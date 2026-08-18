// Migration 0030 follow-up — condition-from-grade derivation, pure-function
// tests (no DB/HTTP). Mirrors billBuilder.spec.ts / manifestBillReconciliation
// .spec.ts's convention: real fixture figures live here, never in src/.
//
// The seven real production (grade, condition) combinations found by the
// pre-migration cross-tab are asserted explicitly by name, since they are
// exactly the cases the migration had to get right:
//   A/REFURBISHED (197, no-op) · A/Refurbished (218, case-only) ·
//   C/Used (11, case-only) · C/Raw (19, semantic — grade wins) ·
//   UG/Used (9, semantic) · UG/Raw (6, semantic) · UG/UG (296, semantic —
//   UG was never a valid condition).
import { describe, it, expect } from 'vitest'
import { deriveConditionFromGrade } from '../src/lib/condition'

describe('deriveConditionFromGrade', () => {
  it('grade A -> REFURBISHED', () => {
    expect(deriveConditionFromGrade('A')).toBe('REFURBISHED')
  })

  it('grade B -> USED', () => {
    expect(deriveConditionFromGrade('B')).toBe('USED')
  })

  it('grade C -> USED', () => {
    expect(deriveConditionFromGrade('C')).toBe('USED')
  })

  it('grade UG -> RAW (UG was never a valid condition value)', () => {
    expect(deriveConditionFromGrade('UG')).toBe('RAW')
  })

  // Vendor-scale D/E: unreachable via the normal import path once migration
  // 0030's CHECK (grade IN ('A','B','C','UG')) is live on expected_devices —
  // a vendor D/E grade is caught and reported at IMPORT time (near-miss /
  // ask-me rule), never stored. Kept here so the function stays correct if
  // the internal scale is ever widened, without needing re-derivation.
  it('grade D -> RAW (vendor-scale, unreachable once the 0030 CHECK constraint is live)', () => {
    expect(deriveConditionFromGrade('D')).toBe('RAW')
  })

  it('grade E -> RAW (vendor-scale, unreachable once the 0030 CHECK constraint is live)', () => {
    expect(deriveConditionFromGrade('E')).toBe('RAW')
  })

  // The seven real production cells from the pre-migration cross-tab
  // (SELECT grade, condition, COUNT(*) FROM expected_devices GROUP BY
  // grade, condition), asserted against the DERIVED value the migration
  // computes — not the stored (and in five of seven cells, wrong or
  // inconsistently-cased) value being replaced.
  it('reproduces all 7 real production (grade, condition) cells correctly under derivation', () => {
    const cells: Array<{ grade: 'A' | 'C' | 'UG'; storedCondition: string; rows: number; expectedTarget: 'REFURBISHED' | 'USED' | 'RAW' }> = [
      { grade: 'A',  storedCondition: 'REFURBISHED', rows: 197, expectedTarget: 'REFURBISHED' },
      { grade: 'A',  storedCondition: 'Refurbished', rows: 218, expectedTarget: 'REFURBISHED' },
      { grade: 'C',  storedCondition: 'Used',        rows: 11,  expectedTarget: 'USED' },
      { grade: 'C',  storedCondition: 'Raw',         rows: 19,  expectedTarget: 'USED' },
      { grade: 'UG', storedCondition: 'Used',        rows: 9,   expectedTarget: 'RAW' },
      { grade: 'UG', storedCondition: 'Raw',         rows: 6,   expectedTarget: 'RAW' },
      { grade: 'UG', storedCondition: 'UG',          rows: 296, expectedTarget: 'RAW' },
    ]
    expect(cells.reduce((s, c) => s + c.rows, 0)).toBe(756)
    for (const cell of cells) {
      expect(deriveConditionFromGrade(cell.grade)).toBe(cell.expectedTarget)
    }
    // Post-migration totals per target (the numbers the migration's own
    // output must log and match).
    const totals = { REFURBISHED: 0, USED: 0, RAW: 0 }
    for (const cell of cells) totals[cell.expectedTarget] += cell.rows
    expect(totals).toEqual({ REFURBISHED: 415, USED: 30, RAW: 311 })
  })
})
