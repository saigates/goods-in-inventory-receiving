// Route-level coverage for Task X — PATCH /api/devices/:id/correct
// (2026-09-14, one-off device correction: IMEI 355178160488248 was scanned
// in with the wrong catalogue SKU/colour). See src/routes/devices.ts's
// requireOwner/CORRECTION_LOCKED_STATUSES block for the full design note.
//
// Scope: the 5 tests explicitly named by the operator —
//   1. owner -> 200, with both a device SKU_CORRECTION event AND (when the
//      caller opts in) a second event for the linked expected_devices row
//   2. non-owner -> 403, zero writes
//   3. a committed (exported) device -> 409, zero writes
//   4. an off-catalogue SKU -> 422, zero writes
//   5. an IMEI edit attempt -> rejected, zero writes
// Plus a couple of supporting checks (colour/grade derived from SKU,
// print-job invalidation, prompt-not-cascade default behaviour) that
// exercise the same route without duplicating the 5 named cases.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, it, expect } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'
import type { AuthUser, DeviceStatus } from '../src/types'

const JWT_SECRET = 'test-secret-device-correct-route'
const testEnv = { ...env, JWT_SECRET } as typeof env & { JWT_SECRET: string }
const db = () => (env as unknown as { DB: D1Database }).DB

const ADMIN_USER: AuthUser = {
  id: 701, email: 'admin-correct@example.com', name: 'Correct-Route Admin', role: 'admin', organisation_id: 1,
}
const MANAGER_USER: AuthUser = {
  id: 702, email: 'manager-correct@example.com', name: 'Correct-Route Manager', role: 'manager', organisation_id: 1,
}
const OPERATOR_USER: AuthUser = {
  id: 703, email: 'operator-correct@example.com', name: 'Correct-Route Operator', role: 'operator', organisation_id: 1,
}

// Distinct IMEI range from every other suite (base 38000...) to avoid
// UNIQUE collisions if files ever share a D1 instance (same convention as
// devicesRejectRoute.spec.ts's 37000... base).
let nextImei = 380000000000001
function newImei(): string {
  return String(nextImei++)
}
let seq = 0
function uniqueSuffix(): string {
  seq += 1
  return `${Date.now().toString(36)}${seq}`
}

beforeEach(async () => {
  for (const user of [ADMIN_USER, MANAGER_USER, OPERATOR_USER]) {
    await db()
      .prepare(`INSERT OR IGNORE INTO users (id, email, name, role, organisation_id) VALUES (?, ?, ?, ?, ?)`)
      .bind(user.id, user.email, user.name, user.role, user.organisation_id)
      .run()
  }
})

// Two catalogue rows, same model/capacity/grade, different colour — the
// "wrong colour, same everything else" shape of the real motivating
// incident (IMEI 355178160488248: MIDNIGHT catalogued, should be another
// colour).
async function insertCatalogRow(row: {
  sku: string; brand: string; model: string; capacity: string; color: string; grade: string
}) {
  await db().prepare(
    `INSERT OR IGNORE INTO sku_catalog (organisation_id, sku, brand, model, capacity, color, grade)
     VALUES (1, ?, ?, ?, ?, ?, ?)`
  ).bind(row.sku, row.brand, row.model, row.capacity, row.color, row.grade).run()
}

async function seedDevice(opts: {
  sku: string; brand: string; model: string; capacity: string; color: string; grade: string
  status?: DeviceStatus; expectedDeviceId?: number
}): Promise<{ id: number; imei: string; uuid: string }> {
  const imei = newImei()
  const uuid = `correct-route-test-uuid-${imei}`
  const result = await db()
    .prepare(
      `INSERT INTO received_devices
         (organisation_id, uuid, imei, sku, brand, model, capacity, color, grade, source, status, expected_device_id)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 'manifest', ?, ?)`
    )
    .bind(uuid, imei, opts.sku, opts.brand, opts.model, opts.capacity, opts.color, opts.grade, opts.status ?? 'RECEIVED', opts.expectedDeviceId ?? null)
    .run()
  return { id: result.meta.last_row_id as number, imei, uuid }
}

async function seedExpectedDevice(opts: { manifestId: number; imei: string; sku: string }): Promise<number> {
  const result = await db()
    .prepare(
      `INSERT INTO expected_devices (organisation_id, manifest_id, imei, sku, status) VALUES (1, ?, ?, ?, 'received')`
    )
    .bind(opts.manifestId, opts.imei, opts.sku)
    .run()
  return result.meta.last_row_id as number
}

