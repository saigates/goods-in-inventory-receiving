import { Hono } from 'hono'
import type { Bindings } from '../types'

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
