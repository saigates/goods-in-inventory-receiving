// Device Lifecycle slice 1 — repair-workflow + Zoho upload-queue test bodies
// (approved draft list #15–37, see docs/plan/device-lifecycle-slice1.md
// section "Test plan", C. and D., renumbered to insert three net-new items:
// #22 QC-FAILED-needs-reason, #28 no-generic-HOLD, #37 ERP-webhook-absent).
//
// STATUS: TEST BODIES ONLY, per explicit instruction. No schema, no
// migration, no `repair_jobs` table, no application-code implementation
// exists yet for ANY of this (confirmed by zero-match grep for
// repair_jobs/READY_FOR_ZOHO/QC_FAILED/zoho across src/, migrations/, and
// pre-existing test/ files). Every test below documents the EXPECTED
// (not-yet-built) contract so it can drive implementation later; the large
// majority are expected to fail against current code, and that is the
// correct, honest outcome of this file — see the pass/fail report
// delivered alongside this commit for the per-test categorization
// (missing coverage vs defect vs fixture issue). DO NOT "fix" a failure
// here by loosening an assertion — the assertions encode the agreed
// design; only real implementation should make them pass.
//
// ASSUMED (not yet confirmed/committed) API surface — this file's own
// working hypothesis, modelled on the existing devices.ts /
// opr.ts route conventions (POST .../:id/<verb>, JSON body, 201/409/422
// error shape). Subject to revision when implementation is authorised —
// nothing here binds the eventual real contract:
//   POST /api/devices/:id/repair/start        { fault_code }
//   POST /api/devices/:id/repair/scan-back    {}
//   POST /api/devices/:id/repair/qc           { result: 'PASSED'|'FAILED', reason? }
//   POST /api/devices/:id/repair/cost         { repair_cost_gbp, parts_cost_gbp, labour_cost_gbp, cost_source, cost_source_reference }
//   POST /api/zoho/batches                    { device_ids: number[] }
//   GET  /api/zoho/batches/:id
//   POST /api/zoho/batches/:id/confirm        {}
//   POST /api/zoho/batches/:id/fail           { reason? }
//
// Fixture placeholders per the agreed instruction:
//   - fault code: present-and-non-empty free text, no controlled list
//   - QC role: manager-only (current placeholder — must NOT be hard-coded
//     against a future separate QC role; tests assert against 'manager'
//     specifically being allowed and 'operator' specifically being refused)
//   - Zoho format: one row per IMEI, no aggregation
//   - SKU mapping check: existence-only (received_devices.sku resolves in
//     sku_catalog for the org — reusing the seeded catalog, no new table)
//   - ERP: absent — no fixture, no route, no table, no field (see #37)

import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'
import type { AuthUser, DeviceStatus } from '../src/types'

const JWT_SECRET = 'test-secret-repair-workflow'
const testEnv = { ...env, JWT_SECRET } as typeof env & { JWT_SECRET: string }
const db = () => (env as unknown as { DB: D1Database }).DB

const ADMIN_USER: AuthUser = {
  id: 1, email: 'admin@goodsin.local', name: 'Seed Admin', role: 'admin', organisation_id: 1,
}
// Placeholder QC-manager-only fixtures (see file header note above).
const MANAGER_USER: AuthUser = {
  id: 501, email: 'manager-rw@example.com', name: 'RW Manager', role: 'manager', organisation_id: 1,
}
const OPERATOR_USER: AuthUser = {
  id: 502, email: 'operator-rw@example.com', name: 'RW Operator', role: 'operator', organisation_id: 1,
}

let nextImei = 360000000000001

// Distinct IMEI range from every other suite (base 36000...) to avoid
// UNIQUE collisions if files ever share a D1 instance.
function newImei(): string {
  return String(nextImei++)
}

