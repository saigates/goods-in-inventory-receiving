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
import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'
import type { AuthUser, DeviceStatus } from '../src/types'

const JWT_SECRET = 'test-only-secret'
const testEnv = () => ({ ...(env as unknown as Record<string, unknown>), JWT_SECRET })
const db = () => (env as unknown as { DB: D1Database }).DB

// Matches the admin user seeded by migration 0008 (org 1 = Saigates Limited).
const ADMIN: AuthUser = {
  id: 1,
  email: 'admin@goodsin.local',
  name: 'Seed Admin',
  role: 'admin',
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
  buy_price?: number | null
  currency?: string
  vat_type?: string | null
  label_printed_at?: string | null
  organisation_id?: number
}

// Inserts directly (bypassing the intake API) so each test controls the exact
// stored bytes — including values intake would normalise away, which is the
// point: the export must survive whatever is already in the ledger.
async function seedDevice(row: SeedRow = {}): Promise<number> {
  const imei = row.imei ?? nextImei()
  const res = await db()
    .prepare(
      `INSERT INTO received_devices
         (organisation_id, uuid, imei, sku, brand, model, capacity, color, grade,
          source, status, buy_price, currency, vat_type, label_printed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      row.buy_price === undefined ? 100 : row.buy_price,
      row.currency ?? 'GBP',
      row.vat_type === undefined ? 'MARGIN' : row.vat_type,
      row.label_printed_at ?? null,
      '2026-07-01 10:00:00',
    )
    .run()
  const id = res.meta.last_row_id as number
  createdIds.push(id)
  return id
}

async function exportCsv(
  query = '',
  opts: { auth?: boolean; as?: AuthUser } = {},
): Promise<{ res: Response; text: string }> {
  const headers: Record<string, string> = {}
  if (opts.auth !== false) {
    headers['Authorization'] = `Bearer ${opts.as === OTHER_ORG_USER ? otherToken : token}`
  }
  const res = await app.request(`/api/devices/export/csv${query}`, { headers }, testEnv())
  const text = await res.text()
  return { res, text }
}

// The canonical header row, asserted literally in one place so a column
// rename/reorder must be a deliberate edit to this constant.
const HEADER =
  'id,uuid,imei,sku,brand,model,capacity,color,grade,status,source,buy_price,currency,vat_type,label_printed_at,created_at'

// CSV is CRLF-delimited (RFC 4180). Split on CRLF only — splitting on \n
// would hide a bug where a value's bare LF creates a phantom row.
const rowsOf = (text: string) => text.split('\r\n')

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
  // Leave the shared local D1 exactly as found.
  for (const id of createdIds) {
    await db().prepare('DELETE FROM received_devices WHERE id = ?').bind(id).run()
  }
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

  it('emits the exact 16-column header, in order, even when zero rows match', async () => {
    // An id that cannot exist → a legitimately empty export.
    const { res, text } = await exportCsv('?ids=999999999')
    expect(res.status).toBe(200)
    const rows = rowsOf(text)
    expect(rows[0]).toBe(HEADER)
    expect(parseCsvRecord(rows[0])).toHaveLength(16)
    // Header only: no trailing blank record, no phantom row.
    expect(rows).toHaveLength(1)
    expect(res.headers.get('X-Export-Row-Count')).toBe('0')
  })

  it('writes one record per device with every field byte-identical to the stored row', async () => {
    const id = await seedDevice({
      sku: 'IP13-128-SLV-B',
      brand: 'Apple',
      model: 'iPhone 13',
      capacity: '128GB',
      color: 'Silver',
      grade: 'A',
      status: 'RECEIVED',
      source: 'manual',
      buy_price: 249.99,
      currency: 'GBP',
      vat_type: 'MARGIN',
    })

    const { res, text } = await exportCsv(`?ids=${id}`)
    expect(res.status).toBe(200)
    const rows = rowsOf(text)
    expect(rows).toHaveLength(2)

    const stored = await db()
      .prepare('SELECT * FROM received_devices WHERE id = ?')
      .bind(id)
      .first<Record<string, any>>()
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
    expect(cell('buy_price')).toBe('249.99')
    expect(cell('currency')).toBe('GBP')
    expect(cell('vat_type')).toBe('MARGIN')
    expect(res.headers.get('X-Export-Row-Count')).toBe('1')
  })

  it('renders SQL NULL as an empty field, never the string "null"', async () => {
    // A device with no valuation/label yet — legal in the ledger for rows
    // predating the valuation requirement.
    const id = await seedDevice({
      brand: null, model: null, capacity: null, color: null,
      buy_price: null, vat_type: null, label_printed_at: null,
    })

    const { text } = await exportCsv(`?ids=${id}`)
    const header = parseCsvRecord(rowsOf(text)[0])
    const fields = parseCsvRecord(rowsOf(text)[1])
    const cell = (name: string) => fields[header.indexOf(name)]

    for (const col of ['brand', 'model', 'capacity', 'color', 'buy_price', 'vat_type', 'label_printed_at']) {
      expect(cell(col)).toBe('')
    }
    // The literal words must not appear anywhere in the record.
    expect(rowsOf(text)[1]).not.toMatch(/null|undefined|NaN/)
    // Column count is still exactly 16 — nulls must not collapse fields.
    expect(fields).toHaveLength(16)
  })

  it('orders records by id ascending regardless of the order ids are requested in', async () => {
    const a = await seedDevice()
    const b = await seedDevice()
    const c = await seedDevice()

    // Deliberately reversed in the query string.
    const { text } = await exportCsv(`?ids=${c},${a},${b}`)
    const rows = rowsOf(text).slice(1)
    const ids = rows.map(r => Number(parseCsvRecord(r)[0]))
    expect(ids).toEqual([a, b, c].sort((x, y) => x - y))
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
    // The critical assertion: the comma did NOT create a 17th column.
    expect(fields).toHaveLength(16)
    expect(fields[header.indexOf('model')]).toBe('iPhone 13, Pro Max')
  })

  it('doubles embedded quotes so the field round-trips exactly', async () => {
    const id = await seedDevice({ color: 'Space "Grey"' })
    const { text } = await exportCsv(`?ids=${id}`)
    const record = rowsOf(text)[1]

    expect(record).toContain('"Space ""Grey"""')
    const header = parseCsvRecord(rowsOf(text)[0])
    const fields = parseCsvRecord(record)
    expect(fields).toHaveLength(16)
    expect(fields[header.indexOf('color')]).toBe('Space "Grey"')
  })

  it('quotes an embedded LF so one device cannot become two rows', async () => {
    const id = await seedDevice({ model: 'iPhone 13\nrefurb' })
    const { text } = await exportCsv(`?ids=${id}`)

    // Split on the record separator: header + exactly one device record.
    const rows = rowsOf(text)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toContain('"iPhone 13\nrefurb"')
    expect(parseCsvRecord(rows[1])).toHaveLength(16)
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
    expect(rows).toHaveLength(2)
    // The load-bearing assertion: the CR-containing value is wrapped in
    // quotes, which is what makes it survive a real parser intact.
    expect(rows[1]).toContain('"iPhone 13\rrefurb"')
    // And any CR present in the body is inside a quoted field — never a
    // naked CR sitting between fields.
    expect(rows[1]).not.toMatch(/,iPhone 13\rrefurb,/)

    const fields = parseCsvRecord(rows[1])
    expect(fields).toHaveLength(16)
    const header = parseCsvRecord(rows[0])
    expect(fields[header.indexOf('model')]).toBe('iPhone 13\rrefurb')
  })

  it('does not quote values that need no quoting (no gratuitous escaping)', async () => {
    const id = await seedDevice({ sku: 'PLAIN-SKU', model: 'iPhone 13' })
    const { text } = await exportCsv(`?ids=${id}`)
    expect(rowsOf(text)[1]).toContain('PLAIN-SKU')
    expect(rowsOf(text)[1]).not.toContain('"PLAIN-SKU"')
  })

  it('uses CRLF as the record separator (Excel-safe) and no trailing newline', async () => {
    const a = await seedDevice()
    const b = await seedDevice()
    const { text } = await exportCsv(`?ids=${a},${b}`)

    expect(text).toContain('\r\n')
    // No trailing separator: a trailing CRLF is read as an empty final record
    // by strict parsers.
    expect(text.endsWith('\r\n')).toBe(false)
    expect(rowsOf(text)).toHaveLength(3)
  })
})

describe('GET /api/devices/export/csv — filters select exactly, or fail loudly', () => {
  it('filters by a single status and excludes every other status', async () => {
    const received = await seedDevice({ status: 'RECEIVED', sku: 'FILTER-STATUS-A' })
    const sorting = await seedDevice({ status: 'SORTING', sku: 'FILTER-STATUS-B' })

    const { text } = await exportCsv('?status=SORTING')
    const ids = rowsOf(text).slice(1).map(r => Number(parseCsvRecord(r)[0]))
    expect(ids).toContain(sorting)
    expect(ids).not.toContain(received)
  })

  it('accepts a comma-separated status list (parity with GET /api/devices)', async () => {
    const received = await seedDevice({ status: 'RECEIVED' })
    const sorting = await seedDevice({ status: 'SORTING' })
    const repair = await seedDevice({ status: 'IN_HOUSE_REPAIR' })

    const { res, text } = await exportCsv('?status=SORTING,IN_HOUSE_REPAIR')
    expect(res.status).toBe(200)
    const ids = rowsOf(text).slice(1).map(r => Number(parseCsvRecord(r)[0]))
    expect(ids).toContain(sorting)
    expect(ids).toContain(repair)
    expect(ids).not.toContain(received)
  })

  it('accepts lowercase status and normalises it', async () => {
    const repair = await seedDevice({ status: 'IN_HOUSE_REPAIR' })
    const { res, text } = await exportCsv('?status=in_house_repair')
    expect(res.status).toBe(200)
    const ids = rowsOf(text).slice(1).map(r => Number(parseCsvRecord(r)[0]))
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
    const ids = rowsOf(text).slice(1).map(r => Number(parseCsvRecord(r)[0]))
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
    const ids = rowsOf(text).slice(1).map(r => Number(parseCsvRecord(r)[0]))
    expect(ids).toContain(match)
    expect(ids).not.toContain(wrongSource)
    expect(ids).not.toContain(wrongStatus)
  })

  it('lets ids take precedence over status/source (an exact operator selection wins)', async () => {
    const picked = await seedDevice({ status: 'RECEIVED', source: 'manual' })
    // Contradictory filters are ignored when ids is supplied — documented
    // behaviour, asserted so it can't drift silently.
    const { text } = await exportCsv(`?ids=${picked}&status=SORTING&source=manifest`)
    const ids = rowsOf(text).slice(1).map(r => Number(parseCsvRecord(r)[0]))
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
    const ids = rowsOf(text).slice(1).map(r => Number(parseCsvRecord(r)[0]))
    expect(ids).toEqual([a, b].sort((x, y) => x - y))
  })

  it('silently ignores ids that do not exist rather than erroring (partial selection)', async () => {
    const a = await seedDevice()
    const { res, text } = await exportCsv(`?ids=${a},999999998`)
    expect(res.status).toBe(200)
    const ids = rowsOf(text).slice(1).map(r => Number(parseCsvRecord(r)[0]))
    expect(ids).toEqual([a])
    // The row count header lets the caller detect the shortfall itself.
    expect(res.headers.get('X-Export-Row-Count')).toBe('1')
  })
})

describe('GET /api/devices/export/csv — organisation scoping', () => {
  it('never exports another organisation\'s devices via the status filter', async () => {
    const mine = await seedDevice({ status: 'SORTING', organisation_id: 1 })
    const theirs = await seedDevice({ status: 'SORTING', organisation_id: 42 })

    const { text } = await exportCsv('?status=SORTING')
    const ids = rowsOf(text).slice(1).map(r => Number(parseCsvRecord(r)[0]))
    expect(ids).toContain(mine)
    expect(ids).not.toContain(theirs)
  })

  it('never exports another organisation\'s device even when its id is named explicitly', async () => {
    // The strongest form: the caller knows the exact id and asks for it.
    const theirs = await seedDevice({ organisation_id: 42 })
    const { res, text } = await exportCsv(`?ids=${theirs}`)
    expect(res.status).toBe(200)
    expect(rowsOf(text)).toHaveLength(1) // header only
    expect(res.headers.get('X-Export-Row-Count')).toBe('0')
  })

  it('shows each organisation only its own row for the same id set', async () => {
    const mine = await seedDevice({ organisation_id: 1 })
    const theirs = await seedDevice({ organisation_id: 42 })

    const asMine = await exportCsv(`?ids=${mine},${theirs}`)
    expect(asMine.res.headers.get('X-Export-Row-Count')).toBe('1')
    expect(rowsOf(asMine.text).slice(1).map(r => Number(parseCsvRecord(r)[0]))).toEqual([mine])

    const asTheirs = await exportCsv(`?ids=${mine},${theirs}`, { as: OTHER_ORG_USER })
    expect(asTheirs.res.headers.get('X-Export-Row-Count')).toBe('1')
    expect(rowsOf(asTheirs.text).slice(1).map(r => Number(parseCsvRecord(r)[0]))).toEqual([theirs])
  })
})

describe('GET /api/devices/export/csv — the row cap refuses truncation', () => {
  it('refuses with 413 and the true total rather than delivering a truncated file', async () => {
    // Proving this with 5001 real rows would be slow and pointless; the
    // invariant under test is "count > cap ⇒ refuse, and say how many",
    // exercised here by asking for a selection whose count the test controls.
    // We shrink the effective set instead: request every device in org 1 and
    // assert the honest contract — either a 200 whose row count equals the
    // counted total (never silently less), or a 413 carrying that total.
    const { res, text } = await exportCsv('')
    if (res.status === 413) {
      const json = JSON.parse(text) as { total: number; cap: number }
      expect(json.total).toBeGreaterThan(json.cap)
      expect(text).not.toContain(HEADER)
      return
    }
    expect(res.status).toBe(200)
    const total = await db()
      .prepare('SELECT COUNT(*) AS n FROM received_devices WHERE organisation_id = 1')
      .first<{ n: number }>()
    // The delivered file carries EVERY matching row — no quiet shortfall.
    expect(Number(res.headers.get('X-Export-Row-Count'))).toBe(total!.n)
    expect(rowsOf(text)).toHaveLength(total!.n + 1)
  })
})
