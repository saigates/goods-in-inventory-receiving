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

// Allowed transitions per the brief. The OPR 2 export flow wires:
//   READY_FOR_EXPORT → IN_EXPORT_CONSIGNMENT   (device scanned onto a draft consignment)
//   IN_EXPORT_CONSIGNMENT → READY_FOR_EXPORT   (line removed while still DRAFT)
//   IN_EXPORT_CONSIGNMENT → EXPORTED_UNDER_OPR (consignment finalised)
// The OPR 3 import/discharge flow wires:
//   EXPORTED_UNDER_OPR → RETURNED_UNDER_OPR    (import consignment received)
//   RETURNED_UNDER_OPR → ACTIVE_INVENTORY      (returned goods back into stock)
// All of these are OPR-WORKFLOW-ONLY: the generic /api/devices/:id/transition
// endpoint refuses them (see OPR_WORKFLOW_ONLY_STATUSES below) because they
// must stay in lockstep with shipment_lines — only src/routes/opr.ts may
// drive them. Sale transitions (→ SOLD) remain NOT enabled: selling is a
// downstream sales flow, not part of the OPR tracks.
// Device Lifecycle slice 1 (docs/plan/device-lifecycle-slice1.md,
// "Amendment 2 resolution — New transition edges"): the old direct
// IN_HOUSE_REPAIR -> ACTIVE_INVENTORY edge is REMOVED for devices going
// through the new repair-job flow. Devices now leave IN_HOUSE_REPAIR only
// via a recorded QC result (-> READY_FOR_ZOHO on PASSED, -> QC_FAILED on
// FAILED), and QC_FAILED can only re-enter IN_HOUSE_REPAIR (re-open) for a
// fresh scan-back/QC cycle. All three new edges are driven exclusively by
// the repair-workflow routes (src/routes/devices.ts repair/* handlers via
// src/lib/repairWorkflow.ts), never by the generic /transition endpoint —
// see REPAIR_WORKFLOW_ONLY_STATUSES below.
export const ALLOWED_TRANSITIONS: Record<DeviceStatus, DeviceStatus[]> = {
  RECEIVED: ['SORTING', 'REJECTED'],
  SORTING: ['ACTIVE_INVENTORY', 'IN_HOUSE_REPAIR', 'READY_FOR_EXPORT'],
  ACTIVE_INVENTORY: [],
  IN_HOUSE_REPAIR: ['READY_FOR_ZOHO', 'QC_FAILED'],
  READY_FOR_EXPORT: ['IN_EXPORT_CONSIGNMENT'],
  // IN_EXPORT_CONSIGNMENT is a SHARED precursor for both the OPR export
  // flow and the TEMP_EXPORTED_STANDARD flow — only the finalise-time
  // target diverges, keyed off shipment.shipment_type (see
  // addDeviceToShipment/addDeviceToReturnShipment in src/routes/opr.ts).
  IN_EXPORT_CONSIGNMENT: ['READY_FOR_EXPORT', 'EXPORTED_UNDER_OPR', 'TEMP_EXPORTED_STANDARD'],
  EXPORTED_UNDER_OPR: ['RETURNED_UNDER_OPR'],
  RETURNED_UNDER_OPR: ['ACTIVE_INVENTORY'],
  SOLD: [],
  // REJECTED -> RECEIVED (added 2026-09-01, live-incident fix: devices 588
  // and 619 were mistakenly rejected by an operator and had NO route back
  // into the flow — REJECTED previously had zero outbound edges, an
  // unintentional dead end reached only because the generic /transition
  // endpoint happens to allow RECEIVED -> REJECTED by omission (REJECTED
  // is not in either *_WORKFLOW_ONLY_STATUSES list) with no corresponding
  // way back. Deliberate design, per instruction: REJECTED rejoins the
  // flow at RECEIVED ONLY — never skips ahead to anywhere RECEIVED itself
  // cannot reach — and scrap/write-off is explicitly out of scope, so this
  // is the device's only two-state holding pattern (rejected, or back into
  // the normal flow from the start). Both edges (RECEIVED->REJECTED and
  // REJECTED->RECEIVED) require a mandatory REASON_CODE (see below),
  // enforced in the route layer (src/routes/devices.ts), not here.
  REJECTED: ['RECEIVED'],
  QC_FAILED: ['IN_HOUSE_REPAIR'],
  // READY_FOR_ZOHO -> ACTIVE_INVENTORY (added 2026-09-02, commit 2 of the
  // repair-workflow pass): a human confirms a device is done with Zoho
  // (uploaded by hand — the batch-upload flow is parked, see
  // test/repairWorkflow.spec.ts Group D) and it returns to stock. This
  // edge exists ONLY so transitionDevice()'s own validation accepts the
  // call when driven by the dedicated route (repair/close-to-inventory,
  // src/routes/devices.ts) — READY_FOR_ZOHO is a REPAIR_WORKFLOW_ONLY_STATUS
  // (see below), so the GENERIC /api/devices/:id/transition endpoint
  // still refuses this edge outright regardless of it being listed here.
  // Do not read this edge's presence as meaning the generic route can
  // drive it — see close-to-inventory's own comments for the full
  // edge-versus-route distinction.
  READY_FOR_ZOHO: ['ACTIVE_INVENTORY'],
  // ── TEMP_EXPORTED_STANDARD consignment flow (migration 0023) ──
  // Mirrors EXPORTED_UNDER_OPR/RETURNED_UNDER_OPR exactly.
  TEMP_EXPORTED_STANDARD: ['RETURNED_UNDER_STANDARD'],
  RETURNED_UNDER_STANDARD: ['ACTIVE_INVENTORY'],
}

