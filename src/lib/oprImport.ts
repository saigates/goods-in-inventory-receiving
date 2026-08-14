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
//   - Partial-return guardrail: the declared exported-goods quantity must
//     equal the consignment quantity (the count of returning devices).
//   - HMRC customs exchange rates are quoted as foreign-currency units per
//     £1, so GBP = amount / rate.
//
// ───────── C&E1154 worksheet chain (2026-08-14 rewrite, Item C) ─────────
// SUPERSEDES the old "duty/VAT assessed on the repair cost only" model —
// that was wrong. The real FedEx OPR worksheet chain, reproduced exactly
// (both real returns, R1 £352.16/R2 £311.20 VAT, asserted to the penny in
// ce1154Golden.spec.ts / the R1+R2 fixture suite):
//
//   compensatory value = device value + process charge + inbound freight + insurance
//   duty base           = process charge + non-EU inbound freight share + insurance
//   VAT base             = process charge + inbound freight + export freight + duty + value adjustment
//   duty                 = duty base × tariff rate
//   VAT (PVA, postponed) = VAT base × 20%
//
// The asymmetry is deliberate and is the single most error-prone part of
// this chain: duty base uses ONLY the non-EU freight share; VAT base uses
// the FULL inbound freight plus the export freight. Device value enters
// the compensatory value but enters NEITHER tax base — that is the entire
// point of Outward Processing Relief (duty/VAT would otherwise be charged
// on the whole value of the goods, not just the processing).
//
// VAT is POSTPONED (PVA — Postponed VAT Accounting), never a cash charge:
// pva_amount_gbp is the figure that goes on the VAT return, and is labelled
// as such everywhere it is surfaced. Duty at 0% still requires an explicit,
// stored duty-override flag (OVR01|DUTY OVERRIDE CLAIMED appears on both
// real entries) — computeCe1154() refuses to report a zero duty unless
// that flag is set on the shipment; a zero is never silently implied.
//
// Anti-misdeclaration (checkMisdeclaration(), below): the device value used
// in the compensatory value AND shown for comparison against any
// broker-declared invoice total is ALWAYS sumLineValues(returningLines) —
// the actual sum of the IMEIs' frozen line values. It is never read from a
// typed-in field. A real example this rewrite guards against: FedEx
// declared £22,588.00 (R1) / £18,794.81 (R2) against true line sums of
// £20,155.00 / £19,231.00.

import type { Shipment, ShipmentLine, OprAuthorisation } from '../types'
import { sumLineValues } from './oprValidation'
import { isValidCurrency } from './validate'
import type { CheckLevel, ValidationCheck, ValidationResult } from './oprValidation'

// The value adjustment defaults to £1.31 (both real legs came through at
// this figure) — this is the DEFAULT an operator's input starts at
// (migration 0024's column default), never a hard-coded term in the
// formula below. Kept here only so computeCe1154() can flag when a
// shipment's stored value deviates from that default; the arithmetic
// always uses importShipment.value_adjustment_gbp, the stored input.
export const DEFAULT_VALUE_ADJUSTMENT_GBP = 1.31

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

// ───────── Anti-misdeclaration structural gate ─────────
//
// Compares broker-declared figures against app-computed/prior-leg figures.
// Device value: ALWAYS computed (sumLineValues) — the broker's declared
// invoice total is compared against it, never substituted for it.
// Piece count / gross weight have no independent "computed" figure (they
// describe packaging, not devices), so the structural check instead
// compares against sibling return legs discharging the SAME export MRN —
// this is what catches exactly the real failure mode (R2 carrying forward
// R1's "two boxes and 40kg" despite 18 fewer devices): identical declared
// packaging figures across legs whose quantities differ are flagged.

export type SiblingLegLite = {
  reference: string
  quantity: number
  declared_piece_count: number | null
  declared_gross_weight_kg: number | null
}

