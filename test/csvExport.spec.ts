// CSV export shape + filter integrity (GET /api/devices/export/csv).
//
// This endpoint was the last item on the "manual/live-verified only" list in
// the README: it had been exercised with curl but never asserted. That is a
// bad place to have no coverage, because a CSV export is an AUDIT ARTEFACT —
// if it silently omits or mangles rows, the operator has no way to tell from
// looking at the file. Every test here therefore asserts the exact bytes the
// endpoint produces, not just a 200.
//
// Runs against the REAL Hono app + REAL D1 binding (all migrations applied).
//
// The three classes of defect this suite exists to prevent:
//   1. Silent truncation / silent omission — a filter typo or an over-cap
//      selection must be a loud error, never a short file that looks valid.
//   2. Structural corruption — a value containing a comma, quote, CR or LF
//      must not be able to split or shift columns (RFC 4180 quoting).
//   3. Cross-tenant leakage — another organisation's devices must never
//      appear, on any filter path.
//
// B3 (2026-09-07) rewrite of THIS FILE, matching the same-dated rewrite of
// src/routes/devices.ts's /export/csv handler:
//   - HEADER is now the manager/admin 18-column superset shape (STEP 1
//     column-set correction: uuid/created_at/brand/capacity/color/source
//     restored, buy_price/currency/label_printed_at dropped — see the
//     route's own module comment for the full column-by-column rationale).
//     OPERATOR_HEADER is the 15-column shape with the 3 cost columns
//     entirely absent (not blanked) for a non-manager caller.
//   - The old X-Export-Row-Count response HEADER no longer exists — the
//     route now STREAMS the CSV body (no row cap, no LIMIT/OFFSET; see the
//     route's module comment point 1), and Cloudflare Workers cannot add a
//     response header once streaming has started. The same cross-check
//     value is now the trailing `# row_count=<n>` comment line the route
//     writes as the last line of the body — every test that used to read
//     the header now reads that line instead (see `rowCountLine()` below).
//   - The old "row cap refuses truncation" describe block asserted a
//     413/EXPORT_ROW_CAP contract that no longer exists at all (the route
//     is deliberately unbounded now) — removed below, not silently
//     dropped: see the explanatory comment where it used to sit.
//   - New coverage: an operator-role case (cost columns absent from the
//     header row entirely), a >200-row no-cap fixture, and the
//     ?excel=1-vs-default IMEI encoding split.
import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'
import type { AuthUser, DeviceStatus } from '../src/types'

const JWT_SECRET = 'test-only-secret'
const testEnv = () => ({ ...(env as unknown as Record<string, unknown>), JWT_SECRET })
const db = () => (env as unknown as { DB: D1Database }).DB

// Matches the admin user seeded by migration 0008 (org 1 = Saigates Limited).
// requireManager() → true (role 'admin'), so this fixture exercises the
// manager/18-column header shape throughout.
const ADMIN: AuthUser = {
  id: 1,
  email: 'admin@goodsin.local',
  name: 'Seed Admin',
  role: 'admin',
  organisation_id: 1,
}

// New (B4, 2026-09-07): an operator-role fixture, same org as ADMIN, purely
// in-memory (signAuthToken doesn't require a users table row — the route
// only reads role/org_id off the verified JWT claims, never re-queries
// `users`). requireManager() → false, so this exercises the 15-column
// non-manager header shape and the "cost columns absent entirely" contract.
const OPERATOR: AuthUser = {
  id: 4243,
  email: 'operator-csv@example.com',
  name: 'Operator CSV User',
  role: 'operator',
  organisation_id: 1,
}

// A second org, to prove the export is org-scoped on every path.
const OTHER_ORG_USER: AuthUser = {
  id: 4242,
  email: 'other-csv@example.com',
  name: 'Other Org CSV User',
  role: 'admin',
  organisation_id: 42,
}

let token: string
let operatorToken: string
let otherToken: string

// Distinct IMEI range from every other suite (files run in parallel and
// received_devices.imei is UNIQUE).
let imeiSeq = 35911220000000
function nextImei(): string {
  return String(imeiSeq++)
}

// Inserted device ids, so this suite can clean up exactly what it created
// and leave the shared local D1 as it found it.
const createdIds: number[] = []
// Bill/bill_lines rows created for the bill_ref coverage, cleaned up
// separately (received_devices has no FK to these — cost_ledger does, and
// cost_ledger rows themselves are cleaned via ON DELETE from the device row
// only if such a cascade exists; to stay correct regardless, this suite
// deletes cost_ledger / bill_lines / bills rows it created explicitly).
const createdBillLineIds: number[] = []
const createdBillIds: number[] = []
const createdSupplierIds: number[] = []

type SeedRow = {
  imei?: string
  sku?: string
  brand?: string | null
  model?: string | null
  capacity?: string | null
  color?: string | null
  grade?: 'A' | 'B' | 'C' | 'UG'
  status?: DeviceStatus
  source?: 'manifest' | 'unreconciled' | 'manual'
  vat_type?: string | null
  organisation_id?: number
  supplier_id?: number | null
  received_at?: string | null
}

