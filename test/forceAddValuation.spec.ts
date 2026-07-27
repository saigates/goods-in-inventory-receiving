// Force-add valuation enforcement (server-side, through the real route).
//
// The force-add path for off-manifest devices is the exception branch of
// goods-in and therefore the likeliest place for a required-field bypass to
// hide. These tests prove — against the REAL Hono app + REAL D1 binding with
// all migrations applied, not mocks — that POST /api/scan/force-add cannot
// create a device without a valid buy_price, vat_type, and valid-ISO
// currency: the same server-side rules the manifest-matched /confirm path
// enforces.
//
// Every rejection case also asserts the negative side-effects: no
// received_devices row, no FORCE_ADD device_events row, no print job — a 422
// that still wrote rows would be a worse bug than the missing validation.
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'
import type { AuthUser } from '../src/types'

const JWT_SECRET = 'test-only-secret'

// Bindings handed to app.request(). DB is the real per-test-file D1 binding
// (migrations already applied via test/apply-migrations.ts); JWT_SECRET is
// injected here so the test controls the signing key.
const testEnv = () => ({ ...(env as unknown as Record<string, unknown>), JWT_SECRET })

const db = () => (env as unknown as { DB: D1Database }).DB

// Matches the admin user seeded by migration 0008.
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

// Luhn-valid 15-digit IMEIs, allocated sequentially so tests never collide
// on the received_devices.imei UNIQUE constraint.
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
let imeiSeq = 49015420000000
function nextImei(): string {
  const body = String(imeiSeq++).padStart(14, '0')
  return body + luhnCheckDigit(body)
}

async function postForceAdd(body: Record<string, unknown>, opts: { auth?: boolean } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.auth !== false) headers['Authorization'] = `Bearer ${token}`
  const res = await app.request(
    '/api/scan/force-add',
    { method: 'POST', headers, body: JSON.stringify(body) },
    testEnv(),
  )
  const json = (await res.json().catch(() => ({}))) as Record<string, any>
  return { res, json }
}

async function deviceByImei(imei: string) {
  return db()
    .prepare('SELECT * FROM received_devices WHERE imei = ?')
    .bind(imei)
    .first<Record<string, any>>()
}

async function forceAddEventsForImei(imei: string) {
  // FORCE_ADD events are keyed by device_id; if no device exists there can
  // be no event, but also guard against an orphaned event via metadata.
  const { results } = await db()
    .prepare(
      `SELECT de.* FROM device_events de
       JOIN received_devices rd ON rd.id = de.device_id
       WHERE de.event_type = 'FORCE_ADD' AND rd.imei = ?`
    )
    .bind(imei)
    .all<Record<string, any>>()
  return results
}

const VALID_BASE = { oem: 'APPL', description: 'iPhone 14 Pro 256GB', grade: 'B', color: 'Silver' }

describe('POST /api/scan/force-add — auth is still required on the exception branch', () => {
  it('rejects an unauthenticated force-add with 401 and creates nothing', async () => {
    const imei = nextImei()
    const { res } = await postForceAdd(
      { imei, ...VALID_BASE, buy_price: 100, currency: 'GBP', vat_type: 'MARGIN' },
      { auth: false },
    )
    expect(res.status).toBe(401)
    expect(await deviceByImei(imei)).toBeNull()
  })
})

describe('POST /api/scan/force-add — buy_price is required and validated', () => {
  it('rejects a force-add with buy_price missing entirely (422, no device row)', async () => {
    const imei = nextImei()
    const { res, json } = await postForceAdd({ imei, ...VALID_BASE, vat_type: 'MARGIN' })
    expect(res.status).toBe(422)
    expect(json.error).toMatch(/buy_price is required/i)
    expect(await deviceByImei(imei)).toBeNull()
  })

  it('rejects buy_price as an empty string (422, no device row)', async () => {
    const imei = nextImei()
    const { res, json } = await postForceAdd({ imei, ...VALID_BASE, buy_price: '', vat_type: 'MARGIN' })
    expect(res.status).toBe(422)
    expect(json.error).toMatch(/buy_price is required/i)
    expect(await deviceByImei(imei)).toBeNull()
  })

  it.each([
    ['negative number', -5],
    ['non-numeric string', 'free'],
    ['NaN string', 'NaN'],
  ])('rejects invalid buy_price (%s) with 422 and no device row', async (_label, bad) => {
    const imei = nextImei()
    const { res } = await postForceAdd({ imei, ...VALID_BASE, buy_price: bad, vat_type: 'MARGIN' })
    expect(res.status).toBe(422)
    expect(await deviceByImei(imei)).toBeNull()
  })
})

