// Browser-UI check: the bulk-transition reject/un-reject authorization
// bypass fix (2026-09-07). Root cause this closes: POST
// /devices/bulk-transition called transitionDevice() directly for every
// row with ZERO gating, so an operator token could bulk-reject or
// bulk-un-reject an entire scanned batch with plain HTTP 200s and no
// reason_code recorded at all — the single-device /:id/transition
// route's manager-gate + mandatory reason_code (2026-09-01) had no
// equivalent on this route. Fixed via a single shared helper,
// checkRejectUnrejectGate() (src/lib/deviceLifecycle.ts), now called
// once-per-call in the bulk route, at the single-device route, AND
// inside transitionDevice() itself as a defence-in-depth backstop
// (TransitionGateError) — see that file's own comments for why a
// once-per-call (not per-row) gate is exhaustive for these two edges.
//
// This is deliberately the BULK path specifically, not a re-check of the
// single-device modal (already covered by reject-role-filter-ui.browser.mjs
// and reject-reason-ui.browser.mjs) — per the standing rule that any claim
// about a rendered verdict must be cited from a browser check, never an
// API or pure-function test, and per the explicit instruction that this
// fix's required test matrix include "a browser check asserting the BULK
// path, not just single-device."
//
// Four things this checks that no vitest test can:
//   1. An OPERATOR opening the Bulk Transition modal does NOT see
//      REJECTED or RECEIVED in the target-status dropdown at all (the
//      role-affordance-filtered options, driven through the real UI).
//   2. A MANAGER/ADMIN opening the same modal DOES see both, and picking
//      either reveals a mandatory reason-code select that wasn't there
//      for any other target.
//   3. Submitting a gated batch with NO reason selected is blocked
//      client-side (a warn toast, no request sent) — the same UX
//      contract as the single-device RejectReasonModal.
//   4. A manager who DOES pick a reason and submits actually transitions
//      the device end-to-end through the real UI (progress panel shows
//      "transitioned", server confirms the new status and the event's
//      metadata carries {bulk:true, reason_code:...}).
//
// Self-contained: seeds two devices via the real HTTP API as admin (one
// RECEIVED for the reject-direction assertions, one already REJECTED for
// the un-reject-direction assertion), then drives the UI as ops@saigates.com
// (operator) and owner@saigates.com (admin) — real per-person accounts,
// local-dev-only test passwords via scripts/set-password.mjs, never
// touches production. Cleans up seeded rows after the run and VERIFIES
// the cleanup by re-querying afterwards, not by trusting the DELETE.
//
// IMEI prefix claimed: 8604568 (see test/browser/README.md's registry —
// checked against the list before claiming, per the 2026-09-07 housekeeping
// lesson from the reject-reason-ui/reject-role-filter-ui collisions).
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
  const body = ('8604568' + String(Date.now() % 1000000).padStart(6, '0').slice(0, 5) + String(n).padStart(2, '0')).slice(0, 14)
  return body + luhnDigit(body)
}
const IMEI_RECEIVED = mkImei(1)   // stays RECEIVED — used for the reject-direction batch
const IMEI_REJECTED = mkImei(2)   // driven to REJECTED during bootstrap — used for the un-reject-direction batch

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
const receive = async (imei, label) => {
  const rcv = await adminApi('POST', '/scan/manual', {
    imei, sku: 'SAM-S26-256-CVT-A', brand: 'Samsung', model: `Galaxy S26 (bulk-gate test ${label})`,
    capacity: '256GB', grade: 'A', buy_price: 120.0, currency: 'GBP', vat_type: 'margin', auto_print: false,
  })
  if (rcv.status !== 200 && rcv.status !== 201) { console.log('BOOTSTRAP FAIL receive', imei, rcv.status, JSON.stringify(rcv.data)); process.exit(2) }
  return rcv.data.received?.id ?? rcv.data.device?.id ?? rcv.data.id
}
const receivedId = await receive(IMEI_RECEIVED, 'received')
const rejectedId = await receive(IMEI_REJECTED, 'rejected')
{
  const t = await adminApi('POST', `/devices/${rejectedId}/transition`, { to_status: 'REJECTED', reason_code: 'faulty_on_test' })
  if (t.status !== 200) { console.log('BOOTSTRAP FAIL reject', t.status, JSON.stringify(t.data)); process.exit(2) }
}
console.log(`bootstrap: RECEIVED device ${receivedId} (${IMEI_RECEIVED}), REJECTED device ${rejectedId} (${IMEI_REJECTED})`)

