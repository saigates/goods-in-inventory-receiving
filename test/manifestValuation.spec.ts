// Manifest-line valuation hints (0015) — optional unit_cost / currency /
// vat_type on manifest upload, stored on expected_devices so the goods-in
// confirm modal can be PRE-FILLED at scan time.
//
// These are HINTS, not the authoritative valuation: /scan/confirm still
// requires buy_price + vat_type on every receive, and the operator's
// confirmed values (not the manifest's) are what land on received_devices.
// These tests prove — against the REAL Hono app + REAL D1 with all
// migrations — that:
//   • valid hints round-trip (currency uppercased, vat_type uppercased)
//   • rows WITHOUT hints still import (columns stay NULL — fully optional)
//   • junk hints reject the ROW (flagged in invalid_valuations) and write
//     NOTHING for that row, while good rows in the same file still import
//   • the scan endpoint returns the hints on the expected line (the SPA's
//     prefill source)
//   • confirm-time values WIN over manifest hints on the created device
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'
import type { AuthUser } from '../src/types'

const JWT_SECRET = 'test-only-secret'
const testEnv = () => ({ ...(env as unknown as Record<string, unknown>), JWT_SECRET })
const db = () => (env as unknown as { DB: D1Database }).DB

const ADMIN: AuthUser = {
  id: 1,
  email: 'admin@goodsin.local',
  name: 'Seed Admin',
  role: 'admin',
  organisation_id: 1,
}

let token: string
beforeAll(async () => {
  token = await signAuthToken(JWT_SECRET, ADMIN)
})

