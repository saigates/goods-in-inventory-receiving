// OPR (Outward Processing Relief) routes — OPR 1 (foundation) + OPR 2
// (export flow) + OPR 3 (import/discharge flow).
//
// OPR 1 (foundation):
//   - Authorisation records: create/list/read/update. Configurable DATA,
//     not code — the Saigates authorisation is seeded via seed.sql.
//   - Shipments (consignment entity above devices): create draft / list /
//     read / update-while-draft, with direction, type, status, procedure
//     codes (validated, incl. the forbidden 2100+B51 combination),
//     consignee, carrier, incoterm, GBP-enforced currency, ship date, and
//     the shipment → authorisation linkage.
//   - Shipment lines: add/remove devices while DRAFT, snapshotting the
//     device's value/attributes at add time (frozen for customs truth).
//
// OPR 2 (export flow):
//   - Consignment builder: POST /shipments/:id/scan (add by IMEI) and the
//     line endpoints now REQUIRE the device to be READY_FOR_EXPORT and
//     drive its status ↔ IN_EXPORT_CONSIGNMENT in lockstep with the line.
//   - GET /shipments/:id/validation — coded green/amber/red engine.
//   - GET /shipments/:id/invoice — print-ready A4 commercial invoice.
//   - GET /shipments/:id/scan-out — IMEI/value list (total == invoice).
//   - GET /shipments/:id/prealert — carrier pre-alert email DRAFT (the
//     mailbox/cut-off come from the authorisation record; nothing is sent).
//   - POST /shipments/:id/finalise — red-blocked; locks lines, devices →
//     EXPORTED_UNDER_OPR, captures MRN/DUCR/EAD.
//   - POST /shipments/:id/export-proof — add/replace proof refs after
//     finalisation (the only mutation a FINALISED shipment accepts).
//
// OPR 3 (import / discharge flow):
//   - Return-consignment builder: /scan and /lines on an IMPORT shipment
//     accept only EXPORTED_UNDER_OPR devices that sit on the consignment's
//     related export — partial returns are fine; the line snapshot copies
//     the ORIGINAL export line's frozen value (the C&E1154 exported-goods
//     value is the returning units' export value, not today's buy price).
//     Device status does NOT move while the import is DRAFT (the goods are
//     still abroad) — a duplicate-draft guard stops the same device being
//     placed on two open return consignments.
//   - GET /shipments/:id/validation — direction-aware: imports run the
//     import validation engine (procedure 6121, related-export + MRN,
//     C&E1154 inputs, OPR Authorisation Number availability, discharge window).
//   - GET /shipments/:id/ce1154 — C&E1154 duty calculation: OPR
//     Authorisation Number in the authorisation field, CDS Authorisation
//     Number ONLY in the cross-referenced statement; repair cost → GBP at
//     the customs rate; exported-goods value = returning units only;
//     relief + net duty. HTML (print A4) by default, ?format=json for the figures.
//   - GET /shipments/:id/clearance — re-import clearance-instruction DRAFT
//     (procedure 6121, quotes export MRN, duty/VAT on repair cost only).
//     Nothing is sent (OPR 4).
//   - POST /shipments/:id/finalise — import path = RECEIPT: red-blocked by
//     the import engine; devices → RETURNED_UNDER_OPR (event-logged with
//     the import MRN); captures import_mrn.
//   - POST /shipments/:id/import-proof — record the 6121 MRN later (the
//     import mirror of /export-proof).
//   - POST /shipments/:id/restock — returned devices → ACTIVE_INVENTORY.
//   - GET /discharge — tracker over FINALISED exports: exported vs
//     returned vs outstanding, deadline = export date + discharge period.
//
// OPR 4 (automation): Gmail send endpoints (honesty-gated 503 until the
// GMAIL_* secrets exist), sent_emails outbox, shipment webhooks, bulk scan.
//
// OPR 6 (manual dispatch, per owner brief — Gmail left as-is until the
// integration is done): /prealert/mark-sent and /clearance/mark-sent record
// an operator's manual copy-paste send in the outbox with provider='manual'
// / status='manual' (never confusable with a real system send); MUCR joins
// MRN/DUCR/EAD as proof-of-export material (migration 0014).

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Bindings, AuthUser, Shipment, ShipmentLine, OprAuthorisation, DeviceStatus } from '../types'
import { currentUser } from '../lib/auth'
import { cleanString, isValidCurrency } from '../lib/validate'
import { transitionDevice, logDeviceEvent } from '../lib/deviceLifecycle'
import { runExportValidation } from '../lib/oprValidation'
import { buildCommercialInvoiceHtml, buildScanOutList, buildPreAlertDraft } from '../lib/oprDocs'
import {
  computeCe1154,
  buildCe1154Html,
  buildClearanceInstructionDraft,
  runImportValidation,
  computeDischargeRow,
} from '../lib/oprImport'
import { gmailConfigFromEnv, sendGmail, type EmailAttachment } from '../lib/email'
import { dispatchShipmentWebhooks, type ShipmentEventPayload } from '../lib/webhook'
import {
  validateShipmentCurrency,
  validateProcedureCodes,
  isDeclarationSafeText,
  isValidEori,
  isValidIsoDate,
} from '../lib/opr'

type OprEnv = { Bindings: Bindings; Variables: { user: AuthUser } }
type OprContext = Context<OprEnv>

const app = new Hono<OprEnv>()

// ═════════ Authorisations ═════════

// Fire-and-forget shipment webhook. Same executionCtx caveat as
// devices.ts: c.executionCtx is a THROWING getter under app.request()
// in tests, so it must be probed inside try/catch, not optional-chained.
async function notifyShipmentEvent(c: OprContext, payload: ShipmentEventPayload): Promise<void> {
  const notify = dispatchShipmentWebhooks(c.env.DB, payload)
  let execCtx: { waitUntil?: (p: Promise<unknown>) => void } | undefined
  try { execCtx = c.executionCtx as { waitUntil?: (p: Promise<unknown>) => void } } catch { execCtx = undefined }
  if (typeof execCtx?.waitUntil === 'function') {
    execCtx.waitUntil(notify)
  } else {
    await notify
  }
}

app.get('/authorisations', async (c) => {
  const user = currentUser(c)
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM opr_authorisations WHERE organisation_id = ? ORDER BY valid_to DESC'
  ).bind(user.organisation_id).all()
  return c.json({ authorisations: results })
})

app.get('/authorisations/:id', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  const auth = await c.env.DB.prepare(
    'SELECT * FROM opr_authorisations WHERE id = ? AND organisation_id = ?'
  ).bind(id, user.organisation_id).first()
  if (!auth) return c.json({ error: 'Not found' }, 404)
  return c.json({ authorisation: auth })
})

type AuthBody = Record<string, unknown>

