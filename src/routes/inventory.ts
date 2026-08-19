import { Hono } from 'hono'
import type { Bindings, AuthUser } from '../types'
import { normalizeGrade, VALID_GRADES } from '../lib/grade'
import { currentUser } from '../lib/auth'
import { logDeviceEvent } from '../lib/deviceLifecycle'
import { cleanString } from '../lib/validate'
import { resolveCatalogSkuBulk, parseSkuGradeSuffix } from '../lib/catalog'

const app = new Hono<{ Bindings: Bindings; Variables: { user: AuthUser } }>()

// Browse all received devices with filters (org-scoped)
app.get('/', async (c) => {
  const user = currentUser(c)
  const q = c.req.query()
  const limit = Math.min(Number(q.limit) || 100, 500)
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

  const sql = `
    SELECT * FROM received_devices
    WHERE ${where.join(' AND ')}
    ORDER BY id DESC
    LIMIT ?
  `
  binds.push(limit)
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all()
  return c.json({ devices: results })
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
  const placeholders = ids.map(() => '?').join(',')
  const { results: current } = await c.env.DB.prepare(
    `SELECT id, uuid, imei, sku, grade, status, brand, model, capacity, color
       FROM received_devices WHERE id IN (${placeholders}) AND organisation_id = ?`
  ).bind(...(ids as unknown[]), orgId).all<{
    id: number; uuid: string; imei: string; sku: string; grade: string; status: string
    brand: string | null; model: string | null; capacity: string | null; color: string | null
  }>()

  type DeviceRow = (typeof current)[number]

  const updated: number[] = []
  const skipped: { id: number; reason: string }[] = []
  const flaggedForRemoval: number[] = []
  const skuCorrectedIds: number[] = []
  const stmts = []
  const foundIds = new Set(current.map(r => r.id))
  for (const id of ids) {
    if (!foundIds.has(id)) {
      skipped.push({ id, reason: 'not found' })
    }
  }

  // Devices whose grade is actually changing — these are the only ones
  // that need grade-change catalogue re-resolution (below). Devices
  // already at the target grade are handled separately just below: most
  // are a true no-op skip, but a subset need a DIFFERENT kind of
  // self-healing (see "SKU-only correction" block).
  const changing = current.filter(r => r.grade !== grade)
  const unchanged = current.filter(r => r.grade === grade)

  // SKU-only self-heal (2026-08-19, id-43 follow-up): a device whose grade
  // is unchanged never reaches the grade-change re-resolution above, so a
  // device regraded BEFORE this fix existed — grade column already correct,
  // but sku still carrying the OLD grade's suffix — can never be reached by
  // calling /grade with its current (unchanged) grade. Faking a grade
  // round-trip (e.g. UG -> A -> UG) would "fix" the SKU but writes two
  // fabricated entries into grade_audit and device_events, which is worse
  // than the mismatch itself — so instead we detect the SKU/grade-suffix
  // disagreement here and re-resolve the SKU ALONE, without touching grade
  // or grade_audit at all. This is a distinct concept from a grade change —
  // logged as its own device_events type (SKU_CORRECTION, not
  // GRADE_CHANGE) below so the audit trail never implies a re-grade that
  // didn't happen.
  const skuMismatched = unchanged.filter(r => {
    const suffix = parseSkuGradeSuffix(r.sku)
    return suffix !== null && suffix !== r.grade
  })
  const consistent = unchanged.filter(r => !skuMismatched.includes(r))
  for (const row of consistent) {
    skipped.push({ id: row.id, reason: 'unchanged' })
  }

  // Bulk-resolve the catalogue for every changing device's (model, capacity,
  // color, NEW grade) in one query (resolveCatalogSkuBulk loads the whole
  // org catalogue once and matches in memory) rather than one D1 round-trip
  // per device — same rationale as the manifest-upload bulk path.
  const lookups = changing.length
    ? await resolveCatalogSkuBulk(
        c.env.DB,
        changing.map(r => ({ model: r.model, capacity: r.capacity, color: r.color, grade })),
        orgId,
      )
    : []

  // Same bulk resolution for the SKU-only self-heal set — same (already
  // correct) grade, since grade is not changing for these rows.
  const skuFixLookups = skuMismatched.length
    ? await resolveCatalogSkuBulk(
        c.env.DB,
        skuMismatched.map(r => ({ model: r.model, capacity: r.capacity, color: r.color, grade })),
        orgId,
      )
    : []

  // device_events writes need to happen after the batch commits (they're
  // logged individually below), but we decide per-row here what SKU (if
  // any) to write and whether the row proceeds at all.
  const eventsToLog: Array<{ row: DeviceRow; oldSku: string; newSku: string }> = []
  // Separate log for the SKU-only self-heal path — kept distinct from
  // eventsToLog so it can be written under its own device_events type
  // (SKU_CORRECTION, not GRADE_CHANGE) and never touches grade_audit.
  const skuCorrectionsToLog: Array<{ row: DeviceRow; oldSku: string; newSku: string }> = []

  for (let i = 0; i < changing.length; i++) {
    const row = changing[i]
    const lookup = lookups[i]

    if (lookup.status !== 'match') {
      // Fail-closed: no catalogue row for this device's new (model,
      // capacity, color, grade) combination (or more than one, equally
      // unsafe to guess). Refuse the regrade for THIS device — do not
      // touch grade, sku, grade_audit, or device_events — and name the
      // exact missing combination so the operator can add the catalogue
      // row or correct the input, rather than getting a silent stale-SKU
      // success.
      const combo = `${row.model ?? '?'} · ${row.capacity ?? '?'} · ${row.color ?? '?'} · grade ${grade}`
      const detail = lookup.status === 'ambiguous'
        ? `${lookup.candidates.length} catalogue SKUs match ${combo} — cannot pick one automatically`
        : `No catalogue SKU exists for ${combo}`
      skipped.push({
        id: row.id,
        reason: `regrade refused: ${detail}. SKU left unchanged at ${row.sku}.`,
      })
      continue
    }

    const newSku = lookup.row.sku
    stmts.push(
      c.env.DB.prepare('UPDATE received_devices SET grade = ?, sku = ? WHERE id = ? AND organisation_id = ?')
        .bind(grade, newSku, row.id, orgId)
    )
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO grade_audit
         (organisation_id, received_device_id, imei, old_grade, new_grade, actor, reason, bulk_id, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(orgId, row.id, row.imei, row.grade, grade, actor, reason, bulkId, user.id)
    )
    updated.push(row.id)
    eventsToLog.push({ row, oldSku: row.sku, newSku })

    // Regrade-fix 2: a device downgraded to UG while it is ACTIVE_INVENTORY
    // (already on the shelf/for sale) needs manual pull-for-review —
    // independent of any Zoho-batch state (no application code writes to
    // zoho_batches today). Literal status check, not gated on grade_audit
    // or repair state.
    if (grade === 'UG' && row.status === 'ACTIVE_INVENTORY') {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO removal_flags
           (organisation_id, received_device_id, imei, sku, old_grade, new_grade, reason, flagged_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(orgId, row.id, row.imei, newSku, row.grade, grade, 'regrade_to_UG_while_active_inventory', user.id)
      )
      flaggedForRemoval.push(row.id)
    }
  }

  // SKU-only self-heal: re-resolve the catalogue for rows whose grade is
  // already correct but whose stored SKU's grade suffix disagrees with it
  // (id 43's exact shape). Grade itself is NOT written here — it's already
  // right — only sku. No grade_audit row (nothing about the grade changed
  // to audit); the correction is recorded via device_events below with its
  // own SKU_CORRECTION event type instead.
  for (let i = 0; i < skuMismatched.length; i++) {
    const row = skuMismatched[i]
    const lookup = skuFixLookups[i]

    if (lookup.status !== 'match') {
      // Can't self-heal without an unambiguous catalogue row — leave the
      // device untouched (same fail-closed posture as the grade-change
      // path) and report the mismatch was seen but not auto-correctable.
      const combo = `${row.model ?? '?'} · ${row.capacity ?? '?'} · ${row.color ?? '?'} · grade ${grade}`
      const detail = lookup.status === 'ambiguous'
        ? `${lookup.candidates.length} catalogue SKUs match ${combo} — cannot pick one automatically`
        : `No catalogue SKU exists for ${combo}`
      skipped.push({
        id: row.id,
        reason: `sku/grade mismatch detected (sku suggests ${parseSkuGradeSuffix(row.sku)}, grade is ${row.grade}) but could not self-heal: ${detail}. SKU left unchanged at ${row.sku}.`,
      })
      continue
    }

    const newSku = lookup.row.sku
    if (newSku === row.sku) {
      // Catalogue resolves back to the same SKU the device already has —
      // nothing to correct after all (shouldn't normally happen since we
      // only get here when parseSkuGradeSuffix disagreed with grade, but
      // stay safe rather than write a no-op correction event).
      skipped.push({ id: row.id, reason: 'unchanged' })
      continue
    }
    stmts.push(
      c.env.DB.prepare('UPDATE received_devices SET sku = ? WHERE id = ? AND organisation_id = ?')
        .bind(newSku, row.id, orgId)
    )
    skuCorrectedIds.push(row.id)
    skuCorrectionsToLog.push({ row, oldSku: row.sku, newSku })
  }

  // Print-job invalidation/re-queue (2026-08-19, same follow-up): a queued
  // (not-yet-printed) label was rendered with the OLD sku baked into its
  // payload_json. If the SKU is changing, that queued job is now wrong and
  // must not be printed as-is — invalidate it and queue a fresh one with
  // the new SKU. Jobs already 'sent' are left alone (the physical label is
  // already printed; nothing here can un-print it). Reads-before-batch,
  // same pattern as print.ts's mark-sent-batch handler.
  const printInvalidated: Record<number, number[]> = {}
  const printRequeued: Record<number, number> = {}
  // Covers both actual grade changes AND SKU-only self-heal corrections —
  // either way the device's SKU changed, so any queued label baked with
  // the old SKU string is equally stale and needs the same treatment.
  for (const { row, oldSku, newSku } of [...eventsToLog, ...skuCorrectionsToLog]) {
    if (newSku === oldSku) continue
    const { results: queuedJobs } = await c.env.DB.prepare(
      `SELECT id FROM print_jobs WHERE received_device_id = ? AND organisation_id = ? AND status = 'queued'`
    ).bind(row.id, orgId).all<{ id: number }>()
    if (queuedJobs.length === 0) continue

    for (const job of queuedJobs) {
      stmts.push(c.env.DB.prepare("UPDATE print_jobs SET status = 'invalidated' WHERE id = ?").bind(job.id))
    }
    const payload = {
      uuid: row.uuid, sku: newSku, imei: row.imei,
      brand: row.brand, model: row.model, capacity: row.capacity, color: row.color, grade,
    }
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO print_jobs (organisation_id, received_device_id, payload_json, created_by_user_id) VALUES (?, ?, ?, ?)`
      ).bind(orgId, row.id, JSON.stringify(payload), user.id)
    )
    printInvalidated[row.id] = queuedJobs.map(j => j.id)
    // Actual new id isn't known until after the batch runs (D1 batch results
    // don't expose per-statement meta.last_row_id reliably across statement
    // types in one batch), so we record that a requeue happened; the count
    // is what the caller needs (device_events carries the audit detail).
    printRequeued[row.id] = queuedJobs.length
  }

  if (stmts.length) await c.env.DB.batch(stmts)

  // One device_events row per changed device, so grade + SKU history is
  // visible in the unified audit trail alongside status transitions. Both
  // old_sku and new_sku are recorded (not just old_grade/new_grade) so the
  // correction itself — not just the grade change that triggered it — is
  // auditable, per the incident that motivated this.
  for (const { row, oldSku, newSku } of eventsToLog) {
    await logDeviceEvent(c.env.DB, {
      organisationId: orgId, deviceId: row.id, eventType: 'GRADE_CHANGE', userId: user.id,
      reference: bulkId,
      metadata: {
        old_grade: row.grade, new_grade: grade, reason,
        old_sku: oldSku, new_sku: newSku,
        ...(printInvalidated[row.id]
          ? { print_jobs_invalidated: printInvalidated[row.id], print_jobs_requeued: printRequeued[row.id] }
          : {}),
      },
    })
  }

  // SKU-only self-heal corrections get their OWN event type — deliberately
  // NOT 'GRADE_CHANGE' — so the audit trail never implies a re-grade
  // happened when only the SKU was ever wrong. No grade_audit row for
  // these (grade field never changed).
  for (const { row, oldSku, newSku } of skuCorrectionsToLog) {
    await logDeviceEvent(c.env.DB, {
      organisationId: orgId, deviceId: row.id, eventType: 'SKU_CORRECTION', userId: user.id,
      reference: bulkId,
      metadata: {
        grade: row.grade,
        reason: reason || 'sku grade-suffix disagreed with grade column; re-resolved via catalogue (grade unchanged)',
        old_sku: oldSku, new_sku: newSku,
        ...(printInvalidated[row.id]
          ? { print_jobs_invalidated: printInvalidated[row.id], print_jobs_requeued: printRequeued[row.id] }
          : {}),
      },
    })
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
