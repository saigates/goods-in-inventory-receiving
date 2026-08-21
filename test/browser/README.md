# Browser-UI checks (Playwright, real Chromium)

`force-add-ui.browser.mjs` drives the actual SPA in headless Chromium against
the running dev server (`http://localhost:3000`) — it is NOT part of the
vitest suite (deliberately named `.browser.mjs` so vitest's `*.spec.*` glob
ignores it), because it needs a live server + Chromium rather than the
workerd test pool.

## Named process smell (2026-08-18): "vacuous same-side reconciliation" — any reconciliation where one side is derived from the other must never render a verdict

**The smell, named explicitly so it stops recurring by accident:** if a
comparison's two "independent" sides are actually the same value expressed
two ways — one computed FROM the other rather than sourced independently —
the comparison carries zero information and rendering a definitive verdict
from it (especially a green/Balanced one) is a defect, not a display
choice. It looks like a real check and always passes, which is worse than
having no check at all.

**Confirmed occurrences of this exact shape in this build, in order:**
1. `c5e5f25` — a bill's `gbp_total` column (itself defined as the sum of
   its own `bill_lines`) was being compared against that same sum, in
   `checkBillCloseable()`'s original form. Fixed by comparing sum(lines)
   against the bill's independently-entered `declared_total_gbp` instead.
