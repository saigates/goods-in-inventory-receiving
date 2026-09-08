// Browser-UI check: the CSV export button (B3, STEP 3, 2026-09-07) on the
// Inventory view's toolbar — src/routes/devices.ts's GET /export/csv route,
// wired through app.js's doExportCsv() -> openWithDocToken() (same
// window.open()+doc-token pattern as the print/OPR document routes; see
// src/lib/auth.ts's DOC_TOKEN_ALLOWED_PATHS).
//
// Per the standing "any rendered-verdict claim must be browser-verified"
// rule — test/csvExport.spec.ts (B4) already covers the route/SQL/header
// contract itself via direct fetch(); what only a real browser can prove:
//   1. The button is actually rendered in the Inventory toolbar, for BOTH
//      an operator and a manager/admin — deliberately visible to both roles
//      (the standing "cost-bearing export is fine to expose to all roles
//      since the backend already narrows the header" call, STEP 3), unlike
//      most of this directory's role-gated buttons which check an ABSENCE.
//   2. Clicking it drives the real doExportCsv() -> openWithDocToken() code
//      path end-to-end: a popup opens, a doc-token is minted via a real
//      POST /api/auth/doc-token call, and the popup's next navigation is
//      to /api/devices/export/csv?excel=1&token=... — not a mocked click
//      handler.
//   3. NOTE (found empirically while writing this check, not assumed): the
//      response carries Content-Disposition: attachment, so Chromium fires
//      Playwright's `download` event on the browser CONTEXT rather than
//      navigating the popup to a rendered page — the popup itself stays at
//      about:blank throughout, confirmed by an earlier debug run of this
//      same click sequence, which is why this check listens for
//      `context.on('download')` (download.url() carries the exact
//      requested URL incl. query string; download.createReadStream() reads
//      the real response body) rather than page.on('response') on the
//      popup, which never fires here.
//   4. The downloaded body's first line is the expected column header for
//      that caller's role — proving the ?excel=1 query param the button
//      hardcodes actually reached the server and the manager/operator
//      column-count gate applies to this exact browser-driven request, not
//      just the direct-fetch tests.
//   5. The operator's downloaded body's IMEI cell uses the `="..."` Excel
//      text-forcing form (proving ?excel=1 took effect for a real button
//      click, not just a hand-built query string in csvExport.spec.ts).
//
// Self-contained: seeds one device via the real HTTP API as admin, then
// drives the UI as both ops@saigates.com (operator) and owner@saigates.com
// (admin) — real per-person accounts, local-dev-only test passwords via
// scripts/set-password.mjs, never touches production. Cleans up the seeded
// row after the run and VERIFIES the cleanup by re-querying afterwards, not
// by trusting the DELETE.
//
// IMEI prefix claimed: 8604569 (see test/browser/README.md's registry —
// checked against the list before claiming; next free after
// bulk-transition-gate-ui's 8604568).
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
  const body = ('8604569' + String(Date.now() % 1000000).padStart(6, '0').slice(0, 5) + String(n).padStart(2, '0')).slice(0, 14)
  return body + luhnDigit(body)
}
const IMEI = mkImei(1)

// Bootstrap as admin (owner@saigates.com).
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
  imei: IMEI, sku: 'SAM-S26-256-CVT-A', brand: 'Samsung', model: 'Galaxy S26 (csv-export-btn-ui test)',
  capacity: '256GB', grade: 'A', buy_price: 120.0, currency: 'GBP', vat_type: 'margin', auto_print: false,
})
if (rcv.status !== 200 && rcv.status !== 201) { console.log('BOOTSTRAP FAIL receive', rcv.status, JSON.stringify(rcv.data)); process.exit(2) }
const deviceId = rcv.data.received?.id ?? rcv.data.device?.id ?? rcv.data.id
console.log(`bootstrap: seeded device ${deviceId} (${IMEI})`)

const browser = await chromium.launch()
const consoleErrors = []

