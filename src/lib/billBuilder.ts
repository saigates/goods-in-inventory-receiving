// Sprint B §1 — ONE bill builder for two bill types (purchase, repair).
//
// Everything here is PURE (no DB access): callers fetch/pass in whatever
// context is needed (existing IMEIs for cross-bill duplicate detection,
// the org's current organisation_id, etc.) — same convention as
// oprImport.ts/oprValidation.ts, which keeps every rule unit-testable
// without HTTP or D1.
//
// ───────── Why one builder, not two ─────────
// A Syncere repair invoice and an LW001 purchase invoice have the same
// shape: vendor, date, invoice number, currency, total, per-IMEI lines.
// `bill_type` ('purchase' | 'repair') selects only which downstream
// cost_ledger.cost_type the resulting lines feed — the parsing/validation/
// pricing/close-rule logic underneath is identical.
//
// ───────── Pricing modes ─────────
// 'header'   — one line, no serials, quantity = header unit_count. Used
//              only when no per-line breakdown exists at all.
// 'per_line' — priced groups; one line may cover >1 serial at one price.
// 'per_imei' — one price per device. MANDATORY support from day one: the
//              162-unit batch proves a header total cannot reconstruct
//              real per-unit variation (the same model/storage varies
//              between £160 and £182).
//
// ───────── Currency conversion (§1) ─────────
// Rate convention (matches computeCe1154()/oprImport.ts): exchange_rate is
// quoted as FOREIGN-CURRENCY UNITS PER £1, so GBP = amount / rate — never
// amount * rate. Convert PER LINE, round each to pence, then the header
// GBP total is the SUM of those already-rounded lines. If converting
// declared_total directly at the header rate differs from that sum, the
// difference is stored as header_residual_gbp — a stated residual, never
// used to nudge any line. Apportioning a converted header total across
// lines is the named historical defect (produced £39,932 against a true
// £39,386) this module exists to avoid repeating.
//
// ───────── Continuation rows — PICK-AND-NOTE ─────────
// The instruction refers to "the Zoho parser['s]" continuation-row spec
// for grouping rows with blank key columns. That specific document could
// not be located in this repository (src/, test/, docs/ all grepped
// clean) nor fully retrieved from hub session history within the read
// budget available this pass. Per the standing "pick-and-note" rule
// (escalate only where a number's meaning on a CUSTOMS document is at
// stake — continuation-row grouping on a purchase/repair bill is not),
// the following concrete rule is adopted and must be revisited if a
// contradicting spec surfaces later:
//
//   A row is treated as a CONTINUATION of the immediately preceding
//   priced row when its key columns (sku AND description AND unit_price)
//   are ALL blank/null but it carries a non-blank imei. Its IMEI is
//   folded into the preceding row's serial list (increasing that line's
//   quantity by one) rather than starting a new line. A continuation row
//   can never be the FIRST row of a file (nothing to attach to) — that
//   case is rejected as an invalid row, not silently dropped.
//
import type { BillType, BillPriceSource, RateSource, CostLedgerProvenance } from '../types'
import { validateImei, isValidCurrency, cleanString } from './validate'

export function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100
}

// ───────── Input shapes ─────────

export type BillImportRow = {
  sku?: string | null
  description?: string | null
  imei?: string | null
  unit_price?: number | string | null   // in bill header currency; blank on a header-only row
  quantity?: number | string | null     // defaults to 1 in per_line/per_imei modes
}

export type BillHeaderInput = {
  bill_type: BillType
  vendor_name: string
  bill_date: string
  invoice_number: string
  currency_code: string
  exchange_rate?: number | null
  rate_date?: string | null
  rate_source?: RateSource | null
  customs_exchange_rate?: number | null
  price_source: BillPriceSource
  declared_total: number
  unit_count: number
}

export type BuiltBillLine = {
  line_no: number
  sku: string | null
  description: string | null
  quantity: number
  unit_price: number | null
  exchange_rate_used: number | null
  unit_price_gbp: number | null
  is_continuation: boolean
  imeis: string[]
}

export type BillRowProblem = { row_index: number; reason: string }