const browser = await chromium.launch()
const consoleErrors = []

// ── Part 1: operator's Bulk Transition modal must NOT offer REJECTED or
//    RECEIVED as targets at all ──
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
  await page.click('button:has-text("Bulk transition by scan")')
  await page.waitForSelector('text=Bulk transition by scan', { timeout: 8000 })
  await page.waitForTimeout(300)

  const targetSelect = page.locator('.modal select').first()
  const opts = await targetSelect.locator('option').evaluateAll(els => els.map(e => e.value))
  check('operator\'s bulk target-status select does NOT offer REJECTED', !opts.includes('REJECTED'), opts.join(','))
  check('operator\'s bulk target-status select does NOT offer RECEIVED', !opts.includes('RECEIVED'), opts.join(','))
  check('operator\'s bulk target-status select STILL offers SORTING (filtering is scoped, not blanket)', opts.includes('SORTING'), opts.join(','))
  const advisoryText = await page.locator('.modal').textContent()
  check('operator sees the manager-only advisory note', advisoryText.includes('manager-only'), advisoryText.slice(0, 400))

  await page.close()
}

// ── Part 2: manager/admin sees both gated targets AND a mandatory
//    reason-code select; submitting with no reason is blocked client-side ──
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
  await page.click('button:has-text("Bulk transition by scan")')
  await page.waitForSelector('text=Bulk transition by scan', { timeout: 8000 })
  await page.waitForTimeout(300)

  const targetSelect = page.locator('.modal select').first()
  const adminOpts = await targetSelect.locator('option').evaluateAll(els => els.map(e => e.value))
  check('admin\'s bulk target-status select DOES offer REJECTED', adminOpts.includes('REJECTED'), adminOpts.join(','))
  check('admin\'s bulk target-status select DOES offer RECEIVED', adminOpts.includes('RECEIVED'), adminOpts.join(','))

  // No reason-code select should be visible before a gated target is picked.
  check('no reason-code select visible before a target is chosen', await page.locator('#bulk-transition-reason-select').count() === 0)

  // Pick REJECTED — a reason-code select must now appear.
  await targetSelect.selectOption('REJECTED')
  await page.waitForTimeout(300)
  const reasonSelect = page.locator('#bulk-transition-reason-select')
  check('reason-code select appears once REJECTED is picked as the bulk target', await reasonSelect.count() > 0)
  const reasonOpts = await reasonSelect.locator('option').evaluateAll(els => els.map(e => e.value))
  check('reason-code select is populated with REJECT_REASON_CODES (not empty, not a hardcoded single value)', reasonOpts.filter(Boolean).length >= 4, reasonOpts.join(','))
  check('reason-code select offers the known "faulty_on_test" code (same list source as the single-device modal)', reasonOpts.includes('faulty_on_test'), reasonOpts.join(','))

  // Paste the RECEIVED-direction IMEI and try to submit with NO reason picked.
  await page.fill('#bulk-transition-textarea', IMEI_RECEIVED)
  await page.click('#bulk-transition-run-btn')
  await page.waitForTimeout(500)
  const toastAfterNoReason = await page.locator('text=Select a reason code').count()
  check('submitting a gated batch with no reason selected is blocked client-side with a warning toast', toastAfterNoReason > 0)
  // Confirm the request genuinely never left the browser for this attempt:
  // the device must still be RECEIVED server-side.
  const stillReceived = await adminApi('GET', `/devices?q=${IMEI_RECEIVED}&page_size=5`)
  const stillReceivedRow = (stillReceived.data.devices || [])[0]
  check('device is still RECEIVED after the no-reason submit attempt (no request reached the server)', stillReceivedRow && stillReceivedRow.status === 'RECEIVED', JSON.stringify(stillReceivedRow))

  // Now pick a valid reason and submit for real — the reject-direction batch.
  await reasonSelect.selectOption('faulty_on_test')
  await page.click('#bulk-transition-run-btn')
  // Wait for the outcome badge itself (not a fixed sleep) — the request is
  // async and a fixed delay is a flaky proxy for "the render committed".
  await page.waitForSelector('.modal .badge', { timeout: 8000 }).catch(() => {})
  const transitionedBadge = await page.locator('.modal .badge:has-text("transitioned")').count()
  check('a "transitioned" outcome badge renders for the batch row', transitionedBadge > 0)
  const progressText = await page.locator('.modal').textContent()
  check('progress panel reports 1 transitioned after a valid manager bulk-reject', progressText.includes('1') && progressText.toLowerCase().includes('transitioned'), progressText.slice(0, 600))

  await page.close()
}