2. The manifest→bill "header-only false green" that
   `reconcileManifestAgainstBill()`'s `awaiting_manifest` verdict exists to
   prevent (see that module's own header comment) — comparing a bill
   against itself when no manifest was actually linked yet.
3. **This pass** — `BillDetailView()`'s same-document check, reproduced in
   the DISPLAY layer rather than the data layer: a `price_source='header'`
   bill (`src/lib/billBuilder.ts`) has exactly ONE synthetic `bill_lines`
   row whose `unit_price_gbp` is computed directly FROM `declared_total`.
   `sum(lines)` therefore equals `declared_total_gbp` BY CONSTRUCTION for
   every such bill, with no exception — the old unconditional badge was
   arithmetically incapable of ever showing anything but "Balanced". Fixed
   with a two-armed gate (`bill.price_source === 'header' || lines.length
   === 0`) that suppresses the same-document verdict and, where a manifest
   IS linked, delegates to the genuinely independent
   `reconcileManifestAgainstBill()` comparison instead (via the shared
   `ManifestBillReconciliationBadge()` function — one verdict function, not
   two copies of the comparison logic). Proven via
   `bill-detail-vacuous-check.browser.mjs`, per the standing rule below.
   With no manifest linked, the badge shows a neutral, non-green "UNPRICED —
   NO LINE DETAIL; RECONCILIATION NOT APPLICABLE" state rather than any
   fabricated verdict.

**The rule going forward:** before wiring any A-vs-B comparison that will
render a Balanced/Matched/OK-style verdict, check whether B was computed
FROM A (or vice versa) anywhere upstream. If it was, either source a
genuinely independent B, or suppress the verdict and say so explicitly
(as `awaiting_manifest` and the header-mode gate above both do) — never
render green from a comparison that cannot mathematically fail.

## Standing process rule (2026-08-18): any claim about a rendered verdict must be cited from a browser check, never an API or pure-function test

A pure-function test (e.g. `reconcileManifestAgainstBill()`'s own spec) or
an HTTP-layer test (e.g. `test/bills.spec.ts` asserting a JSON field) can
prove the DATA is correct, but neither one renders `BillDetailView()` or
any other UI function — so neither can be cited as proof of what a badge,
button, or piece of rendered text actually SHOWS a user. Any statement of
the form "the UI now correctly displays X" must be backed by a
`*.browser.mjs` script that reads the rendered DOM text and asserts on it,
not by a green vitest run alone.

## Process fix (2026-08-18): every script now enforces its own build + bundle freshness — not a documented step, an enforced one

**The incident this closes**: `dist/static/app.js` was found to be a stale
pre-reorder build while `public/static/app.js` (source) already had the
correct nav order — `wrangler pages dev dist` serves whatever is physically
in `dist/`, and nothing rebuilds it automatically on a source edit or a
`pm2 restart`. This means every browser-test PASS before the fix (Devices
tab 18/18 then 25/25, Bills UI 27/28) was potentially checking a bundle that
didn't contain the code under test — not necessarily wrong, but not proven
either.

**The fix**: `test/browser/_harness.mjs` is now imported as the literal
first line of every `*.browser.mjs` script. Being an ES module, its
top-level code runs synchronously on import, before anything else in the
calling script executes, which is what makes this enforced rather than a
step someone can skip. It does two things, in order, and exits with code 2
(aborting the whole run before any check executes) if either fails:

1. Runs `npm run build` for real. A build failure aborts immediately.
2. Fetches the live server's `/static/app.js` (cache-busted) and compares
   its **SHA-256 content hash** against the current `public/static/app.js`
   on disk. Deliberately not a fixed marker string — a hardcoded marker can
   itself go stale and keep passing against a bundle missing some later,
   unrelated change, which would silently recreate the exact failure mode
   this fix exists to close. A full-content hash is self-maintaining: it
   fails the instant served and source diverge by even one byte, for any
   reason (stale `dist/`, wrong port, wrong branch, a caching layer, etc.).

Verified both directions before wiring it in: run clean against the real
dev server (passes, hash match logged) and run against a deliberately
mismatched served bundle (aborts with exit 2, both hashes printed, before
any Playwright check runs). Also verified the underlying assumption that a
plain `npm run build` (no `pm2 restart`) is sufficient for `wrangler pages
dev` to pick up the new `dist/` — confirmed via a scratch marker line
appended to source, rebuilt, and fetched back from the live server without
touching pm2.

No `*.browser.mjs` script should ever add its own build step or its own
freshness check — that duplication is exactly what this file exists to
avoid. Add `import './_harness.mjs'` as the first import and nothing else.

## Process note (2026-08-18) — bill_lines FK order missing from `manifest-bill-link.browser.mjs`'s printed cleanup line

Running the harness-wired script end to end surfaced a real (if minor) bug
in the script's own `CLEANUP_HINT` output: `bill_lines.bill_id → bills(id)`
is `ON DELETE NO ACTION` (confirmed via `PRAGMA foreign_key_list(bill_lines)`
against local D1), so the printed `DELETE FROM bills ...` failed with
`SQLITE_CONSTRAINT_FOREIGNKEY` until `bill_lines` was deleted first. Fixed
in the script itself (the printed line now deletes `bill_lines` before
`bills`); `expected_devices` does not need its own `DELETE` in that line —
`manifests`' FK to it is `ON DELETE CASCADE`, so deleting the manifest row
cascades it. Any bills-related test's cleanup line should be checked
against `PRAGMA foreign_key_list(<table>)` rather than assumed correct by
inspection, since `NO ACTION` vs `CASCADE` isn't visible from the DELETE
statement alone.

## Process note (2026-08-18): bill-to-manifest consumption is UNSTARTED, confirmed by exhaustive grep

Asked to confirm whether bill line → manifest line consumption (open /
partly-received / fully-received states) was built as part of Sprint B §1
or remains unstarted. Confirmed **unstarted**, not merely unsurfaced,
via zero-match greps rather than assumption:
- `grep -n "bill" src/routes/manifests.ts` → zero matches (exit code 1).
- `grep -rn "manifest_id\|expected_devices"` across `src/routes/bills.ts`,
  `src/lib/billBuilder.ts`, and `migrations/0028_bills_cost_ledger_freight.sql`
  → zero matches, aside from two prose comments citing
  `manifests.ts`'s *coding discipline* (bulk-lookup pattern) as a style
  precedent — not actual linkage code.
- `grep -rn "bill_id" migrations/ src/` → every hit is confined to bills'
  own tables (`bill_lines`, `bill_line_serials`, `bill_close_overrides`);
  none reference a manifest or manifest line.

The only cross-linkage that exists today is
`bill_line_serials.received_device_id`, resolved via IMEI match against
`received_devices` at bill-creation time (`src/routes/bills.ts`'s
`POST /`). That is a narrower, different mechanism than "a bill line
consumes a manifest line with open/partly-received/fully-received
states" — it ties a bill line to a device that has already been
received, not to the manifest line that predicted its arrival. Building
real manifest-consumption is a separate, unstarted unit.

(This note was originally written as an inline comment in
`public/static/app.js`'s Bills UI section; moved here 2026-08-18 since a
process/investigation finding belongs in process notes, not shipped
frontend code.)

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
   node test/browser/bills-tab.browser.mjs
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
          (SELECT COUNT(*) FROM scan_events) AS scan_events_remaining,
          (SELECT COUNT(*) FROM bills) AS bills_remaining,
          (SELECT COUNT(*) FROM bill_lines) AS bill_lines_remaining,
          (SELECT COUNT(*) FROM cost_ledger) AS cost_ledger_remaining;
   ```
   Every column should read `0` (the `users.password_hash` reset is checked
   separately, since a real operator's password may legitimately be set at
   other times).

Each script claims its own 7-digit IMEI prefix so re-runs and other scripts
never collide on the `received_devices.imei` UNIQUE constraint. Prefixes
claimed so far: `8604550`-`8604553` (opr-ui, in `~/ui-tests/`, not yet moved
into this repo), `8604554` (opr6-ui), `8604555` (dbg-valui/manifest-val),
`8604556` (confirm-only), `8604557` (temp-export-standard-lifecycle),
`8604558` (devices-tab), `8604559` (devices-tab-2), `8604560` (bills-tab),
`8604561` (manifest-bill-link), `8604562` (bill-detail-vacuous-check —
claimed per convention though this script seeds no received_devices rows),
`8604563` (upload-result-panel), `9900*` (G5 item 2 catalog auto-generation
verification, 2026-08-21, disposable `browser_check.mjs` script — not
checked into this repo, deleted after the citation was captured; see the
citation record below).

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

### `bills-tab.browser.mjs` (34 checks)
Bills tab (Sprint B §1 UI) — list, create (per-IMEI pricing, GBP and
non-GBP with the exchange_rate/rate_date fields appearing conditionally),
reconciliation panel (`declared_total_gbp` vs `sum(lines)`, explicitly not
`gbp_total`), close, force-close, and the append-only force-close history
panel.

**Non-vacuity proof of the §1 close rule, through the real UI+API (not
asserted from unit tests alone)**: one bill is built to be genuinely
balanced (declared total and per-IMEI line sum both £300) and closes on
the first Close click; a second bill is built to be deliberately
unbalanced (£799.20 summed vs £200 declared_total_gbp) and normal Close is
asserted to be **rejected** with the correct variance message before
Force-close (with a reason) is used to override it — demonstrating the
check is not circular/always-true, since an unbalanced bill visibly fails
the same code path a balanced one visibly passes.

**Console-error scoping is per-step, not one end-of-run assertion.** The
close-rejection step deliberately drives a 409 from
`POST /api/bills/:id/close`, which Chromium logs as a `Failed to load
resource: 409` console entry. Rather than filtering all 409s globally out
of the console-error check (which would also hide an unrelated real 409
bug anywhere else in the run), the script checkpoints `consoleErrors`
between phases and asserts each phase is clean; the one phase that
expects a 409 asserts the fresh set contains **exactly** that one line and
nothing else.

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

### `upload-result-panel.browser.mjs` (22 checks)
Upload-result panel (G5 item 1) — `condition_discrepancies` /
`grade_coercions` from `POST /manifests`, surfaced in a persistent panel
(`#upload-result-panel`) on the Receive tab rather than a toast, since
these two arrays are never persisted server-side and a toast alone would
make a finding unreadable the moment someone came back later to act on
it. Two manifests are uploaded in sequence against a dedicated disposable
fixture account (`g5-fixture@example.invalid` — `owner@saigates.com` /
`ops@saigates.com` are real per-person accounts and are off-limits as
disposable test fixtures per the standing constraint; provision this
fixture the same way as `g4-fixture@example.invalid` below, via
`scripts/set-password.mjs` + a plain `INSERT INTO users`):

- **Populated case**: a 2-row manifest with one out-of-scale grade (`Z` →
  coerced to `UG`, logged in `grade_coercions`) and two uploaded
  `condition` values that disagree with their grade-derived condition
  (logged in `condition_discrepancies`). Asserts the exact coercion/
  discrepancy counts and per-row detail text render, that the two findings
  render in visually **distinct** blocks (`#upload-result-coercions` /
  `#upload-result-discrepancies`, amber vs slate), and — checked via
  `compareDocumentPosition`, not inferred — that the coercions block
  precedes the discrepancies block in DOM order, since a coercion is the
  quieter, easier-to-miss event of the two and must not be scanned past at
  equal visual weight. Then asserts the panel **survives an unrelated
  re-render** (opening and dismissing the Bulk-scan modal) and **survives
  navigating away to Manifests and back to Receive**, without a page
  reload, still showing the same findings — both via actual DOM text
  reads after the navigation, not inferred from the global `state` object
  persisting.
- **Zero case**: a second, clean manifest (grade `B` + condition `Used`,
  which is exactly what `B` derives) is uploaded and made active. Asserts
  the panel switches to an explicit "Clean upload" state — not an empty
  box, and not the prior manifest's stale coercion/discrepancy counts
  bleeding across the switch.

## Process note (2026-08-19): scope correction (0023-0029, not 0024-0029) + two owed browser assertions closed + local dev D1 reset side-effect

**Scope correction**: earlier deploy-hold documentation (`.deploy-checks/pre-0029-export.md`,
`migrations-held/README.md`) stated the held/undeployed migration batch was
"0024-0029". Production's own `d1_migrations` export shows only IDs 1-22
ever applied — the correct scope is **0023-0029 (seven files)**. Worse,
forensic review of migration 0023 itself (per explicit sprint instruction)
found a genuine blocking defect: it recreates `received_devices` and
repoints four child tables' FKs but misses two more added by the very next
migration (0022) — `repair_jobs` and `zoho_batch_devices`, both `NO ACTION`
children. Deploying 0023 as written would raise `FOREIGN KEY constraint
failed` the moment either table holds a row. Full forensics, empirical
reproduction, and the required rollback statement are in
`.deploy-checks/pre-0029-export.md`'s 2026-08-19 addendum. The whole
0023-0029 batch is held pending a fix to 0023, which is its own reviewed
unit, not attempted this pass.

**Two owed browser assertions closed**: commit `7b3d590`'s own message
stated plainly that the sentinel-survives-a-re-render behavior and the
`#mf-sup` read-only-lock/pre-fill text had no dedicated browser assertion
yet. `mf-bill-sentinel-and-lock.browser.mjs` (22 checks) now proves both:
`#mf-bill` keeps the linked bill selected across an UNRELATED re-render
(triggered via an unmapped column-mapping change, not by re-touching
`#mf-bill` itself — a genuine survives-re-render check, not a tautology),
and `#mf-sup` becomes readonly + pre-filled + captioned on link, and
editable again (without losing its value) on unlink.

**Local dev D1 reset side-effect (2026-08-19 note) — RETRACTED 2026-08-20,
attribution was wrong.** The paragraph originally here claimed
`test/apply-migrations.ts`'s `rm -rf .wrangler/state/v3/d1` shared its
persistence path with the live `pm2`-managed dev server and that running
the vitest suite was what wiped the dev server's own local D1. That claim
does not survive a check of the actual file: `git log --all --oneline --
test/apply-migrations.ts` shows exactly **one** commit ever (`e99f8bb`, the
file's creation), and its content — then and now — is 13 lines that only
call `applyD1Migrations(anyEnv.DB, anyEnv.TEST_MIGRATIONS)`. It has never
contained an `rm -rf` line. A repo-wide trace of the exact string,
`git log -p --all -S "rm -rf .wrangler/state/v3/d1"`, shows it was only
ever introduced in three places: this file's own prose (the paragraph being
retracted here), `backups/RESTORE.md`, and `package.json`'s `db:reset`
script (`rm -rf .wrangler/state/v3/d1 && npm run db:migrate:local && npm run
db:seed`). The two historical dev-DB-restore incidents this note was
explaining were therefore almost certainly caused by a manual or
`npm run db:reset` invocation against the shared path — not by running the
vitest suite, which never touches it.

**G4 (2026-08-20): vitest D1 isolation measured, root cause corrected, the
actual destructive path guarded.**

*What vitest actually does, measured, not inferred.* `vitest.config.ts`
loads its D1 binding via `wrangler: { configPath: './wrangler.jsonc' }`,
the same config file the `pm2`-managed dev server reads
(`ecosystem.config.cjs` → `wrangler pages dev dist --d1=webapp-production
--local`). Despite sharing that config file, tracing all three layers
involved —
`@cloudflare/vitest-pool-workers/dist/pool/index.mjs`'s
`buildProjectMiniflareOptions()` / `SHARED_MINIFLARE_OPTIONS` (no
persist-related key), `miniflare/dist/src/index.js`'s D1 plugin
`getPersistPath()` (falls back to `path.join(tmpPath, "d1")` when no
`d1Persist`/`defaultPersistRoot` is supplied) and its Miniflare-instance
constructor (`tmpPath = os.tmpdir() + "/miniflare-" + random hex`, removed
via an exit hook on process exit), and `wrangler/wrangler-dist/cli.js`'s
`unstable_getMiniflareWorkerOptions()` (the function vitest-pool-workers
actually calls; its return value carries no `defaultPersistRoot` field at
all, unlike the sibling `wrangler pages dev` code path, which explicitly
computes one defaulting to `.wrangler/state/v3`) — shows that
vitest-pool-workers never forwards a persist root to Miniflare. Each vitest
run therefore gets its own fresh, ephemeral OS-tmpdir D1 store, never
`.wrangler/state/v3/d1`.

*Measured, not just traced.* `md5sum` of both files under
`.wrangler/state/v3/d1/miniflare-D1DatabaseObject/` (`metadata.sqlite` +
the hash-named data file), taken immediately before and immediately after
a full `npx vitest run --reporter=dot` run (25 test files / 511 passed / 8
skipped), came back byte-identical both times this was tried. `curl
http://localhost:3000/api/auth/me` and `wrangler d1 execute
webapp-production --local --command="SELECT COUNT(*)/rows FROM users"`
were also unchanged across the same runs, and `pm2 list` showed the same
`webapp` pid throughout (no restart occurred or was needed). This is the
repeatable isolation check for this claim going forward — cheap enough to
re-run on demand, and it proves the property directly rather than
inferring it from "the dev server still works."

*The actual destructive path, now guarded.* `package.json`'s `db:reset`
script is the only scripted path (outside this file's own retracted prose
and `backups/RESTORE.md`) that ever ran `rm -rf .wrangler/state/v3/d1`
against the shared dev-server state, so it — not the vitest harness — is
the real cause of the two historical restores. It now refuses to run
unless invoked as `CONFIRM_DB_RESET=1 npm run db:reset`; an unguarded `npm
run db:reset` prints the reason and exits 1 without touching anything.
Verified: an unguarded call was run and confirmed to exit 1 with the
warning printed, and the shared D1 files' md5s were unchanged before and
after that call.

*Login → 200 with no restore step.* Per the standing constraint that
`owner@saigates.com` / `ops@saigates.com` are real per-person accounts and
must not be used as disposable test fixtures, this check used a dedicated,
disposable fixture account instead
(`g4-fixture@example.invalid`, inserted via `scripts/set-password.mjs` +
a plain `INSERT INTO users`, following the same seed-and-clean contract as
the scripts below). `POST /api/auth/login` with its credentials returned
`200` with a valid token and user object; the fixture row was then deleted
per the seed-and-clean contract. `/api/auth/me` without a bearer token
(the check this note previously — wrongly — treated as sufficient) only
proves the server is up and routing; it does not exercise the credential
path at all, so it is not cited as the login proof here.

**Consequence for the sprint-wide constraint list**: "vitest shares
persistence with `.wrangler/state/v3/d1`" is retracted as a stated risk —
it was never true. The constraint that generalizes correctly from this
incident is narrower and about `.wrangler/state/v3/d1` itself: no
destructive command (`rm -rf`, `db:reset` without explicit opt-in, or any
manual equivalent) should be run against that path without the same
intentional, opt-in gate `db:reset` now enforces, since that path — not
the test harness — is what actually cost two restores.

## G5 item 1 (2026-08-20): upload-result panel — persistent, distinct coercion/discrepancy treatment, zero-case proven

`condition_discrepancies` / `grade_coercions` from `POST /manifests` exist
only in that response — never persisted server-side, never returned by
`GET /manifests/:id` — and the pre-submission upload modal that receives
the response is removed from the DOM (`$('#upload-modal').remove()`)
immediately on success, before either array is read. `submitManifest()`
(`public/static/app.js`) now captures both into a new `state.lastUploadResult`
field (`{ manifestId, reference, conditionDiscrepancies, gradeCoercions }`)
instead of discarding them, and a new `UploadResultPanel()` renders on the
Receive tab for the manifest that field is keyed to.

`grade_coercions` is given deliberately louder treatment than
`condition_discrepancies` — a discrepancy is the vendor's own condition
text disagreeing with the grade-derived one (visible, an operator can
eyeball which is right); a coercion means `normalizeGrade()` silently
rewrote an out-of-scale grade to `UG` because the data didn't fit the enum
at all, a quieter event precisely because nothing "looks wrong" in the row
afterwards. The coercions block (amber, `#upload-result-coercions`) is
rendered ahead of the discrepancies block (slate, `#upload-result-discrepancies`)
in DOM order — proven via `compareDocumentPosition`, not asserted from
memory. The zero case renders an explicit "Clean upload" state
(`#upload-result-panel` with a green badge), never an empty box.

Proven end-to-end by `upload-result-panel.browser.mjs` (22 checks, all
passing) — see its entry above — including that the panel survives an
unrelated re-render and a navigation away (Manifests) and back (Receive)
without a page reload, and that the zero-case manifest does not inherit
the previous manifest's stale counts. `tsc --noEmit` clean; full vitest
suite unchanged at 25 files / 511 passed / 8 skipped / 519 total.

## Citation record: BROWSER-CHECK-002 (2026-08-21, G5 item 2 verification)

Real Playwright-driven flow through the live dev server, run via a
disposable script (`browser_check.mjs`, not checked into this repo —
created and deleted the same session after the citation was captured):
login → select the disposable manifest `BROWSER-CHECK-002` (id 5,
brand `LiveCheckBrand2` / model `SAMSUNG BROWSERCHECKMODEL9000`, IMEI
`990000000000002` — see the `9900*` prefix claim above; a first attempt,
`BROWSER-CHECK-001`, failed the server's Luhn check on IMEI
`990000000000001` and was superseded, not reused) → scan the IMEI →
click "Add to catalogue & receive".

**Result**: toast rendered "Added SMSG-BROWSERCHECKMODEL9000-128-TEA-A to
catalogue" then "Received 990000000000002 · ... · label queued"; the
label modal rendered with the correct grade "A" badge; zero console
errors captured; a full-page screenshot was taken as evidence (deleted
after review, not a retained artifact). Server-side, `sku_catalog`
confirmed 4 new rows (ids 687-690, grades A/B/C/UG) created by the single
click, i.e. `POST /api/catalog`'s auto-generation of missing sibling
grades (`src/routes/catalog.ts`) fired correctly through the real UI, not
just against a direct API call.

**Precise scope of this proof** (see
`.deploy-checks/g5-item2-catalog-grade-gap-sweep.md`'s own "Browser
citation" section for the same wording): this proves the new response
shape renders without regression against the existing UI flow. It does
NOT prove `generated_siblings`/`sku_conflicts` are surfaced to the
operator — the toast text did not mention the 3 sibling rows also
created by this call, consistent with that UI enhancement being
deliberately deferred. A non-empty `sku_conflicts` case remains
unexercised in a browser (low-priority follow-up, not a gap, since UI
surfacing itself is deferred).

**Cleanup**: all disposable rows created for this check — the two test
manifests (`BROWSER-CHECK-001` id 4, `BROWSER-CHECK-002` id 5) and their
`expected_devices` rows, the `received_devices` row (imei
`990000000000002`), the 4 `sku_catalog` rows (ids 687-690), the
`device_events`/`scan_events`/`print_jobs` rows tied to them, and the
disposable user `test-autogen2@example.local` (id 6) used to drive the
login — were all deleted the same session. `users` table verified back
to its exact 3-row incident-recovery baseline
(`admin@goodsin.local`, `owner@saigates.com`, `ops@saigates.com`) via
`SELECT id, email FROM users ORDER BY id;`, and `PRAGMA
foreign_key_check;` confirmed clean. The disposable user's deletion was
blocked initially by an FK reference from a leftover `device_events` row
(`user_id=6`); resolved by enumerating every real FK-to-`users`
table+column via `SELECT name, sql FROM sqlite_master WHERE type='table'
AND sql LIKE '%REFERENCES users%';` (8 tables/columns returned) rather
than guessing, checking each for the value, and deleting the one
blocking row before deleting the user.
