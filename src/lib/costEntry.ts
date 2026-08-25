// Manager cost-entry writer — the mechanism agreed to close the
// pre-bills-receipts costing gap (see .deploy-checks and the
// GET /api/reports/inventory-valuation review chain for the decision
// trail: the only existing 'purchase'-type cost_ledger writer,
// src/routes/bills.ts's write-cost-ledger, requires a CLOSED bill, and
// historical/pre-bills receipts have no such bill and therefore no
// costing path at all before this file).
//
// Not in repairWorkflow.ts: this is not repair-scoped. It sits beside
// postRepairCostToLedger() (src/lib/repairWorkflow.ts) as a second,
// independent 'purchase'-typed writer with the same append-only,
// no-UPDATE, no-DELETE contract, and is expected to be called both
// interactively (one device at a time, via the route below) and in
// bulk by a future historical-backfill importer (Part 4 of the
// consolidated cost-capture instruction) — the backfill MUST call this
// function rather than write its own SQL, so every 'purchase' row in
// the system, regardless of origin, passes through the same guard
// logic below.
//
// CONTRAST WITH src/routes/bills.ts's write-cost-ledger: that writer's
// provenance is always SUPPLIER_INVOICED because it reads an actual
// invoiced bill line. This writer's provenance is always
// DEFAULT_UNVERIFIED_PROVENANCE, unconditionally — see the constant's
// own comment below for why that is a real information limit, not a
// placeholder.
//
// CONTRAST WITH src/lib/repairWorkflow.ts's postRepairCostToLedger():
// that function writes cost_type = 'repair' always, source_bill_line_id
// nullable (populated when a specific invoiced line backs the cost),
// and provenance chosen accordingly (SUPPLIER_INVOICED when
// source_bill_line_id is set, DEFAULT_UNVERIFIED_PROVENANCE otherwise).
// This function is simpler by design: cost_type = 'purchase' always,
// source_bill_line_id ALWAYS NULL (this writer exists precisely because
// no bill line exists to attribute to), provenance therefore ALWAYS
// DEFAULT_UNVERIFIED_PROVENANCE with no branch.

import type { AuthUser } from '../types'
import { DEFAULT_UNVERIFIED_PROVENANCE } from './billBuilder'

export class CostEntryError extends Error {
  status: 404 | 409 | 422
  constructor(message: string, status: 404 | 409 | 422) {
    super(message)
    this.status = status
  }
}

async function loadDevice(db: D1Database, deviceId: number, organisationId: number) {
  return db.prepare(
    'SELECT * FROM received_devices WHERE id = ? AND organisation_id = ?'
  ).bind(deviceId, organisationId).first<Record<string, unknown>>()
}

