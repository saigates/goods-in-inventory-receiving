import { Hono } from 'hono'
import type { Bindings, ExpectedDevice, ReceivedDevice, AuthUser } from '../types'
import { buildSku } from '../lib/sku'
import { shortUuid } from '../lib/uuid'
import { normalizeGrade } from '../lib/grade'
import { resolveCatalogSku, normalizeCapacity, matchCatalogRows } from '../lib/catalog'
import type { CatalogLookup, CatalogRow } from '../lib/catalog'
import { currentUser } from '../lib/auth'
import { validateImei, validateBuyPrice, isValidCurrency, isValidVatType, normalizeCurrency, cleanString } from '../lib/validate'
import { logDeviceEvent } from '../lib/deviceLifecycle'
import { isValidIsoDate } from '../lib/opr'

// SQLite raises 'UNIQUE constraint failed: received_devices.imei' if a
// duplicate IMEI slips past the pre-check. Detect that so we can return
// a friendly outcome instead of a 500.
function isImeiUniqueError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed:\s*received_devices\.imei/i.test(msg)
}

const app = new Hono<{ Bindings: Bindings; Variables: { user: AuthUser } }>()

// Validate + normalise the optional valuation/VAT fields shared by
// /confirm, /force-add and /manual (Priority 4). Returns either the
// normalised values or a 422-shaped error the caller can return directly.
//
// buy_price and vat_type are REQUIRED on EVERY path that creates a device
// (/confirm, /force-add, /manual) — general rule, earned through evidence:
// force-add shipped with `required: false` and was a real valuation bypass
// until caught. Any future intake path inherits `required: true` by
// default; opting OUT must be a deliberate, reviewed decision. currency
// must always be a valid ISO 4217 code (default GBP).
function parseValuation(
  body: { buy_price?: unknown; currency?: unknown; vat_type?: unknown },
  opts: { required: boolean },
): { ok: true; buy_price: number | null; currency: string; vat_type: string | null } | { ok: false; error: string } {
  let buyPrice: number | null = null
  if (body.buy_price != null && body.buy_price !== '') {
    const v = validateBuyPrice(body.buy_price)
    if (!v.ok) return { ok: false, error: v.reason }
    buyPrice = v.value
  } else if (opts.required) {
    return { ok: false, error: 'buy_price is required' }
  }

  let currency = 'GBP'
  if (body.currency != null && body.currency !== '') {
    if (!isValidCurrency(body.currency)) {
      return { ok: false, error: `currency '${body.currency}' is not a valid ISO 4217 code` }
    }
    currency = normalizeCurrency(body.currency)
  }

  let vatType: string | null = null
  if (body.vat_type != null && body.vat_type !== '') {
    if (!isValidVatType(body.vat_type)) {
      return { ok: false, error: `vat_type must be one of MARGIN, STANDARD, ZERO, PVAT` }
    }
    vatType = String(body.vat_type).trim().toUpperCase()
  } else if (opts.required) {
    return { ok: false, error: 'vat_type is required' }
  }

  return { ok: true, buy_price: buyPrice, currency, vat_type: vatType }
}

// Validate the optional backdated `received_at` field shared by
// /confirm, /bulk, /force-add and /manual (migration 0023). Mirrors the
// shipment_replies.received_at validation pattern (src/routes/opr.ts):
// accepts a date or datetime string, must not be in the future, defaults
// to CURRENT_TIMESTAMP (via SQL COALESCE) when omitted/null/empty.
function parseReceivedAt(
  body: { received_at?: unknown },
): { ok: true; received_at: string | null } | { ok: false; error: string } {
  if (body.received_at == null || body.received_at === '') return { ok: true, received_at: null }
  if (typeof body.received_at !== 'string' || !isValidIsoDate(body.received_at.slice(0, 10))) {
    return { ok: false, error: 'received_at must be an ISO date/datetime' }
  }
  const nowIso = new Date().toISOString()
  if (body.received_at > nowIso) {
    return { ok: false, error: 'received_at cannot be in the future' }
  }
  return { ok: true, received_at: body.received_at }
}

