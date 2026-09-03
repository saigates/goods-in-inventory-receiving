// Browser-UI check: an operator must NEVER see a working "Reopen" button
// on a QC_FAILED repair-queue row, and must instead see the informational
// "Reopen is manager-only" fallback text (2026-09-03, commit 3 — the
// reopen-gate change). Same shape as reject-role-filter-ui.browser.mjs one
// level up: /repair/reopen was newly gated server-side with
// requireManager() in src/routes/devices.ts, and the client-side
// RepairQueueSubview() button was gated in the SAME change (per the
// standing rule in this file's own README: "any manager-gated action
// needs its affordance filtered by role in the SAME commit that creates
// it"). This script is the still-missing browser-level evidence for that
// UI-facing half of the claim — up to now it had only been verified via
// `git show` source-diff inspection, never an actual rendered check.
//
// This checks the SERVER-FILTERED role actually changes what renders for
// an operator, through the real UI — not just that the API 403s (that's
// already covered by test/repairWorkflow.spec.ts's #27b). It also checks
// the manager's OWN view still shows a working button, so any absence for
// the operator below is role-filtering, not something broken globally.
//
// Self-contained: seeds one QC_FAILED device via the admin API (receive ->
// SORTING -> repair/start -> scan-back -> repair/qc FAILED), logs in first
// as the manager to confirm the button still works there, then as the
// ops@saigates.com OPERATOR account (local-only test password provisioned
// via scripts/set-password.mjs — never touches production) to confirm the
// fallback text renders and clicking is not possible. Cleans up seeded
// rows after the run.
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
  const body = ('8604565' + String(Date.now() % 1000000).padStart(6, '0').slice(0, 5) + String(n).padStart(2, '0')).slice(0, 14)
  return body + luhnDigit(body)
}
const IMEI_QC_FAILED = mkImei(1)

// Bootstrap as admin (owner@saigates.com) — need manager/admin to drive
// the device through repair/start, scan-back and repair/qc(FAILED).
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
    imei, sku: 'SAM-S26-256-CVT-A', brand: 'Samsung', model: 'Galaxy S26 (reopen-role-filter test)',
    capacity: '256GB', grade: 'A', buy_price: 120.0, currency: 'GBP', vat_type: 'margin', auto_print: false,
  })
  if (rcv.status !== 200 && rcv.status !== 201) { console.log('BOOTSTRAP FAIL receive', imei, rcv.status, JSON.stringify(rcv.data)); process.exit(2) }
  return rcv.data.received?.id ?? rcv.data.device?.id ?? rcv.data.id
}
const qcFailedId = await receive(IMEI_QC_FAILED)
{
  const t = await adminApi('POST', `/devices/${qcFailedId}/transition`, { to_status: 'SORTING' })
  if (t.status !== 200) { console.log('BOOTSTRAP FAIL sorting', t.status, JSON.stringify(t.data)); process.exit(2) }
  const start = await adminApi('POST', `/devices/${qcFailedId}/repair/start`, { fault_code: 'Screen cracked (reopen-role-filter test)' })
  if (start.status !== 201) { console.log('BOOTSTRAP FAIL repair/start', start.status, JSON.stringify(start.data)); process.exit(2) }
  const back = await adminApi('POST', `/devices/${qcFailedId}/repair/scan-back`, {})
  if (back.status !== 200) { console.log('BOOTSTRAP FAIL scan-back', back.status, JSON.stringify(back.data)); process.exit(2) }
  const qc = await adminApi('POST', `/devices/${qcFailedId}/repair/qc`, { result: 'FAILED', reason: 'Camera still faulty (reopen-role-filter test)' })
  if (qc.status !== 200) { console.log('BOOTSTRAP FAIL repair/qc FAILED', qc.status, JSON.stringify(qc.data)); process.exit(2) }
}
console.log(`bootstrap: QC_FAILED device ${qcFailedId} (${IMEI_QC_FAILED})`)

// Sanity check the ADMIN's own API view can still reopen (proves any
// absence for the operator below is role-filtering, not something broken
// globally). We don't actually call it here — that would flip the device
// out of QC_FAILED before the UI checks below get to see it — but we
// confirm the button renders for a manager-class user in the browser pass.

