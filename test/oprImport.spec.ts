// OPR 3 (Import / Discharge flow) invariants — return-consignment builder,
// C&E1154 computation, clearance-instruction draft, import validation
// engine, receipt (finalise), restock, discharge tracker.
//
// Load-bearing assertions:
//   - Return builder: only EXPORTED_UNDER_OPR devices FROM THE RELATED
//     EXPORT may join; the line snapshot copies the ORIGINAL export line's
//     frozen value (not today's device row); device status does not move
//     while the return is DRAFT; duplicate-draft guard.
//   - C&E1154: OPR Authorisation Number in the authorisation field and
//     NEVER the CDS Authorisation Number; CDS only in the cross-referenced statement;
//     exported-goods value = returning units only (partial return);
//     repair cost → GBP at the customs rate; relief + net duty computed;
//     quantity guardrail.
//   - Import validation engine: coded checks; red blocks receipt with
//     zero side-effects; discharge-window overrun is amber (not blocking).
//   - Receipt: devices → RETURNED_UNDER_OPR (event-logged with import
//     MRN); restock → ACTIVE_INVENTORY; generic transition endpoint
//     refuses the workflow statuses in both directions.
//   - Discharge tracker: exported vs returned vs outstanding, deadline =
//     export date + discharge period; discharged/open classification.
import { env } from 'cloudflare:workers'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'
import { computeCe1154, addMonths, computeDischargeRow, runImportValidation, round2, parseBox47, reconcileBox47, buildCe1154Html, buildClearanceInstructionDraft } from '../src/lib/oprImport'
import type { Shipment, ShipmentLine, OprAuthorisation } from '../src/types'

const JWT_SECRET = 'test-secret-opr-import'
const testEnv = { ...env, JWT_SECRET } as typeof env & { JWT_SECRET: string }

let token = ''
let authId = 0

// Distinct IMEI range from other suites (base 86045510...).
let imeiSeq = 0
function luhnImei(): string {
  const body = `8604551${String(10000000 + imeiSeq++).slice(1)}`
  let sum = 0
  for (let i = 0; i < 14; i++) {
    let d = Number(body[i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return body + String((10 - (sum % 10)) % 10)
}

async function api(path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  }, testEnv)
}

let shipmentSeq = 0

async function makeDevice(overrides: Record<string, unknown> = {}) {
  const res = await api('/api/scan/manual', {
    method: 'POST',
    body: JSON.stringify({
      imei: luhnImei(), brand: 'Samsung', model: 'Galaxy S23', grade: 'A',
      buy_price: 150, vat_type: 'MARGIN', currency: 'GBP',
      ...overrides,
    }),
  })
  expect(res.status).toBe(200)
  const data = await res.json() as { received: { id: number; imei: string } }
  for (const to of ['SORTING', 'READY_FOR_EXPORT']) {
    const t = await api(`/api/devices/${data.received.id}/transition`, {
      method: 'POST', body: JSON.stringify({ to_status: to }),
    })
    expect(t.status).toBe(200)
  }
  return data.received
}

// Creates a FINALISED export with `n` devices and an MRN — the OPR 2 flow
// run for real, so OPR 3 tests sit on true preconditions.
async function makeFinalisedExport(n: number, mrn: string) {
  const ref = `EXP RTN ${100 + shipmentSeq++}`
  const res = await api('/api/opr/shipments', {
    method: 'POST',
    body: JSON.stringify({
      reference: ref, direction: 'export', authorisation_id: authId,
      procedure_code: '2100', ship_date: '2026-07-01',
      consignee_name: 'Overseas Repairer BV',
      consignee_address: 'Repairstraat 1, Amsterdam, NL',
      carrier: 'FedEx', incoterm: 'DAP',
    }),
  })
  expect(res.status).toBe(201)
  const shipment = ((await res.json()) as { shipment: { id: number; reference: string } }).shipment
  const devices: { id: number; imei: string }[] = []
  for (let i = 0; i < n; i++) {
    const d = await makeDevice()
    const scan = await api(`/api/opr/shipments/${shipment.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: d.imei }),
    })
    expect(scan.status).toBe(201)
    devices.push(d)
  }
  const fin = await api(`/api/opr/shipments/${shipment.id}/finalise`, {
    method: 'POST', body: JSON.stringify({ export_mrn: mrn }),
  })
  expect(fin.status).toBe(200)
  return { shipment, devices }
}

// Creates a DRAFT import (return) shipment linked to an export.
async function makeReturnShipment(relatedExportId: number, overrides: Record<string, unknown> = {}) {
  const res = await api('/api/opr/shipments', {
    method: 'POST',
    body: JSON.stringify({
      reference: `IMP RTN ${100 + shipmentSeq++}`, direction: 'import',
      authorisation_id: authId, procedure_code: '6121',
      related_export_shipment_id: relatedExportId,
      ship_date: '2026-09-01',
      // Full FedEx OPR worksheet chain present by default (the 'computed'
      // path) so existing tests get a real computeCe1154() result without
      // each needing its own worksheet-input overrides. duty_rate_pct: 0
      // needs duty_override_claimed: true to avoid the OVR01 refusal.
      repair_cost: 500, repair_cost_currency: 'GBP', duty_rate_pct: 0,
      inbound_freight_gbp: 20, non_eu_freight_share_gbp: 10, export_freight_gbp: 20,
      duty_override_claimed: true,
      ...overrides,
    }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { shipment: Shipment }).shipment
}

async function deviceStatus(id: number): Promise<string> {
  const row = await env.DB.prepare('SELECT status FROM received_devices WHERE id = ?').bind(id).first<{ status: string }>()
  return row!.status
}

async function latestEvent(deviceId: number) {
  return env.DB.prepare('SELECT * FROM device_events WHERE device_id = ? ORDER BY id DESC LIMIT 1')
    .bind(deviceId).first<Record<string, unknown>>()
}

beforeAll(async () => {
  token = await signAuthToken(JWT_SECRET, {
    id: 1, email: 'admin@goodsin.local', name: 'Seed Admin',
    role: 'admin', organisation_id: 1,
  })
  const res = await api('/api/opr/authorisations', {
    method: 'POST',
    body: JSON.stringify({
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
      prealert_email: 'controlprealert@fedex.com',
      prealert_cutoff: '16:00',
    }),
  })
  expect(res.status).toBe(201)
  authId = ((await res.json()) as { authorisation: { id: number } }).authorisation.id
})

afterAll(async () => {
  // Leave the shared local D1 clean for other suites / manual smokes.
  await env.DB.prepare("DELETE FROM shipment_lines WHERE imei LIKE '8604551%'").run()
  // shipment_value_deltas FK-references shipments — must be cleared first.
  await env.DB.prepare(`
    DELETE FROM shipment_value_deltas WHERE shipment_id IN (
      SELECT id FROM shipments WHERE reference LIKE 'EXP RTN %' OR reference LIKE 'IMP RTN %'
    )
  `).run()
  await env.DB.prepare("DELETE FROM shipments WHERE reference LIKE 'EXP RTN %' OR reference LIKE 'IMP RTN %'").run()
  await env.DB.prepare('DELETE FROM opr_authorisations WHERE id = ?').bind(authId).run()
})

// ═════════ Return-consignment builder ═════════

describe('OPR 3 — return-consignment builder', () => {
  it('adds an exported device from the related export; line copies the FROZEN export value; status does not move while DRAFT', async () => {
    const { shipment: exp, devices } = await makeFinalisedExport(2, '26GB0000000000AA01')
    const ret = await makeReturnShipment(exp.id)

    // Mutate the device row AFTER export — buy_price today ≠ export value.
    await env.DB.prepare('UPDATE received_devices SET buy_price = 999.99 WHERE id = ?')
      .bind(devices[0].id).run()

    const scan = await api(`/api/opr/shipments/${ret.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: devices[0].imei }),
    })
    expect(scan.status).toBe(201)
    const line = ((await scan.json()) as { line: ShipmentLine }).line
    // Frozen export value (150), NOT the mutated 999.99.
    expect(Number(line.unit_value)).toBe(150)

    // Device is still abroad — no status change while the return is DRAFT.
    expect(await deviceStatus(devices[0].id)).toBe('EXPORTED_UNDER_OPR')
    // But the add is on the audit trail.
    const ev = await latestEvent(devices[0].id)
    expect(ev!.event_type).toBe('RETURN_CONSIGNMENT_ADD')
  })

  it('refuses a device that was NOT on the related export (zero side-effects)', async () => {
    const { shipment: expA } = await makeFinalisedExport(1, '26GB0000000000AA02')
    const { devices: devicesB } = await makeFinalisedExport(1, '26GB0000000000AA03')
    const ret = await makeReturnShipment(expA.id)

    const scan = await api(`/api/opr/shipments/${ret.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: devicesB[0].imei }),
    })
    expect(scan.status).toBe(409)
    expect(((await scan.json()) as { error: string }).error).toMatch(/not on export shipment/)
    expect(await deviceStatus(devicesB[0].id)).toBe('EXPORTED_UNDER_OPR')
    const lines = await env.DB.prepare('SELECT COUNT(*) AS n FROM shipment_lines WHERE shipment_id = ?')
      .bind(ret.id).first<{ n: number }>()
    expect(lines!.n).toBe(0)
  })

  it('refuses a device already parked on another OPEN return consignment (duplicate-draft guard)', async () => {
    const { shipment: exp, devices } = await makeFinalisedExport(1, '26GB0000000000AA04')
    const ret1 = await makeReturnShipment(exp.id)
    const ret2 = await makeReturnShipment(exp.id)

    const first = await api(`/api/opr/shipments/${ret1.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: devices[0].imei }),
    })
    expect(first.status).toBe(201)

    const second = await api(`/api/opr/shipments/${ret2.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: devices[0].imei }),
    })
    expect(second.status).toBe(409)
    expect(((await second.json()) as { error: string }).error).toMatch(/already on open return consignment/)
  })

  it('removing a line logs RETURN_CONSIGNMENT_REMOVE and frees the device for another return', async () => {
    const { shipment: exp, devices } = await makeFinalisedExport(1, '26GB0000000000AA05')
    const ret1 = await makeReturnShipment(exp.id)
    const ret2 = await makeReturnShipment(exp.id)

    const add = await api(`/api/opr/shipments/${ret1.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: devices[0].imei }),
    })
    expect(add.status).toBe(201)
    const lineId = ((await add.json()) as { line: { id: number } }).line.id

    const del = await api(`/api/opr/shipments/${ret1.id}/lines/${lineId}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    const ev = await latestEvent(devices[0].id)
    expect(ev!.event_type).toBe('RETURN_CONSIGNMENT_REMOVE')
    // Status never moved either way.
    expect(await deviceStatus(devices[0].id)).toBe('EXPORTED_UNDER_OPR')

    const readd = await api(`/api/opr/shipments/${ret2.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: devices[0].imei }),
    })
    expect(readd.status).toBe(201)
  })

  it('a READY_FOR_EXPORT (never exported) device cannot join a return', async () => {
    const { shipment: exp } = await makeFinalisedExport(1, '26GB0000000000AA06')
    const ret = await makeReturnShipment(exp.id)
    const fresh = await makeDevice() // READY_FOR_EXPORT

    const scan = await api(`/api/opr/shipments/${ret.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: fresh.imei }),
    })
    expect(scan.status).toBe(409)
    expect(((await scan.json()) as { error: string }).error).toMatch(/only EXPORTED_UNDER_OPR/)
  })

  // Phase-0 regression A10: a device that has been through a FULL OPR
  // round trip (exported → returned → restocked to ACTIVE_INVENTORY)
  // must not be reusable in ANY new export/return without a legitimate
  // transition back to READY_FOR_EXPORT. Today's ALLOWED_TRANSITIONS has
  // no outgoing edge from ACTIVE_INVENTORY at all, so this is structurally
  // guaranteed — but it was not previously exercised with a real
  // full-round-trip fixture (only with a device that had never left
  // READY_FOR_EXPORT), so this closes that gap explicitly.
  it('a device that completed a full round trip (restocked to ACTIVE_INVENTORY) cannot rejoin a NEW export or a NEW return — zero side-effects', async () => {
    const { shipment: exp, devices } = await makeFinalisedExport(1, '26GB0000000000AA07')
    const ret1 = await makeReturnShipment(exp.id)
    const scanIn = await api(`/api/opr/shipments/${ret1.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: devices[0].imei }),
    })
    expect(scanIn.status).toBe(201)
    const fin = await api(`/api/opr/shipments/${ret1.id}/finalise`, {
      method: 'POST', body: JSON.stringify({ import_mrn: '26GB0000000000BB01' }),
    })
    expect(fin.status).toBe(200)
    expect(await deviceStatus(devices[0].id)).toBe('RETURNED_UNDER_OPR')
    const restock = await api(`/api/opr/shipments/${ret1.id}/restock`, { method: 'POST' })
    expect(restock.status).toBe(200)
    expect(await deviceStatus(devices[0].id)).toBe('ACTIVE_INVENTORY')

    // (a) Cannot rejoin a brand-new EXPORT consignment — the export
    // builder requires READY_FOR_EXPORT, and there is no allowed edge
    // from ACTIVE_INVENTORY back to it.
    const newExpRes = await api('/api/opr/shipments', {
      method: 'POST',
      body: JSON.stringify({
        reference: `EXP RTN ${100 + shipmentSeq++}`, direction: 'export', authorisation_id: authId,
        procedure_code: '2100', consignee_name: 'Overseas Repairer BV',
        consignee_address: 'Repairstraat 1, Amsterdam, NL',
      }),
    })
    expect(newExpRes.status).toBe(201)
    const newExp = ((await newExpRes.json()) as { shipment: { id: number } }).shipment
    const linesBefore = await env.DB.prepare('SELECT COUNT(*) AS n FROM shipment_lines WHERE shipment_id = ?')
      .bind(newExp.id).first<{ n: number }>()
    const rejoinExport = await api(`/api/opr/shipments/${newExp.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: devices[0].imei }),
    })
    expect(rejoinExport.status).toBe(409)
    expect(((await rejoinExport.json()) as { error: string }).error).toMatch(/READY_FOR_EXPORT/)
    expect(await deviceStatus(devices[0].id)).toBe('ACTIVE_INVENTORY')
    const linesAfter = await env.DB.prepare('SELECT COUNT(*) AS n FROM shipment_lines WHERE shipment_id = ?')
      .bind(newExp.id).first<{ n: number }>()
    expect(linesAfter!.n).toBe(linesBefore!.n)

    // (b) Cannot rejoin a NEW return linked to the ORIGINAL export either
    // — the return builder requires EXPORTED_UNDER_OPR, and this device
    // is now ACTIVE_INVENTORY, not EXPORTED_UNDER_OPR.
    const ret2 = await makeReturnShipment(exp.id)
    const rejoinReturn = await api(`/api/opr/shipments/${ret2.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: devices[0].imei }),
    })
    expect(rejoinReturn.status).toBe(409)
    expect(((await rejoinReturn.json()) as { error: string }).error).toMatch(/only EXPORTED_UNDER_OPR/)
    expect(await deviceStatus(devices[0].id)).toBe('ACTIVE_INVENTORY')
    const ret2Lines = await env.DB.prepare('SELECT COUNT(*) AS n FROM shipment_lines WHERE shipment_id = ?')
      .bind(ret2.id).first<{ n: number }>()
    expect(ret2Lines!.n).toBe(0)
  })
})

