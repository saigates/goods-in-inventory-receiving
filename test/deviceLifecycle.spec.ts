// State-machine transition tests (Priority 2 & 3).
//
// Covers:
//   - every allowed transition in ALLOWED_TRANSITIONS succeeds
//   - a representative set of disallowed transitions (incl.
//     IN_EXPORT_CONSIGNMENT→SOLD) are rejected with InvalidTransitionError
//   - each transition writes exactly one device_events row with the
//     correct from_status/to_status/user_id/organisation_id
//   - the audit-trail invariant holds as an automated assertion:
//     device.status === (most recent device_events row).to_status
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ALLOWED_TRANSITIONS,
  DeviceNotFoundError,
  InvalidTransitionError,
  transitionDevice,
} from '../src/lib/deviceLifecycle'
import type { AuthUser, DeviceStatus } from '../src/types'
import { DEVICE_STATUSES } from '../src/types'

const db = () => (env as unknown as { DB: D1Database }).DB

const ADMIN_USER: AuthUser = {
  id: 1,
  email: 'admin@goodsin.local',
  name: 'Seed Admin',
  role: 'admin',
  organisation_id: 1,
}

// A second user/org to prove org_id/user_id on the event row are the
// actual caller's, not hardcoded/assumed.
const OTHER_ORG_USER: AuthUser = {
  id: 99,
  email: 'other@example.com',
  name: 'Other Org User',
  role: 'operator',
  organisation_id: 2,
}

// Same-org (org 1) operator fixture for the transitionDevice()-level
// reject/un-reject gate tests below — OTHER_ORG_USER above is
// deliberately in a DIFFERENT org, so using it against an org-1-seeded
// device would 404 before the gate is ever reached, not exercise the
// gate itself.
const SAME_ORG_OPERATOR_USER: AuthUser = {
  id: 98,
  email: 'same-org-operator@example.com',
  name: 'Same-Org Operator',
  role: 'operator',
  organisation_id: 1,
}

let nextImei = 350000000000001

// Inserts a received_devices row directly (bypassing the API) so each test
// starts from a known, isolated status. Returns the new device id.
async function seedDevice(status: DeviceStatus, organisationId = 1): Promise<number> {
  const imei = String(nextImei++)
  const uuid = `test-uuid-${imei}`
  const result = await db()
    .prepare(
      `INSERT INTO received_devices
         (organisation_id, uuid, imei, sku, source, status)
       VALUES (?, ?, ?, ?, 'manual', ?)`
    )
    .bind(organisationId, uuid, imei, 'TEST-SKU', status)
    .run()
  return result.meta.last_row_id as number
}

async function eventsFor(deviceId: number) {
  const { results } = await db()
    .prepare('SELECT * FROM device_events WHERE device_id = ? ORDER BY id ASC')
    .bind(deviceId)
    .all<Record<string, unknown>>()
  return results
}

beforeEach(async () => {
  // Second org + user needed for the org-scoping / cross-tenant tests below.
  // Both organisation_id and user_id are FK-enforced on device_events, so
  // OTHER_ORG_USER must correspond to a real row, not just a plausible id.
  await db()
    .prepare(`INSERT OR IGNORE INTO organisations (id, name, slug) VALUES (2, 'Other Org', 'other')`)
    .run()
  await db()
    .prepare(
      `INSERT OR IGNORE INTO users (id, email, name, role, organisation_id) VALUES (?, ?, ?, ?, ?)`
    )
    .bind(OTHER_ORG_USER.id, OTHER_ORG_USER.email, OTHER_ORG_USER.name, OTHER_ORG_USER.role, OTHER_ORG_USER.organisation_id)
    .run()
  await db()
    .prepare(
      `INSERT OR IGNORE INTO users (id, email, name, role, organisation_id) VALUES (?, ?, ?, ?, ?)`
    )
    .bind(SAME_ORG_OPERATOR_USER.id, SAME_ORG_OPERATOR_USER.email, SAME_ORG_OPERATOR_USER.name, SAME_ORG_OPERATOR_USER.role, SAME_ORG_OPERATOR_USER.organisation_id)
    .run()
})

