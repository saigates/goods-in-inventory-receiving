// Device status state-machine + event log (Priority 2 & 3).
//
// Every status change on `received_devices` MUST go through
// `transitionDevice()` so that:
//   1. the transition is validated against ALLOWED_TRANSITIONS
//   2. the device row and the append-only device_events row are written
//      atomically (D1 batch)
//   3. the device's `status` always equals the `to_status` of its most
//      recent event (Priority 3 acceptance criterion)
//
// Do not write to received_devices.status anywhere else in the codebase.

import type { Bindings, DeviceStatus, AuthUser } from '../types'
import { DEVICE_STATUSES } from '../types'

export { DEVICE_STATUSES }

// Allowed transitions per the brief. Export/return transitions
// (READY_FOR_EXPORT → IN_EXPORT_CONSIGNMENT → EXPORTED_UNDER_OPR →
// RETURNED_UNDER_OPR, and → SOLD) are intentionally NOT enabled yet — they
// are defined in DEVICE_STATUSES so the column/enum is future-proof, but
// their workflows are out of scope for this pass.
export const ALLOWED_TRANSITIONS: Record<DeviceStatus, DeviceStatus[]> = {
  RECEIVED: ['SORTING', 'REJECTED'],
  SORTING: ['ACTIVE_INVENTORY', 'IN_HOUSE_REPAIR', 'READY_FOR_EXPORT'],
  ACTIVE_INVENTORY: [],
  IN_HOUSE_REPAIR: ['ACTIVE_INVENTORY'],
  READY_FOR_EXPORT: [],
  IN_EXPORT_CONSIGNMENT: [],
  EXPORTED_UNDER_OPR: [],
  RETURNED_UNDER_OPR: [],
  SOLD: [],
  REJECTED: [],
}

export class InvalidTransitionError extends Error {
  code = 'invalid_transition' as const
  constructor(from: DeviceStatus, to: DeviceStatus) {
    super(`Cannot transition device from ${from} to ${to}. Allowed from ${from}: ${ALLOWED_TRANSITIONS[from]?.join(', ') || '(none)'}`)
  }
}

export class DeviceNotFoundError extends Error {
  code = 'device_not_found' as const
  constructor(id: number) {
    super(`Device ${id} not found`)
  }
}

export type TransitionContext = {
  user: AuthUser
  reference?: string | null
  metadata?: Record<string, unknown> | null
  // event_type defaults to the plain status name (e.g. 'STATUS_CHANGE');
  // callers can supply a more specific one, e.g. 'RECEIVE', 'REJECT'.
  eventType?: string
}

export type TransitionResult = {
  device: Record<string, unknown>
  event: Record<string, unknown>
}

// The single choke point for every status change. Validates the transition,
// then writes the device UPDATE and the device_events INSERT in one D1
// batch so they can never diverge (no partial writes).
export async function transitionDevice(
  db: D1Database,
  deviceId: number,
  toStatus: DeviceStatus,
  ctx: TransitionContext,
): Promise<TransitionResult> {
  if (!DEVICE_STATUSES.includes(toStatus)) {
    throw new Error(`Unknown target status: ${toStatus}`)
  }

  const device = await db.prepare(
    'SELECT * FROM received_devices WHERE id = ? AND organisation_id = ?'
  ).bind(deviceId, ctx.user.organisation_id).first<Record<string, unknown>>()
  if (!device) throw new DeviceNotFoundError(deviceId)

  const fromStatus = device.status as DeviceStatus
  const allowed = ALLOWED_TRANSITIONS[fromStatus] || []
  if (!allowed.includes(toStatus)) {
    throw new InvalidTransitionError(fromStatus, toStatus)
  }

  const eventType = ctx.eventType || 'STATUS_CHANGE'
  const metadataJson = ctx.metadata ? JSON.stringify(ctx.metadata) : null

  const updateStmt = db.prepare(
    `UPDATE received_devices SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organisation_id = ?`
  ).bind(toStatus, deviceId, ctx.user.organisation_id)

  const eventStmt = db.prepare(
    `INSERT INTO device_events
       (organisation_id, device_id, event_type, from_status, to_status, user_id, reference, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    ctx.user.organisation_id,
    deviceId,
    eventType,
    fromStatus,
    toStatus,
    ctx.user.id,
    ctx.reference ?? null,
    metadataJson,
  )

  await db.batch([updateStmt, eventStmt])

  const updatedDevice = await db.prepare('SELECT * FROM received_devices WHERE id = ?')
    .bind(deviceId).first<Record<string, unknown>>()
  const event = await db.prepare('SELECT * FROM device_events WHERE device_id = ? ORDER BY id DESC LIMIT 1')
    .bind(deviceId).first<Record<string, unknown>>()

  return { device: updatedDevice!, event: event! }
}

// Writes a device_events row WITHOUT a status change — used for events like
// 'SCAN' (matched/duplicate/unreconciled lookups that don't mutate a device
// yet) where from_status/to_status don't apply.
export async function logDeviceEvent(
  db: D1Database,
  opts: {
    organisationId: number
    deviceId: number | null
    eventType: string
    fromStatus?: DeviceStatus | null
    toStatus?: DeviceStatus | null
    userId: number | null
    reference?: string | null
    metadata?: Record<string, unknown> | null
  },
): Promise<void> {
  await db.prepare(
    `INSERT INTO device_events
       (organisation_id, device_id, event_type, from_status, to_status, user_id, reference, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    opts.organisationId,
    opts.deviceId,
    opts.eventType,
    opts.fromStatus ?? null,
    opts.toStatus ?? null,
    opts.userId,
    opts.reference ?? null,
    opts.metadata ? JSON.stringify(opts.metadata) : null,
  ).run()
}
