// Golden-file regression test — C&E1154 output for a fixed authorisation /
// shipment / line fixture.
//
// Provenance of the fixture (test/__fixtures__/ce1154-golden.{json,html}):
// REGENERATED 2026-08-14 (Item C) using the REAL R1 FedEx OPR worksheet
// inputs — process charge, freight figures, MRNs and authorisation are all
// taken from the real R1 shipment (AWB 874874338764, import MRN
// 26GB8ILNEI7EFJPAR1, export MRN 26GB7LKWO3QHFLCAA0), NOT invented values,
// and NOT captured from whatever computeCe1154() happened to emit for an
// arbitrary/synthetic fixture. A golden file whose expected values were
// produced by the code under test only proves the code is self-consistent
// — R1 is usable as real ground truth because every input AND every
// output is independently known from FedEx/CDS, not derived from this
// codebase.
//
// Before freezing this fixture the four Item C table figures were checked
// BY HAND against the real R1 worksheet (also asserted at full 90-unit
// scale, from the same real inputs, in the dedicated "OPR 3 — R1/R2
// real-shipment C&E1154 fixtures" describe block in oprImport.spec.ts —
// and asserted here too, in the last test below, executably rather than
// only in this comment):
//   duty base £1,599.82 · VAT base £1,760.80 · duty £0.00 · VAT (PVA) £352.16
// By hand, from the real R1 figures (process charge £1,556.09, inbound
// freight £101.70, non-EU freight share £43.73, export freight £101.70,
// insurance £0, duty rate 0%, value adjustment at the £1.31 default):
//   duty base = 1556.09 (process charge) + 43.73 (non-EU freight share) + 0 (insurance) = 1599.82 ✓
//   duty      = 1599.82 × 0% = 0.00 ✓
//   VAT base  = 1556.09 + 101.70 (inbound freight) + 101.70 (export freight) + 0 (duty) + 1.31 (value adjustment) = 1760.80 ✓
//   VAT (PVA) = 1760.80 × 20% = 352.16 ✓
// All four match the real worksheet table exactly. That is the
// independent-of-the-code-under-test proof; only once it held was the
// actual computeCe1154()/buildCe1154Html() output for these same real
// inputs frozen into the two fixture files below.
//
// Pick-and-note (does not affect the four figures above, which depend on
// neither device count nor device value): this file uses 2 illustrative
// device lines (£150 each) and supplementary_units: 2, rather than R1's
// real 90 units/IMEIs, kept deliberately small so the frozen JSON/HTML
// text stays reviewable. The full 90-unit R1 shipment (real device count,
// same worksheet inputs) is exercised precisely in oprImport.spec.ts's
// dedicated R1 fixture test; this file exists to catch shape/rendering
// regressions in computeCe1154()/buildCe1154Html(), not to duplicate that
// penny-exact check at full scale.
//
// Prior provenance (superseded by the above): the previous fixture, frozen
// after the op_authorisation_number rename (commits 10f9544 / 39f373f),
// used the OLD "duty/VAT assessed on the repair cost only" model, which
// Item C established was wrong (duty and VAT are actually assessed on the
// full FedEx OPR worksheet chain — see src/lib/oprImport.ts's file-header
// comment). That fixture's shape no longer exists on this branch and could
// not be carried forward incrementally; this is a full, deliberate
// regeneration under the new model, noted as such in the commit message.
//
// If you intentionally change the C&E1154's shape again, regenerate this
// fixture deliberately and say so in the commit message — do not silently
// update it to make this test pass. And when you do: derive the expected
// VALUES from an independent source of truth first (as above), not from
// the function's own output for arbitrary/synthetic inputs.
import { describe, it, expect } from 'vitest'
// Tests run inside workerd (no `fs`/`node:fs`) — fixtures are bundled as
// raw text via Vite's `?raw` import suffix, not read at runtime.
// eslint-disable-next-line import/no-unresolved
import fixtureJsonRaw from './__fixtures__/ce1154-golden.json.txt?raw'
// eslint-disable-next-line import/no-unresolved
import fixtureHtmlRaw from './__fixtures__/ce1154-golden.html.txt?raw'
import { computeCe1154, buildCe1154Html } from '../src/lib/oprImport'
import type { Shipment, ShipmentLine, OprAuthorisation } from '../src/types'