export type BuildBillResult =
  | {
      ok: true
      lines: BuiltBillLine[]
      gbp_total: number
      // declared_total converted to GBP at the header rate (or
      // declared_total itself for a GBP bill) — the header's OWN claimed
      // total, DELIBERATELY a separate figure from gbp_total (the
      // independently-summed line total). This is what the close rule
      // compares gbp_total against; conflating the two would make the
      // close check trivially always pass.
      declared_total_gbp: number
      header_residual_gbp: number | null
      dropped_non_imei_rows: number
      within_bill_duplicate_imeis: string[]   // always empty when ok:true — presence here would have made this false
      cross_bill_duplicate_imeis: string[]    // flagged for manager review; does NOT block the build
      invalid_rows: BillRowProblem[]
    }
  | { ok: false; error: string; within_bill_duplicate_imeis?: string[]; invalid_rows?: BillRowProblem[] }

// ───────── Grouping: continuation rows (blank key columns) ─────────
//
// Groups raw rows into "priced groups" — a leading row with sku/
// description/unit_price, followed by zero or more continuation rows
// (blank sku+description+unit_price, non-blank imei) that share the
// leading row's price. Returns groups in file order; a continuation row
// with no preceding priced row is surfaced as an invalid row.
type RowGroup = { lead: BillImportRow; leadIndex: number; imeis: Array<{ imei: string; rowIndex: number }> }

export function groupContinuationRows(rows: BillImportRow[]): { groups: RowGroup[]; invalid: BillRowProblem[] } {
  const groups: RowGroup[] = []
  const invalid: BillRowProblem[] = []
  let current: RowGroup | null = null

  rows.forEach((row, idx) => {
    const hasKeyCols = !!(cleanString(row.sku) || cleanString(row.description) || row.unit_price != null && row.unit_price !== '')
    const imei = cleanString(row.imei)

    if (hasKeyCols) {
      // Starts a new priced group.
      current = { lead: row, leadIndex: idx, imeis: imei ? [{ imei, rowIndex: idx }] : [] }
      groups.push(current)
      return
    }

    // Blank key columns — a continuation row IF it carries an IMEI and
    // there is a preceding group to attach to.
    if (!imei) {
      invalid.push({ row_index: idx, reason: 'Row has no SKU/description/price and no IMEI — nothing to parse' })
      return
    }
    if (!current) {
      invalid.push({ row_index: idx, reason: 'Continuation row (blank key columns) has no preceding priced row to attach to' })
      return
    }
    current.imeis.push({ imei, rowIndex: idx })
  })

  return { groups, invalid }
}

