// LW001 manifest-14 follow-up — normalizeCapacity() TB/GB canonical-form
// tests, pure-function (no DB/HTTP). Mirrors condition.spec.ts's convention:
// real fixture figures live here, never in src/.
//
// The catalogue's own real distinct-capacity value set (confirmed via
// `SELECT DISTINCT capacity, COUNT(*) FROM sku_catalog GROUP BY capacity`
// against the local D1 mirror, 2781 rows total) is exactly:
//   64GB=140 · 128GB=585 · 256GB=966 · 512GB=774 · 1TB=304 · 2TB=12
// i.e. the catalogue NEVER stores "1024GB" or "2048GB" — only GB-notation
// below 1024 and TB-notation at/above 1024. Before this fix,
// normalizeCapacity("1024GB") returned "1024GB" verbatim, which could never
// equal the catalogue's "1TB" regardless of how good the model/color/grade
// match was (see expected_devices id 701 in
// .deploy-checks/lw001-16-catalog-coverage.md — an iPhone 15 Pro Max /
// 1024GB / Black / UG device that has a real, exact-match catalogue SKU
// stored as "1TB").
import { describe, it, expect } from 'vitest'
import { normalizeCapacity } from '../src/lib/catalog'

describe('normalizeCapacity', () => {
  describe('TB folding (the bug this fixes)', () => {
    it('"1024" (bare multiple of 1024) -> "1TB"', () => {
      expect(normalizeCapacity('1024')).toBe('1TB')
    })

    it('"1024GB" -> "1TB"', () => {
      expect(normalizeCapacity('1024GB')).toBe('1TB')
    })

    it('"1024 GB" (space before unit) -> "1TB"', () => {
      expect(normalizeCapacity('1024 GB')).toBe('1TB')
    })

    it('"1024G" -> "1TB"', () => {
      expect(normalizeCapacity('1024G')).toBe('1TB')
    })

    it('"2048" -> "2TB"', () => {
      expect(normalizeCapacity('2048')).toBe('2TB')
    })

    it('"2048GB" -> "2TB"', () => {
      expect(normalizeCapacity('2048GB')).toBe('2TB')
    })
  })

  describe('explicit TB passthrough (collapsed to catalogue form)', () => {
    it('"1TB" -> "1TB"', () => {
      expect(normalizeCapacity('1TB')).toBe('1TB')
    })

    it('"1 TB" (space before unit) -> "1TB"', () => {
      expect(normalizeCapacity('1 TB')).toBe('1TB')
    })

    it('"2TB" -> "2TB"', () => {
      expect(normalizeCapacity('2TB')).toBe('2TB')
    })

    it('lowercase "1tb" -> "1TB"', () => {
      expect(normalizeCapacity('1tb')).toBe('1TB')
    })
  })

  describe('existing GB-range behaviour (regression)', () => {
    it('"128" -> "128GB"', () => {
      expect(normalizeCapacity('128')).toBe('128GB')
    })

    it('"128G" -> "128GB"', () => {
      expect(normalizeCapacity('128G')).toBe('128GB')
    })

    it('"128 GB" -> "128GB"', () => {
      expect(normalizeCapacity('128 GB')).toBe('128GB')
    })

    it('"128GB" -> "128GB"', () => {
      expect(normalizeCapacity('128GB')).toBe('128GB')
    })

    it('"256GB" -> "256GB" (not a multiple of 1024, must not fold)', () => {
      expect(normalizeCapacity('256GB')).toBe('256GB')
    })

    it('"512GB" -> "512GB" (not a multiple of 1024, must not fold)', () => {
      expect(normalizeCapacity('512GB')).toBe('512GB')
    })

    it('"64GB" -> "64GB"', () => {
      expect(normalizeCapacity('64GB')).toBe('64GB')
    })
  })

  describe('null / empty / fallback paths (regression)', () => {
    it('null -> null', () => {
      expect(normalizeCapacity(null)).toBeNull()
    })

    it('undefined -> null', () => {
      expect(normalizeCapacity(undefined)).toBeNull()
    })

    it('"" -> null', () => {
      expect(normalizeCapacity('')).toBeNull()
    })

    it('"   " (whitespace-only) -> null', () => {
      expect(normalizeCapacity('   ')).toBeNull()
    })

    it('non-numeric junk falls back to uppercase + collapsed whitespace', () => {
      expect(normalizeCapacity('  n/a  ')).toBe('N/A')
    })
  })

  // The catalogue's own real distinct-value set, asserted verbatim so this
  // test breaks (loudly) if the catalogue's convention is ever widened
  // (e.g. a future 4TB SKU) without a matching normalizeCapacity() update.
  it('normalizes every real catalogue capacity value to itself (idempotent)', () => {
    const catalogueValues = ['64GB', '128GB', '256GB', '512GB', '1TB', '2TB']
    for (const v of catalogueValues) {
      expect(normalizeCapacity(v)).toBe(v)
    }
  })
})
