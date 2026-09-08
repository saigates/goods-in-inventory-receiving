// sku_map / zoho_items loader — migration 0032, src/lib/skuMapImport.ts,
// src/routes/skuMap.ts.
//
// Pure-function tests (parse/validate/diff) use hand-built fixture rows,
// not the real Z-G-MAPPING.csv (which is a user-uploaded file outside the
// repo, not a fixture this suite can depend on existing). The specific
// facts this suite locks in were independently verified against the real
// file during the 2026-09-08 validation pass (row count 747 vs 749
// expected — a delta, reported, not silently absorbed; 3 intentional
// shared Zoho Item IDs; 0 bijection breaks) — see the chat report for that
// reconciliation. This file only proves the LOADER enforces the rules
// correctly on deliberately-constructed cases, including the negative
// ones the real file (being clean) never exercises.
import { env } from 'cloudflare:workers'
import { describe, expect, it, beforeEach } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'
import type { AuthUser } from '../src/types'
import {
  parseSkuMapCsv,
  validateSkuMapCsv,
  computeImportDiff,
  applySkuMapImport,
  type SkuMapCsvRow,
} from '../src/lib/skuMapImport'

const JWT_SECRET = 'test-secret-sku-map'
const testEnv = { ...env, JWT_SECRET } as typeof env & { JWT_SECRET: string }
const db = () => (env as unknown as { DB: D1Database }).DB

const MANAGER_USER: AuthUser = {
  id: 801, email: 'manager-skumap@example.com', name: 'SkuMap Manager', role: 'manager', organisation_id: 1,
}
const OPERATOR_USER: AuthUser = {
  id: 802, email: 'operator-skumap@example.com', name: 'SkuMap Operator', role: 'operator', organisation_id: 1,
}

async function apiAs(user: AuthUser, path: string, init: RequestInit = {}) {
  const token = await signAuthToken(JWT_SECRET, user)
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  }, testEnv)
}

beforeEach(async () => {
  for (const u of [MANAGER_USER, OPERATOR_USER]) {
    await db().prepare(
      `INSERT OR IGNORE INTO users (id, email, name, role, organisation_id) VALUES (?, ?, ?, ?, ?)`
    ).bind(u.id, u.email, u.name, u.role, u.organisation_id).run()
  }
})

function csvHeader(): string {
  return 'SKU,Brand,Model,Capacity,Color,Grade,Zoho Item ID,Zoho SKU,Zoho Item Name'
}
function csvRow(f: Partial<Record<keyof SkuMapCsvRow, string>>): string {
  const d: SkuMapCsvRow = {
    SKU: 'APL-TEST-128-BLK-A', Brand: 'APPLE', Model: 'TEST MODEL', Capacity: '128GB',
    Color: 'BLACK', Grade: 'A', 'Zoho Item ID': '900000000000001', 'Zoho SKU': 'TEST-128-BLK-A',
    'Zoho Item Name': 'APPLE TEST MODEL-128GB/BLACK/A',
  }
  const merged = { ...d, ...f }
  return [merged.SKU, merged.Brand, merged.Model, merged.Capacity, merged.Color, merged.Grade,
    merged['Zoho Item ID'], merged['Zoho SKU'], merged['Zoho Item Name']].join(',')
}
function buildCsv(rows: string[]): string {
  return [csvHeader(), ...rows].join('\r\n') + '\r\n'
}

describe('parseSkuMapCsv', () => {
  it('parses a clean file and reports fileLineCount matching row count', () => {
    const csv = buildCsv([csvRow({ SKU: 'A1' }), csvRow({ SKU: 'A2', 'Zoho Item ID': '900000000000002', 'Zoho SKU': 'TEST-2' })])
    const result = parseSkuMapCsv(csv)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toHaveLength(2)
    expect(result.fileLineCount).toBe(2)
  })

  it('rejects a file missing a required header', () => {
    const badCsv = 'SKU,Brand\nAPL-X,APPLE\n'
    const result = parseSkuMapCsv(badCsv)
    expect(result.ok).toBe(false)
  })

  it('tolerates a single trailing blank line without inflating the row count', () => {
    const csv = buildCsv([csvRow({ SKU: 'A1' })])
    // buildCsv already ends with \r\n (one trailing blank line implied) —
    // confirm this doesn't get counted as a phantom second row.
    const result = parseSkuMapCsv(csv)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toHaveLength(1)
  })
})

