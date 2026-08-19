// Browser-UI proof for the two items left explicitly owed by commit
// 7b3d590 ("Batch items 3-6: Supplier placeholder/bill-vendor precedence,
// #mf-bill sentinel fix, pluralisation"). That commit's own message says,
// verbatim: "no dedicated browser assertion for items 4-6 individually
// has been written yet. That is still owed as a follow-up, not claimed as
// proven here." This script is that follow-up, per the standing rule that
// any claim about a rendered verdict/state must be cited from a browser
// check, never an API or pure-function test.
//
// Two things proven here, both on the manifest upload modal:
//
// 1. SENTINEL-SURVIVES-RE-RENDER (item 6): once a bill is linked via
//    #mf-bill, uploadCtx.billId must stay selected in the picker across an
//    UNRELATED re-render of the same modal (renderUploadModal() tears down
//    and rebuilds the whole modal on every re-render — file parse, column
//    remap, etc.). The bug this closes: h()'s catch-all
//    setAttribute('value', ...) is a silent no-op for <select> elements,
//    so before the fix the picker visually snapped back to "— no bill —"
//    on every re-render even though uploadCtx.billId was still correctly
//    set underneath. We trigger the re-render via a column-mapping change
//    (the same renderUploadModal() call path used elsewhere in this file),
//    NOT via re-selecting the bill itself, so this is a genuine
//    survives-an-unrelated-re-render check, not a tautology.
//
// 2. READ-ONLY-LOCK (items 4/5): once a bill is linked, #mf-sup must
//    become readonly, its value must be pre-filled from the linked bill's
//    own vendor_name (applyBillVendorPrecedence()), and the explanatory
//    caption text must be visible. Unlinking (back to "— no bill —") must
//    remove the readonly attribute again WITHOUT clearing the field's
//    current value (a manually-typed supplier from before linking is not
//    erased — it simply becomes editable again).
//
// Same seed-and-clean / local-only-test-password pattern as
// manifest-bill-link.browser.mjs — see test/browser/README.md.
//
// IMEI prefix: not needed — this script never creates a received_devices
// row (no manifest is actually submitted; the CSV is uploaded only to
// populate the column-mapping panel used as the re-render trigger for
// check #1). Registry claim skipped per the same convention noted in
// bill-detail-vacuous-check.browser.mjs for scripts that seed no devices.
import './_harness.mjs'  // enforced build + bundle-freshness check — see _harness.mjs
import { chromium } from 'playwright'
import { writeFileSync, unlinkSync } from 'node:fs'

const BASE = process.env.BASE || 'http://localhost:3000'
let failures = 0
function check(name, cond, detail = '') {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const tokResp = await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'owner@saigates.com', password: 'local-owner-testpw' }),
})).json()
const tok = tokResp.token
if (!tok) { console.log('BOOTSTRAP FAIL: no token — password_hash not applied?'); process.exit(2) }

const invBill = 'MFSENTINEL-' + Date.now()

// Open header-only bill via the API — the picker must list it. Same
// helper shape as manifest-bill-link.browser.mjs / bill-detail-vacuous-check.
const billResp = await (await fetch(`${BASE}/api/bills`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
  body: JSON.stringify({
    bill_type: 'purchase', vendor_name: 'MFSENTINEL-TEST-VENDOR', bill_date: '2026-08-01',
    invoice_number: invBill, currency_code: 'GBP', price_source: 'header',
    declared_total: 250.00, unit_count: 1,
  }),
})).json()
const billId = billResp.bill_id
if (!billId) { console.log('BOOTSTRAP FAIL: could not create test bill', JSON.stringify(billResp)); process.exit(2) }

// Minimal 2-column CSV: enough to populate the column-mapping panel (whose
// onchange is the unrelated re-render trigger for check #1) without
// mapping IMEI, so no manifest row is ever actually submittable/submitted.
const csvPath = `/tmp/mfsentinel-${Date.now()}.csv`
writeFileSync(csvPath, `model_no,capacity\niPhone 15,128GB\n`)

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

await page.click('.tab-btn:has-text("Manifests")')
await page.waitForSelector('h1:has-text("Shipping Manifests")', { timeout: 8000 })
await page.click('button:has-text("Upload Manifest")')
await page.waitForSelector('#mf-bill', { timeout: 8000 })
await page.waitForFunction(
  (inv) => Array.from(document.querySelectorAll('#mf-bill option')).some(o => o.textContent.includes(inv)),
  invBill, { timeout: 8000 }
)
checkClean('no console errors opening upload modal / loading open bills')

// ── Pre-link baseline: #mf-sup is editable, no lock caption ──
check('#mf-sup is NOT readonly before any bill is linked', await page.getAttribute('#mf-sup', 'readonly') === null)
check('no lock caption before any bill is linked', !(await page.textContent('body')).includes('Pre-filled from the linked bill'))