const fixtureJson: string = fixtureJsonRaw
const fixtureHtml: string = fixtureHtmlRaw

// Real R1 authorisation (same record used by the OPR-3 R1/R2 fixtures in
// oprImport.spec.ts) — supervising office corrected to Liverpool GBLIV002
// per Item C part (j) (dropping the earlier Newcastle reference).
const authorisation: OprAuthorisation = {
  id: 1,
  organisation_id: 1,
  holder_name: 'Saigates Limited',
  eori: 'GB369979995000',
  cds_number: 'GBOPO36997999500020260226105539',
  op_authorisation_number: 'OP/0922/601/31',
  valid_from: '2026-03-01',
  valid_to: '2031-02-28',
  supervising_office_name: 'HMRC S1756 IP-OP Customs Liverpool',
  supervising_office_code: 'GBLIV002',
  commodity_scope: 'Smartphones',
  commodity_codes: '8517130000',
  rate_of_yield: '1:1',
  discharge_period_months: 6,
  notes: null,
  prealert_email: null,
  prealert_cutoff: null,
  created_at: '2026-03-01T00:00:00.000Z',
  updated_at: null,
}

// Real R1's related export (export MRN 26GB7LKWO3QHFLCAA0 — the same MRN
// the discharge worked example in Item C part (h) sums R1+R2's
// supplementary units against).
const exportShipment: Shipment = {
  id: 1,
  organisation_id: 1,
  reference: 'EXP R1-DISCHARGE 26GB7LKWO3QHFLCAA0',
  direction: 'export',
  shipment_type: 'OPR_REPAIR',
  status: 'FINALISED',
  authorisation_id: 1,
  procedure_code: '2100',
  additional_procedure_code: null,
  consignee_name: null,
  consignee_address: null,
  carrier: 'FedEx',
  carrier_account: null,
  incoterm: null,
  currency: 'GBP',
  ship_date: '2026-07-01',
  related_export_shipment_id: null,
  export_mrn: '26GB7LKWO3QHFLCAA0',
  ducr: null,
  ead_mrn: null,
  mucr: null,
  finalised_at: '2026-07-01T00:00:00.000Z',
  finalised_by_user_id: null,
  repair_cost: null,
  repair_cost_currency: null,
  customs_exchange_rate: null,
  duty_rate_pct: null,
  import_mrn: null,
  reconciled_value_gbp: null,
  customs_entry_ref: null,
  vat_evidence_ref: null,
  repair_cost_confirmed_at: null,
  repair_cost_confirmed_by_user_id: null,
  inbound_freight_gbp: null,
  non_eu_freight_share_gbp: null,
  export_freight_gbp: null,
  insurance_gbp: null,
  value_adjustment_gbp: null,
  commodity_code: null,
  duty_override_claimed: 0,
  entry_accepted_at: null,
  entry_cleared_at: null,
  supplementary_units: null,
  entry_duty_base_gbp: null,
  entry_vat_base_gbp: null,
  entry_duty_gbp: null,
  entry_vat_gbp: null,
  declared_invoice_total_gbp: null,
  declared_piece_count: null,
  declared_gross_weight_kg: null,
  misdeclaration_ack_at: null,
  misdeclaration_ack_by_user_id: null,
  notes: null,
  created_by_user_id: null,
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: null,
}