// ═════════ C&E1154 computation (pure) ═════════

describe('OPR 3 — computeCe1154', () => {
  const baseAuth: OprAuthorisation = {
    id: 1, organisation_id: 1, holder_name: 'Saigates Limited', eori: 'GB369979995000',
    cds_number: 'GBOPO36997999500020260226105539', op_authorisation_number: 'OP/0922/601/31',
    valid_from: '2026-03-01', valid_to: '2031-02-28',
    supervising_office_name: null, supervising_office_code: null,
    commodity_scope: 'Smartphones', commodity_codes: '8517130000',
    rate_of_yield: '1:1', discharge_period_months: 6, notes: null,
    prealert_email: null, prealert_cutoff: null, created_at: '', updated_at: null,
  }
  // Full FedEx OPR worksheet chain present by default (the 'computed'
  // path) — tests that want the 'entry_pending' fallback null the 4
  // worksheet-input fields out explicitly. Process charge: 1000 USD /
  // 1.25 = £800. Duty 2% is nonzero so duty_override_claimed doesn't
  // gate these by default; tests targeting the 0%-duty/override
  // interaction override duty_rate_pct and duty_override_claimed together.
  const mkImport = (over: Partial<Shipment> = {}): Shipment => ({
    id: 2, organisation_id: 1, reference: 'IMP X', direction: 'import',
    shipment_type: 'OPR_REPAIR', status: 'DRAFT', authorisation_id: 1,
    procedure_code: '6121', additional_procedure_code: null,
    consignee_name: null, consignee_address: null, carrier: null, carrier_account: null,
    incoterm: null, currency: 'GBP', ship_date: '2026-09-01',
    related_export_shipment_id: 1, export_mrn: null, ducr: null, ead_mrn: null, mucr: null,
    finalised_at: null, finalised_by_user_id: null,
    repair_cost: 1000, repair_cost_currency: 'USD', customs_exchange_rate: 1.25,
    duty_rate_pct: 2, import_mrn: null,
    reconciled_value_gbp: null,
    customs_entry_ref: null, vat_evidence_ref: null,
    repair_cost_confirmed_at: null, repair_cost_confirmed_by_user_id: null,
    inbound_freight_gbp: 100, non_eu_freight_share_gbp: 40, export_freight_gbp: 100,
    insurance_gbp: null, value_adjustment_gbp: null, worksheet_input_provenance: null,
    commodity_code: null, duty_override_claimed: 0,
    entry_accepted_at: null, entry_cleared_at: null, supplementary_units: null,
    entry_duty_base_gbp: null, entry_vat_base_gbp: null, entry_duty_gbp: null, entry_vat_gbp: null,
    declared_invoice_total_gbp: null, declared_piece_count: null, declared_gross_weight_kg: null,
    misdeclaration_ack_at: null, misdeclaration_ack_by_user_id: null,
    notes: null, created_by_user_id: null, created_at: '', updated_at: null,
    ...over,
  })
  const mkExport = (over: Partial<Shipment> = {}): Shipment => mkImport({
    id: 1, reference: 'EXP X', direction: 'export', procedure_code: '2100',
    related_export_shipment_id: null, export_mrn: '26GB1111111111XX01', status: 'FINALISED',
    repair_cost: null, repair_cost_currency: null, customs_exchange_rate: null, duty_rate_pct: null,
    inbound_freight_gbp: null, non_eu_freight_share_gbp: null, export_freight_gbp: null,
    ship_date: '2026-07-01',
    ...over,
  })
  const mkLine = (unit: number, id = 1): ShipmentLine => ({
    id, organisation_id: 1, shipment_id: 2, received_device_id: id,
    imei: `86045519999999${id}`, sku: null, brand: 'Samsung', model: 'S23',
    capacity: null, color: null, grade: 'A', unit_value: unit, currency: 'GBP',
    added_by_user_id: null, created_at: '',
  })

  it('computes the full FedEx OPR worksheet chain: compensatory value, duty base, VAT base, duty, VAT (PVA); OPR Authorisation Number in the auth field, CDS only in the statement', () => {
    // Process charge 1000 USD / 1.25 = £800. Inbound freight £100,
    // non-EU share £40, export freight £100, insurance defaults to 0,
    // value adjustment defaults to £1.31. Device value = 150+150 = £300
    // (computed from lines — NEVER a typed-in field).
    //   compensatory value = 300 + 800 + 100 + 0            = 1200
    //   duty base           = 800 + 40 (non-EU share only) + 0 =  840
    //   duty                = 840 * 2%                        =   16.80
    //   VAT base            = 800 + 100 + 100 + 16.80 + 1.31  = 1018.11
    //   VAT (PVA)           = 1018.11 * 20%                   =  203.62
    const r = computeCe1154(mkImport(), mkExport(), baseAuth, [mkLine(150, 1), mkLine(150, 2)])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ce1154.opr_authorisation_number).toBe('OP/0922/601/31')
    expect(r.ce1154.opr_authorisation_number).not.toContain('GBOPO')
    expect(r.ce1154.cross_reference_statement).toContain('GBOPO36997999500020260226105539')
    expect(r.ce1154.export_mrn).toBe('26GB1111111111XX01')
    expect(r.ce1154.quantity).toBe(2)
    expect(r.ce1154.worksheet_source).toBe('computed')
    expect(r.ce1154.device_value_gbp).toBe(300)
    expect(r.ce1154.process_charge_gbp).toBe(800)
    expect(r.ce1154.compensatory_value_gbp).toBe(1200)
    expect(r.ce1154.duty_base_gbp).toBe(840)
    expect(r.ce1154.duty_gbp).toBe(16.80)
    expect(r.ce1154.vat_base_gbp).toBe(1018.11)
    expect(r.ce1154.pva_amount_gbp).toBe(203.62)
    expect(r.ce1154.value_adjustment_gbp).toBe(1.31)
    expect(r.ce1154.value_adjustment_is_default).toBe(true)
    expect(r.ce1154.vat_note).toMatch(/POSTPONED/)
  })

  it('partial return: device value (computed) counts the RETURNING units only, never the whole export', () => {
    // Export had many devices, but only one £150 line is returning.
    const r = computeCe1154(mkImport(), mkExport(), baseAuth, [mkLine(150)])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ce1154.device_value_gbp).toBe(150)
    expect(r.ce1154.quantity).toBe(1)
  })

  it('quantity guardrail: declared quantity must equal consignment quantity', () => {
    const r = computeCe1154(mkImport(), mkExport(), baseAuth, [mkLine(150)], 162)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/does not equal the consignment quantity/)
  })

  it('duty computing to £0.00 without duty_override_claimed is refused — a zero duty is never silently implied', () => {
    const r = computeCe1154(
      mkImport({ repair_cost: 500, repair_cost_currency: 'GBP', customs_exchange_rate: null, duty_rate_pct: 0 }),
      mkExport(), baseAuth, [mkLine(150)],
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/duty_override_claimed/)
    expect(r.error).toMatch(/OVR01/)
  })

  it('GBP process charge needs no exchange rate; duty 0% is valid once duty_override_claimed is set', () => {
    const r = computeCe1154(
      mkImport({
        repair_cost: 500, repair_cost_currency: 'GBP', customs_exchange_rate: null,
        duty_rate_pct: 0, duty_override_claimed: 1,
      }),
      mkExport(), baseAuth, [mkLine(150)],
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ce1154.process_charge_gbp).toBe(500)
    expect(r.ce1154.customs_exchange_rate).toBeNull()
    expect(r.ce1154.duty_gbp).toBe(0)
    expect(r.ce1154.duty_override_claimed).toBe(true)
  })

  it('refuses without an OPR Authorisation Number — the CDS Authorisation Number must NOT be substituted', () => {
    const r = computeCe1154(mkImport(), mkExport(), { ...baseAuth, op_authorisation_number: null }, [mkLine(150)])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/OPR Authorisation Number/)
    expect(r.error).toMatch(/must NOT be substituted/)
  })

  it('refuses a non-GBP process charge without a customs exchange rate', () => {
    const r = computeCe1154(mkImport({ customs_exchange_rate: null }), mkExport(), baseAuth, [mkLine(150)])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/customs_exchange_rate/)
  })

  it('refuses when the related export has no MRN', () => {
    const r = computeCe1154(mkImport(), mkExport({ export_mrn: null }), baseAuth, [mkLine(150)])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/export MRN/)
  })

  // ── entry_pending fallback (the general mechanism: when worksheet
  // inputs aren't yet available for ANY leg, fall back to the CDS entry's
  // own declared bases/taxes rather than inventing figures. R2 itself no
  // longer exercises this path — see the "OPR 3 — R1/R2 real-shipment"
  // describe block below, where entry_pending has been retired for R2 in
  // favour of derived-and-tied worksheet inputs. This test's synthetic
  // figures happen to numerically match R2's real ones only because they
  // were originally copied from R2 before that retirement; the mechanism
  // under test here is generic and still needed for any future leg whose
  // worksheet genuinely has no derivable inputs yet.) ──
  it('falls back to the CDS entry-declared bases/taxes when FedEx worksheet inputs are missing (entry_pending)', () => {
    const r = computeCe1154(
      mkImport({
        repair_cost: null, repair_cost_currency: null, customs_exchange_rate: null, duty_rate_pct: null,
        inbound_freight_gbp: null, non_eu_freight_share_gbp: null, export_freight_gbp: null,
        duty_override_claimed: 1,
        entry_duty_base_gbp: 1390.81, entry_vat_base_gbp: 1555.99, entry_duty_gbp: 0, entry_vat_gbp: 311.20,
      }),
      mkExport(), baseAuth, [mkLine(150)],
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ce1154.worksheet_source).toBe('entry_pending')
    expect(r.ce1154.worksheet_pending_note).toMatch(/pending/i)
    expect(r.ce1154.duty_base_gbp).toBe(1390.81)
    expect(r.ce1154.vat_base_gbp).toBe(1555.99)
    expect(r.ce1154.duty_gbp).toBe(0)
    expect(r.ce1154.pva_amount_gbp).toBe(311.20)
    expect(r.ce1154.process_charge).toBeNull()
    expect(r.ce1154.process_charge_gbp).toBeNull()
  })

  it('refuses when neither FedEx worksheet inputs nor CDS entry-declared bases/taxes are recorded', () => {
    const r = computeCe1154(
      mkImport({
        repair_cost: null, repair_cost_currency: null, customs_exchange_rate: null, duty_rate_pct: null,
        inbound_freight_gbp: null, non_eu_freight_share_gbp: null, export_freight_gbp: null,
      }),
      mkExport(), baseAuth, [mkLine(150)],
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/Neither the FedEx OPR worksheet inputs nor the CDS entry-declared/)
  })

  // ── Anti-misdeclaration structural gate (checkMisdeclaration, embedded) ──
  it('flags declared vs. computed device-value variance, side by side, and requires acknowledgement', () => {
    // Real discrepancy shape: broker-declared invoice total differs from
    // the true line-value sum (never the other way — device value is
    // ALWAYS the computed sum, never the declared figure).
    const r = computeCe1154(
      mkImport({ declared_invoice_total_gbp: 22588.00 }),
      mkExport(), baseAuth, [mkLine(150, 1), mkLine(150, 2)],
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ce1154.device_value_gbp).toBe(300) // computed — unaffected by the declared figure
    expect(r.ce1154.misdeclaration.value.declared_gbp).toBe(22588.00)
    expect(r.ce1154.misdeclaration.value.computed_gbp).toBe(300)
    expect(r.ce1154.misdeclaration.value.variance_gbp).toBe(22288)
    expect(r.ce1154.misdeclaration.value.misdeclared).toBe(true)
    expect(r.ce1154.misdeclaration.any_misdeclared).toBe(true)
    expect(r.ce1154.misdeclaration.requires_acknowledgement).toBe(true)
  })

  it('does not flag value misdeclaration when declared matches computed to the penny', () => {
    const r = computeCe1154(
      mkImport({ declared_invoice_total_gbp: 300 }),
      mkExport(), baseAuth, [mkLine(150, 1), mkLine(150, 2)],
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ce1154.misdeclaration.value.misdeclared).toBe(false)
    expect(r.ce1154.misdeclaration.any_misdeclared).toBe(false)
  })

  it('flags piece count / gross weight carried forward from a sibling leg despite a different quantity (better catch than a bare declared-value check)', () => {
    // R2 carried forward R1's "two boxes / 40kg" despite 18 fewer devices.
    const r = computeCe1154(
      mkImport({ declared_piece_count: 2, declared_gross_weight_kg: 40 }),
      mkExport(), baseAuth, [mkLine(150, 1), mkLine(150, 2)],
      undefined,
      [{ reference: 'IMP RTN R1', quantity: 90, declared_piece_count: 2, declared_gross_weight_kg: 40 }],
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ce1154.misdeclaration.piece_count.misdeclared).toBe(true)
    expect(r.ce1154.misdeclaration.piece_count.suspect_carried_forward_from).toBe('IMP RTN R1')
    expect(r.ce1154.misdeclaration.gross_weight.misdeclared).toBe(true)
    expect(r.ce1154.misdeclaration.gross_weight.suspect_carried_forward_from).toBe('IMP RTN R1')
    expect(r.ce1154.misdeclaration.any_misdeclared).toBe(true)
  })

  it('does not flag piece count / gross weight when a sibling leg has the same quantity too (not a carry-forward, a real match)', () => {
    const r = computeCe1154(
      mkImport({ declared_piece_count: 2, declared_gross_weight_kg: 40 }),
      mkExport(), baseAuth, [mkLine(150, 1), mkLine(150, 2)],
      undefined,
      [{ reference: 'IMP RTN SAME', quantity: 2, declared_piece_count: 2, declared_gross_weight_kg: 40 }],
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ce1154.misdeclaration.piece_count.misdeclared).toBe(false)
    expect(r.ce1154.misdeclaration.gross_weight.misdeclared).toBe(false)
  })
})

