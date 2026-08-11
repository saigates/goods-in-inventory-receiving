// Ticket C — Communication tracker: truthful send/receive logging, the
// 3-working-day (Mon–Fri, bank holidays ignored) follow-up flag, and the
// per-return outstanding-items checklist.
//
// Load-bearing assertions:
//   - Send log (sent_emails, kind='correspondence'): status is always the
//     caller's stated true outcome — never defaulted to 'sent'; a 'failed'
//     send requires an error detail; a bad/missing status is rejected.
//   - Received replies (shipment_replies): logged against the shipment,
//     retrievable, cannot be forward-dated.
//   - Follow-up flag: no sends → not flagged; sends with a reply logged
//     since → not flagged; sends with NO reply and >= 3 working days
//     elapsed (Mon–Fri only, weekends never counted) → flagged; < 3
//     working days → not yet flagged.
//   - Checklist: applies to IMPORT shipments only (409 on export); starts
//     fully outstanding; each field flips independently; VAT evidence is
//     generic free text (no PVA/C79 assumption baked in).
import { env } from 'cloudflare:workers'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'
import {
  isWorkingDay, workingDaysBetween, computeFollowUpStatus, computeOutstandingChecklist,
} from '../src/lib/oprComms'
import type { Shipment } from '../src/types'

const JWT_SECRET = 'test-secret-opr-comms'
const testEnv = { ...env, JWT_SECRET } as typeof env & { JWT_SECRET: string }

let token = ''
let authId = 0

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

