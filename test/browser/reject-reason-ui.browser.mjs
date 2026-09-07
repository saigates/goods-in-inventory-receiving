// Browser-UI check for the RECEIVED<->REJECTED reason-code flow
// (2026-09-01 live-incident fix, commit 84a57e7 + this follow-up).
//
// Confirms end-to-end, through the REAL rendered SPA (not an API call and
// not a pure-function test), that:
//   1. the "Move to" select on a RECEIVED device offers REJECTED (proving
//      the client reads the transition map from the server, not a stale
//      client-side copy)
//   2. picking REJECTED opens the reason-code modal rather than firing a
//      bare POST that would 422 (the frontend gap this pass fixes)
//   3. submitting without a reason is blocked client-side
//   4. picking a reason and submitting transitions the device and the
//      toast reports it
//   5. the reverse edge (REJECTED -> RECEIVED) goes through the same
//      modal with the UNREJECT reason list
//
// Self-contained: seeds its own device via the real API, cleans up
// nothing destructive to existing data. Local-only test password on
// owner@saigates.com (scripts/set-password.mjs), never touches
// production or the real per-person credentials.
//
// IMEI prefix (corrected 2026-09-07): 8604566. Originally claimed 8604560,
// which collided with bills-tab.browser.mjs (44f6d4e, 2026-08-18) — a
// registry violation present since this file was written (d64bc28,
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
  const body = ('8604566' + String(Date.now() % 1000000).padStart(6, '0').slice(0, 5) + String(n).padStart(2, '0')).slice(0, 14)
  return body + luhnDigit(body)
}
const IMEI_REJECT = mkImei(1)

const tok = (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'owner@saigates.com', password: 'local-owner-testpw' }),
})).json()).token
if (!tok) { console.log('BOOTSTRAP FAIL: no token'); process.exit(2) }
const api = async (method, path, body) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, data: await r.json().catch(() => null) }
}
const rcv = await api('POST', '/scan/manual', {
  imei: IMEI_REJECT, sku: 'SAM-S26-256-CVT-A', brand: 'Samsung', model: 'Galaxy S26 (reject-ui test)',
  capacity: '256GB', grade: 'A', buy_price: 120.0, currency: 'GBP', vat_type: 'margin', auto_print: false,
})
if (rcv.status !== 200 && rcv.status !== 201) { console.log('BOOTSTRAP FAIL receive', rcv.status, JSON.stringify(rcv.data)); process.exit(2) }
const deviceId = rcv.data.received?.id ?? rcv.data.device?.id ?? rcv.data.id
console.log(`bootstrap: RECEIVED device ${deviceId} (${IMEI_REJECT})`)

const browser = await chromium.launch()
const page = await browser.newPage()
const consoleErrors = []
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message))

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#login-email', { timeout: 15000 })
await page.fill('#login-email', 'owner@saigates.com')
await page.fill('#login-password', 'local-owner-testpw')
await page.click('#login-submit')
await page.waitForSelector('.tab-btn', { timeout: 15000 })

await page.click('.tab-btn:has-text("Devices")')
await page.waitForSelector('h1:has-text("Devices")', { timeout: 8000 })
// Default filter excludes REJECTED but includes RECEIVED — no filter change needed.
await page.waitForTimeout(500)

const row = page.locator('tr', { hasText: IMEI_REJECT })
const moveSelect = row.locator('select')
check('RECEIVED row has a "Move to" select', await moveSelect.count() > 0)

// 1. Server-sourced options: REJECTED must be an <option>, proving no stale client copy.
const optionValues = await moveSelect.locator('option').evaluateAll(els => els.map(e => e.value))
check('"Move to" select offers REJECTED (server-sourced transition map)', optionValues.includes('REJECTED'), optionValues.join(','))

// 2. Selecting REJECTED opens the reason modal, NOT a bare transition.
await moveSelect.selectOption('REJECTED')
await page.waitForTimeout(400)
check('reason modal opens (not a bare 422 POST)', await page.isVisible('#reject-reason-select'))
check('modal header says "Reject device"', (await page.textContent('body')).includes('Reject device'))