// Real R1 return leg (AWB 874874338764, import MRN 26GB8ILNEI7EFJPAR1).
// Worksheet inputs are the REAL figures from the R1 FedEx OPR worksheet —
// see the file header for the by-hand check against the Item C table.
const importShipment: Shipment = {
  ...exportShipment,
  id: 2,
  reference: 'IMP RTN R1 (AWB 874874338764)',
  direction: 'import',
  procedure_code: '6121',
  related_export_shipment_id: 1,
  export_mrn: null,
  finalised_at: null,
  ship_date: '2026-09-01',
  import_mrn: '26GB8ILNEI7EFJPAR1',
  repair_cost: 1556.09,
  repair_cost_currency: 'GBP',
  customs_exchange_rate: null,
  duty_rate_pct: 0,
  inbound_freight_gbp: 101.70,
  non_eu_freight_share_gbp: 43.73,
  export_freight_gbp: 101.70,
  insurance_gbp: 0,
  value_adjustment_gbp: null, // left at the operator-entered DEFAULT (£1.31) — both real R1/R2 legs came through at this figure
  commodity_code: '8517130000',
  duty_override_claimed: 1, // OVR01|DUTY OVERRIDE CLAIMED — stored fact, present on both real entries
  supplementary_units: 2, // pick-and-note: real R1 is 90 (see oprImport.spec.ts's full-scale R1 test); kept small here for a reviewable frozen fixture
}

const lines: ShipmentLine[] = [
  {
    id: 1, organisation_id: 1, shipment_id: 2, received_device_id: 1,
    imei: '860455190001200', sku: 'SKU-1', brand: 'Samsung', model: 'Galaxy S23',
    capacity: '128GB', color: 'Black', grade: 'A', unit_value: 150, currency: 'GBP',
    added_by_user_id: null, created_at: '2026-09-01T00:00:00.000Z',
  },
  {
    id: 2, organisation_id: 1, shipment_id: 2, received_device_id: 2,
    imei: '860455190001217', sku: 'SKU-2', brand: 'Samsung', model: 'Galaxy S23',
    capacity: '128GB', color: 'Black', grade: 'B', unit_value: 150, currency: 'GBP',
    added_by_user_id: null, created_at: '2026-09-01T00:00:00.000Z',
  },
]

describe('C&E1154 golden file — output frozen against the real R1 FedEx OPR worksheet (Item C)', () => {
  it('computeCe1154() JSON matches the frozen fixture byte-for-byte', () => {
    const result = computeCe1154(importShipment, exportShipment, authorisation, lines, 2)
    if (!result.ok) throw new Error(`fixture computation failed: ${result.error}`)
    expect(JSON.stringify(result.ce1154, null, 2)).toBe(fixtureJson.replace(/\n$/, ''))
  })

  it('buildCe1154Html() output matches the frozen fixture byte-for-byte', () => {
    const result = computeCe1154(importShipment, exportShipment, authorisation, lines, 2)
    if (!result.ok) throw new Error(`fixture computation failed: ${result.error}`)
    const html = buildCe1154Html(result.ce1154, importShipment, lines)
    expect(html).toBe(fixtureHtml.replace(/\n$/, ''))
  })

  it('authorisation field is driven by op_authorisation_number, never the CDS number', () => {
    const result = computeCe1154(importShipment, exportShipment, authorisation, lines, 2)
    if (!result.ok) throw new Error(`fixture computation failed: ${result.error}`)
    expect(result.ce1154.opr_authorisation_number).toBe('OP/0922/601/31')
    expect(result.ce1154.opr_authorisation_number).not.toBe(authorisation.cds_number)
  })

  it('the four Item C table figures match the real R1 worksheet, independently of the frozen fixture', () => {
    // The executable form of the by-hand check in the file header: this
    // asserts against the Item C table's real values directly, not
    // against fixtureJson, so a future edit that breaks the formula but
    // happens to still match a stale frozen fixture cannot slip through.
    const result = computeCe1154(importShipment, exportShipment, authorisation, lines, 2)
    if (!result.ok) throw new Error(`fixture computation failed: ${result.error}`)
    expect(result.ce1154.duty_base_gbp).toBe(1599.82)
    expect(result.ce1154.vat_base_gbp).toBe(1760.80)
    expect(result.ce1154.duty_gbp).toBe(0)
    expect(result.ce1154.pva_amount_gbp).toBe(352.16)
  })
})
