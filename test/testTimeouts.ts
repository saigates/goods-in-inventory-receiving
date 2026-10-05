// Shared per-test timeout overrides (Z-16 instance 13, 2026-09-28).
//
// Vitest's default per-test timeout (5000ms) is tuned for ordinary
// assertion-style tests. A small number of tests in this suite do
// genuinely CPU- or round-trip-heavy sequential work — real PBKDF2-SHA256
// derivations at 100,000 iterations, or several real HTTP round trips
// writing one device at a time — and sit close enough to that default
// (or to an ad-hoc override) that ordinary full-suite PARALLEL contention
// from other test files' workerd instances can push them over, producing
// a false-red "failure" that has nothing to do with the code under test.
// Two such cases were found and fixed this pass:
//   - test/rowCountRegression.spec.ts's bulk-serials site at n=341
//     (12.6s unloaded, 37s loaded, against a flat 30000ms)
//   - test/auth.spec.ts's password-change test (~5-6 sequential PBKDF2
//     derivations, against the vitest DEFAULT 5000ms, no override at all)
//
// This module is the single place that owns these margins, named by what
// the test actually does rather than by a bare number repeated at each
// call site — the same "one auditable spot, not N near-identical inline
// constants" reasoning as src/lib/d1Chunk.ts's D1_IN_CHUNK_SIZE.
//
// DELIBERATELY NOT a change to vitest.config.ts's global default: raising
// the suite-wide timeout would mask a genuine performance regression in
// any of the other ~800 tests (a test that starts taking 25s instead of
// 2s should show up as a timeout, not silently pass under a looser
// global bound) — see docs/plan/z16-convention-drift.md instance 13 and
// Z-20 (gate reliability) for the operator's standing ruling on this.
//
// Adding a THIRD qualifying test: do not invent a new ad-hoc number next
// to it. Either reuse one of these constants if the shape matches, or add
// a new named constant HERE with a one-line comment saying what kind of
// work justifies it, then import it at the call site.

// Sequential per-device HTTP-round-trip-style write loops (one
// addDeviceToShipment()/addDeviceToReturnShipment() call per item, each
// its own INSERT + transitionDevice()) at real production batch sizes up
// to ~341. Matches the existing precedent in test/oprExport.spec.ts and
// test/oprImport.spec.ts, which already use 60000ms for their own
// heaviest real-HTTP-round-trip cases.
export const SEQUENTIAL_BATCH_WRITE_TIMEOUT_MS = 60000

// Several real PBKDF2-SHA256 derivations (100,000 iterations each, the
// Cloudflare Workers cap — see src/lib/password.ts) in a single test.
// Each derivation alone is cheap; a test chaining multiple logins/
// password changes (verify old hash, derive new hash, verify new hash,
// restore old hash) multiplies that cost and can exceed vitest's default
// 5000ms under contention even though no single derivation is slow.
export const PASSWORD_HASH_CHAIN_TIMEOUT_MS = 15000
