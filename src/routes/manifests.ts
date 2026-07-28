import { Hono } from 'hono'
import type { Bindings, AuthUser } from '../types'
import { normalizeGrade } from '../lib/grade'
import { resolveCatalogSku, normalizeCapacity } from '../lib/catalog'
import { currentUser } from '../lib/auth'
import { validateImei, cleanString, validateBuyPrice, isValidCurrency, normalizeCurrency, isValidVatType } from '../lib/validate'

const app = new Hono<{ Bindings: Bindings; Variables: { user: AuthUser } }>()

// List all manifests with progress counts (org-scoped)
app.get('/', async (c) => {
  const user = currentUser(c)
  const { results } = await c.env.DB.prepare(`
    SELECT m.*,
      (SELECT COUNT(*) FROM expected_devices WHERE manifest_id = m.id) AS expected_count,
      (SELECT COUNT(*) FROM expected_devices WHERE manifest_id = m.id AND status = 'received') AS received_count,
      (SELECT COUNT(*) FROM received_devices WHERE manifest_id = m.id AND source = 'unreconciled') AS unreconciled_count
    FROM manifests m
    WHERE m.organisation_id = ?
    ORDER BY m.created_at DESC
  `).bind(user.organisation_id).all()
  return c.json({ manifests: results })
})

// Get one manifest with all expected lines and any unreconciled scans for it
app.get('/:id', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const manifest = await c.env.DB.prepare('SELECT * FROM manifests WHERE id = ? AND organisation_id = ?')
    .bind(id, user.organisation_id).first()
  if (!manifest) return c.json({ error: 'Not found' }, 404)

  const expected = await c.env.DB.prepare(`
    SELECT ed.*, rd.uuid AS received_uuid, rd.sku AS received_sku
    FROM expected_devices ed
    LEFT JOIN received_devices rd ON rd.id = ed.received_device_id
    WHERE ed.manifest_id = ? AND ed.organisation_id = ?
    ORDER BY ed.id ASC
  `).bind(id, user.organisation_id).all()

  const unreconciled = await c.env.DB.prepare(`
    SELECT * FROM received_devices WHERE manifest_id = ? AND source = 'unreconciled' AND organisation_id = ?
    ORDER BY created_at DESC
  `).bind(id, user.organisation_id).all()

  const summary = await c.env.DB.prepare(`
    SELECT
      COUNT(*) AS expected_count,
      SUM(CASE WHEN status = 'received' THEN 1 ELSE 0 END) AS received_count
    FROM expected_devices WHERE manifest_id = ? AND organisation_id = ?
  `).bind(id, user.organisation_id).first<{ expected_count: number; received_count: number }>()

  return c.json({
    manifest,
    expected: expected.results,
    unreconciled: unreconciled.results,
    summary,
  })
})

type ImportRow = {
  oem?: string | null
  condition?: string | null
  description?: string | null
  grade?: string | null
  model_no?: string | null
  imei: string | number
  unit_cost?: number | null
  currency?: string | null   // optional ISO 4217 valuation hint (0015)
  vat_type?: string | null   // optional MARGIN | STANDARD | ZERO hint (0015)
  capacity?: string | null
  color?: string | null
}

// Optional per-row valuation hints. These PRE-FILL the goods-in confirm
// modal; they are NOT the authoritative valuation — /scan/confirm still
// requires the operator to confirm buy_price + vat_type on every receive.
// Invalid hints reject the ROW (flagged in the response, like bad IMEIs)
// rather than silently storing junk that would then pre-fill the modal.
function parseRowValuation(r: ImportRow):
  | { ok: true; unit_cost: number | null; currency: string | null; vat_type: string | null }
  | { ok: false; reason: string } {
  let unitCost: number | null = null
  if (r.unit_cost != null && String(r.unit_cost) !== '') {
    const v = validateBuyPrice(r.unit_cost)
    if (!v.ok) return { ok: false, reason: `unit_cost: ${v.reason}` }
    unitCost = v.value
  }
  let currency: string | null = null
  if (r.currency != null && String(r.currency).trim() !== '') {
    if (!isValidCurrency(r.currency)) {
      return { ok: false, reason: `currency '${r.currency}' is not a valid ISO 4217 code` }
    }
    currency = normalizeCurrency(r.currency)
  }
  let vatType: string | null = null
  if (r.vat_type != null && String(r.vat_type).trim() !== '') {
    if (!isValidVatType(r.vat_type)) {
      return { ok: false, reason: `vat_type '${r.vat_type}' must be one of MARGIN, STANDARD, ZERO` }
    }
    vatType = String(r.vat_type).trim().toUpperCase()
  }
  return { ok: true, unit_cost: unitCost, currency, vat_type: vatType }
}

