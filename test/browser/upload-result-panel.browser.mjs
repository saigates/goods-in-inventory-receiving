// Browser-UI smoke check for the upload-result panel (G5 item 1):
// condition_discrepancies / grade_coercions from POST /manifests must
// render in a PERSISTENT panel (not a toast — the toast disappears in a
// few seconds; a discrepancy found at upload must still be readable when
// someone comes back later to act on it), must survive a re-render AND a
// navigation away and back, and the zero case (no findings) must render
// an explicit "clean" state rather than an empty box that reads like a
// failure.
//
// Uses a dedicated disposable fixture account
// (g5-fixture@example.invalid) rather than owner@saigates.com /
// ops@saigates.com — those are real per-person accounts and are
// off-limits as disposable test fixtures per the standing constraint.
// Provision it first (local D1 only):
//   node scripts/set-password.mjs g5-fixture@example.invalid '<password>'
//   npx wrangler d1 execute webapp-production --local --command="INSERT INTO users (email, name, role, organisation_id, password_hash) VALUES ('g5-fixture@example.invalid', 'G5 Fixture', 'operator', 1, '<hash>');"
//
// Same seed-and-clean contract as the other scripts in this directory —
// see test/browser/README.md.
//
// IMEI prefix: 8604563 (next free after bill-detail-vacuous-check's 8604562).
import './_harness.mjs'  // enforced build + bundle-freshness check — see _harness.mjs
import { chromium } from 'playwright'
import { writeFileSync, unlinkSync } from 'node:fs'

const BASE = process.env.BASE || 'http://localhost:3000'
const FIXTURE_EMAIL = 'g5-fixture@example.invalid'
const FIXTURE_PASSWORD = process.env.G5_FIXTURE_PASSWORD || 'g5-fixture-testpw-2026'

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
  const body = ('8604563' + String(Date.now() % 1000000).padStart(6, '0').slice(0, 5) + String(n).padStart(2, '0')).slice(0, 14)
  return body + luhnDigit(body)
}
// Populated-case manifest: two rows.
//   row 0: grade "Z" (out-of-scale) + condition "Used" -> coercion
//          (Z -> UG) AND a discrepancy (Used vs derived RAW, since UG derives RAW).
//   row 1: grade "A" + condition "Used" -> discrepancy only
//          (A derives REFURBISHED, uploaded says Used) — no coercion,
//          since A is already a valid grade.
const IMEI_1 = mkImei(1)
const IMEI_2 = mkImei(2)
// Zero-case manifest: one clean row — grade "B" + condition "Used", which
// IS what B derives (USED), so no discrepancy and no coercion.
const IMEI_3 = mkImei(3)

const tokResp = await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: FIXTURE_EMAIL, password: FIXTURE_PASSWORD }),
})).json()
const tok = tokResp.token
if (!tok) { console.log('BOOTSTRAP FAIL: no token — is the fixture account provisioned? see header comment', JSON.stringify(tokResp)); process.exit(2) }

const manifestRefPopulated = 'UPLOADRES-UI-POP-' + Date.now()
const manifestRefClean = 'UPLOADRES-UI-CLEAN-' + Date.now()

// Minimal CSVs the file-upload dropzone can parse: header row + data row(s).
const csvPopulatedPath = `/tmp/uploadres-ui-pop-${Date.now()}.csv`
writeFileSync(csvPopulatedPath,
  `imei,model_no,capacity,color,grade,condition,unit_cost\n` +
  `${IMEI_1},iPhone 15,128GB,Black,Z,Used,100.00\n` +
  `${IMEI_2},iPhone 15,128GB,Black,A,Used,150.00\n`)
const csvCleanPath = `/tmp/uploadres-ui-clean-${Date.now()}.csv`
writeFileSync(csvCleanPath,
  `imei,model_no,capacity,color,grade,condition,unit_cost\n` +
  `${IMEI_3},iPhone 15,128GB,Black,B,Used,120.00\n`)

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