// Scan an IMEI against an active manifest.
// Returns one of:
//  - { outcome: 'matched',       expected, suggested_sku }   (needs SKU confirmation)
//  - { outcome: 'duplicate',     received }
//  - { outcome: 'unreconciled',  imei, message }             (caller decides: force-add or reject)
app.post('/', async (c) => {
  const user = currentUser(c)
  const body = await c.req.json<{ manifest_id: number; imei: string }>().catch(() => ({} as any))
  const manifestId = Number(body.manifest_id)
  const orgId = user.organisation_id

  if (!manifestId) return c.json({ error: 'manifest_id is required' }, 400)

  // Server-side IMEI validation is authoritative (Priority 5) — the SPA's
  // own check is optimistic UX only. Strictly 15 digits + Luhn checksum, or
  // a 10-character alphanumeric serial for non-cellular devices.
  const imeiCheck = validateImei(body.imei)
  if (!imeiCheck.ok) {
    await logDeviceEvent(c.env.DB, {
      organisationId: orgId, deviceId: null, eventType: 'SCAN', userId: user.id,
      reference: String(manifestId), metadata: { outcome: 'rejected', reason: imeiCheck.reason, raw_imei: body.imei },
    })
    await c.env.DB.prepare(
      "INSERT INTO scan_events (organisation_id, manifest_id, imei, outcome, message, user_id) VALUES (?, ?, ?, 'rejected', ?, ?)"
    ).bind(orgId, manifestId, String(body.imei ?? ''), imeiCheck.reason, user.id).run()
    return c.json({ outcome: 'rejected', imei: body.imei, message: imeiCheck.reason }, 200)
  }
  const imei = imeiCheck.imei

  // First: did we already receive this IMEI? (org-scoped)
  const alreadyReceived = await c.env.DB.prepare(
    'SELECT * FROM received_devices WHERE imei = ? AND organisation_id = ?'
  ).bind(imei, orgId).first<ReceivedDevice>()

  if (alreadyReceived) {
    await c.env.DB.prepare(
      "INSERT INTO scan_events (organisation_id, manifest_id, imei, outcome, message, user_id) VALUES (?, ?, ?, 'duplicate', 'Already received', ?)"
    ).bind(orgId, manifestId, imei, user.id).run()
    await logDeviceEvent(c.env.DB, {
      organisationId: orgId, deviceId: alreadyReceived.id, eventType: 'SCAN', userId: user.id,
      reference: String(manifestId), metadata: { outcome: 'duplicate' },
    })
    return c.json({ outcome: 'duplicate', received: alreadyReceived })
  }

  // Check manifest (org-scoped)
  const expected = await c.env.DB.prepare(
    'SELECT * FROM expected_devices WHERE manifest_id = ? AND imei = ? AND organisation_id = ?'
  ).bind(manifestId, imei, orgId).first<ExpectedDevice>()

  if (!expected) {
    await c.env.DB.prepare(
      "INSERT INTO scan_events (organisation_id, manifest_id, imei, outcome, message, user_id) VALUES (?, ?, ?, 'unreconciled', 'Not on manifest', ?)"
    ).bind(orgId, manifestId, imei, user.id).run()
    await logDeviceEvent(c.env.DB, {
      organisationId: orgId, deviceId: null, eventType: 'SCAN', userId: user.id,
      reference: String(manifestId), metadata: { outcome: 'unreconciled', imei },
    })
    return c.json({
      outcome: 'unreconciled',
      imei,
      message: 'This IMEI is not on the manifest. Reject or force-add to Unreconciled bucket.',
    })
  }

  // Catalog is the source of truth. Resolve the manifest line to a real
  // catalog SKU by (model, capacity, color, grade). The grade on the
  // manifest is taken verbatim — operator is expected to have set it to
  // A | B | C | UG before import (normalised at import time anyway).
  const grade = normalizeGrade(expected.grade)
  // Prefer model (the actual model column) over description for lookup.
  // expected.description is now optional and may be a junk code like "FL".
  const modelForLookup = expected.model_no || expected.description || null

  // Fast path: expected_devices.sku may already be pre-filled — either the
  // manifest upload matched it directly, or an operator used "Use this for
  // all other SKUs in this batch" (POST /manifests/:id/apply-sku-to-batch)
  // to stamp it onto this line after resolving a sibling with the same
  // (model, capacity, color, grade) signature. In that case, trust the
  // stored sku directly (a single indexed lookup by primary key, not the
  // 4-field catalog match) instead of re-running the same
  // (model, capacity, color, grade) lookup that produced no_match/ambiguous
  // at upload time in the first place — re-deriving it here would silently
  // ignore the pre-filled sku and show the same red banner again.
  let lookup: CatalogLookup
  if (expected.sku) {
    const row = await c.env.DB.prepare(
      'SELECT id, sku, brand, model, capacity, color, grade FROM sku_catalog WHERE sku = ? AND organisation_id = ?'
    ).bind(expected.sku, orgId).first<CatalogRow>()
    lookup = row
      ? { status: 'match', row }
      // The pre-filled sku no longer exists in the catalogue (e.g. deleted
      // after being applied) — fall back to the normal
      // (model, capacity, color, grade) resolution rather than failing
      // outright.
      : await resolveCatalogSku(c.env.DB, { model: modelForLookup, capacity: expected.capacity, color: expected.color, grade }, orgId)
  } else {
    lookup = await resolveCatalogSku(c.env.DB, { model: modelForLookup, capacity: expected.capacity, color: expected.color, grade }, orgId)
  }

  await c.env.DB.prepare(
    "INSERT INTO scan_events (organisation_id, manifest_id, imei, outcome, message, user_id) VALUES (?, ?, ?, 'matched', NULL, ?)"
  ).bind(orgId, manifestId, imei, user.id).run()
  await logDeviceEvent(c.env.DB, {
    organisationId: orgId, deviceId: null, eventType: 'SCAN', userId: user.id,
    reference: String(manifestId), metadata: { outcome: 'matched', imei },
  })

  // Normalised echo back to the UI so it can re-render with canonical values.
  const expectedOut = {
    ...expected,
    capacity: normalizeCapacity(expected.capacity),
  }

  if (lookup.status === 'match') {
    return c.json({
      outcome: 'matched',
      expected: expectedOut,
      catalog_match: { status: 'match', row: lookup.row },
    })
  }

  // No clean catalog match — surface it to the operator with the candidate
  // list so they can pick or correct. Modal opens with a red banner.
  return c.json({
    outcome: 'matched',
    expected: expectedOut,
    catalog_match: lookup, // { status: 'no_match' | 'ambiguous', candidates, reason }
  })
})