// The three independently-arising variance kinds. Value (declared invoice
// total vs. computed line-sum) and piece_count/gross_weight (carried-forward
// packaging figures vs. a sibling leg) are DIFFERENT broker errors — R2
// exhibits both simultaneously (an £18,794.81 vs £19,231.00 value variance
// AND a carried-forward "two boxes, 40kg" from R1 despite 18 fewer devices)
// — so each acknowledges separately (migration 0025: shipment_misdeclaration_acks,
// one row per acknowledgement, keyed by variance_type).
export type MisdeclarationVarianceType = 'value' | 'piece_count' | 'gross_weight'

// The latest acknowledgement row per variance_type, as loaded by the
// caller (route layer) from shipment_misdeclaration_acks. Only the latest
// row per type is relevant — checkMisdeclaration() decides whether it
// still matches the CURRENT figures (i.e. has not lapsed).
export type MisdeclarationAckLite = {
  variance_type: MisdeclarationVarianceType
  declared_gbp: number | null
  computed_gbp: number | null
  declared_count: number | null
  declared_weight_kg: number | null
  acknowledged_at: string
}

export type MisdeclarationCheckResult = {
  value: { declared_gbp: number | null; computed_gbp: number; variance_gbp: number | null; misdeclared: boolean; acknowledged: boolean; acknowledged_at: string | null }
  piece_count: { declared: number | null; suspect_carried_forward_from: string | null; misdeclared: boolean; acknowledged: boolean; acknowledged_at: string | null }
  gross_weight: { declared: number | null; suspect_carried_forward_from: string | null; misdeclared: boolean; acknowledged: boolean; acknowledged_at: string | null }
  any_misdeclared: boolean
  requires_acknowledgement: boolean
  // true only once EVERY currently-misdeclared component has a matching,
  // non-lapsed acknowledgement — this is what gates finalise (red iff false
  // and any_misdeclared).
  fully_acknowledged: boolean
}

export function checkMisdeclaration(input: {
  computed_device_value_gbp: number
  declared_invoice_total_gbp: number | null
  quantity: number
  declared_piece_count: number | null
  declared_gross_weight_kg: number | null
  sibling_legs?: SiblingLegLite[]
  // Latest ack per variance_type (caller loads via
  // GET .../misdeclaration-ack or the same query finalise uses).
  acks?: MisdeclarationAckLite[]
}): MisdeclarationCheckResult {
  const computedGbp = round2(input.computed_device_value_gbp)
  const variance = input.declared_invoice_total_gbp != null
    ? round2(input.declared_invoice_total_gbp - computedGbp)
    : null
  const valueMisdeclared = variance != null && Math.abs(variance) >= 0.005
  const siblings = input.sibling_legs ?? []
  const acks = input.acks ?? []
  const latestAck = (type: MisdeclarationVarianceType) => acks.find(a => a.variance_type === type) ?? null

  let pieceSuspect: string | null = null
  if (input.declared_piece_count != null) {
    const hit = siblings.find(s => s.declared_piece_count === input.declared_piece_count && s.quantity !== input.quantity)
    if (hit) pieceSuspect = hit.reference
  }
  let weightSuspect: string | null = null
  if (input.declared_gross_weight_kg != null) {
    const hit = siblings.find(s => s.declared_gross_weight_kg === input.declared_gross_weight_kg && s.quantity !== input.quantity)
    if (hit) weightSuspect = hit.reference
  }

  const pieceMisdeclared = pieceSuspect != null
  const weightMisdeclared = weightSuspect != null
  const anyMisdeclared = valueMisdeclared || pieceMisdeclared || weightMisdeclared

  // An ack is valid for the CURRENT state only if the figures it froze
  // still match — otherwise the line set (or the declared figures) moved
  // since the acknowledgement and it has LAPSED. A lapsed ack counts as
  // not-acknowledged; a fresh one is required (never silently re-validated).
  const valueAck = latestAck('value')
  const valueAcknowledged = valueMisdeclared && valueAck != null
    && valueAck.declared_gbp === input.declared_invoice_total_gbp && valueAck.computed_gbp === computedGbp
  const pieceAck = latestAck('piece_count')
  const pieceAcknowledged = pieceMisdeclared && pieceAck != null
    && pieceAck.declared_count === input.declared_piece_count
  const weightAck = latestAck('gross_weight')
  const weightAcknowledged = weightMisdeclared && weightAck != null
    && weightAck.declared_weight_kg === input.declared_gross_weight_kg

  const fullyAcknowledged =
    (!valueMisdeclared || valueAcknowledged) &&
    (!pieceMisdeclared || pieceAcknowledged) &&
    (!weightMisdeclared || weightAcknowledged)

  return {
    value: { declared_gbp: input.declared_invoice_total_gbp, computed_gbp: computedGbp, variance_gbp: variance, misdeclared: valueMisdeclared, acknowledged: valueAcknowledged, acknowledged_at: valueAcknowledged ? valueAck!.acknowledged_at : null },
    piece_count: { declared: input.declared_piece_count, suspect_carried_forward_from: pieceSuspect, misdeclared: pieceMisdeclared, acknowledged: pieceAcknowledged, acknowledged_at: pieceAcknowledged ? pieceAck!.acknowledged_at : null },
    gross_weight: { declared: input.declared_gross_weight_kg, suspect_carried_forward_from: weightSuspect, misdeclared: weightMisdeclared, acknowledged: weightAcknowledged, acknowledged_at: weightAcknowledged ? weightAck!.acknowledged_at : null },
    any_misdeclared: anyMisdeclared,
    requires_acknowledgement: anyMisdeclared,
    fully_acknowledged: fullyAcknowledged,
  }
}

