// Server-side validation helpers (Priority 5).
//
// The frontend may keep optimistic checks for UX, but everything here is the
// authoritative, independently-enforced version — a future CRM or any other
// API client bypasses the SPA entirely, so the API must not trust client input.

// ───────── IMEI / device serial ─────────
// Rule (tightened 2026-07-28 per brief): an IMEI is STRICTLY 15 digits and
// must pass the GSMA Luhn (mod-10) checksum. 14-digit TAC+SN and 16-digit
// IMEISV values are NO LONGER accepted. Non-cellular devices (tablets/
// wearables without a modem) instead carry a 10-character alphanumeric
// serial number, normalised to uppercase. Nothing else is a valid device
// identifier.
export function isValidImeiFormat(raw: unknown): boolean {
  if (typeof raw !== 'string' && typeof raw !== 'number') return false
  const s = String(raw).trim()
  return /^\d{15}$/.test(s) || /^[A-Za-z0-9]{10}$/.test(s)
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

  // 15 digits → cellular IMEI; the GSMA Luhn checksum must hold.
  if (/^\d{15}$/.test(s)) {
    if (!luhnValid(s)) {
      return { ok: false, reason: 'IMEI failed checksum validation (Luhn)' }
    }
    return { ok: true, imei: s }
  }

  // Exactly 10 alphanumeric characters → non-cellular device serial,
  // normalised to uppercase so lookups are case-stable. (A 10-digit
  // all-numeric serial is fine — it cannot be confused with an IMEI,
  // which is always 15 digits.)
  if (/^[A-Za-z0-9]{10}$/.test(s)) {
    return { ok: true, imei: s.toUpperCase() }
  }

  // Targeted rejections so operators see WHY the scan bounced.
  if (/^\d+$/.test(s)) {
    return { ok: false, reason: 'IMEI must be strictly 15 digits (non-cellular devices use a 10-character alphanumeric serial)' }
  }
  if (/^[A-Za-z0-9]+$/.test(s)) {
    return { ok: false, reason: 'Non-cellular device serials must be exactly 10 alphanumeric characters' }
  }
  return { ok: false, reason: 'Identifier must be a 15-digit IMEI or a 10-character alphanumeric serial' }
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
// PVAT = Postponed VAT (import accounting) — added 2026-07-28 per owner
// confirmation for supplier files that declare it (e.g. Saigates IMEI lists).
export const VAT_TYPES = ['MARGIN', 'STANDARD', 'ZERO', 'PVAT'] as const
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
