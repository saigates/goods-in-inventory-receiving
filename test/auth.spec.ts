// Real credentialed login (migration 0016) — two per-person accounts under
// the single organisation Saigates Limited, each with its own PBKDF2-SHA256
// password hash. These tests prove, against the REAL Hono app + REAL D1:
//   • correct credentials for user A → 200 + JWT identifying user A; same
//     for user B, independently (distinct sub claims)
//   • wrong password → 401, no token, zero side effects
//   • unknown email → 401 with the SAME body (no user enumeration)
//   • the old dev-login is GONE (410 tombstone, mints nothing)
//   • no route can grant a valid JWT without password verification
//   • per-user attribution: A scans, B scans — each scan_event / device
//     write records the correct DISTINCT user id (not merged, not swapped)
//   • plaintext passwords never appear in any stored row
//   • change-password: wrong current 401 (hash untouched), weak new 422,
//     valid change works and old password stops working
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { hashPassword } from '../src/lib/password'

const JWT_SECRET = 'test-only-secret'
const testEnv = () => ({ ...(env as unknown as Record<string, unknown>), JWT_SECRET })
const db = () => (env as unknown as { DB: D1Database }).DB

const PW_A = 'alpha-test-password-1'
const PW_B = 'bravo-test-password-2'

// Provision the two seeded accounts (0016 ships password_hash NULL — the
// same out-of-band step the owner performs, done here with test passwords).
beforeAll(async () => {
  await db().prepare('UPDATE users SET password_hash = ? WHERE email = ?')
    .bind(await hashPassword(PW_A), 'owner@saigates.com').run()
  await db().prepare('UPDATE users SET password_hash = ? WHERE email = ?')
    .bind(await hashPassword(PW_B), 'ops@saigates.com').run()
})

async function post(path: string, body: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await app.request(`/api${path}`, { method: 'POST', headers, body: JSON.stringify(body) }, testEnv())
  const json = (await res.json().catch(() => ({}))) as Record<string, any>
  return { res, json }
}

async function login(email: string, password: string) {
  return post('/auth/login', { email, password })
}

function jwtPayload(token: string): Record<string, any> {
  return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
}

