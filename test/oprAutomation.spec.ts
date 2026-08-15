// OPR 4 (Automation & Integration) invariants — actually SENDING email via
// Gmail REST (not just drafting), shipment lifecycle webhooks, and the bulk
// scan endpoint.
//
// Load-bearing assertions:
//   - HONESTY GATE: with no GMAIL_* secrets, /prealert/send and
//     /clearance/send refuse 503 gmail_not_configured and write NOTHING to
//     the sent_emails outbox — the system never pretends an email went out.
//   - With secrets configured (fetch stubbed at the isolate boundary): the
//     token exchange posts the refresh-token grant, the Gmail send call
//     carries the base64url RFC2822 message whose decoded content contains
//     the recipient, subject and attachments; the outbox row records
//     status='sent' with the provider message id.
//   - Provider failure (send HTTP 500) → 502 AND an outbox row with
//     status='failed' carrying the error — attempts are auditable either way.
//   - Webhooks: shipment.finalised (export + import) and shipment.restocked
//     fire against enabled org webhooks with a verifiable HMAC-SHA256
//     X-Signature over the exact body; disabled webhooks stay silent.
//   - Bulk scan: per-IMEI independent outcomes through the same gates as
//     single /scan — good ones land, bad ones fail with the same errors and
//     zero side-effects; caps at 200.
//
// Outbound fetch is stubbed by swapping globalThis.fetch (the email and
// webhook libs are the only fetch users); every test restores it.
import { env } from 'cloudflare:workers'
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'
import { buildMimeMessage, base64Url, gmailConfigFromEnv } from '../src/lib/email'
import type { Shipment } from '../src/types'

const JWT_SECRET = 'test-secret-opr-automation'
const GMAIL_ENV = {
  GMAIL_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GMAIL_CLIENT_SECRET: 'test-client-secret',
  GMAIL_REFRESH_TOKEN: 'test-refresh-token',
}
// Two env flavours: bare (no Gmail secrets) and configured.
const bareEnv = { ...env, JWT_SECRET } as typeof env & { JWT_SECRET: string }
const gmailEnv = { ...bareEnv, ...GMAIL_ENV }

let token = ''
let authId = 0

// Distinct IMEI range from other suites (base 86045520...).
let imeiSeq = 0
function luhnImei(): string {
  const body = `8604552${String(10000000 + imeiSeq++).slice(1)}`
  let sum = 0
  for (let i = 0; i < 14; i++) {
    let d = Number(body[i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return body + String((10 - (sum % 10)) % 10)
}

async function api(path: string, init: RequestInit = {}, useEnv: object = bareEnv) {
  return app.request(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  }, useEnv)
}

// ───────── fetch stubbing (save/restore around every test) ─────────
const realFetch = globalThis.fetch
type CapturedRequest = { url: string; method: string; headers: Record<string, string>; body: string }
let captured: CapturedRequest[] = []

function stubFetch(handler: (req: CapturedRequest) => Response | null) {
  captured = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    let body = ''
    if (init?.body) body = String(init.body)
    else if (input instanceof Request) body = await input.clone().text()
    const headers: Record<string, string> = {}
    const h = init?.headers ?? (input instanceof Request ? input.headers : undefined)
    if (h) new Headers(h as HeadersInit).forEach((v, k) => { headers[k.toLowerCase()] = v })
    const req = { url, method, headers, body }
    captured.push(req)
    const res = handler(req)
    if (res) return res
    return new Response('unmatched stub', { status: 599 })
  }) as typeof fetch
}

afterEach(() => { globalThis.fetch = realFetch })

