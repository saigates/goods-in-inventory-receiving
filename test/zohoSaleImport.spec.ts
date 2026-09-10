// Zoho Inwards/Outwards sale-attribution importer — pure classification
// logic (src/lib/zohoSaleImport.ts). No D1, no HTTP.
//
// UPDATE (2026-09-09): applyZohoSaleImport (the D1-backed write function)
// now exists in src/lib/zohoSaleImport.ts and IS tested — see
// test/zohoSaleImportApply.spec.ts, the D1-backed HTTP-level companion
// file (IMEI prefix 8604570, claimed in test/browser/README.md in the
// same commit). This file stays pure-function-only by design; it is not
// being extended to cover the write path.
//
// IMEI-registry note: every fixture "serial code" in this file is a
// PLAIN STRING passed straight into classifyRow()'s knownImeisUpper Set —
// none of it is ever written to received_devices (no D1 binding is used
// anywhere in this file), so the collision this file's fixtures could
// cause is with EACH OTHER within a single test, never with the shared
// received_devices UNIQUE(imei) constraint or any other suite's rows.
// This file therefore claims no registry prefix — see
// test/zohoSaleImportApply.spec.ts for the file that does.
import { describe, expect, it } from 'vitest'
import {
  classifySerialShape,
  normaliseSerialForMatch,
  classifyDisposition,
  ZOHO_CONTACT_DISPOSITION_MAP,
  gbpStringToPence,
  classifyRow,
  classifyZohoCsvRows,
  parseZohoCsv,
  resolveZohoRowForCode,
  ZOHO_CSV_HEADERS,
  type ZohoCsvRow,
} from '../src/lib/zohoSaleImport'

// A known SALE_EXTERNAL contact id from the mapping table, used across
// several tests below without repeating the raw literal.
const SALE_EXTERNAL_CONTACT_ID = '251444000000060479' // Amazon UK - Customer
const FBA_TRANSFER_CONTACT_ID = '251444000345383017' // Amazon FBA
const GRADE_CHANGE_OUT_CONTACT_ID = '251444000065690570' // GR CHANGE AUTO OUT
const RETURN_TO_SUPPLIER_CONTACT_ID = '251444000347365746' // SW001

function makeRow(overrides: Partial<ZohoCsvRow> = {}): ZohoCsvRow {
  const base: ZohoCsvRow = {
    product_name: 'IPHONE 13-128GB/BLACK/A',
    serial_number_item_id: '251444000067528154',
    sku: 'I13-128-BLK-A',
    serial_number_code: '351264783478842',
    status: 'sold',
    in_entity: 'BILL-0001',
    in_entity_type: 'bill',
    in_entity_id: '251444000000000001',
    in_entity_number: 'BILL-0001',
    in_contact_id: '251444000000000002',
    in_contact_name: 'Some Supplier',
    in_entity_date: '2026-08-05',
    out_entity: 'INV-0001',
    out_entity_type: 'invoice',
    out_entity_id: '251444000000000003',
    out_entity_number: 'INV-0001',
    out_entity_date: '2026-08-10',
    out_contact_id: SALE_EXTERNAL_CONTACT_ID,
    out_contact_name: 'Amazon UK - Customer',
    line_item_location_id: '251444000000000004',
    line_item_location_name: 'Main Warehouse',
    cost_price: '200.00',
    sold_price: '260.00',
    profit: '60.00',
    item_status: 'active',
  }
  return { ...base, ...overrides }
}

describe('classifySerialShape', () => {
  it('classifies an exact 15-digit numeric string as imei_15_digit, Luhn or not', () => {
    // 861669048498974 is the confirmed real Luhn-INVALID counter-example
    // from the reconnaissance note (Section 6) — must still classify as
    // imei_15_digit, since shape classification never gates on Luhn.
    expect(classifySerialShape('861669048498974')).toBe('imei_15_digit')
    expect(classifySerialShape('351264783478842')).toBe('imei_15_digit')
  })

  it('classifies an exact 10-character alphanumeric string as alnum_10', () => {
    expect(classifySerialShape('ABCDEFGH12')).toBe('alnum_10')
  })

  it('classifies anything else (wrong length, mixed shape, 16-digit IMEISV) as other', () => {
    expect(classifySerialShape('RFAR72WAX0L')).toBe('other') // 11 chars
    expect(classifySerialShape('C02W63V9HV2L')).toBe('other') // 12 chars
    expect(classifySerialShape('3356295608925687')).toBe('other') // 16-digit
    expect(classifySerialShape('12345')).toBe('other') // too short to be either shape
  })
})

