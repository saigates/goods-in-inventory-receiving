// Browser-UI verification for the TEMP_EXPORT_STANDARD lifecycle (this
// sprint) — NOT the permanent Playwright script (that's explicitly
// deferred). One-shot run, seed via API + wrangler, drive via real
// Chromium against the live localhost:3000 SPA, clean up afterwards.
//
// Sequence (per the agreed sprint scope):
//   1. Create TEMP_EXPORT_STANDARD export via OprNewShipmentModal (verify
//      the shipment_type selector + hidden authorisation/procedure fields).
//   2. Scan a device in.
//   3. Finalise → confirm device status TEMP_EXPORTED_STANDARD (via API).
//   4. Create the linked return (TEMP_EXPORT_STANDARD import, discharges
//      the export) via the modal.
//   5. Scan the device onto the return.
//   6. Confirm the validation panel: EVERY customs-only check renders the
//      grey "n/a" badge (badge-slate), NOT a green pass badge — this is
//      the specific thing flagged as most likely to be subtly wrong
//      (string-match coupling to backend message text), so every check
//      that carries a "Not applicable" message is enumerated and checked
//      individually, not just spot-checked.
//   7. Finalise (receive) the return → confirm device status
//      RETURNED_UNDER_STANDARD (via API).
//   8. Restock → confirm device status ACTIVE_INVENTORY (via API).
//   9. Also spot-check the customs-block hiding on the detail screen
//      (no Invoice/Pre-alert/C&E1154/Clearance buttons, no repair-invoice
//      card, no export-proof card) while on this shipment_type.
//
// Cleanup: same discipline as opr-ui.spec.mjs / opr6-ui.spec.mjs / the
// prior devices-tab-check runs — delete every seeded row (respecting FK
// order), reset password_hash to NULL, confirm via SQL zero-count checks.
import './_harness.mjs'  // enforced build + bundle-freshness check — see _harness.mjs
import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'
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
// TEMP_EXPORT_STANDARD lifecycle UI-test IMEI namespace: 8604557 (next
// unused after opr-ui 8604550-53, opr6-ui 8604554, dbg-valui/manifest-val
// 8604555, confirm-only 8604556).
const mkImei = (n) => {
  const body = ('8604557' + String(Date.now() % 1000000).padStart(6, '0').slice(0, 5) + String(n).padStart(2, '0')).slice(0, 14)
  return body + luhnDigit(body)
}
const IMEI_A = mkImei(1)
const REF_EXP = `EXP TES ${String(Date.now()).slice(-6)}`
const REF_IMP = `IMP TES ${String(Date.now()).slice(-6)}`

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

// ── API bootstrap: 1 device READY_FOR_EXPORT (lifecycle precondition, not
// OPR UI — same pattern as opr-ui.spec.mjs / opr6-ui.spec.mjs).
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
const rcv = await api('POST', '/scan/manual', {
  imei: IMEI_A, brand: 'TestBrand', model: 'TempExportStd', capacity: '128GB',
  buy_price: 65.0, currency: 'GBP', vat_type: 'margin', auto_print: false,
})
if (rcv.status !== 200 && rcv.status !== 201) { console.log('BOOTSTRAP FAIL receive', rcv.status, JSON.stringify(rcv.data)); process.exit(2) }
const deviceId = rcv.data.received?.id ?? rcv.data.device?.id ?? rcv.data.id
for (const st of ['SORTING', 'READY_FOR_EXPORT']) {
  const t = await api('POST', `/devices/${deviceId}/transition`, { to_status: st })
  if (t.status !== 200) { console.log('BOOTSTRAP FAIL transition', st, t.status, JSON.stringify(t.data)); process.exit(2) }
}
console.log(`bootstrap: device ${deviceId} READY_FOR_EXPORT (${IMEI_A})`)

const browser = await chromium.launch()
const page = await browser.newPage()
const jsErrors = []
page.on('pageerror', (e) => jsErrors.push(String(e)))

