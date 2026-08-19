// POST /api/inventory/grade — SKU re-resolution on grade change, fail-closed
// on no catalogue match, and print-job invalidation/re-queue (2026-08-19,
// LW001 follow-up — root cause of the id-701/id-43 stale-SKU rows: the
// re-grade endpoint changed received_devices.grade but never re-resolved
// received_devices.sku for the new grade, so the SKU silently kept
// pointing at the OLD grade forever). Also covers the standalone
// GET /api/inventory/sku-grade-consistency check added in the same pass.
//
// These tests run against the REAL Hono app + REAL D1 binding with all
// migrations applied (not mocks) — sku_catalog rows and received_devices
// rows are inserted directly, then the real route is exercised via
// app.request(), matching the house style established in
// forceAddValuation.spec.ts / deviceLifecycle.spec.ts.
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'
import type { AuthUser } from '../src/types'

const JWT_SECRET = 'test-only-secret'
const testEnv = () => ({ ...(env as unknown as Record<string, unknown>), JWT_SECRET })
const db = () => (env as unknown as { DB: D1Database }).DB

const ADMIN: AuthUser = {
  id: 1,
  email: 'admin@goodsin.local',
  name: 'Seed Admin',
  role: 'admin',
  organisation_id: 1,
}

let token: string
beforeAll(async () => {
  token = await signAuthToken(JWT_SECRET, ADMIN)
})

let seq = 0
function uniqueSuffix(): string {
  seq += 1
  return `${Date.now().toString(36)}${seq}`
}

async function insertCatalogRow(row: {
  sku: string; brand: string; model: string; capacity: string; color: string; grade: string
}) {
  await db().prepare(
    `INSERT INTO sku_catalog (organisation_id, sku, brand, model, capacity, color, grade)
     VALUES (1, ?, ?, ?, ?, ?, ?)`
  ).bind(row.sku, row.brand, row.model, row.capacity, row.color, row.grade).run()
}

async function insertReceivedDevice(row: {
  sku: string; grade: string; model: string; capacity: string; color: string; brand?: string; status?: string
}): Promise<{ id: number; uuid: string; imei: string }> {
  const suffix = uniqueSuffix()
  const uuid = `test-uuid-${suffix}`
  const imei = `35${suffix}`.padEnd(15, '0').slice(0, 15)
  const result = await db().prepare(
    `INSERT INTO received_devices
       (organisation_id, uuid, imei, sku, brand, model, capacity, color, grade, source, status)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`
  ).bind(uuid, imei, row.sku, row.brand ?? 'SAMSUNG', row.model, row.capacity, row.color, row.grade, row.status ?? 'RECEIVED').run()
  return { id: result.meta.last_row_id as number, uuid, imei }
}

async function insertQueuedPrintJob(receivedDeviceId: number, sku: string): Promise<number> {
  const result = await db().prepare(
    `INSERT INTO print_jobs (organisation_id, received_device_id, payload_json, status) VALUES (1, ?, ?, 'queued')`
  ).bind(receivedDeviceId, JSON.stringify({ sku })).run()
  return result.meta.last_row_id as number
}

async function postGrade(body: Record<string, unknown>) {
  const res = await app.request(
    '/api/inventory/grade',
    { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) },
    testEnv(),
  )
  const json = (await res.json().catch(() => ({}))) as Record<string, any>
  return { res, json }
}

async function deviceById(id: number) {
  return db().prepare('SELECT * FROM received_devices WHERE id = ?').bind(id).first<Record<string, any>>()
}

async function gradeChangeEventsFor(deviceId: number) {
  const { results } = await db()
    .prepare(`SELECT * FROM device_events WHERE device_id = ? AND event_type = 'GRADE_CHANGE' ORDER BY id ASC`)
    .bind(deviceId).all<Record<string, any>>()
  return results
}

async function printJobsFor(deviceId: number) {
  const { results } = await db()
    .prepare('SELECT * FROM print_jobs WHERE received_device_id = ? ORDER BY id ASC')
    .bind(deviceId).all<Record<string, any>>()
  return results
}

