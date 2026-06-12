import { Hono } from 'hono'
import type { Bindings, ExpectedDevice, ReceivedDevice } from '../types'
import { buildSku } from '../lib/sku'
import { shortUuid } from '../lib/uuid'

const app = new Hono<{ Bindings: Bindings }>()

// Scan an IMEI against an active manifest.
// Returns one of:
//  - { outcome: 'matched',       expected, suggested_sku }   (needs SKU confirmation)
//  - { outcome: 'duplicate',     received }
//  - { outcome: 'unreconciled',  imei, message }             (caller decides: force-add or reject)
app.post('/', async (c) => {
  const body = await c.req.json<{ manifest_id: number; imei: string }>()
  const manifestId = Number(body.manifest_id)
  const imei = String(body.imei || '').trim()

  if (!manifestId || !imei) return c.json({ error: 'manifest_id and imei required' }, 400)
  if (!/^\d{14,17}$/.test(imei)) {
    return c.json({ outcome: 'rejected', imei, message: 'IMEI must be 14-17 digits' }, 200)
  }

  // First: did we already receive this IMEI?
  const alreadyReceived = await c.env.DB.prepare(
    'SELECT * FROM received_devices WHERE imei = ?'
  ).bind(imei).first<ReceivedDevice>()

  if (alreadyReceived) {
    await c.env.DB.prepare(
      "INSERT INTO scan_events (manifest_id, imei, outcome, message) VALUES (?, ?, 'duplicate', 'Already received')"
    ).bind(manifestId, imei).run()
    return c.json({ outcome: 'duplicate', received: alreadyReceived })
  }

  // Check manifest
  const expected = await c.env.DB.prepare(
    'SELECT * FROM expected_devices WHERE manifest_id = ? AND imei = ?'
  ).bind(manifestId, imei).first<ExpectedDevice>()

  if (!expected) {
    await c.env.DB.prepare(
      "INSERT INTO scan_events (manifest_id, imei, outcome, message) VALUES (?, ?, 'unreconciled', 'Not on manifest')"
    ).bind(manifestId, imei).run()
    return c.json({
      outcome: 'unreconciled',
      imei,
      message: 'This IMEI is not on the manifest. Reject or force-add to Unreconciled bucket.',
    })
  }

  // Compute a suggested SKU using parsed description and a default color
  const suggested = buildSku({ oem: expected.oem, description: expected.description })

  await c.env.DB.prepare(
    "INSERT INTO scan_events (manifest_id, imei, outcome, message) VALUES (?, ?, 'matched', NULL)"
  ).bind(manifestId, imei).run()

  return c.json({
    outcome: 'matched',
    expected,
    suggested_sku: suggested,
  })
})

// Confirm a matched scan with a final SKU (and optionally color override).
// Creates received_devices row, marks expected as received, and queues a print job.
app.post('/confirm', async (c) => {
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
  }>()

  if (!body.expected_device_id || !body.sku) {
    return c.json({ error: 'expected_device_id and sku required' }, 400)
  }

  const expected = await c.env.DB.prepare(
    'SELECT * FROM expected_devices WHERE id = ?'
  ).bind(body.expected_device_id).first<ExpectedDevice>()
  if (!expected) return c.json({ error: 'Expected device not found' }, 404)
  if (expected.status === 'received') {
    return c.json({ error: 'Already received' }, 409)
  }

  const uuid = shortUuid()
  const insRecv = await c.env.DB.prepare(
    `INSERT INTO received_devices
     (uuid, imei, sku, brand, model, capacity, color, grade, source, manifest_id, expected_device_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manifest', ?, ?, ?)`
  ).bind(
    uuid,
    expected.imei,
    body.sku,
    body.brand ?? null,
    body.model ?? null,
    body.capacity ?? null,
    body.color ?? null,
    body.grade ?? expected.grade ?? null,
    expected.manifest_id,
    expected.id,
    body.notes ?? null
  ).run()

  const receivedId = insRecv.meta.last_row_id as number

  await c.env.DB.prepare(
    `UPDATE expected_devices
     SET status = 'received', received_at = CURRENT_TIMESTAMP, received_device_id = ?
     WHERE id = ?`
  ).bind(receivedId, expected.id).run()

  // Queue print job
  let printJobId: number | null = null
  if (body.auto_print !== false) {
    const payload = {
      uuid,
      sku: body.sku,
      imei: expected.imei,
      brand: body.brand,
      model: body.model,
      capacity: body.capacity,
      color: body.color,
      grade: body.grade ?? expected.grade,
    }
    const pj = await c.env.DB.prepare(
      `INSERT INTO print_jobs (received_device_id, payload_json) VALUES (?, ?)`
    ).bind(receivedId, JSON.stringify(payload)).run()
    printJobId = pj.meta.last_row_id as number
  }

  const received = await c.env.DB.prepare('SELECT * FROM received_devices WHERE id = ?')
    .bind(receivedId).first<ReceivedDevice>()

  return c.json({ ok: true, received, print_job_id: printJobId })
})

// Force-add an unreconciled IMEI (not on manifest) to the inventory bucket
app.post('/force-add', async (c) => {
  const body = await c.req.json<{
    manifest_id: number
    imei: string
    oem?: string
    description?: string
    grade?: string
    color?: string
    notes?: string
  }>()

  const imei = String(body.imei || '').trim()
  if (!imei || !/^\d{14,17}$/.test(imei)) {
    return c.json({ error: 'Invalid IMEI' }, 400)
  }

  const dup = await c.env.DB.prepare('SELECT id FROM received_devices WHERE imei = ?')
    .bind(imei).first()
  if (dup) return c.json({ error: 'IMEI already received' }, 409)

  const built = buildSku({
    oem: body.oem || 'UNK',
    description: body.description || 'Unknown',
    color: body.color || null,
  })

  const uuid = shortUuid()
  const ins = await c.env.DB.prepare(
    `INSERT INTO received_devices
     (uuid, imei, sku, brand, model, capacity, color, grade, source, manifest_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unreconciled', ?, ?)`
  ).bind(
    uuid, imei, built.sku, built.brand, built.model, built.capacity, built.color,
    body.grade || null, body.manifest_id || null,
    body.notes || 'Force-added: not on manifest. Pending manager review.'
  ).run()

  const receivedId = ins.meta.last_row_id as number

  // Queue print job
  const payload = { uuid, sku: built.sku, imei, ...built, grade: body.grade }
  await c.env.DB.prepare(
    `INSERT INTO print_jobs (received_device_id, payload_json) VALUES (?, ?)`
  ).bind(receivedId, JSON.stringify(payload)).run()

  const received = await c.env.DB.prepare('SELECT * FROM received_devices WHERE id = ?')
    .bind(receivedId).first<ReceivedDevice>()

  return c.json({ ok: true, received })
})

// Reject an unreconciled scan (just log it)
app.post('/reject', async (c) => {
  const body = await c.req.json<{ manifest_id: number; imei: string; reason?: string }>()
  await c.env.DB.prepare(
    "INSERT INTO scan_events (manifest_id, imei, outcome, message) VALUES (?, ?, 'rejected', ?)"
  ).bind(body.manifest_id || null, body.imei, body.reason || 'Rejected by operator').run()
  return c.json({ ok: true })
})

// Recent scan events for a manifest (for live activity feed)
app.get('/events/:manifestId', async (c) => {
  const id = Number(c.req.param('manifestId'))
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM scan_events WHERE manifest_id = ? ORDER BY id DESC LIMIT 30'
  ).bind(id).all()
  return c.json({ events: results })
})

export default app
