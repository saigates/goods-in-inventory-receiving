import { Hono } from 'hono'
import type { Bindings, AuthUser } from '../types'
import { normalizeGrade } from '../lib/grade'
import { resolveCatalogSkuBulk, normalizeCapacity, norm } from '../lib/catalog'
import { currentUser } from '../lib/auth'
import { validateImei, cleanString, validateBuyPrice, isValidCurrency, normalizeCurrency, isValidVatType } from '../lib/validate'
import { reconcileManifestAgainstBill, type ManifestLineForReconciliation } from '../lib/manifestBillReconciliation'
import { deriveConditionFromGrade } from '../lib/condition'

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

  // Manifest → bill reconciliation (0029): sum of THIS manifest's own
  // unit_cost hints vs. the linked bill's declared_total_gbp. Deliberately
  // NOT checkBillCloseable() (that's the bill's own lines vs. its own
  // header — a same-document check); this compares two separate
  // documents. Replaces the historical header-only false-green: with no
  // bill linked, or the bill/manifest not yet priced, this reports
  // 'awaiting_manifest', never 'balanced'.
  const m = manifest as { bill_id: number | null }
  let bill: { declared_total_gbp: number | null; currency_code: string; exchange_rate: number | null; unit_count: number } | null = null
  if (m.bill_id != null) {
    bill = await c.env.DB.prepare(
      'SELECT declared_total_gbp, currency_code, exchange_rate, unit_count FROM bills WHERE id = ? AND organisation_id = ?'
    ).bind(m.bill_id, user.organisation_id).first()
  }
  const reconLines: ManifestLineForReconciliation[] = (expected.results as Array<{ unit_cost: number | null; currency: string | null }>)
    .map(e => ({ unit_cost: e.unit_cost, currency: e.currency }))
  const bill_reconciliation = reconcileManifestAgainstBill(m.bill_id != null, reconLines, bill)

  return c.json({
    manifest,
    expected: expected.results,
    unreconciled: unreconciled.results,
    summary,
    bill_reconciliation,
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
  vat_type?: string | null   // optional MARGIN | STANDARD | ZERO | PVAT hint (0015)
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
      return { ok: false, reason: `vat_type '${r.vat_type}' must be one of MARGIN, STANDARD, ZERO, PVAT` }
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
    bill_id?: number | null
  }>().catch(() => ({} as any))

  if (!body.reference || !body.supplier || !Array.isArray(body.rows) || body.rows.length === 0) {
    return c.json({ error: 'reference, supplier, and rows[] are required' }, 400)
  }

  // Optional bill link (0029). Leaving it empty must still work — goods
  // received without a bill remains fully permitted. When supplied, the
  // bill must exist, belong to this org, and be 'draft' (open) — a
  // manifest should link to the bill it's about to reconcile against,
  // not one already closed and settled.
  let billId: number | null = null
  if (body.bill_id != null) {
    const bid = Number(body.bill_id)
    if (!Number.isInteger(bid)) return c.json({ error: 'bill_id must be an integer' }, 400)
    const bill = await c.env.DB.prepare(
      "SELECT id FROM bills WHERE id = ? AND organisation_id = ? AND status = 'draft'"
    ).bind(bid, orgId).first()
    if (!bill) return c.json({ error: `bill_id ${bid} is not an open bill in this organisation` }, 400)
    billId = bid
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
    'INSERT INTO manifests (organisation_id, reference, supplier, notes, created_by_user_id, bill_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(orgId, body.reference, body.supplier, body.notes || null, user.id, billId).run()
  const manifestId = ins.meta.last_row_id as number

  // Pre-resolve SKU from CATALOG (source of truth). We don't invent SKUs
  // anymore — if the catalog has no entry for (model, capacity, color, grade),
  // the manifest line gets sku=NULL and the scan modal will prompt the
  // operator to fix it. Count unmatched lines so we can surface them.
  //
  // IMPORTANT (2026-07-29 production bug fix): this used to call
  // resolveCatalogSku() — 1-3 sequential D1 queries — once per row inside
  // this loop. That's free against the local dev SQLite stub (in-process,
  // no network hop) but against REAL remote D1 each call is a network round
  // trip, so a several-hundred-row manifest turned into several-hundred
  // SEQUENTIAL round trips in one request. The manifest HEADER insert above
  // already commits, but this loop (and the expected_devices batch insert
  // after it) runs afterwards — so a slow upload that outran the client's
  // patience (or any timeout in the request path) left a manifest row with
  // ZERO expected_devices, with no error surfaced anywhere. Confirmed: a
  // 197-row upload created manifest id 11 in production with 0 devices,
  // while the identical upload against local dev correctly got all 197.
  // Fixed by loading the whole organisation's catalog ONCE up front
  // (`resolveCatalogSkuBulk`) and matching every row in memory — O(1) DB
  // round trips instead of O(rows).
  const stmts: D1PreparedStatement[] = []
  let unmatched = 0
  const invalidImeis: Array<{ row_index: number; imei: unknown; reason: string }> = []
  const invalidValuations: Array<{ row_index: number; imei: unknown; reason: string }> = []
  // Condition is DERIVED from grade (0030) — never stored from the upload.
  // Where the file carries its own condition value that disagrees with the
  // derived one, that's reported here so drift is visible, not silently
  // discarded and not silently overridden.
  const conditionDiscrepancies: Array<{ row_index: number; imei: string; uploaded: string; derived: string }> = []
  // normalizeGrade() flattening any out-of-scale vendor grade (a real D or
  // E, or any other non-A/B/C/UG value) to 'UG' at import is CORRECT and
  // INTENDED (owner decision — the vendor's grade is a claim, not a
  // verified fact, and normalizeGrade()'s behaviour is deliberately left
  // unchanged by this pass). What was missing was visibility: this array
  // records every such coercion event — the exact raw value the vendor's
  // file carried, which row/imei it was on, and that it was stored as
  // 'UG' — so the coercion is observable without changing what gets
  // stored. Mirrors conditionDiscrepancies's pattern exactly. Deliberately
  // NOT logged for a raw value that's already A/B/C/UG (nothing was
  // coerced) or for a blank/missing grade (there is no vendor claim to
  // report on) — only for a genuinely out-of-scale value that
  // normalizeGrade() had to launder.
  const gradeCoercions: Array<{ row_index: number; imei: string; uploaded: string; stored: 'UG' }> = []

  type ValidRow = {
    r: ImportRow
    imei: string
    val: { unit_cost: number | null; currency: string | null; vat_type: string | null }
    capacity: string | null
    color: string | null
    grade: ReturnType<typeof normalizeGrade>
    rawGrade: string | null   // grade exactly as the uploaded file carried it, pre-normalizeGrade() — for grade_coercions only
    modelForLookup: string | null
  }
  const validRows: ValidRow[] = []
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
    const rawGrade = r.grade == null ? null : String(r.grade).trim()
    validRows.push({ r, imei, val, capacity, color, grade, rawGrade, modelForLookup })
  }

  // One query for the whole organisation's catalog, then match every valid
  // row against it in memory (see comment above).
  const lookups = await resolveCatalogSkuBulk(
    c.env.DB,
    validRows.map((vr) => ({
      model: vr.modelForLookup,
      capacity: vr.capacity,
      color: vr.color,
      grade: vr.grade,
    })),
    orgId,
  )

  for (let i = 0; i < validRows.length; i++) {
    const { r, imei, val, capacity, color, grade, rawGrade, modelForLookup } = validRows[i]
    let sku: string | null = null
    if (modelForLookup) {
      const lookup = lookups[i]
      if (lookup.status === 'match') sku = lookup.row.sku
      else unmatched += 1
    } else {
      unmatched += 1
    }

    // Condition is derived from grade (0030) — grade always wins, condition
    // is always optional. We no longer read r.condition into the column at
    // all: an uploaded condition can no longer drift out of sync with grade
    // because it's never stored. If the file DID carry a condition and it
    // disagrees with what grade derives, log the discrepancy for visibility
    // (e.g. a vendor claims grade A but writes "Used" in their own sheet) —
    // report it, don't store it, and don't let it override the derivation.
    const derivedCondition = deriveConditionFromGrade(grade)
    const uploadedCondition = cleanString(r.condition, 64)
    if (uploadedCondition && uploadedCondition.toUpperCase() !== derivedCondition) {
      conditionDiscrepancies.push({
        row_index: i, imei, uploaded: uploadedCondition, derived: derivedCondition,
      })
    }

    // grade_coercions: record only a GENUINE coercion — a raw value that
    // was present and did not already equal (case-insensitively) the
    // normalized result. A blank/missing grade normalizes to 'UG' too,
    // but that's an absent claim, not a coerced one, so it's excluded.
    // normalizeGrade() only ever coerces TO 'UG' (never to A/B/C), so
    // grade === 'UG' here is guaranteed whenever this branch is taken —
    // asserted explicitly so the literal 'stored: UG' type holds.
    if (rawGrade && rawGrade.toUpperCase() !== grade && grade === 'UG') {
      gradeCoercions.push({ row_index: i, imei, uploaded: rawGrade, stored: grade })
    }

    stmts.push(c.env.DB.prepare(
      `INSERT INTO expected_devices
       (organisation_id, manifest_id, oem, condition, description, grade, model_no, imei, unit_cost, currency, vat_type, sku, capacity, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      orgId,
      manifestId,
      cleanString(r.oem, 64),
      derivedCondition,
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
    condition_discrepancies: conditionDiscrepancies,
    grade_coercions: gradeCoercions,
  })
})

// ───────── "Use this for all other SKUs in this batch" ─────────
//
// When the operator picks a catalog candidate (or edits fields to a
// re-resolved match) for one unmatched manifest line in the Confirm-SKU
// modal, this lets them apply that SAME sku/brand/model/capacity/color/grade
// to every OTHER still-pending line on the manifest that has the SAME
// unresolved signature — instead of repeating the identical pick for every
// unit in a batch of, say, 50 identical phones with one supplier typo.
//
// Deliberately narrow in scope to avoid silently mislabelling devices:
//  - only lines with status = 'pending' (a received line is a permanent
//    audit record — sku is never rewritten after receipt);
//  - only lines whose CURRENT (model_no||description, capacity, color, grade)
//    tuple matches the line the operator started from, using the exact same
//    norm()/normalizeCapacity() rules the catalog matcher itself uses (so
//    "128GB" and "128 GB" are treated as the same signature, matching what
//    the operator saw as "the same unresolved SKU" in the modal);
//  - the target sku MUST already exist in this organisation's sku_catalog —
//    refuses otherwise, same rule as /scan/confirm, so a batch-apply can
//    never assign a SKU that isn't a real catalogue entry;
//  - this does NOT receive/scan anything — it only pre-fills
//    expected_devices.sku so that scanning each remaining IMEI in the
//    Confirm-SKU modal shows an immediate green "from catalogue" match
//    instead of the red "no match" banner, without a second manual pick.
app.post('/:id/apply-sku-to-batch', async (c) => {
  const user = currentUser(c)
  const orgId = user.organisation_id
  const manifestId = Number(c.req.param('id'))
  if (!manifestId) return c.json({ error: 'Invalid manifest id' }, 400)

  const body = await c.req.json<{
    sku: string
    model?: string | null
    capacity?: string | null
    color?: string | null
    grade?: string | null
    // Optional: restrict to one specific line's signature (the line the
    // operator started from) rather than re-deriving it from model/capacity/
    // color/grade — belt-and-braces so a client bug can't accidentally
    // widen the match to an unrelated signature.
    source_expected_device_id?: number
  }>().catch(() => ({} as any))

  const sku = cleanString(body.sku, 128)
  if (!sku) return c.json({ error: 'sku is required' }, 400)

  const manifest = await c.env.DB.prepare(
    'SELECT id, status FROM manifests WHERE id = ? AND organisation_id = ?'
  ).bind(manifestId, orgId).first<{ id: number; status: string }>()
  if (!manifest) return c.json({ error: 'Manifest not found' }, 404)

  // SKU must exist in the catalogue — same rule as /scan/confirm. Also pull
  // brand/model/capacity/color/grade back so the response can tell the
  // client exactly what got applied (it should match what's on screen, but
  // the catalogue row is authoritative).
  const catalogRow = await c.env.DB.prepare(
    'SELECT sku, brand, model, capacity, color, grade FROM sku_catalog WHERE sku = ? AND organisation_id = ?'
  ).bind(sku, orgId).first<{ sku: string; brand: string; model: string; capacity: string | null; color: string | null; grade: string | null }>()
  if (!catalogRow) {
    return c.json({
      error: `SKU '${sku}' is not in the catalogue. Add it via the Catalog tab, then retry.`,
      code: 'sku_not_in_catalog',
    }, 422)
  }

  // Derive the target signature either from the source line (preferred —
  // guarantees we match exactly what the operator was looking at) or from
  // the body fields directly.
  let targetModel = body.model ?? null
  let targetCapacity = body.capacity ?? null
  let targetColor = body.color ?? null
  let targetGrade = body.grade ?? null
  if (body.source_expected_device_id) {
    const src = await c.env.DB.prepare(
      'SELECT model_no, description, capacity, color, grade FROM expected_devices WHERE id = ? AND organisation_id = ? AND manifest_id = ?'
    ).bind(body.source_expected_device_id, orgId, manifestId)
      .first<{ model_no: string | null; description: string | null; capacity: string | null; color: string | null; grade: string | null }>()
    if (src) {
      targetModel = src.model_no || src.description || null
      targetCapacity = src.capacity
      targetColor = src.color
      targetGrade = src.grade
    }
  }

  const targetModelNorm = norm(targetModel)
  const targetCapacityNorm = norm(normalizeCapacity(targetCapacity))
  const targetColorNorm = norm(targetColor)
  const targetGradeNorm = normalizeGrade(targetGrade)
  if (!targetModelNorm) {
    return c.json({ error: 'Could not determine the manifest line signature (no model) to match other lines against' }, 422)
  }

  // Pull every still-pending line on this manifest and match in memory —
  // same "load once, compare in memory" discipline as resolveCatalogSkuBulk,
  // since this can also run against a several-hundred-line manifest.
  const { results: pending } = await c.env.DB.prepare(
    `SELECT id, model_no, description, capacity, color, grade FROM expected_devices
     WHERE manifest_id = ? AND organisation_id = ? AND status = 'pending'`
  ).bind(manifestId, orgId).all<{ id: number; model_no: string | null; description: string | null; capacity: string | null; color: string | null; grade: string | null }>()

  const matchingIds: number[] = []
  for (const row of pending) {
    const model = row.model_no || row.description || null
    if (norm(model) !== targetModelNorm) continue
    if (norm(normalizeCapacity(row.capacity)) !== targetCapacityNorm) continue
    if (norm(row.color) !== targetColorNorm) continue
    if (normalizeGrade(row.grade) !== targetGradeNorm) continue
    matchingIds.push(row.id)
  }

  if (matchingIds.length === 0) {
    return c.json({ ok: true, applied: 0, sku: catalogRow.sku, message: 'No other pending lines share this signature.' })
  }

  const placeholders = matchingIds.map(() => '?').join(',')
  await c.env.DB.prepare(
    `UPDATE expected_devices SET sku = ? WHERE id IN (${placeholders}) AND organisation_id = ? AND manifest_id = ? AND status = 'pending'`
  ).bind(catalogRow.sku, ...(matchingIds as unknown[]), orgId, manifestId).run()

  return c.json({
    ok: true,
    applied: matchingIds.length,
    sku: catalogRow.sku,
    expected_device_ids: matchingIds,
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