// Inserts directly (bypassing the intake API) so each test controls the exact
// stored bytes — including values intake would normalise away, which is the
// point: the export must survive whatever is already in the ledger.
//
// buy_price/currency/label_printed_at are still real columns on
// received_devices (unchanged by B3 — B3 only changed what the EXPORT
// selects, not the schema) and are still populated here with harmless
// defaults so this insert matches the table's NOT NULL constraints (currency
// defaults NOT NULL 'GBP' at the schema level) — but no test in this file
// asserts on their exported VALUE, because none of the three is in either
// header shape any more.
async function seedDevice(row: SeedRow = {}): Promise<number> {
  const imei = row.imei ?? nextImei()
  const res = await db()
    .prepare(
      `INSERT INTO received_devices
         (organisation_id, uuid, imei, sku, brand, model, capacity, color, grade,
          source, status, buy_price, currency, vat_type, label_printed_at, created_at,
          supplier_id, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.organisation_id ?? 1,
      `csv-export-uuid-${imei}`,
      imei,
      row.sku ?? 'CSV-TEST-SKU',
      // NOTE: `=== undefined`, not `??` — an explicitly-passed `null` must
      // reach the DB as NULL (that is exactly what the null-rendering test
      // needs to seed), and `??` would substitute the default instead.
      row.brand === undefined ? 'Apple' : row.brand,
      row.model === undefined ? 'iPhone 13' : row.model,
      row.capacity === undefined ? '128GB' : row.capacity,
      row.color === undefined ? 'Silver' : row.color,
      row.grade ?? 'B',
      row.source ?? 'manual',
      row.status ?? 'RECEIVED',
      100, // buy_price — not exported; harmless constant
      'GBP', // currency — not exported; harmless constant
      row.vat_type === undefined ? 'MARGIN' : row.vat_type,
      null, // label_printed_at — not exported
      '2026-07-01 10:00:00',
      row.supplier_id ?? null,
      row.received_at === undefined ? null : row.received_at,
    )
    .run()
  const id = res.meta.last_row_id as number
  createdIds.push(id)
  return id
}

async function seedSupplier(name: string): Promise<number> {
  const res = await db()
    .prepare(`INSERT INTO suppliers (organisation_id, name) VALUES (1, ?)`)
    .bind(name)
    .run()
  const id = res.meta.last_row_id as number
  createdSupplierIds.push(id)
  return id
}

// Minimal fixture bill + one bill_lines row, giving a real bill_line id to
// attribute a cost_ledger 'purchase' row to — same direct-INSERT convention
// as test/repairWorkflow.spec.ts's seedBillLine(), reused here so the
// bill_ref column (bills.invoice_number via cost_ledger.source_bill_line_id)
// has genuine coverage rather than being asserted only as always-NULL.
async function seedBillLine(invoiceNumber: string): Promise<number> {
  const billResult = await db()
    .prepare(
      `INSERT INTO bills
         (organisation_id, bill_type, vendor_name, bill_date, invoice_number,
          currency_code, unit_count, declared_total, price_source, status)
       VALUES (1, 'purchase', 'CSV Export Test Vendor', '2026-07-01', ?, 'GBP', 1, 249.99, 'per_imei', 'closed')`
    )
    .bind(invoiceNumber)
    .run()
  const billId = billResult.meta.last_row_id as number
  createdBillIds.push(billId)

  const lineResult = await db()
    .prepare(
      `INSERT INTO bill_lines (organisation_id, bill_id, line_no, sku, description, quantity, unit_price, unit_price_gbp)
       VALUES (1, ?, 1, 'CSV-EXPORT-LINE', 'CSV export bill_ref fixture', 1, 249.99, 249.99)`
    )
    .bind(billId)
    .run()
  const lineId = lineResult.meta.last_row_id as number
  createdBillLineIds.push(lineId)
  return lineId
}

async function seedCostLedgerRow(
  deviceId: number,
  costType: 'purchase' | 'repair',
  amountGbp: number,
  sourceBillLineId: number | null,
): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO cost_ledger
         (organisation_id, received_device_id, cost_type, amount_gbp, currency_code,
          source_bill_line_id, provenance)
       VALUES (1, ?, ?, ?, 'GBP', ?, 'supplier-invoiced')`
    )
    .bind(deviceId, costType, amountGbp, sourceBillLineId)
    .run()
}

async function exportCsv(
  query = '',
  opts: { auth?: boolean; as?: AuthUser } = {},
): Promise<{ res: Response; text: string }> {
  const headers: Record<string, string> = {}
  if (opts.auth !== false) {
    const t =
      opts.as === OTHER_ORG_USER ? otherToken : opts.as === OPERATOR ? operatorToken : token
    headers['Authorization'] = `Bearer ${t}`
  }
  const res = await app.request(`/api/devices/export/csv${query}`, { headers }, testEnv())
  const text = await res.text()
  return { res, text }
}

// The canonical header rows, asserted literally in one place so a column
// rename/reorder must be a deliberate edit to these constants.
//
// HEADER — manager/admin shape (18 columns): the STEP-1-corrected superset
// (uuid/created_at/brand/capacity/color/source restored) plus the new
// lifecycle/costing columns (vendor, bill_ref, purchase_cost_gbp,
// repair_cost_gbp) and received_date. buy_price/currency/label_printed_at
// are gone — see src/routes/devices.ts's module comment for why each one
// specifically was or wasn't restored.
const HEADER =
  'id,uuid,imei,sku,brand,model,capacity,color,grade,status,source,vat_type,created_at,received_date,vendor,bill_ref,purchase_cost_gbp,repair_cost_gbp'

