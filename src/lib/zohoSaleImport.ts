// Zoho Inwards/Outwards CSV → received_devices sale-attribution importer.
//
// Everything here is PURE where possible (parsing, shape-classification,
// disposition-classification, diff computation) — same convention as
// skuMapImport.ts/oprImport.ts — so the classification rules are
// unit-testable without HTTP or D1. The D1 write path (applyZohoSaleImport)
// needs D1 to look up received_devices by imei.
//
// ───────── Design basis (.deploy-checks/zoho-outbound-reconnaissance-2026-09-09.md) ─────────
// - Match key: serial_number_code (case-insensitive, exact string) against
//   received_devices.imei. NO SKU translation on this path.
// - out_entity_type is the WRONG revenue classifier (FBA transfers and
//   internal grade changes both carry out_entity_type='invoice' alongside
//   real sales). out_contact_id is the correct classifier, mapped to
//   exactly one of five dispositions below. Any out_contact_id NOT in the
//   mapping table produces UNCLASSIFIED — it must NEVER silently default
//   to SALE_EXTERNAL (a silent default there is an uncaught revenue
//   overstatement). CONFIRMED 2026-09-09 (scope-ruling verification): 0 of
//   21 non-blank out_contact_id values in the sample span more than one
//   out_entity_type — out_contact_id ALONE remains a sufficient
//   classification key; no composite (out_contact_id, out_entity_type) key
//   is needed. The "22 groups vs 21 contacts" gap is fully explained by the
//   single blank-out_contact_id/available-status bucket, not a collision.
//   Re-check this on the real (1 Aug 2026+) file when it arrives — a future
//   file may still introduce a genuine collision, which is why
//   UNCLASSIFIED stays as a permanent fallback branch regardless.
// - Vendor credits (RETURN_TO_SUPPLIER): do NOT set status=SOLD, do NOT
//   populate sold_price_pence. Credit value goes in credit_value_pence
//   (migration 0034), never sold_price_pence. Price equality
//   (sold_price==cost_price) is explicitly NOT a detection heuristic —
//   disproven empirically (58/95 SW001 rows differ) — out_contact_id
//   membership is the only correct detector.
// - FBA_TRANSFER hard rule (operator-confirmed 2026-09-09, scope ruling):
//   Amazon FBA sales are exportable separately from the FBA dashboard, so
//   the flat £450 sold_price on every FBA_TRANSFER row is a CUSTODY-MOVE
//   placeholder, not revenue, not a cost, and not a credit. It must be
//   written to NO money column anywhere — not sold_price_pence, not
//   credit_value_pence, not any future revenue column. classifyRow()
//   enforces this by setting creditValuePence to null for FBA_TRANSFER
//   (see matched_non_revenue below) — this must stay null even if a future
//   edit adds more fields to that variant. DOUBLE-COUNT RISK: a future,
//   not-yet-built Amazon-FBA-sales importer will eventually attribute real
//   revenue to the SAME physical unit that already carries an
//   FBA_TRANSFER leg here. The disposition model must therefore stay able
//   to accept a later Amazon-sourced sale against a device already marked
//   FBA_TRANSFER — FBA_TRANSFER must never be treated as a terminal/locking
//   state for a device. Do not begin the FBA-sales-importer workstream
//   from this file.
// - Serial shape: NO Luhn validation on Zoho-supplied serials (a real
//   counter-example, 861669048498974, is Luhn-invalid and must still be
//   considered for matching). NEVER coerce through validateImei().
//   classifySerialShape()/SerialShape are kept as standalone, unit-testable
//   reporting utilities (see STILL OPEN #3 — the disposition/shape/pence
//   test file must cover the shape classifier), but as of the 2026-09-09
//   scope ruling below, shape is NO LONGER used to produce, count, or
//   report an outcome for a non-matching serial — see the INNER JOIN
//   CONTRACT note directly above classifyRow().
// - serial_number_code alone is not a safe leg-identifier WITHIN the Zoho
//   export (a physical device can be re-graded and get a new
//   serial_number_item_id/sku while keeping the same serial_number_code —
//   see the reconnaissance note Section 2). This does not affect the
//   received_devices join (an IMEI has no grade-change-reuse concept on
//   OUR side), but the importer must not assume a matched code has only
//   one candidate Zoho row if the Zoho data itself contains more than one
//   for that code — see resolveZohoRowForCode below.
// - PARSE BY HEADER NAME, NEVER BY COLUMN POSITION (operator instruction,
//   scope ruling 2026-09-09): only one sample of this CSV format has been
//   seen (Serial Number Details_Inwards/Outwards.csv, explicitly
//   reclassified as a FORMAT SAMPLE ONLY — the real file, full data from
//   1 August 2026, arrives separately and may shift column order). Every
//   row read in parseZohoCsv() below is built by indexing into the
//   HEADER ROW's own positions (`header.forEach((h, idx) => row[h] = ...)`),
//   never by a hardcoded column index — and parseZohoCsv() fails loudly
//   (`ok: false`) at parse time if any ZOHO_CSV_HEADERS name is missing
//   from the file's own header row, rather than silently reading the wrong
//   column into the wrong field name.
// - REAL-FILE EXPECTATION INVERSION (operator instruction, scope ruling
//   2026-09-09): the low match rate measured against the FORMAT-SAMPLE
//   Outwards file (retired figure, do not quote — see CLOSED note below)
//   was benign ONLY because that sample's out-side window reached back to
//   2022, before this app's own goods-in tracking existed. The REAL file's
//   window (1 Aug 2026 onward) sits INSIDE both the app's lifetime and
//   goods-in's own window (MIN in_entity_date = 2026-08-03) — so "low match
//   rate is expected/benign" must NOT be assumed for the real file. Any
//   future match-rate monitoring against the real file must treat a low
//   rate as a signal to investigate, not as expected background noise.
//
// ───────── INNER JOIN CONTRACT (operator instruction, scope ruling 2026-09-09) ─────────
// The importer is an INNER JOIN on the goods-in roster (received_devices.
// imei). Only a Zoho row whose serial_number_code matches a known IMEI
// produces ANY output — a classification outcome, a counter increment, or
// a report line. A Zoho row with no matching IMEI produces NOTHING: no
// outcome object, no count, no staging-table entry, no report line. This
// is a hard contract on output cardinality (bounded by the goods-in
// roster, never by the Outwards file's own row count), not a default that
// a future edit may loosen by re-adding an "unmatched" counter. The
// previously-committed `unmatched_no_device` / `unmatched_serial_shape`
// ZohoImportOutcome variants (and their unmatchedNoDeviceCount /
// unmatchedSerialShapeCount / unattributedTotal counts) have been REMOVED
// to enforce this — classifyRow() now returns `null` (produces nothing)
// for a non-matching serial, and classifyZohoCsvRows() filters those nulls
// out before they ever reach `outcomes` or any count.

