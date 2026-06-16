import { Hono } from 'hono'
import type { Bindings } from '../types'
import { buildSku } from '../lib/sku'
import { normalizeGrade } from '../lib/grade'

const app = new Hono<{ Bindings: Bindings }>()

// List all manifests with progress counts
app.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT m.*,
      (SELECT COUNT(*) FROM expected_devices WHERE manifest_id = m.id) AS expected_count,
      (SELECT COUNT(*) FROM expected_devices WHERE manifest_id = m.id AND status = 'received') AS received_count,
      (SELECT COUNT(*) FROM received_devices WHERE manifest_id = m.id AND source = 'unreconciled') AS unreconciled_count
    FROM manifests m
    ORDER BY m.created_at DESC
  `).all()
  return c.json({ manifests: results })
})

// Get one manifest with all expected lines and any unreconciled scans for it
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const manifest = await c.env.DB.prepare('SELECT * FROM manifests WHERE id = ?').bind(id).first()
  if (!manifest) return c.json({ error: 'Not found' }, 404)

  const expected = await c.env.DB.prepare(`
    SELECT ed.*, rd.uuid AS received_uuid, rd.sku AS received_sku
    FROM expected_devices ed
    LEFT JOIN received_devices rd ON rd.id = ed.received_device_id
    WHERE ed.manifest_id = ?
    ORDER BY ed.id ASC
  `).bind(id).all()

  const unreconciled = await c.env.DB.prepare(`
    SELECT * FROM received_devices WHERE manifest_id = ? AND source = 'unreconciled'
    ORDER BY created_at DESC
  `).bind(id).all()

  const summary = await c.env.DB.prepare(`
    SELECT
      COUNT(*) AS expected_count,
      SUM(CASE WHEN status = 'received' THEN 1 ELSE 0 END) AS received_count
    FROM expected_devices WHERE manifest_id = ?
  `).bind(id).first<{ expected_count: number; received_count: number }>()

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
  capacity?: string | null
  color?: string | null
}

// Create a manifest with a batch of expected devices (JSON body)
app.post('/', async (c) => {
  const body = await c.req.json<{
    reference: string
    supplier: string
    notes?: string
    rows: ImportRow[]
  }>()

  if (!body.reference || !body.supplier || !Array.isArray(body.rows) || body.rows.length === 0) {
    return c.json({ error: 'reference, supplier, and rows[] are required' }, 400)
  }

  // Check duplicate reference
  const existing = await c.env.DB.prepare('SELECT id FROM manifests WHERE reference = ?')
    .bind(body.reference).first()
  if (existing) return c.json({ error: `Manifest reference '${body.reference}' already exists` }, 409)

  // Create manifest
  const ins = await c.env.DB.prepare(
    'INSERT INTO manifests (reference, supplier, notes) VALUES (?, ?, ?)'
  ).bind(body.reference, body.supplier, body.notes || null).run()
  const manifestId = ins.meta.last_row_id as number

  // Pre-resolve SKU when possible
  const stmts = body.rows.map((r) => {
    const imei = String(r.imei).trim()
    const capacity = r.capacity ? String(r.capacity).trim() || null : null
    const color = r.color ? String(r.color).trim() || null : null
    let sku: string | null = null
    if (r.description && r.oem) {
      // Best-effort prepopulation; if capacity/color were supplied in the manifest,
      // fold them into the SKU so receiving doesn't have to guess.
      sku = buildSku({
        oem: r.oem,
        description: r.description,
        capacity,
        color,
      }).sku
    }
    // Supplier-declared grade is only a hint — normalise to A | B | C | UG.
    // Anything else (B+, A-, missing, junk) → UG. Real grade assigned at QC.
    const grade = normalizeGrade(r.grade)
    return c.env.DB.prepare(
      `INSERT INTO expected_devices
       (manifest_id, oem, condition, description, grade, model_no, imei, unit_cost, sku, capacity, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      manifestId,
      r.oem || null,
      r.condition || null,
      r.description || null,
      grade,
      r.model_no || null,
      imei,
      r.unit_cost ?? null,
      sku,
      capacity,
      color,
    )
  })

  // D1 batch
  await c.env.DB.batch(stmts)

  return c.json({ ok: true, manifest_id: manifestId, count: body.rows.length })
})

// Close/reopen a manifest
app.post('/:id/close', async (c) => {
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare(
    "UPDATE manifests SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).bind(id).run()
  return c.json({ ok: true })
})

app.post('/:id/reopen', async (c) => {
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare(
    "UPDATE manifests SET status = 'open', closed_at = NULL WHERE id = ?"
  ).bind(id).run()
  return c.json({ ok: true })
})

// Delete manifest. expected_devices cascade. received_devices stay in
// inventory — their manifest_id / expected_device_id are SET NULL by FK.
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  // Count surviving received_devices for the response so the operator knows
  // what was orphaned into the general inventory bucket.
  const orphan = await c.env.DB.prepare(
    'SELECT COUNT(*) AS c FROM received_devices WHERE manifest_id = ?'
  ).bind(id).first<{ c: number }>()
  try {
    const res = await c.env.DB.prepare('DELETE FROM manifests WHERE id = ?').bind(id).run()
    if (!res.meta.changes) return c.json({ error: 'Manifest not found' }, 404)
    return c.json({ ok: true, kept_in_inventory: orphan?.c ?? 0 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: `Could not delete manifest: ${msg}` }, 500)
  }
})

export default app