describe('normaliseSerialForMatch', () => {
  it('uppercases and trims, so case and incidental whitespace never block a match', () => {
    // rfat12vx6ey / RFAT12VX6EY is the real case-difference pair cited in
    // the reconnaissance note (Section 6).
    expect(normaliseSerialForMatch('rfat12vx6ey')).toBe('RFAT12VX6EY')
    expect(normaliseSerialForMatch('  351264783478842  ')).toBe('351264783478842')
  })
})

describe('classifyDisposition — the out_contact_id -> Disposition map', () => {
  it('maps every mapping-table entry to its documented disposition', () => {
    expect(classifyDisposition(SALE_EXTERNAL_CONTACT_ID)).toBe('SALE_EXTERNAL')
    expect(classifyDisposition(FBA_TRANSFER_CONTACT_ID)).toBe('FBA_TRANSFER')
    expect(classifyDisposition(GRADE_CHANGE_OUT_CONTACT_ID)).toBe('GRADE_CHANGE_OUT')
    expect(classifyDisposition(RETURN_TO_SUPPLIER_CONTACT_ID)).toBe('RETURN_TO_SUPPLIER')
  })

  it('an out_contact_id NOT in the mapping table classifies as UNCLASSIFIED, never defaults to SALE_EXTERNAL', () => {
    // A future Zoho contact this dataset has never seen. This is the
    // failure mode the reconnaissance note explicitly forbids silently
    // defaulting away: an unmapped id must never be treated as revenue.
    expect(classifyDisposition('251444000999999999')).toBe('UNCLASSIFIED')
  })

  it('a blank out_contact_id (device not yet sold) classifies as UNCLASSIFIED', () => {
    expect(classifyDisposition('')).toBe('UNCLASSIFIED')
    expect(classifyDisposition('   ')).toBe('UNCLASSIFIED')
  })

  it('the two TEMU contact_ids (name collision, confirmed distinct ids) both map correctly and independently', () => {
    // Reconnaissance note Section 3: 'TEMU' is the display name for TWO
    // different out_contact_id values. The map must be keyed on id, never
    // name, so both resolve correctly despite sharing a name.
    expect(classifyDisposition('251444000458664685')).toBe('SALE_EXTERNAL')
    expect(classifyDisposition('251444000458172774')).toBe('SALE_EXTERNAL')
  })

  it('the mapping table has no accidental duplicate-id entries collapsing to the wrong count', () => {
    // 21 non-blank out_contact_id values were confirmed in the
    // reconnaissance note's mandated aggregation (Section 3) plus this
    // turn's STILL OPEN #1 verification (0 collisions with out_entity_type).
    expect(Object.keys(ZOHO_CONTACT_DISPOSITION_MAP)).toHaveLength(21)
  })
})

describe('gbpStringToPence — decimal-string to integer-pence, never through a float', () => {
  it('parses a plain two-decimal amount exactly', () => {
    expect(gbpStringToPence('260.00')).toBe(26000)
    expect(gbpStringToPence('450.00')).toBe(45000)
  })

  it('parses a whole-pound amount with no decimal point', () => {
    expect(gbpStringToPence('100')).toBe(10000)
  })

  it('parses a single-decimal-digit amount by treating it as tenths', () => {
    expect(gbpStringToPence('80.5')).toBe(8050)
  })

  it('parses a value classically prone to float rounding noise (e.g. 0.29, 19.9x) exactly', () => {
    // The whole point of parsing via regex + parseInt rather than
    // parseFloat()*100 is to avoid exactly this class of error.
    expect(gbpStringToPence('19.99')).toBe(1999)
    expect(gbpStringToPence('0.29')).toBe(29)
    expect(gbpStringToPence('439.95')).toBe(43995)
  })

  it('returns null for a blank string, never coercing to 0 silently', () => {
    expect(gbpStringToPence('')).toBeNull()
    expect(gbpStringToPence('   ')).toBeNull()
  })

  it('returns null for a non-numeric string rather than throwing or silently returning NaN/0', () => {
    expect(gbpStringToPence('N/A')).toBeNull()
    expect(gbpStringToPence('abc')).toBeNull()
  })

  it('handles a negative amount (credit-note style) correctly, sign only on the whole part', () => {
    expect(gbpStringToPence('-50.00')).toBe(-5000)
  })
})