describe('POST /api/scan/force-add — vat_type is required and validated', () => {
  it('rejects a force-add with vat_type missing (422, no device row)', async () => {
    const imei = nextImei()
    const { res, json } = await postForceAdd({ imei, ...VALID_BASE, buy_price: 120.5 })
    expect(res.status).toBe(422)
    expect(json.error).toMatch(/vat_type is required/i)
    expect(await deviceByImei(imei)).toBeNull()
  })

  it.each(['REDUCED', 'margin scheme', '20%', 'YES'])(
    'rejects invalid vat_type %s with 422 and no device row',
    async (bad) => {
      const imei = nextImei()
      const { res, json } = await postForceAdd({ imei, ...VALID_BASE, buy_price: 120.5, vat_type: bad })
      expect(res.status).toBe(422)
      expect(json.error).toMatch(/MARGIN, STANDARD, ZERO/)
      expect(await deviceByImei(imei)).toBeNull()
    }
  )
})

describe('POST /api/scan/force-add — currency must be a valid ISO 4217 code', () => {
  it('rejects "UKL" (typo for GBP) with 422 and no device row', async () => {
    const imei = nextImei()
    const { res, json } = await postForceAdd({
      imei, ...VALID_BASE, buy_price: 99.99, currency: 'UKL', vat_type: 'STANDARD',
    })
    expect(res.status).toBe(422)
    expect(json.error).toMatch(/not a valid ISO 4217 code/i)
    expect(await deviceByImei(imei)).toBeNull()
  })

  it.each(['ZZZ', 'GB', 'GBPX', '123', '£'])(
    'rejects junk currency %s with 422 and no device row',
    async (junk) => {
      const imei = nextImei()
      const { res } = await postForceAdd({
        imei, ...VALID_BASE, buy_price: 99.99, currency: junk, vat_type: 'STANDARD',
      })
      expect(res.status).toBe(422)
      expect(await deviceByImei(imei)).toBeNull()
    }
  )

  // Case-insensitive-by-design: matches isValidCurrency()/normalizeCurrency()
  // (see the NOTE in test/validate.spec.ts — confirmed as intended behaviour).
  it('accepts lowercase "gbp" and stores the normalised "GBP"', async () => {
    const imei = nextImei()
    const { res, json } = await postForceAdd({
      imei, ...VALID_BASE, buy_price: 42, currency: 'gbp', vat_type: 'ZERO',
    })
    expect(res.status).toBe(200)
    expect(json.received.currency).toBe('GBP')
  })
})

describe('POST /api/scan/force-add — a fully valid payload succeeds with full audit trail', () => {
  it('creates the device with valuation persisted, plus FORCE_ADD event carrying the valuation', async () => {
    const imei = nextImei()
    const { res, json } = await postForceAdd({
      imei, ...VALID_BASE, buy_price: '150.25', currency: 'EUR', vat_type: 'margin', notes: 'test force-add',
    })
    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)

    const device = await deviceByImei(imei)
    expect(device).not.toBeNull()
    expect(device!.source).toBe('unreconciled')
    expect(device!.status).toBe('RECEIVED')
    expect(device!.buy_price).toBe(150.25)
    expect(device!.currency).toBe('EUR')
    expect(device!.vat_type).toBe('MARGIN') // normalised to uppercase

    const events = await forceAddEventsForImei(imei)
    expect(events.length).toBe(1)
    expect(events[0].to_status).toBe('RECEIVED')
    expect(events[0].user_id).toBe(ADMIN.id)
    expect(events[0].organisation_id).toBe(ADMIN.organisation_id)
    const meta = JSON.parse(String(events[0].metadata))
    expect(meta.buy_price).toBe(150.25)
    expect(meta.currency).toBe('EUR')
    expect(meta.vat_type).toBe('MARGIN')
  })

  it('defaults currency to GBP when omitted (buy_price + vat_type still required)', async () => {
    const imei = nextImei()
    const { res, json } = await postForceAdd({
      imei, ...VALID_BASE, buy_price: 10, vat_type: 'ZERO',
    })
    expect(res.status).toBe(200)
    expect(json.received.currency).toBe('GBP')
  })
})

describe('POST /api/scan/force-add — rejected requests leave zero side-effects', () => {
  it('writes no scan_events "received" row and no print job for a 422 rejection', async () => {
    const imei = nextImei()
    const before = await db()
      .prepare("SELECT COUNT(*) AS n FROM print_jobs")
      .first<{ n: number }>()
    const { res } = await postForceAdd({ imei, ...VALID_BASE }) // no valuation at all
    expect(res.status).toBe(422)

    const scanReceived = await db()
      .prepare("SELECT COUNT(*) AS n FROM scan_events WHERE imei = ? AND outcome = 'received'")
      .bind(imei)
      .first<{ n: number }>()
    expect(scanReceived!.n).toBe(0)

    const after = await db()
      .prepare('SELECT COUNT(*) AS n FROM print_jobs')
      .first<{ n: number }>()
    expect(after!.n).toBe(before!.n)
  })
})
