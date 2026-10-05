# Z-20 — Gate Reliability: Scope + Sizing

Status: **SCOPING ONLY. No code change exists yet beyond the two
timeout fixes already landed under Z-16 instances 12/13 (see below).**
This document is the work-tracker entry required before further
implementation begins, per the standing protocol (same convention as
`docs/plan/z15-return-completeness-gate.md`). Written per operator
instruction (2026-09-28, §3), Sprint 2.

## Problem statement

Three consecutive full-suite runs in one pass (2026-09-28) produced
three different results:

1. A from-scratch run: `test/rowCountRegression.spec.ts`'s 341/341
   bulk-serials case red — `Error: Test timed out in 30000ms`.
2. A from-scratch run immediately after, with no code change in
   between: all 38 files green, 808 passed / 8 skipped / 0 failed.
3. A from-scratch run immediately after the instance-12 fix was
   verified: `test/auth.spec.ts`'s password-change test red —
   `Error: Test timed out in 5000ms` (the vitest default, no override).

Both reds were diagnosed (Z-16 instances 12 and 13,
`docs/plan/z16-convention-drift.md`) as timeout-margin issues under
full-suite parallel contention, not defects in the code under test —
chunking correctness and password-hashing correctness were both intact
in every run, failing or clean. Both have been fixed with named,
purpose-specific constants in `test/testTimeouts.ts`.

That is not the finding this document exists to record. The finding is
that the gate itself — "run `npm test`, all green means ship" — produced
three different verdicts for the identical unmodified code within one
pass, before either fix landed. A gate that does this is not a
reliable yes/no statement about the code; it is one sample drawn from
some distribution of possible outcomes, and treating any single green
run as "the suite passes" has been, on this evidence, an overstatement
every time it has been reported this session. This is a more serious
problem than any individual slow test, because it means every clean
full-suite result accepted so far — including the ones that gated prior
deploys — carries an unknown, uncharacterized false-negative rate.

## Scope (this ticket)

1. **Inventory every test whose runtime sits within a small margin of
   its timeout** — across all 38 files (`npm test`) and the separately-run
   `test/oprImport.spec.ts` (`npm run test:serial`). "Small margin" means:
   runtime (observed across several runs, not one) within roughly 50% of
   its effective timeout (file-level default, suite default, or a named
   override). This requires multiple timed runs per file, both isolated
   and under full-suite contention, not a single pass — a test that is
   comfortable alone and tight under contention is exactly the shape
   instances 12 and 13 were.
2. **Report the margins** — a table: test name, effective timeout,
   observed runtime isolated, observed runtime under full-suite
   contention (best/worst of at least 3 runs each), and which of the two
   named `test/testTimeouts.ts` classes (if any) it resembles.
3. **Decide per-test, after the report, not before**: for each flagged
   test, either (a) raise its bound via a named `test/testTimeouts.ts`
   constant (reusing an existing one if the shape matches, adding a new
   one with its own one-line justification otherwise — per Z-16 instance
   13's standing rule, never a bare number and never the global default),
   or (b) make the test itself faster (batch a loop that is currently
   sequential, reduce an inflated fixture size, etc.) if the slowness is
   itself worth fixing rather than just accommodating. Sizing which
   tests get which treatment happens after the report exists, not as
   part of producing it.
4. **A repeatability check**, not just a margin table: run the full
   suite back-to-back at least 3 times after whatever fixes land from
   (3), and confirm all 3 are clean. One green run is no longer
   sufficient evidence that the gate is reliable — that is the direct
   lesson of this ticket's own problem statement.

## Production signal folded in (operator §4, 2026-09-28)

Z-16 instance 12's diagnosis measured `opr.ts`'s bulk-serials endpoint
(`addDeviceToShipment()` called once per device, sequentially) at
**12.6 seconds unloaded for 341 devices** — and 341 is not an arbitrary
test size; it is Export 2's real unit count. That is not only a test-gate
finding. It means the real operator action of bulk-adding that
consignment, run against production D1 from inside a Cloudflare Worker
with its own CPU-time limits (10ms free / 30ms paid per request — see
this project's own standing Cloudflare-limits note), may be taking
comparable real wall-clock time against production, with an unknown
margin against the Worker's own CPU budget (wall-clock and CPU-time are
not the same measure — most of that 12.6s is very likely D1 network
round-trip latency, not CPU, but that distinction itself has not been
measured and should not be assumed).

**Action required under this ticket, not deferred to Z-20's main test-
margin work**: measure the real production (or production-equivalent)
latency of `POST /shipments/:id/bulk-serials` at a batch size near 341,
and check it against the Worker's actual CPU-time budget, not just wall-
clock. If it is genuinely near a Worker limit, that is its own ticket
(a batching/parallelisation fix to `addDeviceToShipment`'s call site in
`opr.ts`, analogous to the bulk read-path chunking Z-1 already did for
the SELECT side of this same endpoint) — opened separately, scoped on
its own, not folded into this gate-reliability ticket's fix. The
operator's own framing: better to find this now than mid-scan.

## Explicitly not in scope for this ticket

- Any change to `vitest.config.ts`'s global default timeout (ruled out,
  operator §1 — see Z-16 instance 13).
- Fixing `opr.ts`'s bulk-serials sequential-write pattern itself, if the
  production-signal check above finds it IS near a Worker limit — that
  becomes its own ticket, not absorbed into Z-20.
- Any test file not currently green — Z-20 is about margin and
  repeatability of an already-passing suite, not about fixing failing
  tests (none exist on `main` as of this writing, both known flakes
  fixed under Z-16 instances 12/13).
