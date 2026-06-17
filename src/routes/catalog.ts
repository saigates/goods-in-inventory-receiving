import { Hono } from 'hono'
import type { Bindings } from '../types'
import { buildSku, brandFromOem, colorShortCode } from '../lib/sku'
import { normalizeGrade, VALID_GRADES } from '../lib/grade'
import { normalizeCapacity } from '../lib/catalog'

const app = new Hono<{ Bindings: Bindings }>()

// List catalogue entries (optionally filtered by free-text q)
app.get('/', async (c) => {
  const q = c.req.query('q')?.trim()
  let sql = 'SELECT * FROM sku_catalog'
  const binds: unknown[] = []
  if (q) {
    sql += ' WHERE sku LIKE ? OR brand LIKE ? OR model LIKE ?'
    const w = `%${q}%`
    binds.push(w, w, w)
  }
  sql += ' ORDER BY brand ASC, model ASC, capacity ASC LIMIT 1000'
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all()
  return c.json({ catalog: results })
})

// Bulk upload. Body:
//   { rows: [{ brand, model, capacity?, color?, sku? }, ...] }
//
// Per row we:
//   1. Compute a canonical sku_code if the row didn't supply one. We use the
//      same buildSku helper that the receive path uses, so manual entries
//      and catalogue entries share the same naming scheme.
//   2. Check for an existing row with the same sku. If it exists with the
//      SAME (brand, model, capacity, color), we report it as 'duplicate'.
//      If it exists with DIFFERENT fields we report it as 'collision' — we
//      do NOT merge, do NOT overwrite. The operator has to resolve manually
//      (rename one side or delete the conflicting row).
//   3. Otherwise insert.
//
// The whole upload is dry-run-able with ?dry_run=1 — useful for the UI
// preview step before the user commits.
app.post('/upload', async (c) => {
  const dryRun = c.req.query('dry_run') === '1'
  const body = await c.req.json<{
    rows: Array<{
      brand?: string | null
      model?: string | null
      capacity?: string | null
      color?: string | null
      sku?: string | null
      grade?: string | null
    }>
  }>()

  const rows = Array.isArray(body.rows) ? body.rows : []
  if (rows.length === 0) return c.json({ error: 'rows[] required' }, 400)

  type Outcome = 'inserted' | 'duplicate' | 'collision' | 'invalid'
  type Report = {
    row_index: number
    outcome: Outcome
    sku: string | null
    brand: string | null
    model: string | null
    capacity: string | null
    color: string | null
    grade: string | null
    existing?: { sku: string; brand: string; model: string; capacity: string | null; color: string | null; grade: string | null }
    message?: string
  }

  // Build a canonical SKU for a catalogue row when none is supplied.
  // Pattern: {BRAND}-{MODELSHORT}-{CAP}-{COLOR}-{GRADE}
  function deriveSku(
    brand: string, model: string, capacity: string | null, color: string | null, grade: string,
  ): string {
    void brandFromOem
    const built = buildSku({
      oem: brand,
      description: capacity ? `${model} ${capacity}` : model,
      color,
      capacity,
    })
    return `${built.sku}-${grade}`
  }

  // Pre-load existing SKUs into a map so we can check without N+1 queries.
  // For a prototype catalogue (< ~10k rows) this is fine.
  const { results: existingRows } = await c.env.DB.prepare(
    'SELECT sku, brand, model, capacity, color, grade FROM sku_catalog'
  ).all<{ sku: string; brand: string; model: string; capacity: string | null; color: string | null; grade: string | null }>()
  const existingMap = new Map(existingRows.map(r => [r.sku, r]))

  const report: Report[] = []

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {}
    const brand = (r.brand || '').trim()
    const model = (r.model || '').trim()
    const capacity = normalizeCapacity(r.capacity)
    const color = r.color ? String(r.color).trim() : null
    // Grade is now first-class on catalog. Anything missing/invalid → UG so
    // the row is still usable; this matches receive-side normalisation.
    const rawGrade = (r.grade ?? '').toString().trim()
    const gradeValid = VALID_GRADES.includes(rawGrade.toUpperCase() as never)
    const grade = gradeValid ? rawGrade.toUpperCase() : normalizeGrade(rawGrade)

    if (!brand || !model) {
      report.push({
        row_index: i, outcome: 'invalid', sku: null,
        brand: brand || null, model: model || null, capacity, color, grade,
        message: 'brand and model are required',
      })
      continue
    }

    const sku = (r.sku && r.sku.trim()) || deriveSku(brand, model, capacity, color, grade)

    // Check existing (DB + any rows we've inserted/seen earlier in this upload).
    const prior = existingMap.get(sku)
    if (prior) {
      const same =
        prior.brand === brand &&
        prior.model === model &&
        (prior.capacity || null) === capacity &&
        (prior.color || null) === color &&
        (prior.grade || null) === grade
      report.push({
        row_index: i,
        outcome: same ? 'duplicate' : 'collision',
        sku, brand, model, capacity, color, grade,
        existing: prior,
        message: same
          ? 'SKU already exists with identical fields — skipped'
          : 'SKU exists but with different brand/model/capacity/color/grade — NOT merged, please resolve manually',
      })
      continue
    }

    // Good to insert
    if (!dryRun) {
      await c.env.DB.prepare(
        `INSERT INTO sku_catalog (sku, brand, model, capacity, color, grade) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(sku, brand, model, capacity, color, grade).run()
    }
    report.push({ row_index: i, outcome: 'inserted', sku, brand, model, capacity, color, grade })
    // Mark as known so the next row in this upload sees it (in-upload duplicate detection)
    existingMap.set(sku, { sku, brand, model, capacity, color, grade })
  }

  const summary = {
    inserted: report.filter(r => r.outcome === 'inserted').length,
    duplicate: report.filter(r => r.outcome === 'duplicate').length,
    collision: report.filter(r => r.outcome === 'collision').length,
    invalid: report.filter(r => r.outcome === 'invalid').length,
    total: report.length,
    dry_run: dryRun,
  }
  return c.json({ ok: true, summary, report })
})

// Live lookup endpoint for the ConfirmSkuModal. The modal calls this as the
// operator edits model/capacity/color/grade so it can re-resolve to a
// catalog SKU on every change, without having to re-scan the IMEI.
// Body: { model, capacity, color, grade }
import { resolveCatalogSku } from '../lib/catalog'
app.post('/lookup', async (c) => {
  const body = await c.req.json<{
    model?: string | null
    capacity?: string | null
    color?: string | null
    grade?: string | null
  }>()
  const grade = normalizeGrade(body.grade)
  const result = await resolveCatalogSku(c.env.DB, {
    model: body.model,
    capacity: body.capacity,
    color: body.color,
    grade,
  })
  return c.json(result)
})

// Add a single catalog entry on the fly from the ConfirmSkuModal when no
// matching SKU exists. Body: { brand, model, capacity, color, grade, sku? }
// Returns the inserted row (or the conflicting row if a SKU collision exists).
app.post('/', async (c) => {
  const body = await c.req.json<{
    brand?: string | null
    model?: string | null
    capacity?: string | null
    color?: string | null
    grade?: string | null
    sku?: string | null
  }>()
  const brand = (body.brand || '').trim()
  const model = (body.model || '').trim()
  const capacity = normalizeCapacity(body.capacity)
  const color = body.color ? String(body.color).trim() : null
  const grade = normalizeGrade(body.grade)

  if (!brand || !model) {
    return c.json({ error: 'brand and model are required' }, 400)
  }
  // Refuse if a row already matches (model+capacity+color+grade) — operator
  // should pick that one rather than create a duplicate.
  const existingMatch = await resolveCatalogSku(c.env.DB, { model, capacity, color, grade })
  if (existingMatch.status === 'match') {
    return c.json({
      error: 'A catalog SKU already exists for this combination',
      existing: existingMatch.row,
    }, 409)
  }

  // Derive SKU if not provided
  const sku = body.sku?.trim() || (() => {
    const built = buildSku({ oem: brand, description: model, color, capacity })
    return `${built.sku}-${grade}`
  })()

  // Refuse if SKU collides with a different row
  const collision = await c.env.DB.prepare(
    'SELECT id, sku, brand, model, capacity, color, grade FROM sku_catalog WHERE sku = ?'
  ).bind(sku).first()
  if (collision) {
    return c.json({
      error: `SKU '${sku}' already exists with different fields`,
      existing: collision,
    }, 409)
  }

  const ins = await c.env.DB.prepare(
    'INSERT INTO sku_catalog (sku, brand, model, capacity, color, grade) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(sku, brand, model, capacity, color, grade).run()
  const row = await c.env.DB.prepare('SELECT * FROM sku_catalog WHERE id = ?')
    .bind(ins.meta.last_row_id).first()
  return c.json({ ok: true, row })
})

// Delete a single catalogue entry by id. Does NOT affect received_devices that
// reference this SKU — those keep their copy of the SKU string.
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  await c.env.DB.prepare('DELETE FROM sku_catalog WHERE id = ?').bind(id).run()
  return c.json({ ok: true })
})

export default app