// Shared field validation for create + update. Returns either the cleaned
// column map or a 422-able error string.
function parseAuthorisationBody(body: AuthBody, partial: boolean):
  | { ok: true; fields: Record<string, unknown> }
  | { ok: false; error: string } {
  const fields: Record<string, unknown> = {}

  const want = (key: string) => !partial || body[key] !== undefined

  if (want('holder_name')) {
    const v = cleanString(body.holder_name, 200)
    if (!v) return { ok: false, error: 'holder_name is required' }
    fields.holder_name = v
  }
  if (want('eori')) {
    const v = cleanString(body.eori, 20)
    if (!v || !isValidEori(v)) return { ok: false, error: `eori '${body.eori ?? ''}' is not a valid EORI (expected e.g. GB369979995000)` }
    fields.eori = v.toUpperCase()
  }
  if (want('cds_number')) {
    const v = cleanString(body.cds_number, 40)
    if (!v) return { ok: false, error: 'cds_number is required (the CDS-format authorisation number used on CDS declarations)' }
    fields.cds_number = v.toUpperCase()
  }
  if (want('op_authorisation_number')) {
    // Optional, but if present keep as-is (contains slashes by format).
    // This is the OPR Authorisation Number (e.g. OP/0922/601/31) — a
    // distinct identifier from the CDS Authorisation Number, and NOT a
    // "CHIEF number" (no such identifier exists on this authorisation).
    fields.op_authorisation_number = cleanString(body.op_authorisation_number, 40)
  }
  if (want('valid_from')) {
    if (!isValidIsoDate(body.valid_from)) return { ok: false, error: 'valid_from must be an ISO date (YYYY-MM-DD)' }
    fields.valid_from = body.valid_from
  }
  if (want('valid_to')) {
    if (!isValidIsoDate(body.valid_to)) return { ok: false, error: 'valid_to must be an ISO date (YYYY-MM-DD)' }
    fields.valid_to = body.valid_to
  }
  if (want('supervising_office_name')) fields.supervising_office_name = cleanString(body.supervising_office_name, 200)
  if (want('supervising_office_code')) fields.supervising_office_code = cleanString(body.supervising_office_code, 20)
  if (want('commodity_scope')) fields.commodity_scope = cleanString(body.commodity_scope, 500)
  if (want('commodity_codes')) fields.commodity_codes = cleanString(body.commodity_codes, 500)
  if (want('rate_of_yield')) {
    const v = cleanString(body.rate_of_yield, 20)
    fields.rate_of_yield = v ?? '1:1'
  }
  if (want('discharge_period_months')) {
    const n = Number(body.discharge_period_months ?? 6)
    if (!Number.isInteger(n) || n < 1 || n > 60) return { ok: false, error: 'discharge_period_months must be an integer between 1 and 60' }
    fields.discharge_period_months = n
  }
  if (want('notes')) fields.notes = cleanString(body.notes, 2000)
  if (want('prealert_email')) {
    const v = cleanString(body.prealert_email, 200)
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { ok: false, error: `prealert_email '${v}' is not a valid email address` }
    fields.prealert_email = v ? v.toLowerCase() : null
  }
  if (want('prealert_cutoff')) {
    const v = cleanString(body.prealert_cutoff, 5)
    if (v && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return { ok: false, error: `prealert_cutoff '${v}' must be a 24h time (HH:MM)` }
    fields.prealert_cutoff = v
  }

  // Cross-field: dates must be ordered when both present.
  const from = fields.valid_from as string | undefined
  const to = fields.valid_to as string | undefined
  if (from && to && from > to) return { ok: false, error: 'valid_from must be on or before valid_to' }

  return { ok: true, fields }
}

app.post('/authorisations', async (c) => {
  const user = currentUser(c)
  const body = await c.req.json<AuthBody>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)

  const parsed = parseAuthorisationBody(body, false)
  if (!parsed.ok) return c.json({ error: parsed.error }, 422)

  const f = parsed.fields
  try {
    const result = await c.env.DB.prepare(`
      INSERT INTO opr_authorisations
        (organisation_id, holder_name, eori, cds_number, op_authorisation_number,
         valid_from, valid_to, supervising_office_name, supervising_office_code,
         commodity_scope, commodity_codes, rate_of_yield, discharge_period_months, notes,
         prealert_email, prealert_cutoff)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      user.organisation_id, f.holder_name, f.eori, f.cds_number, f.op_authorisation_number ?? null,
      f.valid_from, f.valid_to, f.supervising_office_name ?? null, f.supervising_office_code ?? null,
      f.commodity_scope ?? null, f.commodity_codes ?? null, f.rate_of_yield ?? '1:1',
      f.discharge_period_months ?? 6, f.notes ?? null,
      f.prealert_email ?? null, f.prealert_cutoff ?? null,
    ).run()
    const auth = await c.env.DB.prepare('SELECT * FROM opr_authorisations WHERE id = ?')
      .bind(result.meta.last_row_id).first()
    return c.json({ ok: true, authorisation: auth }, 201)
  } catch (e: unknown) {
    if (String(e).includes('UNIQUE')) {
      return c.json({ error: `An authorisation with CDS number '${f.cds_number}' already exists` }, 409)
    }
    throw e
  }
})

app.patch('/authorisations/:id', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  const existing = await c.env.DB.prepare(
    'SELECT id FROM opr_authorisations WHERE id = ? AND organisation_id = ?'
  ).bind(id, user.organisation_id).first()
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json<AuthBody>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)

  const parsed = parseAuthorisationBody(body, true)
  if (!parsed.ok) return c.json({ error: parsed.error }, 422)
  const keys = Object.keys(parsed.fields)
  if (!keys.length) return c.json({ error: 'No recognised fields to update' }, 400)

  const sets = keys.map(k => `${k} = ?`).join(', ')
  await c.env.DB.prepare(
    `UPDATE opr_authorisations SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organisation_id = ?`
  ).bind(...keys.map(k => parsed.fields[k]), id, user.organisation_id).run()

  const auth = await c.env.DB.prepare('SELECT * FROM opr_authorisations WHERE id = ?').bind(id).first()
  return c.json({ ok: true, authorisation: auth })
})

// ═════════ Shipments ═════════

app.get('/shipments', async (c) => {
  const user = currentUser(c)
  const { results } = await c.env.DB.prepare(`
    SELECT s.*,
           (SELECT COUNT(*) FROM shipment_lines l WHERE l.shipment_id = s.id) AS line_count,
           (SELECT COALESCE(SUM(l.unit_value), 0) FROM shipment_lines l WHERE l.shipment_id = s.id) AS total_value
    FROM shipments s WHERE s.organisation_id = ? ORDER BY s.id DESC
  `).bind(user.organisation_id).all()
  return c.json({ shipments: results })
})

app.get('/shipments/:id', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  const shipment = await c.env.DB.prepare(
    'SELECT * FROM shipments WHERE id = ? AND organisation_id = ?'
  ).bind(id, user.organisation_id).first()
  if (!shipment) return c.json({ error: 'Not found' }, 404)
  const { results: lines } = await c.env.DB.prepare(
    'SELECT * FROM shipment_lines WHERE shipment_id = ? ORDER BY id'
  ).bind(id).all()
  const authorisation = await c.env.DB.prepare(
    'SELECT * FROM opr_authorisations WHERE id = ?'
  ).bind((shipment as Record<string, unknown>).authorisation_id).first()
  const totalValue = (lines as Array<Record<string, unknown>>).reduce((s, l) => s + Number(l.unit_value || 0), 0)
  return c.json({ shipment, lines, authorisation, total_value: Math.round(totalValue * 100) / 100 })
})

type ShipmentBody = Record<string, unknown>

// ───── C&E1154 input fields (OPR 3) ─────
// repair_cost / repair_cost_currency / customs_exchange_rate /
// duty_rate_pct are IMPORT-shipment data (they describe the repairer
// invoice and the duty position of the returning goods). Rejected on
// export shipments so junk can't accumulate silently.
function parseRepairFields(body: ShipmentBody, direction: string):
  | { ok: true; fields: Record<string, unknown> }
  | { ok: false; error: string } {
  const fields: Record<string, unknown> = {}
  const provided = ['repair_cost', 'repair_cost_currency', 'customs_exchange_rate', 'duty_rate_pct']
    .filter(k => body[k] !== undefined)
  if (!provided.length) return { ok: true, fields }
  if (direction !== 'import') {
    return { ok: false, error: `${provided.join(', ')} are import-shipment fields (C&E1154 inputs) — not valid on an export shipment` }
  }
  if (body.repair_cost !== undefined) {
    if (body.repair_cost === null) fields.repair_cost = null
    else {
      const v = Number(body.repair_cost)
      if (Number.isNaN(v) || v <= 0) return { ok: false, error: 'repair_cost must be a positive number (the repairer invoice amount)' }
      if (Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) return { ok: false, error: `repair_cost ${v} is not expressible in minor units (2dp)` }
      fields.repair_cost = v
    }
  }
  if (body.repair_cost_currency !== undefined) {
    if (body.repair_cost_currency === null) fields.repair_cost_currency = null
    else {
      const cur = String(body.repair_cost_currency).trim().toUpperCase()
      if (!isValidCurrency(cur)) return { ok: false, error: `repair_cost_currency '${cur}' is not a valid ISO 4217 code` }
      fields.repair_cost_currency = cur
    }
  }
  if (body.customs_exchange_rate !== undefined) {
    if (body.customs_exchange_rate === null) fields.customs_exchange_rate = null
    else {
      const v = Number(body.customs_exchange_rate)
      if (Number.isNaN(v) || v <= 0) return { ok: false, error: 'customs_exchange_rate must be a positive number (HMRC monthly rate, foreign units per GBP 1)' }
      fields.customs_exchange_rate = v
    }
  }
  if (body.duty_rate_pct !== undefined) {
    if (body.duty_rate_pct === null) fields.duty_rate_pct = null
    else {
      const v = Number(body.duty_rate_pct)
      if (Number.isNaN(v) || v < 0 || v > 100) return { ok: false, error: 'duty_rate_pct must be between 0 and 100 (0 is valid for duty-free commodities)' }
      fields.duty_rate_pct = v
    }
  }
  return { ok: true, fields }
}

app.post('/shipments', async (c) => {
  const user = currentUser(c)
  const body = await c.req.json<ShipmentBody>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)

  const direction = String(body.direction ?? '').trim().toLowerCase()
  if (direction !== 'export' && direction !== 'import') {
    return c.json({ error: "direction must be 'export' or 'import'" }, 422)
  }

  const reference = cleanString(body.reference, 60)
  if (!reference) return c.json({ error: 'reference is required' }, 422)
  if (!isDeclarationSafeText(reference)) {
    return c.json({ error: 'reference may contain letters, numbers and spaces only (it flows onto customs declarations)' }, 422)
  }

  // Authorisation must exist, belong to the org, and the linkage is NOT
  // optional — an OPR shipment without an authorisation is meaningless.
  const authId = Number(body.authorisation_id)
  if (!authId) return c.json({ error: 'authorisation_id is required — every OPR shipment must link to an authorisation' }, 422)
  const auth = await c.env.DB.prepare(
    'SELECT id FROM opr_authorisations WHERE id = ? AND organisation_id = ?'
  ).bind(authId, user.organisation_id).first()
  if (!auth) return c.json({ error: `authorisation_id ${authId} not found for this organisation` }, 422)

  const proc = validateProcedureCodes(direction, body.procedure_code, body.additional_procedure_code)
  if (!proc.ok) return c.json({ error: proc.error }, 422)

  const cur = validateShipmentCurrency(body.currency)
  if (!cur.ok) return c.json({ error: cur.error }, 422)

  const consigneeName = cleanString(body.consignee_name, 200)
  if (consigneeName && !isDeclarationSafeText(consigneeName)) {
    return c.json({ error: 'consignee_name may contain letters, numbers and spaces only (declaration charset)' }, 422)
  }

  let shipDate: string | null = null
  if (body.ship_date != null && body.ship_date !== '') {
    if (!isValidIsoDate(body.ship_date)) return c.json({ error: 'ship_date must be an ISO date (YYYY-MM-DD)' }, 422)
    shipDate = body.ship_date
  }

  // import shipments may reference the export they discharge (used by OPR 3)
  let relatedExportId: number | null = null
  if (body.related_export_shipment_id != null) {
    relatedExportId = Number(body.related_export_shipment_id)
    const rel = await c.env.DB.prepare(
      "SELECT id FROM shipments WHERE id = ? AND organisation_id = ? AND direction = 'export'"
    ).bind(relatedExportId, user.organisation_id).first()
    if (!rel) return c.json({ error: `related_export_shipment_id ${relatedExportId} is not an export shipment of this organisation` }, 422)
  }

  const repair = parseRepairFields(body, direction)
  if (!repair.ok) return c.json({ error: repair.error }, 422)

  try {
    const result = await c.env.DB.prepare(`
      INSERT INTO shipments
        (organisation_id, reference, direction, shipment_type, status, authorisation_id,
         procedure_code, additional_procedure_code, consignee_name, consignee_address,
         carrier, carrier_account, incoterm, currency, ship_date,
         related_export_shipment_id, notes, created_by_user_id)
      VALUES (?, ?, ?, 'OPR_REPAIR', 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      user.organisation_id, reference, direction, authId,
      proc.procedure_code, proc.additional_procedure_code,
      consigneeName, cleanString(body.consignee_address, 500),
      cleanString(body.carrier, 100), cleanString(body.carrier_account, 100),
      cleanString(body.incoterm, 10), cur.value, shipDate,
      relatedExportId, cleanString(body.notes, 2000), user.id,
    ).run()
    const newId = Number(result.meta.last_row_id)
    const repairKeys = Object.keys(repair.fields)
    if (repairKeys.length) {
      await c.env.DB.prepare(
        `UPDATE shipments SET ${repairKeys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`
      ).bind(...repairKeys.map(k => repair.fields[k]), newId).run()
    }
    const shipment = await c.env.DB.prepare('SELECT * FROM shipments WHERE id = ?')
      .bind(newId).first()
    return c.json({ ok: true, shipment }, 201)
  } catch (e: unknown) {
    if (String(e).includes('UNIQUE')) {
      return c.json({ error: `A shipment with reference '${reference}' already exists` }, 409)
    }
    throw e
  }
})

// Update header fields while DRAFT only.
app.patch('/shipments/:id', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  const shipment = await c.env.DB.prepare(
    'SELECT * FROM shipments WHERE id = ? AND organisation_id = ?'
  ).bind(id, user.organisation_id).first<Record<string, unknown>>()
  if (!shipment) return c.json({ error: 'Not found' }, 404)
  if (shipment.status !== 'DRAFT') {
    return c.json({ error: `Shipment is ${shipment.status} — only DRAFT shipments can be edited` }, 409)
  }

  const body = await c.req.json<ShipmentBody>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)

  const fields: Record<string, unknown> = {}

  if (body.reference !== undefined) {
    const reference = cleanString(body.reference, 60)
    if (!reference) return c.json({ error: 'reference is required' }, 422)
    if (!isDeclarationSafeText(reference)) return c.json({ error: 'reference may contain letters, numbers and spaces only' }, 422)
    fields.reference = reference
  }
  if (body.procedure_code !== undefined || body.additional_procedure_code !== undefined) {
    const proc = validateProcedureCodes(
      shipment.direction as 'export' | 'import',
      body.procedure_code ?? shipment.procedure_code,
      body.additional_procedure_code !== undefined ? body.additional_procedure_code : shipment.additional_procedure_code,
    )
    if (!proc.ok) return c.json({ error: proc.error }, 422)
    fields.procedure_code = proc.procedure_code
    fields.additional_procedure_code = proc.additional_procedure_code
  }
  if (body.currency !== undefined) {
    const cur = validateShipmentCurrency(body.currency)
    if (!cur.ok) return c.json({ error: cur.error }, 422)
    fields.currency = cur.value
  }
  if (body.consignee_name !== undefined) {
    const v = cleanString(body.consignee_name, 200)
    if (v && !isDeclarationSafeText(v)) return c.json({ error: 'consignee_name may contain letters, numbers and spaces only' }, 422)
    fields.consignee_name = v
  }
  if (body.consignee_address !== undefined) fields.consignee_address = cleanString(body.consignee_address, 500)
  if (body.carrier !== undefined) fields.carrier = cleanString(body.carrier, 100)
  if (body.carrier_account !== undefined) fields.carrier_account = cleanString(body.carrier_account, 100)
  if (body.incoterm !== undefined) fields.incoterm = cleanString(body.incoterm, 10)
  if (body.ship_date !== undefined) {
    if (body.ship_date === null || body.ship_date === '') fields.ship_date = null
    else if (!isValidIsoDate(body.ship_date)) return c.json({ error: 'ship_date must be an ISO date (YYYY-MM-DD)' }, 422)
    else fields.ship_date = body.ship_date
  }
  if (body.notes !== undefined) fields.notes = cleanString(body.notes, 2000)

  // C&E1154 inputs (OPR 3) — import shipments only.
  const repair = parseRepairFields(body, String(shipment.direction))
  if (!repair.ok) return c.json({ error: repair.error }, 422)
  Object.assign(fields, repair.fields)

  const keys = Object.keys(fields)
  if (!keys.length) return c.json({ error: 'No recognised fields to update' }, 400)

  try {
    await c.env.DB.prepare(
      `UPDATE shipments SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organisation_id = ?`
    ).bind(...keys.map(k => fields[k]), id, user.organisation_id).run()
  } catch (e: unknown) {
    if (String(e).includes('UNIQUE')) return c.json({ error: `A shipment with reference '${fields.reference}' already exists` }, 409)
    throw e
  }
  const updated = await c.env.DB.prepare('SELECT * FROM shipments WHERE id = ?').bind(id).first()
  return c.json({ ok: true, shipment: updated })
})

