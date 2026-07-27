// OPR 2 (Export flow) invariants — consignment builder, validation engine,
// documents, finalisation.
//
// Load-bearing assertions:
//   - Builder: only READY_FOR_EXPORT devices join an export consignment;
//     joining/leaving drives device status ↔ IN_EXPORT_CONSIGNMENT in
//     lockstep with the line (event-logged); import shipments refuse the
//     builder; the generic transition endpoint refuses consignment-derived
//     statuses in BOTH directions.
//   - Validation engine: coded green/amber/red results; red blocks
//     finalisation with zero side-effects; amber does not block.
//   - Documents: invoice total == scan-out total (same pence-exact sum);
//     both are built from the FROZEN line snapshots.
//   - Finalisation: locks lines, devices → EXPORTED_UNDER_OPR, proof refs
//     captured; FINALISED accepts export-proof updates and nothing else.
import { env } from 'cloudflare:workers'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'
import { runExportValidation } from '../src/lib/oprValidation'
import type { Shipment, ShipmentLine, OprAuthorisation } from '../src/types'

const JWT_SECRET = 'test-secret-opr-export'
const testEnv = { ...env, JWT_SECRET } as typeof env & { JWT_SECRET: string }

let token = ''
let authId = 0

// Distinct IMEI range from other suites (base 86045500...) to avoid UNIQUE
// collisions if files ever share a D1 instance.
let imeiSeq = 0
function luhnImei(): string {
  const body = `8604550${String(10000000 + imeiSeq++).slice(1)}`
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

// Creates a device via the real intake path, optionally staged to
// READY_FOR_EXPORT through the real state machine.
async function makeDevice(overrides: Record<string, unknown> = {}, stage = true) {
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
  if (stage) {
    for (const to of ['SORTING', 'READY_FOR_EXPORT']) {
      const t = await api(`/api/devices/${data.received.id}/transition`, {
        method: 'POST', body: JSON.stringify({ to_status: to }),
      })
      expect(t.status).toBe(200)
    }
  }
  return data.received
}

async function makeShipment(overrides: Record<string, unknown> = {}): Promise<{ id: number; reference: string }> {
  const reference = `EXP TEST ${100 + shipmentSeq++}`
  const res = await api('/api/opr/shipments', {
    method: 'POST',
    body: JSON.stringify({
      reference, direction: 'export', authorisation_id: authId,
      procedure_code: '2100', ship_date: '2026-08-01',
      consignee_name: 'Overseas Repairer BV',
      consignee_address: 'Repairstraat 1, Amsterdam, NL',
      carrier: 'FedEx', incoterm: 'DAP',
      ...overrides,
    }),
  })
  expect(res.status).toBe(201)
  const data = await res.json() as { shipment: { id: number; reference: string } }
  return data.shipment
}
let shipmentSeq = 0

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
      chief_number: 'OP/0922/601/31',
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

describe('consignment builder — status lockstep', () => {
  it('scanning an IMEI onto a draft export adds the line AND moves the device to IN_EXPORT_CONSIGNMENT (event-logged)', async () => {
    const shipment = await makeShipment()
    const device = await makeDevice()

    const res = await api(`/api/opr/shipments/${shipment.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: device.imei }),
    })
    expect(res.status).toBe(201)
    const { line } = await res.json() as { line: Record<string, unknown> }
    expect(line.imei).toBe(device.imei)
    expect(line.unit_value).toBe(150)

    expect(await deviceStatus(device.id)).toBe('IN_EXPORT_CONSIGNMENT')
    const ev = await latestEvent(device.id)
    expect(ev!.event_type).toBe('EXPORT_CONSIGNMENT_ADD')
    expect(ev!.to_status).toBe('IN_EXPORT_CONSIGNMENT')
  })

  it('rejects devices that are not READY_FOR_EXPORT — zero side-effects', async () => {
    const shipment = await makeShipment()
    const device = await makeDevice({}, false) // stays RECEIVED

    const linesBefore = await env.DB.prepare('SELECT COUNT(*) AS n FROM shipment_lines').first<{ n: number }>()
    const res = await api(`/api/opr/shipments/${shipment.id}/lines`, {
      method: 'POST', body: JSON.stringify({ device_id: device.id }),
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/READY_FOR_EXPORT/)

    const linesAfter = await env.DB.prepare('SELECT COUNT(*) AS n FROM shipment_lines').first<{ n: number }>()
    expect(linesAfter!.n).toBe(linesBefore!.n)
    expect(await deviceStatus(device.id)).toBe('RECEIVED')
  })

  it('404 for an IMEI not in inventory', async () => {
    const shipment = await makeShipment()
    const res = await api(`/api/opr/shipments/${shipment.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: luhnImei() }),
    })
    expect(res.status).toBe(404)
  })

  it('removing a line releases the device back to READY_FOR_EXPORT (event-logged)', async () => {
    const shipment = await makeShipment()
    const device = await makeDevice()
    const add = await api(`/api/opr/shipments/${shipment.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: device.imei }),
    })
    const { line } = await add.json() as { line: { id: number } }

    const del = await api(`/api/opr/shipments/${shipment.id}/lines/${line.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(await deviceStatus(device.id)).toBe('READY_FOR_EXPORT')
    const ev = await latestEvent(device.id)
    expect(ev!.event_type).toBe('EXPORT_CONSIGNMENT_REMOVE')

    // ...and it can join another consignment afterwards.
    const shipment2 = await makeShipment()
    const re = await api(`/api/opr/shipments/${shipment2.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: device.imei }),
    })
    expect(re.status).toBe(201)
  })

  it('import shipments refuse the consignment builder (OPR 3 flow)', async () => {
    const res = await api('/api/opr/shipments', {
      method: 'POST',
      body: JSON.stringify({ reference: `IMP TEST ${shipmentSeq++}`, direction: 'import', authorisation_id: authId, procedure_code: '6121' }),
    })
    expect(res.status).toBe(201)
    const importShipment = ((await res.json()) as { shipment: { id: number } }).shipment
    const device = await makeDevice()

    const scan = await api(`/api/opr/shipments/${importShipment.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: device.imei }),
    })
    expect(scan.status).toBe(409)
    expect(((await scan.json()) as { error: string }).error).toMatch(/OPR 3/)
  })

  it('generic transition endpoint refuses consignment-derived statuses in BOTH directions', async () => {
    // Direction 1: cannot PUSH a device into IN_EXPORT_CONSIGNMENT directly.
    const staged = await makeDevice()
    const push = await api(`/api/devices/${staged.id}/transition`, {
      method: 'POST', body: JSON.stringify({ to_status: 'IN_EXPORT_CONSIGNMENT' }),
    })
    expect(push.status).toBe(409)
    expect(((await push.json()) as { error: string }).error).toMatch(/OPR consignment workflow/)
    expect(await deviceStatus(staged.id)).toBe('READY_FOR_EXPORT')

    // Direction 2: cannot PULL a device that IS in a consignment out of it.
    const shipment = await makeShipment()
    const inConsignment = await makeDevice()
    await api(`/api/opr/shipments/${shipment.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: inConsignment.imei }),
    })
    const pull = await api(`/api/devices/${inConsignment.id}/transition`, {
      method: 'POST', body: JSON.stringify({ to_status: 'READY_FOR_EXPORT' }),
    })
    expect(pull.status).toBe(409)
    expect(await deviceStatus(inConsignment.id)).toBe('IN_EXPORT_CONSIGNMENT')
  })
})

describe('validation engine — coded green/amber/red', () => {
  const baseShipment = (over: Partial<Shipment> = {}): Shipment => ({
    id: 1, organisation_id: 1, reference: 'ENGINE TEST 1', direction: 'export',
    shipment_type: 'OPR_REPAIR', status: 'DRAFT', authorisation_id: 1,
    procedure_code: '2100', additional_procedure_code: null,
    consignee_name: 'Overseas Repairer BV', consignee_address: 'Repairstraat 1',
    carrier: 'FedEx', carrier_account: null, incoterm: 'DAP', currency: 'GBP',
    ship_date: '2026-08-01', related_export_shipment_id: null, export_mrn: null,
    ducr: null, ead_mrn: null, finalised_at: null, finalised_by_user_id: null,
    notes: null, created_by_user_id: 1, created_at: '', updated_at: null,
    ...over,
  })
  const baseAuth: OprAuthorisation = {
    id: 1, organisation_id: 1, holder_name: 'Saigates Limited', eori: 'GB369979995000',
    cds_number: 'GBOPO36997999500020260226105539', chief_number: 'OP/0922/601/31',
    valid_from: '2026-03-01', valid_to: '2031-02-28',
    supervising_office_name: null, supervising_office_code: 'GBNCL001',
    commodity_scope: 'Smartphones', commodity_codes: '8517130000',
    rate_of_yield: '1:1', discharge_period_months: 6, notes: null,
    prealert_email: 'controlprealert@fedex.com', prealert_cutoff: '16:00',
    created_at: '', updated_at: null,
  }
  const mkLine = (over: Partial<ShipmentLine> = {}): ShipmentLine => ({
    id: 1, organisation_id: 1, shipment_id: 1, received_device_id: 1,
    imei: luhnImei(), sku: 'SGS23-A', brand: 'Samsung', model: 'Galaxy S23',
    capacity: null, color: null, grade: 'A', unit_value: 150, currency: 'GBP',
    added_by_user_id: 1, created_at: '',
    ...over,
  })
  const codeLevel = (r: ReturnType<typeof runExportValidation>, code: string) =>
    r.checks.find(x => x.code === code)?.level

  it('fully-formed shipment is green on every check', () => {
    const r = runExportValidation(baseShipment(), baseAuth, [mkLine(), mkLine({ id: 2 })])
    expect(r.result).toBe('green')
    expect(r.red_count).toBe(0)
    expect(r.amber_count).toBe(0)
  })

  it('no lines → red SHIP_HAS_LINES', () => {
    const r = runExportValidation(baseShipment(), baseAuth, [])
    expect(codeLevel(r, 'SHIP_HAS_LINES')).toBe('red')
    expect(r.result).toBe('red')
  })

  it('ship date outside authorisation validity → red AUTH_VALID_ON_SHIP_DATE', () => {
    const r = runExportValidation(baseShipment({ ship_date: '2032-01-01' }), baseAuth, [mkLine()])
    expect(codeLevel(r, 'AUTH_VALID_ON_SHIP_DATE')).toBe('red')
  })

  it('no ship date → amber (checked against today), does not block', () => {
    const r = runExportValidation(baseShipment({ ship_date: null }), baseAuth, [mkLine()], '2026-07-27')
    expect(codeLevel(r, 'AUTH_VALID_ON_SHIP_DATE')).toBe('amber')
    expect(r.result).toBe('amber')
  })

  it('duplicate IMEI across lines → red IMEIS_VALID_UNIQUE', () => {
    const dup = luhnImei()
    const r = runExportValidation(baseShipment(), baseAuth, [mkLine({ imei: dup }), mkLine({ id: 2, imei: dup })])
    expect(codeLevel(r, 'IMEIS_VALID_UNIQUE')).toBe('red')
  })

  it('checksum-invalid IMEI → red IMEIS_VALID_UNIQUE', () => {
    const good = luhnImei()
    // Rotate the check digit by one — guaranteed to break the Luhn sum.
    const bad = good.slice(0, 14) + String((Number(good[14]) + 1) % 10)
    const r = runExportValidation(baseShipment(), baseAuth, [mkLine({ imei: bad })])
    expect(codeLevel(r, 'IMEIS_VALID_UNIQUE')).toBe('red')
  })

  it('pence-inexact unit value → red UNIT_VALUES_PRESENT', () => {
    const r = runExportValidation(baseShipment(), baseAuth, [mkLine({ unit_value: 33.333 })])
    expect(codeLevel(r, 'UNIT_VALUES_PRESENT')).toBe('red')
  })

  it('zero/negative unit value → red UNIT_VALUES_PRESENT', () => {
    const r = runExportValidation(baseShipment(), baseAuth, [mkLine({ unit_value: 0 })])
    expect(codeLevel(r, 'UNIT_VALUES_PRESENT')).toBe('red')
  })

  it('missing logistics fields → amber LOGISTICS_COMPLETE', () => {
    const r = runExportValidation(baseShipment({ carrier: null, incoterm: null }), baseAuth, [mkLine()])
    expect(codeLevel(r, 'LOGISTICS_COMPLETE')).toBe('amber')
  })

  it('missing commodity codes on the authorisation → amber COMMODITY_SCOPE', () => {
    const r = runExportValidation(baseShipment(), { ...baseAuth, commodity_codes: null }, [mkLine()])
    expect(codeLevel(r, 'COMMODITY_SCOPE')).toBe('amber')
  })

  it('endpoint returns the coded checks for a real shipment', async () => {
    const shipment = await makeShipment()
    const device = await makeDevice()
    await api(`/api/opr/shipments/${shipment.id}/scan`, { method: 'POST', body: JSON.stringify({ imei: device.imei }) })

    const res = await api(`/api/opr/shipments/${shipment.id}/validation`)
    expect(res.status).toBe(200)
    const data = await res.json() as { validation: { result: string; checks: Array<{ code: string; level: string }> } }
    expect(data.validation.result).toBe('green')
    const codes = data.validation.checks.map(x => x.code)
    for (const code of ['SHIP_HAS_LINES', 'CURRENCY_GBP', 'AUTH_VALID_ON_SHIP_DATE', 'PROCEDURE_CODE', 'COMMODITY_SCOPE', 'IMEIS_VALID_UNIQUE', 'DECLARATION_TEXT', 'UNIT_VALUES_PRESENT', 'TOTALS_CONSISTENT', 'LOGISTICS_COMPLETE']) {
      expect(codes).toContain(code)
    }
  })
})

describe('documents — invoice, scan-out, pre-alert', () => {
  let shipmentId = 0
  const values = [150, 249.99, 88.5]

  beforeAll(async () => {
    const shipment = await makeShipment()
    shipmentId = shipment.id
    for (const v of values) {
      const device = await makeDevice({ buy_price: v })
      const res = await api(`/api/opr/shipments/${shipmentId}/scan`, {
        method: 'POST', body: JSON.stringify({ imei: device.imei }),
      })
      expect(res.status).toBe(201)
    }
  })

  it('scan-out list totals the frozen line values pence-exactly', async () => {
    const res = await api(`/api/opr/shipments/${shipmentId}/scan-out`)
    expect(res.status).toBe(200)
    const { scan_out } = await res.json() as { scan_out: { unit_count: number; total_value: number; lines: Array<{ imei: string; unit_value: number }> } }
    expect(scan_out.unit_count).toBe(3)
    expect(scan_out.total_value).toBe(488.49) // 150 + 249.99 + 88.5
  })

  it('invoice HTML carries the customs facts and the SAME total as the scan-out list', async () => {
    const res = await api(`/api/opr/shipments/${shipmentId}/invoice`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const html = await res.text()

    expect(html).toContain('COMMERCIAL INVOICE')
    expect(html).toContain('GBOPO36997999500020260226105539') // CDS number, never the CHIEF one
    expect(html).not.toContain('OP/0922/601/31')              // CHIEF number is for the C&E1154 (OPR 3)
    expect(html).toContain('2100')
    expect(html).toContain('8517130000')
    expect(html).toContain('£488.49')
    expect(html).toContain('Outward Processing')

    // Every frozen IMEI appears on the invoice.
    const { scan_out } = await (await api(`/api/opr/shipments/${shipmentId}/scan-out`)).json() as { scan_out: { lines: Array<{ imei: string }> } }
    for (const line of scan_out.lines) expect(html).toContain(line.imei)
  })

  it('invoice on a line-less shipment → 422', async () => {
    const empty = await makeShipment()
    const res = await api(`/api/opr/shipments/${empty.id}/invoice`)
    expect(res.status).toBe(422)
  })

  it('pre-alert draft uses the mailbox + cut-off configured on the authorisation (data, not code)', async () => {
    const res = await api(`/api/opr/shipments/${shipmentId}/prealert`)
    expect(res.status).toBe(200)
    const { prealert } = await res.json() as { prealert: { to: string; to_configured: boolean; cutoff: string; subject: string; body: string; note: string } }
    expect(prealert.to).toBe('controlprealert@fedex.com')
    expect(prealert.to_configured).toBe(true)
    expect(prealert.cutoff).toBe('16:00')
    expect(prealert.subject).toContain('3 unit(s)')
    expect(prealert.body).toContain('£488.49')
    expect(prealert.body).toContain('GBOPO36997999500020260226105539')
    expect(prealert.note).toMatch(/no email is sent/i)
  })

  it('pre-alert flags an unconfigured mailbox instead of inventing one', async () => {
    const createAuth = await api('/api/opr/authorisations', {
      method: 'POST',
      body: JSON.stringify({
        holder_name: 'No Prealert Ltd', eori: 'GB111111111000',
        cds_number: `GBOPO-NOPREALERT-${Date.now()}`.replace(/-/g, ''),
        valid_from: '2026-01-01', valid_to: '2030-12-31',
      }),
    })
    expect(createAuth.status).toBe(201)
    const bareAuthId = ((await createAuth.json()) as { authorisation: { id: number } }).authorisation.id
    const shipment = await makeShipment({ authorisation_id: bareAuthId })
    const res = await api(`/api/opr/shipments/${shipment.id}/prealert`)
    const { prealert } = await res.json() as { prealert: { to: string | null; to_configured: boolean } }
    expect(prealert.to).toBeNull()
    expect(prealert.to_configured).toBe(false)
  })
})

describe('finalisation', () => {
  it('red validation blocks finalisation with zero side-effects', async () => {
    const shipment = await makeShipment() // no lines → SHIP_HAS_LINES red
    const res = await api(`/api/opr/shipments/${shipment.id}/finalise`, {
      method: 'POST', body: JSON.stringify({ export_mrn: '26GB1234567890123' }),
    })
    expect(res.status).toBe(422)
    const data = await res.json() as { error: string; validation: { result: string } }
    expect(data.validation.result).toBe('red')

    const row = await env.DB.prepare('SELECT status, export_mrn, finalised_at FROM shipments WHERE id = ?')
      .bind(shipment.id).first<{ status: string; export_mrn: string | null; finalised_at: string | null }>()
    expect(row!.status).toBe('DRAFT')
    expect(row!.export_mrn).toBeNull()
    expect(row!.finalised_at).toBeNull()
  })

  it('happy path: locks the shipment, devices → EXPORTED_UNDER_OPR (event-logged), proof refs captured; amber does not block', async () => {
    // No ship_date → AUTH_VALID_ON_SHIP_DATE is amber: proves amber passes.
    const shipment = await makeShipment({ ship_date: null })
    const d1 = await makeDevice({ buy_price: 100 })
    const d2 = await makeDevice({ buy_price: 200 })
    for (const d of [d1, d2]) {
      const r = await api(`/api/opr/shipments/${shipment.id}/scan`, { method: 'POST', body: JSON.stringify({ imei: d.imei }) })
      expect(r.status).toBe(201)
    }

    const res = await api(`/api/opr/shipments/${shipment.id}/finalise`, {
      method: 'POST',
      body: JSON.stringify({ export_mrn: '26GB1234567890123', ducr: '6GB369979995000-EXP001' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { shipment: Record<string, unknown>; devices_exported: number; validation: { result: string } }
    expect(data.shipment.status).toBe('FINALISED')
    expect(data.shipment.export_mrn).toBe('26GB1234567890123')
    expect(data.shipment.ducr).toBe('6GB369979995000-EXP001')
    expect(data.shipment.finalised_at).toBeTruthy()
    expect(data.shipment.finalised_by_user_id).toBe(1)
    expect(data.devices_exported).toBe(2)
    expect(data.validation.result).toBe('amber')

    for (const d of [d1, d2]) {
      expect(await deviceStatus(d.id)).toBe('EXPORTED_UNDER_OPR')
      const ev = await latestEvent(d.id)
      expect(ev!.event_type).toBe('EXPORT_FINALISED')
      expect(JSON.parse(String(ev!.metadata)).export_mrn).toBe('26GB1234567890123')
    }

    // FINALISED is locked: no re-finalise, no line changes, no PATCH…
    expect((await api(`/api/opr/shipments/${shipment.id}/finalise`, { method: 'POST', body: '{}' })).status).toBe(409)
    const d3 = await makeDevice()
    expect((await api(`/api/opr/shipments/${shipment.id}/scan`, { method: 'POST', body: JSON.stringify({ imei: d3.imei }) })).status).toBe(409)
    expect((await api(`/api/opr/shipments/${shipment.id}`, { method: 'PATCH', body: JSON.stringify({ carrier: 'DHL' }) })).status).toBe(409)

    // …but export-proof updates ARE accepted (the one allowed mutation).
    const proof = await api(`/api/opr/shipments/${shipment.id}/export-proof`, {
      method: 'POST', body: JSON.stringify({ ead_mrn: '26GB9999888877776' }),
    })
    expect(proof.status).toBe(200)
    const updated = await proof.json() as { shipment: Record<string, unknown> }
    expect(updated.shipment.ead_mrn).toBe('26GB9999888877776')
    expect(updated.shipment.export_mrn).toBe('26GB1234567890123') // untouched

    // Exported devices are terminal for the generic endpoint too.
    const pull = await api(`/api/devices/${d1.id}/transition`, {
      method: 'POST', body: JSON.stringify({ to_status: 'SORTING' }),
    })
    expect(pull.status).toBe(409)
  })

  it('export-proof refuses DRAFT shipments and bad charset', async () => {
    const draft = await makeShipment()
    const onDraft = await api(`/api/opr/shipments/${draft.id}/export-proof`, {
      method: 'POST', body: JSON.stringify({ export_mrn: '26GB0001' }),
    })
    expect(onDraft.status).toBe(409)

    // Build a finalisable shipment for the charset check.
    const shipment = await makeShipment()
    const device = await makeDevice()
    await api(`/api/opr/shipments/${shipment.id}/scan`, { method: 'POST', body: JSON.stringify({ imei: device.imei }) })
    const bad = await api(`/api/opr/shipments/${shipment.id}/finalise`, {
      method: 'POST', body: JSON.stringify({ export_mrn: 'MRN;DROP TABLE' }),
    })
    expect(bad.status).toBe(422)
    expect(((await bad.json()) as { error: string }).error).toMatch(/export_mrn/)
    // Blocked before any state change:
    const row = await env.DB.prepare('SELECT status FROM shipments WHERE id = ?').bind(shipment.id).first<{ status: string }>()
    expect(row!.status).toBe('DRAFT')
  })
})

afterAll(async () => {
  // Test hygiene, consistent with the other suites.
  await env.DB.prepare('DELETE FROM shipment_lines').run()
  await env.DB.prepare('DELETE FROM shipments').run()
  await env.DB.prepare('DELETE FROM opr_authorisations').run()
})
