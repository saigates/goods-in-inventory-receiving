# Z-16 — convention drift: a file says one thing and does another

Not a ticket with a build deliverable — a standing tracking note for a
recurring failure mode this codebase has produced multiple times: a
comment, a test assertion, or a logging choice states a fact about the
system that was true when written, the system changes underneath it, and
nothing forces the stale statement to be noticed or updated. The
statement then actively misleads the next person (including a future
pass of this same agent) instead of just going quiet.

This note exists so the pattern has one place to be recognised by name,
rather than being re-discovered and re-explained from scratch each time
it recurs. Parked here per operator instruction (2026-09-27) rather than
tracked as an open ticket, since there is no single fix — each instance
below was fixed locally, in the commit that found it.

A ruling issued in conversation is not a ruling recorded. Three of the
instances below (6, 7, 8) were each ruled on in a prior pass but never
actually written into this file — this document went briefly out of
sync with its own record for the exact reason it exists: a fact true in
someone's head, not in a file. That gap is itself the drift mechanism
Z-16 exists to catch, and it caught itself (2026-09-28, operator §3).

## The fourteen instances on record

1. **FK-ordered teardown needing three separate manual fixes** —
   `test/oprImport.spec.ts`'s `afterAll` cleanup deletes rows in an order
   that must respect every table's foreign-key references to `shipments`
   (and to each other). Each time a new table was added that referenced
   `shipments` (`shipment_value_deltas`, `return_line_corrections`, then
   Z-15's `partial_return_declarations`), the cleanup block's *comment*
   said "delete in FK order" but the code itself did not automatically
   enforce it — a new table's DELETE had to be manually inserted in the
   right position, and the Z-15 commit (`d5d787c`, 2026-09-27) is the
   third time this needed a follow-up fix, caught only by a **full
   serial-suite run** after the initial fix looked complete: "Also fixed
   a genuine 5th bug surfaced only by a full serial-suite run after the
   [first 4] above: the suite's afterAll cleanup deleted from shipments
   before deleting from the new partial_return_declarations table... same
   ordering constraint already respected for shipment_value_deltas and
   return_line_corrections in this same afterAll, just not yet extended
   to the new Z-15 table." The comment ("FK order matters") was correct
   throughout; the code silently fell one table behind it, twice.

2. **`test/oprFoundation.spec.ts` asserting on literal error text that
   drifted** — the test `'rejects devices with no buy_price — no line
   created'` asserted the exact old error message the export-gate used to
   return. When Z-2 (2026-09-26) widened that gate to call
   `computeAcquisitionCostGbp()` instead of reading `buy_price` directly,
   the gate's real behaviour and error wording changed (a "no acquisition
   cost" message replaced the old buy-price-specific one) but the test's
   literal-string assertion did not — the test kept passing right up
   until Z-2's own full-suite run surfaced it as a regression (commit
   `225308c`, 2026-09-26: "fixed a real regression the widened
   export-gate surfaced — ... asserted the OLD literal-buy_price error
   wording; the gate now calls computeAcquisitionCostGbp() and returns a
   'no acquisition cost' message instead"). The test name itself also
   needed updating, since it described the old, no-longer-accurate
   behaviour.

3. **`test/skuMapImport.spec.ts` claiming the endpoint was retired while
   the guard beneath it said otherwise** — a test-harness comment read
   "production retired /api/sku-map", written during the 2026-09-10
   incident response when the route genuinely was unmounted. The route
   was re-mounted in `src/index.tsx` the very next day (2026-09-11, Quick
   Item B), but the comment was never updated — it sat directly ABOVE a
   `describe` block whose own tests, from that point forward, were
   actively proving the opposite fact (that the route IS live). The stale
   comment was only corrected on 2026-09-27, seventeen days after it went
   wrong, specifically because a later pass through this file noticed the
   comment contradicted the test block immediately beneath it: "This
   comment previously read 'production retired /api/sku-map' — stale as
   of the re-mount, corrected here (2026-09-27) rather than left
   contradicting the GUARD block beneath it."

4. **`costEntry.ts` logging an override to console where Z-6 persists it
   to `device_events`** — `postPurchaseCostToLedger`'s
   `allow_duplicate_purchase_row` override is real, working code, not
   drift in the sense of the three instances above (nothing about it is
   stale or wrong). It is listed here as the FORWARD-LOOKING half of this
   note: its own comment states, as settled design, "OVERRIDE SIGNALLING:
   server-side log line only (console.log), NOT a response-body field —
   the response goes to the caller, a log line is what an operator/
   auditor greps, and the two audiences should not be conflated." Z-6
   (2026-09-27) needed the same override-with-reason shape but for a
   customs-adjacent record (a device already snapshotted into a Zoho
   batch), and the operator ruled explicitly that `costEntry.ts`'s
   console-only pattern is **not** strong enough for that case — an
   override on a customs-adjacent record needs to be *queryable*, not
   merely *greppable*. Z-6 keeps the `console.log` line for parity but
   ALSO persists the override + its reason into `device_events.metadata`.
   Two working patterns now coexist in the codebase for the same shape of
   problem (a second-layer override on an already-authenticated write) —
   this is not itself drift, but it is exactly the kind of situation
   where a future author could copy the older, weaker `costEntry.ts`
   pattern by habit instead of the newer, stronger `devices.ts` one,
   which is why the forward rule below names `devices.ts` as the one to
   copy.

5. **Four benign auto-backup collisions** — every merge this session
   (`z4-phase2-excel-roundtrip`, `z6-correction-lock`, and two prior
   tickets) hit a `git fetch genspark main` that had silently advanced
   past the last-recorded `main` tip, because the platform's end-of-turn
   auto-backup mechanism pushes the current branch tip to `genspark/main`
   regardless of what branch is actually meant to be `main` at that
   moment. Each time, the stated fact ("genspark/main is at commit X, the
   last one we recorded") was already false by the time the next merge
   was attempted — not because anything was wrong, but because an
   out-of-band process changed the ref without updating any comment,
   report, or expectation that referenced it. Each instance was resolved
   the same way (diff the candidate against the unexpected tip — 0 lines
   — then `merge-base --is-ancestor` — true — before proceeding), but the
   check had to be re-run by hand every single time; nothing in the
   process itself flags "the fact you are about to rely on has already
   changed."

6. **Silent null-to-zero coercion of `acquisition_cost_gbp` inside
   `total_cost_gbp`** — `computeAcquisitionCostGbp()` correctly returns
   `acquisition_cost_gbp: null` for a device with no `cost_ledger`
   purchase row and no `buy_price` (`acquisition_source: 'none'`,
   `src/lib/acquisitionCost.ts:63`). But `computeDeviceCostBreakdown()`
   silently treats that `null` as `0` when summing `total_cost_gbp`
   (`const totalCostGbp = round2((acquisition.acquisition_cost_gbp ?? 0)
   + repairCostGbp + freightCostGbp)`, `acquisitionCost.ts:91`). The
   `null`/`'none'` distinction is preserved correctly in
   `acquisition_cost_gbp`/`acquisition_source` themselves — nothing here
   is a bug in the existing code — but any caller that reads only
   `total_cost_gbp` without also checking `acquisition_source` sees an
   indistinguishable `0`, the same value a genuinely free/zero-cost
   device would produce. Ruled during the Z-5/V-6 review pass
   (2026-09-27) as a real drift risk for V-6 specifically (an Amazon-
   facing cost feed reading `total_cost_gbp` verbatim would report a
   fallback-costed device as literally free), and flagged as one of
   V-6's still-open build-time questions
   (`docs/plan/v6-amazon-cost-feed.md:179-185`) — but the ruling that
   this is a Z-16-shaped drift risk in its own right was never written
   into this file until now.

7. **`h()` hyperscript helper's undefined/null-only attribute skip,
   producing `disabled="false"`** — `public/static/app.js`'s `h()`
   helper only skips `el.setAttribute(k, v)` for `v === undefined` or
   `v === null` (`app.js:20`, `else if (v !== undefined && v !== null)
   el.setAttribute(k, v)`). HTML's `disabled` is a boolean PRESENCE
   attribute, so a raw `false` passed as `disabled: false` still calls
   `setAttribute('disabled', false)`, which the DOM treats as present
   (disabled) — identical to `setAttribute('disabled', 'disabled')`.
   Three call sites in the SKU-map modals used this broken raw-boolean
   pattern instead of the working `condition ? 'disabled' : null` idiom
   used at ~15 other sites in the same file; one of the three (the
   Commit-import button) reached production and was reported by the
   operator as a live bug (154-row clean dry run, button permanently
   disabled). Fixed in commit `7bd0d68` (2026-09-27/28). Ruled at the
   time as opening Z-17 (systemic review of the `h()` helper's
   attribute-setting logic for any other boolean-presence attributes
   misused this way) — Z-17 is correctly listed as parked for Sprint 2
   grooming elsewhere in this project's tracking, but the drift-log
   entry for the underlying defect class itself was never written here
   until now.

8. **Genspark auto-backup pushing a sibling commit ahead of the agent's
   own commit** — during the Z-4 unmapped-queue-filter pass
   (2026-09-28), the platform's end-of-turn auto-backup mechanism
   captured this pass's working-tree changes as commit `cfdc305`
   ("genspark auto-backup") and pushed it directly to `genspark/main`
   BEFORE the agent committed the same changes itself, under a
   descriptive message, as `7374112`. Both commits shared the same
   parent (`7bd0d68`) and an identical tree
   (`cb108b09a30c346e135c887f1dc0afadd5cff9a1`) — true siblings, not a
   content conflict — but `git merge-base --is-ancestor genspark/main
   main` returned **false** for the first time this session (five prior
   benign auto-backup collisions, instance 5 above, had all returned
   true). `git push genspark main` was rejected as non-fast-forward.
   Resolved via a content-no-op merge commit (`dc9b533`) rather than a
   force-push, restoring the three-way `main`/`origin/main`/
   `genspark/main` HEAD match. This is a genuinely new failure MODE of
   instance 5's mechanism (identical content but non-ancestor history,
   not just an advanced-past-expectation tip), ruled as its own
   distinct instance at the time rather than folded into instance 5 —
   but, per the pattern this whole file exists to catch, that ruling
   itself was never written down until now.

9. **`rm -rf .wrangler/state/v3/d1` treated as a routine pre-build
   precaution, then reported as an incremental migration apply** — during
   the Z-4 unmapped-queue-filter pass (2026-09-28), this command was run
   against the local sandbox D1 without stating its blast radius first —
   it was framed in the moment as ordinary pre-build hygiene. It actually
   destroyed the entire local D1 (including seeded fixtures), not just
   cleared stale state. The first status report of that same pass then
   described the sandbox as "40/41 applied migrations (`0040` pending)" —
   a fact that was true a few steps earlier but had already been
   invalidated by the `rm -rf`. When migration 0040 was applied per the
   operator's next-pass instruction, it silently became a from-scratch
   41/41 apply rather than the described one-migration increment. Caught
   only because the operator cross-checked the reported end state (41/41)
   against what should have been possible from a "40/41" starting point
   and asked what actually happened. No data of record was lost (local
   dev fixtures only, prod untouched), but the same pattern as instances
   1-3 above: a statement ("this is routine," "40/41 pending 0040") was
   accurate when made and silently went stale, and nothing forced a
   recheck before it was repeated in a report. Standing rule from here
   (2026-09-28, operator §2): no destructive filesystem or database
   command against ANY environment, local sandbox included, without
   stating the intent and the expected blast radius in the same pass,
   before running it.

10. **Smoke-check hash algorithm not pinned across passes** — the
   `/static/app.js` content-presence smoke check has been run at least
   twice this project with two different hash algorithms reported: a
   prior pass recorded a 64-hex SHA-256 digest (`840b9fef…`), this pass's
   Z-4 deploy (2026-09-28) recorded a 32-hex MD5 digest (`4abb3c20…`).
   Both checks were internally valid (deployed vs. local source matched
   on each occasion), so no deploy was reopened over this, but the two
   numbers are not comparable to each other — a future pass diffing "the
   hash reported last time" against "the hash reported this time" would
   see two structurally different strings and have no way to tell import
   from a real content change. Standing rule from here (2026-09-28,
   operator §3): the `/static/app.js` (and any equivalent static-asset)
   smoke check standardises on SHA-256 going forward; `sha256sum`, not
   `md5sum`.

11. **A complete, tested, deployed endpoint that is functionally absent
   because nobody can reach it** — `GET /api/reports/inventory-valuation`
   (`src/routes/reports.ts`) was built across four commits (`7d20d47`
   2026-08-24, `939b7a1` accounting-review amendments, `fd200b9`
   valuation-inclusion partition, `b3d9401` 2026-09-09), mounted at
   `src/index.tsx:57`, and covered by a dedicated 4-case test file
   (`test/inventoryValuationReport.spec.ts`) — every box a "was this
   built and tested" check would tick. It was still, until this pass,
   invisible to any actual user: zero references to `inventory-valuation`
   or `/api/reports` anywhere in `public/static/app.js` (confirmed via
   grep — no nav entry, no fetch call, nothing), and no README/openapi
   entry (`fd200b9`'s own commit message records this explicitly: "No
   README.md/openapi.yaml entry exists for this endpoint and none is
   added here"). `README.md:523` is the direct evidence someone went
   looking for it and failed: a deploy-checklist note says "the pending
   inventory-valuation 'status list' refinement could not be located,"
   written by a pass that didn't know the endpoint already existed. The
   operator's own board audit (2026-09-28 §1) concluded "there is no
   valuation report... anywhere" — true of the board, false of the
   codebase, and the gap between those two statements is a new variant
   of the pattern this document exists to name: instances 1-10 are all
   cases of a STATEMENT going stale relative to the SYSTEM; this one is
   a SYSTEM going stale relative to anyone's knowledge that it exists,
   because "built and tested" was silently treated as equivalent to
   "shipped and discoverable" when the two are not the same claim.
   Standing rule from here (2026-09-28, operator §1): before ticketing
   work as new, check `src/index.tsx`'s mounted routes against the
   board — a mount with no frontend caller and no README entry is
   exactly the shape this instance describes, and the operator has
   asked for a one-pass sweep of all mounted routes against the board
   for any other case in this state, ahead of Sprint 3 planning.

12. **A red test tolerated on `main`, treated as a footnote instead of a
   gate breach** — `test/rowCountRegression.spec.ts`'s
   "adds exactly 341/341 devices with zero failures (chunked SELECT
   lookup)" case failed on a full-suite run this pass (2026-09-28) with
   `Error: Test timed out in 30000ms`, and the first pass over that
   finding recorded it as "flagged for operator awareness only, not
   investigated further this pass" — i.e. treated as an aside rather
   than as the gate breach the standing discipline (full suite green
   before any commit lands) actually requires. The operator (§3)
   rejected that treatment outright and ordered a proper investigation
   before any deploy could proceed. Investigation: the failure was a
   TIMEOUT, not a count or chunking-boundary defect — the assertion
   message named `test/rowCountRegression.spec.ts:127:5` (the response
   awaited from `POST /shipments/:id/bulk-serials`), not a mismatched
   `added`/`requested`/DB-cross-check number. Root cause: of the file's
   four sites, Site 1 (`opr.ts`'s bulk-serials) is the only one that
   writes sequentially — one `addDeviceToShipment()` call (its own
   INSERT + `transitionDevice()`) per matched device — so its wall-clock
   scales linearly with N, unlike Sites 2-4's single batched
   read/write. At n=341 under the ORIGINAL run's full-suite PARALLEL
   contention it took 36983ms against a flat 30000ms per-test timeout;
   re-run in isolation immediately after, the identical case (same code,
   same fixture, same assertions) completed in 12589ms, and a full,
   freshly-captured, complete-suite run (38 files, 816 tests: 808 passed,
   8 skipped, 0 failed, exit 0) passed the same case at 12589ms as well.
   This rules OUT a chunking defect directly rather than assuming it away
   — every SELECT/UPDATE chunking assertion at every size in the file,
   including the operator-flagged 217 boundary case designed to expose an
   off-by-one, passed in both the failing run and the clean rerun; only
   the sequential-write site's margin at the largest size was thin enough
   to be pushed over by ordinary contention from other test files'
   workerd instances. This is the "stale fixture" branch of the
   operator's instruction (a timeout margin too tight for one sequential
   site under contention, not a row-count regression) — fixed by raising
   this file's per-test timeout from a flat 30000ms to a named
   `TEST_TIMEOUT_MS = 60000` constant, matching the existing precedent
   for exactly this class of margin issue already set by
   `test/oprExport.spec.ts`/`test/oprImport.spec.ts` (each already at
   60000ms for their own heaviest real-HTTP-round-trip cases). The
   convention-drift instance is not the timeout margin itself — margins
   need occasional widening as suites grow, that is ordinary maintenance
   — it is that a red test on `main` was FIRST characterized as a
   footnote rather than as the gate breach the project's own standing
   rule (full suite green before a commit lands) says it is. Standing
   rule from here (2026-09-28, operator §3): a failing test discovered on
   `main`, however unrelated it looks to the change in hand, gets the
   same "investigate before anything else moves" treatment as a defect
   found in new code — never a footnote, never deferred past the next
   deploy without an explicit operator ruling to defer it.

13. **Ad-hoc per-file test timeouts, discovered by a second gate-check
   flake rather than by design** — immediately after instance 12's fix
   was verified, a second full-suite run (done specifically to confirm
   the gate was "genuinely green" before deploy) came back red on an
   UNRELATED file: `test/auth.spec.ts`'s password-change test timed out
   at vitest's DEFAULT 5000ms — a margin that had never been given a
   named override at all, let alone one visible as a convention. Root
   cause: the test chains six real PBKDF2-SHA256 derivations (100,000
   iterations each — the Cloudflare Workers cap, see
   `src/lib/password.ts`) in strict sequence (a login, change-password's
   own internal verify, two post-change logins, a restore `hashPassword`
   call, and a final restore-login verify), and that chain's combined
   cost was thin enough against the unnamed 5000ms default that ordinary
   full-suite parallel contention pushed it over — the same underlying
   shape as instance 12 (CPU-heavy sequential work vs. a timeout margin
   under contention), but a DIFFERENT file, a DIFFERENT kind of work
   (password hashing, not sequential HTTP writes), and no override to
   even point at as "this file's known margin." Three consecutive
   full-suite runs this pass produced three different results (341/341
   red, then clean, then `auth.spec.ts` red) — see Z-20 (gate
   reliability, Sprint 2) for the standing finding that this makes the
   suite non-deterministic as a gate, not just two isolated slow tests.
   Fixed by extracting a shared, named-by-purpose constants module
   (`test/testTimeouts.ts` — `SEQUENTIAL_BATCH_WRITE_TIMEOUT_MS` for
   instance 12's class, `PASSWORD_HASH_CHAIN_TIMEOUT_MS` for this one)
   rather than a third bare number invented at the call site, so the
   next qualifying test inherits a convention instead of rediscovering
   the problem from scratch — deliberately NOT a change to
   `vitest.config.ts`'s global default (operator §1, 2026-09-28): raising
   the suite-wide timeout would hide a genuine performance regression in
   any of the other ~800 tests, which is a materially worse failure mode
   than an occasional named per-test override. Standing rule from here:
   a test that qualifies for one of these constants gets a one-line
   comment at the call site saying which class it belongs to and why —
   never a bare number, and never routed through the global default.

14. **The mounted-routes sweep (Z-16 §1's original mandate, finally run)
   finds the same shape of gap again, at larger scale than instance 11.**
   Instance 11 found ONE route (`GET /api/reports/inventory-valuation`)
   built, tested, and mounted, but invisible to anyone who didn't already
   know it existed — no frontend caller, no README/openapi entry. The
   operator's own standing instruction after that finding was "a one-pass
   sweep of all mounted routes against the board for any other case in
   this state." Running that sweep now (2026-10-05, cross-checking every
   `app.get/post/patch/delete` across all 13 route files against
   `public/static/app.js` by regex, then against `openapi.yaml`, with
   false positives from dynamic-path template literals — `${kind}`,
   `${d.kind}` — manually re-checked by reading the surrounding UI code
   rather than trusted from a bare grep miss) finds **33 genuinely
   uncalled-from-the-UI endpoints**, not one:
   - **Whole config surface, never given a management screen**: `GET/POST
     /api/webhooks`, `POST /webhooks/:id/toggle`, `DELETE /webhooks/:id`
     — the underlying delivery mechanism (`dispatchDeviceStatusWebhooks`)
     IS wired and fires for real on every device transition (confirmed in
     `devices.ts`/`opr.ts`); it is only the CRUD *configuration* routes
     that have no UI, so an operator can receive webhooks today but can
     only register/edit one via a raw API call. Different shape from
     instance 11: the capability is live, only its admin surface is
     missing.
   - **A large OPR-correspondence/correction/declaration cluster, built
     and tested but never wired into the SPA's OPR panel**: `GET
     /opr/shipments/:id/{scan-out,value-deltas,misdeclaration-acks,
     partial-return-declarations,corrections,replies,follow-up,checklist}`,
     `POST /opr/shipments/:id/{reconcile-value,misdeclaration-ack,
     import-proof,correspondence,replies,checklist,scan-bulk,bulk-serials}`,
     `POST /opr/shipments/:id/lines/:lineId/{correction,correction/review}`.
     Confirmed real (not dead/abandoned code) via direct test-file
     cross-reference: `oprComms.spec.ts`, `oprAutomation.spec.ts`,
     `oprImport.spec.ts`, `bulkSerials.spec.ts`, `rowCountRegression.spec.ts`,
     `ce1154Golden.spec.ts` all exercise one or more of these paths against
     the real app. The SPA's OPR detail panel (`public/static/app.js`
     ~line 2200+) wires `scan`/`lines` (remove)/`finalise`/`restock`/
     `export-proof`/`prealert`/`clearance`/`invoice`/`ce1154` — a genuine,
     working subset — but stops there; every correspondence-tracking,
     value-correction, and bulk-add path above it has no button, no
     panel, nothing in the DOM that could call it.
   - **Smaller single-route gaps, same pattern**: `GET
     /opr/authorisations/:id` + `PATCH /opr/authorisations/:id` (the UI's
     own authorisations dropdown literally reads "No authorisations —
     create one via the API first" — list-only, no detail/edit screen
     exists); `POST /opr/shipments/:id/lines` (add-by-device-id — the
     scan-by-IMEI sibling IS wired, this one isn't); `GET
     /inventory/sku-grade-consistency`; `GET /inventory/grade-audit/:id`
     (though curiously present in `openapi.yaml`); `GET /print/job/:id`
     (ditto, in openapi but not called); `POST
     /devices/:id/{repair/cost-ledger,purchase/cost-ledger}`; `POST
     /bills/:id/repair-control`; `GET /sku-map/{orphans,shared,version}`.
   - **`openapi.yaml` does not independently catch any of these** — it
     documents `webhooks` and two of the smaller gaps
     (`grade-audit/:id`, `print/job/:id`) but is silent on the entire OPR
     cluster and the rest, confirming the spec file is itself stale
     relative to `opr.ts` (41 of its 44 endpoints appear to predate the
     correspondence/correction/value-reconciliation work) rather than a
     usable cross-check for this sweep on its own.
   This is the same category of gap as instance 11 — "built and tested"
   silently treated as equivalent to "shipped and discoverable" — just
   found at the scale the operator's "any OTHER case in this state"
   phrasing anticipated. Standing rule from here: a newly-built OPR (or
   any) endpoint is not done when its test file is green; it is done when
   either a UI control calls it or a conscious "deferred, API-only for
   now" note says why not — the same bar instance 11 set for the
   valuation report, now stated as the general rule rather than
   re-derived per endpoint. No code change is made by this instance —
   logged as a sweep finding for Sprint 3 scoping, per the operator's own
   framing of the original ask as "ahead of Sprint 3 planning," not an
   in-pass fix. Follow-up: the operator's §2 ruling (2026-10-05) ordered a
   read-only triage table over these 33 — route / auth level / spec
   coverage / wire-keep headless-retire verdict — plus an openapi.yaml
   reconciliation folded into the same pass. See
   `docs/plan/z16-triage-33.md` for the table (24 wire, 7 keep headless, 2
   retire-candidate) and for why the openapi reconciliation itself was
   NOT completed in that pass — the spec turned out to have zero `/opr`,
   `/sku-map`, or `/bills` path entries at all (not just the 33-endpoint
   gap), making "bring it back in line with opr.ts" a multi-hour
   from-scratch authoring task rather than a patch, flagged there for
   separate sequencing rather than rushed.

## The through-line

In cases 1-10, a STATEMENT (a comment, a test assertion, a design note,
an out-of-band git ref) described the system accurately at the moment it
was written, and nothing in the system's own mechanics forced that
statement to be re-checked or updated when the underlying reality
changed. The statement did not fail loudly — it kept looking like
documentation, kept passing (in the test cases), and actively misled the
next reader until something else (a full-suite run, a contradicting test
block a few lines below, an explicit operator ruling) surfaced the gap by
accident rather than by design.

Instance 11 is the same family with the direction reversed: nothing
false was ever stated — the code and its own tests were accurate the
whole time — but the SYSTEM went stale relative to everyone's knowledge
that it existed, because nothing forced "built and tested" to also
produce "documented and reachable." A statement drifting from the
system and a system drifting from anyone's awareness of it are the same
underlying failure — an artefact's true state and what people believe
about that state are allowed to silently diverge — just observed from
opposite ends.

Instance 12 is a third variant, one level up from the other eleven: the
drift is not in a statement or in the system, but in the PROCESS meant
to catch drift in either. A red test is the exact mechanism this project
relies on to surface instances 1-11's kind of gap automatically — and
that mechanism was itself, in the first pass over it, downgraded to a
footnote instead of treated as the gate breach the project's own
standing rule says it is. If a failing check can be waved past as an
aside once, the next nine can be waved past the same way, and the whole
apparatus of "full suite green before a commit lands" stops meaning
anything. The fix for instances 1-11 is to look somewhere new (a mount
point, a stale annotation); the fix for instance 12 is procedural
discipline about a signal that was already firing correctly.

Instance 13 sits directly underneath instance 12, found only because
confirming instance 12's fix meant actually running the gate again
rather than trusting the diagnosis alone — and the second run surfaced a
second, unrelated margin that instance 12's own fix did nothing to
touch. Taken together, the two are the same lesson told twice in one
pass: a gate that is sometimes green and sometimes red for reasons that
have nothing to do with the code under test cannot be read as a
statement about that code at all, only as one draw from a distribution.
See Z-20 (gate reliability) for the standing response to that, which is
broader than either individual fix here.

## Two forward rules this note exists to state

**Y-2's six block conditions must assert on machine-readable codes, not
prose.** Given instance 2 above (a literal error-message string silently
drifting out from under a passing test), any future gate with multiple
named block conditions — Y-2's six being the concrete case in view —
should expose a stable `code` (or equivalent enum-like field) for each
condition, and tests/callers should assert on that code, not on the
free-text message. Free text is allowed to read however is clearest to a
human; it must never be the thing a test or a caller matches against,
because free text is exactly the kind of value someone edits for
clarity/wording without realising a test depends on its exact contents.

**Z-6's persisted-override pattern is the one to copy, not
`costEntry.ts`'s console-only one.** Per instance 4 above: when a future
ticket needs a second-layer override-with-reason on an
already-authenticated write, follow `src/routes/devices.ts`'s
`batchLock`/`override_batch_lock`/`override_reason` shape (console.log
for grep-parity, AND persisted into the relevant event-log table's
metadata, AND echoed back in the response body) — not
`src/lib/costEntry.ts`'s `allow_duplicate_purchase_row` shape
(console.log only). `costEntry.ts` is not being retrofitted by this note;
it is left as-is (its own override signal is genuinely lower-stakes: a
duplicate positive cost row, not a customs/Zoho-adjacent commitment), but
no new ticket should copy it as the starting template going forward.