// ═════════ Shipment lines (device snapshots) ═════════

// POST /shipments/:id/lines { device_id } — snapshot the device NOW.
// Shared implementation for POST /lines (by device_id) and POST /scan (by
// IMEI — the consignment-builder path a scanner uses). OPR 2 rule: only
// READY_FOR_EXPORT devices may join an EXPORT consignment, and joining
// moves them to IN_EXPORT_CONSIGNMENT in lockstep with the line insert.
async function addDeviceToShipment(
  c: OprContext,
  user: AuthUser,
  shipment: Record<string, unknown>,
  device: Record<string, unknown>,
) {
  const shipmentId = Number(shipment.id)
  const deviceId = Number(device.id)

  // Customs documents need a declared unit value. A device with no buy
  // price cannot go on a consignment — same valuation rule as goods-in,
  // enforced at the point the snapshot is taken.
  if (device.buy_price == null) {
    return c.json({ error: `Device ${deviceId} (IMEI ${device.imei}) has no buy_price — a unit value is required before it can be added to a consignment` }, 422)
  }

  // Export consignments only take devices staged for export. (Import/return
  // consignment building is OPR 3 — refused at the shipment check below.)
  if (device.status !== 'READY_FOR_EXPORT') {
    return c.json({ error: `Device ${deviceId} (IMEI ${device.imei}) is ${device.status} — only READY_FOR_EXPORT devices can be added to an export consignment` }, 409)
  }

  let lineId: number
  try {
    const result = await c.env.DB.prepare(`
      INSERT INTO shipment_lines
        (organisation_id, shipment_id, received_device_id,
         imei, sku, brand, model, capacity, color, grade, unit_value, currency, added_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      user.organisation_id, shipmentId, deviceId,
      device.imei, device.sku, device.brand, device.model,
      device.capacity, device.color, device.grade,
      device.buy_price, 'GBP', user.id,
    ).run()
    lineId = Number(result.meta.last_row_id)
  } catch (e: unknown) {
    if (String(e).includes('UNIQUE')) {
      return c.json({ error: `Device ${deviceId} is already on this shipment` }, 409)
    }
    throw e
  }

  // Status must follow the line. If the transition fails (it shouldn't —
  // status was just checked), undo the line so they can never diverge.
  try {
    await transitionDevice(c.env.DB, deviceId, 'IN_EXPORT_CONSIGNMENT', {
      user,
      reference: String(shipment.reference),
      metadata: { shipment_id: shipmentId, line_id: lineId },
      eventType: 'EXPORT_CONSIGNMENT_ADD',
    })
  } catch (e) {
    await c.env.DB.prepare('DELETE FROM shipment_lines WHERE id = ?').bind(lineId).run()
    throw e
  }

  const line = await c.env.DB.prepare('SELECT * FROM shipment_lines WHERE id = ?').bind(lineId).first()
  return c.json({ ok: true, line }, 201)
}

// OPR 3 — return-consignment builder. An IMPORT shipment collects devices
// that are coming back from the overseas repairer:
//   - the shipment must be linked to its related export (the return
//     discharges a specific export declaration)
//   - only EXPORTED_UNDER_OPR devices that have a line ON that export may
//     join — partial returns are fine (90 of 162)
//   - the line snapshot COPIES the original export line's frozen value:
//     the C&E1154 exported-goods value is what was declared at export,
//     never today's device row
//   - device status does NOT move while the import is DRAFT (the goods
//     are physically still abroad); a duplicate-draft guard stops one
//     device sitting on two open return consignments
async function addDeviceToReturnShipment(
  c: OprContext,
  user: AuthUser,
  shipment: Record<string, unknown>,
  device: Record<string, unknown>,
) {
  const shipmentId = Number(shipment.id)
  const deviceId = Number(device.id)

  const relatedExportId = Number(shipment.related_export_shipment_id)
  if (!relatedExportId) {
    return c.json({ error: 'Import shipment has no related_export_shipment_id — link the return to the export it discharges before adding devices' }, 422)
  }

  if (device.status !== 'EXPORTED_UNDER_OPR') {
    return c.json({ error: `Device ${deviceId} (IMEI ${device.imei}) is ${device.status} — only EXPORTED_UNDER_OPR devices can join a return consignment` }, 409)
  }

  // The device must have been declared on THE related export — a device
  // exported on a different consignment cannot discharge this one.
  const exportLine = await c.env.DB.prepare(
    'SELECT * FROM shipment_lines WHERE shipment_id = ? AND received_device_id = ?'
  ).bind(relatedExportId, deviceId).first<Record<string, unknown>>()
  if (!exportLine) {
    return c.json({ error: `Device ${deviceId} (IMEI ${device.imei}) was not on export shipment ${relatedExportId} — a return can only contain devices from its related export` }, 409)
  }

  // Duplicate-draft guard: status alone can't catch a device parked on
  // another OPEN return consignment (status only moves at receipt).
  const openElsewhere = await c.env.DB.prepare(
    `SELECT s.id, s.reference FROM shipment_lines sl
       JOIN shipments s ON s.id = sl.shipment_id
      WHERE sl.received_device_id = ? AND s.direction = 'import'
        AND s.status = 'DRAFT' AND s.id != ?`
  ).bind(deviceId, shipmentId).first<{ id: number; reference: string }>()
  if (openElsewhere) {
    return c.json({ error: `Device ${deviceId} (IMEI ${device.imei}) is already on open return consignment '${openElsewhere.reference}' (id ${openElsewhere.id})` }, 409)
  }

  try {
    const result = await c.env.DB.prepare(`
      INSERT INTO shipment_lines
        (organisation_id, shipment_id, received_device_id,
         imei, sku, brand, model, capacity, color, grade, unit_value, currency, added_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      user.organisation_id, shipmentId, deviceId,
      exportLine.imei, exportLine.sku, exportLine.brand, exportLine.model,
      exportLine.capacity, exportLine.color, exportLine.grade,
      exportLine.unit_value, exportLine.currency, user.id,
    ).run()
    // Audit without a status change — the device is still abroad.
    await logDeviceEvent(c.env.DB, {
      organisationId: user.organisation_id,
      deviceId,
      eventType: 'RETURN_CONSIGNMENT_ADD',
      userId: user.id,
      reference: String(shipment.reference),
      metadata: { shipment_id: shipmentId, line_id: Number(result.meta.last_row_id), related_export_shipment_id: relatedExportId },
    })
    const line = await c.env.DB.prepare('SELECT * FROM shipment_lines WHERE id = ?')
      .bind(result.meta.last_row_id).first()
    return c.json({ ok: true, line }, 201)
  } catch (e: unknown) {
    if (String(e).includes('UNIQUE')) {
      return c.json({ error: `Device ${deviceId} is already on this shipment` }, 409)
    }
    throw e
  }
}

// Loads + gates the shipment for consignment building: must exist, be
// org-scoped, and be DRAFT. Both directions build lines now — exports via
// addDeviceToShipment (OPR 2), imports via addDeviceToReturnShipment
// (OPR 3) — the endpoints branch on direction.
async function loadDraftShipment(
  c: OprContext,
  user: AuthUser,
  id: number,
): Promise<{ ok: true; shipment: Record<string, unknown> } | { ok: false; response: Response }> {
  const shipment = await c.env.DB.prepare(
    'SELECT * FROM shipments WHERE id = ? AND organisation_id = ?'
  ).bind(id, user.organisation_id).first<Record<string, unknown>>()
  if (!shipment) return { ok: false, response: c.json({ error: 'Shipment not found' }, 404) }
  if (shipment.status !== 'DRAFT') {
    return { ok: false, response: c.json({ error: `Shipment is ${shipment.status} — lines can only be changed while DRAFT` }, 409) }
  }
  return { ok: true, shipment }
}

app.post('/shipments/:id/lines', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const gate = await loadDraftShipment(c, user, id)
  if (!gate.ok) return gate.response

  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
  const deviceId = Number(body.device_id)
  if (!deviceId) return c.json({ error: 'device_id is required' }, 422)

  const device = await c.env.DB.prepare(
    'SELECT * FROM received_devices WHERE id = ? AND organisation_id = ?'
  ).bind(deviceId, user.organisation_id).first<Record<string, unknown>>()
  if (!device) return c.json({ error: `Device ${deviceId} not found` }, 404)

  return gate.shipment.direction === 'import'
    ? addDeviceToReturnShipment(c, user, gate.shipment, device)
    : addDeviceToShipment(c, user, gate.shipment, device)
})

