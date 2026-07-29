// Catalog SKU resolution. The catalog is the source of truth: at scan time
// we look up by (model, capacity, color, grade) and return the catalog's
// SKU verbatim. No SKU invention.

import type { Grade } from './grade'

export type CatalogRow = {
  id: number
  sku: string
  brand: string
  model: string
  capacity: string | null
  color: string | null
  grade: string | null
}

// "128", "128G", "128 GB", "128GB" → "128GB"; anything else returned trimmed-upper.
// Returns null for null / empty.
export function normalizeCapacity(raw: unknown): string | null {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  const m = s.match(/^(\d+)\s*(?:GB|G)?$/i)
  if (m) return `${m[1]}GB`
  // Fallback: just uppercase + collapse whitespace
  return s.toUpperCase().replace(/\s+/g, ' ')
}

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toUpperCase().replace(/\s+/g, ' ')
}

// Lookup result. `match` is set when we have exactly one catalog SKU for the
// inputs. `candidates` is populated when nothing exact matched — these are
// the rows the operator should pick from (same model + grade, any
// capacity/color), so the modal can render alternatives.
export type CatalogLookup =
  | { status: 'match'; row: CatalogRow }
  | { status: 'no_match'; candidates: CatalogRow[]; reason: string }
  | { status: 'ambiguous'; candidates: CatalogRow[]; reason: string }

/**
 * Pure, in-memory version of the matching rules — takes an already-fetched
 * set of catalog rows (scoped to the caller's organisation) and resolves a
 * single (model, capacity, color, grade) tuple against them, with no DB I/O.
 *
 * Matching rules (in order):
 *  1. Strict, case-insensitive equality on model + capacity + color + grade
 *  2. If that finds nothing AND a single substring color match exists
 *     (e.g. "PURPLE" → "DEEP PURPLE" when no other contains "PURPLE"),
 *     accept that
 *  3. Otherwise return no_match with candidates the operator can pick from
 *
 * Extracted (2026-07-29) so a bulk caller (manifest upload) can fetch the
 * organisation's whole catalog ONCE and match every row against it in
 * memory, instead of 1-3 sequential D1 round-trips per row. See
 * `resolveCatalogSkuBulk` below for why that matters: against local
 * (in-process) SQLite the per-row round-trips are free, but against real
 * remote D1 each one is a network hop, and a several-hundred-row manifest
 * upload turned into several-hundred SEQUENTIAL network round-trips in a
 * single Worker invocation — slow enough to trip a client-side timeout /
 * disconnect before the (unrelated, later) `expected_devices` batch insert
 * ever ran, silently leaving a manifest header with zero device rows.
 */
export function matchCatalogRows(
  catalog: CatalogRow[],
  input: {
    model: string | null | undefined
    capacity: string | null | undefined
    color: string | null | undefined
    grade: Grade
  },
): CatalogLookup {
  const model = norm(input.model)
  const capacityCanon = normalizeCapacity(input.capacity)
  const color = norm(input.color)
  const grade = input.grade

  if (!model) {
    return { status: 'no_match', candidates: [], reason: 'No model on the manifest line.' }
  }

  // Step 1: strict, case-insensitive equality on all four
  const exact = catalog.filter((r) =>
    norm(r.model) === model &&
    norm(r.capacity) === (capacityCanon ?? '') &&
    norm(r.color) === color &&
    r.grade === grade,
  )

  if (exact.length === 1) {
    return { status: 'match', row: exact[0] }
  }
  if (exact.length > 1) {
    return {
      status: 'ambiguous',
      candidates: exact.slice(0, 5),
      reason: 'Multiple catalog SKUs match this combination — pick one.',
    }
  }

  // Step 2: fuzzy color (substring), still strict on model + capacity + grade
  const sameShape = catalog.filter((r) =>
    norm(r.model) === model &&
    norm(r.capacity) === (capacityCanon ?? '') &&
    r.grade === grade,
  )

  if (color) {
    const fuzzy = sameShape.filter((r) => {
      const rc = norm(r.color)
      return rc && (rc.includes(color) || color.includes(rc))
    })
    if (fuzzy.length === 1) {
      return { status: 'match', row: fuzzy[0] }
    }
    if (fuzzy.length > 1) {
      return {
        status: 'ambiguous',
        candidates: fuzzy,
        reason: `Multiple colors match "${input.color}" — pick one.`,
      }
    }
  }

  // Step 3: nothing matched. Return same-model+grade rows as candidates so
  // the operator can see what *is* in the catalog for this model/grade.
  // Fall back to same-model (any grade) if even that's empty.
  let candidates = sameShape.slice(0, 50)
  if (candidates.length === 0) {
    candidates = catalog
      .filter((r) => norm(r.model) === model)
      .sort((a, b) =>
        norm(a.capacity).localeCompare(norm(b.capacity)) ||
        norm(a.color).localeCompare(norm(b.color)) ||
        (a.grade ?? '').localeCompare(b.grade ?? ''),
      )
      .slice(0, 50)
  }

  return {
    status: 'no_match',
    candidates,
    reason: candidates.length
      ? `No catalog SKU for ${input.model} · ${capacityCanon ?? '?'} · ${input.color ?? '?'} · grade ${grade}. Closest matches below.`
      : `No catalog SKUs exist for model ${input.model}. Add it to the catalogue first.`,
  }
}

