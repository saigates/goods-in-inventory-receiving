import { Hono } from 'hono'
import type { Bindings, AuthUser } from '../types'
import { normalizeGrade, VALID_GRADES } from '../lib/grade'
import { currentUser } from '../lib/auth'
import { logDeviceEvent } from '../lib/deviceLifecycle'
import { cleanString } from '../lib/validate'
import { resolveCatalogSkuBulk, parseSkuGradeSuffix } from '../lib/catalog'
import { chunkArray, BULK_SERIAL_CAP } from '../lib/d1Chunk'
import {
  planGradeCorrection, buildGradeCorrectionStmts, logGradeCorrectionEvent,
  type GradeCorrectionDeviceRow, type GradeCorrectionEffect,
} from '../lib/gradeCorrection'

const app = new Hono<{ Bindings: Bindings; Variables: { user: AuthUser } }>()

// Browse all received devices with filters (org-scoped)
//
// PAGINATED (2026-09-07 — "Inventory only shows devices when scanned/
// filtered" fix, part B2): this endpoint previously had no total-count or
// offset support at all — a bare `limit` (capped 500) with no way to see
// or reach anything past it, so once the org's device count grew past that
// cap the Inventory page could only ever render the newest ~200-500 and had
// no way to tell the operator more existed. Now mirrors GET /api/devices's
// page/page_size/total contract exactly (same param names, same 200 cap) so
// the two list endpoints behave identically from a caller's perspective.
// `total` is always returned so the UI can render e.g. "Showing 1-200 of
// 1,412" — the LIVE count from the server, never a value fixed at
// fix-time — and never silently present a truncated list as complete.
app.get('/', async (c) => {
  const user = currentUser(c)
  const q = c.req.query()
  const pageSize = Math.min(Math.max(Number(q.page_size) || Number(q.limit) || 100, 1), 200)
  const page = Math.max(Number(q.page) || 1, 1)
  const offset = (page - 1) * pageSize
  const where: string[] = ['organisation_id = ?']
  const binds: unknown[] = [user.organisation_id]

  if (q.q) {
    where.push('(imei LIKE ? OR sku LIKE ? OR uuid LIKE ?)')
    const w = `%${q.q}%`
    binds.push(w, w, w)
  }
  if (q.source) {
    where.push('source = ?')
    binds.push(q.source)
  }
  if (q.manifest_id) {
    where.push('manifest_id = ?')
    binds.push(Number(q.manifest_id))
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

// Delete a received device. Restores the original manifest line to 'pending'
// (so it can be re-scanned), and removes any associated print jobs.
app.delete('/:id', async (c) => {
  const user = currentUser(c)
  const orgId = user.organisation_id
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const device = await c.env.DB.prepare('SELECT * FROM received_devices WHERE id = ? AND organisation_id = ?')
    .bind(id, orgId).first<{ id: number; expected_device_id: number | null; imei: string; manifest_id: number | null; status: string }>()
  if (!device) return c.json({ error: 'Not found' }, 404)

  const stmts = []
  // Re-open the manifest line if this came from a manifest
  if (device.expected_device_id) {
    stmts.push(
      c.env.DB.prepare(
        `UPDATE expected_devices
         SET status = 'pending', received_at = NULL, received_device_id = NULL
         WHERE id = ? AND organisation_id = ?`
      ).bind(device.expected_device_id, orgId)
    )
  }
  // Audit log
  stmts.push(
    c.env.DB.prepare(
      "INSERT INTO scan_events (organisation_id, manifest_id, imei, outcome, message, user_id) VALUES (?, ?, ?, 'rejected', 'Received device deleted by operator', ?)"
    ).bind(orgId, device.manifest_id, device.imei, user.id)
  )
  // print_jobs are cascade-deleted via FK
  stmts.push(c.env.DB.prepare('DELETE FROM received_devices WHERE id = ? AND organisation_id = ?').bind(id, orgId))

  await c.env.DB.batch(stmts)

  // device_events is append-only and the device row is about to disappear,
  // so record the deletion as a final DEVICE_DELETED event before the
  // FK-less log entry above would otherwise be the only trace.
  await logDeviceEvent(c.env.DB, {
    organisationId: orgId, deviceId: id, eventType: 'DEVICE_DELETED', userId: user.id,
    fromStatus: device.status as any, toStatus: null,
    metadata: { restored_expected: !!device.expected_device_id },
  })

  return c.json({ ok: true, restored_expected: !!device.expected_device_id })
})

// ───────── Grade override (single + bulk) ─────────
// Body: { ids: number[], grade: 'A'|'B'|'C'|'UG', actor?: string, reason?: string }
// Writes one received_devices.grade update per id and one grade_audit row per id.
// Bulk and single use the same endpoint — single is just ids.length === 1.
// Returns { ok, updated, skipped, audit_bulk_id }.
//
// SKU re-resolution (2026-08-19, LW001 follow-up — root cause of id 701/43
// was a grade change that silently left the OLD, now-wrong-grade SKU in
// place): a grade change is a change to one of the four dimensions the
// catalogue SKU is keyed on (model, capacity, color, grade), so whenever a
// device's grade actually changes we re-run catalogue resolution for the
// device's (model, capacity, color, NEW grade) and, on a match, update
// received_devices.sku to match. This is NOT optional/best-effort: if no
// catalogue row exists for the new combination, that device's regrade is
// refused outright (grade is NOT updated, no audit/event row is written,
// its stale SKU is left untouched) rather than silently succeeding with a
// stale SKU — "silent success is what produced this row" (id 43 in local
// D1 today: sku ...-A, grade UG, from exactly this gap). Per-device
// failure, not whole-batch abort: this matches the endpoint's existing
// "not found"/"unchanged" skip-and-report convention, so one bad device in
// a bulk regrade doesn't block the others.
//
// SKU-only self-heal (2026-08-19, id-43 remediation follow-up): the
// re-resolution above only fires when grade is CHANGING, so a device
// regraded before this fix existed — grade column already correct, but
// sku still carrying the old grade's suffix — can never be reached by
// calling /grade with its current (unchanged) grade; it hits the plain
// "unchanged" skip before ever reaching re-resolution. Faking a grade
// round-trip (e.g. UG -> A -> UG) would fix the SKU but writes two
// fabricated rows into grade_audit and device_events, which is worse than
// the mismatch itself. So the "unchanged" branch additionally checks
// whether the stored SKU's grade suffix (parseSkuGradeSuffix) disagrees
// with the (already correct) grade column, and if so re-resolves the SKU
// ALONE via the catalogue — grade is never written, grade_audit is never
// touched, and the correction is logged as its own device_events type
// (SKU_CORRECTION, not GRADE_CHANGE) so the audit trail never implies a
// re-grade that didn't happen. No new endpoint/surface — folded into this
// existing handler per instruction, since this makes /grade self-healing.
app.post('/grade', async (c) => {
  const user = currentUser(c)
  const orgId = user.organisation_id
  const body = await c.req.json<{
    ids: number[]
    grade: string
    actor?: string
    reason?: string
  }>().catch(() => ({} as any))

  const ids: number[] = Array.from(new Set((body.ids || []).map(Number).filter(Boolean)))
  if (ids.length === 0) return c.json({ error: 'ids[] required' }, 400)
  // Application-layer ceiling (Z-1, 2026-09-24) — same BULK_SERIAL_CAP used
  // by opr.ts's bulk-serials endpoint, shared here since this route had no
  // equivalent input-size cap of its own before this pass.
  if (ids.length > BULK_SERIAL_CAP) {
    return c.json({ error: `Maximum ${BULK_SERIAL_CAP} ids per request` }, 422)
  }

  const grade = normalizeGrade(body.grade)
  // Be strict: if the caller sent something not in the set we refuse rather
  // than silently coercing (which would hide bugs).
  if (!VALID_GRADES.includes(grade) || String(body.grade).toUpperCase() !== grade) {
    return c.json({
      error: `Invalid grade '${body.grade}'. Allowed: ${VALID_GRADES.join(', ')}`,
    }, 400)
  }

  const actor = cleanString(body.actor, 64) || user.name || user.email
  const reason = cleanString(body.reason, 500)
  // Stamp a single bulk_id so we can group bulk-override audit rows together.
  const bulkId = ids.length > 1
    ? `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    : null

  // Fetch current state for the audit row + skip detection (org-scoped —
  // an id belonging to another tenant is treated as not-found). Now also
  // pulls uuid/brand/model/capacity/color: needed both to re-resolve the
  // catalogue SKU for the new grade, and to build a fresh print-job payload
  // if that resolution changes the SKU (see below).
  //
  // Chunked at D1_IN_CHUNK_SIZE (Z-1, 2026-09-24): a single `id IN (?,?,...)`
  // statement is capped by D1 at 100 bound params, and real bulk-regrade
  // batches run well past that (155/162/181/217/341 in production). A
  // device id simply not matching (wrong org, already deleted) is the
  // existing, intentional "not found" skip path below — not a truncation —
  // so this reads via plain chunk-and-concatenate, same reasoning as the
  // bulk-serials SELECT in opr.ts.
  const current: GradeCorrectionDeviceRow[] = []
  for (const chunk of chunkArray(ids)) {
    const placeholders = chunk.map(() => '?').join(',')
    const { results } = await c.env.DB.prepare(
      `SELECT id, uuid, imei, sku, grade, status, brand, model, capacity, color
         FROM received_devices WHERE id IN (${placeholders}) AND organisation_id = ?`
    ).bind(...(chunk as unknown[]), orgId).all<GradeCorrectionDeviceRow>()
    current.push(...(results || []))
  }

  const updated: number[] = []
  const skipped: { id: number; reason: string }[] = []
  const flaggedForRemoval: number[] = []
  const skuCorrectedIds: number[] = []
  const stmts: D1PreparedStatement[] = []
  const foundIds = new Set(current.map(r => r.id))
  for (const id of ids) {
    if (!foundIds.has(id)) {
      skipped.push({ id, reason: 'not found' })
    }
  }

  // 2026-09-26 (Z-9 Amendment 5 follow-up): the decide/write/log logic
  // below is now shared with Z-9's restock write-through — see
  // src/lib/gradeCorrection.ts's header comment for why this is a
  // three-step (plan/build-stmts/log-event) split rather than a single
  // reusable call, and why the BULK catalogue resolution + single
  // db.batch() call stays right here rather than moving into the shared
  // module (this route's 155/162/181/217/341-device batches are exactly
  // what that batching exists to protect; Z-9's restock path is a
  // per-shipment handful of devices and batches per-shipment instead).
  //
  // Devices whose grade is actually changing need grade-change catalogue
  // re-resolution; devices already at the target grade go through the
  // SKU-only self-heal check instead (id-43 follow-up, 2026-08-19: a
  // device regraded before that fix existed can have grade correct but
  // sku still carrying the old grade's suffix, and can never be reached
  // by calling /grade with its current unchanged grade otherwise).
  const changing = current.filter(r => r.grade !== grade)
  const unchanged = current.filter(r => r.grade === grade)
  const skuMismatched = unchanged.filter(r => {
    const suffix = parseSkuGradeSuffix(r.sku)
    return suffix !== null && suffix !== r.grade
  })
  const consistent = unchanged.filter(r => !skuMismatched.includes(r))
  for (const row of consistent) {
    skipped.push({ id: row.id, reason: 'unchanged' })
  }

  // Bulk-resolve the catalogue for every changing device's (model,
  // capacity, color, NEW grade) in one query (resolveCatalogSkuBulk loads
  // the whole org catalogue once and matches in memory) rather than one
  // D1 round-trip per device — same rationale as the manifest-upload bulk
  // path. Same bulk call for the SKU-only self-heal set (already-correct
  // grade, since grade is not changing for these rows).
  const lookups = changing.length
    ? await resolveCatalogSkuBulk(
        c.env.DB,
        changing.map(r => ({ model: r.model, capacity: r.capacity, color: r.color, grade })),
        orgId,
      )
    : []
  const skuFixLookups = skuMismatched.length
    ? await resolveCatalogSkuBulk(
        c.env.DB,
        skuMismatched.map(r => ({ model: r.model, capacity: r.capacity, color: r.color, grade })),
        orgId,
      )
    : []

  const effects: GradeCorrectionEffect[] = []

  for (let i = 0; i < changing.length; i++) {
    const row = changing[i]
    const plan = planGradeCorrection(row, grade, lookups[i])
    if (plan.action === 'skip') {
      skipped.push({ id: row.id, reason: plan.reason })
      continue
    }
    const effect = await buildGradeCorrectionStmts(c.env.DB, stmts, {
      organisationId: orgId, device: row, plan, targetGrade: grade, actor, reason, userId: user.id, bulkId,
    })
    if (effect) {
      effects.push(effect)
      updated.push(row.id)
      if (effect.kind === 'changed' && effect.flaggedForRemoval) flaggedForRemoval.push(row.id)
    }
  }

  for (let i = 0; i < skuMismatched.length; i++) {
    const row = skuMismatched[i]
    const plan = planGradeCorrection(row, grade, skuFixLookups[i])
    if (plan.action === 'skip') {
      skipped.push({ id: row.id, reason: plan.reason })
      continue
    }
    const effect = await buildGradeCorrectionStmts(c.env.DB, stmts, {
      organisationId: orgId, device: row, plan, targetGrade: grade, actor, reason, userId: user.id, bulkId,
    })
    if (effect) {
      effects.push(effect)
      skuCorrectedIds.push(row.id)
    }
  }

  if (stmts.length) await c.env.DB.batch(stmts)

  // device_events writes happen AFTER the batch commits, one row per
  // changed/corrected device — same ordering as the original inline logic.
  for (const effect of effects) {
    await logGradeCorrectionEvent(c.env.DB, orgId, user.id, reason, bulkId, effect)
  }

  return c.json({
    ok: true,
    grade,
    updated_count: updated.length,
    updated_ids: updated,
    sku_corrected_count: skuCorrectedIds.length,
    sku_corrected_ids: skuCorrectedIds,
    skipped,
    bulk_id: bulkId,
    flagged_for_removal: flaggedForRemoval,
  })
})

// Consistency check (2026-08-19, LW001 follow-up): scan received_devices for
// rows whose stored SKU's grade suffix (the last hyphen-delimited segment —
// see parseSkuGradeSuffix, confirmed against deriveSku() in
// src/routes/catalog.ts, which always appends `-${grade}`) disagrees with
// the row's own `grade` column. A mismatch here means the SKU was never
// re-resolved after a grade change — exactly the class of bug the /grade
// re-resolution above now closes going forward; this surfaces any rows a
// PRE-fix regrade already produced (id 43 in local D1: sku ...-A, grade UG,
// confirmed via grade_audit as a regrade that happened before this fix).
// Scoped to received_devices (not expected_devices): this is the
// post-receipt table where a SKU is actually assigned/persisted and where
// grade changes are actually written; expected_devices rows are pre-receipt
// manifest lines with no independently-writable grade column to drift
// against. SKUs with no parseable grade suffix (the 9 legacy pre-0007 rows)
// are not counted as mismatches — there is no suffix to disagree.
app.get('/sku-grade-consistency', async (c) => {
  const user = currentUser(c)
  const { results } = await c.env.DB.prepare(
    `SELECT id, uuid, imei, sku, grade FROM received_devices WHERE organisation_id = ? ORDER BY id ASC`
  ).bind(user.organisation_id).all<{ id: number; uuid: string; imei: string; sku: string; grade: string }>()

  const mismatches = results
    .map(r => ({ ...r, sku_grade_suffix: parseSkuGradeSuffix(r.sku) }))
    .filter(r => r.sku_grade_suffix !== null && r.sku_grade_suffix !== r.grade)

  return c.json({ checked: results.length, mismatch_count: mismatches.length, mismatches })
})

// Removal-flag list (regrade-fix 2): devices downgraded to UG while
// ACTIVE_INVENTORY, awaiting manual pull-from-shelf review.
// GET /inventory/removal-flags?resolved=0|1 (default: open only)
app.get('/removal-flags', async (c) => {
  const user = currentUser(c)
  const q = c.req.query()
  const openOnly = q.resolved !== '1'
  const sql = openOnly
    ? `SELECT * FROM removal_flags WHERE organisation_id = ? AND resolved_at IS NULL ORDER BY flagged_at DESC LIMIT 200`
    : `SELECT * FROM removal_flags WHERE organisation_id = ? ORDER BY flagged_at DESC LIMIT 200`
  const { results } = await c.env.DB.prepare(sql).bind(user.organisation_id).all()
  return c.json({ removal_flags: results || [] })
})

// Resolve a removal flag (device physically pulled / reviewed).
app.post('/removal-flags/:id/resolve', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  const note = cleanString((await c.req.json().catch(() => ({} as any))).note, 500)
  const res = await c.env.DB.prepare(
    `UPDATE removal_flags SET resolved_at = CURRENT_TIMESTAMP, resolved_by_user_id = ?, note = COALESCE(?, note)
     WHERE id = ? AND organisation_id = ? AND resolved_at IS NULL`
  ).bind(user.id, note, id, user.organisation_id).run()
  if (!res.meta.changes) return c.json({ error: 'Flag not found or already resolved' }, 404)
  const flag = await c.env.DB.prepare('SELECT * FROM removal_flags WHERE id = ?').bind(id).first()
  return c.json({ ok: true, removal_flag: flag })
})

// Audit log for a single device's grade history (or for a bulk operation)
app.get('/grade-audit/:id', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM grade_audit WHERE received_device_id = ? AND organisation_id = ? ORDER BY id DESC LIMIT 50`
  ).bind(id, user.organisation_id).all()
  return c.json({ audit: results })
})

// Global stats (org-scoped)
app.get('/stats', async (c) => {
  const user = currentUser(c)
  const orgId = user.organisation_id
  const stats = await c.env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM manifests WHERE status = 'open' AND organisation_id = ?) AS open_manifests,
      (SELECT COUNT(*) FROM expected_devices WHERE status = 'pending' AND organisation_id = ?) AS pending_devices,
      (SELECT COUNT(*) FROM received_devices WHERE organisation_id = ?) AS received_total,
      (SELECT COUNT(*) FROM received_devices WHERE source = 'unreconciled' AND organisation_id = ?) AS unreconciled_total,
      (SELECT COUNT(*) FROM print_jobs WHERE status = 'queued' AND organisation_id = ?) AS print_queue
  `).bind(orgId, orgId, orgId, orgId, orgId).first()
  return c.json({ stats })
})

export default app