// POST /shipments/:id/scan { imei } — the scanner-first consignment
// builder: look the device up by IMEI and add it (same rules as /lines).
app.post('/shipments/:id/scan', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const gate = await loadDraftShipment(c, user, id)
  if (!gate.ok) return gate.response

  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
  const imei = cleanString(body.imei, 16)
  if (!imei) return c.json({ error: 'imei is required' }, 422)

  const device = await c.env.DB.prepare(
    'SELECT * FROM received_devices WHERE imei = ? AND organisation_id = ?'
  ).bind(imei, user.organisation_id).first<Record<string, unknown>>()
  if (!device) return c.json({ error: `No device with IMEI ${imei} in inventory` }, 404)

  return gate.shipment.direction === 'import'
    ? addDeviceToReturnShipment(c, user, gate.shipment, device)
    : addDeviceToShipment(c, user, gate.shipment, device)
})

app.delete('/shipments/:id/lines/:lineId', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const lineId = Number(c.req.param('lineId'))
  if (!id || !lineId) return c.json({ error: 'Invalid id' }, 400)

  const shipment = await c.env.DB.prepare(
    'SELECT status, reference, direction FROM shipments WHERE id = ? AND organisation_id = ?'
  ).bind(id, user.organisation_id).first<Record<string, unknown>>()
  if (!shipment) return c.json({ error: 'Shipment not found' }, 404)
  if (shipment.status !== 'DRAFT') {
    return c.json({ error: `Shipment is ${shipment.status} — lines can only be removed while DRAFT` }, 409)
  }

  const line = await c.env.DB.prepare(
    'SELECT * FROM shipment_lines WHERE id = ? AND shipment_id = ? AND organisation_id = ?'
  ).bind(lineId, id, user.organisation_id).first<Record<string, unknown>>()
  if (!line) return c.json({ error: 'Line not found' }, 404)

  await c.env.DB.prepare('DELETE FROM shipment_lines WHERE id = ?').bind(lineId).run()

  // Release the device back to READY_FOR_EXPORT so it can join another
  // consignment. Guarded: only if it is actually IN_EXPORT_CONSIGNMENT
  // (lines created before the OPR 2 wiring may reference devices whose
  // status was never moved).
  const device = await c.env.DB.prepare(
    'SELECT id, status FROM received_devices WHERE id = ? AND organisation_id = ?'
  ).bind(line.received_device_id, user.organisation_id).first<{ id: number; status: DeviceStatus }>()
  if (device && device.status === 'IN_EXPORT_CONSIGNMENT') {
    await transitionDevice(c.env.DB, device.id, 'READY_FOR_EXPORT', {
      user,
      reference: String(shipment.reference),
      metadata: { shipment_id: id, line_id: lineId },
      eventType: 'EXPORT_CONSIGNMENT_REMOVE',
    })
  } else if (shipment.direction === 'import' && device) {
    // No status to unwind on a draft return (the device never moved) —
    // but the removal still belongs on the audit trail.
    await logDeviceEvent(c.env.DB, {
      organisationId: user.organisation_id,
      deviceId: device.id,
      eventType: 'RETURN_CONSIGNMENT_REMOVE',
      userId: user.id,
      reference: String(shipment.reference),
      metadata: { shipment_id: id, line_id: lineId },
    })
  }
  return c.json({ ok: true })
})