// Confirm a matched scan with a final SKU (and optionally color override).
// Creates received_devices row, marks expected as received, and queues a print job.
app.post('/confirm', async (c) => {
  const user = currentUser(c)
  const orgId = user.organisation_id
  const body = await c.req.json<{
    expected_device_id: number
    sku: string
    brand?: string
    model?: string
    capacity?: string
    color?: string
    grade?: string
    notes?: string
    auto_print?: boolean
    buy_price?: number | string
    currency?: string
    vat_type?: string
    supplier_id?: number
    received_at?: string
  }>().catch(() => ({} as any))

  if (!body.expected_device_id || !body.sku) {
    return c.json({ error: 'expected_device_id and sku required' }, 400)
  }

  // Valuation/VAT are required at goods-in confirm time (Priority 4).
  const valuation = parseValuation(body, { required: true })
  if (!valuation.ok) return c.json({ error: valuation.error }, 422)

  const receivedAt = parseReceivedAt(body)
  if (!receivedAt.ok) return c.json({ error: receivedAt.error }, 422)

  const expected = await c.env.DB.prepare(
    'SELECT * FROM expected_devices WHERE id = ? AND organisation_id = ?'
  ).bind(body.expected_device_id, orgId).first<ExpectedDevice>()
  if (!expected) return c.json({ error: 'Expected device not found' }, 404)
  if (expected.status === 'received') {
    return c.json({ error: 'Already received' }, 409)
  }

  // Catalog is the source of truth. The chosen SKU MUST exist in
  // sku_catalog — refuse otherwise so an operator can't print a label
  // for a SKU that isn't in the master list.
  const catalogRow = await c.env.DB.prepare(
    'SELECT sku, brand, model, capacity, color, grade FROM sku_catalog WHERE sku = ? AND organisation_id = ?'
  ).bind(body.sku, orgId).first<{ sku: string; brand: string; model: string; capacity: string | null; color: string | null; grade: string | null }>()
  if (!catalogRow) {
    return c.json({
      error: `SKU '${body.sku}' is not in the catalogue. Add it via the Catalog tab, then retry.`,
      code: 'sku_not_in_catalog',
    }, 422)
  }

  // Defensive: someone could have raced ahead and received this IMEI between
  // the scan event and the confirm. UNIQUE constraint will catch it too.
  const existing = await c.env.DB.prepare('SELECT id, uuid, sku FROM received_devices WHERE imei = ? AND organisation_id = ?')
    .bind(expected.imei, orgId).first<{ id: number; uuid: string; sku: string }>()
  if (existing) {
    return c.json({ error: `IMEI ${expected.imei} already received (UUID ${existing.uuid}, SKU ${existing.sku})` }, 409)
  }

  // Optional supplier_id must belong to this org if supplied.
  let supplierId: number | null = null
  if (body.supplier_id) {
    const sup = await c.env.DB.prepare('SELECT id FROM suppliers WHERE id = ? AND organisation_id = ?')
      .bind(Number(body.supplier_id), orgId).first()
    if (!sup) return c.json({ error: `supplier_id ${body.supplier_id} not found for this organisation` }, 400)
    supplierId = Number(body.supplier_id)
  }

  // Force grade into the strict A|B|C|UG set. The body grade wins if valid;
  // Grade: prefer the catalog row's grade (authoritative since the SKU
  // exists for that grade), fall back to body/manifest.
  const grade = normalizeGrade(catalogRow.grade ?? body.grade ?? expected.grade)

  // Use catalog's brand/model/capacity/color so we never drift from the
  // master list. The body's values are ignored on purpose.
  const uuid = shortUuid()
  let insRecv
  try {
    insRecv = await c.env.DB.prepare(
      `INSERT INTO received_devices
       (organisation_id, uuid, imei, sku, brand, model, capacity, color, grade, source, manifest_id, expected_device_id, notes,
        status, created_by_user_id, buy_price, currency, vat_type, supplier_id, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manifest', ?, ?, ?, 'RECEIVED', ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`
    ).bind(
      orgId,
      uuid,
      expected.imei,
      catalogRow.sku,
      catalogRow.brand,
      catalogRow.model,
      catalogRow.capacity,
      catalogRow.color,
      grade,
      expected.manifest_id,
      expected.id,
      cleanString(body.notes),
      user.id,
      valuation.buy_price,
      valuation.currency,
      valuation.vat_type,
      supplierId,
      receivedAt.received_at,
    ).run()
  } catch (err) {
    if (isImeiUniqueError(err)) {
      return c.json({ error: `IMEI ${expected.imei} already received` }, 409)
    }
    throw err
  }

  const receivedId = insRecv.meta.last_row_id as number

  await c.env.DB.prepare(
    `UPDATE expected_devices
     SET status = 'received', received_at = CURRENT_TIMESTAMP, received_device_id = ?
     WHERE id = ? AND organisation_id = ?`
  ).bind(receivedId, expected.id, orgId).run()

  // Audit the receive itself. The initial scan-lookup wrote a 'matched'
  // event; this 'received' event records that the modal was actually
  // confirmed, so the Recent scans panel stays in lock-step with
  // received_devices even if the lookup step was skipped (direct API).
  await c.env.DB.prepare(
    "INSERT INTO scan_events (organisation_id, manifest_id, imei, outcome, message, user_id) VALUES (?, ?, ?, 'received', ?, ?)"
  ).bind(orgId, expected.manifest_id, expected.imei, `SKU ${body.sku} · grade ${grade}`, user.id).run()

  // Full device-lifecycle audit event — this is the record the downstream
  // OPR customs process depends on (Priority 3).
  await logDeviceEvent(c.env.DB, {
    organisationId: orgId, deviceId: receivedId, eventType: 'RECEIVE', userId: user.id,
    toStatus: 'RECEIVED', reference: String(expected.manifest_id ?? ''),
    metadata: { sku: catalogRow.sku, grade, source: 'manifest', buy_price: valuation.buy_price, currency: valuation.currency, vat_type: valuation.vat_type },
  })

  // Queue print job
  let printJobId: number | null = null
  if (body.auto_print !== false) {
    const payload = {
      uuid,
      sku: catalogRow.sku,
      imei: expected.imei,
      brand: catalogRow.brand,
      model: catalogRow.model,
      capacity: catalogRow.capacity,
      color: catalogRow.color,
      grade,
    }
    const pj = await c.env.DB.prepare(
      `INSERT INTO print_jobs (organisation_id, received_device_id, payload_json, created_by_user_id) VALUES (?, ?, ?, ?)`
    ).bind(orgId, receivedId, JSON.stringify(payload), user.id).run()
    printJobId = pj.meta.last_row_id as number
  }

  const received = await c.env.DB.prepare('SELECT * FROM received_devices WHERE id = ?')
    .bind(receivedId).first<ReceivedDevice>()

  return c.json({ ok: true, received, print_job_id: printJobId })
})

