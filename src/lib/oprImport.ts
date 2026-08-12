// OPR 3 — Import / Discharge flow: C&E1154 duty computation, re-import
// clearance-instruction draft, import validation engine, discharge maths.
//
// Everything here is PURE (no DB access): callers fetch the rows and pass
// them in, keeping every rule unit-testable without HTTP.
//
// Domain rules encoded (from the authorisation reference notes):
//   - The C&E1154's "OPR authorisation number" field takes the OPR
//     Authorisation Number (op_authorisation_number, e.g. OP/0922/601/31);
//     the CDS Authorisation Number appears ONLY in the cross-referenced
//     statement. Confusing the two is a known failure mode. Neither is a
//     "CHIEF number" — no legacy CHIEF-format identifier exists on this
//     authorisation; that label was a documentation error and has been
//     scrubbed from the schema, types and this module.
//   - Duty/VAT on re-import (procedure 6121) is assessed on the REPAIR COST
//     only, never the full value of the goods — that is the relief.
//   - Exported-goods value on the form = sum of the RETURNING devices'
//     frozen export values only (partial returns declare partial value).
//   - Partial-return guardrail: the declared exported-goods quantity must
//     equal the consignment quantity (the count of returning devices).
//   - HMRC customs exchange rates are quoted as foreign-currency units per
//     £1, so GBP = amount / rate.

import type { Shipment, ShipmentLine, OprAuthorisation } from '../types'
import { sumLineValues } from './oprValidation'
import { isValidCurrency } from './validate'
import type { CheckLevel, ValidationCheck, ValidationResult } from './oprValidation'

// ───────── Money helpers ─────────

export function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function isPenceExact(v: number): boolean {
  return Math.abs(v * 100 - Math.round(v * 100)) < 1e-6
}

// ───────── Date helpers (discharge deadline) ─────────

// ISO date + N calendar months, clamping the day to the target month's
// length (e.g. 2026-08-31 + 6 months → 2027-02-28).
export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  const targetMonthIndex = m - 1 + months
  const targetYear = y + Math.floor(targetMonthIndex / 12)
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12
  // Day 0 of month+1 = last day of target month (UTC, no DST surprises).
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  const day = Math.min(d, lastDay)
  return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// ───────── C&E1154 computation ─────────

export type Ce1154Result =
  | { ok: true; ce1154: Ce1154 }
  | { ok: false; error: string }

export type Ce1154 = {
  form: 'C&E1154'
  // OPR Authorisation Number (e.g. OP/0922/601/31) — the ONLY place it may appear.
  opr_authorisation_number: string
  // CDS Authorisation Number lives in the cross-referenced statement, never the field above.
  cross_reference_statement: string
  // Supervising office NAME only — never the code, never an address. The
  // office code is a reference-only field on our authorisation record and
  // is not ours to put on a customs document.
  supervising_office_name: string | null
  export_mrn: string
  quantity: number
  exported_goods_value_gbp: number
  repair_cost: { amount: number; currency: string }
  customs_exchange_rate: number | null
  repair_cost_gbp: number
  duty_rate_pct: number
  duty_without_relief_gbp: number
  duty_on_repair_cost_gbp: number   // the net duty actually payable
  opr_relief_gbp: number
  vat_note: string
}