describe('parseZohoCsv — header-name parsing, never column position (2026-09-09 scope ruling)', () => {
  it('parses a well-formed file with all 25 required headers present, in the documented order', () => {
    const csv = [ZOHO_CSV_HEADERS.join(','), 'A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P,Q,R,S,T,U,V,W,X,Y'].join('\n')
    const result = parseZohoCsv(csv)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].product_name).toBe('A')
    expect(result.rows[0].item_status).toBe('Y')
  })

  it('parses correctly even when the real file reorders columns, because it reads by header NAME not position', () => {
    // This is the direct test of the "parse by header name, never by
    // column position" mandate: swap two columns' physical order in the
    // header row and confirm each value still lands under the correct
    // field name, not the field that used to sit at that index.
    const reorderedHeaders = [...ZOHO_CSV_HEADERS]
    const i = reorderedHeaders.indexOf('serial_number_code')
    const j = reorderedHeaders.indexOf('out_contact_id')
    ;[reorderedHeaders[i], reorderedHeaders[j]] = [reorderedHeaders[j], reorderedHeaders[i]]

    const dataRow = reorderedHeaders.map(h => (h === 'serial_number_code' ? 'SWAPPED-SERIAL' : h === 'out_contact_id' ? 'SWAPPED-CONTACT-ID' : 'x'))
    const csv = [reorderedHeaders.join(','), dataRow.join(',')].join('\n')

    const result = parseZohoCsv(csv)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows[0].serial_number_code).toBe('SWAPPED-SERIAL')
    expect(result.rows[0].out_contact_id).toBe('SWAPPED-CONTACT-ID')
  })

  it('fails loudly (ok:false) when a required header is missing, rather than silently misreading a column', () => {
    const headersMinusOne = ZOHO_CSV_HEADERS.filter(h => h !== 'out_contact_id')
    const csv = [headersMinusOne.join(','), headersMinusOne.map(() => 'x').join(',')].join('\n')
    const result = parseZohoCsv(csv)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('out_contact_id')
  })

  it('rejects an empty file rather than returning an empty-but-ok result', () => {
    const result = parseZohoCsv('')
    expect(result.ok).toBe(false)
  })

  it('does not inflate the row count from a single trailing blank line', () => {
    const csv = [ZOHO_CSV_HEADERS.join(','), ZOHO_CSV_HEADERS.map(() => 'x').join(','), ''].join('\n')
    const result = parseZohoCsv(csv)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toHaveLength(1)
    expect(result.fileLineCount).toBe(1)
  })
})

describe('parseZohoCsv — FILE-SHAPE GATE (2026-09-10 incident response): reject a wholly-Inwards export', () => {
  function rowWith(overrides: Partial<Record<string, string>>): string {
    const values = ZOHO_CSV_HEADERS.map(h => (h in overrides ? (overrides as any)[h] : 'x'))
    return values.join(',')
  }

  it('rejects a wholly-inwards file (out_entity_date AND out_contact_id blank on EVERY row) with a clear reason, not a silent empty-ish ok:true', () => {
    const csv = [
      ZOHO_CSV_HEADERS.join(','),
      rowWith({ out_entity_date: '', out_contact_id: '' }),
      rowWith({ out_entity_date: '', out_contact_id: '' }),
      rowWith({ out_entity_date: '', out_contact_id: '' }),
    ].join('\n')

    const result = parseZohoCsv(csv)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('out_entity_date')
    expect(result.error).toContain('out_contact_id')
  })

  it('a normal outwards file (every row has both out_entity_date and out_contact_id populated) is unaffected', () => {
    const csv = [
      ZOHO_CSV_HEADERS.join(','),
      rowWith({ out_entity_date: '2026-08-10', out_contact_id: '251444000000060479' }),
      rowWith({ out_entity_date: '2026-08-11', out_contact_id: '251444000000060479' }),
    ].join('\n')

    const result = parseZohoCsv(csv)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toHaveLength(2)
  })

  it('a mixed file — some rows lack out_contact_id but at least one row carries real out-side data — is NOT rejected, and per-row classification (skipped_available/UNCLASSIFIED) is unaffected by this gate', () => {
    const csv = [
      ZOHO_CSV_HEADERS.join(','),
      // Genuinely idle stock: no out-side data at all on this row.
      rowWith({ status: 'available', out_entity_date: '', out_contact_id: '', out_entity_type: '', sold_price: '' }),
      // A real outwards row with a populated out_entity_date, proving the
      // file as a whole is NOT wholly-inwards.
      rowWith({ out_entity_date: '2026-08-12', out_contact_id: '251444000000060479' }),
    ].join('\n')

    const result = parseZohoCsv(csv)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toHaveLength(2)
    // The gate must not have touched per-row content — the first row's
    // fields remain exactly as submitted, still eligible for
    // classifyRow()'s existing skipped_available narrowing downstream.
    expect(result.rows[0].out_contact_id).toBe('')
    expect(result.rows[0].out_entity_date).toBe('')
    expect(result.rows[1].out_entity_date).toBe('2026-08-12')
  })
})

