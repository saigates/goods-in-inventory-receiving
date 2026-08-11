// Golden-file regression test — C&E1154 output for a fixed authorisation /
// shipment / line fixture.
//
// Provenance of the fixture (test/__fixtures__/ce1154-golden.{json,html}):
// captured by running the SAME fixed inputs below through computeCe1154() +
// buildCe1154Html() on two checkouts —
//   - commit 10f9544 (pre-rename, authorisation.chief_number)
//   - commit 39f373f (post-rename, authorisation.op_authorisation_number)
// — and diffing the two outputs. Result: byte-for-byte identical (same
// SHA256, same 3937-byte length) for both the JSON Ce1154 object and the
// rendered HTML. That comparison is the actual proof the rename did not
// change what lands on the form; it is NOT re-derivable from this test
// alone (the pre-rename code no longer exists on this branch). The fixture
// below freezes the (already-verified) current output so any FUTURE change
// to computeCe1154()/buildCe1154Html() that alters the C&E1154 is caught.
//
// If you intentionally change the C&E1154's shape, regenerate the fixture
// deliberately and say so in the commit message — do not silently update it
// to make this test pass.
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

// Exactly the fixed fixture used to capture the before/after comparison.
const authorisation: OprAuthorisation = {
  id: 1,
  organisation_id: 1,
  holder_name: 'Saigates Limited',
  eori: 'GB123456789000',
  cds_number: 'GBOPO36997999500020260226105539',
  op_authorisation_number: 'OP/0922/601/31',
  valid_from: '2026-03-01',
  valid_to: '2031-02-28',
  // Deliberately populated (was null) — the golden fixture recapture that
  // added the "Issued by" field (C&E1154 output change, name-only) chose a
  // realistic value here so the frozen golden actually exercises the new
  // row instead of freezing an empty render. supervising_office_code stays
  // null: the code is reference-only and must never appear on this form.
  supervising_office_name: 'IP-OP Customs Liverpool',
  supervising_office_code: null,
  commodity_scope: null,
  commodity_codes: null,
  rate_of_yield: '1:1',
  discharge_period_months: 6,
  notes: null,
  prealert_email: null,
  prealert_cutoff: null,
  created_at: '2026-03-01T00:00:00.000Z',
  updated_at: null,
}

const exportShipment: Shipment = {
  id: 100,
  organisation_id: 1,
  reference: 'EXP-GOLDEN-0001',
  direction: 'export',
  shipment_type: 'OPR_REPAIR',
  status: 'FINALISED',
  authorisation_id: 1,
  procedure_code: '2100',
  additional_procedure_code: null,
  consignee_name: null,
  consignee_address: null,
  carrier: null,
  carrier_account: null,
  incoterm: null,
  currency: 'GBP',
  ship_date: '2026-04-01',
  related_export_shipment_id: null,
  export_mrn: '26GB1111111111XX01',
  ducr: null,
  ead_mrn: null,
  mucr: null,
  finalised_at: '2026-04-01T00:00:00.000Z',
  finalised_by_user_id: null,
  repair_cost: null,
  repair_cost_currency: null,
  customs_exchange_rate: null,
  duty_rate_pct: null,
  import_mrn: null,
  notes: null,
  created_by_user_id: null,
  created_at: '2026-04-01T00:00:00.000Z',
  updated_at: null,
}

const importShipment: Shipment = {
  ...exportShipment,
  id: 101,
  reference: 'IMP-GOLDEN-0001',
  direction: 'import',
  related_export_shipment_id: 100,
  export_mrn: null,
  import_mrn: '26GB2222222222XX01',
  repair_cost: 800,
  repair_cost_currency: 'USD',
  customs_exchange_rate: 1.25,
  duty_rate_pct: 2,
  ship_date: null,
}

const lines: ShipmentLine[] = [
  {
    id: 1, organisation_id: 1, shipment_id: 101, received_device_id: 1,
    imei: '860455101000012', sku: 'SKU-1', brand: 'Samsung', model: 'Galaxy S23',
    capacity: '128GB', color: 'Black', grade: 'A', unit_value: 150, currency: 'GBP',
    added_by_user_id: null, created_at: '2026-06-01T00:00:00.000Z',
  },
  {
    id: 2, organisation_id: 1, shipment_id: 101, received_device_id: 2,
    imei: '860455101000029', sku: 'SKU-2', brand: 'Samsung', model: 'Galaxy S23',
    capacity: '128GB', color: 'Black', grade: 'B', unit_value: 150, currency: 'GBP',
    added_by_user_id: null, created_at: '2026-06-01T00:00:00.000Z',
  },
]

describe('C&E1154 golden file — output frozen after verified before/after rename comparison', () => {
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
})
