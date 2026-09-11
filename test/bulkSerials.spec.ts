// Step 2A gap (a) — POST /shipments/:id/bulk-serials, D1/HTTP-level.
// Pure classification/parsing logic is covered separately in
// test/bulkSerialImport.spec.ts (no D1). This file exercises the real
// route: the write path (reusing addDeviceToShipment /
// addDeviceToReturnShipment), the D1 batched lookup, and the
// idempotent-resubmission case, which only exists once real
// shipment_lines rows are involved.
//
// IMEI-registry claim (test/browser/README.md, "next free 8604571" as of
// 2026-09-11): this file's fixtures use IMEI prefix `8604571` exclusively
// — distinct from every other suite's range, including
// test/bulkSerialImport.spec.ts, which never writes to received_devices
// and therefore claims no prefix.
import { env } from 'cloudflare:workers'
import { describe, it, expect, beforeAll } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'
import type { Shipment } from '../src/types'

const JWT_SECRET = 'test-secret-bulk-serials'
const testEnv = { ...env, JWT_SECRET } as typeof env & { JWT_SECRET: string }

let token = ''
let authId = 0
let imeiSeq = 0

// Distinct IMEI range from every other suite (base 8604571...). Must be a
// real Luhn-valid 15-digit IMEI — /api/scan/manual enforces the checksum.
function newImei(): string {
  const body = `8604571${String(10000000 + imeiSeq++).slice(1)}`
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
  const imei = newImei()
  const res = await api('/api/scan/manual', {
    method: 'POST',
    body: JSON.stringify({
      imei, brand: 'Samsung', model: 'Galaxy S23', grade: 'A',
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

async function makeExportShipment() {
  const res = await api('/api/opr/shipments', {
    method: 'POST',
    body: JSON.stringify({
      reference: `EXP BULK ${100 + shipmentSeq++}`, direction: 'export', authorisation_id: authId,
      procedure_code: '2100', ship_date: '2026-07-01',
      consignee_name: 'Overseas Repairer BV',
      consignee_address: 'Repairstraat 1, Amsterdam, NL',
      carrier: 'FedEx', incoterm: 'DAP',
    }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { shipment: Shipment }).shipment
}

async function makeFinalisedExport(n: number, mrn: string) {
  const shipment = await makeExportShipment()
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

async function makeReturnShipment(relatedExportId: number) {
  const res = await api('/api/opr/shipments', {
    method: 'POST',
    body: JSON.stringify({
      reference: `IMP BULK ${100 + shipmentSeq++}`, direction: 'import',
      authorisation_id: authId, procedure_code: '6121',
      related_export_shipment_id: relatedExportId,
      ship_date: '2026-09-01',
      repair_cost: 500, repair_cost_currency: 'GBP', duty_rate_pct: 0,
      inbound_freight_gbp: 20, non_eu_freight_share_gbp: 10, export_freight_gbp: 20,
      duty_override_claimed: true,
    }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { shipment: Shipment }).shipment
}

beforeAll(async () => {
  token = await signAuthToken(JWT_SECRET, {
    id: 1, email: 'admin@goodsin.local', name: 'Seed Admin',
    role: 'admin', organisation_id: 1,
  })
  const res = await api('/api/opr/authorisations', {
    method: 'POST',
    body: JSON.stringify({
      holder_name: 'Bulk Serials Test Holder', eori: 'GB999888777666',
      cds_number: 'GBOPO99988877766620260101000000',
      op_authorisation_number: 'OP/9999/888/77',
      valid_from: '2026-01-01', valid_to: '2031-01-01',
      supervising_office_name: 'HMRC S1756 IP-OP Customs Liverpool',
      supervising_office_code: 'GBLIV002',
      commodity_codes: '8517130000', discharge_period_months: 6,
      prealert_email: 'prealert-bulk-test@example.com', prealert_cutoff: '16:00',
    }),
  })
  expect(res.status).toBe(201)
  authId = ((await res.json()) as { authorisation: { id: number } }).authorisation.id
})

describe('POST /shipments/:id/bulk-serials — bare paste', () => {
  it('matches a plain newline-separated list, adds every one, returns explicit matched outcomes', async () => {
    const shipment = await makeExportShipment()
    const d1 = await makeDevice()
    const d2 = await makeDevice()

    const res = await api(`/api/opr/shipments/${shipment.id}/bulk-serials`, {
      method: 'POST',
      body: JSON.stringify({ text: `${d1.imei}\n${d2.imei}` }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { requested: number; added: number; failed: number; results: Array<Record<string, unknown>> }
    expect(body.requested).toBe(2)
    expect(body.added).toBe(2)
    expect(body.failed).toBe(0)
    expect(body.results[0]).toMatchObject({ outcome: 'matched', ok: true })
    expect(body.results[1]).toMatchObject({ outcome: 'matched', ok: true })

    const lines = await env.DB.prepare('SELECT COUNT(*) AS n FROM shipment_lines WHERE shipment_id = ?').bind(shipment.id).first<{ n: number }>()
    expect(lines!.n).toBe(2)
  })

  it('unknown serial gets an explicit unknown outcome, never a silent skip', async () => {
    const shipment = await makeExportShipment()
    const d1 = await makeDevice()

    const res = await api(`/api/opr/shipments/${shipment.id}/bulk-serials`, {
      method: 'POST',
      body: JSON.stringify({ text: `${d1.imei}\nNOT-A-REAL-SERIAL` }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { added: number; failed: number; results: Array<Record<string, unknown>> }
    expect(body.added).toBe(1)
    expect(body.failed).toBe(1)
    expect(body.results[1]).toMatchObject({ outcome: 'unknown', ok: false })
  })

  it('already-sold serial gets already_sold, distinct from a generic already_out', async () => {
    const shipment = await makeExportShipment()
    const d1 = await makeDevice()
    // Force SOLD via the Zoho sale-import direct D1 status write path is
    // out of scope here; use the generic transition endpoint instead —
    // RECEIVED/SORTING/etc all allow -> SOLD per the 2026-09-09 SOLD edge
    // decision, but this device is READY_FOR_EXPORT which also allows
    // -> SOLD directly.
    const t = await api(`/api/devices/${d1.id}/transition`, {
      method: 'POST', body: JSON.stringify({ to_status: 'SOLD' }),
    })
    expect(t.status).toBe(200)

    const res = await api(`/api/opr/shipments/${shipment.id}/bulk-serials`, {
      method: 'POST',
      body: JSON.stringify({ text: d1.imei }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { results: Array<Record<string, unknown>> }
    expect(body.results[0]).toMatchObject({ outcome: 'already_sold', ok: false })
  })

  it('already-out serial (device mid-repair, not SOLD) gets already_out with the real status attached', async () => {
    const shipment = await makeExportShipment()
    const other = await makeExportShipment()
    const d1 = await makeDevice()
    // Put d1 on a DIFFERENT open export consignment (IN_EXPORT_CONSIGNMENT).
    const scan = await api(`/api/opr/shipments/${other.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: d1.imei }),
    })
    expect(scan.status).toBe(201)

    const res = await api(`/api/opr/shipments/${shipment.id}/bulk-serials`, {
      method: 'POST',
      body: JSON.stringify({ text: d1.imei }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { results: Array<Record<string, unknown>> }
    expect(body.results[0]).toMatchObject({ outcome: 'already_out', ok: false, status: 'IN_EXPORT_CONSIGNMENT' })
  })

  it('a duplicate serial within one submission is reported duplicate_in_submission and never double-moved', async () => {
    const shipment = await makeExportShipment()
    const d1 = await makeDevice()

    const res = await api(`/api/opr/shipments/${shipment.id}/bulk-serials`, {
      method: 'POST',
      body: JSON.stringify({ text: `${d1.imei}\n${d1.imei}` }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { added: number; results: Array<Record<string, unknown>> }
    expect(body.added).toBe(1)
    expect(body.results[0]).toMatchObject({ outcome: 'matched', ok: true })
    expect(body.results[1]).toMatchObject({ outcome: 'duplicate_in_submission', ok: false })

    const lines = await env.DB.prepare('SELECT COUNT(*) AS n FROM shipment_lines WHERE shipment_id = ?').bind(shipment.id).first<{ n: number }>()
    expect(lines!.n).toBe(1) // never double-inserted
  })

  it('re-submitting the identical list is idempotent: second call reports already_on_this_shipment, no second line', async () => {
    const shipment = await makeExportShipment()
    const d1 = await makeDevice()

    const first = await api(`/api/opr/shipments/${shipment.id}/bulk-serials`, {
      method: 'POST', body: JSON.stringify({ text: d1.imei }),
    })
    expect(first.status).toBe(200)
    const firstBody = await first.json() as { added: number }
    expect(firstBody.added).toBe(1)

    const second = await api(`/api/opr/shipments/${shipment.id}/bulk-serials`, {
      method: 'POST', body: JSON.stringify({ text: d1.imei }),
    })
    expect(second.status).toBe(200)
    const secondBody = await second.json() as { results: Array<Record<string, unknown>> }
    expect(secondBody.results[0]).toMatchObject({ outcome: 'already_on_this_shipment', ok: true })

    const lines = await env.DB.prepare('SELECT COUNT(*) AS n FROM shipment_lines WHERE shipment_id = ?').bind(shipment.id).first<{ n: number }>()
    expect(lines!.n).toBe(1) // still exactly one line, not two
  })

  it('case-insensitive matching: lowercase input still matches the real (numeric) IMEI', async () => {
    const shipment = await makeExportShipment()
    const d1 = await makeDevice()

    const res = await api(`/api/opr/shipments/${shipment.id}/bulk-serials`, {
      method: 'POST',
      body: JSON.stringify({ text: d1.imei.toLowerCase() }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { added: number }
    expect(body.added).toBe(1)
  })
})

describe('POST /shipments/:id/bulk-serials — column-mapped CSV upload', () => {
  it('extracts the named column from a supplier CSV with extra columns', async () => {
    const shipment = await makeExportShipment()
    const d1 = await makeDevice()
    const d2 = await makeDevice()
    const csv = `Ref,Serial Number,Notes\nA-1,${d1.imei},ok\nA-2,${d2.imei},ok`

    const res = await api(`/api/opr/shipments/${shipment.id}/bulk-serials`, {
      method: 'POST',
      body: JSON.stringify({ text: csv, serial_column: 'Serial Number' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { added: number }
    expect(body.added).toBe(2)
  })

  it('an unknown column name is refused with a 422, zero writes', async () => {
    const shipment = await makeExportShipment()
    const csv = 'Ref,Code\nA,1'
    const res = await api(`/api/opr/shipments/${shipment.id}/bulk-serials`, {
      method: 'POST',
      body: JSON.stringify({ text: csv, serial_column: 'Serial Number' }),
    })
    expect(res.status).toBe(422)
  })
})

describe('POST /shipments/:id/bulk-serials — import (return) shipments', () => {
  it('works through the return gates: EXPORTED_UNDER_OPR devices match; status does not move while DRAFT', async () => {
    const { shipment: exp, devices } = await makeFinalisedExport(2, '26GB99999999999901')
    const imp = await makeReturnShipment(exp.id)

    const res = await api(`/api/opr/shipments/${imp.id}/bulk-serials`, {
      method: 'POST',
      body: JSON.stringify({ text: devices.map(d => d.imei).join('\n') }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { added: number }
    expect(body.added).toBe(2)

    for (const d of devices) {
      const row = await env.DB.prepare('SELECT status FROM received_devices WHERE id = ?').bind(d.id).first<{ status: string }>()
      expect(row!.status).toBe('EXPORTED_UNDER_OPR') // unchanged while DRAFT
    }
  })
})

describe('POST /shipments/:id/bulk-serials — standing hard requirements', () => {
  it('no money column is ever written by this endpoint (sold_price_pence / credit_value_pence stay untouched)', async () => {
    const shipment = await makeExportShipment()
    const d1 = await makeDevice()

    await api(`/api/opr/shipments/${shipment.id}/bulk-serials`, {
      method: 'POST', body: JSON.stringify({ text: d1.imei }),
    })

    const row = await env.DB.prepare('SELECT sold_price_pence, credit_value_pence, buy_price FROM received_devices WHERE id = ?').bind(d1.id).first<{ sold_price_pence: number | null; credit_value_pence: number | null; buy_price: number }>()
    expect(row!.sold_price_pence).toBeNull()
    expect(row!.credit_value_pence).toBeNull()
    expect(row!.buy_price).toBe(150) // cost basis (buy_price) untouched on the way out
  })

  it('grade is captured per line, frozen at the device grade at add-time', async () => {
    const shipment = await makeExportShipment()
    const d1 = await makeDevice({ grade: 'B' })

    await api(`/api/opr/shipments/${shipment.id}/bulk-serials`, {
      method: 'POST', body: JSON.stringify({ text: d1.imei }),
    })

    const line = await env.DB.prepare('SELECT grade FROM shipment_lines WHERE shipment_id = ? AND received_device_id = ?').bind(shipment.id, d1.id).first<{ grade: string }>()
    expect(line!.grade).toBe('B')
  })

  it('rejects a non-DRAFT shipment (409, same gate as single /scan)', async () => {
    const { shipment } = await makeFinalisedExport(1, '26GB99999999999902')
    const res = await api(`/api/opr/shipments/${shipment.id}/bulk-serials`, {
      method: 'POST', body: JSON.stringify({ text: '860457199999999' }),
    })
    expect(res.status).toBe(409)
  })

  it('caps the submission and rejects a malformed body', async () => {
    const shipment = await makeExportShipment()
    const tooMany = Array.from({ length: 501 }, (_, i) => String(100000000000000 + i)).join('\n')
    const res = await api(`/api/opr/shipments/${shipment.id}/bulk-serials`, {
      method: 'POST', body: JSON.stringify({ text: tooMany }),
    })
    expect(res.status).toBe(422)

    const bad = await api(`/api/opr/shipments/${shipment.id}/bulk-serials`, {
      method: 'POST', body: JSON.stringify({ notText: 'wrong shape' }),
    })
    expect(bad.status).toBe(422)
  })
})