// Seeds a received_devices row directly (bypassing the API), same pattern
// as test/deviceLifecycle.spec.ts#seedDevice.
//
// Correction (2026-08-11): the previous comment here claimed the default
// SKU "already exists in the seeded sku_catalog (see seed.sql)". That was
// false in the test environment — test/apply-migrations.ts runs
// applyD1Migrations() against ./migrations only; seed.sql is never loaded
// by the test harness (confirmed: zero-match grep for a seed.sql load call
// anywhere under test/). 'SMSG-S24-256-PBK' is inserted only by seed.sql,
// so against the migrated-only test catalogue it has no mapping, which
// silently broke #24/#29 once the separate missing-model defect was fixed.
//
// The default is now 'SAM-S26-256-CVT-A' — a SKU migration 0017 actually
// inserts (migrations/0017_catalog_case_normalize_and_expand.sql:354), so
// the comment's claim is true of the environment the tests really run in.
// It also carries a grade suffix ('-A'), which the SKU catalogue's other
// legacy-shape rows (e.g. the old '-PBK' colour-suffix SKUs) do not — the
// planned sixth READY_FOR_ZOHO gate condition parses that suffix, so the
// default fixture SKU needs to have one.
//
// Pass sku: 'UNMAPPED-SKU-NOT-IN-CATALOG' explicitly for the missing-SKU
// case.
async function seedDevice(
  status: DeviceStatus,
  opts: { sku?: string; organisationId?: number; model?: string } = {},
): Promise<number> {
  const imei = newImei()
  const uuid = `repair-test-uuid-${imei}`
  const sku = opts.sku ?? 'SAM-S26-256-CVT-A'
  const organisationId = opts.organisationId ?? 1
  // model is required by checkReadyForZohoGate's condition 3
  // (src/lib/repairWorkflow.ts:127) — set a non-null value here so
  // gate-condition tests exercise the SKU/movement checks (4-5) rather
  // than failing on the earlier, unrelated model check.
  const model = opts.model ?? 'Galaxy S24'
  const result = await db()
    .prepare(
      `INSERT INTO received_devices
         (organisation_id, uuid, imei, sku, model, source, status)
       VALUES (?, ?, ?, ?, ?, 'manual', ?)`
    )
    .bind(organisationId, uuid, imei, sku, model, status)
    .run()
  return result.meta.last_row_id as number
}

async function deviceStatus(deviceId: number): Promise<string | undefined> {
  const row = await db()
    .prepare('SELECT status FROM received_devices WHERE id = ?')
    .bind(deviceId)
    .first<{ status: string }>()
  return row?.status
}

async function eventsFor(deviceId: number) {
  const { results } = await db()
    .prepare('SELECT * FROM device_events WHERE device_id = ? ORDER BY id ASC')
    .bind(deviceId)
    .all<Record<string, unknown>>()
  return results
}

// Will throw D1_ERROR: no such table: repair_jobs until the migration
// exists — that throw IS the correct, honest signal for this phase (see
// file header). Tests that need "no repair_jobs row created" call this and
// let a throw count as a failure, rather than swallowing it.
async function repairJobsFor(deviceId: number) {
  const { results } = await db()
    .prepare('SELECT * FROM repair_jobs WHERE device_id = ? ORDER BY id ASC')
    .bind(deviceId)
    .all<Record<string, unknown>>()
  return results
}

async function repairJobsCount(): Promise<number> {
  const row = await db().prepare('SELECT COUNT(*) AS n FROM repair_jobs').first<{ n: number }>()
  return row!.n
}

async function tokenFor(user: AuthUser) {
  return signAuthToken(JWT_SECRET, user)
}

async function apiAs(user: AuthUser, path: string, init: RequestInit = {}) {
  const token = await tokenFor(user)
  return app.request(
    path,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    },
    testEnv,
  )
}

const api = (path: string, init: RequestInit = {}) => apiAs(ADMIN_USER, path, init)