describe('validateSkuMapCsv — load-time checks', () => {
  it('clean file: ok=true, zero errors, rowCountDelta=0', () => {
    const rows: SkuMapCsvRow[] = [
      JSON.parse(JSON.stringify({ SKU: 'A1', Brand: 'APPLE', Model: 'M', Capacity: '128GB', Color: 'BLACK', Grade: 'A', 'Zoho Item ID': '1', 'Zoho SKU': 'Z1', 'Zoho Item Name': 'N1' })),
      JSON.parse(JSON.stringify({ SKU: 'A2', Brand: 'APPLE', Model: 'M', Capacity: '128GB', Color: 'BLACK', Grade: 'B', 'Zoho Item ID': '2', 'Zoho SKU': 'Z2', 'Zoho Item Name': 'N2' })),
    ]
    const v = validateSkuMapCsv(rows, 2)
    expect(v.ok).toBe(true)
    expect(v.errors).toHaveLength(0)
    expect(v.rowCountDelta).toBe(0)
    expect(v.sharedZohoItems).toHaveLength(0)
  })

  it('duplicate goods_in_sku fails the load', () => {
    const rows: SkuMapCsvRow[] = [
      { SKU: 'DUP', Brand: 'APPLE', Model: 'M', Capacity: '128GB', Color: 'BLACK', Grade: 'A', 'Zoho Item ID': '1', 'Zoho SKU': 'Z1', 'Zoho Item Name': 'N1' } as SkuMapCsvRow,
      { SKU: 'DUP', Brand: 'APPLE', Model: 'M', Capacity: '128GB', Color: 'BLACK', Grade: 'B', 'Zoho Item ID': '2', 'Zoho SKU': 'Z2', 'Zoho Item Name': 'N2' } as SkuMapCsvRow,
    ]
    const v = validateSkuMapCsv(rows, 2)
    expect(v.ok).toBe(false)
    expect(v.errors.some(e => e.includes('Duplicate goods_in_sku'))).toBe(true)
  })

  it('one zoho_item_id under two different zoho_sku strings fails (bijection break)', () => {
    const rows: SkuMapCsvRow[] = [
      { SKU: 'A1', Brand: 'APPLE', Model: 'M', Capacity: '128GB', Color: 'BLACK', Grade: 'A', 'Zoho Item ID': 'SAME_ID', 'Zoho SKU': 'Z1', 'Zoho Item Name': 'N1' } as SkuMapCsvRow,
      { SKU: 'A2', Brand: 'APPLE', Model: 'M', Capacity: '128GB', Color: 'BLACK', Grade: 'B', 'Zoho Item ID': 'SAME_ID', 'Zoho SKU': 'Z_DIFFERENT', 'Zoho Item Name': 'N2' } as SkuMapCsvRow,
    ]
    const v = validateSkuMapCsv(rows, 2)
    expect(v.ok).toBe(false)
    expect(v.errors.some(e => e.includes('bijection broken'))).toBe(true)
  })

  it('one zoho_sku under two different zoho_item_id values fails (bijection break, other direction)', () => {
    const rows: SkuMapCsvRow[] = [
      { SKU: 'A1', Brand: 'APPLE', Model: 'M', Capacity: '128GB', Color: 'BLACK', Grade: 'A', 'Zoho Item ID': 'ID_1', 'Zoho SKU': 'SAME_SKU', 'Zoho Item Name': 'N1' } as SkuMapCsvRow,
      { SKU: 'A2', Brand: 'APPLE', Model: 'M', Capacity: '128GB', Color: 'BLACK', Grade: 'B', 'Zoho Item ID': 'ID_2', 'Zoho SKU': 'SAME_SKU', 'Zoho Item Name': 'N2' } as SkuMapCsvRow,
    ]
    const v = validateSkuMapCsv(rows, 2)
    expect(v.ok).toBe(false)
    expect(v.errors.some(e => e.includes('bijection broken'))).toBe(true)
  })

  it('a zoho_item_id referenced by multiple goods_in_sku is PERMITTED and reported informationally, not a failure', () => {
    const rows: SkuMapCsvRow[] = [
      { SKU: 'PHYS-A', Brand: 'APPLE', Model: 'M', Capacity: '128GB', Color: 'RED', Grade: 'B', 'Zoho Item ID': 'SHARED_ID', 'Zoho SKU': 'Z_SHARED', 'Zoho Item Name': 'N_SHARED' } as SkuMapCsvRow,
      { SKU: 'PHYS-A-ESIM', Brand: 'APPLE', Model: 'M', Capacity: '128GB', Color: 'RED', Grade: 'B', 'Zoho Item ID': 'SHARED_ID', 'Zoho SKU': 'Z_SHARED', 'Zoho Item Name': 'N_SHARED' } as SkuMapCsvRow,
    ]
    const v = validateSkuMapCsv(rows, 2)
    expect(v.ok).toBe(true)
    expect(v.sharedZohoItems).toEqual([{ zoho_item_id: 'SHARED_ID', goods_in_skus: ['PHYS-A', 'PHYS-A-ESIM'] }])
  })

  it('blank required field fails the load', () => {
    const rows: SkuMapCsvRow[] = [
      { SKU: 'A1', Brand: '', Model: 'M', Capacity: '128GB', Color: 'BLACK', Grade: 'A', 'Zoho Item ID': '1', 'Zoho SKU': 'Z1', 'Zoho Item Name': 'N1' } as SkuMapCsvRow,
    ]
    const v = validateSkuMapCsv(rows, 1)
    expect(v.ok).toBe(false)
    expect(v.errors.some(e => e.includes('Brand is blank'))).toBe(true)
  })
})