// OPERATOR_HEADER — non-manager shape (15 columns): identical to HEADER
// minus the 3 cost columns, which are omitted from the header row ENTIRELY
// (not blanked) per the standing role-filtered-export rule.
const OPERATOR_HEADER =
  'id,uuid,imei,sku,brand,model,capacity,color,grade,status,source,vat_type,created_at,received_date,vendor'

// CSV is CRLF-delimited (RFC 4180). Split on CRLF only — splitting on \n
// would hide a bug where a value's bare LF creates a phantom row.
//
// The route's own trailing line (`# row_count=<n>\r\n`) itself ends in a
// CRLF, so a naive split leaves one bogus trailing empty string at the end
// of the array (e.g. ['header', 'row1', '# row_count=1', '']) — that empty
// element is an artefact of the split, not a real record, and must be
// dropped here so every caller's `.slice(1, -1)` (drop header, drop the
// row_count comment) lands on the real last data row instead of on this
// phantom empty one.
const rowsOf = (text: string) => {
  const parts = text.split('\r\n')
  if (parts.length && parts[parts.length - 1] === '') parts.pop()
  return parts
}

// The route can no longer set a response header for the row count (see the
// module comment above) — it writes a trailing `# row_count=<n>` comment
// line as the last line of the body instead. This helper reads it the same
// way a spreadsheet importer would be expected to ignore it: as a comment,
// not a data row.
function rowCountLine(text: string): number | null {
  const rows = rowsOf(text)
  const last = rows[rows.length - 1]
  const m = /^# row_count=(\d+)$/.exec(last ?? '')
  return m ? Number(m[1]) : null
}

// Parses one RFC 4180 record into fields, honouring quotes/escapes, so the
// assertions read the file the way a real spreadsheet parser does rather than
// naively splitting on commas.
function parseCsvRecord(line: string): string[] {
  const out: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { out.push(field); field = '' }
    else field += ch
  }
  out.push(field)
  return out
}

beforeAll(async () => {
  token = await signAuthToken(JWT_SECRET, ADMIN)
  operatorToken = await signAuthToken(JWT_SECRET, OPERATOR)
  otherToken = await signAuthToken(JWT_SECRET, OTHER_ORG_USER)
  // organisation_id on received_devices is FK-enforced, so the second org
  // must be a real row for the cross-tenant tests to mean anything.
  await db()
    .prepare(`INSERT OR IGNORE INTO organisations (id, name, slug) VALUES (42, 'Other CSV Org', 'other-csv')`)
    .run()
  await db()
    .prepare(`INSERT OR IGNORE INTO users (id, email, name, role, organisation_id) VALUES (?, ?, ?, ?, ?)`)
    .bind(OTHER_ORG_USER.id, OTHER_ORG_USER.email, OTHER_ORG_USER.name, OTHER_ORG_USER.role, OTHER_ORG_USER.organisation_id)
    .run()
})