// ── Link the bill ──
const pickerOptionsText = await page.locator('#mf-bill').innerText()
const optionLabel = pickerOptionsText.split('\n').find(l => l.includes(invBill))
await page.selectOption('#mf-bill', { label: optionLabel })
checkClean('no console errors linking the bill')

// 2a. READ-ONLY-LOCK: #mf-sup becomes readonly, pre-filled, captioned.
check('#mf-bill picker reflects the linked bill immediately after selecting it',
  await page.locator('#mf-bill').inputValue() === String(billId))
check('#mf-sup becomes readonly once a bill is linked', await page.getAttribute('#mf-sup', 'readonly') !== null)
check('#mf-sup is pre-filled from the linked bill\'s vendor_name',
  await page.inputValue('#mf-sup') === 'MFSENTINEL-TEST-VENDOR')
check('lock caption is visible once a bill is linked',
  (await page.textContent('body')).includes('Pre-filled from the linked bill'))
checkClean('no console errors after linking the bill')

// 1. SENTINEL-SURVIVES-RE-RENDER: upload the CSV (populates the column
// mapping panel), then change a mapping <select> — an UNRELATED field,
// not #mf-bill itself — which calls reparseFromMapping() + renderUploadModal()
// and tears down/rebuilds the whole modal. #mf-bill must still show the
// linked bill selected afterwards, not snap back to "— no bill —".
await page.setInputFiles('#mf-file', csvPath)
await page.waitForFunction(() => document.querySelectorAll('.card select').length > 0, { timeout: 8000 })
checkClean('no console errors uploading the CSV (column mapping panel populated)')

// Trigger an unrelated re-render: flip the FIRST mapping <select> (Model
// No.'s own detected column, since the CSV's only 2 headers are
// model_no/capacity) to a different value, which fires renderUploadModal().
const mappingSelects = page.locator('.card select')
const mappingSelectCount = await mappingSelects.count()
check('column mapping panel rendered at least one <select> to re-map', mappingSelectCount > 0, `count=${mappingSelectCount}`)
if (mappingSelectCount > 0) {
  const firstMappingSelect = mappingSelects.first()
  const optsText = await firstMappingSelect.innerText()
  const notInFileLabel = optsText.split('\n').find(l => l.includes('not in file'))
  await firstMappingSelect.selectOption({ label: notInFileLabel })
}
checkClean('no console errors after the unrelated column-remap re-render')

check('#mf-bill STILL shows the linked bill selected after an unrelated re-render (sentinel survives)',
  await page.locator('#mf-bill').inputValue() === String(billId))
check('#mf-sup is STILL readonly after the unrelated re-render',
  await page.getAttribute('#mf-sup', 'readonly') !== null)
check('#mf-sup value is STILL the linked bill\'s vendor_name after the unrelated re-render',
  await page.inputValue('#mf-sup') === 'MFSENTINEL-TEST-VENDOR')

// 2b. Unlink: back to "— no bill —" unlocks #mf-sup WITHOUT clearing its
// current (bill-derived) value — per applyBillVendorPrecedence()'s own
// comment: "Unlinking ... does NOT clear a manually-typed supplier from
// before linking; it simply unlocks the field again."
await page.selectOption('#mf-bill', { label: '— no bill —' })
checkClean('no console errors unlinking the bill')
check('#mf-sup is editable again after unlinking', await page.getAttribute('#mf-sup', 'readonly') === null)
check('lock caption disappears after unlinking', !(await page.textContent('body')).includes('Pre-filled from the linked bill'))
check('#mf-sup value is NOT cleared by unlinking (still shows the bill-derived vendor name)',
  await page.inputValue('#mf-sup') === 'MFSENTINEL-TEST-VENDOR')

// 2c. Now that it's unlocked, the field is genuinely editable (not just
// missing the readonly attribute by coincidence of timing).
await page.fill('#mf-sup', 'Manually Typed After Unlink')
check('#mf-sup accepts manual typing once unlocked', await page.inputValue('#mf-sup') === 'Manually Typed After Unlink')
checkClean('no console errors typing into the unlocked field')

await browser.close()
try { unlinkSync(csvPath) } catch {}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
console.log(`CLEANUP_HINT invoices=${invBill}`)
// bill_lines.bill_id -> bills(id) is ON DELETE NO ACTION (see
// manifest-bill-link.browser.mjs's own note) -- bill_lines before bills.
// No manifest was ever created/submitted in this script (IMEI column was
// deliberately never mapped), so no manifests/received_devices cleanup is
// needed.
console.log(`Cleanup (respecting FK order): DELETE FROM bill_lines WHERE bill_id IN (SELECT id FROM bills WHERE invoice_number = '${invBill}'); DELETE FROM bills WHERE invoice_number = '${invBill}';`)
process.exit(failures === 0 ? 0 : 1)
