import { Hono } from 'hono'
import type { Bindings } from '../types'
import { buildSku, brandFromOem, colorShortCode } from '../lib/sku'

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
    existing?: { sku: string; brand: string; model: string; capacity: string | null; color: string | null }
    message?: string
  }

  // Build a canonical SKU for a catalogue row, mirroring buildSku()
  // but using the row's own brand/model/capacity/color (not OEM/description).
  function deriveSku(brand: string, model: string, capacity: string | null, color: string | null): string {
    // Reuse the same building blocks so receive-side codes match catalogue codes
    const { brandCode } = brandFromOem(brand)
    const built = buildSku({
      oem: brand,
      description: capacity ? `${model} ${capacity}` : model,
      color,
    })
    // buildSku returns its own composite — that's fine for us; brandCode is
    // referenced just to keep the helper used (and to make this future-proof
    // if we ever need to override the brand mapping)
    void brandCode
    return built.sku
  }

  // Pre-load existing SKUs into a map so we can check without N+1 queries.
  // For a prototype catalogue (< ~10k rows) this is fine.
  const { results: existingRows } = await c.env.DB.prepare(
    'SELECT sku, brand, model, capacity, color FROM sku_catalog'
  ).all<{ sku: string; brand: string; model: string; capacity: string | null; color: string | null }>()
  const existingMap = new Map(existingRows.map(r => [r.sku, r]))

  const report: Report[] = []

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {}
    const brand = (r.brand || '').trim()
    const model = (r.model || '').trim()
    const capacity = r.capacity ? String(r.capacity).trim() : null
    const color = r.color ? String(r.color).trim() : null

    if (!brand || !model) {
      report.push({
        row_index: i, outcome: 'invalid', sku: null,
        brand: brand || null, model: model || null, capacity, color,
        message: 'brand and model are required',
      })
      continue
    }

    const sku = (r.sku && r.sku.trim()) || deriveSku(brand, model, capacity, color)

    // Check existing (DB + any rows we've inserted/seen earlier in this upload).
    const prior = existingMap.get(sku)
    if (prior) {
      const same =
        prior.brand === brand &&
        prior.model === model &&
        (prior.capacity || null) === capacity &&
        (prior.color || null) === color
      report.push({
        row_index: i,
        outcome: same ? 'duplicate' : 'collision',
        sku, brand, model, capacity, color,
        existing: prior,
        message: same
          ? 'SKU already exists with identical fields — skipped'
          : 'SKU exists but with different brand/model/capacity/color — NOT merged, please resolve manually',
      })
      continue
    }

    // Good to insert
    if (!dryRun) {
      await c.env.DB.prepare(
        `INSERT INTO sku_catalog (sku, brand, model, capacity, color) VALUES (?, ?, ?, ?, ?)`
      ).bind(sku, brand, model, capacity, color).run()
    }
    report.push({ row_index: i, outcome: 'inserted', sku, brand, model, capacity, color })
    // Mark as known so the next row in this upload sees it (in-upload duplicate detection)
    existingMap.set(sku, { sku, brand, model, capacity, color })
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

// Delete a single catalogue entry by id. Does NOT affect received_devices that
// reference this SKU — those keep their copy of the SKU string.
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  await c.env.DB.prepare('DELETE FROM sku_catalog WHERE id = ?').bind(id).run()
  return c.json({ ok: true })
})

export default app
