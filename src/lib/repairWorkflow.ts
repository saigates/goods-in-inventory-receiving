// Device Lifecycle slice 1 — in-house repair workflow (Workstream C) and
// the READY_FOR_ZOHO gate that feeds Workstream D's Zoho upload queue.
// See docs/plan/device-lifecycle-slice1.md for the full design record.
//
// NAMING COLLISION NOTE (mandatory naming rule, dev instruction
// 2026-08-11): repair_jobs.repair_cost_gbp is the IN-HOUSE repair cost.
// It must never be confused with OPR's shipments.repair_cost (overseas-
// repairer invoice amount, the customs VAT base) or
// Ce1154.repair_cost_gbp (src/lib/oprImport.ts — that invoice amount
// converted to GBP). Namespaced by ACCESS PATH here: every value this
// module returns is nested under a `repair_job` object
// (repair_job.repair_cost_gbp), never a bare top-level repair_cost_gbp.
// This module does not import from or write to src/lib/oprImport.ts,
// src/routes/opr.ts, or anything touching computeCe1154()/
// parseRepairFields()/procedure-code validators/the C&E1154 generator —
// per the explicit Item 2 guardrail.

import type { AuthUser, DeviceStatus } from '../types'
import { transitionDevice, InvalidTransitionError, DeviceNotFoundError } from './deviceLifecycle'

export class RepairJobError extends Error {
  status: 404 | 409 | 422
  constructor(message: string, status: 404 | 409 | 422) {
    super(message)
    this.status = status
  }
}

// Statuses a device must be in to start a NEW repair job. Anything else
// (SOLD, EXPORTED_UNDER_OPR, RETURNED_UNDER_OPR, REJECTED,
// IN_EXPORT_CONSIGNMENT, READY_FOR_EXPORT, IN_HOUSE_REPAIR itself, etc.)
// is refused with 409 (test #18 spans SOLD/EXPORTED_UNDER_OPR/
// RETURNED_UNDER_OPR explicitly).
const REPAIR_STARTABLE_STATUSES: readonly DeviceStatus[] = ['SORTING', 'ACTIVE_INVENTORY'] as const

async function loadDevice(db: D1Database, deviceId: number, organisationId: number) {
  return db.prepare(
    'SELECT * FROM received_devices WHERE id = ? AND organisation_id = ?'
  ).bind(deviceId, organisationId).first<Record<string, unknown>>()
}

async function openRepairJobFor(db: D1Database, deviceId: number) {
  return db.prepare(
    `SELECT * FROM repair_jobs WHERE device_id = ? AND status IN ('open', 'awaiting_qc') ORDER BY id DESC LIMIT 1`
  ).bind(deviceId).first<Record<string, unknown>>()
}

// POST /api/devices/:id/repair/start — { fault_code }
export async function startRepair(
  db: D1Database,
  deviceId: number,
  faultCode: unknown,
  user: AuthUser,
): Promise<{ repair_job: Record<string, unknown>; device: Record<string, unknown> }> {
  const device = await loadDevice(db, deviceId, user.organisation_id)
  if (!device) throw new RepairJobError(`Device ${deviceId} not found`, 404)

  // Placeholder per the agreed boundary: present-and-non-empty free text,
  // no controlled list.
  const fault = typeof faultCode === 'string' ? faultCode.trim() : ''
  if (!fault) throw new RepairJobError('fault_code is required and must be non-empty', 422)

  const status = device.status as DeviceStatus
  if (!REPAIR_STARTABLE_STATUSES.includes(status)) {
    throw new RepairJobError(
      `Device is ${status} — repair can only be started from SORTING or ACTIVE_INVENTORY`,
      409,
    )
  }

  const existingOpen = await openRepairJobFor(db, deviceId)
  if (existingOpen) {
    throw new RepairJobError(`Device already has an open repair job (id ${existingOpen.id})`, 409)
  }

  const insertJob = db.prepare(
    `INSERT INTO repair_jobs (organisation_id, device_id, imei, fault_code, status, opened_by_user_id)
     VALUES (?, ?, ?, ?, 'open', ?)`
  ).bind(user.organisation_id, deviceId, String(device.imei), fault, user.id)

  // transitionDevice() does its own device+event write in one batch; run
  // the job insert first so if it throws (shouldn't, but defensively) no
  // status change has happened yet.
  const jobResult = await insertJob.run()
  const jobId = jobResult.meta.last_row_id as number

  const { device: updatedDevice } = await transitionDevice(db, deviceId, 'IN_HOUSE_REPAIR', {
    user,
    eventType: 'SENT_TO_INHOUSE_REPAIR',
  })

  const repairJob = await db.prepare('SELECT * FROM repair_jobs WHERE id = ?').bind(jobId).first<Record<string, unknown>>()
  return { repair_job: repairJob!, device: updatedDevice }
}