export function computeCe1154(
  importShipment: Shipment,
  exportShipment: Shipment | null,
  authorisation: OprAuthorisation | null,
  returningLines: ShipmentLine[],
  declaredQuantity?: number,
): Ce1154Result {
  if (importShipment.direction !== 'import') {
    return { ok: false, error: 'C&E1154 is generated for IMPORT (re-import) shipments only' }
  }
  if (!returningLines.length) {
    return { ok: false, error: 'Import consignment has no device lines — nothing to declare on the C&E1154' }
  }
  // Partial-return guardrail: the declared exported-goods quantity MUST
  // equal the consignment quantity. Partial returns are fine (90 of 162),
  // but the form must describe the returning consignment, not the original
  // export.
  const quantity = returningLines.length
  if (declaredQuantity !== undefined && declaredQuantity !== quantity) {
    return { ok: false, error: `Declared exported-goods quantity ${declaredQuantity} does not equal the consignment quantity ${quantity} — the C&E1154 must describe the returning consignment` }
  }
  if (!authorisation) {
    return { ok: false, error: 'Import shipment has no resolvable OPR authorisation' }
  }
  // The C&E1154 authorisation field takes the OPR Authorisation Number.
  // Refusing to fall back to the CDS Authorisation Number here is
  // deliberate — that substitution is the known failure mode.
  if (!authorisation.op_authorisation_number) {
    return { ok: false, error: 'Authorisation record has no OPR Authorisation Number (op_authorisation_number) — the C&E1154 authorisation field requires it and the CDS Authorisation Number must NOT be substituted' }
  }
  if (!exportShipment || !exportShipment.export_mrn) {
    return { ok: false, error: 'Related export shipment has no export MRN — the C&E1154 must reference the original export declaration' }
  }

  // Repair cost → GBP at the HMRC customs rate.
  const cost = Number(importShipment.repair_cost)
  if (importShipment.repair_cost == null || Number.isNaN(cost) || cost <= 0) {
    return { ok: false, error: 'repair_cost is required (the repairer invoice amount) and must be positive' }
  }
  if (!isPenceExact(cost)) {
    return { ok: false, error: `repair_cost ${cost} is not expressible in minor units (2dp)` }
  }
  const costCurrency = (importShipment.repair_cost_currency || 'GBP').toUpperCase()
  let rate: number | null = null
  let repairCostGbp: number
  if (costCurrency === 'GBP') {
    repairCostGbp = cost
  } else {
    rate = Number(importShipment.customs_exchange_rate)
    if (importShipment.customs_exchange_rate == null || Number.isNaN(rate) || rate <= 0) {
      return { ok: false, error: `repair_cost is in ${costCurrency} — customs_exchange_rate (HMRC monthly rate, ${costCurrency} per GBP 1) is required to convert it` }
    }
    repairCostGbp = round2(cost / rate)
  }

  const dutyPct = Number(importShipment.duty_rate_pct)
  if (importShipment.duty_rate_pct == null || Number.isNaN(dutyPct) || dutyPct < 0 || dutyPct > 100) {
    return { ok: false, error: 'duty_rate_pct is required (0–100; 0 is valid — smartphones under 8517 are typically duty-free)' }
  }

  // Exported-goods value = the RETURNING lines' frozen export values only.
  const exportedValue = sumLineValues(returningLines)

  // OPR relief: without OPR, duty would be charged on the full customs
  // value (goods + repair). Under OPR it is charged on the repair cost
  // only. The relief is the difference.
  const dutyWithoutRelief = round2((exportedValue + repairCostGbp) * dutyPct / 100)
  const dutyNet = round2(repairCostGbp * dutyPct / 100)
  const relief = round2(dutyWithoutRelief - dutyNet)

  return {
    ok: true,
    ce1154: {
      form: 'C&E1154',
      opr_authorisation_number: authorisation.op_authorisation_number,
      cross_reference_statement:
        `Goods re-imported after outward processing under CDS authorisation ${authorisation.cds_number} ` +
        `held by ${authorisation.holder_name} (EORI ${authorisation.eori}); original export MRN ${exportShipment.export_mrn}`,
      supervising_office_name: authorisation.supervising_office_name,
      export_mrn: exportShipment.export_mrn,
      quantity,
      exported_goods_value_gbp: exportedValue,
      repair_cost: { amount: cost, currency: costCurrency },
      customs_exchange_rate: rate,
      repair_cost_gbp: repairCostGbp,
      duty_rate_pct: dutyPct,
      duty_without_relief_gbp: dutyWithoutRelief,
      duty_on_repair_cost_gbp: dutyNet,
      opr_relief_gbp: relief,
      vat_note: 'Import VAT is assessed on the repair cost (plus any duty and return freight) only — never on the full value of the goods',
    },
  }
}