describe('POST /api/inventory/grade — re-resolves SKU when grade changes and a catalogue match exists', () => {
  it('updates received_devices.sku to the NEW-grade catalogue SKU, not just the grade column', async () => {
    const model = `TESTMODEL-${uniqueSuffix()}`
    await insertCatalogRow({ sku: `TST-${model}-256-BLK-B`, brand: 'TESTBRAND', model, capacity: '256GB', color: 'BLACK', grade: 'B' })
    await insertCatalogRow({ sku: `TST-${model}-256-BLK-A`, brand: 'TESTBRAND', model, capacity: '256GB', color: 'BLACK', grade: 'A' })

    const device = await insertReceivedDevice({ sku: `TST-${model}-256-BLK-B`, grade: 'B', model, capacity: '256GB', color: 'BLACK' })

    const { res, json } = await postGrade({ ids: [device.id], grade: 'A', reason: 'test upgrade' })
    expect(res.status).toBe(200)
    expect(json.updated_count).toBe(1)
    expect(json.updated_ids).toEqual([device.id])

    const row = await deviceById(device.id)
    expect(row?.grade).toBe('A')
    expect(row?.sku).toBe(`TST-${model}-256-BLK-A`) // NOT left at the old -B sku
  })

  it('writes both old_sku and new_sku into the device_events GRADE_CHANGE metadata', async () => {
    const model = `TESTMODEL-${uniqueSuffix()}`
    await insertCatalogRow({ sku: `TST-${model}-128-WHT-B`, brand: 'TESTBRAND', model, capacity: '128GB', color: 'WHITE', grade: 'B' })
    await insertCatalogRow({ sku: `TST-${model}-128-WHT-C`, brand: 'TESTBRAND', model, capacity: '128GB', color: 'WHITE', grade: 'C' })

    const device = await insertReceivedDevice({ sku: `TST-${model}-128-WHT-B`, grade: 'B', model, capacity: '128GB', color: 'WHITE' })
    await postGrade({ ids: [device.id], grade: 'C', reason: 'test downgrade' })

    const events = await gradeChangeEventsFor(device.id)
    expect(events.length).toBe(1)
    const meta = JSON.parse(events[0].metadata)
    expect(meta.old_grade).toBe('B')
    expect(meta.new_grade).toBe('C')
    expect(meta.old_sku).toBe(`TST-${model}-128-WHT-B`)
    expect(meta.new_sku).toBe(`TST-${model}-128-WHT-C`)
  })

  it('does not touch sku/grade/audit/events for a device whose grade is unchanged (existing skip path)', async () => {
    const model = `TESTMODEL-${uniqueSuffix()}`
    await insertCatalogRow({ sku: `TST-${model}-64-RED-A`, brand: 'TESTBRAND', model, capacity: '64GB', color: 'RED', grade: 'A' })
    const device = await insertReceivedDevice({ sku: `TST-${model}-64-RED-A`, grade: 'A', model, capacity: '64GB', color: 'RED' })

    const { json } = await postGrade({ ids: [device.id], grade: 'A' })
    expect(json.updated_count).toBe(0)
    expect(json.skipped).toEqual([{ id: device.id, reason: 'unchanged' }])
    expect(await gradeChangeEventsFor(device.id)).toEqual([])
  })
})

