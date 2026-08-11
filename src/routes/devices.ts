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
import { DEVICE_STATUSES, transitionDevice, InvalidTransitionError, DeviceNotFoundError, ALLOWED_TRANSITIONS, OPR_WORKFLOW_ONLY_STATUSES, REPAIR_WORKFLOW_ONLY_STATUSES } from '../lib/deviceLifecycle'
import { dispatchDeviceStatusWebhooks } from '../lib/webhook'
import { startRepair, scanBackRepair, recordQc, reopenRepair, recordRepairCost, RepairJobError } from '../lib/repairWorkflow'

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
//
// This file is an audit artefact, so every failure mode here is LOUD rather
// than a quiet wrong answer:
//   - `status`/`source` are validated against their enums (a typo like
//     `RECIEVED` used to return a headers-only CSV, indistinguishable from
//     "no devices in that state"); `status` accepts a comma-separated list
//     for parity with `GET /api/devices`.
//   - a non-numeric entry in `ids` is a 400, never silently dropped — the
//     operator must never believe they exported a selection they didn't.
//   - exceeding the row cap is a 413 carrying the true total, never a
//     silently truncated file.
// Values are written byte-faithfully: the only transformation is RFC 4180
// quoting (which must include `\r`, not just `\n` — a bare CR terminates a
// record in Excel and would corrupt one device into two malformed rows).
const EXPORT_ROW_CAP = 5000
const DEVICE_SOURCES = ['manifest', 'unreconciled', 'manual'] as const

