// OPR 2 — Export validation engine.
//
// Runs the pre-finalisation checks over a shipment + its authorisation +
// its frozen lines and returns CODED green/amber/red results:
//   green — check passed
//   amber — finalisation allowed, but a human should look (warning)
//   red   — blocks finalisation
//
// The engine is pure (no DB access): callers fetch the rows and pass them
// in, which keeps every rule unit-testable without HTTP.

import type { Shipment, ShipmentLine, OprAuthorisation } from '../types'
import { validateImei } from './validate'
import { validateProcedureCodes, isDeclarationSafeText } from './opr'

export type CheckLevel = 'green' | 'amber' | 'red'

export type ValidationCheck = {
  code: string
  level: CheckLevel
  message: string
}

export type ValidationResult = {
  result: CheckLevel        // worst level across all checks
  checks: ValidationCheck[]
  red_count: number
  amber_count: number
}

// Money rule: declared unit values must be expressible in pence — a value
// like 33.333 makes document totals ambiguous between rounding schemes.
function isPenceExact(v: number): boolean {
  return Math.abs(v * 100 - Math.round(v * 100)) < 1e-6
}

export function sumLineValues(lines: Pick<ShipmentLine, 'unit_value'>[]): number {
  return Math.round(lines.reduce((s, l) => s + Number(l.unit_value) * 100, 0)) / 100
}