// The two reject/un-reject edges now require a reason_code even at this
// raw transitionDevice() layer (2026-09-07 defence-in-depth — see
// checkRejectUnrejectGate's comment). ADMIN_USER already satisfies the
// role half of that gate (role check is manager-or-admin); this helper
// supplies a syntactically-valid reason_code for exactly those two edges
// so the generic sweeps below keep exercising every OTHER edge with a
// plain, reason-code-free call, unaffected by the gate.
function reasonMetadataFor(from: DeviceStatus, to: DeviceStatus): Record<string, unknown> | undefined {
  if (from === 'RECEIVED' && to === 'REJECTED') return { reason_code: 'faulty_on_test' }
  if (from === 'REJECTED' && to === 'RECEIVED') return { reason_code: 'rejected_in_error' }
  return undefined
}

describe('transitionDevice — allowed transitions', () => {
  for (const [from, tos] of Object.entries(ALLOWED_TRANSITIONS) as [DeviceStatus, DeviceStatus[]][]) {
    for (const to of tos) {
      it(`allows ${from} → ${to}`, async () => {
        const deviceId = await seedDevice(from)

        const { device, event } = await transitionDevice(db(), deviceId, to, { user: ADMIN_USER, metadata: reasonMetadataFor(from, to) })

        expect(device.status).toBe(to)
        expect(event.from_status).toBe(from)
        expect(event.to_status).toBe(to)
      })
    }
  }
})

describe('transitionDevice — disallowed transitions are rejected', () => {
  // Representative set spanning: an export-workflow jump that's out of
  // scope, a same-status no-op, a transition out of every
  // terminal/no-outgoing-transition status, and a SOLD-edge exclusion.
  //
  // NOTE (2026-09-01): REJECTED -> RECEIVED moved OUT of this list — it is
  // now an allowed edge (live-incident fix, devices 588/619 stranded in
  // REJECTED with no way back). See the dedicated
  // 'transitionDevice — reject / un-reject edge' describe block below for
  // its coverage, and REJECTED -> anywhere-else-RECEIVED-can-reach for the
  // negative case proving the edge is scoped to RECEIVED only.
  //
  // NOTE (2026-09-09): RECEIVED -> SOLD moved OUT of this list — it is now
  // an allowed edge (SOLD transition edge decision, see the header comment
  // above ALLOWED_TRANSITIONS in src/lib/deviceLifecycle.ts: Zoho is the
  // authoritative external record of a sale, so a real sale can legitimately
  // be recorded before this app's own workflow has caught up to
  // ACTIVE_INVENTORY). IN_EXPORT_CONSIGNMENT -> SOLD substituted below as
  // the equivalent negative case: a device under an open OPR/temp-export
  // consignment must surface a named conflict on a Zoho sale match, never
  // a silent status overwrite, so that edge stays deliberately excluded.
  const disallowed: [DeviceStatus, DeviceStatus][] = [
    ['IN_EXPORT_CONSIGNMENT', 'SOLD'], // consignment-locked stock, excluded by design
    ['RECEIVED', 'ACTIVE_INVENTORY'], // skipping SORTING
    ['SORTING', 'EXPORTED_UNDER_OPR'], // must go via IN_EXPORT_CONSIGNMENT (OPR finalisation)
    ['ACTIVE_INVENTORY', 'IN_HOUSE_REPAIR'], // ACTIVE_INVENTORY has no outgoing transitions
    ['REJECTED', 'SORTING'], // REJECTED may ONLY re-enter at RECEIVED, never skip ahead
    ['REJECTED', 'ACTIVE_INVENTORY'], // same — must restart the flow from RECEIVED
    ['RECEIVED', 'RECEIVED'], // same-status no-op is not a valid transition
  ]

  for (const [from, to] of disallowed) {
    it(`rejects ${from} → ${to}`, async () => {
      const deviceId = await seedDevice(from)

      await expect(
        transitionDevice(db(), deviceId, to, { user: ADMIN_USER })
      ).rejects.toBeInstanceOf(InvalidTransitionError)

      // Rejected transitions must not mutate device or write an event.
      const device = await db()
        .prepare('SELECT status FROM received_devices WHERE id = ?')
        .bind(deviceId)
        .first<{ status: string }>()
      expect(device?.status).toBe(from)
      expect(await eventsFor(deviceId)).toHaveLength(0)
    })
  }

  it('rejects an unknown target status', async () => {
    const deviceId = await seedDevice('RECEIVED')
    await expect(
      transitionDevice(db(), deviceId, 'NOT_A_REAL_STATUS' as DeviceStatus, { user: ADMIN_USER })
    ).rejects.toThrow('Unknown target status')
  })

  it('rejects a transition on a device that does not exist', async () => {
    await expect(
      transitionDevice(db(), 999999, 'SORTING', { user: ADMIN_USER })
    ).rejects.toBeInstanceOf(DeviceNotFoundError)
  })

  it('rejects a transition on a device belonging to a different organisation', async () => {
    // Device seeded under org 1; caller is org 2 — must be treated as
    // not-found (org-scoping happens in the same query as the lookup),
    // never as a cross-tenant leak or a silent success.
    const deviceId = await seedDevice('RECEIVED', 1)
    await expect(
      transitionDevice(db(), deviceId, 'SORTING', { user: OTHER_ORG_USER })
    ).rejects.toBeInstanceOf(DeviceNotFoundError)
  })
})

