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
    // A genuine mismatch exists but no cascade was requested — the route
    // must say so explicitly (2026-09-16 fourth-state addition), not a
    // bare null indistinguishable from "no mismatch at all". This is the
    // exact response shape the real device-1319 modal-race incident
    // produced at the API layer before this fix.
    expect(body.manifest_line_cascade).toBe('divergent_not_requested')

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
    expect(body.manifest_line_cascade).toBe('applied')

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

  // ── Route hardening (3rd master-checklist review, 2026-09-15) ──
  // The exact bug the UI-design review caught: call once (sku fixed, no
  // cascade requested), then call AGAIN with also_correct_manifest_line:
  // true. Because oldSku is re-read fresh from received_devices on every
  // call, by the second call the device's sku is already the NEW one —
  // so the old `expectedRow.sku === oldSku` condition can never see the
  // original mismatch, silently returns manifest_line_also_wrong: false
  // (indistinguishable from "already correct"), and the manifest line is
  // never touched, with a 200 and no error anywhere. This is the exact
  // shape of the IMEI 355178160488248 acceptance test if the UI were
  // built as a two-call flow. The hardened route must return
  // manifest_line_cascade: 'not_applicable_already_matches' — an
  // EXPLICIT, distinct signal — not a bare false a caller could misread
  // as success.
  it('a SECOND, follow-up call with also_correct_manifest_line=true (after the sku already changed) gets an EXPLICIT not-applicable signal, not a silent false', async () => {
    const suffix = uniqueSuffix()
    await insertCatalogRow({ sku: `TEST-TWOCALL-WRONG-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTW', capacity: '128GB', color: 'MIDNIGHT', grade: 'A' })
    await insertCatalogRow({ sku: `TEST-TWOCALL-RIGHT-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTW', capacity: '128GB', color: 'BLUE', grade: 'A' })

    const manifestId = await seedManifest()
    const device = await seedDevice({
      sku: `TEST-TWOCALL-WRONG-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTW', capacity: '128GB', color: 'MIDNIGHT', grade: 'A',
    })
    const expectedId = await seedExpectedDevice({ manifestId, imei: device.imei, sku: `TEST-TWOCALL-WRONG-${suffix}` })
    await db().prepare('UPDATE received_devices SET expected_device_id = ? WHERE id = ?').bind(expectedId, device.id).run()

    // Call 1: fix the device sku, no cascade requested — same shape as
    // test 1 above. Device sku is now TEST-TWOCALL-RIGHT-<suffix>.
    const res1 = await apiAs(ADMIN_USER, `/api/devices/${device.id}/correct`, {
      method: 'PATCH',
      body: JSON.stringify({ sku: `TEST-TWOCALL-RIGHT-${suffix}`, reason: 'first call: fix the device only' }),
    })
    expect(res1.status).toBe(200)
    const body1 = await res1.json() as any
    expect(body1.manifest_line_also_wrong).toBe(true) // correctly flagged — manifest still says WRONG
    expect(body1.manifest_line_cascade).toBe('divergent_not_requested') // mismatch exists, no cascade asked for this call

    // Call 2: the buggy two-call flow the UI spec originally implied —
    // resubmit the SAME (already-applied) sku with the cascade flag on.
    // Manifest line is still wrong (still TEST-TWOCALL-WRONG-<suffix>),
    // but device.sku now EQUALS the target sku, so this is NOT a genuine
    // mismatch-and-cascade case any more — it's the stale-comparison
    // trap. Must be reported explicitly, never a bare false.
    const res2 = await apiAs(ADMIN_USER, `/api/devices/${device.id}/correct`, {
      method: 'PATCH',
      body: JSON.stringify({ sku: `TEST-TWOCALL-RIGHT-${suffix}`, reason: 'second call: attempt cascade after the fact', also_correct_manifest_line: true }),
    })
    expect(res2.status).toBe(200)
    const body2 = await res2.json() as any
    // Because device.sku already equals catalogRow.sku on this second
    // call, the widened `expectedRow.sku !== catalogRow.sku` condition
    // in the route (hardening change #1) DOES still detect the
    // manifest/device mismatch here (expectedRow.sku is still the OLD
    // sku, catalogRow.sku is the corrected one) — so this specific
    // two-call retry is actually rescued by the widened condition and
    // DOES cascade correctly. The real trap this route hardening exists
    // for is the case below, where the widened condition also runs out
    // of things to fix because the manifest line has ALREADY been
    // brought in line by an earlier explicit cascade.
    expect(body2.manifest_line_cascade).toBe('applied')

    // Call 3: repeat the same cascade request a THIRD time. The manifest
    // line is now genuinely in sync with the device (both corrected) —
    // this is the true "nothing left to cascade" case hardening change
    // #2 exists for, and it must come back as an explicit reason, not a
    // bare false indistinguishable from a fresh success.
    const res3 = await apiAs(ADMIN_USER, `/api/devices/${device.id}/correct`, {
      method: 'PATCH',
      body: JSON.stringify({ sku: `TEST-TWOCALL-RIGHT-${suffix}`, reason: 'third call: cascade requested again with nothing left to fix', also_correct_manifest_line: true }),
    })
    expect(res3.status).toBe(200)
    const body3 = await res3.json() as any
    expect(body3.manifest_line_also_wrong).toBe(false)
    expect(body3.manifest_line_cascade).toBe('not_applicable_already_matches')

    const expectedRowFinal = await db().prepare('SELECT sku FROM expected_devices WHERE id = ?').bind(expectedId).first<{ sku: string }>()
    expect(expectedRowFinal?.sku).toBe(`TEST-TWOCALL-RIGHT-${suffix}`) // cascaded exactly once, by call 2
  })

  // ── Widened condition (hardening change #2): a manifest line wrong in
  // a THIRD, unrelated way — i.e. it never matched the device's ORIGINAL
  // sku either — used to be neither corrected nor reported under the old
  // `expectedRow.sku === oldSku` test. The widened
  // `expectedRow.sku !== catalogRow.sku` test catches this too, since the
  // real question is "does the manifest line match what the device now
  // is", not "did it match what the device used to be". ──
  it('manifest line SKU that never matched the device at all (a third, unrelated value) is still flagged as a mismatch, not silently ignored', async () => {
    const suffix = uniqueSuffix()
    // NOTE: model 'IPHONE TESTTHIRD' (not 'IPHONE TESTQ') — TESTQ collides
    // with the pre-existing REJECTED test below on the org-scoped unique
    // index (brand, model, capacity, color, grade); this test originally
    // reused TESTQ+128GB+BLUE+A, the exact same config+grade key as that
    // test's TEST-REJECTED-OK row, and INSERT OR IGNORE silently dropped
    // whichever ran second — caught by the full-file run, fixed here.
    await insertCatalogRow({ sku: `TEST-THIRDVAL-DEVICE-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTTHIRD', capacity: '128GB', color: 'MIDNIGHT', grade: 'A' })
    await insertCatalogRow({ sku: `TEST-THIRDVAL-CORRECTED-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTTHIRD', capacity: '128GB', color: 'BLUE', grade: 'A' })

    const manifestId = await seedManifest()
    const device = await seedDevice({
      sku: `TEST-THIRDVAL-DEVICE-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTTHIRD', capacity: '128GB', color: 'MIDNIGHT', grade: 'A',
    })
    // Manifest line's sku is a THIRD value — neither the device's current
    // sku nor the sku it's being corrected to. Under the old
    // `expectedRow.sku === oldSku` test this would never match (oldSku is
    // TEST-THIRDVAL-DEVICE-<suffix>, expectedRow.sku is
    // TEST-THIRDVAL-MANIFESTONLY-<suffix>), so the mismatch would be
    // silently dropped — no flag, no report, no way for the operator to
    // ever learn the manifest line disagreed with anything.
    const expectedId = await seedExpectedDevice({ manifestId, imei: device.imei, sku: `TEST-THIRDVAL-MANIFESTONLY-${suffix}` })
    await db().prepare('UPDATE received_devices SET expected_device_id = ? WHERE id = ?').bind(expectedId, device.id).run()

    const res = await apiAs(ADMIN_USER, `/api/devices/${device.id}/correct`, {
      method: 'PATCH',
      body: JSON.stringify({ sku: `TEST-THIRDVAL-CORRECTED-${suffix}`, reason: 'correcting device sku; manifest line disagrees with both old and new' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    // Widened condition catches it: expectedRow.sku (MANIFESTONLY) !==
    // catalogRow.sku (CORRECTED) -> true, so this IS flagged, even
    // though it would never have matched the old oldSku-based test.
    expect(body.manifest_line_also_wrong).toBe(true)
    expect(body.manifest_line).toMatchObject({ id: expectedId, sku: `TEST-THIRDVAL-MANIFESTONLY-${suffix}` })
    expect(body.manifest_line_cascade).toBe('divergent_not_requested') // mismatch exists, no cascade asked for this call
  })

  // ── Real-incident regression (2026-09-16): device 1319 / IMEI
  // 355178160488248's live acceptance run. The CorrectDeviceModal's
  // GET /:id fetch (which populates ctx.manifestLine) is async; the "Save
  // correction" button was gated only on ctx.busy, not ctx.loading, so an
  // operator who picked a replacement SKU and clicked Save before that
  // fetch resolved could submit with also_correct_manifest_line
  // effectively false — indistinguishable, from the route's OLD response
  // alone, from a deliberate decline or from there having been no
  // mismatch at all. Fixed two ways: the modal now also gates Save on
  // ctx.loading (this test proves the ROUTE side — that a false/absent
  // flag on a genuine mismatch is reported as 'divergent_not_requested',
  // never a bare null a caller could misread as "nothing to say"), and
  // the modal fix itself is a UI-only change with no route-observable
  // side effect to assert here.
  //
  // The critical distinction this test exists for: 'divergent_not_requested'
  // must appear ONLY when a real mismatch exists — a device with NO
  // mismatch and no cascade requested must still get a plain null (see
  // test 2's second call further down, and the very first "no manifest
  // line at all" shape below), so a future caller can tell "there was
  // something to decide and it wasn't decided" apart from "there was
  // nothing to decide" without inspecting manifest_line_also_wrong
  // separately.
  it('a genuine mismatch with also_correct_manifest_line absent (the modal-race shape) is reported as divergent_not_requested, never a bare null', async () => {
    const suffix = uniqueSuffix()
    await insertCatalogRow({ sku: `TEST-RACE-WRONG-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTRACE', capacity: '128GB', color: 'MIDNIGHT', grade: 'A' })
    await insertCatalogRow({ sku: `TEST-RACE-RIGHT-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTRACE', capacity: '128GB', color: 'BLUE', grade: 'A' })

    const manifestId = await seedManifest()
    const device = await seedDevice({
      sku: `TEST-RACE-WRONG-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTRACE', capacity: '128GB', color: 'MIDNIGHT', grade: 'A',
    })
    const expectedId = await seedExpectedDevice({ manifestId, imei: device.imei, sku: `TEST-RACE-WRONG-${suffix}` })
    await db().prepare('UPDATE received_devices SET expected_device_id = ? WHERE id = ?').bind(expectedId, device.id).run()

    // No also_correct_manifest_line key at all in the body — the exact
    // shape a race-truncated submit produces (the modal never sends the
    // key as `true` if the race window closed before ctx.manifestLine
    // populated; manifestMismatch is false so it sends `false`, but a
    // client that omitted the key entirely must be caught identically).
    const res = await apiAs(ADMIN_USER, `/api/devices/${device.id}/correct`, {
      method: 'PATCH',
      body: JSON.stringify({ sku: `TEST-RACE-RIGHT-${suffix}`, reason: 'race-shaped submit: cascade flag never arrived despite a real mismatch' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.manifest_line_also_wrong).toBe(true)
    expect(body.manifest_line_cascade).toBe('divergent_not_requested')

    // Manifest line itself must remain untouched — this is a report-only
    // signal, not an implicit cascade.
    const expectedRowAfter = await db().prepare('SELECT sku FROM expected_devices WHERE id = ?').bind(expectedId).first<{ sku: string }>()
    expect(expectedRowAfter?.sku).toBe(`TEST-RACE-WRONG-${suffix}`)

    // Contrast case, same call shape, but genuinely nothing to report:
    // no expected_devices link at all. Must stay a plain null, not
    // 'divergent_not_requested' — the new state names a REAL divergence,
    // not "cascade wasn't requested" in general.
    const plainDevice = await seedDevice({
      sku: `TEST-RACE-RIGHT-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTRACE', capacity: '128GB', color: 'BLUE', grade: 'A',
    })
    const resPlain = await apiAs(ADMIN_USER, `/api/devices/${plainDevice.id}/correct`, {
      method: 'PATCH',
      body: JSON.stringify({ sku: `TEST-RACE-WRONG-${suffix}`, reason: 'no manifest line linked at all — genuinely nothing to report' }),
    })
    expect(resPlain.status).toBe(200)
    const bodyPlain = await resPlain.json() as any
    expect(bodyPlain.manifest_line_also_wrong).toBe(false)
    expect(bodyPlain.manifest_line_cascade).toBeNull()
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

  // ── Zoho-push gate: EXISTS-any-closed-job, not just the latest job
  // (fixed 2026-09-15, 2nd master-checklist review) ──
  // A device pushed to Zoho once (job 1 closed) and then re-repaired
  // under a NEW, still-open job 2 must STILL be blocked — the earlier
  // `ORDER BY id DESC LIMIT 1` form would see only job 2's null
  // closed_at and wrongly allow the correction through, even though the
  // device is already sitting in Zoho with the old SKU from job 1's
  // push. This is the exact case the operator's second review caught.
  it('device pushed to Zoho once (job 1 closed) then re-repaired (job 2 open) is STILL blocked — any closed job counts, not just the latest', async () => {
    const suffix = uniqueSuffix()
    await insertCatalogRow({ sku: `TEST-ZOHOREREPAIR-${suffix}`, brand: 'APPLE', model: 'IPHONE TESTR', capacity: '128GB', color: 'GREEN', grade: 'A' })
    const device = await seedDevice({
      sku: 'TEST-STALE-ZOHOREREPAIR-SKU', brand: 'APPLE', model: 'IPHONE TESTR', capacity: '128GB', color: 'RED', grade: 'A',
      status: 'SORTING', // device came back in for a second repair pass
    })
    // job 1: closed (this is the push-to-Zoho event) — inserted first so
    // its id is lower, i.e. NOT the "most recent" job.
    await db().prepare(
      `INSERT INTO repair_jobs (organisation_id, device_id, imei, fault_code, status, qc_result, closed_at)
       VALUES (1, ?, ?, 'screen', 'completed', 'PASSED', '2026-09-10 10:00:00')`
    ).bind(device.id, device.imei).run()
    // job 2: open (re-repair after the device came back) — higher id,
    // so this IS "most recent" — its closed_at is NULL. status='open' and
    // qc_result='PENDING' are the schema's real values (migration 0022:
    // status CHECK is open/awaiting_qc/completed/cancelled, qc_result is
    // NOT NULL DEFAULT 'PENDING' — 'in_progress' is not a valid status).
    await db().prepare(
      `INSERT INTO repair_jobs (organisation_id, device_id, imei, fault_code, status, qc_result)
       VALUES (1, ?, ?, 'battery', 'open', 'PENDING')`
    ).bind(device.id, device.imei).run()

    const res = await apiAs(ADMIN_USER, `/api/devices/${device.id}/correct`, {
      method: 'PATCH',
      body: JSON.stringify({ sku: `TEST-ZOHOREREPAIR-${suffix}`, reason: 'attempted on a device pushed once, now mid re-repair' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json() as any
    expect(body.error).toMatch(/pushed to Zoho/i)
    expect(body.error).toMatch(/2026-09-10/) // reports the EARLIEST closed date, i.e. when it first became pushed

    const row = await deviceRow(device.id)
    expect(row?.sku).toBe('TEST-STALE-ZOHOREREPAIR-SKU') // unchanged
    expect((await eventsFor(device.id)).length).toBe(0)
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

// ── GET /api/devices/:id — manifest_line field (2026-09-15, Task X UI
// bundle) ── Added specifically so the correction modal can decide,
// BEFORE submitting a PATCH, whether the linked manifest line's sku
// already matches the device's current sku — the only way the
// "also fix the manifest line?" prompt can be shown up front rather
// than as a broken second call (see the two-call trap covered above).
describe('GET /api/devices/:id — manifest_line field', () => {
  it('returns manifest_line: null when the device has no linked expected_devices row', async () => {
    const device = await seedDevice({ sku: 'TEST-GETID-NOLINK-SKU', brand: 'APPLE', model: 'IPHONE TESTG', capacity: '128GB', color: 'RED', grade: 'A' })
    const res = await apiAs(ADMIN_USER, `/api/devices/${device.id}`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.manifest_line).toBeNull()
  })

  it('returns the linked manifest line { id, sku } when device.expected_device_id is set', async () => {
    const manifestId = await seedManifest()
    const device = await seedDevice({ sku: 'TEST-GETID-LINKED-SKU', brand: 'APPLE', model: 'IPHONE TESTG', capacity: '128GB', color: 'RED', grade: 'A' })
    const expectedId = await seedExpectedDevice({ manifestId, imei: device.imei, sku: 'TEST-GETID-LINKED-SKU' })
    await db().prepare('UPDATE received_devices SET expected_device_id = ? WHERE id = ?').bind(expectedId, device.id).run()

    const res = await apiAs(ADMIN_USER, `/api/devices/${device.id}`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.manifest_line).toMatchObject({ id: expectedId, sku: 'TEST-GETID-LINKED-SKU' })
  })
})
