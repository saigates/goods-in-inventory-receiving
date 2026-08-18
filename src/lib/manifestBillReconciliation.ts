// Sprint B §1 follow-up — manifest → bill reconciliation.
//
// Manifests carry the itemisation (expected_devices, one row per physical
// unit with its own unit_cost/currency/vat_type hints — 0015). Bills carry
// the header (declared_total_gbp, the supplier-invoiced total this
// consignment cost — 0028). These are deliberately two separate documents:
// a manifest is NEVER generated from a bill's lines, and a bill's own
// bill_lines/bill_line_serials keep resolving against received_devices
// exactly as before (0028), untouched by this module.
//
// This module answers one question: does what the manifest says the units
// cost (summed) match what the linked bill's header declares as the total?
// It is pure (no DB access) — same convention as billBuilder.ts and
// freightApportionment.ts — callers fetch the manifest lines' unit_cost/
// currency and the bill's declared_total_gbp/currency_code/exchange_rate
// and pass them in.
//
// Deliberately NOT reused: checkBillCloseable() in billBuilder.ts, which
// compares sum(bill_lines GBP) against a bill's OWN declared_total_gbp —
// a same-document check. This module compares a DIFFERENT document (the
// manifest) against the bill, and the two must never be conflated: a bill
// can be internally balanced (its own lines sum to its own header) while
// still not matching the manifest that was actually shipped against it,
// and vice versa.

export type ManifestLineForReconciliation = {
  unit_cost: number | null      // in the manifest line's OWN currency (0015 hint)
  currency: string | null       // ISO 4217; NULL means "assume bill's currency" (see below)
}

export type ManifestBillReconciliationResult =
  // Nothing to compare yet — either no bill_id on the manifest at all
  // (the expected, permitted "goods received without a bill" case), the
  // linked bill has no declared_total_gbp yet, or the manifest has no
  // priced lines yet. Never presented as Balanced (the historical
  // header-only false-green this replaces) and never presented as a
  // variance either — there is nothing to vary against.
  | { verdict: 'awaiting_manifest'; reason: string }
  | {
      verdict: 'balanced'
      sum_manifest_gbp: number
      declared_total_gbp: number
      variance_gbp: 0
      unit_count_manifest: number
      unit_count_bill: number
    }
  | {
      verdict: 'variance'
      sum_manifest_gbp: number
      declared_total_gbp: number
      variance_gbp: number
      unit_count_manifest: number
      unit_count_bill: number
      unit_count_mismatch: boolean
    }

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100
}

// `manifestLines` — every expected_devices row on the manifest (priced or
// not; unpriced rows are simply excluded from the sum, mirroring the
// "hints are optional" convention from 0015). `billCurrencyCode` and
// `billExchangeRate` are the LINKED bill's own header currency/rate — a
// manifest line with no currency of its own is assumed to be quoted in
// the bill's currency (the common case: a supplier's manifest and their
// own invoice are almost always in the same currency); a manifest line
// that DOES specify its own currency different from the bill's is
// converted using the bill's exchange_rate (same "one accounting rate"
// convention as 0028 — this module does not fetch or infer a second rate).
export function reconcileManifestAgainstBill(
  hasBillId: boolean,
  manifestLines: ManifestLineForReconciliation[],
  bill: { declared_total_gbp: number | null; currency_code: string; exchange_rate: number | null; unit_count: number } | null,
): ManifestBillReconciliationResult {
  if (!hasBillId || !bill) {
    return { verdict: 'awaiting_manifest', reason: 'No bill linked to this manifest yet' }
  }
  if (bill.declared_total_gbp == null) {
    return { verdict: 'awaiting_manifest', reason: 'Linked bill has no declared_total_gbp yet' }
  }

  const priced = manifestLines.filter(l => l.unit_cost != null && Number.isFinite(l.unit_cost))
  if (priced.length === 0) {
    return { verdict: 'awaiting_manifest', reason: 'Manifest has no priced lines yet' }
  }

  const isGbpBill = bill.currency_code === 'GBP'
  let sumGbp = 0
  for (const line of priced) {
    const cost = line.unit_cost as number
    // Same currency as the bill (or no currency stated on the line, which
    // we assume matches the bill's) — no conversion needed for a GBP bill,
    // or already in the bill's own currency for a non-GBP bill.
    if (isGbpBill || line.currency == null || line.currency === bill.currency_code) {
      sumGbp += isGbpBill ? cost : (bill.exchange_rate ? cost / bill.exchange_rate : cost)
    } else {
      // Line states a DIFFERENT currency from the bill's — this module
      // does not fetch a second exchange rate; treat as unconvertible and
      // skip it from the sum rather than silently mixing currencies. A
      // caller that needs true multi-currency-per-line reconciliation is
      // out of scope for this pass — flagged, not guessed.
      continue
    }
  }
  sumGbp = round2(sumGbp)
  const declaredTotalGbp = round2(bill.declared_total_gbp)
  const variance = round2(sumGbp - declaredTotalGbp)
  const unitCountMismatch = priced.length !== bill.unit_count

  if (variance === 0 && !unitCountMismatch) {
    return {
      verdict: 'balanced',
      sum_manifest_gbp: sumGbp,
      declared_total_gbp: declaredTotalGbp,
      variance_gbp: 0,
      unit_count_manifest: priced.length,
      unit_count_bill: bill.unit_count,
    }
  }
  return {
    verdict: 'variance',
    sum_manifest_gbp: sumGbp,
    declared_total_gbp: declaredTotalGbp,
    variance_gbp: variance,
    unit_count_manifest: priced.length,
    unit_count_bill: bill.unit_count,
    unit_count_mismatch: unitCountMismatch,
  }
}
