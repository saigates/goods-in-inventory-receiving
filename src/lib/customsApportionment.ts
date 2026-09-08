// Standard temp-export re-import — customs apportionment, value-based, ONE
// function per return consignment. Pure (no DB access). Deliberately its
// OWN module, not a call into freightApportionment.ts — same reasoning as
// the repair_cost_gbp naming-collision precedent (docs/plan/device-
// lifecycle-slice1.md): freight and customs are different cost concepts
// that must never share a code path, even though the arithmetic they run
// happens to be identical. If the shared algorithm ever needs to change
// for one and not the other, that's a feature of the separation, not a
// duplication bug.
//
// Business rule (2026-09-08 brief): a TEMP_EXPORT_STANDARD re-import is
// dutiable on the FULL declared value of the returned devices, not on any
// value-added/repair component — unlike an OPR_REPAIR return, which is
// customs-relieved to the repair cost only (see shipments.repair_cost /
// computeCe1154() in oprImport.ts, ENTIRELY SEPARATE from this module).
// TEMP_EXPORT_STANDARD shipments explicitly carry NO C&E1154/worksheet
// fields at all (src/routes/opr.ts's WORKSHEET_FIELD_NAMES skip-list) —
// so there is no shipment-level customs total to read here; the caller
// supplies customsTotalGbp directly (the actual customs charge assessed
// on this return consignment), and this function apportions it across
// the consignment's devices by value, same as freight.
//
// Owner's decision, mirrored from freightApportionment.ts: apportion by
// VALUE (device line price ÷ sum of priced lines in the consignment) ×
// customs total — not flat per-unit, for the same reason (a flat charge
// distorts cost-as-% for cheap vs. expensive devices).
//
// Rounding: largest-remainder method, IDENTICAL to freightApportionment.ts
// — exact (unrounded) shares, floor each to the penny, distribute leftover
// pence one-by-one to the largest fractional remainder, ties broken by
// largest price_gbp then by received_device_id, any final residual on the
// largest line.
//
// Two hard rules (mirroring freight's three; rule 2 below is the customs
// analogue of "book only freight actually invoiced"):
//   1. HOLD until every device in the consignment is priced — an unpriced
//      device would be invisibly missing from the denominator, overstating
//      customs on the priced devices.
//   2. Book only customs actually ASSESSED/PAID on this consignment — no
//      accruals/estimates. Caller is responsible for passing the real
//      figure (e.g., from the customs/broker charge for this return), not
//      a projected one.
//
// Persistence note (deliberately NOT decided in this module): where the
// resulting shares get written — a new cost_ledger row per device with
// cost_type = 'customs' is the natural target, mirroring how freight
// shares are DOCUMENTED to land in cost_ledger with cost_type = 'freight'
// (freightApportionment.ts:141, migrations/0028's freight_invoices.
// apportioned_at comment) — but as of this write, apportionFreightByValue
// itself has NO real call site in any route (confirmed by
// `grep -rn "apportionFreightByValue(" src/` returning only its own
// definition) and no POST route exists for freight_invoices either. This
// function is therefore built and tested to the same pure-function
// standard as its freight counterpart, but wiring it into
// finaliseImportShipment (src/routes/opr.ts) needs an explicit decision on
// where the actual "customs charge for this return" figure gets entered
// and stored (a new customs_charges table mirroring freight_invoices, or
// an inline finalise-time field) — that decision was NOT made by this
// commit and should not be inferred silently.

export type PricedDeviceLine = {
  received_device_id: number
  price_gbp: number // the device's purchase-cost line price, GBP, already frozen
}

export type CustomsApportionmentShare = {
  received_device_id: number
  share_gbp: number
}

export type CustomsApportionmentResult =
  | { ok: true; shares: CustomsApportionmentShare[]; total_apportioned_gbp: number }
  | { ok: false; error: string; pending_reason?: string }

// `allDeviceIdsInConsignment` is the FULL membership of the return
// consignment, independent of `pricedLines` — lets rule 1 detect "not
// every line is priced yet" even when the caller only has priced lines in
// hand. Identical shape to apportionFreightByValue's first two params.
export function apportionCustomsByValue(
  allDeviceIdsInConsignment: number[],
  pricedLines: PricedDeviceLine[],
  customsTotalGbp: number,
): CustomsApportionmentResult {
  if (allDeviceIdsInConsignment.length === 0) {
    return { ok: false, error: 'Consignment has no devices to apportion customs across' }
  }
  if (!Number.isFinite(customsTotalGbp) || customsTotalGbp < 0) {
    return { ok: false, error: 'customsTotalGbp must be a non-negative number' }
  }

  // Rule 1: hold until every line is priced.
  const pricedIds = new Set(pricedLines.map(l => l.received_device_id))
  const missing = allDeviceIdsInConsignment.filter(id => !pricedIds.has(id))
  if (missing.length > 0) {
    return {
      ok: false,
      error: `${missing.length} of ${allDeviceIdsInConsignment.length} device(s) in this consignment are not yet priced — customs apportionment held`,
      pending_reason: `unpriced device_id(s): ${missing.join(', ')}`,
    }
  }

  const sumPriced = round2(pricedLines.reduce((s, l) => s + l.price_gbp, 0))
  if (sumPriced <= 0) {
    return { ok: false, error: 'Sum of priced lines is zero — cannot apportion customs by value' }
  }

  // Exact (unrounded) shares, in whole pence, kept as floats until the
  // largest-remainder redistribution below. Identical method to
  // apportionFreightByValue.
  const customsTotalPence = Math.round(customsTotalGbp * 100)
  const exact = pricedLines.map(l => ({
    received_device_id: l.received_device_id,
    price_gbp: l.price_gbp,
    exactPence: (l.price_gbp / sumPriced) * customsTotalPence,
  }))

  const floored = exact.map(e => ({
    received_device_id: e.received_device_id,
    price_gbp: e.price_gbp,
    pence: Math.floor(e.exactPence),
    remainder: e.exactPence - Math.floor(e.exactPence),
  }))

  const flooredSum = floored.reduce((s, f) => s + f.pence, 0)
  let leftover = customsTotalPence - flooredSum

  // Distribute leftover pence to the largest remainders first. Ties in
  // remainder are broken by largest price_gbp (the "largest line" rule),
  // then by received_device_id for full determinism — same tie-break
  // order as apportionFreightByValue.
  const order = [...floored].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder
    if (b.price_gbp !== a.price_gbp) return b.price_gbp - a.price_gbp
    return a.received_device_id - b.received_device_id
  })

  const pence = new Map<number, number>(floored.map(f => [f.received_device_id, f.pence]))
  for (let i = 0; i < order.length && leftover > 0; i++, leftover--) {
    const id = order[i].received_device_id
    pence.set(id, (pence.get(id) ?? 0) + 1)
  }
  // Any residual beyond a full pass lands entirely on the largest line,
  // same defensive guard as apportionFreightByValue.
  if (leftover > 0) {
    const largestId = order[0].received_device_id
    pence.set(largestId, (pence.get(largestId) ?? 0) + leftover)
    leftover = 0
  }

  const shares: CustomsApportionmentShare[] = pricedLines.map(l => ({
    received_device_id: l.received_device_id,
    share_gbp: round2((pence.get(l.received_device_id) ?? 0) / 100),
  }))

  const totalApportioned = round2(shares.reduce((s, r) => s + r.share_gbp, 0))

  return { ok: true, shares, total_apportioned_gbp: totalApportioned }
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100
}
