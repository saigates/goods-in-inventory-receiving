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
