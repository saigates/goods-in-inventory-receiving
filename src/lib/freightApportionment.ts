// Sprint B §3 — freight apportionment, value-based, ONE function called
// THREE times (outbound + return R1 + return R2). Pure (no DB access).
//
// Owner's decision, explicit and margin-neutral by construction: freight
// is apportioned by VALUE (device line price ÷ sum of priced lines in
// that consignment) × invoice total — NOT flat per-unit. A flat per-unit
// charge lands under 2% on a £452 device and near 7% on a £90 one; value
// apportionment makes freight a constant % of cost per device.
//
// Rounding: largest-remainder method. Compute exact (unrounded) shares,
// floor each to the penny, then distribute the leftover pence one-by-one
// to the lines with the largest fractional remainder, with any final
// single leftover penny (an odd-cent tie) landing on the LARGEST line —
// never an arbitrary one.
//
// Three hard rules (§3):
//   1. HOLD until every line in the consignment is priced. Apportioning
//      across priced-only lines would overstate freight on those devices
//      (an unpriced device is invisibly missing from the denominator).
//   2. Book only freight ACTUALLY INVOICED — no accruals/estimates. The
//      AED 945.99 billed to Syncere (or any conversion of it) is
//      SPECIFICALLY EXCLUDED from this apportionment (it is a repair-
//      adjacent charge, not consignment freight).
//   3. A device reads `freight_expected` until every expected leg has
//      landed — same "an incomplete cost must never present as final"
//      spirit as default-unverified/CostLedgerProvenance.
//
// Customs freight (shipments.inbound_freight_gbp / export_freight_gbp,
// already feeding computeCe1154()) is ENTIRELY SEPARATE and is never
// read or written here — see migrations/0028's header comment for the
// full boundary rationale.

export type PricedDeviceLine = {
  received_device_id: number
  price_gbp: number   // the device's purchase-cost line price, GBP, already frozen
}

export type FreightApportionmentShare = {
  received_device_id: number
  share_gbp: number
}

export type FreightApportionmentResult =
  | { ok: true; shares: FreightApportionmentShare[]; total_apportioned_gbp: number }
  | { ok: false; error: string; pending_reason?: string }

// `allDeviceIdsInConsignment` is the FULL membership of the consignment
// (every device on that leg), independent of `pricedLines` — this is
// what lets rule 1 detect "not every line is priced yet" even when the
// caller only has priced lines in hand.
export function apportionFreightByValue(
  allDeviceIdsInConsignment: number[],
  pricedLines: PricedDeviceLine[],
  invoiceTotalGbp: number,
): FreightApportionmentResult {
  if (allDeviceIdsInConsignment.length === 0) {
    return { ok: false, error: 'Consignment has no devices to apportion freight across' }
  }
  if (!Number.isFinite(invoiceTotalGbp) || invoiceTotalGbp < 0) {
    return { ok: false, error: 'invoiceTotalGbp must be a non-negative number' }
  }

  // Rule 1: hold until every line is priced.
  const pricedIds = new Set(pricedLines.map(l => l.received_device_id))
  const missing = allDeviceIdsInConsignment.filter(id => !pricedIds.has(id))
  if (missing.length > 0) {
    return {
      ok: false,
      error: `${missing.length} of ${allDeviceIdsInConsignment.length} device(s) in this consignment are not yet priced — apportionment held`,
      pending_reason: `unpriced device_id(s): ${missing.join(', ')}`,
    }
  }

  const sumPriced = round2(pricedLines.reduce((s, l) => s + l.price_gbp, 0))
  if (sumPriced <= 0) {
    return { ok: false, error: 'Sum of priced lines is zero — cannot apportion freight by value' }
  }

  // Exact (unrounded) shares, in whole pence, kept as floats until the
  // largest-remainder redistribution below.
  const invoiceTotalPence = Math.round(invoiceTotalGbp * 100)
  const exact = pricedLines.map(l => ({
    received_device_id: l.received_device_id,
    price_gbp: l.price_gbp,
    exactPence: (l.price_gbp / sumPriced) * invoiceTotalPence,
  }))

  const floored = exact.map(e => ({
    received_device_id: e.received_device_id,
    price_gbp: e.price_gbp,
    pence: Math.floor(e.exactPence),
    remainder: e.exactPence - Math.floor(e.exactPence),
  }))

  const flooredSum = floored.reduce((s, f) => s + f.pence, 0)
  let leftover = invoiceTotalPence - flooredSum

  // Distribute leftover pence to the largest remainders first. Ties in
  // remainder are broken by largest price_gbp (the "largest line" rule),
  // then by received_device_id for full determinism.
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
  // Any residual beyond a full pass (shouldn't happen — leftover < n by
  // construction — but guard defensively) lands entirely on the largest
  // line, per the explicit "residual on the largest line" instruction.
  if (leftover > 0) {
    const largestId = order[0].received_device_id
    pence.set(largestId, (pence.get(largestId) ?? 0) + leftover)
    leftover = 0
  }

  const shares: FreightApportionmentShare[] = pricedLines.map(l => ({
    received_device_id: l.received_device_id,
    share_gbp: round2((pence.get(l.received_device_id) ?? 0) / 100),
  }))

  const totalApportioned = round2(shares.reduce((s, r) => s + r.share_gbp, 0))

  return { ok: true, shares, total_apportioned_gbp: totalApportioned }
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100
}

// ───────── freight_expected status (§3, rule 3) ─────────
//
// A device's freight is FINAL only once every expected leg for it has an
// apportioned share recorded. `expectedLegs` is caller-supplied (e.g.
// ['outbound', 'return'] for a device that both went out and came back;
// just ['outbound'] for one still overseas). `landedLegs` is whichever
// legs already have a cost_ledger 'freight' row for this device.
export function freightStatusForDevice(
  expectedLegs: string[],
  landedLegs: string[],
): 'freight_final' | 'freight_expected' {
  const landed = new Set(landedLegs)
  return expectedLegs.every(leg => landed.has(leg)) ? 'freight_final' : 'freight_expected'
}
