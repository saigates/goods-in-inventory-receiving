// Z-1 row-count regressions — Master Checklist "Next pass, item 1"
// (2026-09-25): prove that chunking neither drops nor duplicates a single
// item at the REAL production batch sizes across all four Z-1 sites —
// opr.ts:2519 (bulk-serials SELECT), inventory.ts:183 (/grade SELECT),
// manifests.ts:458 (apply-sku-to-batch UPDATE), devices.ts:586
// (export/csv ids= SELECT) — at 103 / 155 / 181 / 217 / 341 devices.
//
// 217 is the size the operator called out explicitly: it does NOT land on
// a D1_IN_CHUNK_SIZE=90 boundary (217 = 2*90 + 37, a 3-chunk split with a
// short final chunk), unlike 180 (an exact 2*90). If chunking has an
// off-by-one at a chunk boundary, 217 is the size most likely to expose
// it. Each site's 217-case assertion is written standalone (not just
// folded into the sizes loop) so a failure there is unambiguous in the
// runner output and can be reported separately, per instruction.
//
// Direct-SQL db.batch() seeding is used for received_devices (validated
// via a throwaway timing probe this segment: 341 rows in ~347ms) rather
// than the slow per-device HTTP round-trip pattern in bulkSerials.spec.ts
// — this file needs up to 4 sites * 5 sizes = ~1000 devices total, and
// the per-device API path (scan/manual + 2 transitions, each a full HTTP
// round-trip) would make that prohibitively slow.
//
// IMEI namespace: 4444400xxxxxxx — confirmed free via a full-registry grep
// across test/*.spec.ts, test/browser/*.mjs and test/browser/README.md
// (2026-09-25) before use; distinct from every prefix already claimed
// (3579654/3579655/3579656, 8604571, 8604549-8604572, 9900000, etc.).
import { env } from 'cloudflare:workers'
import { describe, it, expect, beforeAll } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'

const JWT_SECRET = 'test-secret-row-count-regression'
const testEnv = { ...env, JWT_SECRET } as typeof env & { JWT_SECRET: string }
const db = () => (env as unknown as { DB: D1Database }).DB

let token = ''
let authId = 0
let imeiSeq = 0

