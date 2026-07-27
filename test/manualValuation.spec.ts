// Manual-receive valuation enforcement (server-side, through the real route).
//
// Completes the general rule: EVERY path that creates a device (/confirm,
// /force-add, /manual) enforces the same server-side valuation rules —
// buy_price and vat_type required, currency a valid ISO 4217 code. /manual
// was the last intake branch still on `required: false`; these tests prove,
// against the REAL Hono app + REAL D1 binding (all migrations applied),
// that POST /api/scan/manual can no longer create a valuation-less device.
//
// Mirrors test/forceAddValuation.spec.ts: every rejection also asserts the
// negative side-effects (no received_devices row, no MANUAL_RECEIVE event,
// no scan_events row, no print job).
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'
import type { AuthUser } from '../src/types'

const JWT_SECRET = 'test-only-secret'
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

// Luhn-valid 15-digit IMEIs; distinct base range from the force-add suite
// so parallel test files can't collide on the UNIQUE(imei) constraint.
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
let imeiSeq = 35733110000000
function nextImei(): string {
  const body = String(imeiSeq++).padStart(14, '0')
  return body + luhnCheckDigit(body)
}

async function postManual(body: Record<string, unknown>, opts: { auth?: boolean } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.auth !== false) headers['Authorization'] = `Bearer ${token}`
  const res = await app.request(
    '/api/scan/manual',
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

async function manualEventsForImei(imei: string) {
  const { results } = await db()
    .prepare(
      `SELECT de.* FROM device_events de
       JOIN received_devices rd ON rd.id = de.device_id
       WHERE de.event_type = 'MANUAL_RECEIVE' AND rd.imei = ?`
    )
    .bind(imei)
    .all<Record<string, any>>()
  return results
}

const VALID_BASE = { brand: 'Apple', model: 'iPhone 13', capacity: '128GB', color: 'Silver', grade: 'B', auto_print: false }

describe('POST /api/scan/manual — auth is required', () => {
  it('rejects an unauthenticated manual receive with 401 and creates nothing', async () => {
    const imei = nextImei()
    const { res } = await postManual(
      { imei, ...VALID_BASE, buy_price: 100, currency: 'GBP', vat_type: 'MARGIN' },
      { auth: false },
    )
    expect(res.status).toBe(401)
    expect(await deviceByImei(imei)).toBeNull()
  })
})

describe('POST /api/scan/manual — buy_price is required and validated', () => {
  it('rejects a manual receive with buy_price missing entirely (422, no device row)', async () => {
    const imei = nextImei()
    const { res, json } = await postManual({ imei, ...VALID_BASE, vat_type: 'MARGIN' })
    expect(res.status).toBe(422)
    expect(json.error).toMatch(/buy_price is required/i)
    expect(await deviceByImei(imei)).toBeNull()
  })

  it('rejects buy_price as an empty string (422, no device row)', async () => {
    const imei = nextImei()
    const { res, json } = await postManual({ imei, ...VALID_BASE, buy_price: '', vat_type: 'MARGIN' })
    expect(res.status).toBe(422)
    expect(json.error).toMatch(/buy_price is required/i)
    expect(await deviceByImei(imei)).toBeNull()
  })

  it.each([
    ['negative number', -1],
    ['non-numeric string', 'a tenner'],
    ['NaN string', 'NaN'],
  ])('rejects invalid buy_price (%s) with 422 and no device row', async (_label, bad) => {
    const imei = nextImei()
    const { res } = await postManual({ imei, ...VALID_BASE, buy_price: bad, vat_type: 'MARGIN' })
    expect(res.status).toBe(422)
    expect(await deviceByImei(imei)).toBeNull()
  })
})

describe('POST /api/scan/manual — vat_type is required and validated', () => {
  it('rejects a manual receive with vat_type missing (422, no device row)', async () => {
    const imei = nextImei()
    const { res, json } = await postManual({ imei, ...VALID_BASE, buy_price: 75 })
    expect(res.status).toBe(422)
    expect(json.error).toMatch(/vat_type is required/i)
    expect(await deviceByImei(imei)).toBeNull()
  })

  it.each(['REDUCED', 'vatable', '20'])(
    'rejects invalid vat_type %s with 422 and no device row',
    async (bad) => {
      const imei = nextImei()
      const { res, json } = await postManual({ imei, ...VALID_BASE, buy_price: 75, vat_type: bad })
      expect(res.status).toBe(422)
      expect(json.error).toMatch(/MARGIN, STANDARD, ZERO/)
      expect(await deviceByImei(imei)).toBeNull()
    }
  )
})

describe('POST /api/scan/manual — currency must be a valid ISO 4217 code', () => {
  it('rejects "UKL" (typo for GBP) with 422 and no device row', async () => {
    const imei = nextImei()
    const { res, json } = await postManual({
      imei, ...VALID_BASE, buy_price: 60, currency: 'UKL', vat_type: 'STANDARD',
    })
    expect(res.status).toBe(422)
    expect(json.error).toMatch(/not a valid ISO 4217 code/i)
    expect(await deviceByImei(imei)).toBeNull()
  })

  it.each(['ZZZ', 'GB', 'GBPX', '£'])(
    'rejects junk currency %s with 422 and no device row',
    async (junk) => {
      const imei = nextImei()
      const { res } = await postManual({
        imei, ...VALID_BASE, buy_price: 60, currency: junk, vat_type: 'STANDARD',
      })
      expect(res.status).toBe(422)
      expect(await deviceByImei(imei)).toBeNull()
    }
  )

  // Case-insensitive-by-design (confirmed intended): lowercase valid code
  // passes and is stored normalised. Consistent with the other two paths.
  it('accepts lowercase "eur" and stores the normalised "EUR"', async () => {
    const imei = nextImei()
    const { res, json } = await postManual({
      imei, ...VALID_BASE, buy_price: 33, currency: 'eur', vat_type: 'ZERO',
    })
    expect(res.status).toBe(200)
    expect(json.received.currency).toBe('EUR')
  })
})

describe('POST /api/scan/manual — a fully valid payload succeeds with full audit trail', () => {
  it('creates the device with valuation persisted, plus MANUAL_RECEIVE event carrying the valuation', async () => {
    const imei = nextImei()
    const { res, json } = await postManual({
      imei, ...VALID_BASE, buy_price: '88.80', currency: 'GBP', vat_type: 'standard',
    })
    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)

    const device = await deviceByImei(imei)
    expect(device).not.toBeNull()
    expect(device!.source).toBe('manual')
    expect(device!.status).toBe('RECEIVED')
    expect(device!.buy_price).toBe(88.8)
    expect(device!.currency).toBe('GBP')
    expect(device!.vat_type).toBe('STANDARD') // normalised to uppercase

    const events = await manualEventsForImei(imei)
    expect(events.length).toBe(1)
    expect(events[0].to_status).toBe('RECEIVED')
    expect(events[0].user_id).toBe(ADMIN.id)
    expect(events[0].organisation_id).toBe(ADMIN.organisation_id)
    const meta = JSON.parse(String(events[0].metadata))
    expect(meta.buy_price).toBe(88.8)
    expect(meta.currency).toBe('GBP')
    expect(meta.vat_type).toBe('STANDARD')
  })

  it('defaults currency to GBP when omitted (buy_price + vat_type still required)', async () => {
    const imei = nextImei()
    const { res, json } = await postManual({
      imei, ...VALID_BASE, buy_price: 5, vat_type: 'ZERO',
    })
    expect(res.status).toBe(200)
    expect(json.received.currency).toBe('GBP')
  })
})

describe('POST /api/scan/manual — rejected requests leave zero side-effects', () => {
  it('writes no scan_events row and no print job for a 422 rejection', async () => {
    const imei = nextImei()
    const before = await db()
      .prepare('SELECT COUNT(*) AS n FROM print_jobs')
      .first<{ n: number }>()
    const { res } = await postManual({ imei, ...VALID_BASE, auto_print: true }) // no valuation at all
    expect(res.status).toBe(422)

    const scanRows = await db()
      .prepare('SELECT COUNT(*) AS n FROM scan_events WHERE imei = ?')
      .bind(imei)
      .first<{ n: number }>()
    expect(scanRows!.n).toBe(0)

    const after = await db()
      .prepare('SELECT COUNT(*) AS n FROM print_jobs')
      .first<{ n: number }>()
    expect(after!.n).toBe(before!.n)
  })
})
