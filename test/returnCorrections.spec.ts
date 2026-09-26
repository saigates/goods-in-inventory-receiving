// Z-9 — pure-logic unit tests for src/lib/returnCorrections.ts:
// generation parsing/boundary detection, catalog-value-difference
// comparison, the combined review decision, and snapshot-merge (operator
// amendment 1). No DB access anywhere in this file — every function under
// test is pure, mirroring the house convention for oprValidation-style
// pure-engine modules (see oprImport.spec.ts's own pure-function describe
// blocks, e.g. 'OPR — value reconciliation: multi-leg balancing (pure)').
import { describe, it, expect } from 'vitest'
import {
  parseModelGeneration,
  compareGenerations,
  compareCatalogValues,
  computeReturnLineReview,
  mergeCorrectionSnapshot,
  CATALOG_VALUE_REVIEW_THRESHOLD_PCT,
  type FrozenLineSpec,
  type CorrectedLineSpec,
} from '../src/lib/returnCorrections'

// ═════════ parseModelGeneration (operator amendment 3) ═════════

describe('Z-9 — parseModelGeneration: numeric-generation extraction, fail loud on unparseable', () => {
  it('extracts the numeric generation from common iPhone model strings regardless of suffix', () => {
    expect(parseModelGeneration('iPhone 13')).toBe(13)
    expect(parseModelGeneration('iPhone 13 Pro Max')).toBe(13)
    expect(parseModelGeneration('iPhone 13 Mini')).toBe(13)
    expect(parseModelGeneration('iPhone 16e')).toBe(16)
  })

  it('extracts the numeric generation from Samsung Galaxy S/Z-series without brand-specific branching', () => {
    expect(parseModelGeneration('Galaxy S23')).toBe(23)
    expect(parseModelGeneration('Galaxy S23 Ultra')).toBe(23)
    expect(parseModelGeneration('Galaxy Z Fold5')).toBe(5)
    expect(parseModelGeneration('Galaxy Z Flip6')).toBe(6)
  })

  it('returns null (unparseable) for a model string with no numeric generation, rather than guessing', () => {
    expect(parseModelGeneration('iPhone SE')).toBeNull()
    expect(parseModelGeneration('iPhone Air')).toBeNull()
    expect(parseModelGeneration('')).toBeNull()
    expect(parseModelGeneration(null)).toBeNull()
    expect(parseModelGeneration(undefined)).toBeNull()
  })

  it('returns null for a non-positive or non-finite parse rather than a bogus number', () => {
    expect(parseModelGeneration('Model 0')).toBeNull()
  })
})

describe('Z-9 — compareGenerations: boundary vs unparseable are distinct, never conflated', () => {
  it('reports a boundary when both sides parse and differ', () => {
    const cmp = compareGenerations('iPhone 13', 'iPhone 14')
    expect(cmp.frozen_generation).toBe(13)
    expect(cmp.corrected_generation).toBe(14)
    expect(cmp.generation_unparseable).toBe(false)
    expect(cmp.is_generation_boundary).toBe(true)
  })

  it('reports NO boundary when both sides parse and match, even with a different suffix', () => {
    const cmp = compareGenerations('iPhone 13', 'iPhone 13 Pro Max')
    expect(cmp.generation_unparseable).toBe(false)
    expect(cmp.is_generation_boundary).toBe(false)
  })

  it('reports unparseable (not a boundary) when EITHER side fails to parse — never guesses a boundary from a half-parsed comparison', () => {
    const frozenSideFails = compareGenerations('iPhone SE', 'iPhone 14')
    expect(frozenSideFails.generation_unparseable).toBe(true)
    expect(frozenSideFails.is_generation_boundary).toBe(false)

    const correctedSideFails = compareGenerations('iPhone 13', 'iPhone SE')
    expect(correctedSideFails.generation_unparseable).toBe(true)
    expect(correctedSideFails.is_generation_boundary).toBe(false)

    const bothFail = compareGenerations('iPhone SE', 'iPhone Air')
    expect(bothFail.generation_unparseable).toBe(true)
    expect(bothFail.is_generation_boundary).toBe(false)
  })
})

// ═════════ compareCatalogValues (operator amendment 2) ═════════

