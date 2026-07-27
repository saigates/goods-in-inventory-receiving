// OPR (Outward Processing Relief) foundation helpers — OPR 1 track.
//
// Scope guard: this file is ENTITY validation only (fields that must never
// be junk at write time). The full green/amber/red validation ENGINE —
// authorisation-valid-on-ship-date, commodity-within-scope, IMEI
// presence/uniqueness across the consignment, document totals — is OPR 2
// and does not live here yet.

// ───────── Currency: GBP only ─────────
// Critical constraint from the authorisation reference notes: currency on
// customs paperwork is "GBP", never the legacy "UKL". We enforce GBP-only
// at the shipment level (buy prices at goods-in may be other ISO codes;
// customs consignments are declared in GBP).
export function validateShipmentCurrency(raw: unknown): { ok: true; value: 'GBP' } | { ok: false; error: string } {
  const v = raw == null || raw === '' ? 'GBP' : String(raw).trim().toUpperCase()
  if (v === 'UKL') {
    return { ok: false, error: "currency must be 'GBP' — 'UKL' is the obsolete CHIEF-era code and is rejected on CDS declarations" }
  }
  if (v !== 'GBP') {
    return { ok: false, error: `OPR shipments must be declared in GBP (got '${v}')` }
  }
  return { ok: true, value: 'GBP' }
}

// ───────── Procedure codes ─────────
// From the authorisation reference notes:
//   export: 2100 (standard OPR export), 2200 (warranty/free-of-charge)
//   import: 6121 (re-import after outward processing)
// Additional procedure codes: B51 / B02 pair with 2200 (warranty).
// Critical constraint: 2100 + B51 is NOT a permitted combination.
export const EXPORT_PROCEDURE_CODES = ['2100', '2200'] as const
export const IMPORT_PROCEDURE_CODES = ['6121'] as const
export const ADDITIONAL_PROCEDURE_CODES = ['B51', 'B02'] as const

export type ProcedureValidation =
  | { ok: true; procedure_code: string; additional_procedure_code: string | null }
  | { ok: false; error: string }

export function validateProcedureCodes(
  direction: 'export' | 'import',
  rawProc: unknown,
  rawAdditional: unknown,
): ProcedureValidation {
  const proc = String(rawProc ?? '').trim()
  const additional = rawAdditional == null || String(rawAdditional).trim() === ''
    ? null
    : String(rawAdditional).trim().toUpperCase()

  const allowed: readonly string[] = direction === 'export' ? EXPORT_PROCEDURE_CODES : IMPORT_PROCEDURE_CODES
  if (!allowed.includes(proc)) {
    return { ok: false, error: `procedure_code '${proc || '(missing)'}' is not valid for ${direction} (allowed: ${allowed.join(', ')})` }
  }

  if (additional !== null) {
    if (!(ADDITIONAL_PROCEDURE_CODES as readonly string[]).includes(additional)) {
      return { ok: false, error: `additional_procedure_code '${additional}' is not recognised (allowed: ${ADDITIONAL_PROCEDURE_CODES.join(', ')} or none)` }
    }
    // The known-failure-mode combination, called out in the authorisation
    // reference notes: 2100 + B51 is not permitted; B51 pairs with 2200.
    if (proc === '2100' && additional === 'B51') {
      return { ok: false, error: 'procedure code 2100 with additional procedure code B51 is not a permitted combination — B51 (warranty) pairs with 2200' }
    }
    if (direction === 'import') {
      return { ok: false, error: 'additional_procedure_code is an export-declaration field; leave it empty on import shipments (import handling is OPR 3)' }
    }
  }

  return { ok: true, procedure_code: proc, additional_procedure_code: additional }
}

// ───────── Declaration text charset ─────────
// Critical constraint: text destined for customs declarations may contain
// letters, numbers and spaces only — no punctuation, no symbols. Applied to
// fields that flow onto declarations (consignee name, shipment reference).
export function isDeclarationSafeText(raw: string): boolean {
  return /^[A-Za-z0-9 ]+$/.test(raw)
}

// ───────── Authorisation field checks ─────────
// EORI: 2-letter country prefix + 1–15 alphanumerics (GB EORIs are
// GB + 12 digits + 3-digit suffix, but we validate the general shape and
// let the record carry what HMRC issued).
export function isValidEori(raw: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{1,15}$/.test(raw.trim().toUpperCase())
}

// ISO date (YYYY-MM-DD) that actually parses.
export function isValidIsoDate(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false
  const d = new Date(raw + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw
}