afterAll(async () => {
  // Leave the shared local D1 exactly as found. FK order matters:
  // cost_ledger references received_devices + bill_lines, bill_lines
  // references bills, so delete in that order before the devices/bills/
  // suppliers themselves.
  // D1/SQLite has a bound-variable ceiling per statement, and the >200-row
  // fixture (below) can create more ids than fit in one IN (...) list — so
  // both cleanup deletes below batch in chunks rather than binding every id
  // at once, which is what a 220-id single statement hit here initially
  // (`too many SQL variables`) before this fix.
  const CHUNK = 100
  for (let i = 0; i < createdIds.length; i += CHUNK) {
    const chunk = createdIds.slice(i, i + CHUNK)
    await db()
      .prepare(`DELETE FROM cost_ledger WHERE received_device_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .run()
  }
  for (let i = 0; i < createdIds.length; i += CHUNK) {
    const chunk = createdIds.slice(i, i + CHUNK)
    await db()
      .prepare(`DELETE FROM received_devices WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .run()
  }
  for (const id of createdBillLineIds) {
    await db().prepare('DELETE FROM bill_lines WHERE id = ?').bind(id).run()
  }
  for (const id of createdBillIds) {
    await db().prepare('DELETE FROM bills WHERE id = ?').bind(id).run()
  }
  for (const id of createdSupplierIds) {
    await db().prepare('DELETE FROM suppliers WHERE id = ?').bind(id).run()
  }

  // Cleanup confirmed by RE-QUERY, not trusted from exit code alone (per the
  // standing constraint) — every id this suite created must be genuinely
  // gone from every table it touched. Batched for the same bound-variable
  // reason as the deletes above (createdIds can exceed 100 with the bulk
  // fixture).
  let remainingDeviceCount = 0
  for (let i = 0; i < createdIds.length; i += CHUNK) {
    const chunk = createdIds.slice(i, i + CHUNK)
    const row = await db()
      .prepare(`SELECT COUNT(*) AS n FROM received_devices WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .first<{ n: number }>()
    remainingDeviceCount += row?.n ?? 0
  }
  if (createdIds.length) expect(remainingDeviceCount).toBe(0)

  const remainingBills = await db()
    .prepare(`SELECT COUNT(*) AS n FROM bills WHERE id IN (${createdBillIds.map(() => '?').join(',') || 'NULL'})`)
    .bind(...createdBillIds)
    .first<{ n: number }>()
  if (createdBillIds.length) expect(remainingBills?.n).toBe(0)
})

describe('GET /api/devices/export/csv — auth is required', () => {
  it('rejects an unauthenticated export with 401 and returns no device data', async () => {
    const { res, text } = await exportCsv('', { auth: false })
    expect(res.status).toBe(401)
    // The body must not be a CSV at all — no header row, no rows.
    expect(text).not.toContain(HEADER)
  })
})

describe('GET /api/devices/export/csv — response shape', () => {
  it('serves a CSV content type and an attachment filename', async () => {
    const { res } = await exportCsv('?ids=999999999')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="devices-export-\d+\.csv"$/)
  })

  it('emits the exact 18-column manager header, in order, even when zero rows match', async () => {
    // An id that cannot exist → a legitimately empty export.
    const { res, text } = await exportCsv('?ids=999999999')
    expect(res.status).toBe(200)
    const rows = rowsOf(text)
    expect(rows[0]).toBe(HEADER)
    expect(parseCsvRecord(rows[0])).toHaveLength(18)
    // Header + trailing row_count comment only: no data row, no phantom row.
    expect(rows).toHaveLength(2)
    expect(rowCountLine(text)).toBe(0)
  })

  it('writes one record per device with every field byte-identical to the stored row, including the new lifecycle/costing columns', async () => {
    const supplierId = await seedSupplier('CSV Export Vendor Co')
    const billLineId = await seedBillLine(`CSV-BILLREF-${Date.now()}-${Math.random()}`)
    const id = await seedDevice({
      sku: 'IP13-128-SLV-B',
      brand: 'Apple',
      model: 'iPhone 13',
      capacity: '128GB',
      color: 'Silver',
      grade: 'A',
      status: 'RECEIVED',
      source: 'manual',
      vat_type: 'MARGIN',
      supplier_id: supplierId,
      received_at: '2026-07-02 09:30:00',
    })
    await seedCostLedgerRow(id, 'purchase', 249.99, billLineId)
    await seedCostLedgerRow(id, 'repair', 15.5, null)

    const { res, text } = await exportCsv(`?ids=${id}`)
    expect(res.status).toBe(200)
    const rows = rowsOf(text)
    // header + 1 data row + trailing row_count comment
    expect(rows).toHaveLength(3)

    const stored = await db()
      .prepare('SELECT * FROM received_devices WHERE id = ?')
      .bind(id)
      .first<Record<string, any>>()
    const bill = await db()
      .prepare('SELECT invoice_number FROM bills WHERE id = (SELECT bill_id FROM bill_lines WHERE id = ?)')
      .bind(billLineId)
      .first<{ invoice_number: string }>()
    const fields = parseCsvRecord(rows[1])
    const header = parseCsvRecord(rows[0])
    const cell = (name: string) => fields[header.indexOf(name)]

    // Compared against the DB row, not against the literals passed in — this
    // catches a column-shift bug that a literal comparison would miss.
    expect(cell('id')).toBe(String(stored!.id))
    expect(cell('uuid')).toBe(stored!.uuid)
    expect(cell('imei')).toBe(stored!.imei)
    expect(cell('sku')).toBe('IP13-128-SLV-B')
    expect(cell('brand')).toBe('Apple')
    expect(cell('model')).toBe('iPhone 13')
    expect(cell('capacity')).toBe('128GB')
    expect(cell('color')).toBe('Silver')
    expect(cell('grade')).toBe('A')
    expect(cell('status')).toBe('RECEIVED')
    expect(cell('source')).toBe('manual')
    expect(cell('vat_type')).toBe('MARGIN')
    expect(cell('created_at')).toBe(stored!.created_at)
    // received_date = COALESCE(received_at, created_at); received_at was
    // populated here, so it must win over created_at.
    expect(cell('received_date')).toBe('2026-07-02 09:30:00')
    expect(cell('vendor')).toBe('CSV Export Vendor Co')
    expect(cell('bill_ref')).toBe(bill!.invoice_number)
    expect(cell('purchase_cost_gbp')).toBe('249.99')
    expect(cell('repair_cost_gbp')).toBe('15.5')
    expect(rowCountLine(text)).toBe(1)
  })

  it('falls back received_date to created_at when received_at is NULL, and renders SQL NULL as an empty field, never the string "null"', async () => {
    // A device with no valuation/label yet — legal in the ledger for rows
    // predating the valuation requirement. brand/model/capacity/color are
    // still the export's NULL-rendering columns (buy_price/label_printed_at
    // are no longer in the export at all, so they are correctly NOT
    // asserted here any more).
    const id = await seedDevice({
      brand: null, model: null, capacity: null, color: null,
      vat_type: null, received_at: null,
    })

    const { text } = await exportCsv(`?ids=${id}`)
    const header = parseCsvRecord(rowsOf(text)[0])
    const fields = parseCsvRecord(rowsOf(text)[1])
    const cell = (name: string) => fields[header.indexOf(name)]

    for (const col of ['brand', 'model', 'capacity', 'color', 'vat_type']) {
      expect(cell(col)).toBe('')
    }
    // vendor/bill_ref are also NULL here (no supplier, no cost_ledger row)
    // and must render empty too, never the string "null".
    expect(cell('vendor')).toBe('')
    expect(cell('bill_ref')).toBe('')
    // purchase_cost_gbp/repair_cost_gbp are COALESCE(...,0) aggregates, so
    // an uncosted device must read as the string "0", not empty and not null.
    expect(cell('purchase_cost_gbp')).toBe('0')
    expect(cell('repair_cost_gbp')).toBe('0')
    // received_at was NULL, so received_date must fall back to created_at.
    const stored = await db()
      .prepare('SELECT created_at FROM received_devices WHERE id = ?')
      .bind(id)
      .first<{ created_at: string }>()
    expect(cell('received_date')).toBe(stored!.created_at)
    // The literal words must not appear anywhere in the record.
    expect(rowsOf(text)[1]).not.toMatch(/null|undefined|NaN/)
    // Column count is still exactly 18 — nulls must not collapse fields.
    expect(fields).toHaveLength(18)
  })

  it('orders records by id ascending regardless of the order ids are requested in', async () => {
    const a = await seedDevice()
    const b = await seedDevice()
    const c = await seedDevice()

    // Deliberately reversed in the query string.
    const { text } = await exportCsv(`?ids=${c},${a},${b}`)
    const rows = rowsOf(text).slice(1, -1) // drop header and trailing row_count comment
    const ids = rows.map(r => Number(parseCsvRecord(r)[0]))
    expect(ids).toEqual([a, b, c].sort((x, y) => x - y))
  })
})

describe('GET /api/devices/export/csv — role-gated cost columns (operator vs. manager)', () => {
  it('omits purchase_cost_gbp/repair_cost_gbp/bill_ref from the header ENTIRELY for an operator, not just blanked cells', async () => {
    const supplierId = await seedSupplier('Operator-View Vendor')
    const billLineId = await seedBillLine(`CSV-OPROLE-${Date.now()}-${Math.random()}`)
    const id = await seedDevice({ supplier_id: supplierId })
    await seedCostLedgerRow(id, 'purchase', 88, billLineId)

    const { res, text } = await exportCsv(`?ids=${id}`, { as: OPERATOR })
    expect(res.status).toBe(200)
    const rows = rowsOf(text)
    expect(rows[0]).toBe(OPERATOR_HEADER)
    const header = parseCsvRecord(rows[0])
    expect(header).toHaveLength(15)
    expect(header).not.toContain('bill_ref')
    expect(header).not.toContain('purchase_cost_gbp')
    expect(header).not.toContain('repair_cost_gbp')

    // The data row itself must also carry exactly 15 fields — the omission
    // is structural (fewer columns), not values silently blanked while the
    // column count stays 18.
    const fields = parseCsvRecord(rows[1])
    expect(fields).toHaveLength(15)
    // vendor is NOT cost-gated (only bill_ref/purchase/repair are) and must
    // still be visible to an operator.
    expect(fields[header.indexOf('vendor')]).toBe('Operator-View Vendor')
  })

  it('includes all three cost columns for a manager/admin caller, on the very same device', async () => {
    const id = await seedDevice()
    await seedCostLedgerRow(id, 'purchase', 42, null)

    const { text } = await exportCsv(`?ids=${id}`)
    const header = parseCsvRecord(rowsOf(text)[0])
    expect(header).toHaveLength(18)
    expect(header).toContain('purchase_cost_gbp')
    const fields = parseCsvRecord(rowsOf(text)[1])
    expect(fields[header.indexOf('purchase_cost_gbp')]).toBe('42')
  })
})

describe('GET /api/devices/export/csv — IMEI encoding (?excel=1 vs. default)', () => {
  it('emits the IMEI as plain digits in a quoted field by default (machine-readable — Zoho gap diff, vitest)', async () => {
    const id = await seedDevice()
    const { text } = await exportCsv(`?ids=${id}`)
    const header = parseCsvRecord(rowsOf(text)[0])
    const fields = parseCsvRecord(rowsOf(text)[1])
    const imeiCell = fields[header.indexOf('imei')]
    const stored = await db().prepare('SELECT imei FROM received_devices WHERE id = ?').bind(id).first<{ imei: string }>()
    expect(imeiCell).toBe(stored!.imei)
    expect(imeiCell).not.toMatch(/^="/)
  })

  it('emits the IMEI in the ="..." Excel text-forcing form under ?excel=1', async () => {
    const id = await seedDevice()
    const { text } = await exportCsv(`?ids=${id}&excel=1`)
    const rawRecord = rowsOf(text)[1]
    const stored = await db().prepare('SELECT imei FROM received_devices WHERE id = ?').bind(id).first<{ imei: string }>()
    // The ="..." form is itself not RFC-4180-quoted (the outer field has no
    // comma/quote/CR/LF needing escape) so it appears verbatim in the raw
    // record — asserted directly rather than through parseCsvRecord, which
    // would strip the literal ="" wrapper as if it were quoting.
    expect(rawRecord).toContain(`="${stored!.imei}"`)
  })

  it('?excel=1 affects only the imei column — every other field is unchanged from the default', async () => {
    const id = await seedDevice({ sku: 'EXCEL-FLAG-SKU', model: 'iPhone 13' })
    const { text: plain } = await exportCsv(`?ids=${id}`)
    const { text: excel } = await exportCsv(`?ids=${id}&excel=1`)

    const plainFields = parseCsvRecord(rowsOf(plain)[1])
    const header = parseCsvRecord(rowsOf(plain)[0])
    const excelRaw = rowsOf(excel)[1]

    // Every non-imei cell must appear byte-identically in the excel-mode raw
    // record too.
    for (const col of ['sku', 'model', 'grade', 'status']) {
      const idx = header.indexOf(col)
      expect(excelRaw).toContain(plainFields[idx])
    }
  })
})

describe('GET /api/devices/export/csv — RFC 4180 quoting cannot corrupt the grid', () => {
  it('quotes a value containing a comma so it stays one field', async () => {
    const id = await seedDevice({ model: 'iPhone 13, Pro Max' })
    const { text } = await exportCsv(`?ids=${id}`)
    const record = rowsOf(text)[1]

    expect(record).toContain('"iPhone 13, Pro Max"')
    const header = parseCsvRecord(rowsOf(text)[0])
    const fields = parseCsvRecord(record)
    // The critical assertion: the comma did NOT create an extra column.
    expect(fields).toHaveLength(18)
    expect(fields[header.indexOf('model')]).toBe('iPhone 13, Pro Max')
  })

  it('doubles embedded quotes so the field round-trips exactly', async () => {
    const id = await seedDevice({ color: 'Space "Grey"' })
    const { text } = await exportCsv(`?ids=${id}`)
    const record = rowsOf(text)[1]

    expect(record).toContain('"Space ""Grey"""')
    const header = parseCsvRecord(rowsOf(text)[0])
    const fields = parseCsvRecord(record)
    expect(fields).toHaveLength(18)
    expect(fields[header.indexOf('color')]).toBe('Space "Grey"')
  })

  it('quotes an embedded LF so one device cannot become two rows', async () => {
    const id = await seedDevice({ model: 'iPhone 13\nrefurb' })
    const { text } = await exportCsv(`?ids=${id}`)

    // Split on the record separator: header + exactly one device record +
    // the trailing row_count comment.
    const rows = rowsOf(text)
    expect(rows).toHaveLength(3)
    expect(rows[1]).toContain('"iPhone 13\nrefurb"')
    expect(parseCsvRecord(rows[1])).toHaveLength(18)
  })

  it('quotes an embedded CR so a bare carriage return cannot split the record', async () => {
    // This is the case the pre-existing escape regex missed: it tested for
    // `"`, `,` and `\n` only, so a lone `\r` was emitted UNQUOTED — and a bare
    // CR is a record terminator to Excel and many parsers, corrupting one
    // device into two malformed rows.
    //
    // The assertion must be on the QUOTING, not on a CRLF-split row count:
    // splitting on '\r\n' cannot see a lone '\r' at all, so a row-count
    // assertion here would pass with or without the fix (verified — it did).
    const id = await seedDevice({ model: 'iPhone 13\rrefurb' })
    const { text } = await exportCsv(`?ids=${id}`)

    const rows = rowsOf(text)
    expect(rows).toHaveLength(3)
    // The load-bearing assertion: the CR-containing value is wrapped in
    // quotes, which is what makes it survive a real parser intact.
    expect(rows[1]).toContain('"iPhone 13\rrefurb"')
    // And any CR present in the body is inside a quoted field — never a
    // naked CR sitting between fields.
    expect(rows[1]).not.toMatch(/,iPhone 13\rrefurb,/)

    const fields = parseCsvRecord(rows[1])
    expect(fields).toHaveLength(18)
    const header = parseCsvRecord(rows[0])
    expect(fields[header.indexOf('model')]).toBe('iPhone 13\rrefurb')
  })

  it('does not quote values that need no quoting (no gratuitous escaping)', async () => {
    const id = await seedDevice({ sku: 'PLAIN-SKU', model: 'iPhone 13' })
    const { text } = await exportCsv(`?ids=${id}`)
    expect(rowsOf(text)[1]).toContain('PLAIN-SKU')
    expect(rowsOf(text)[1]).not.toContain('"PLAIN-SKU"')
  })

  it('uses CRLF as the record separator (Excel-safe) and no trailing bare newline', async () => {
    const a = await seedDevice()
    const b = await seedDevice()
    const { text } = await exportCsv(`?ids=${a},${b}`)

    expect(text).toContain('\r\n')
    // header + 2 data rows + trailing row_count comment.
    expect(rowsOf(text)).toHaveLength(4)
    expect(rowCountLine(text)).toBe(2)
  })
})

describe('GET /api/devices/export/csv — filters select exactly, or fail loudly', () => {
  it('filters by a single status and excludes every other status', async () => {
    const received = await seedDevice({ status: 'RECEIVED', sku: 'FILTER-STATUS-A' })
    const sorting = await seedDevice({ status: 'SORTING', sku: 'FILTER-STATUS-B' })

    const { text } = await exportCsv('?status=SORTING')
    const ids = rowsOf(text).slice(1, -1).map(r => Number(parseCsvRecord(r)[0]))
    expect(ids).toContain(sorting)
    expect(ids).not.toContain(received)
  })

  it('accepts a comma-separated status list (parity with GET /api/devices)', async () => {
    const received = await seedDevice({ status: 'RECEIVED' })
    const sorting = await seedDevice({ status: 'SORTING' })
    const repair = await seedDevice({ status: 'IN_HOUSE_REPAIR' })

    const { res, text } = await exportCsv('?status=SORTING,IN_HOUSE_REPAIR')
    expect(res.status).toBe(200)
    const ids = rowsOf(text).slice(1, -1).map(r => Number(parseCsvRecord(r)[0]))
    expect(ids).toContain(sorting)
    expect(ids).toContain(repair)
    expect(ids).not.toContain(received)
  })

  it('accepts lowercase status and normalises it', async () => {
    const repair = await seedDevice({ status: 'IN_HOUSE_REPAIR' })
    const { res, text } = await exportCsv('?status=in_house_repair')
    expect(res.status).toBe(200)
    const ids = rowsOf(text).slice(1, -1).map(r => Number(parseCsvRecord(r)[0]))
    expect(ids).toContain(repair)
  })

  it('rejects a misspelled status with 400 instead of returning an empty CSV', async () => {
    // The defect this locks out: `RECIEVED` (a very plausible typo) formerly
    // matched nothing and returned a headers-only 200 — visually identical to
    // "you have no received devices". An operator could file that as evidence.
    const { res, text } = await exportCsv('?status=RECIEVED')
    expect(res.status).toBe(400)
    const json = JSON.parse(text) as { error: string }
    expect(json.error).toMatch(/Invalid status value\(s\): RECIEVED/)
    expect(text).not.toContain(HEADER)
  })

  it('rejects an invalid status inside an otherwise-valid list', async () => {
    const { res, text } = await exportCsv('?status=RECEIVED,NOT_A_STATUS')
    expect(res.status).toBe(400)
    expect(JSON.parse(text).error).toMatch(/NOT_A_STATUS/)
  })

  it('filters by source and excludes other sources', async () => {
    const manual = await seedDevice({ source: 'manual' })
    const manifest = await seedDevice({ source: 'manifest' })

    const { text } = await exportCsv('?source=manifest')
    const ids = rowsOf(text).slice(1, -1).map(r => Number(parseCsvRecord(r)[0]))
    expect(ids).toContain(manifest)
    expect(ids).not.toContain(manual)
  })

  it('rejects an invalid source with 400 rather than an empty CSV', async () => {
    const { res, text } = await exportCsv('?source=supplier')
    expect(res.status).toBe(400)
    expect(JSON.parse(text).error).toMatch(/Invalid source value: supplier/)
    expect(text).not.toContain(HEADER)
  })

  it('combines status and source as AND, not OR', async () => {
    const match = await seedDevice({ status: 'SORTING', source: 'manifest' })
    const wrongSource = await seedDevice({ status: 'SORTING', source: 'manual' })
    const wrongStatus = await seedDevice({ status: 'RECEIVED', source: 'manifest' })

    const { text } = await exportCsv('?status=SORTING&source=manifest')
    const ids = rowsOf(text).slice(1, -1).map(r => Number(parseCsvRecord(r)[0]))
    expect(ids).toContain(match)
    expect(ids).not.toContain(wrongSource)
    expect(ids).not.toContain(wrongStatus)
  })

  it('lets ids take precedence over status/source (an exact operator selection wins)', async () => {
    const picked = await seedDevice({ status: 'RECEIVED', source: 'manual' })
    // Contradictory filters are ignored when ids is supplied — documented
    // behaviour, asserted so it can't drift silently.
    const { text } = await exportCsv(`?ids=${picked}&status=SORTING&source=manifest`)
    const ids = rowsOf(text).slice(1, -1).map(r => Number(parseCsvRecord(r)[0]))
    expect(ids).toEqual([picked])
  })

  it('rejects a non-numeric id instead of silently dropping it', async () => {
    // Formerly `.map(Number).filter(Boolean)` discarded NaN entries without a
    // word, so `?ids=12,abc,13` exported 2 of the 3 rows the operator picked.
    const a = await seedDevice()
    const { res, text } = await exportCsv(`?ids=${a},abc`)
    expect(res.status).toBe(400)
    expect(JSON.parse(text).error).toMatch(/ids must be positive integers — invalid: abc/)
    expect(text).not.toContain(HEADER)
  })

  it('rejects id 0 and negative ids (they can never identify a device)', async () => {
    for (const bad of ['0', '-1']) {
      const { res } = await exportCsv(`?ids=${bad}`)
      expect(res.status).toBe(400)
    }
  })

  it('rejects an ids parameter with no usable entries', async () => {
    const { res, text } = await exportCsv('?ids=,,')
    expect(res.status).toBe(400)
    expect(JSON.parse(text).error).toMatch(/at least one numeric id/)
  })

  it('tolerates whitespace around ids', async () => {
    const a = await seedDevice()
    const b = await seedDevice()
    const { res, text } = await exportCsv(`?ids=${encodeURIComponent(` ${a} , ${b} `)}`)
    expect(res.status).toBe(200)
    const ids = rowsOf(text).slice(1, -1).map(r => Number(parseCsvRecord(r)[0]))
    expect(ids).toEqual([a, b].sort((x, y) => x - y))
  })

  it('silently ignores ids that do not exist rather than erroring (partial selection)', async () => {
    const a = await seedDevice()
    const { res, text } = await exportCsv(`?ids=${a},999999998`)
    expect(res.status).toBe(200)
    const ids = rowsOf(text).slice(1, -1).map(r => Number(parseCsvRecord(r)[0]))
    expect(ids).toEqual([a])
    // The row-count trailer lets the caller detect the shortfall itself.
    expect(rowCountLine(text)).toBe(1)
  })
})

describe('GET /api/devices/export/csv — organisation scoping', () => {
  it('never exports another organisation\'s devices via the status filter', async () => {
    const mine = await seedDevice({ status: 'SORTING', organisation_id: 1 })
    const theirs = await seedDevice({ status: 'SORTING', organisation_id: 42 })

    const { text } = await exportCsv('?status=SORTING')
    const ids = rowsOf(text).slice(1, -1).map(r => Number(parseCsvRecord(r)[0]))
    expect(ids).toContain(mine)
    expect(ids).not.toContain(theirs)
  })

  it('never exports another organisation\'s device even when its id is named explicitly', async () => {
    // The strongest form: the caller knows the exact id and asks for it.
    const theirs = await seedDevice({ organisation_id: 42 })
    const { res, text } = await exportCsv(`?ids=${theirs}`)
    expect(res.status).toBe(200)
    expect(rowsOf(text)).toHaveLength(2) // header + trailing row_count comment only
    expect(rowCountLine(text)).toBe(0)
  })

  it('shows each organisation only its own row for the same id set', async () => {
    const mine = await seedDevice({ organisation_id: 1 })
    const theirs = await seedDevice({ organisation_id: 42 })

    const asMine = await exportCsv(`?ids=${mine},${theirs}`)
    expect(rowCountLine(asMine.text)).toBe(1)
    expect(rowsOf(asMine.text).slice(1, -1).map(r => Number(parseCsvRecord(r)[0]))).toEqual([mine])

    const asTheirs = await exportCsv(`?ids=${mine},${theirs}`, { as: OTHER_ORG_USER })
    expect(rowCountLine(asTheirs.text)).toBe(1)
    expect(rowsOf(asTheirs.text).slice(1, -1).map(r => Number(parseCsvRecord(r)[0]))).toEqual([theirs])
  })
})

// The old "the row cap refuses truncation" describe block asserted an
// EXPORT_ROW_CAP=5000 → 413 contract that no longer exists — B3 removed the
// cap entirely (see src/routes/devices.ts's module comment point 1: the org
// now has 1133+ devices and growing, so refusing large exports is not an
// option; the route streams instead). That test asserted a real invariant
// ("count > cap ⇒ refuse, and say how many") which is simply gone now, not
// replaced by an equivalent — there is no cap left to test. Removed here
// rather than left in place asserting dead behaviour, per the standing
// instruction to say explicitly when a case no longer has meaning rather
// than silently deleting it. Its replacement invariant — "every matching
// row is delivered, none silently dropped, however many there are" — is
// covered by the new fixture immediately below instead.
describe('GET /api/devices/export/csv — no cap: an arbitrarily large selection is delivered in full', () => {
  it('streams every one of 200+ rows with no truncation and a correct trailing row_count', async () => {
    const ROW_COUNT = 220
    // Deliberately NOT using `?ids=<220 comma-separated ids>` here — that
    // path binds one SQL variable per id (plus organisation_id) and D1/
    // SQLite has a per-statement bound-variable ceiling well under 220,
    // which is an orthogonal limit on the `ids` filter's OWN bind list,
    // not on the export's row count (confirmed empirically: the identical
    // `?ids=...` shape used by every other test in this file works fine at
    // 1-3 ids). The invariant this test exists to prove — "no LIMIT/OFFSET,
    // every matching row is delivered" — is exercised more cleanly via the
    // `source` filter instead, which needs exactly one bound parameter
    // regardless of how many rows match it.
    const marker = `BULK-EXPORT-${Date.now()}`
    const ids: number[] = []
    for (let i = 0; i < ROW_COUNT; i++) {
      ids.push(await seedDevice({ sku: `${marker}-${i}`, source: 'unreconciled' }))
    }

    const { res, text } = await exportCsv(`?source=unreconciled`)
    expect(res.status).toBe(200)
    const rows = rowsOf(text)
    const exportedIds = rows.slice(1, -1).map(r => Number(parseCsvRecord(r)[0]))
    // Scope the assertion to exactly the ids this test created (other
    // suites/tests in this same run may also have seeded 'unreconciled'
    // devices) — the invariant under test is "every one of MY 220 rows is
    // present and none truncated", not "the filter matches nothing else".
    const mineExported = exportedIds.filter(id => ids.includes(id))
    expect(mineExported).toHaveLength(ROW_COUNT)
    expect(mineExported.sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b))
    // Ordering invariant still holds at this size too.
    expect(mineExported).toEqual([...mineExported].sort((a, b) => a - b))
  })
})
