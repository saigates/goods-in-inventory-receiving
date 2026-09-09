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
//   exactly one of four dispositions below. Any out_contact_id NOT in the
//   mapping table produces UNCLASSIFIED — it must NEVER silently default
//   to SALE_EXTERNAL (a silent default there is an uncaught revenue
//   overstatement).
// - Vendor credits (RETURN_TO_SUPPLIER): do NOT set status=SOLD, do NOT
//   populate sold_price_pence. Credit value goes in credit_value_pence
//   (migration 0034), never sold_price_pence. Price equality
//   (sold_price==cost_price) is explicitly NOT a detection heuristic —
//   disproven empirically (58/95 SW001 rows differ) — out_contact_id
//   membership is the only correct detector.
// - Serial shape: NO Luhn validation on Zoho-supplied serials (a real
//   counter-example, 861669048498974, is Luhn-invalid and must still be
//   considered for matching). NEVER coerce through validateImei() — a
//   non-matching-shape code gets UNMATCHED_SERIAL_SHAPE, counted and
//   reported, never silently dropped or forced through the app's IMEI
//   validator.
// - serial_number_code alone is not a safe leg-identifier WITHIN the Zoho
//   export (a physical device can be re-graded and get a new
//   serial_number_item_id/sku while keeping the same serial_number_code —
//   see the reconnaissance note Section 2). This does not affect the
//   received_devices join (an IMEI has no grade-change-reuse concept on
//   OUR side), but the importer must not assume a matched code has only
//   one candidate Zoho row if the Zoho data itself contains more than one
//   for that code — see resolveZohoRowForCode below.

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
// equality against received_devices.imei — shape is classified here only
// for REPORTING (so an operator can see why a code produced
// UNMATCHED_SERIAL_SHAPE at match time), never as a gate on whether the
// match attempt itself is made.

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
      outcome: 'unmatched_no_device'
      serialCode: string
      shape: SerialShape
    }
  | {
      outcome: 'unmatched_serial_shape'
      serialCode: string
      shape: SerialShape
    }
  | {
      outcome: 'skipped_available'
      serialCode: string
      imei: string
    }

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
export function classifyRow(
  row: ZohoCsvRow,
  knownImeisUpper: ReadonlySet<string>,
): ZohoImportOutcome {
  const serialCode = row.serial_number_code
  const normalised = normaliseSerialForMatch(serialCode)
  const shape = classifySerialShape(serialCode)
  const matchedImei = knownImeisUpper.has(normalised) ? normalised : null

  if (!matchedImei) {
    // Unmatched: distinguish "looked like a device identifier but we don't
    // hold that device" from "doesn't look like a device identifier at
    // all" — both are reported, never silently dropped, but the shape
    // distinction is preserved for the operator to act on differently
    // (a missing goods-in device vs. a genuinely non-device serial, e.g.
    // an accessory or SIM-card style code).
    if (shape === 'other') {
      return { outcome: 'unmatched_serial_shape', serialCode, shape }
    }
    return { outcome: 'unmatched_no_device', serialCode, shape }
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

export type ZohoImportSummary = {
  totalRows: number
  matchedSaleCount: number
  matchedNonRevenueCount: number
  matchedUnclassifiedCount: number
  unmatchedNoDeviceCount: number
  unmatchedSerialShapeCount: number
  skippedAvailableCount: number
  outcomes: ZohoImportOutcome[]
  // Placard counts: unattributed = every row this run did not turn into a
  // matched_sale/matched_non_revenue/matched_unclassified write. Reported
  // explicitly (never silently absorbed) per the reconnaissance note's
  // "expect a low match rate, don't treat it as failure" framing.
  unattributedTotal: number
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

  const outcomes: ZohoImportOutcome[] = []
  for (const [, codeRows] of byCode) {
    const resolved = resolveZohoRowForCode(codeRows)
    if (!resolved) continue
    outcomes.push(classifyRow(resolved, knownImeisUpper))
  }

  const count = (o: ZohoImportOutcome['outcome']) => outcomes.filter(x => x.outcome === o).length
  const matchedSaleCount = count('matched_sale')
  const matchedNonRevenueCount = count('matched_non_revenue')
  const matchedUnclassifiedCount = count('matched_unclassified')
  const unmatchedNoDeviceCount = count('unmatched_no_device')
  const unmatchedSerialShapeCount = count('unmatched_serial_shape')
  const skippedAvailableCount = count('skipped_available')

  return {
    totalRows: rows.length,
    matchedSaleCount,
    matchedNonRevenueCount,
    matchedUnclassifiedCount,
    unmatchedNoDeviceCount,
    unmatchedSerialShapeCount,
    skippedAvailableCount,
    outcomes,
    unattributedTotal: unmatchedNoDeviceCount + unmatchedSerialShapeCount,
  }
}
