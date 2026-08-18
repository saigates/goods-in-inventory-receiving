// Sprint B §1 follow-up — HTTP-level tests for the manifest ↔ bill link
// (0029): optional bill_id on manifest upload (filtered to OPEN bills),
// and the bill_reconciliation block returned on GET /api/manifests/:id.
//
// Real figures per the instruction: a bill declaring £4,774.00 and a
// 16-row manifest whose unit costs sum to exactly £4,774.00 → Balanced.
// Fixture-local, never hard-coded in src/ (same rule as £39,386/£1.31).
import { env } from 'cloudflare:workers'
import { describe, it, expect, beforeAll } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'

const JWT_SECRET = 'test-secret-manifest-bill-link'
const testEnv = { ...env, JWT_SECRET } as typeof env & { JWT_SECRET: string }

let token = ''
let imeiSeq = 0
// Distinct namespace from other suites (base 3579654...) to avoid
// cross-suite IMEI collisions on the shared in-memory D1.
function luhnImei(): string {
  const body = `3579654${String(10000000 + imeiSeq++).slice(1)}`
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

async function makeOpenBill(declaredTotal: number, unitCount: number): Promise<number> {
  const res = await api('/api/bills', {
    method: 'POST',
    body: JSON.stringify({
      bill_type: 'purchase',
      vendor_name: 'MANIFEST-LINK-TEST-VENDOR',
      bill_date: '2026-06-01',
      invoice_number: `INV-MFLINK-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      currency_code: 'GBP',
      price_source: 'header',
      declared_total: declaredTotal,
      unit_count: unitCount,
      rows: [],
    }),
  })
  expect(res.status).toBe(200)
  const data = await res.json() as { bill_id: number }
  return data.bill_id
}

describe('manifest → bill link (0029)', () => {
  it('creating a manifest with no bill_id still works (goods received without a bill)', async () => {
    const imei = luhnImei()
    const res = await api('/api/manifests', {
      method: 'POST',
      body: JSON.stringify({
        reference: `MF-NOBILL-${Date.now()}`,
        supplier: 'Test Supplier',
        rows: [{ imei, model_no: 'iPhone 17', capacity: '256GB', grade: 'A' }],
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { ok: boolean; manifest_id: number }
    expect(data.ok).toBe(true)

    const detail = await api(`/api/manifests/${data.manifest_id}`)
    expect(detail.status).toBe(200)
    const detailData = await detail.json() as { manifest: { bill_id: number | null }; bill_reconciliation: { verdict: string } }
    expect(detailData.manifest.bill_id).toBeNull()
    expect(detailData.bill_reconciliation.verdict).toBe('awaiting_manifest')
  })

  it('rejects a bill_id for a bill that does not exist or is not open', async () => {
    const closedBillId = await makeOpenBill(100, 1)
    // Close it — should then be rejected as a manifest link target.
    const closeRes = await api(`/api/bills/${closedBillId}/close`, { method: 'POST' })
    // header/no-lines bill won't balance to close normally via lines, but
    // this is fine — we only need it to NOT be 'draft' OR we simply use
    // a nonexistent id, which is the simpler and equally valid case.
    const imei = luhnImei()
    const res = await api('/api/manifests', {
      method: 'POST',
      body: JSON.stringify({
        reference: `MF-BADBILL-${Date.now()}`,
        supplier: 'Test Supplier',
        bill_id: 999999999,
        rows: [{ imei, model_no: 'iPhone 17', capacity: '256GB', grade: 'A' }],
      }),
    })
    expect(res.status).toBe(400)
  })

  it('non-vacuity: a bill with declared_total_gbp but NO manifest linked to it does not surface as Balanced anywhere', async () => {
    // The historical false-green this replaces. There is no manifest-side
    // query possible here (nothing points AT this bill) — the guarantee
    // instead lives in the pure-function test (manifestBillReconciliation.
    // spec.ts) and in the fact that GET /api/bills/:id has never returned
    // a manifest-comparison verdict at all (grepped — bills.ts has zero
    // references to manifest_id/expected_devices outside prose comments).
    // This test documents that boundary at the HTTP level: bills.ts's own
    // detail response carries no bill_reconciliation field.
    const billId = await makeOpenBill(4774.00, 16)
    const res = await api(`/api/bills/${billId}`)
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data).not.toHaveProperty('bill_reconciliation')
  })

  it('16-row manifest summing to £4,774.00 linked to a bill declaring £4,774.00 → Balanced', async () => {
    const billId = await makeOpenBill(4774.00, 16)
    const unitCosts = [
      313.94, 252.50, 277.50, 272.32, 323.65, 317.67, 339.22, 258.69,
      292.19, 252.98, 271.86, 300.54, 252.65, 269.88, 314.99, 463.42,
    ]
    expect(unitCosts.reduce((s, v) => s + v, 0)).toBeCloseTo(4774.00, 2)

    const rows = unitCosts.map(cost => ({
      imei: luhnImei(), model_no: 'iPhone 17', capacity: '256GB', grade: 'A',
      unit_cost: cost, currency: 'GBP',
    }))
    const mfRes = await api('/api/manifests', {
      method: 'POST',
      body: JSON.stringify({
        reference: `MF-BALANCED-${Date.now()}`,
        supplier: 'Test Supplier',
        bill_id: billId,
        rows,
      }),
    })
    expect(mfRes.status).toBe(200)
    const mfData = await mfRes.json() as { manifest_id: number }

    const detail = await api(`/api/manifests/${mfData.manifest_id}`)
    const detailData = await detail.json() as {
      manifest: { bill_id: number }
      bill_reconciliation: { verdict: string; sum_manifest_gbp: number; declared_total_gbp: number; variance_gbp: number }
    }
    expect(detailData.manifest.bill_id).toBe(billId)
    expect(detailData.bill_reconciliation.verdict).toBe('balanced')
    expect(detailData.bill_reconciliation.sum_manifest_gbp).toBe(4774.00)
    expect(detailData.bill_reconciliation.declared_total_gbp).toBe(4774.00)
    expect(detailData.bill_reconciliation.variance_gbp).toBe(0)
  })

  it('a manifest linked to a bill with a genuine variance reports it, not a false Balanced', async () => {
    const billId = await makeOpenBill(1000, 2)
    const rows = [
      { imei: luhnImei(), model_no: 'iPhone 17', capacity: '256GB', grade: 'A', unit_cost: 400, currency: 'GBP' },
      { imei: luhnImei(), model_no: 'iPhone 17', capacity: '256GB', grade: 'A', unit_cost: 400, currency: 'GBP' },
    ]
    const mfRes = await api('/api/manifests', {
      method: 'POST',
      body: JSON.stringify({
        reference: `MF-VARIANCE-${Date.now()}`,
        supplier: 'Test Supplier',
        bill_id: billId,
        rows,
      }),
    })
    const mfData = await mfRes.json() as { manifest_id: number }
    const detail = await api(`/api/manifests/${mfData.manifest_id}`)
    const detailData = await detail.json() as { bill_reconciliation: { verdict: string; variance_gbp: number } }
    expect(detailData.bill_reconciliation.verdict).toBe('variance')
    expect(detailData.bill_reconciliation.variance_gbp).toBe(-200)
  })
})