// Luhn-valid IMEIs — namespace 4901543 (force-add uses 4901542).
function luhnCheckDigit(body14: string): string {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    let d = Number(body14[i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return String((10 - (sum % 10)) % 10)
}
let imeiSeq = 49015430000000
function nextImei(): string {
  const body = String(imeiSeq++).padStart(14, '0')
  return body + luhnCheckDigit(body)
}

let refSeq = 1
async function api(method: string, path: string, body?: Record<string, unknown>) {
  const res = await app.request(
    `/api${path}`,
    {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    },
    testEnv(),
  )
  const json = (await res.json().catch(() => ({}))) as Record<string, any>
  return { res, json }
}

async function createManifest(rows: Array<Record<string, unknown>>) {
  return api('POST', '/manifests', {
    reference: `VAL TEST ${refSeq++}`,
    supplier: 'Valuation Test Supplier',
    rows,
  })
}

async function expectedByImei(imei: string) {
  return db()
    .prepare('SELECT * FROM expected_devices WHERE imei = ?')
    .bind(imei)
    .first<Record<string, any>>()
}

const ROW_BASE = { oem: 'Samsung', model_no: 'Galaxy S24', capacity: '256GB', color: 'Black', grade: 'A' }

describe('manifest valuation hints: import + storage', () => {
  it('stores valid unit_cost/currency/vat_type on the expected line (normalised uppercase)', async () => {
    const imei = nextImei()
    const { res, json } = await createManifest([
      { ...ROW_BASE, imei, unit_cost: 199.99, currency: 'usd', vat_type: 'margin' },
    ])
    expect(res.status).toBe(200)
    expect(json.count).toBe(1)
    expect(json.invalid_valuations).toEqual([])
    const line = await expectedByImei(imei)
    expect(line?.unit_cost).toBe(199.99)
    expect(line?.currency).toBe('USD')
    expect(line?.vat_type).toBe('MARGIN')
  })

  it('rows WITHOUT valuation hints still import — columns stay NULL (fully optional)', async () => {
    const imei = nextImei()
    const { res, json } = await createManifest([{ ...ROW_BASE, imei }])
    expect(res.status).toBe(200)
    expect(json.count).toBe(1)
    const line = await expectedByImei(imei)
    expect(line).not.toBeNull()
    expect(line?.unit_cost).toBeNull()
    expect(line?.currency).toBeNull()
    expect(line?.vat_type).toBeNull()
  })

  it('junk currency rejects the ROW (flagged, nothing written) while a good row in the same file imports', async () => {
    const bad = nextImei()
    const good = nextImei()
    const { res, json } = await createManifest([
      { ...ROW_BASE, imei: bad, unit_cost: 100, currency: 'DOLLARS', vat_type: 'MARGIN' },
      { ...ROW_BASE, imei: good, unit_cost: 100, currency: 'USD', vat_type: 'MARGIN' },
    ])
    expect(res.status).toBe(200)
    expect(json.count).toBe(1)
    expect(json.invalid_valuations).toHaveLength(1)
    expect(json.invalid_valuations[0].imei).toBe(bad)
    expect(json.invalid_valuations[0].reason).toContain('ISO 4217')
    expect(await expectedByImei(bad)).toBeNull()
    expect((await expectedByImei(good))?.currency).toBe('USD')
  })

  it('junk vat_type and negative unit_cost each reject their row with a targeted reason', async () => {
    const badVat = nextImei()
    const badPrice = nextImei()
    const { json } = await createManifest([
      { ...ROW_BASE, imei: badVat, vat_type: 'REVERSE_CHARGE' },
      { ...ROW_BASE, imei: badPrice, unit_cost: -5 },
    ])
    expect(json.count).toBe(0)
    expect(json.invalid_valuations).toHaveLength(2)
    const reasons = json.invalid_valuations.map((v: any) => v.reason).join(' | ')
    expect(reasons).toContain('MARGIN, STANDARD, ZERO')
    expect(reasons).toContain('unit_cost')
    expect(await expectedByImei(badVat)).toBeNull()
    expect(await expectedByImei(badPrice)).toBeNull()
  })
})

describe('manifest valuation hints: scan prefill + confirm authority', () => {
  it('scan match returns the hints on expected (the prefill source for the confirm modal)', async () => {
    const imei = nextImei()
    const { json: created } = await createManifest([
      { ...ROW_BASE, imei, unit_cost: 350, currency: 'USD', vat_type: 'STANDARD' },
    ])
    const { res, json } = await api('POST', '/scan', { manifest_id: created.manifest_id, imei })
    expect(res.status).toBe(200)
    expect(json.outcome).toBe('matched')
    expect(json.expected.unit_cost).toBe(350)
    expect(json.expected.currency).toBe('USD')
    expect(json.expected.vat_type).toBe('STANDARD')
  })

  it('confirm-time values WIN over manifest hints — the operator is authoritative', async () => {
    const imei = nextImei()
    const { json: created } = await createManifest([
      { ...ROW_BASE, imei, unit_cost: 350, currency: 'USD', vat_type: 'STANDARD' },
    ])
    const { json: scan } = await api('POST', '/scan', { manifest_id: created.manifest_id, imei })
    expect(scan.outcome).toBe('matched')
    // Ensure a catalog SKU exists to confirm against.
    const { json: cat } = await api('POST', '/catalog', {
      brand: 'Samsung', model: 'Galaxy S24', capacity: '256GB', color: 'Black', grade: 'A',
    })
    const sku = cat.row?.sku ?? cat.sku ?? cat.existing?.sku  // 409 duplicate → reuse existing
    expect(sku).toBeTruthy()
    // Operator overrides the manifest's 350 USD STANDARD with 300 GBP MARGIN.
    const { res, json } = await api('POST', '/scan/confirm', {
      expected_device_id: scan.expected.id, sku,
      buy_price: 300, currency: 'GBP', vat_type: 'MARGIN', auto_print: false,
    })
    expect(res.status).toBe(200)
    const device = await db()
      .prepare('SELECT buy_price, currency, vat_type FROM received_devices WHERE imei = ?')
      .bind(imei).first<Record<string, any>>()
    expect(device?.buy_price).toBe(300)
    expect(device?.currency).toBe('GBP')
    expect(device?.vat_type).toBe('MARGIN')
    // The manifest line is untouched — it still records the supplier's claim.
    const line = await expectedByImei(imei)
    expect(line?.unit_cost).toBe(350)
    expect(line?.currency).toBe('USD')
  })

  it('confirm still REQUIRES valuation even when the manifest carried hints (hints are not a bypass)', async () => {
    const imei = nextImei()
    const { json: created } = await createManifest([
      { ...ROW_BASE, imei, unit_cost: 350, currency: 'USD', vat_type: 'STANDARD' },
    ])
    const { json: scan } = await api('POST', '/scan', { manifest_id: created.manifest_id, imei })
    const { json: cat } = await api('POST', '/catalog', {
      brand: 'Samsung', model: 'Galaxy S24', capacity: '256GB', color: 'Black', grade: 'A',
    })
    const sku = cat.row?.sku ?? cat.sku ?? cat.existing?.sku  // 409 duplicate → reuse existing
    // No buy_price/vat_type in the confirm body — the server must refuse
    // rather than silently fall back to the manifest hint.
    const { res } = await api('POST', '/scan/confirm', {
      expected_device_id: scan.expected.id, sku, auto_print: false,
    })
    expect(res.status).toBe(422)
    const device = await db()
      .prepare('SELECT id FROM received_devices WHERE imei = ?')
      .bind(imei).first()
    expect(device).toBeNull()
  })
})
