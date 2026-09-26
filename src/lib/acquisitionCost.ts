// Z-2 — acquisition cost / total cost computation.
//
// See docs/plan/z2-acquisition-cost.md for the full design decision and
// the pre-existing gap this resolves (two previously-unreconciled
// "acquisition cost" concepts: received_devices.buy_price, set at
// goods-in, vs. cost_ledger cost_type='purchase' sums, populated later
// via a bill or a manual entry — neither of which fires at goods-in
// time). Short version: acquisition_cost_gbp prefers the cost_ledger
// 'purchase' sum when any such row exists, and falls back to the
// goods-in buy_price otherwise — so a freshly-received device is never
// zero-acquisition-costed just because no bill has landed yet.
//
// DELIBERATELY a computed READ, not a new stored column and not a new
// cost_ledger writer — see the doc's "Decision" section for why an
// auto-write-at-goods-in design was rejected (double-counting risk
// against costEntry.ts's/bills.ts's existing writers, which have no
// cross-writer duplicate guard between them).

export type AcquisitionSource = 'cost_ledger' | 'goods_in_buy_price' | 'none'

export interface AcquisitionCostResult {
  acquisition_cost_gbp: number | null
  acquisition_source: AcquisitionSource
}

export interface DeviceCostBreakdown extends AcquisitionCostResult {
  repair_cost_gbp: number
  freight_cost_gbp: number
  // acquisition_cost_gbp + repair_cost_gbp + freight_cost_gbp, treating a
  // null acquisition_cost_gbp as 0 for this sum only (total_cost_gbp is
  // always a number — the null/none distinction lives in
  // acquisition_cost_gbp/acquisition_source, not here).
  total_cost_gbp: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

// Reads the cost_ledger 'purchase' sum for one device; falls back to
// received_devices.buy_price when no 'purchase' row exists at all.
// db-agnostic over a single device row already fetched by the caller
// PLUS one extra query for the ledger sum — callers that already have
// the device row (e.g. addDeviceToShipment, which loads it to check
// status) should pass buyPrice through rather than re-querying
// received_devices here.
export async function computeAcquisitionCostGbp(
  db: D1Database,
  organisationId: number,
  receivedDeviceId: number,
  buyPrice: number | null,
): Promise<AcquisitionCostResult> {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(amount_gbp), 0) AS total, COUNT(*) AS row_count
       FROM cost_ledger
      WHERE organisation_id = ? AND received_device_id = ? AND cost_type = 'purchase'`
  ).bind(organisationId, receivedDeviceId).first<{ total: number; row_count: number }>()

  if (row && row.row_count > 0) {
    return { acquisition_cost_gbp: round2(row.total), acquisition_source: 'cost_ledger' }
  }
  if (buyPrice != null) {
    return { acquisition_cost_gbp: round2(buyPrice), acquisition_source: 'goods_in_buy_price' }
  }
  return { acquisition_cost_gbp: null, acquisition_source: 'none' }
}

// Full breakdown — acquisition (with fallback) + repair + freight sums,
// and their total. One extra query beyond computeAcquisitionCostGbp's own
// (repair+freight sums in a single pass, GROUP BY cost_type).
export async function computeDeviceCostBreakdown(
  db: D1Database,
  organisationId: number,
  receivedDeviceId: number,
  buyPrice: number | null,
): Promise<DeviceCostBreakdown> {
  const acquisition = await computeAcquisitionCostGbp(db, organisationId, receivedDeviceId, buyPrice)

  const { results } = await db.prepare(
    `SELECT cost_type, COALESCE(SUM(amount_gbp), 0) AS total
       FROM cost_ledger
      WHERE organisation_id = ? AND received_device_id = ? AND cost_type IN ('repair','freight')
      GROUP BY cost_type`
  ).bind(organisationId, receivedDeviceId).all<{ cost_type: string; total: number }>()

  let repairCostGbp = 0
  let freightCostGbp = 0
  for (const r of results) {
    if (r.cost_type === 'repair') repairCostGbp = round2(r.total)
    else if (r.cost_type === 'freight') freightCostGbp = round2(r.total)
  }

  const totalCostGbp = round2((acquisition.acquisition_cost_gbp ?? 0) + repairCostGbp + freightCostGbp)

  return {
    ...acquisition,
    repair_cost_gbp: repairCostGbp,
    freight_cost_gbp: freightCostGbp,
    total_cost_gbp: totalCostGbp,
  }
}
