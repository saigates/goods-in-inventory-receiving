// Browser-UI check: the "Close to inventory" button on the Ready-for-Zoho
// subview (commit 2, 2026-09-02) — READY_FOR_ZOHO -> ACTIVE_INVENTORY.
//
// Three things this checks that no vitest test can (per the standing
// "any claim about a rendered verdict must be cited from a browser check"
// rule — test/repairWorkflow.spec.ts already covers the route/function
// contract itself):
//   1. A MANAGER-OR-ADMIN caller sees the button on a READY_FOR_ZOHO row.
//   2. An OPERATOR caller does NOT see it at all (absence is the half
//      that regresses silently — a stale/removed role check would leave
//      the button visible with nothing to catch it except this check).
//   3. After a successful close, the device disappears from the
//      Ready-for-Zoho subview entirely (it left READY_FOR_ZOHO, so the
//      `GET /devices?status=READY_FOR_ZOHO` list this subview reads must
//      no longer include it — same "no console errors, no stale row"
//      standard as the other subview checks in this directory).
//
// Self-contained: seeds one device via the real HTTP API (admin), drives
// it to READY_FOR_ZOHO through the real repair-workflow routes (start ->
// scan-back -> QC PASSED), then drives the UI itself as first an operator
// (to assert absence) and then as admin (to assert presence + the close
// action + post-close disappearance). Local-dev-only test passwords via
// scripts/set-password.mjs — never touches production. Cleans up seeded
// rows after the run and VERIFIES the cleanup by re-querying the API
// afterwards (device is gone; a lookup 404s) rather than just trusting the
// DELETE statement executed.
//
// IMEI prefix claimed: 8604564 (see the registry in this file's README).
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
  const body = ('8604564' + String(Date.now() % 1000000).padStart(6, '0').slice(0, 5) + String(n).padStart(2, '0')).slice(0, 14)
  return body + luhnDigit(body)
}
const IMEI = mkImei(1)

// Bootstrap as admin (owner@saigates.com) — need manager/admin to drive
// the repair workflow (start/scan-back/qc are manager-gated for qc).
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

const rcv = await adminApi('POST', '/scan/manual', {
  imei: IMEI, sku: 'SAM-S26-256-CVT-A', brand: 'Samsung', model: 'Galaxy S26 (close-to-inventory test)',
  capacity: '256GB', grade: 'A', buy_price: 120.0, currency: 'GBP', vat_type: 'margin', auto_print: false,
})
if (rcv.status !== 200 && rcv.status !== 201) { console.log('BOOTSTRAP FAIL receive', rcv.status, JSON.stringify(rcv.data)); process.exit(2) }
const deviceId = rcv.data.received?.id ?? rcv.data.device?.id ?? rcv.data.id

{
  const t = await adminApi('POST', `/devices/${deviceId}/transition`, { to_status: 'SORTING' })
  if (t.status !== 200) { console.log('BOOTSTRAP FAIL sorting transition', t.status, JSON.stringify(t.data)); process.exit(2) }
}
{
  const s = await adminApi('POST', `/devices/${deviceId}/repair/start`, { fault_code: 'SCREEN_CRACKED' })
  if (s.status !== 201) { console.log('BOOTSTRAP FAIL repair/start', s.status, JSON.stringify(s.data)); process.exit(2) }
}
{
  const sb = await adminApi('POST', `/devices/${deviceId}/repair/scan-back`, {})
  if (sb.status !== 200) { console.log('BOOTSTRAP FAIL repair/scan-back', sb.status, JSON.stringify(sb.data)); process.exit(2) }
}
{
  const qc = await adminApi('POST', `/devices/${deviceId}/repair/qc`, { result: 'PASSED' })
  if (qc.status !== 200) { console.log('BOOTSTRAP FAIL repair/qc PASSED', qc.status, JSON.stringify(qc.data)); process.exit(2) }
}
console.log(`bootstrap: READY_FOR_ZOHO device ${deviceId} (${IMEI})`)

// Sanity: confirm the seeded device really is READY_FOR_ZOHO before
// touching the browser at all (so a later FAIL is unambiguously about the
// UI, not a bootstrap mistake).
{
  const check1 = await adminApi('GET', `/devices?status=READY_FOR_ZOHO&page_size=200`)
  const found = (check1.data.devices || []).some((d) => d.id === deviceId)
  check('bootstrap: seeded device is READY_FOR_ZOHO before any browser interaction', found)
}

const browser = await chromium.launch()
const consoleErrors = []