describe('transitionDevice — device_events audit trail', () => {
  it('writes exactly one device_events row per transition, with correct from_status/to_status/user_id/organisation_id', async () => {
    const deviceId = await seedDevice('RECEIVED', 1)

    const { event } = await transitionDevice(db(), deviceId, 'SORTING', {
      user: ADMIN_USER,
      reference: 'test-ref-1',
    })

    const events = await eventsFor(deviceId)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      device_id: deviceId,
      organisation_id: ADMIN_USER.organisation_id,
      user_id: ADMIN_USER.id,
      from_status: 'RECEIVED',
      to_status: 'SORTING',
      reference: 'test-ref-1',
    })
    // The row returned by transitionDevice() must be that same row.
    expect(event.id).toBe(events[0].id)
  })

  it('appends a new row (does not overwrite) on a second transition, and each transition individually writes exactly one row', async () => {
    const deviceId = await seedDevice('RECEIVED', 1)

    await transitionDevice(db(), deviceId, 'SORTING', { user: ADMIN_USER })
    expect(await eventsFor(deviceId)).toHaveLength(1)

    await transitionDevice(db(), deviceId, 'ACTIVE_INVENTORY', { user: ADMIN_USER })
    const events = await eventsFor(deviceId)
    expect(events).toHaveLength(2)

    expect(events[0]).toMatchObject({ from_status: 'RECEIVED', to_status: 'SORTING' })
    expect(events[1]).toMatchObject({ from_status: 'SORTING', to_status: 'ACTIVE_INVENTORY' })
  })

  it('records the calling user_id and organisation_id, not a different or seeded default', async () => {
    // Seed device under org 2 and transition as OTHER_ORG_USER (also org 2)
    // to prove the values written are genuinely taken from ctx.user, not
    // just always matching the org-1 seed data by coincidence.
    const deviceId = await seedDevice('RECEIVED', 2)

    await transitionDevice(db(), deviceId, 'SORTING', { user: OTHER_ORG_USER })

    const events = await eventsFor(deviceId)
    expect(events).toHaveLength(1)
    expect(events[0].user_id).toBe(OTHER_ORG_USER.id)
    expect(events[0].organisation_id).toBe(OTHER_ORG_USER.organisation_id)
  })
})

