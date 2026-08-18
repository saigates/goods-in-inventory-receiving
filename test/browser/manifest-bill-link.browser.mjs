// Browser-UI smoke check for the manifest ↔ bill link (0029): nav reorder
// (order, not just presence — the regression this test exists to prevent),
// the bill-picker <select> on the manifest upload modal, bill_id round-trip,
// the linked-bill indicator on the Manifests list, and the reconciliation
// badge on the Receive tab.
//
// Same seed-and-clean / local-only-test-password pattern as
// bills-tab.browser.mjs — see test/browser/README.md.
//
// IMEI prefix: 8604561 (next free after bills-tab's 8604560).
import './_harness.mjs'  // enforced build + bundle-freshness check — see _harness.mjs
import { chromium } from 'playwright'
import { writeFileSync, unlinkSync } from 'node:fs'

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
  const body = ('8604561' + String(Date.now() % 1000000).padStart(6, '0').slice(0, 5) + String(n).padStart(2, '0')).slice(0, 14)
  return body + luhnDigit(body)
}
const IMEI_1 = mkImei(1)

const tokResp = await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'owner@saigates.com', password: 'local-owner-testpw' }),
})).json()
const tok = tokResp.token
if (!tok) { console.log('BOOTSTRAP FAIL: no token — password_hash not applied?'); process.exit(2) }

const invBill = 'MFBILL-UI-' + Date.now()
const manifestRef = 'MFBILL-UI-REF-' + Date.now()

// Create an OPEN header-only bill via the API (same helper pattern as
// test/manifestBillLink.spec.ts's makeOpenBill) — the picker must list it.
const billResp = await (await fetch(`${BASE}/api/bills`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
  body: JSON.stringify({
    bill_type: 'purchase', vendor_name: 'MFBILL-UI-TEST-VENDOR', bill_date: '2026-08-01',
    invoice_number: invBill, currency_code: 'GBP', price_source: 'header',
    declared_total: 500.00, unit_count: 1,
  }),
})).json()
const billId = billResp.bill_id
if (!billId) { console.log('BOOTSTRAP FAIL: could not create test bill', JSON.stringify(billResp)); process.exit(2) }

// A minimal CSV the file-upload dropzone can parse: header row + one device row.
const csvPath = `/tmp/mfbill-ui-${Date.now()}.csv`
writeFileSync(csvPath, `imei,model_no,capacity,color,grade,condition,unit_cost\n${IMEI_1},iPhone 15,128GB,Black,A,Refurbished,500.00\n`)

const browser = await chromium.launch()
const page = await browser.newPage()
const consoleErrors = []
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message))
let errCheckpoint = 0
function checkClean(label) {
  const fresh = consoleErrors.slice(errCheckpoint)
  check(label, fresh.length === 0, fresh.join(' || '))
  errCheckpoint = consoleErrors.length
}

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#login-email', { timeout: 15000 })
await page.fill('#login-email', 'owner@saigates.com')
await page.fill('#login-password', 'local-owner-testpw')
await page.click('#login-submit')
await page.waitForSelector('.tab-btn', { timeout: 15000 })
check('login succeeds and app shell loads', await page.isVisible('.tab-btn'))
checkClean('no console errors during login')

// 1. Nav ORDER assertion — not just presence. Reads the actual rendered tab
// label sequence and compares it against the exact instructed order, so a
// future reorder-regression (or a stale dist/ build, the actual root cause
// found this pass) fails loudly here instead of only being visually noticed.
const tabLabels = await page.locator('.tab-btn').allInnerTexts()
const expectedOrder = ['Dashboard', 'Bills', 'Manifests', 'Receive', 'Inventory', 'Catalog', 'Print Queue', 'Devices', 'OPR', 'Settings']
const normalizedLabels = tabLabels.map(t => t.trim())
check('tab order matches Dashboard/Bills/Manifests/Receive/Inventory/Catalog/Print Queue/Devices/OPR/Settings exactly',
  JSON.stringify(normalizedLabels) === JSON.stringify(expectedOrder), normalizedLabels.join(' > '))
