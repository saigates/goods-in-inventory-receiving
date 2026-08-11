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
import { computeCe1154, addMonths, computeDischargeRow, runImportValidation } from '../src/lib/oprImport'
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
      repair_cost: 500, repair_cost_currency: 'GBP', duty_rate_pct: 0,
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
      supervising_office_code: 'GBNCL001',
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
  const mkImport = (over: Partial<Shipment> = {}): Shipment => ({
    id: 2, organisation_id: 1, reference: 'IMP X', direction: 'import',
    shipment_type: 'OPR_REPAIR', status: 'DRAFT', authorisation_id: 1,
    procedure_code: '6121', additional_procedure_code: null,
    consignee_name: null, consignee_address: null, carrier: null, carrier_account: null,
    incoterm: null, currency: 'GBP', ship_date: '2026-09-01',
    related_export_shipment_id: 1, export_mrn: null, ducr: null, ead_mrn: null,
    finalised_at: null, finalised_by_user_id: null,
    repair_cost: 1000, repair_cost_currency: 'USD', customs_exchange_rate: 1.25,
    duty_rate_pct: 2, import_mrn: null,
    notes: null, created_by_user_id: null, created_at: '', updated_at: null,
    ...over,
  })
  const mkExport = (over: Partial<Shipment> = {}): Shipment => mkImport({
    id: 1, reference: 'EXP X', direction: 'export', procedure_code: '2100',
    related_export_shipment_id: null, export_mrn: '26GB1111111111XX01', status: 'FINALISED',
    repair_cost: null, repair_cost_currency: null, customs_exchange_rate: null, duty_rate_pct: null,
    ship_date: '2026-07-01',
    ...over,
  })
  const mkLine = (unit: number, id = 1): ShipmentLine => ({
    id, organisation_id: 1, shipment_id: 2, received_device_id: id,
    imei: `86045519999999${id}`, sku: null, brand: 'Samsung', model: 'S23',
    capacity: null, color: null, grade: 'A', unit_value: unit, currency: 'GBP',
    added_by_user_id: null, created_at: '',
  })

  it('computes conversion, relief and net duty; OPR Authorisation Number in the auth field, CDS only in the statement', () => {
    // 1000 USD / 1.25 = £800 repair. Duty 2%.
    // Without OPR: (300 + 800) * 2% = £22. Net (repair only): 800 * 2% = £16. Relief £6.
    const r = computeCe1154(mkImport(), mkExport(), baseAuth, [mkLine(150, 1), mkLine(150, 2)])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ce1154.opr_authorisation_number).toBe('OP/0922/601/31')
    expect(r.ce1154.opr_authorisation_number).not.toContain('GBOPO')
    expect(r.ce1154.cross_reference_statement).toContain('GBOPO36997999500020260226105539')
    expect(r.ce1154.export_mrn).toBe('26GB1111111111XX01')
    expect(r.ce1154.quantity).toBe(2)
    expect(r.ce1154.exported_goods_value_gbp).toBe(300)
    expect(r.ce1154.repair_cost_gbp).toBe(800)
    expect(r.ce1154.duty_without_relief_gbp).toBe(22)
    expect(r.ce1154.duty_on_repair_cost_gbp).toBe(16)
    expect(r.ce1154.opr_relief_gbp).toBe(6)
  })

  it('partial return: exported-goods value counts the RETURNING units only', () => {
    // Export had many devices, but only one £150 line is returning.
    const r = computeCe1154(mkImport(), mkExport(), baseAuth, [mkLine(150)])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ce1154.exported_goods_value_gbp).toBe(150)
    expect(r.ce1154.quantity).toBe(1)
  })

  it('quantity guardrail: declared quantity must equal consignment quantity', () => {
    const r = computeCe1154(mkImport(), mkExport(), baseAuth, [mkLine(150)], 162)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/does not equal the consignment quantity/)
  })

  it('GBP repair cost needs no exchange rate; duty 0% is valid (net duty £0)', () => {
    const r = computeCe1154(
      mkImport({ repair_cost: 500, repair_cost_currency: 'GBP', customs_exchange_rate: null, duty_rate_pct: 0 }),
      mkExport(), baseAuth, [mkLine(150)],
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ce1154.repair_cost_gbp).toBe(500)
    expect(r.ce1154.customs_exchange_rate).toBeNull()
    expect(r.ce1154.duty_on_repair_cost_gbp).toBe(0)
    expect(r.ce1154.opr_relief_gbp).toBe(0)
  })

  it('refuses without an OPR Authorisation Number — the CDS Authorisation Number must NOT be substituted', () => {
    const r = computeCe1154(mkImport(), mkExport(), { ...baseAuth, op_authorisation_number: null }, [mkLine(150)])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/OPR Authorisation Number/)
    expect(r.error).toMatch(/must NOT be substituted/)
  })

  it('refuses a non-GBP repair cost without a customs exchange rate', () => {
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

    // C&E1154 JSON: value counts the 2 returning units (2 × 150).
    const ceRes = await api(`/api/opr/shipments/${ret.id}/ce1154?format=json`)
    expect(ceRes.status).toBe(200)
    const ce = ((await ceRes.json()) as { ce1154: { quantity: number; exported_goods_value_gbp: number; opr_authorisation_number: string } }).ce1154
    expect(ce.quantity).toBe(2)
    expect(ce.exported_goods_value_gbp).toBe(300)
    expect(ce.opr_authorisation_number).toBe('OP/0922/601/31')

    // C&E1154 HTML: OPR Authorisation Number present; CDS Authorisation
    // Number ONLY inside the cross-referenced statement section.
    const htmlRes = await api(`/api/opr/shipments/${ret.id}/ce1154`)
    expect(htmlRes.status).toBe(200)
    const html = await htmlRes.text()
    expect(html).toContain('OP/0922/601/31')
    const statementStart = html.indexOf('id="ce1154-statement"')
    expect(html.indexOf('GBOPO36997999500020260226105539')).toBeGreaterThan(statementStart)

    // Clearance draft: quotes the export MRN, repair-cost-only wording.
    const clr = await api(`/api/opr/shipments/${ret.id}/clearance`)
    expect(clr.status).toBe(200)
    const clearance = ((await clr.json()) as { clearance: { body: string; export_mrn_present: boolean; note: string } }).clearance
    expect(clearance.export_mrn_present).toBe(true)
    expect(clearance.body).toContain('26GB0000000000AA09')
    expect(clearance.body).toContain('repair cost only')
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