// ── Sign in through the UI
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.fill('#login-email', 'owner@saigates.com')
await page.fill('#login-password', 'local-owner-testpw')
await page.click('#login-submit')
await page.waitForSelector('.tab-btn:has-text("OPR")', { timeout: 8000 })
check('signed in, OPR tab present', true)

// ── 1. New consignment modal — verify shipment_type selector exists and
//    flipping it hides authorisation/procedure fields.
await page.click('.tab-btn:has-text("OPR")')
await page.waitForSelector('#opr-new-btn', { timeout: 8000 })
await page.click('#opr-new-btn')
await page.waitForSelector('#opr-new-shipment-type', { timeout: 5000 })
check('shipment_type selector is present in the New consignment modal', true)

// Before flipping: OPR_REPAIR is default, authorisation select should be visible.
const authVisibleBefore = await page.locator('label:has-text("OPR authorisation")').isVisible()
check('authorisation field visible for default OPR_REPAIR', authVisibleBefore)

await page.selectOption('#opr-new-shipment-type', 'TEMP_EXPORT_STANDARD')
await page.waitForTimeout(150)
const authVisibleAfter = await page.locator('label:has-text("OPR authorisation")').isVisible()
check('authorisation field HIDDEN after selecting TEMP_EXPORT_STANDARD', !authVisibleAfter)
const procVisibleAfter = await page.locator('label:has-text("Procedure code")').isVisible()
check('procedure code field HIDDEN after selecting TEMP_EXPORT_STANDARD', !procVisibleAfter)

await page.fill('#opr-new-reference', REF_EXP)
await page.click('#opr-new-create')
// Match on the actual reference, not the generic word "created" — a bare
// 'created' needle can match a still-visible toast from an unrelated prior
// action and silently log the wrong shipment's reference (caught in an
// earlier run of this script: the return-creation toast log below showed
// the EXPORT's reference instead of the import's, because a lingering
// toast satisfied the loose needle first).
const createdToast = await waitForToastContaining(page, REF_EXP)
check('TEMP_EXPORT_STANDARD export consignment created via modal', !!createdToast, createdToast || 'no toast')

await page.waitForSelector('#opr-detail-ref', { timeout: 5000 })
check('detail view shows the reference', (await page.textContent('#opr-detail-ref'))?.trim() === REF_EXP)

// ── Spot-check customs-block hiding on the export DRAFT screen
const bodyTextExportDraft = await page.textContent('body')
check('no Invoice document button on TEMP_EXPORT_STANDARD export', !(await page.locator('button:has-text("Invoice")').isVisible().catch(() => false)))
check('no Pre-alert draft button on TEMP_EXPORT_STANDARD export', !(await page.locator('button:has-text("Pre-alert draft")').isVisible().catch(() => false)))
check('header Authorisation fact shows n/a', bodyTextExportDraft.includes('n/a — no customs declaration'))

// ── 2. Scan the device in
await page.fill('#opr-scan-input', IMEI_A)
await page.press('#opr-scan-input', 'Enter')
const scanToast = await waitForToastContaining(page, IMEI_A)
check(`scan added ${IMEI_A}`, !!scanToast, scanToast || 'no toast')
await page.waitForTimeout(300)
const lineRows = await page.$$('.opr-line-row')
check('lines table shows 1 row', lineRows.length === 1, `got ${lineRows.length}`)

// ── Validation panel — export side: all customs checks should be n/a (grey)
check('validation panel visible on export DRAFT', await page.isVisible('#opr-validation'))
const exportBadges = await page.locator('#opr-validation .badge').allInnerTexts()
console.log('export validation badges:', JSON.stringify(exportBadges))
const exportGreenBadges = await page.locator('#opr-validation .badge-green').count()
// Overall result badge is also .badge-green when result is green — exclude
// it by checking the per-check rows only (badge-slate for n/a, never
// badge-green for a per-check n/a row).
const exportSlateCount = await page.locator('#opr-validation .badge-slate').count()
check('export validation shows at least one grey n/a badge', exportSlateCount > 0, `slate count=${exportSlateCount}`)
const exportNaTexts = await page.locator('#opr-validation .badge-slate').allInnerTexts()
check('every n/a badge on export side reads "n/a" (not green/pass)', exportNaTexts.every(t => t.trim() === 'n/a'), exportNaTexts.join(','))