checkClean('no console errors checking tab order')

// 2. Open the manifest upload modal — bill picker must be present and list our bill
await page.click('.tab-btn:has-text("Manifests")')
await page.waitForSelector('h1:has-text("Shipping Manifests")', { timeout: 8000 })
await page.click('button:has-text("Upload Manifest")')
await page.waitForSelector('#mf-bill', { timeout: 8000 })
check('bill picker <select> present in upload modal', await page.isVisible('#mf-bill'))
// openBills is fetched async after the modal's first render — wait for the option to land.
await page.waitForFunction(
  (inv) => Array.from(document.querySelectorAll('#mf-bill option')).some(o => o.textContent.includes(inv)),
  invBill, { timeout: 8000 }
)
const pickerOptionsText = await page.locator('#mf-bill').innerText()
check('bill picker lists the newly created open bill', pickerOptionsText.includes(invBill), pickerOptionsText)
checkClean('no console errors opening upload modal / loading open bills')

// 3. Fill the form, select the bill, upload the CSV, submit
await page.fill('#mf-ref', manifestRef)
await page.fill('#mf-sup', 'MFBILL-UI-TEST-VENDOR')
await page.selectOption('#mf-bill', { label: pickerOptionsText.split('\n').find(l => l.includes(invBill)) })
await page.setInputFiles('#mf-file', csvPath)
await page.waitForFunction(() => document.body.textContent.includes('Parsed'), { timeout: 8000 })
await page.click('button:has-text("Create Manifest")')
await page.waitForTimeout(1200)
checkClean('no console errors submitting the manifest with a linked bill')

// 4. Linked-bill indicator on the Manifests list
await page.waitForSelector('h1:has-text("Shipping Manifests")', { timeout: 8000 })
const bodyTextAfterCreate = await page.textContent('body')
check('new manifest appears in the list', bodyTextAfterCreate.includes(manifestRef))
const manifestRow = page.locator('tr', { hasText: manifestRef })
check('linked-bill indicator badge visible on the manifest row', await manifestRow.locator('text=bill').first().isVisible().catch(() => false))
checkClean('no console errors viewing the manifests list')

// 5. Receive tab shows the reconciliation badge (awaiting_manifest is fine here —
// price_source='header' bill has declared_total_gbp but the manifest line's
// unit_cost of 500.00 vs 1 unit should tie; assert some reconciliation state renders,
// not a specific verdict, since the exact £ math is already proven at the HTTP/unit level).
await manifestRow.locator('button:has-text("Receive")').click()
await page.waitForTimeout(800)
const receiveBodyText = await page.textContent('body')
check('reconciliation badge renders on Receive tab (Balanced/Variance/Awaiting manifest)',
  /Balanced|Variance|Awaiting manifest/i.test(receiveBodyText))
checkClean('no console errors on the Receive tab reconciliation badge')

await browser.close()
try { unlinkSync(csvPath) } catch {}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
console.log(`CLEANUP_HINT imeis=${IMEI_1} invoices=${invBill} manifest_ref=${manifestRef}`)
// bill_lines.bill_id -> bills(id) is ON DELETE NO ACTION (confirmed via
// PRAGMA foreign_key_list(bill_lines) during a live harness run 2026-08-18)
// — it MUST be deleted before bills or the DELETE FROM bills fails with
// SQLITE_CONSTRAINT_FOREIGNKEY. expected_devices does not need its own
// DELETE: manifests.expected_devices FK is ON DELETE CASCADE, so deleting
// the manifest row cascades it automatically.
console.log(`Cleanup (respecting FK order): DELETE FROM received_devices WHERE imei IN ('${IMEI_1}'); DELETE FROM bill_lines WHERE bill_id IN (SELECT id FROM bills WHERE invoice_number = '${invBill}'); DELETE FROM manifests WHERE reference = '${manifestRef}'; DELETE FROM bills WHERE invoice_number = '${invBill}';`)
process.exit(failures === 0 ? 0 : 1)