// Reason codes for the two reject/un-reject edges (2026-09-01). Stored as
// device_events.metadata.reason_code (JSON — the column needs no schema
// migration, confirmed directly from live production rows before this
// edge existed: device 588/619's own RECEIVE events already carry a JSON
// object in this column). Enforcement (mandatory-on-these-two-edges-only,
// reject-unrecognised-codes) lives in the /:id/transition route, since
// transitionDevice() itself is edge-agnostic about metadata contents.
export const REJECT_REASON_CODES = [
  'not_as_described',
  'wrong_model_or_storage',
  'imei_mismatch',
  'cosmetic_grade_below_stated',
  'faulty_on_test',
  'blacklisted_or_locked',
  'missing_items',
  'damaged_in_transit',
] as const

export const UNREJECT_REASON_CODES = [
  'rejected_in_error',
  'retested_and_passed',
  'regraded_and_accepted',
  'vendor_issue_resolved',
] as const

export type RejectReasonCode = typeof REJECT_REASON_CODES[number]
export type UnrejectReasonCode = typeof UNREJECT_REASON_CODES[number]

// Statuses whose membership is DERIVED from consignment state (a device is
// IN_EXPORT_CONSIGNMENT iff it has a line on a DRAFT export shipment;
// EXPORTED_UNDER_OPR iff that shipment finalised; RETURNED_UNDER_OPR iff a
// related import consignment was received). Letting the generic transition
// endpoint set or leave these statuses would desynchronise the device
// ledger from shipment_lines, so it refuses both directions.
export const OPR_WORKFLOW_ONLY_STATUSES: readonly DeviceStatus[] = [
  'IN_EXPORT_CONSIGNMENT',
  'EXPORTED_UNDER_OPR',
  'RETURNED_UNDER_OPR',
  // TEMP_EXPORTED_STANDARD/RETURNED_UNDER_STANDARD are consignment-driven
  // identically to the 3 OPR statuses above — same desync risk, same guard.
  'TEMP_EXPORTED_STANDARD',
  'RETURNED_UNDER_STANDARD',
] as const

// Device Lifecycle slice 1 — same pattern as OPR_WORKFLOW_ONLY_STATUSES
// above, for the repair-job flow (docs/plan/device-lifecycle-slice1.md,
// "Interaction with the existing generic /api/devices/:id/transition
// endpoint"). IN_HOUSE_REPAIR/QC_FAILED/READY_FOR_ZOHO may only be set (or
// left) via the repair-workflow routes (repair/start, repair/qc,
// repair/reopen) so a raw POST /transition call cannot desynchronise a
// device from its repair_jobs row.
export const REPAIR_WORKFLOW_ONLY_STATUSES: readonly DeviceStatus[] = [
  'IN_HOUSE_REPAIR',
  'QC_FAILED',
  'READY_FOR_ZOHO',
] as const

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