describe('resolveZohoRowForCode — grade-change-reuse guard (reconnaissance note Section 2)', () => {
  it('returns the single row unchanged when only one row exists for a code', () => {
    const row = makeRow()
    expect(resolveZohoRowForCode([row])).toBe(row)
  })

  it('returns null for an empty list', () => {
    expect(resolveZohoRowForCode([])).toBeNull()
  })

  it('picks the MOST RECENT out_entity_date leg when a code has multiple sold rows (re-grade history)', () => {
    const earlierLeg = makeRow({ out_entity_date: '2026-07-14', out_entity_number: 'INV-EARLY', sku: 'I13-128-BLK-B' })
    const laterLeg = makeRow({ out_entity_date: '2026-09-07', out_entity_number: 'INV-LATE', sku: 'I13-128-BLK-A' })
    const resolved = resolveZohoRowForCode([earlierLeg, laterLeg])
    expect(resolved).toBe(laterLeg)
  })

  it('prefers a sold row over an unsold (no out_entity_date) row for the same code', () => {
    const unsoldLeg = makeRow({ out_entity_date: '', out_contact_id: '', status: 'available' })
    const soldLeg = makeRow({ out_entity_date: '2026-08-10' })
    const resolved = resolveZohoRowForCode([unsoldLeg, soldLeg])
    expect(resolved).toBe(soldLeg)
  })

  it('falls back to the first row when NONE of the multiple rows have a sale date', () => {
    const a = makeRow({ out_entity_date: '', out_contact_id: '', serial_number_item_id: 'A' })
    const b = makeRow({ out_entity_date: '', out_contact_id: '', serial_number_item_id: 'B' })
    expect(resolveZohoRowForCode([a, b])).toBe(a)
  })
})