// ───────── Bulk scan ─────────
//
// POST /scan/bulk — process MANY IMEIs against one manifest in a single
// call, instead of the operator scanning + confirming one at a time through
// the modal. Body: { manifest_id, imeis: [...] } (max 200, mirroring the
// OPR 4 scan-bulk cap in src/routes/opr.ts). Optional shared valuation
// fields (buy_price, currency, vat_type, supplier_id) apply to every IMEI
// in the batch that reaches a receivable outcome — this is the natural
// complement to "use this SKU for all other lines in this batch": once a
// batch of identical units all carry the same pre-filled catalog SKU
// (via /manifests/:id/apply-sku-to-batch), the operator can scan the whole
// stack and receive them in one shot with one shared cost/currency/VAT
// entry, rather than re-typing the same valuation in the confirm modal for
// every unit.
//
// Each IMEI is processed INDEPENDENTLY — a bad, duplicate, unreconciled, or
// unresolvable IMEI never blocks the rest of the batch and leaves NO
// partial side-effects of its own (same guarantee as /scan/confirm; this
// endpoint literally reuses /scan/confirm's core write sequence per row,
// just without a modal round-trip per device).
//
// Deliberately conservative about what it will auto-receive: an IMEI only
// receives automatically if
//   (a) it validates (15-digit Luhn or 10-char serial),
//   (b) it is on this manifest and still pending,
//   (c) it is not already received,
//   (d) the catalog match for it resolves to EXACTLY ONE sku — a
//       pre-filled expected_devices.sku (from apply-sku-to-batch) is
//       trusted directly, same fast-path as single /scan; otherwise it
//       falls back to the normal (model, capacity, color, grade) match.
// Anything else (unreconciled, ambiguous, no_match, already received,
// invalid IMEI) is reported back with a reason and NOT auto-resolved —
// the operator still has to go through the single-scan modal for those,
// same as before. This endpoint never invents a SKU or guesses among
// candidates.
//
// The catalog is loaded ONCE for the whole batch and matched in memory
// (matchCatalogRows) — the same "load once, match in memory" discipline
// that fixed the 197-IMEI production bug (see README) — so a 200-IMEI
// batch against a several-thousand-row catalog is O(1) catalog round
// trips, not O(imeis).
app.post('/bulk', async (c) => {
  const user = currentUser(c)
  const orgId = user.organisation_id

  const body = await c.req.json<{
    manifest_id?: number
    imeis?: unknown[]
    buy_price?: number | string
    currency?: string
    vat_type?: string
    supplier_id?: number
    auto_print?: boolean
    received_at?: string
  }>().catch(() => ({} as any))

  const manifestId = Number(body.manifest_id)
  if (!manifestId) return c.json({ error: 'manifest_id is required' }, 400)
  if (!Array.isArray(body.imeis)) return c.json({ error: 'Body must be { manifest_id, imeis: [...] }' }, 422)
  if (!body.imeis.length) return c.json({ error: 'imeis is empty' }, 422)
  if (body.imeis.length > 200) return c.json({ error: 'Maximum 200 IMEIs per bulk call' }, 422)

  const manifest = await c.env.DB.prepare(
    'SELECT id, status FROM manifests WHERE id = ? AND organisation_id = ?'
  ).bind(manifestId, orgId).first<{ id: number; status: string }>()
  if (!manifest) return c.json({ error: 'Manifest not found' }, 404)

  // Valuation is shared across the whole batch (Priority 4 still applies —
  // every device that gets created has buy_price/currency/vat_type, they
  // just come from one shared entry instead of a per-device modal).
  const valuation = parseValuation(body, { required: true })
  if (!valuation.ok) return c.json({ error: valuation.error }, 422)

  // received_at is also shared across the whole batch, same rationale.
  const receivedAt = parseReceivedAt(body)
  if (!receivedAt.ok) return c.json({ error: receivedAt.error }, 422)

  let supplierId: number | null = null
  if (body.supplier_id) {
    const sup = await c.env.DB.prepare('SELECT id FROM suppliers WHERE id = ? AND organisation_id = ?')
      .bind(Number(body.supplier_id), orgId).first()
    if (!sup) return c.json({ error: `supplier_id ${body.supplier_id} not found for this organisation` }, 400)
    supplierId = Number(body.supplier_id)
  }

  // Load the whole org catalog ONCE — matched in memory per row below.
  const { results: catalog } = await c.env.DB.prepare(
    'SELECT id, sku, brand, model, capacity, color, grade FROM sku_catalog WHERE organisation_id = ?'
  ).bind(orgId).all<CatalogRow>()
  const catalogBySku = new Map(catalog.map((r) => [r.sku, r]))

  type BulkOutcome = {
    imei: string
    ok: boolean
    outcome: 'received' | 'duplicate' | 'unreconciled' | 'rejected' | 'no_match' | 'ambiguous' | 'error'
    message?: string
    received_id?: number
    sku?: string
    print_job_id?: number | null
    // Populated for 'no_match' / 'ambiguous' only — lets the client resolve
    // these the same way the single-scan Confirm-SKU modal does: pick a
    // candidate row and (optionally) apply it to every other pending line
    // on this manifest sharing the same signature via
    // POST /manifests/:id/apply-sku-to-batch, then re-run the bulk scan.
    // Without this the operator has no way to act on a failed bulk line
    // except re-scanning it one at a time through the normal modal.
    expected_device_id?: number
    candidates?: CatalogRow[]
  }
  const results: BulkOutcome[] = []

  for (const raw of body.imeis) {
    const imeiCheck = validateImei(raw)
    if (!imeiCheck.ok) {
      results.push({ imei: String(raw ?? ''), ok: false, outcome: 'rejected', message: imeiCheck.reason })
      await logDeviceEvent(c.env.DB, {
        organisationId: orgId, deviceId: null, eventType: 'SCAN', userId: user.id,
        reference: String(manifestId), metadata: { outcome: 'rejected', reason: imeiCheck.reason, raw_imei: raw, bulk: true },
      })
      continue
    }
    const imei = imeiCheck.imei

    // Already received anywhere in this org?
    const already = await c.env.DB.prepare(
      'SELECT id, uuid FROM received_devices WHERE imei = ? AND organisation_id = ?'
    ).bind(imei, orgId).first<{ id: number; uuid: string }>()
    if (already) {
      results.push({ imei, ok: false, outcome: 'duplicate', message: `Already received (UUID ${already.uuid})` })
      continue
    }

    const expected = await c.env.DB.prepare(
      'SELECT * FROM expected_devices WHERE manifest_id = ? AND imei = ? AND organisation_id = ?'
    ).bind(manifestId, imei, orgId).first<ExpectedDevice>()
    if (!expected) {
      results.push({ imei, ok: false, outcome: 'unreconciled', message: 'Not on this manifest' })
      await c.env.DB.prepare(
        "INSERT INTO scan_events (organisation_id, manifest_id, imei, outcome, message, user_id) VALUES (?, ?, ?, 'unreconciled', 'Not on manifest (bulk)', ?)"
      ).bind(orgId, manifestId, imei, user.id).run()
      continue
    }
    if (expected.status === 'received') {
      results.push({ imei, ok: false, outcome: 'duplicate', message: 'This manifest line was already received' })
      continue
    }

    // Resolve catalog SKU: trust a pre-filled expected.sku first (same
    // fast-path as single /scan), else match in memory against the
    // catalog loaded above.
    const grade = normalizeGrade(expected.grade)
    let catalogRow: CatalogRow | undefined
    if (expected.sku) catalogRow = catalogBySku.get(expected.sku)
    if (!catalogRow) {
      const modelForLookup = expected.model_no || expected.description || null
      const lookup = matchCatalogRows(catalog, { model: modelForLookup, capacity: expected.capacity, color: expected.color, grade })
      if (lookup.status === 'match') catalogRow = lookup.row
      else {
        results.push({
          imei, ok: false, outcome: lookup.status, message: lookup.reason,
          expected_device_id: expected.id, candidates: lookup.candidates,
        })
        continue
      }
    }

    // Write the received device — same core sequence as /confirm.
    const uuid = shortUuid()
    let insRecv
    try {
      insRecv = await c.env.DB.prepare(
        `INSERT INTO received_devices
         (organisation_id, uuid, imei, sku, brand, model, capacity, color, grade, source, manifest_id, expected_device_id,
          status, created_by_user_id, buy_price, currency, vat_type, supplier_id, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manifest', ?, ?, 'RECEIVED', ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`
      ).bind(
        orgId, uuid, imei, catalogRow.sku, catalogRow.brand, catalogRow.model, catalogRow.capacity, catalogRow.color,
        normalizeGrade(catalogRow.grade ?? grade), manifestId, expected.id, user.id,
        valuation.buy_price, valuation.currency, valuation.vat_type, supplierId, receivedAt.received_at,
      ).run()
    } catch (err) {
      if (isImeiUniqueError(err)) {
        results.push({ imei, ok: false, outcome: 'duplicate', message: 'Already received (race)' })
        continue
      }
      results.push({ imei, ok: false, outcome: 'error', message: err instanceof Error ? err.message : String(err) })
      continue
    }

    const receivedId = insRecv.meta.last_row_id as number

    await c.env.DB.prepare(
      `UPDATE expected_devices SET status = 'received', received_at = CURRENT_TIMESTAMP, received_device_id = ? WHERE id = ? AND organisation_id = ?`
    ).bind(receivedId, expected.id, orgId).run()

    await c.env.DB.prepare(
      "INSERT INTO scan_events (organisation_id, manifest_id, imei, outcome, message, user_id) VALUES (?, ?, ?, 'received', ?, ?)"
    ).bind(orgId, manifestId, imei, `SKU ${catalogRow.sku} · grade ${grade} (bulk)`, user.id).run()

    await logDeviceEvent(c.env.DB, {
      organisationId: orgId, deviceId: receivedId, eventType: 'RECEIVE', userId: user.id,
      toStatus: 'RECEIVED', reference: String(manifestId),
      metadata: { sku: catalogRow.sku, grade, source: 'manifest', bulk: true, buy_price: valuation.buy_price, currency: valuation.currency, vat_type: valuation.vat_type },
    })

    let printJobId: number | null = null
    if (body.auto_print !== false) {
      const payload = { uuid, sku: catalogRow.sku, imei, brand: catalogRow.brand, model: catalogRow.model, capacity: catalogRow.capacity, color: catalogRow.color, grade: normalizeGrade(catalogRow.grade ?? grade) }
      const pj = await c.env.DB.prepare(
        `INSERT INTO print_jobs (organisation_id, received_device_id, payload_json, created_by_user_id) VALUES (?, ?, ?, ?)`
      ).bind(orgId, receivedId, JSON.stringify(payload), user.id).run()
      printJobId = pj.meta.last_row_id as number
    }

    results.push({ imei, ok: true, outcome: 'received', sku: catalogRow.sku, received_id: receivedId, print_job_id: printJobId })
  }

  const received = results.filter((r) => r.ok).length
  return c.json({
    ok: true,
    requested: results.length,
    received,
    failed: results.length - received,
    results,
  })
})