// ═════════ OPR 2 — validation, documents, finalisation ═════════

// Fetches shipment + lines + authorisation for the document/validation
// endpoints. Unlike the builder gate, this accepts any status (documents
// can be reprinted after finalisation) but still org-scopes everything.
async function loadShipmentBundle(
  c: OprContext,
  user: AuthUser,
  id: number,
): Promise<{ ok: true; shipment: Shipment; lines: ShipmentLine[]; authorisation: OprAuthorisation | null; relatedExport: Shipment | null } | { ok: false; response: Response }> {
  const shipment = await c.env.DB.prepare(
    'SELECT * FROM shipments WHERE id = ? AND organisation_id = ?'
  ).bind(id, user.organisation_id).first<Shipment>()
  if (!shipment) return { ok: false, response: c.json({ error: 'Shipment not found' }, 404) }
  const { results: lines } = await c.env.DB.prepare(
    'SELECT * FROM shipment_lines WHERE shipment_id = ? ORDER BY id ASC'
  ).bind(id).all<ShipmentLine>()
  const authorisation = await c.env.DB.prepare(
    'SELECT * FROM opr_authorisations WHERE id = ? AND organisation_id = ?'
  ).bind(shipment.authorisation_id, user.organisation_id).first<OprAuthorisation>()
  // OPR 3: an import shipment's validation/C&E1154/clearance all need the
  // export it discharges.
  let relatedExport: Shipment | null = null
  if (shipment.related_export_shipment_id) {
    relatedExport = await c.env.DB.prepare(
      'SELECT * FROM shipments WHERE id = ? AND organisation_id = ?'
    ).bind(shipment.related_export_shipment_id, user.organisation_id).first<Shipment>()
  }
  return { ok: true, shipment, lines, authorisation: authorisation ?? null, relatedExport }
}

// GET /shipments/:id/validation — run the green/amber/red engine.
// Direction-aware: exports run the OPR 2 export engine, imports the OPR 3
// import engine (procedure 6121, related export + MRN, C&E1154 inputs,
// OPR Authorisation Number availability, discharge window).
app.get('/shipments/:id/validation', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  const bundle = await loadShipmentBundle(c, user, id)
  if (!bundle.ok) return bundle.response
  const validation = bundle.shipment.direction === 'import'
    ? runImportValidation(bundle.shipment, bundle.relatedExport, bundle.authorisation, bundle.lines)
    : runExportValidation(bundle.shipment, bundle.authorisation, bundle.lines)
  return c.json({ shipment_id: id, status: bundle.shipment.status, direction: bundle.shipment.direction, validation })
})

// GET /shipments/:id/invoice — print-ready A4 commercial invoice (HTML).
app.get('/shipments/:id/invoice', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  const bundle = await loadShipmentBundle(c, user, id)
  if (!bundle.ok) return bundle.response
  if (bundle.shipment.direction !== 'export') {
    return c.json({ error: 'Commercial invoice generation covers EXPORT consignments' }, 409)
  }
  if (!bundle.authorisation) return c.json({ error: 'Shipment has no resolvable authorisation' }, 422)
  if (!bundle.lines.length) return c.json({ error: 'Consignment has no lines — nothing to invoice' }, 422)
  return c.html(buildCommercialInvoiceHtml(bundle.shipment, bundle.authorisation, bundle.lines))
})

// GET /shipments/:id/scan-out — IMEI/value list; total equals the invoice
// total by construction (same pence-exact sum).
app.get('/shipments/:id/scan-out', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  const bundle = await loadShipmentBundle(c, user, id)
  if (!bundle.ok) return bundle.response
  return c.json({ scan_out: buildScanOutList(bundle.shipment, bundle.lines) })
})

// GET /shipments/:id/prealert — carrier customs pre-alert email DRAFT.
// Mailbox + cut-off come from the authorisation record (data, not code).
// Nothing is sent — Workers has no SMTP; this returns copy-paste material.
app.get('/shipments/:id/prealert', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  const bundle = await loadShipmentBundle(c, user, id)
  if (!bundle.ok) return bundle.response
  if (bundle.shipment.direction !== 'export') {
    return c.json({ error: 'Pre-alert drafts cover EXPORT consignments' }, 409)
  }
  if (!bundle.authorisation) return c.json({ error: 'Shipment has no resolvable authorisation' }, 422)
  return c.json({ prealert: buildPreAlertDraft(bundle.shipment, bundle.authorisation, bundle.lines) })
})

// ═════ OPR 3 — C&E1154, clearance instruction, discharge tracker ═════

// GET /shipments/:id/ce1154 — the OPR duty-calculation form for a
// returning consignment. HTML (print A4) by default; ?format=json returns
// the computed figures. OPR Authorisation Number in the authorisation
// field, CDS Authorisation Number ONLY in the cross-referenced statement.
app.get('/shipments/:id/ce1154', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  const bundle = await loadShipmentBundle(c, user, id)
  if (!bundle.ok) return bundle.response
  if (bundle.shipment.direction !== 'import') {
    return c.json({ error: 'The C&E1154 is generated for IMPORT (re-import) shipments — exports have the commercial invoice' }, 409)
  }
  const ce = computeCe1154(bundle.shipment, bundle.relatedExport, bundle.authorisation, bundle.lines)
  if (!ce.ok) return c.json({ error: ce.error }, 422)
  if (c.req.query('format') === 'json') {
    return c.json({ ce1154: ce.ce1154 })
  }
  return c.html(buildCe1154Html(ce.ce1154, bundle.shipment, bundle.lines))
})

// GET /shipments/:id/clearance — re-import clearance-instruction DRAFT
// (copy-paste material for the broker; nothing is sent — that is OPR 4).
app.get('/shipments/:id/clearance', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  const bundle = await loadShipmentBundle(c, user, id)
  if (!bundle.ok) return bundle.response
  if (bundle.shipment.direction !== 'import') {
    return c.json({ error: 'Clearance instructions cover IMPORT (re-import) consignments — exports have the pre-alert draft' }, 409)
  }
  if (!bundle.authorisation) return c.json({ error: 'Shipment has no resolvable authorisation' }, 422)
  if (!bundle.lines.length) return c.json({ error: 'Import consignment has no lines — nothing to clear' }, 422)
  const ce = computeCe1154(bundle.shipment, bundle.relatedExport, bundle.authorisation, bundle.lines)
  return c.json({
    clearance: buildClearanceInstructionDraft(
      bundle.shipment, bundle.relatedExport, bundle.authorisation, bundle.lines,
      ce.ok ? ce.ce1154 : null,
    ),
    ...(ce.ok ? {} : { ce1154_note: `C&E1154 figures unavailable: ${ce.error}` }),
  })
})