async function makeFinalisedExport(n: number, mrn: string) {
  const ref = `COMMS EXP ${100 + shipmentSeq++}`
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
  const shipment = ((await res.json()) as { shipment: { id: number } }).shipment
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

// Plain DRAFT export shipment (no lines) — enough for correspondence/
// replies/follow-up tests, which don't care about the consignment builder.
async function makeDraftExport() {
  const res = await api('/api/opr/shipments', {
    method: 'POST',
    body: JSON.stringify({
      reference: `COMMS EXP ${100 + shipmentSeq++}`, direction: 'export', authorisation_id: authId,
      procedure_code: '2100', ship_date: '2026-07-01',
      consignee_name: 'Overseas Repairer BV', consignee_address: 'Repairstraat 1, Amsterdam, NL',
      carrier: 'FedEx', incoterm: 'DAP',
    }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { shipment: Shipment }).shipment
}

async function makeReturnShipment(relatedExportId: number, overrides: Record<string, unknown> = {}) {
  const res = await api('/api/opr/shipments', {
    method: 'POST',
    body: JSON.stringify({
      reference: `COMMS IMP ${100 + shipmentSeq++}`, direction: 'import',
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
      supervising_office_code: 'GBLIV002',
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
  await env.DB.prepare(`
    DELETE FROM sent_emails WHERE shipment_id IN (
      SELECT id FROM shipments WHERE reference LIKE 'COMMS EXP %' OR reference LIKE 'COMMS IMP %'
    )
  `).run()
  await env.DB.prepare(`
    DELETE FROM shipment_replies WHERE shipment_id IN (
      SELECT id FROM shipments WHERE reference LIKE 'COMMS EXP %' OR reference LIKE 'COMMS IMP %'
    )
  `).run()
  await env.DB.prepare("DELETE FROM shipment_lines WHERE imei LIKE '8604552%'").run()
  await env.DB.prepare("DELETE FROM shipments WHERE reference LIKE 'COMMS EXP %' OR reference LIKE 'COMMS IMP %'").run()
  await env.DB.prepare('DELETE FROM opr_authorisations WHERE id = ?').bind(authId).run()
})

// ═════════ Pure helpers ═════════

describe('OPR comms — working-day helpers (pure)', () => {
  it('isWorkingDay: Mon–Fri true, Sat/Sun false — bank holidays are NOT special-cased', () => {
    // 2026-08-10 is a Monday.
    expect(isWorkingDay('2026-08-10')).toBe(true) // Mon
    expect(isWorkingDay('2026-08-11')).toBe(true) // Tue
    expect(isWorkingDay('2026-08-14')).toBe(true) // Fri
    expect(isWorkingDay('2026-08-15')).toBe(false) // Sat
    expect(isWorkingDay('2026-08-16')).toBe(false) // Sun
    // 2026-08-31 is the August bank holiday (Mon) in England — still a
    // working day by this function, exactly as instructed ("ignore bank
    // holidays").
    expect(isWorkingDay('2026-08-31')).toBe(true)
  })

  it('workingDaysBetween: Mon → Thu = 3 working days (Tue, Wed, Thu)', () => {
    expect(workingDaysBetween('2026-08-10T09:00:00.000Z', '2026-08-13T09:00:00.000Z')).toBe(3)
  })

  it('workingDaysBetween: Fri → Mon = 1 (weekend skipped entirely)', () => {
    expect(workingDaysBetween('2026-08-14T09:00:00.000Z', '2026-08-17T09:00:00.000Z')).toBe(1)
  })

  it('workingDaysBetween: same day or backwards = 0', () => {
    expect(workingDaysBetween('2026-08-10T09:00:00.000Z', '2026-08-10T17:00:00.000Z')).toBe(0)
    expect(workingDaysBetween('2026-08-10T09:00:00.000Z', '2026-08-09T09:00:00.000Z')).toBe(0)
  })
})

describe('OPR comms — follow-up flag (pure)', () => {
  it('no sends at all → never flagged', () => {
    const status = computeFollowUpStatus([], [], '2026-08-20T09:00:00.000Z')
    expect(status.flagged).toBe(false)
    expect(status.last_send_at).toBeNull()
  })

  it('sent Mon, checked Wed (2 working days) → NOT yet flagged', () => {
    const status = computeFollowUpStatus(
      [{ status: 'sent', created_at: '2026-08-10T09:00:00.000Z' }], // Mon
      [],
      '2026-08-12T09:00:00.000Z', // Wed
    )
    expect(status.working_days_since_send).toBe(2)
    expect(status.flagged).toBe(false)
  })

  it('sent Mon, checked Thu (3 working days, no reply) → FLAGGED', () => {
    const status = computeFollowUpStatus(
      [{ status: 'sent', created_at: '2026-08-10T09:00:00.000Z' }], // Mon
      [],
      '2026-08-13T09:00:00.000Z', // Thu
    )
    expect(status.working_days_since_send).toBe(3)
    expect(status.flagged).toBe(true)
    expect(status.reply_logged_since_send).toBe(false)
  })

  it('a reply logged since the last send clears the flag even past 3 working days', () => {
    const status = computeFollowUpStatus(
      [{ status: 'sent', created_at: '2026-08-10T09:00:00.000Z' }], // Mon
      [{ received_at: '2026-08-11T09:00:00.000Z' }], // Tue reply
      '2026-08-14T09:00:00.000Z', // Fri — well past 3 working days
    )
    expect(status.flagged).toBe(false)
    expect(status.reply_logged_since_send).toBe(true)
  })

  it('a failed or manual send still counts as something to chase (honesty rule governs status, not chase eligibility)', () => {
    const status = computeFollowUpStatus(
      [{ status: 'failed', created_at: '2026-08-10T09:00:00.000Z' }], // Mon
      [],
      '2026-08-13T09:00:00.000Z', // Thu
    )
    expect(status.flagged).toBe(true)
  })

  it('the weekend spanning Fri→Mon does NOT count toward the 3-day threshold', () => {
    // Sent Wed. By Mon (next week) only 3 working days have passed
    // (Thu, Fri, Mon) — Sat/Sun contribute zero.
    const status = computeFollowUpStatus(
      [{ status: 'sent', created_at: '2026-08-12T09:00:00.000Z' }], // Wed
      [],
      '2026-08-17T09:00:00.000Z', // following Mon
    )
    expect(status.working_days_since_send).toBe(3)
    expect(status.flagged).toBe(true)
  })
})

describe('OPR comms — outstanding-items checklist (pure)', () => {
  it('all four items outstanding when nothing is recorded', () => {
    const result = computeOutstandingChecklist({
      import_mrn: null, customs_entry_ref: null, vat_evidence_ref: null, repair_cost_confirmed_at: null,
    })
    expect(result.outstanding_count).toBe(4)
    expect(result.complete).toBe(false)
  })

  it('complete when all four are present — VAT evidence is accepted as generic free text (no PVA/C79 assumption)', () => {
    const result = computeOutstandingChecklist({
      import_mrn: '26GB1111111111AA01',
      customs_entry_ref: 'C88-2026-000123',
      vat_evidence_ref: 'Awaiting agent confirmation of evidence type — placeholder ref ABC123',
      repair_cost_confirmed_at: '2026-08-10T10:00:00.000Z',
    })
    expect(result.outstanding_count).toBe(0)
    expect(result.complete).toBe(true)
    expect(result.items.find(i => i.code === 'VAT_EVIDENCE')!.done).toBe(true)
  })
})

// ═════════ End-to-end: truthful send log ═════════

describe('OPR comms — POST /correspondence (truthful send log)', () => {
  it('logs a real send with status=sent; never defaults status', async () => {
    const exp = await makeDraftExport()
    const res = await api(`/api/opr/shipments/${exp.id}/correspondence`, {
      method: 'POST',
      body: JSON.stringify({ mailbox: 'controlprealert@fedex.com', summary: 'Chased status of batch 001 clearance', status: 'sent' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { email_id: number; status: string }
    expect(body.status).toBe('sent')

    const row = await env.DB.prepare('SELECT kind, to_email, subject, status, provider FROM sent_emails WHERE id = ?')
      .bind(body.email_id).first<{ kind: string; to_email: string; subject: string; status: string; provider: string }>()
    expect(row!.kind).toBe('correspondence')
    expect(row!.to_email).toBe('controlprealert@fedex.com')
    expect(row!.status).toBe('sent')
    expect(row!.provider).toBe('gmail')
  })

  it('logs a manual send with provider=manual', async () => {
    const exp = await makeDraftExport()
    const res = await api(`/api/opr/shipments/${exp.id}/correspondence`, {
      method: 'POST',
      body: JSON.stringify({ mailbox: 'ops@saigates.example', summary: 'Called FedEx, confirmed by phone, followed up by email from personal inbox', status: 'manual' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { email_id: number }
    const row = await env.DB.prepare('SELECT status, provider FROM sent_emails WHERE id = ?')
      .bind(body.email_id).first<{ status: string; provider: string }>()
    expect(row!.status).toBe('manual')
    expect(row!.provider).toBe('manual')
  })

  it('a failed attempt requires an error detail — refuses to log a bare "failed" with no reason', async () => {
    const exp = await makeDraftExport()
    const missingError = await api(`/api/opr/shipments/${exp.id}/correspondence`, {
      method: 'POST',
      body: JSON.stringify({ mailbox: 'controlprealert@fedex.com', summary: 'Attempted chase', status: 'failed' }),
    })
    expect(missingError.status).toBe(422)

    const withError = await api(`/api/opr/shipments/${exp.id}/correspondence`, {
      method: 'POST',
      body: JSON.stringify({ mailbox: 'controlprealert@fedex.com', summary: 'Attempted chase', status: 'failed', error: 'SMTP timeout after 30s' }),
    })
    expect(withError.status).toBe(201)
    const body = await withError.json() as { email_id: number }
    const row = await env.DB.prepare('SELECT status, error FROM sent_emails WHERE id = ?')
      .bind(body.email_id).first<{ status: string; error: string }>()
    expect(row!.status).toBe('failed')
    expect(row!.error).toBe('SMTP timeout after 30s')
  })

  it('rejects a missing/invalid status — never silently defaults to "sent"', async () => {
    const exp = await makeDraftExport()
    const noStatus = await api(`/api/opr/shipments/${exp.id}/correspondence`, {
      method: 'POST', body: JSON.stringify({ mailbox: 'x@fedex.com', summary: 'test' }),
    })
    expect(noStatus.status).toBe(422)
    expect(((await noStatus.json()) as { error: string }).error).toMatch(/never defaulted/)

    const badStatus = await api(`/api/opr/shipments/${exp.id}/correspondence`, {
      method: 'POST', body: JSON.stringify({ mailbox: 'x@fedex.com', summary: 'test', status: 'delivered' }),
    })
    expect(badStatus.status).toBe(422)

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM sent_emails WHERE shipment_id = ?').bind(exp.id).first<{ n: number }>()
    expect(count!.n).toBe(0)
  })
})

// ═════════ End-to-end: received replies ═════════

describe('OPR comms — replies (received correspondence)', () => {
  it('logs a received reply against the shipment and lists it', async () => {
    const exp = await makeDraftExport()
    const res = await api(`/api/opr/shipments/${exp.id}/replies`, {
      method: 'POST',
      body: JSON.stringify({ from_mailbox: 'controlprealert@fedex.com', summary: 'Confirmed clearance instruction received, processing' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { reply: { id: number; from_mailbox: string; summary: string; received_at: string } }
    expect(body.reply.from_mailbox).toBe('controlprealert@fedex.com')
    expect(body.reply.received_at).toBeTruthy()

    const list = await api(`/api/opr/shipments/${exp.id}/replies`)
    expect(list.status).toBe(200)
    const replies = ((await list.json()) as { replies: { id: number }[] }).replies
    expect(replies.length).toBe(1)
    expect(replies[0].id).toBe(body.reply.id)
  })

  it('refuses a future received_at (a reply cannot be logged before it happened)', async () => {
    const exp = await makeDraftExport()
    const future = new Date(Date.now() + 86400000).toISOString()
    const res = await api(`/api/opr/shipments/${exp.id}/replies`, {
      method: 'POST',
      body: JSON.stringify({ from_mailbox: 'x@fedex.com', summary: 'test', received_at: future }),
    })
    expect(res.status).toBe(422)
  })

  it('accepts a backdated received_at (logging a reply that actually arrived earlier)', async () => {
    const exp = await makeDraftExport()
    const res = await api(`/api/opr/shipments/${exp.id}/replies`, {
      method: 'POST',
      body: JSON.stringify({ from_mailbox: 'x@fedex.com', summary: 'test', received_at: '2026-08-01T10:00:00.000Z' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { reply: { received_at: string } }
    expect(body.reply.received_at.slice(0, 10)).toBe('2026-08-01')
  })
})

// ═════════ End-to-end: follow-up flag over real HTTP data ═════════

describe('OPR comms — GET /follow-up (real exchange, HTTP end-to-end)', () => {
  it('no correspondence yet → not flagged', async () => {
    const exp = await makeDraftExport()
    const res = await api(`/api/opr/shipments/${exp.id}/follow-up`)
    expect(res.status).toBe(200)
    const body = await res.json() as { flagged: boolean }
    expect(body.flagged).toBe(false)
  })

  it('a real send, backdated 4 working days, with no reply → FLAGGED; after logging a reply → clears', async () => {
    const exp = await makeDraftExport()
    const send = await api(`/api/opr/shipments/${exp.id}/correspondence`, {
      method: 'POST',
      body: JSON.stringify({ mailbox: 'controlprealert@fedex.com', summary: 'Chasing clearance confirmation', status: 'sent' }),
    })
    expect(send.status).toBe(201)
    const { email_id } = await send.json() as { email_id: number }
    // Backdate to a real Monday, 4 working days before a fixed "now" we
    // control via the real send's created_at + directly reading it back —
    // the follow-up endpoint uses the DB's actual now, so backdate the row
    // far enough into the past that "today" is unambiguously >= 3 working
    // days later regardless of which real day this test runs on (7
    // calendar days always covers >= 3 working days).
    const eightDaysAgo = new Date(Date.now() - 8 * 86400000).toISOString()
    await env.DB.prepare('UPDATE sent_emails SET created_at = ? WHERE id = ?').bind(eightDaysAgo, email_id).run()

    const flagged = await api(`/api/opr/shipments/${exp.id}/follow-up`)
    expect(flagged.status).toBe(200)
    const flaggedBody = await flagged.json() as { flagged: boolean; working_days_since_send: number }
    expect(flaggedBody.flagged).toBe(true)
    expect(flaggedBody.working_days_since_send).toBeGreaterThanOrEqual(3)

    // Log a reply after that send — the flag must clear.
    const reply = await api(`/api/opr/shipments/${exp.id}/replies`, {
      method: 'POST', body: JSON.stringify({ from_mailbox: 'controlprealert@fedex.com', summary: 'Reply received' }),
    })
    expect(reply.status).toBe(201)

    const cleared = await api(`/api/opr/shipments/${exp.id}/follow-up`)
    const clearedBody = await cleared.json() as { flagged: boolean; reply_logged_since_send: boolean }
    expect(clearedBody.flagged).toBe(false)
    expect(clearedBody.reply_logged_since_send).toBe(true)
  })

  it('a recent send (< 3 working days old) is not yet flagged', async () => {
    const exp = await makeDraftExport()
    const send = await api(`/api/opr/shipments/${exp.id}/correspondence`, {
      method: 'POST',
      body: JSON.stringify({ mailbox: 'controlprealert@fedex.com', summary: 'Just sent', status: 'sent' }),
    })
    expect(send.status).toBe(201)
    const res = await api(`/api/opr/shipments/${exp.id}/follow-up`)
    const body = await res.json() as { flagged: boolean }
    expect(body.flagged).toBe(false)
  })
})

// ═════════ End-to-end: per-return outstanding-items checklist ═════════

describe('OPR comms — checklist (real state, HTTP end-to-end)', () => {
  it('applies to IMPORT shipments only — 409 on export', async () => {
    const exp = await makeDraftExport()
    const res = await api(`/api/opr/shipments/${exp.id}/checklist`)
    expect(res.status).toBe(409)
  })

  it('starts fully outstanding on a fresh return shipment, then reflects real recorded state field-by-field', async () => {
    const { shipment: exp, devices } = await makeFinalisedExport(1, '26GB0000COMMS001')
    const ret = await makeReturnShipment(exp.id)

    const initial = await api(`/api/opr/shipments/${ret.id}/checklist`)
    expect(initial.status).toBe(200)
    const initialBody = await initial.json() as { outstanding_count: number; complete: boolean }
    expect(initialBody.outstanding_count).toBe(4)
    expect(initialBody.complete).toBe(false)

    // Return builder needs at least one line before it can finalise (red
    // validation otherwise) — scan the exported device back onto it.
    const scan = await api(`/api/opr/shipments/${ret.id}/scan`, {
      method: 'POST', body: JSON.stringify({ imei: devices[0].imei }),
    })
    expect(scan.status).toBe(201)

    // Record the import MRN via the existing /import-proof endpoint (not
    // duplicated by the checklist route) — first finalise the return so
    // import-proof is accepted (it's the only mutation FINALISED accepts).
    const fin = await api(`/api/opr/shipments/${ret.id}/finalise`, {
      method: 'POST', body: JSON.stringify({ import_mrn: '26GB0000COMMS002' }),
    })
    expect(fin.status).toBe(200)

    const afterMrn = await api(`/api/opr/shipments/${ret.id}/checklist`)
    const afterMrnBody = await afterMrn.json() as { outstanding_count: number; items: { code: string; done: boolean }[] }
    expect(afterMrnBody.outstanding_count).toBe(3)
    expect(afterMrnBody.items.find(i => i.code === 'IMPORT_MRN')!.done).toBe(true)

    // Record customs entry + VAT evidence (generic ref) via the checklist route.
    const setEntries = await api(`/api/opr/shipments/${ret.id}/checklist`, {
      method: 'POST',
      body: JSON.stringify({ customs_entry_ref: 'C88-2026-000456', vat_evidence_ref: 'Evidence pending agent confirmation — ref DOC-9981' }),
    })
    expect(setEntries.status).toBe(200)
    const setEntriesBody = await setEntries.json() as { outstanding_count: number }
    expect(setEntriesBody.outstanding_count).toBe(1) // only repair-cost confirmation left

    // Confirm repair cost.
    const confirm = await api(`/api/opr/shipments/${ret.id}/checklist`, {
      method: 'POST', body: JSON.stringify({ repair_cost_confirmed: true }),
    })
    expect(confirm.status).toBe(200)
    const confirmBody = await confirm.json() as { outstanding_count: number; complete: boolean }
    expect(confirmBody.outstanding_count).toBe(0)
    expect(confirmBody.complete).toBe(true)

    // Un-confirming flips it back — the checklist reflects REAL current state, not a one-way tick.
    const unconfirm = await api(`/api/opr/shipments/${ret.id}/checklist`, {
      method: 'POST', body: JSON.stringify({ repair_cost_confirmed: false }),
    })
    expect(unconfirm.status).toBe(200)
    const unconfirmBody = await unconfirm.json() as { outstanding_count: number }
    expect(unconfirmBody.outstanding_count).toBe(1)
  })

  it('rejects a non-boolean repair_cost_confirmed and an empty body', async () => {
    const { shipment: exp } = await makeFinalisedExport(1, '26GB0000COMMS003')
    const ret = await makeReturnShipment(exp.id)

    const badType = await api(`/api/opr/shipments/${ret.id}/checklist`, {
      method: 'POST', body: JSON.stringify({ repair_cost_confirmed: 'yes' }),
    })
    expect(badType.status).toBe(422)

    const empty = await api(`/api/opr/shipments/${ret.id}/checklist`, { method: 'POST', body: JSON.stringify({}) })
    expect(empty.status).toBe(422)
  })
})