// ═════════ R1 / R2 real-shipment fixtures (Item C, assert to the penny) ═════════
//
// R1 (AWB 874874338764, import MRN 26GB8ILNEI7EFJPAR1, 90 units) has a
// FULL FedEx OPR worksheet — the whole computation chain is exercised and
// every intermediate/final figure is asserted to the penny.
//
// R2 (AWB 875147276207, import MRN 26GB8JRJW1IQOR7AR0, 72 units): the
// FedEx "OP WS 875147276207" worksheet itself is still outstanding from
// Aimee, but R2 has NO unknowns — every input and output is determined
// by two independent equations that each close to zero, so `entry_pending`
// is retired here in favour of the full computed chain. These are
// DERIVED-AND-TIED figures, not broker-supplied ones:
//   R1 compensatory-value/invoice-total check (proves the equation form):
//     £22,588.00 + £1,556.09 + £101.70 + £0.00 = £24,245.79 ✓ (declared
//     invoice total)
//   R2 inbound freight (derived from the same equation, applied to R2):
//     £18,794.81 − £17,344.00 (device value) − £1,345.63 (process/repair
//     charge) = £105.18
//   R2 export freight (derived from the VAT-base equation):
//     £1,555.99 − £1,345.63 − £105.18 − £0.00 (duty) − £1.31 (value
//     adjustment) = £103.87
//   R2 duty-base tie (confirms the derived freight split against the
//     known duty base): £1,345.63 + £45.18 (non-EU freight share) =
//     £1,390.81 ✓
// The outstanding item with Aimee/FedEx is now CONFIRMATION of figures
// already held, not discovery of unknowns.
describe('OPR 3 — R1/R2 real-shipment C&E1154 fixtures (Item C)', () => {
  const auth: OprAuthorisation = {
    id: 1, organisation_id: 1, holder_name: 'Saigates Limited', eori: 'GB369979995000',
    cds_number: 'GBOPO36997999500020260226105539', op_authorisation_number: 'OP/0922/601/31',
    valid_from: '2026-03-01', valid_to: '2031-02-28',
    supervising_office_name: 'HMRC S1756 IP-OP Customs Liverpool', supervising_office_code: 'GBLIV002',
    commodity_scope: 'Smartphones', commodity_codes: '8517130000',
    rate_of_yield: '1:1', discharge_period_months: 6, notes: null,
    prealert_email: null, prealert_cutoff: null, created_at: '', updated_at: null,
  }
  const mkBase = (over: Partial<Shipment> = {}): Shipment => ({
    id: 2, organisation_id: 1, reference: 'R1', direction: 'import',
    shipment_type: 'OPR_REPAIR', status: 'DRAFT', authorisation_id: 1,
    procedure_code: '6121', additional_procedure_code: null,
    consignee_name: null, consignee_address: null, carrier: 'FedEx', carrier_account: null,
    incoterm: null, currency: 'GBP', ship_date: '2026-09-01',
    related_export_shipment_id: 1, export_mrn: null, ducr: null, ead_mrn: null, mucr: null,
    finalised_at: null, finalised_by_user_id: null,
    repair_cost: null, repair_cost_currency: null, customs_exchange_rate: null,
    duty_rate_pct: null, import_mrn: null,
    reconciled_value_gbp: null,
    customs_entry_ref: null, vat_evidence_ref: null,
    repair_cost_confirmed_at: null, repair_cost_confirmed_by_user_id: null,
    inbound_freight_gbp: null, non_eu_freight_share_gbp: null, export_freight_gbp: null,
    insurance_gbp: null, value_adjustment_gbp: null, worksheet_input_provenance: null,
    commodity_code: '8517130000', duty_override_claimed: 1, // OVR01|DUTY OVERRIDE CLAIMED — stored fact
    entry_accepted_at: null, entry_cleared_at: null, supplementary_units: null,
    entry_duty_base_gbp: null, entry_vat_base_gbp: null, entry_duty_gbp: null, entry_vat_gbp: null,
    declared_invoice_total_gbp: null, declared_piece_count: null, declared_gross_weight_kg: null,
    misdeclaration_ack_at: null, misdeclaration_ack_by_user_id: null,
    notes: null, created_by_user_id: null, created_at: '', updated_at: null,
    ...over,
  })
  const mkExport = (mrn: string): Shipment => mkBase({
    id: 1, reference: `EXP ${mrn}`, direction: 'export', procedure_code: '2100',
    related_export_shipment_id: null, export_mrn: mrn, status: 'FINALISED',
    duty_override_claimed: 0,
  })

  it('R1 (874874338764, import MRN 26GB8ILNEI7EFJPAR1, 90 units) — full worksheet chain asserted to the penny', () => {
    // Device value is NOT part of the fixture table (only the worksheet
    // and bases/taxes figures are specified in Item C) — 90 synthetic
    // £1.00 lines stand in for the real IMEI-level values so the
    // quantity (90) is exact while compensatory_value_gbp is checked
    // structurally against the formula rather than to an invented penny
    // figure. Pick-and-note: real per-device values await the IMEI-level
    // export/return manifests, not part of this table.
    const lines: ShipmentLine[] = Array.from({ length: 90 }, (_, i) => ({
      id: i + 1, organisation_id: 1, shipment_id: 2, received_device_id: i + 1,
      imei: `860455190001${String(i).padStart(2, '0')}`, sku: null, brand: 'Samsung', model: 'S23',
      capacity: null, color: null, grade: 'A', unit_value: 1, currency: 'GBP',
      added_by_user_id: null, created_at: '',
    }))
    const importShipment = mkBase({
      reference: 'R1', import_mrn: '26GB8ILNEI7EFJPAR1', supplementary_units: 90,
      repair_cost: 1556.09, repair_cost_currency: 'GBP',
      inbound_freight_gbp: 101.70, non_eu_freight_share_gbp: 43.73, export_freight_gbp: 101.70,
      insurance_gbp: 0, duty_rate_pct: 0,
    })
    const r = computeCe1154(importShipment, mkExport('26GB7LKWO3QHFLCAA0'), auth, lines)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ce1154.worksheet_source).toBe('computed')
    expect(r.ce1154.quantity).toBe(90)
    expect(r.ce1154.supplementary_units).toBe(90)
    expect(r.ce1154.process_charge_gbp).toBe(1556.09)
    expect(r.ce1154.inbound_freight_gbp).toBe(101.70)
    expect(r.ce1154.non_eu_freight_share_gbp).toBe(43.73)
    expect(r.ce1154.export_freight_gbp).toBe(101.70)
    expect(r.ce1154.value_adjustment_gbp).toBe(1.31)
    expect(r.ce1154.value_adjustment_is_default).toBe(true)
    // Sprint A 2a (migration 0027, provenance-gated residual solving): R1
    // has no entry_vat_base_gbp recorded, so the solve/refuse guard never
    // activates — the £1.31 default is used exactly as before, but there
    // is nothing here to check it against, so it is tagged
    // 'default-unverified' (owner follow-up review of the 2a
    // demonstration), NOT 'broker-supplied': it is a document convention
    // being applied, not a figure the operator/worksheet actually
    // supplied. Nothing is unattributed either way. This is what keeps
    // R1's chain untouched by 2a.
    expect(r.ce1154.value_adjustment_provenance).toBe('default-unverified')
    expect(r.ce1154.unattributed_variance_gbp).toBeNull()
    // Table figures, asserted to the penny:
    expect(r.ce1154.duty_base_gbp).toBe(1599.82)
    expect(r.ce1154.vat_base_gbp).toBe(1760.80)
    expect(r.ce1154.duty_gbp).toBe(0)
    expect(r.ce1154.pva_amount_gbp).toBe(352.16)
    expect(r.ce1154.duty_override_claimed).toBe(true)
    // Structural check on compensatory value (not a table figure):
    expect(r.ce1154.compensatory_value_gbp).toBe(round2(90 + 1556.09 + 101.70 + 0))
  })

  it('R2 (875147276207, import MRN 26GB8JRJW1IQOR7AR0, 72 units) — entry_pending RETIRED: full worksheet chain asserted to the penny from derived-and-tied freight figures', () => {
    // Pick-and-note (same convention as R1): real per-device values await
    // the IMEI-level export/return manifests, so 72 synthetic £1.00 lines
    // stand in for exact quantity while compensatory_value_gbp is checked
    // structurally against the formula, not to an invented device-value
    // penny figure. That does not affect the four Item C table figures
    // below, none of which depend on device value.
    const lines: ShipmentLine[] = Array.from({ length: 72 }, (_, i) => ({
      id: i + 1, organisation_id: 1, shipment_id: 2, received_device_id: i + 1,
      imei: `860455190002${String(i).padStart(2, '0')}`, sku: null, brand: 'Samsung', model: 'S23',
      capacity: null, color: null, grade: 'A', unit_value: 1, currency: 'GBP',
      added_by_user_id: null, created_at: '',
    }))
    const importShipment = mkBase({
      reference: 'R2', import_mrn: '26GB8JRJW1IQOR7AR0', supplementary_units: 72,
      // Derived-and-tied worksheet inputs (see the describe-block header
      // comment for the two independent equations each figure closes
      // against) — NOT broker-supplied, but not unknowns either: FedEx's
      // own "OP WS 875147276207" worksheet is still outstanding, and this
      // is what confirmation from Aimee/FedEx is expected to match.
      repair_cost: 1345.63, repair_cost_currency: 'GBP', customs_exchange_rate: null,
      inbound_freight_gbp: 105.18, non_eu_freight_share_gbp: 45.18, export_freight_gbp: 103.87,
      insurance_gbp: 0, duty_rate_pct: 0,
      // value_adjustment_gbp left at the operator-entered DEFAULT (£1.31) —
      // both real R1/R2 legs came through at this figure.
      //
      // Sprint A 2a (migration 0027, provenance-gated residual solving):
      // repair charge (process_charge) is broker-supplied (straight off
      // the FedEx invoice); the three freight figures are 'derived' (hand-
      // derived from the equations in the describe-block header comment,
      // themselves assuming £1.31) — this is EXACTLY the circularity the
      // guard exists to catch, so the guard must REFUSE to solve
      // value_adjustment here, not silently confirm £1.31 by re-deriving
      // it from figures that already assumed it.
      worksheet_input_provenance: JSON.stringify({
        process_charge: 'broker-supplied',
        inbound_freight_gbp: 'derived',
        non_eu_freight_share_gbp: 'derived',
        export_freight_gbp: 'derived',
      }),
      // The CDS entry's own declared bases/taxes — document facts,
      // implicitly broker-supplied (not part of the provenance blob's key
      // set; they come straight off the entry, never derived/solved).
      // entry_vat_base_gbp is what the guard's refuse-branch measures the
      // unattributed_variance_gbp gap against.
      entry_duty_base_gbp: 1390.81, entry_vat_base_gbp: 1555.99, entry_duty_gbp: 0, entry_vat_gbp: 311.20,
    })
    const r = computeCe1154(importShipment, mkExport('26GB7LKWO3QHFLCAA0'), auth, lines)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ce1154.worksheet_source).toBe('computed')
    expect(r.ce1154.quantity).toBe(72)
    expect(r.ce1154.supplementary_units).toBe(72)
    expect(r.ce1154.process_charge_gbp).toBe(1345.63)
    expect(r.ce1154.inbound_freight_gbp).toBe(105.18)
    expect(r.ce1154.non_eu_freight_share_gbp).toBe(45.18)
    expect(r.ce1154.export_freight_gbp).toBe(103.87)
    // The guard REFUSES to solve value_adjustment here (inbound/export
    // freight are 'derived', not 'broker-supplied') — value_adjustment_gbp
    // stays at the £1.31 default, exactly as before 2a, and the honest gap
    // is surfaced separately via unattributed_variance_gbp below. This is
    // the load-bearing assertion of 2a: solving here would just reproduce
    // the £1.31 the freight figures were derived FROM (see the
    // describe-block header comment) — not confirm it.
    //
    // Provenance is 'default-unverified', not null (owner follow-up review
    // of the 2a demonstration): a caller reading value_adjustment_gbp
    // alone must never be able to mistake this refused-solve default for a
    // document fact. null previously meant exactly the same thing here as
    // it does in the no-entry-base branch above, but looked different —
    // both now use the same explicit tag so the field and its provenance
    // can never diverge.
    expect(r.ce1154.value_adjustment_gbp).toBe(1.31)
    expect(r.ce1154.value_adjustment_is_default).toBe(true)
    expect(r.ce1154.value_adjustment_provenance).toBe('default-unverified')
    // £1,555.99 (entry_vat_base_gbp) − £1,345.63 (broker-supplied process
    // charge) − £0 (both freight terms derived, so excluded) − £0 (duty)
    // = £210.36 — the portion covering inbound freight, export freight and
    // the value adjustment jointly, which cannot be decomposed from the
    // documents currently held. Reported honestly, not as a fabricated
    // £1.31 solve and not as a silent zero.
    expect(r.ce1154.unattributed_variance_gbp).toBe(210.36)
    // Table figures, asserted to the penny — these are the SAME figures
    // the CDS entry declared (£1,390.81 / £1,555.99 / £0.00 / £311.20),
    // now reached by computing forward from the derived-and-tied worksheet
    // inputs above, rather than by reading them back off the entry.
    // UNCHANGED by 2a — the regression guard holds trivially here rather
    // than by luck, because the guard refused to touch the arithmetic.
    expect(r.ce1154.duty_base_gbp).toBe(1390.81)
    expect(r.ce1154.vat_base_gbp).toBe(1555.99)
    expect(r.ce1154.duty_gbp).toBe(0)
    expect(r.ce1154.pva_amount_gbp).toBe(311.20)
    expect(r.ce1154.duty_override_claimed).toBe(true)
    // Structural check on compensatory value (not a table figure, same
    // convention as the R1 test above):
    expect(r.ce1154.compensatory_value_gbp).toBe(round2(72 + 1345.63 + 105.18 + 0))
  })

  it('Sprint A 2a guard, positive path: if R2\'s freight figures WERE broker-supplied, the guard would genuinely SOLVE value_adjustment from entry_vat_base_gbp instead of refusing', () => {
    // Secondary demonstration of the provenance-gated guard, using R2's
    // real figures with the provenance tags flipped to what they would be
    // once FedEx's own "OP WS 875147276207" worksheet actually arrives
    // (the owner-facing resolution the guard is holding a gap open for).
    // Not a replacement for the refuse-path test above (real R2 data, the
    // guard's primary demonstration) — this is the complementary positive
    // path: same inputs, different provenance, opposite guard outcome.
    const lines: ShipmentLine[] = Array.from({ length: 72 }, (_, i) => ({
      id: i + 1, organisation_id: 1, shipment_id: 2, received_device_id: i + 1,
      imei: `860455190002${String(i).padStart(2, '0')}`, sku: null, brand: 'Samsung', model: 'S23',
      capacity: null, color: null, grade: 'A', unit_value: 1, currency: 'GBP',
      added_by_user_id: null, created_at: '',
    }))
    const importShipment = mkBase({
      reference: 'R2', import_mrn: '26GB8JRJW1IQOR7AR0', supplementary_units: 72,
      repair_cost: 1345.63, repair_cost_currency: 'GBP', customs_exchange_rate: null,
      inbound_freight_gbp: 105.18, non_eu_freight_share_gbp: 45.18, export_freight_gbp: 103.87,
      insurance_gbp: 0, duty_rate_pct: 0,
      // ALL inputs broker-supplied this time — the guard's condition for
      // solving to fire.
      worksheet_input_provenance: JSON.stringify({
        process_charge: 'broker-supplied',
        inbound_freight_gbp: 'broker-supplied',
        non_eu_freight_share_gbp: 'broker-supplied',
        export_freight_gbp: 'broker-supplied',
      }),
      entry_duty_base_gbp: 1390.81, entry_vat_base_gbp: 1555.99, entry_duty_gbp: 0, entry_vat_gbp: 311.20,
    })
    const r = computeCe1154(importShipment, mkExport('26GB7LKWO3QHFLCAA0'), auth, lines)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Guard passes: solves value_adjustment = entry_vat_base_gbp − process
    // charge − inbound freight − export freight − duty
    //            = 1555.99 − 1345.63 − 105.18 − 103.87 − 0 = 1.31
    // Note this happens to equal the same £1.31 default — but this time
    // it is a genuine solve (every other input broker-supplied), not the
    // guard's refusal-with-default-fallback from the primary R2 test.
    expect(r.ce1154.value_adjustment_gbp).toBe(1.31)
    expect(r.ce1154.value_adjustment_provenance).toBe('solved')
    expect(r.ce1154.unattributed_variance_gbp).toBeNull()
    // Table figures are IDENTICAL to the primary R2 test's — the guard's
    // choice of path (solve vs. refuse) is invisible on the table itself
    // when the solved figure happens to match the default; the visible
    // difference is entirely in the new provenance/variance fields above.
    expect(r.ce1154.duty_base_gbp).toBe(1390.81)
    expect(r.ce1154.vat_base_gbp).toBe(1555.99)
    expect(r.ce1154.duty_gbp).toBe(0)
    expect(r.ce1154.pva_amount_gbp).toBe(311.20)
  })

  it('Sprint A 2a guard branch order: an explicitly-supplied value_adjustment_gbp is NEVER overwritten by a solve, even when entry_vat_base_gbp is also present and every other input is broker-supplied', () => {
    // Owner follow-up (post-2a acceptance): "Supplied always wins over
    // solved. Confirm which way round it is; if it's the wrong way,
    // that's a one-line fix plus a test." Investigation (throwaway
    // untracked scratch script, since deleted) confirmed the code is
    // already correct — the `value_adjustment_gbp != null` check is the
    // FIRST branch in the guard and short-circuits unconditionally,
    // before entry_vat_base_gbp or any provenance tag is even inspected.
    // This test makes that guarantee permanent rather than a one-off
    // scratch confirmation: it constructs the one shape that would catch
    // a regression if the branch order were ever reversed — an
    // R1/R2-style shipment that has BOTH an explicit
    // value_adjustment_gbp AND an entry_vat_base_gbp that would otherwise
    // let the guard's solve path fire (every other worksheet input tagged
    // broker-supplied, entry base ties exactly to the supplied figure).
    // If the guard ever reached for a solve here, it would silently
    // overwrite a genuine worksheet figure with a re-derived one.
    const lines: ShipmentLine[] = Array.from({ length: 72 }, (_, i) => ({
      id: i + 1, organisation_id: 1, shipment_id: 2, received_device_id: i + 1,
      imei: `860455190002${String(i).padStart(2, '0')}`, sku: null, brand: 'Samsung', model: 'S23',
      capacity: null, color: null, grade: 'A', unit_value: 1, currency: 'GBP',
      added_by_user_id: null, created_at: '',
    }))
    const importShipment = mkBase({
      reference: 'R2', import_mrn: '26GB8JRJW1IQOR7AR0', supplementary_units: 72,
      repair_cost: 1345.63, repair_cost_currency: 'GBP', customs_exchange_rate: null,
      inbound_freight_gbp: 105.18, non_eu_freight_share_gbp: 45.18, export_freight_gbp: 103.87,
      insurance_gbp: 0, duty_rate_pct: 0,
      // Explicitly supplied — a document fact. The guard must stop here
      // and never proceed to consider entry_vat_base_gbp at all.
      value_adjustment_gbp: 1.31,
      // Every other input broker-supplied — the exact condition that
      // would make the solve path fire if it were ever consulted first.
      worksheet_input_provenance: JSON.stringify({
        process_charge: 'broker-supplied',
        inbound_freight_gbp: 'broker-supplied',
        non_eu_freight_share_gbp: 'broker-supplied',
        export_freight_gbp: 'broker-supplied',
      }),
      // Ties exactly to the supplied £1.31, so a wrongly-ordered guard
      // would reproduce 1.31 and this test would pass for the wrong
      // reason if it only checked the value. The provenance and
      // unattributed_variance_gbp assertions below are what actually
      // prove the branch order, independent of whether the numbers
      // happen to agree.
      entry_duty_base_gbp: 1390.81, entry_vat_base_gbp: 1555.99, entry_duty_gbp: 0, entry_vat_gbp: 311.20,
    })
    const r = computeCe1154(importShipment, mkExport('26GB7LKWO3QHFLCAA0'), auth, lines)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Value is exactly the supplied figure, untouched. (value_adjustment_is_default
    // is a pure numeric-equality check against the £1.31 convention default,
    // not a provenance check — it is deliberately true here too, since the
    // supplied figure happens to equal the default; that coincidence is
    // exactly why this test relies on provenance, not the value, to prove
    // the branch order below.)
    expect(r.ce1154.value_adjustment_gbp).toBe(1.31)
    expect(r.ce1154.value_adjustment_is_default).toBe(true)
    // Provenance proves this was never solved, only accepted as supplied
    // — a wrongly-ordered guard would report 'solved' here instead.
    expect(r.ce1154.value_adjustment_provenance).toBe('broker-supplied')
    // No solve was attempted, so no honest gap to report either — a
    // wrongly-ordered guard would still leave this null (the solve
    // succeeds cleanly when everything ties), so this assertion alone
    // would not catch the bug; it is the provenance check above that
    // does the real work here.
    expect(r.ce1154.unattributed_variance_gbp).toBeNull()
  })

  it('R2 duty-base tie: derived process charge + NEU freight share reconstructs the known duty base independently of computeCe1154()', () => {
    // The executable form of the by-hand tie in the describe-block header:
    // £1,345.63 + £45.18 = £1,390.81, matching the CDS entry's declared
    // duty base exactly. Asserted directly against the arithmetic, not
    // against computeCe1154()'s output, so a future formula change that
    // happens to still match a stale expectation cannot slip through.
    expect(round2(1345.63 + 45.18)).toBe(1390.81)
  })

  it('discharge worked example: R1 (90) + R2 (72) supplementary units against export MRN 26GB7LKWO3QHFLCAA0 sum to exactly 162', () => {
    // Confirms the fixture data itself is internally consistent with the
    // Item C discharge worked example (90 + 72 = 162, fully discharged,
    // 10 Jan 2027 deadline met). The AGGREGATION logic across legs citing
    // a shared export MRN is separate application code (Step 3, not yet
    // wired into computeDischargeRow()/GET /discharge) — this test only
    // pins the arithmetic identity the fixtures must satisfy.
    const r1SupplementaryUnits = 90
    const r2SupplementaryUnits = 72
    expect(r1SupplementaryUnits + r2SupplementaryUnits).toBe(162)
  })
})

