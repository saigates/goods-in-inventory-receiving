// OPR (Outward Processing Relief) routes — OPR 1 (foundation) + OPR 2
// (export flow).
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
// Explicitly OUT of scope (OPR 3/4 — do not add without a brief):
//   - import/return consignments (line adds on import shipments are
//     refused), C&E1154 generation, discharge tracking, automation.

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Bindings, AuthUser, Shipment, ShipmentLine, OprAuthorisation, DeviceStatus } from '../types'
import { currentUser } from '../lib/auth'
import { cleanString } from '../lib/validate'
import { transitionDevice } from '../lib/deviceLifecycle'
import { runExportValidation } from '../lib/oprValidation'
import { buildCommercialInvoiceHtml, buildScanOutList, buildPreAlertDraft } from '../lib/oprDocs'
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
  if (want('chief_number')) {
    // Optional, but if present keep as-is (contains slashes by format).
    fields.chief_number = cleanString(body.chief_number, 40)
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
        (organisation_id, holder_name, eori, cds_number, chief_number,
         valid_from, valid_to, supervising_office_name, supervising_office_code,
         commodity_scope, commodity_codes, rate_of_yield, discharge_period_months, notes,
         prealert_email, prealert_cutoff)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      user.organisation_id, f.holder_name, f.eori, f.cds_number, f.chief_number ?? null,
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
    const shipment = await c.env.DB.prepare('SELECT * FROM shipments WHERE id = ?')
      .bind(result.meta.last_row_id).first()
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

// Loads + gates the shipment for consignment building: must exist, be
// org-scoped, be an EXPORT (import builders are OPR 3), and be DRAFT.
async function loadDraftExportShipment(
  c: OprContext,
  user: AuthUser,
  id: number,
): Promise<{ ok: true; shipment: Record<string, unknown> } | { ok: false; response: Response }> {
  const shipment = await c.env.DB.prepare(
    'SELECT * FROM shipments WHERE id = ? AND organisation_id = ?'
  ).bind(id, user.organisation_id).first<Record<string, unknown>>()
  if (!shipment) return { ok: false, response: c.json({ error: 'Shipment not found' }, 404) }
  if (shipment.direction !== 'export') {
    return { ok: false, response: c.json({ error: 'Devices can only be scanned onto EXPORT consignments — import/return consignment building is the OPR 3 flow' }, 409) }
  }
  if (shipment.status !== 'DRAFT') {
    return { ok: false, response: c.json({ error: `Shipment is ${shipment.status} — lines can only be changed while DRAFT` }, 409) }
  }
  return { ok: true, shipment }
}

app.post('/shipments/:id/lines', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const gate = await loadDraftExportShipment(c, user, id)
  if (!gate.ok) return gate.response

  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
  const deviceId = Number(body.device_id)
  if (!deviceId) return c.json({ error: 'device_id is required' }, 422)

  const device = await c.env.DB.prepare(
    'SELECT * FROM received_devices WHERE id = ? AND organisation_id = ?'
  ).bind(deviceId, user.organisation_id).first<Record<string, unknown>>()
  if (!device) return c.json({ error: `Device ${deviceId} not found` }, 404)

  return addDeviceToShipment(c, user, gate.shipment, device)
})

// POST /shipments/:id/scan { imei } — the scanner-first consignment
// builder: look the device up by IMEI and add it (same rules as /lines).
app.post('/shipments/:id/scan', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const gate = await loadDraftExportShipment(c, user, id)
  if (!gate.ok) return gate.response

  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
  const imei = cleanString(body.imei, 16)
  if (!imei) return c.json({ error: 'imei is required' }, 422)

  const device = await c.env.DB.prepare(
    'SELECT * FROM received_devices WHERE imei = ? AND organisation_id = ?'
  ).bind(imei, user.organisation_id).first<Record<string, unknown>>()
  if (!device) return c.json({ error: `No device with IMEI ${imei} in inventory` }, 404)

  return addDeviceToShipment(c, user, gate.shipment, device)
})

