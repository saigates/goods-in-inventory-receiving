// Shared device-level grade/SKU correction logic — the actual DB writes
// (UPDATE received_devices, INSERT grade_audit, device_events GRADE_CHANGE/
// SKU_CORRECTION, removal_flags, print_jobs invalidate/requeue) that
// POST /api/inventory/grade performs per device. Extracted (2026-09-26,
// Z-9 Amendment 5) so Z-9's restock write-through (src/routes/opr.ts,
// POST /shipments/:id/restock) can trigger the SAME code path a return
// correction resolves to, rather than re-implementing an equivalent-but-
// separate copy — "grade_audit and the SKU-correction event fire
// NATURALLY, not via new bespoke logic" (operator amendment 5, verbatim).
//
// Three-step shape (decide / build statements / log events), deliberately
// NOT a single "resolve+write+log per device" call, because /inventory/grade
// batches ALL devices' writes into ONE c.env.DB.batch() call (Z-1,
// 2026-09-24 fix — real bulk-regrade batches run 155/162/181/217/341
// devices, and one D1 network round-trip per device was the exact
// performance bug that fix closed). Collapsing this back into a
// per-device db.batch() call to gain reuse would silently reintroduce
// that regression. So:
//   1. planGradeCorrection()      — pure, no DB access, one device at a time
//   2. buildGradeCorrectionStmts() — DB READS only (print_jobs lookup),
//      returns statements to push into the CALLER's own stmts array —
//      the caller still controls batching granularity (all-at-once for
//      /grade's bulk path; per-shipment for Z-9's restock path, which is
//      tens of devices, not hundreds, so a per-shipment batch is fine).
//   3. logGradeCorrectionEvent()  — device_events write, called AFTER the
//      caller's batch has committed (same "write events after commit"
//      ordering /grade's original inline logic already used).
//
// test/inventoryGradeSkuResolution.spec.ts's existing assertions
// (byte-for-byte skip messages, grade_audit rows, device_events metadata
// shape, print_jobs invalidate/requeue) are the regression gate for
// /inventory/grade's refactor to call these — they must pass unchanged.

import type { Grade } from './grade'
import type { CatalogLookup } from './catalog'
import { parseSkuGradeSuffix } from './catalog'
import { logDeviceEvent } from './deviceLifecycle'

export type GradeCorrectionDeviceRow = {
  id: number
  uuid: string
  imei: string
  sku: string
  grade: string
  status: string
  brand: string | null
  model: string | null
  capacity: string | null
  color: string | null
}

export type GradeCorrectionPlan =
  | { action: 'change'; newSku: string }
  | { action: 'sku_self_heal'; newSku: string }
  | { action: 'skip'; reason: string }

// Decide what should happen for ONE device given the catalogue lookup
// already resolved for (device.model, device.capacity, device.color,
// targetGrade) — the caller resolves that lookup (bulk or single) and
// passes it in; this function contains no DB access at all. Same rules,
// same skip-reason wording, as /inventory/grade's original inline logic.
export function planGradeCorrection(
  device: GradeCorrectionDeviceRow,
  targetGrade: Grade,
  lookupForTargetGrade: CatalogLookup,
): GradeCorrectionPlan {
  const combo = `${device.model ?? '?'} · ${device.capacity ?? '?'} · ${device.color ?? '?'} · grade ${targetGrade}`

  if (device.grade !== targetGrade) {
    if (lookupForTargetGrade.status !== 'match') {
      const detail = lookupForTargetGrade.status === 'ambiguous'
        ? `${lookupForTargetGrade.candidates.length} catalogue SKUs match ${combo} — cannot pick one automatically`
        : `No catalogue SKU exists for ${combo}`
      return { action: 'skip', reason: `regrade refused: ${detail}. SKU left unchanged at ${device.sku}.` }
    }
    return { action: 'change', newSku: lookupForTargetGrade.row.sku }
  }

  // Grade is unchanged — only a SKU-only self-heal candidate if the
  // stored SKU's grade suffix disagrees with the (already correct) grade
  // column (id-43 shape: a regrade that happened before this fix existed).
  const suffix = parseSkuGradeSuffix(device.sku)
  if (suffix === null || suffix === device.grade) {
    return { action: 'skip', reason: 'unchanged' }
  }
  if (lookupForTargetGrade.status !== 'match') {
    const detail = lookupForTargetGrade.status === 'ambiguous'
      ? `${lookupForTargetGrade.candidates.length} catalogue SKUs match ${combo} — cannot pick one automatically`
      : `No catalogue SKU exists for ${combo}`
    return { action: 'skip', reason: `sku/grade mismatch detected (sku suggests ${suffix}, grade is ${device.grade}) but could not self-heal: ${detail}. SKU left unchanged at ${device.sku}.` }
  }
  if (lookupForTargetGrade.row.sku === device.sku) {
    return { action: 'skip', reason: 'unchanged' }
  }
  return { action: 'sku_self_heal', newSku: lookupForTargetGrade.row.sku }
}

