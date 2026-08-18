// Migration 0030 follow-up — HTTP-level proof that the write path
// (src/routes/manifests.ts) actually derives condition from grade instead
// of storing the uploaded r.condition value, and that the derivation
// matches the exact 7 real (grade, uploaded-condition) cells found by the
// pre-migration production cross-tab. Runs against the real D1 binding
// with every migration (including 0030) applied by test/apply-migrations.ts
// — see vitest.config.ts — so this exercises the LIVE schema, not a mock.
//
// This does not (and cannot) reproduce the exact 756-row production
// counts locally — local dev D1 has zero expected_devices rows (confirmed
// empty). What it DOES prove: for each of the 7 real (grade, uploaded
// condition) combinations, uploading a manifest row with that exact grade
// and that exact uploaded condition string results in the CORRECT derived
// condition being stored, the uploaded value never being stored verbatim,
// and — for every case where uploaded != derived — a
// condition_discrepancies entry reporting it.
import { env } from 'cloudflare:workers'
import { describe, it, expect, beforeAll } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'

const JWT_SECRET = 'test-secret-condition-derivation'
const testEnv = { ...env, JWT_SECRET } as typeof env & { JWT_SECRET: string }

let token = ''
let imeiSeq = 0
// Distinct namespace from other suites to avoid cross-suite IMEI collisions
// on the shared in-memory D1.
function luhnImei(): string {
  const body = `3579655${String(10000000 + imeiSeq++).slice(1)}`
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
    id: 1, email: 'admin@goodsin.local', name: 'Seed Admin',
    role: 'admin', organisation_id: 1,
  })
})

describe('expected_devices.condition is derived from grade at write time (0030)', () => {
  // The 7 real (grade, uploaded-condition) cells from the pre-migration
  // production cross-tab, and what each MUST derive to.
  //
  // `expectDiscrepancy` is INTENTIONALLY NOT the same partition as the
  // migration's own no-op/case-only/semantic classification (that
  // classification describes what happens to an EXISTING stored row
  // during the one-off 0030 UPDATE). This flags a DIFFERENT, narrower
  // thing: for a FRESH upload going forward, does the file's condition
  // column, compared case-insensitively, actually disagree with what
  // grade derives? A case-only difference is not a real disagreement
  // (e.g. uploaded "Refurbished" against a derived "REFURBISHED" is the
  // same value, just cased differently) — so those are NOT logged as
  // discrepancies, matching the instruction to flag rows that
  // "disagree", not rows that merely differ in case. Concretely, only
  // 3 of these 7 real historical patterns represent a genuine semantic
  // disagreement under case-insensitive comparison: C/Raw, UG/Used,
  // UG/UG. The other 4 — including UG/Raw, despite the migration's own
  // table calling it "semantic — grade wins" for historical-provenance
  // reasons — already textually agree with the derived target once
  // case is normalised, so a fresh upload of that combination raises no
  // discrepancy flag today.
  const cells: Array<{ grade: string; uploaded: string; expectedDerived: 'REFURBISHED' | 'USED' | 'RAW'; expectDiscrepancy: boolean }> = [
    { grade: 'A',  uploaded: 'REFURBISHED', expectedDerived: 'REFURBISHED', expectDiscrepancy: false },
    { grade: 'A',  uploaded: 'Refurbished', expectedDerived: 'REFURBISHED', expectDiscrepancy: false },
    { grade: 'C',  uploaded: 'Used',        expectedDerived: 'USED',        expectDiscrepancy: false },
    { grade: 'C',  uploaded: 'Raw',         expectedDerived: 'USED',        expectDiscrepancy: true },
    { grade: 'UG', uploaded: 'Used',        expectedDerived: 'RAW',         expectDiscrepancy: true },
    { grade: 'UG', uploaded: 'Raw',         expectedDerived: 'RAW',         expectDiscrepancy: false },
    { grade: 'UG', uploaded: 'UG',          expectedDerived: 'RAW',         expectDiscrepancy: true },
  ]

  for (const cell of cells) {
    it(`grade ${cell.grade} + uploaded condition "${cell.uploaded}" -> stored ${cell.expectedDerived}`, async () => {
      const imei = luhnImei()
      const res = await api('/api/manifests', {
        method: 'POST',
        body: JSON.stringify({
          reference: `MF-COND-${cell.grade}-${cell.uploaded}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          supplier: 'Condition Derivation Test Vendor',
          rows: [{ imei, model_no: 'iPhone 17', capacity: '256GB', grade: cell.grade, condition: cell.uploaded }],
        }),
      })
      expect(res.status).toBe(200)
      const data = await res.json() as {
        ok: boolean; manifest_id: number
        condition_discrepancies: Array<{ row_index: number; imei: string; uploaded: string; derived: string }>
      }
      expect(data.ok).toBe(true)

      // Discrepancy log: present iff uploaded (case-insensitively) != derived.
      if (!cell.expectDiscrepancy) {
        expect(data.condition_discrepancies).toEqual([])
      } else {
        expect(data.condition_discrepancies).toHaveLength(1)
        expect(data.condition_discrepancies[0]).toMatchObject({
          imei, uploaded: cell.uploaded, derived: cell.expectedDerived,
        })
      }

      // The stored row must ALWAYS carry the DERIVED value — never the
      // uploaded free-text value verbatim — regardless of whether a
      // discrepancy was logged.
      const detail = await api(`/api/manifests/${data.manifest_id}`)
      const detailData = await detail.json() as { expected: Array<{ grade: string; condition: string }> }
      expect(detailData.expected).toHaveLength(1)
      expect(detailData.expected[0].grade).toBe(cell.grade)
      expect(detailData.expected[0].condition).toBe(cell.expectedDerived)
    })
  }

  it('a manifest row with no condition column at all still gets one derived from grade', async () => {
    const imei = luhnImei()
    const res = await api('/api/manifests', {
      method: 'POST',
      body: JSON.stringify({
        reference: `MF-COND-NOCOL-${Date.now()}`,
        supplier: 'Condition Derivation Test Vendor',
        rows: [{ imei, model_no: 'iPhone 17', capacity: '256GB', grade: 'A' }],
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as {
      ok: boolean; manifest_id: number
      condition_discrepancies: Array<unknown>
    }
    expect(data.ok).toBe(true)
    expect(data.condition_discrepancies).toEqual([])
    const detail = await api(`/api/manifests/${data.manifest_id}`)
    const detailData = await detail.json() as { expected: Array<{ condition: string }> }
    expect(detailData.expected[0].condition).toBe('REFURBISHED')
  })

  it('the expected_devices.grade CHECK constraint rejects a raw grade outside A/B/C/UG at the DB level', async () => {
    // This exercises the CHECK added by 0030 directly (bypassing
    // normalizeGrade() entirely) to prove the CONSTRAINT itself is
    // correctly in place — separate from, and not a substitute for, the
    // still-open normalizeGrade() D/E-laundering gap flagged in
    // src/lib/condition.ts (that gap is about the APPLICATION layer
    // laundering D/E to UG before this constraint ever sees it; this test
    // proves the constraint itself does its job against a raw bad value).
    await expect(
      testEnv.DB.prepare(
        `INSERT INTO expected_devices (manifest_id, imei, grade, condition, organisation_id)
         VALUES (1, ?, 'D', 'RAW', 1)`
      ).bind(luhnImei()).run()
    ).rejects.toThrow()
  })
})
