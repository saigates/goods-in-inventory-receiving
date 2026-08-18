// Browser-UI smoke check for the Devices tab: All Devices sub-view +
// Repair Queue sub-view (repair-jobs join, Scan back, QC pass).
//
// Self-contained: seeds its own 3 devices via the real API (manual receive
// + status transitions + repair/start), so this script has no dependency
// on any external DB state or prior manual seeding. Same seed-and-clean
// pattern as temp-export-standard-lifecycle.mjs — local-only test password
// on owner@saigates.com (provisioned via scripts/set-password.mjs, never
// touches production), all seeded rows cleaned up after a run.
//
// IMEI namespace: 8604558 (next free after opr-ui 8604550-53, opr6-ui
// 8604554, dbg-valui/manifest-val 8604555, confirm-only 8604556,
// temp-export-standard-lifecycle 8604557).
import './_harness.mjs'  // enforced build + bundle-freshness check — see _harness.mjs
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
  const body = ('8604558' + String(Date.now() % 1000000).padStart(6, '0').slice(0, 5) + String(n).padStart(2, '0')).slice(0, 14)
  return body + luhnDigit(body)
}
const IMEI_SORTING = mkImei(1)   // RECEIVED -> SORTING, exercises the "Move to" select
const IMEI_REPAIR = mkImei(2)    // SORTING -> repair/start -> IN_HOUSE_REPAIR

async function waitForToastContaining(page, needle, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const t = (await page.$$eval('.toast', els => els.map(e => e.innerText.trim())))
      .find(x => x.toLowerCase().includes(needle.toLowerCase()))
    if (t) return t
    await page.waitForTimeout(100)
  }
  return null
}

// ── API bootstrap
const tok = (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'owner@saigates.com', password: 'local-owner-testpw' }),
})).json()).token
if (!tok) { console.log('BOOTSTRAP FAIL: no token — password_hash not applied?'); process.exit(2) }
const api = async (method, path, body) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, data: await r.json().catch(() => null) }
}
const receiveDevice = async (imei, model) => {
  const rcv = await api('POST', '/scan/manual', {
    imei, sku: 'SAM-S26-256-CVT-A', brand: 'Samsung', model, capacity: '256GB', grade: 'A',
    buy_price: 120.0, currency: 'GBP', vat_type: 'margin', auto_print: false,
  })
  if (rcv.status !== 200 && rcv.status !== 201) { console.log('BOOTSTRAP FAIL receive', imei, rcv.status, JSON.stringify(rcv.data)); process.exit(2) }
  return rcv.data.received?.id ?? rcv.data.device?.id ?? rcv.data.id
}

const sortingId = await receiveDevice(IMEI_SORTING, 'Galaxy S26 (sorting test)')
{
  const t = await api('POST', `/devices/${sortingId}/transition`, { to_status: 'SORTING' })
  if (t.status !== 200) { console.log('BOOTSTRAP FAIL sorting transition', t.status, JSON.stringify(t.data)); process.exit(2) }
}

const repairId = await receiveDevice(IMEI_REPAIR, 'Galaxy S26 (repair test)')
{
  const t = await api('POST', `/devices/${repairId}/transition`, { to_status: 'SORTING' })
  if (t.status !== 200) { console.log('BOOTSTRAP FAIL repair-device sorting', t.status, JSON.stringify(t.data)); process.exit(2) }
  const start = await api('POST', `/devices/${repairId}/repair/start`, { fault_code: 'Screen cracked' })
  if (start.status !== 201) { console.log('BOOTSTRAP FAIL repair/start', start.status, JSON.stringify(start.data)); process.exit(2) }
}

console.log(`bootstrap: SORTING device ${sortingId} (${IMEI_SORTING}), IN_HOUSE_REPAIR device ${repairId} (${IMEI_REPAIR})`)

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
check('login succeeds and app shell loads', await page.isVisible('.tab-btn'))

