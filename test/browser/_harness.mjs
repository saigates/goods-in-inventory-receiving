// Shared entrypoint guard for every *.browser.mjs script (2026-08-18 process
// fix, requested after the stale dist/static/app.js incident that made the
// Bills tab visually render 8th despite public/static/app.js already having
// the correct order).
//
// Root cause this closes: `wrangler pages dev dist` serves whatever is
// physically sitting in dist/static/app.js, and nothing rebuilds dist/
// automatically when public/static/app.js changes. A browser-test run could
// therefore silently exercise a stale bundle and still report a green PASS
// — which is exactly what happened. Every browser-test PASS from before this
// fix (Devices tab 18/18 then 25/25, Bills UI 27/28) is consequently not
// provably against the code it claimed to test, only "not necessarily
// wrong". This file exists so that can never happen again, undetected.
//
// Two guarantees, both enforced — not documented — by running as soon as any
// *.browser.mjs imports this module as its FIRST import (top-level code in
// an ES module runs synchronously on import, before the rest of the calling
// file's body executes):
//
//   1. `npm run build` actually runs, every time, before any check in the
//      calling script can execute. A build failure aborts immediately
//      (non-zero exit) — it does not fall through to testing whatever old
//      dist/ happened to exist already.
//
//   2. The bundle the LIVE SERVER is actually serving is content-hashed
//      (SHA-256) and compared against the CURRENT public/static/app.js on
//      disk, post-build. This is deliberately NOT a hardcoded marker
//      string: a fixed marker can itself go stale and keep passing against
//      a bundle that is missing a later, unrelated change, which would
//      re-create exactly the false-confidence failure mode this fix exists
//      to close. A full-content hash against current source is
//      self-maintaining and strictly stronger — it fails the instant served
//      and source diverge by even one byte, for any reason (stale dist/,
//      a caching layer, wrong port, wrong branch checked out, etc.).
//
// If either guarantee fails, the script exits with code 2 and prints why.
// Every *.browser.mjs must have `import './_harness.mjs'` as its very first
// line, before any other import.
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const BASE = process.env.BASE || 'http://localhost:3000'

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

// ── 1. Enforced build ──────────────────────────────────────────────────
console.log('[harness] npm run build (enforced — see test/browser/_harness.mjs)...')
try {
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' })
} catch (err) {
  console.error('[harness] BUILD FAILED — aborting before any check runs.')
  console.error('[harness] A stale or broken dist/ must never be tested against.')
  process.exit(2)
}

// ── 2. Bundle-freshness assertion (content hash, not a fixed marker) ──
const sourcePath = join(REPO_ROOT, 'public', 'static', 'app.js')
const sourceHash = sha256(readFileSync(sourcePath))

const bustUrl = `${BASE}/static/app.js?_bundlecheck=${Date.now()}`
let servedText
try {
  const res = await fetch(bustUrl)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  servedText = await res.text()
} catch (err) {
  console.error(`[harness] BUNDLE-FRESHNESS CHECK COULD NOT RUN — could not fetch ${bustUrl}: ${err.message}`)
  console.error('[harness] Is the app server running? (npm run build && pm2 start ecosystem.config.cjs)')
  process.exit(2)
}
const servedHash = sha256(Buffer.from(servedText, 'utf8'))

if (servedHash !== sourceHash) {
  console.error('[harness] STALE BUNDLE DETECTED — the server is NOT serving the current public/static/app.js.')
  console.error(`[harness]   current source sha256: ${sourceHash}`)
  console.error(`[harness]   served bundle sha256:   ${servedHash}`)
  console.error('[harness] This is exactly the failure mode that let prior browser-test runs pass against stale code. Aborting rather than testing unknown code.')
  process.exit(2)
}
console.log(`[harness] bundle freshness OK — served /static/app.js matches current source (sha256 ${sourceHash.slice(0, 12)}...)`)