import { newUuid } from './uuid'
import { transitionDevice, InvalidTransitionError } from './deviceLifecycle'
import type { AuthUser } from '../types'

// ───────── CSV parsing ─────────

export const ZOHO_CSV_HEADERS = [
  'product_name', 'serial_number_item_id', 'sku', 'serial_number_code',
  'status', 'in_entity', 'in_entity_type', 'in_entity_id', 'in_entity_number',
  'in_contact_id', 'in_contact_name', 'in_entity_date', 'out_entity',
  'out_entity_type', 'out_entity_id', 'out_entity_number', 'out_entity_date',
  'out_contact_id', 'out_contact_name', 'line_item_location_id',
  'line_item_location_name', 'cost_price', 'sold_price', 'profit',
  'item_status',
] as const

export type ZohoCsvRow = Record<typeof ZOHO_CSV_HEADERS[number], string>

// Minimal RFC4180-ish CSV line splitter — same implementation as
// skuMapImport.ts's parseCsvLine (basic double-quote quoting/escaping),
// kept as a local copy rather than a shared import so each importer's
// parsing stays independently readable/testable.
function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = false }
      } else {
        cur += ch
      }
    } else {
      if (ch === '"') inQuotes = true
      else if (ch === ',') { cells.push(cur); cur = '' }
      else cur += ch
    }
  }
  cells.push(cur)
  return cells
}

export type ZohoCsvParseResult =
  | { ok: true; rows: ZohoCsvRow[]; fileLineCount: number }
  | { ok: false; error: string }

export function parseZohoCsv(raw: string): ZohoCsvParseResult {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return { ok: false, error: 'Empty file' }

  const header = parseCsvLine(lines[0]).map(h => h.trim())
  for (const req of ZOHO_CSV_HEADERS) {
    if (!header.includes(req)) {
      return { ok: false, error: `Missing required column: ${req}` }
    }
  }

  const dataLines = lines.slice(1)
  const rows: ZohoCsvRow[] = []
  for (const line of dataLines) {
    if (line.trim() === '') continue
    const cells = parseCsvLine(line)
    const row: Record<string, string> = {}
    header.forEach((h, idx) => { row[h] = (cells[idx] ?? '').trim() })
    rows.push(row as ZohoCsvRow)
  }

  return { ok: true, rows, fileLineCount: dataLines.filter(l => l.trim() !== '').length }
}

// ───────── Outwards-submission shape gate ─────────
//
// FILE-SHAPE GATE (2026-09-10 incident response, revised after the :405
// collision). This is a SUBMISSION POLICY — "is this the right file for
// this importer" — not a parsing concern, and deliberately lives OUTSIDE
// parseZohoCsv() so unit tests may still call the parser directly with
// small, deliberately-minimal fixtures (including a single genuinely-idle
// row with no out-side data at all) without tripping an import-submission
// rule. It is called once, by applyZohoSaleImport(), after a successful
// parse and before classifyZohoCsvRows() — it never alters a per-row
// outcome, only whether the whole file is accepted for classification.
//
// The first version of this gate rejected on ABSENCE alone (no row has
// out_entity_date or out_contact_id populated). That collided with a
// legitimate minimal fixture: a single row of genuinely idle stock has
// no out-side data either, by definition, and is indistinguishable from
// a wholly-mistaken-Inwards file under an absence-only rule. Absence of a
// signal is not evidence of the WRONG file; it is also the shape of a
// small slice of the RIGHT file. Revised to require a POSITIVE
// counter-signal instead: reject only when the file has zero out-side
// signal AND at least one row carries a positive Inwards signature
// (in_entity_date populated with item_status = 'available') — i.e. there
// is actual evidence this is an Inwards-shaped export, not merely an
// absence of outwards evidence. A file with neither signal (no out-side
// data, no Inwards signature either) is not diagnosable as the wrong
// file and must pass through unchanged, exactly as before this gate
// existed.
export type OutwardsShapeCheckResult =
  | { ok: true }
  | { ok: false; error: string }

