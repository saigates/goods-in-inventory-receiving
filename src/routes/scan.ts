import { Hono } from 'hono'
import type { Bindings, ExpectedDevice, ReceivedDevice, AuthUser } from '../types'
import { buildSku } from '../lib/sku'
import { shortUuid } from '../lib/uuid'
import { normalizeGrade } from '../lib/grade'
import { resolveCatalogSku, normalizeCapacity } from '../lib/catalog'
import { currentUser } from '../lib/auth'
import { validateImei, validateBuyPrice, isValidCurrency, isValidVatType, normalizeCurrency, cleanString } from '../lib/validate'
import { logDeviceEvent } from '../lib/deviceLifecycle'

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
// buy_price and vat_type are REQUIRED at the point of confirming a device
// per the brief ("confirming a device requires a valid buy price and VAT
// type"); force-add/manual keep them optional since those paths predate
// this requirement and aren't the primary SKU-confirm flow, but if
// supplied they are still validated with the same rigor.
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
      return { ok: false, error: `vat_type must be one of MARGIN, STANDARD, ZERO` }
    }
    vatType = String(body.vat_type).trim().toUpperCase()
  } else if (opts.required) {
    return { ok: false, error: 'vat_type is required' }
  }

  return { ok: true, buy_price: buyPrice, currency, vat_type: vatType }
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
  // own check is optimistic UX only. 14-16 digits + Luhn checksum when the
  // length is the standard 15.
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
  const lookup = await resolveCatalogSku(c.env.DB, {
    model: modelForLookup,
    capacity: expected.capacity,
    color: expected.color,
    grade,
  }, orgId)

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
  }>().catch(() => ({} as any))

  if (!body.expected_device_id || !body.sku) {
    return c.json({ error: 'expected_device_id and sku required' }, 400)
  }

  // Valuation/VAT are required at goods-in confirm time (Priority 4).
  const valuation = parseValuation(body, { required: true })
  if (!valuation.ok) return c.json({ error: valuation.error }, 422)

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
        status, created_by_user_id, buy_price, currency, vat_type, supplier_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manifest', ?, ?, ?, 'RECEIVED', ?, ?, ?, ?, ?)`
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
  }>().catch(() => ({} as any))

  const imeiCheck = validateImei(body.imei)
  if (!imeiCheck.ok) return c.json({ error: imeiCheck.reason }, 400)
  const imei = imeiCheck.imei

  const valuation = parseValuation(body, { required: false })
  if (!valuation.ok) return c.json({ error: valuation.error }, 422)

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
        status, created_by_user_id, buy_price, currency, vat_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unreconciled', ?, ?, 'RECEIVED', ?, ?, ?, ?)`
    ).bind(
      orgId, uuid, imei, built.sku, built.brand, built.model, built.capacity, built.color,
      grade, body.manifest_id || null,
      cleanString(body.notes) || 'Force-added: not on manifest. Pending manager review.',
      user.id, valuation.buy_price, valuation.currency, valuation.vat_type,
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
    metadata: { sku: built.sku, grade, source: 'unreconciled' },
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
  }>().catch(() => ({} as any))

  const imeiCheck = validateImei(body.imei)
  if (!imeiCheck.ok) return c.json({ error: imeiCheck.reason }, 400)
  const imei = imeiCheck.imei

  const valuation = parseValuation(body, { required: false })
  if (!valuation.ok) return c.json({ error: valuation.error }, 422)

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
        status, created_by_user_id, buy_price, currency, vat_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, 'RECEIVED', ?, ?, ?, ?)`
    ).bind(
      orgId, uuid, imei, sku, brand, model, capacity, color, grade,
      cleanString(body.notes),
      user.id, valuation.buy_price, valuation.currency, valuation.vat_type,
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
    toStatus: 'RECEIVED', metadata: { sku, grade, source: 'manual' },
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