// Force-add an unreconciled IMEI (not on manifest) to the inventory bucket
app.post('/force-add', async (c) => {
  const user = currentUser(c)
  const orgId = user.organisation_id
  const body = await c.req.json<{
    manifest_id: number
    imei: string
    oem?: string
    description?: string
    grade?: string
    color?: string
    notes?: string
    buy_price?: number | string
    currency?: string
    vat_type?: string
    received_at?: string
  }>().catch(() => ({} as any))

  const imeiCheck = validateImei(body.imei)
  if (!imeiCheck.ok) return c.json({ error: imeiCheck.reason }, 400)
  const imei = imeiCheck.imei

  // Valuation/VAT are required on force-add exactly like /confirm — the
  // off-manifest exception branch must not be a bypass for required fields.
  const valuation = parseValuation(body, { required: true })
  if (!valuation.ok) return c.json({ error: valuation.error }, 422)

  const receivedAt = parseReceivedAt(body)
  if (!receivedAt.ok) return c.json({ error: receivedAt.error }, 422)

  const dup = await c.env.DB.prepare('SELECT id, uuid, sku FROM received_devices WHERE imei = ? AND organisation_id = ?')
    .bind(imei, orgId).first<{ id: number; uuid: string; sku: string }>()
  if (dup) return c.json({ error: `IMEI ${imei} already received (UUID ${dup.uuid}, SKU ${dup.sku})` }, 409)

  const built = buildSku({
    oem: body.oem || 'UNK',
    description: body.description || 'Unknown',
    color: body.color || null,
  })
  const grade = normalizeGrade(body.grade)

  const uuid = shortUuid()
  let ins
  try {
    ins = await c.env.DB.prepare(
      `INSERT INTO received_devices
       (organisation_id, uuid, imei, sku, brand, model, capacity, color, grade, source, manifest_id, notes,
        status, created_by_user_id, buy_price, currency, vat_type, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unreconciled', ?, ?, 'RECEIVED', ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`
    ).bind(
      orgId, uuid, imei, built.sku, built.brand, built.model, built.capacity, built.color,
      grade, body.manifest_id || null,
      cleanString(body.notes) || 'Force-added: not on manifest. Pending manager review.',
      user.id, valuation.buy_price, valuation.currency, valuation.vat_type, receivedAt.received_at,
    ).run()
  } catch (err) {
    if (isImeiUniqueError(err)) {
      return c.json({ error: `IMEI ${imei} already received` }, 409)
    }
    throw err
  }

  const receivedId = ins.meta.last_row_id as number

  // Audit the force-add (unreconciled receive). Pairs with the 'unreconciled'
  // lookup event written by POST / so Recent scans shows both halves.
  await c.env.DB.prepare(
    "INSERT INTO scan_events (organisation_id, manifest_id, imei, outcome, message, user_id) VALUES (?, ?, ?, 'received', ?, ?)"
  ).bind(orgId, body.manifest_id || null, imei, `Force-added · SKU ${built.sku} · grade ${grade}`, user.id).run()

  await logDeviceEvent(c.env.DB, {
    organisationId: orgId, deviceId: receivedId, eventType: 'FORCE_ADD', userId: user.id,
    toStatus: 'RECEIVED', reference: body.manifest_id ? String(body.manifest_id) : null,
    metadata: { sku: built.sku, grade, source: 'unreconciled', buy_price: valuation.buy_price, currency: valuation.currency, vat_type: valuation.vat_type },
  })

  // Queue print job
  const payload = { uuid, imei, grade, ...built }
  await c.env.DB.prepare(
    `INSERT INTO print_jobs (organisation_id, received_device_id, payload_json, created_by_user_id) VALUES (?, ?, ?, ?)`
  ).bind(orgId, receivedId, JSON.stringify(payload), user.id).run()

  const received = await c.env.DB.prepare('SELECT * FROM received_devices WHERE id = ?')
    .bind(receivedId).first<ReceivedDevice>()

  return c.json({ ok: true, received })
})

