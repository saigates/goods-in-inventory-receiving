# Browser-UI checks (Playwright, real Chromium)

`force-add-ui.browser.mjs` drives the actual SPA in headless Chromium against
the running dev server (`http://localhost:3000`) — it is NOT part of the
vitest suite (deliberately named `.browser.mjs` so vitest's `*.spec.*` glob
ignores it), because it needs a live server + Chromium rather than the
workerd test pool.

## Process note (2026-08-14): a tool's own success/failure signal is not proof — `tsc` is

While wiring `siblingLegs` through the last few `computeCe1154()` /
`runImportValidation()` call sites in `src/routes/opr.ts`, one `Edit` call
reported `Failed to verify file write operation`. That error string turned
out to be an unreliable signal in both directions: a second edit that
reported the *same* error had actually applied cleanly, while the first one
had left the file with a duplicate trailing fragment (an old `export default
app` plus a few stray lines re-appended after the real end of the file).
Nothing about the diff or a plain read made this obvious — the corruption
was only surfaced when `npx tsc --noEmit -p .` failed with `Declaration or
statement expected` at the last two line numbers in the file.

**The rule this sets**: run `npx tsc --noEmit -p .` after *every* individual
`Edit` / `MultiEdit` / `Write`, not once at the end of a batch of edits —
and treat it as mandatory, not optional, immediately after any edit call
that reports an error or an ambiguous status, since that is exactly when
the tool's own signal cannot be trusted. `tsc` is doing more than type
checking here: a clean `--noEmit` run is the cheapest available proof that
the file the editor thinks it wrote is the file actually on disk. Catching
this after a handful of edits is fine; catching it after a full batch means
re-diffing everything to find which edit was the culprit.

## Process note (2026-08-14, second occurrence): the same corruption happened
## again on the same file, and `tsc` only caught it by luck

Wiring `loadMisdeclarationAcks()` into `opr.ts`'s 6 pre-existing
`computeCe1154()`/`runImportValidation()` call sites reproduced the exact
failure mode above: a multi-site edit session on `opr.ts` left duplicate,
garbled bytes after the real `export default app` at end of file. This
time `tsc` caught it too (`Declaration or statement expected` at the last
two line numbers), but only because the corruption happened to land after
the file's final syntactic construct, where a stray token is guaranteed to
be a parse error. A corruption that instead duplicated or garbled a
mid-file statement — still syntactically valid TypeScript, just wrong —
would NOT make `tsc` fail, and would ship silently.

**The rule this adds**: after any edit that touches more than one call
site in a file (whether via several `Edit` calls in sequence or one
`MultiEdit`), check the file's tail explicitly (`tail -20 file` or
`wc -l` compared against the expected line count) in addition to running
`tsc`. Do not rely on `tsc` alone to catch structural corruption; it only
catches the subset that happens to be syntactically invalid.

**Tooling degradation observed alongside this, worth flagging on its own**:
- `MultiEdit` failed atomically with `"Edit N: missing 'new_string'"` and
  applied NONE of its edits, including several that were individually
  well-formed — this is documented tool behavior, but it is easy to
  mis-diagnose as "the other edits probably went through."
- `Read` (on this same file, mid-session) hard-failed after repeated
  identical-argument calls with "This tool is not working reliably. You
  MUST stop retrying" — no content was returned at all.
- What actually recovered from both: never trusting a prior edit attempt's
  intent, and instead re-deriving the current, authoritative state of the
  6 call sites via a fresh `grep -n` before touching the file again, then
  falling back to `sed -n` for read access once `Read` degraded. Re-query
  the source of truth (the file itself, via a tool that is still working)
  rather than reasoning from what an earlier tool call was *supposed* to
  have done.

## Process note (2026-08-17): a file can contain literal `\uXXXX` text, and the
## `Read` tool's decoded view will not tell you

While correcting `public/tracker/index.html`'s metadata (Sprint A 2d), a
`MultiEdit` call reported success but produced no visible change on
re-read — a silent no-op, distinct from the two `Failed to verify file
write operation` cases above but with the same root lesson: a tool's own
success signal is not proof the bytes on disk match what you intended.