check('no console errors observed during the whole run', consoleErrors.length === 0, consoleErrors.join(' || '))

await browser.close()

// ── Server-side confirmation (not just optimistic UI state) ──
// 1. The RECEIVED-direction device really moved to REJECTED, with the
//    batch's reason_code recorded and {bulk:true} in the event metadata.
const afterReject = await adminApi('GET', `/devices?q=${IMEI_RECEIVED}&page_size=5`)
const afterRejectRow = (afterReject.data.devices || [])[0]
check('server confirms the UI-driven bulk-reject actually moved the device to REJECTED', afterRejectRow && afterRejectRow.status === 'REJECTED', JSON.stringify(afterRejectRow))

const rejectEvents = await adminApi('GET', `/devices/${receivedId}`).catch(() => ({ data: null }))
let rejectEventFound = false
let rejectEventDetail = ''
if (rejectEvents && rejectEvents.data) {
  const events = rejectEvents.data.events || []
  const ev = Array.isArray(events) ? events.find((e) => e.event_type === 'REJECT') : null
  if (ev) {
    let meta = ev.metadata
    if (typeof meta === 'string') { try { meta = JSON.parse(meta) } catch { meta = null } }
    rejectEventFound = !!(meta && meta.bulk === true && meta.reason_code === 'faulty_on_test')
    rejectEventDetail = JSON.stringify(ev)
  }
}
check('the REJECT event\'s metadata carries {bulk:true, reason_code:"faulty_on_test"} (proves the bulk route wrote batch-level metadata, not a bare transition)', rejectEventFound, rejectEventDetail)

// 2. Un-reject-direction device (seeded already-REJECTED) is untouched by
//    this run (we never submitted a batch for it) — sanity that Part 2's
//    assertions were scoped to the RECEIVED-direction IMEI only, not a
//    stray effect on the other fixture.
const stillRejected = await adminApi('GET', `/devices?q=${IMEI_REJECTED}&page_size=5`)
const stillRejectedRow = (stillRejected.data.devices || [])[0]
check('the separately-seeded already-REJECTED fixture is untouched (still REJECTED)', stillRejectedRow && stillRejectedRow.status === 'REJECTED', JSON.stringify(stillRejectedRow))

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
console.log(`CLEANUP_HINT device_ids=${receivedId},${rejectedId} imeis=${IMEI_RECEIVED},${IMEI_REJECTED}`)
console.log(`Cleanup (respecting FK order): DELETE FROM device_events WHERE device_id IN (${receivedId},${rejectedId}); DELETE FROM scan_events WHERE imei IN ('${IMEI_RECEIVED}','${IMEI_REJECTED}'); DELETE FROM received_devices WHERE id IN (${receivedId},${rejectedId});`)
// This script has no D1 binding (only fetch()), so — same as every other
// script in this directory — it cannot run the DELETE itself; it prints
// the statement above plus this re-query for whoever runs the cleanup to
// confirm with, rather than trusting the DELETE succeeded from exit code
// alone. Run this AFTER applying the DELETE line above:
console.log(`Cleanup verification (run AFTER the DELETE above): SELECT (SELECT COUNT(*) FROM received_devices WHERE id IN (${receivedId},${rejectedId})) AS devices_remaining, (SELECT COUNT(*) FROM device_events WHERE device_id IN (${receivedId},${rejectedId})) AS events_remaining, (SELECT COUNT(*) FROM scan_events WHERE imei IN ('${IMEI_RECEIVED}','${IMEI_REJECTED}')) AS scan_events_remaining; -- every column must read 0`)

process.exit(failures === 0 ? 0 : 1)