// GET /discharge — tracker over FINALISED exports: exported vs returned vs
// outstanding, deadline = export date + the authorisation's discharge
// period. Returned = lines on FINALISED import shipments related to the
// export (receipt is what discharges; draft returns are still abroad).
app.get('/discharge', async (c) => {
  const user = currentUser(c)
  const { results } = await c.env.DB.prepare(`
    SELECT s.id, s.reference, s.export_mrn, s.ship_date, s.finalised_at,
           a.discharge_period_months,
           (SELECT COUNT(*) FROM shipment_lines sl WHERE sl.shipment_id = s.id) AS exported,
           (SELECT COUNT(*) FROM shipment_lines rl
              JOIN shipments r ON r.id = rl.shipment_id
             WHERE r.direction = 'import' AND r.status = 'FINALISED'
               AND r.related_export_shipment_id = s.id) AS returned
      FROM shipments s
      JOIN opr_authorisations a ON a.id = s.authorisation_id
     WHERE s.organisation_id = ? AND s.direction = 'export' AND s.status = 'FINALISED'
     ORDER BY s.id ASC
  `).bind(user.organisation_id).all<Shipment & { discharge_period_months: number; exported: number; returned: number }>()

  const rows = (results || []).map(r => computeDischargeRow(
    r, r.discharge_period_months, Number(r.exported), Number(r.returned),
  ))
  return c.json({
    discharge: rows,
    summary: {
      exports: rows.length,
      discharged: rows.filter(r => r.status === 'discharged').length,
      overdue: rows.filter(r => r.status === 'overdue').length,
      closing: rows.filter(r => r.status === 'closing').length,
      open: rows.filter(r => r.status === 'open').length,
      devices_outstanding: rows.reduce((s, r) => s + Math.max(0, r.outstanding), 0),
    },
  })
})

// Proof-of-export fields share one validator: declaration-safe-ish refs
// (letters/digits/spaces and the dash used in MRN/DUCR formats).
function cleanProofRef(raw: unknown, label: string):
  | { ok: true; value: string | null }
  | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: null }
  const v = cleanString(raw, 40)
  if (!v) return { ok: true, value: null }
  if (!/^[A-Za-z0-9 \-\/]+$/.test(v)) return { ok: false, error: `${label} may contain letters, numbers, spaces, dashes and slashes only` }
  return { ok: true, value: v.toUpperCase() }
}

// OPR 3 — the import finalisation = RECEIPT of the returning consignment.
// Red-blocked by the import validation engine; every device →
// RETURNED_UNDER_OPR through the real state machine (event-logged with
// the import MRN); captures import_mrn; locks lines. Restocking to
// ACTIVE_INVENTORY is the separate explicit /restock step.
async function finaliseImportShipment(
  c: OprContext,
  user: AuthUser,
  bundle: { shipment: Shipment; lines: ShipmentLine[]; authorisation: OprAuthorisation | null; relatedExport: Shipment | null },
) {
  const { shipment, lines, authorisation, relatedExport } = bundle
  const id = shipment.id

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const mrn = cleanProofRef(body.import_mrn, 'import_mrn')
  if (!mrn.ok) return c.json({ error: mrn.error }, 422)

  const validation = runImportValidation(shipment, relatedExport, authorisation, lines)
  if (validation.result === 'red') {
    return c.json({ error: 'Receipt blocked — validation has red results', validation }, 422)
  }

  // Devices must all still be EXPORTED_UNDER_OPR (returns don't move
  // status while DRAFT, so anything else means out-of-band mutation).
  const deviceIds = lines.map(l => l.received_device_id)
  for (const deviceId of deviceIds) {
    const d = await c.env.DB.prepare('SELECT status FROM received_devices WHERE id = ?')
      .bind(deviceId).first<{ status: DeviceStatus }>()
    if (!d || d.status !== 'EXPORTED_UNDER_OPR') {
      return c.json({ error: `Device ${deviceId} is ${d?.status ?? 'missing'} — every device on the return must be EXPORTED_UNDER_OPR to receive` }, 409)
    }
  }

  const upd = await c.env.DB.prepare(
    `UPDATE shipments SET status = 'FINALISED', import_mrn = COALESCE(?, import_mrn),
       finalised_at = CURRENT_TIMESTAMP, finalised_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND organisation_id = ? AND status = 'DRAFT'`
  ).bind(mrn.value, user.id, id, user.organisation_id).run()
  if (!upd.meta.changes) {
    return c.json({ error: 'Shipment was modified concurrently — reload and retry' }, 409)
  }

  for (const deviceId of deviceIds) {
    await transitionDevice(c.env.DB, deviceId, 'RETURNED_UNDER_OPR', {
      user,
      reference: shipment.reference,
      metadata: { shipment_id: id, import_mrn: mrn.value, related_export_shipment_id: shipment.related_export_shipment_id },
      eventType: 'IMPORT_RECEIVED',
    })
  }

  const finalised = await c.env.DB.prepare('SELECT * FROM shipments WHERE id = ?').bind(id).first()
  await notifyShipmentEvent(c, {
    event: 'shipment.finalised',
    organisation_id: user.organisation_id,
    shipment_id: id,
    reference: shipment.reference,
    direction: 'import',
    status: 'FINALISED',
    import_mrn: mrn.value,
    device_count: deviceIds.length,
    user_id: user.id,
    occurred_at: new Date().toISOString(),
  })
  return c.json({ ok: true, shipment: finalised, devices_returned: deviceIds.length, validation })
}

// POST /shipments/:id/finalise — direction-aware lock. Exports (OPR 2):
// red-blocked, devices → EXPORTED_UNDER_OPR, captures MRN/DUCR/EAD.
// Imports (OPR 3): receipt — red-blocked by the import engine, devices →
// RETURNED_UNDER_OPR, captures import_mrn.
app.post('/shipments/:id/finalise', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const bundle = await loadShipmentBundle(c, user, id)
  if (!bundle.ok) return bundle.response
  const { shipment, lines, authorisation } = bundle

  if (shipment.status !== 'DRAFT') {
    return c.json({ error: `Shipment is ${shipment.status} — only DRAFT shipments can be finalised` }, 409)
  }
  if (shipment.direction === 'import') {
    return finaliseImportShipment(c, user, bundle)
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const mrn = cleanProofRef(body.export_mrn, 'export_mrn')
  if (!mrn.ok) return c.json({ error: mrn.error }, 422)
  const ducr = cleanProofRef(body.ducr, 'ducr')
  if (!ducr.ok) return c.json({ error: ducr.error }, 422)
  const ead = cleanProofRef(body.ead_mrn, 'ead_mrn')
  if (!ead.ok) return c.json({ error: ead.error }, 422)
  const mucr = cleanProofRef(body.mucr, 'mucr')
  if (!mucr.ok) return c.json({ error: mucr.error }, 422)

  // The gate: any red check blocks finalisation. Ambers pass but are
  // returned so the caller can surface them.
  const validation = runExportValidation(shipment, authorisation, lines)
  if (validation.result === 'red') {
    return c.json({
      error: 'Finalisation blocked — validation has red results',
      validation,
    }, 422)
  }

  // Devices must all still be IN_EXPORT_CONSIGNMENT (they are, unless rows
  // predate the OPR 2 wiring or were mutated out-of-band).
  const deviceIds = lines.map(l => l.received_device_id)
  for (const deviceId of deviceIds) {
    const d = await c.env.DB.prepare('SELECT status FROM received_devices WHERE id = ?')
      .bind(deviceId).first<{ status: DeviceStatus }>()
    if (!d || d.status !== 'IN_EXPORT_CONSIGNMENT') {
      return c.json({ error: `Device ${deviceId} is ${d?.status ?? 'missing'} — every device on the consignment must be IN_EXPORT_CONSIGNMENT to finalise` }, 409)
    }
  }

  // Flip the shipment first (guarded UPDATE doubles as a lost-race check),
  // then walk the devices through the state machine so each transition is
  // validated and event-logged.
  const upd = await c.env.DB.prepare(
    `UPDATE shipments SET status = 'FINALISED', export_mrn = COALESCE(?, export_mrn),
       ducr = COALESCE(?, ducr), ead_mrn = COALESCE(?, ead_mrn), mucr = COALESCE(?, mucr),
       finalised_at = CURRENT_TIMESTAMP, finalised_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND organisation_id = ? AND status = 'DRAFT'`
  ).bind(mrn.value, ducr.value, ead.value, mucr.value, user.id, id, user.organisation_id).run()
  if (!upd.meta.changes) {
    return c.json({ error: 'Shipment was modified concurrently — reload and retry' }, 409)
  }

  for (const deviceId of deviceIds) {
    await transitionDevice(c.env.DB, deviceId, 'EXPORTED_UNDER_OPR', {
      user,
      reference: shipment.reference,
      metadata: { shipment_id: id, export_mrn: mrn.value },
      eventType: 'EXPORT_FINALISED',
    })
  }

  const finalised = await c.env.DB.prepare('SELECT * FROM shipments WHERE id = ?').bind(id).first()
  await notifyShipmentEvent(c, {
    event: 'shipment.finalised',
    organisation_id: user.organisation_id,
    shipment_id: id,
    reference: shipment.reference,
    direction: 'export',
    status: 'FINALISED',
    export_mrn: mrn.value,
    device_count: deviceIds.length,
    user_id: user.id,
    occurred_at: new Date().toISOString(),
  })
  return c.json({ ok: true, shipment: finalised, devices_exported: deviceIds.length, validation })
})