The cause here was different from the earlier two notes. This file's
inline `<script>` DATA object does not contain real Unicode punctuation
(em dashes, curly quotes) — it contains the LITERAL SIX-CHARACTER TEXT
`\u2014`, `\u2019`, `\u201c` etc., i.e. an actual backslash, `u`, and four
hex digits sitting in the file as plain ASCII bytes, not a JS string
escape that has already been evaluated into a dash or a quote. The `Read`
tool renders these bytes' *intended* character to the screen (so a `—`
appears where the file literally holds `\u2014`), which means an
`old_string` built by copy-pasting what `Read` displayed will contain the
real Unicode character — and will never match the file's actual raw
bytes, which hold the six-character escape sequence instead. `MultiEdit`
correctly reports "no match found" in the strict sense of `old_string`
not being present, but with matching text visible on both sides of the
diff to a human eye, this reads as a baffling silent failure rather than
the string-mismatch it actually is.

**How this was diagnosed**: `Read`'s decoded view was abandoned in favour
of tools that show raw bytes — `od -c` and `sed -n` — which immediately
showed the six literal characters `\`, `u`, `2`, `0`, `1`, `4` in
sequence, not a single em-dash byte (or its UTF-8 multi-byte sequence).
`grep -n` against the literal string `\\u2014` (escaped for the shell)
confirmed exactly which lines carried this pattern.

**The workaround that worked**: construct `old_string`/`new_string` from
the raw-byte tool output (`grep -n` / `sed -n` / `od -c`), never from
`Read`'s rendered view, whenever a file is suspected of holding literal
`\uXXXX` escapes rather than evaluated Unicode. For a full-line rewrite
spanning a `\uXXXX`-heavy line (as `commitNote` and `figuresSource` were
here), the most reliable approach was a short Python script operating on
exact 0-indexed line numbers (`open(path).readlines()`, replace by index,
write back) rather than any string-match-based edit at all — a line
index cannot be thrown off by an invisible escape-sequence mismatch the
way `old_string` matching can.

**The rule this adds**: before trusting `Read`'s output to build an
`old_string` against any file, especially one that embeds JSON-like
string literals inside a `<script>` block, check for literal `\uXXXX`
sequences with `grep -n '\\\\u[0-9a-fA-F]\{4\}'` (or the JS-embedding
equivalent) first. If present, treat that file the same way a binary
file would be treated for editing purposes: raw-byte tools or an
index-based script only, never a `Read`-sourced `old_string`. A single
silent no-op from `MultiEdit`/`Edit` on a file that visually appears to
contain ordinary punctuation is itself the tell.

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

## Seed-and-clean contract (applies to every script below)

These three scripts are **self-contained**: each seeds every device/shipment
row it needs via the real HTTP API (never a direct `INSERT`, so the exact
code paths a real user would hit — including their validation — are what
gets exercised), then prints a `CLEANUP_HINT` line plus a ready-to-run
`Cleanup (respecting FK order): DELETE FROM ...` SQL statement at the end.

Standing steps for every run:
1. **Local-only test password.** Before running any of these, provision
   `owner@saigates.com` with a known password on the **local** D1 only —
   this must never touch production:
   ```bash
   node scripts/set-password.mjs owner@saigates.com 'local-owner-testpw'
   # apply the printed UPDATE statement with:
   npx wrangler d1 execute webapp-production --local --command="UPDATE users SET password_hash = '...' WHERE LOWER(email) = 'owner@saigates.com';"
   ```
2. **App must be running**: `npm run build && pm2 start ecosystem.config.cjs`,
   then confirm with `curl http://localhost:3000`.
3. **Run the script** (from the repo root, so it resolves the `playwright`
   devDependency already in `package.json`):
   ```bash
   node test/browser/devices-tab.browser.mjs
   node test/browser/devices-tab-2.browser.mjs
   node test/browser/temp-export-standard-lifecycle.browser.mjs
   ```
4. **Clean up**: copy the `Cleanup (respecting FK order): ...` line the
   script printed and run it via `wrangler d1 execute ... --local
   --command="..."`. Then reset the password:
   ```sql
   UPDATE users SET password_hash = NULL WHERE LOWER(email) = 'owner@saigates.com';
   ```
