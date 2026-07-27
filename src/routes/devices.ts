// Integration seams for later phases (Priority 6): read endpoints the
// future CRM / OPR modules will consume, plus the status-transition
// endpoint that's the single entry point for lifecycle changes, CSV
// export, and outbound webhook configuration.
//
// These are deliberately generic device reads/writes — NOT grading/export/
// customs workflows (explicitly out of scope for this pass).

import { Hono } from 'hono'
import type { Bindings, AuthUser, DeviceStatus } from '../types'
import { currentUser } from '../lib/auth'
import { DEVICE_STATUSES, transitionDevice, InvalidTransitionError, DeviceNotFoundError, ALLOWED_TRANSITIONS } from '../lib/deviceLifecycle'
import { dispatchDeviceStatusWebhooks } from '../lib/webhook'

const app = new Hono<{ Bindings: Bindings; Variables: { user: AuthUser } }>()

// GET /api/devices?status=&source=&q=&page=&page_size=
// Org-scoped, filterable, paginated. This is the primary read seam a
// future CRM integration will poll/subscribe against.
app.get('/', async (c) => {
  const user = currentUser(c)
  const q = c.req.query()
  const pageSize = Math.min(Math.max(Number(q.page_size) || 50, 1), 200)
  const page = Math.max(Number(q.page) || 1, 1)
  const offset = (page - 1) * pageSize

  const where: string[] = ['organisation_id = ?']
  const binds: unknown[] = [user.organisation_id]

  if (q.status) {
    const statuses = q.status.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    const invalid = statuses.filter(s => !DEVICE_STATUSES.includes(s as DeviceStatus))
    if (invalid.length) {
      return c.json({ error: `Invalid status value(s): ${invalid.join(', ')}` }, 400)
    }
    where.push(`status IN (${statuses.map(() => '?').join(',')})`)
    binds.push(...statuses)
  }
  if (q.source) {
    where.push('source = ?')
    binds.push(q.source)
  }
  if (q.q) {
    where.push('(imei LIKE ? OR sku LIKE ? OR uuid LIKE ?)')
    const w = `%${q.q}%`
    binds.push(w, w, w)
  }

  const whereSql = `WHERE ${where.join(' AND ')}`

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM received_devices ${whereSql}`
  ).bind(...binds).first<{ total: number }>()

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM received_devices ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).bind(...binds, pageSize, offset).all()

  return c.json({
    devices: results,
    page,
    page_size: pageSize,
    total: countRow?.total ?? 0,
  })
})

// GET /api/devices/:id — full record with current status + event history.
app.get('/:id', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const device = await c.env.DB.prepare(
    'SELECT * FROM received_devices WHERE id = ? AND organisation_id = ?'
  ).bind(id, user.organisation_id).first()
  if (!device) return c.json({ error: 'Not found' }, 404)

  const { results: events } = await c.env.DB.prepare(
    'SELECT * FROM device_events WHERE device_id = ? AND organisation_id = ? ORDER BY id DESC LIMIT 200'
  ).bind(id, user.organisation_id).all()

  return c.json({ device, events })
})

// GET /api/devices/export/csv?status=&source=&ids=  — CSV export for a
// received/selected batch. `ids` (comma-separated) takes precedence over
// the status/source filters when supplied, for exporting an exact
// operator-picked selection from the Inventory view.
app.get('/export/csv', async (c) => {
  const user = currentUser(c)
  const q = c.req.query()

  const where: string[] = ['organisation_id = ?']
  const binds: unknown[] = [user.organisation_id]

  if (q.ids) {
    const ids = q.ids.split(',').map(Number).filter(Boolean)
    if (!ids.length) return c.json({ error: 'ids must contain at least one numeric id' }, 400)
    where.push(`id IN (${ids.map(() => '?').join(',')})`)
    binds.push(...ids)
  } else {
    if (q.status) {
      where.push('status = ?')
      binds.push(q.status.toUpperCase())
    }
    if (q.source) {
      where.push('source = ?')
      binds.push(q.source)
    }
  }

  const { results } = await c.env.DB.prepare(
    `SELECT id, uuid, imei, sku, brand, model, capacity, color, grade, status, source,
            buy_price, currency, vat_type, label_printed_at, created_at
       FROM received_devices
      WHERE ${where.join(' AND ')}
      ORDER BY id ASC LIMIT 5000`
  ).bind(...binds).all<Record<string, unknown>>()

  const headers = ['id', 'uuid', 'imei', 'sku', 'brand', 'model', 'capacity', 'color', 'grade', 'status', 'source', 'buy_price', 'currency', 'vat_type', 'label_printed_at', 'created_at']
  const escapeCsv = (v: unknown) => {
    if (v == null) return ''
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.join(',')]
  for (const row of results) {
    lines.push(headers.map(h => escapeCsv(row[h])).join(','))
  }
  const csv = lines.join('\n')

  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="devices-export-${Date.now()}.csv"`)
  return c.body(csv)
})

// GET /api/devices/statuses — expose the enum + allowed transition map so a
// CRM/UI can render valid next-states without hardcoding the state machine.
app.get('/meta/statuses', (c) => {
  return c.json({ statuses: DEVICE_STATUSES, transitions: ALLOWED_TRANSITIONS })
})

// POST /api/devices/:id/transition — the single API entry point for status
// changes. Body: { to_status, reference?, metadata? }
app.post('/:id/transition', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const body = await c.req.json<{ to_status?: string; reference?: string; metadata?: Record<string, unknown> }>().catch(() => ({} as any))
  const toStatus = String(body.to_status || '').toUpperCase() as DeviceStatus
  if (!DEVICE_STATUSES.includes(toStatus)) {
    return c.json({ error: `to_status must be one of: ${DEVICE_STATUSES.join(', ')}` }, 400)
  }

  try {
    const { device, event } = await transitionDevice(c.env.DB, id, toStatus, {
      user,
      reference: body.reference ?? null,
      metadata: body.metadata ?? null,
      eventType: 'STATUS_CHANGE',
    })

    // Fire-and-forget webhook. Not awaited-blocking the response would be
    // ideal, but Workers require awaiting async work before the response
    // finishes unless we use waitUntil — do that where available.
    const notify = dispatchDeviceStatusWebhooks(c.env.DB, {
      event: 'device.status_changed',
      organisation_id: user.organisation_id,
      device_id: id,
      imei: String((device as any).imei),
      uuid: String((device as any).uuid),
      from_status: (event as any).from_status ?? null,
      to_status: toStatus,
      user_id: user.id,
      occurred_at: new Date().toISOString(),
    })
    if (typeof (c.executionCtx as any)?.waitUntil === 'function') {
      ;(c.executionCtx as any).waitUntil(notify)
    } else {
      await notify
    }

    return c.json({ ok: true, device, event })
  } catch (err) {
    if (err instanceof InvalidTransitionError) return c.json({ error: err.message, code: err.code }, 409)
    if (err instanceof DeviceNotFoundError) return c.json({ error: err.message, code: err.code }, 404)
    throw err
  }
})

export default app
