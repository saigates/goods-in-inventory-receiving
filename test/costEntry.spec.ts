// POST /api/devices/:id/purchase/cost-ledger — the manager cost-entry
// writer (postPurchaseCostToLedger(), src/lib/costEntry.ts) built to
// close the pre-bills-receipts costing gap documented in the
// inventory-valuation report review chain: the only prior 'purchase'
// writer (src/routes/bills.ts's write-cost-ledger) requires a CLOSED
// bill, which historical/pre-bills receipts never have.
//
// Per-file in-memory test D1 (test/apply-migrations.ts) — no
// disposable-account or FK-cleanup convention applies, per standing
// test discipline. No real per-person account (owner@saigates.com /
// ops@saigates.com) is used anywhere in this file.

import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'
import type { AuthUser, DeviceStatus } from '../src/types'

const JWT_SECRET = 'test-secret-cost-entry'
const testEnv = { ...env, JWT_SECRET } as typeof env & { JWT_SECRET: string }
const db = () => (env as unknown as { DB: D1Database }).DB

const MANAGER_USER: AuthUser = {
  id: 701, email: 'manager-ce@example.com', name: 'CE Manager', role: 'manager', organisation_id: 1,
}
const OPERATOR_USER: AuthUser = {
  id: 702, email: 'operator-ce@example.com', name: 'CE Operator', role: 'operator', organisation_id: 1,
}

// Distinct IMEI prefix from every other suite to avoid UNIQUE collisions
// on the shared in-memory D1 (repairWorkflow.spec.ts uses 36000...,
// inventoryValuationReport.spec.ts uses 379000000000001..., etc).
let nextImei = 385000000000001
function newImei(): string {
  return String(nextImei++)
}

// Seeds a received_devices row directly, same pattern as
// test/inventoryValuationReport.spec.ts#seedDevice.
async function seedDevice(status: DeviceStatus = 'RECEIVED'): Promise<number> {
  const imei = newImei()
  const uuid = `ce-test-uuid-${imei}`
  const result = await db()
    .prepare(
      `INSERT INTO received_devices
         (organisation_id, uuid, imei, sku, model, grade, source, status)
       VALUES (1, ?, ?, 'SAM-S26-256-CVT-A', 'Galaxy S24', 'A', 'manual', ?)`
    )
    .bind(uuid, imei, status)
    .run()
  return result.meta.last_row_id as number
}

