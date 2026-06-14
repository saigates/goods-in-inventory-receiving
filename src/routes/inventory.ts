import { Hono } from 'hono'
import type { Bindings } from '../types'
import { normalizeGrade, VALID_GRADES } from '../lib/grade'

const app = new Hono<{ Bindings: Bindings }>()

// Browse all received devices with filters
app.get('/', async (c) => {
  const q = c.req.query()
  const limit = Math.min(Number(q.limit) || 100, 500)
  const where: string[] = []
  const binds: unknown[] = []

  if (q.q) {
    where.push('(imei LIKE ? OR sku LIKE ? OR uuid LIKE ?)')
    const w = `%${q.q}%`
    binds.push(w, w, w)
  }
  if (q.source) {
    where.push('source = ?')
    binds.push(q.source)
  }
  if (q.manifest_id) {
    where.push('manifest_id = ?')
    binds.push(Number(q.manifest_id))
  }

  const sql = `
    SELECT * FROM received_devices
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC
    LIMIT ?
  `
  binds.push(limit)
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all()
  return c.json({ devices: results })
})

// Delete a received device. Restores the original manifest line to 'pending'
// (so it can be re-scanned), and removes any associated print jobs.
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const device = await c.env.DB.prepare('SELECT * FROM received_devices WHERE id = ?')
    .bind(id).first<{ id: number; expected_device_id: number | null; imei: string; manifest_id: number | null }>()
  if (!device) return c.json({ error: 'Not found' }, 404)

  const stmts = []
  // Re-open the manifest line if this came from a manifest
  if (device.expected_device_id) {
    stmts.push(
      c.env.DB.prepare(
        `UPDATE expected_devices
         SET status = 'pending', received_at = NULL, received_device_id = NULL
         WHERE id = ?`
      ).bind(device.expected_device_id)
    )
  }
  // Audit log
  stmts.push(
    c.env.DB.prepare(
      "INSERT INTO scan_events (manifest_id, imei, outcome, message) VALUES (?, ?, 'rejected', 'Received device deleted by operator')"
    ).bind(device.manifest_id, device.imei)
  )
  // print_jobs are cascade-deleted via FK
  stmts.push(c.env.DB.prepare('DELETE FROM received_devices WHERE id = ?').bind(id))

  await c.env.DB.batch(stmts)
  return c.json({ ok: true, restored_expected: !!device.expected_device_id })
})

// ───────── Grade override (single + bulk) ─────────
// Body: { ids: number[], grade: 'A'|'B'|'C'|'UG', actor?: string, reason?: string }
// Writes one received_devices.grade update per id and one grade_audit row per id.
// Bulk and single use the same endpoint — single is just ids.length === 1.
// Returns { ok, updated, skipped, audit_bulk_id }.
app.post('/grade', async (c) => {
  const body = await c.req.json<{
    ids: number[]
    grade: string
    actor?: string
    reason?: string
  }>()

  const ids = Array.from(new Set((body.ids || []).map(Number).filter(Boolean)))
  if (ids.length === 0) return c.json({ error: 'ids[] required' }, 400)

  const grade = normalizeGrade(body.grade)
  // Be strict: if the caller sent something not in the set we refuse rather
  // than silently coercing (which would hide bugs).
  if (!VALID_GRADES.includes(grade) || String(body.grade).toUpperCase() !== grade) {
    return c.json({
      error: `Invalid grade '${body.grade}'. Allowed: ${VALID_GRADES.join(', ')}`,
    }, 400)
  }

  const actor = (body.actor || 'operator').slice(0, 64)
  const reason = body.reason ? String(body.reason).slice(0, 500) : null
  // Stamp a single bulk_id so we can group bulk-override audit rows together.
  const bulkId = ids.length > 1
    ? `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    : null

  // Fetch current state for the audit row + skip detection.
  const placeholders = ids.map(() => '?').join(',')
  const { results: current } = await c.env.DB.prepare(
    `SELECT id, imei, grade FROM received_devices WHERE id IN (${placeholders})`
  ).bind(...ids).all<{ id: number; imei: string; grade: string }>()

  const updated: number[] = []
  const skipped: { id: number; reason: string }[] = []
  const stmts = []
  const foundIds = new Set(current.map(r => r.id))
  for (const id of ids) {
    if (!foundIds.has(id)) {
      skipped.push({ id, reason: 'not found' })
    }
  }
  for (const row of current) {
    if (row.grade === grade) {
      // No-op — same grade, don't write an audit row.
      skipped.push({ id: row.id, reason: 'unchanged' })
      continue
    }
    stmts.push(
      c.env.DB.prepare('UPDATE received_devices SET grade = ? WHERE id = ?').bind(grade, row.id)
    )
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO grade_audit
         (received_device_id, imei, old_grade, new_grade, actor, reason, bulk_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(row.id, row.imei, row.grade, grade, actor, reason, bulkId)
    )
    updated.push(row.id)
  }

  if (stmts.length) await c.env.DB.batch(stmts)

  return c.json({
    ok: true,
    grade,
    updated_count: updated.length,
    updated_ids: updated,
    skipped,
    bulk_id: bulkId,
  })
})

// Audit log for a single device's grade history (or for a bulk operation)
app.get('/grade-audit/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM grade_audit WHERE received_device_id = ? ORDER BY id DESC LIMIT 50`
  ).bind(id).all()
  return c.json({ audit: results })
})

// Global stats
app.get('/stats', async (c) => {
  const stats = await c.env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM manifests WHERE status = 'open') AS open_manifests,
      (SELECT COUNT(*) FROM expected_devices WHERE status = 'pending') AS pending_devices,
      (SELECT COUNT(*) FROM received_devices) AS received_total,
      (SELECT COUNT(*) FROM received_devices WHERE source = 'unreconciled') AS unreconciled_total,
      (SELECT COUNT(*) FROM print_jobs WHERE status = 'queued') AS print_queue
  `).first()
  return c.json({ stats })
})

export default app
