// OPR 1 (Foundation) invariants — authorisations, shipments, line snapshots.
//
// The load-bearing assertions, mirroring the goods-in valuation discipline:
//   - GBP-only currency on shipments; 'UKL' rejected with the CHIEF-era
//     explanation; every rejection has zero side-effects.
//   - Procedure-code validation incl. the forbidden 2100+B51 combination.
//   - Declaration charset (letters/numbers/spaces) on reference/consignee.
//   - Authorisation linkage mandatory; cross-org authorisations rejected.
//   - Line snapshots FROZEN: mutating the device after adding a line must
//     not change the line. Devices without buy_price cannot be added.
import { env } from 'cloudflare:workers'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'

const JWT_SECRET = 'test-secret-opr-foundation'
const testEnv = { ...env, JWT_SECRET } as typeof env & { JWT_SECRET: string }

let token = ''
let authId = 0

// Distinct IMEI range from other suites (base 86045490...) to avoid UNIQUE
// collisions if files ever share a D1 instance.
let imeiSeq = 0
function luhnImei(): string {
  const body = `8604549${String(10000000 + imeiSeq++).slice(1)}`
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

async function makeDevice(overrides: Record<string, unknown> = {}) {
  const res = await api('/api/scan/manual', {
    method: 'POST',
    body: JSON.stringify({
      imei: luhnImei(), brand: 'Samsung', model: 'Galaxy S23', grade: 'A',
      buy_price: 120, vat_type: 'MARGIN', currency: 'GBP',
      ...overrides,
    }),
  })
  expect(res.status).toBe(200)
  const data = await res.json() as { received: { id: number; imei: string } }
  return data.received
}

const VALID_AUTH = {
  holder_name: 'Saigates Limited',
  eori: 'GB369979995000',
  cds_number: 'GBOPO36997999500020260226105539',
  chief_number: 'OP/0922/601/31',
  valid_from: '2026-03-01',
  valid_to: '2031-02-28',
  supervising_office_code: 'GBNCL001',
  commodity_codes: '8517130000',
}

beforeAll(async () => {
  token = await signAuthToken(JWT_SECRET, {
    id: 1, email: 'admin@goodsin.local', name: 'Seed Admin',
    role: 'admin', organisation_id: 1,
  })
  // Baseline authorisation used by shipment tests.
  const res = await api('/api/opr/authorisations', { method: 'POST', body: JSON.stringify(VALID_AUTH) })
  expect(res.status).toBe(201)
  const data = await res.json() as { authorisation: { id: number } }
  authId = data.authorisation.id
})

async function shipmentCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM shipments').first<{ n: number }>()
  return row!.n
}

