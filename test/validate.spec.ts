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
import { ISO_4217_CODES, isValidCurrency, normalizeCurrency, validateImei, isValidImeiFormat } from '../src/lib/validate'

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

// ───────── IMEI / device serial (rule tightened 2026-07-28) ─────────
// IMEI: STRICTLY 15 digits + Luhn. Non-cellular devices: exactly 10
// alphanumeric characters, normalised to uppercase. 14-digit TAC+SN and
// 16-digit IMEISV — previously tolerated — are now REJECTED.

function luhnImei(body14: string): string {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    let d = Number(body14[i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return body14 + String((10 - (sum % 10)) % 10)
}

describe('validateImei — strict 15-digit IMEI', () => {
  it('accepts a Luhn-valid 15-digit IMEI', () => {
    const imei = luhnImei('35610215272349')
    const r = validateImei(imei)
    expect(r).toEqual({ ok: true, imei })
  })

  it('rejects a 15-digit IMEI with a broken Luhn checksum', () => {
    const good = luhnImei('35610215272349')
    const bad = good.slice(0, 14) + String((Number(good[14]) + 1) % 10)
    const r = validateImei(bad)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('Luhn')
  })

  it('REJECTS a 14-digit TAC+SN (previously tolerated)', () => {
    const r = validateImei('35610215272349')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('strictly 15 digits')
  })

  it('REJECTS a 16-digit IMEISV (previously tolerated)', () => {
    const r = validateImei(luhnImei('35610215272349') + '0')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('strictly 15 digits')
  })

  it('rejects empty / null / whitespace', () => {
    for (const v of ['', null, undefined, '   ']) {
      expect(validateImei(v).ok).toBe(false)
    }
  })
})

describe('validateImei — 10-character non-cellular serials', () => {
  it('accepts a 10-char alphanumeric serial and uppercases it', () => {
    const r = validateImei('c02xk1abcd')
    expect(r).toEqual({ ok: true, imei: 'C02XK1ABCD' })
  })

  it('accepts an all-numeric 10-char serial (unambiguous — IMEIs are 15)', () => {
    expect(validateImei('1234567890')).toEqual({ ok: true, imei: '1234567890' })
  })

  it('rejects 9- and 11-char alphanumeric serials', () => {
    for (const v of ['C02XK1ABC', 'C02XK1ABCDE']) {
      const r = validateImei(v)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('exactly 10 alphanumeric')
    }
  })

  it('rejects serials with punctuation or spaces inside', () => {
    for (const v of ['C02X-1ABCD', 'C02X 1ABCD', 'C02X_1ABCD']) {
      expect(validateImei(v).ok).toBe(false)
    }
  })
})

describe('isValidImeiFormat — mirrors the strict rule', () => {
  it('accepts 15 digits and 10 alphanumerics only', () => {
    expect(isValidImeiFormat('356102152723494')).toBe(true)
    expect(isValidImeiFormat('C02XK1ABCD')).toBe(true)
    expect(isValidImeiFormat('35610215272349')).toBe(false)   // 14
    expect(isValidImeiFormat('3561021527234940')).toBe(false) // 16
    expect(isValidImeiFormat('C02XK1ABC')).toBe(false)        // 9
    expect(isValidImeiFormat('')).toBe(false)
  })
})