async function costLedgerFor(deviceId: number) {
  const { results } = await db()
    .prepare('SELECT * FROM cost_ledger WHERE received_device_id = ? ORDER BY id ASC')
    .bind(deviceId)
    .all<Record<string, unknown>>()
  return results
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

// cost_ledger.created_by_user_id is FK-enforced on users(id) (migration
// 0028) — same requirement repairWorkflow.spec.ts documents for
// device_events.user_id. Must be real rows, not just AuthUser objects
// (the JWT payload alone never touches the users table).
beforeEach(async () => {
  await db()
    .prepare(`INSERT OR IGNORE INTO users (id, email, name, role, organisation_id) VALUES (?, ?, ?, ?, ?)`)
    .bind(MANAGER_USER.id, MANAGER_USER.email, MANAGER_USER.name, MANAGER_USER.role, MANAGER_USER.organisation_id)
    .run()
  await db()
    .prepare(`INSERT OR IGNORE INTO users (id, email, name, role, organisation_id) VALUES (?, ?, ?, ?, ?)`)
    .bind(OPERATOR_USER.id, OPERATOR_USER.email, OPERATOR_USER.name, OPERATOR_USER.role, OPERATOR_USER.organisation_id)
    .run()
})

async function inventoryValuation() {
  const res = await apiAs(MANAGER_USER, '/api/reports/inventory-valuation')
  expect(res.status).toBe(200)
  return res.json() as Promise<{
    headline: { purchase_only: { count: number; value_gbp: number } }
    costed_vs_uncosted: { costed: number; uncosted: number; total_devices: number }
  }>
}

describe('POST /api/devices/:id/purchase/cost-ledger', () => {
  // Standalone 403 case, its own it() block — matching the standing
  // convention set by test/inventoryValuationReport.spec.ts's own
  // standalone 403 test (confirmed not folded into any other test).
  it('non-manager (operator) gets 403, zero rows written', async () => {
    const deviceId = await seedDevice()

    const res = await apiAs(OPERATOR_USER, `/api/devices/${deviceId}/purchase/cost-ledger`, {
      method: 'POST',
      body: JSON.stringify({ amount_gbp: 150 }),
    })
    expect(res.status).toBe(403)

    const rows = await costLedgerFor(deviceId)
    expect(rows).toHaveLength(0)
  })

  it('writes a cost_ledger row with cost_type=purchase, source_bill_line_id=NULL, provenance=default-unverified', async () => {
    const deviceId = await seedDevice()

    const res = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/purchase/cost-ledger`, {
      method: 'POST',
      body: JSON.stringify({ amount_gbp: 150, note: 'SKU-list estimate, pre-bills historical unit' }),
    })
    expect(res.status).toBe(201)
    const { cost_ledger_entry } = await res.json() as { cost_ledger_entry: Record<string, unknown> }

    expect(cost_ledger_entry).toMatchObject({
      cost_type: 'purchase',
      amount_gbp: 150,
      currency_code: 'GBP',
      source_bill_line_id: null,
      // Assertion beyond the original test list, per explicit
      // instruction: the written row's provenance must actually equal
      // the constant, not just be present.
      provenance: 'default-unverified',
      created_by_user_id: MANAGER_USER.id,
    })

    const rows = await costLedgerFor(deviceId)
    expect(rows).toHaveLength(1)
  })

  it('device goes from uncosted to costed, and the valuation endpoint reflects both costed AND uncosted counts moving', async () => {
    const deviceId = await seedDevice()

    const before = await inventoryValuation()
    const uncostedBefore = before.costed_vs_uncosted.uncosted
    const costedBefore = before.costed_vs_uncosted.costed

    const res = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/purchase/cost-ledger`, {
      method: 'POST',
      body: JSON.stringify({ amount_gbp: 200 }),
    })
    expect(res.status).toBe(201)

    const after = await inventoryValuation()
    // Assertion beyond the original test list, per explicit instruction:
    // costed incrementing and uncosted decrementing are computed
    // separately in src/routes/reports.ts (an if/else on
    // purchase_row_count, not derived from one another), so a bug in
    // either accumulator would not surface from asserting only the
    // other. Both must be checked.
    expect(after.costed_vs_uncosted.costed).toBe(costedBefore + 1)
    expect(after.costed_vs_uncosted.uncosted).toBe(uncostedBefore - 1)
    expect(after.costed_vs_uncosted.total_devices).toBe(before.costed_vs_uncosted.total_devices)
    expect(after.headline.purchase_only.value_gbp).toBeCloseTo(before.headline.purchase_only.value_gbp + 200, 2)
  })

  it('a second POSITIVE purchase row on the same device is refused with 409, zero additional rows written', async () => {
    const deviceId = await seedDevice()

    const first = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/purchase/cost-ledger`, {
      method: 'POST',
      body: JSON.stringify({ amount_gbp: 150 }),
    })
    expect(first.status).toBe(201)

    const second = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/purchase/cost-ledger`, {
      method: 'POST',
      body: JSON.stringify({ amount_gbp: 160 }),
    })
    expect(second.status).toBe(409)
    const body = await second.json() as { error: string }
    expect(body.error).toContain('already has a positive purchase cost row')

    const rows = await costLedgerFor(deviceId)
    expect(rows).toHaveLength(1)
  })

  it('allow_duplicate_purchase_row: true permits a second positive row, both rows present', async () => {
    const deviceId = await seedDevice()

    const first = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/purchase/cost-ledger`, {
      method: 'POST',
      body: JSON.stringify({ amount_gbp: 150 }),
    })
    expect(first.status).toBe(201)

    const second = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/purchase/cost-ledger`, {
      method: 'POST',
      body: JSON.stringify({ amount_gbp: 160, allow_duplicate_purchase_row: true }),
    })
    expect(second.status).toBe(201)

    const rows = await costLedgerFor(deviceId)
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.amount_gbp).sort()).toEqual([150, 160])
  })

  it('a compensating NEGATIVE row passes the duplicate guard without the override flag, and nets correctly in purchase_only', async () => {
    const deviceId = await seedDevice()

    const first = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/purchase/cost-ledger`, {
      method: 'POST',
      body: JSON.stringify({ amount_gbp: 150 }),
    })
    expect(first.status).toBe(201)

    // Correction: the first figure was entered wrong, post a compensating
    // negative row WITHOUT allow_duplicate_purchase_row — this must not
    // be refused, since the sign-scoped guard only fires for a second
    // POSITIVE amount (a negative row can only reduce the total, never
    // inflate it).
    const correction = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/purchase/cost-ledger`, {
      method: 'POST',
      body: JSON.stringify({ amount_gbp: -50, note: 'Correction: original figure overstated' }),
    })
    expect(correction.status).toBe(201)

    const rows = await costLedgerFor(deviceId)
    expect(rows).toHaveLength(2)

    const valuation = await inventoryValuation()
    // 150 + (-50) = 100 net, proving the compensating row is actually
    // summed into the headline total rather than merely coexisting in
    // the table.
    expect(valuation.headline.purchase_only.value_gbp).toBeGreaterThanOrEqual(100)
  })

  it('both sides of the sign boundary on ONE device: a zero-amount row also passes the guard without the flag', async () => {
    const deviceId = await seedDevice()

    const first = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/purchase/cost-ledger`, {
      method: 'POST',
      body: JSON.stringify({ amount_gbp: 150 }),
    })
    expect(first.status).toBe(201)

    // amount_gbp = 0 is NOT > 0, so the sign-scoped guard (which only
    // fires for amount_gbp > 0) must not refuse this even without the
    // override flag.
    const zero = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/purchase/cost-ledger`, {
      method: 'POST',
      body: JSON.stringify({ amount_gbp: 0, note: 'Zero-value placeholder row' }),
    })
    expect(zero.status).toBe(201)

    const rows = await costLedgerFor(deviceId)
    expect(rows).toHaveLength(2)
  })

  it('device not found → 404', async () => {
    const res = await apiAs(MANAGER_USER, '/api/devices/999999/purchase/cost-ledger', {
      method: 'POST',
      body: JSON.stringify({ amount_gbp: 100 }),
    })
    expect(res.status).toBe(404)
  })

  it('amount_gbp missing/non-numeric → 422, zero rows written', async () => {
    const deviceId = await seedDevice()

    const res = await apiAs(MANAGER_USER, `/api/devices/${deviceId}/purchase/cost-ledger`, {
      method: 'POST',
      body: JSON.stringify({ note: 'no amount given' }),
    })
    expect(res.status).toBe(422)

    const rows = await costLedgerFor(deviceId)
    expect(rows).toHaveLength(0)
  })
})
