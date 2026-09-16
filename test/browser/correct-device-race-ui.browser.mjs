// Browser-UI regression check: CorrectDeviceModal's async-fetch race
// (2026-09-16, real incident — device 1319 / IMEI 355178160488248's live
// acceptance run).
//
// What happened live: openCorrectDeviceModal() sets ctx.manifestLine=null,
// ctx.loading=true, then asynchronously fetches GET /devices/:id (which
// populates ctx.manifestLine from the response's manifest_line field).
// The "Save correction" button was gated only on ctx.busy, never on
// ctx.loading — so an operator who picked a replacement SKU and clicked
// Save before that fetch resolved could submit with ctx.manifestLine still
// null. manifestMismatch's `!!ctx.manifestLine` guard then evaluated false
// regardless of the actual SKU values: no prompt shown,
// also_correct_manifest_line sent false, the manifest-line cascade never
// fired, and nothing on screen indicated anything had gone wrong. That is
// exactly what device 1319 produced: one SKU_CORRECTION event instead of
// two, expected_devices left at the old SKU.
//
// No pure-function or route-level vitest test can prove what the BUTTON's
// disabled state actually is at a given instant relative to an in-flight
// fetch — that is a rendered-DOM, real-timing claim, so it belongs here
// per the standing "any claim about a rendered verdict must be cited from
// a browser check" rule (test/browser/README.md). This script throttles
// the live GET /devices/:id response so the race window is wide enough to
// observe deterministically, rather than relying on incidental network
// speed.
//
// Two parts:
//   1. THROTTLED: while GET /devices/:id is artificially delayed, "Save
//      correction" must be disabled (proves the ctx.loading fix actually
//      blocks the window that caused the live incident) and a "Checking
//      linked manifest line…" placeholder must be visible instead of the
//      cascade checkbox. Once the delayed response lands, the button must
//      become enabled and — because this device's manifest line genuinely
//      disagrees with the freshly-picked SKU — the cascade checkbox must
//      now render. Checking it and submitting must send
//      also_correct_manifest_line: true (asserted server-side: the
//      manifest line's SKU is actually updated after submit).
//   2. FETCH-FAILURE: throttled to a network error instead of a delay —
//      proves the modal's catch path clears ctx.loading (so a failed
//      fetch degrades to a usable, cascade-less Save, never a frozen
//      button) and surfaces a visible error toast.
//
// Self-contained: seeds one manifest-linked device via the real API
// (POST /manifests -> POST /scan -> POST /scan/confirm, the same path a
// real receive uses, not a raw D1 insert) so expected_device_id is
// genuinely populated the way production data is. Local-dev-only test
// password on owner@saigates.com (scripts/set-password.mjs) — never
// touches production.
//
// IMEI prefix claimed: 8604572 (next free after csv-export-btn-ui's 8604569;
// zohoSaleImportApply.spec.ts/bulkSerials.spec.ts claimed 8604570/8604571 as
// non-.browser.mjs vitest specs per the registry's own convention).
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
  const body = ('8604572' + String(Date.now() % 1000000).padStart(6, '0').slice(0, 5) + String(n).padStart(2, '0')).slice(0, 14)
  return body + luhnDigit(body)
}
const IMEI_THROTTLE = mkImei(1)
const IMEI_FAILURE = mkImei(2)

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

// Real catalogue rows — a "wrong colour" pair sharing model/capacity/grade,
// same shape as the actual IMEI 355178160488248 incident (MIDNIGHT
// catalogued, should have been a different colour).
const suffix = Date.now().toString(36)
const SKU_WRONG = `RACEUI-WRONG-${suffix}`
const SKU_RIGHT = `RACEUI-RIGHT-${suffix}`
for (const [sku, color] of [[SKU_WRONG, 'MIDNIGHT'], [SKU_RIGHT, 'BLUE']]) {
  const r = await adminApi('POST', '/catalog', {
    brand: 'APPLE', model: `IPHONE RACEUI ${suffix}`, capacity: '128GB', color, grade: 'A', sku,
  })
  if (r.status !== 200 && r.status !== 201) { console.log('BOOTSTRAP FAIL catalog', sku, r.status, JSON.stringify(r.data)); process.exit(2) }
}

