// Browser-UI proof (Playwright + real Chromium) that:
//  1. The login click-through works interactively end to end (bad email →
//     visible error; blank email → seeded admin session → app shell).
//  2. The force-add path for off-manifest devices cannot create a device
//     without valid buy_price / vat_type / valid-ISO currency — enforced
//     through the actual UI, not curl:
//       a. Missing buy_price  → UI optimistic check blocks, warn toast,
//          modal stays open, NO network request, no device row.
//       b. Missing vat_type   → same.
//       c. Invalid ISO currency ("UKL") — the client does NOT pre-check
//          currency, so this request genuinely reaches the server and the
//          422 error message rendered in the toast is the SERVER's ISO 4217
//          rejection. No device row is created. This is the true
//          server-through-UI proof.
//       d. Valid values → force-add succeeds, device row exists with the
//          exact valuation persisted (verified via authenticated API).
import './_harness.mjs'  // enforced build + bundle-freshness check — see _harness.mjs
import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'
const results = []
let failures = 0

function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail })
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// Luhn-valid 15-digit IMEI, unique per run so re-runs don't collide with
// the UNIQUE(imei) constraint.
function luhnDigit(b) {
  let s = 0
  for (let i = 0; i < 14; i++) {
    let d = Number(b[i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    s += d
  }
  return String((10 - (s % 10)) % 10)
}
function freshImei() {
  const body = ('86' + String(Date.now()).slice(-12)).slice(0, 14)
  return body + luhnDigit(body)
}

async function toastTexts(page) {
  return page.$$eval('.toast', els => els.map(e => e.innerText.trim()))
}
async function waitForToastContaining(page, needle, timeout = 4000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const t = (await toastTexts(page)).find(x => x.toLowerCase().includes(needle.toLowerCase()))
    if (t) return t
    await page.waitForTimeout(100)
  }
  return null
}

const browser = await chromium.launch()
const page = await browser.newPage()
// Collect every request the SPA fires at /api/scan/force-add so we can
// assert the optimistic checks send NOTHING and the currency case sends
// exactly one request that the server 422s.
const forceAddRequests = []
page.on('response', async (res) => {
  if (res.url().includes('/api/scan/force-add')) {
    forceAddRequests.push({ status: res.status(), body: await res.json().catch(() => null) })
  }
})

await page.goto(BASE, { waitUntil: 'networkidle' })

// ───────── 1. Login click-through ─────────
check('login screen shown on cold load', await page.isVisible('text=Sign in to continue'))

// Bad email → interactive error surfaces
await page.fill('input[type="email"]', 'nobody@nowhere.invalid')
await page.click('button:has-text("Sign in")')
await page.waitForTimeout(800)
const errBanner = await page.textContent('body')
check('unknown email shows a visible auth error', /no user|not found|invalid/i.test(errBanner || ''),
  'login must fail loudly, not silently')

// Blank email → seeded admin
await page.fill('input[type="email"]', '')
await page.click('button:has-text("Sign in")')
await page.waitForSelector('header >> text=GOODS IN', { timeout: 8000 })
await page.waitForSelector('.tab-btn:has-text("Receive")', { timeout: 8000 })
check('blank-email sign-in reaches the app shell (topbar + tabs)', true)

// Token actually stored + /auth/me honoured (session survives reload)
await page.reload({ waitUntil: 'networkidle' })
const stillIn = await page.isVisible('.tab-btn:has-text("Receive")')
check('session persists across reload (token validated via /auth/me)', stillIn)
await page.screenshot({ path: '/home/user/ui-tests/shots/01-logged-in.png' })

// ───────── 2. Receive view + off-manifest scan ─────────
await page.click('.tab-btn:has-text("Receive")')
await page.waitForSelector('#scan-input', { timeout: 8000 })
const IMEI = freshImei()
await page.fill('#scan-input', IMEI)
await page.press('#scan-input', 'Enter')
await page.waitForSelector('text=IMEI not on manifest', { timeout: 8000 })
check('off-manifest scan opens the Unreconciled modal', true, `IMEI ${IMEI}`)
check('valuation section is present in the force-add modal', await page.isVisible('#unrec-valuation'))
await page.screenshot({ path: '/home/user/ui-tests/shots/02-unrec-modal.png' })

// ── 2a. Missing buy_price: click force-add with valuation untouched
await page.click('#unrec-force-add-btn')
const t1 = await waitForToastContaining(page, 'Buy price is required')
check('force-add without buy_price is blocked with a visible warning', !!t1, t1 || 'no toast')
check('modal stays open after blocked attempt (missing buy_price)', await page.isVisible('#unrec-force-add-btn'))
check('no network request was sent for the missing-buy_price attempt', forceAddRequests.length === 0)

// ── 2b. Missing vat_type: fill price only
await page.fill('#unrec-buy-price', '150.00')
await page.click('#unrec-force-add-btn')
const t2 = await waitForToastContaining(page, 'VAT type is required')
check('force-add without vat_type is blocked with a visible warning', !!t2, t2 || 'no toast')
check('no network request was sent for the missing-vat_type attempt', forceAddRequests.length === 0)

// ── 2c. Invalid ISO currency — client does NOT pre-check this, so the
// request reaches the server; the toast must carry the SERVER's 422 message.
await page.fill('#unrec-currency', 'UKL')
await page.selectOption('#unrec-vat-type', 'MARGIN')
await page.click('#unrec-force-add-btn')
const t3 = await waitForToastContaining(page, 'ISO 4217')
check('invalid currency "UKL" typed in the UI is rejected by the SERVER (422 message in toast)', !!t3, t3 || 'no toast')
check('exactly one request reached the server and it was 422',
  forceAddRequests.length === 1 && forceAddRequests[0].status === 422,
  JSON.stringify(forceAddRequests))
check('modal stays open after server rejection', await page.isVisible('#unrec-force-add-btn'))
await page.screenshot({ path: '/home/user/ui-tests/shots/03-server-422-ukl.png' })

// Confirm via the authenticated API (same browser session/token) that NO
// device was created by any of the three blocked attempts.
async function inventoryLookup(imei) {
  return page.evaluate(async (q) => {
    const token = localStorage.getItem('goodsin.auth_token.v1')
    const r = await fetch(`/api/inventory?q=${q}`, { headers: { Authorization: `Bearer ${token}` } })
    const j = await r.json()
    return (j.devices || []).find(d => d.imei === q) || null
  }, imei)
}
const blockedDev = await inventoryLookup(IMEI)
check('no received_devices row exists after all blocked attempts', blockedDev === null,
  blockedDev ? JSON.stringify(blockedDev).slice(0, 120) : 'clean')

// ── 2d. Fully valid values → success
await page.fill('#unrec-currency', 'GBP')
await page.click('#unrec-force-add-btn')
const t4 = await waitForToastContaining(page, 'Force-added')
check('force-add with valid buy_price/currency/vat_type succeeds', !!t4, t4 || 'no toast')
check('exactly one more request reached the server and it was 200',
  forceAddRequests.length === 2 && forceAddRequests[1].status === 200,
  JSON.stringify(forceAddRequests.map(r => r.status)))
await page.waitForTimeout(500)
check('modal closed after successful force-add', !(await page.isVisible('#unrec-force-add-btn')))
await page.screenshot({ path: '/home/user/ui-tests/shots/04-force-added.png' })

// Verify persisted valuation through the authenticated API (same session).
const dev = await inventoryLookup(IMEI)
check('created device row carries the exact valuation entered in the UI',
  !!dev && Number(dev.buy_price) === 150 && dev.currency === 'GBP' && dev.vat_type === 'MARGIN',
  dev ? `buy_price=${dev.buy_price} currency=${dev.currency} vat_type=${dev.vat_type} source=${dev.source}` : 'device not found via inventory API')
check('device landed in the unreconciled bucket', !!dev && dev.source === 'unreconciled')

// ── 2e. Inventory view shows it (end-to-end visibility)
await page.click('.tab-btn:has-text("Inventory")')
await page.waitForTimeout(400)
const searchBox = await page.$('input[placeholder*="Search"], input[placeholder*="search"], #inv-search')
if (searchBox) { await searchBox.fill(IMEI); await page.waitForTimeout(600) }
const invVisible = (await page.textContent('body'))?.includes(IMEI)
check('force-added device visible in Inventory view', !!invVisible)
await page.screenshot({ path: '/home/user/ui-tests/shots/05-inventory.png' })

// ───────── 3. Logout → login screen again ─────────
const logoutBtn = await page.$('button[title*="ogout"], .fa-right-from-bracket, button:has-text("Logout")')
if (logoutBtn) {
  await logoutBtn.click()
  await page.waitForTimeout(500)
  check('logout returns to the login screen', await page.isVisible('text=Sign in to continue'))
} else {
  check('logout returns to the login screen', false, 'logout control not found in topbar')
}

await browser.close()
console.log(`\n${results.length - failures}/${results.length} UI checks passed`)
process.exit(failures ? 1 : 0)
