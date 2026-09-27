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

## The five instances on record

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

## The through-line

In all five cases, a STATEMENT (a comment, a test assertion, a design
note, an out-of-band git ref) described the system accurately at the
moment it was written, and nothing in the system's own mechanics forced
that statement to be re-checked or updated when the underlying reality
changed. The statement did not fail loudly — it kept looking like
documentation, kept passing (in the test cases), and actively misled the
next reader until something else (a full-suite run, a contradicting test
block a few lines below, an explicit operator ruling) surfaced the gap by
accident rather than by design.

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