// ───────── C&E1154 computation ─────────

export type Ce1154Result =
  | { ok: true; ce1154: Ce1154 }
  | { ok: false; error: string }

// 'computed' — the full FedEx OPR worksheet chain ran from first
// principles (all worksheet inputs present on the shipment).
// 'entry_pending' — worksheet inputs are not yet recorded; the bases/taxes
// below are the CDS entry's OWN declared figures (entry_duty_base_gbp
// etc.), honestly labelled pending on the input-breakdown side (e.g. R2,
// awaiting FedEx's "OP WS 875147276207").
export type Ce1154WorksheetSource = 'computed' | 'entry_pending'

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
  import_mrn: string | null
  procedure_code: string | null
  additional_procedure_code: string | null
  commodity_code: string | null
  quantity: number
  supplementary_units: number
  entry_accepted_at: string | null
  entry_cleared_at: string | null

  worksheet_source: Ce1154WorksheetSource
  worksheet_pending_note: string | null

  // Device value is ALWAYS computed (sumLineValues) — never typed in. It
  // enters the compensatory value but NEITHER tax base (see misdeclaration
  // below for the declared-vs-computed comparison).
  device_value_gbp: number
  process_charge: { amount: number; currency: string } | null
  customs_exchange_rate: number | null
  process_charge_gbp: number | null
  inbound_freight_gbp: number | null
  non_eu_freight_share_gbp: number | null
  export_freight_gbp: number | null
  insurance_gbp: number | null
  value_adjustment_gbp: number | null
  value_adjustment_is_default: boolean
  tariff_duty_rate_pct: number | null

  // compensatory value = device value + process charge + inbound freight + insurance
  compensatory_value_gbp: number | null
  // duty base = process charge + non-EU inbound freight share + insurance
  duty_base_gbp: number
  // VAT base = process charge + inbound freight + export freight + duty + value adjustment
  vat_base_gbp: number
  // duty = duty base × tariff rate
  duty_gbp: number
  // VAT (PVA) = VAT base × 20% — POSTPONED, never a cash charge.
  pva_amount_gbp: number
  vat_note: string

  duty_override_claimed: boolean

  misdeclaration: MisdeclarationCheckResult
}