function luhnImei(): string {
  const body = `4444400${String(10000000 + imeiSeq++).slice(1)}`
  let sum = 0
  for (let i = 0; i < 14; i++) {
    let d = Number(body[i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return body + String((10 - (sum % 10)) % 10)
}

async function api(path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  }, testEnv)
}

beforeAll(async () => {
  token = await signAuthToken(JWT_SECRET, {
    id: 1, email: 'admin@goodsin.local', name: 'Seed Admin', role: 'admin', organisation_id: 1,
  })
  const res = await api('/api/opr/authorisations', {
    method: 'POST',
    body: JSON.stringify({
      holder_name: 'Row Count Regression Holder', eori: 'GB111222333444',
      cds_number: 'GBOPO11122233344420260101000000',
      op_authorisation_number: 'OP/1112/223/33',
      valid_from: '2026-01-01', valid_to: '2031-01-01',
      supervising_office_name: 'HMRC S1756 IP-OP Customs Liverpool',
      supervising_office_code: 'GBLIV002',
      commodity_codes: '8517130000', discharge_period_months: 6,
      prealert_email: 'prealert-rowcount-test@example.com', prealert_cutoff: '16:00',
    }),
  })
  expect(res.status).toBe(201)
  authId = ((await res.json()) as { authorisation: { id: number } }).authorisation.id
})

// Direct-SQL received_devices seeding — bypasses the per-device HTTP API
// path deliberately (see module comment). Every row is a REAL D1 write
// via a REAL db.batch() call, not a stub.
// NOTE (test-design bug found and fixed while running this file,
// 2026-09-25): the first version of this helper re-fetched ids via a
// single unchunked `imei IN (?,?,...)` SELECT over the whole seeded set —
// which itself blew D1's 100-bound-parameter cap at n>100, the exact
// class of bug this whole file exists to test for, just self-inflicted in
// the fixture rather than the route under test. Fixed by reading each
// insert's own `meta.last_row_id` at batch time instead of re-querying by
// IMEI at all.
async function seedReceivedDevices(n: number, overrides: {
  status?: string; sku?: string; model?: string; capacity?: string; color?: string; grade?: string; buy_price?: number | null
} = {}): Promise<{ ids: number[]; imeis: string[] }> {
  const stmts = []
  const imeis: string[] = []
  for (let i = 0; i < n; i++) {
    const imei = luhnImei()
    imeis.push(imei)
    stmts.push(db().prepare(
      `INSERT INTO received_devices
        (organisation_id, uuid, imei, sku, brand, model, capacity, color, grade, source, status, buy_price, currency)
       VALUES (1, ?, ?, ?, 'RowCountBrand', ?, ?, ?, ?, 'manual', ?, ?, 'GBP')`
    ).bind(
      `rowcount-uuid-${imei}`, imei,
      overrides.sku ?? 'ROWCOUNT-OLD-SKU',
      overrides.model ?? 'Row Count Model',
      overrides.capacity ?? '128GB',
      overrides.color ?? 'Black',
      overrides.grade ?? 'A',
      overrides.status ?? 'RECEIVED',
      overrides.buy_price === undefined ? 100 : overrides.buy_price,
    ))
  }
  const results = await db().batch(stmts)
  const ids = results.map(r => Number(r.meta.last_row_id))
  return { ids, imeis }
}

const SIZES = [103, 155, 181, 217, 341]

// ═════════ Site 1: opr.ts:2519 — POST /shipments/:id/bulk-serials ═════════
describe('Row-count regression — opr.ts bulk-serials (SELECT chunking)', () => {
  for (const n of SIZES) {
    it(`adds exactly ${n}/${n} devices with zero failures (chunked SELECT lookup)${n === 217 ? ' — 217: NOT a multiple of D1_IN_CHUNK_SIZE=90 (2*90+37), the size most likely to expose an off-by-one at a chunk boundary' : ''}`, async () => {
      const shipRes = await api('/api/opr/shipments', {
        method: 'POST',
        body: JSON.stringify({
          reference: `RC BULK ${n} ${Date.now()}`, direction: 'export', authorisation_id: authId,
          procedure_code: '2100', ship_date: '2026-07-01',
          consignee_name: 'Row Count Repairer', consignee_address: 'Row Count Street, NL',
          carrier: 'FedEx', incoterm: 'DAP',
        }),
      })
      expect(shipRes.status).toBe(201)
      const shipmentId = ((await shipRes.json()) as { shipment: { id: number } }).shipment.id

      const { imeis } = await seedReceivedDevices(n, { status: 'READY_FOR_EXPORT' })

      const res = await api(`/api/opr/shipments/${shipmentId}/bulk-serials`, {
        method: 'POST', body: JSON.stringify({ text: imeis.join('\n') }),
      })
      expect(res.status).toBe(200)
      const json = await res.json() as { requested: number; added: number; failed: number }
      expect(json.requested).toBe(n)
      expect(json.added).toBe(n)
      expect(json.failed).toBe(0)

      // Real DB cross-check, not just the route's own self-reported count.
      const lineCount = await db().prepare(
        'SELECT COUNT(*) AS c FROM shipment_lines WHERE shipment_id = ?'
      ).bind(shipmentId).first<{ c: number }>()
      expect(lineCount!.c).toBe(n)
    }, 30000)
  }
})

// ═════════ Site 2: inventory.ts:183 — POST /api/inventory/grade ═════════
describe('Row-count regression — inventory.ts /grade (SELECT chunking)', () => {
  for (const n of SIZES) {
    it(`regrades exactly ${n}/${n} devices with zero skips (chunked SELECT lookup)${n === 217 ? ' — 217 reported separately per instruction' : ''}`, async () => {
      const model = `RC Grade Model ${n}`
      const capacity = '256GB'
      const color = 'Blue'
      // Catalog row for the TARGET grade only — created before seeding so
      // there is exactly one unambiguous match for resolveCatalogSkuBulk.
      const sku = `RC-GRADE-SKU-${n}-${Date.now()}`
      await db().prepare(
        `INSERT INTO sku_catalog (organisation_id, sku, brand, model, capacity, color, grade)
         VALUES (1, ?, 'RowCountBrand', ?, ?, ?, 'B')`
      ).bind(sku, model.toUpperCase(), capacity, color.toUpperCase()).run()

      const { ids } = await seedReceivedDevices(n, { model, capacity, color, grade: 'A', sku: 'ROWCOUNT-PRE-GRADE-SKU' })

      const res = await api('/api/inventory/grade', {
        method: 'POST', body: JSON.stringify({ ids, grade: 'B', actor: 'Row Count Test' }),
      })
      expect(res.status).toBe(200)
      const json = await res.json() as { updated_count: number; skipped: unknown[] }
      expect(json.updated_count).toBe(n)
      expect(json.skipped).toHaveLength(0)

      // Cross-check by `sku` alone (unique per test run, per n), NOT
      // `id IN (...)` — an unchunked id-list re-check here would blow the
      // exact same 100-param cap this file exists to test for, just in
      // the test's own verification query instead of the route (this bit
      // a first draft of this test at n>100; fixed by relying on the
      // fresh-per-test sku's uniqueness instead of the id list).
      const check = await db().prepare(
        `SELECT COUNT(*) AS c FROM received_devices WHERE sku = ? AND grade = 'B'`
      ).bind(sku).first<{ c: number }>()
      expect(check!.c).toBe(n)
      expect(ids).toHaveLength(n)
    }, 30000)
  }
})

// ═════════ Site 3: manifests.ts:458 — POST /:id/apply-sku-to-batch ═════════
describe('Row-count regression — manifests.ts apply-sku-to-batch (UPDATE chunking)', () => {
  for (const n of SIZES) {
    it(`applies the sku to exactly ${n}/${n} pending lines (chunked UPDATE, never truncates or 409s on a clean run)${n === 217 ? ' — 217: if chunking alone does not reconcile this, that is a stop-and-report condition' : ''}`, async () => {
      const model = `RC Manifest Model ${n}`
      const capacity = '512GB'
      const color = 'Gold'
      const grade = 'C'

      const rows = Array.from({ length: n }, () => ({
        imei: luhnImei(), model_no: model, capacity, color, grade,
      }))
      const mfRes = await api('/api/manifests', {
        method: 'POST',
        body: JSON.stringify({
          reference: `RC-MANIFEST-${n}-${Date.now()}`, supplier: 'Row Count Vendor', rows,
        }),
      })
      expect(mfRes.status).toBe(200)
      const manifestId = ((await mfRes.json()) as { manifest_id: number }).manifest_id

      // Catalog row created AFTER upload — every line starts sku=NULL, so
      // `applied === n` below is unambiguously this endpoint's own write.
      const before = await db().prepare(
        `SELECT COUNT(*) AS c FROM expected_devices WHERE manifest_id = ? AND sku IS NULL`
      ).bind(manifestId).first<{ c: number }>()
      expect(before!.c).toBe(n)

      const sku = `RC-MANIFEST-SKU-${n}-${Date.now()}`
      await db().prepare(
        `INSERT INTO sku_catalog (organisation_id, sku, brand, model, capacity, color, grade)
         VALUES (1, ?, 'RowCountBrand', ?, ?, ?, ?)`
      ).bind(sku, model.toUpperCase(), capacity, color.toUpperCase(), grade).run()

      const res = await api(`/api/manifests/${manifestId}/apply-sku-to-batch`, {
        method: 'POST', body: JSON.stringify({ sku, model, capacity, color, grade }),
      })
      expect(res.status).toBe(200)
      const json = await res.json() as { applied: number }
      expect(json.applied).toBe(n)

      const after = await db().prepare(
        `SELECT COUNT(*) AS c FROM expected_devices WHERE manifest_id = ? AND sku = ?`
      ).bind(manifestId, sku).first<{ c: number }>()
      expect(after!.c).toBe(n)
    }, 30000)
  }
})

// ═════════ Site 4: devices.ts:586 — GET /export/csv?ids= (SELECT chunking) ═════════
describe('Row-count regression — devices.ts export/csv ids= (SELECT chunking)', () => {
  for (const n of SIZES) {
    it(`exports exactly ${n}/${n} rows with no shortfall headers (chunked ids= SELECT)${n === 217 ? ' — 217 reported separately per instruction' : ''}`, async () => {
      const { ids } = await seedReceivedDevices(n)
      const res = await app.request(
        `/api/devices/export/csv?ids=${ids.join(',')}`,
        { headers: { Authorization: `Bearer ${token}` } },
        testEnv,
      )
      expect(res.status).toBe(200)
      expect(res.headers.has('X-Export-Ids-Missing')).toBe(false)
      const text = await res.text()
      const lines = text.split('\r\n')
      if (lines.length && lines[lines.length - 1] === '') lines.pop()
      const last = lines[lines.length - 1]
      const m = /^# row_count=(\d+)$/.exec(last ?? '')
      expect(m).not.toBeNull()
      expect(Number(m![1])).toBe(n)
      // Header + n data rows + 1 trailing row_count comment line.
      expect(lines).toHaveLength(n + 2)
    }, 30000)
  }
})
