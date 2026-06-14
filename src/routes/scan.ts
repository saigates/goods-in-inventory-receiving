import { Hono } from 'hono'
import type { Bindings, ExpectedDevice, ReceivedDevice } from '../types'
import { buildSku } from '../lib/sku'
import { shortUuid } from '../lib/uuid'
import { normalizeGrade } from '../lib/grade'

// SQLite raises 'UNIQUE constraint failed: received_devices.imei' if a
// duplicate IMEI slips past the pre-check. Detect that so we can return
// a friendly outcome instead of a 500.
function isImeiUniqueError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed:\s*received_devices\.imei/i.test(msg)
}

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

  // Defensive: someone could have raced ahead and received this IMEI between
  // the scan event and the confirm. UNIQUE constraint will catch it too.
  const existing = await c.env.DB.prepare('SELECT id, uuid, sku FROM received_devices WHERE imei = ?')
    .bind(expected.imei).first<{ id: number; uuid: string; sku: string }>()
  if (existing) {
    return c.json({ error: `IMEI ${expected.imei} already received (UUID ${existing.uuid}, SKU ${existing.sku})` }, 409)
  }

  // Force grade into the strict A|B|C|UG set. The body grade wins if valid;
  // otherwise we fall back to the (already-normalised) manifest grade; if
  // both are missing we default to UG.
  const grade = normalizeGrade(body.grade ?? expected.grade)

  const uuid = shortUuid()
  let insRecv
  try {
    insRecv = await c.env.DB.prepare(
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
      grade,
      expected.manifest_id,
      expected.id,
      body.notes ?? null
    ).run()
  } catch (err) {
    if (isImeiUniqueError(err)) {
      return c.json({ error: `IMEI ${expected.imei} already received` }, 409)
    }
    throw err
  }

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
      grade,
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

  const dup = await c.env.DB.prepare('SELECT id, uuid, sku FROM received_devices WHERE imei = ?')
    .bind(imei).first<{ id: number; uuid: string; sku: string }>()
  if (dup) return c.json({ error: `IMEI ${imei} already received (UUID ${dup.uuid}, SKU ${dup.sku})` }, 409)

  const built = buildSku({
    oem: body.oem || 'UNK',
    description: body.description || 'Unknown',
    color: body.color || null,
  })
  const grade = normalizeGrade(body.grade)

  const uuid = shortUuid()
  let ins
  try {
    ins = await c.env.DB.prepare(
      `INSERT INTO received_devices
       (uuid, imei, sku, brand, model, capacity, color, grade, source, manifest_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unreconciled', ?, ?)`
    ).bind(
      uuid, imei, built.sku, built.brand, built.model, built.capacity, built.color,
      grade, body.manifest_id || null,
      body.notes || 'Force-added: not on manifest. Pending manager review.'
    ).run()
  } catch (err) {
    if (isImeiUniqueError(err)) {
      return c.json({ error: `IMEI ${imei} already received` }, 409)
    }
    throw err
  }

  const receivedId = ins.meta.last_row_id as number

  // Queue print job
  const payload = { uuid, sku: built.sku, imei, ...built, grade }
  await c.env.DB.prepare(
    `INSERT INTO print_jobs (received_device_id, payload_json) VALUES (?, ?)`
  ).bind(receivedId, JSON.stringify(payload)).run()

  const received = await c.env.DB.prepare('SELECT * FROM received_devices WHERE id = ?')
    .bind(receivedId).first<ReceivedDevice>()

  return c.json({ ok: true, received })
})

// ───────── Manual receive (no manifest required) ─────────
// Used for the "Quick receive" path when there is no ASN/manifest. The
// operator scans/types an IMEI, picks a SKU (typically from the catalogue),
// and the device gets booked into inventory with source='manual'.
app.post('/manual', async (c) => {
  const body = await c.req.json<{
    imei: string
    sku?: string
    brand?: string
    model?: string
    capacity?: string
    color?: string
    grade?: string
    notes?: string
    auto_print?: boolean
  }>()

  const imei = String(body.imei || '').trim()
  if (!imei || !/^\d{14,17}$/.test(imei)) {
    return c.json({ error: 'IMEI must be 14-17 digits' }, 400)
  }

  // Duplicate check — same friendly path as scan/confirm.
  const existing = await c.env.DB.prepare('SELECT id, uuid, sku FROM received_devices WHERE imei = ?')
    .bind(imei).first<{ id: number; uuid: string; sku: string }>()
  if (existing) {
    return c.json({
      error: `IMEI ${imei} already received`,
      detail: { uuid: existing.uuid, sku: existing.sku },
    }, 409)
  }

  // Resolve SKU. If the caller supplied an explicit SKU we use it as-is;
  // otherwise we try to look it up by (brand+model+capacity) from the
  // catalogue; otherwise we fall back to buildSku() like force-add does.
  let sku = body.sku?.trim() || ''
  let brand = body.brand?.trim() || null
  let model = body.model?.trim() || null
  let capacity = body.capacity?.trim() || null
  let color = body.color?.trim() || null

  if (sku) {
    // Try to enrich from the catalogue so the printed label has full info
    const row = await c.env.DB.prepare(
      'SELECT brand, model, capacity, color FROM sku_catalog WHERE sku = ?'
    ).bind(sku).first<{ brand: string; model: string; capacity: string | null; color: string | null }>()
    if (row) {
      brand = brand || row.brand
      model = model || row.model
      capacity = capacity || row.capacity
      color = color || row.color
    }
  } else {
    // No SKU given — derive one (same algorithm as force-add)
    const built = buildSku({ oem: brand, description: [model, capacity].filter(Boolean).join(' '), color })
    sku = built.sku
    brand = brand || built.brand
    model = model || built.model
    capacity = capacity || built.capacity
    color = color || built.color
  }

  const grade = normalizeGrade(body.grade)
  const uuid = shortUuid()

  let ins
  try {
    ins = await c.env.DB.prepare(
      `INSERT INTO received_devices
       (uuid, imei, sku, brand, model, capacity, color, grade, source, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`
    ).bind(
      uuid, imei, sku, brand, model, capacity, color, grade,
      body.notes || null
    ).run()
  } catch (err) {
    if (isImeiUniqueError(err)) {
      return c.json({ error: `IMEI ${imei} already received` }, 409)
    }
    throw err
  }

  const receivedId = ins.meta.last_row_id as number

  // Audit log (reuse scan_events with outcome='matched' but no manifest)
  await c.env.DB.prepare(
    "INSERT INTO scan_events (manifest_id, imei, outcome, message) VALUES (NULL, ?, 'matched', 'Manual receive')"
  ).bind(imei).run()

  // Queue print job by default
  let printJobId: number | null = null
  if (body.auto_print !== false) {
    const payload = { uuid, sku, imei, brand, model, capacity, color, grade }
    const pj = await c.env.DB.prepare(
      'INSERT INTO print_jobs (received_device_id, payload_json) VALUES (?, ?)'
    ).bind(receivedId, JSON.stringify(payload)).run()
    printJobId = pj.meta.last_row_id as number
  }

  const received = await c.env.DB.prepare('SELECT * FROM received_devices WHERE id = ?')
    .bind(receivedId).first<ReceivedDevice>()

  return c.json({ ok: true, received, print_job_id: printJobId })
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