// Luhn-valid IMEIs — auth-suite namespace 4901544.
function luhnCheckDigit(body14: string): string {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    let d = Number(body14[i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return String((10 - (sum % 10)) % 10)
}
let imeiSeq = 49015440000000
function nextImei(): string {
  const body = String(imeiSeq++).padStart(14, '0')
  return body + luhnCheckDigit(body)
}

describe('credentialed login: the door', () => {
  it('user A (owner@saigates.com) logs in with the correct password → token identifying user A', async () => {
    const { res, json } = await login('owner@saigates.com', PW_A)
    expect(res.status).toBe(200)
    expect(json.token).toBeTruthy()
    expect(json.user.email).toBe('owner@saigates.com')
    expect(json.user.organisation_id).toBe(1)
    const claims = jwtPayload(json.token)
    expect(claims.sub).toBe(String(json.user.id))
    expect(claims.org_id).toBe(1)
  })

  it('user B (ops@saigates.com) logs in independently → DIFFERENT user id in the token', async () => {
    const { json: a } = await login('owner@saigates.com', PW_A)
    const { res, json: b } = await login('ops@saigates.com', PW_B)
    expect(res.status).toBe(200)
    expect(b.user.email).toBe('ops@saigates.com')
    expect(b.user.organisation_id).toBe(1) // same single org
    expect(b.user.id).not.toBe(a.user.id)  // genuinely separate people
    expect(jwtPayload(b.token).sub).not.toBe(jwtPayload(a.token).sub)
  })

  it("user B's password does NOT open user A's account (credentials are per-person, not shared)", async () => {
    const { res, json } = await login('owner@saigates.com', PW_B)
    expect(res.status).toBe(401)
    expect(json.token).toBeUndefined()
  })

  it('wrong password → 401, no token, and the token it would have minted does not exist', async () => {
    const { res, json } = await login('owner@saigates.com', 'not-the-password')
    expect(res.status).toBe(401)
    expect(json.token).toBeUndefined()
    expect(json.error).toBe('Invalid email or password')
  })

  it('unknown email → 401 with the SAME body as wrong password (no user enumeration)', async () => {
    const { res, json } = await login('nobody@saigates.com', 'whatever-password')
    expect(res.status).toBe(401)
    expect(json.error).toBe('Invalid email or password')
  })

  it('missing password → 400, no token', async () => {
    const { res, json } = await post('/auth/login', { email: 'owner@saigates.com' })
    expect(res.status).toBe(400)
    expect(json.token).toBeUndefined()
  })

  it('an account with NO provisioned password (hash NULL) can never log in — legacy seed admin included', async () => {
    const { res } = await login('admin@goodsin.local', '')
    expect(res.status).toBe(400) // empty password short-circuits
    const { res: res2 } = await login('admin@goodsin.local', 'anything-at-all')
    expect(res2.status).toBe(401)
  })
})

describe('the dev-login bypass is provably gone', () => {
  it('POST /api/auth/dev-login → 410 tombstone, no token minted', async () => {
    const { res, json } = await post('/auth/dev-login', { email: 'admin@goodsin.local' })
    expect(res.status).toBe(410)
    expect(json.token).toBeUndefined()
    expect(json.error).toMatch(/removed/)
  })

  it('dev-login with an empty body (the old default-admin path) is equally dead', async () => {
    const { res, json } = await post('/auth/dev-login', {})
    expect(res.status).toBe(410)
    expect(json.token).toBeUndefined()
  })

  it('NO unauthenticated route can mint a token: /login is the only 2xx-capable door and it requires a correct password', async () => {
    // The middleware exempts exactly /api/health, /api/auth/login and the
    // dev-login tombstone. health returns no token; the tombstone is a 410;
    // /login with bad credentials refuses. Everything else 401s without a
    // bearer token — so no token can exist without password verification.
    const health = await app.request('/api/health', {}, testEnv())
    expect(health.status).toBe(200)
    expect(JSON.stringify(await health.json())).not.toMatch(/token/)
    const me = await app.request('/api/auth/me', {}, testEnv())
    expect(me.status).toBe(401)
    const cp = await post('/auth/change-password', { current_password: 'x', new_password: 'y'.repeat(12) })
    expect(cp.res.status).toBe(401)
    const manifests = await app.request('/api/manifests', {}, testEnv())
    expect(manifests.status).toBe(401)
  })
})

describe('per-person attribution: two people, two audit trails', () => {
  it('user A scans one IMEI, user B scans another — each scan_event records the correct distinct user id', async () => {
    const { json: a } = await login('owner@saigates.com', PW_A)
    const { json: b } = await login('ops@saigates.com', PW_B)

    const imeiA = nextImei()
    const imeiB = nextImei()
    const { res: mres, json: man } = await post('/manifests', {
      reference: 'AUTH ATTR TEST', supplier: 'Auth Suite',
      rows: [
        { oem: 'Samsung', model_no: 'Galaxy S24', capacity: '256GB', color: 'Black', grade: 'A', imei: imeiA },
        { oem: 'Samsung', model_no: 'Galaxy S24', capacity: '256GB', color: 'Black', grade: 'A', imei: imeiB },
      ],
    }, a.token)
    expect(mres.status).toBe(200)

    const sa = await post('/scan', { manifest_id: man.manifest_id, imei: imeiA }, a.token)
    expect(sa.json.outcome).toBe('matched')
    const sb = await post('/scan', { manifest_id: man.manifest_id, imei: imeiB }, b.token)
    expect(sb.json.outcome).toBe('matched')

    const evA = await db().prepare('SELECT user_id FROM scan_events WHERE imei = ? ORDER BY id DESC LIMIT 1')
      .bind(imeiA).first<{ user_id: number }>()
    const evB = await db().prepare('SELECT user_id FROM scan_events WHERE imei = ? ORDER BY id DESC LIMIT 1')
      .bind(imeiB).first<{ user_id: number }>()
    expect(evA?.user_id).toBe(a.user.id)
    expect(evB?.user_id).toBe(b.user.id)
    expect(evA?.user_id).not.toBe(evB?.user_id) // not merged, not swapped

    // And through to the received device + its lifecycle event: B confirms
    // B's line; the device_events row must carry B's id, not A's.
    const { json: cat } = await post('/catalog', {
      brand: 'Samsung', model: 'Galaxy S24', capacity: '256GB', color: 'Black', grade: 'A',
    }, a.token)
    const sku = cat.row?.sku ?? cat.sku ?? cat.existing?.sku
    const conf = await post('/scan/confirm', {
      expected_device_id: sb.json.expected.id, sku,
      buy_price: 100, currency: 'GBP', vat_type: 'MARGIN', auto_print: false,
    }, b.token)
    expect(conf.res.status).toBe(200)
    const dev = await db().prepare('SELECT id, created_by_user_id FROM received_devices WHERE imei = ?')
      .bind(imeiB).first<{ id: number; created_by_user_id: number }>()
    expect(dev?.created_by_user_id).toBe(b.user.id)
    const devEv = await db().prepare('SELECT user_id FROM device_events WHERE device_id = ? ORDER BY id DESC LIMIT 1')
      .bind(dev!.id).first<{ user_id: number }>()
    expect(devEv?.user_id).toBe(b.user.id)
  })
})

describe('plaintext never stored', () => {
  it('no stored row anywhere contains a test plaintext password; hashes are well-formed pbkdf2 strings', async () => {
    const rows = await db().prepare('SELECT id, email, password_hash FROM users').all<Record<string, any>>()
    for (const u of rows.results) {
      if (u.password_hash != null) {
        expect(u.password_hash).toMatch(/^pbkdf2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/)
        expect(u.password_hash).not.toContain(PW_A)
        expect(u.password_hash).not.toContain(PW_B)
      }
    }
    // Sweep every free-text column this suite could have written through —
    // a plaintext leak into any audit/business row would be catastrophic.
    const sweeps: Array<[string, string]> = [
      ['scan_events', 'message'],
      ['device_events', 'metadata'],
      ['manifests', 'notes'],
      ['received_devices', 'notes'],
    ]
    for (const [table, col] of sweeps) {
      const leak = await db().prepare(
        `SELECT COUNT(*) AS n FROM ${table} WHERE ${col} LIKE ? OR ${col} LIKE ?`
      ).bind(`%${PW_A}%`, `%${PW_B}%`).first<{ n: number }>()
      expect(leak?.n, `${table}.${col} must never contain a plaintext password`).toBe(0)
    }
  })
})

describe('self-service password change', () => {
  it('wrong current password → 401 and the stored hash is untouched', async () => {
    const { json: b } = await login('ops@saigates.com', PW_B)
    const before = await db().prepare('SELECT password_hash FROM users WHERE email = ?')
      .bind('ops@saigates.com').first<{ password_hash: string }>()
    const { res } = await post('/auth/change-password',
      { current_password: 'wrong-current', new_password: 'a-perfectly-fine-new-pw' }, b.token)
    expect(res.status).toBe(401)
    const after = await db().prepare('SELECT password_hash FROM users WHERE email = ?')
      .bind('ops@saigates.com').first<{ password_hash: string }>()
    expect(after?.password_hash).toBe(before?.password_hash)
  })

  it('weak new password (<10 chars) → 422, hash untouched', async () => {
    const { json: b } = await login('ops@saigates.com', PW_B)
    const { res, json } = await post('/auth/change-password',
      { current_password: PW_B, new_password: 'short' }, b.token)
    expect(res.status).toBe(422)
    expect(json.error).toMatch(/10 characters/)
    const { res: still } = await login('ops@saigates.com', PW_B)
    expect(still.status).toBe(200)
  })

  it('valid change: new password works, old password stops working (then restored for suite isolation)', async () => {
    const { json: b } = await login('ops@saigates.com', PW_B)
    const NEW_PW = 'rotated-test-password-3'
    const { res } = await post('/auth/change-password',
      { current_password: PW_B, new_password: NEW_PW }, b.token)
    expect(res.status).toBe(200)
    expect((await login('ops@saigates.com', PW_B)).res.status).toBe(401) // old dead
    expect((await login('ops@saigates.com', NEW_PW)).res.status).toBe(200) // new works
    // restore PW_B so test order never matters
    await db().prepare('UPDATE users SET password_hash = ? WHERE email = ?')
      .bind(await hashPassword(PW_B), 'ops@saigates.com').run()
    expect((await login('ops@saigates.com', PW_B)).res.status).toBe(200)
  })
})