describe('transitionDevice — audit-trail invariant', () => {
  // The core acceptance criterion from the brief: a device's current status
  // must always equal the to_status of its most recent device_events row.
  // This is asserted automatically here so a future refactor of
  // transitionDevice() (or a bypass of it) cannot silently break the
  // invariant without a test failing.
  async function assertInvariant(deviceId: number) {
    const device = await db()
      .prepare('SELECT status FROM received_devices WHERE id = ?')
      .bind(deviceId)
      .first<{ status: string }>()
    const latestEvent = await db()
      .prepare('SELECT to_status FROM device_events WHERE device_id = ? ORDER BY id DESC LIMIT 1')
      .bind(deviceId)
      .first<{ to_status: string }>()

    expect(device?.status).toBe(latestEvent?.to_status)
  }

  it('holds after a single transition', async () => {
    const deviceId = await seedDevice('RECEIVED')
    await transitionDevice(db(), deviceId, 'SORTING', { user: ADMIN_USER })
    await assertInvariant(deviceId)
  })

  it('holds after a chain of transitions', async () => {
    // NOTE: IN_HOUSE_REPAIR -> ACTIVE_INVENTORY was removed by Device
    // Lifecycle slice 1 (docs/plan/device-lifecycle-slice1.md, "Amendment
    // 2 resolution") — devices now leave IN_HOUSE_REPAIR only via a
    // recorded QC result. This chain is updated to use the new
    // IN_HOUSE_REPAIR -> READY_FOR_ZOHO edge so the test keeps exercising
    // a genuine multi-hop chain rather than being deleted.
    const deviceId = await seedDevice('RECEIVED')
    await transitionDevice(db(), deviceId, 'SORTING', { user: ADMIN_USER })
    await assertInvariant(deviceId)
    await transitionDevice(db(), deviceId, 'IN_HOUSE_REPAIR', { user: ADMIN_USER })
    await assertInvariant(deviceId)
    await transitionDevice(db(), deviceId, 'READY_FOR_ZOHO', { user: ADMIN_USER })
    await assertInvariant(deviceId)
  })

  it('holds (is unchanged) when a transition is rejected — status and latest event stay in sync', async () => {
    const deviceId = await seedDevice('RECEIVED')
    await transitionDevice(db(), deviceId, 'SORTING', { user: ADMIN_USER })
    await assertInvariant(deviceId)

    // ACTIVE_INVENTORY has no outgoing transitions defined yet at this
    // point the device is only in SORTING, so try an invalid jump instead.
    await expect(
      transitionDevice(db(), deviceId, 'EXPORTED_UNDER_OPR', { user: ADMIN_USER })
    ).rejects.toBeInstanceOf(InvalidTransitionError)

    // Still holds: the rejected attempt did not touch status or events.
    await assertInvariant(deviceId)
  })

  it('holds across every device independently seeded and transitioned in this run', async () => {
    // Belt-and-suspenders: sweep every allowed transition again, but this
    // time assert the invariant explicitly per-device rather than just
    // trusting transitionDevice()'s own return value.
    for (const [from, tos] of Object.entries(ALLOWED_TRANSITIONS) as [DeviceStatus, DeviceStatus[]][]) {
      for (const to of tos) {
        const deviceId = await seedDevice(from)
        await transitionDevice(db(), deviceId, to, { user: ADMIN_USER, metadata: reasonMetadataFor(from, to) })
        await assertInvariant(deviceId)
      }
    }
  })
})

describe('transitionDevice — reject / un-reject edge (2026-09-01 live-incident fix)', () => {
  // Route-level manager-gating/reason-code enforcement is covered in
  // test/devicesRejectRoute.spec.ts — this block's own focus is the raw
  // state-machine shape: REJECTED has exactly one outbound edge, back to
  // RECEIVED, and the round trip works.
  //
  // CORRECTED (2026-09-07): this file's own comment used to claim
  // "transitionDevice() itself is edge-agnostic about reason codes" — that
  // was true until this same commit added a defence-in-depth re-check of
  // checkRejectUnrejectGate() INSIDE transitionDevice() (closing the
  // bulk-transition bypass — see deviceLifecycle.ts's own comment on the
  // check). ADMIN_USER already satisfies the role half of that gate, so
  // every call on these two specific edges below now also supplies a
  // valid reason_code via metadata, same as a well-behaved route caller
  // would; every OTHER edge in this file is unaffected and untouched.
  it('allows RECEIVED -> REJECTED -> RECEIVED, a full round trip', async () => {
    const deviceId = await seedDevice('RECEIVED')

    await transitionDevice(db(), deviceId, 'REJECTED', { user: ADMIN_USER, metadata: { reason_code: 'faulty_on_test' } })
    expect((await db().prepare('SELECT status FROM received_devices WHERE id = ?').bind(deviceId).first<{ status: string }>())?.status).toBe('REJECTED')

    await transitionDevice(db(), deviceId, 'RECEIVED', { user: ADMIN_USER, metadata: { reason_code: 'rejected_in_error' } })
    expect((await db().prepare('SELECT status FROM received_devices WHERE id = ?').bind(deviceId).first<{ status: string }>())?.status).toBe('RECEIVED')

    const events = await eventsFor(deviceId)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ from_status: 'RECEIVED', to_status: 'REJECTED' })
    expect(events[1]).toMatchObject({ from_status: 'REJECTED', to_status: 'RECEIVED' })
  })

  it('REJECTED has exactly one outbound edge (RECEIVED), never a shortcut ahead', () => {
    expect(ALLOWED_TRANSITIONS.REJECTED).toEqual(['RECEIVED'])
  })

  it('a device un-rejected back to RECEIVED can re-run the normal flow from scratch', async () => {
    const deviceId = await seedDevice('RECEIVED')
    await transitionDevice(db(), deviceId, 'REJECTED', { user: ADMIN_USER, metadata: { reason_code: 'faulty_on_test' } })
    await transitionDevice(db(), deviceId, 'RECEIVED', { user: ADMIN_USER, metadata: { reason_code: 'rejected_in_error' } })

    // Proves it isn't a dead-end-that-looks-alive: the device can proceed
    // through the ordinary RECEIVED -> SORTING -> ACTIVE_INVENTORY chain
    // exactly as if it had never been rejected.
    await transitionDevice(db(), deviceId, 'SORTING', { user: ADMIN_USER })
    await transitionDevice(db(), deviceId, 'ACTIVE_INVENTORY', { user: ADMIN_USER })
    expect((await db().prepare('SELECT status FROM received_devices WHERE id = ?').bind(deviceId).first<{ status: string }>())?.status).toBe('ACTIVE_INVENTORY')
  })
})

