// Sprint B §1/§4 — bill builder (purchase + repair, one builder), close
// rules, and repair-bill control. Pure-function tests, no HTTP/DB needed
// (billBuilder.ts is pure — same convention as oprImport.ts).
import { describe, expect, it } from 'vitest'
import {
  buildBill,
  groupContinuationRows,
  checkBillCloseable,
  checkRepairBillAgainstDeclaredCharge,
  round2,
  type BillImportRow,
  type BillHeaderInput,
} from '../src/lib/billBuilder'

// Distinct valid Luhn IMEIs for this suite (base 35696540...).
let seq = 0
function luhnImei(): string {
  const body = `3569654${String(10000000 + seq++).slice(1)}`
  let sum = 0
  for (let i = 0; i < 14; i++) {
    let d = Number(body[i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return body + String((10 - (sum % 10)) % 10)
}

const gbpPurchaseHeader: BillHeaderInput = {
  bill_type: 'purchase',
  vendor_name: 'LW001',
  bill_date: '2026-06-01',
  invoice_number: 'INV-LW001-001',
  currency_code: 'GBP',
  price_source: 'per_imei',
  declared_total: 0, // filled per test
  unit_count: 0,
}

describe('buildBill — per_imei GBP purchase (the mandatory pricing mode)', () => {
  it('builds one line per IMEI with distinct prices — a header total could not reconstruct £160 vs £182', () => {
    const imei1 = luhnImei()
    const imei2 = luhnImei()
    const rows: BillImportRow[] = [
      { sku: 'APL-I17-256-BLK-A', description: 'iPhone 17 256GB Black A', imei: imei1, unit_price: 160 },
      { sku: 'APL-I17-256-BLK-A', description: 'iPhone 17 256GB Black A', imei: imei2, unit_price: 182 },
    ]
    const header = { ...gbpPurchaseHeader, declared_total: 342, unit_count: 2 }
    const result = buildBill(header, rows)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines).toHaveLength(2)
    expect(result.lines[0].unit_price_gbp).toBe(160)
    expect(result.lines[1].unit_price_gbp).toBe(182)
    expect(result.gbp_total).toBe(342)
    expect(result.header_residual_gbp).toBeNull() // GBP bill — no conversion, no residual concept
  })

  it('rejects the file outright on a within-bill duplicate IMEI (not just a flag)', () => {
    const dupe = luhnImei()
    const rows: BillImportRow[] = [
      { sku: 'APL-I17-256-BLK-A', description: 'x', imei: dupe, unit_price: 160 },
      { sku: 'APL-I17-256-BLK-A', description: 'x', imei: dupe, unit_price: 182 },
    ]
    const header = { ...gbpPurchaseHeader, declared_total: 342, unit_count: 2 }
    const result = buildBill(header, rows)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/Duplicate IMEI/)
    expect(result.within_bill_duplicate_imeis).toContain(dupe)
  })

  it('flags a cross-bill duplicate IMEI for manager review but does NOT block the build', () => {
    const seen = luhnImei()
    const rows: BillImportRow[] = [
      { sku: 'APL-I17-256-BLK-A', description: 'x', imei: seen, unit_price: 170 },
    ]
    const header = { ...gbpPurchaseHeader, declared_total: 170, unit_count: 1 }
    const result = buildBill(header, rows, new Set([seen]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.cross_bill_duplicate_imeis).toContain(seen)
  })

  it('drops non-IMEI lines (a row with no serial and no attachable priced row) rather than failing the whole file', () => {
    const good = luhnImei()
    const rows: BillImportRow[] = [
      { sku: 'JUNK', description: 'no imei anywhere', unit_price: 99 },
      { sku: 'APL-I17-256-BLK-A', description: 'x', imei: good, unit_price: 170 },
    ]
    const header = { ...gbpPurchaseHeader, declared_total: 170, unit_count: 1 }
    const result = buildBill(header, rows)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0].imeis).toEqual([good])
    // The junk row (has key cols but no attachable IMEI) surfaces as an
    // invalid row, demonstrating it was seen and rejected, not silently
    // vanished.
    expect(result.invalid_rows.some(r => r.reason.includes('No valid IMEI'))).toBe(true)
  })

  it('enforces count(serials) == Quantity on a per_line row with a declared quantity mismatch', () => {
    const a = luhnImei()
    const rows: BillImportRow[] = [
      { sku: 'APL-I17-256-BLK-A', description: 'x', imei: a, unit_price: 170, quantity: 2 },
    ]
    const header: BillHeaderInput = { ...gbpPurchaseHeader, price_source: 'per_line', declared_total: 170, unit_count: 1 }
    const result = buildBill(header, rows)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.invalid_rows?.some(r => r.reason.includes('does not match'))).toBe(true)
  })
})