describe('POST /api/inventory/grade — fails closed when no catalogue row exists for the new grade', () => {
  it('refuses the regrade, leaves grade/sku/audit untouched, and names the missing combination', async () => {
    const model = `TESTMODEL-${uniqueSuffix()}`
    // Only a B-grade catalogue row exists — no A-grade row for this exact shape.
    await insertCatalogRow({ sku: `TST-${model}-512-GRN-B`, brand: 'TESTBRAND', model, capacity: '512GB', color: 'GREEN', grade: 'B' })
    const device = await insertReceivedDevice({ sku: `TST-${model}-512-GRN-B`, grade: 'B', model, capacity: '512GB', color: 'GREEN' })

    const { res, json } = await postGrade({ ids: [device.id], grade: 'A' })
    expect(res.status).toBe(200) // per-device failure, not an HTTP-level error
    expect(json.updated_count).toBe(0)
    expect(json.updated_ids).toEqual([])
    expect(json.skipped).toHaveLength(1)
    expect(json.skipped[0].id).toBe(device.id)
    // Names the missing model/capacity/color/grade combination, not a generic error.
    expect(json.skipped[0].reason).toMatch(new RegExp(model))
    expect(json.skipped[0].reason).toMatch(/512GB/)
    expect(json.skipped[0].reason).toMatch(/GREEN/)
    expect(json.skipped[0].reason).toMatch(/grade A/)

    // Silent success is exactly what this fixes: grade, sku, and audit
    // trail must all be untouched — the device is left exactly as it was.
    const row = await deviceById(device.id)
    expect(row?.grade).toBe('B')
    expect(row?.sku).toBe(`TST-${model}-512-GRN-B`)
    expect(await gradeChangeEventsFor(device.id)).toEqual([])
  })

  it('does not block OTHER devices in the same bulk regrade when one has no catalogue match', async () => {
    const model = `TESTMODEL-${uniqueSuffix()}`
    // Device 1 CAN resolve to A; device 2 cannot (no A row for its shape).
    await insertCatalogRow({ sku: `TST-${model}-256-BLU-B`, brand: 'TESTBRAND', model, capacity: '256GB', color: 'BLUE', grade: 'B' })
    await insertCatalogRow({ sku: `TST-${model}-256-BLU-A`, brand: 'TESTBRAND', model, capacity: '256GB', color: 'BLUE', grade: 'A' })
    await insertCatalogRow({ sku: `TST-${model}-256-GOLD-B`, brand: 'TESTBRAND', model, capacity: '256GB', color: 'GOLD', grade: 'B' })
    // Deliberately NO -A row for GOLD.

    const good = await insertReceivedDevice({ sku: `TST-${model}-256-BLU-B`, grade: 'B', model, capacity: '256GB', color: 'BLUE' })
    const bad = await insertReceivedDevice({ sku: `TST-${model}-256-GOLD-B`, grade: 'B', model, capacity: '256GB', color: 'GOLD' })

    const { json } = await postGrade({ ids: [good.id, bad.id], grade: 'A' })
    expect(json.updated_count).toBe(1)
    expect(json.updated_ids).toEqual([good.id])
    expect(json.skipped.some((s: any) => s.id === bad.id)).toBe(true)

    expect((await deviceById(good.id))?.sku).toBe(`TST-${model}-256-BLU-A`)
    expect((await deviceById(bad.id))?.sku).toBe(`TST-${model}-256-GOLD-B`) // unchanged
  })
})

describe('POST /api/inventory/grade — invalidates and re-queues stale print jobs on SKU change', () => {
  it('marks the old queued job invalidated and queues a fresh one with the new SKU', async () => {
    const model = `TESTMODEL-${uniqueSuffix()}`
    await insertCatalogRow({ sku: `TST-${model}-1TB-SLV-B`, brand: 'TESTBRAND', model, capacity: '1TB', color: 'SILVER', grade: 'B' })
    await insertCatalogRow({ sku: `TST-${model}-1TB-SLV-A`, brand: 'TESTBRAND', model, capacity: '1TB', color: 'SILVER', grade: 'A' })

    const device = await insertReceivedDevice({ sku: `TST-${model}-1TB-SLV-B`, grade: 'B', model, capacity: '1TB', color: 'SILVER' })
    const oldJobId = await insertQueuedPrintJob(device.id, `TST-${model}-1TB-SLV-B`)

    await postGrade({ ids: [device.id], grade: 'A' })

    const jobs = await printJobsFor(device.id)
    const oldJob = jobs.find(j => j.id === oldJobId)
    expect(oldJob?.status).toBe('invalidated')

    const freshJobs = jobs.filter(j => j.id !== oldJobId)
    expect(freshJobs).toHaveLength(1)
    expect(freshJobs[0].status).toBe('queued')
    const payload = JSON.parse(freshJobs[0].payload_json)
    expect(payload.sku).toBe(`TST-${model}-1TB-SLV-A`)
  })

  it('leaves an already-sent print job alone (does not resurrect/invalidate printed labels)', async () => {
    const model = `TESTMODEL-${uniqueSuffix()}`
    await insertCatalogRow({ sku: `TST-${model}-128-BLK-B`, brand: 'TESTBRAND', model, capacity: '128GB', color: 'BLACK', grade: 'B' })
    await insertCatalogRow({ sku: `TST-${model}-128-BLK-C`, brand: 'TESTBRAND', model, capacity: '128GB', color: 'BLACK', grade: 'C' })

    const device = await insertReceivedDevice({ sku: `TST-${model}-128-BLK-B`, grade: 'B', model, capacity: '128GB', color: 'BLACK' })
    const sentJobId = await insertQueuedPrintJob(device.id, `TST-${model}-128-BLK-B`)
    await db().prepare(`UPDATE print_jobs SET status = 'sent' WHERE id = ?`).bind(sentJobId).run()

    await postGrade({ ids: [device.id], grade: 'C' })

    const jobs = await printJobsFor(device.id)
    const sentJob = jobs.find(j => j.id === sentJobId)
    expect(sentJob?.status).toBe('sent') // untouched
    expect(jobs.some(j => j.status === 'queued')).toBe(false) // no new job queued — nothing was queued to begin with
  })

  it('does not touch print jobs when the regrade fails closed (no catalogue match)', async () => {
    const model = `TESTMODEL-${uniqueSuffix()}`
    await insertCatalogRow({ sku: `TST-${model}-256-PNK-B`, brand: 'TESTBRAND', model, capacity: '256GB', color: 'PINK', grade: 'B' })
    // No -A row.
    const device = await insertReceivedDevice({ sku: `TST-${model}-256-PNK-B`, grade: 'B', model, capacity: '256GB', color: 'PINK' })
    const jobId = await insertQueuedPrintJob(device.id, `TST-${model}-256-PNK-B`)

    await postGrade({ ids: [device.id], grade: 'A' })

    const jobs = await printJobsFor(device.id)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].id).toBe(jobId)
    expect(jobs[0].status).toBe('queued') // unchanged — the regrade never happened
  })
})