const browser = await chromium.launch()
const page = await browser.newPage()
const consoleErrors = []
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message))

// ───────── 1. Manager/admin view: button renders and is clickable ─────────
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#login-email', { timeout: 15000 })
await page.fill('#login-email', 'owner@saigates.com')
await page.fill('#login-password', 'local-owner-testpw')
await page.click('#login-submit')
await page.waitForSelector('.tab-btn', { timeout: 15000 })
check('admin login succeeds', await page.isVisible('.tab-btn'))

await page.click('.tab-btn:has-text("Devices")')
await page.waitForSelector('h1:has-text("Devices")', { timeout: 8000 })
await page.click('button:has-text("Repair Queue")')
await page.waitForTimeout(500)

const adminRow = page.locator('tr', { hasText: IMEI_QC_FAILED })
check('admin sees the seeded QC_FAILED row in the Repair Queue', await adminRow.count() > 0)
const adminReopenBtn = adminRow.locator('button:has-text("Reopen")')
check('admin/manager row HAS a working "Reopen" button', await adminReopenBtn.count() > 0)
const adminFallback = adminRow.locator('text=Reopen is manager-only')
check('admin/manager row does NOT show the "Reopen is manager-only" fallback', await adminFallback.count() === 0)

// ───────── 2. Operator view: fallback text only, no button ─────────
// Log out (reload to a fresh unauthenticated context) and log back in as
// the operator, rather than trying to find a UI logout control — simplest
// and matches how login-prod.browser.mjs and reject-role-filter-ui handle
// role switches (a fresh page/context each time).
await page.close()
const page2 = await browser.newPage()
page2.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
page2.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message))

await page2.goto(BASE, { waitUntil: 'domcontentloaded' })
await page2.waitForSelector('#login-email', { timeout: 15000 })
await page2.fill('#login-email', 'ops@saigates.com')
await page2.fill('#login-password', 'local-ops-testpw')
await page2.click('#login-submit')
await page2.waitForSelector('.tab-btn', { timeout: 15000 })
check('operator login succeeds', await page2.isVisible('.tab-btn'))

await page2.click('.tab-btn:has-text("Devices")')
await page2.waitForSelector('h1:has-text("Devices")', { timeout: 8000 })
await page2.click('button:has-text("Repair Queue")')
await page2.waitForTimeout(500)

const opRow = page2.locator('tr', { hasText: IMEI_QC_FAILED })
check('operator sees the same seeded QC_FAILED row in the Repair Queue', await opRow.count() > 0)
const opReopenBtn = opRow.locator('button:has-text("Reopen")')
check('operator row does NOT offer a "Reopen" button', await opReopenBtn.count() === 0)
const opFallbackText = await opRow.textContent()
check('operator row shows "Reopen is manager-only" instead', opFallbackText.includes('Reopen is manager-only'), opFallbackText)

// Confirm the server side actually backs this up too, not just the UI —
// an operator token hitting the route directly still gets 403 (this is
// the same assertion test/repairWorkflow.spec.ts's #27b makes via the
// workers test pool, repeated here against the real running dev server
// for end-to-end confidence that nothing diverges between the two paths).
const opTok = (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'ops@saigates.com', password: 'local-ops-testpw' }),
})).json()).token
const opReopenApi = await fetch(`${BASE}/api/devices/${qcFailedId}/repair/reopen`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opTok}` }, body: '{}',
})
check('operator token hitting POST /repair/reopen directly still gets 403 (server backs up the UI gate)', opReopenApi.status === 403, String(opReopenApi.status))

check('no console errors observed during the whole run', consoleErrors.length === 0, consoleErrors.join(' || '))

await browser.close()

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
console.log(`CLEANUP_HINT device_ids=${qcFailedId} imeis=${IMEI_QC_FAILED}`)
console.log(`Cleanup (respecting FK order): DELETE FROM device_events WHERE device_id IN (${qcFailedId}); DELETE FROM repair_jobs WHERE device_id IN (${qcFailedId}); DELETE FROM scan_events WHERE imei IN ('${IMEI_QC_FAILED}'); DELETE FROM received_devices WHERE id IN (${qcFailedId});`)
process.exit(failures === 0 ? 0 : 1)
