// Sprint B §1 follow-up — manifest → bill reconciliation, pure-function
// tests (no DB/HTTP). Mirrors billBuilder.spec.ts / freightApportionment.
// spec.ts's convention: real fixture figures live here, never in src/.
//
// Two tests carry the instruction's own acceptance criteria verbatim:
//   - non-vacuity: a header-only bill with NO manifest must NOT report
//     Balanced (the historical header-only false-green this replaces).
//   - real figures: 16 manifest lines summing to £4,774.00 against a bill
//     declaring £4,774.00 must report Balanced.
import { describe, it, expect } from 'vitest'
import { reconcileManifestAgainstBill, type ManifestLineForReconciliation } from '../src/lib/manifestBillReconciliation'

describe('reconcileManifestAgainstBill', () => {
  it('non-vacuity: a header-only bill with no manifest linked does NOT report Balanced', () => {
    // This is the exact defect being replaced: a bill with no manifest at
    // all used to read as a false "Balanced" green because there was
    // nothing to compare it against. hasBillId=false is the "no manifest
    // has this bill linked" case from the manifest side; from the bill's
    // own perspective this is presented as "awaiting manifest", not green.
    const result = reconcileManifestAgainstBill(false, [], null)
    expect(result.verdict).not.toBe('balanced')
    expect(result.verdict).toBe('awaiting_manifest')
  })

  it('non-vacuity: a manifest linked to a bill but with zero priced lines does NOT report Balanced', () => {
    const bill = { declared_total_gbp: 4774.00, currency_code: 'GBP', exchange_rate: null, unit_count: 16 }
    const unpriced: ManifestLineForReconciliation[] = [
      { unit_cost: null, currency: null },
      { unit_cost: null, currency: null },
    ]
    const result = reconcileManifestAgainstBill(true, unpriced, bill)
    expect(result.verdict).not.toBe('balanced')
    expect(result.verdict).toBe('awaiting_manifest')
  })

  it('16 manifest lines summing to £4,774.00 against a bill declaring £4,774.00 (GBP) → Balanced', () => {
    // Real figures per the instruction: 16 rows, sum = £4,774.00.
    const unitCosts = [
      313.94, 252.50, 277.50, 272.32, 323.65, 317.67, 339.22, 258.69,
      292.19, 252.98, 271.86, 300.54, 252.65, 269.88, 314.99, 463.42,
    ]
    expect(unitCosts.length).toBe(16)
    expect(Math.round(unitCosts.reduce((s, v) => s + v, 0) * 100) / 100).toBe(4774.00)

    const lines: ManifestLineForReconciliation[] = unitCosts.map(c => ({ unit_cost: c, currency: 'GBP' }))
    const bill = { declared_total_gbp: 4774.00, currency_code: 'GBP', exchange_rate: null, unit_count: 16 }

    const result = reconcileManifestAgainstBill(true, lines, bill)
    expect(result.verdict).toBe('balanced')
    if (result.verdict === 'balanced') {
      expect(result.sum_manifest_gbp).toBe(4774.00)
      expect(result.declared_total_gbp).toBe(4774.00)
      expect(result.variance_gbp).toBe(0)
      expect(result.unit_count_manifest).toBe(16)
      expect(result.unit_count_bill).toBe(16)
    }
  })

  it('a genuine variance between manifest sum and bill declared total is reported, not hidden', () => {
    const lines: ManifestLineForReconciliation[] = [
      { unit_cost: 100, currency: 'GBP' },
      { unit_cost: 100, currency: 'GBP' },
    ]
    const bill = { declared_total_gbp: 250, currency_code: 'GBP', exchange_rate: null, unit_count: 2 }
    const result = reconcileManifestAgainstBill(true, lines, bill)
    expect(result.verdict).toBe('variance')
    if (result.verdict === 'variance') {
      expect(result.sum_manifest_gbp).toBe(200)
      expect(result.declared_total_gbp).toBe(250)
      expect(result.variance_gbp).toBe(-50)
      expect(result.unit_count_mismatch).toBe(false)
    }
  })

  it('unit count mismatch is flagged even when the GBP totals happen to tie', () => {
    // 3 manifest lines summing to 300, but the bill's own unit_count says 2
    // units were invoiced — this must not silently pass as Balanced just
    // because the money matches; row count is checked too, per instruction.
    const lines: ManifestLineForReconciliation[] = [
      { unit_cost: 100, currency: 'GBP' },
      { unit_cost: 100, currency: 'GBP' },
      { unit_cost: 100, currency: 'GBP' },
    ]
    const bill = { declared_total_gbp: 300, currency_code: 'GBP', exchange_rate: null, unit_count: 2 }
    const result = reconcileManifestAgainstBill(true, lines, bill)
    expect(result.verdict).toBe('variance')
    if (result.verdict === 'variance') {
      expect(result.variance_gbp).toBe(0)
      expect(result.unit_count_mismatch).toBe(true)
      expect(result.unit_count_manifest).toBe(3)
      expect(result.unit_count_bill).toBe(2)
    }
  })

  it('a manifest with no bill linked at all reports awaiting_manifest, never a variance either', () => {
    const lines: ManifestLineForReconciliation[] = [{ unit_cost: 50, currency: 'GBP' }]
    const result = reconcileManifestAgainstBill(false, lines, null)
    expect(result.verdict).toBe('awaiting_manifest')
  })

  it('a non-GBP bill converts manifest lines at the bill exchange rate', () => {
    // Bill in USD, exchange_rate = 1.25 USD per GBP 1 (foreign units per GBP).
    // Manifest lines with no currency stated are assumed to be in the
    // bill's own currency (USD here) and converted at that rate.
    const lines: ManifestLineForReconciliation[] = [
      { unit_cost: 125, currency: null },  // USD 125 / 1.25 = GBP 100
      { unit_cost: 125, currency: null },  // USD 125 / 1.25 = GBP 100
    ]
    const bill = { declared_total_gbp: 200, currency_code: 'USD', exchange_rate: 1.25, unit_count: 2 }
    const result = reconcileManifestAgainstBill(true, lines, bill)
    expect(result.verdict).toBe('balanced')
  })
})
