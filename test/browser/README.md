# Browser-UI checks (Playwright, real Chromium)

`force-add-ui.browser.mjs` drives the actual SPA in headless Chromium against
the running dev server (`http://localhost:3000`) — it is NOT part of the
vitest suite (deliberately named `.browser.mjs` so vitest's `*.spec.*` glob
ignores it), because it needs a live server + Chromium rather than the
workerd test pool.

## What it proves (22 checks)
1. **Login click-through end to end** — cold load shows the login screen,
   an unknown email fails loudly with a visible error, blank-email sign-in
   reaches the app shell, the session survives a reload (token re-validated
   via `/api/auth/me`), and logout returns to the login screen.
2. **Force-add valuation enforcement through the real UI** — an off-manifest
   scan opens the Unreconciled modal, and the force-add path cannot create a
   device without valid `buy_price` / `vat_type` / valid-ISO `currency`:
   - missing buy_price / vat_type → blocked client-side with a warn toast,
     modal stays open, **zero network requests** (asserted via response
     interception);
   - invalid ISO currency `UKL` → the client does NOT pre-check currency, so
     the request genuinely reaches the **server**, which 422s; the server's
     "not a valid ISO 4217 code" message is asserted in the rendered toast —
     this is the server-through-UI proof, not a client-only check;
   - after all blocked attempts, the inventory API confirms **no device row
     exists**;
   - valid values → 200, modal closes, the created row carries the exact
     valuation entered (`buy_price=150, GBP, MARGIN`), lands in the
     unreconciled bucket, and is visible in the Inventory view.

## Running it
```bash
# One-time (kept OUTSIDE the webapp dependency tree on purpose):
mkdir -p ~/ui-tests && cd ~/ui-tests && npm init -y && npm i playwright
npx playwright install chromium --with-deps

# App must be running (npm run build && pm2 start ecosystem.config.cjs), then:
node force-add-ui.spec.mjs   # from ~/ui-tests, with this file copied there
```
Exit code is non-zero on any failed check. Screenshots land in `./shots/`.

## Failure-mode verification (can these checks actually fail?)
Both enforcement layers were deliberately sabotaged and the suite re-run:
removing the client-side optimistic checks AND flipping the server to
`required: false` produced immediate FAILs on the blocked-attempt checks
(no toast, modal proceeded, request went through). Code was then restored
from git (sha1-verified identical) and the leaked sabotage row cleaned from
the local D1 (`received_devices` + `device_events` + `scan_events` +
`print_jobs`). Each green run's test device is likewise cleaned up so the
local DB isn't polluted with test rows.

## manual-ui.browser.mjs (13 checks)
Same pattern applied to the **Quick receive (manual)** path — the last intake
branch brought up to valuation parity: modal shows the required Valuation &
VAT section; missing buy_price / vat_type blocked client-side with zero
network requests; `UKL` typed into the currency field genuinely reaches the
server and the toast carries its 422 ISO 4217 message; no device row after
blocked attempts; valid values persist exactly (`77.50 / GBP / STANDARD`,
`source=manual`). The script prints `CLEANUP_IMEI=<imei>` at the end — delete
that row (+ its device_events / scan_events / print_jobs) from local D1 after
a green run.

## `login-prod.browser.mjs` (14 checks) — credentialed login through the real form

Added 2026-07-28 after a reported "Invalid email or password" on accounts that
had been verified **at the API level with curl but never through the UI**. Drives
the actual login form in real Chromium: types into `#login-email` /
`#login-password`, clicks `#login-submit`, and asserts the SPA reaches the app
shell — for both `owner@saigates.com` and `ops@saigates.com`.

Every positive is paired with a negative, so it cannot pass against a broken
always-true verifier: a one-character-off password must return 401 **and** stay
on the login screen with the server's message rendered; the owner's password on
the ops account must be refused; and the session must survive a reload.

Runs against either environment — credentials come from env vars so no plaintext
enters the repo:

```bash
# production
OWNER_PW='...' OPS_PW='...' node test/browser/login-prod.browser.mjs
# local preview
BASE=http://localhost:3000 OWNER_PW='...' OPS_PW='...' node test/browser/login-prod.browser.mjs
```

**Why it exists (the actual bug it would have caught):** production and the local
sandbox preview are two separate D1 databases with independently provisioned
password hashes. The prod passwords therefore returned a truthful
`Invalid email or password` against the local preview — indistinguishable, to the
person typing, from a broken deploy. The two databases are now provisioned with
the *same* hashes, and this suite is run against **both** URLs so the divergence
cannot recur silently.