beforeEach(async () => {
  // Manager/operator fixtures needed for the role-gating tests (#29, #33).
  // FK-enforced on device_events.user_id, so these must be real rows.
  await db()
    .prepare(`INSERT OR IGNORE INTO users (id, email, name, role, organisation_id) VALUES (?, ?, ?, ?, ?)`)
    .bind(MANAGER_USER.id, MANAGER_USER.email, MANAGER_USER.name, MANAGER_USER.role, MANAGER_USER.organisation_id)
    .run()
  await db()
    .prepare(`INSERT OR IGNORE INTO users (id, email, name, role, organisation_id) VALUES (?, ?, ?, ?, ?)`)
    .bind(OPERATOR_USER.id, OPERATOR_USER.email, OPERATOR_USER.name, OPERATOR_USER.role, OPERATOR_USER.organisation_id)
    .run()
})

// ═══════════════════════════════════════════════════════════════════════
// C. Repair-workflow tests (#15–29)
// ═══════════════════════════════════════════════════════════════════════

describe('C. repair workflow — start repair (#15–19)', () => {
  it('#15 start repair with unknown/invalid IMEI → 404/422, no repair_jobs row created', async () => {
    const res = await api('/api/devices/999999/repair/start', {
      method: 'POST',
      body: JSON.stringify({ fault_code: 'SCREEN_CRACKED' }),
    })
    expect([404, 422]).toContain(res.status)
    expect(await repairJobsCount()).toBe(0)
  })

  it('#16 start repair without a fault code → 422, no repair_jobs row created', async () => {
    const deviceId = await seedDevice('SORTING')
    const res = await api(`/api/devices/${deviceId}/repair/start`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(422)
    expect(await repairJobsFor(deviceId)).toHaveLength(0)
    expect(await deviceStatus(deviceId)).toBe('SORTING')
  })

  it('#17 start repair on a device with an already-open repair job → 409, no second row, existing job unchanged', async () => {
    const deviceId = await seedDevice('SORTING')
    const first = await api(`/api/devices/${deviceId}/repair/start`, {
      method: 'POST',
      body: JSON.stringify({ fault_code: 'SCREEN_CRACKED' }),
    })
    expect(first.status).toBe(201)
    const beforeSecond = await repairJobsFor(deviceId)

    const second = await api(`/api/devices/${deviceId}/repair/start`, {
      method: 'POST',
      body: JSON.stringify({ fault_code: 'BATTERY_FAULT' }),
    })
    expect(second.status).toBe(409)

    const afterSecond = await repairJobsFor(deviceId)
    expect(afterSecond).toHaveLength(1)
    expect(afterSecond).toEqual(beforeSecond)
  })

  it.each(['SOLD', 'EXPORTED_UNDER_OPR', 'RETURNED_UNDER_OPR'] as DeviceStatus[])(
    '#18 start repair on a %s device → 409, no repair_jobs row, device status unchanged',
    async (status) => {
      const deviceId = await seedDevice(status)
      const res = await api(`/api/devices/${deviceId}/repair/start`, {
        method: 'POST',
        body: JSON.stringify({ fault_code: 'SCREEN_CRACKED' }),
      })
      expect(res.status).toBe(409)
      expect(await repairJobsFor(deviceId)).toHaveLength(0)
      expect(await deviceStatus(deviceId)).toBe(status)
    },
  )

  it('#19 start repair on a valid device with a fault code → 201, repair_jobs row (7 cost fields present-but-null), device → IN_HOUSE_REPAIR, exactly one new device_events row', async () => {
    const deviceId = await seedDevice('SORTING')
    const res = await api(`/api/devices/${deviceId}/repair/start`, {
      method: 'POST',
      body: JSON.stringify({ fault_code: 'SCREEN_CRACKED' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { repair_job: Record<string, unknown> }

    expect(await deviceStatus(deviceId)).toBe('IN_HOUSE_REPAIR')

    const jobs = await repairJobsFor(deviceId)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ device_id: deviceId, fault_code: 'SCREEN_CRACKED' })
    // The 7 confirmed cost fields (docs/plan/device-lifecycle-slice1.md
    // "Amendment 1 resolution") must exist as columns, null until costed.
    for (const field of [
      'repair_cost_gbp', 'parts_cost_gbp', 'labour_cost_gbp',
      'cost_source', 'cost_source_reference', 'cost_recorded_at', 'cost_recorded_by',
    ]) {
      expect(jobs[0]).toHaveProperty(field, null)
    }
    expect(body.repair_job).toMatchObject({ device_id: deviceId })

    const events = await eventsFor(deviceId)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ from_status: 'SORTING', to_status: 'IN_HOUSE_REPAIR' })
  })
})

describe('C. repair workflow — scan-back and QC (#20–25, incl. NEW #22)', () => {
  it('#20 scan-back with no open repair job → 409, no state change', async () => {
    const deviceId = await seedDevice('ACTIVE_INVENTORY')
    const res = await api(`/api/devices/${deviceId}/repair/scan-back`, { method: 'POST', body: JSON.stringify({}) })
    expect(res.status).toBe(409)
    expect(await deviceStatus(deviceId)).toBe('ACTIVE_INVENTORY')
  })

  it('#21 scan-back with an open job, QC not yet recorded → job enters "awaiting QC", device remains IN_HOUSE_REPAIR', async () => {
    const deviceId = await seedDevice('SORTING')
    await api(`/api/devices/${deviceId}/repair/start`, { method: 'POST', body: JSON.stringify({ fault_code: 'SCREEN_CRACKED' }) })

    const res = await api(`/api/devices/${deviceId}/repair/scan-back`, { method: 'POST', body: JSON.stringify({}) })
    expect(res.status).toBe(200)

    expect(await deviceStatus(deviceId)).toBe('IN_HOUSE_REPAIR')
    const jobs = await repairJobsFor(deviceId)
    expect(jobs[0]).toMatchObject({ qc_result: 'PENDING' })
    expect(jobs[0]).toMatchObject({ status: 'awaiting_qc' })
  })

  // #22 (NEW, net-new item this segment)
  it('#22 recording QC FAILED without a reason → 422, device stays IN_HOUSE_REPAIR, no transition', async () => {
    const deviceId = await seedDevice('SORTING')
    await api(`/api/devices/${deviceId}/repair/start`, { method: 'POST', body: JSON.stringify({ fault_code: 'SCREEN_CRACKED' }) })
    await api(`/api/devices/${deviceId}/repair/scan-back`, { method: 'POST', body: JSON.stringify({}) })

    const before = await eventsFor(deviceId)
    const res = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/repair/qc`, {
      method: 'POST',
      body: JSON.stringify({ result: 'FAILED' }), // reason omitted — must be rejected
    })
    expect(res.status).toBe(422)
    expect(await deviceStatus(deviceId)).toBe('IN_HOUSE_REPAIR')
    expect(await eventsFor(deviceId)).toEqual(before) // no new event written
  })

  it('#23 recording QC FAILED with a reason → device → QC_FAILED, qc_result+reason stored, one device_events row, does NOT reach READY_FOR_ZOHO', async () => {
    const deviceId = await seedDevice('SORTING')
    await api(`/api/devices/${deviceId}/repair/start`, { method: 'POST', body: JSON.stringify({ fault_code: 'SCREEN_CRACKED' }) })
    await api(`/api/devices/${deviceId}/repair/scan-back`, { method: 'POST', body: JSON.stringify({}) })
    const beforeEvents = await eventsFor(deviceId)

    const res = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/repair/qc`, {
      method: 'POST',
      body: JSON.stringify({ result: 'FAILED', reason: 'Screen replacement did not resolve digitiser fault' }),
    })
    expect(res.status).toBe(200)

    expect(await deviceStatus(deviceId)).toBe('QC_FAILED')
    expect(await deviceStatus(deviceId)).not.toBe('READY_FOR_ZOHO')

    const jobs = await repairJobsFor(deviceId)
    expect(jobs[0]).toMatchObject({
      qc_result: 'FAILED',
      qc_fail_reason: 'Screen replacement did not resolve digitiser fault',
    })

    const afterEvents = await eventsFor(deviceId)
    expect(afterEvents).toHaveLength(beforeEvents.length + 1)
    expect(afterEvents[afterEvents.length - 1]).toMatchObject({
      from_status: 'IN_HOUSE_REPAIR', to_status: 'QC_FAILED',
    })
  })

  it('#24 recording QC PASSED → device → READY_FOR_ZOHO only if all five gate conditions met', async () => {
    const deviceId = await seedDevice('SORTING')
    await api(`/api/devices/${deviceId}/repair/start`, { method: 'POST', body: JSON.stringify({ fault_code: 'SCREEN_CRACKED' }) })
    await api(`/api/devices/${deviceId}/repair/scan-back`, { method: 'POST', body: JSON.stringify({}) })
    const beforeEvents = await eventsFor(deviceId)

    const res = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/repair/qc`, {
      method: 'POST',
      body: JSON.stringify({ result: 'PASSED' }),
    })
    expect(res.status).toBe(200)

    expect(await deviceStatus(deviceId)).toBe('READY_FOR_ZOHO')
    const jobs = await repairJobsFor(deviceId)
    expect(jobs[0]).toMatchObject({ qc_result: 'PASSED' })

    const afterEvents = await eventsFor(deviceId)
    expect(afterEvents).toHaveLength(beforeEvents.length + 1)
    expect(afterEvents[afterEvents.length - 1]).toMatchObject({
      from_status: 'IN_HOUSE_REPAIR', to_status: 'READY_FOR_ZOHO',
    })
  })

  it('#25 QC PASSED but SKU mapping missing → transition blocked, error names the unmet gate condition, device stays IN_HOUSE_REPAIR', async () => {
    const deviceId = await seedDevice('SORTING', { sku: 'UNMAPPED-SKU-NOT-IN-CATALOG' })
    await api(`/api/devices/${deviceId}/repair/start`, { method: 'POST', body: JSON.stringify({ fault_code: 'SCREEN_CRACKED' }) })
    await api(`/api/devices/${deviceId}/repair/scan-back`, { method: 'POST', body: JSON.stringify({}) })

    const res = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/repair/qc`, {
      method: 'POST',
      body: JSON.stringify({ result: 'PASSED' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error.toLowerCase()).toContain('sku')

    expect(await deviceStatus(deviceId)).toBe('IN_HOUSE_REPAIR')
  })
})

describe('C. repair workflow — cost entry (#26)', () => {
  it('#26 repair cost entered (7 confirmed cost fields) → correctly linked to device_id/IMEI, GBP-only, no currency field', async () => {
    const deviceId = await seedDevice('SORTING')
    const startRes = await api(`/api/devices/${deviceId}/repair/start`, { method: 'POST', body: JSON.stringify({ fault_code: 'SCREEN_CRACKED' }) })
    const { repair_job } = await startRes.json() as { repair_job: { id: number } }

    const res = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/repair/cost`, {
      method: 'POST',
      body: JSON.stringify({
        repair_cost_gbp: 45.5,
        parts_cost_gbp: 30,
        labour_cost_gbp: 15.5,
        cost_source: 'MANUAL_MANAGER_ENTRY',
        cost_source_reference: 'INV-1001',
      }),
    })
    expect(res.status).toBe(200)

    const jobs = await repairJobsFor(deviceId)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].id).toBe(repair_job.id)
    expect(jobs[0]).toMatchObject({
      repair_cost_gbp: 45.5,
      parts_cost_gbp: 30,
      labour_cost_gbp: 15.5,
      cost_source: 'MANUAL_MANAGER_ENTRY',
      cost_source_reference: 'INV-1001',
      cost_recorded_by: MANAGER_USER.id,
    })
    expect(jobs[0].cost_recorded_at).toBeTruthy()
    // GBP-only by design (slice 1) — no currency column exists on the job.
    expect(jobs[0]).not.toHaveProperty('repair_cost_currency')
    expect(jobs[0]).not.toHaveProperty('currency')
  })
})

describe('C. repair workflow — QC_FAILED re-open (#27)', () => {
  it('#27 QC_FAILED device can re-enter IN_HOUSE_REPAIR (re-open) but requires a fresh scan-back/QC cycle — cannot skip straight to READY_FOR_ZOHO', async () => {
    // Seeded directly into QC_FAILED: exercises the schema/enum in
    // isolation from the full start→scan-back→QC-fail chain above.
    const deviceId = await seedDevice('QC_FAILED' as DeviceStatus)

    const reopen = await api(`/api/devices/${deviceId}/repair/reopen`, { method: 'POST', body: JSON.stringify({}) })
    expect(reopen.status).toBe(200)
    expect(await deviceStatus(deviceId)).toBe('IN_HOUSE_REPAIR')

    // No shortcut straight to READY_FOR_ZOHO without a fresh QC PASSED.
    const skip = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/repair/qc`, {
      method: 'POST',
      body: JSON.stringify({ result: 'PASSED' }),
    })
    // Fresh scan-back is required first — a bare re-open + immediate QC
    // call (no intervening scan-back) must be refused.
    expect(skip.status).toBe(409)
    expect(await deviceStatus(deviceId)).not.toBe('READY_FOR_ZOHO')
  })
})

describe('C. repair workflow — no generic HOLD (#28, NEW)', () => {
  it('#28 no generic HOLD status is reachable from any repair-workflow transition', async () => {
    // Static/documentation-level assertion: 'HOLD' must not appear in the
    // device status enum at all (docs/plan/device-lifecycle-slice1.md,
    // "Amendment 2 resolution" — HOLD is explicitly out of scope; QC_FAILED
    // is a distinct, separate status, never overloaded onto a generic HOLD).
    const { DEVICE_STATUSES } = await import('../src/types')
    expect(DEVICE_STATUSES).not.toContain('HOLD')

    // Behavioural companion: the generic transition endpoint must refuse an
    // attempt to set a literal 'HOLD' status outright (it isn't a real
    // DeviceStatus at all, so this must 400, not silently no-op or 200).
    const deviceId = await seedDevice('IN_HOUSE_REPAIR')
    const res = await api(`/api/devices/${deviceId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ to_status: 'HOLD' }),
    })
    expect(res.status).toBe(400)
    expect(await deviceStatus(deviceId)).toBe('IN_HOUSE_REPAIR')
  })
})

describe('C. repair workflow — QC role gating (#29)', () => {
  it('#29 QC recording is manager-role-only (placeholder) — operator role attempting QC PASSED/FAILED → 403', async () => {
    const deviceId = await seedDevice('SORTING')
    await api(`/api/devices/${deviceId}/repair/start`, { method: 'POST', body: JSON.stringify({ fault_code: 'SCREEN_CRACKED' }) })
    await api(`/api/devices/${deviceId}/repair/scan-back`, { method: 'POST', body: JSON.stringify({}) })

    const asOperator = await apiAs(OPERATOR_USER, `/api/devices/${deviceId}/repair/qc`, {
      method: 'POST',
      body: JSON.stringify({ result: 'PASSED' }),
    })
    expect(asOperator.status).toBe(403)
    expect(await deviceStatus(deviceId)).toBe('IN_HOUSE_REPAIR')

    // Manager (the current placeholder role) must still be allowed — this
    // is what stops the test from merely proving "everything is 403".
    const asManager = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/repair/qc`, {
      method: 'POST',
      body: JSON.stringify({ result: 'PASSED' }),
    })
    expect(asManager.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// D. Zoho upload queue tests (#30–37)
// ═══════════════════════════════════════════════════════════════════════

// Drives a device from SORTING all the way to READY_FOR_ZOHO via the real
// (assumed) API chain, so Zoho-queue tests exercise genuinely-eligible
// devices rather than ones force-seeded straight into the status.
async function makeReadyForZohoDevice(): Promise<{ id: number; imei: string }> {
  const deviceId = await seedDevice('SORTING')
  const row = await db().prepare('SELECT imei FROM received_devices WHERE id = ?').bind(deviceId).first<{ imei: string }>()
  await api(`/api/devices/${deviceId}/repair/start`, { method: 'POST', body: JSON.stringify({ fault_code: 'SCREEN_CRACKED' }) })
  await api(`/api/devices/${deviceId}/repair/scan-back`, { method: 'POST', body: JSON.stringify({}) })
  await apiAs(MANAGER_USER, `/api/devices/${deviceId}/repair/qc`, { method: 'POST', body: JSON.stringify({ result: 'PASSED' }) })
  return { id: deviceId, imei: row!.imei }
}

async function zohoBatchRows(batchId: number) {
  const { results } = await db()
    .prepare('SELECT * FROM zoho_batch_devices WHERE batch_id = ? ORDER BY id ASC')
    .bind(batchId)
    .all<Record<string, unknown>>()
  return results
}

describe('D. Zoho upload queue — batch generation (#30–32)', () => {
  it('#30 generating a Zoho file with N selected READY_FOR_ZOHO devices → batch with exactly those N IMEIs, one row per IMEI, no aggregation', async () => {
    const a = await makeReadyForZohoDevice()
    const b = await makeReadyForZohoDevice()
    const c = await makeReadyForZohoDevice()

    const res = await apiAs(MANAGER_USER, '/api/zoho/batches', {
      method: 'POST',
      body: JSON.stringify({ device_ids: [a.id, b.id, c.id] }),
    })
    expect(res.status).toBe(201)
    const { batch } = await res.json() as { batch: { id: number } }

    const rows = await zohoBatchRows(batch.id)
    expect(rows).toHaveLength(3)
    const imeis = rows.map((r) => r.imei).sort()
    expect(imeis).toEqual([a.imei, b.imei, c.imei].sort())
    // one row per IMEI, no aggregation: no row should represent more than
    // one device.
    expect(new Set(rows.map((r) => r.device_id)).size).toBe(3)
  })

  it('#31 generating the file does NOT change any device status', async () => {
    const a = await makeReadyForZohoDevice()
    const b = await makeReadyForZohoDevice()

    const res = await apiAs(MANAGER_USER, '/api/zoho/batches', {
      method: 'POST',
      body: JSON.stringify({ device_ids: [a.id, b.id] }),
    })
    expect(res.status).toBe(201)

    expect(await deviceStatus(a.id)).toBe('READY_FOR_ZOHO')
    expect(await deviceStatus(b.id)).toBe('READY_FOR_ZOHO')
  })

  it('#32 a device not in READY_FOR_ZOHO cannot be included in a batch → excluded/rejected', async () => {
    const eligible = await makeReadyForZohoDevice()
    const ineligibleId = await seedDevice('IN_HOUSE_REPAIR')

    const res = await apiAs(MANAGER_USER, '/api/zoho/batches', {
      method: 'POST',
      body: JSON.stringify({ device_ids: [eligible.id, ineligibleId] }),
    })
    // Either the whole call is rejected (422/409) or the ineligible device
    // is excluded from the created batch — either is an acceptable
    // implementation, but a silent inclusion is not.
    if (res.status === 201) {
      const { batch } = await res.json() as { batch: { id: number } }
      const rows = await zohoBatchRows(batch.id)
      expect(rows.map((r) => r.device_id)).not.toContain(ineligibleId)
    } else {
      expect([409, 422]).toContain(res.status)
    }
  })
})

describe('D. Zoho upload queue — confirmation (#33–36)', () => {
  async function makeBatch(): Promise<number> {
    const a = await makeReadyForZohoDevice()
    const res = await apiAs(MANAGER_USER, '/api/zoho/batches', {
      method: 'POST',
      body: JSON.stringify({ device_ids: [a.id] }),
    })
    const { batch } = await res.json() as { batch: { id: number } }
    return batch.id
  }

  it('#33 manager confirms upload → batch status updated; manager-role-only (operator → 403)', async () => {
    const batchId = await makeBatch()

    const asOperator = await apiAs(OPERATOR_USER, `/api/zoho/batches/${batchId}/confirm`, { method: 'POST', body: JSON.stringify({}) })
    expect(asOperator.status).toBe(403)

    const asManager = await apiAs(MANAGER_USER, `/api/zoho/batches/${batchId}/confirm`, { method: 'POST', body: JSON.stringify({}) })
    expect(asManager.status).toBe(200)

    const row = await db().prepare('SELECT status FROM zoho_batches WHERE id = ?').bind(batchId).first<{ status: string }>()
    expect(row?.status).toBe('CONFIRMED')
  })

  it('#34 repeating the same confirmation call → idempotent, no duplicate upload-result row/audit event', async () => {
    const batchId = await makeBatch()
    await apiAs(MANAGER_USER, `/api/zoho/batches/${batchId}/confirm`, { method: 'POST', body: JSON.stringify({}) })

    const countBefore = await db().prepare('SELECT COUNT(*) AS n FROM zoho_batch_events WHERE batch_id = ?').bind(batchId).first<{ n: number }>()

    const second = await apiAs(MANAGER_USER, `/api/zoho/batches/${batchId}/confirm`, { method: 'POST', body: JSON.stringify({}) })
    expect(second.status).toBe(200)

    const countAfter = await db().prepare('SELECT COUNT(*) AS n FROM zoho_batch_events WHERE batch_id = ?').bind(batchId).first<{ n: number }>()
    expect(countAfter?.n).toBe(countBefore?.n)
  })

  it('#35 upload marked as failed/retry → batch status reflects failure, no silent retry/corruption', async () => {
    const batchId = await makeBatch()

    const res = await apiAs(MANAGER_USER, `/api/zoho/batches/${batchId}/fail`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Zoho API timeout' }),
    })
    expect(res.status).toBe(200)

    const row = await db().prepare('SELECT status FROM zoho_batches WHERE id = ?').bind(batchId).first<{ status: string }>()
    expect(row?.status).toBe('FAILED')

    // No silent retry: the batch must not have auto-transitioned itself
    // back to CONFIRMED/UPLOADED without an explicit new action.
    expect(row?.status).not.toBe('CONFIRMED')
  })

  it('#36 a device does NOT move to ACTIVE_INVENTORY purely from being in a confirmed-uploaded batch', async () => {
    const a = await makeReadyForZohoDevice()
    const res = await apiAs(MANAGER_USER, '/api/zoho/batches', { method: 'POST', body: JSON.stringify({ device_ids: [a.id] }) })
    const { batch } = await res.json() as { batch: { id: number } }

    await apiAs(MANAGER_USER, `/api/zoho/batches/${batch.id}/confirm`, { method: 'POST', body: JSON.stringify({}) })

    expect(await deviceStatus(a.id)).toBe('READY_FOR_ZOHO')
    expect(await deviceStatus(a.id)).not.toBe('ACTIVE_INVENTORY')
  })
})

describe('D. Zoho upload queue — ERP absence (#37, NEW)', () => {
  it('#37 ERP webhook is absent — zero-match search confirms no ERP-webhook route/table/field exists in this slice', async () => {
    // Route-level: no /api/erp/* or /api/*erp* path is registered.
    const res = await api('/api/erp/webhook', { method: 'POST', body: JSON.stringify({}) })
    expect(res.status).toBe(404)

    // Table-level: no table with 'erp' in its name exists in the schema.
    const { results } = await db()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND LOWER(name) LIKE '%erp%'")
      .all<{ name: string }>()
    expect(results).toHaveLength(0)
  })
})