// Thrown by transitionDevice()'s own defence-in-depth check below (see
// checkRejectUnrejectGate) when a caller reaches the reject/un-reject
// edge without having passed the gate. Route callers are expected to run
// the SAME check themselves first (via checkRejectUnrejectGate) so this
// throws only as a backstop for a route that forgot to, or a future
// caller that doesn't exist yet — never as the primary/expected path.
export class TransitionGateError extends Error {
  code = 'transition_gate_denied' as const
  status: 403 | 422
  validReasonCodes?: readonly string[]
  constructor(status: 403 | 422, message: string, validReasonCodes?: readonly string[]) {
    super(message)
    this.status = status
    this.validReasonCodes = validReasonCodes
  }
}

export type RejectUnrejectGateResult =
  | { applicable: false }
  | { applicable: true; ok: true; edgeKind: 'reject' | 'unreject'; reasonCode: string }
  | { applicable: true; ok: false; status: 403; error: string }
  | { applicable: true; ok: false; status: 422; error: string; valid_reason_codes: readonly string[] }

// Shared gate for the two manager-gated, reason-code-mandatory edges
// (RECEIVED -> REJECTED, REJECTED -> RECEIVED). Originally lived ONLY in
// devices.ts's /:id/transition handler (2026-09-01 live-incident fix) —
// extracted here (2026-09-07) so the SAME check runs in both places it
// must, rather than a second hand-copied implementation drifting from the
// first:
//   1. the route layer (single-device AND bulk-transition), for a clean,
//      fast 403/422 before any DB write is attempted;
//   2. transitionDevice() itself below, as a defence-in-depth backstop —
//      so no future caller can reach either edge by skipping the
//      route-level check, the same way POST /api/devices/bulk-transition
//      did until this fix (it called transitionDevice() directly and
//      never ran the single-device route's gate at all: an operator
//      token could bulk-reject or bulk-un-reject with a plain HTTP 200,
//      no reason_code, metadata = {"bulk":true} only — see #38-#42's
//      sibling tests just below for the closed hole).
export function checkRejectUnrejectGate(
  fromStatus: DeviceStatus,
  toStatus: DeviceStatus,
  user: AuthUser,
  reasonCodeInput: unknown,
): RejectUnrejectGateResult {
  const isRejectEdge = fromStatus === 'RECEIVED' && toStatus === 'REJECTED'
  const isUnrejectEdge = fromStatus === 'REJECTED' && toStatus === 'RECEIVED'
  if (!isRejectEdge && !isUnrejectEdge) return { applicable: false }

  const isManager = user.role === 'manager' || user.role === 'admin'
  if (!isManager) {
    return {
      applicable: true, ok: false, status: 403,
      error: `${isRejectEdge ? 'Rejecting' : 'Un-rejecting'} a device is manager-only`,
    }
  }
  const reasonCode = typeof reasonCodeInput === 'string' ? reasonCodeInput.trim() : ''
  const validCodes: readonly string[] = isRejectEdge ? REJECT_REASON_CODES : UNREJECT_REASON_CODES
  if (!reasonCode) {
    return { applicable: true, ok: false, status: 422, error: 'reason_code is required for this transition', valid_reason_codes: validCodes }
  }
  if (!validCodes.includes(reasonCode)) {
    return { applicable: true, ok: false, status: 422, error: `reason_code must be one of: ${validCodes.join(', ')}`, valid_reason_codes: validCodes }
  }
  return { applicable: true, ok: true, edgeKind: isRejectEdge ? 'reject' : 'unreject', reasonCode }
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

  // Defence-in-depth (2026-09-07): re-run the reject/un-reject gate HERE,
  // not just at the route layer, so no caller — present or future — can
  // reach either edge ungated by calling this function directly. This is
  // the concrete case that motivated it: POST /bulk-transition called
  // transitionDevice() directly and never ran the single-device route's
  // gate at all, so an operator token could bulk-reject or bulk-un-reject
  // a device with a plain HTTP 200, no reason_code, no 403 — see
  // checkRejectUnrejectGate's own comment. A well-behaved route caller is
  // expected to have already run checkRejectUnrejectGate() itself for a
  // fast, pre-write 403/422 (and to have folded the returned reasonCode
  // into ctx.metadata.reason_code, exactly as this check reads it back
  // out below) — this re-check is expected to confirm `ok: true` again in
  // that case, not to be the first time the gate runs on the happy path.
  const gate = checkRejectUnrejectGate(fromStatus, toStatus, ctx.user, ctx.metadata?.reason_code)
  if (gate.applicable && !gate.ok) {
    throw new TransitionGateError(
      gate.status,
      gate.error,
      gate.status === 422 ? gate.valid_reason_codes : undefined,
    )
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