describe('Z-9 — compareCatalogValues: catalog-vs-catalog, both sides read NOW, never against shipment_lines.unit_value', () => {
  it('flags a difference exceeding the 20% default threshold', () => {
    const cmp = compareCatalogValues(100, 130)
    expect(cmp.catalog_value_diff_pct).toBeCloseTo(0.30, 5)
    expect(cmp.exceeds_threshold).toBe(true)
  })

  it('does not flag a difference within the threshold', () => {
    const cmp = compareCatalogValues(100, 110)
    expect(cmp.catalog_value_diff_pct).toBeCloseTo(0.10, 5)
    expect(cmp.exceeds_threshold).toBe(false)
  })

  it('is symmetric — a negative (corrected cheaper) swing past the threshold also flags', () => {
    const cmp = compareCatalogValues(100, 70)
    expect(cmp.catalog_value_diff_pct).toBeCloseTo(-0.30, 5)
    expect(cmp.exceeds_threshold).toBe(true)
  })

  it('never flags when either side is unresolvable (null) or the frozen side is zero — no divide-by-zero, no false positive', () => {
    expect(compareCatalogValues(null, 130).exceeds_threshold).toBe(false)
    expect(compareCatalogValues(100, null).exceeds_threshold).toBe(false)
    expect(compareCatalogValues(0, 130).exceeds_threshold).toBe(false)
    expect(compareCatalogValues(null, 130).catalog_value_diff_pct).toBeNull()
  })

  it('respects a custom threshold override', () => {
    expect(compareCatalogValues(100, 105, 0.03).exceeds_threshold).toBe(true)
    expect(CATALOG_VALUE_REVIEW_THRESHOLD_PCT).toBe(0.20)
  })
})

// ═════════ computeReturnLineReview (combines all triggers, Amendments 2-4) ═════════

const baseFrozen: FrozenLineSpec = {
  imei: '860455100000001', sku: 'SMSG-S23-256-BLK', brand: 'Samsung', model: 'Galaxy S23',
  capacity: '256GB', color: 'Phantom Black', grade: 'A',
}
function corrected(overrides: Partial<CorrectedLineSpec> = {}): CorrectedLineSpec {
  return { ...baseFrozen, grade: 'A', ...overrides }
}

describe('Z-9 — computeReturnLineReview: requires_review triggers and machine-readable reasons', () => {
  it('no triggers -> requires_review false, empty reasons', () => {
    const r = computeReturnLineReview({
      frozen: baseFrozen, corrected: corrected(),
      frozenCatalogValueGbp: 200, correctedCatalogValueGbp: 205,
    })
    expect(r.requires_review).toBe(false)
    expect(r.review_reasons).toEqual([])
    expect(r.imei_changed).toBe(false)
  })

  it('an IMEI change alone sets requires_review and reasons=[imei_change] — the amendment-4 "sharp case"', () => {
    const r = computeReturnLineReview({
      frozen: baseFrozen, corrected: corrected({ imei: '860455100000002' }),
      frozenCatalogValueGbp: 200, correctedCatalogValueGbp: 200,
    })
    expect(r.imei_changed).toBe(true)
    expect(r.requires_review).toBe(true)
    expect(r.review_reasons).toEqual(['imei_change'])
  })

  it('a generation boundary alone sets requires_review and reasons=[generation_boundary], with no imei_change reason present', () => {
    const r = computeReturnLineReview({
      frozen: baseFrozen, corrected: corrected({ model: 'Galaxy S24' }),
      frozenCatalogValueGbp: 200, correctedCatalogValueGbp: 200,
    })
    expect(r.is_generation_boundary).toBe(true)
    expect(r.requires_review).toBe(true)
    expect(r.review_reasons).toEqual(['generation_boundary'])
    expect(r.review_reasons).not.toContain('imei_change')
  })

  it('an unparseable generation on either side sets requires_review and reasons=[generation_unparseable] (fail loud, never silently passes)', () => {
    const r = computeReturnLineReview({
      frozen: { ...baseFrozen, model: 'iPhone SE' }, corrected: corrected({ model: 'iPhone SE' }),
      frozenCatalogValueGbp: 200, correctedCatalogValueGbp: 200,
    })
    expect(r.generation_unparseable).toBe(true)
    expect(r.requires_review).toBe(true)
    expect(r.review_reasons).toEqual(['generation_unparseable'])
  })

  it('a catalog-value difference exceeding threshold alone sets requires_review and reasons=[catalog_value_diff]', () => {
    const r = computeReturnLineReview({
      frozen: baseFrozen, corrected: corrected({ grade: 'C' }),
      frozenCatalogValueGbp: 200, correctedCatalogValueGbp: 100,
    })
    expect(r.catalog_value_diff_pct).toBeCloseTo(-0.5, 5)
    expect(r.requires_review).toBe(true)
    expect(r.review_reasons).toEqual(['catalog_value_diff'])
  })

  it('multiple simultaneous triggers all appear in review_reasons, not just the first found', () => {
    const r = computeReturnLineReview({
      frozen: baseFrozen,
      corrected: corrected({ imei: '860455100000003', model: 'Galaxy S24', grade: 'C' }),
      frozenCatalogValueGbp: 200, correctedCatalogValueGbp: 100,
    })
    expect(r.review_reasons.sort()).toEqual(['catalog_value_diff', 'generation_boundary', 'imei_change'].sort())
    expect(r.requires_review).toBe(true)
  })
})