export function computeCe1154(
  importShipment: Shipment,
  exportShipment: Shipment | null,
  authorisation: OprAuthorisation | null,
  returningLines: ShipmentLine[],
  declaredQuantity?: number,
  siblingLegs: SiblingLegLite[] = [],
  // Latest acknowledgement per variance_type (migration 0025). Optional and
  // additive — omitting it just means every existing call site keeps
  // reporting any_misdeclared/requires_acknowledgement exactly as before,
  // with fully_acknowledged always false while a variance exists (the
  // safe default: unacknowledged until proven otherwise).
  misdeclarationAcks: MisdeclarationAckLite[] = [],
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

  // Device value is ALWAYS computed from the frozen line values — never a
  // typed-in field (the anti-misdeclaration principle, Section g).
  const deviceValueGbp = sumLineValues(returningLines)
  const dutyOverrideClaimed = !!importShipment.duty_override_claimed

  // Full worksheet chain requires ALL of: process charge (repair_cost),
  // inbound freight, non-EU freight share, export freight, duty rate.
  // Insurance/value adjustment are optional (default 0 / DEFAULT_VALUE_ADJUSTMENT_GBP).
  const hasWorksheetInputs =
    importShipment.repair_cost != null &&
    importShipment.inbound_freight_gbp != null &&
    importShipment.non_eu_freight_share_gbp != null &&
    importShipment.export_freight_gbp != null &&
    importShipment.duty_rate_pct != null

  let processCharge: { amount: number; currency: string } | null = null
  let rate: number | null = null
  let processChargeGbp: number | null = null
  let insuranceGbp: number | null = null
  let valueAdjustmentGbp: number | null = null
  let dutyPct: number | null = null
  let compensatoryValueGbp: number | null = null
  let dutyBaseGbp: number
  let vatBaseGbp: number
  let dutyGbp: number
  let pvaAmountGbp: number
  let worksheetSource: Ce1154WorksheetSource
  let worksheetPendingNote: string | null

  if (hasWorksheetInputs) {
    // Process (repair) charge → GBP at the HMRC customs rate.
    const cost = Number(importShipment.repair_cost)
    if (Number.isNaN(cost) || cost <= 0) {
      return { ok: false, error: 'repair_cost (process charge) must be positive' }
    }
    if (!isPenceExact(cost)) {
      return { ok: false, error: `repair_cost ${cost} is not expressible in minor units (2dp)` }
    }
    const costCurrency = (importShipment.repair_cost_currency || 'GBP').toUpperCase()
    if (costCurrency === 'GBP') {
      processChargeGbp = cost
    } else {
      rate = Number(importShipment.customs_exchange_rate)
      if (importShipment.customs_exchange_rate == null || Number.isNaN(rate) || rate <= 0) {
        return { ok: false, error: `repair_cost (process charge) is in ${costCurrency} — customs_exchange_rate (HMRC monthly rate, ${costCurrency} per GBP 1) is required to convert it` }
      }
      processChargeGbp = round2(cost / rate)
    }
    processCharge = { amount: cost, currency: costCurrency }

    dutyPct = Number(importShipment.duty_rate_pct)
    if (Number.isNaN(dutyPct) || dutyPct < 0 || dutyPct > 100) {
      return { ok: false, error: 'duty_rate_pct (tariff duty rate) must be between 0 and 100' }
    }

    insuranceGbp = importShipment.insurance_gbp ?? 0
    valueAdjustmentGbp = importShipment.value_adjustment_gbp ?? DEFAULT_VALUE_ADJUSTMENT_GBP
    const inboundFreight = importShipment.inbound_freight_gbp as number
    const nonEuShare = importShipment.non_eu_freight_share_gbp as number
    const exportFreight = importShipment.export_freight_gbp as number

    // compensatory value = device value + process charge + inbound freight + insurance
    compensatoryValueGbp = round2(deviceValueGbp + processChargeGbp + inboundFreight + insuranceGbp)
    // duty base = process charge + non-EU inbound freight share + insurance
    // (ASYMMETRY: non-EU share ONLY, not the full inbound freight)
    dutyBaseGbp = round2(processChargeGbp + nonEuShare + insuranceGbp)
    // duty = duty base × tariff rate
    dutyGbp = round2(dutyBaseGbp * dutyPct / 100)
    // VAT base = process charge + inbound freight + export freight + duty + value adjustment
    // (ASYMMETRY: FULL inbound freight + export freight, unlike duty base)
    vatBaseGbp = round2(processChargeGbp + inboundFreight + exportFreight + dutyGbp + valueAdjustmentGbp)
    // VAT (PVA, postponed) = VAT base × 20%
    pvaAmountGbp = round2(vatBaseGbp * 0.20)
    worksheetSource = 'computed'
    worksheetPendingNote = null
  } else {
    // Worksheet inputs not yet recorded — fall back to the CDS entry's OWN
    // declared bases/taxes (e.g. R2: entry known, "OP WS 875147276207"
    // requested from FedEx and not yet supplied). Honestly labelled
    // pending on the input-breakdown side; NOT a placeholder invented by
    // this function.
    if (
      importShipment.entry_duty_base_gbp == null || importShipment.entry_vat_base_gbp == null ||
      importShipment.entry_duty_gbp == null || importShipment.entry_vat_gbp == null
    ) {
      return { ok: false, error: 'Neither the FedEx OPR worksheet inputs nor the CDS entry-declared bases/taxes (entry_duty_base_gbp/entry_vat_base_gbp/entry_duty_gbp/entry_vat_gbp) are recorded — nothing to compute the C&E1154 from' }
    }
    dutyBaseGbp = round2(importShipment.entry_duty_base_gbp)
    vatBaseGbp = round2(importShipment.entry_vat_base_gbp)
    dutyGbp = round2(importShipment.entry_duty_gbp)
    pvaAmountGbp = round2(importShipment.entry_vat_gbp)
    worksheetSource = 'entry_pending'
    worksheetPendingNote = 'FedEx OPR worksheet inputs are not yet recorded on this shipment — the bases and taxes above are taken directly from the CDS entry; the input breakdown (process charge, freight, insurance, value adjustment) is pending.'
  }

  // Duty at 0% still requires the duty-override flag to be an explicit,
  // stored fact (OVR01|DUTY OVERRIDE CLAIMED appears on both real entries)
  // — a zero duty is never silently implied.
  if (dutyGbp === 0 && !dutyOverrideClaimed) {
    return { ok: false, error: 'Duty computes to £0.00 but duty_override_claimed is not set on the shipment — record the duty-override flag (OVR01|DUTY OVERRIDE CLAIMED) before a zero duty can be reported' }
  }

  const supplementaryUnits = importShipment.supplementary_units ?? quantity

  const misdeclaration = checkMisdeclaration({
    computed_device_value_gbp: deviceValueGbp,
    declared_invoice_total_gbp: importShipment.declared_invoice_total_gbp,
    quantity,
    declared_piece_count: importShipment.declared_piece_count,
    declared_gross_weight_kg: importShipment.declared_gross_weight_kg,
    acks: misdeclarationAcks,
    sibling_legs: siblingLegs,
  })

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
      import_mrn: importShipment.import_mrn,
      procedure_code: importShipment.procedure_code,
      additional_procedure_code: importShipment.additional_procedure_code,
      commodity_code: importShipment.commodity_code,
      quantity,
      supplementary_units: supplementaryUnits,
      entry_accepted_at: importShipment.entry_accepted_at,
      entry_cleared_at: importShipment.entry_cleared_at,
      worksheet_source: worksheetSource,
      worksheet_pending_note: worksheetPendingNote,
      device_value_gbp: deviceValueGbp,
      process_charge: processCharge,
      customs_exchange_rate: rate,
      process_charge_gbp: processChargeGbp,
      inbound_freight_gbp: importShipment.inbound_freight_gbp,
      non_eu_freight_share_gbp: importShipment.non_eu_freight_share_gbp,
      export_freight_gbp: importShipment.export_freight_gbp,
      insurance_gbp: insuranceGbp,
      value_adjustment_gbp: valueAdjustmentGbp,
      value_adjustment_is_default: valueAdjustmentGbp === DEFAULT_VALUE_ADJUSTMENT_GBP,
      tariff_duty_rate_pct: dutyPct,
      compensatory_value_gbp: compensatoryValueGbp,
      duty_base_gbp: dutyBaseGbp,
      vat_base_gbp: vatBaseGbp,
      duty_gbp: dutyGbp,
      pva_amount_gbp: pvaAmountGbp,
      vat_note: 'VAT is POSTPONED (PVA — Postponed VAT Accounting) — it goes on the VAT return, not a cash charge at the border',
      duty_override_claimed: dutyOverrideClaimed,
      misdeclaration,
    },
  }
}

