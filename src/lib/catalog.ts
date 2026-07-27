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
 * Resolve a (model, capacity, color, grade) tuple to a single catalog row.
 *
 * Matching rules (in order):
 *  1. Strict, case-insensitive equality on model + capacity + color + grade
 *  2. If that finds nothing AND a single substring color match exists
 *     (e.g. "PURPLE" → "DEEP PURPLE" when no other contains "PURPLE"),
 *     accept that
 *  3. Otherwise return no_match with candidates the operator can pick from
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

// Used by the manifest upload code path: bulk-resolve every expected row
// to a catalog SKU at import time, returning the row's resolved sku or null.
// This is best-effort — unmatched rows get a null SKU which the scan
// confirmation will then prompt the operator to fix.
export async function bulkResolveCatalog(
  db: D1Database,
  rows: Array<{
    model: string | null | undefined
    capacity: string | null | undefined
    color: string | null | undefined
    grade: Grade
  }>,
  organisationId: number,
): Promise<Array<string | null>> {
  const out: Array<string | null> = []
  for (const r of rows) {
    const res = await resolveCatalogSku(db, r, organisationId)
    out.push(res.status === 'match' ? res.row.sku : null)
  }
  return out
}