export type IdentityFieldOverrides = Partial<
  Pick<GradeCorrectionDeviceRow, 'imei' | 'brand' | 'model' | 'capacity' | 'color'>
>

export type GradeCorrectionEffect =
  | {
      kind: 'changed'; device: GradeCorrectionDeviceRow; targetGrade: Grade
      oldSku: string; newSku: string; flaggedForRemoval: boolean
      printInvalidatedIds: number[]; printRequeuedCount: number
      identityChanges: IdentityFieldOverrides
    }
  | {
      kind: 'sku_corrected'; device: GradeCorrectionDeviceRow
      oldSku: string; newSku: string
      printInvalidatedIds: number[]; printRequeuedCount: number
      identityChanges: IdentityFieldOverrides
    }
  // Z-9 Amendment 1/5 only: grade+sku were ALREADY correct (planGradeCorrection
  // returned 'skip') but the return correction's snapshot still disagrees with
  // one or more of imei/brand/model/capacity/color — e.g. a correction that
  // only fixed the colour, leaving grade untouched. /inventory/grade can never
  // produce this effect kind (it never passes identityOverrides), so this is
  // purely additive and does not touch that route's existing behaviour.
  | {
      kind: 'identity_corrected'; device: GradeCorrectionDeviceRow
      identityChanges: IdentityFieldOverrides
    }