export function assertOutwardsShape(rows: ZohoCsvRow[]): OutwardsShapeCheckResult {
  if (rows.length === 0) return { ok: true }

  const hasAnyOutSideSignal = rows.some(
    r => r.out_entity_date.trim() !== '' || r.out_contact_id.trim() !== ''
  )
  if (hasAnyOutSideSignal) return { ok: true }

  const inwardsSignatureCount = rows.filter(
    r => r.in_entity_date.trim() !== '' && r.item_status.trim().toLowerCase() === 'available'
  ).length

  if (inwardsSignatureCount === 0) return { ok: true }

  return {
    ok: false,
    error: `Every one of ${rows.length} row(s) is missing both out_entity_date ` +
      `and out_contact_id, and ${inwardsSignatureCount} row(s) carry a positive ` +
      `Inwards signature (in_entity_date populated with item_status=available) — ` +
      `this looks like an Inwards export submitted to the Outwards/sale importer, ` +
      `not an outwards or mixed file. Rejected before classification.`,
  }
}

// ───────── Serial shape classification ─────────
//
// Deliberately NOT validateImei() (src/lib/validate.ts). That function
// enforces a Luhn checksum on 15-digit codes and only accepts exactly-10-
// char alnum otherwise — real Zoho-supplied serials violate both (a
// confirmed Luhn-invalid 15-digit cellular value, and 11/12/16-char
// "other"-shaped serials for accessories/tablets). Coercing through it
// would silently reject legitimate matches.
//
// The importer's own matching rule is exact case-insensitive string
// equality against received_devices.imei. classifySerialShape() is kept as
// a standalone, unit-testable utility (required by STILL OPEN #3's test
// coverage), but per the 2026-09-09 INNER JOIN CONTRACT it is no longer
// consulted by classifyRow()/classifyZohoCsvRows() to produce, count, or
// report any outcome for a non-matching serial — a non-match now produces
// nothing at all, not a shape-tagged report line.

export type SerialShape = 'imei_15_digit' | 'alnum_10' | 'other'

export function classifySerialShape(code: string): SerialShape {
  const s = code.trim()
  if (/^\d{15}$/.test(s)) return 'imei_15_digit'
  if (/^[A-Za-z0-9]{10}$/.test(s)) return 'alnum_10'
  return 'other'
}

export function normaliseSerialForMatch(code: string): string {
  return code.trim().toUpperCase()
}

// ───────── Disposition classification (out_contact_id → enum) ─────────
//
// Mapping table derived empirically from the mandated aggregation query
// (.deploy-checks/zoho-outbound-reconnaissance-2026-09-09.md, Section 3).
// This table is a SNAPSHOT of the dataset seen at reconnaissance time —
// it is expected to need new entries as new Zoho contacts appear in
// future exports. Any out_contact_id NOT in this table classifies as
// UNCLASSIFIED, never SALE_EXTERNAL, so a future unmapped contact cannot
// silently inflate revenue.

export type Disposition =
  | 'SALE_EXTERNAL'
  | 'FBA_TRANSFER'
  | 'GRADE_CHANGE_OUT'
  | 'RETURN_TO_SUPPLIER'
  | 'UNCLASSIFIED'

// Dispositions that must NEVER set status=SOLD or populate
// sold_price_pence (RETURN_TO_SUPPLIER is excluded from revenue by
// definition; UNCLASSIFIED is excluded because we don't yet know what it
// is — treating an unknown as a sale is the exact silent-default failure
// mode the brief forbids).
export const NON_SALE_DISPOSITIONS: readonly Disposition[] = ['FBA_TRANSFER', 'GRADE_CHANGE_OUT', 'RETURN_TO_SUPPLIER', 'UNCLASSIFIED']

export const ZOHO_CONTACT_DISPOSITION_MAP: Record<string, Disposition> = {
  '251444000000060479': 'SALE_EXTERNAL',     // Amazon UK - Customer
  '251444000023280586': 'SALE_EXTERNAL',     // AMAZON MANUAL
  '251444000122630826': 'SALE_EXTERNAL',     // Last Rope BM Automation
  '251444000458664685': 'SALE_EXTERNAL',     // TEMU (contact_id #1)
  '251444000458172774': 'SALE_EXTERNAL',     // TEMU (contact_id #2 -- name collision, confirmed distinct contact)
  '251444000000214057': 'SALE_EXTERNAL',     // Saigates BM Automation
  '251444000459339270': 'SALE_EXTERNAL',     // REFURBED
  '251444000005533455': 'SALE_EXTERNAL',     // BM-LR Manual
  '251444000000051003': 'SALE_EXTERNAL',     // BM MANUAL
  '251444000418326549': 'SALE_EXTERNAL',     // EBAY LASTDROP
  '251444000007063707': 'SALE_EXTERNAL',     // Backmarket LR
  '251444000104824496': 'SALE_EXTERNAL',     // Shop Customer
  '251444000048250993': 'SALE_EXTERNAL',     // RAKESHBHAI LONDON
  '251444000345383017': 'FBA_TRANSFER',      // Amazon FBA (flat GBP450 custody move)
  '251444000065690570': 'GRADE_CHANGE_OUT',  // GR CHANGE AUTO OUT (internal re-grade)
  '251444000347365746': 'RETURN_TO_SUPPLIER', // SW001
  '251444000244894695': 'RETURN_TO_SUPPLIER', // rep
  '251444000000147532': 'RETURN_TO_SUPPLIER', // ADJ
  '251444000000365314': 'RETURN_TO_SUPPLIER', // MT001
  '251444000457721449': 'RETURN_TO_SUPPLIER', // TWG001
  '251444000119914593': 'RETURN_TO_SUPPLIER', // YH001
}

export function classifyDisposition(outContactId: string): Disposition {
  const id = outContactId.trim()
  if (!id) return 'UNCLASSIFIED'
  return ZOHO_CONTACT_DISPOSITION_MAP[id] ?? 'UNCLASSIFIED'
}