// POST /api/devices/:id/purchase/cost-ledger —
// { amount_gbp, note?, allow_duplicate_purchase_row? }
//
// Manager-only (see requireManager(c) in the route handler — same
// authorisation level as postRepairCostToLedger()'s route; a ledger
// write is at least as privileged as any other cost-column write).
//
// APPEND-ONLY, NO EXCEPTIONS: this function only ever INSERTs, matching
// postRepairCostToLedger()'s contract. A cost corrected after the fact
// gets a NEW (typically negative, see sign-scoped guard below) row, never
// an edit to the original. Do not add an UPDATE/DELETE path here.
//
// source_bill_line_id: ALWAYS NULL. This writer exists specifically for
// costs with no bill line to attribute to (pre-bills historical
// receipts, and manager-keyed entries generally) — unlike
// postRepairCostToLedger(), there is no code path here that could ever
// populate it, so it is not exposed as an input field at all.
//
// provenance: ALWAYS DEFAULT_UNVERIFIED_PROVENANCE ('default-unverified',
// billBuilder.ts), unconditionally — no branch, because this writer never
// has a bill line to promote it to SUPPLIER_INVOICED.
//
// PROVENANCE LIMITATION (recorded here per explicit instruction, since
// the accounting integration reads this field and the limit belongs
// where the next person will find it, not discovered downstream):
// DEFAULT_UNVERIFIED_PROVENANCE distinguishes THIS WRITER from the
// bill-derived one (src/routes/bills.ts's write-cost-ledger) — it tells
// a consumer "this figure has no invoiced bill line behind it." It does
// NOT distinguish, within that population, a SKU-price-list estimate
// (Part 4's historical bulk backfill) from a figure a manager typed in
// having looked at an actual paper invoice that never became a `bills`
// row. Both land as 'default-unverified' with no way to tell them apart
// downstream. This is a known, accepted limitation of the current
// two-value-plus-'derived' CostLedgerProvenance vocabulary — NOT a
// reason to add a third provenance value now; that decision is out of
// scope for this file.
//
// DUPLICATE GUARD — SIGN-SCOPED (amendment to the original two-decision
// draft, which conflicted: a compensating negative row is itself a
// second 'purchase' row, so guarding on "any second row" would trip the
// 409 on every legitimate correction and force the override flag to be
// used routinely, destroying its signal value as an anomaly marker).
// The guard therefore only fires for a second POSITIVE amount:
//   - amount_gbp > 0 AND a cost_type='purchase' row already exists on
//     this device → refuse with 409, UNLESS the request explicitly sets
//     allow_duplicate_purchase_row: true (a device legitimately carrying
//     two positive acquisition costs is not ruled out operationally).
//   - amount_gbp <= 0 always passes the guard unconditionally — a
//     non-positive row can only reduce a device's costed value, never
//     inflate it, so there is nothing here for the guard to protect
//     against.
// OVERRIDE SIGNALLING: server-side log line only (console.log), NOT a
// response-body field — the response goes to the caller, a log line is
// what an operator/auditor greps, and the two audiences should not be
// conflated by putting an internal signal in an external contract.
export async function postPurchaseCostToLedger(
  db: D1Database,
  deviceId: number,
  body: {
    amount_gbp?: unknown
    note?: unknown
    allow_duplicate_purchase_row?: unknown
  },
  user: AuthUser,
): Promise<{ cost_ledger_entry: Record<string, unknown> }> {
  const device = await loadDevice(db, deviceId, user.organisation_id)
  if (!device) throw new CostEntryError(`Device ${deviceId} not found`, 404)

  const amount = Number(body.amount_gbp)
  if (!Number.isFinite(amount)) {
    throw new CostEntryError('amount_gbp is required and must be a finite number', 422)
  }

  const allowDuplicate = body.allow_duplicate_purchase_row === true

  if (amount > 0 && !allowDuplicate) {
    const existing = await db.prepare(
      `SELECT id FROM cost_ledger WHERE received_device_id = ? AND organisation_id = ? AND cost_type = 'purchase' LIMIT 1`
    ).bind(deviceId, user.organisation_id).first<{ id: number }>()
    if (existing) {
      throw new CostEntryError(
        `Device ${deviceId} already has a positive purchase cost row (cost_ledger id ${existing.id}). ` +
        'Set allow_duplicate_purchase_row: true to post a second positive row anyway.',
        409,
      )
    }
  }

  if (amount > 0 && allowDuplicate) {
    // Server-side signal only — see OVERRIDE SIGNALLING comment above.
    console.log(
      `[costEntry] duplicate_override_used device_id=${deviceId} organisation_id=${user.organisation_id} ` +
      `amount_gbp=${amount} user_id=${user.id}`
    )
  }

  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null

  const insertResult = await db.prepare(
    `INSERT INTO cost_ledger
       (organisation_id, received_device_id, cost_type, amount_gbp, currency_code,
        source_bill_line_id, provenance, note, created_by_user_id)
     VALUES (?, ?, 'purchase', ?, 'GBP', NULL, ?, ?, ?)`
  ).bind(
    user.organisation_id,
    deviceId,
    amount,
    DEFAULT_UNVERIFIED_PROVENANCE,
    note,
    user.id,
  ).run()

  const entryId = insertResult.meta.last_row_id as number
  const entry = await db.prepare('SELECT * FROM cost_ledger WHERE id = ?').bind(entryId).first<Record<string, unknown>>()
  return { cost_ledger_entry: entry! }
}