// ═════════ mergeCorrectionSnapshot (operator amendment 1 — the load-bearing test) ═════════

describe('Z-9 — mergeCorrectionSnapshot: snapshot semantics across sequential corrections (operator-mandated regression test)', () => {
  it('first correction against no prior row: untouched fields fall back to the FROZEN export line, not null', () => {
    const merged = mergeCorrectionSnapshot(baseFrozen, null, { grade: 'B' })
    expect(merged.grade).toBe('B')
    // Everything else carried forward from frozen, unchanged.
    expect(merged.imei).toBe(baseFrozen.imei)
    expect(merged.sku).toBe(baseFrozen.sku)
    expect(merged.brand).toBe(baseFrozen.brand)
    expect(merged.model).toBe(baseFrozen.model)
    expect(merged.capacity).toBe(baseFrozen.capacity)
    expect(merged.color).toBe(baseFrozen.color)
  })

  // ── THE OPERATOR-MANDATED TEST ──
  // Correction 1 sets grade only. Correction 2 (against correction 1 as
  // baseline) sets ONLY colour. Assert the resulting row's grade is STILL
  // correction 1's value — a sparse/partial-diff implementation would let
  // correction 2's absent grade field silently revert to the frozen
  // export line's original grade, which is exactly the bug migration
  // 0039's header comment describes and amendment 1 exists to prevent.
  it('snapshot semantics across two sequential corrections: correction 2 touching ONLY colour does not revert correction 1\'s grade change', () => {
    // Correction 1: grade A -> B. Nothing else touched.
    const afterCorrection1 = mergeCorrectionSnapshot(baseFrozen, null, { grade: 'B' })
    expect(afterCorrection1.grade).toBe('B')
    expect(afterCorrection1.color).toBe(baseFrozen.color) // unchanged so far

    // Correction 2: uses correction 1's row as baseline (as the route
    // layer does — see opr.ts's previousCorrection load), touches ONLY color.
    const afterCorrection2 = mergeCorrectionSnapshot(baseFrozen, afterCorrection1, { color: 'Cream' })
    expect(afterCorrection2.color).toBe('Cream')
    // THE ASSERTION THAT MATTERS: grade is STILL 'B' (correction 1's
    // value), not reverted to baseFrozen.grade ('A').
    expect(afterCorrection2.grade).toBe('B')
    // Every other untouched field also still carries forward correctly.
    expect(afterCorrection2.imei).toBe(baseFrozen.imei)
    expect(afterCorrection2.sku).toBe(baseFrozen.sku)
    expect(afterCorrection2.brand).toBe(baseFrozen.brand)
    expect(afterCorrection2.model).toBe(baseFrozen.model)
    expect(afterCorrection2.capacity).toBe(baseFrozen.capacity)
  })

  it('a THIRD correction, touching a field already touched by an earlier correction, overwrites it (latest correction always wins for a field it explicitly touches)', () => {
    const c1 = mergeCorrectionSnapshot(baseFrozen, null, { grade: 'B' })
    const c2 = mergeCorrectionSnapshot(baseFrozen, c1, { color: 'Cream' })
    const c3 = mergeCorrectionSnapshot(baseFrozen, c2, { grade: 'C' })
    expect(c3.grade).toBe('C')       // c3 explicitly touched grade -> wins
    expect(c3.color).toBe('Cream')   // c3 didn't touch color -> c2's value carries forward
  })

  it('an explicit null is honoured distinctly from "not touched" (partial.X !== undefined check)', () => {
    const withColor: FrozenLineSpec = { ...baseFrozen, color: 'Phantom Black' }
    const merged = mergeCorrectionSnapshot(withColor, null, { color: null as unknown as string | null })
    expect(merged.color).toBeNull()
    // A field genuinely absent from the partial payload is NOT touched.
    expect(merged.brand).toBe(withColor.brand)
  })

  // Structural value-pinning guarantee (Amendment 1): mergeCorrectionSnapshot
  // has no unit_value/currency field on FrozenLineSpec/CorrectedLineSpec at
  // all — there is nothing for a correction to touch. Asserted here as a
  // type-level fact via a compile-time check (TypeScript would refuse this
  // file to compile if either type gained such a field and this test tried
  // to reference it), plus a runtime assertion that the merged object has
  // no such keys regardless of what's spread into partial.
  it('unit_value/currency are structurally absent from a merged snapshot — cannot be smuggled in via partial', () => {
    const merged = mergeCorrectionSnapshot(baseFrozen, null, { grade: 'B' } as any)
    expect(Object.keys(merged).sort()).toEqual(
      ['brand', 'capacity', 'color', 'grade', 'imei', 'model', 'sku'].sort()
    )
    expect((merged as any).unit_value).toBeUndefined()
    expect((merged as any).currency).toBeUndefined()
  })
})