app.get('/export/csv', async (c) => {
  const user = currentUser(c)
  const q = c.req.query()

  const where: string[] = ['organisation_id = ?']
  const binds: unknown[] = [user.organisation_id]

  if (q.ids) {
    const raw = q.ids.split(',').map(s => s.trim()).filter(s => s !== '')
    if (!raw.length) return c.json({ error: 'ids must contain at least one numeric id' }, 400)
    // Reject junk loudly: silently dropping an unparseable id would hand the
    // operator a file that is missing rows they believe they selected.
    const invalid = raw.filter(s => !/^[1-9][0-9]*$/.test(s))
    if (invalid.length) {
      return c.json({ error: `ids must be positive integers — invalid: ${invalid.join(', ')}` }, 400)
    }
    const ids = raw.map(Number)
    where.push(`id IN (${ids.map(() => '?').join(',')})`)
    binds.push(...ids)
  } else {
    if (q.status) {
      const statuses = q.status.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
      const invalid = statuses.filter(s => !DEVICE_STATUSES.includes(s as DeviceStatus))
      if (invalid.length) {
        return c.json({ error: `Invalid status value(s): ${invalid.join(', ')}` }, 400)
      }
      if (statuses.length) {
        where.push(`status IN (${statuses.map(() => '?').join(',')})`)
        binds.push(...statuses)
      }
    }
    if (q.source) {
      const source = q.source.trim().toLowerCase()
      if (!DEVICE_SOURCES.includes(source as typeof DEVICE_SOURCES[number])) {
        return c.json({ error: `Invalid source value: ${q.source} — must be one of: ${DEVICE_SOURCES.join(', ')}` }, 400)
      }
      where.push('source = ?')
      binds.push(source)
    }
  }

  const whereSql = where.join(' AND ')

  // Count first so truncation can be refused instead of silently delivered.
  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM received_devices WHERE ${whereSql}`
  ).bind(...binds).first<{ total: number }>()
  const total = countRow?.total ?? 0
  if (total > EXPORT_ROW_CAP) {
    return c.json({
      error: `Export matches ${total} devices, above the ${EXPORT_ROW_CAP}-row cap — narrow the selection with status, source or ids rather than accepting a truncated audit file`,
      total,
      cap: EXPORT_ROW_CAP,
    }, 413)
  }

  const { results } = await c.env.DB.prepare(
    `SELECT id, uuid, imei, sku, brand, model, capacity, color, grade, status, source,
            buy_price, currency, vat_type, label_printed_at, created_at
       FROM received_devices
      WHERE ${whereSql}
      ORDER BY id ASC LIMIT ?`
  ).bind(...binds, EXPORT_ROW_CAP).all<Record<string, unknown>>()

  const headers = ['id', 'uuid', 'imei', 'sku', 'brand', 'model', 'capacity', 'color', 'grade', 'status', 'source', 'buy_price', 'currency', 'vat_type', 'label_printed_at', 'created_at']
  const escapeCsv = (v: unknown) => {
    if (v == null) return ''
    const s = String(v)
    return /["\r\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.join(',')]
  for (const row of results) {
    lines.push(headers.map(h => escapeCsv(row[h])).join(','))
  }
  const csv = lines.join('\r\n')

  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="devices-export-${Date.now()}.csv"`)
  // Lets a caller cross-check that it received every row the server counted.
  c.header('X-Export-Row-Count', String(results.length))
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

  // Consignment-derived statuses may only be driven by the OPR workflow
  // endpoints — moving a device in/out of them here would desynchronise
  // shipment_lines from the device ledger.
  if (OPR_WORKFLOW_ONLY_STATUSES.includes(toStatus)) {
    return c.json({ error: `${toStatus} is managed by the OPR consignment workflow — use /api/opr/shipments/:id/lines (add/remove) and /finalise instead of a direct transition` }, 409)
  }
  // Repair-job-derived statuses (Device Lifecycle slice 1) may only be
  // driven by the repair-workflow endpoints below — moving a device
  // in/out of them here would desynchronise repair_jobs from the device
  // ledger. Same pattern/reasoning as the OPR guard above.
  if (REPAIR_WORKFLOW_ONLY_STATUSES.includes(toStatus)) {
    return c.json({ error: `${toStatus} is managed by the repair workflow — use /api/devices/:id/repair/* instead of a direct transition` }, 409)
  }
  {
    const device = await c.env.DB.prepare(
      'SELECT status FROM received_devices WHERE id = ? AND organisation_id = ?'
    ).bind(id, user.organisation_id).first<{ status: DeviceStatus }>()
    if (device && OPR_WORKFLOW_ONLY_STATUSES.includes(device.status)) {
      return c.json({ error: `Device is ${device.status}, which is managed by the OPR consignment workflow — it cannot be transitioned via this endpoint` }, 409)
    }
    if (device && REPAIR_WORKFLOW_ONLY_STATUSES.includes(device.status)) {
      return c.json({ error: `Device is ${device.status}, which is managed by the repair workflow — it cannot be transitioned via this endpoint` }, 409)
    }
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
    // NOTE: c.executionCtx is a THROWING getter in Hono when no
    // ExecutionContext exists (e.g. app.request() in tests) — it cannot be
    // probed with optional chaining alone.
    let execCtx: { waitUntil?: (p: Promise<unknown>) => void } | undefined
    try { execCtx = c.executionCtx as any } catch { execCtx = undefined }
    if (typeof execCtx?.waitUntil === 'function') {
      execCtx.waitUntil(notify)
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

// ───────── Device Lifecycle slice 1 — in-house repair workflow (Workstream C) ─────────
// See docs/plan/device-lifecycle-slice1.md and src/lib/repairWorkflow.ts.
// QC recording (repair/qc) is manager-only per the agreed placeholder —
// NOT hard-coded against a future separate QC role, just checked against
// the current 'manager'/'admin' roles (test #29 asserts operator -> 403,
// manager -> 200).
function requireManager(c: any): boolean {
  const role = (c.var.user as AuthUser).role
  return role === 'manager' || role === 'admin'
}

app.post('/:id/repair/start', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  const body = await c.req.json<{ fault_code?: string }>().catch(() => ({} as any))
  try {
    const result = await startRepair(c.env.DB, id, body.fault_code, user)
    return c.json(result, 201)
  } catch (err) {
    if (err instanceof RepairJobError) return c.json({ error: err.message }, err.status)
    throw err
  }
})

app.post('/:id/repair/scan-back', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  try {
    const result = await scanBackRepair(c.env.DB, id, user)
    return c.json(result, 200)
  } catch (err) {
    if (err instanceof RepairJobError) return c.json({ error: err.message }, err.status)
    throw err
  }
})

app.post('/:id/repair/qc', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  if (!requireManager(c)) return c.json({ error: 'QC recording is manager-only' }, 403)
  const body = await c.req.json<{ result?: string; reason?: string }>().catch(() => ({} as any))
  try {
    const result = await recordQc(c.env.DB, id, body.result, body.reason, user)
    return c.json(result, 200)
  } catch (err) {
    if (err instanceof RepairJobError) return c.json({ error: err.message }, err.status)
    throw err
  }
})

app.post('/:id/repair/reopen', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  try {
    const result = await reopenRepair(c.env.DB, id, user)
    return c.json(result, 200)
  } catch (err) {
    if (err instanceof RepairJobError) return c.json({ error: err.message }, err.status)
    throw err
  }
})

app.post('/:id/repair/cost', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  if (!requireManager(c)) return c.json({ error: 'Repair cost entry is manager-only' }, 403)
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as any))
  try {
    const result = await recordRepairCost(c.env.DB, id, body, user)
    return c.json(result, 200)
  } catch (err) {
    if (err instanceof RepairJobError) return c.json({ error: err.message }, err.status)
    throw err
  }
})

export default app