describe('classifyRow — INNER JOIN CONTRACT (2026-09-09 scope ruling)', () => {
  it('returns null for a serial with NO matching received_devices.imei — no outcome, not a counted/reported one', () => {
    const row = makeRow({ serial_number_code: 'NOT-IN-GOODS-IN-999999' })
    const result = classifyRow(row, new Set(['SOME-OTHER-IMEI']))
    expect(result).toBeNull()
  })

  it('this holds regardless of serial shape — a 15-digit-looking non-match still returns null, not a shape-tagged outcome', () => {
    const row = makeRow({ serial_number_code: '999999999999999' })
    const result = classifyRow(row, new Set(['351264783478842']))
    expect(result).toBeNull()
  })

  it('matches case-insensitively against the known-IMEI set', () => {
    const row = makeRow({
      serial_number_code: 'rfat12vx6ey', out_contact_id: '',
      status: 'available', out_entity_type: '', out_entity_number: '', out_entity_date: '', sold_price: '',
    })
    const result = classifyRow(row, new Set(['RFAT12VX6EY']))
    expect(result).not.toBeNull()
    expect(result?.outcome).toBe('skipped_available')
  })

  it('a matched device with a blank out_contact_id AND no out-side data at all (status=available, blank out_entity_type, blank sold_price) is skipped_available', () => {
    const row = makeRow({
      out_contact_id: '',
      status: 'available', out_entity_type: '', out_entity_number: '', out_entity_date: '', sold_price: '',
    })
    const result = classifyRow(row, new Set([row.serial_number_code]))
    expect(result).toEqual({ outcome: 'skipped_available', serialCode: row.serial_number_code, imei: row.serial_number_code })
  })

  it('DEVELOPER INSTRUCTION 2026-09-09 (item 2 narrowing): a blank out_contact_id WITH real out-side data (an Outwards row that moved out but has no classifier) is matched_unclassified, NOT skipped_available -- this row shape does not occur in the 2026-09-09 sample (its 525 blanks are all Inwards/available/no-sold_price by construction) and must be constructed deliberately here so the 1 Aug real file cannot silently vanish a genuine outbound movement into the available bucket', () => {
    const row = makeRow({
      out_contact_id: '', out_contact_name: '',
      status: 'sold', out_entity_type: 'invoice', out_entity_number: 'INV-0555', out_entity_date: '2026-08-12',
      sold_price: '199.00',
    })
    const result = classifyRow(row, new Set([row.serial_number_code]))
    expect(result).toEqual({
      outcome: 'matched_unclassified',
      serialCode: row.serial_number_code,
      imei: row.serial_number_code,
      outContactId: '',
      outContactName: '',
    })
  })

  it('DEVELOPER INSTRUCTION 2026-09-09: a blank out_contact_id with sold_price populated alone (even if status/out_entity_type still read available/blank) is matched_unclassified -- any ONE of the three out-side signals is enough to disqualify skipped_available', () => {
    const row = makeRow({
      out_contact_id: '', out_contact_name: '',
      status: 'available', out_entity_type: '', out_entity_number: '', out_entity_date: '',
      sold_price: '50.00',
    })
    const result = classifyRow(row, new Set([row.serial_number_code]))
    expect(result?.outcome).toBe('matched_unclassified')
  })

  it('a matched SALE_EXTERNAL row classifies as matched_sale with pence-parsed sold price', () => {
    const row = makeRow({ out_contact_id: SALE_EXTERNAL_CONTACT_ID, sold_price: '260.00', out_entity_number: 'INV-0099', out_entity_date: '2026-08-10' })
    const result = classifyRow(row, new Set([row.serial_number_code]))
    expect(result).toEqual({
      outcome: 'matched_sale',
      serialCode: row.serial_number_code,
      imei: row.serial_number_code,
      disposition: 'SALE_EXTERNAL',
      soldPricePence: 26000,
      invoiceNo: 'INV-0099',
      saleDate: '2026-08-10',
      outContactId: SALE_EXTERNAL_CONTACT_ID,
    })
  })

  it('FBA_TRANSFER hard rule: creditValuePence is ALWAYS null, even though sold_price is populated', () => {
    // The flat £450 on this row must never land in a money column.
    const row = makeRow({ out_contact_id: FBA_TRANSFER_CONTACT_ID, sold_price: '450.00', cost_price: '180.00' })
    const result = classifyRow(row, new Set([row.serial_number_code]))
    expect(result?.outcome).toBe('matched_non_revenue')
    if (result?.outcome !== 'matched_non_revenue') return
    expect(result.disposition).toBe('FBA_TRANSFER')
    expect(result.creditValuePence).toBeNull()
  })

  it('GRADE_CHANGE_OUT classifies as matched_non_revenue with creditValuePence null (internal move, not a credit)', () => {
    const row = makeRow({ out_contact_id: GRADE_CHANGE_OUT_CONTACT_ID, sold_price: '300.00' })
    const result = classifyRow(row, new Set([row.serial_number_code]))
    expect(result?.outcome).toBe('matched_non_revenue')
    if (result?.outcome !== 'matched_non_revenue') return
    expect(result.disposition).toBe('GRADE_CHANGE_OUT')
    expect(result.creditValuePence).toBeNull()
  })

  it('RETURN_TO_SUPPLIER classifies as matched_non_revenue WITH a populated creditValuePence (the one disposition that carries a value)', () => {
    const row = makeRow({ out_contact_id: RETURN_TO_SUPPLIER_CONTACT_ID, sold_price: '260.00', cost_price: '135.00' })
    const result = classifyRow(row, new Set([row.serial_number_code]))
    expect(result?.outcome).toBe('matched_non_revenue')
    if (result?.outcome !== 'matched_non_revenue') return
    expect(result.disposition).toBe('RETURN_TO_SUPPLIER')
    expect(result.creditValuePence).toBe(26000)
  })

  it('an out_contact_id absent from the mapping table classifies as matched_unclassified, never as matched_sale', () => {
    const row = makeRow({ out_contact_id: '251444000999999999', out_contact_name: 'FUTURE UNKNOWN CONTACT' })
    const result = classifyRow(row, new Set([row.serial_number_code]))
    expect(result).toEqual({
      outcome: 'matched_unclassified',
      serialCode: row.serial_number_code,
      imei: row.serial_number_code,
      outContactId: '251444000999999999',
      outContactName: 'FUTURE UNKNOWN CONTACT',
    })
  })
})

