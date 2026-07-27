// Server-side validation helpers (Priority 5).
//
// The frontend may keep optimistic checks for UX, but everything here is the
// authoritative, independently-enforced version — a future CRM or any other
// API client bypasses the SPA entirely, so the API must not trust client input.

// ───────── IMEI ─────────
// Standard IMEI is 15 digits with a Luhn (mod-10) check digit. IMEISV is 16
// digits with no check digit. Some supplier manifests carry 14-digit TAC+SN
// values without the check digit. We accept the 14-16 digit range required
// by the brief, and enforce the Luhn checksum only when the length is the
// standard 15 digits (where a checksum digit is actually defined).
export function isValidImeiFormat(raw: unknown): boolean {
  if (typeof raw !== 'string' && typeof raw !== 'number') return false
  const s = String(raw).trim()
  return /^\d{14,16}$/.test(s)
}

// Luhn checksum used by the GSMA IMEI spec.
function luhnValid(digits: string): boolean {
  let sum = 0
  const arr = digits.split('').map(Number).reverse()
  for (let i = 0; i < arr.length; i++) {
    let d = arr[i]
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

export type ImeiValidation =
  | { ok: true; imei: string }
  | { ok: false; reason: string }

export function validateImei(raw: unknown): ImeiValidation {
  if (raw == null || String(raw).trim() === '') {
    return { ok: false, reason: 'IMEI is required' }
  }
  const s = String(raw).trim()
  if (!/^\d+$/.test(s)) {
    return { ok: false, reason: 'IMEI must contain only digits' }
  }
  if (s.length < 14 || s.length > 16) {
    return { ok: false, reason: 'IMEI must be 14-16 digits' }
  }
  if (s.length === 15 && !luhnValid(s)) {
    return { ok: false, reason: 'IMEI failed checksum validation (Luhn)' }
  }
  return { ok: true, imei: s }
}

// ───────── Currency (ISO 4217) ─────────
// Deliberately a fixed allow-list rather than a dynamic lookup — valuation
// data feeds inventory and future customs docs, so an unknown/typo'd code
// (e.g. "UKL") must be rejected outright rather than silently accepted.
export const ISO_4217_CODES = new Set([
  'AED','AFN','ALL','AMD','ANG','AOA','ARS','AUD','AWG','AZN',
  'BAM','BBD','BDT','BGN','BHD','BIF','BMD','BND','BOB','BRL','BSD','BTN','BWP','BYN','BZD',
  'CAD','CDF','CHF','CLP','CNY','COP','CRC','CUP','CVE','CZK',
  'DJF','DKK','DOP','DZD',
  'EGP','ERN','ETB','EUR',
  'FJD','FKP',
  'GBP','GEL','GHS','GIP','GMD','GNF','GTQ','GYD',
  'HKD','HNL','HRK','HTG','HUF',
  'IDR','ILS','INR','IQD','IRR','ISK',
  'JMD','JOD','JPY',
  'KES','KGS','KHR','KMF','KPW','KRW','KWD','KYD','KZT',
  'LAK','LBP','LKR','LRD','LSL','LYD',
  'MAD','MDL','MGA','MKD','MMK','MNT','MOP','MRU','MUR','MVR','MWK','MXN','MYR','MZN',
  'NAD','NGN','NIO','NOK','NPR','NZD',
  'OMR',
  'PAB','PEN','PGK','PHP','PKR','PLN','PYG',
  'QAR',
  'RON','RSD','RUB','RWF',
  'SAR','SBD','SCR','SDG','SEK','SGD','SHP','SLE','SOS','SRD','SSP','STN','SYP','SZL',
  'THB','TJS','TMT','TND','TOP','TRY','TTD','TWD','TZS',
  'UAH','UGX','USD','UYU','UZS',
  'VES','VND','VUV',
  'WST',
  'XAF','XCD','XOF','XPF',
  'YER',
  'ZAR','ZMW','ZWL',
])

export function isValidCurrency(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  return ISO_4217_CODES.has(raw.trim().toUpperCase())
}

export function normalizeCurrency(raw: unknown, fallback = 'GBP'): string {
  if (typeof raw === 'string' && isValidCurrency(raw)) return raw.trim().toUpperCase()
  return fallback
}

// ───────── VAT type ─────────
export const VAT_TYPES = ['MARGIN', 'STANDARD', 'ZERO'] as const
export type VatTypeValue = typeof VAT_TYPES[number]

export function isValidVatType(raw: unknown): raw is VatTypeValue {
  return typeof raw === 'string' && (VAT_TYPES as readonly string[]).includes(raw.trim().toUpperCase())
}

// ───────── Buy price ─────────
export type PriceValidation =
  | { ok: true; value: number }
  | { ok: false; reason: string }

export function validateBuyPrice(raw: unknown): PriceValidation {
  if (raw == null || raw === '') return { ok: false, reason: 'buy_price is required' }
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return { ok: false, reason: 'buy_price must be a number' }
  if (n < 0) return { ok: false, reason: 'buy_price cannot be negative' }
  if (n > 1_000_000) return { ok: false, reason: 'buy_price is implausibly large' }
  // Round to 2dp — this is money.
  return { ok: true, value: Math.round(n * 100) / 100 }
}

// ───────── Generic string helpers ─────────
export function cleanString(raw: unknown, maxLen = 500): string | null {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  return s.slice(0, maxLen)
}