describe('groupContinuationRows — blank-key-column grouping (documented pick-and-note rule)', () => {
  it('folds a blank-key-column row with an IMEI into the preceding priced row', () => {
    const a = luhnImei()
    const b = luhnImei()
    const rows: BillImportRow[] = [
      { sku: 'X', description: 'priced', imei: a, unit_price: 100 },
      { imei: b }, // continuation: blank sku/description/unit_price, has imei
    ]
    const { groups, invalid } = groupContinuationRows(rows)
    expect(invalid).toHaveLength(0)
    expect(groups).toHaveLength(1)
    expect(groups[0].imeis.map(x => x.imei)).toEqual([a, b])
  })

  it('rejects a continuation row that appears BEFORE any priced row (nothing to attach to)', () => {
    const a = luhnImei()
    const rows: BillImportRow[] = [{ imei: a }]
    const { groups, invalid } = groupContinuationRows(rows)
    expect(groups).toHaveLength(0)
    expect(invalid).toHaveLength(1)
    expect(invalid[0].reason).toMatch(/no preceding priced row/)
  })
})

describe('buildBill — multi-currency: convert per line, never apportion a converted header total', () => {
  it('USD bill: sums independently-rounded per-line GBP figures; stores any header/line-sum gap as header_residual_gbp', () => {
    const a = luhnImei()
    const b = luhnImei()
    const c = luhnImei()
    // exchange_rate convention (matches computeCe1154()): foreign-currency
    // units per £1, so GBP = amount / rate. 1.27 USD per £1 is a
    // plausible GBP/USD rate that also produces a real, non-zero
    // per-line rounding residual against the header total.
    const rate = 1.27
    const header: BillHeaderInput = {
      bill_type: 'purchase',
      vendor_name: 'Test Vendor USD',
      bill_date: '2026-06-01',
      invoice_number: 'INV-USD-001',
      currency_code: 'USD',
      exchange_rate: rate,
      rate_date: '2026-06-01',
      rate_source: 'manual',
      price_source: 'per_imei',
      declared_total: 300, // 100 + 100 + 100 USD
      unit_count: 3,
    }
    const rows: BillImportRow[] = [
      { sku: 'X', description: 'x', imei: a, unit_price: 100 },
      { sku: 'X', description: 'x', imei: b, unit_price: 100 },
      { sku: 'X', description: 'x', imei: c, unit_price: 100 },
    ]
    const result = buildBill(header, rows)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const line of result.lines) {
      expect(line.unit_price_gbp).toBe(round2(100 / rate))
    }
    const expectedSum = round2(round2(100 / rate) * 3)
    expect(result.gbp_total).toBe(expectedSum)
    const headerConvertedDirect = round2(300 / rate)
    expect(result.header_residual_gbp).toBe(round2(headerConvertedDirect - expectedSum))
  })

  it('rejects a non-GBP bill with no exchange_rate supplied', () => {
    const header: BillHeaderInput = {
      bill_type: 'purchase',
      vendor_name: 'V',
      bill_date: '2026-06-01',
      invoice_number: 'I',
      currency_code: 'AED',
      price_source: 'header',
      declared_total: 100,
      unit_count: 1,
    }
    const result = buildBill(header, [])
    expect(result.ok).toBe(false)
  })
})

describe('checkBillCloseable — sum(lines) must equal header total unless force-closed', () => {
  it('reports closeable when the sums match exactly', () => {
    expect(checkBillCloseable(342, 342)).toEqual({ ok: true })
  })

  it('reports NOT closeable with the exact variance when sums differ', () => {
    const r = checkBillCloseable(342.5, 342)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.variance_gbp).toBe(0.5)
  })
})

describe('checkRepairBillAgainstDeclaredCharge (§4) — ties per-IMEI repair lines to the customs-declared process charge', () => {
  it('R1: matches when the lines sum to exactly £1,556.09 (the real, already-declared R1 process charge)', () => {
    const r = checkRepairBillAgainstDeclaredCharge(1556.09, 1556.09)
    expect(r.matches).toBe(true)
    expect(r.variance_gbp).toBe(0)
  })

  it('R2: flags variance rather than silently reconciling when lines do not tie to £1,345.63', () => {
    const r = checkRepairBillAgainstDeclaredCharge(1400.00, 1345.63)
    expect(r.matches).toBe(false)
    expect(r.variance_gbp).toBe(round2(1400.00 - 1345.63))
  })
})