// POST /shipments/:id/export-proof — record/replace MRN / DUCR / EAD after
// finalisation (e.g. when the carrier's declaration lands later). This is
// deliberately the ONLY mutation a FINALISED shipment accepts.
app.post('/shipments/:id/export-proof', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const shipment = await c.env.DB.prepare(
    'SELECT * FROM shipments WHERE id = ? AND organisation_id = ?'
  ).bind(id, user.organisation_id).first<Shipment>()
  if (!shipment) return c.json({ error: 'Shipment not found' }, 404)
  if (shipment.direction !== 'export') {
    return c.json({ error: 'Export proof belongs to EXPORT shipments — record the 6121 MRN on an import via /import-proof' }, 409)
  }
  if (shipment.status !== 'FINALISED') {
    return c.json({ error: `Shipment is ${shipment.status} — export proof is recorded on FINALISED shipments (finalise first, or pass the refs to /finalise)` }, 409)
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)

  const fields: Record<string, string> = {}
  for (const [key, label] of [['export_mrn', 'export_mrn'], ['ducr', 'ducr'], ['ead_mrn', 'ead_mrn'], ['mucr', 'mucr']] as const) {
    if (body[key] !== undefined) {
      const parsed = cleanProofRef(body[key], label)
      if (!parsed.ok) return c.json({ error: parsed.error }, 422)
      if (parsed.value) fields[key] = parsed.value
    }
  }
  if (!Object.keys(fields).length) return c.json({ error: 'Provide at least one of export_mrn, ducr, ead_mrn, mucr' }, 422)

  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ')
  await c.env.DB.prepare(
    `UPDATE shipments SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organisation_id = ?`
  ).bind(...Object.values(fields), id, user.organisation_id).run()

  const updated = await c.env.DB.prepare('SELECT * FROM shipments WHERE id = ?').bind(id).first()
  return c.json({ ok: true, shipment: updated })
})

// POST /shipments/:id/import-proof — record/replace the 6121 import MRN
// after receipt (the import mirror of /export-proof; the only mutation a
// FINALISED import shipment accepts).
app.post('/shipments/:id/import-proof', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const shipment = await c.env.DB.prepare(
    'SELECT * FROM shipments WHERE id = ? AND organisation_id = ?'
  ).bind(id, user.organisation_id).first<Shipment>()
  if (!shipment) return c.json({ error: 'Shipment not found' }, 404)
  if (shipment.direction !== 'import') {
    return c.json({ error: 'Import proof belongs to IMPORT shipments — record export refs via /export-proof' }, 409)
  }
  if (shipment.status !== 'FINALISED') {
    return c.json({ error: `Shipment is ${shipment.status} — import proof is recorded on FINALISED (received) shipments` }, 409)
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
  const mrn = cleanProofRef(body.import_mrn, 'import_mrn')
  if (!mrn.ok) return c.json({ error: mrn.error }, 422)
  if (!mrn.value) return c.json({ error: 'import_mrn is required' }, 422)

  await c.env.DB.prepare(
    'UPDATE shipments SET import_mrn = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organisation_id = ?'
  ).bind(mrn.value, id, user.organisation_id).run()
  const updated = await c.env.DB.prepare('SELECT * FROM shipments WHERE id = ?').bind(id).first()
  return c.json({ ok: true, shipment: updated })
})

// POST /shipments/:id/restock — move the received consignment's devices
// RETURNED_UNDER_OPR → ACTIVE_INVENTORY. Deliberately a separate explicit
// step after receipt (goods are checked in before going back on sale).
// Idempotent-ish: already-restocked devices are skipped, not errors.
app.post('/shipments/:id/restock', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const bundle = await loadShipmentBundle(c, user, id)
  if (!bundle.ok) return bundle.response
  const { shipment, lines } = bundle
  if (shipment.direction !== 'import') {
    return c.json({ error: 'Restock applies to IMPORT (return) consignments' }, 409)
  }
  if (shipment.status !== 'FINALISED') {
    return c.json({ error: `Shipment is ${shipment.status} — receive the consignment (finalise) before restocking` }, 409)
  }

  let restocked = 0
  const skipped: { device_id: number; status: string }[] = []
  for (const line of lines) {
    const d = await c.env.DB.prepare('SELECT id, status FROM received_devices WHERE id = ? AND organisation_id = ?')
      .bind(line.received_device_id, user.organisation_id).first<{ id: number; status: DeviceStatus }>()
    if (!d) { skipped.push({ device_id: line.received_device_id, status: 'missing' }); continue }
    if (d.status !== 'RETURNED_UNDER_OPR') { skipped.push({ device_id: d.id, status: d.status }); continue }
    await transitionDevice(c.env.DB, d.id, 'ACTIVE_INVENTORY', {
      user,
      reference: shipment.reference,
      metadata: { shipment_id: id },
      eventType: 'RETURN_RESTOCKED',
    })
    restocked++
  }
  if (restocked > 0) {
    await notifyShipmentEvent(c, {
      event: 'shipment.restocked',
      organisation_id: user.organisation_id,
      shipment_id: id,
      reference: shipment.reference,
      direction: 'import',
      status: shipment.status,
      import_mrn: shipment.import_mrn ?? null,
      device_count: restocked,
      user_id: user.id,
      occurred_at: new Date().toISOString(),
    })
  }
  return c.json({ ok: true, restocked, skipped })
})

// ───────── OPR 4: actually sending email (Gmail REST) ─────────
//
// POST /shipments/:id/prealert/send — sends the pre-alert email to the
// authorisation's configured mailbox with the commercial invoice + scan-out
// list attached as HTML. POST /shipments/:id/clearance/send — sends the
// clearance instruction (with the C&E1154 attached when computable) to the
// mailbox in the body (or the authorisation's pre-alert mailbox).
//
// HONESTY: with no GMAIL_* secrets configured these refuse 503 and write
// NOTHING — the sent_emails outbox records real attempts only. Every
// attempt (success or provider failure) is recorded with the outcome.