describe('computeImportDiff — column-scoped, never touches note, orphan detection', () => {
  it('a row present in DB but absent from the file is reported as a new orphan, not silently dropped', () => {
    const rows: SkuMapCsvRow[] = [
      { SKU: 'STILL-HERE', Brand: 'APPLE', Model: 'M', Capacity: '128GB', Color: 'BLACK', Grade: 'A', 'Zoho Item ID': '1', 'Zoho SKU': 'Z1', 'Zoho Item Name': 'N1' } as SkuMapCsvRow,
    ]
    const existingSkuMap = [
      { goods_in_sku: 'STILL-HERE', zoho_item_id: '1', brand: 'APPLE', model: 'M', capacity: '128GB', color: 'BLACK', grade: 'A', orphaned_at: null },
      { goods_in_sku: 'GONE-NOW', zoho_item_id: '2', brand: 'APPLE', model: 'M', capacity: '256GB', color: 'RED', grade: 'B', orphaned_at: null },
    ]
    const existingZohoItems = [
      { zoho_item_id: '1', zoho_sku: 'Z1', zoho_item_name: 'N1' },
      { zoho_item_id: '2', zoho_sku: 'Z2', zoho_item_name: 'N2' },
    ]
    const diff = computeImportDiff(rows, existingSkuMap, existingZohoItems)
    expect(diff.newOrphans).toEqual([{ goods_in_sku: 'GONE-NOW' }])
    expect(diff.adds).toHaveLength(0)
    expect(diff.changes).toHaveLength(0)
  })

  it('a zoho_item rename (same ID, new SKU/name) is reported as a rename, not an error', () => {
    const rows: SkuMapCsvRow[] = [
      { SKU: 'A1', Brand: 'APPLE', Model: 'M', Capacity: '128GB', Color: 'BLACK', Grade: 'A', 'Zoho Item ID': '1', 'Zoho SKU': 'Z1-RENAMED', 'Zoho Item Name': 'NEW NAME' } as SkuMapCsvRow,
    ]
    const existingSkuMap = [
      { goods_in_sku: 'A1', zoho_item_id: '1', brand: 'APPLE', model: 'M', capacity: '128GB', color: 'BLACK', grade: 'A', orphaned_at: null },
    ]
    const existingZohoItems = [{ zoho_item_id: '1', zoho_sku: 'Z1-OLD', zoho_item_name: 'OLD NAME' }]
    const diff = computeImportDiff(rows, existingSkuMap, existingZohoItems)
    expect(diff.renames).toEqual(expect.arrayContaining([
      { zoho_item_id: '1', field: 'zoho_sku', old_value: 'Z1-OLD', new_value: 'Z1-RENAMED' },
      { zoho_item_id: '1', field: 'zoho_item_name', old_value: 'OLD NAME', new_value: 'NEW NAME' },
    ]))
  })

  it('a row that reappears after being orphaned is flagged for un-orphaning (reReOrphaned)', () => {
    const rows: SkuMapCsvRow[] = [
      { SKU: 'BACK-AGAIN', Brand: 'APPLE', Model: 'M', Capacity: '128GB', Color: 'BLACK', Grade: 'A', 'Zoho Item ID': '1', 'Zoho SKU': 'Z1', 'Zoho Item Name': 'N1' } as SkuMapCsvRow,
    ]
    const existingSkuMap = [
      { goods_in_sku: 'BACK-AGAIN', zoho_item_id: '1', brand: 'APPLE', model: 'M', capacity: '128GB', color: 'BLACK', grade: 'A', orphaned_at: '2026-01-01T00:00:00Z' },
    ]
    const existingZohoItems = [{ zoho_item_id: '1', zoho_sku: 'Z1', zoho_item_name: 'N1' }]
    const diff = computeImportDiff(rows, existingSkuMap, existingZohoItems)
    expect(diff.reReOrphaned).toEqual(['BACK-AGAIN'])
  })
})