describe('authorisations', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await app.request('/api/opr/authorisations', {}, testEnv)
    expect(res.status).toBe(401)
  })

  it('stores CDS and CHIEF numbers as distinct fields', async () => {
    const res = await api(`/api/opr/authorisations/${authId}`)
    expect(res.status).toBe(200)
    const { authorisation } = await res.json() as { authorisation: Record<string, unknown> }
    expect(authorisation.cds_number).toBe('GBOPO36997999500020260226105539')
    expect(authorisation.chief_number).toBe('OP/0922/601/31')
    expect(authorisation.cds_number).not.toBe(authorisation.chief_number)
    expect(authorisation.rate_of_yield).toBe('1:1')
    expect(authorisation.discharge_period_months).toBe(6)
  })

  it('422 on invalid EORI', async () => {
    const res = await api('/api/opr/authorisations', {
      method: 'POST',
      body: JSON.stringify({ ...VALID_AUTH, cds_number: 'X1', eori: 'not-an-eori!' }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toMatch(/EORI/i)
  })

  it('422 on missing cds_number', async () => {
    const res = await api('/api/opr/authorisations', {
      method: 'POST',
      body: JSON.stringify({ ...VALID_AUTH, cds_number: '' }),
    })
    expect(res.status).toBe(422)
  })

  it('422 on inverted validity dates', async () => {
    const res = await api('/api/opr/authorisations', {
      method: 'POST',
      body: JSON.stringify({ ...VALID_AUTH, cds_number: 'X2', valid_from: '2031-01-01', valid_to: '2026-01-01' }),
    })
    expect(res.status).toBe(422)
  })

  it('409 on duplicate CDS number', async () => {
    const res = await api('/api/opr/authorisations', { method: 'POST', body: JSON.stringify(VALID_AUTH) })
    expect(res.status).toBe(409)
  })
})

describe('shipments — GBP-only currency', () => {
  const base = () => ({
    reference: `EXP TEST ${Math.random().toString(36).slice(2, 8).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`,
    direction: 'export', authorisation_id: authId, procedure_code: '2100',
  })

  it("rejects 'UKL' with the CHIEF-era explanation, zero side-effects", async () => {
    const before = await shipmentCount()
    const res = await api('/api/opr/shipments', {
      method: 'POST', body: JSON.stringify({ ...base(), currency: 'UKL' }),
    })
    expect(res.status).toBe(422)
    const { error } = await res.json() as { error: string }
    expect(error).toMatch(/UKL/)
    expect(error).toMatch(/CHIEF/i)
    expect(await shipmentCount()).toBe(before)
  })

  it('rejects any non-GBP ISO code (EUR)', async () => {
    const before = await shipmentCount()
    const res = await api('/api/opr/shipments', {
      method: 'POST', body: JSON.stringify({ ...base(), currency: 'EUR' }),
    })
    expect(res.status).toBe(422)
    expect(await shipmentCount()).toBe(before)
  })

  it("accepts lowercase 'gbp' and normalises, defaults empty to GBP", async () => {
    const res = await api('/api/opr/shipments', {
      method: 'POST', body: JSON.stringify({ ...base(), currency: 'gbp' }),
    })
    expect(res.status).toBe(201)
    const { shipment } = await res.json() as { shipment: Record<string, unknown> }
    expect(shipment.currency).toBe('GBP')

    const res2 = await api('/api/opr/shipments', { method: 'POST', body: JSON.stringify(base()) })
    expect(res2.status).toBe(201)
    expect(((await res2.json()) as { shipment: Record<string, unknown> }).shipment.currency).toBe('GBP')
  })
})

describe('shipments — procedure codes', () => {
  const base = (extra: Record<string, unknown>) => ({
    reference: `PROC ${Math.random().toString(36).slice(2, 8).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`,
    direction: 'export', authorisation_id: authId, ...extra,
  })

  it('rejects the forbidden 2100+B51 combination', async () => {
    const before = await shipmentCount()
    const res = await api('/api/opr/shipments', {
      method: 'POST',
      body: JSON.stringify(base({ procedure_code: '2100', additional_procedure_code: 'B51' })),
    })
    expect(res.status).toBe(422)
    const { error } = await res.json() as { error: string }
    expect(error).toMatch(/2100/)
    expect(error).toMatch(/B51/)
    expect(await shipmentCount()).toBe(before)
  })

  it('accepts warranty 2200+B51 and 2200+B02', async () => {
    for (const apc of ['B51', 'B02']) {
      const res = await api('/api/opr/shipments', {
        method: 'POST',
        body: JSON.stringify(base({ procedure_code: '2200', additional_procedure_code: apc })),
      })
      expect(res.status).toBe(201)
      const { shipment } = await res.json() as { shipment: Record<string, unknown> }
      expect(shipment.procedure_code).toBe('2200')
      expect(shipment.additional_procedure_code).toBe(apc)
    }
  })

  it('rejects import procedure code on an export shipment and vice versa', async () => {
    const res = await api('/api/opr/shipments', {
      method: 'POST', body: JSON.stringify(base({ procedure_code: '6121' })),
    })
    expect(res.status).toBe(422)

    const res2 = await api('/api/opr/shipments', {
      method: 'POST',
      body: JSON.stringify({ ...base({ procedure_code: '2100' }), direction: 'import' }),
    })
    expect(res2.status).toBe(422)
  })

  it('accepts import with 6121', async () => {
    const res = await api('/api/opr/shipments', {
      method: 'POST',
      body: JSON.stringify({ ...base({ procedure_code: '6121' }), direction: 'import' }),
    })
    expect(res.status).toBe(201)
  })

  it('rejects unknown additional procedure code', async () => {
    const res = await api('/api/opr/shipments', {
      method: 'POST',
      body: JSON.stringify(base({ procedure_code: '2200', additional_procedure_code: 'Z99' })),
    })
    expect(res.status).toBe(422)
  })
})

describe('shipments — declaration charset & linkage', () => {
  it('rejects punctuation in reference (declaration charset)', async () => {
    const before = await shipmentCount()
    const res = await api('/api/opr/shipments', {
      method: 'POST',
      body: JSON.stringify({ reference: 'EXP-001!', direction: 'export', authorisation_id: authId, procedure_code: '2100' }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toMatch(/letters, numbers and spaces/)
    expect(await shipmentCount()).toBe(before)
  })

  it('rejects punctuation in consignee_name', async () => {
    const res = await api('/api/opr/shipments', {
      method: 'POST',
      body: JSON.stringify({
        reference: 'CHARSET OK 1', direction: 'export', authorisation_id: authId,
        procedure_code: '2100', consignee_name: 'Repairer & Co.',
      }),
    })
    expect(res.status).toBe(422)
  })

  it('422 when authorisation_id missing or non-existent', async () => {
    const res = await api('/api/opr/shipments', {
      method: 'POST',
      body: JSON.stringify({ reference: 'NO AUTH 1', direction: 'export', procedure_code: '2100' }),
    })
    expect(res.status).toBe(422)
    const res2 = await api('/api/opr/shipments', {
      method: 'POST',
      body: JSON.stringify({ reference: 'NO AUTH 2', direction: 'export', authorisation_id: 999999, procedure_code: '2100' }),
    })
    expect(res2.status).toBe(422)
  })

  it('409 on duplicate reference within org', async () => {
    const body = { reference: 'DUP REF 1', direction: 'export', authorisation_id: authId, procedure_code: '2100' }
    const res1 = await api('/api/opr/shipments', { method: 'POST', body: JSON.stringify(body) })
    expect(res1.status).toBe(201)
    const res2 = await api('/api/opr/shipments', { method: 'POST', body: JSON.stringify(body) })
    expect(res2.status).toBe(409)
  })
})

describe('shipment lines — frozen snapshots', () => {
  let shipmentId = 0

  beforeAll(async () => {
    const res = await api('/api/opr/shipments', {
      method: 'POST',
      body: JSON.stringify({ reference: 'SNAPSHOT SHIP 1', direction: 'export', authorisation_id: authId, procedure_code: '2100' }),
    })
    expect(res.status).toBe(201)
    shipmentId = ((await res.json()) as { shipment: { id: number } }).shipment.id
  })

  it('snapshots value/attributes at add time; later device edits do NOT leak in', async () => {
    const device = await makeDevice({ buy_price: 250.5, grade: 'B' })

    const addRes = await api(`/api/opr/shipments/${shipmentId}/lines`, {
      method: 'POST', body: JSON.stringify({ device_id: device.id }),
    })
    expect(addRes.status).toBe(201)
    const { line } = await addRes.json() as { line: Record<string, unknown> }
    expect(line.unit_value).toBe(250.5)
    expect(line.grade).toBe('B')
    expect(line.imei).toBe(device.imei)
    expect(line.currency).toBe('GBP')

    // Mutate the device AFTER the snapshot — the declared truth must not move.
    await env.DB.prepare('UPDATE received_devices SET buy_price = 999.99, grade = ? WHERE id = ?')
      .bind('A', device.id).run()

    const after = await env.DB.prepare('SELECT unit_value, grade FROM shipment_lines WHERE id = ?')
      .bind(line.id).first<{ unit_value: number; grade: string }>()
    expect(after!.unit_value).toBe(250.5)
    expect(after!.grade).toBe('B')
  })

  it('rejects devices with no buy_price — no line created', async () => {
    const device = await makeDevice({ buy_price: 10 })
    await env.DB.prepare('UPDATE received_devices SET buy_price = NULL WHERE id = ?').bind(device.id).run()

    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM shipment_lines').first<{ n: number }>()
    const res = await api(`/api/opr/shipments/${shipmentId}/lines`, {
      method: 'POST', body: JSON.stringify({ device_id: device.id }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toMatch(/buy_price/)
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM shipment_lines').first<{ n: number }>()
    expect(after!.n).toBe(before!.n)
  })

  it('409 when adding the same device twice', async () => {
    const device = await makeDevice()
    const r1 = await api(`/api/opr/shipments/${shipmentId}/lines`, {
      method: 'POST', body: JSON.stringify({ device_id: device.id }),
    })
    expect(r1.status).toBe(201)
    const r2 = await api(`/api/opr/shipments/${shipmentId}/lines`, {
      method: 'POST', body: JSON.stringify({ device_id: device.id }),
    })
    expect(r2.status).toBe(409)
  })

  it('non-DRAFT shipments refuse line changes (409)', async () => {
    // Simulate finalisation directly (the finalisation WORKFLOW is OPR 2;
    // the invariant that non-DRAFT is immutable belongs to the foundation).
    await env.DB.prepare("UPDATE shipments SET status = 'FINALISED' WHERE id = ?").bind(shipmentId).run()
    const device = await makeDevice()
    const res = await api(`/api/opr/shipments/${shipmentId}/lines`, {
      method: 'POST', body: JSON.stringify({ device_id: device.id }),
    })
    expect(res.status).toBe(409)

    const patch = await api(`/api/opr/shipments/${shipmentId}`, {
      method: 'PATCH', body: JSON.stringify({ carrier: 'FedEx' }),
    })
    expect(patch.status).toBe(409)
    // restore for cleanliness
    await env.DB.prepare("UPDATE shipments SET status = 'DRAFT' WHERE id = ?").bind(shipmentId).run()
  })

  it('shipment detail returns lines + authorisation + total', async () => {
    const res = await api(`/api/opr/shipments/${shipmentId}`)
    expect(res.status).toBe(200)
    const data = await res.json() as {
      shipment: Record<string, unknown>
      lines: Array<Record<string, unknown>>
      authorisation: Record<string, unknown>
      total_value: number
    }
    expect(data.lines.length).toBeGreaterThan(0)
    expect(data.authorisation.cds_number).toBe('GBOPO36997999500020260226105539')
    const sum = data.lines.reduce((s, l) => s + Number(l.unit_value), 0)
    expect(data.total_value).toBeCloseTo(sum, 2)
  })

  it('lines can be removed while DRAFT', async () => {
    const device = await makeDevice()
    const add = await api(`/api/opr/shipments/${shipmentId}/lines`, {
      method: 'POST', body: JSON.stringify({ device_id: device.id }),
    })
    const { line } = await add.json() as { line: { id: number } }
    const del = await api(`/api/opr/shipments/${shipmentId}/lines/${line.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
  })
})

describe('tenancy', () => {
  it("another org's token cannot see or use org 1's authorisation", async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO organisations (id, name, slug) VALUES (2, 'Other Org', 'other')").run()
    const otherToken = await signAuthToken(JWT_SECRET, {
      id: 999, email: 'other@example.com', name: 'Other', role: 'admin', organisation_id: 2,
    })
    const list = await app.request('/api/opr/authorisations', {
      headers: { Authorization: `Bearer ${otherToken}` },
    }, testEnv)
    expect(list.status).toBe(200)
    expect(((await list.json()) as { authorisations: unknown[] }).authorisations.length).toBe(0)

    const create = await app.request('/api/opr/shipments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${otherToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: 'XORG 1', direction: 'export', authorisation_id: authId, procedure_code: '2100' }),
    }, testEnv)
    expect(create.status).toBe(422) // authorisation not visible cross-org
  })
})

afterAll(async () => {
  // Test hygiene: remove everything this suite created (fresh in-test D1,
  // but keep the discipline consistent with the other suites).
  await env.DB.prepare('DELETE FROM shipment_lines').run()
  await env.DB.prepare('DELETE FROM shipments').run()
  await env.DB.prepare('DELETE FROM opr_authorisations').run()
})