// Print-ready A4 rendering of the computed C&E1154 figures.
export function buildCe1154Html(ce: Ce1154, importShipment: Shipment, lines: ShipmentLine[]): string {
  const money = (v: number) => `£${v.toFixed(2)}`
  const rows = lines.map((l, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${l.imei}</td>
          <td>${[l.brand, l.model, l.capacity, l.color].filter(Boolean).join(' ')}</td>
          <td class="num">${money(Number(l.unit_value))}</td>
        </tr>`).join('')
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>C&amp;E1154 — ${importShipment.reference}</title>
<style>
  @page { size: A4; margin: 18mm; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; color: #111; }
  h1 { font-size: 15pt; margin: 0 0 2mm; }
  h2 { font-size: 11pt; margin: 6mm 0 2mm; border-bottom: 1px solid #999; }
  table { width: 100%; border-collapse: collapse; margin-top: 2mm; }
  th, td { border: 1px solid #bbb; padding: 1.5mm 2mm; text-align: left; font-size: 9.5pt; }
  .num { text-align: right; }
  .kv td:first-child { width: 42%; font-weight: bold; background: #f6f6f6; }
  .statement { margin-top: 4mm; padding: 3mm; border: 1px solid #999; background: #fafafa; font-size: 9.5pt; }
</style>
</head>
<body>
  <header id="ce1154-header">
    <h1>C&amp;E1154 — Outward Processing Relief duty calculation</h1>
    <p>Returning consignment: <strong>${importShipment.reference}</strong> · Procedure code <strong>${importShipment.procedure_code}</strong></p>
  </header>
  <section id="ce1154-authorisation">
    <h2>Authorisation &amp; export reference</h2>
    <table class="kv">
      <tr><td>OPR authorisation number (this form)</td><td>${ce.opr_authorisation_number}</td></tr>
      ${ce.supervising_office_name ? `<tr><td>Issued by</td><td>${ce.supervising_office_name}</td></tr>` : ''}
      <tr><td>Original export MRN</td><td>${ce.export_mrn}</td></tr>
    </table>
  </section>
  <section id="ce1154-calculation">
    <h2>Duty calculation</h2>
    <table class="kv">
      <tr><td>Quantity of exported goods (this consignment)</td><td>${ce.quantity}</td></tr>
      <tr><td>Value of exported goods (returning units only)</td><td>${money(ce.exported_goods_value_gbp)}</td></tr>
      <tr><td>Repair cost (as invoiced)</td><td>${ce.repair_cost.amount.toFixed(2)} ${ce.repair_cost.currency}</td></tr>
      ${ce.customs_exchange_rate != null ? `<tr><td>Customs exchange rate (${ce.repair_cost.currency} per £1)</td><td>${ce.customs_exchange_rate}</td></tr>` : ''}
      <tr><td>Repair cost in GBP</td><td>${money(ce.repair_cost_gbp)}</td></tr>
      <tr><td>Duty rate</td><td>${ce.duty_rate_pct}%</td></tr>
      <tr><td>Duty without OPR (full value + repair)</td><td>${money(ce.duty_without_relief_gbp)}</td></tr>
      <tr><td>OPR relief</td><td>${money(ce.opr_relief_gbp)}</td></tr>
      <tr><td><strong>Net duty payable (repair cost only)</strong></td><td><strong>${money(ce.duty_on_repair_cost_gbp)}</strong></td></tr>
    </table>
    <p>${ce.vat_note}.</p>
  </section>
  <section id="ce1154-lines">
    <h2>Returning devices</h2>
    <table>
      <thead><tr><th>#</th><th>IMEI</th><th>Description</th><th class="num">Export value</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>
  <section id="ce1154-statement" class="statement">
    <strong>Cross-referenced statement:</strong> ${ce.cross_reference_statement}
  </section>
</body>
</html>`
}

// ───────── Re-import clearance-instruction draft ─────────
// Copy-paste material for the broker/carrier. Nothing is sent (OPR 4).

export function buildClearanceInstructionDraft(
  importShipment: Shipment,
  exportShipment: Shipment | null,
  authorisation: OprAuthorisation,
  lines: ShipmentLine[],
  ce1154: Ce1154 | null,
) {
  const exportMrn = exportShipment?.export_mrn || null
  const exportedValue = sumLineValues(lines)
  const bodyLines = [
    'Hello,',
    '',
    'Please clear the following returning Outward Processing Relief consignment:',
    '',
    `  Consignment reference: ${importShipment.reference}`,
    `  Importer: ${authorisation.holder_name} (EORI ${authorisation.eori})`,
    `  OPR authorisation (CDS): ${authorisation.cds_number}`,
    `  Customs procedure code: ${importShipment.procedure_code} (re-import after outward processing)`,
    `  Original export MRN: ${exportMrn ?? 'MISSING — supply before lodging'}`,
    `  Units returning: ${lines.length}`,
    `  Value of exported goods (returning units): £${exportedValue.toFixed(2)} GBP`,
    ce1154
      ? `  Repair cost: ${ce1154.repair_cost.amount.toFixed(2)} ${ce1154.repair_cost.currency} (£${ce1154.repair_cost_gbp.toFixed(2)} GBP)`
      : '  Repair cost: NOT YET RECORDED on the shipment — supply before lodging',
    ce1154
      ? `  Net duty payable: £${ce1154.duty_on_repair_cost_gbp.toFixed(2)} (duty rate ${ce1154.duty_rate_pct}%, OPR relief £${ce1154.opr_relief_gbp.toFixed(2)})`
      : '',
    '',
    'IMPORTANT: duty and import VAT are to be assessed on the three-part',
    'cost breakdown only — (1) repair cost, (2) inbound freight,',
    '(3) outbound freight — NOT the full value of the goods, which are',
    'returning under Outward Processing Relief.',
    '',
    'Kind regards',
  ].filter(l => l !== '')
  return {
    subject: `OPR re-import clearance instruction — ${importShipment.reference} — ${lines.length} unit(s) — procedure ${importShipment.procedure_code}`,
    body: bodyLines.join('\n'),
    export_mrn: exportMrn,
    export_mrn_present: exportMrn != null,
    note: 'Draft only — no email is sent (automated sending is OPR 4)',
  }
}

// ───────── Import validation engine (mirrors the OPR 2 export engine) ─────────

export function runImportValidation(
  importShipment: Shipment,
  exportShipment: Shipment | null,
  authorisation: OprAuthorisation | null,
  lines: ShipmentLine[],
  today = new Date().toISOString().slice(0, 10),
): ValidationResult {
  const checks: ValidationCheck[] = []
  const add = (code: string, level: CheckLevel, message: string) => checks.push({ code, level, message })
  // TEMP_EXPORT_STANDARD is a non-customs consignment flow (migration
  // 0023): no procedure code, no authorisation, no C&E1154, no discharge
  // clock. Those checks are customs-specific and do not apply — reported
  // green/"not applicable" so a TEMP_EXPORT_STANDARD return isn't
  // red-blocked on fields it is forbidden from ever having set (enforced
  // at shipment creation in routes/opr.ts).
  const isStandardTemp = importShipment.shipment_type === 'TEMP_EXPORT_STANDARD'

  // ── IMP_HAS_LINES ──
  if (!lines.length) add('IMP_HAS_LINES', 'red', 'Import consignment has no device lines — nothing to receive')
  else add('IMP_HAS_LINES', 'green', `${lines.length} returning device line(s) on the consignment`)

  // ── IMP_PROCEDURE_6121 ──
  if (isStandardTemp) {
    add('IMP_PROCEDURE_6121', 'green', 'Not applicable — TEMP_EXPORT_STANDARD carries no customs procedure code')
  } else if (importShipment.procedure_code !== '6121') {
    add('IMP_PROCEDURE_6121', 'red', `procedure_code '${importShipment.procedure_code}' — re-import after outward processing must be 6121`)
  } else {
    add('IMP_PROCEDURE_6121', 'green', 'Procedure code 6121 (re-import after outward processing)')
  }

  // ── IMP_CURRENCY_GBP ──
  if (importShipment.currency !== 'GBP') {
    add('IMP_CURRENCY_GBP', 'red', `Shipment currency is '${importShipment.currency}' — OPR declarations must be GBP (never UKL)`)
  } else {
    add('IMP_CURRENCY_GBP', 'green', 'Shipment is declared in GBP')
  }

  // ── IMP_RELATED_EXPORT + IMP_EXPORT_MRN ──
  if (!exportShipment) {
    add('IMP_RELATED_EXPORT', 'red', 'Import shipment has no related export shipment — the return must discharge a specific export')
  } else if (exportShipment.status !== 'FINALISED') {
    add('IMP_RELATED_EXPORT', 'red', `Related export shipment ${exportShipment.reference} is ${exportShipment.status} — only a FINALISED export can be discharged`)
  } else {
    add('IMP_RELATED_EXPORT', 'green', `Discharges export ${exportShipment.reference}`)
    if (isStandardTemp) {
      add('IMP_EXPORT_MRN', 'green', 'Not applicable — TEMP_EXPORT_STANDARD has no export MRN to quote')
    } else if (!exportShipment.export_mrn) {
      add('IMP_EXPORT_MRN', 'red', 'Related export has no export MRN — the re-import declaration must quote it')
    } else {
      add('IMP_EXPORT_MRN', 'green', `Quotes original export MRN ${exportShipment.export_mrn}`)
    }
  }

  // ── IMP_REPAIR_COST (C&E1154 inputs) ──
  if (isStandardTemp) {
    add('IMP_REPAIR_COST', 'green', 'Not applicable — no customs arithmetic on a TEMP_EXPORT_STANDARD shipment')
  } else {
    const cost = Number(importShipment.repair_cost)
    const costCur = (importShipment.repair_cost_currency || 'GBP').toUpperCase()
    const costProblems: string[] = []
    if (importShipment.repair_cost == null) costProblems.push('repair_cost is missing (the repairer invoice amount)')
    else if (Number.isNaN(cost) || cost <= 0) costProblems.push(`repair_cost ${importShipment.repair_cost} must be positive`)
    else if (!isPenceExact(cost)) costProblems.push(`repair_cost ${cost} is not expressible in minor units (2dp)`)
    if (!isValidCurrency(costCur)) costProblems.push(`repair_cost_currency '${costCur}' is not a valid ISO 4217 code`)
    if (costCur !== 'GBP') {
      const rate = Number(importShipment.customs_exchange_rate)
      if (importShipment.customs_exchange_rate == null || Number.isNaN(rate) || rate <= 0) {
        costProblems.push(`customs_exchange_rate is required to convert the ${costCur} repair cost to GBP`)
      }
    }
    if (costProblems.length) add('IMP_REPAIR_COST', 'red', costProblems.join('; '))
    else add('IMP_REPAIR_COST', 'green', `Repair cost ${cost.toFixed(2)} ${costCur} with usable conversion inputs`)
  }

  // ── IMP_DUTY_RATE ──
  if (isStandardTemp) {
    add('IMP_DUTY_RATE', 'green', 'Not applicable — no customs duty on a TEMP_EXPORT_STANDARD shipment')
  } else {
    const dutyPct = Number(importShipment.duty_rate_pct)
    if (importShipment.duty_rate_pct == null || Number.isNaN(dutyPct) || dutyPct < 0 || dutyPct > 100) {
      add('IMP_DUTY_RATE', 'red', 'duty_rate_pct is required (0–100; 0 is valid for duty-free commodities)')
    } else {
      add('IMP_DUTY_RATE', 'green', `Duty rate ${dutyPct}%`)
    }
  }

  // ── IMP_OP_AUTH_NUMBER — the C&E1154 needs the OPR Authorisation Number ──
  if (isStandardTemp) {
    add('IMP_OP_AUTH_NUMBER', 'green', 'Not applicable — TEMP_EXPORT_STANDARD has no customs authorisation')
  } else if (!authorisation) {
    add('IMP_OP_AUTH_NUMBER', 'red', 'Import shipment has no resolvable OPR authorisation')
  } else if (!authorisation.op_authorisation_number) {
    add('IMP_OP_AUTH_NUMBER', 'red', 'Authorisation has no OPR Authorisation Number — the C&E1154 authorisation field requires it (the CDS Authorisation Number must NOT be substituted)')
  } else {
    add('IMP_OP_AUTH_NUMBER', 'green', `OPR Authorisation Number ${authorisation.op_authorisation_number} available for the C&E1154`)
  }

  // ── IMP_AUTH_VALID — authorisation valid on receipt date ──
  if (!isStandardTemp && authorisation) {
    const effective = importShipment.ship_date || today
    if (effective < authorisation.valid_from || effective > authorisation.valid_to) {
      add('IMP_AUTH_VALID', 'red', `Authorisation ${authorisation.cds_number} is valid ${authorisation.valid_from} → ${authorisation.valid_to}; ${importShipment.ship_date ? 'ship date' : 'today'} ${effective} is outside that window`)
    } else if (!importShipment.ship_date) {
      add('IMP_AUTH_VALID', 'amber', `No ship_date set — authorisation checked against today (${today})`)
    } else {
      add('IMP_AUTH_VALID', 'green', `Authorisation valid on ${importShipment.ship_date}`)
    }
  }

  // ── IMP_DISCHARGE_WINDOW — advisory: returning after the discharge
  // deadline is a compliance problem HMRC must be told about, but blocking
  // the receipt would strand the physical goods, so this stays amber.
  // Not applicable to TEMP_EXPORT_STANDARD — no authorisation means no
  // discharge_period_months to compute a deadline from. ──
  if (!isStandardTemp && exportShipment && authorisation) {
    const exportDate = exportShipment.ship_date
      || (exportShipment.finalised_at ? String(exportShipment.finalised_at).slice(0, 10) : null)
    if (exportDate) {
      const deadline = addMonths(exportDate, authorisation.discharge_period_months)
      const effective = importShipment.ship_date || today
      if (effective > deadline) {
        add('IMP_DISCHARGE_WINDOW', 'amber', `Return date ${effective} is AFTER the discharge deadline ${deadline} (export ${exportDate} + ${authorisation.discharge_period_months} months) — notify the supervising office`)
      } else {
        add('IMP_DISCHARGE_WINDOW', 'green', `Within the discharge window (deadline ${deadline})`)
      }
    }
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

// ───────── Discharge tracker maths ─────────

export type DischargeRow = {
  export_shipment_id: number
  reference: string
  export_mrn: string | null
  export_date: string | null
  discharge_deadline: string | null
  days_remaining: number | null
  exported: number
  returned: number
  outstanding: number
  status: 'discharged' | 'overdue' | 'closing' | 'open' | 'no_export_date'
  // ── Value reconciliation (goods VALUE, not just unit counts) ──
  // Present only when value inputs were supplied (existing counts-only
  // callers are unaffected — these fields are additive/optional).
  exported_value_gbp?: number
  returned_value_gbp?: number
  outstanding_value_gbp?: number
  value_balanced?: boolean   // true once outstanding_value_gbp <= 0 (mirrors 'discharged' on counts)
}

export function computeDischargeRow(
  exportShipment: Pick<Shipment, 'id' | 'reference' | 'export_mrn' | 'ship_date' | 'finalised_at'>,
  dischargePeriodMonths: number,
  exported: number,
  returned: number,
  today = new Date().toISOString().slice(0, 10),
  closingWindowDays = 30,
  // Optional value inputs, in GBP — pass both to get value fields on the
  // row. exportedValueGbp is the export batch's reconciled/declared goods
  // value; returnedValueGbp is the value of the lines that have actually
  // discharged it so far (both counts- and value-based checks must pass
  // before a batch is considered fully discharged).
  exportedValueGbp?: number,
  returnedValueGbp?: number,
): DischargeRow {
  const exportDate = exportShipment.ship_date
    || (exportShipment.finalised_at ? String(exportShipment.finalised_at).slice(0, 10) : null)
  const outstanding = exported - returned
  let deadline: string | null = null
  let daysRemaining: number | null = null
  let status: DischargeRow['status']
  if (!exportDate) {
    status = 'no_export_date'
  } else {
    deadline = addMonths(exportDate, dischargePeriodMonths)
    daysRemaining = Math.round((Date.parse(deadline + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000)
    if (outstanding <= 0) status = 'discharged'
    else if (daysRemaining < 0) status = 'overdue'
    else if (daysRemaining <= closingWindowDays) status = 'closing'
    else status = 'open'
  }
  const row: DischargeRow = {
    export_shipment_id: exportShipment.id,
    reference: exportShipment.reference,
    export_mrn: exportShipment.export_mrn ?? null,
    export_date: exportDate,
    discharge_deadline: deadline,
    days_remaining: daysRemaining,
    exported,
    returned,
    outstanding,
    status,
  }
  if (exportedValueGbp != null && returnedValueGbp != null) {
    const outstandingValue = round2(exportedValueGbp - returnedValueGbp)
    row.exported_value_gbp = round2(exportedValueGbp)
    row.returned_value_gbp = round2(returnedValueGbp)
    row.outstanding_value_gbp = outstandingValue
    row.value_balanced = outstandingValue <= 0
  }
  return row
}

// ───────── Value reconciliation — goods value vs unit counts, delta trail ─────────
//
// shipment_lines.unit_value is FROZEN at add-time and never edited — so
// the "value change" tracked here is never an edit to a line. It is the
// export batch's DECLARED reconciliation value (reconciled_value_gbp on
// the shipment row) being set/corrected by ops against some external
// total (e.g. a FedEx/manifest figure) — always pence-exact, always
// producing a permanent delta record (old, new, difference, timestamp,
// actor), never silently overwritten.
//
// INVARIANT: this module is pure goods-value arithmetic. It takes no
// repair_cost/customs_exchange_rate input and returns nothing that feeds
// computeCe1154() — the VAT/duty basis (repair cost) is untouched by
// design; see the isolation test in oprImport.spec.ts.

export type ValueDeltaResult =
  | { ok: true; old_value_gbp: number; new_value_gbp: number; difference_gbp: number }
  | { ok: false; error: string }

// Computes the delta record fields for a reconciliation correction.
// oldValueGbp is the shipment's current reconciled_value_gbp (or, if that
// is still NULL, the computed sum of its lines — the implicit starting
// point before any explicit reconciliation has ever been recorded).
export function computeValueDelta(oldValueGbp: number, newValueGbp: number): ValueDeltaResult {
  if (!isPenceExact(newValueGbp)) {
    return { ok: false, error: `Reconciled value ${newValueGbp} is not expressible in minor units (2dp)` }
  }
  if (newValueGbp < 0) {
    return { ok: false, error: 'Reconciled value cannot be negative' }
  }
  return {
    ok: true,
    old_value_gbp: round2(oldValueGbp),
    new_value_gbp: round2(newValueGbp),
    difference_gbp: round2(newValueGbp - oldValueGbp),
  }
}

// Multi-leg balance check: given an export batch's declared/reconciled
// value and the goods value of the return legs that have discharged it so
// far, is the batch balanced (fully accounted for) on VALUE as well as on
// unit count? Both must hold before the batch can be treated as
// discharged — a leg that balances on count but not value (or vice versa)
// is not actually reconciled.
export function isValueBalanced(exportedValueGbp: number, returnedLegsValueGbp: number[]): {
  balanced: boolean
  returned_value_gbp: number
  outstanding_value_gbp: number
} {
  const returnedTotal = round2(returnedLegsValueGbp.reduce((s, v) => round2(s + v), 0))
  const outstanding = round2(exportedValueGbp - returnedTotal)
  return { balanced: outstanding <= 0, returned_value_gbp: returnedTotal, outstanding_value_gbp: outstanding }
}
