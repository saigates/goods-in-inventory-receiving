// Browser-UI smoke check for the new Bills tab (Sprint B §1 UI): list,
// create (per-IMEI pricing, GBP + non-GBP), reconciliation display,
// close (balanced) and close-rejection + force-close (unbalanced).
//
// Same seed-and-clean / local-only-test-password pattern as
// devices-tab.browser.mjs — see test/browser/README.md for the standing
// steps (provision owner@saigates.com's local password before running,
// reset it to NULL after, clean up seeded rows).
//
// IMEI prefix: 8604560 (next free after devices-tab-2's 8604559).
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
  const body = ('8604560' + String(Date.now() % 1000000).padStart(6, '0').slice(0, 5) + String(n).padStart(2, '0')).slice(0, 14)
  return body + luhnDigit(body)
}
const IMEI_1 = mkImei(1)   // balanced GBP bill, line 1
const IMEI_2 = mkImei(2)   // balanced GBP bill, line 2
const IMEI_3 = mkImei(3)   // unbalanced USD bill

const tok = (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'owner@saigates.com', password: 'local-owner-testpw' }),
})).json()).token
if (!tok) { console.log('BOOTSTRAP FAIL: no token — password_hash not applied?'); process.exit(2) }

const invBalanced = 'BILLS-UI-BAL-' + Date.now()
const invUnbalanced = 'BILLS-UI-UNB-' + Date.now()

const browser = await chromium.launch()
const page = await browser.newPage()
const consoleErrors = []
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message))
// Per-step console-error scoping: checkpoint the array between phases so a
// genuine app/JS error anywhere is caught close to its cause, rather than
// one end-of-run assertion where a real bug could hide alongside an
// expected error. `checkClean(label)` asserts zero NEW entries since the
// last checkpoint; the one step that deliberately drives a 409 (the
// close-rejection proof) instead asserts EXACTLY that one expected browser
// network-log line and nothing else — never a global "ignore all 409s"
// filter, which would also swallow an unrelated real 409 bug.
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

// 1. Bills tab exists and navigates
check('Bills tab exists in Topbar', await page.isVisible('.tab-btn:has-text("Bills")'))
await page.click('.tab-btn:has-text("Bills")')
await page.waitForSelector('h1:has-text("Bills")', { timeout: 8000 })
check('Bills view renders (h1 "Bills")', await page.isVisible('h1:has-text("Bills")'))
checkClean('no console errors navigating to Bills tab')

// 2. New bill modal — BALANCED GBP purchase bill, 2 per-IMEI lines summing exactly to declared_total
await page.click('#bill-new-btn')
await page.waitForSelector('#bill-new-vendor', { timeout: 5000 })
check('New bill modal opens', await page.isVisible('#bill-new-vendor'))
await page.fill('#bill-new-vendor', 'BILLS-UI-TEST-VENDOR')
await page.fill('#bill-new-invoice', invBalanced)
await page.fill('#bill-new-declared', '300.00')
await page.fill('#bill-new-unitcount', '2')
await page.fill('#bill-new-rows', `SKU-A,Test device A,${IMEI_1},150.00\nSKU-A,Test device A,${IMEI_2},150.00`)
await page.click('#bill-new-create-btn')
await page.waitForSelector('#bill-reconciliation', { timeout: 8000 })
check('Balanced bill created, detail view opens (#bill-reconciliation visible)', await page.isVisible('#bill-reconciliation'))
checkClean('no console errors creating the balanced bill')

// 3. Reconciliation panel: declared_total_gbp vs sum(lines) — must show BALANCED for this bill
const declaredGbpText = await page.textContent('#bill-declared-total-gbp')
const sumLinesText = await page.textContent('#bill-sum-lines-gbp')
check('Declared total (GBP) shows £300.00', declaredGbpText.includes('300.00'), declaredGbpText)
check('Sum of lines (GBP) shows £300.00', sumLinesText.includes('300.00'), sumLinesText)
const varianceText = await page.textContent('#bill-variance-indicator')
check('Variance indicator shows Balanced', varianceText.includes('Balanced'), varianceText)
check('Close button visible for balanced draft bill', await page.isVisible('#bill-close-btn'))
check('Force-close button NOT shown for balanced bill', !(await page.isVisible('#bill-force-close-btn')))
checkClean('no console errors on the reconciliation panel (balanced)')

// 4. Close the balanced bill — demonstrates the close-rule accepting a genuinely balanced bill
await page.click('#bill-close-btn')
await page.waitForTimeout(1000)
let toastTexts = await page.locator('.toast').allInnerTexts()
check('Close toast confirms "Bill closed"', toastTexts.some(t => t.toLowerCase().includes('bill closed')), toastTexts.join(' | '))
check('Status badge now shows closed', (await page.textContent('body')).includes('closed'))
check('Write cost ledger button now visible (closed bill)', await page.isVisible('#bill-write-ledger-btn'))
checkClean('no console errors closing the balanced bill')

// 5. Write cost ledger on the closed bill
await page.click('#bill-write-ledger-btn')
await page.waitForTimeout(1000)
toastTexts = await page.locator('.toast').allInnerTexts()
check('Write-cost-ledger toast confirms posted row(s)', toastTexts.some(t => /\d+ cost_ledger row/i.test(t)), toastTexts.join(' | '))
checkClean('no console errors writing the cost ledger')

// 6. Back to list, verify the new bill appears
await page.click('#bill-back-btn')
await page.waitForTimeout(300)
check('Back navigation returns to bills list', await page.isVisible('#bill-new-btn'))
check('Bills list shows the new invoice number', (await page.textContent('body')).includes(invBalanced))
checkClean('no console errors returning to the bills list')