// ───────── Row selection for a matched serial (grade-change-reuse guard) ─────────
//
// A serial_number_code can legitimately appear on more than one Zoho row
// across a device's re-grade history (reconnaissance note Section 2). When
// matching against a SINGLE received_devices.imei, prefer the row whose
// out_entity_date is the MOST RECENT — the current/latest leg is the one
// relevant to today's import, not a closed earlier leg. Rows with no
// out_entity_date (status='available', not yet sold) sort last, since an
// unsold row carries no disposition-relevant sale to attribute.
export function resolveZohoRowForCode(rows: ZohoCsvRow[]): ZohoCsvRow | null {
  if (rows.length === 0) return null
  if (rows.length === 1) return rows[0]
  const sold = rows.filter(r => r.out_entity_date && r.out_entity_date.trim())
  if (sold.length === 0) return rows[0]
  return sold.reduce((latest, r) => (r.out_entity_date > latest.out_entity_date ? r : latest))
}

// ───────── Per-row classification result ─────────

export type ZohoImportOutcome =
  | {
      outcome: 'matched_sale'
      serialCode: string
      imei: string
      disposition: 'SALE_EXTERNAL'
      soldPricePence: number
      invoiceNo: string
      saleDate: string
      outContactId: string
    }
  | {
      outcome: 'matched_non_revenue'
      serialCode: string
      imei: string
      disposition: 'FBA_TRANSFER' | 'GRADE_CHANGE_OUT' | 'RETURN_TO_SUPPLIER'
      creditValuePence: number | null
      entityNumber: string
      entityDate: string
      outContactId: string
    }
  | {
      outcome: 'matched_unclassified'
      serialCode: string
      imei: string
      outContactId: string
      outContactName: string
    }
  | {
      outcome: 'skipped_available'
      serialCode: string
      imei: string
    }
// INNER JOIN CONTRACT: there is deliberately NO "unmatched"/"no device"
// outcome variant here. A serial with no matching received_devices.imei
// produces no ZohoImportOutcome at all — classifyRow() returns null for
// it, and classifyZohoCsvRows() drops the null before it reaches
// `outcomes` or any count. See the design-basis comment above.

// Converts a decimal GBP string ("260.00") to integer pence. Parses
// straight to an integer via string-splitting, never through a float
// (same discipline as 0033's sold_price_pence rationale) — avoids binary
// floating-point rounding noise on money.
export function gbpStringToPence(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const match = /^(-?\d+)(?:\.(\d{1,2}))?$/.exec(trimmed)
  if (!match) return null
  const whole = parseInt(match[1], 10)
  const fracStr = (match[2] ?? '').padEnd(2, '0')
  const frac = parseInt(fracStr, 10)
  const sign = whole < 0 ? -1 : 1
  return whole * 100 + sign * frac
}

// classifyRow: pure classification of ONE (already-resolved) Zoho row
// against the set of known received_devices IMEIs (case-insensitive).
// Does not decide DB writes — see applyZohoSaleImport for that.
//
// INNER JOIN CONTRACT (2026-09-09 scope ruling): returns null when the
// row's serial_number_code has no matching received_devices.imei. A null
// return means "produce nothing" — no outcome object, no counter, no
// report line. Callers (classifyZohoCsvRows) MUST filter out null before
// counting/reporting; they must never re-introduce an "unmatched" count.
export function classifyRow(
  row: ZohoCsvRow,
  knownImeisUpper: ReadonlySet<string>,
): ZohoImportOutcome | null {
  const serialCode = row.serial_number_code
  const normalised = normaliseSerialForMatch(serialCode)
  const matchedImei = knownImeisUpper.has(normalised) ? normalised : null

  if (!matchedImei) {
    // No matching goods-in device: the INNER JOIN contract means this row
    // produces NOTHING — not a counted "unmatched" outcome, not a report
    // line, not a staging-table entry. classifySerialShape() still exists
    // as a standalone reporting utility (unit-tested per STILL OPEN #3)
    // but is deliberately NOT consulted here anymore.
    return null
  }

  // Matched an IMEI we hold. A blank out_contact_id is skipped_available
  // ONLY if there is also no out-side transaction data at all (2026-09-09
  // narrowing, DEVELOPER INSTRUCTION): status='available' AND blank
  // out_entity_type AND blank sold_price. NOTE: this row's `status` column
  // (values 'available'/'sold') is the availability discriminator — NOT
  // `item_status`, which reads 'active' for both the blank-out_contact_id
  // AND non-blank populations alike in the 2026-09-09 sample (confirmed:
  // 525/525 blanks and 2691/2691 non-blanks both read item_status='active'
  // — item_status carries zero discriminating signal here and must not be
  // used as this guard's condition). The 2026-09-09 sample's 525
  // blank-out_contact_id rows are all Inwards/status=available/no-sold_price,
  // so this guard changes nothing on that sample — but the sample's blanks
  // are all Inwards BY CONSTRUCTION and cannot prove an Outwards row with
  // a blank out_contact_id is safe to treat the same way. An OUTWARDS row
  // with real out-side data (a genuine movement out) but a blank
  // out_contact_id is a real classifier gap, not idle stock — filing it
  // as skipped_available would make it vanish silently, the exact failure
  // mode UNCLASSIFIED exists to prevent. So: blank id WITH any out-side
  // data falls through to classifyDisposition() below, which already
  // returns UNCLASSIFIED for a blank id — no new outcome variant, no
  // special branch, just a narrower guard on the existing early return.
  const outContactId = row.out_contact_id.trim()
  if (!outContactId) {
    const status = row.status.trim().toLowerCase()
    const hasOutSideData = status !== 'available'
      || row.out_entity_type.trim() !== ''
      || row.sold_price.trim() !== ''
    if (!hasOutSideData) {
      return { outcome: 'skipped_available', serialCode, imei: matchedImei }
    }
  }

  const disposition = classifyDisposition(outContactId)

  if (disposition === 'UNCLASSIFIED') {
    return {
      outcome: 'matched_unclassified',
      serialCode,
      imei: matchedImei,
      outContactId,
      outContactName: row.out_contact_name,
    }
  }

  if (disposition === 'SALE_EXTERNAL') {
    const soldPricePence = gbpStringToPence(row.sold_price)
    return {
      outcome: 'matched_sale',
      serialCode,
      imei: matchedImei,
      disposition,
      soldPricePence: soldPricePence ?? 0,
      invoiceNo: row.out_entity_number,
      saleDate: row.out_entity_date,
      outContactId,
    }
  }

  // FBA_TRANSFER / GRADE_CHANGE_OUT / RETURN_TO_SUPPLIER — all non-revenue.
  // Only RETURN_TO_SUPPLIER carries a meaningful credit value; the other
  // two still record cost_price-adjacent bookkeeping via entityNumber/date
  // but never populate sold_price_pence or credit_value_pence for
  // themselves (FBA/grade-change are custody/internal moves, not credits).
  const creditValuePence = disposition === 'RETURN_TO_SUPPLIER'
    ? gbpStringToPence(row.sold_price)
    : null

  return {
    outcome: 'matched_non_revenue',
    serialCode,
    imei: matchedImei,
    disposition,
    creditValuePence,
    entityNumber: row.out_entity_number,
    entityDate: row.out_entity_date,
    outContactId,
  }
}

