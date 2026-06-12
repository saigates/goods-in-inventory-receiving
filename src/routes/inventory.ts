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
