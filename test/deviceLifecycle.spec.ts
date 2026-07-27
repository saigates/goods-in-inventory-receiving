// State-machine transition tests (Priority 2 & 3).
//
// Covers:
//   - every allowed transition in ALLOWED_TRANSITIONS succeeds
//   - a representative set of disallowed transitions (incl. RECEIVED→SOLD)
//     are rejected with InvalidTransitionError
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
})

describe('transitionDevice — allowed transitions', () => {
  for (const [from, tos] of Object.entries(ALLOWED_TRANSITIONS) as [DeviceStatus, DeviceStatus[]][]) {
    for (const to of tos) {
      it(`allows ${from} → ${to}`, async () => {
        const deviceId = await seedDevice(from)

        const { device, event } = await transitionDevice(db(), deviceId, to, { user: ADMIN_USER })

        expect(device.status).toBe(to)
        expect(event.from_status).toBe(from)
        expect(event.to_status).toBe(to)
      })
    }
  }
})

describe('transitionDevice — disallowed transitions are rejected', () => {
  // Representative set spanning: the brief's explicit example, an
  // export-workflow jump that's out of scope, a same-status no-op, and a
  // transition out of every terminal/no-outgoing-transition status.
  const disallowed: [DeviceStatus, DeviceStatus][] = [
    ['RECEIVED', 'SOLD'], // explicitly named in the brief
    ['RECEIVED', 'ACTIVE_INVENTORY'], // skipping SORTING
    ['SORTING', 'EXPORTED_UNDER_OPR'], // must go via IN_EXPORT_CONSIGNMENT (OPR finalisation)
    ['ACTIVE_INVENTORY', 'IN_HOUSE_REPAIR'], // ACTIVE_INVENTORY has no outgoing transitions
    ['REJECTED', 'RECEIVED'], // terminal status, no way back
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
    const deviceId = await seedDevice('RECEIVED')
    await transitionDevice(db(), deviceId, 'SORTING', { user: ADMIN_USER })
    await assertInvariant(deviceId)
    await transitionDevice(db(), deviceId, 'IN_HOUSE_REPAIR', { user: ADMIN_USER })
    await assertInvariant(deviceId)
    await transitionDevice(db(), deviceId, 'ACTIVE_INVENTORY', { user: ADMIN_USER })
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
        await transitionDevice(db(), deviceId, to, { user: ADMIN_USER })
        await assertInvariant(deviceId)
      }
    }
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
