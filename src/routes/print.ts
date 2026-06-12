import { Hono } from 'hono'
import type { Bindings } from '../types'

const app = new Hono<{ Bindings: Bindings }>()

// Pending print queue (what would be sent to PrintNode / QZ Tray)
app.get('/queue', async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT pj.*, rd.uuid, rd.imei, rd.sku, rd.brand, rd.model, rd.capacity, rd.color, rd.grade
    FROM print_jobs pj
    JOIN received_devices rd ON rd.id = pj.received_device_id
    WHERE pj.status = 'queued'
    ORDER BY pj.id ASC
    LIMIT 100
  `).all()
  return c.json({ queue: results })
})

// "Send" a job — in production this would POST to PrintNode / QZ Tray.
// Here we just flip status to 'sent' and stamp received_devices.label_printed_at.
app.post('/send/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const job = await c.env.DB.prepare('SELECT * FROM print_jobs WHERE id = ?').bind(id).first<{
    id: number
    received_device_id: number
    status: string
  }>()
  if (!job) return c.json({ error: 'Not found' }, 404)
  if (job.status === 'sent') return c.json({ ok: true, already: true })

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE print_jobs SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id),
    c.env.DB.prepare("UPDATE received_devices SET label_printed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(job.received_device_id),
  ])
  return c.json({ ok: true })
})

// Send all queued (bulk "release print spooler")
app.post('/send-all', async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, received_device_id FROM print_jobs WHERE status = 'queued'"
  ).all<{ id: number; received_device_id: number }>()
  const stmts = results.flatMap((j) => [
    c.env.DB.prepare("UPDATE print_jobs SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?").bind(j.id),
    c.env.DB.prepare("UPDATE received_devices SET label_printed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(j.received_device_id),
  ])
  if (stmts.length) await c.env.DB.batch(stmts)
  return c.json({ ok: true, sent: results.length })
})

// Fetch a print job payload (for the label preview popup)
app.get('/job/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const job = await c.env.DB.prepare(`
    SELECT pj.*, rd.uuid, rd.imei, rd.sku, rd.brand, rd.model, rd.capacity, rd.color, rd.grade
    FROM print_jobs pj
    JOIN received_devices rd ON rd.id = pj.received_device_id
    WHERE pj.id = ?
  `).bind(id).first()
  if (!job) return c.json({ error: 'Not found' }, 404)
  return c.json({ job })
})

export default app