// Seed a manifest whose one line's sku is WRONG, scan+confirm it through
// the real API so expected_device_id genuinely links back — exactly the
// live incident's data shape (manifest line and device both wrong,
// operator about to fix the device but not yet the manifest line).
async function bootstrapLinkedDevice(imei) {
  const manifestRef = `RACEUI-${suffix}-${imei.slice(-4)}`
  const mf = await adminApi('POST', '/manifests', {
    reference: manifestRef, supplier: 'RaceUI Test Supplier',
    rows: [{ imei, model_no: `IPHONE RACEUI ${suffix}`, capacity: '128GB', color: 'MIDNIGHT', grade: 'A', unit_cost: 100, currency: 'GBP', vat_type: 'MARGIN' }],
  })
  if (mf.status !== 200 && mf.status !== 201) { console.log('BOOTSTRAP FAIL manifest', mf.status, JSON.stringify(mf.data)); process.exit(2) }
  const manifestId = mf.data.manifest_id
  const scanRes = await adminApi('POST', '/scan', { manifest_id: manifestId, imei })
  if (scanRes.data.outcome !== 'matched') { console.log('BOOTSTRAP FAIL scan (not matched)', JSON.stringify(scanRes.data)); process.exit(2) }
  const expectedDeviceId = scanRes.data.expected.id
  const confirmRes = await adminApi('POST', '/scan/confirm', {
    expected_device_id: expectedDeviceId, sku: SKU_WRONG, buy_price: 100, currency: 'GBP', vat_type: 'MARGIN', auto_print: false,
  })
  if (confirmRes.status !== 200 && confirmRes.status !== 201) { console.log('BOOTSTRAP FAIL confirm', confirmRes.status, JSON.stringify(confirmRes.data)); process.exit(2) }
  const deviceId = confirmRes.data.received?.id ?? confirmRes.data.device?.id ?? confirmRes.data.id
  return { deviceId, expectedDeviceId, manifestId }
}

const throttleFixture = await bootstrapLinkedDevice(IMEI_THROTTLE)
const failureFixture = await bootstrapLinkedDevice(IMEI_FAILURE)
console.log(`bootstrap: throttle device ${throttleFixture.deviceId} (${IMEI_THROTTLE}), failure device ${failureFixture.deviceId} (${IMEI_FAILURE}), both manifest-linked with sku=${SKU_WRONG}`)

const browser = await chromium.launch()
const consoleErrors = []

async function loginAsAdmin(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#login-email', { timeout: 15000 })
  await page.fill('#login-email', 'owner@saigates.com')
  await page.fill('#login-password', 'local-owner-testpw')
  await page.click('#login-submit')
  await page.waitForSelector('.tab-btn', { timeout: 15000 })
}

async function openModalFor(page, imei) {
  await page.click('.tab-btn:has-text("Devices")')
  await page.waitForSelector('h1:has-text("Devices")', { timeout: 8000 })
  await page.click('button:has-text("All Devices")').catch(() => {}) // may already be the default subview
  await page.waitForTimeout(400)
  const row = page.locator('tr', { hasText: imei })
  await row.locator('button:has-text("Correct details")').click()
  await page.waitForSelector('.modal-backdrop', { timeout: 8000 })
}

