// Browser-UI check: an operator must NEVER see the reject/un-reject
// edges as "Move to" options at all (2026-09-01, second pass — the same
// failure class as reject-reason-ui.browser.mjs one layer up: serving the
// unfiltered ALLOWED_TRANSITIONS map to a non-manager would let their
// dropdown offer an edge that always 403s once picked).
//
// This checks the SERVER-FILTERED response actually changes what renders
// for an operator, through the real UI — not just that the API payload is
// filtered (that's covered in test/devicesRejectRoute.spec.ts already).
//
// Self-contained: seeds two devices (one RECEIVED, one REJECTED) via the
// admin API, logs in as the ops@saigates.com OPERATOR account (local-only
// test password provisioned via scripts/set-password.mjs — never touches
// production, never the real per-person credential's meaning) and checks
// what that role actually sees. Cleans up seeded rows after the run.
//
// IMEI prefix (corrected 2026-09-07): 8604567. Originally claimed 8604561,
// which collided with manifest-bill-link.browser.mjs (14e1d06, 2026-08-18)
// — a registry violation present since this file was written (ec31bf6,
// 2026-09-01) and never caught until a routine housekeeping check. See
// test/browser/README.md's prefix registry for the corrected assignment.
import './_harness.mjs'
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:3000'
let failures = 0
function check(name, cond, detail = '') {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
function luhnDigit(b) {
  let s = 0
  for (let i = 0; i < 14; i++) {
    let d = Number(b[i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    s += d
  }
  return String((10 - (s % 10)) % 10)
}
const mkImei = (n) => {
  const body = ('8604567' + String(Date.now() % 1000000).padStart(6, '0').slice(0, 5) + String(n).padStart(2, '0')).slice(0, 14)
  return body + luhnDigit(body)
}
const IMEI_RECEIVED = mkImei(1)
const IMEI_REJECTED = mkImei(2)

// Bootstrap as admin (owner@saigates.com) — need manager/admin to reach
// REJECTED at all, since that edge is gated.
const adminTok = (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'owner@saigates.com', password: 'local-owner-testpw' }),
})).json()).token
if (!adminTok) { console.log('BOOTSTRAP FAIL: no admin token'); process.exit(2) }
const adminApi = async (method, path, body) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, data: await r.json().catch(() => null) }
}
const receive = async (imei) => {
  const rcv = await adminApi('POST', '/scan/manual', {
    imei, sku: 'SAM-S26-256-CVT-A', brand: 'Samsung', model: 'Galaxy S26 (role-filter test)',
    capacity: '256GB', grade: 'A', buy_price: 120.0, currency: 'GBP', vat_type: 'margin', auto_print: false,
  })
  if (rcv.status !== 200 && rcv.status !== 201) { console.log('BOOTSTRAP FAIL receive', imei, rcv.status, JSON.stringify(rcv.data)); process.exit(2) }
  return rcv.data.received?.id ?? rcv.data.device?.id ?? rcv.data.id
}
const receivedId = await receive(IMEI_RECEIVED)
const rejectedId = await receive(IMEI_REJECTED)
{
  const t = await adminApi('POST', `/devices/${rejectedId}/transition`, { to_status: 'REJECTED', reason_code: 'faulty_on_test' })
  if (t.status !== 200) { console.log('BOOTSTRAP FAIL reject', t.status, JSON.stringify(t.data)); process.exit(2) }
}
console.log(`bootstrap: RECEIVED device ${receivedId} (${IMEI_RECEIVED}), REJECTED device ${rejectedId} (${IMEI_REJECTED})`)

// Sanity check the ADMIN's own API view still has the full map (proves
// any absence for the operator below is role-filtering, not something
// broken globally).
const adminMeta = await adminApi('GET', '/devices/meta/statuses')
check('admin API view of /meta/statuses includes RECEIVED->REJECTED', (adminMeta.data.transitions.RECEIVED || []).includes('REJECTED'), JSON.stringify(adminMeta.data.transitions.RECEIVED))

const browser = await chromium.launch()
const page = await browser.newPage()
const consoleErrors = []
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message))

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#login-email', { timeout: 15000 })
await page.fill('#login-email', 'ops@saigates.com')
await page.fill('#login-password', 'local-ops-testpw')
await page.click('#login-submit')
await page.waitForSelector('.tab-btn', { timeout: 15000 })
check('operator login succeeds', await page.isVisible('.tab-btn'))

await page.click('.tab-btn:has-text("Devices")')
await page.waitForSelector('h1:has-text("Devices")', { timeout: 8000 })
await page.waitForTimeout(500)

// 1. RECEIVED row: "Move to" select must NOT offer REJECTED for an operator.
const receivedRow = page.locator('tr', { hasText: IMEI_RECEIVED })
const receivedSelect = receivedRow.locator('select')
check('operator sees a "Move to" select on the RECEIVED row', await receivedSelect.count() > 0)
if (await receivedSelect.count() > 0) {
  const opts = await receivedSelect.locator('option').evaluateAll(els => els.map(e => e.value))
  check('operator\'s RECEIVED row does NOT offer REJECTED', !opts.includes('REJECTED'), opts.join(','))
  check('operator\'s RECEIVED row STILL offers SORTING (filtering is scoped, not blanket)', opts.includes('SORTING'), opts.join(','))
}

// 2. REJECTED row: switch to "All statuses" filter, confirm operator sees
//    "No moves" rather than a select offering RECEIVED (which would 403).
await page.selectOption('.input.text-sm.w-auto', { label: 'All statuses' })
await page.waitForTimeout(500)
const rejectedRow = page.locator('tr', { hasText: IMEI_REJECTED })
const rejectedSelectCount = await rejectedRow.locator('select').count()
check('operator\'s REJECTED row has NO "Move to" select at all (no outbound edges visible to this role)', rejectedSelectCount === 0, `select count=${rejectedSelectCount}`)
const rejectedRowText = await rejectedRow.textContent()
check('operator\'s REJECTED row shows "No moves" rather than a dead-end select', rejectedRowText.includes('No moves'), rejectedRowText)

check('no console errors observed during the whole run', consoleErrors.length === 0, consoleErrors.join(' || '))

await browser.close()

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
console.log(`CLEANUP_HINT device_ids=${receivedId},${rejectedId} imeis=${IMEI_RECEIVED},${IMEI_REJECTED}`)
console.log(`Cleanup (respecting FK order): DELETE FROM device_events WHERE device_id IN (${receivedId},${rejectedId}); DELETE FROM scan_events WHERE imei IN ('${IMEI_RECEIVED}','${IMEI_REJECTED}'); DELETE FROM received_devices WHERE id IN (${receivedId},${rejectedId});`)
process.exit(failures === 0 ? 0 : 1)