describe('POST /api/sku-map/import — HTTP level', () => {
  it('non-manager (operator) gets 403, nothing written', async () => {
    const csv = buildCsv([csvRow({ SKU: 'HTTP-A1' })])
    const res = await apiAs(OPERATOR_USER, '/api/sku-map/import', { method: 'POST', body: csv, headers: { 'Content-Type': 'text/csv' } })
    expect(res.status).toBe(403)
    const row = await db().prepare('SELECT * FROM sku_map WHERE goods_in_sku = ?').bind('HTTP-A1').first()
    expect(row).toBeNull()
  })

  it('dry_run=1 computes the diff but writes nothing', async () => {
    const csv = buildCsv([csvRow({ SKU: 'DRYRUN-A1' })])
    const res = await apiAs(MANAGER_USER, '/api/sku-map/import?dry_run=1', { method: 'POST', body: csv, headers: { 'Content-Type': 'text/csv' } })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.dryRun).toBe(true)
    expect(body.diff.adds).toEqual([{ goods_in_sku: 'DRYRUN-A1', zoho_item_id: '900000000000001' }])
    const row = await db().prepare('SELECT * FROM sku_map WHERE goods_in_sku = ?').bind('DRYRUN-A1').first()
    expect(row).toBeNull()
  })

  it('real import (dry_run absent) writes sku_map + zoho_items and bumps mapping_version exactly once', async () => {
    const beforeVersion = await apiAs(MANAGER_USER, '/api/sku-map/version')
    const { mapping_version: v0 } = await beforeVersion.json() as { mapping_version: number }

    const csv = buildCsv([csvRow({ SKU: 'REAL-A1' })])
    const res = await apiAs(MANAGER_USER, '/api/sku-map/import', { method: 'POST', body: csv, headers: { 'Content-Type': 'text/csv' } })
    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.mappingVersion).toBe(v0 + 1)

    const row = await db().prepare('SELECT * FROM sku_map WHERE goods_in_sku = ?').bind('REAL-A1').first<any>()
    expect(row).not.toBeNull()
    expect(row.zoho_item_id).toBe('900000000000001')
    expect(row.note).toBeNull()
  })

  it('a manually-entered note survives a re-import that changes only the zoho_item_id (column-scoped write)', async () => {
    // Initial import.
    const csv1 = buildCsv([csvRow({ SKU: 'NOTE-SURVIVES', 'Zoho Item ID': '900000000000010', 'Zoho SKU': 'Z10' })])
    await apiAs(MANAGER_USER, '/api/sku-map/import', { method: 'POST', body: csv1, headers: { 'Content-Type': 'text/csv' } })

    // UI edit: attach a note (row_version starts at 1 after the initial import).
    const existing = await db().prepare('SELECT row_version FROM sku_map WHERE goods_in_sku = ?').bind('NOTE-SURVIVES').first<{ row_version: number }>()
    const patchRes = await apiAs(MANAGER_USER, '/api/sku-map/NOTE-SURVIVES', {
      method: 'PATCH',
      body: JSON.stringify({ note: 'This note must survive a future CSV re-import', row_version: existing!.row_version }),
    })
    expect(patchRes.status).toBe(200)

    // Re-import: same SKU, DIFFERENT zoho item id/sku, no note column exists in CSV at all.
    const csv2 = buildCsv([csvRow({ SKU: 'NOTE-SURVIVES', 'Zoho Item ID': '900000000000011', 'Zoho SKU': 'Z11' })])
    const reimport = await apiAs(MANAGER_USER, '/api/sku-map/import', { method: 'POST', body: csv2, headers: { 'Content-Type': 'text/csv' } })
    expect(reimport.status).toBe(201)

    const after = await db().prepare('SELECT * FROM sku_map WHERE goods_in_sku = ?').bind('NOTE-SURVIVES').first<any>()
    expect(after.zoho_item_id).toBe('900000000000011') // CSV wins on this column
    expect(after.note).toBe('This note must survive a future CSV re-import') // but never touches note
  })

  it('a row missing from a re-import is marked orphaned, never deleted', async () => {
    const csv1 = buildCsv([csvRow({ SKU: 'WILL-BE-ORPHANED' })])
    await apiAs(MANAGER_USER, '/api/sku-map/import', { method: 'POST', body: csv1, headers: { 'Content-Type': 'text/csv' } })

    // Re-import a file that no longer mentions WILL-BE-ORPHANED at all.
    const csv2 = buildCsv([csvRow({ SKU: 'SOME-OTHER-SKU', 'Zoho Item ID': '900000000000099', 'Zoho SKU': 'Z99' })])
    const reimport = await apiAs(MANAGER_USER, '/api/sku-map/import', { method: 'POST', body: csv2, headers: { 'Content-Type': 'text/csv' } })
    expect(reimport.status).toBe(201)
    const body = await reimport.json() as any
    expect(body.diff.newOrphans).toEqual(expect.arrayContaining([{ goods_in_sku: 'WILL-BE-ORPHANED' }]))

    const row = await db().prepare('SELECT * FROM sku_map WHERE goods_in_sku = ?').bind('WILL-BE-ORPHANED').first<any>()
    expect(row).not.toBeNull() // still exists — not a DELETE
    expect(row.orphaned_at).not.toBeNull()
  })

  it('an import overwriting an existing zoho_item_id writes a pre-image audit row', async () => {
    const csv1 = buildCsv([csvRow({ SKU: 'AUDIT-ME', 'Zoho Item ID': '900000000000020', 'Zoho SKU': 'Z20' })])
    await apiAs(MANAGER_USER, '/api/sku-map/import', { method: 'POST', body: csv1, headers: { 'Content-Type': 'text/csv' } })

    const csv2 = buildCsv([csvRow({ SKU: 'AUDIT-ME', 'Zoho Item ID': '900000000000021', 'Zoho SKU': 'Z21' })])
    await apiAs(MANAGER_USER, '/api/sku-map/import', { method: 'POST', body: csv2, headers: { 'Content-Type': 'text/csv' } })

    const { results } = await db().prepare(
      `SELECT * FROM sku_map_audit WHERE goods_in_sku = 'AUDIT-ME' ORDER BY id ASC`
    ).all<any>()
    expect(results).toHaveLength(1)
    expect(results[0].old_zoho_item_id).toBe('900000000000020')
    expect(results[0].new_zoho_item_id).toBe('900000000000021')
    expect(results[0].source).toBe('import')
  })
})