// Appends this device's write statements to `stmts` (caller owns the
// array and the eventual db.batch() call — see header). Returns null for
// a 'skip' plan (nothing to write). Does one DB READ (print_jobs lookup)
// per device when the SKU is actually changing — same read /grade's
// original inline loop already did per-device before batching, not a new
// round-trip this refactor introduces.
export async function buildGradeCorrectionStmts(
  db: D1Database,
  stmts: D1PreparedStatement[],
  params: {
    organisationId: number
    device: GradeCorrectionDeviceRow
    plan: GradeCorrectionPlan
    targetGrade: Grade
    actor: string | null
    reason: string | null
    userId: number
    bulkId?: string | null
    // Z-9 Amendment 1/5 only — NEVER passed by /inventory/grade. Any field
    // present here that differs from device's current value is folded into
    // whichever UPDATE this call already builds (or, when plan is 'skip',
    // triggers a NEW identity-only UPDATE that otherwise wouldn't exist).
    // Fields absent, or equal to the device's current value, are left
    // untouched — a full-snapshot overwrite of ONLY the fields that differ.
    identityOverrides?: IdentityFieldOverrides
  },
): Promise<GradeCorrectionEffect | null> {
  const { organisationId, device, plan, targetGrade, actor, reason, userId, bulkId, identityOverrides } = params

  const identityChanges: IdentityFieldOverrides = {}
  if (identityOverrides) {
    for (const f of ['imei', 'brand', 'model', 'capacity', 'color'] as const) {
      const v = identityOverrides[f]
      if (v !== undefined && v !== device[f]) (identityChanges as Record<string, string | null>)[f] = v
    }
  }
  const identityCols = Object.keys(identityChanges) as Array<keyof IdentityFieldOverrides>

  if (plan.action === 'skip') {
    if (!identityCols.length) return null
    stmts.push(
      db.prepare(
        `UPDATE received_devices SET ${identityCols.map(f => `${f} = ?`).join(', ')} WHERE id = ? AND organisation_id = ?`
      ).bind(...identityCols.map(f => identityChanges[f]), device.id, organisationId)
    )
    return { kind: 'identity_corrected', device, identityChanges }
  }

  let flaggedForRemoval = false

  if (plan.action === 'change') {
    const setCols = ['grade = ?', 'sku = ?', ...identityCols.map(f => `${f} = ?`)]
    const setVals: unknown[] = [targetGrade, plan.newSku, ...identityCols.map(f => identityChanges[f])]
    stmts.push(
      db.prepare(`UPDATE received_devices SET ${setCols.join(', ')} WHERE id = ? AND organisation_id = ?`)
        .bind(...setVals, device.id, organisationId)
    )
    stmts.push(
      db.prepare(
        `INSERT INTO grade_audit
         (organisation_id, received_device_id, imei, old_grade, new_grade, actor, reason, bulk_id, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(organisationId, device.id, device.imei, device.grade, targetGrade, actor, reason, bulkId ?? null, userId)
    )
    if (targetGrade === 'UG' && device.status === 'ACTIVE_INVENTORY') {
      stmts.push(
        db.prepare(
          `INSERT INTO removal_flags
           (organisation_id, received_device_id, imei, sku, old_grade, new_grade, reason, flagged_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(organisationId, device.id, device.imei, plan.newSku, device.grade, targetGrade, 'regrade_to_UG_while_active_inventory', userId)
      )
      flaggedForRemoval = true
    }
  } else {
    const setCols = ['sku = ?', ...identityCols.map(f => `${f} = ?`)]
    const setVals: unknown[] = [plan.newSku, ...identityCols.map(f => identityChanges[f])]
    stmts.push(
      db.prepare(`UPDATE received_devices SET ${setCols.join(', ')} WHERE id = ? AND organisation_id = ?`)
        .bind(...setVals, device.id, organisationId)
    )
  }

  const oldSku = device.sku
  const newSku = plan.newSku
  let printInvalidatedIds: number[] = []
  let printRequeuedCount = 0
  if (newSku !== oldSku) {
    const { results: queuedJobs } = await db.prepare(
      `SELECT id FROM print_jobs WHERE received_device_id = ? AND organisation_id = ? AND status = 'queued'`
    ).bind(device.id, organisationId).all<{ id: number }>()
    if (queuedJobs.length) {
      for (const job of queuedJobs) {
        stmts.push(db.prepare("UPDATE print_jobs SET status = 'invalidated' WHERE id = ?").bind(job.id))
      }
      const payload = {
        uuid: device.uuid, sku: newSku, imei: device.imei,
        brand: device.brand, model: device.model, capacity: device.capacity, color: device.color,
        grade: plan.action === 'change' ? targetGrade : device.grade,
      }
      stmts.push(
        db.prepare(
          `INSERT INTO print_jobs (organisation_id, received_device_id, payload_json, created_by_user_id) VALUES (?, ?, ?, ?)`
        ).bind(organisationId, device.id, JSON.stringify(payload), userId)
      )
      printInvalidatedIds = queuedJobs.map(j => j.id)
      printRequeuedCount = queuedJobs.length
    }
  }

  if (plan.action === 'change') {
    return { kind: 'changed', device, targetGrade, oldSku, newSku, flaggedForRemoval, printInvalidatedIds, printRequeuedCount, identityChanges }
  }
  return { kind: 'sku_corrected', device, oldSku, newSku, printInvalidatedIds, printRequeuedCount, identityChanges }
}

// Writes the device_events row for one effect — called AFTER the
// caller's db.batch() has committed, same ordering /grade's original
// inline logic used (batch first, then log events individually).
export async function logGradeCorrectionEvent(
  db: D1Database,
  organisationId: number,
  userId: number,
  reason: string | null,
  bulkId: string | null | undefined,
  effect: GradeCorrectionEffect,
): Promise<void> {
  if (effect.kind === 'identity_corrected') {
    await logDeviceEvent(db, {
      organisationId, deviceId: effect.device.id, eventType: 'RETURN_IDENTITY_CORRECTED', userId,
      reference: bulkId ?? null,
      metadata: {
        reason: reason || 'return correction identity fields written through at restock (grade/sku unchanged)',
        identity_changes: effect.identityChanges,
      },
    })
    return
  }
  if (effect.kind === 'changed') {
    await logDeviceEvent(db, {
      organisationId, deviceId: effect.device.id, eventType: 'GRADE_CHANGE', userId,
      reference: bulkId ?? null,
      metadata: {
        old_grade: effect.device.grade, new_grade: effect.targetGrade, reason,
        old_sku: effect.oldSku, new_sku: effect.newSku,
        ...(effect.printInvalidatedIds.length
          ? { print_jobs_invalidated: effect.printInvalidatedIds, print_jobs_requeued: effect.printRequeuedCount }
          : {}),
      },
    })
    return
  }
  await logDeviceEvent(db, {
    organisationId, deviceId: effect.device.id, eventType: 'SKU_CORRECTION', userId,
    reference: bulkId ?? null,
    metadata: {
      grade: effect.device.grade,
      reason: reason || 'sku grade-suffix disagreed with grade column; re-resolved via catalogue (grade unchanged)',
      old_sku: effect.oldSku, new_sku: effect.newSku,
      ...(effect.printInvalidatedIds.length
        ? { print_jobs_invalidated: effect.printInvalidatedIds, print_jobs_requeued: effect.printRequeuedCount }
        : {}),
    },
  })
}
