// D1 bound-parameter chunking (Z-1, 2026-09-24).
//
// D1 (the underlying Cloudflare/SQLite HTTP binding) rejects a prepared
// statement with more than 100 bound parameters — SQLITE_ERROR: "too many
// SQL variables". Any query built as `WHERE col IN (${ids.map(() => '?')})`
// silently assumes the caller's list fits under that cap. It doesn't: real
// production batches run 155, 162, 181, 217, 341 devices — all comfortably
// over 100 — so every one of those call sites was a live landmine, not a
// theoretical one.
//
// This module is the single place that owns the chunk size and the
// never-silently-truncate row-count check, so the fix (and its test
// coverage) lives in one auditable spot rather than four near-identical
// inline loops that could drift apart. It deliberately does NOT try to
// own the actual SQL/bind construction at each call site: the four
// locations that use it (opr.ts, inventory.ts, manifests.ts, devices.ts)
// each bind their fixed extra params (org_id, a SET value, a status
// literal) in a DIFFERENT position relative to the IN-list.
//
// KNOWN WART, left deliberately unfixed: this bind-order inconsistency
// predates this module and is NOT normalised by it. Forcing one bind
// order would mean rewriting working statements at every call site for a
// cosmetic reason, inside a ticket that's already load-bearing (Z-1 is
// the gate every Sprint-1/2 ticket sits behind) — not worth the risk.
// Each call site builds its own SQL/bind list per chunk; this module only
// decides HOW MANY chunks and CHECKS the combined count. Do not assume a
// consistent bind position across call sites when adding a fifth one —
// check each site's own WHERE clause.
//
// NEVER SILENTLY TRUNCATE (the OTHER standing rule this ticket exists to
// serve — the 210-vs-217 and 52-vs-155 incidents). chunkArray splits
// EVERY item into SOME chunk — nothing is capped or dropped here. Callers
// must run every chunk this returns and verify the combined result against
// what was expected — see runChunked below, which enforces that for the
// common "N items in, N rows/changes out" shape, and throws loudly
// (ChunkCountMismatchError) rather than returning a partial result as if
// it were complete.

export const BULK_SERIAL_CAP = 500
export const D1_IN_CHUNK_SIZE = 90

/**
 * Split `items` into chunks of at most `size` — the last chunk may be
 * shorter. Never drops or reorders items: concatenating every returned
 * chunk in order always reproduces `items` exactly.
 */
export function chunkArray<T>(items: readonly T[], size: number = D1_IN_CHUNK_SIZE): T[][] {
  if (size <= 0) throw new Error(`chunkArray size must be positive, got ${size}`)
  if (items.length === 0) return []
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

/**
 * Thrown when a chunked multi-statement operation returns fewer rows/
 * changes than the input items promised — the "never silently truncate"
 * rule made concrete as a typed, catchable error rather than a returned
 * boolean a caller could ignore. Carries expected vs actual so a route
 * handler can build a loud 5xx response with counts, per the standing
 * rule, without re-deriving the numbers itself.
 */
export class ChunkCountMismatchError extends Error {
  readonly expected: number
  readonly actual: number

  constructor(expected: number, actual: number, context?: string) {
    super(
      `Expected ${expected} row(s)/change(s) across all chunks, got ${actual}` +
      (context ? ` (${context})` : '') +
      ' — refusing to report a partial result as complete.'
    )
    this.name = 'ChunkCountMismatchError'
    this.expected = expected
    this.actual = actual
  }
}

/**
 * Run `execChunk` once per chunk of `items` (each call receives that
 * chunk's own items plus a ready-made `?`-placeholder string of the same
 * length, e.g. "?,?,?" for a 3-item chunk) and sum the numeric result of
 * every call. If the summed total is less than `expectedTotal`, throws
 * ChunkCountMismatchError instead of returning — this is the shared
 * enforcement point for "never silently truncate": a caller cannot
 * accidentally ignore a short chunk because the mismatch throws before
 * any partial count reaches the HTTP response.
 *
 * `execChunk` returns whatever number is meaningful for the operation —
 * `results.length` for a SELECT, `meta.changes` for an UPDATE — the
 * caller decides which, since (as the module comment explains) an
 * UPDATE's WHERE may also filter on state, making "matched" and
 * "changed" different counts the caller must reconcile itself before
 * calling this.
 */
export async function runChunked(
  items: readonly (string | number)[],
  expectedTotal: number,
  execChunk: (chunkItems: readonly (string | number)[], placeholders: string) => Promise<number>,
  opts: { chunkSize?: number; context?: string } = {},
): Promise<number> {
  const chunkSize = opts.chunkSize ?? D1_IN_CHUNK_SIZE
  const chunks = chunkArray(items, chunkSize)
  let total = 0
  for (const chunk of chunks) {
    const placeholders = chunk.map(() => '?').join(',')
    total += await execChunk(chunk, placeholders)
  }
  if (total < expectedTotal) {
    throw new ChunkCountMismatchError(expectedTotal, total, opts.context)
  }
  return total
}