// 7. New bill modal — DELIBERATELY UNBALANCED USD bill (declared_total won't match line sum)
await page.click('#bill-new-btn')
await page.waitForSelector('#bill-new-vendor', { timeout: 5000 })
await page.fill('#bill-new-vendor', 'BILLS-UI-TEST-VENDOR-2')
await page.fill('#bill-new-invoice', invUnbalanced)
await page.selectOption('#bill-new-currency', 'USD')
await page.waitForSelector('#bill-new-exrate', { timeout: 3000 })
check('Exchange rate field appears for non-GBP currency', await page.isVisible('#bill-new-exrate'))
await page.fill('#bill-new-exrate', '1.25')
await page.fill('#bill-new-ratedate', '2026-08-01')
await page.fill('#bill-new-declared', '250.00')   // 250 USD / 1.25 = £200 declared_total_gbp
await page.fill('#bill-new-unitcount', '1')
await page.fill('#bill-new-rows', `SKU-B,Test device B,${IMEI_3},999.00`)  // 999/1.25 = £799.20 line sum — deliberately mismatched
await page.click('#bill-new-create-btn')
await page.waitForSelector('#bill-reconciliation', { timeout: 8000 })

// 8. Reconciliation shows the mismatch (non-vacuity proof #1: a real, non-zero variance is displayed)
const varianceText2 = await page.textContent('#bill-variance-indicator')
check('Unbalanced bill shows a Variance badge (not Balanced)', varianceText2.includes('Variance:') && !varianceText2.includes('Balanced'), varianceText2)
check('Force-close button visible for unbalanced draft bill', await page.isVisible('#bill-force-close-btn'))
checkClean('no console errors creating the unbalanced bill / viewing its reconciliation')

// 9. Attempt normal Close on the unbalanced bill — MUST be rejected (non-vacuity proof #2:
//    demonstrates the close-rule check is not circular/always-true through the real UI+API).
// This step DELIBERATELY drives a 409 from POST /api/bills/:id/close, which
// Chromium logs as a "Failed to load resource: 409" console error — that is
// the expected, intended shape of this one request. Rather than a blanket
// filter for all 409s (which would also hide an unrelated real bug), assert
// the fresh console-error set contains EXACTLY that one expected line and
// nothing else.
await page.click('#bill-close-btn')
await page.waitForTimeout(1000)
toastTexts = await page.locator('.toast').allInnerTexts()
check('Close is REJECTED for unbalanced bill (variance toast shown)', toastTexts.some(t => t.toLowerCase().includes('cannot close') && t.toLowerCase().includes('variance')), toastTexts.join(' | '))
check('Bill status still draft after rejected close', (await page.textContent('body')).includes('draft'))
{
  const fresh = consoleErrors.slice(errCheckpoint)
  const expected = fresh.filter(e => e.includes('409'))
  const unexpected = fresh.filter(e => !e.includes('409'))
  check('exactly one expected 409 console line from the deliberate close-rejection, no other console errors',
    fresh.length === 1 && expected.length === 1 && unexpected.length === 0, fresh.join(' || '))
  errCheckpoint = consoleErrors.length
}

// 10. Force-close with a reason — captures variance + reason + user
await page.click('#bill-force-close-btn')
await page.waitForSelector('#bill-force-close-reason', { timeout: 5000 })
check('Force-close modal opens', await page.isVisible('#bill-force-close-reason'))
await page.fill('#bill-force-close-reason', 'Browser-verification test: deliberate mismatch, override accepted for UI proof.')
await page.click('#bill-force-close-submit')
await page.waitForTimeout(1000)
toastTexts = await page.locator('.toast').allInnerTexts()
check('Force-close toast confirms variance recorded', toastTexts.some(t => t.toLowerCase().includes('force-closed') && t.toLowerCase().includes('variance')), toastTexts.join(' | '))
check('Bill now shows closed status', (await page.textContent('body')).includes('closed'))
checkClean('no console errors force-closing the unbalanced bill')

// 11. Force-close history panel shows variance, reason, AND user
check('Force-close history panel (#bill-close-overrides) visible', await page.isVisible('#bill-close-overrides'))
const overridesText = await page.textContent('#bill-close-overrides')
check('Override entry shows a variance badge', overridesText.includes('variance'))
check('Override entry shows the submitted reason', overridesText.includes('Browser-verification test'))
check('Override entry shows the acting user (Owner)', overridesText.includes('Owner'))
checkClean('no console errors on the force-close history panel')

await browser.close()

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
console.log(`CLEANUP_HINT imeis=${IMEI_1},${IMEI_2},${IMEI_3} invoices=${invBalanced},${invUnbalanced}`)
console.log(`Cleanup (respecting FK order): DELETE FROM cost_ledger WHERE source_bill_line_id IN (SELECT bl.id FROM bill_lines bl JOIN bills b ON b.id=bl.bill_id WHERE b.invoice_number IN ('${invBalanced}','${invUnbalanced}')); DELETE FROM bill_close_overrides WHERE bill_id IN (SELECT id FROM bills WHERE invoice_number IN ('${invBalanced}','${invUnbalanced}')); DELETE FROM bill_line_serials WHERE bill_line_id IN (SELECT bl.id FROM bill_lines bl JOIN bills b ON b.id=bl.bill_id WHERE b.invoice_number IN ('${invBalanced}','${invUnbalanced}')); DELETE FROM bill_lines WHERE bill_id IN (SELECT id FROM bills WHERE invoice_number IN ('${invBalanced}','${invUnbalanced}')); DELETE FROM bills WHERE invoice_number IN ('${invBalanced}','${invUnbalanced}'); DELETE FROM received_devices WHERE imei IN ('${IMEI_1}','${IMEI_2}','${IMEI_3}');`)
process.exit(failures === 0 ? 0 : 1)
