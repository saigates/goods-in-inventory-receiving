// Z-9 — return-consignment re-identify/re-grade. Pure logic (no DB access)
// for: generation-boundary parsing, catalog-value-difference comparison,
// and the requires_review decision. Callers (src/routes/opr.ts) fetch rows
// and pass them in, same "pure engine, DB-touching route layer" split as
// oprValidation.ts / oprImport.ts.
//
// ───────── What this module deliberately does NOT do ─────────
// - Never reads or writes shipment_lines.unit_value/currency — the
//   declared customs value stays pinned to the frozen export line always
//   (operator-endorsed structural guarantee, migration 0039 header).
// - Never regrades received_devices directly — that write-through only
//   happens at RESTOCK time (operator amendment 5), via the route layer
//   reusing the existing /inventory/grade code path, not this module.

export type FrozenLineSpec = {
  imei: string
  sku: string | null
  brand: string | null
  model: string | null
  capacity: string | null
  color: string | null
  grade: string | null
}

export type CorrectedLineSpec = {
  imei: string
  sku: string | null
  brand: string | null
  model: string | null
  capacity: string | null
  color: string | null
  grade: string
}

// ───────── Generation parsing (operator amendment 3) ─────────
//
// Keyed on a NUMERIC generation extracted from the model string, not exact
// -string matching — the catalogue already contains "iPhone 14 Plus",
// "iPhone 15 Pro Max" and the pre-existing I14P-/I15P- SKU-prefix
// ambiguity (migration 0007's own comment), plus whatever Y-6's eSIM
// variants add. A single regex against the numeric generation captures
// "iPhone 13"/"iPhone 13 Pro Max"/"iPhone 13 Mini" as generation 13
// regardless of the suffix, and correctly reports iPhone SE/Air (no
// numeric generation at all) as unparseable rather than guessing.
//
// Samsung Galaxy S-series and Z-series share the same shape (a numeric
// generation immediately after "Galaxy S"/"Galaxy Z Flip"/"Galaxy Z
// Fold") and are handled by the same generic pattern — no brand-specific
// branching needed.
//
// Returns null (unparseable) rather than throwing or guessing — the
// caller (computeReturnLineReview) treats null as
// generation_unparseable = true, which itself sets requires_review = 1
// (fail loud, per operator instruction, never silently pass through).
export function parseModelGeneration(model: string | null | undefined): number | null {
  if (!model) return null
  const s = String(model).trim()
  if (!s) return null
  // "iPhone 13", "iPhone 13 Pro Max", "iPhone 13 Mini", "Galaxy S23",
  // "Galaxy S23 Ultra", "Galaxy Z Fold5", "Galaxy Z Flip6" — the first
  // integer token anywhere in the string, after any brand/family words.
  // Deliberately the FIRST number found, not the last, so "iPhone 16e"
  // still parses as 16 while a hypothetical capacity-in-model-string edge
  // case doesn't get picked up instead (models never carry capacity here
  // — capacity is its own column — but this keeps the regex intent explicit).
  const m = s.match(/(\d+)/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

export type GenerationComparison = {
  frozen_generation: number | null
  corrected_generation: number | null
  generation_unparseable: boolean
  is_generation_boundary: boolean
}

export function compareGenerations(
  frozenModel: string | null | undefined,
  correctedModel: string | null | undefined,
): GenerationComparison {
  const frozenGen = parseModelGeneration(frozenModel)
  const correctedGen = parseModelGeneration(correctedModel)
  const unparseable = frozenGen === null || correctedGen === null
  return {
    frozen_generation: frozenGen,
    corrected_generation: correctedGen,
    generation_unparseable: unparseable,
    // A boundary requires BOTH sides to have parsed AND differ — an
    // unparseable side is its own separate review trigger (see above),
    // never conflated with "boundary crossed" (that would imply we know
    // the two generations differ, which we don't if one didn't parse).
    is_generation_boundary: !unparseable && frozenGen !== correctedGen,
  }
}

// ───────── Catalog-value-difference (operator amendment 2) ─────────
//
// Compares the CORRECTED spec's current catalog value against the
// FROZEN spec's current catalog value — both read from the catalog NOW,
// never against shipment_lines.unit_value (the frozen customs figure).
// This isolates an identity-correctness signal from ordinary market
// drift: Batch 3 exported 2 Sep, returns late Sep — handset prices move
// several percent a month, so unit_value (frozen weeks earlier) vs
// today's catalog price would fire on drift alone. Reading both sides
// from today's catalog cancels that drift out; what's left is the
// identity change itself.
//
// catalogValueLookup is injected (not a DB call in this pure module) —
// the route layer resolves it via the existing sku_catalog average
// buy_price for the (model, capacity, color, grade) tuple (mirrors how
// resolveCatalogSku already keys catalogue lookups) and passes the two
// numbers in.
export type CatalogValueComparison = {
  frozen_catalog_value_gbp: number | null
  corrected_catalog_value_gbp: number | null
  catalog_value_diff_pct: number | null   // fraction, e.g. 0.23 = 23%
  exceeds_threshold: boolean
}

export const CATALOG_VALUE_REVIEW_THRESHOLD_PCT = 0.20

export function compareCatalogValues(
  frozenCatalogValueGbp: number | null,
  correctedCatalogValueGbp: number | null,
  thresholdPct: number = CATALOG_VALUE_REVIEW_THRESHOLD_PCT,
): CatalogValueComparison {
  if (frozenCatalogValueGbp == null || correctedCatalogValueGbp == null || frozenCatalogValueGbp === 0) {
    return {
      frozen_catalog_value_gbp: frozenCatalogValueGbp,
      corrected_catalog_value_gbp: correctedCatalogValueGbp,
      catalog_value_diff_pct: null,
      exceeds_threshold: false,
    }
  }
  const diffPct = (correctedCatalogValueGbp - frozenCatalogValueGbp) / frozenCatalogValueGbp
  return {
    frozen_catalog_value_gbp: frozenCatalogValueGbp,
    corrected_catalog_value_gbp: correctedCatalogValueGbp,
    catalog_value_diff_pct: diffPct,
    exceeds_threshold: Math.abs(diffPct) > thresholdPct,
  }
}

// ───────── Full review decision (combines all triggers) ─────────

export type ReturnLineReviewInput = {
  frozen: FrozenLineSpec
  corrected: CorrectedLineSpec
  frozenCatalogValueGbp: number | null
  correctedCatalogValueGbp: number | null
}

export type ReturnLineReviewResult = {
  is_generation_boundary: boolean
  frozen_generation: number | null
  corrected_generation: number | null
  generation_unparseable: boolean
  frozen_catalog_value_gbp: number | null
  corrected_catalog_value_gbp: number | null
  catalog_value_diff_pct: number | null
  imei_changed: boolean
  requires_review: boolean
  // Machine-readable trigger list — every reason requires_review is true,
  // not just the first one found, so the review UI/audit trail can show
  // "generation_boundary + catalog_value_diff" rather than only one.
  review_reasons: string[]
}

export function computeReturnLineReview(input: ReturnLineReviewInput): ReturnLineReviewResult {
  const genCmp = compareGenerations(input.frozen.model, input.corrected.model)
  const valCmp = compareCatalogValues(input.frozenCatalogValueGbp, input.correctedCatalogValueGbp)
  const imeiChanged = input.corrected.imei !== input.frozen.imei

  const reasons: string[] = []
  if (imeiChanged) reasons.push('imei_change')
  if (genCmp.generation_unparseable) reasons.push('generation_unparseable')
  if (genCmp.is_generation_boundary) reasons.push('generation_boundary')
  if (valCmp.exceeds_threshold) reasons.push('catalog_value_diff')

  return {
    is_generation_boundary: genCmp.is_generation_boundary,
    frozen_generation: genCmp.frozen_generation,
    corrected_generation: genCmp.corrected_generation,
    generation_unparseable: genCmp.generation_unparseable,
    frozen_catalog_value_gbp: valCmp.frozen_catalog_value_gbp,
    corrected_catalog_value_gbp: valCmp.corrected_catalog_value_gbp,
    catalog_value_diff_pct: valCmp.catalog_value_diff_pct,
    imei_changed: imeiChanged,
    // ANY trigger present -> requires_review. IMEI and generation-boundary/
    // -unparseable ALWAYS hard-block finalise (operator amendment 4);
    // catalog_value_diff alone is still amber-eligible display but is
    // folded into the same requires_review flag per the operator's
    // "reuse the misdeclaration-ack pattern" instruction — severity
    // (block vs display) is decided by the CALLER inspecting
    // review_reasons, not by a second boolean here.
    requires_review: reasons.length > 0,
    review_reasons: reasons,
  }
}

// ───────── Snapshot merge (operator amendment 1) ─────────
//
// Builds the new correction row's full seven-field snapshot from: the
// frozen export line (baseline), the LATEST existing correction row for
// this shipment_line_id (if any — carries forward anything not touched by
// THIS correction), and this correction's actual partial changes. Latest-
// row-wins is unambiguous downstream ONLY because every row this function
// produces is a complete snapshot — see migration 0039's header comment.
export type PartialCorrectionInput = Partial<{
  imei: string
  sku: string | null
  brand: string | null
  model: string | null
  capacity: string | null
  color: string | null
  grade: string
}>

export function mergeCorrectionSnapshot(
  frozen: FrozenLineSpec,
  previousCorrection: CorrectedLineSpec | null,
  partial: PartialCorrectionInput,
): CorrectedLineSpec {
  // Baseline is the previous correction's snapshot if one exists,
  // otherwise the frozen export line itself (the implicit "correction of
  // nothing" state before any correction has ever been recorded).
  const baseline: CorrectedLineSpec = previousCorrection ?? {
    imei: frozen.imei,
    sku: frozen.sku,
    brand: frozen.brand,
    model: frozen.model,
    capacity: frozen.capacity,
    color: frozen.color,
    grade: frozen.grade ?? 'UG',
  }
  return {
    imei: partial.imei !== undefined ? partial.imei : baseline.imei,
    sku: partial.sku !== undefined ? partial.sku : baseline.sku,
    brand: partial.brand !== undefined ? partial.brand : baseline.brand,
    model: partial.model !== undefined ? partial.model : baseline.model,
    capacity: partial.capacity !== undefined ? partial.capacity : baseline.capacity,
    color: partial.color !== undefined ? partial.color : baseline.color,
    grade: partial.grade !== undefined ? partial.grade : baseline.grade,
  }
}