// ── Part 1: THROTTLED — Save must stay disabled during the fetch window,
// then become usable and correctly offer the cascade once it resolves ──
{
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push('throttle: ' + msg.text()) })
  page.on('pageerror', (err) => consoleErrors.push('throttle pageerror: ' + err.message))

  // Delay the specific GET /api/devices/:id call for this device by 2.5s —
  // long enough to reliably observe the disabled state without flaking on
  // normal request latency, short enough not to bloat the run.
  let releaseDelay
  const delayPromise = new Promise((resolve) => { releaseDelay = resolve })
  await context.route(`**/api/devices/${throttleFixture.deviceId}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await delayPromise
    await route.continue()
  })

  await loginAsAdmin(page)
  await openModalFor(page, IMEI_THROTTLE)

  // Scoped to the modal itself (.modal-backdrop) — the page has several
  // other <select>/<textarea> elements (subview filters, per-row "Move to"
  // pickers) that an unscoped locator would ambiguously match.
  const modal = page.locator('.modal-backdrop')
  check('while GET /devices/:id is in flight, "Checking linked manifest line…" is shown', await page.locator('text=Checking linked manifest line').count() > 0)

  const saveBtn = modal.locator('button:has-text("Save correction")')
  check('"Save correction" button exists', await saveBtn.count() > 0)
  check('"Save correction" is DISABLED while the manifest-line fetch is still in flight (the fix under test)', await saveBtn.isDisabled())

  // Pick the corrected SKU while still loading — this is exactly the
  // live-incident sequence (operator picks the SKU fast, before the fetch
  // resolves) and must NOT let the click through.
  await modal.locator('select').selectOption(SKU_RIGHT)
  await modal.locator('textarea').fill('race-ui throttle check: picked while still loading')
  check('"Save correction" is STILL disabled after picking a SKU while loading (clicking now must be a no-op)', await saveBtn.isDisabled())

  // Attempt a click anyway (defensive — a disabled button should not fire
  // its handler in a real browser, but assert no PATCH request escapes).
  let patchFiredWhileLoading = false
  const patchWatcher = (req) => {
    if (req.method() === 'PATCH' && req.url().includes(`/devices/${throttleFixture.deviceId}/correct`)) patchFiredWhileLoading = true
  }
  page.on('request', patchWatcher)
  await saveBtn.click({ force: false }).catch(() => {}) // disabled buttons refuse a real (non-forced) click
  await page.waitForTimeout(200)
  check('no PATCH /correct request escaped while the button was disabled', !patchFiredWhileLoading)
  page.off('request', patchWatcher)

  // Release the throttled response.
  releaseDelay()
  await page.waitForSelector('text=Checking linked manifest line', { state: 'detached', timeout: 8000 })

  check('"Save correction" becomes ENABLED once the manifest-line fetch resolves', !(await saveBtn.isDisabled()))
  check('the manifest-line cascade checkbox now renders (genuine mismatch: manifest still says the WRONG sku)', await page.locator(`text=${SKU_WRONG}`).count() > 0)

  const cascadeCheckbox = modal.locator('input[type=checkbox]')
  await cascadeCheckbox.check()
  await saveBtn.click()
  await page.waitForTimeout(700)
  check('a confirming toast appears after a successful correction', await page.locator('text=corrected').count() > 0)

  await context.close()
}

// Server-side confirmation: the cascade genuinely fired (manifest line
// SKU updated), not just an optimistic UI close.
{
  const check1 = await adminApi('GET', `/devices/${throttleFixture.deviceId}`)
  check('server confirms device sku corrected', check1.data?.device?.sku === SKU_RIGHT, JSON.stringify(check1.data?.device))
  check('server confirms the manifest line was ALSO cascaded (not left at the wrong sku)', check1.data?.manifest_line?.sku === SKU_RIGHT, JSON.stringify(check1.data?.manifest_line))
}

// ── Part 2: FETCH FAILURE — catch path must clear loading, not freeze Save ──
{
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push('failure: ' + msg.text()) })
  page.on('pageerror', (err) => consoleErrors.push('failure pageerror: ' + err.message))

  await context.route(`**/api/devices/${failureFixture.deviceId}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await route.abort('failed')
  })

  await loginAsAdmin(page)
  await openModalFor(page, IMEI_FAILURE)

  const modal2 = page.locator('.modal-backdrop')
  const saveBtn = modal2.locator('button:has-text("Save correction")')
  await page.waitForTimeout(1500) // give the aborted fetch time to reject and the catch path to run
  check('after the manifest-line fetch FAILS, "Save correction" is NOT permanently disabled (catch path clears loading)', !(await saveBtn.isDisabled()))
  check('a failure toast is shown for the failed manifest-line fetch', await page.locator('text=Failed to load device details').count() > 0)

  // Correcting the device itself must still work (no cascade offered,
  // since the manifest line was never learned — degraded but functional,
  // never a dead end).
  await modal2.locator('select').selectOption(SKU_RIGHT)
  await modal2.locator('textarea').fill('race-ui failure check: fetch failed, still correctable without cascade')
  check('no cascade checkbox is offered when the manifest line could not be fetched', await modal2.locator('input[type=checkbox]').count() === 0)
  await saveBtn.click()
  await page.waitForTimeout(700)
  check('correction still succeeds despite the earlier manifest-line fetch failure', await page.locator('text=corrected').count() > 0)

  await context.close()
}

check('no unexpected console errors observed during the whole run', consoleErrors.length === 0, consoleErrors.join(' || '))

await browser.close()

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
console.log(`CLEANUP_HINT throttle_device_id=${throttleFixture.deviceId} imei=${IMEI_THROTTLE} failure_device_id=${failureFixture.deviceId} imei=${IMEI_FAILURE}`)
console.log(`Cleanup (respecting FK order): DELETE FROM device_events WHERE device_id IN (${throttleFixture.deviceId}, ${failureFixture.deviceId}); DELETE FROM scan_events WHERE imei IN ('${IMEI_THROTTLE}', '${IMEI_FAILURE}'); DELETE FROM print_jobs WHERE received_device_id IN (${throttleFixture.deviceId}, ${failureFixture.deviceId}); DELETE FROM expected_devices WHERE id IN (${throttleFixture.expectedDeviceId}, ${failureFixture.expectedDeviceId}); DELETE FROM received_devices WHERE id IN (${throttleFixture.deviceId}, ${failureFixture.deviceId}); DELETE FROM manifests WHERE id IN (${throttleFixture.manifestId}, ${failureFixture.manifestId}); DELETE FROM sku_catalog WHERE sku IN ('${SKU_WRONG}', '${SKU_RIGHT}');`)
console.log(`Cleanup verification (run AFTER the DELETE above): SELECT (SELECT COUNT(*) FROM received_devices WHERE id IN (${throttleFixture.deviceId}, ${failureFixture.deviceId})) AS devices_remaining, (SELECT COUNT(*) FROM expected_devices WHERE id IN (${throttleFixture.expectedDeviceId}, ${failureFixture.expectedDeviceId})) AS expected_remaining, (SELECT COUNT(*) FROM manifests WHERE id IN (${throttleFixture.manifestId}, ${failureFixture.manifestId})) AS manifests_remaining, (SELECT COUNT(*) FROM sku_catalog WHERE sku IN ('${SKU_WRONG}', '${SKU_RIGHT}')) AS catalog_remaining; -- every column must read 0`)

process.exit(failures === 0 ? 0 : 1)