// 3. Submit with no reason selected -> blocked client-side (still open, warn toast).
await page.click('#reject-reason-submit')
await page.waitForTimeout(300)
check('submitting with no reason stays on the modal', await page.isVisible('#reject-reason-select'))
const warnToast = await page.locator('.toast').allInnerTexts()
check('warn toast asks for a reason', warnToast.some(t => t.toLowerCase().includes('reason')), warnToast.join(' | '))

// 4. Pick a reason code and submit -> device actually transitions.
const rejectOptionValues = await page.locator('#reject-reason-select option').evaluateAll(els => els.map(e => e.value).filter(Boolean))
check('reason select has REJECT_REASON_CODES options (server-sourced)', rejectOptionValues.length > 0, rejectOptionValues.join(','))
await page.selectOption('#reject-reason-select', rejectOptionValues[0])
await page.click('#reject-reason-submit')
await page.waitForTimeout(1000)
const rejectToast = await page.locator('.toast').allInnerTexts()
check('reject transition toast confirms RECEIVED -> REJECTED', rejectToast.some(t => t.includes('RECEIVED') && t.includes('REJECTED')), rejectToast.join(' | '))
const afterReject = await api('GET', `/devices?q=${IMEI_REJECT}`)
const devAfterReject = (afterReject.data?.devices || [])[0]
check('device status is REJECTED via API cross-check', devAfterReject?.status === 'REJECTED', JSON.stringify(devAfterReject))

// 5. Reverse edge: REJECTED -> RECEIVED goes through the same modal with the UNREJECT list.
await page.click('.tab-btn:has-text("Devices")')
await page.waitForSelector('h1:has-text("Devices")', { timeout: 8000 });
// REJECTED is excluded from the default filter — switch to "All statuses".
await page.selectOption('.input.text-sm.w-auto', { label: 'All statuses' })
await page.waitForTimeout(500)
const rejectedRow = page.locator('tr', { hasText: IMEI_REJECT })
const unrejectSelect = rejectedRow.locator('select')
const unrejectOptionValues = await unrejectSelect.locator('option').evaluateAll(els => els.map(e => e.value))
check('REJECTED row\'s "Move to" select offers RECEIVED', unrejectOptionValues.includes('RECEIVED'), unrejectOptionValues.join(','))
await unrejectSelect.selectOption('RECEIVED')
await page.waitForTimeout(400)
check('un-reject modal header says "Un-reject device"', (await page.textContent('body')).includes('Un-reject device'))
const unrejectCodes = await page.locator('#reject-reason-select option').evaluateAll(els => els.map(e => e.value).filter(Boolean))
check('un-reject reason select has UNREJECT_REASON_CODES options, distinct set', unrejectCodes.includes('rejected_in_error'), unrejectCodes.join(','))
await page.selectOption('#reject-reason-select', 'rejected_in_error')
await page.click('#reject-reason-submit')
await page.waitForTimeout(1000)
const unrejectToast = await page.locator('.toast').allInnerTexts()
check('un-reject transition toast confirms REJECTED -> RECEIVED', unrejectToast.some(t => t.includes('REJECTED') && t.includes('RECEIVED')), unrejectToast.join(' | '))
const afterUnreject = await api('GET', `/devices?q=${IMEI_REJECT}&status=RECEIVED,SORTING,ACTIVE_INVENTORY,READY_FOR_EXPORT,REJECTED`)
const devAfterUnreject = (afterUnreject.data?.devices || [])[0]
check('device status is back to RECEIVED via API cross-check', devAfterUnreject?.status === 'RECEIVED', JSON.stringify(devAfterUnreject))

check('no console errors observed during the whole run', consoleErrors.length === 0, consoleErrors.join(' || '))

await browser.close()

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
console.log(`CLEANUP_HINT device_id=${deviceId} imei=${IMEI_REJECT}`)
console.log(`Cleanup (respecting FK order): DELETE FROM device_events WHERE device_id IN (${deviceId}); DELETE FROM scan_events WHERE imei IN ('${IMEI_REJECT}'); DELETE FROM received_devices WHERE id IN (${deviceId});`)
process.exit(failures === 0 ? 0 : 1)