describe('classifyZohoCsvRows — batch classification, no unmatched counter anywhere (2026-09-09 scope ruling)', () => {
  it('ZohoImportSummary carries no unmatched/unattributed field at all', () => {
    const rows = [makeRow({ serial_number_code: 'NO-MATCH-AT-ALL' })]
    const summary = classifyZohoCsvRows(rows, new Set())
    expect(summary).not.toHaveProperty('unmatchedNoDeviceCount')
    expect(summary).not.toHaveProperty('unmatchedSerialShapeCount')
    expect(summary).not.toHaveProperty('unattributedTotal')
  })

  it('a non-matching serial produces zero outcomes and does not inflate any count', () => {
    const rows = [makeRow({ serial_number_code: 'NO-MATCH-AT-ALL' })]
    const summary = classifyZohoCsvRows(rows, new Set())
    expect(summary.outcomes).toHaveLength(0)
    expect(summary.matchedSaleCount).toBe(0)
    expect(summary.matchedNonRevenueCount).toBe(0)
    expect(summary.matchedUnclassifiedCount).toBe(0)
    expect(summary.skippedAvailableCount).toBe(0)
    // totalRows still reflects the raw parsed input, as a parse-time fact
    // only -- never implied as an expected outcome denominator.
    expect(summary.totalRows).toBe(1)
  })

  it('a mixed batch of matched-sale, matched-non-revenue, matched-unclassified, skipped-available and non-matching rows counts only the matched ones', () => {
    const rows = [
      makeRow({ serial_number_code: 'MATCH-SALE', out_contact_id: SALE_EXTERNAL_CONTACT_ID }),
      makeRow({ serial_number_code: 'MATCH-FBA', out_contact_id: FBA_TRANSFER_CONTACT_ID }),
      makeRow({ serial_number_code: 'MATCH-UNCLASSIFIED', out_contact_id: '251444000999999999', out_contact_name: 'UNKNOWN' }),
      makeRow({
        serial_number_code: 'MATCH-AVAILABLE', out_contact_id: '',
        status: 'available', out_entity_type: '', out_entity_number: '', out_entity_date: '', sold_price: '',
      }),
      makeRow({ serial_number_code: 'NO-MATCH-1' }),
      makeRow({ serial_number_code: 'NO-MATCH-2' }),
    ]
    const knownImeis = new Set(['MATCH-SALE', 'MATCH-FBA', 'MATCH-UNCLASSIFIED', 'MATCH-AVAILABLE'])
    const summary = classifyZohoCsvRows(rows, knownImeis)

    expect(summary.totalRows).toBe(6)
    expect(summary.matchedSaleCount).toBe(1)
    expect(summary.matchedNonRevenueCount).toBe(1)
    expect(summary.matchedUnclassifiedCount).toBe(1)
    expect(summary.skippedAvailableCount).toBe(1)
    // Exactly 4 outcomes -- the two non-matching rows produced NOTHING,
    // not a fifth/sixth outcome of any unmatched kind.
    expect(summary.outcomes).toHaveLength(4)
  })

  it('grade-change-reuse: two rows sharing one serial_number_code resolve to ONE outcome, not two', () => {
    const earlierLeg = makeRow({ serial_number_code: 'REUSED-CODE', out_entity_date: '2026-07-14', out_contact_id: GRADE_CHANGE_OUT_CONTACT_ID, serial_number_item_id: 'LEG-1' })
    const laterLeg = makeRow({ serial_number_code: 'REUSED-CODE', out_entity_date: '2026-09-07', out_contact_id: SALE_EXTERNAL_CONTACT_ID, serial_number_item_id: 'LEG-2' })
    const summary = classifyZohoCsvRows([earlierLeg, laterLeg], new Set(['REUSED-CODE']))
    expect(summary.outcomes).toHaveLength(1)
    expect(summary.outcomes[0].outcome).toBe('matched_sale') // the LATER leg wins, per resolveZohoRowForCode
  })
})