// 1. Devices tab exists and is clickable
const devicesTabVisible = await page.isVisible('.tab-btn:has-text("Devices")')
check('Devices tab exists in Topbar', devicesTabVisible)
await page.click('.tab-btn:has-text("Devices")')
await page.waitForSelector('h1:has-text("Devices")', { timeout: 8000 })
check('Devices view renders (h1 "Devices")', await page.isVisible('h1:has-text("Devices")'))

// 2. All Devices sub-view (default) — seeded test device visible
await page.waitForTimeout(300)
const allDevicesText = await page.textContent('body')
check('All Devices sub-view shows seeded RECEIVED->SORTING test device', allDevicesText.includes(IMEI_SORTING))

// Exercise a real transition: SORTING -> ACTIVE_INVENTORY via the "Move to" select
const row = page.locator('tr', { hasText: IMEI_SORTING })
const moveSelect = row.locator('select')
check('SORTING row has a "Move to" select with transition options', await moveSelect.count() > 0)
if (await moveSelect.count() > 0) {
  await moveSelect.selectOption('ACTIVE_INVENTORY')
  await page.waitForTimeout(1000)
  const toastText = await page.locator('.toast').allInnerTexts()
  check('transition toast confirms SORTING -> ACTIVE_INVENTORY', toastText.some(t => t.includes('SORTING') && t.includes('ACTIVE_INVENTORY')), toastText.join(' | '))
}

// 3. Repair Queue sub-view
await page.click('button:has-text("Repair Queue")')
await page.waitForTimeout(500)
const repairText = await page.textContent('body')
check('Repair Queue shows IN_HOUSE_REPAIR seeded device', repairText.includes(IMEI_REPAIR))
check('Repair Queue shows fault_code "Screen cracked" from repair_jobs join', repairText.includes('Screen cracked'))
check('Repair Queue shows job status "open"', repairText.includes('open'))

// Exercise Scan back on the open in-house-repair job
const repairRow = page.locator('tr', { hasText: IMEI_REPAIR })
const scanBackBtn = repairRow.locator('button:has-text("Scan back")')
check('open repair job row has a "Scan back" button', await scanBackBtn.count() > 0)
if (await scanBackBtn.count() > 0) {
  await scanBackBtn.click()
  await page.waitForTimeout(1000)
  const toastText2 = await page.locator('.toast').allInnerTexts()
  check('scan-back toast confirms "awaiting QC"', toastText2.some(t => t.toLowerCase().includes('awaiting qc')), toastText2.join(' | '))
  const bodyAfter2 = await page.textContent('body')
  check('row now shows awaiting_qc job status', bodyAfter2.includes('awaiting_qc'))
}

// QC pass on the now-awaiting_qc device (owner is admin -> manager-gated actions visible)
const repairRow2 = page.locator('tr', { hasText: IMEI_REPAIR })
const qcPassBtn = repairRow2.locator('button:has-text("QC pass")')
check('awaiting_qc row shows "QC pass" button for admin user', await qcPassBtn.count() > 0)
if (await qcPassBtn.count() > 0) {
  await qcPassBtn.click()
  await page.waitForTimeout(1000)
  const toastText3 = await page.locator('.toast').allInnerTexts()
  check('QC pass toast confirms "Ready for Zoho"', toastText3.some(t => t.toLowerCase().includes('ready for zoho')), toastText3.join(' | '))
}

check('no console errors observed during the whole run', consoleErrors.length === 0, consoleErrors.join(' || '))

await browser.close()

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
console.log(`CLEANUP_HINT device_ids=${sortingId},${repairId} imeis=${IMEI_SORTING},${IMEI_REPAIR}`)
console.log(`Cleanup (respecting FK order): DELETE FROM device_events WHERE device_id IN (${sortingId},${repairId}); DELETE FROM repair_jobs WHERE device_id IN (${sortingId},${repairId}); DELETE FROM scan_events WHERE imei IN ('${IMEI_SORTING}','${IMEI_REPAIR}'); DELETE FROM received_devices WHERE id IN (${sortingId},${repairId});`)
process.exit(failures === 0 ? 0 : 1)