const gmailHappyStub = (req: CapturedRequest): Response | null => {
  if (req.url.startsWith('https://oauth2.googleapis.com/token')) {
    return new Response(JSON.stringify({ access_token: 'stub-access-token', expires_in: 3599 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }
  if (req.url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')) {
    return new Response(JSON.stringify({ id: 'stub-message-id-123' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }
  return null
}

// ───────── shared fixtures (real OPR 2 + 3 flows) ─────────
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

async function makeExportShipment() {
  const res = await api('/api/opr/shipments', {
    method: 'POST',
    body: JSON.stringify({
      reference: `EXP AUTO ${100 + shipmentSeq++}`, direction: 'export', authorisation_id: authId,
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

async function makeReturnShipment(relatedExportId: number, overrides: Record<string, unknown> = {}) {
  const res = await api('/api/opr/shipments', {
    method: 'POST',
    body: JSON.stringify({
      reference: `IMP AUTO ${100 + shipmentSeq++}`, direction: 'import',
      authorisation_id: authId, procedure_code: '6121',
      related_export_shipment_id: relatedExportId,
      ship_date: '2026-09-01',
      // Full FedEx OPR worksheet chain present by default (the 'computed'
      // path) so computeCe1154() succeeds for these OPR-4 automation tests
      // without each needing its own worksheet-input overrides. duty_rate_pct:
      // 0 needs duty_override_claimed: true to avoid the OVR01 refusal.
      repair_cost: 500, repair_cost_currency: 'GBP', duty_rate_pct: 0,
      inbound_freight_gbp: 20, non_eu_freight_share_gbp: 10, export_freight_gbp: 20,
      duty_override_claimed: true,
      ...overrides,
    }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { shipment: Shipment }).shipment
}

async function emailRows(shipmentId: number) {
  const { results } = await env.DB.prepare('SELECT * FROM sent_emails WHERE shipment_id = ? ORDER BY id')
    .bind(shipmentId).all<Record<string, unknown>>()
  return results
}

beforeAll(async () => {
  token = await signAuthToken(JWT_SECRET, {
    id: 1, email: 'admin@goodsin.local', name: 'Seed Admin',
    role: 'admin', organisation_id: 1,
  })
  const res = await api('/api/opr/authorisations', {
    method: 'POST',
    body: JSON.stringify({
      holder_name: 'Auto Test Holder', eori: 'GB111222333444',
      cds_number: 'GBOPO11122233344420260101000000',
      op_authorisation_number: 'OP/1111/222/33',
      valid_from: '2026-01-01', valid_to: '2031-01-01',
      commodity_codes: '8517130000', discharge_period_months: 6,
      prealert_email: 'prealert-test@example.com', prealert_cutoff: '16:00',
    }),
  })
  expect(res.status).toBe(201)
  authId = ((await res.json()) as { authorisation: { id: number } }).authorisation.id
})

afterAll(async () => {
  // Clean everything this suite created (IMEI base 8604552, EXP/IMP AUTO refs).
  await env.DB.prepare("DELETE FROM sent_emails WHERE shipment_id IN (SELECT id FROM shipments WHERE reference LIKE 'EXP AUTO %' OR reference LIKE 'IMP AUTO %')").run()
  await env.DB.prepare("DELETE FROM shipment_lines WHERE imei LIKE '8604552%'").run()
  await env.DB.prepare("DELETE FROM shipments WHERE reference LIKE 'EXP AUTO %' OR reference LIKE 'IMP AUTO %'").run()
  await env.DB.prepare("DELETE FROM device_events WHERE device_id IN (SELECT id FROM received_devices WHERE imei LIKE '8604552%')").run()
  await env.DB.prepare("DELETE FROM scan_events WHERE imei LIKE '8604552%'").run()
  await env.DB.prepare("DELETE FROM print_jobs WHERE received_device_id IN (SELECT id FROM received_devices WHERE imei LIKE '8604552%')").run()
  await env.DB.prepare("DELETE FROM received_devices WHERE imei LIKE '8604552%'").run()
  await env.DB.prepare('DELETE FROM webhooks WHERE url LIKE ?').bind('https://opr4-test.example.com%').run()
  await env.DB.prepare('DELETE FROM opr_authorisations WHERE id = ?').bind(authId).run()
})

// ───────── config gate (pure) ─────────
describe('gmailConfigFromEnv', () => {
  it('returns null unless ALL three secrets are present', () => {
    expect(gmailConfigFromEnv({})).toBeNull()
    expect(gmailConfigFromEnv({ GMAIL_CLIENT_ID: 'a' })).toBeNull()
    expect(gmailConfigFromEnv({ GMAIL_CLIENT_ID: 'a', GMAIL_CLIENT_SECRET: 'b' })).toBeNull()
    expect(gmailConfigFromEnv({ GMAIL_CLIENT_ID: 'a', GMAIL_CLIENT_SECRET: 'b', GMAIL_REFRESH_TOKEN: '  ' })).toBeNull()
    expect(gmailConfigFromEnv(GMAIL_ENV)).toEqual({
      clientId: GMAIL_ENV.GMAIL_CLIENT_ID,
      clientSecret: GMAIL_ENV.GMAIL_CLIENT_SECRET,
      refreshToken: GMAIL_ENV.GMAIL_REFRESH_TOKEN,
    })
  })
})

// ───────── MIME builder (pure) ─────────
describe('buildMimeMessage / base64Url', () => {
  it('builds a multipart message carrying recipient, encoded subject and attachments', () => {
    const mime = buildMimeMessage({
      to: 'dest@example.com',
      subject: 'OPR — test',
      body: 'Hello body',
      attachments: [{ filename: 'doc.html', contentType: 'text/html', content: '<p>attached</p>' }],
    })
    expect(mime).toContain('To: dest@example.com')
    expect(mime).toContain('=?UTF-8?B?') // RFC2047 subject
    expect(mime).toContain('multipart/mixed')
    expect(mime).toContain('filename="doc.html"')
    expect(mime).toContain(btoa('Hello body'))
    expect(mime).toContain(btoa('<p>attached</p>'))
  })
  it('base64url output has no +, / or padding', () => {
    const out = base64Url('subject?>>~~\xff\xfe')
    expect(out).not.toMatch(/[+/=]/)
  })
})

// ───────── the honesty gate ─────────
describe('unconfigured Gmail refuses honestly', () => {
  it('prealert/send → 503 gmail_not_configured and NO outbox row', async () => {
    const { shipment } = await makeFinalisedExport(1, '26GB11111111111101')
    const res = await api(`/api/opr/shipments/${shipment.id}/prealert/send`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(503)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('gmail_not_configured')
    expect(await emailRows(shipment.id)).toHaveLength(0)
  })
  it('clearance/send → 503 and NO outbox row', async () => {
    const { shipment: exp, devices } = await makeFinalisedExport(1, '26GB11111111111102')
    const imp = await makeReturnShipment(exp.id)
    const scan = await api(`/api/opr/shipments/${imp.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: devices[0].imei }),
    })
    expect(scan.status).toBe(201)
    const res = await api(`/api/opr/shipments/${imp.id}/clearance/send`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(503)
    expect(await emailRows(imp.id)).toHaveLength(0)
  })
})

// ───────── configured sends (fetch stubbed) ─────────
describe('prealert/send with Gmail configured', () => {
  it('exchanges the refresh token, sends the MIME message, records status=sent', async () => {
    const { shipment } = await makeFinalisedExport(2, '26GB11111111111103')
    stubFetch(gmailHappyStub)
    const res = await api(`/api/opr/shipments/${shipment.id}/prealert/send`, { method: 'POST', body: '{}' }, gmailEnv)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; to: string; provider_message_id: string; attachments: string[] }
    expect(body.ok).toBe(true)
    expect(body.to).toBe('prealert-test@example.com')
    expect(body.provider_message_id).toBe('stub-message-id-123')
    expect(body.attachments.some(a => a.startsWith('invoice-'))).toBe(true)
    expect(body.attachments.some(a => a.startsWith('scan-out-'))).toBe(true)

    // Wire-level proof: token exchange then send.
    expect(captured).toHaveLength(2)
    expect(captured[0].url).toBe('https://oauth2.googleapis.com/token')
    expect(captured[0].body).toContain('grant_type=refresh_token')
    expect(captured[0].body).toContain('refresh_token=test-refresh-token')
    expect(captured[1].url).toContain('gmail/v1/users/me/messages/send')
    expect(captured[1].headers['authorization']).toBe('Bearer stub-access-token')
    const raw = (JSON.parse(captured[1].body) as { raw: string }).raw
    // decode base64url → the actual RFC2822 message
    const decoded = atob(raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - raw.length % 4) % 4))
    expect(decoded).toContain('To: prealert-test@example.com')
    expect(decoded).toContain('multipart/mixed')

    // Outbox row is the audit.
    const rows = await emailRows(shipment.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('prealert')
    expect(rows[0].status).toBe('sent')
    expect(rows[0].provider_message_id).toBe('stub-message-id-123')
    expect(rows[0].to_email).toBe('prealert-test@example.com')
  })

  it('refuses on a DRAFT export? no — drafts may pre-alert; but refuses with no lines (422, no outbox row)', async () => {
    const emptyExp = await makeExportShipment()
    stubFetch(gmailHappyStub)
    const res = await api(`/api/opr/shipments/${emptyExp.id}/prealert/send`, { method: 'POST', body: '{}' }, gmailEnv)
    expect(res.status).toBe(422)
    expect(captured).toHaveLength(0) // nothing even attempted
    expect(await emailRows(emptyExp.id)).toHaveLength(0)
  })

  it('import shipments refuse prealert/send (409)', async () => {
    const { shipment: exp } = await makeFinalisedExport(1, '26GB11111111111104')
    const imp = await makeReturnShipment(exp.id)
    stubFetch(gmailHappyStub)
    const res = await api(`/api/opr/shipments/${imp.id}/prealert/send`, { method: 'POST', body: '{}' }, gmailEnv)
    expect(res.status).toBe(409)
    expect(captured).toHaveLength(0)
  })

  it('provider failure → 502 AND an outbox row with status=failed carrying the error', async () => {
    const { shipment } = await makeFinalisedExport(1, '26GB11111111111105')
    stubFetch((req) => {
      if (req.url.startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'stub-access-token' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (req.url.includes('messages/send')) {
        return new Response('{"error":{"message":"quota exceeded"}}', { status: 500 })
      }
      return null
    })
    const res = await api(`/api/opr/shipments/${shipment.id}/prealert/send`, { method: 'POST', body: '{}' }, gmailEnv)
    expect(res.status).toBe(502)
    const rows = await emailRows(shipment.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failed')
    expect(String(rows[0].error)).toContain('HTTP 500')
    expect(rows[0].provider_message_id).toBeNull()
  })

  it('token-exchange failure → 502, outbox row failed, and no send call was attempted', async () => {
    const { shipment } = await makeFinalisedExport(1, '26GB11111111111106')
    stubFetch((req) => {
      if (req.url.startsWith('https://oauth2.googleapis.com/token')) {
        return new Response('{"error":"invalid_grant"}', { status: 400 })
      }
      return null
    })
    const res = await api(`/api/opr/shipments/${shipment.id}/prealert/send`, { method: 'POST', body: '{}' }, gmailEnv)
    expect(res.status).toBe(502)
    expect(captured).toHaveLength(1) // only the token call — never reached Gmail send
    const rows = await emailRows(shipment.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failed')
    expect(String(rows[0].error)).toContain('token exchange failed')
  })
})

describe('clearance/send with Gmail configured', () => {
  it('sends to the explicit recipient with the C&E1154 attached; outbox records it', async () => {
    const { shipment: exp, devices } = await makeFinalisedExport(2, '26GB11111111111107')
    const imp = await makeReturnShipment(exp.id)
    for (const d of devices) {
      const scan = await api(`/api/opr/shipments/${imp.id}/scan`, { method: 'POST', body: JSON.stringify({ imei: d.imei }) })
      expect(scan.status).toBe(201)
    }
    stubFetch(gmailHappyStub)
    const res = await api(`/api/opr/shipments/${imp.id}/clearance/send`, {
      method: 'POST', body: JSON.stringify({ to: 'broker@customs-agent.example.com' }),
    }, gmailEnv)
    expect(res.status).toBe(200)
    const body = await res.json() as { to: string; attachments: string[] }
    expect(body.to).toBe('broker@customs-agent.example.com')
    expect(body.attachments.some(a => a.startsWith('ce1154-'))).toBe(true)

    const raw = (JSON.parse(captured[1].body) as { raw: string }).raw
    const decoded = atob(raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - raw.length % 4) % 4))
    expect(decoded).toContain('To: broker@customs-agent.example.com')

    const rows = await emailRows(imp.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('clearance')
    expect(rows[0].status).toBe('sent')
  })

  it('invalid recipient → 422, nothing attempted, no outbox row', async () => {
    const { shipment: exp, devices } = await makeFinalisedExport(1, '26GB11111111111108')
    const imp = await makeReturnShipment(exp.id, { })
    const scan = await api(`/api/opr/shipments/${imp.id}/scan`, { method: 'POST', body: JSON.stringify({ imei: devices[0].imei }) })
    expect(scan.status).toBe(201)
    stubFetch(gmailHappyStub)
    const res = await api(`/api/opr/shipments/${imp.id}/clearance/send`, {
      method: 'POST', body: JSON.stringify({ to: 'not-an-email' }),
    }, gmailEnv)
    expect(res.status).toBe(422)
    expect(captured).toHaveLength(0)
    expect(await emailRows(imp.id)).toHaveLength(0)
  })

  it('GET /emails lists the outbox newest-first and never leaks other shipments', async () => {
    const { shipment: exp, devices } = await makeFinalisedExport(1, '26GB11111111111109')
    const imp = await makeReturnShipment(exp.id)
    const scan = await api(`/api/opr/shipments/${imp.id}/scan`, { method: 'POST', body: JSON.stringify({ imei: devices[0].imei }) })
    expect(scan.status).toBe(201)
    stubFetch(gmailHappyStub)
    const s1 = await api(`/api/opr/shipments/${imp.id}/clearance/send`, { method: 'POST', body: JSON.stringify({ to: 'a@b.co' }) }, gmailEnv)
    expect(s1.status).toBe(200)
    const list = await api(`/api/opr/shipments/${imp.id}/emails`)
    expect(list.status).toBe(200)
    const { emails } = await list.json() as { emails: { shipment_id?: number; kind: string }[] }
    expect(emails).toHaveLength(1)
    expect(emails[0].kind).toBe('clearance')
    // exp's outbox is untouched
    const listExp = await api(`/api/opr/shipments/${exp.id}/emails`)
    expect(((await listExp.json()) as { emails: unknown[] }).emails).toHaveLength(0)
  })
})

// ───────── shipment webhooks ─────────
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

describe('shipment lifecycle webhooks', () => {
  it('export finalise fires shipment.finalised with a verifiable HMAC signature', async () => {
    // register a webhook
    const create = await api('/api/webhooks', { method: 'POST', body: JSON.stringify({ url: 'https://opr4-test.example.com/hook1' }) })
    expect(create.status).toBe(200)
    const { id: whId, secret } = await create.json() as { id: number; secret: string }

    const shipment = await makeExportShipment()
    const d = await makeDevice()
    await api(`/api/opr/shipments/${shipment.id}/scan`, { method: 'POST', body: JSON.stringify({ imei: d.imei }) })

    stubFetch((req) => req.url.startsWith('https://opr4-test.example.com') ? new Response('ok') : null)
    const fin = await api(`/api/opr/shipments/${shipment.id}/finalise`, {
      method: 'POST', body: JSON.stringify({ export_mrn: '26GB11111111111110' }),
    })
    expect(fin.status).toBe(200)

    const hook = captured.find(r => r.url === 'https://opr4-test.example.com/hook1')
    expect(hook).toBeTruthy()
    const payload = JSON.parse(hook!.body) as Record<string, unknown>
    expect(payload.event).toBe('shipment.finalised')
    expect(payload.direction).toBe('export')
    expect(payload.shipment_id).toBe(shipment.id)
    expect(payload.export_mrn).toBe('26GB11111111111110')
    expect(payload.device_count).toBe(1)
    // signature verifies over the exact body
    const expected = `sha256=${await hmacHex(secret, hook!.body)}`
    expect(hook!.headers['x-signature']).toBe(expected)
    expect(hook!.headers['x-webhook-id']).toBe(String(whId))

    await api(`/api/webhooks/${whId}`, { method: 'DELETE' })
  })

  it('import receipt and restock fire their events; disabled webhooks stay silent', async () => {
    const create = await api('/api/webhooks', { method: 'POST', body: JSON.stringify({ url: 'https://opr4-test.example.com/hook2' }) })
    const { id: whId } = await create.json() as { id: number }

    const { shipment: exp, devices } = await makeFinalisedExport(1, '26GB11111111111111')
    const imp = await makeReturnShipment(exp.id)
    await api(`/api/opr/shipments/${imp.id}/scan`, { method: 'POST', body: JSON.stringify({ imei: devices[0].imei }) })

    stubFetch((req) => req.url.startsWith('https://opr4-test.example.com') ? new Response('ok') : null)
    const fin = await api(`/api/opr/shipments/${imp.id}/finalise`, { method: 'POST', body: JSON.stringify({ import_mrn: '26GB22222222222201' }) })
    expect(fin.status).toBe(200)
    const finHooks = captured.filter(r => r.url.endsWith('/hook2')).map(r => JSON.parse(r.body) as Record<string, unknown>)
    // device transition webhooks also fire; find the shipment one
    const shipmentEvent = finHooks.find(p => p.event === 'shipment.finalised')
    expect(shipmentEvent).toBeTruthy()
    expect(shipmentEvent!.direction).toBe('import')
    expect(shipmentEvent!.import_mrn).toBe('26GB22222222222201')

    // restock fires shipment.restocked
    stubFetch((req) => req.url.startsWith('https://opr4-test.example.com') ? new Response('ok') : null)
    const restock = await api(`/api/opr/shipments/${imp.id}/restock`, { method: 'POST', body: '{}' })
    expect(restock.status).toBe(200)
    const restockEvents = captured.filter(r => r.url.endsWith('/hook2')).map(r => JSON.parse(r.body) as Record<string, unknown>)
    const restocked = restockEvents.find(p => p.event === 'shipment.restocked')
    expect(restocked).toBeTruthy()
    expect(restocked!.device_count).toBe(1)

    // disable → second restock (no-op restock fires nothing anyway) + a fresh finalise elsewhere fires nothing at this URL
    await api(`/api/webhooks/${whId}/toggle`, { method: 'POST', body: JSON.stringify({ enabled: false }) })
    stubFetch((req) => req.url.startsWith('https://opr4-test.example.com') ? new Response('ok') : null)
    const shipment2 = await makeExportShipment()
    const d2 = await makeDevice()
    await api(`/api/opr/shipments/${shipment2.id}/scan`, { method: 'POST', body: JSON.stringify({ imei: d2.imei }) })
    const fin2 = await api(`/api/opr/shipments/${shipment2.id}/finalise`, { method: 'POST', body: JSON.stringify({ export_mrn: '26GB11111111111112' }) })
    expect(fin2.status).toBe(200)
    expect(captured.filter(r => r.url.endsWith('/hook2'))).toHaveLength(0)

    await api(`/api/webhooks/${whId}`, { method: 'DELETE' })
  })

  it('webhook receiver being DOWN never fails the finalise (delivery errors are swallowed)', async () => {
    const create = await api('/api/webhooks', { method: 'POST', body: JSON.stringify({ url: 'https://opr4-test.example.com/hook3' }) })
    const { id: whId } = await create.json() as { id: number }
    const shipment = await makeExportShipment()
    const d = await makeDevice()
    await api(`/api/opr/shipments/${shipment.id}/scan`, { method: 'POST', body: JSON.stringify({ imei: d.imei }) })
    stubFetch(() => { throw new Error('connection refused') })
    const fin = await api(`/api/opr/shipments/${shipment.id}/finalise`, { method: 'POST', body: JSON.stringify({ export_mrn: '26GB11111111111113' }) })
    expect(fin.status).toBe(200) // the business op succeeded regardless
    await api(`/api/webhooks/${whId}`, { method: 'DELETE' })
  })
})

// ───────── bulk scan ─────────
describe('POST /shipments/:id/scan-bulk', () => {
  it('per-IMEI independent outcomes through the same gates as single scan', async () => {
    const shipment = await makeExportShipment()
    const good1 = await makeDevice()
    const good2 = await makeDevice()
    // a RECEIVED (not READY_FOR_EXPORT) device — must fail 409 like single scan
    const notReadyRes = await api('/api/scan/manual', {
      method: 'POST',
      body: JSON.stringify({ imei: luhnImei(), brand: 'Samsung', model: 'S23', grade: 'B', buy_price: 99, vat_type: 'MARGIN', currency: 'GBP' }),
    })
    const notReady = ((await notReadyRes.json()) as { received: { id: number; imei: string } }).received

    const res = await api(`/api/opr/shipments/${shipment.id}/scan-bulk`, {
      method: 'POST',
      body: JSON.stringify({ imeis: [good1.imei, 'nonexistent999', notReady.imei, good2.imei] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { requested: number; added: number; failed: number; results: { imei: string; ok: boolean; status: number; error?: string }[] }
    expect(body.requested).toBe(4)
    expect(body.added).toBe(2)
    expect(body.failed).toBe(2)
    expect(body.results[0]).toMatchObject({ imei: good1.imei, ok: true, status: 201 })
    expect(body.results[1]).toMatchObject({ ok: false, status: 404 })
    expect(body.results[2].status).toBe(409) // not READY_FOR_EXPORT — same gate as single scan
    expect(body.results[3]).toMatchObject({ imei: good2.imei, ok: true, status: 201 })

    // zero side-effects for the failed ones
    const notReadyRow = await env.DB.prepare('SELECT status FROM received_devices WHERE id = ?').bind(notReady.id).first<{ status: string }>()
    expect(notReadyRow!.status).toBe('RECEIVED')
    const lines = await env.DB.prepare('SELECT COUNT(*) AS n FROM shipment_lines WHERE shipment_id = ?').bind(shipment.id).first<{ n: number }>()
    expect(lines!.n).toBe(2)
  })

  it('caps at 500 IMEIs (raised 2026-08-15 from 200 — see BULK_TRANSITION_CAP writeup in src/routes/devices.ts) and validates the body shape', async () => {
    const shipment = await makeExportShipment()
    const tooMany = Array.from({ length: 501 }, (_, i) => String(100000000000000 + i))
    const res = await api(`/api/opr/shipments/${shipment.id}/scan-bulk`, { method: 'POST', body: JSON.stringify({ imeis: tooMany }) })
    expect(res.status).toBe(422)
    const bad = await api(`/api/opr/shipments/${shipment.id}/scan-bulk`, { method: 'POST', body: JSON.stringify({ imeis: 'not-an-array' }) })
    expect(bad.status).toBe(422)
    const empty = await api(`/api/opr/shipments/${shipment.id}/scan-bulk`, { method: 'POST', body: JSON.stringify({ imeis: [] }) })
    expect(empty.status).toBe(422)
  })

  it('works on import (return) shipments through the return gates', async () => {
    const { shipment: exp, devices } = await makeFinalisedExport(3, '26GB11111111111114')
    const imp = await makeReturnShipment(exp.id)
    const res = await api(`/api/opr/shipments/${imp.id}/scan-bulk`, {
      method: 'POST',
      body: JSON.stringify({ imeis: devices.map(d => d.imei) }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { added: number; failed: number }
    expect(body.added).toBe(3)
    expect(body.failed).toBe(0)
    // statuses did NOT move (return lines don't move status while DRAFT)
    for (const d of devices) {
      const row = await env.DB.prepare('SELECT status FROM received_devices WHERE id = ?').bind(d.id).first<{ status: string }>()
      expect(row!.status).toBe('EXPORTED_UNDER_OPR')
    }
  })

  it('FINALISED shipments refuse bulk (same DRAFT gate as single scan)', async () => {
    const { shipment } = await makeFinalisedExport(1, '26GB11111111111115')
    const d = await makeDevice()
    const res = await api(`/api/opr/shipments/${shipment.id}/scan-bulk`, { method: 'POST', body: JSON.stringify({ imeis: [d.imei] }) })
    expect(res.status).toBe(409)
  })
})

// ───────── OPR 6: manual dispatch + MUCR (per owner brief — Gmail left
// as-is until the integration is done) ─────────

describe('OPR 6: mark-sent (manual dispatch)', () => {
  it('prealert/mark-sent records a provider=manual/status=manual outbox row with the SERVER-built subject', async () => {
    const { shipment } = await makeFinalisedExport(1, '26GB66666666666601')
    const res = await api(`/api/opr/shipments/${shipment.id}/prealert/mark-sent`, {
      method: 'POST', body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; email_id: number; to: string; subject: string; provider: string; status: string }
    expect(body.ok).toBe(true)
    expect(body.provider).toBe('manual')
    expect(body.status).toBe('manual')
    expect(body.to).toBe('prealert-test@example.com') // from the authorisation
    expect(body.subject).toContain('OPR export pre-alert')
    expect(body.subject).toContain(shipment.reference)

    const rows = await emailRows(shipment.id)
    expect(rows.length).toBe(1)
    expect(rows[0].provider).toBe('manual')
    expect(rows[0].status).toBe('manual')
    expect(rows[0].provider_message_id).toBeNull() // a manual send can never carry a provider id
    expect(rows[0].to_email).toBe('prealert-test@example.com')
    expect(rows[0].subject).toBe(body.subject)
    expect(rows[0].user_id).toBe(1) // operator attribution
  })

  it('mark-sent works with NO Gmail secrets (bareEnv) — unlike /send which refuses 503', async () => {
    const { shipment } = await makeFinalisedExport(1, '26GB66666666666602')
    const send = await api(`/api/opr/shipments/${shipment.id}/prealert/send`, { method: 'POST', body: '{}' }, bareEnv)
    expect(send.status).toBe(503) // the honesty gate is untouched
    const mark = await api(`/api/opr/shipments/${shipment.id}/prealert/mark-sent`, { method: 'POST', body: '{}' }, bareEnv)
    expect(mark.status).toBe(200)
    const rows = await emailRows(shipment.id)
    expect(rows.length).toBe(1) // only the manual row — the refused send wrote nothing
    expect(rows[0].provider).toBe('manual')
  })

  it('a manual row is NEVER recorded as a real send (status/provider distinct from gmail sent)', async () => {
    const { shipment } = await makeFinalisedExport(1, '26GB66666666666603')
    // real send via stub, then a manual record on the same shipment
    stubFetch(gmailHappyStub)
    const send = await api(`/api/opr/shipments/${shipment.id}/prealert/send`, { method: 'POST', body: '{}' }, gmailEnv)
    expect(send.status).toBe(200)
    globalThis.fetch = realFetch
    const mark = await api(`/api/opr/shipments/${shipment.id}/prealert/mark-sent`, { method: 'POST', body: '{}' })
    expect(mark.status).toBe(200)
    const rows = await emailRows(shipment.id)
    expect(rows.length).toBe(2)
    const real = rows.find(r => r.provider === 'gmail')!
    const manual = rows.find(r => r.provider === 'manual')!
    expect(real.status).toBe('sent')
    expect(real.provider_message_id).toBe('stub-message-id-123')
    expect(manual.status).toBe('manual')
    expect(manual.provider_message_id).toBeNull()
  })

  it('recipient override: a valid `to` is recorded as given; junk is 422 with zero outbox rows', async () => {
    const { shipment } = await makeFinalisedExport(1, '26GB66666666666604')
    const bad = await api(`/api/opr/shipments/${shipment.id}/prealert/mark-sent`, {
      method: 'POST', body: JSON.stringify({ to: 'not-an-email' }),
    })
    expect(bad.status).toBe(422)
    expect((await emailRows(shipment.id)).length).toBe(0)

    const good = await api(`/api/opr/shipments/${shipment.id}/prealert/mark-sent`, {
      method: 'POST', body: JSON.stringify({ to: 'Customs.Desk@Carrier.Example' }),
    })
    expect(good.status).toBe(200)
    const rows = await emailRows(shipment.id)
    expect(rows.length).toBe(1)
    expect(rows[0].to_email).toBe('customs.desk@carrier.example') // normalised lowercase
  })

  it('clearance/mark-sent records a manual clearance row on an import consignment', async () => {
    const { shipment: exp, devices } = await makeFinalisedExport(1, '26GB66666666666605')
    const imp = await makeReturnShipment(exp.id)
    const scan = await api(`/api/opr/shipments/${imp.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: devices[0].imei }),
    })
    expect(scan.status).toBe(201)
    const res = await api(`/api/opr/shipments/${imp.id}/clearance/mark-sent`, {
      method: 'POST', body: JSON.stringify({ to: 'broker@example.com' }),
    })
    expect(res.status).toBe(200)
    const rows = await emailRows(imp.id)
    expect(rows.length).toBe(1)
    expect(rows[0].kind).toBe('clearance')
    expect(rows[0].provider).toBe('manual')
    expect(String(rows[0].subject)).toContain('clearance instruction')
  })

  it('direction guards: prealert/mark-sent refuses imports, clearance/mark-sent refuses exports (zero side-effects)', async () => {
    const { shipment: exp, devices } = await makeFinalisedExport(1, '26GB66666666666606')
    const imp = await makeReturnShipment(exp.id)
    await api(`/api/opr/shipments/${imp.id}/scan`, { method: 'POST', body: JSON.stringify({ imei: devices[0].imei }) })
    const a = await api(`/api/opr/shipments/${imp.id}/prealert/mark-sent`, { method: 'POST', body: '{}' })
    expect(a.status).toBe(409)
    const b = await api(`/api/opr/shipments/${exp.id}/clearance/mark-sent`, { method: 'POST', body: '{}' })
    expect(b.status).toBe(409)
    expect((await emailRows(exp.id)).length).toBe(0)
    expect((await emailRows(imp.id)).length).toBe(0)
  })

  it('empty consignment refuses mark-sent (nothing to pre-alert) with zero outbox rows', async () => {
    const shipment = await makeExportShipment()
    const res = await api(`/api/opr/shipments/${shipment.id}/prealert/mark-sent`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(422)
    expect((await emailRows(shipment.id)).length).toBe(0)
  })
})

describe('OPR 6: MUCR proof reference', () => {
  it('finalise captures mucr alongside MRN/DUCR/EAD (normalised uppercase)', async () => {
    const shipment = await makeExportShipment()
    const d = await makeDevice()
    await api(`/api/opr/shipments/${shipment.id}/scan`, { method: 'POST', body: JSON.stringify({ imei: d.imei }) })
    const fin = await api(`/api/opr/shipments/${shipment.id}/finalise`, {
      method: 'POST', body: JSON.stringify({ export_mrn: '26GB66666666666607', mucr: 'gb/sgat-12345678' }),
    })
    expect(fin.status).toBe(200)
    const row = await env.DB.prepare('SELECT mucr, export_mrn FROM shipments WHERE id = ?').bind(shipment.id).first<{ mucr: string; export_mrn: string }>()
    expect(row!.mucr).toBe('GB/SGAT-12345678')
    expect(row!.export_mrn).toBe('26GB66666666666607')
  })

  it('export-proof records/replaces mucr after finalisation; junk charset is 422 and does not touch the row', async () => {
    const { shipment } = await makeFinalisedExport(1, '26GB66666666666608')
    const ok = await api(`/api/opr/shipments/${shipment.id}/export-proof`, {
      method: 'POST', body: JSON.stringify({ mucr: 'GB/SGAT-00000001' }),
    })
    expect(ok.status).toBe(200)
    let row = await env.DB.prepare('SELECT mucr FROM shipments WHERE id = ?').bind(shipment.id).first<{ mucr: string }>()
    expect(row!.mucr).toBe('GB/SGAT-00000001')

    const bad = await api(`/api/opr/shipments/${shipment.id}/export-proof`, {
      method: 'POST', body: JSON.stringify({ mucr: 'GB/SGAT_!!bad' }),
    })
    expect(bad.status).toBe(422)
    row = await env.DB.prepare('SELECT mucr FROM shipments WHERE id = ?').bind(shipment.id).first<{ mucr: string }>()
    expect(row!.mucr).toBe('GB/SGAT-00000001') // unchanged

    const replace = await api(`/api/opr/shipments/${shipment.id}/export-proof`, {
      method: 'POST', body: JSON.stringify({ mucr: 'GB/SGAT-00000002' }),
    })
    expect(replace.status).toBe(200)
    row = await env.DB.prepare('SELECT mucr FROM shipments WHERE id = ?').bind(shipment.id).first<{ mucr: string }>()
    expect(row!.mucr).toBe('GB/SGAT-00000002')
  })

  it('DRAFT shipments still refuse export-proof (mucr included) — finalise first', async () => {
    const shipment = await makeExportShipment()
    const res = await api(`/api/opr/shipments/${shipment.id}/export-proof`, {
      method: 'POST', body: JSON.stringify({ mucr: 'GB/SGAT-99999999' }),
    })
    expect(res.status).toBe(409)
    const row = await env.DB.prepare('SELECT mucr FROM shipments WHERE id = ?').bind(shipment.id).first<{ mucr: string | null }>()
    expect(row!.mucr).toBeNull()
  })
})