describe('PATCH /api/sku-map/:goods_in_sku — optimistic locking', () => {
  it('a stale row_version is rejected with 409, not silently applied', async () => {
    const csv = buildCsv([csvRow({ SKU: 'LOCK-TEST', 'Zoho Item ID': '900000000000030', 'Zoho SKU': 'Z30' })])
    await apiAs(MANAGER_USER, '/api/sku-map/import', { method: 'POST', body: csv, headers: { 'Content-Type': 'text/csv' } })

    // Editor A reads row_version=1 and edits successfully.
    const res1 = await apiAs(MANAGER_USER, '/api/sku-map/LOCK-TEST', {
      method: 'PATCH', body: JSON.stringify({ note: 'Editor A note', row_version: 1 }),
    })
    expect(res1.status).toBe(200)

    // Editor B still holds the STALE row_version=1 and tries to write —
    // must be rejected, not silently clobber Editor A's write.
    const res2 = await apiAs(MANAGER_USER, '/api/sku-map/LOCK-TEST', {
      method: 'PATCH', body: JSON.stringify({ note: 'Editor B note (stale)', row_version: 1 }),
    })
    expect(res2.status).toBe(409)

    const row = await db().prepare('SELECT note FROM sku_map WHERE goods_in_sku = ?').bind('LOCK-TEST').first<{ note: string }>()
    expect(row!.note).toBe('Editor A note')
  })

  it('reassigning to a zoho_item_id writes a ui_edit audit row with a reason', async () => {
    const csv = buildCsv([
      csvRow({ SKU: 'REASSIGN-ME', 'Zoho Item ID': '900000000000040', 'Zoho SKU': 'Z40' }),
      csvRow({ SKU: 'DONOR-ROW', 'Zoho Item ID': '900000000000041', 'Zoho SKU': 'Z41' }),
    ])
    await apiAs(MANAGER_USER, '/api/sku-map/import', { method: 'POST', body: csv, headers: { 'Content-Type': 'text/csv' } })

    const patch = await apiAs(MANAGER_USER, '/api/sku-map/REASSIGN-ME', {
      method: 'PATCH',
      body: JSON.stringify({ zoho_item_id: '900000000000041', reason: 'Manual correction after Zoho catalogue merge', row_version: 1 }),
    })
    expect(patch.status).toBe(200)

    const { results } = await db().prepare(
      `SELECT * FROM sku_map_audit WHERE goods_in_sku = 'REASSIGN-ME' AND source = 'ui_edit'`
    ).all<any>()
    expect(results).toHaveLength(1)
    expect(results[0].old_zoho_item_id).toBe('900000000000040')
    expect(results[0].new_zoho_item_id).toBe('900000000000041')
    expect(results[0].reason).toBe('Manual correction after Zoho catalogue merge')
  })
})

