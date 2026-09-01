// Route-level coverage for the REJECTED <-> RECEIVED edge added to
// POST /api/devices/:id/transition (2026-09-01 live-incident fix, devices
// 588/619 stranded in REJECTED with no way back — see
// src/lib/deviceLifecycle.ts's ALLOWED_TRANSITIONS.REJECTED comment).
//
// Scope of this file: everything the ROUTE adds on top of the raw
// state-machine edge already covered by
// test/deviceLifecycle.spec.ts's 'reject / un-reject edge' block —
//   - manager-only gating, scoped to EXACTLY these two edges (every other
//     transition on this route stays open to any role, unchanged and
//     untouched by this fix — see devices.ts's isRejectEdge/isUnrejectEdge
//     scoping)
//   - mandatory reason_code on both edges, drawn from the enumerated
//     REJECT_REASON_CODES / UNREJECT_REASON_CODES lists
//   - an unrecognised reason_code is rejected (422), not silently stored
//   - the accepted reason_code lands in device_events.metadata.reason_code
import { env } from 'cloudflare:workers'
import { beforeEach, describe, it, expect } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'
import { REJECT_REASON_CODES, UNREJECT_REASON_CODES } from '../src/lib/deviceLifecycle'
import type { AuthUser, DeviceStatus } from '../src/types'

const JWT_SECRET = 'test-secret-devices-reject-route'
const testEnv = { ...env, JWT_SECRET } as typeof env & { JWT_SECRET: string }
const db = () => (env as unknown as { DB: D1Database }).DB

const MANAGER_USER: AuthUser = {
  id: 601, email: 'manager-reject@example.com', name: 'Reject-Route Manager', role: 'manager', organisation_id: 1,
}
const OPERATOR_USER: AuthUser = {
  id: 602, email: 'operator-reject@example.com', name: 'Reject-Route Operator', role: 'operator', organisation_id: 1,
}
const ADMIN_USER: AuthUser = {
  id: 603, email: 'admin-reject@example.com', name: 'Reject-Route Admin', role: 'admin', organisation_id: 1,
}

let nextImei = 370000000000001
// Distinct IMEI range from every other suite (base 37000...) to avoid
// UNIQUE collisions if files ever share a D1 instance.
function newImei(): string {
  return String(nextImei++)
}

async function seedDevice(status: DeviceStatus, organisationId = 1): Promise<number> {
  const imei = newImei()
  const uuid = `reject-route-test-uuid-${imei}`
  const result = await db()
    .prepare(
      `INSERT INTO received_devices (organisation_id, uuid, imei, sku, source, status)
       VALUES (?, ?, ?, ?, 'manual', ?)`
    )
    .bind(organisationId, uuid, imei, 'TEST-SKU', status)
    .run()
  return result.meta.last_row_id as number
}

async function deviceStatus(deviceId: number): Promise<string | undefined> {
  const row = await db().prepare('SELECT status FROM received_devices WHERE id = ?').bind(deviceId).first<{ status: string }>()
  return row?.status
}

async function latestEvent(deviceId: number) {
  return db().prepare('SELECT * FROM device_events WHERE device_id = ? ORDER BY id DESC LIMIT 1').bind(deviceId).first<Record<string, unknown>>()
}

// FK-enforced on device_events.user_id (confirmed the hard way in Part 1 —
// see fc356c2's fixture fix — so every fixture user here must be a real
// `users` row, not just a plausible AuthUser object), same pattern as
// test/repairWorkflow.spec.ts's beforeEach.
beforeEach(async () => {
  for (const user of [MANAGER_USER, OPERATOR_USER, ADMIN_USER]) {
    await db()
      .prepare(`INSERT OR IGNORE INTO users (id, email, name, role, organisation_id) VALUES (?, ?, ?, ?, ?)`)
      .bind(user.id, user.email, user.name, user.role, user.organisation_id)
      .run()
  }
})

async function apiAs(user: AuthUser, path: string, init: RequestInit = {}) {
  const token = await signAuthToken(JWT_SECRET, user)
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  }, testEnv)
}