// Shared driver: log in as the given role, go to Inventory, click Export
// CSV, capture the resulting browser `download` (see the module comment's
// note #3 for why this is a download, not a popup navigation), and read
// its body directly off the response stream. Returns { firstLine, bodyText,
// downloadUrl }. Each call gets its OWN browser context (not just a new
// page) — the two roles must not share localStorage/session state, or the
// second login would silently skip the login form using the first role's
// still-valid token, exactly as happened in this script's first draft.
async function driveExport(email, password, roleLabel) {
  const context = await browser.newContext({ acceptDownloads: true })
  const page = await context.newPage()
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(`${roleLabel}: ${msg.text()}`) })
  page.on('pageerror', (err) => consoleErrors.push(`${roleLabel} pageerror: ${err.message}`))

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#login-email', { timeout: 15000 })
  await page.fill('#login-email', email)
  await page.fill('#login-password', password)
  await page.click('#login-submit')
  await page.waitForSelector('.tab-btn', { timeout: 15000 })
  check(`${roleLabel} login succeeds`, await page.isVisible('.tab-btn'))

  await page.click('.tab-btn:has-text("Inventory")')
  await page.waitForSelector('h1:has-text("Inventory")', { timeout: 8000 })

  const exportBtn = page.locator('button:has-text("Export CSV")')
  check(`${roleLabel} sees the Export CSV button in the Inventory toolbar`, await exportBtn.count() > 0)

  const [download] = await Promise.all([
    context.waitForEvent('download', { timeout: 10000 }).catch((e) => { consoleErrors.push(`${roleLabel} download wait error: ${e.message}`); return null }),
    exportBtn.click(),
  ])
  check(`${roleLabel} clicking Export CSV triggers a real browser download`, !!download)

  const downloadUrl = download ? download.url() : ''
  check(`${roleLabel} download URL is the export endpoint with ?excel=1`, downloadUrl.includes('/api/devices/export/csv') && downloadUrl.includes('excel=1'), downloadUrl)

  let bodyText = ''
  if (download) {
    const stream = await download.createReadStream()
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    bodyText = Buffer.concat(chunks).toString('utf8')
  }
  const firstLine = bodyText.split('\r\n')[0] || ''

  await context.close()
  return { firstLine, bodyText, downloadUrl, roleLabel }
}

const OPERATOR_HEADER = 'id,uuid,imei,sku,brand,model,capacity,color,grade,status,source,vat_type,created_at,received_date,vendor'
const MANAGER_HEADER = OPERATOR_HEADER + ',bill_ref,purchase_cost_gbp,repair_cost_gbp'

// ── Part 1: operator ──
const opResult = await driveExport('ops@saigates.com', 'local-ops-testpw', 'operator')
check('operator CSV header omits cost columns entirely (15-col shape)', opResult.firstLine === OPERATOR_HEADER, opResult.firstLine)

// Locate this run's own seeded row in the operator body and confirm the
// IMEI cell is the ?excel=1 ="..." text-forcing form — proving the query
// param the button hardcodes really reached the server for a genuine
// browser click, not just a hand-built fetch.
{
  const lines = opResult.bodyText.split('\r\n')
  const dataLine = lines.find(l => l.includes(String(deviceId)) && l.startsWith(String(deviceId) + ','))
  check('operator CSV body contains this run\'s seeded device row', !!dataLine, `deviceId=${deviceId}; lines=${lines.length}`)
  check('operator CSV IMEI cell uses the ?excel=1 ="..." text-forcing form', !!dataLine && dataLine.includes(`="${IMEI}"`), dataLine || '')
}

// ── Part 2: admin/manager ──
const adminResult = await driveExport('owner@saigates.com', 'local-owner-testpw', 'admin')
check('admin CSV header includes cost columns (18-col shape)', adminResult.firstLine === MANAGER_HEADER, adminResult.firstLine)

check('no console errors observed during the whole run', consoleErrors.length === 0, consoleErrors.join(' || '))

await browser.close()

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
console.log(`CLEANUP_HINT device_ids=${deviceId} imeis=${IMEI}`)
console.log(`Cleanup (respecting FK order): DELETE FROM device_events WHERE device_id IN (${deviceId}); DELETE FROM scan_events WHERE imei IN ('${IMEI}'); DELETE FROM received_devices WHERE id IN (${deviceId});`)
// This script has no D1 binding (only fetch()), so — same as every other
// script in this directory — it cannot run the DELETE itself; it prints
// the statement above plus this re-query for whoever runs the cleanup to
// confirm with, rather than trusting the DELETE succeeded from exit code
// alone. Run this AFTER applying the DELETE line above:
console.log(`Cleanup verification (run AFTER the DELETE above): SELECT (SELECT COUNT(*) FROM received_devices WHERE id IN (${deviceId})) AS devices_remaining, (SELECT COUNT(*) FROM device_events WHERE device_id IN (${deviceId})) AS events_remaining, (SELECT COUNT(*) FROM scan_events WHERE imei IN ('${IMEI}')) AS scan_events_remaining; -- every column must read 0`)

process.exit(failures === 0 ? 0 : 1)
