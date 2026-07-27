// Browser-UI proof for the Quick receive (manual) path — same pattern as
// force-add-ui.spec.mjs: missing buy_price / vat_type blocked client-side
// with ZERO network requests; invalid ISO currency ("UKL") genuinely reaches
// the SERVER and the toast carries its 422 message; valid values succeed
// with the exact valuation persisted. Test row cleaned up at the end via
// the app's own delete endpoint is NOT used — cleanup is done by the runner
// script via wrangler (documented in test/browser/README.md).
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
const body14 = ('35' + String(Date.now()).slice(-12)).slice(0, 14)
const IMEI = body14 + luhnDigit(body14)

async function waitForToastContaining(page, needle, timeout = 4000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const t = (await page.$$eval('.toast', els => els.map(e => e.innerText.trim())))
      .find(x => x.toLowerCase().includes(needle.toLowerCase()))
    if (t) return t
    await page.waitForTimeout(100)
  }
  return null
}

const browser = await chromium.launch()
const page = await browser.newPage()
const manualRequests = []
page.on('response', async (res) => {
  if (res.url().includes('/api/scan/manual')) {
    manualRequests.push({ status: res.status(), body: await res.json().catch(() => null) })
  }
})

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.click('button:has-text("Sign in")')
await page.waitForSelector('.tab-btn:has-text("Inventory")', { timeout: 8000 })

// Open Quick receive from the Inventory view
await page.click('.tab-btn:has-text("Inventory")')
await page.click('button:has-text("Quick receive")')
await page.waitForSelector('text=Quick receive (no manifest)', { timeout: 8000 })
check('Quick receive modal opens', true, `IMEI ${IMEI}`)
check('valuation section is present in the manual modal', await page.isVisible('#manual-valuation'))

// Fill IMEI + custom brand/model, leave valuation empty
await page.fill('input[placeholder="Scan or type IMEI…"]', IMEI)

// a. missing buy_price
await page.click('#manual-receive-btn')
const t1 = await waitForToastContaining(page, 'Buy price is required')
check('manual receive without buy_price is blocked with a visible warning', !!t1, t1 || 'no toast')
check('no network request sent for missing-buy_price attempt', manualRequests.length === 0)

// b. missing vat_type
await page.fill('#manual-buy-price', '77.50')
await page.click('#manual-receive-btn')
const t2 = await waitForToastContaining(page, 'VAT type is required')
check('manual receive without vat_type is blocked with a visible warning', !!t2, t2 || 'no toast')
check('no network request sent for missing-vat_type attempt', manualRequests.length === 0)

// c. invalid ISO currency — reaches the SERVER (client doesn't pre-check currency)
await page.fill('#manual-currency', 'UKL')
await page.selectOption('#manual-vat-type', 'STANDARD')
await page.click('#manual-receive-btn')
const t3 = await waitForToastContaining(page, 'ISO 4217')
check('invalid currency "UKL" typed in the UI is rejected by the SERVER (422 in toast)', !!t3, t3 || 'no toast')
check('exactly one request reached the server and it was 422',
  manualRequests.length === 1 && manualRequests[0].status === 422,
  JSON.stringify(manualRequests.map(r => r.status)))
check('modal stays open after server rejection', await page.isVisible('#manual-receive-btn'))

// No device row after blocked attempts
async function lookup(imei) {
  return page.evaluate(async (q) => {
    const token = localStorage.getItem('goodsin.auth_token.v1')
    const r = await fetch(`/api/inventory?q=${q}`, { headers: { Authorization: `Bearer ${token}` } })
    const j = await r.json()
    return (j.devices || []).find(d => d.imei === q) || null
  }, imei)
}
check('no received_devices row exists after all blocked attempts', (await lookup(IMEI)) === null)

// d. valid values → success
await page.fill('#manual-currency', 'GBP')
await page.click('#manual-receive-btn')
const t4 = await waitForToastContaining(page, 'Received')
check('manual receive with valid valuation succeeds', !!t4, t4 || 'no toast')
check('second request reached the server and was 200',
  manualRequests.length === 2 && manualRequests[1].status === 200,
  JSON.stringify(manualRequests.map(r => r.status)))
await page.waitForTimeout(500)

const dev = await lookup(IMEI)
check('created device carries the exact valuation entered in the UI',
  !!dev && Number(dev.buy_price) === 77.5 && dev.currency === 'GBP' && dev.vat_type === 'STANDARD' && dev.source === 'manual',
  dev ? `buy_price=${dev.buy_price} currency=${dev.currency} vat_type=${dev.vat_type} source=${dev.source}` : 'not found')

console.log(`\nCLEANUP_IMEI=${IMEI}`)
await browser.close()
process.exit(failures ? 1 : 0)