// 2026-09-07 — closes the bulk-transition bypass (POST /devices/bulk-
// transition called transitionDevice() directly with no gate at all).
// This block proves the backstop lives INSIDE transitionDevice() itself,
// by calling it directly (bypassing every route) exactly the way the
// defective bulk-transition handler used to — an operator role and a
// missing/invalid reason_code must still be refused even with no route
// in front of it at all.
describe('transitionDevice — reject/un-reject gate is enforced INSIDE transitionDevice() itself (defence-in-depth, 2026-09-07)', () => {
  it('operator role calling transitionDevice() directly for RECEIVED -> REJECTED is refused, device unchanged, no event written', async () => {
    const deviceId = await seedDevice('RECEIVED')
    await expect(
      transitionDevice(db(), deviceId, 'REJECTED', { user: SAME_ORG_OPERATOR_USER, metadata: { reason_code: 'faulty_on_test' } })
    ).rejects.toMatchObject({ status: 403 })
    expect((await db().prepare('SELECT status FROM received_devices WHERE id = ?').bind(deviceId).first<{ status: string }>())?.status).toBe('RECEIVED')
    expect(await eventsFor(deviceId)).toHaveLength(0)
  })

  it('admin/manager role but missing reason_code is refused with 422, device unchanged', async () => {
    const deviceId = await seedDevice('RECEIVED')
    await expect(
      transitionDevice(db(), deviceId, 'REJECTED', { user: ADMIN_USER })
    ).rejects.toMatchObject({ status: 422 })
    expect((await db().prepare('SELECT status FROM received_devices WHERE id = ?').bind(deviceId).first<{ status: string }>())?.status).toBe('RECEIVED')
    expect(await eventsFor(deviceId)).toHaveLength(0)
  })

  it('admin/manager role but an unrecognised reason_code is refused with 422, device unchanged', async () => {
    const deviceId = await seedDevice('RECEIVED')
    await expect(
      transitionDevice(db(), deviceId, 'REJECTED', { user: ADMIN_USER, metadata: { reason_code: 'not_a_real_code' } })
    ).rejects.toMatchObject({ status: 422 })
    expect((await db().prepare('SELECT status FROM received_devices WHERE id = ?').bind(deviceId).first<{ status: string }>())?.status).toBe('RECEIVED')
  })

  it('operator role calling transitionDevice() directly for REJECTED -> RECEIVED (un-reject) is refused, device unchanged', async () => {
    const deviceId = await seedDevice('REJECTED')
    await expect(
      transitionDevice(db(), deviceId, 'RECEIVED', { user: SAME_ORG_OPERATOR_USER, metadata: { reason_code: 'rejected_in_error' } })
    ).rejects.toMatchObject({ status: 403 })
    expect((await db().prepare('SELECT status FROM received_devices WHERE id = ?').bind(deviceId).first<{ status: string }>())?.status).toBe('REJECTED')
  })

  it('every OTHER edge is unaffected by this gate — no role/reason_code required (the gate is scoped to exactly these two edges)', async () => {
    const deviceId = await seedDevice('RECEIVED')
    await expect(
      transitionDevice(db(), deviceId, 'SORTING', { user: SAME_ORG_OPERATOR_USER })
    ).resolves.toMatchObject({ device: { status: 'SORTING' } })
  })
})

describe('DEVICE_STATUSES / ALLOWED_TRANSITIONS sanity', () => {
  it('every key and value in ALLOWED_TRANSITIONS is a real DeviceStatus', () => {
    for (const [from, tos] of Object.entries(ALLOWED_TRANSITIONS)) {
      expect(DEVICE_STATUSES).toContain(from)
      for (const to of tos) expect(DEVICE_STATUSES).toContain(to)
    }
  })

  it('every DeviceStatus has an entry (possibly empty) in ALLOWED_TRANSITIONS', () => {
    for (const status of DEVICE_STATUSES) {
      expect(Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, status)).toBe(true)
    }
  })
})