async function seedManifest(): Promise<number> {
  const suffix = uniqueSuffix()
  const result = await db()
    .prepare(`INSERT INTO manifests (organisation_id, reference, supplier, status) VALUES (1, ?, 'Test Supplier', 'open')`)
    .bind(`correct-route-test-${suffix}`)
    .run()
  return result.meta.last_row_id as number
}

async function deviceRow(id: number): Promise<Record<string, unknown> | undefined> {
  return (await db().prepare('SELECT * FROM received_devices WHERE id = ?').bind(id).first()) as any
}

async function eventsFor(deviceId: number) {
  const { results } = await db().prepare(
    'SELECT * FROM device_events WHERE device_id = ? ORDER BY id ASC'
  ).bind(deviceId).all<Record<string, unknown>>()
  return results
}

async function apiAs(user: AuthUser, path: string, init: RequestInit = {}) {
  const token = await signAuthToken(JWT_SECRET, user)
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  }, testEnv)
}

describe('PATCH /api/devices/:id/correct', () => {
  // ── Test 1 (named): owner -> 200 with both events ──
  it('owner performs a correction -> 200, device fields updated from the catalogue row, and (with opt-in) the linked manifest line gets its OWN second event', async () => {
    const suffix = uniqueSuffix()
    await insertCatalogRow({ sku: `TEST-CORRECT-WRONG-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTX', capacity: '128GB', color: 'MIDNIGHT', grade: 'A' })
    await insertCatalogRow({ sku: `TEST-CORRECT-RIGHT-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTX', capacity: '128GB', color: 'STARLIGHT', grade: 'A' })

    const manifestId = await seedManifest()
    const device = await seedDevice({
      sku: `TEST-CORRECT-WRONG-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTX', capacity: '128GB', color: 'MIDNIGHT', grade: 'A',
    })
    const expectedId = await seedExpectedDevice({ manifestId, imei: device.imei, sku: `TEST-CORRECT-WRONG-${suffix}` })
    await db().prepare('UPDATE received_devices SET expected_device_id = ? WHERE id = ?').bind(expectedId, device.id).run()

    // No opt-in on this call — expect the manifest-line mismatch surfaced
    // in the response, NOT silently cascaded (prompt-not-cascade default).
    const res = await apiAs(ADMIN_USER, `/api/devices/${device.id}/correct`, {
      method: 'PATCH',
      body: JSON.stringify({ sku: `TEST-CORRECT-RIGHT-${suffix}`, reason: 'wrong colour scanned in, corrected per manifest re-check' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(body.device.sku).toBe(`TEST-CORRECT-RIGHT-${suffix}`)
    expect(body.device.color).toBe('STARLIGHT')
    expect(body.device.grade).toBe('A')
    expect(body.manifest_line_also_wrong).toBe(true)
    expect(body.manifest_line).toMatchObject({ id: expectedId, sku: `TEST-CORRECT-WRONG-${suffix}` })

    const row = await deviceRow(device.id)
    expect(row?.sku).toBe(`TEST-CORRECT-RIGHT-${suffix}`)
    expect(row?.color).toBe('STARLIGHT')

    const events = await eventsFor(device.id)
    expect(events.length).toBe(1)
    expect(events[0].event_type).toBe('SKU_CORRECTION')
    const meta = JSON.parse(String(events[0].metadata))
    expect(meta).toMatchObject({
      old_sku: `TEST-CORRECT-WRONG-${suffix}`, new_sku: `TEST-CORRECT-RIGHT-${suffix}`,
      old_color: 'MIDNIGHT', new_color: 'STARLIGHT',
      reason: 'wrong colour scanned in, corrected per manifest re-check',
    })

    // Manifest line itself untouched — cascade requires its own opt-in
    // call, covered by the dedicated test right below.
    const expectedRowAfter = await db().prepare('SELECT sku FROM expected_devices WHERE id = ?').bind(expectedId).first<{ sku: string }>()
    expect(expectedRowAfter?.sku).toBe(`TEST-CORRECT-WRONG-${suffix}`)
  })

  it('owner correction with also_correct_manifest_line=true on a genuinely mismatched pair writes a SECOND event for the manifest line, in the SAME call', async () => {
    const suffix = uniqueSuffix()
    await insertCatalogRow({ sku: `TEST-CASCADE-WRONG-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTY', capacity: '256GB', color: 'MIDNIGHT', grade: 'B' })
    await insertCatalogRow({ sku: `TEST-CASCADE-RIGHT-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTY', capacity: '256GB', color: 'PINK', grade: 'B' })

    const manifestId = await seedManifest()
    const device = await seedDevice({
      sku: `TEST-CASCADE-WRONG-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTY', capacity: '256GB', color: 'MIDNIGHT', grade: 'B',
    })
    const expectedId = await seedExpectedDevice({ manifestId, imei: device.imei, sku: `TEST-CASCADE-WRONG-${suffix}` })
    await db().prepare('UPDATE received_devices SET expected_device_id = ? WHERE id = ?').bind(expectedId, device.id).run()

    const res = await apiAs(ADMIN_USER, `/api/devices/${device.id}/correct`, {
      method: 'PATCH',
      body: JSON.stringify({ sku: `TEST-CASCADE-RIGHT-${suffix}`, reason: 'wrong colour, also fix manifest', also_correct_manifest_line: true }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.manifest_line_also_wrong).toBe(false) // resolved within this same call

    const expectedRowAfter = await db().prepare('SELECT sku FROM expected_devices WHERE id = ?').bind(expectedId).first<{ sku: string }>()
    expect(expectedRowAfter?.sku).toBe(`TEST-CASCADE-RIGHT-${suffix}`)

    const events = await eventsFor(device.id)
    expect(events.length).toBe(2)
    expect(events[0].event_type).toBe('SKU_CORRECTION')
    expect(events[1].event_type).toBe('SKU_CORRECTION')
    const meta1 = JSON.parse(String(events[0].metadata))
    const meta2 = JSON.parse(String(events[1].metadata))
    expect(meta1.target).toBeUndefined() // first event = the device-row correction
    expect(meta2).toMatchObject({ target: 'expected_devices', expected_device_id: expectedId, new_sku: `TEST-CASCADE-RIGHT-${suffix}` })
  })

  // ── Test 2 (named): non-owner -> 403, zero writes ──
  it('non-owner (manager) attempting a correction -> 403, zero writes', async () => {
    const suffix = uniqueSuffix()
    await insertCatalogRow({ sku: `TEST-NONOWNER-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTZ', capacity: '128GB', color: 'BLUE', grade: 'A' })
    const device = await seedDevice({ sku: 'TEST-STALE-SKU', brand: 'APPLE', model: 'IPHONE TESTZ', capacity: '128GB', color: 'RED', grade: 'A' })

    const resManager = await apiAs(MANAGER_USER, `/api/devices/${device.id}/correct`, {
      method: 'PATCH',
      body: JSON.stringify({ sku: `TEST-NONOWNER-${suffix}`, reason: 'attempted by a manager, not the owner' }),
    })
    expect(resManager.status).toBe(403)

    const resOperator = await apiAs(OPERATOR_USER, `/api/devices/${device.id}/correct`, {
      method: 'PATCH',
      body: JSON.stringify({ sku: `TEST-NONOWNER-${suffix}`, reason: 'attempted by an operator, not the owner' }),
    })
    expect(resOperator.status).toBe(403)

    const row = await deviceRow(device.id)
    expect(row?.sku).toBe('TEST-STALE-SKU') // unchanged
    expect((await eventsFor(device.id)).length).toBe(0)
  })

  // ── Test 3 (named): committed (exported) device -> 409, zero writes ──
  it('device already EXPORTED_UNDER_OPR -> 409, zero writes', async () => {
    const suffix = uniqueSuffix()
    await insertCatalogRow({ sku: `TEST-EXPORTED-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTW', capacity: '128GB', color: 'GREEN', grade: 'A' })
    const device = await seedDevice({
      sku: 'TEST-STALE-EXPORTED-SKU', brand: 'APPLE', model: 'IPHONE TESTW', capacity: '128GB', color: 'RED', grade: 'A',
      status: 'EXPORTED_UNDER_OPR',
    })

    const res = await apiAs(ADMIN_USER, `/api/devices/${device.id}/correct`, {
      method: 'PATCH',
      body: JSON.stringify({ sku: `TEST-EXPORTED-${suffix}`, reason: 'attempted on an exported device' }),
    })
    expect(res.status).toBe(409)

    const row = await deviceRow(device.id)
    expect(row?.sku).toBe('TEST-STALE-EXPORTED-SKU') // unchanged
    expect((await eventsFor(device.id)).length).toBe(0)
  })

  it('device already SOLD -> 409, zero writes (SOLD is committed even though it is not an OPR_WORKFLOW_ONLY_STATUS)', async () => {
    const suffix = uniqueSuffix()
    await insertCatalogRow({ sku: `TEST-SOLD-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTV', capacity: '128GB', color: 'GREEN', grade: 'A' })
    const device = await seedDevice({
      sku: 'TEST-STALE-SOLD-SKU', brand: 'APPLE', model: 'IPHONE TESTV', capacity: '128GB', color: 'RED', grade: 'A',
      status: 'SOLD',
    })

    const res = await apiAs(ADMIN_USER, `/api/devices/${device.id}/correct`, {
      method: 'PATCH',
      body: JSON.stringify({ sku: `TEST-SOLD-${suffix}`, reason: 'attempted on a sold device' }),
    })
    expect(res.status).toBe(409)
    expect((await eventsFor(device.id)).length).toBe(0)
  })

  // ── Zoho-push gate (added 2026-09-14, master-checklist review) ──
  // "Pushed to Zoho" is not a received_devices.status value — it is
  // repair_jobs.closed_at, stamped by closeToInventory() when a human
  // confirms the manual Zoho upload. A device in that state has already
  // moved on to ACTIVE_INVENTORY (correctable by status alone), so the
  // route must check repair_jobs directly, not just device.status.
  it('device with a CLOSED repair job (pushed to Zoho) -> 409, zero writes, even though its status (ACTIVE_INVENTORY) is not itself locked', async () => {
    const suffix = uniqueSuffix()
    await insertCatalogRow({ sku: `TEST-ZOHOPUSHED-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTP', capacity: '128GB', color: 'GREEN', grade: 'A' })
    const device = await seedDevice({
      sku: 'TEST-STALE-ZOHOPUSHED-SKU', brand: 'APPLE', model: 'IPHONE TESTP', capacity: '128GB', color: 'RED', grade: 'A',
      status: 'ACTIVE_INVENTORY',
    })
    await db().prepare(
      `INSERT INTO repair_jobs (organisation_id, device_id, imei, fault_code, status, qc_result, closed_at)
       VALUES (1, ?, ?, 'screen', 'completed', 'PASSED', CURRENT_TIMESTAMP)`
    ).bind(device.id, device.imei).run()

    const res = await apiAs(ADMIN_USER, `/api/devices/${device.id}/correct`, {
      method: 'PATCH',
      body: JSON.stringify({ sku: `TEST-ZOHOPUSHED-${suffix}`, reason: 'attempted on a device already pushed to Zoho' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json() as any
    expect(body.error).toMatch(/pushed to Zoho/i)

    const row = await deviceRow(device.id)
    expect(row?.sku).toBe('TEST-STALE-ZOHOPUSHED-SKU') // unchanged
    expect((await eventsFor(device.id)).length).toBe(0)
  })

  it('device with an OPEN (not yet closed) repair job is still correctable — only a CLOSED job blocks', async () => {
    const suffix = uniqueSuffix()
    await insertCatalogRow({ sku: `TEST-ZOHOOPEN-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTO', capacity: '128GB', color: 'GREEN', grade: 'A' })
    const device = await seedDevice({
      sku: 'TEST-STALE-ZOHOOPEN-SKU', brand: 'APPLE', model: 'IPHONE TESTO', capacity: '128GB', color: 'RED', grade: 'A',
      status: 'READY_FOR_ZOHO',
    })
    await db().prepare(
      `INSERT INTO repair_jobs (organisation_id, device_id, imei, fault_code, status, qc_result)
       VALUES (1, ?, ?, 'screen', 'completed', 'PASSED')`
    ).bind(device.id, device.imei).run()

    const res = await apiAs(ADMIN_USER, `/api/devices/${device.id}/correct`, {
      method: 'PATCH',
      body: JSON.stringify({ sku: `TEST-ZOHOOPEN-${suffix}`, reason: 'correcting before Zoho upload is confirmed' }),
    })
    expect(res.status).toBe(200)
  })

  // ── Test 4 (named): off-catalogue SKU -> 422, zero writes ──
  it('SKU not present in the catalogue -> 422, zero writes', async () => {
    const suffix = uniqueSuffix()
    const device = await seedDevice({ sku: 'TEST-STALE-OFFCATALOGUE-SKU', brand: 'APPLE', model: 'IPHONE TESTU', capacity: '128GB', color: 'RED', grade: 'A' })

    const res = await apiAs(ADMIN_USER, `/api/devices/${device.id}/correct`, {
      method: 'PATCH',
      body: JSON.stringify({ sku: `TEST-DOES-NOT-EXIST-${suffix}`, reason: 'made-up sku not in the catalogue' }),
    })
    expect(res.status).toBe(422)

    const row = await deviceRow(device.id)
    expect(row?.sku).toBe('TEST-STALE-OFFCATALOGUE-SKU') // unchanged
    expect((await eventsFor(device.id)).length).toBe(0)
  })

  // ── Test 5 (named): IMEI edit attempt -> rejected, zero writes ──
  it('attempting to include imei in the body -> rejected (422), zero writes, regardless of catalogue validity', async () => {
    const suffix = uniqueSuffix()
    await insertCatalogRow({ sku: `TEST-IMEIGUARD-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTT', capacity: '128GB', color: 'GREEN', grade: 'A' })
    const device = await seedDevice({ sku: 'TEST-STALE-IMEIGUARD-SKU', brand: 'APPLE', model: 'IPHONE TESTT', capacity: '128GB', color: 'RED', grade: 'A' })

    const res = await apiAs(ADMIN_USER, `/api/devices/${device.id}/correct`, {
      method: 'PATCH',
      body: JSON.stringify({ sku: `TEST-IMEIGUARD-${suffix}`, reason: 'attempting to also change imei', imei: '999999999999999' }),
    })
    expect(res.status).toBe(422)

    const row = await deviceRow(device.id)
    expect(row?.imei).toBe(device.imei) // unchanged
    expect(row?.sku).toBe('TEST-STALE-IMEIGUARD-SKU') // unchanged — whole request rejected, not partially applied
    expect((await eventsFor(device.id)).length).toBe(0)
  })

  // ── Supporting checks (not among the 5 named, but exercise the same route) ──
  it('missing reason -> 422, zero writes', async () => {
    const suffix = uniqueSuffix()
    await insertCatalogRow({ sku: `TEST-NOREASON-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTS', capacity: '128GB', color: 'GREEN', grade: 'A' })
    const device = await seedDevice({ sku: 'TEST-STALE-NOREASON-SKU', brand: 'APPLE', model: 'IPHONE TESTS', capacity: '128GB', color: 'RED', grade: 'A' })

    const res = await apiAs(ADMIN_USER, `/api/devices/${device.id}/correct`, {
      method: 'PATCH',
      body: JSON.stringify({ sku: `TEST-NOREASON-${suffix}` }),
    })
    expect(res.status).toBe(422)
    expect((await eventsFor(device.id)).length).toBe(0)
  })

  it('queued print job for the device is invalidated and a fresh one queued with the corrected payload', async () => {
    const suffix = uniqueSuffix()
    await insertCatalogRow({ sku: `TEST-PRINTJOB-RIGHT-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTR', capacity: '128GB', color: 'PINK', grade: 'A' })
    const device = await seedDevice({ sku: 'TEST-STALE-PRINTJOB-SKU', brand: 'APPLE', model: 'IPHONE TESTR', capacity: '128GB', color: 'MIDNIGHT', grade: 'A' })

    const jobResult = await db().prepare(
      `INSERT INTO print_jobs (organisation_id, received_device_id, payload_json, status) VALUES (1, ?, '{}', 'queued')`
    ).bind(device.id).run()
    const oldJobId = jobResult.meta.last_row_id as number

    const res = await apiAs(ADMIN_USER, `/api/devices/${device.id}/correct`, {
      method: 'PATCH',
      body: JSON.stringify({ sku: `TEST-PRINTJOB-RIGHT-${suffix}`, reason: 'wrong colour, printed label would be wrong too' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.print_jobs_invalidated).toBe(1)

    const oldJob = await db().prepare('SELECT status FROM print_jobs WHERE id = ?').bind(oldJobId).first<{ status: string }>()
    expect(oldJob?.status).toBe('invalidated')

    const { results: freshJobs } = await db().prepare(
      `SELECT payload_json FROM print_jobs WHERE received_device_id = ? AND status = 'queued'`
    ).bind(device.id).all<{ payload_json: string }>()
    expect(freshJobs.length).toBe(1)
    const payload = JSON.parse(freshJobs[0].payload_json)
    expect(payload.sku).toBe(`TEST-PRINTJOB-RIGHT-${suffix}`)
    expect(payload.color).toBe('PINK')
  })

  it('a REJECTED device is still correctable (REJECTED is pre-commitment, not in CORRECTION_LOCKED_STATUSES)', async () => {
    const suffix = uniqueSuffix()
    await insertCatalogRow({ sku: `TEST-REJECTED-OK-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTQ', capacity: '128GB', color: 'BLUE', grade: 'A' })
    const device = await seedDevice({
      sku: 'TEST-STALE-REJECTED-SKU', brand: 'APPLE', model: 'IPHONE TESTQ', capacity: '128GB', color: 'RED', grade: 'A',
      status: 'REJECTED',
    })

    const res = await apiAs(ADMIN_USER, `/api/devices/${device.id}/correct`, {
      method: 'PATCH',
      body: JSON.stringify({ sku: `TEST-REJECTED-OK-${suffix}`, reason: 'correcting a rejected device catalogue line' }),
    })
    expect(res.status).toBe(200)
  })
})