describe('GET /api/inventory/sku-grade-consistency', () => {
  async function getConsistency() {
    const res = await app.request(
      '/api/inventory/sku-grade-consistency',
      { headers: { Authorization: `Bearer ${token}` } },
      testEnv(),
    )
    const json = (await res.json()) as Record<string, any>
    return { res, json }
  }

  it('flags a device whose SKU grade suffix disagrees with its grade column', async () => {
    const model = `TESTMODEL-${uniqueSuffix()}`
    // Simulate a pre-fix stale row: SKU still says -A but grade column is UG
    // (exactly the id-43 shape found in local D1 during this investigation).
    const device = await insertReceivedDevice({ sku: `TST-${model}-256-BLK-A`, grade: 'UG', model, capacity: '256GB', color: 'BLACK' })

    const { res, json } = await getConsistency()
    expect(res.status).toBe(200)
    const found = json.mismatches.find((m: any) => m.id === device.id)
    expect(found).toBeTruthy()
    expect(found.sku_grade_suffix).toBe('A')
    expect(found.grade).toBe('UG')
  })

  it('does not flag a device whose SKU suffix matches its grade', async () => {
    const model = `TESTMODEL-${uniqueSuffix()}`
    const device = await insertReceivedDevice({ sku: `TST-${model}-256-BLK-C`, grade: 'C', model, capacity: '256GB', color: 'BLACK' })

    const { json } = await getConsistency()
    expect(json.mismatches.some((m: any) => m.id === device.id)).toBe(false)
  })

  it('does not flag a legacy SKU with no parseable grade suffix at all', async () => {
    // Pre-migration-0007 naming: no trailing grade segment (e.g. "SMSG-S24-256-PBK").
    const device = await insertReceivedDevice({ sku: 'SMSG-LEGACYNOSUFFIX-256-PBK', grade: 'UG', model: 'GALAXY LEGACY', capacity: '256GB', color: 'PHANTOM BLACK' })

    const { json } = await getConsistency()
    expect(json.mismatches.some((m: any) => m.id === device.id)).toBe(false)
  })

  it('a successful re-grade (with SKU re-resolution) clears a previously-flagged mismatch', async () => {
    const model = `TESTMODEL-${uniqueSuffix()}`
    await insertCatalogRow({ sku: `TST-${model}-64-WHT-UG`, brand: 'TESTBRAND', model, capacity: '64GB', color: 'WHITE', grade: 'UG' })
    // Stale: sku says -A, grade column already UG (as if regraded before this fix existed).
    const device = await insertReceivedDevice({ sku: `TST-${model}-64-WHT-A`, grade: 'UG', model, capacity: '64GB', color: 'WHITE' })

    const before = await getConsistency()
    expect(before.json.mismatches.some((m: any) => m.id === device.id)).toBe(true)

    // Re-running the SAME grade through the fixed endpoint is a no-op
    // ('unchanged' skip) since grade isn't actually changing — re-resolution
    // only fires on an actual grade change. Regrade to a genuinely
    // different grade and back is the real-world remediation path; here we
    // simply prove that a grade CHANGE (UG -> A, catalogue row added first)
    // does re-resolve and clear the flag.
    await insertCatalogRow({ sku: `TST-${model}-64-WHT-A`, brand: 'TESTBRAND', model, capacity: '64GB', color: 'WHITE', grade: 'A' })
    await postGrade({ ids: [device.id], grade: 'A' })

    const after = await getConsistency()
    expect(after.json.mismatches.some((m: any) => m.id === device.id)).toBe(false)
    expect((await deviceById(device.id))?.sku).toBe(`TST-${model}-64-WHT-A`)
  })
})