app.delete('/shipments/:id/lines/:lineId', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const lineId = Number(c.req.param('lineId'))
  if (!id || !lineId) return c.json({ error: 'Invalid id' }, 400)

  const shipment = await c.env.DB.prepare(
    'SELECT status, reference FROM shipments WHERE id = ? AND organisation_id = ?'
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
): Promise<{ ok: true; shipment: Shipment; lines: ShipmentLine[]; authorisation: OprAuthorisation | null } | { ok: false; response: Response }> {
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
  return { ok: true, shipment, lines, authorisation: authorisation ?? null }
}

// GET /shipments/:id/validation — run the green/amber/red engine.
app.get('/shipments/:id/validation', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  const bundle = await loadShipmentBundle(c, user, id)
  if (!bundle.ok) return bundle.response
  if (bundle.shipment.direction !== 'export') {
    return c.json({ error: 'Validation engine covers EXPORT consignments — import validation is the OPR 3 flow' }, 409)
  }
  const validation = runExportValidation(bundle.shipment, bundle.authorisation, bundle.lines)
  return c.json({ shipment_id: id, status: bundle.shipment.status, validation })
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

// POST /shipments/:id/finalise — the OPR 2 lock. Red-blocked by the
// validation engine; locks lines; every device → EXPORTED_UNDER_OPR;
// optionally captures export_mrn / ducr / ead_mrn in the same call.
app.post('/shipments/:id/finalise', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const bundle = await loadShipmentBundle(c, user, id)
  if (!bundle.ok) return bundle.response
  const { shipment, lines, authorisation } = bundle

  if (shipment.direction !== 'export') {
    return c.json({ error: 'Finalisation covers EXPORT consignments — import discharge is the OPR 3 flow' }, 409)
  }
  if (shipment.status !== 'DRAFT') {
    return c.json({ error: `Shipment is ${shipment.status} — only DRAFT shipments can be finalised` }, 409)
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const mrn = cleanProofRef(body.export_mrn, 'export_mrn')
  if (!mrn.ok) return c.json({ error: mrn.error }, 422)
  const ducr = cleanProofRef(body.ducr, 'ducr')
  if (!ducr.ok) return c.json({ error: ducr.error }, 422)
  const ead = cleanProofRef(body.ead_mrn, 'ead_mrn')
  if (!ead.ok) return c.json({ error: ead.error }, 422)

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
       ducr = COALESCE(?, ducr), ead_mrn = COALESCE(?, ead_mrn),
       finalised_at = CURRENT_TIMESTAMP, finalised_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND organisation_id = ? AND status = 'DRAFT'`
  ).bind(mrn.value, ducr.value, ead.value, user.id, id, user.organisation_id).run()
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
  if (shipment.status !== 'FINALISED') {
    return c.json({ error: `Shipment is ${shipment.status} — export proof is recorded on FINALISED shipments (finalise first, or pass the refs to /finalise)` }, 409)
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)

  const fields: Record<string, string> = {}
  for (const [key, label] of [['export_mrn', 'export_mrn'], ['ducr', 'ducr'], ['ead_mrn', 'ead_mrn']] as const) {
    if (body[key] !== undefined) {
      const parsed = cleanProofRef(body[key], label)
      if (!parsed.ok) return c.json({ error: parsed.error }, 422)
      if (parsed.value) fields[key] = parsed.value
    }
  }
  if (!Object.keys(fields).length) return c.json({ error: 'Provide at least one of export_mrn, ducr, ead_mrn' }, 422)

  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ')
  await c.env.DB.prepare(
    `UPDATE shipments SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organisation_id = ?`
  ).bind(...Object.values(fields), id, user.organisation_id).run()

  const updated = await c.env.DB.prepare('SELECT * FROM shipments WHERE id = ?').bind(id).first()
  return c.json({ ok: true, shipment: updated })
})

export default app