describe('GET /api/sku-map/shared — three intentional shared-ID pairs pattern', () => {
  it('a zoho_item_id referenced by two live goods_in_sku rows appears once in the shared view with both SKUs', async () => {
    const csv = buildCsv([
      csvRow({ SKU: 'SHARED-PHYS', 'Zoho Item ID': '900000000000050', 'Zoho SKU': 'Z50' }),
      csvRow({ SKU: 'SHARED-ESIM', 'Zoho Item ID': '900000000000050', 'Zoho SKU': 'Z50' }),
    ])
    await apiAs(MANAGER_USER, '/api/sku-map/import', { method: 'POST', body: csv, headers: { 'Content-Type': 'text/csv' } })

    const res = await apiAs(MANAGER_USER, '/api/sku-map/shared')
    expect(res.status).toBe(200)
    const body = await res.json() as any
    const entry = body.shared.find((s: any) => s.zoho_item_id === '900000000000050')
    expect(entry).toBeDefined()
    expect(entry.goods_in_skus.sort()).toEqual(['SHARED-ESIM', 'SHARED-PHYS'])
  })
})

describe('applySkuMapImport — invalid file never writes anything (hard-fail on intra-file contradiction)', () => {
  it('a bijection-breaking file is refused with zero DB writes', async () => {
    const csv = buildCsv([
      csvRow({ SKU: 'BAD-A', 'Zoho Item ID': 'BROKEN_ID', 'Zoho SKU': 'Z_A' }),
      csvRow({ SKU: 'BAD-B', 'Zoho Item ID': 'BROKEN_ID', 'Zoho SKU': 'Z_B' }),
    ])
    const result = await applySkuMapImport(db(), 1, csv, { dryRun: false, actorUserId: MANAGER_USER.id })
    expect(result.ok).toBe(false)
    const rowA = await db().prepare('SELECT * FROM sku_map WHERE goods_in_sku = ?').bind('BAD-A').first()
    const rowB = await db().prepare('SELECT * FROM sku_map WHERE goods_in_sku = ?').bind('BAD-B').first()
    expect(rowA).toBeNull()
    expect(rowB).toBeNull()
  })
})