// Print-ready A4 rendering of the computed C&E1154 figures.
export function buildCe1154Html(ce: Ce1154, importShipment: Shipment, lines: ShipmentLine[]): string {
  const money = (v: number | null) => v == null ? '—' : `£${v.toFixed(2)}`
  const rows = lines.map((l, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${l.imei}</td>
          <td>${[l.brand, l.model, l.capacity, l.color].filter(Boolean).join(' ')}</td>
          <td class="num">${money(Number(l.unit_value))}</td>
        </tr>`).join('')
  const misdeclarationRows = [
    ce.misdeclaration.value.declared_gbp != null && ce.misdeclaration.value.misdeclared
      ? `<tr><td>Broker-declared invoice total vs. app-computed device value</td><td>${money(ce.misdeclaration.value.declared_gbp)} vs. ${money(ce.misdeclaration.value.computed_gbp)} (variance ${money(ce.misdeclaration.value.variance_gbp)}) — REQUIRES ACKNOWLEDGEMENT</td></tr>`
      : '',
    ce.misdeclaration.piece_count.misdeclared
      ? `<tr><td>Piece count</td><td>${ce.misdeclaration.piece_count.declared} — matches prior leg ${ce.misdeclaration.piece_count.suspect_carried_forward_from} despite a different quantity — REQUIRES ACKNOWLEDGEMENT</td></tr>`
      : '',
    ce.misdeclaration.gross_weight.misdeclared
      ? `<tr><td>Gross weight</td><td>${ce.misdeclaration.gross_weight.declared}kg — matches prior leg ${ce.misdeclaration.gross_weight.suspect_carried_forward_from} despite a different quantity — REQUIRES ACKNOWLEDGEMENT</td></tr>`
      : '',
  ].filter(Boolean).join('')
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
  .warn { background: #fff3cd; }
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
      ${ce.import_mrn ? `<tr><td>Import MRN</td><td>${ce.import_mrn}</td></tr>` : ''}
    </table>
  </section>
  <section id="ce1154-calculation">
    <h2>Duty &amp; VAT calculation — FedEx OPR worksheet chain${ce.worksheet_source === 'entry_pending' ? ' (worksheet PENDING — CDS entry figures shown)' : ''}</h2>
    <table class="kv">
      <tr><td>Quantity of exported goods (this consignment)</td><td>${ce.quantity}</td></tr>
      <tr><td>Device value (computed — sum of returning line values)</td><td>${money(ce.device_value_gbp)}</td></tr>
      ${ce.process_charge ? `<tr><td>Process (repair) charge (as invoiced)</td><td>${ce.process_charge.amount.toFixed(2)} ${ce.process_charge.currency}</td></tr>` : ''}
      ${ce.customs_exchange_rate != null ? `<tr><td>Customs exchange rate (${ce.process_charge?.currency} per £1)</td><td>${ce.customs_exchange_rate}</td></tr>` : ''}
      ${ce.process_charge_gbp != null ? `<tr><td>Process charge in GBP</td><td>${money(ce.process_charge_gbp)}</td></tr>` : ''}
      ${ce.inbound_freight_gbp != null ? `<tr><td>Inbound freight</td><td>${money(ce.inbound_freight_gbp)}</td></tr>` : ''}
      ${ce.non_eu_freight_share_gbp != null ? `<tr><td>Non-EU inbound freight share</td><td>${money(ce.non_eu_freight_share_gbp)}</td></tr>` : ''}
      ${ce.export_freight_gbp != null ? `<tr><td>Export freight</td><td>${money(ce.export_freight_gbp)}</td></tr>` : ''}
      ${ce.insurance_gbp != null ? `<tr><td>Insurance</td><td>${money(ce.insurance_gbp)}</td></tr>` : ''}
      ${ce.value_adjustment_gbp != null ? `<tr><td>Value adjustment${ce.value_adjustment_is_default ? '' : ' (differs from the £1.31 default)'}</td><td>${money(ce.value_adjustment_gbp)}</td></tr>` : ''}
      ${ce.compensatory_value_gbp != null ? `<tr><td>Compensatory value</td><td>${money(ce.compensatory_value_gbp)}</td></tr>` : ''}
      <tr><td><strong>Duty base</strong></td><td><strong>${money(ce.duty_base_gbp)}</strong></td></tr>
      ${ce.tariff_duty_rate_pct != null ? `<tr><td>Tariff duty rate</td><td>${ce.tariff_duty_rate_pct}%</td></tr>` : ''}
      <tr><td><strong>Duty</strong></td><td><strong>${money(ce.duty_gbp)}</strong></td></tr>
      <tr><td><strong>VAT base</strong></td><td><strong>${money(ce.vat_base_gbp)}</strong></td></tr>
      <tr><td><strong>VAT (postponed — PVA)</strong></td><td><strong>${money(ce.pva_amount_gbp)}</strong></td></tr>
      <tr><td>Duty override claimed (OVR01)</td><td>${ce.duty_override_claimed ? 'YES' : 'NO'}</td></tr>
    </table>
    <p>${ce.vat_note}.</p>
    ${ce.worksheet_pending_note ? `<p><em>${ce.worksheet_pending_note}</em></p>` : ''}
  </section>
  ${misdeclarationRows ? `<section id="ce1154-misdeclaration" class="statement warn">
    <h2>Declared vs. computed — acknowledgement required</h2>
    <table class="kv">${misdeclarationRows}</table>
  </section>` : ''}
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
  const deviceValue = sumLineValues(lines)
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
    `  Device value (computed, returning units): £${deviceValue.toFixed(2)} GBP`,
    ce1154 && ce1154.process_charge
      ? `  Process (repair) charge: ${ce1154.process_charge.amount.toFixed(2)} ${ce1154.process_charge.currency} (£${ce1154.process_charge_gbp?.toFixed(2)} GBP)`
      : '',
    ce1154
      ? `  Duty base £${ce1154.duty_base_gbp.toFixed(2)}, duty £${ce1154.duty_gbp.toFixed(2)}; VAT base £${ce1154.vat_base_gbp.toFixed(2)}, VAT £${ce1154.pva_amount_gbp.toFixed(2)} (POSTPONED — PVA, not payable at the border)`
      : '  C&E1154 figures: NOT YET AVAILABLE — supply worksheet inputs before lodging',
    ce1154 && ce1154.worksheet_pending_note ? `  NOTE: ${ce1154.worksheet_pending_note}` : '',
    '',
    'IMPORTANT: duty and VAT are assessed on the FULL FedEx OPR worksheet',
    'chain — process charge, freight (inbound/export), insurance and the',
    'value adjustment — NOT on the device value, which enters the',
    'compensatory value only. Note the asymmetry: the duty base uses only',
    'the non-EU inbound freight share, while the VAT base uses the FULL',
    'inbound freight plus the export freight.',
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
  siblingLegs: SiblingLegLite[] = [],
  misdeclarationAcks: MisdeclarationAckLite[] = [],
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

  // ── IMP_DUTY_OVERRIDE + IMP_MISDECLARATION_CHECK — both derived from the
  // SAME computeCe1154() run that produces the actual C&E1154, rather than
  // re-implementing its refusal/misdeclaration logic a second time here.
  // Not applicable to TEMP_EXPORT_STANDARD (no customs arithmetic at all);
  // deferred (amber, not red) when the consignment has no lines yet or
  // computeCe1154() cannot yet run for an unrelated reason already covered
  // by an earlier check above (e.g. missing repair cost/duty rate) — that
  // earlier check is what should red-block in that case, not this one
  // reporting the same gap twice under a different code.
  if (isStandardTemp) {
    add('IMP_DUTY_OVERRIDE', 'green', 'Not applicable — no customs duty on a TEMP_EXPORT_STANDARD shipment')
    add('IMP_MISDECLARATION_CHECK', 'green', 'Not applicable — no customs value comparison on a TEMP_EXPORT_STANDARD shipment')
  } else if (!lines.length) {
    add('IMP_DUTY_OVERRIDE', 'amber', 'Cannot check yet — consignment has no device lines')
    add('IMP_MISDECLARATION_CHECK', 'amber', 'Cannot check yet — consignment has no device lines')
  } else {
    const ce = computeCe1154(importShipment, exportShipment, authorisation, lines, undefined, siblingLegs, misdeclarationAcks)
    if (!ce.ok) {
      if (/duty_override_claimed/.test(ce.error)) {
        // The one refusal reason this check exists to catch: duty computes
        // to £0.00 but OVR01|DUTY OVERRIDE CLAIMED is not recorded.
        add('IMP_DUTY_OVERRIDE', 'red', ce.error)
      } else {
        add('IMP_DUTY_OVERRIDE', 'amber', `Cannot check yet — ${ce.error}`)
      }
      add('IMP_MISDECLARATION_CHECK', 'amber', `Cannot check yet — ${ce.error}`)
    } else {
      add('IMP_DUTY_OVERRIDE', 'green', ce.ce1154.duty_gbp === 0
        ? 'Duty computes to £0.00 and duty_override_claimed (OVR01|DUTY OVERRIDE CLAIMED) is recorded'
        : `Duty £${ce.ce1154.duty_gbp.toFixed(2)} is non-zero — no override required`)

      // Red iff a variance exists AND is not (fully, freshly) acknowledged —
      // fully_acknowledged already accounts for lapsing (a stale ack whose
      // frozen figures no longer match the current computed value/declared
      // packaging counts as not-acknowledged). Value, piece-count and
      // gross-weight variances are reported individually so a partial
      // acknowledgement (e.g. value ack'd, packaging not) is visible.
      const m = ce.ce1154.misdeclaration
      if (m.any_misdeclared && !m.fully_acknowledged) {
        const parts: string[] = []
        if (m.value.misdeclared && !m.value.acknowledged) parts.push(`declared invoice total £${m.value.declared_gbp} vs. computed device value £${m.value.computed_gbp} (variance £${m.value.variance_gbp}) — not acknowledged`)
        if (m.piece_count.misdeclared && !m.piece_count.acknowledged) parts.push(`piece count ${m.piece_count.declared} matches leg ${m.piece_count.suspect_carried_forward_from} despite a different quantity — not acknowledged`)
        if (m.gross_weight.misdeclared && !m.gross_weight.acknowledged) parts.push(`gross weight ${m.gross_weight.declared}kg matches leg ${m.gross_weight.suspect_carried_forward_from} despite a different quantity — not acknowledged`)
        add('IMP_MISDECLARATION_CHECK', 'red', `Declared-vs-computed variance requires acknowledgement before receipt: ${parts.join('; ')}`)
      } else if (m.any_misdeclared) {
        const acked: string[] = []
        if (m.value.misdeclared) acked.push(`value variance acknowledged at ${m.value.acknowledged_at}`)
        if (m.piece_count.misdeclared) acked.push(`piece-count variance acknowledged at ${m.piece_count.acknowledged_at}`)
        if (m.gross_weight.misdeclared) acked.push(`gross-weight variance acknowledged at ${m.gross_weight.acknowledged_at}`)
        add('IMP_MISDECLARATION_CHECK', 'amber', `Declared-vs-computed variance was acknowledged: ${acked.join('; ')}`)
      } else {
        add('IMP_MISDECLARATION_CHECK', 'green', 'Declared figures (where present) match the computed device value; no carried-forward piece count/gross weight detected against sibling legs')
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
