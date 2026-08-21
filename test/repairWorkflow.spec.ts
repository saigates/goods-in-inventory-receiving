// Device Lifecycle slice 1 — repair-workflow + Zoho upload-queue test bodies
// (approved draft list #15–37, see docs/plan/device-lifecycle-slice1.md
// section "Test plan", C. and D., renumbered to insert four net-new items:
// #22 QC-FAILED-needs-reason, #28 no-generic-HOLD, #37 ERP-webhook-absent,
// and #25a/#25b (originally #25a–#25f, added 2026-08-11 against a
// SKU-suffix-parsing implementation of gate condition 6; REWRITTEN
// 2026-08-12 — see "Regrade-fix 1 superseded the SKU-suffix reject-path
// tests" below for why four of the original six were deleted rather than
// fixed).

// Regrade-fix 1 superseded the SKU-suffix reject-path tests (2026-08-12).
//
// Condition 6 (src/lib/repairWorkflow.ts:149–164) was rewritten this
// sprint to read `received_devices.grade` directly instead of re-parsing
// the SKU string's trailing hyphen segment. The original #25a–#25f were
// written against the OLD (SKU-parsing) implementation and asserted
// exact wording/behaviour of that parser: #25c (unrecognised 'X'
// suffix), #25d (no-hyphen / trailing-hyphen SKU shapes), #25e (lowercase
// suffix case-sensitivity) and #25f (4-segment colour-code SKU, "no grade
// segment" wording) all target malformed/atypical *SKU-string* shapes —
// a scenario the new implementation never inspects at all.
//
// These four are not just failing, they are asserting behaviour against
// an input that can no longer even reach a check: the grade values those
// tests fabricate ('X', '', no-segment, lowercase 'a') can never exist in
// `received_devices.grade` in the first place, because that column is
// CHECK-constrained to exactly 'A'|'B'|'C'|'UG' (migrations/0004, 0023
// line 73) — any INSERT/UPDATE attempting one of those values fails at
// the D1 layer before checkReadyForZohoGate ever runs. Confirmed via
// grep: zero matches for SKU-suffix-parsing or "no grade segment" logic
// anywhere under src/ — the old parser (including its 4-segment "no
// grade segment" branch) was deleted outright, not left dead-but-present.
// Also confirmed: no other endpoint anywhere in the codebase performs a
// SKU-shape/suffix validity check, so there is no "catalogue-shape check
// that runs somewhere else" to relocate these four tests onto.
//
// DECISION (mine, per explicit instruction to pick and state it): DELETE
// #25c/#25d/#25e/#25f outright rather than keep them as a relocated
// catalogue-shape check — there is nothing left in the application for
// them to describe, and inventing a new SKU-shape-validation feature
// solely to keep four tests green would be scope the owner never asked
// for. #25a and #25b are RE-PURPOSED (not deleted) into two tests that
// assert the real contract regrade-fix 1 introduced: the grade COLUMN is
// authoritative even when it diverges from what the SKU's own suffix
// would suggest (the exact scenario named in the condition-6 comment —
// a device regraded via POST /api/inventory/grade after receipt, without
// its SKU being renamed to match).
//
// #24/#25 (above, unchanged) only ever exercised the ACCEPT path for
// condition 6 — a green suite around an untriggered branch proves the
// branch didn't break anything, not that it works. #25a/#25b force the
// reject branch and its converse accept branch, specifically via a
// SKU/grade MISMATCH, so a naive implementation that fell back to
// re-reading the SKU suffix (instead of the grade column) would fail
// both.
//
// Group D (#30–37) status: SKIPPED for #30–36 (see the two describe.skip
// blocks below) — Zoho batch generation/confirmation was never built and
// was parked by explicit owner decision (stock currently goes into Zoho by
// hand). Carrying seven permanent reds made the board unreadable; skipping
// with a stated reason is more honest than "not yet green". #37 (ERP
// webhook absence) stays unskipped — it asserts an absence against
// already-existing code/schema, so it's genuinely green, not blocked on
// unbuilt routes.
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
  opts: { sku?: string; organisationId?: number; model?: string; grade?: string } = {},
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
  // grade defaults to 'A' — condition 6 (regrade-fix 1, this sprint) reads
  // received_devices.grade directly, not the SKU suffix, so the default
  // must clear the gate rather than rely on the received_devices.grade
  // column's own schema default ('UG', which condition 6 rejects).
  const grade = opts.grade ?? 'A'
  const result = await db()
    .prepare(
      `INSERT INTO received_devices
         (organisation_id, uuid, imei, sku, model, grade, source, status)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)`
    )
    .bind(organisationId, uuid, imei, sku, model, grade, status)
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

