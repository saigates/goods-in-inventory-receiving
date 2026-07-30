// Doc-token hardening (2026-07-30) — proves the fix for the `?token=`
// exposure described in src/lib/auth.ts:
//   - a session token can no longer be presented via `?token=` anywhere
//     (previously it worked on ANY /api/* route for its full 12h life —
//     that was the actual exposure: leaked URL = full API access);
//   - POST /api/auth/doc-token mints a separate, short-lived (5 min),
//     `typ:'doc'`-tagged token, and requires the caller to already hold a
//     valid session (it sits behind authMiddleware, not exempt);
//   - a doc token only works via `?token=` on its exact allow-listed
//     paths — rejected via the Authorization header, and rejected via
//     `?token=` on any other path.
import { env } from 'cloudflare:workers'
import { describe, it, expect, beforeAll } from 'vitest'
import app from '../src/index'
import { signAuthToken, signDocToken, DOC_TOKEN_TTL_SECONDS } from '../src/lib/auth'
import type { AuthUser } from '../src/types'

const JWT_SECRET = 'test-secret-doc-token'
const testEnv = () => ({ ...(env as unknown as Record<string, unknown>), JWT_SECRET })
const db = () => (env as unknown as { DB: D1Database }).DB

const USER: AuthUser = {
  id: 1,
  email: 'admin@goodsin.local',
  name: 'Seed Admin',
  role: 'admin',
  organisation_id: 1,
}

let sessionToken = ''

function jwtPayload(token: string): Record<string, any> {
  return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
}

async function api(path: string, init: RequestInit = {}, token = sessionToken) {
  return app.request(`/api${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  }, testEnv())
}

// Luhn-valid IMEIs — doc-token suite namespace 356043.
let imeiSeq = 35604300000000
function nextImei(): string {
  const body = String(imeiSeq++).padStart(14, '0')
  let sum = 0
  for (let i = 0; i < 14; i++) {
    let d = Number(body[i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return body + String((10 - (sum % 10)) % 10)
}

beforeAll(async () => {
  sessionToken = await signAuthToken(JWT_SECRET, USER)
})

// Creates a real print_jobs row via the real intake path (POST
// /scan/manual, auto_print defaults to true) so the allow-listed
// /api/print/label/:id path has a genuine row to serve.
async function makePrintJobId(): Promise<number> {
  const imei = nextImei()
  const res = await api('/scan/manual', {
    method: 'POST',
    body: JSON.stringify({
      imei, brand: 'Samsung', model: 'Galaxy S24', capacity: '256GB', color: 'Black', grade: 'A',
      buy_price: 100, currency: 'GBP', vat_type: 'MARGIN',
    }),
  })
  expect(res.status).toBe(200)
  const row = await db().prepare(
    'SELECT id FROM print_jobs WHERE received_device_id = (SELECT id FROM received_devices WHERE imei = ?)'
  ).bind(imei).first<{ id: number }>()
  if (!row) throw new Error('print job was not queued by /scan/manual')
  return row.id
}

describe('POST /api/auth/doc-token — minting', () => {
  it('requires a valid session token — 401 with no bearer at all', async () => {
    const res = await api('/auth/doc-token', { method: 'POST' }, '')
    expect(res.status).toBe(401)
  })

  it('mints a token distinct from the session token, tagged typ:"doc", ~5 minutes from now', async () => {
    const res = await api('/auth/doc-token', { method: 'POST' })
    expect(res.status).toBe(200)
    const { token } = await res.json<{ token: string }>()
    expect(token).toBeTruthy()
    expect(token).not.toBe(sessionToken)
    const claims = jwtPayload(token)
    expect(claims.typ).toBe('doc')
    expect(claims.sub).toBe(String(USER.id))
    expect(claims.org_id).toBe(USER.organisation_id)
    expect(claims.exp - claims.iat).toBe(DOC_TOKEN_TTL_SECONDS)
    expect(claims.exp - claims.iat).toBe(5 * 60)
  })
})

describe('doc token on the allow-listed print/label path', () => {
  it('a doc token via ?token= on GET /api/print/label/:id succeeds', async () => {
    const jobId = await makePrintJobId()
    const docRes = await api('/auth/doc-token', { method: 'POST' })
    const { token: docToken } = await docRes.json<{ token: string }>()

    const res = await app.request(`/api/print/label/${jobId}?token=${encodeURIComponent(docToken)}`, {}, testEnv())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
  })

  it('the SAME doc token via the Authorization header (not query) is rejected — cannot double as a session credential', async () => {
    const jobId = await makePrintJobId()
    const docRes = await api('/auth/doc-token', { method: 'POST' })
    const { token: docToken } = await docRes.json<{ token: string }>()

    const res = await app.request(`/api/print/label/${jobId}`, {
      headers: { Authorization: `Bearer ${docToken}` },
    }, testEnv())
    expect(res.status).toBe(401)
    const json = await res.json<{ error: string }>()
    expect(json.error).toMatch(/doc token not valid for this route/)
  })

  it('a doc token via ?token= on a NON-allow-listed path (e.g. /api/manifests) is rejected', async () => {
    const docRes = await api('/auth/doc-token', { method: 'POST' })
    const { token: docToken } = await docRes.json<{ token: string }>()

    const res = await app.request(`/api/manifests?token=${encodeURIComponent(docToken)}`, {}, testEnv())
    expect(res.status).toBe(401)
    const json = await res.json<{ error: string }>()
    expect(json.error).toMatch(/doc token not valid for this route/)
  })
})

describe('session tokens can no longer be presented via ?token= — the actual regression this pass fixes', () => {
  it('a normal session token via ?token= on the allow-listed print/label path is REJECTED', async () => {
    const jobId = await makePrintJobId()
    const res = await app.request(`/api/print/label/${jobId}?token=${encodeURIComponent(sessionToken)}`, {}, testEnv())
    expect(res.status).toBe(401)
    const json = await res.json<{ error: string }>()
    expect(json.error).toMatch(/session tokens cannot be presented via \?token=/)
  })

  it('a normal session token via ?token= on ANY other route is also REJECTED (previously worked everywhere for 12h)', async () => {
    const res = await app.request(`/api/manifests?token=${encodeURIComponent(sessionToken)}`, {}, testEnv())
    expect(res.status).toBe(401)
    const json = await res.json<{ error: string }>()
    expect(json.error).toMatch(/session tokens cannot be presented via \?token=/)
  })

  it('the session token still works normally via the Authorization header — no regression to ordinary auth', async () => {
    const res = await api('/auth/me')
    expect(res.status).toBe(200)
  })
})

describe('sendToPrintNode no longer forwards the caller session token to a third party', () => {
  // We can't hit real PrintNode from this suite, but we CAN prove the
  // route-level contract: with print_mode=browser/manual (the default —
  // no PrintNode key configured), /send/:id never touches PrintNode and
  // returns a browser url with no token embedded (the frontend mints its
  // own doc token separately via openWithDocToken()). This guards against
  // a regression where a raw session token gets baked into that url.
  it('POST /api/print/send/:id (browser mode) returns a url with NO token= query param at all', async () => {
    const jobId = await makePrintJobId()
    const res = await api(`/print/send/${jobId}`, { method: 'POST' })
    expect(res.status).toBe(200)
    const json = await res.json<{ ok: boolean; mode: string; url: string }>()
    expect(json.mode).toBe('browser')
    expect(json.url).not.toMatch(/token=/)
  })
})