// Create a manifest with a batch of expected devices (JSON body)
app.post('/', async (c) => {
  const user = currentUser(c)
  const orgId = user.organisation_id
  const body = await c.req.json<{
    reference: string
    supplier: string
    notes?: string
    rows: ImportRow[]
  }>().catch(() => ({} as any))

  if (!body.reference || !body.supplier || !Array.isArray(body.rows) || body.rows.length === 0) {
    return c.json({ error: 'reference, supplier, and rows[] are required' }, 400)
  }

  // Server-side validation of every inbound row (Priority 5) — the API is
  // the source of truth since a future CRM will POST here directly without
  // going through the SPA's own checks. We don't hard-reject the whole
  // manifest for a bad IMEI (a supplier file with one typo shouldn't block
  // 500 good lines) — instead each bad row is flagged in the response and
  // skipped, mirroring the catalog_unmatched pattern already in use here.
  const existing = await c.env.DB.prepare('SELECT id FROM manifests WHERE reference = ? AND organisation_id = ?')
    .bind(body.reference, orgId).first()
  if (existing) return c.json({ error: `Manifest reference '${body.reference}' already exists` }, 409)

  // Create manifest
  const ins = await c.env.DB.prepare(
    'INSERT INTO manifests (organisation_id, reference, supplier, notes, created_by_user_id) VALUES (?, ?, ?, ?, ?)'
  ).bind(orgId, body.reference, body.supplier, body.notes || null, user.id).run()
  const manifestId = ins.meta.last_row_id as number

  // Pre-resolve SKU from CATALOG (source of truth). We don't invent SKUs
  // anymore — if the catalog has no entry for (model, capacity, color, grade),
  // the manifest line gets sku=NULL and the scan modal will prompt the
  // operator to fix it. Count unmatched lines so we can surface them.
  const stmts: D1PreparedStatement[] = []
  let unmatched = 0
  const invalidImeis: Array<{ row_index: number; imei: unknown; reason: string }> = []
  const invalidValuations: Array<{ row_index: number; imei: unknown; reason: string }> = []
  for (let i = 0; i < body.rows.length; i++) {
    const r = body.rows[i] || ({} as ImportRow)
    const imeiCheck = validateImei(r.imei)
    if (!imeiCheck.ok) {
      invalidImeis.push({ row_index: i, imei: r.imei, reason: imeiCheck.reason })
      continue
    }
    const imei = imeiCheck.imei
    const val = parseRowValuation(r)
    if (!val.ok) {
      invalidValuations.push({ row_index: i, imei, reason: val.reason })
      continue
    }
    const capacity = normalizeCapacity(r.capacity)
    const color = cleanString(r.color, 64)
    // Grade taken verbatim from the manifest column (operator edited the
    // spreadsheet to A|B|C|UG). Anything else → UG.
    const grade = normalizeGrade(r.grade)
    // Prefer model_no as the model carrier (Apple-style files put the
    // human-readable model name there); fall back to description if model_no
    // is empty (older manifests where description holds "Galaxy S24_256G").
    const modelForLookup = r.model_no || r.description || null

    let sku: string | null = null
    if (modelForLookup) {
      const lookup = await resolveCatalogSku(c.env.DB, {
        model: modelForLookup,
        capacity,
        color,
        grade,
      }, orgId)
      if (lookup.status === 'match') sku = lookup.row.sku
      else unmatched += 1
    } else {
      unmatched += 1
    }

    stmts.push(c.env.DB.prepare(
      `INSERT INTO expected_devices
       (organisation_id, manifest_id, oem, condition, description, grade, model_no, imei, unit_cost, currency, vat_type, sku, capacity, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      orgId,
      manifestId,
      cleanString(r.oem, 64),
      cleanString(r.condition, 64),
      cleanString(r.description, 256),
      grade,
      cleanString(r.model_no, 128),
      imei,
      val.unit_cost,
      val.currency,
      val.vat_type,
      sku,
      capacity,
      color,
    ))
  }

  // D1 batch (parameterised statements only — see src/lib/validate.ts)
  if (stmts.length) await c.env.DB.batch(stmts)

  return c.json({
    ok: true,
    manifest_id: manifestId,
    count: stmts.length,
    catalog_unmatched: unmatched,
    invalid_imeis: invalidImeis,
    invalid_valuations: invalidValuations,
  })
})

// Close/reopen a manifest
app.post('/:id/close', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare(
    "UPDATE manifests SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = ? AND organisation_id = ?"
  ).bind(id, user.organisation_id).run()
  return c.json({ ok: true })
})

app.post('/:id/reopen', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare(
    "UPDATE manifests SET status = 'open', closed_at = NULL WHERE id = ? AND organisation_id = ?"
  ).bind(id, user.organisation_id).run()
  return c.json({ ok: true })
})

// Delete manifest AND every device booked against it.
// Treat the manifest as never happened: received_devices → print_jobs and
// grade_audit cascade away (FK ON DELETE CASCADE from 0001/0004); expected
// lines cascade from manifests; scan_events for this manifest are cleaned
// up by hand (no FK, just an int reference).
app.delete('/:id', async (c) => {
  const user = currentUser(c)
  const orgId = user.organisation_id
  const id = Number(c.req.param('id'))
  try {
    // Count what we're about to destroy so the toast can tell the operator.
    const recv = await c.env.DB.prepare(
      'SELECT COUNT(*) AS c FROM received_devices WHERE manifest_id = ? AND organisation_id = ?'
    ).bind(id, orgId).first<{ c: number }>()
    const exp = await c.env.DB.prepare(
      'SELECT COUNT(*) AS c FROM expected_devices WHERE manifest_id = ? AND organisation_id = ?'
    ).bind(id, orgId).first<{ c: number }>()

    // 1. Kill received_devices linked to this manifest. CASCADE on
    //    print_jobs and grade_audit pulls their dependents along.
    await c.env.DB.prepare(
      'DELETE FROM received_devices WHERE manifest_id = ? AND organisation_id = ?'
    ).bind(id, orgId).run()

    // 2. Tidy scan_events (no FK, otherwise they'd orphan).
    await c.env.DB.prepare(
      'DELETE FROM scan_events WHERE manifest_id = ? AND organisation_id = ?'
    ).bind(id, orgId).run()

    // 3. Delete the manifest — cascades into expected_devices.
    const res = await c.env.DB.prepare(
      'DELETE FROM manifests WHERE id = ? AND organisation_id = ?'
    ).bind(id, orgId).run()
    if (!res.meta.changes) return c.json({ error: 'Manifest not found' }, 404)

    return c.json({
      ok: true,
      deleted_received: recv?.c ?? 0,
      deleted_expected: exp?.c ?? 0,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: `Could not delete manifest: ${msg}` }, 500)
  }
})

export default app