// ═════════ Owner finding (2026-08-17, "first item of the next pass") ═════════
// "The provenance sweep gives a clean negative result, but it surfaces
// something worth acting on before Sprint B... Check whether
// unattributed_variance_gbp appears on the rendered C&E1154 and the
// clearance instruction at all; if it doesn't, surface both it and the
// provenance — at minimum, mark default-unverified and solved figures
// visibly, and state the unattributed amount where one exists."
//
// Prior state (confirmed by exhaustive grep before this fix): neither
// buildCe1154Html() nor buildClearanceInstructionDraft() referenced
// value_adjustment_provenance or unattributed_variance_gbp anywhere —
// only value_adjustment_gbp/value_adjustment_is_default (a pure numeric
// check, true for both a genuinely broker-supplied £1.31 and an
// unverified assumed £1.31) were rendered. buildClearanceInstructionDraft
// had ZERO prior test coverage at all; these are new tests, not updates.
describe('OPR 3 — provenance/variance surfaced on broker-facing documents (owner finding, first item of next pass)', () => {
  const auth: OprAuthorisation = {
    id: 1, organisation_id: 1, holder_name: 'Saigates Limited', eori: 'GB369979995000',
    cds_number: 'GBOPO36997999500020260226105539', op_authorisation_number: 'OP/0922/601/31',
    valid_from: '2026-03-01', valid_to: '2031-02-28',
    supervising_office_name: 'HMRC S1756 IP-OP Customs Liverpool', supervising_office_code: 'GBLIV002',
    commodity_scope: 'Smartphones', commodity_codes: '8517130000',
    rate_of_yield: '1:1', discharge_period_months: 6, notes: null,
    prealert_email: null, prealert_cutoff: null, created_at: '', updated_at: null,
  }
  const mkBase = (over: Partial<Shipment> = {}): Shipment => ({
    id: 2, organisation_id: 1, reference: 'R1', direction: 'import',
    shipment_type: 'OPR_REPAIR', status: 'DRAFT', authorisation_id: 1,
    procedure_code: '6121', additional_procedure_code: null,
    consignee_name: null, consignee_address: null, carrier: 'FedEx', carrier_account: null,
    incoterm: null, currency: 'GBP', ship_date: '2026-09-01',
    related_export_shipment_id: 1, export_mrn: null, ducr: null, ead_mrn: null, mucr: null,
    finalised_at: null, finalised_by_user_id: null,
    repair_cost: null, repair_cost_currency: null, customs_exchange_rate: null,
    duty_rate_pct: null, import_mrn: null,
    reconciled_value_gbp: null,
    customs_entry_ref: null, vat_evidence_ref: null,
    repair_cost_confirmed_at: null, repair_cost_confirmed_by_user_id: null,
    inbound_freight_gbp: null, non_eu_freight_share_gbp: null, export_freight_gbp: null,
    insurance_gbp: null, value_adjustment_gbp: null, worksheet_input_provenance: null,
    commodity_code: '8517130000', duty_override_claimed: 1,
    entry_accepted_at: null, entry_cleared_at: null, supplementary_units: null,
    entry_duty_base_gbp: null, entry_vat_base_gbp: null, entry_duty_gbp: null, entry_vat_gbp: null,
    declared_invoice_total_gbp: null, declared_piece_count: null, declared_gross_weight_kg: null,
    misdeclaration_ack_at: null, misdeclaration_ack_by_user_id: null,
    notes: null, created_by_user_id: null, created_at: '', updated_at: null,
    ...over,
  })
  const mkExport = (mrn: string): Shipment => mkBase({
    id: 1, reference: `EXP ${mrn}`, direction: 'export', procedure_code: '2100',
    related_export_shipment_id: null, export_mrn: mrn, status: 'FINALISED',
    duty_override_claimed: 0,
  })
  const oneLine: ShipmentLine[] = [{
    id: 1, organisation_id: 1, shipment_id: 2, received_device_id: 1,
    imei: '860455190001200', sku: null, brand: 'Samsung', model: 'S23',
    capacity: null, color: null, grade: 'A', unit_value: 150, currency: 'GBP',
    added_by_user_id: null, created_at: '',
  }]

  it("R1's real case (default-unverified, no variance): C&E1154 marks the value adjustment UNVERIFIED, and shows no unattributed-variance row", () => {
    const importShipment = mkBase({
      reference: 'R1', import_mrn: '26GB8ILNEI7EFJPAR1',
      repair_cost: 1556.09, repair_cost_currency: 'GBP',
      inbound_freight_gbp: 101.70, non_eu_freight_share_gbp: 43.73, export_freight_gbp: 101.70,
      insurance_gbp: 0, duty_rate_pct: 0,
    })
    const r = computeCe1154(importShipment, mkExport('26GB7LKWO3QHFLCAA0'), auth, oneLine)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ce1154.value_adjustment_provenance).toBe('default-unverified')
    expect(r.ce1154.unattributed_variance_gbp).toBeNull()
    const html = buildCe1154Html(r.ce1154, importShipment, oneLine)
    expect(html).toContain('UNVERIFIED (default assumption, not confirmed by any document)')
    expect(html).not.toContain('Unattributed variance')
    expect(html).not.toContain('SOLVED')
    const draft = buildClearanceInstructionDraft(importShipment, mkExport('26GB7LKWO3QHFLCAA0'), auth, oneLine, r.ce1154)
    expect(draft.body).toContain('UNVERIFIED — a default assumption, not confirmed by any document')
    expect(draft.body).not.toContain('unattributed variance')
    expect(draft.body).not.toContain('SOLVED')
  })

  it("R2's real case (default-unverified, £210.36 unattributed variance): C&E1154 and the clearance instruction both surface the mark AND the amount — this is the exact gap the owner's finding identified", () => {
    const importShipment = mkBase({
      reference: 'R2', import_mrn: '26GB8JRJW1IQOR7AR0',
      repair_cost: 1345.63, repair_cost_currency: 'GBP', customs_exchange_rate: null,
      inbound_freight_gbp: 105.18, non_eu_freight_share_gbp: 45.18, export_freight_gbp: 103.87,
      insurance_gbp: 0, duty_rate_pct: 0,
      worksheet_input_provenance: JSON.stringify({
        process_charge: 'broker-supplied',
        inbound_freight_gbp: 'derived',
        non_eu_freight_share_gbp: 'derived',
        export_freight_gbp: 'derived',
      }),
      entry_duty_base_gbp: 1390.81, entry_vat_base_gbp: 1555.99, entry_duty_gbp: 0, entry_vat_gbp: 311.20,
    })
    const r = computeCe1154(importShipment, mkExport('26GB7LKWO3QHFLCAA0'), auth, oneLine)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ce1154.value_adjustment_provenance).toBe('default-unverified')
    expect(r.ce1154.unattributed_variance_gbp).toBe(210.36)
    const html = buildCe1154Html(r.ce1154, importShipment, oneLine)
    expect(html).toContain('UNVERIFIED (default assumption, not confirmed by any document)')
    expect(html).toContain('Unattributed variance')
    expect(html).toContain('£210.36')
    const draft = buildClearanceInstructionDraft(importShipment, mkExport('26GB7LKWO3QHFLCAA0'), auth, oneLine, r.ce1154)
    expect(draft.body).toContain('UNVERIFIED — a default assumption, not confirmed by any document')
    expect(draft.body).toContain('unattributed variance £210.36')
  })

  it("guard's positive-solve path ('solved', no variance): C&E1154 and the clearance instruction mark the value adjustment SOLVED, not UNVERIFIED, and show no unattributed-variance row", () => {
    const importShipment = mkBase({
      reference: 'R2', import_mrn: '26GB8JRJW1IQOR7AR0',
      repair_cost: 1345.63, repair_cost_currency: 'GBP', customs_exchange_rate: null,
      inbound_freight_gbp: 105.18, non_eu_freight_share_gbp: 45.18, export_freight_gbp: 103.87,
      insurance_gbp: 0, duty_rate_pct: 0,
      worksheet_input_provenance: JSON.stringify({
        process_charge: 'broker-supplied',
        inbound_freight_gbp: 'broker-supplied',
        non_eu_freight_share_gbp: 'broker-supplied',
        export_freight_gbp: 'broker-supplied',
      }),
      entry_duty_base_gbp: 1390.81, entry_vat_base_gbp: 1555.99, entry_duty_gbp: 0, entry_vat_gbp: 311.20,
    })
    const r = computeCe1154(importShipment, mkExport('26GB7LKWO3QHFLCAA0'), auth, oneLine)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ce1154.value_adjustment_provenance).toBe('solved')
    expect(r.ce1154.unattributed_variance_gbp).toBeNull()
    const html = buildCe1154Html(r.ce1154, importShipment, oneLine)
    expect(html).toContain('SOLVED (derived from the entry VAT base; not directly supplied)')
    expect(html).not.toContain('UNVERIFIED')
    expect(html).not.toContain('Unattributed variance')
    const draft = buildClearanceInstructionDraft(importShipment, mkExport('26GB7LKWO3QHFLCAA0'), auth, oneLine, r.ce1154)
    expect(draft.body).toContain('SOLVED — derived from the entry VAT base, not directly supplied')
    expect(draft.body).not.toContain('UNVERIFIED')
    expect(draft.body).not.toContain('unattributed variance')
  })

  it("genuinely broker-supplied value adjustment: NEITHER document shows any UNVERIFIED/SOLVED marker or a warn-highlighted row — the baseline document-fact case is left unmarked", () => {
    const importShipment = mkBase({
      reference: 'R1', import_mrn: '26GB8ILNEI7EFJPAR1',
      repair_cost: 1556.09, repair_cost_currency: 'GBP',
      inbound_freight_gbp: 101.70, non_eu_freight_share_gbp: 43.73, export_freight_gbp: 101.70,
      insurance_gbp: 0, duty_rate_pct: 0,
      value_adjustment_gbp: 1.31, // explicitly supplied — a document fact
    })
    const r = computeCe1154(importShipment, mkExport('26GB7LKWO3QHFLCAA0'), auth, oneLine)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ce1154.value_adjustment_provenance).toBe('broker-supplied')
    expect(r.ce1154.unattributed_variance_gbp).toBeNull()
    const html = buildCe1154Html(r.ce1154, importShipment, oneLine)
    expect(html).not.toContain('UNVERIFIED')
    expect(html).not.toContain('SOLVED')
    expect(html).not.toContain('Unattributed variance')
    expect(html).toContain('<tr><td>Value adjustment</td><td>£1.31</td></tr>')
    const draft = buildClearanceInstructionDraft(importShipment, mkExport('26GB7LKWO3QHFLCAA0'), auth, oneLine, r.ce1154)
    expect(draft.body).not.toContain('UNVERIFIED')
    expect(draft.body).not.toContain('SOLVED')
    expect(draft.body).not.toContain('unattributed variance')
  })
})