5. **Confirm the DB is clean** with an aggregate zero-count query, e.g.:
   ```sql
   SELECT (SELECT COUNT(*) FROM received_devices) AS devices_remaining,
          (SELECT COUNT(*) FROM shipments) AS shipments_remaining,
          (SELECT COUNT(*) FROM shipment_lines) AS lines_remaining,
          (SELECT COUNT(*) FROM device_events) AS events_remaining,
          (SELECT COUNT(*) FROM repair_jobs) AS repair_jobs_remaining,
          (SELECT COUNT(*) FROM removal_flags) AS removal_flags_remaining,
          (SELECT COUNT(*) FROM scan_events) AS scan_events_remaining;
   ```
   Every column should read `0` (the `users.password_hash` reset is checked
   separately, since a real operator's password may legitimately be set at
   other times).

Each script claims its own 7-digit IMEI prefix so re-runs and other scripts
never collide on the `received_devices.imei` UNIQUE constraint. Prefixes
claimed so far: `8604550`-`8604553` (opr-ui, in `~/ui-tests/`, not yet moved
into this repo), `8604554` (opr6-ui), `8604555` (dbg-valui/manifest-val),
`8604556` (confirm-only), `8604557` (temp-export-standard-lifecycle),
`8604558` (devices-tab), `8604559` (devices-tab-2).

### `devices-tab.browser.mjs` (15 checks)
Devices tab — **All Devices** sub-view (status + legal transition via the
"Move to" `<select>`, exercised end-to-end: `SORTING → ACTIVE_INVENTORY`
with a confirming toast) and **Repair Queue** sub-view (seeded
`IN_HOUSE_REPAIR` device shows its `repair_jobs` join data — `fault_code`,
job status — then **Scan back** (`open → awaiting_qc`) and **QC pass**
(`awaiting_qc → Ready for Zoho`) both driven through the real UI buttons
against the live backend).

### `devices-tab-2.browser.mjs` (22 checks)
The four surfaces `devices-tab.browser.mjs` leaves unexercised:
- **QC Failed** — seeded device (driven to that status via
  `repair/start` + `repair/qc(FAILED, reason)`) renders with its fault
  reason; "Go to Repair Queue" shortcut navigates correctly.
- **Ready for Zoho** — seeded device (via `repair/qc(PASSED)`, which
  requires grade A/B/C to clear the gate — grade `UG` is rejected by
  `checkReadyForZohoGate` and will 409) renders read-only (no action
  buttons in that row).
- **Removal Flags** — the flag is generated by the **real** regrade path
  (`POST /api/inventory/grade` via the Inventory view's grade `<select>`,
  regrading an `ACTIVE_INVENTORY` device to `UG`), not a direct DB insert.
  Also exercises **Resolve** and the "Show resolved" toggle.
- **BulkTransitionModal**, mixed-outcome batch: one IMEI legally
  transitions (`SORTING → ACTIVE_INVENTORY`), one is already in the target
  status (illegal self-transition, `ALLOWED_TRANSITIONS['ACTIVE_INVENTORY']
  = []`), one is illegal for the map (`RECEIVED → ACTIVE_INVENTORY`).
  Asserts the toast summary counts AND each individual result row's
  per-IMEI outcome badge (`transitioned` / `skipped`), not just the
  aggregate.

### `temp-export-standard-lifecycle.browser.mjs` (34 checks)
Full `TEMP_EXPORT_STANDARD` device/shipment lifecycle: create export via
`OprNewShipmentModal` (shipment_type selector hides/shows the
authorisation + procedure-code fields correctly) → scan → finalise
(confirms device status becomes `TEMP_EXPORTED_STANDARD`, not
`EXPORTED_UNDER_OPR`) → create the linked return (same-shipment_type
discharge-link filter proven working) → scan → finalise/receive (confirms
`RETURNED_UNDER_STANDARD`) → restock (confirms `ACTIVE_INVENTORY`).

The validation-panel check is **exhaustive, not a spot check**: every
visible check row is enumerated, and any row whose message starts with
`'Not applicable'` must render the grey `badge-slate` / `n/a` badge — never
green. It also separately asserts zero `badge-green` elements exist among
the per-check rows at all (a stronger invariant than checking each skipped
row individually, since it also catches a wording drift in a check nobody
thought to enumerate). This directly guards against the fragile
`message.startsWith('Not applicable')` string-coupling between the backend
validation engines (`src/lib/oprValidation.ts`, `src/lib/oprImport.ts`) and
the frontend (`OprShipmentDetail` in `public/static/app.js`) — if a future
backend check is worded differently, this script fails loudly with the
exact badge class and message text logged, rather than silently rendering
a skipped customs check as a passed one.