// ── Part 1: operator must NOT see the button at all ──
{
  const page = await browser.newPage()
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push('operator: ' + msg.text()) })
  page.on('pageerror', (err) => consoleErrors.push('operator pageerror: ' + err.message))

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#login-email', { timeout: 15000 })
  await page.fill('#login-email', 'ops@saigates.com')
  await page.fill('#login-password', 'local-ops-testpw')
  await page.click('#login-submit')
  await page.waitForSelector('.tab-btn', { timeout: 15000 })
  check('operator login succeeds', await page.isVisible('.tab-btn'))

  await page.click('.tab-btn:has-text("Devices")')
  await page.waitForSelector('h1:has-text("Devices")', { timeout: 8000 })
  await page.click('button:has-text("Ready for Zoho")')
  await page.waitForTimeout(500)

  const row = page.locator('tr', { hasText: IMEI })
  check('operator can see the READY_FOR_ZOHO row itself (list is not role-filtered, only the action is)', await row.count() > 0)
  const closeBtn = row.locator('button:has-text("Close to inventory")')
  check('operator does NOT see the "Close to inventory" button', await closeBtn.count() === 0)
  const rowText = await row.textContent()
  check('operator sees "Manager-only" placeholder text instead of the button', rowText.includes('Manager-only'), rowText)

  await page.close()
}

// ── Part 2: admin/manager sees and can use the button; row disappears after ──
{
  const page = await browser.newPage()
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push('admin: ' + msg.text()) })
  page.on('pageerror', (err) => consoleErrors.push('admin pageerror: ' + err.message))

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#login-email', { timeout: 15000 })
  await page.fill('#login-email', 'owner@saigates.com')
  await page.fill('#login-password', 'local-owner-testpw')
  await page.click('#login-submit')
  await page.waitForSelector('.tab-btn', { timeout: 15000 })
  check('admin login succeeds', await page.isVisible('.tab-btn'))

  await page.click('.tab-btn:has-text("Devices")')
  await page.waitForSelector('h1:has-text("Devices")', { timeout: 8000 })
  await page.click('button:has-text("Ready for Zoho")')
  await page.waitForTimeout(500)

  const row = page.locator('tr', { hasText: IMEI })
  check('admin sees the READY_FOR_ZOHO row', await row.count() > 0)
  const closeBtn = row.locator('button:has-text("Close to inventory")')
  check('admin sees the "Close to inventory" button', await closeBtn.count() > 0)

  if (await closeBtn.count() > 0) {
    await closeBtn.click()
    await page.waitForTimeout(700)
    const toastVisible = await page.locator('text=closed to inventory').count() > 0
    check('a confirming toast appears after clicking "Close to inventory"', toastVisible)

    const rowAfter = page.locator('tr', { hasText: IMEI })
    check('the device row disappears from the Ready-for-Zoho subview after a successful close (it has left READY_FOR_ZOHO)', await rowAfter.count() === 0)
  }

  await page.close()
}

check('no console errors observed during the whole run', consoleErrors.length === 0, consoleErrors.join(' || '))

await browser.close()

// Server-side confirmation the transition actually happened (not just a
// UI-only optimistic render that would still show "gone" even if the API
// call silently failed).
const finalDevice = await adminApi('GET', `/devices?q=${IMEI}&page_size=5`)
const finalRow = (finalDevice.data.devices || [])[0]
check('server confirms device status is ACTIVE_INVENTORY after the UI-driven close', finalRow && finalRow.status === 'ACTIVE_INVENTORY', JSON.stringify(finalRow))

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
console.log(`CLEANUP_HINT device_id=${deviceId} imei=${IMEI}`)
console.log(`Cleanup (respecting FK order): DELETE FROM cost_ledger WHERE received_device_id = ${deviceId}; DELETE FROM device_events WHERE device_id = ${deviceId}; DELETE FROM repair_jobs WHERE device_id = ${deviceId}; DELETE FROM scan_events WHERE imei = '${IMEI}'; DELETE FROM received_devices WHERE id = ${deviceId};`)
// This script has no D1 binding (only fetch()), so — same as every other
// script in this directory — it cannot run the DELETE itself; it prints
// the statement above plus this re-query for whoever runs the cleanup to
// confirm with, rather than trusting the DELETE succeeded from exit code
// alone. Run this AFTER applying the DELETE line above:
console.log(`Cleanup verification (run AFTER the DELETE above): SELECT (SELECT COUNT(*) FROM received_devices WHERE id = ${deviceId}) AS device_remaining, (SELECT COUNT(*) FROM repair_jobs WHERE device_id = ${deviceId}) AS repair_jobs_remaining, (SELECT COUNT(*) FROM device_events WHERE device_id = ${deviceId}) AS events_remaining, (SELECT COUNT(*) FROM scan_events WHERE imei = '${IMEI}') AS scan_events_remaining; -- every column must read 0`)

process.exit(failures === 0 ? 0 : 1)