// ═════════ addMonths / discharge maths (pure) ═════════

describe('OPR 3 — addMonths + computeDischargeRow', () => {
  it('adds calendar months, clamping to month length', () => {
    expect(addMonths('2026-07-01', 6)).toBe('2027-01-01')
    expect(addMonths('2026-08-31', 6)).toBe('2027-02-28') // clamped
    expect(addMonths('2026-11-15', 2)).toBe('2027-01-15') // year rollover
  })

  it('classifies discharged / open / closing / overdue', () => {
    const exp = { id: 1, reference: 'E', export_mrn: 'M', ship_date: '2026-07-01', finalised_at: null }
    // deadline 2027-01-01
    expect(computeDischargeRow(exp, 6, 10, 10, '2026-08-01').status).toBe('discharged')
    expect(computeDischargeRow(exp, 6, 10, 4, '2026-08-01').status).toBe('open')
    expect(computeDischargeRow(exp, 6, 10, 4, '2026-12-15').status).toBe('closing')
    expect(computeDischargeRow(exp, 6, 10, 4, '2027-01-02').status).toBe('overdue')
    const row = computeDischargeRow(exp, 6, 10, 4, '2026-12-31')
    expect(row.discharge_deadline).toBe('2027-01-01')
    expect(row.days_remaining).toBe(1)
    expect(row.outstanding).toBe(6)
  })

  it('falls back to finalised_at date when ship_date is missing; no_export_date when both missing', () => {
    const viaFinalised = computeDischargeRow(
      { id: 1, reference: 'E', export_mrn: 'M', ship_date: null, finalised_at: '2026-07-01 10:00:00' }, 6, 5, 0, '2026-08-01')
    expect(viaFinalised.export_date).toBe('2026-07-01')
    const none = computeDischargeRow(
      { id: 1, reference: 'E', export_mrn: 'M', ship_date: null, finalised_at: null }, 6, 5, 0)
    expect(none.status).toBe('no_export_date')
  })
})

// ═════════ Import validation engine + endpoints ═════════

