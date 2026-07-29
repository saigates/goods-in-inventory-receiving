// Browser-UI proof that the two real accounts can sign in through the ACTUAL
// login form, driven by real Chromium — closing the gap flagged after the
// deploy (logins had been proven at the API level with curl, not through the
// UI the owner actually uses).
//
// Run against production by default; pass a BASE env var to point elsewhere:
//   BASE=http://localhost:3000 node test/browser/login-prod.browser.mjs
//
// Credentials are passed in via env so no plaintext lives in the repo:
//   OWNER_PW=... OPS_PW=... node test/browser/login-prod.browser.mjs
//
// Every positive check is paired with a NEGATIVE (wrong password must be
// rejected AND must not reach the app shell), so this cannot pass against a
// broken always-true verifier.
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'https://d6aea290-bd61-4f82-aa8d-94378b9f2fec.vip.gensparksite.com'
const OWNER_PW = process.env.OWNER_PW
const OPS_PW = process.env.OPS_PW
if (!OWNER_PW || !OPS_PW) {
  console.error('Set OWNER_PW and OPS_PW env vars')
  process.exit(2)
}

const results = []
let failures = 0
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail })
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// Sign in through the real form: type into #login-email / #login-password and
// click #login-submit, exactly as a person does.
async function attemptLogin(page, email, password) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#login-email', { timeout: 20000 })
  await page.fill('#login-email', email)
  await page.fill('#login-password', password)
  const loginResp = page.waitForResponse(
    (r) => r.url().includes('/api/auth/login'),
    { timeout: 20000 },
  ).catch(() => null)
  await page.click('#login-submit')
  const resp = await loginResp
  // Give the SPA a moment to either boot the shell or render the error.
  await page.waitForTimeout(2500)
  const status = resp ? resp.status() : null
  const stillOnLogin = await page.$('#login-email') !== null
  const bodyText = await page.evaluate(() => document.body.innerText)
  return { status, stillOnLogin, bodyText }
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
try {
  const pageErrors = []
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  console.log(`\n=== Target: ${BASE} ===\n`)

  // ---------- owner: correct password ----------
  let r = await attemptLogin(page, 'owner@saigates.com', OWNER_PW)
  check('owner: login POST returned 200', r.status === 200, `status=${r.status}`)
  check('owner: left the login screen (reached app shell)', !r.stillOnLogin)
  check('owner: no "Invalid email or password" on screen', !r.bodyText.includes('Invalid email or password'))

  // ---------- owner: WRONG password (negative) ----------
  const ctx2 = await browser.newContext()
  const page2 = await ctx2.newPage()
  page2.on('pageerror', (e) => pageErrors.push(String(e)))
  r = await attemptLogin(page2, 'owner@saigates.com', OWNER_PW.slice(0, -1) + 'x')
  check('owner NEGATIVE: wrong password returned 401', r.status === 401, `status=${r.status}`)
  check('owner NEGATIVE: stayed on the login screen', r.stillOnLogin)
  check('owner NEGATIVE: server error rendered in the UI',
    r.bodyText.includes('Invalid email or password'))
  await ctx2.close()

  // ---------- ops: correct password ----------
  const ctx3 = await browser.newContext()
  const page3 = await ctx3.newPage()
  page3.on('pageerror', (e) => pageErrors.push(String(e)))
  r = await attemptLogin(page3, 'ops@saigates.com', OPS_PW)
  check('ops: login POST returned 200', r.status === 200, `status=${r.status}`)
  check('ops: left the login screen (reached app shell)', !r.stillOnLogin)
  check('ops: no "Invalid email or password" on screen', !r.bodyText.includes('Invalid email or password'))

  // ---------- ops: WRONG password (negative) ----------
  const ctx4 = await browser.newContext()
  const page4 = await ctx4.newPage()
  page4.on('pageerror', (e) => pageErrors.push(String(e)))
  r = await attemptLogin(page4, 'ops@saigates.com', OPS_PW.slice(0, -1) + 'x')
  check('ops NEGATIVE: wrong password returned 401', r.status === 401, `status=${r.status}`)
  check('ops NEGATIVE: stayed on the login screen', r.stillOnLogin)
  await ctx4.close()

  // ---------- cross-account (negative) ----------
  const ctx5 = await browser.newContext()
  const page5 = await ctx5.newPage()
  r = await attemptLogin(page5, 'ops@saigates.com', OWNER_PW)
  check('CROSS NEGATIVE: owner password on ops account rejected 401', r.status === 401, `status=${r.status}`)
  await ctx5.close()

  // ---------- session survives reload ----------
  const ctx6 = await browser.newContext()
  const page6 = await ctx6.newPage()
  await attemptLogin(page6, 'owner@saigates.com', OWNER_PW)
  await page6.reload({ waitUntil: 'domcontentloaded' })
  await page6.waitForTimeout(2500)
  const afterReload = await page6.$('#login-email') === null
  check('owner: session survives a page reload', afterReload)
  await ctx6.close()

  check('no uncaught page JS errors', pageErrors.length === 0, pageErrors.join(' | '))
  await ctx.close()
} finally {
  await browser.close()
}

console.log(`\n${results.filter(r => r.pass).length}/${results.length} checks passed`)
process.exit(failures === 0 ? 0 : 1)