// ───────── Main builder ─────────
//
// existingImeisInThisOrg: IMEIs already present on ANY OTHER bill in this
// organisation (caller-supplied — a bulk lookup, same discipline as
// resolveCatalogSkuBulk in catalog.ts: one query up front, not N).
export function buildBill(
  header: BillHeaderInput,
  rows: BillImportRow[],
  existingImeisInThisOrg: Set<string> = new Set(),
): BuildBillResult {
  if (!header.vendor_name || !cleanString(header.vendor_name)) {
    return { ok: false, error: 'vendor_name is required' }
  }
  if (!header.invoice_number || !cleanString(header.invoice_number)) {
    return { ok: false, error: 'invoice_number is required' }
  }
  if (!isValidCurrency(header.currency_code)) {
    return { ok: false, error: `currency_code '${header.currency_code}' is not a recognised ISO 4217 code` }
  }
  const currency = header.currency_code.trim().toUpperCase()
  if (currency !== 'GBP' && (header.exchange_rate == null || !(header.exchange_rate > 0))) {
    return { ok: false, error: `exchange_rate is required and must be positive for a ${currency} bill` }
  }
  if (!Number.isFinite(header.declared_total) || header.declared_total < 0) {
    return { ok: false, error: 'declared_total must be a non-negative number' }
  }
  if (!['header', 'per_line', 'per_imei'].includes(header.price_source)) {
    return { ok: false, error: `price_source '${header.price_source}' is not valid` }
  }

  // ── 'header' mode: one line, no serials, nothing to validate per-row ──
  if (header.price_source === 'header') {
    const unitPriceGbp = currency === 'GBP'
      ? round2(header.declared_total)
      : round2(header.declared_total / (header.exchange_rate as number))
    const line: BuiltBillLine = {
      line_no: 1,
      sku: null,
      description: `${header.vendor_name} — header total (no per-line breakdown)`,
      quantity: header.unit_count,
      unit_price: header.declared_total,
      exchange_rate_used: currency === 'GBP' ? null : header.exchange_rate ?? null,
      unit_price_gbp: unitPriceGbp,
      is_continuation: false,
      imeis: [],
    }
    return {
      ok: true,
      lines: [line],
      gbp_total: unitPriceGbp,
      // 'header' mode: the single line IS the converted declared_total,
      // so gbp_total and declared_total_gbp are necessarily identical
      // here (nothing to compare against — there are no independent
      // lines to diverge from the header).
      declared_total_gbp: unitPriceGbp,
      header_residual_gbp: null,
      dropped_non_imei_rows: 0,
      within_bill_duplicate_imeis: [],
      cross_bill_duplicate_imeis: [],
      invalid_rows: [],
    }
  }

  // ── 'per_line' / 'per_imei': every row must carry an IMEI to survive ──
  const nonImeiRows = rows.filter(r => !cleanString(r.imei) && !cleanString(r.sku) && !cleanString(r.description))
  const droppedNonImei = rows.filter(r => cleanString(r.sku) || cleanString(r.description)
    ? !cleanString(r.imei) && !(r.unit_price != null)
    : false).length

  const { groups, invalid: continuationInvalid } = groupContinuationRows(rows)

  const withinBillSeen = new Set<string>()
  const withinBillDuplicates = new Set<string>()
  const crossBillDuplicates = new Set<string>()
  const invalidRows: BillRowProblem[] = [...continuationInvalid]
  let droppedNonImeiCount = 0
  const lines: BuiltBillLine[] = []

  groups.forEach((group, gi) => {
    const priceRaw = group.lead.unit_price
    const price = priceRaw == null || priceRaw === '' ? null : Number(priceRaw)
    const qtyRaw = group.lead.quantity
    const declaredQty = qtyRaw == null || qtyRaw === '' ? null : Number(qtyRaw)

    if (price == null || !Number.isFinite(price)) {
      invalidRows.push({ row_index: group.leadIndex, reason: 'Line has SKU/description but no usable unit_price' })
      return
    }

    // Validate every IMEI in the group; drop the row (line) entirely if
    // it ends up with zero valid serials in per_imei/per_line mode —
    // "a supplier file with one typo shouldn't block 500 good lines"
    // (same philosophy as manifests.ts's per-row flagging).
    const validImeis: string[] = []
    for (const { imei, rowIndex } of group.imeis) {
      const v = validateImei(imei)
      if (!v.ok) {
        invalidRows.push({ row_index: rowIndex, reason: `Invalid IMEI '${imei}': ${v.reason}` })
        continue
      }
      if (withinBillSeen.has(v.imei)) {
        withinBillDuplicates.add(v.imei)
        continue
      }
      withinBillSeen.add(v.imei)
      if (existingImeisInThisOrg.has(v.imei)) crossBillDuplicates.add(v.imei)
      validImeis.push(v.imei)
    }

    if (validImeis.length === 0) {
      droppedNonImeiCount++
      invalidRows.push({ row_index: group.leadIndex, reason: 'No valid IMEI attached to this priced line — dropped' })
      return
    }

    // count(serials) == Quantity, when Quantity was actually declared.
    if (header.price_source === 'per_line' && declaredQty != null && Number.isFinite(declaredQty) && declaredQty !== validImeis.length) {
      invalidRows.push({
        row_index: group.leadIndex,
        reason: `Declared quantity ${declaredQty} does not match ${validImeis.length} attached serial(s)`,
      })
      return
    }
    if (header.price_source === 'per_imei' && validImeis.length !== 1 && group.imeis.length <= 1) {
      // per_imei with a single lead row and no continuation is fine at
      // qty 1; per_imei with continuations effectively behaves like
      // per_line (several serials at the same unit price) and quantity is
      // simply the count of attached serials — no separate check needed.
    }

    const exRate = currency === 'GBP' ? null : (header.exchange_rate as number)
    const unitPriceGbp = currency === 'GBP' ? round2(price) : round2(price / (exRate as number))

    lines.push({
      line_no: gi + 1,
      sku: cleanString(group.lead.sku),
      description: cleanString(group.lead.description),
      quantity: validImeis.length,
      unit_price: price,
      exchange_rate_used: exRate,
      unit_price_gbp: unitPriceGbp,
      is_continuation: false,
      imeis: validImeis,
    })
  })

  // Within-bill duplicate IMEI ⇒ REJECT THE FILE (per §1: "reject the
  // file if a duplicate IMEI appears within a bill" — this is stricter
  // than the row-level flagging above, and deliberately so: a duplicate
  // inside one invoice means the invoice itself is internally
  // inconsistent, not that one row has a typo).
  if (withinBillDuplicates.size > 0) {
    return {
      ok: false,
      error: `Duplicate IMEI(s) within this bill: ${[...withinBillDuplicates].join(', ')}`,
      within_bill_duplicate_imeis: [...withinBillDuplicates],
      invalid_rows: invalidRows,
    }
  }

  if (lines.length === 0) {
    return { ok: false, error: 'No valid priced lines with attached IMEIs were produced from this file', invalid_rows: invalidRows }
  }

  // Sum per-line GBP figures (already rounded to pence each) — the ONLY
  // way gbp_total is computed. Never a re-conversion of declared_total.
  const gbpTotal = round2(lines.reduce((s, l) => s + (l.unit_price_gbp ?? 0), 0))

  // declared_total_gbp: the header's OWN claimed total, converted to GBP
  // at the header rate (or declared_total itself for a GBP bill) —
  // computed for EVERY bill (not only non-GBP ones), because this is
  // exactly the figure the close rule compares gbp_total against.
  const declaredTotalGbp = currency === 'GBP'
    ? round2(header.declared_total)
    : round2(header.declared_total / (header.exchange_rate as number))

  let headerResidualGbp: number | null = null
  if (currency !== 'GBP') {
    headerResidualGbp = round2(declaredTotalGbp - gbpTotal)
    if (headerResidualGbp === 0) headerResidualGbp = 0 // normalise -0
  }

  return {
    ok: true,
    lines,
    gbp_total: gbpTotal,
    declared_total_gbp: declaredTotalGbp,
    header_residual_gbp: headerResidualGbp,
    dropped_non_imei_rows: droppedNonImeiCount + nonImeiRows.length,
    within_bill_duplicate_imeis: [],
    cross_bill_duplicate_imeis: [...crossBillDuplicates],
    invalid_rows: invalidRows,
  }
}

