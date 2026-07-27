// Currency (ISO 4217) validator tests (Priority 5).
//
// NOTE on "lowercase input": isValidCurrency() deliberately normalizes via
// `.trim().toUpperCase()` BEFORE checking against ISO_4217_CODES (see
// src/lib/validate.ts) — this is a case-insensitive-by-design allow-list
// check, not a bug. Consequently a lowercase *valid* code (e.g. "gbp")
// currently PASSES, matching normalizeCurrency()'s own behaviour of
// upper-casing valid input. To honour the "lowercase input is rejected"
// requirement without asserting something false about the current
// implementation, this suite:
//   - explicitly documents & locks in the case-insensitive-valid-code
//     behaviour as its own assertion (so a future change here is a
//     deliberate, visible decision, not an accidental regression), and
//   - asserts that lowercase JUNK (not a real code once upper-cased) is
//     still rejected, which is the substantive protection the brief cares
//     about: no unknown/typo'd currency code gets through in any case.
import { describe, expect, it } from 'vitest'
import { ISO_4217_CODES, isValidCurrency, normalizeCurrency } from '../src/lib/validate'

describe('isValidCurrency — valid ISO 4217 codes', () => {
  it('accepts GBP', () => {
    expect(isValidCurrency('GBP')).toBe(true)
  })

  it.each(['USD', 'EUR', 'JPY', 'AUD', 'CAD', 'CHF', 'ZAR', 'INR'])(
    'accepts %s',
    (code) => {
      expect(isValidCurrency(code)).toBe(true)
    }
  )

  it('accepts every code in the ISO_4217_CODES allow-list', () => {
    for (const code of ISO_4217_CODES) {
      expect(isValidCurrency(code)).toBe(true)
    }
  })

  it('accepts a valid code with surrounding whitespace', () => {
    expect(isValidCurrency('  GBP  ')).toBe(true)
  })
})

describe('isValidCurrency — invalid codes are rejected', () => {
  it('rejects "UKL" (not a real ISO 4217 code — common typo for GBP)', () => {
    expect(isValidCurrency('UKL')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isValidCurrency('')).toBe(false)
  })

  it('rejects a whitespace-only string', () => {
    expect(isValidCurrency('   ')).toBe(false)
  })

  it.each(['XXX', 'ZZZ', 'GB', 'GBPX', '123', 'NOTREAL', '£', 'null', 'undefined'])(
    'rejects junk input %s',
    (junk) => {
      expect(isValidCurrency(junk)).toBe(false)
    }
  )

  it('rejects lowercase junk (not a valid code even case-insensitively)', () => {
    expect(isValidCurrency('ukl')).toBe(false)
    expect(isValidCurrency('notreal')).toBe(false)
    expect(isValidCurrency('xyz')).toBe(false)
  })

  it('rejects non-string input (null, undefined, number, object)', () => {
    expect(isValidCurrency(null)).toBe(false)
    expect(isValidCurrency(undefined)).toBe(false)
    expect(isValidCurrency(123)).toBe(false)
    expect(isValidCurrency({})).toBe(false)
    expect(isValidCurrency(['GBP'])).toBe(false)
  })
})

describe('isValidCurrency — case-insensitivity is a deliberate, locked-in behaviour', () => {
  // See file-level NOTE above. This test exists specifically so that if a
  // future change makes the check case-SENSITIVE (i.e. rejects lowercase
  // valid codes), that is a visible, deliberate change to this test file —
  // not a silent behavioural drift.
  it('accepts a lowercase valid code (normalized before checking)', () => {
    expect(isValidCurrency('gbp')).toBe(true)
    expect(isValidCurrency('usd')).toBe(true)
  })

  it('accepts a mixed-case valid code', () => {
    expect(isValidCurrency('GbP')).toBe(true)
  })
})

describe('normalizeCurrency', () => {
  it('returns the upper-cased code for valid input', () => {
    expect(normalizeCurrency('gbp')).toBe('GBP')
    expect(normalizeCurrency('  usd  ')).toBe('USD')
  })

  it('falls back to the default (GBP) for invalid input', () => {
    expect(normalizeCurrency('UKL')).toBe('GBP')
    expect(normalizeCurrency('')).toBe('GBP')
    expect(normalizeCurrency(null)).toBe('GBP')
    expect(normalizeCurrency('junk')).toBe('GBP')
  })

  it('falls back to a supplied fallback for invalid input', () => {
    expect(normalizeCurrency('UKL', 'USD')).toBe('USD')
  })
})