export function runExportValidation(
  shipment: Shipment,
  authorisation: OprAuthorisation | null,
  lines: ShipmentLine[],
  today = new Date().toISOString().slice(0, 10),
): ValidationResult {
  const checks: ValidationCheck[] = []
  const add = (code: string, level: CheckLevel, message: string) => checks.push({ code, level, message })
  // TEMP_EXPORT_STANDARD is a non-customs consignment flow (migration 0023):
  // no authorisation, no procedure code, no commodity-scope concept. Those
  // checks are customs-declaration-specific and do not apply — they are
  // reported green/"not applicable" rather than evaluated, so the traffic
  // lights stay honest instead of red-blocking on fields the shipment is
  // forbidden from ever having (enforced at creation in routes/opr.ts).
  const isStandardTemp = shipment.shipment_type === 'TEMP_EXPORT_STANDARD'

  // ── SHIP_HAS_LINES ──
  if (lines.length === 0) {
    add('SHIP_HAS_LINES', 'red', 'Consignment has no device lines — nothing to declare')
  } else {
    add('SHIP_HAS_LINES', 'green', `${lines.length} device line(s) on the consignment`)
  }

  // ── CURRENCY_GBP — shipment AND every frozen line ──
  const badCur = lines.filter(l => l.currency !== 'GBP')
  if (shipment.currency !== 'GBP') {
    add('CURRENCY_GBP', 'red', `Shipment currency is '${shipment.currency}' — OPR declarations must be GBP (never UKL)`)
  } else if (badCur.length) {
    add('CURRENCY_GBP', 'red', `${badCur.length} line(s) have a non-GBP currency — OPR declarations must be GBP`)
  } else {
    add('CURRENCY_GBP', 'green', 'Shipment and all lines are GBP')
  }

  // ── AUTH_VALID_ON_SHIP_DATE ──
  if (isStandardTemp) {
    add('AUTH_VALID_ON_SHIP_DATE', 'green', 'Not applicable — TEMP_EXPORT_STANDARD has no customs authorisation')
  } else if (!authorisation) {
    add('AUTH_VALID_ON_SHIP_DATE', 'red', 'Shipment has no resolvable OPR authorisation')
  } else {
    const effective = shipment.ship_date || today
    if (effective < authorisation.valid_from || effective > authorisation.valid_to) {
      add('AUTH_VALID_ON_SHIP_DATE', 'red',
        `Authorisation ${authorisation.cds_number} is valid ${authorisation.valid_from} → ${authorisation.valid_to}; ${shipment.ship_date ? 'ship date' : 'today'} ${effective} is outside that window`)
    } else if (!shipment.ship_date) {
      add('AUTH_VALID_ON_SHIP_DATE', 'amber',
        `No ship_date set — authorisation checked against today (${today}); set the actual ship date before finalising`)
    } else {
      add('AUTH_VALID_ON_SHIP_DATE', 'green', `Authorisation valid on ship date ${shipment.ship_date}`)
    }
  }

  // ── PROCEDURE_CODE — defence in depth (also enforced at create/patch) ──
  if (isStandardTemp) {
    add('PROCEDURE_CODE', 'green', 'Not applicable — TEMP_EXPORT_STANDARD carries no customs procedure code')
  } else {
    const proc = validateProcedureCodes('export', shipment.procedure_code, shipment.additional_procedure_code)
    if (!proc.ok) {
      add('PROCEDURE_CODE', 'red', proc.error)
    } else {
      add('PROCEDURE_CODE', 'green',
        `Procedure code ${shipment.procedure_code}${shipment.additional_procedure_code ? ' + ' + shipment.additional_procedure_code : ''} is valid for OPR export`)
    }
  }

  // ── COMMODITY_SCOPE ──
  if (isStandardTemp) {
    add('COMMODITY_SCOPE', 'green', 'Not applicable — TEMP_EXPORT_STANDARD has no customs commodity scope to verify')
  } else if (!authorisation) {
    add('COMMODITY_SCOPE', 'red', 'Cannot check commodity scope without an authorisation')
  } else if (!authorisation.commodity_codes) {
    add('COMMODITY_SCOPE', 'amber',
      'Authorisation record has no commodity_codes — scope cannot be verified automatically; confirm the goods are within the authorised scope')
  } else {
    add('COMMODITY_SCOPE', 'green',
      `Goods are ${authorisation.commodity_scope || 'devices'} within authorised commodity code(s) ${authorisation.commodity_codes}`)
  }

  // ── IMEIS_VALID_UNIQUE ──
  const seen = new Map<string, number>()
  const imeiProblems: string[] = []
  for (const l of lines) {
    if (!l.imei) { imeiProblems.push(`line ${l.id}: IMEI missing`); continue }
    const v = validateImei(l.imei)
    if (!v.ok) imeiProblems.push(`line ${l.id} (${l.imei}): ${v.reason}`)
    seen.set(l.imei, (seen.get(l.imei) || 0) + 1)
  }
  for (const [imei, n] of seen) if (n > 1) imeiProblems.push(`IMEI ${imei} appears ${n} times`)
  if (imeiProblems.length) {
    add('IMEIS_VALID_UNIQUE', 'red', `IMEI problems: ${imeiProblems.join('; ')}`)
  } else if (lines.length) {
    add('IMEIS_VALID_UNIQUE', 'green', `All ${lines.length} IMEIs present, checksum-valid and unique`)
  }

  // ── DECLARATION_TEXT — charset (red) + length (amber) ──
  const textProblems: { level: CheckLevel; msg: string }[] = []
  if (!shipment.reference || !isDeclarationSafeText(shipment.reference)) {
    textProblems.push({ level: 'red', msg: 'reference contains characters not permitted on declarations' })
  } else if (shipment.reference.length > 35) {
    textProblems.push({ level: 'amber', msg: `reference is ${shipment.reference.length} chars — declaration boxes are typically limited to 35` })
  }
  if (shipment.consignee_name && !isDeclarationSafeText(shipment.consignee_name)) {
    textProblems.push({ level: 'red', msg: 'consignee_name contains characters not permitted on declarations' })
  }
  if (!shipment.consignee_name) {
    textProblems.push({ level: 'amber', msg: 'consignee_name is empty — the invoice needs the overseas repairer' })
  }
  if (textProblems.some(p => p.level === 'red')) {
    add('DECLARATION_TEXT', 'red', textProblems.filter(p => p.level === 'red').map(p => p.msg).join('; '))
  } else if (textProblems.length) {
    add('DECLARATION_TEXT', 'amber', textProblems.map(p => p.msg).join('; '))
  } else {
    add('DECLARATION_TEXT', 'green', 'Declaration text fields are charset- and length-safe')
  }

  // ── UNIT_VALUES_PRESENT — present, positive, pence-exact ──
  const valueProblems: string[] = []
  for (const l of lines) {
    const v = Number(l.unit_value)
    if (l.unit_value == null || Number.isNaN(v)) valueProblems.push(`line ${l.id} (${l.imei}): unit value missing`)
    else if (v <= 0) valueProblems.push(`line ${l.id} (${l.imei}): unit value ${v} must be positive`)
    else if (!isPenceExact(v)) valueProblems.push(`line ${l.id} (${l.imei}): unit value ${v} is not expressible in pence`)
  }
  if (valueProblems.length) {
    add('UNIT_VALUES_PRESENT', 'red', `Unit value problems: ${valueProblems.join('; ')}`)
  } else if (lines.length) {
    add('UNIT_VALUES_PRESENT', 'green', 'Every line has a positive, pence-exact unit value')
  }

  // ── TOTALS_CONSISTENT — invoice total vs scan-out total, independently computed ──
  if (lines.length && !valueProblems.length) {
    const invoiceTotal = sumLineValues(lines)                                   // pence-sum
    const scanOutTotal = Math.round(lines.reduce((s, l) => s + Number(l.unit_value), 0) * 100) / 100 // float-sum then round
    if (invoiceTotal !== scanOutTotal) {
      add('TOTALS_CONSISTENT', 'red', `Invoice total £${invoiceTotal.toFixed(2)} ≠ scan-out total £${scanOutTotal.toFixed(2)}`)
    } else {
      add('TOTALS_CONSISTENT', 'green', `Document totals agree: £${invoiceTotal.toFixed(2)} across ${lines.length} unit(s)`)
    }
  }

  // ── LOGISTICS_COMPLETE — advisory ──
  const missing: string[] = []
  if (!shipment.consignee_address) missing.push('consignee_address')
  if (!shipment.carrier) missing.push('carrier')
  if (!shipment.incoterm) missing.push('incoterm')
  if (missing.length) {
    add('LOGISTICS_COMPLETE', 'amber', `Missing logistics fields: ${missing.join(', ')}`)
  } else {
    add('LOGISTICS_COMPLETE', 'green', 'Consignee address, carrier and incoterm are set')
  }

  const red_count = checks.filter(x => x.level === 'red').length
  const amber_count = checks.filter(x => x.level === 'amber').length
  return {
    result: red_count ? 'red' : amber_count ? 'amber' : 'green',
    checks,
    red_count,
    amber_count,
  }
}