describe('POST /:id/transition — reject edge (RECEIVED -> REJECTED) gating', () => {
  it('operator attempting to reject a device -> 403, device unchanged', async () => {
    const deviceId = await seedDevice('RECEIVED')
    const res = await apiAs(OPERATOR_USER, `/api/devices/${deviceId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ to_status: 'REJECTED', reason_code: 'faulty_on_test' }),
    })
    expect(res.status).toBe(403)
    expect(await deviceStatus(deviceId)).toBe('RECEIVED')
  })

  it('manager rejecting without a reason_code -> 422, device unchanged', async () => {
    const deviceId = await seedDevice('RECEIVED')
    const res = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ to_status: 'REJECTED' }),
    })
    expect(res.status).toBe(422)
    expect(await deviceStatus(deviceId)).toBe('RECEIVED')
  })

  it('manager rejecting with an unrecognised reason_code -> 422, device unchanged, no silent store', async () => {
    const deviceId = await seedDevice('RECEIVED')
    const res = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ to_status: 'REJECTED', reason_code: 'not_a_real_code' }),
    })
    expect(res.status).toBe(422)
    expect(await deviceStatus(deviceId)).toBe('RECEIVED')
  })

  it('manager rejecting with a valid reason_code -> 200, device REJECTED, reason_code recorded on the event', async () => {
    const deviceId = await seedDevice('RECEIVED')
    const res = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ to_status: 'REJECTED', reason_code: 'faulty_on_test' }),
    })
    expect(res.status).toBe(200)
    expect(await deviceStatus(deviceId)).toBe('REJECTED')

    const event = await latestEvent(deviceId)
    expect(event).toMatchObject({ from_status: 'RECEIVED', to_status: 'REJECTED', event_type: 'REJECT' })
    expect(JSON.parse(String(event!.metadata))).toMatchObject({ reason_code: 'faulty_on_test' })
  })

  it('admin (not just manager) can reject — the placeholder role check is manager-or-admin, matching every sibling gate', async () => {
    const deviceId = await seedDevice('RECEIVED')
    const res = await apiAs(ADMIN_USER, `/api/devices/${deviceId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ to_status: 'REJECTED', reason_code: 'imei_mismatch' }),
    })
    expect(res.status).toBe(200)
    expect(await deviceStatus(deviceId)).toBe('REJECTED')
  })

  it('every REJECT_REASON_CODES entry is independently accepted', async () => {
    for (const code of REJECT_REASON_CODES) {
      const deviceId = await seedDevice('RECEIVED')
      const res = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ to_status: 'REJECTED', reason_code: code }),
      })
      expect(res.status).toBe(200)
    }
  })
})