// ───────── Batch classification over a full CSV ─────────

// INNER JOIN CONTRACT (2026-09-09 scope ruling): totalRows is the RAW
// input row count from the CSV — kept only as a parse-time fact ("we read
// N lines"), never as a denominator implying N outcomes are expected.
// `outcomes` contains ONLY matched rows (matched_sale / matched_non_revenue
// / matched_unclassified / skipped_available) — there is deliberately NO
// unmatched count anywhere on this type. A non-matching serial is absent
// from `outcomes` and from every count below; it is not represented by a
// zero, a null entry, or a placard figure. Do not re-add one.
export type ZohoImportSummary = {
  totalRows: number
  matchedSaleCount: number
  matchedNonRevenueCount: number
  matchedUnclassifiedCount: number
  skippedAvailableCount: number
  outcomes: ZohoImportOutcome[]
}

export function classifyZohoCsvRows(
  rows: ZohoCsvRow[],
  knownImeisUpper: ReadonlySet<string>,
): ZohoImportSummary {
  // Group by serial_number_code first so re-grade duplicates (Section 2)
  // resolve to a single row per code before classification.
  const byCode = new Map<string, ZohoCsvRow[]>()
  for (const r of rows) {
    const key = r.serial_number_code
    if (!byCode.has(key)) byCode.set(key, [])
    byCode.get(key)!.push(r)
  }

  // INNER JOIN CONTRACT: classifyRow() returns null for any serial with no
  // matching received_devices.imei. Filter it out here, immediately —
  // nulls must never reach `outcomes` or any count below.
  const outcomes: ZohoImportOutcome[] = []
  for (const [, codeRows] of byCode) {
    const resolved = resolveZohoRowForCode(codeRows)
    if (!resolved) continue
    const outcome = classifyRow(resolved, knownImeisUpper)
    if (outcome === null) continue
    outcomes.push(outcome)
  }

  const count = (o: ZohoImportOutcome['outcome']) => outcomes.filter(x => x.outcome === o).length
  const matchedSaleCount = count('matched_sale')
  const matchedNonRevenueCount = count('matched_non_revenue')
  const matchedUnclassifiedCount = count('matched_unclassified')
  const skippedAvailableCount = count('skipped_available')

  return {
    totalRows: rows.length,
    matchedSaleCount,
    matchedNonRevenueCount,
    matchedUnclassifiedCount,
    skippedAvailableCount,
    outcomes,
  }
}

// ───────── D1-backed apply (write path) ─────────
//
// Not pure — looks up received_devices by IMEI to build the known-IMEI set
// classifyRow()/classifyZohoCsvRows() need, then writes outcomes. Same
// two-phase shape as applySkuMapImport (skuMapImport.ts): parse -> validate
// -> (dry-run: return diff-equivalent preview) -> (write: batch statements).
//
// Per-outcome write behaviour (design-basis + 2026-09-09 scope rulings):
//   matched_sale (SALE_EXTERNAL):
//     - related-row-first, transitionDevice()-second (repairWorkflow.ts
//       closeToInventory() ordering convention) — write the sale columns
//       (sold_invoice_no, sold_date, sold_channel='zoho_import',
//       sold_price_pence, attribution='zoho_import', disposition,
//       zoho_out_contact_id, zoho_out_entity_number) BEFORE calling
//       transitionDevice(..., 'SOLD', ...), so no external observer can
//       catch a SOLD device with blank sale columns.
//     - transitionDevice() throws InvalidTransitionError for a device
//       already outside the reachable-to-SOLD source set (the five
//       OPR/temp-export consignment statuses, REJECTED) or already SOLD
//       (ALLOWED_TRANSITIONS.SOLD = []) — both are caught and surfaced as
//       a NAMED conflict entry, never a thrown error that aborts the
//       whole batch and never a silent skip.
//   matched_non_revenue (FBA_TRANSFER / GRADE_CHANGE_OUT / RETURN_TO_SUPPLIER):
//     - writes disposition/creditValuePence/zoho_out_contact_id/
//       zoho_out_entity_number ONLY. Never calls transitionDevice() into
//       SOLD — these are custody moves or vendor credits, not sales (see
//       design-basis note above classifyRow()). sold_price_pence and every
//       other 0033 sale column stay untouched.
//   matched_unclassified:
//     - no write at all. Reported back in the result for operator review;
//       UNCLASSIFIED is the correct destination for an unmapped
//       out_contact_id (2026-09-09 scope ruling) and needs no schema
//       write until a human maps it into ZOHO_CONTACT_DISPOSITION_MAP.
//   skipped_available:
//     - no write. The device hasn't been sold in Zoho yet (blank
//       out_contact_id, status=available) — nothing to attribute this run.
//
// CONFLICT SURFACING (never a thrown error, never a silent skip): a
// matched_sale outcome whose target device is not currently in one of the
// seven reachable-to-SOLD source statuses (already SOLD, or on a locked
// consignment leg, or REJECTED) is recorded as a `ZohoImportConflict` and
// excluded from the write batch — the rest of the import still proceeds.
//
// dryRun=true classifies every row and reports what WOULD happen
// (soldCount/nonRevenueCount/unclassifiedCount/skippedCount/conflicts)
// without writing anything or calling transitionDevice().

