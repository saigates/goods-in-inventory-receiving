import { Hono } from 'hono'
import type { Bindings, AuthUser } from '../types'
import { normalizeGrade, VALID_GRADES } from '../lib/grade'
import { currentUser } from '../lib/auth'
import { logDeviceEvent } from '../lib/deviceLifecycle'
import { cleanString } from '../lib/validate'

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
  // an id belonging to another tenant is treated as not-found).
  const placeholders = ids.map(() => '?').join(',')
  const { results: current } = await c.env.DB.prepare(
    `SELECT id, imei, grade FROM received_devices WHERE id IN (${placeholders}) AND organisation_id = ?`
  ).bind(...(ids as unknown[]), orgId).all<{ id: number; imei: string; grade: string }>()

  const updated: number[] = []
  const skipped: { id: number; reason: string }[] = []
  const stmts = []
  const foundIds = new Set(current.map(r => r.id))
  for (const id of ids) {
    if (!foundIds.has(id)) {
      skipped.push({ id, reason: 'not found' })
    }
  }
  for (const row of current) {
    if (row.grade === grade) {
      // No-op — same grade, don't write an audit row.
      skipped.push({ id: row.id, reason: 'unchanged' })
      continue
    }
    stmts.push(
      c.env.DB.prepare('UPDATE received_devices SET grade = ? WHERE id = ? AND organisation_id = ?').bind(grade, row.id, orgId)
    )
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO grade_audit
         (organisation_id, received_device_id, imei, old_grade, new_grade, actor, reason, bulk_id, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(orgId, row.id, row.imei, row.grade, grade, actor, reason, bulkId, user.id)
    )
    updated.push(row.id)
  }

  if (stmts.length) await c.env.DB.batch(stmts)

  // One device_events row per changed device, so grade history is visible
  // in the unified audit trail alongside status transitions.
  for (const row of current) {
    if (row.grade === grade) continue
    await logDeviceEvent(c.env.DB, {
      organisationId: orgId, deviceId: row.id, eventType: 'GRADE_CHANGE', userId: user.id,
      reference: bulkId, metadata: { old_grade: row.grade, new_grade: grade, reason },
    })
  }

  return c.json({
    ok: true,
    grade,
    updated_count: updated.length,
    updated_ids: updated,
    skipped,
    bulk_id: bulkId,
  })
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