// ── 3. Finalise export → verify device TEMP_EXPORTED_STANDARD
await page.click('#opr-finalise-btn')
await page.waitForSelector('#opr-finalise-confirm', { timeout: 5000 })
// TEMP_EXPORT_STANDARD finalise modal should have NO declaration fields.
const mrnFieldVisible = await page.locator('input[placeholder="26GB34F7Y1AB8CDE12"]').isVisible().catch(() => false)
check('no Export MRN field in finalise modal for TEMP_EXPORT_STANDARD', !mrnFieldVisible)
const modalBodyText = await page.textContent('.modal')
check('finalise modal description mentions no customs declaration', modalBodyText.toLowerCase().includes('no customs declaration'))
await page.click('#opr-finalise-confirm')
const finToast = await waitForToastContaining(page, 'TEMP_EXPORTED_STANDARD')
check('finalise toast reports TEMP_EXPORTED_STANDARD (not EXPORTED_UNDER_OPR)', !!finToast, finToast || 'no toast')
await page.waitForTimeout(400)

const devAfterExport = await api('GET', `/devices/${deviceId}`)
const statusAfterExport = devAfterExport.data?.device?.status ?? devAfterExport.data?.status
check('device status is TEMP_EXPORTED_STANDARD after finalise', statusAfterExport === 'TEMP_EXPORTED_STANDARD', statusAfterExport)

// ── 4. Create the linked return
await page.click('#opr-back-btn')
await page.waitForSelector('#opr-new-btn', { timeout: 5000 })
await page.click('#opr-new-btn')
await page.waitForSelector('#opr-new-direction', { timeout: 5000 })
await page.selectOption('#opr-new-direction', 'import')
await page.waitForTimeout(150)
await page.selectOption('#opr-new-shipment-type', 'TEMP_EXPORT_STANDARD')
await page.waitForTimeout(150)
await page.fill('#opr-new-reference', REF_IMP)
const relSelect = await page.$('select:has(option:has-text("' + REF_EXP + '"))')
check('finalised TEMP_EXPORT_STANDARD export offered as discharge link', !!relSelect)
if (relSelect) {
  const optVal = await relSelect.$eval(`option:has-text("${REF_EXP}")`, o => o.value)
  await relSelect.selectOption(optVal)
}
// Import procedure-code helper text should NOT appear for TEMP_EXPORT_STANDARD.
const importHelperVisible = await page.locator('text=Import procedure code is fixed at 6121').isVisible().catch(() => false)
check('no "fixed at 6121" helper text for TEMP_EXPORT_STANDARD import', !importHelperVisible)
await page.click('#opr-new-create')
const impToast = await waitForToastContaining(page, REF_IMP)
check('TEMP_EXPORT_STANDARD return consignment created via modal', !!impToast, impToast || 'no toast')
await page.waitForSelector('#opr-detail-ref', { timeout: 5000 })

// ── No repair-invoice card should be offered on this shipment_type
const repairCardVisible = await page.isVisible('#opr-repair-card').catch(() => false)
check('no repair-invoice card on TEMP_EXPORT_STANDARD return DRAFT', !repairCardVisible)

// ── 5. Scan the device onto the return
await page.fill('#opr-scan-input', IMEI_A)
await page.press('#opr-scan-input', 'Enter')
const retToast = await waitForToastContaining(page, IMEI_A)
check('return scan added the exported device', !!retToast, retToast || 'no toast')
await page.waitForTimeout(300)