export type ZohoImportConflict = {
  serialCode: string
  imei: string
  reason: 'already_sold' | 'locked_consignment' | 'rejected' | 'device_not_found'
  currentStatus: string | null
}

// A matched_sale row whose device is already SOLD but whose stored
// zoho_out_entity_number matches THIS row's invoice number: re-running the
// same Zoho export file re-derives the same outcome, not a new conflict
// (item 3, DEVELOPER INSTRUCTION 2026-09-09). Never counted in `conflicts`.
export type ZohoAlreadyImported = { serialCode: string; imei: string; invoiceNo: string }

// A matched_sale row whose device is currently QC_FAILED. `dryRun` lists
// every such row here unconditionally (informational preview) regardless
// of opts.acknowledgeQcFailed. (QC_FAILED acknowledgment gate, DEVELOPER
// INSTRUCTION 2026-09-09 -- folded into item 2's classifier work.)
export type ZohoQcFailedRow = {
  serialCode: string; imei: string; invoiceNo: string
  soldPricePence: number; currentStatus: string
}

// A matched_sale row that targeted a QC_FAILED device but was excluded
// from the write batch because opts.acknowledgeQcFailed was not true.
// Every OTHER row in the batch still proceeds -- one flagged device must
// not fail a whole import. The verbatim `message` is QC_FAILED_WARNING_MESSAGE.
export type ZohoWarningUnacknowledged = ZohoQcFailedRow & { message: string }

// Verbatim, greppable copy for the QC_FAILED acknowledgment gate. The rule
// attaches to the QC_FAILED -> SOLD edge itself, not to this importer --
// reuse this exact string on any future single-device sale path that can
// also reach SOLD from QC_FAILED.
export const QC_FAILED_WARNING_MESSAGE =
  'Device failed QC (QC_FAILED). Selling as a standard sale — revenue will be reported with all other sales. Confirm to proceed.'

export type ZohoImportApplyResult = {
  ok: boolean
  errors: string[]
  dryRun: boolean
  importBatchId: string | null
  totalRows: number
  matchedSaleCount: number
  matchedNonRevenueCount: number
  matchedUnclassifiedCount: number
  skippedAvailableCount: number
  soldCount: number // subset of matchedSaleCount actually written (dryRun: what WOULD write)
  conflicts: ZohoImportConflict[]
  unclassified: Array<{ serialCode: string; imei: string; outContactId: string; outContactName: string }>
  // Same invoice number already recorded on this device from an earlier
  // run of this same file -- idempotent no-op, NOT a conflict (item 3).
  alreadyImportedCount: number
  alreadyImported: ZohoAlreadyImported[]
  // dryRun-only informational preview of every QC_FAILED-source matched_sale
  // row, regardless of opts.acknowledgeQcFailed. Empty on a real (non-dryRun) run.
  qcFailedPreview: ZohoQcFailedRow[]
  // Rows excluded from the write batch because they targeted a QC_FAILED
  // device without opts.acknowledgeQcFailed === true. Populated identically
  // on dryRun and real runs (same rule, truthful preview). Empty when every
  // QC_FAILED-source row was acknowledged or there were none.
  warningUnacknowledgedCount: number
  warningUnacknowledged: ZohoWarningUnacknowledged[]
}

// Statuses a device may be in when a matched_sale outcome targets it.
// Mirrors deviceLifecycle.ts's ALLOWED_TRANSITIONS SOLD-edge note exactly
// (RECEIVED, SORTING, ACTIVE_INVENTORY, IN_HOUSE_REPAIR, READY_FOR_EXPORT,
// QC_FAILED, READY_FOR_ZOHO) — kept as a local literal rather than derived
// from ALLOWED_TRANSITIONS at runtime so a future edit to that table
// cannot silently widen/narrow this importer's own conflict-detection
// without a matching, reviewed change here.
const SOLD_REACHABLE_STATUSES = new Set([
  'RECEIVED', 'SORTING', 'ACTIVE_INVENTORY', 'IN_HOUSE_REPAIR',
  'READY_FOR_EXPORT', 'QC_FAILED', 'READY_FOR_ZOHO',
])

function conflictReasonFor(status: string): ZohoImportConflict['reason'] {
  if (status === 'SOLD') return 'already_sold'
  if (status === 'REJECTED') return 'rejected'
  return 'locked_consignment' // the five OPR/temp-export consignment statuses
}

