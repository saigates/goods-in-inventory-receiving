// Browser-UI check for the header-mode BillDetailView() false-green fix
// (the "vacuous same-document reconciliation" defect — see process notes
// below and the NAMED PROCESS SMELL comment in public/static/app.js's
// BillDetailView()).
//
// STANDING PROCESS RULE (this pass): any claim about a rendered verdict
// must be cited from a browser check, never an API or pure-function test.
// The backend half of this fix (src/routes/bills.ts's linked-manifest
// lookup) is already covered by test/manifestBillLink.spec.ts and
// test/bills.spec.ts at the HTTP layer, but neither of those renders
// BillDetailView() — so they cannot be cited as proof of what the badge
// actually SHOWS. This script is that proof.
//
// The defect this closes: a 'header'-mode bill (src/lib/billBuilder.ts)
// produces exactly ONE synthetic bill_lines row whose unit_price_gbp is
// DERIVED FROM declared_total — so sum(lines) === declared_total BY
// CONSTRUCTION, and the old unconditional same-document check was
// arithmetically incapable of rendering anything but "Balanced". Same
// shape as the historical c5e5f25 circular gbp_total defect, reproduced
// in the display layer (3rd occurrence of this smell in this build).
//
// This test creates a header-mode bill, vendor_name 'LW001', with NO
// manifest linked to it, opens it via the Bills tab, and asserts the
// rendered reconciliation text is NOT "Balanced" — it must show the
// neutral "UNPRICED — NO LINE DETAIL; RECONCILIATION NOT APPLICABLE"
// state instead, per the corrected two-armed gate
// (bill.price_source === 'header' || lines.length === 0).
//
// Same seed-and-clean / local-only-test-password pattern as
// bills-tab.browser.mjs / manifest-bill-link.browser.mjs — see
// test/browser/README.md for the standing steps.
//
// IMEI prefix: 8604562 (next free after manifest-bill-link's 8604561).
// (This script does not actually need to create any received_devices —
// it seeds no manifest — but claims the prefix per the registry
// convention in case a future revision of this test adds device rows.)
import './_harness.mjs'  // enforced build + bundle-freshness check — see _harness.mjs
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:3000'
let failures = 0
function check(name, cond, detail = '') {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const tok = (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'owner@saigates.com', password: 'local-owner-testpw' }),
})).json()).token
if (!tok) { console.log('BOOTSTRAP FAIL: no token — password_hash not applied?'); process.exit(2) }

const invHeader = 'LW001-VACUOUS-' + Date.now()

// Header-only bill, no manifest linked — vendor_name 'LW001' per the
// user's request to use "the real LW001 bill" naming convention (this
// is a FRESH bill created for this test, not a shared fixture, so it
// cannot collide with test/bills.spec.ts's own separate 'LW001' fixture).
const billResp = await (await fetch(`${BASE}/api/bills`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
  body: JSON.stringify({
    bill_type: 'purchase', vendor_name: 'LW001', bill_date: '2026-08-01',
    invoice_number: invHeader, currency_code: 'GBP', price_source: 'header',
    declared_total: 4321.00, unit_count: 16,
  }),
})).json()
const billId = billResp.bill_id
if (!billId) { console.log('BOOTSTRAP FAIL: could not create test bill', JSON.stringify(billResp)); process.exit(2) }

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

// Navigate to Bills tab and open the header-only bill via the list —
// this exercises the real GET /api/bills/:id -> BillDetailView() path,
// not a synthetic state injection.
await page.click('.tab-btn:has-text("Bills")')
await page.waitForSelector('h1:has-text("Bills")', { timeout: 8000 })
checkClean('no console errors navigating to Bills tab')

await page.waitForFunction(
  (inv) => document.body.textContent.includes(inv),
  invHeader, { timeout: 8000 }
)
const billRow = page.locator('tr.bill-row', { hasText: invHeader })
check('the new header-only LW001 bill appears in the bills list', await billRow.count() > 0)
await billRow.locator('.bill-open-btn').click()
await page.waitForSelector('#bill-reconciliation', { timeout: 8000 })
check('bill detail view opens (#bill-reconciliation visible)', await page.isVisible('#bill-reconciliation'))
checkClean('no console errors opening the header-only bill')

// The core assertion: the rendered variance indicator must NOT contain
// "Balanced" for this header-mode, unlinked bill — the false green this
// fix exists to close.
const varianceText = await page.textContent('#bill-variance-indicator')
check('rendered reconciliation text does NOT say Balanced (vacuous same-doc check suppressed)',
  !/Balanced/i.test(varianceText), varianceText)
check('rendered reconciliation text shows the neutral not-applicable state instead',
  /UNPRICED|NOT APPLICABLE/i.test(varianceText), varianceText)
// It also must not be a red Variance badge — that would be an equally
// fabricated verdict from the wrong side (the check is meant to be
// SUPPRESSED, not inverted).
check('rendered reconciliation text does NOT say Variance either (suppressed, not inverted)',
  !/Variance:/i.test(varianceText), varianceText)
checkClean('no console errors on the reconciliation panel')

// Pricing mode is visibly 'header' on this bill's own header card — a
// human reading the page has the same information the gate uses.
const bodyText = await page.textContent('body')
check('pricing mode "header" is visible on the bill header card', bodyText.includes('header'))

// Sanity: the existing per-IMEI Balanced/Variance behaviour (proven by
// bills-tab.browser.mjs) must be unaffected by this change — that script
// is unmodified and still exercises price_source='per_imei' bills, whose
// two-armed gate evaluates false (they have real, non-zero line rows).
// Not re-asserted here to avoid duplicating that script; noted for the
// record since this is the same gate function both scripts exercise.

await browser.close()

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
console.log(`CLEANUP_HINT invoices=${invHeader}`)
// bill_lines.bill_id -> bills(id) is ON DELETE NO ACTION (confirmed via
// PRAGMA foreign_key_list(bill_lines) — see manifest-bill-link.browser.mjs's
// own note) — bill_lines must be deleted before bills.
console.log(`Cleanup (respecting FK order): DELETE FROM bill_lines WHERE bill_id IN (SELECT id FROM bills WHERE invoice_number = '${invHeader}'); DELETE FROM bills WHERE invoice_number = '${invHeader}';`)
process.exit(failures === 0 ? 0 : 1)