async function uploadManifest(reference, supplier, csvPath) {
  await page.click('.tab-btn:has-text("Manifests")')
  await page.waitForSelector('h1:has-text("Shipping Manifests")', { timeout: 8000 })
  await page.click('button:has-text("Upload Manifest")')
  await page.waitForSelector('#mf-ref', { timeout: 8000 })
  await page.fill('#mf-ref', reference)
  await page.fill('#mf-sup', supplier)
  await page.setInputFiles('#mf-file', csvPath)
  await page.waitForFunction(() => document.body.textContent.includes('Parsed'), { timeout: 8000 })
  await page.click('button:has-text("Create Manifest")')
  await page.waitForTimeout(1200)
}

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#login-email', { timeout: 15000 })
await page.fill('#login-email', FIXTURE_EMAIL)
await page.fill('#login-password', FIXTURE_PASSWORD)
await page.click('#login-submit')
await page.waitForSelector('.tab-btn', { timeout: 15000 })
check('login succeeds and app shell loads', await page.isVisible('.tab-btn'))
checkClean('no console errors during login')

// ── 1. POPULATED CASE ──────────────────────────────────────────────────
await uploadManifest(manifestRefPopulated, 'UPLOADRES-UI-VENDOR', csvPopulatedPath)
checkClean('no console errors submitting the populated-case manifest')

// Land on Manifests list after create — navigate to Receive for this manifest.
await page.waitForSelector('h1:has-text("Shipping Manifests")', { timeout: 8000 })
const popRow = page.locator('tr', { hasText: manifestRefPopulated })
await popRow.locator('button:has-text("Receive")').click()
await page.waitForTimeout(800)

const panelSelector = '#upload-result-panel'
await page.waitForSelector(panelSelector, { timeout: 8000 })
check('upload-result panel renders on Receive tab for the just-created manifest', await page.isVisible(panelSelector))
const panelText1 = await page.textContent(panelSelector)
check('panel shows 1 grade coercion', /1 grade coercion/i.test(panelText1), panelText1)
check('panel shows coercion detail: uploaded "Z" -> stored UG', panelText1.includes('uploaded "Z"') && panelText1.includes('stored UG'), panelText1)
check('panel shows 2 condition discrepancies', /2 condition discrepanc/i.test(panelText1), panelText1)
check('panel shows discrepancy detail for row 1 (A vs derived REFURBISHED)', panelText1.includes('vs derived "REFURBISHED"'), panelText1)
// Coercion block must appear ABOVE (before, in DOM order) the discrepancy
// block — the "louder, not equal weight" requirement translated into a
// concrete, checkable DOM assertion rather than an inferred claim.
const coercionsBlockVisible = await page.isVisible('#upload-result-coercions')
const discrepanciesBlockVisible = await page.isVisible('#upload-result-discrepancies')
check('distinct coercions block is visible', coercionsBlockVisible)
check('distinct discrepancies block is visible', discrepanciesBlockVisible)
const domOrder = await page.evaluate(() => {
  const panel = document.querySelector('#upload-result-panel')
  const co = panel.querySelector('#upload-result-coercions')
  const di = panel.querySelector('#upload-result-discrepancies')
  if (!co || !di) return null
  // co precedes di in document order?
  return !!(co.compareDocumentPosition(di) & Node.DOCUMENT_POSITION_FOLLOWING)
})
check('coercions block renders before (louder than) discrepancies block in DOM order', domOrder === true, String(domOrder))
checkClean('no console errors viewing the populated-case panel')