export async function applyZohoSaleImport(
  db: D1Database,
  organisationId: number,
  csvText: string,
  opts: { dryRun: boolean; actorUserId: number; user: AuthUser; acknowledgeQcFailed?: boolean },
): Promise<ZohoImportApplyResult> {
  const empty = {
    ok: false, errors: [] as string[], dryRun: opts.dryRun, importBatchId: null,
    totalRows: 0, matchedSaleCount: 0, matchedNonRevenueCount: 0,
    matchedUnclassifiedCount: 0, skippedAvailableCount: 0, soldCount: 0,
    conflicts: [] as ZohoImportConflict[], unclassified: [] as ZohoImportApplyResult['unclassified'],
    alreadyImportedCount: 0, alreadyImported: [] as ZohoAlreadyImported[],
    qcFailedPreview: [] as ZohoQcFailedRow[],
    warningUnacknowledgedCount: 0, warningUnacknowledged: [] as ZohoWarningUnacknowledged[],
  }

  const parsed = parseZohoCsv(csvText)
  if (!parsed.ok) return { ...empty, errors: [parsed.error] }

  // Submission-shape gate (2026-09-10 incident response) — checked here,
  // at the import-submission boundary, not inside parseZohoCsv() itself.
  // See assertOutwardsShape()'s own header comment for the full rationale.
  const shapeCheck = assertOutwardsShape(parsed.rows)
  if (!shapeCheck.ok) return { ...empty, errors: [shapeCheck.error] }

  // Build the known-IMEI set from received_devices for this organisation —
  // classifyRow()'s INNER JOIN CONTRACT needs this to decide match/no-match.
  // zoho_out_entity_number is fetched here too — item 3's re-import
  // idempotency check needs the device's STORED invoice number to compare
  // against the CSV row's invoice number.
  const { results: deviceRows } = await db.prepare(
    'SELECT id, imei, status, zoho_out_entity_number FROM received_devices WHERE organisation_id = ?'
  ).bind(organisationId).all<{ id: number; imei: string; status: string; zoho_out_entity_number: string | null }>()
  const byImeiUpper = new Map(deviceRows.map(d => [d.imei.trim().toUpperCase(), d]))
  const knownImeisUpper = new Set(byImeiUpper.keys())

  const summary = classifyZohoCsvRows(parsed.rows, knownImeisUpper)

  const unclassified = summary.outcomes
    .filter((o): o is Extract<ZohoImportOutcome, { outcome: 'matched_unclassified' }> => o.outcome === 'matched_unclassified')
    .map(o => ({ serialCode: o.serialCode, imei: o.imei, outContactId: o.outContactId, outContactName: o.outContactName }))

  const saleOutcomes = summary.outcomes
    .filter((o): o is Extract<ZohoImportOutcome, { outcome: 'matched_sale' }> => o.outcome === 'matched_sale')
  const nonRevenueOutcomes = summary.outcomes
    .filter((o): o is Extract<ZohoImportOutcome, { outcome: 'matched_non_revenue' }> => o.outcome === 'matched_non_revenue')

  // Conflict detection — same rule for dry-run preview and real write, so
  // the preview is a truthful predictor of what a real run will do.
  //
  // Three device-side checks, in order, for every matched_sale outcome:
  //   1. device_not_found — should not happen (o.imei came from
  //      knownImeisUpper), but keep the contract explicit rather than assume.
  //   2. already-SOLD split on zoho_out_entity_number (item 3, DEVELOPER
  //      INSTRUCTION 2026-09-09): SAME invoice number as already stored on
  //      the device -> this is a re-run of a file we've already applied ->
  //      `alreadyImported`, NOT a conflict. DIFFERENT (or no stored) invoice
  //      number -> genuine double-sale / mis-keyed-serial conflict, reported
  //      loudly as `already_sold`. Runs BEFORE the general
  //      SOLD_REACHABLE_STATUSES check because SOLD is itself excluded from
  //      that set — must intercept SOLD explicitly first.
  //   3. QC_FAILED acknowledgment gate (folded into item 2's classifier
  //      work, DEVELOPER INSTRUCTION 2026-09-09): a device currently
  //      QC_FAILED is a reachable-to-SOLD source (SOLD_REACHABLE_STATUSES
  //      already includes it — the transition edge itself is fine), but a
  //      human must consciously confirm selling a device that failed QC.
  //      Every QC_FAILED-source row is recorded in qcFailedPreview
  //      unconditionally (informational, both dryRun and real run). If
  //      opts.acknowledgeQcFailed is not true, the row is ALSO excluded from
  //      the write batch and recorded in warningUnacknowledged — every OTHER
  //      row in the batch still proceeds; one flagged device must not fail
  //      a whole import.
  const conflicts: ZohoImportConflict[] = []
  const alreadyImported: ZohoAlreadyImported[] = []
  const qcFailedPreview: ZohoQcFailedRow[] = []
  const warningUnacknowledged: ZohoWarningUnacknowledged[] = []
  const writableSales: Array<{ outcome: Extract<ZohoImportOutcome, { outcome: 'matched_sale' }>; device: { id: number; imei: string; status: string; zoho_out_entity_number: string | null } }> = []
  for (const o of saleOutcomes) {
    const device = byImeiUpper.get(o.imei)
    if (!device) {
      conflicts.push({ serialCode: o.serialCode, imei: o.imei, reason: 'device_not_found', currentStatus: null })
      continue
    }
    if (device.status === 'SOLD') {
      if (device.zoho_out_entity_number && device.zoho_out_entity_number === o.invoiceNo) {
        alreadyImported.push({ serialCode: o.serialCode, imei: o.imei, invoiceNo: o.invoiceNo })
      } else {
        conflicts.push({ serialCode: o.serialCode, imei: o.imei, reason: 'already_sold', currentStatus: device.status })
      }
      continue
    }
    if (!SOLD_REACHABLE_STATUSES.has(device.status)) {
      conflicts.push({ serialCode: o.serialCode, imei: o.imei, reason: conflictReasonFor(device.status), currentStatus: device.status })
      continue
    }
    if (device.status === 'QC_FAILED') {
      qcFailedPreview.push({
        serialCode: o.serialCode, imei: o.imei, invoiceNo: o.invoiceNo,
        soldPricePence: o.soldPricePence, currentStatus: device.status,
      })
      if (!opts.acknowledgeQcFailed) {
        warningUnacknowledged.push({
          serialCode: o.serialCode, imei: o.imei, invoiceNo: o.invoiceNo,
          soldPricePence: o.soldPricePence, currentStatus: device.status,
          message: QC_FAILED_WARNING_MESSAGE,
        })
        continue
      }
    }
    writableSales.push({ outcome: o, device })
  }

  if (opts.dryRun) {
    return {
      ok: true, errors: [], dryRun: true, importBatchId: null,
      totalRows: summary.totalRows,
      matchedSaleCount: summary.matchedSaleCount,
      matchedNonRevenueCount: summary.matchedNonRevenueCount,
      matchedUnclassifiedCount: summary.matchedUnclassifiedCount,
      skippedAvailableCount: summary.skippedAvailableCount,
      soldCount: writableSales.length,
      conflicts,
      unclassified,
      alreadyImportedCount: alreadyImported.length,
      alreadyImported,
      qcFailedPreview,
      warningUnacknowledgedCount: warningUnacknowledged.length,
      warningUnacknowledged,
    }
  }

  const importBatchId = newUuid()
  const now = new Date().toISOString()

  // non_revenue writes: disposition/creditValuePence/zoho_out_contact_id/
  // zoho_out_entity_number ONLY. Never touches sold_price_pence or any
  // other 0033 sale column, never calls transitionDevice() into SOLD.
  const nonRevenueStatements = nonRevenueOutcomes.map(o => {
    const device = byImeiUpper.get(o.imei)!
    return db.prepare(
      `UPDATE received_devices SET
         disposition = ?, credit_value_pence = ?, zoho_out_contact_id = ?,
         zoho_out_entity_number = ?, updated_at = ?
       WHERE id = ? AND organisation_id = ?`
    ).bind(o.disposition, o.creditValuePence, o.outContactId, o.entityNumber, now, device.id, organisationId)
  })

  if (nonRevenueStatements.length > 0) {
    await db.batch(nonRevenueStatements)
  }

  // sale writes: related-row (sale columns) FIRST, transitionDevice()
  // SECOND per repairWorkflow.ts closeToInventory()'s ordering convention
  // — each device processed independently so one device's transition
  // failure cannot abort another's, matching the bulk-transition route's
  // per-row-independent precedent (src/routes/devices.ts).
  let soldCount = 0
  for (const { outcome: o, device } of writableSales) {
    await db.prepare(
      `UPDATE received_devices SET
         sold_invoice_no = ?, sold_date = ?, sold_channel = 'zoho_import',
         sold_price_pence = ?, attribution = 'zoho_import',
         disposition = ?, zoho_out_contact_id = ?, zoho_out_entity_number = ?,
         updated_at = ?
       WHERE id = ? AND organisation_id = ?`
    ).bind(
      o.invoiceNo, o.saleDate, o.soldPricePence, o.disposition,
      o.outContactId, o.invoiceNo, now, device.id, organisationId,
    ).run()

    try {
      await transitionDevice(db, device.id, 'SOLD', {
        user: opts.user,
        eventType: 'ZOHO_SALE_IMPORT',
        reference: importBatchId,
        metadata: { zoho_invoice_no: o.invoiceNo, zoho_out_contact_id: o.outContactId },
      })
      soldCount++
    } catch (err) {
      // A device that changed status between the conflict check above and
      // this write (race) surfaces as a conflict rather than aborting the
      // whole import — the sale columns just written stand as a record of
      // the attempt; they are not rolled back (matches the "no partial
      // rollback across independent devices" precedent in bulk-transition).
      conflicts.push({
        serialCode: o.serialCode, imei: o.imei,
        reason: err instanceof InvalidTransitionError ? conflictReasonFor(device.status) : 'device_not_found',
        currentStatus: device.status,
      })
    }
  }

  return {
    ok: true, errors: [], dryRun: false, importBatchId,
    totalRows: summary.totalRows,
    matchedSaleCount: summary.matchedSaleCount,
    matchedNonRevenueCount: summary.matchedNonRevenueCount,
    matchedUnclassifiedCount: summary.matchedUnclassifiedCount,
    skippedAvailableCount: summary.skippedAvailableCount,
    soldCount,
    conflicts,
    unclassified,
    alreadyImportedCount: alreadyImported.length,
    alreadyImported,
    // qcFailedPreview is a dryRun-only informational concept (the user's
    // "dry_run lists every QC_FAILED-source row" instruction) -- a real
    // run's outcome for those rows is fully described by soldCount (if
    // acknowledged) or warningUnacknowledged (if not), so this stays empty
    // here rather than duplicating warningUnacknowledged's content.
    qcFailedPreview: [],
    warningUnacknowledgedCount: warningUnacknowledged.length,
    warningUnacknowledged,
  }
}
