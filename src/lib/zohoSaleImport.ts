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

  // Matched an IMEI we hold. If this row hasn't been sold yet (status
  // available / no out_contact_id), there's nothing to attribute this run.
  const outContactId = row.out_contact_id.trim()
  if (!outContactId) {
    return { outcome: 'skipped_available', serialCode, imei: matchedImei }
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