// ───────── Close rules (§1) ─────────
//
// A bill cannot close while sum(lines) != header total, unless
// force-closed — the misdeclaration-ack pattern, reused: the caller must
// then write a bill_close_overrides row (append-only) recording the
// variance, reason and user. This function only decides whether a normal
// (non-forced) close is permitted; it never writes anything.
export type CloseBillCheck =
  | { ok: true }
  | { ok: false; variance_gbp: number; reason: string }

export function checkBillCloseable(gbpTotal: number, declaredTotalGbp: number): CloseBillCheck {
  const variance = round2(gbpTotal - declaredTotalGbp)
  if (variance === 0) return { ok: true }
  return {
    ok: false,
    variance_gbp: variance,
    reason: `Sum of bill lines (£${gbpTotal.toFixed(2)}) does not match the declared bill total (£${declaredTotalGbp.toFixed(2)}) — force-close with a reason to override`,
  }
}

// ───────── Repair-bill control (§4) ─────────
//
// The sum of per-IMEI repair lines on a Syncere invoice must tie to the
// process charge already declared to customs (Ce1154.process_charge_gbp /
// shipments.repair_cost, converted at the SAME rate used for that
// declaration — captured on the bill, never looked up later). Flags any
// variance; never reconciles silently.
export type RepairBillControlResult = {
  lines_total_gbp: number
  declared_process_charge_gbp: number
  variance_gbp: number
  matches: boolean
}

export function checkRepairBillAgainstDeclaredCharge(
  linesTotalGbp: number,
  declaredProcessChargeGbp: number,
): RepairBillControlResult {
  const variance = round2(linesTotalGbp - declaredProcessChargeGbp)
  return {
    lines_total_gbp: round2(linesTotalGbp),
    declared_process_charge_gbp: round2(declaredProcessChargeGbp),
    variance_gbp: variance,
    matches: variance === 0,
  }
}

// Default cost-ledger provenance to use when a bill line feeds a
// cost_ledger row directly (i.e. an ordinary priced, invoice-backed
// line) — 'supplier-invoiced'. Exported so routes/tests share one
// constant rather than each spelling the string out.
export const SUPPLIER_INVOICED: CostLedgerProvenance = 'supplier-invoiced'
