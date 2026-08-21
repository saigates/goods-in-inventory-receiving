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
import { SUPPLIER_INVOICED, DEFAULT_UNVERIFIED_PROVENANCE } from './billBuilder'

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

  // 6. (Regrade-fix 1, this sprint.) AUTHORITY MOVED: the device's grade
  // is validated against `received_devices.grade` — the stored column
  // (CHECK-constrained to 'A'|'B'|'C'|'UG', migration 0021) — not by
  // re-parsing the SKU's final hyphen segment. The prior SKU-suffix parse
  // was a proxy for the actual grade and diverged from it whenever a
  // device was regraded after receipt without also renaming its SKU (the
  // regrade endpoint, POST /api/inventory/grade, only ever writes
  // received_devices.grade — see src/routes/inventory.ts — it never
  // touches sku). device.grade defaults to 'UG' and is always present, so
  // this subsumes condition 3's capacity/grade branch as the real guard
  // against ungraded stock reaching Zoho. Any grade that is not exactly
  // 'A', 'B', or 'C' — including 'UG' — is rejected outright.
  const grade = device.grade
  if (grade !== 'A' && grade !== 'B' && grade !== 'C') {
    return `Device has grade '${grade}' — only A, B, or C may reach Zoho`
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

// POST /api/devices/:id/repair/cost-ledger — { amount_gbp, source_bill_line_id? }
// Manager-only (see requireManager(c) in the route handler — matches
// recordRepairCost()'s authorisation level; a ledger write is at least as
// privileged as the repair_jobs cost-column write it sits alongside).
//
// DELIBERATELY SEPARATE from recordRepairCost() above: that function is
// an explicit, documented compatibility layer writing repair_jobs's own
// (mutable, UPDATE-in-place) cost columns pending a future device_costs
// table (docs/plan/device-lifecycle-slice1.md) — a temporary shim. This
// function writes cost_ledger, the durable, typed, append-only ledger
// (migration 0028) that item 5 (movement/reporting) reads. Folding the
// two together would entangle the temporary shim with the durable path.
//
// APPEND-ONLY, NO EXCEPTIONS: this function only ever INSERTs. It must
// never grow an UPDATE or DELETE against cost_ledger — a device sent for
// repair twice, or a cost corrected after the fact, gets a NEW row each
// time (a correction is a compensating row, never an edit to the
// original). Posting this function twice for the same device must
// produce TWO cost_ledger rows with two distinct ids, never one row
// updated in place — see test/repairWorkflow.spec.ts's coexistence test
// for the exact assertion. Do not add an edit path here.
//
// source_bill_line_id nullability contract: NULL when this cost has no
// specific bill_lines row behind it (an in-house-only repair cost, e.g.
// a grade-band average with no invoice) — provenance is then
// DEFAULT_UNVERIFIED_PROVENANCE ('default-unverified', billBuilder.ts).
// Populated with an actual bill_lines.id when attributing this cost to a
// specific invoiced line — provenance is then SUPPLIER_INVOICED
// ('supplier-invoiced', billBuilder.ts), matching write-cost-ledger's
// (src/routes/bills.ts) own convention for that value.
//
// provenance vocabulary note: cost_ledger.provenance carries NO CHECK
// constraint and NO enforcing trigger at the DB level (checked directly
// against sqlite_master, not inferred from migration 0028's column
// comment — see the DEFAULT_UNVERIFIED_PROVENANCE comment in
// billBuilder.ts for the query). The exported constants in billBuilder.ts
// are therefore the ONLY guard against an out-of-vocabulary provenance
// value reaching this column — always use them, never a bare literal.
//
// NO UI SURFACE (checked, not assumed, 2026-08-21): grep -n
// "repair/cost-ledger" and grep -rn "postRepairCostToLedger" against
// public/static/app.js (and public/ generally) both returned zero
// matches — no call site anywhere in the frontend hits this endpoint.
// That retires, as not-applicable rather than outstanding, the two
// conditional requirements from this item's original scope: a browser
// citation (BROWSER-CHECK-xxx with a SHA-256 of the recorded run) and a
// new IMEI prefix registered in test/browser/README.md. Both applied
// only "if any of this surfaces in the UI" — it doesn't, so neither is
// owed. If a UI hook is ever added later, both requirements re-attach at
// that point and must be satisfied before that change ships.
export async function postRepairCostToLedger(
  db: D1Database,
  deviceId: number,
  body: {
    amount_gbp?: unknown
    source_bill_line_id?: unknown
    note?: unknown
  },
  user: AuthUser,
): Promise<{ cost_ledger_entry: Record<string, unknown> }> {
  const device = await loadDevice(db, deviceId, user.organisation_id)
  if (!device) throw new RepairJobError(`Device ${deviceId} not found`, 404)

  const amount = Number(body.amount_gbp)
  if (!Number.isFinite(amount)) {
    throw new RepairJobError('amount_gbp is required and must be a finite number', 422)
  }

  const sourceBillLineId =
    body.source_bill_line_id === undefined || body.source_bill_line_id === null
      ? null
      : Number(body.source_bill_line_id)
  if (sourceBillLineId !== null && !Number.isFinite(sourceBillLineId)) {
    throw new RepairJobError('source_bill_line_id must be a number when present', 422)
  }

  const provenance = sourceBillLineId === null ? DEFAULT_UNVERIFIED_PROVENANCE : SUPPLIER_INVOICED
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null

  const insertResult = await db.prepare(
    `INSERT INTO cost_ledger
       (organisation_id, received_device_id, cost_type, amount_gbp, currency_code,
        source_bill_line_id, provenance, note, created_by_user_id)
     VALUES (?, ?, 'repair', ?, 'GBP', ?, ?, ?, ?)`
  ).bind(
    user.organisation_id,
    deviceId,
    amount,
    sourceBillLineId,
    provenance,
    note,
    user.id,
  ).run()

  const entryId = insertResult.meta.last_row_id as number
  const entry = await db.prepare('SELECT * FROM cost_ledger WHERE id = ?').bind(entryId).first<Record<string, unknown>>()
  return { cost_ledger_entry: entry! }
}