describe('POST /:id/transition — un-reject edge (REJECTED -> RECEIVED) gating', () => {
  it('operator attempting to un-reject a device -> 403, device unchanged', async () => {
    const deviceId = await seedDevice('REJECTED')
    const res = await apiAs(OPERATOR_USER, `/api/devices/${deviceId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ to_status: 'RECEIVED', reason_code: 'rejected_in_error' }),
    })
    expect(res.status).toBe(403)
    expect(await deviceStatus(deviceId)).toBe('REJECTED')
  })

  it('manager un-rejecting without a reason_code -> 422, device unchanged', async () => {
    const deviceId = await seedDevice('REJECTED')
    const res = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ to_status: 'RECEIVED' }),
    })
    expect(res.status).toBe(422)
    expect(await deviceStatus(deviceId)).toBe('REJECTED')
  })

  it('manager un-rejecting with an unrecognised reason_code -> 422, device unchanged', async () => {
    const deviceId = await seedDevice('REJECTED')
    const res = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ to_status: 'RECEIVED', reason_code: 'faulty_on_test' }), // a REJECT code, not an UNREJECT one
    })
    expect(res.status).toBe(422)
    expect(await deviceStatus(deviceId)).toBe('REJECTED')
  })

  it('manager un-rejecting with a valid reason_code -> 200, device RECEIVED, reason_code recorded on the event', async () => {
    const deviceId = await seedDevice('REJECTED')
    const res = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ to_status: 'RECEIVED', reason_code: 'rejected_in_error' }),
    })
    expect(res.status).toBe(200)
    expect(await deviceStatus(deviceId)).toBe('RECEIVED')

    const event = await latestEvent(deviceId)
    expect(event).toMatchObject({ from_status: 'REJECTED', to_status: 'RECEIVED', event_type: 'UNREJECT' })
    expect(JSON.parse(String(event!.metadata))).toMatchObject({ reason_code: 'rejected_in_error' })
  })

  it('every UNREJECT_REASON_CODES entry is independently accepted', async () => {
    for (const code of UNREJECT_REASON_CODES) {
      const deviceId = await seedDevice('REJECTED')
      const res = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ to_status: 'RECEIVED', reason_code: code }),
      })
      expect(res.status).toBe(200)
    }
  })
})

describe('POST /:id/transition — reject/un-reject gating is scoped to ONLY these two edges', () => {
  // The whole point of scoping (per instruction): every other transition
  // on this route must keep working for an operator, unchanged, with no
  // reason_code required — proving the new gate didn't leak onto
  // unrelated edges.
  it('operator can still drive RECEIVED -> SORTING with no reason_code, unaffected by the reject gate', async () => {
    const deviceId = await seedDevice('RECEIVED')
    const res = await apiAs(OPERATOR_USER, `/api/devices/${deviceId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ to_status: 'SORTING' }),
    })
    expect(res.status).toBe(200)
    expect(await deviceStatus(deviceId)).toBe('SORTING')
  })

  it('operator can still drive SORTING -> ACTIVE_INVENTORY with no reason_code', async () => {
    const deviceId = await seedDevice('SORTING')
    const res = await apiAs(OPERATOR_USER, `/api/devices/${deviceId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ to_status: 'ACTIVE_INVENTORY' }),
    })
    expect(res.status).toBe(200)
    expect(await deviceStatus(deviceId)).toBe('ACTIVE_INVENTORY')
  })
})

// GET /devices/meta/statuses is the frontend's ONLY source for the reason
// codes (public/static/app.js's RejectReasonModal reads
// state.deviceStatuses.reason_codes — no hardcoded list on the client, the
// same single-source-of-truth principle already applied to `transitions`).
// This locks the response shape so a future rename/refactor of
// REJECT_REASON_CODES/UNREJECT_REASON_CODES can't silently break the UI's
// dropdown without a test noticing.
describe('GET /devices/meta/statuses — reason_codes exposed for the UI (2026-09-01)', () => {
  it('exposes REJECTED and UNREJECT reason code lists matching the exported constants exactly', async () => {
    const res = await apiAs(MANAGER_USER, '/api/devices/meta/statuses', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = await res.json() as { reason_codes: { REJECTED: string[]; UNREJECT: string[] } }
    expect(body.reason_codes.REJECTED).toEqual([...REJECT_REASON_CODES])
    expect(body.reason_codes.UNREJECT).toEqual([...UNREJECT_REASON_CODES])
  })
})

// Role-filtered `transitions` (2026-09-01, second pass — the same failure
// class caught one layer up: serving the unfiltered map to an operator
// would let their "Move to" dropdown offer an edge that always 403s once
// picked). This is the server-side fix, so the frontend needs no per-edge
// role logic of its own — it just renders whatever transitions this
// endpoint returns, exactly like it already does for reason_codes.
describe('GET /devices/meta/statuses — transitions map is role-filtered on the reject/un-reject edges', () => {
  it('manager/admin see the full map, including RECEIVED->REJECTED and REJECTED->RECEIVED', async () => {
    for (const user of [MANAGER_USER, ADMIN_USER]) {
      const res = await apiAs(user, '/api/devices/meta/statuses', { method: 'GET' })
      expect(res.status).toBe(200)
      const body = await res.json() as { transitions: Record<string, string[]> }
      expect(body.transitions.RECEIVED).toContain('REJECTED')
      expect(body.transitions.REJECTED).toEqual(['RECEIVED'])
    }
  })

  it('operator does NOT see REJECTED as a RECEIVED-outbound edge, and REJECTED has no outbound edges at all', async () => {
    const res = await apiAs(OPERATOR_USER, '/api/devices/meta/statuses', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = await res.json() as { transitions: Record<string, string[]> }
    expect(body.transitions.RECEIVED).not.toContain('REJECTED')
    expect(body.transitions.REJECTED).toEqual([])
  })

  it('operator still sees every OTHER edge unfiltered (RECEIVED->SORTING, SORTING->ACTIVE_INVENTORY, etc.) — filtering is scoped to exactly the two reject edges', async () => {
    const res = await apiAs(OPERATOR_USER, '/api/devices/meta/statuses', { method: 'GET' })
    const body = await res.json() as { transitions: Record<string, string[]> }
    expect(body.transitions.RECEIVED).toContain('SORTING')
    expect(body.transitions.SORTING).toEqual(expect.arrayContaining(['ACTIVE_INVENTORY', 'IN_HOUSE_REPAIR', 'READY_FOR_EXPORT']))
    expect(body.transitions.IN_HOUSE_REPAIR).toEqual(expect.arrayContaining(['READY_FOR_ZOHO', 'QC_FAILED']))
  })

  it('the filtered view never mutates the shared ALLOWED_TRANSITIONS export (operator call followed by a manager call still shows the full map)', async () => {
    await apiAs(OPERATOR_USER, '/api/devices/meta/statuses', { method: 'GET' })
    const res = await apiAs(MANAGER_USER, '/api/devices/meta/statuses', { method: 'GET' })
    const body = await res.json() as { transitions: Record<string, string[]> }
    expect(body.transitions.REJECTED).toEqual(['RECEIVED'])
  })
})