// ───────── Manual receive (no manifest required) ─────────
// Used for the "Quick receive" path when there is no ASN/manifest. The
// operator scans/types an IMEI, picks a SKU (typically from the catalogue),
// and the device gets booked into inventory with source='manual'.
app.post('/manual', async (c) => {
  const user = currentUser(c)
  const orgId = user.organisation_id
  const body = await c.req.json<{
    imei: string
    sku?: string
    brand?: string
    model?: string
    capacity?: string
    color?: string
    grade?: string
    notes?: string
    auto_print?: boolean
    buy_price?: number | string
    currency?: string
    vat_type?: string
    received_at?: string
  }>().catch(() => ({} as any))

  const imeiCheck = validateImei(body.imei)
  if (!imeiCheck.ok) return c.json({ error: imeiCheck.reason }, 400)
  const imei = imeiCheck.imei

  // Valuation/VAT required here too — manual is an intake path like any
  // other; "quick receive" must not mean "valuation-less receive".
  const valuation = parseValuation(body, { required: true })
  if (!valuation.ok) return c.json({ error: valuation.error }, 422)

  const receivedAt = parseReceivedAt(body)
  if (!receivedAt.ok) return c.json({ error: receivedAt.error }, 422)

  // Duplicate check — same friendly path as scan/confirm.
  const existing = await c.env.DB.prepare('SELECT id, uuid, sku FROM received_devices WHERE imei = ? AND organisation_id = ?')
    .bind(imei, orgId).first<{ id: number; uuid: string; sku: string }>()
  if (existing) {
    return c.json({
      error: `IMEI ${imei} already received`,
      detail: { uuid: existing.uuid, sku: existing.sku },
    }, 409)
  }

  // Resolve SKU. If the caller supplied an explicit SKU we use it as-is;
  // otherwise we try to look it up by (brand+model+capacity) from the
  // catalogue; otherwise we fall back to buildSku() like force-add does.
  let sku = cleanString(body.sku, 128) || ''
  let brand = cleanString(body.brand, 128)
  let model = cleanString(body.model, 128)
  let capacity = cleanString(body.capacity, 64)
  let color = cleanString(body.color, 64)

  if (sku) {
    // Try to enrich from the catalogue so the printed label has full info
    const row = await c.env.DB.prepare(
      'SELECT brand, model, capacity, color FROM sku_catalog WHERE sku = ? AND organisation_id = ?'
    ).bind(sku, orgId).first<{ brand: string; model: string; capacity: string | null; color: string | null }>()
    if (row) {
      brand = brand || row.brand
      model = model || row.model
      capacity = capacity || row.capacity
      color = color || row.color
    }
  } else {
    // No SKU given — derive one (same algorithm as force-add)
    const built = buildSku({ oem: brand, description: [model, capacity].filter(Boolean).join(' '), color })
    sku = built.sku
    brand = brand || built.brand
    model = model || built.model
    capacity = capacity || built.capacity
    color = color || built.color
  }

  const grade = normalizeGrade(body.grade)
  const uuid = shortUuid()

  let ins
  try {
    ins = await c.env.DB.prepare(
      `INSERT INTO received_devices
       (organisation_id, uuid, imei, sku, brand, model, capacity, color, grade, source, notes,
        status, created_by_user_id, buy_price, currency, vat_type, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, 'RECEIVED', ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`
    ).bind(
      orgId, uuid, imei, sku, brand, model, capacity, color, grade,
      cleanString(body.notes),
      user.id, valuation.buy_price, valuation.currency, valuation.vat_type, receivedAt.received_at,
    ).run()
  } catch (err) {
    if (isImeiUniqueError(err)) {
      return c.json({ error: `IMEI ${imei} already received` }, 409)
    }
    throw err
  }

  const receivedId = ins.meta.last_row_id as number

  // Audit log (reuse scan_events with outcome='matched' but no manifest)
  await c.env.DB.prepare(
    "INSERT INTO scan_events (organisation_id, manifest_id, imei, outcome, message, user_id) VALUES (?, NULL, ?, 'matched', 'Manual receive', ?)"
  ).bind(orgId, imei, user.id).run()

  await logDeviceEvent(c.env.DB, {
    organisationId: orgId, deviceId: receivedId, eventType: 'MANUAL_RECEIVE', userId: user.id,
    toStatus: 'RECEIVED', metadata: { sku, grade, source: 'manual', buy_price: valuation.buy_price, currency: valuation.currency, vat_type: valuation.vat_type },
  })

  // Queue print job by default
  let printJobId: number | null = null
  if (body.auto_print !== false) {
    const payload = { uuid, sku, imei, brand, model, capacity, color, grade }
    const pj = await c.env.DB.prepare(
      'INSERT INTO print_jobs (organisation_id, received_device_id, payload_json, created_by_user_id) VALUES (?, ?, ?, ?)'
    ).bind(orgId, receivedId, JSON.stringify(payload), user.id).run()
    printJobId = pj.meta.last_row_id as number
  }

  const received = await c.env.DB.prepare('SELECT * FROM received_devices WHERE id = ?')
    .bind(receivedId).first<ReceivedDevice>()

  return c.json({ ok: true, received, print_job_id: printJobId })
})

// Reject an unreconciled scan (just log it)
app.post('/reject', async (c) => {
  const user = currentUser(c)
  const orgId = user.organisation_id
  const body = await c.req.json<{ manifest_id: number; imei: string; reason?: string }>().catch(() => ({} as any))
  await c.env.DB.prepare(
    "INSERT INTO scan_events (organisation_id, manifest_id, imei, outcome, message, user_id) VALUES (?, ?, ?, 'rejected', ?, ?)"
  ).bind(orgId, body.manifest_id || null, cleanString(body.imei, 32), cleanString(body.reason) || 'Rejected by operator', user.id).run()
  await logDeviceEvent(c.env.DB, {
    organisationId: orgId, deviceId: null, eventType: 'REJECT', userId: user.id,
    reference: body.manifest_id ? String(body.manifest_id) : null,
    metadata: { imei: body.imei, reason: body.reason },
  })
  return c.json({ ok: true })
})

// Recent scan events for a manifest (for live activity feed)
app.get('/events/:manifestId', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('manifestId'))
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM scan_events WHERE manifest_id = ? AND organisation_id = ? ORDER BY id DESC LIMIT 30'
  ).bind(id, user.organisation_id).all()
  return c.json({ events: results })
})

export default app