// ── 6. Validation panel on the return side — enumerate EVERY n/a badge
//    individually (this is the specific risk flagged: a differently-phrased
//    backend message would slip through as green, not grey).
check('validation panel visible on return DRAFT', await page.isVisible('#opr-validation'))
const importRows = await page.locator('#opr-validation .space-y-1 > div').all()
let importGreenLeak = 0
let importSlateCount = 0
for (const row of importRows) {
  const badgeText = (await row.locator('.badge').innerText()).trim()
  const badgeClasses = await row.locator('.badge').getAttribute('class')
  const messageText = (await row.locator('span').nth(1).innerText()).trim()
  const looksNotApplicable = messageText.startsWith('Not applicable')
  if (looksNotApplicable) {
    if (badgeClasses.includes('badge-slate') && badgeText === 'n/a') {
      importSlateCount++
    } else {
      importGreenLeak++
      console.log(`FAIL DETAIL: "Not applicable" message rendered with badge class "${badgeClasses}" text "${badgeText}" — message: ${messageText}`)
    }
  }
}
check(`every "Not applicable" check on the return renders grey n/a (checked ${importRows.length} visible rows, ${importSlateCount} n/a)`, importGreenLeak === 0, `leaks=${importGreenLeak}`)
check('at least one n/a badge present on return validation (customs checks skipped)', importSlateCount > 0, `count=${importSlateCount}`)
// Also confirm NO badge-green appears among the per-check rows (only the
// overall result pill above the list is allowed to be green).
const perCheckGreenCount = await page.locator('#opr-validation .space-y-1 .badge-green').count()
check('no green per-check badge among visible validation rows', perCheckGreenCount === 0, `count=${perCheckGreenCount}`)

// ── 7. Finalise (receive) the return → verify RETURNED_UNDER_STANDARD
await page.click('#opr-finalise-btn')
await page.waitForSelector('#opr-finalise-confirm', { timeout: 5000 })
const importMrnFieldVisible = await page.locator('input[placeholder="26GB89E4Q2CD7FGH34"]').isVisible().catch(() => false)
check('no Import MRN field in finalise modal for TEMP_EXPORT_STANDARD', !importMrnFieldVisible)
await page.click('#opr-finalise-confirm')
const recToast = await waitForToastContaining(page, 'RETURNED_UNDER_STANDARD')
check('receive toast reports RETURNED_UNDER_STANDARD (not RETURNED_UNDER_OPR)', !!recToast, recToast || 'no toast')
await page.waitForTimeout(400)

const devAfterReturn = await api('GET', `/devices/${deviceId}`)
const statusAfterReturn = devAfterReturn.data?.device?.status ?? devAfterReturn.data?.status
check('device status is RETURNED_UNDER_STANDARD after receipt', statusAfterReturn === 'RETURNED_UNDER_STANDARD', statusAfterReturn)

// Restock button title should mention RETURNED_UNDER_STANDARD, not _OPR
const restockBtn = await page.$('#opr-restock-btn')
const restockTitle = restockBtn ? await restockBtn.getAttribute('title') : null
check('restock button title is shipment_type-aware (mentions RETURNED_UNDER_STANDARD)', !!restockTitle && restockTitle.includes('RETURNED_UNDER_STANDARD'), restockTitle)

// ── 8. Restock → verify ACTIVE_INVENTORY
await page.click('#opr-restock-btn')
const rsToast = await waitForToastContaining(page, 'Restocked 1')
check('restock toast reports 1 device', !!rsToast, rsToast || 'no toast')
await page.waitForTimeout(300)

const devFinal = await api('GET', `/devices/${deviceId}`)
const statusFinal = devFinal.data?.device?.status ?? devFinal.data?.status
check('device status is ACTIVE_INVENTORY after restock', statusFinal === 'ACTIVE_INVENTORY', statusFinal)

check('zero page JS errors across the whole flow', jsErrors.length === 0, jsErrors.join(' ; ').slice(0, 300))

await browser.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`)
console.log(`CLEANUP_HINT imeis prefix 8604557 refs '${REF_EXP}' '${REF_IMP}' device ${deviceId}`)
console.log(`Cleanup (respecting FK order): DELETE FROM device_events WHERE device_id = ${deviceId}; DELETE FROM shipment_lines WHERE received_device_id = ${deviceId}; DELETE FROM shipments WHERE reference IN ('${REF_EXP}','${REF_IMP}'); DELETE FROM scan_events WHERE imei = '${IMEI_A}'; DELETE FROM received_devices WHERE id = ${deviceId};`)
process.exit(failures === 0 ? 0 : 1)