describe('OPR 3 — import validation, receipt, restock, discharge (end-to-end)', () => {
  it('validation endpoint runs the IMPORT engine on an import shipment', async () => {
    const { shipment: exp } = await makeFinalisedExport(1, '26GB0000000000AA07')
    const ret = await makeReturnShipment(exp.id)
    const res = await api(`/api/opr/shipments/${ret.id}/validation`)
    expect(res.status).toBe(200)
    const data = await res.json() as { direction: string; validation: { checks: { code: string }[] } }
    expect(data.direction).toBe('import')
    const codes = data.validation.checks.map(ch => ch.code)
    for (const code of ['IMP_HAS_LINES', 'IMP_PROCEDURE_6121', 'IMP_CURRENCY_GBP', 'IMP_RELATED_EXPORT', 'IMP_EXPORT_MRN', 'IMP_REPAIR_COST', 'IMP_DUTY_RATE', 'IMP_OP_AUTH_NUMBER', 'IMP_AUTH_VALID', 'IMP_DISCHARGE_WINDOW']) {
      expect(codes).toContain(code)
    }
  })

  it('discharge-window overrun is AMBER (return after deadline warns, does not block receipt)', () => {
    const importShipment = {
      direction: 'import', procedure_code: '6121', currency: 'GBP',
      ship_date: '2027-06-01', // way past 2026-07-01 + 6 months
      repair_cost: 500, repair_cost_currency: 'GBP', customs_exchange_rate: null, duty_rate_pct: 0,
    } as unknown as Shipment
    const exportShipment = {
      status: 'FINALISED', reference: 'EXP X', export_mrn: 'M', ship_date: '2026-07-01', finalised_at: null,
    } as unknown as Shipment
    const auth = {
      cds_number: 'X', op_authorisation_number: 'OP/1/2/3', valid_from: '2026-03-01', valid_to: '2031-02-28',
      discharge_period_months: 6, holder_name: 'H', eori: 'E',
    } as unknown as OprAuthorisation
    const line = { id: 1, imei: '860455199999991', unit_value: 150, currency: 'GBP', received_device_id: 1 } as unknown as ShipmentLine
    const r = runImportValidation(importShipment, exportShipment, auth, [line])
    const window = r.checks.find(ch => ch.code === 'IMP_DISCHARGE_WINDOW')
    expect(window!.level).toBe('amber')
    expect(r.result).toBe('amber') // amber overall — receipt not blocked
  })

  it('red validation blocks receipt with zero side-effects (missing repair cost)', async () => {
    const { shipment: exp, devices } = await makeFinalisedExport(1, '26GB0000000000AA08')
    const ret = await makeReturnShipment(exp.id, { repair_cost: undefined })
    // repair_cost was passed as undefined → not set. Confirm it's null.
    const row = await env.DB.prepare('SELECT repair_cost FROM shipments WHERE id = ?').bind(ret.id).first<{ repair_cost: number | null }>()
    expect(row!.repair_cost).toBeNull()

    const add = await api(`/api/opr/shipments/${ret.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: devices[0].imei }),
    })
    expect(add.status).toBe(201)

    const fin = await api(`/api/opr/shipments/${ret.id}/finalise`, {
      method: 'POST', body: JSON.stringify({ import_mrn: '26GB2222222222YY01' }),
    })
    expect(fin.status).toBe(422)
    const body = await fin.json() as { error: string; validation: { result: string } }
    expect(body.error).toMatch(/validation has red results/)
    expect(body.validation.result).toBe('red')

    // Zero side-effects: shipment still DRAFT, device untouched, no import_mrn.
    const after = await env.DB.prepare('SELECT status, import_mrn FROM shipments WHERE id = ?').bind(ret.id).first<{ status: string; import_mrn: string | null }>()
    expect(after!.status).toBe('DRAFT')
    expect(after!.import_mrn).toBeNull()
    expect(await deviceStatus(devices[0].id)).toBe('EXPORTED_UNDER_OPR')
  })

  it('happy path: receipt → RETURNED_UNDER_OPR (event-logged with MRN), C&E1154 + clearance render, restock → ACTIVE_INVENTORY, discharge tracker counts', async () => {
    const { shipment: exp, devices } = await makeFinalisedExport(3, '26GB0000000000AA09')
    const ret = await makeReturnShipment(exp.id, { repair_cost: 750.5, repair_cost_currency: 'GBP', duty_rate_pct: 0 })

    // Partial return: 2 of 3.
    for (const d of devices.slice(0, 2)) {
      const s = await api(`/api/opr/shipments/${ret.id}/scan`, {
        method: 'POST', body: JSON.stringify({ imei: d.imei }),
      })
      expect(s.status).toBe(201)
    }

    // C&E1154 JSON: device value (computed) counts the 2 returning units (2 × 150).
    const ceRes = await api(`/api/opr/shipments/${ret.id}/ce1154?format=json`)
    expect(ceRes.status).toBe(200)
    const ce = ((await ceRes.json()) as { ce1154: { quantity: number; device_value_gbp: number; opr_authorisation_number: string } }).ce1154
    expect(ce.quantity).toBe(2)
    expect(ce.device_value_gbp).toBe(300)
    expect(ce.opr_authorisation_number).toBe('OP/0922/601/31')

    // C&E1154 HTML: OPR Authorisation Number present; CDS Authorisation
    // Number ONLY inside the cross-referenced statement section.
    const htmlRes = await api(`/api/opr/shipments/${ret.id}/ce1154`)
    expect(htmlRes.status).toBe(200)
    const html = await htmlRes.text()
    expect(html).toContain('OP/0922/601/31')
    const statementStart = html.indexOf('id="ce1154-statement"')
    expect(html.indexOf('GBOPO36997999500020260226105539')).toBeGreaterThan(statementStart)

    // Clearance draft: quotes the export MRN, full FedEx OPR worksheet-chain
    // wording (process/repair charge, inbound freight, duty base/VAT base
    // asymmetry — Item C superseded the old "repair cost only" framing so
    // the template no longer implies freight is out of scope of the
    // customs assessment).
    const clr = await api(`/api/opr/shipments/${ret.id}/clearance`)
    expect(clr.status).toBe(200)
    const clearance = ((await clr.json()) as { clearance: { body: string; export_mrn_present: boolean; note: string } }).clearance
    expect(clearance.export_mrn_present).toBe(true)
    expect(clearance.body).toContain('26GB0000000000AA09')
    expect(clearance.body).toContain('Process (repair) charge')
    expect(clearance.body).toContain('inbound freight')
    expect(clearance.body).toContain('Duty base')
    expect(clearance.body).toContain('POSTPONED')
    expect(clearance.body).not.toContain('repair cost only')
    expect(clearance.note).toMatch(/no email is sent/)

    // Receipt.
    const fin = await api(`/api/opr/shipments/${ret.id}/finalise`, {
      method: 'POST', body: JSON.stringify({ import_mrn: '26GB2222222222YY02' }),
    })
    expect(fin.status).toBe(200)
    const finBody = await fin.json() as { devices_returned: number; shipment: { status: string; import_mrn: string } }
    expect(finBody.devices_returned).toBe(2)
    expect(finBody.shipment.status).toBe('FINALISED')
    expect(finBody.shipment.import_mrn).toBe('26GB2222222222YY02')

    for (const d of devices.slice(0, 2)) {
      expect(await deviceStatus(d.id)).toBe('RETURNED_UNDER_OPR')
      const ev = await latestEvent(d.id)
      expect(ev!.event_type).toBe('IMPORT_RECEIVED')
      expect(JSON.parse(String(ev!.metadata)).import_mrn).toBe('26GB2222222222YY02')
    }
    // The unreturned device is untouched.
    expect(await deviceStatus(devices[2].id)).toBe('EXPORTED_UNDER_OPR')

    // Lines locked after receipt.
    const lateAdd = await api(`/api/opr/shipments/${ret.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: devices[2].imei }),
    })
    expect(lateAdd.status).toBe(409)

    // Generic endpoint refuses RETURNED_UNDER_OPR in both directions.
    const push = await api(`/api/devices/${devices[2].id}/transition`, {
      method: 'POST', body: JSON.stringify({ to_status: 'RETURNED_UNDER_OPR' }),
    })
    expect(push.status).toBe(409)
    const pull = await api(`/api/devices/${devices[0].id}/transition`, {
      method: 'POST', body: JSON.stringify({ to_status: 'ACTIVE_INVENTORY' }),
    })
    expect(pull.status).toBe(409)

    // Discharge tracker: 3 exported, 2 returned, 1 outstanding, open.
    const tracker = await api('/api/opr/discharge')
    expect(tracker.status).toBe(200)
    const rows = ((await tracker.json()) as { discharge: { export_shipment_id: number; exported: number; returned: number; outstanding: number; status: string; discharge_deadline: string }[] }).discharge
    const row = rows.find(r => r.export_shipment_id === exp.id)!
    expect(row.exported).toBe(3)
    expect(row.returned).toBe(2)
    expect(row.outstanding).toBe(1)
    expect(row.discharge_deadline).toBe('2027-01-01') // 2026-07-01 + 6 months

    // Restock: the 2 returned devices → ACTIVE_INVENTORY.
    const restock = await api(`/api/opr/shipments/${ret.id}/restock`, { method: 'POST' })
    expect(restock.status).toBe(200)
    const restockBody = await restock.json() as { restocked: number; skipped: unknown[] }
    expect(restockBody.restocked).toBe(2)
    for (const d of devices.slice(0, 2)) {
      expect(await deviceStatus(d.id)).toBe('ACTIVE_INVENTORY')
      const ev = await latestEvent(d.id)
      expect(ev!.event_type).toBe('RETURN_RESTOCKED')
    }
    // Second restock is a no-op, not an error.
    const again = await api(`/api/opr/shipments/${ret.id}/restock`, { method: 'POST' })
    expect(again.status).toBe(200)
    expect(((await again.json()) as { restocked: number }).restocked).toBe(0)
  })

  it('Sprint A 2b: GET /discharge sums supplementary_units per FINALISED import leg, not raw shipment_lines COUNT(*)', async () => {
    // Proves the fix reads supplementary_units, not line count: the return
    // leg scans only 1 device (line count = 1) but declares
    // supplementary_units: 5 (the customs-declaration quantity, e.g. a
    // multi-unit commodity code). If GET /discharge were still using the
    // pre-fix raw COUNT(*) of shipment_lines, `returned` would read 1, not
    // 5 — a deliberately DIFFERENT value from the line count so the two
    // codepaths cannot coincidentally agree.
    const { shipment: exp, devices } = await makeFinalisedExport(2, '26GB0000000000AA20')
    const ret = await makeReturnShipment(exp.id, { supplementary_units: 5 })
    const scan = await api(`/api/opr/shipments/${ret.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: devices[0].imei }),
    })
    expect(scan.status).toBe(201)
    const fin = await api(`/api/opr/shipments/${ret.id}/finalise`, {
      method: 'POST', body: JSON.stringify({ import_mrn: '26GB2222222222YY20' }),
    })
    expect(fin.status).toBe(200)

    const tracker = await api('/api/opr/discharge')
    expect(tracker.status).toBe(200)
    const rows = ((await tracker.json()) as { discharge: { export_shipment_id: number; exported: number; returned: number; outstanding: number }[] }).discharge
    const row = rows.find(r => r.export_shipment_id === exp.id)!
    // exported stays a raw line count (2) — supplementary_units is
    // documented/enforced as import-shipment-only data, never set on the
    // export leg itself.
    expect(row.exported).toBe(2)
    // returned reflects the DECLARED supplementary_units (5), not the raw
    // scanned-line count (1) of the single FINALISED import leg.
    expect(row.returned).toBe(5)
    expect(row.outstanding).toBe(-3) // 2 - 5; a real over-declaration would be investigated, but the arithmetic must be honest either way
  })

  it('Sprint A 2b: GET /discharge sums supplementary_units ACROSS MULTIPLE FINALISED import legs (per-leg COALESCE, not one pooled COUNT)', async () => {
    // Two return legs against the same export, each with a distinct
    // supplementary_units figure, neither equal to its own scanned-line
    // count — this is the case a single pooled COUNT(*) across all legs'
    // lines could never reproduce correctly (it has no per-leg boundary),
    // and mirrors the Item C worked example's R1(90)+R2(72)=162 shape at
    // small scale.
    const { shipment: exp, devices } = await makeFinalisedExport(2, '26GB0000000000AA21')
    const ret1 = await makeReturnShipment(exp.id, { supplementary_units: 9 })
    expect((await api(`/api/opr/shipments/${ret1.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: devices[0].imei }),
    })).status).toBe(201)
    expect((await api(`/api/opr/shipments/${ret1.id}/finalise`, {
      method: 'POST', body: JSON.stringify({ import_mrn: '26GB2222222222YY21' }),
    })).status).toBe(200)

    const ret2 = await makeReturnShipment(exp.id, { supplementary_units: 7 })
    expect((await api(`/api/opr/shipments/${ret2.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: devices[1].imei }),
    })).status).toBe(201)
    expect((await api(`/api/opr/shipments/${ret2.id}/finalise`, {
      method: 'POST', body: JSON.stringify({ import_mrn: '26GB2222222222YY22' }),
    })).status).toBe(200)

    const tracker = await api('/api/opr/discharge')
    const rows = ((await tracker.json()) as { discharge: { export_shipment_id: number; returned: number }[] }).discharge
    const row = rows.find(r => r.export_shipment_id === exp.id)!
    // 9 + 7 = 16, NOT the pooled raw line count (1 + 1 = 2).
    expect(row.returned).toBe(16)
  })

  it('Sprint A 2b, REAL FIGURES: R1 (90 supplementary units) + R2 (72 supplementary units) against the real export MRN 26GB7LKWO3QHFLCAA0 report returned: 162 via a live GET /discharge call', async () => {
    // This is the tie the whole OPR authorisation rests on (Item C's
    // discharge worked example), asserted here against the REAL R1/R2
    // supplementary_units (90 and 72 — not 5/16 stand-ins) and the REAL
    // export MRN, through the actual API rather than as a standalone
    // arithmetic identity (see 'discharge worked example: R1 (90) + R2
    // (72)...' above, which only pins 90+72=162 in isolation). 90+162
    // devices are scanned individually (READY_FOR_EXPORT → export → two
    // finalised import legs) so `exported`/`returned` are read back from
    // the same per-leg supplementary_units COALESCE the 2b fix introduced
    // — not asserted against a mocked or hand-computed total.
    const { shipment: exp, devices } = await makeFinalisedExport(162, '26GB7LKWO3QHFLCAA0')

    // Return leg R1: 90 devices scanned, declared supplementary_units: 90
    // (AWB 874874338764, import MRN 26GB8ILNEI7EFJPAR1 — same fixture used
    // by the OPR 3 R1/R2 C&E1154 tests and ce1154Golden.spec.ts).
    const r1 = await makeReturnShipment(exp.id, { supplementary_units: 90 })
    for (const d of devices.slice(0, 90)) {
      expect((await api(`/api/opr/shipments/${r1.id}/scan`, {
        method: 'POST', body: JSON.stringify({ imei: d.imei }),
      })).status).toBe(201)
    }
    expect((await api(`/api/opr/shipments/${r1.id}/finalise`, {
      method: 'POST', body: JSON.stringify({ import_mrn: '26GB8ILNEI7EFJPAR1' }),
    })).status).toBe(200)

    // Return leg R2: 72 devices scanned, declared supplementary_units: 72
    // (AWB 875147276207, import MRN 26GB8JRJW1IQOR7AR0).
    const r2 = await makeReturnShipment(exp.id, { supplementary_units: 72 })
    for (const d of devices.slice(90, 162)) {
      expect((await api(`/api/opr/shipments/${r2.id}/scan`, {
        method: 'POST', body: JSON.stringify({ imei: d.imei }),
      })).status).toBe(201)
    }
    expect((await api(`/api/opr/shipments/${r2.id}/finalise`, {
      method: 'POST', body: JSON.stringify({ import_mrn: '26GB8JRJW1IQOR7AR0' }),
    })).status).toBe(200)

    const tracker = await api('/api/opr/discharge')
    expect(tracker.status).toBe(200)
    const rows = ((await tracker.json()) as {
      discharge: { export_shipment_id: number; export_mrn: string; exported: number; returned: number; outstanding: number; status: string }[]
    }).discharge
    const row = rows.find(r => r.export_shipment_id === exp.id)!
    expect(row.export_mrn).toBe('26GB7LKWO3QHFLCAA0')
    expect(row.exported).toBe(162)
    // The load-bearing figure: 90 + 72 = 162, read back from a live
    // GET /discharge call against the real MRN, not asserted in isolation.
    expect(row.returned).toBe(162)
    expect(row.outstanding).toBe(0)
    expect(row.status).toBe('discharged')
  }, 30000)

  it('import-proof records the 6121 MRN on a FINALISED import only; export-proof refuses imports', async () => {
    const { shipment: exp, devices } = await makeFinalisedExport(1, '26GB0000000000AA10')
    const ret = await makeReturnShipment(exp.id)

    // DRAFT → import-proof refused.
    const early = await api(`/api/opr/shipments/${ret.id}/import-proof`, {
      method: 'POST', body: JSON.stringify({ import_mrn: '26GB2222222222YY03' }),
    })
    expect(early.status).toBe(409)

    const add = await api(`/api/opr/shipments/${ret.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: devices[0].imei }),
    })
    expect(add.status).toBe(201)
    const fin = await api(`/api/opr/shipments/${ret.id}/finalise`, { method: 'POST', body: JSON.stringify({}) })
    expect(fin.status).toBe(200)

    // FINALISED → import-proof works.
    const proof = await api(`/api/opr/shipments/${ret.id}/import-proof`, {
      method: 'POST', body: JSON.stringify({ import_mrn: '26GB2222222222YY03' }),
    })
    expect(proof.status).toBe(200)
    expect(((await proof.json()) as { shipment: { import_mrn: string } }).shipment.import_mrn).toBe('26GB2222222222YY03')

    // export-proof on an import → 409.
    const wrong = await api(`/api/opr/shipments/${ret.id}/export-proof`, {
      method: 'POST', body: JSON.stringify({ export_mrn: '26GB0000000000AA10' }),
    })
    expect(wrong.status).toBe(409)
    expect(((await wrong.json()) as { error: string }).error).toMatch(/import-proof/)
  })

  it('repair fields are refused on EXPORT shipments (junk cannot accumulate)', async () => {
    const res = await api('/api/opr/shipments', {
      method: 'POST',
      body: JSON.stringify({
        reference: `EXP RTN ${100 + shipmentSeq++}`, direction: 'export',
        authorisation_id: authId, procedure_code: '2100', repair_cost: 500,
      }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toMatch(/import-shipment fields/)
  })

  it('ce1154 endpoint refuses export shipments; missing inputs are a clean 422', async () => {
    const { shipment: exp } = await makeFinalisedExport(1, '26GB0000000000AA11')
    const onExport = await api(`/api/opr/shipments/${exp.id}/ce1154`)
    expect(onExport.status).toBe(409)

    const ret = await makeReturnShipment(exp.id, { repair_cost: undefined })
    const noCost = await api(`/api/opr/shipments/${ret.id}/ce1154?format=json`)
    expect(noCost.status).toBe(422)
    expect(((await noCost.json()) as { error: string }).error).toMatch(/nothing to declare|repair_cost/)
  })

  // TEMP_EXPORT_STANDARD (migration 0023) is a non-customs consignment
  // type: no authorisation, no procedure code, no repair_cost/duty_rate —
  // all 422-rejected at creation (routes/opr.ts). This is the load-bearing
  // check for that type: the IMPORT validation engine must NOT red-block
  // receipt on the customs-only checks (IMP_PROCEDURE_6121, IMP_REPAIR_COST,
  // IMP_DUTY_RATE, IMP_OP_AUTH_NUMBER, IMP_AUTH_VALID, IMP_DISCHARGE_WINDOW,
  // IMP_EXPORT_MRN) that assume fields this shipment type can never have.
  it('TEMP_EXPORT_STANDARD full round trip: export finalise → TEMP_EXPORTED_STANDARD, receipt is GREEN with no customs fields set, restock → ACTIVE_INVENTORY', async () => {
    const expRef = `TES EXP ${100 + shipmentSeq++}`
    const expRes = await api('/api/opr/shipments', {
      method: 'POST',
      body: JSON.stringify({ reference: expRef, direction: 'export', shipment_type: 'TEMP_EXPORT_STANDARD' }),
    })
    expect(expRes.status).toBe(201)
    const exp = ((await expRes.json()) as { shipment: { id: number } }).shipment

    const device = await makeDevice()
    const scan = await api(`/api/opr/shipments/${exp.id}/scan`, { method: 'POST', body: JSON.stringify({ imei: device.imei }) })
    expect(scan.status).toBe(201)

    const expFin = await api(`/api/opr/shipments/${exp.id}/finalise`, { method: 'POST', body: JSON.stringify({}) })
    expect(expFin.status).toBe(200)
    expect(await deviceStatus(device.id)).toBe('TEMP_EXPORTED_STANDARD')

    // Return (import) shipment — no authorisation_id/procedure_code/repair fields at all.
    const retRes = await api('/api/opr/shipments', {
      method: 'POST',
      body: JSON.stringify({
        reference: `TES RTN ${100 + shipmentSeq++}`, direction: 'import',
        shipment_type: 'TEMP_EXPORT_STANDARD', related_export_shipment_id: exp.id,
      }),
    })
    expect(retRes.status).toBe(201)
    const ret = ((await retRes.json()) as { shipment: { id: number } }).shipment

    const retScan = await api(`/api/opr/shipments/${ret.id}/scan`, { method: 'POST', body: JSON.stringify({ imei: device.imei }) })
    expect(retScan.status).toBe(201)

    // Validation must be GREEN — the customs-only checks report not-applicable, not red.
    const valRes = await api(`/api/opr/shipments/${ret.id}/validation`)
    expect(valRes.status).toBe(200)
    const valData = await valRes.json() as { validation: { result: string; checks: Array<{ code: string; level: string }> } }
    expect(valData.validation.result).toBe('green')
    for (const code of ['IMP_PROCEDURE_6121', 'IMP_REPAIR_COST', 'IMP_DUTY_RATE', 'IMP_OP_AUTH_NUMBER', 'IMP_EXPORT_MRN']) {
      expect(valData.validation.checks.find(c => c.code === code)?.level).toBe('green')
    }

    const retFin = await api(`/api/opr/shipments/${ret.id}/finalise`, { method: 'POST', body: JSON.stringify({}) })
    expect(retFin.status).toBe(200)
    expect(await deviceStatus(device.id)).toBe('RETURNED_UNDER_STANDARD')

    const restock = await api(`/api/opr/shipments/${ret.id}/restock`, { method: 'POST' })
    expect(restock.status).toBe(200)
    expect(await deviceStatus(device.id)).toBe('ACTIVE_INVENTORY')
  })
})

// ═════════ Value reconciliation + delta trail (0019) ═════════
//
// shipment_lines.unit_value is FROZEN at add-time and never subsequently
// UPDATEd anywhere (confirmed by code search) — so "value change" here is
// never an edit to a line. It is the export batch's DECLARED
// reconciliation value (reconciled_value_gbp) being corrected by ops
// against an external total (e.g. FedEx/manifest), always producing a
// permanent delta record.
import { computeValueDelta, isValueBalanced } from '../src/lib/oprImport'

describe('OPR — value reconciliation: multi-leg balancing (pure)', () => {
  // Provenance: £22,042 is the Return A packing-list PDF total (20260726_OPR_90.pdf,
  // 90 IMEIs); £17,344 is £39,386 (Batch 001 invoice) minus that £22,042 — a DERIVED
  // remainder, not Return B's own shipment invoice (which separately states £16,798;
  // see the other fixture below) — kept only as its own internally-consistent pair.
  it('Batch 001 = 162 units / £39,386 → 90/£22,042 + 72/£17,344 balances on BOTH counts and value', () => {
    const exportedUnits = 162
    const exportedValue = 39386
    const leg1 = { units: 90, value: 22042 }
    const leg2 = { units: 72, value: 17344 }

    // Counts.
    expect(leg1.units + leg2.units).toBe(exportedUnits)

    // Value — via the pure isValueBalanced helper.
    const balance = isValueBalanced(exportedValue, [leg1.value, leg2.value])
    expect(balance.returned_value_gbp).toBe(39386)
    expect(balance.outstanding_value_gbp).toBe(0)
    expect(balance.balanced).toBe(true)

    // Same figures through computeDischargeRow's value fields, end to end.
    const row = computeDischargeRow(
      { id: 1, reference: 'BATCH 001', export_mrn: 'M', ship_date: '2026-07-01', finalised_at: null },
      6, exportedUnits, leg1.units + leg2.units, '2026-08-01', 30,
      exportedValue, leg1.value + leg2.value,
    )
    expect(row.outstanding).toBe(0)
    expect(row.status).toBe('discharged')
    expect(row.exported_value_gbp).toBe(39386)
    expect(row.returned_value_gbp).toBe(39386)
    expect(row.outstanding_value_gbp).toBe(0)
    expect(row.value_balanced).toBe(true)
  })

  // Phase-0 regression A2: the CONFIRMED Batch 001 supporting-documentation
  // values (Return A £22,588.00 + Return B £16,798.00 = Export £39,386.00).
  // Distinct fixture from the £22,042/£17,344 pair above — that fixture
  // stays untouched; this one exists alongside it, not in place of it.
  // Provenance: £22,588 (Return A) and £16,798 (Return B) are each the
  // shipment/reconciliation values used on the live FedEx correspondence for
  // AWB 874874338764 (Return A) and AWB 875147276207 (Return B) — the actual
  // figures declared/discharged, distinct from the £22,042 packing-list total
  // and its £17,344 derived remainder in the fixture above.
  it('Batch 001 (confirmed supporting docs) = 162 units / £39,386 → Return A £22,588 + Return B £16,798 balances on BOTH counts and value', () => {
    const exportedUnits = 162
    const exportedValue = 39386
    const returnA = { units: 90, value: 22588 }
    const returnB = { units: 72, value: 16798 }

    // Units: 90 + 72 = 162.
    expect(returnA.units + returnB.units).toBe(exportedUnits)

    // Value — via the pure isValueBalanced helper.
    const balance = isValueBalanced(exportedValue, [returnA.value, returnB.value])
    expect(balance.returned_value_gbp).toBe(39386)
    expect(balance.outstanding_value_gbp).toBe(0)
    expect(balance.balanced).toBe(true)

    // Same figures through computeDischargeRow's value fields, end to end.
    const row = computeDischargeRow(
      { id: 1, reference: 'BATCH 001', export_mrn: 'M', ship_date: '2026-07-01', finalised_at: null },
      6, exportedUnits, returnA.units + returnB.units, '2026-08-01', 30,
      exportedValue, returnA.value + returnB.value,
    )
    expect(row.outstanding).toBe(0)
    expect(row.status).toBe('discharged')
    expect(row.exported_value_gbp).toBe(39386)
    expect(row.returned_value_gbp).toBe(39386)
    expect(row.outstanding_value_gbp).toBe(0)
    expect(row.value_balanced).toBe(true)

    // This fixture is additive, not a replacement — the pre-existing
    // £22,042/£17,344 pair (different Batch 001 leg split) must still sum
    // to the same £39,386 export value without collision or overwrite.
    const otherPairBalance = isValueBalanced(exportedValue, [22042, 17344])
    expect(otherPairBalance.balanced).toBe(true)
    expect(otherPairBalance.returned_value_gbp).toBe(39386)
  })

  it('a partial leg (only 90 of 162 returned) balances on count-so-far but NOT on value if the value is short', () => {
    // Only the first leg (90 units / £22,042) has landed so far.
    const balance = isValueBalanced(39386, [22042])
    expect(balance.returned_value_gbp).toBe(22042)
    expect(balance.outstanding_value_gbp).toBe(17344) // exactly the second leg still owed
    expect(balance.balanced).toBe(false)

    const row = computeDischargeRow(
      { id: 1, reference: 'BATCH 001', export_mrn: 'M', ship_date: '2026-07-01', finalised_at: null },
      6, 162, 90, '2026-08-01', 30,
      39386, 22042,
    )
    // Counts alone would say "outstanding 72" but the row must ALSO expose
    // that £17,344 of value is outstanding — a batch that looks closer to
    // done on count is not actually reconciled until value matches too.
    expect(row.outstanding).toBe(72)
    expect(row.value_balanced).toBe(false)
    expect(row.outstanding_value_gbp).toBe(17344)
  })

  it('computeValueDelta: the £16,798→£17,344 fixture reproduces a visible £546 delta', () => {
    const delta = computeValueDelta(16798, 17344)
    expect(delta.ok).toBe(true)
    if (!delta.ok) return
    expect(delta.old_value_gbp).toBe(16798)
    expect(delta.new_value_gbp).toBe(17344)
    expect(delta.difference_gbp).toBe(546)
  })

  it('computeValueDelta refuses a non-pence-exact or negative correction', () => {
    expect(computeValueDelta(100, 100.001).ok).toBe(false)
    expect(computeValueDelta(100, -5).ok).toBe(false)
  })
})

describe('OPR — value reconciliation: durable delta record (end-to-end)', () => {
  it('reconcile-value on an export batch writes a permanent delta record for £16,798→£17,344 (£546 delta) with old/new/diff/timestamp/actor', async () => {
    const res = await api('/api/opr/shipments', {
      method: 'POST',
      body: JSON.stringify({
        reference: `EXP RTN ${100 + shipmentSeq++}`, direction: 'export', authorisation_id: authId,
        procedure_code: '2100', ship_date: '2026-07-01',
        consignee_name: 'Overseas Repairer BV', consignee_address: 'Repairstraat 1, Amsterdam, NL',
        carrier: 'FedEx', incoterm: 'DAP',
      }),
    })
    expect(res.status).toBe(201)
    const shipment = ((await res.json()) as { shipment: Shipment }).shipment

    // First reconciliation: baseline is the (empty) computed line sum (0),
    // ops sets the FedEx-manifest-declared value of £16,798.
    const first = await api(`/api/opr/shipments/${shipment.id}/reconcile-value`, {
      method: 'POST', body: JSON.stringify({ value_gbp: 16798, note: 'Initial FedEx manifest total' }),
    })
    expect(first.status).toBe(201)
    const firstDelta = ((await first.json()) as { delta: { old_value_gbp: number; new_value_gbp: number; difference_gbp: number; user_id: number; created_at: string } }).delta
    expect(firstDelta.old_value_gbp).toBe(0)
    expect(firstDelta.new_value_gbp).toBe(16798)
    expect(firstDelta.difference_gbp).toBe(16798)
    expect(firstDelta.user_id).toBe(1)
    expect(firstDelta.created_at).toBeTruthy()

    // Correction: manifest re-issued at £17,344 — must show a VISIBLE £546 delta.
    const second = await api(`/api/opr/shipments/${shipment.id}/reconcile-value`, {
      method: 'POST', body: JSON.stringify({ value_gbp: 17344, note: 'Corrected manifest — carrier re-weighed batch' }),
    })
    expect(second.status).toBe(201)
    const secondDelta = ((await second.json()) as { delta: { old_value_gbp: number; new_value_gbp: number; difference_gbp: number } }).delta
    expect(secondDelta.old_value_gbp).toBe(16798)
    expect(secondDelta.new_value_gbp).toBe(17344)
    expect(secondDelta.difference_gbp).toBe(546)

    // The full, permanent history is retrievable — nothing was overwritten.
    const hist = await api(`/api/opr/shipments/${shipment.id}/value-deltas`)
    expect(hist.status).toBe(200)
    const deltas = ((await hist.json()) as { deltas: { old_value_gbp: number; new_value_gbp: number; difference_gbp: number }[] }).deltas
    expect(deltas.length).toBe(2)
    expect(deltas[0].difference_gbp).toBe(16798)
    expect(deltas[1].difference_gbp).toBe(546)

    // The shipment row itself reflects the latest reconciled value.
    const shipRow = await env.DB.prepare('SELECT reconciled_value_gbp FROM shipments WHERE id = ?')
      .bind(shipment.id).first<{ reconciled_value_gbp: number }>()
    expect(Number(shipRow!.reconciled_value_gbp)).toBe(17344)
  })

  it('refuses reconciliation on an IMPORT shipment (value reconciliation is an export-batch concept)', async () => {
    const { shipment: exp } = await makeFinalisedExport(1, '26GB0000000000AA12')
    const ret = await makeReturnShipment(exp.id)
    const res = await api(`/api/opr/shipments/${ret.id}/reconcile-value`, {
      method: 'POST', body: JSON.stringify({ value_gbp: 100 }),
    })
    expect(res.status).toBe(409)
  })

  it('discharge tracker exposes value_balanced / outstanding_value_gbp end to end', async () => {
    const { shipment: exp, devices } = await makeFinalisedExport(2, '26GB0000000000AA13')
    // Two £150 lines → export batch value = £300 by default (no explicit reconciliation yet).
    const ret = await makeReturnShipment(exp.id)
    for (const d of devices) {
      const s = await api(`/api/opr/shipments/${ret.id}/scan`, { method: 'POST', body: JSON.stringify({ imei: d.imei }) })
      expect(s.status).toBe(201)
    }
    const fin = await api(`/api/opr/shipments/${ret.id}/finalise`, {
      method: 'POST', body: JSON.stringify({ import_mrn: '26GB3333333333ZZ01' }),
    })
    expect(fin.status).toBe(200)

    const tracker = await api('/api/opr/discharge')
    expect(tracker.status).toBe(200)
    const rows = ((await tracker.json()) as {
      discharge: { export_shipment_id: number; exported_value_gbp: number; returned_value_gbp: number; outstanding_value_gbp: number; value_balanced: boolean }[]
    }).discharge
    const row = rows.find(r => r.export_shipment_id === exp.id)!
    expect(row.exported_value_gbp).toBe(300)   // computed sum of the 2 frozen £150 lines
    expect(row.returned_value_gbp).toBe(300)   // both returned and finalised
    expect(row.outstanding_value_gbp).toBe(0)
    expect(row.value_balanced).toBe(true)
  })
})

describe('OPR — value reconciliation: isolation from the C&E1154 VAT/duty basis (protected invariant)', () => {
  it('reconciling an EXPORT batch\'s goods value does not change repair_cost / customs_exchange_rate / duty_rate_pct on ANY import shipment, nor computeCe1154()\'s output', async () => {
    const { shipment: exp, devices } = await makeFinalisedExport(2, '26GB0000000000AA14')
    const ret = await makeReturnShipment(exp.id, { repair_cost: 800, repair_cost_currency: 'USD', customs_exchange_rate: 1.25, duty_rate_pct: 2 })
    for (const d of devices) {
      const s = await api(`/api/opr/shipments/${ret.id}/scan`, { method: 'POST', body: JSON.stringify({ imei: d.imei }) })
      expect(s.status).toBe(201)
    }

    // Snapshot the import shipment's VAT/duty-basis fields AND the full
    // computed C&E1154 BEFORE any value-reconciliation activity.
    const beforeShip = await env.DB.prepare(
      'SELECT repair_cost, repair_cost_currency, customs_exchange_rate, duty_rate_pct FROM shipments WHERE id = ?'
    ).bind(ret.id).first<{ repair_cost: number; repair_cost_currency: string; customs_exchange_rate: number; duty_rate_pct: number }>()
    const ceBefore = await api(`/api/opr/shipments/${ret.id}/ce1154?format=json`)
    expect(ceBefore.status).toBe(200)
    const ceBeforeBody = await ceBefore.json()

    // Exercise value-reconciliation on the EXPORT batch — repeatedly, with
    // real corrections, exactly as an operator would.
    for (const value of [16798, 17344, 12000]) {
      const r = await api(`/api/opr/shipments/${exp.id}/reconcile-value`, {
        method: 'POST', body: JSON.stringify({ value_gbp: value }),
      })
      expect(r.status).toBe(201)
    }

    // AFTER: the import shipment's VAT/duty-basis fields must be BYTE-IDENTICAL.
    const afterShip = await env.DB.prepare(
      'SELECT repair_cost, repair_cost_currency, customs_exchange_rate, duty_rate_pct FROM shipments WHERE id = ?'
    ).bind(ret.id).first<{ repair_cost: number; repair_cost_currency: string; customs_exchange_rate: number; duty_rate_pct: number }>()
    expect(afterShip).toEqual(beforeShip)

    // And computeCe1154()'s full output — including repair_cost_gbp, duty
    // figures and the VAT note — must be identical too.
    const ceAfter = await api(`/api/opr/shipments/${ret.id}/ce1154?format=json`)
    expect(ceAfter.status).toBe(200)
    const ceAfterBody = await ceAfter.json()
    expect(ceAfterBody).toEqual(ceBeforeBody)
  })

  it('computeValueDelta / isValueBalanced take no repair-cost input at all — pure goods-value arithmetic, structurally isolated', () => {
    // Type-level + behavioural proof: neither function accepts or returns
    // anything resembling repair_cost/customs_exchange_rate/duty_rate_pct.
    const delta = computeValueDelta(100, 200)
    expect(delta.ok).toBe(true)
    if (delta.ok) {
      expect(Object.keys(delta).sort()).toEqual(['difference_gbp', 'new_value_gbp', 'ok', 'old_value_gbp'].sort())
    }
    const balance = isValueBalanced(500, [200, 300])
    expect(Object.keys(balance).sort()).toEqual(['balanced', 'outstanding_value_gbp', 'returned_value_gbp'].sort())
  })
})

// ═════════ Sprint A 2c — Box 47 dual-format parser ═════════

describe('OPR 3 — parseBox47 / reconcileBox47', () => {
  // Verbatim box 47 excerpts from the two real CDS entries on file (PDF
  // text extraction artefacts — '##' prefixes and blank lines between
  // every fragment — preserved exactly as the source renders them, since
  // that noise is exactly what the parser must tolerate).
  const r1Box47Text = `
[44] Documents, certificates and authorisations [2/3] Code|Id and part|Status|Reason|Issuing authority|Validity date|Units|Quantity

C019|GBOPO36997999500020260226105539

## C505|GBCGUGUARANTEENOTREQUIRED |XW|WAIVER

C506|GBDPO9088874

## 9WKS|WORKSHEET ATTACHED |AC

## Y900|CITES PERMITS NOT REQUIRED |-|CITES PERMITS NOT REQUIRED [47] Calculation of taxes

Type [4/3]

## Tax base [4/4] Meas.

## Unit

## Tax rate [4/5]

## Curr

Payable amount [4/6]

MoP [4/8]

## Deduct (relief) amount

Total tax assessed [4/7]

A00

1599.82 GBP

0.00 E

0.00

B00

1760.80 GBP

0.00 E

0.00

## Acceptance date/time

2026-08-03 13:43:33
`

  const r2Box47Text = `
[44] Documents, certificates and authorisations [2/3] Code|Id and part|Status|Reason|Issuing authority|Validity date|Units|Quantity

C019|GBOPO36997999500020260226105539

## C505|GBCGUGUARANTEENOTREQUIRED |XW|WAIVER

C506|GBDPO9088874

## 9WKS|WORKSHEET ATTACHED |AC

## Y900|CITES PERMITS NOT REQUIRED |-|CITES PERMITS NOT REQUIRED [47] Calculation of taxes

Type [4/3]

## Tax base [4/4] Meas.

## Unit

## Tax rate [4/5]

## Curr

Payable amount [4/6]

MoP [4/8]

## Deduct (relief) amount

Total tax assessed [4/7]

A00

1390.81 GBP

0.00 E

0.00

B00

1555.99 GBP

0.00 E

0.00

## Acceptance date/time

2026-08-04 09:16:33
`

  it('parses R1 (entry 874874338764): A00 duty base £1,599.82, B00 VAT base £1,760.80, both "total tax assessed" 0.00 (PVA)', () => {
    const r = parseBox47(r1Box47Text)
    expect(r.duty_found).toBe(true)
    expect(r.vat_found).toBe(true)
    expect(r.duty).toEqual({ tax_type: 'A00', tax_base_gbp: 1599.82, tax_rate_pct: 0, total_tax_assessed_gbp: 0 })
    expect(r.vat).toEqual({ tax_type: 'B00', tax_base_gbp: 1760.80, tax_rate_pct: 0, total_tax_assessed_gbp: 0 })
  })

  it('parses R2 (entry 875147276207): A00 duty base £1,390.81, B00 VAT base £1,555.99, both "total tax assessed" 0.00 (PVA)', () => {
    const r = parseBox47(r2Box47Text)
    expect(r.duty_found).toBe(true)
    expect(r.vat_found).toBe(true)
    expect(r.duty).toEqual({ tax_type: 'A00', tax_base_gbp: 1390.81, tax_rate_pct: 0, total_tax_assessed_gbp: 0 })
    expect(r.vat).toEqual({ tax_type: 'B00', tax_base_gbp: 1555.99, tax_rate_pct: 0, total_tax_assessed_gbp: 0 })
  })

  it('B00 "total tax assessed" is 0.00 on BOTH real entries (PVA never a cash charge) — the parser reports this verbatim, it does not infer VAT liability from it', () => {
    // This is the fact the whole parser exists to protect: a reader who
    // took "total tax assessed" at face value would conclude VAT payable
    // is nil on every entry, always. It never is — VAT is postponed, not
    // waived. The real liability is tax_base x 20%, computed separately
    // (see computeCe1154's pva_amount_gbp), never read off this field.
    const r1 = parseBox47(r1Box47Text)
    const r2 = parseBox47(r2Box47Text)
    expect(r1.vat!.total_tax_assessed_gbp).toBe(0)
    expect(r2.vat!.total_tax_assessed_gbp).toBe(0)
    expect(round2(r1.vat!.tax_base_gbp! * 0.2)).toBe(352.16) // R1's real PVA amount
    expect(round2(r2.vat!.tax_base_gbp! * 0.2)).toBe(311.20) // R2's real PVA amount
  })

  it('reconcileBox47: R1 matches computeCe1154()\'s own duty/VAT bases exactly', () => {
    const parsed = parseBox47(r1Box47Text)
    const rec = reconcileBox47(parsed, 1599.82, 1760.80)
    expect(rec.ok).toBe(true)
    if (!rec.ok) return
    expect(rec.duty_base_matches).toBe(true)
    expect(rec.vat_base_matches).toBe(true)
  })

  it('reconcileBox47: flags a genuine mismatch rather than silently reporting a match', () => {
    const parsed = parseBox47(r1Box47Text)
    // Deliberately wrong computed figures — the reconciliation must say so.
    const rec = reconcileBox47(parsed, 1600.00, 1760.80)
    expect(rec.ok).toBe(true)
    if (!rec.ok) return
    expect(rec.duty_base_matches).toBe(false)
    expect(rec.vat_base_matches).toBe(true)
  })

  it('reconcileBox47: refuses to reconcile (ok:false) when a tax type is entirely absent from the text, rather than reporting a fabricated false match', () => {
    const noVat = parseBox47(`A00\n\n1390.81 GBP\n\n0.00 E\n\n0.00\n`)
    const rec = reconcileBox47(noVat, 1390.81, 1555.99)
    expect(rec.ok).toBe(false)
    if (rec.ok) return
    expect(rec.error).toMatch(/B00/)
  })

  // ── Dual-format / future-format resilience (the actual defect this
  // unit exists to close) ──
  //
  // The filing party's warning: an upcoming HMRC change may alter the
  // NUMBER or ORDER of tax-type blocks in box 47. A parser hard-coded to
  // "block 1 is duty, block 2 is VAT" or "there are always exactly two
  // blocks" would misread a reordered/added entry. These tests construct
  // synthetic box 47 texts in shapes the real entries have NEVER shown,
  // and confirm the code-keyed parser still finds the right figures by
  // tax-type code, never by position.
  it('future-format resilience: B00 (VAT) appearing BEFORE A00 (duty) is still parsed correctly by code, not position', () => {
    const reordered = `
[47] Calculation of taxes

B00

1555.99 GBP

0.00 E

0.00

A00

1390.81 GBP

0.00 E

0.00
`
    const r = parseBox47(reordered)
    expect(r.duty_found).toBe(true)
    expect(r.vat_found).toBe(true)
    // Still correctly assigned to A00/B00 despite the swapped order —
    // proof this is a code lookup, not "first block = duty".
    expect(r.duty!.tax_base_gbp).toBe(1390.81)
    expect(r.vat!.tax_base_gbp).toBe(1555.99)
  })

  it('future-format resilience: a THIRD tax-type block (e.g. an excise code future entries might add) does not confuse duty/VAT extraction, and is preserved rather than dropped', () => {
    const withExcise = `
[47] Calculation of taxes

A00

1390.81 GBP

0.00 E

0.00

E00

50.00 GBP

10.00 %

5.00

B00

1555.99 GBP

0.00 E

0.00
`
    const r = parseBox47(withExcise)
    expect(r.lines.length).toBe(3)
    expect(r.duty!.tax_base_gbp).toBe(1390.81)
    expect(r.vat!.tax_base_gbp).toBe(1555.99)
    const excise = r.lines.find(l => l.tax_type === 'E00')
    expect(excise).toEqual({ tax_type: 'E00', tax_base_gbp: 50, tax_rate_pct: 10, total_tax_assessed_gbp: 5 })
  })

  it('future-format resilience: A00 with a NON-ZERO "total tax assessed" (the specific HMRC-change scenario named by the filing party) is read correctly, not clamped or ignored', () => {
    // The filing party's exact scenario: "future entries [may] show duty
    // only against A00 tax amount" — i.e. A00's total tax assessed goes
    // non-zero while B00 stays postponed. A position/shape-naive parser
    // that assumed "total tax assessed is always 0.00" could silently
    // drop a real duty liability here.
    const dutyPayable = `
[47] Calculation of taxes

A00

1390.81 GBP

5.00 %

69.54

B00

1555.99 GBP

0.00 E

0.00
`
    const r = parseBox47(dutyPayable)
    expect(r.duty!.total_tax_assessed_gbp).toBe(69.54)
    expect(r.duty!.tax_rate_pct).toBe(5)
    expect(r.vat!.total_tax_assessed_gbp).toBe(0)
  })

  it('future-format resilience: a MISSING optional "Deduct (relief) amount" line does not shift which figure is read as the total', () => {
    // Some entries carry an extra deduct/relief line between rate and
    // total; the two real entries on file happen not to render one
    // (their amounts array is [base, rate] then jumps straight to
    // total). This test constructs the OTHER shape — base, rate, a
    // relief amount, THEN total — confirming the last collected amount
    // (not a fixed "3rd line") is always the one read as the total.
    const withRelief = `
[47] Calculation of taxes

A00

1390.81 GBP

10.00 %

20.00

119.08
`
    const r = parseBox47(withRelief)
    expect(r.duty!.tax_base_gbp).toBe(1390.81)
    expect(r.duty!.tax_rate_pct).toBe(10)
    // 119.08, not the 20.00 relief line in between.
    expect(r.duty!.total_tax_assessed_gbp).toBe(119.08)
  })

  it('duty_found / vat_found are false (never a fabricated zero) when box 47 is entirely absent from the text', () => {
    const r = parseBox47('No box 47 content here at all — just other declaration text.\nSomething else.\n')
    expect(r.duty_found).toBe(false)
    expect(r.vat_found).toBe(false)
    expect(r.duty).toBeNull()
    expect(r.vat).toBeNull()
    expect(r.lines).toEqual([])
  })
})