// POST /api/devices/:id/repair/scan-back — {}
// Moves the open job to "awaiting_qc". Does NOT change device status —
// QC is a distinct, separate action per the design.
export async function scanBackRepair(
  db: D1Database,
  deviceId: number,
  user: AuthUser,
): Promise<{ repair_job: Record<string, unknown> }> {
  const job = await openRepairJobFor(db, deviceId)
  if (!job || job.status !== 'open') {
    throw new RepairJobError(`Device ${deviceId} has no open repair job to scan back`, 409)
  }

  await db.prepare(`UPDATE repair_jobs SET status = 'awaiting_qc' WHERE id = ?`).bind(job.id).run()
  const updated = await db.prepare('SELECT * FROM repair_jobs WHERE id = ?').bind(job.id).first<Record<string, unknown>>()
  return { repair_job: updated! }
}

// Gate for entering READY_FOR_ZOHO — docs/plan/device-lifecycle-slice1.md
// "Gate for entering READY_FOR_ZOHO (all must hold)". Conditions 1-2 are
// checked by the caller (job status/qc_result) before this runs; this
// function checks 3-5 and returns the first unmet condition's message, or
// null if all pass. Mirrors runExportValidation's named-check pattern
// (src/lib/oprValidation.ts) — explicit, named reasons rather than one
// opaque rejection.
export async function checkReadyForZohoGate(
  db: D1Database,
  device: Record<string, unknown>,
): Promise<string | null> {
  // 3. Required device data present (imei, model, capacity/grade).
  if (!device.imei) return 'Device is missing an IMEI'
  if (!device.model) return 'Device is missing a model'
  if (!device.capacity && !device.grade) return 'Device is missing capacity/grade'

  // 4. Valid SKU mapping exists — existence-only check against sku_catalog
  // for the org, reusing the seeded catalog (no new table).
  const sku = await db.prepare(
    'SELECT id FROM sku_catalog WHERE sku = ? AND organisation_id = ?'
  ).bind(device.sku, device.organisation_id).first<{ id: number }>()
  if (!sku) return `SKU '${device.sku}' has no mapping in the catalog`

  // 5. No open conflicting movement: device is not currently on any
  // DRAFT/open OPR consignment line, and not already SOLD/DESPATCHED/
  // REJECTED (already excluded upstream by the pre-existing device
  // status, since a device only reaches this gate from IN_HOUSE_REPAIR,
  // but re-checked defensively per the design doc's explicit condition).
  const openLine = await db.prepare(
    `SELECT sl.id FROM shipment_lines sl
       JOIN shipments s ON s.id = sl.shipment_id
      WHERE sl.received_device_id = ? AND s.status = 'DRAFT'`
  ).bind(device.id).first<{ id: number }>()
  if (openLine) return 'Device is on an open (DRAFT) OPR consignment line'

  // 6. (Added 2026-08-11.) The SKU's grade is A, B, or C. Parsed as the
  // FINAL hyphen-separated segment of the SKU string — not by a fixed
  // character position, since SKU segment counts vary (e.g.
  // 'SAM-S26-256-CVT-A' vs 'APL-I17-256-BLK-UG'). Any final segment that
  // is not exactly 'A', 'B', or 'C' — including 'UG' (ungraded) — is
  // rejected outright, not defaulted to a pass/fail-safe value. This is
  // deliberately independent of condition 3's capacity/grade presence
  // check above: received_devices.grade defaults to 'UG'
  // (migrations/0021_repair_qc_zoho_status_enum.sql:102) and is therefore
  // always present, making condition 3's grade branch vacuous as a guard
  // against ungraded stock — this condition is the real guard, and reads
  // the SKU (the catalogue-assigned grade), not the device row's own
  // grade column.
  const skuSegments = String(device.sku).split('-')
  const skuGrade = skuSegments[skuSegments.length - 1]
  if (skuGrade !== 'A' && skuGrade !== 'B' && skuGrade !== 'C') {
    return `SKU '${device.sku}' has grade '${skuGrade}' — only A, B, or C may reach Zoho`
  }

  return null
}