/**
 * Resolve a (model, capacity, color, grade) tuple to a single catalog row —
 * single-lookup path, used by one-off callers (a single IMEI scan, the
 * "add to catalogue" / "re-resolve on field edit" UI actions) where doing
 * 1-3 targeted DB queries per call is the right tradeoff (small, indexed,
 * infrequent). For bulk resolution of many rows in one request, use
 * `resolveCatalogSkuBulk` instead — see its comment for why.
 */
export async function resolveCatalogSku(
  db: D1Database,
  input: {
    model: string | null | undefined
    capacity: string | null | undefined
    color: string | null | undefined
    grade: Grade
  },
  organisationId: number,
): Promise<CatalogLookup> {
  const model = norm(input.model)
  const capacityCanon = normalizeCapacity(input.capacity)
  const color = norm(input.color)
  const grade = input.grade

  if (!model) {
    return { status: 'no_match', candidates: [], reason: 'No model on the manifest line.' }
  }

  // Step 1: strict, case-insensitive equality on all four
  const exact = await db
    .prepare(
      `SELECT id, sku, brand, model, capacity, color, grade
         FROM sku_catalog
        WHERE organisation_id = ?
          AND UPPER(model) = ?
          AND UPPER(COALESCE(capacity, '')) = ?
          AND UPPER(COALESCE(color, ''))    = ?
          AND grade = ?
        LIMIT 5`,
    )
    .bind(organisationId, model, capacityCanon ?? '', color, grade)
    .all<CatalogRow>()

  if (exact.results.length === 1) {
    return { status: 'match', row: exact.results[0] }
  }
  if (exact.results.length > 1) {
    return {
      status: 'ambiguous',
      candidates: exact.results,
      reason: 'Multiple catalog SKUs match this combination — pick one.',
    }
  }

  // Step 2: fuzzy color (substring), still strict on model + capacity + grade
  const sameShape = await db
    .prepare(
      `SELECT id, sku, brand, model, capacity, color, grade
         FROM sku_catalog
        WHERE organisation_id = ?
          AND UPPER(model) = ?
          AND UPPER(COALESCE(capacity, '')) = ?
          AND grade = ?
        LIMIT 50`,
    )
    .bind(organisationId, model, capacityCanon ?? '', grade)
    .all<CatalogRow>()

  if (color) {
    const fuzzy = sameShape.results.filter((r) => {
      const rc = norm(r.color)
      return rc && (rc.includes(color) || color.includes(rc))
    })
    if (fuzzy.length === 1) {
      return { status: 'match', row: fuzzy[0] }
    }
    if (fuzzy.length > 1) {
      return {
        status: 'ambiguous',
        candidates: fuzzy,
        reason: `Multiple colors match "${input.color}" — pick one.`,
      }
    }
  }

  // Step 3: nothing matched. Return same-model+grade rows as candidates so
  // the operator can see what *is* in the catalog for this model/grade.
  // Fall back to same-model (any grade) if even that's empty.
  let candidates = sameShape.results
  if (candidates.length === 0) {
    const sameModel = await db
      .prepare(
        `SELECT id, sku, brand, model, capacity, color, grade
           FROM sku_catalog
          WHERE organisation_id = ? AND UPPER(model) = ?
          ORDER BY capacity, color, grade
          LIMIT 50`,
      )
      .bind(organisationId, model)
      .all<CatalogRow>()
    candidates = sameModel.results
  }

  return {
    status: 'no_match',
    candidates,
    reason: candidates.length
      ? `No catalog SKU for ${input.model} · ${capacityCanon ?? '?'} · ${input.color ?? '?'} · grade ${grade}. Closest matches below.`
      : `No catalog SKUs exist for model ${input.model}. Add it to the catalogue first.`,
  }
}

// Bulk resolution for the manifest-upload path: loads the organisation's
// ENTIRE catalog with ONE query, then matches every input row against it
// in memory via `matchCatalogRows`. This is what fixed the production bug
// above — O(1) DB round-trips instead of O(rows). Safe at the catalogue's
// current size (~2,800 rows fits comfortably in Worker memory); if the
// per-organisation catalog ever grows into the tens of thousands, revisit
// with a narrower per-model prefetch instead of the whole table.
export async function resolveCatalogSkuBulk(
  db: D1Database,
  rows: Array<{
    model: string | null | undefined
    capacity: string | null | undefined
    color: string | null | undefined
    grade: Grade
  }>,
  organisationId: number,
): Promise<CatalogLookup[]> {
  const { results } = await db
    .prepare(
      `SELECT id, sku, brand, model, capacity, color, grade
         FROM sku_catalog
        WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .all<CatalogRow>()
  return rows.map((r) => matchCatalogRows(results, r))
}