// Gate condition 6 (src/lib/repairWorkflow.ts:149–164) — grade-column
// authority, reject and accept paths.
//
// #24 and #25 (above) only ever exercise the ACCEPT side of condition 6
// with a fixture whose SKU and grade column happen to agree (both imply
// grade 'A'). That proves the happy path works but not that the grade
// COLUMN — rather than the SKU string — is what's actually being
// checked. #25a and #25b force a SKU/grade MISMATCH specifically so a
// regression back to SKU-suffix parsing (or a fixed-position parse of
// the SKU) would fail them even though it might satisfy a looser
// "any 409" assertion.
describe('C. repair workflow — gate condition 6, grade-column authority (#25a–#25b, REWRITTEN 2026-08-12)', () => {
  it('#25a device graded UG via the regrade endpoint, but its SKU still ends in -A → 409, error names the actual grade (UG), not the stale SKU suffix', async () => {
    // Seed with a SKU whose suffix says '-A' (would pass under the old
    // SKU-parsing implementation) but an explicit grade column of 'UG' —
    // this is exactly the divergence the condition-6 comment names: a
    // device regraded via POST /api/inventory/grade after receipt,
    // without its SKU being renamed to match.
    const deviceId = await seedDevice('SORTING', { sku: 'SAM-S26-256-CVT-A', grade: 'UG' })
    await api(`/api/devices/${deviceId}/repair/start`, { method: 'POST', body: JSON.stringify({ fault_code: 'SCREEN_CRACKED' }) })
    await api(`/api/devices/${deviceId}/repair/scan-back`, { method: 'POST', body: JSON.stringify({}) })

    const res = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/repair/qc`, {
      method: 'POST',
      body: JSON.stringify({ result: 'PASSED' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    // Must name the GRADE COLUMN value ('UG'), proving the column — not
    // the SKU's '-A' suffix — was read.
    expect(body.error).toContain('UG')

    expect(await deviceStatus(deviceId)).toBe('IN_HOUSE_REPAIR')
  })

  it('#25b device graded A via the regrade endpoint, but its SKU still ends in -UG → 200/READY_FOR_ZOHO, the stale SKU suffix does not block it', async () => {
    // Converse of #25a: SKU suffix says '-UG' (would fail under the old
    // SKU-parsing implementation) but the grade column is explicitly
    // 'A' — proves the column is authoritative in the ACCEPT direction
    // too, not just the reject direction.
    const deviceId = await seedDevice('SORTING', { sku: 'SAM-S26-256-CVT-UG', grade: 'A' })
    await api(`/api/devices/${deviceId}/repair/start`, { method: 'POST', body: JSON.stringify({ fault_code: 'SCREEN_CRACKED' }) })
    await api(`/api/devices/${deviceId}/repair/scan-back`, { method: 'POST', body: JSON.stringify({}) })

    const res = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/repair/qc`, {
      method: 'POST',
      body: JSON.stringify({ result: 'PASSED' }),
    })
    expect(res.status).toBe(200)
    expect(await deviceStatus(deviceId)).toBe('READY_FOR_ZOHO')
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

// SKIPPED (2026-08-11) by explicit owner decision: Zoho batch
// generation/confirmation (the /api/zoho/batches* routes, zoho_batches and
// zoho_batch_devices/zoho_batch_events tables) was never built and is not
// scheduled next — stock currently goes into Zoho by hand. These bodies
// document the intended contract for whenever that work is picked up, but
// carrying them as permanent reds made the test board unreadable, so they
// are marked skipped rather than left red. Do not un-skip without a
// deliberate decision to build Group D — see queue order in the standing
// project status (date-enterability → verified/tested backup → Item 3 →
// Group D).
describe.skip('D. Zoho upload queue — batch generation (#30–32) [SKIPPED: Zoho batch upload not built; stock goes into Zoho by hand for now]', () => {
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

// SKIPPED (2026-08-11) — same reason as the batch-generation block above:
// confirmation depends on batch generation, which is not built. See the
// note above #30–32 for the full rationale and un-skip conditions.
describe.skip('D. Zoho upload queue — confirmation (#33–36) [SKIPPED: depends on unbuilt Zoho batch generation; stock goes into Zoho by hand for now]', () => {
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

// ═══════════════════════════════════════════════════════════════════════
// E. Device Lifecycle UI-layer sprint (2026-08-12) — bulk-transition +
// repair-queue read endpoints (#38–#43, NEW)
// ═══════════════════════════════════════════════════════════════════════
describe('E. POST /api/devices/bulk-transition (#38–#42, NEW)', () => {
  it('#38 transitions every IMEI in the batch and returns per-IMEI + summary counts', async () => {
    const a = await seedDevice('RECEIVED')
    const b = await seedDevice('RECEIVED')
    const [imeiA, imeiB] = await Promise.all([
      db().prepare('SELECT imei FROM received_devices WHERE id = ?').bind(a).first<{ imei: string }>(),
      db().prepare('SELECT imei FROM received_devices WHERE id = ?').bind(b).first<{ imei: string }>(),
    ])
    const res = await api('/api/devices/bulk-transition', {
      method: 'POST',
      body: JSON.stringify({ target_status: 'SORTING', imeis: [imeiA!.imei, imeiB!.imei] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { transitioned: number; failed: number; requested: number; results: any[] }
    expect(body.requested).toBe(2)
    expect(body.transitioned).toBe(2)
    expect(body.failed).toBe(0)
    expect(await deviceStatus(a)).toBe('SORTING')
    expect(await deviceStatus(b)).toBe('SORTING')
    expect(body.results.every((r: any) => r.ok && r.outcome === 'transitioned')).toBe(true)
  })

  it('#39 a bad IMEI in the batch is reported per-row and does not block the rest (partial success)', async () => {
    const a = await seedDevice('RECEIVED')
    const imeiA = (await db().prepare('SELECT imei FROM received_devices WHERE id = ?').bind(a).first<{ imei: string }>())!.imei
    const res = await api('/api/devices/bulk-transition', {
      method: 'POST',
      body: JSON.stringify({ target_status: 'SORTING', imeis: [imeiA, '0000000000000000-NOT-A-DEVICE'] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { transitioned: number; failed: number; results: any[] }
    expect(body.transitioned).toBe(1)
    expect(body.failed).toBe(1)
    expect(await deviceStatus(a)).toBe('SORTING')
    const badRow = body.results.find((r: any) => r.imei === '0000000000000000-NOT-A-DEVICE')
    expect(badRow.ok).toBe(false)
    expect(badRow.outcome).toBe('error')
    expect(badRow.message).toContain('No device found')
  })

  it('#40 an illegal transition for one device is reported as skipped with the InvalidTransitionError message, other rows unaffected', async () => {
    const legal = await seedDevice('RECEIVED')
    const illegal = await seedDevice('ACTIVE_INVENTORY') // ACTIVE_INVENTORY has no outbound transitions
    const [imeiLegal, imeiIllegal] = await Promise.all([
      db().prepare('SELECT imei FROM received_devices WHERE id = ?').bind(legal).first<{ imei: string }>(),
      db().prepare('SELECT imei FROM received_devices WHERE id = ?').bind(illegal).first<{ imei: string }>(),
    ])
    const res = await api('/api/devices/bulk-transition', {
      method: 'POST',
      body: JSON.stringify({ target_status: 'SORTING', imeis: [imeiLegal!.imei, imeiIllegal!.imei] }),
    })
    const body = await res.json() as { transitioned: number; failed: number; results: any[] }
    expect(body.transitioned).toBe(1)
    expect(body.failed).toBe(1)
    expect(await deviceStatus(legal)).toBe('SORTING')
    expect(await deviceStatus(illegal)).toBe('ACTIVE_INVENTORY') // unchanged
    const skippedRow = body.results.find((r: any) => r.imei === imeiIllegal!.imei)
    expect(skippedRow.outcome).toBe('skipped')
    expect(skippedRow.message).toContain('Cannot transition device from ACTIVE_INVENTORY to SORTING')
  })

  it('#41 target_status inside OPR_WORKFLOW_ONLY_STATUSES is refused outright (409), before any device is touched', async () => {
    const a = await seedDevice('READY_FOR_EXPORT')
    const imeiA = (await db().prepare('SELECT imei FROM received_devices WHERE id = ?').bind(a).first<{ imei: string }>())!.imei
    const res = await api('/api/devices/bulk-transition', {
      method: 'POST',
      body: JSON.stringify({ target_status: 'EXPORTED_UNDER_OPR', imeis: [imeiA] }),
    })
    expect(res.status).toBe(409)
    expect(await deviceStatus(a)).toBe('READY_FOR_EXPORT') // unchanged
  })

  it('#42 target_status inside REPAIR_WORKFLOW_ONLY_STATUSES is refused outright (409) — bulk cannot bypass the repair-workflow gate', async () => {
    const a = await seedDevice('SORTING')
    const imeiA = (await db().prepare('SELECT imei FROM received_devices WHERE id = ?').bind(a).first<{ imei: string }>())!.imei
    const res = await api('/api/devices/bulk-transition', {
      method: 'POST',
      body: JSON.stringify({ target_status: 'IN_HOUSE_REPAIR', imeis: [imeiA] }),
    })
    expect(res.status).toBe(409)
    expect(await deviceStatus(a)).toBe('SORTING') // unchanged
  })

  it('#42b caps at 500 IMEIs with an explicit 422 (raised 2026-08-15 from 200 — the cap itself was never the production silent-drop defect, see BULK_TRANSITION_CAP comment)', async () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => String(100000000000000 + i))
    const res = await api('/api/devices/bulk-transition', {
      method: 'POST',
      body: JSON.stringify({ target_status: 'SORTING', imeis: tooMany }),
    })
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('500')
  })
})

describe('E. GET /api/devices/repair-queue (#43, NEW)', () => {
  it('#43 returns only IN_HOUSE_REPAIR / QC_FAILED devices, each joined with its latest repair_jobs row', async () => {
    const inRepair = await seedDevice('SORTING')
    await api(`/api/devices/${inRepair}/repair/start`, { method: 'POST', body: JSON.stringify({ fault_code: 'SCREEN_CRACKED' }) })
    const notInQueue = await seedDevice('ACTIVE_INVENTORY')

    const res = await api('/api/devices/repair-queue')
    expect(res.status).toBe(200)
    const body = await res.json() as { devices: any[] }
    const ids = body.devices.map((d: any) => d.id)
    expect(ids).toContain(inRepair)
    expect(ids).not.toContain(notInQueue)
    const row = body.devices.find((d: any) => d.id === inRepair)
    expect(row.repair_job_status).toBe('open')
    expect(row.fault_code).toBe('SCREEN_CRACKED')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// G5 item 3 — POST /api/devices/:id/repair/cost-ledger
// (postRepairCostToLedger(), src/lib/repairWorkflow.ts) — separate from
// the repair_jobs cost-column shim tested above (#26); writes the
// durable, typed, append-only cost_ledger (migration 0028) that item 5
// (movement/reporting) reads.
// ═══════════════════════════════════════════════════════════════════════

// Minimal fixture bill + one bill_lines row for the "attributed to a
// specific invoiced line" branch (source_bill_line_id populated). Bypasses
// the API/billBuilder entirely — same direct-INSERT convention as
// seedDevice() above — because this suite is testing the cost_ledger
// write, not bill creation itself.
async function seedBillLine(): Promise<number> {
  const billResult = await db()
    .prepare(
      `INSERT INTO bills
         (organisation_id, bill_type, vendor_name, bill_date, invoice_number,
          currency_code, unit_count, declared_total, price_source, status)
       VALUES (1, 'repair', 'Syncere', '2026-06-01', ?, 'GBP', 1, 45.5, 'per_imei', 'closed')`
    )
    .bind(`INV-G5ITEM3-${Date.now()}-${Math.random()}`)
    .run()
  const billId = billResult.meta.last_row_id as number

  const lineResult = await db()
    .prepare(
      `INSERT INTO bill_lines (organisation_id, bill_id, line_no, sku, description, quantity, unit_price, unit_price_gbp)
       VALUES (1, ?, 1, 'REPAIR-LINE', 'Screen replacement', 1, 45.5, 45.5)`
    )
    .bind(billId)
    .run()
  return lineResult.meta.last_row_id as number
}

async function costLedgerFor(deviceId: number) {
  const { results } = await db()
    .prepare('SELECT * FROM cost_ledger WHERE received_device_id = ? ORDER BY id ASC')
    .bind(deviceId)
    .all<Record<string, unknown>>()
  return results
}

describe('G5 item 3 — repair cost posted to cost_ledger (append-only, coexisting NULL/populated source_bill_line_id)', () => {
  it('posting twice for one device (once in-house/NULL, once attributed to a bill line) yields TWO rows with distinct ids, correct nullability + provenance on each, never one row updated', async () => {
    const deviceId = await seedDevice('SORTING')
    const billLineId = await seedBillLine()

    // First post: in-house-only cost, no source bill line.
    const firstRes = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/repair/cost-ledger`, {
      method: 'POST',
      body: JSON.stringify({ amount_gbp: 30, note: 'In-house screen swap, no invoice' }),
    })
    expect(firstRes.status).toBe(201)
    const { cost_ledger_entry: firstEntry } = await firstRes.json() as { cost_ledger_entry: { id: number } }

    // Second post: same device, attributed to the seeded bill line.
    const secondRes = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/repair/cost-ledger`, {
      method: 'POST',
      body: JSON.stringify({ amount_gbp: 45.5, source_bill_line_id: billLineId }),
    })
    expect(secondRes.status).toBe(201)
    const { cost_ledger_entry: secondEntry } = await secondRes.json() as { cost_ledger_entry: { id: number } }

    // Core assertion: two rows, distinct ids — never one row updated.
    const rows = await costLedgerFor(deviceId)
    expect(rows).toHaveLength(2)
    expect(firstEntry.id).not.toBe(secondEntry.id)
    expect(rows.map(r => r.id).sort()).toEqual([firstEntry.id, secondEntry.id].sort())

    const first = rows.find(r => r.id === firstEntry.id)!
    const second = rows.find(r => r.id === secondEntry.id)!

    // Both nullability branches + both provenance values fall out of this
    // one fixture, per the accepted design decision.
    expect(first).toMatchObject({
      cost_type: 'repair',
      amount_gbp: 30,
      currency_code: 'GBP',
      source_bill_line_id: null,
      provenance: 'default-unverified',
      created_by_user_id: MANAGER_USER.id,
    })
    expect(second).toMatchObject({
      cost_type: 'repair',
      amount_gbp: 45.5,
      currency_code: 'GBP',
      source_bill_line_id: billLineId,
      provenance: 'supplier-invoiced',
      created_by_user_id: MANAGER_USER.id,
    })
  })

  it('non-manager (operator) attempting to post to the cost ledger → 403, zero rows written', async () => {
    const deviceId = await seedDevice('SORTING')

    const res = await apiAs(OPERATOR_USER, `/api/devices/${deviceId}/repair/cost-ledger`, {
      method: 'POST',
      body: JSON.stringify({ amount_gbp: 30 }),
    })
    expect(res.status).toBe(403)

    const rows = await costLedgerFor(deviceId)
    expect(rows).toHaveLength(0)
  })
})