// Re-render survival: trigger a render by toggling something unrelated
// (open the bulk-scan modal, then dismiss it by clicking the backdrop —
// the modal's own documented dismiss gesture, see the `close` handler on
// '.modal-backdrop' in BulkScanModal()) and confirm the panel is still
// there with the same content, without a page reload.
await page.click('button:has-text("Bulk scan")')
await page.waitForSelector('.modal-backdrop', { timeout: 8000 })
await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } })
await page.waitForTimeout(300)
const panelTextAfterRerender = await page.textContent(panelSelector).catch(() => null)
check('panel survives an unrelated re-render (still present with same findings)',
  panelTextAfterRerender != null && /1 grade coercion/i.test(panelTextAfterRerender) && /2 condition discrepanc/i.test(panelTextAfterRerender),
  panelTextAfterRerender || '(panel missing)')
checkClean('no console errors after the re-render check')

// Navigation-away-and-back survival: go to Manifests, then back to Receive
// for the SAME manifest (still the active one) — confirm the panel still
// shows the same findings, per the "ideally survives navigation away and
// back" requirement (satisfied here without a full page reload, matching
// the single global-state-object architecture).
await page.click('.tab-btn:has-text("Manifests")')
await page.waitForSelector('h1:has-text("Shipping Manifests")', { timeout: 8000 })
await page.click('.tab-btn:has-text("Receive")')
await page.waitForTimeout(600)
const panelTextAfterNav = await page.textContent(panelSelector).catch(() => null)
check('panel survives navigating away (Manifests) and back (Receive)',
  panelTextAfterNav != null && /1 grade coercion/i.test(panelTextAfterNav) && /2 condition discrepanc/i.test(panelTextAfterNav),
  panelTextAfterNav || '(panel missing)')
checkClean('no console errors after navigate-away-and-back')

// ── 2. ZERO CASE ────────────────────────────────────────────────────────
// Upload a second, clean manifest — the panel must switch to the explicit
// "Clean upload" state for this (now active) manifest, not show the prior
// manifest's stale findings and not show an ambiguous empty box.
await uploadManifest(manifestRefClean, 'UPLOADRES-UI-VENDOR', csvCleanPath)
checkClean('no console errors submitting the zero-case manifest')
await page.waitForSelector('h1:has-text("Shipping Manifests")', { timeout: 8000 })
const cleanRow = page.locator('tr', { hasText: manifestRefClean })
await cleanRow.locator('button:has-text("Receive")').click()
await page.waitForTimeout(800)
await page.waitForSelector(panelSelector, { timeout: 8000 })
const panelText2 = await page.textContent(panelSelector)
check('zero-case panel renders an explicit "Clean upload" state', /clean upload/i.test(panelText2), panelText2)
check('zero-case panel explicitly states no discrepancies/no coercions (not an empty box)',
  /no condition discrepancies/i.test(panelText2) && /no grade coercions/i.test(panelText2), panelText2)
check('zero-case panel does NOT show the previous manifest\'s coercion/discrepancy counts',
  !/grade coercion/i.test(panelText2.replace(/no grade coercions/i, '')) &&
  !/condition discrepanc/i.test(panelText2.replace(/no condition discrepancies/i, '')),
  panelText2)
checkClean('no console errors viewing the zero-case panel')

await browser.close()
try { unlinkSync(csvPopulatedPath) } catch {}
try { unlinkSync(csvCleanPath) } catch {}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
console.log(`CLEANUP_HINT imeis=${IMEI_1},${IMEI_2},${IMEI_3} manifest_refs=${manifestRefPopulated},${manifestRefClean}`)
// expected_devices FK is manifests -> ON DELETE CASCADE, so deleting the
// manifest rows cascades expected_devices automatically. No bill was
// created/linked by this script, so no bill_lines/bills cleanup needed.
console.log(`Cleanup (respecting FK order): DELETE FROM received_devices WHERE imei IN ('${IMEI_1}', '${IMEI_2}', '${IMEI_3}'); DELETE FROM manifests WHERE reference IN ('${manifestRefPopulated}', '${manifestRefClean}');`)
console.log(`Also delete the disposable fixture user once no longer needed: DELETE FROM users WHERE email = '${FIXTURE_EMAIL}';`)
process.exit(failures === 0 ? 0 : 1)