async function recordEmail(c: OprContext, row: {
  organisationId: number; shipmentId: number; kind: 'prealert' | 'clearance'
  to: string; subject: string; status: 'sent' | 'failed' | 'manual'
  provider?: 'gmail' | 'manual'
  messageId?: string | null; error?: string | null; userId: number
}): Promise<number> {
  const ins = await c.env.DB.prepare(
    `INSERT INTO sent_emails (organisation_id, shipment_id, kind, to_email, subject, provider, provider_message_id, status, error, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(row.organisationId, row.shipmentId, row.kind, row.to, row.subject,
    row.provider ?? 'gmail', row.messageId ?? null, row.status, row.error ?? null, row.userId).run()
  return Number(ins.meta.last_row_id)
}

// ───────── OPR 6: manual dispatch (until Gmail integration is live) ─────────
//
// POST /shipments/:id/prealert/mark-sent and /clearance/mark-sent — the
// operator copies the draft out of the UI, sends it from their own mail
// client, then records the manual send here. The outbox row is written
// with provider='manual' / status='manual' so it can NEVER be confused
// with a real system send: the honesty rule stays intact (a 'sent' row
// still means the system itself delivered via a provider).
//
// The recorded to/subject are taken from the SERVER-built draft (not the
// client), so the audit row reflects what the system drafted; the operator
// may override `to` (they may have sent it to a different mailbox) — the
// override is recorded as given.

function cleanManualEmailOverride(raw: unknown):
  | { ok: true; value: string | null }
  | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, error: 'to must be a string email address' }
  const v = raw.trim()
  if (v.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    return { ok: false, error: 'to must be a valid email address' }
  }
  return { ok: true, value: v.toLowerCase() }
}

app.post('/shipments/:id/prealert/mark-sent', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const bundle = await loadShipmentBundle(c, user, id)
  if (!bundle.ok) return bundle.response
  const { shipment, lines, authorisation } = bundle
  if (shipment.direction !== 'export') {
    return c.json({ error: 'Pre-alerts cover EXPORT consignments' }, 409)
  }
  if (!authorisation) return c.json({ error: 'Shipment has no resolvable authorisation' }, 422)
  if (!lines.length) return c.json({ error: 'Consignment has no lines — nothing to pre-alert' }, 422)

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const override = cleanManualEmailOverride(body.to)
  if (!override.ok) return c.json({ error: override.error }, 422)

  const draft = buildPreAlertDraft(shipment, authorisation, lines)
  const to = override.value ?? draft.to
  if (!to) {
    return c.json({ error: 'No recipient — the authorisation has no pre-alert mailbox configured and no `to` was supplied' }, 422)
  }

  const emailId = await recordEmail(c, {
    organisationId: user.organisation_id, shipmentId: id, kind: 'prealert',
    to, subject: draft.subject, status: 'manual', provider: 'manual', userId: user.id,
  })
  return c.json({ ok: true, email_id: emailId, to, subject: draft.subject, provider: 'manual', status: 'manual' })
})

app.post('/shipments/:id/clearance/mark-sent', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const bundle = await loadShipmentBundle(c, user, id)
  if (!bundle.ok) return bundle.response
  const { shipment, lines, authorisation, relatedExport } = bundle
  if (shipment.direction !== 'import') {
    return c.json({ error: 'Clearance instructions cover IMPORT (re-import) consignments' }, 409)
  }
  if (!authorisation) return c.json({ error: 'Shipment has no resolvable authorisation' }, 422)
  if (!lines.length) return c.json({ error: 'Import consignment has no lines — nothing to clear' }, 422)

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const override = cleanManualEmailOverride(body.to)
  if (!override.ok) return c.json({ error: override.error }, 422)

  const to = override.value ?? authorisation.prealert_email ?? null
  if (!to) {
    return c.json({ error: 'No recipient — supply `to` (or configure prealert_email on the authorisation)' }, 422)
  }

  const ce = computeCe1154(shipment, relatedExport, authorisation, lines)
  const draft = buildClearanceInstructionDraft(shipment, relatedExport, authorisation, lines, ce.ok ? ce.ce1154 : null)

  const emailId = await recordEmail(c, {
    organisationId: user.organisation_id, shipmentId: id, kind: 'clearance',
    to, subject: draft.subject, status: 'manual', provider: 'manual', userId: user.id,
  })
  return c.json({ ok: true, email_id: emailId, to, subject: draft.subject, provider: 'manual', status: 'manual' })
})

app.post('/shipments/:id/prealert/send', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const cfg = gmailConfigFromEnv(c.env as unknown as Record<string, unknown>)
  if (!cfg) {
    return c.json({
      error: 'Email sending is not configured — set the GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN secrets. The draft endpoint (/prealert) still works.',
      code: 'gmail_not_configured',
    }, 503)
  }

  const bundle = await loadShipmentBundle(c, user, id)
  if (!bundle.ok) return bundle.response
  const { shipment, lines, authorisation } = bundle
  if (shipment.direction !== 'export') {
    return c.json({ error: 'Pre-alerts cover EXPORT consignments' }, 409)
  }
  if (!authorisation) return c.json({ error: 'Shipment has no resolvable authorisation' }, 422)
  if (!lines.length) return c.json({ error: 'Consignment has no lines — nothing to pre-alert' }, 422)

  const draft = buildPreAlertDraft(shipment, authorisation, lines)
  if (!draft.to) {
    return c.json({ error: 'No pre-alert mailbox configured on the authorisation (set prealert_email) — refusing to invent a recipient' }, 422)
  }

  const attachments: EmailAttachment[] = [
    { filename: `invoice-${shipment.reference.replace(/\s+/g, '-')}.html`, contentType: 'text/html', content: buildCommercialInvoiceHtml(shipment, authorisation, lines) },
    { filename: `scan-out-${shipment.reference.replace(/\s+/g, '-')}.html`, contentType: 'text/html', content: JSON.stringify(buildScanOutList(shipment, lines), null, 2) },
  ]
  const result = await sendGmail(cfg, { to: draft.to, subject: draft.subject, body: draft.body, attachments })

  const emailId = await recordEmail(c, {
    organisationId: user.organisation_id, shipmentId: id, kind: 'prealert',
    to: draft.to, subject: draft.subject,
    status: result.ok ? 'sent' : 'failed',
    messageId: result.ok ? result.messageId : null,
    error: result.ok ? null : result.error,
    userId: user.id,
  })

  if (!result.ok) {
    return c.json({ error: `Pre-alert send failed: ${result.error}`, email_id: emailId }, 502)
  }
  return c.json({ ok: true, email_id: emailId, to: draft.to, subject: draft.subject, provider_message_id: result.messageId, attachments: attachments.map(a => a.filename) })
})

app.post('/shipments/:id/clearance/send', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const cfg = gmailConfigFromEnv(c.env as unknown as Record<string, unknown>)
  if (!cfg) {
    return c.json({
      error: 'Email sending is not configured — set the GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN secrets. The draft endpoint (/clearance) still works.',
      code: 'gmail_not_configured',
    }, 503)
  }

  const bundle = await loadShipmentBundle(c, user, id)
  if (!bundle.ok) return bundle.response
  const { shipment, lines, authorisation, relatedExport } = bundle
  if (shipment.direction !== 'import') {
    return c.json({ error: 'Clearance instructions cover IMPORT (re-import) consignments' }, 409)
  }
  if (!authorisation) return c.json({ error: 'Shipment has no resolvable authorisation' }, 422)
  if (!lines.length) return c.json({ error: 'Import consignment has no lines — nothing to clear' }, 422)

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const to = cleanString(body.to, 254) || authorisation.prealert_email || null
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return c.json({ error: 'A valid recipient is required — pass { to } or configure prealert_email on the authorisation' }, 422)
  }

  const ce = computeCe1154(shipment, relatedExport, authorisation, lines)
  const draft = buildClearanceInstructionDraft(shipment, relatedExport, authorisation, lines, ce.ok ? ce.ce1154 : null)
  const attachments: EmailAttachment[] = ce.ok
    ? [{ filename: `ce1154-${shipment.reference.replace(/\s+/g, '-')}.html`, contentType: 'text/html', content: buildCe1154Html(ce.ce1154, shipment, lines) }]
    : []
  const result = await sendGmail(cfg, { to, subject: draft.subject, body: draft.body, attachments })

  const emailId = await recordEmail(c, {
    organisationId: user.organisation_id, shipmentId: id, kind: 'clearance',
    to, subject: draft.subject,
    status: result.ok ? 'sent' : 'failed',
    messageId: result.ok ? result.messageId : null,
    error: result.ok ? null : result.error,
    userId: user.id,
  })

  if (!result.ok) {
    return c.json({ error: `Clearance send failed: ${result.error}`, email_id: emailId }, 502)
  }
  return c.json({
    ok: true, email_id: emailId, to, subject: draft.subject, provider_message_id: result.messageId,
    attachments: attachments.map(a => a.filename),
    ...(ce.ok ? {} : { ce1154_note: `C&E1154 not attached: ${ce.error}` }),
  })
})

// GET /shipments/:id/emails — the sent_emails outbox for a shipment. An
// empty list genuinely means nothing was ever attempted.
app.get('/shipments/:id/emails', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  const bundle = await loadShipmentBundle(c, user, id)
  if (!bundle.ok) return bundle.response
  const { results } = await c.env.DB.prepare(
    'SELECT id, kind, to_email, subject, provider, provider_message_id, status, error, user_id, created_at FROM sent_emails WHERE shipment_id = ? AND organisation_id = ? ORDER BY id DESC'
  ).bind(id, user.organisation_id).all()
  return c.json({ emails: results })
})

// ───────── OPR 4: bulk endpoint for downstream consumers ─────────
//
// POST /shipments/:id/scan-bulk — add MANY devices to a DRAFT consignment
// in one call (body: { imeis: [...] }, max 200). Per-IMEI outcomes: each
// entry succeeds or fails INDEPENDENTLY through exactly the same
// direction-aware gate as single /scan — a bad IMEI never blocks the rest,
// and a failed entry provably leaves no line/status/event side-effects
// (same guarantees, same code path).
app.post('/shipments/:id/scan-bulk', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const gate = await loadDraftShipment(c, user, id)
  if (!gate.ok) return gate.response

  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body || !Array.isArray(body.imeis)) {
    return c.json({ error: 'Body must be { imeis: […] }' }, 422)
  }
  if (!body.imeis.length) return c.json({ error: 'imeis is empty' }, 422)
  if (body.imeis.length > 200) return c.json({ error: 'Maximum 200 IMEIs per bulk call' }, 422)

  const results: { imei: string; ok: boolean; status: number; error?: string; line_id?: number }[] = []
  for (const raw of body.imeis) {
    const imei = cleanString(raw, 16)
    if (!imei) { results.push({ imei: String(raw ?? ''), ok: false, status: 422, error: 'imei is required' }); continue }

    const device = await c.env.DB.prepare(
      'SELECT * FROM received_devices WHERE imei = ? AND organisation_id = ?'
    ).bind(imei, user.organisation_id).first<Record<string, unknown>>()
    if (!device) { results.push({ imei, ok: false, status: 404, error: `No device with IMEI ${imei} in inventory` }); continue }

    const res = gate.shipment.direction === 'import'
      ? await addDeviceToReturnShipment(c, user, gate.shipment, device)
      : await addDeviceToShipment(c, user, gate.shipment, device)
    const data = await res.json() as { error?: string; line?: { id: number } }
    results.push(res.status === 201
      ? { imei, ok: true, status: 201, line_id: data.line?.id }
      : { imei, ok: false, status: res.status, error: data.error })
  }

  const added = results.filter(r => r.ok).length
  return c.json({ ok: true, requested: results.length, added, failed: results.length - added, results })
})

export default app