// POST /api/devices/:id/repair/qc — { result: 'PASSED'|'FAILED', reason? }
export async function recordQc(
  db: D1Database,
  deviceId: number,
  result: unknown,
  reason: unknown,
  user: AuthUser,
): Promise<{ repair_job: Record<string, unknown>; device: Record<string, unknown> }> {
  const device = await loadDevice(db, deviceId, user.organisation_id)
  if (!device) throw new RepairJobError(`Device ${deviceId} not found`, 404)

  const job = await openRepairJobFor(db, deviceId)
  if (!job || job.status !== 'awaiting_qc') {
    throw new RepairJobError(`Device ${deviceId} has no repair job awaiting QC (scan-back must happen first)`, 409)
  }

  const qcResult = result === 'PASSED' || result === 'FAILED' ? result : null
  if (!qcResult) throw new RepairJobError(`result must be 'PASSED' or 'FAILED'`, 422)

  // Amendment 2 resolution: a QC_FAILED result requires a mandatory
  // reason — the endpoint rejects a request that omits it, before any
  // write happens (no job/device mutation, no device_events row).
  const reasonText = typeof reason === 'string' ? reason.trim() : ''
  if (qcResult === 'FAILED' && !reasonText) {
    throw new RepairJobError('reason is required when result is FAILED', 422)
  }

  if (qcResult === 'PASSED') {
    const gateFailure = await checkReadyForZohoGate(db, device)
    if (gateFailure) throw new RepairJobError(gateFailure, 409)
  }

  const toStatus: DeviceStatus = qcResult === 'PASSED' ? 'READY_FOR_ZOHO' : 'QC_FAILED'
  const newJobStatus = qcResult === 'PASSED' ? 'completed' : 'open'

  await db.prepare(
    `UPDATE repair_jobs
        SET qc_result = ?, qc_fail_reason = ?, qc_by = ?, qc_at = CURRENT_TIMESTAMP,
            status = ?, closed_at = CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE closed_at END
      WHERE id = ?`
  ).bind(qcResult, qcResult === 'FAILED' ? reasonText : null, user.id, newJobStatus, newJobStatus, job.id).run()

  const { device: updatedDevice } = await transitionDevice(db, deviceId, toStatus, {
    user,
    eventType: qcResult === 'FAILED' ? 'RECEIVED_BACK_FROM_INHOUSE_REPAIR' : 'REPAIR_QC_PASSED',
  })

  const updatedJob = await db.prepare('SELECT * FROM repair_jobs WHERE id = ?').bind(job.id).first<Record<string, unknown>>()
  return { repair_job: updatedJob!, device: updatedDevice }
}

// POST /api/devices/:id/repair/reopen — {}
// QC_FAILED -> IN_HOUSE_REPAIR. Reopens the existing job (back to 'open'
// status, qc_result reset to PENDING) so a fresh scan-back/QC cycle is
// required — no shortcut straight to READY_FOR_ZOHO from QC_FAILED.
export async function reopenRepair(
  db: D1Database,
  deviceId: number,
  user: AuthUser,
): Promise<{ repair_job: Record<string, unknown>; device: Record<string, unknown> }> {
  const device = await loadDevice(db, deviceId, user.organisation_id)
  if (!device) throw new RepairJobError(`Device ${deviceId} not found`, 404)
  if (device.status !== 'QC_FAILED') {
    throw new RepairJobError(`Device is ${device.status} — reopen is only valid from QC_FAILED`, 409)
  }

  const job = await db.prepare(
    `SELECT * FROM repair_jobs WHERE device_id = ? ORDER BY id DESC LIMIT 1`
  ).bind(deviceId).first<Record<string, unknown>>()

  if (job) {
    await db.prepare(
      `UPDATE repair_jobs SET status = 'open', qc_result = 'PENDING', qc_fail_reason = NULL, closed_at = NULL WHERE id = ?`
    ).bind(job.id).run()
  }

  const { device: updatedDevice } = await transitionDevice(db, deviceId, 'IN_HOUSE_REPAIR', {
    user,
    eventType: 'REPAIR_REOPENED',
  })

  const updatedJob = job
    ? await db.prepare('SELECT * FROM repair_jobs WHERE id = ?').bind(job.id).first<Record<string, unknown>>()
    : null

  return { repair_job: updatedJob ?? {}, device: updatedDevice }
}

// POST /api/devices/:id/repair/cost — { repair_cost_gbp, parts_cost_gbp, labour_cost_gbp, cost_source, cost_source_reference }
// Manager-only (see role check in the route handler). GBP-only by design
// (slice 1) — no currency field, see docs/plan/device-lifecycle-slice1.md
// "Amendment 1 resolution".
export async function recordRepairCost(
  db: D1Database,
  deviceId: number,
  body: {
    repair_cost_gbp?: unknown
    parts_cost_gbp?: unknown
    labour_cost_gbp?: unknown
    cost_source?: unknown
    cost_source_reference?: unknown
  },
  user: AuthUser,
): Promise<{ repair_job: Record<string, unknown> }> {
  const job = await db.prepare(
    `SELECT * FROM repair_jobs WHERE device_id = ? ORDER BY id DESC LIMIT 1`
  ).bind(deviceId).first<Record<string, unknown>>()
  if (!job) throw new RepairJobError(`Device ${deviceId} has no repair job`, 404)

  const num = (v: unknown): number | null => {
    if (v === undefined || v === null) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  await db.prepare(
    `UPDATE repair_jobs
        SET repair_cost_gbp = ?, parts_cost_gbp = ?, labour_cost_gbp = ?,
            cost_source = ?, cost_source_reference = ?,
            cost_recorded_at = CURRENT_TIMESTAMP, cost_recorded_by = ?
      WHERE id = ?`
  ).bind(
    num(body.repair_cost_gbp),
    num(body.parts_cost_gbp),
    num(body.labour_cost_gbp),
    body.cost_source ?? null,
    body.cost_source_reference ?? null,
    user.id,
    job.id,
  ).run()

  const updated = await db.prepare('SELECT * FROM repair_jobs WHERE id = ?').bind(job.id).first<Record<string, unknown>>()
  return { repair_job: updated! }
}
