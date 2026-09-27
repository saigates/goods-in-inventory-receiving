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
import { Hono } from 'hono'
import { describe, expect, it, beforeEach } from 'vitest'
import app from '../src/index'
import { authMiddleware, signAuthToken } from '../src/lib/auth'
import skuMapRoute from '../src/routes/skuMap'
import type { AuthUser, Bindings } from '../src/types'
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

// Test-local harness. Originally written while production had /api/sku-map
// unmounted (2026-09-10 incident response); the route was re-mounted in
// src/index.tsx on 2026-09-11 (Quick Item B — see the GUARD describe block
// below, which now proves the OPPOSITE fact and is the live source of
// truth on mount status). This comment previously read "production
// retired /api/sku-map" — stale as of the re-mount, corrected here
// (2026-09-27) rather than left contradicting the GUARD block beneath it.
// The harness itself needed no change either time: mounting the SAME
// router (skuMapRoute, unmodified) under a test-local Hono instance with
// the SAME auth middleware wiring as src/index.tsx lets these HTTP-level
// tests keep proving the route's actual request/response contract
// independently of whether the production app currently exposes it.
const localApp = new Hono<{ Bindings: Bindings; Variables: { user: AuthUser } }>()
localApp.use('/api/*', async (c, next) => authMiddleware(c, next))
localApp.route('/api/sku-map', skuMapRoute)

async function apiAs(user: AuthUser, path: string, init: RequestInit = {}) {
  const token = await signAuthToken(JWT_SECRET, user)
  return localApp.request(path, {
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

describe('POST /api/sku-map — manual single-row create (Z-4 phase 1)', () => {
  it('non-manager (operator) gets 403, nothing written', async () => {
    const res = await apiAs(OPERATOR_USER, '/api/sku-map', {
      method: 'POST',
      body: JSON.stringify({
        goods_in_sku: 'MANUAL-403', zoho_item_id: '900000000000000100',
        zoho_sku: 'M100', zoho_item_name: 'Manual Test 100', brand: 'APPLE', model: 'TEST',
      }),
    })
    expect(res.status).toBe(403)
    const row = await db().prepare('SELECT * FROM sku_map WHERE goods_in_sku = ?').bind('MANUAL-403').first()
    expect(row).toBeNull()
  })

  it('rejects a zoho_item_id that is not exactly 18 numeric digits', async () => {
    const res = await apiAs(MANAGER_USER, '/api/sku-map', {
      method: 'POST',
      body: JSON.stringify({
        goods_in_sku: 'MANUAL-BADID', zoho_item_id: '12345', // too short
        zoho_sku: 'BADID', zoho_item_name: 'Bad Id', brand: 'APPLE', model: 'TEST',
      }),
    })
    expect(res.status).toBe(422)
    const row = await db().prepare('SELECT * FROM sku_map WHERE goods_in_sku = ?').bind('MANUAL-BADID').first()
    expect(row).toBeNull()
  })

  it('creates a new goods_in_sku + a new zoho_items row when the Zoho ID is unseen', async () => {
    const res = await apiAs(MANAGER_USER, '/api/sku-map', {
      method: 'POST',
      body: JSON.stringify({
        goods_in_sku: 'MANUAL-NEW-1', zoho_item_id: '900000000000000101',
        zoho_sku: 'M101', zoho_item_name: 'Manual Test 101', brand: 'APPLE', model: 'TEST', capacity: '128GB',
      }),
    })
    expect(res.status).toBe(201)
    const row = await db().prepare('SELECT * FROM sku_map WHERE goods_in_sku = ?').bind('MANUAL-NEW-1').first<any>()
    expect(row).not.toBeNull()
    expect(row.zoho_item_id).toBe('900000000000000101')
    const zitem = await db().prepare('SELECT * FROM zoho_items WHERE zoho_item_id = ?').bind('900000000000000101').first()
    expect(zitem).not.toBeNull()
  })

  it('a second create against an already-mapped (live, non-orphaned) goods_in_sku is 409, not silently overwritten', async () => {
    await apiAs(MANAGER_USER, '/api/sku-map', {
      method: 'POST',
      body: JSON.stringify({
        goods_in_sku: 'MANUAL-DUP', zoho_item_id: '900000000000000102',
        zoho_sku: 'M102', zoho_item_name: 'Manual Test 102', brand: 'APPLE', model: 'TEST',
      }),
    })
    const res2 = await apiAs(MANAGER_USER, '/api/sku-map', {
      method: 'POST',
      body: JSON.stringify({
        goods_in_sku: 'MANUAL-DUP', zoho_item_id: '900000000000000103',
        zoho_sku: 'M103', zoho_item_name: 'Manual Test 103', brand: 'APPLE', model: 'TEST',
      }),
    })
    expect(res2.status).toBe(409)
    const row = await db().prepare('SELECT zoho_item_id FROM sku_map WHERE goods_in_sku = ?').bind('MANUAL-DUP').first<{ zoho_item_id: string }>()
    expect(row!.zoho_item_id).toBe('900000000000000102') // untouched
  })

  it('reuses an EXISTING zoho_item_id across a second goods_in_sku (many-to-one Zoho side is allowed)', async () => {
    await apiAs(MANAGER_USER, '/api/sku-map', {
      method: 'POST',
      body: JSON.stringify({
        goods_in_sku: 'MANUAL-SHARE-PHYS', zoho_item_id: '900000000000000104',
        zoho_sku: 'M104', zoho_item_name: 'Manual Shared Item', brand: 'APPLE', model: 'TEST',
      }),
    })
    const res2 = await apiAs(MANAGER_USER, '/api/sku-map', {
      method: 'POST',
      // No zoho_sku/zoho_item_name needed — the Zoho item already exists.
      body: JSON.stringify({
        goods_in_sku: 'MANUAL-SHARE-ESIM', zoho_item_id: '900000000000000104',
        brand: 'APPLE', model: 'TEST',
      }),
    })
    expect(res2.status).toBe(201)
    const rows = await db().prepare('SELECT goods_in_sku FROM sku_map WHERE zoho_item_id = ?').bind('900000000000000104').all<{ goods_in_sku: string }>()
    expect(rows.results.map(r => r.goods_in_sku).sort()).toEqual(['MANUAL-SHARE-ESIM', 'MANUAL-SHARE-PHYS'])
  })

  it('creating against a zoho_sku already used by a DIFFERENT zoho_item_id is a 409 (bijection protected)', async () => {
    await apiAs(MANAGER_USER, '/api/sku-map', {
      method: 'POST',
      body: JSON.stringify({
        goods_in_sku: 'MANUAL-BIJ-A', zoho_item_id: '900000000000000105',
        zoho_sku: 'M105-SHARED-SKU', zoho_item_name: 'Bijection A', brand: 'APPLE', model: 'TEST',
      }),
    })
    const res2 = await apiAs(MANAGER_USER, '/api/sku-map', {
      method: 'POST',
      body: JSON.stringify({
        goods_in_sku: 'MANUAL-BIJ-B', zoho_item_id: '900000000000000106',
        zoho_sku: 'M105-SHARED-SKU', zoho_item_name: 'Bijection B', brand: 'APPLE', model: 'TEST',
      }),
    })
    expect(res2.status).toBe(409)
  })

  it('the bijection-conflict 409 names the conflicting our-SKU, not just the Zoho Item ID, so the operator can find the row without a separate query', async () => {
    await apiAs(MANAGER_USER, '/api/sku-map', {
      method: 'POST',
      body: JSON.stringify({
        goods_in_sku: 'MANUAL-BIJ-NAMED-A', zoho_item_id: '900000000000000107',
        zoho_sku: 'M107-SHARED-SKU', zoho_item_name: 'Bijection Named A', brand: 'APPLE', model: 'TEST',
      }),
    })
    const res2 = await apiAs(MANAGER_USER, '/api/sku-map', {
      method: 'POST',
      body: JSON.stringify({
        goods_in_sku: 'MANUAL-BIJ-NAMED-B', zoho_item_id: '900000000000000108',
        zoho_sku: 'M107-SHARED-SKU', zoho_item_name: 'Bijection Named B', brand: 'APPLE', model: 'TEST',
      }),
    })
    expect(res2.status).toBe(409)
    const body = await res2.json() as { error: string; conflicting_zoho_item_id: string; conflicting_goods_in_skus: string[] }
    expect(body.error).toContain('MANUAL-BIJ-NAMED-A')
    expect(body.conflicting_zoho_item_id).toBe('900000000000000107')
    expect(body.conflicting_goods_in_skus).toEqual(['MANUAL-BIJ-NAMED-A'])
  })
})

describe('DELETE /api/sku-map/:goods_in_sku — remove mapping = orphan, never a hard delete (Z-4 phase 1)', () => {
  it('non-manager (operator) gets 403, row untouched', async () => {
    await apiAs(MANAGER_USER, '/api/sku-map', {
      method: 'POST',
      body: JSON.stringify({
        goods_in_sku: 'REMOVE-403', zoho_item_id: '900000000000000110',
        zoho_sku: 'R110', zoho_item_name: 'Remove Test 110', brand: 'APPLE', model: 'TEST',
      }),
    })
    const res = await apiAs(OPERATOR_USER, '/api/sku-map/REMOVE-403', { method: 'DELETE' })
    expect(res.status).toBe(403)
    const row = await db().prepare('SELECT orphaned_at FROM sku_map WHERE goods_in_sku = ?').bind('REMOVE-403').first<{ orphaned_at: string | null }>()
    expect(row!.orphaned_at).toBeNull()
  })

  it('404 for a goods_in_sku that has never existed', async () => {
    const res = await apiAs(MANAGER_USER, '/api/sku-map/NEVER-EXISTED-XYZ', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('sets orphaned_at, the row still exists (soft delete, not a real DELETE)', async () => {
    await apiAs(MANAGER_USER, '/api/sku-map', {
      method: 'POST',
      body: JSON.stringify({
        goods_in_sku: 'REMOVE-SOFT', zoho_item_id: '900000000000000111',
        zoho_sku: 'R111', zoho_item_name: 'Remove Test 111', brand: 'APPLE', model: 'TEST',
      }),
    })
    const res = await apiAs(MANAGER_USER, '/api/sku-map/REMOVE-SOFT', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const row = await db().prepare('SELECT * FROM sku_map WHERE goods_in_sku = ?').bind('REMOVE-SOFT').first<any>()
    expect(row).not.toBeNull() // still exists
    expect(row.orphaned_at).not.toBeNull()
  })

  it('is idempotent — removing an already-orphaned row is a 200 no-op, not a 409/404', async () => {
    await apiAs(MANAGER_USER, '/api/sku-map', {
      method: 'POST',
      body: JSON.stringify({
        goods_in_sku: 'REMOVE-TWICE', zoho_item_id: '900000000000000112',
        zoho_sku: 'R112', zoho_item_name: 'Remove Test 112', brand: 'APPLE', model: 'TEST',
      }),
    })
    const first = await apiAs(MANAGER_USER, '/api/sku-map/REMOVE-TWICE', { method: 'DELETE' })
    expect(first.status).toBe(200)
    const second = await apiAs(MANAGER_USER, '/api/sku-map/REMOVE-TWICE', { method: 'DELETE' })
    expect(second.status).toBe(200)
  })

  it('an orphaned mapping does not satisfy the export gate — it appears in the unmapped queue', async () => {
    await db().prepare(
      `INSERT INTO received_devices (organisation_id, uuid, imei, sku, source, status) VALUES (1, ?, ?, 'ORPHAN-GATE-SKU', 'manual', 'RECEIVED')`
    ).bind('orphan-gate-uuid-1', '990000000000001').run()
    await apiAs(MANAGER_USER, '/api/sku-map', {
      method: 'POST',
      body: JSON.stringify({
        goods_in_sku: 'ORPHAN-GATE-SKU', zoho_item_id: '900000000000000113',
        zoho_sku: 'R113', zoho_item_name: 'Remove Test 113', brand: 'APPLE', model: 'TEST',
      }),
    })
    // Mapped: must NOT appear in the unmapped queue.
    const before = await apiAs(MANAGER_USER, '/api/sku-map/unmapped')
    const beforeBody = await before.json() as { unmapped: Array<{ goods_in_sku: string }> }
    expect(beforeBody.unmapped.find(r => r.goods_in_sku === 'ORPHAN-GATE-SKU')).toBeUndefined()

    await apiAs(MANAGER_USER, '/api/sku-map/ORPHAN-GATE-SKU', { method: 'DELETE' })

    // Orphaned: must reappear in the unmapped queue, same as if never mapped.
    const after = await apiAs(MANAGER_USER, '/api/sku-map/unmapped')
    const afterBody = await after.json() as { unmapped: Array<{ goods_in_sku: string; device_count: number }> }
    const entry = afterBody.unmapped.find(r => r.goods_in_sku === 'ORPHAN-GATE-SKU')
    expect(entry).toBeDefined()
    expect(entry!.device_count).toBe(1)
  })

  it('re-mapping (POST) an orphaned goods_in_sku revives the existing row (updates in place) rather than erroring', async () => {
    await apiAs(MANAGER_USER, '/api/sku-map', {
      method: 'POST',
      body: JSON.stringify({
        goods_in_sku: 'REVIVE-ME', zoho_item_id: '900000000000000114',
        zoho_sku: 'R114', zoho_item_name: 'Revive Test 114', brand: 'APPLE', model: 'TEST',
      }),
    })
    await apiAs(MANAGER_USER, '/api/sku-map/REVIVE-ME', { method: 'DELETE' })

    const revive = await apiAs(MANAGER_USER, '/api/sku-map', {
      method: 'POST',
      body: JSON.stringify({
        goods_in_sku: 'REVIVE-ME', zoho_item_id: '900000000000000115',
        zoho_sku: 'R115', zoho_item_name: 'Revive Test 115 New', brand: 'APPLE', model: 'TEST', capacity: '256GB',
      }),
    })
    expect(revive.status).toBe(200) // revive, not 201 create — same row, not a new one

    const rows = await db().prepare('SELECT * FROM sku_map WHERE goods_in_sku = ?').bind('REVIVE-ME').all<any>()
    expect(rows.results).toHaveLength(1) // never a second row — PRIMARY KEY(goods_in_sku) would reject that anyway
    const row = rows.results[0]
    expect(row.orphaned_at).toBeNull()
    expect(row.zoho_item_id).toBe('900000000000000115')
    expect(row.capacity).toBe('256GB')

    // Revival is audited like any other zoho_item_id change.
    const audit = await db().prepare(
      `SELECT * FROM sku_map_audit WHERE goods_in_sku = 'REVIVE-ME' ORDER BY id DESC LIMIT 1`
    ).first<any>()
    expect(audit.old_zoho_item_id).toBe('900000000000000114')
    expect(audit.new_zoho_item_id).toBe('900000000000000115')
  })
})

describe('GET /api/sku-map/unmapped — grouped by our SKU with device counts, not per-device rows (Z-4 phase 1)', () => {
  it('groups multiple unmapped devices sharing a SKU into one row with the correct count', async () => {
    for (let i = 0; i < 3; i++) {
      await db().prepare(
        `INSERT INTO received_devices (organisation_id, uuid, imei, sku, source, status) VALUES (1, ?, ?, 'UNMAPPED-GROUP-SKU', 'manual', 'RECEIVED')`
      ).bind(`unmapped-group-uuid-${i}`, `99100000000000${i}`).run()
    }
    const res = await apiAs(MANAGER_USER, '/api/sku-map/unmapped')
    expect(res.status).toBe(200)
    const body = await res.json() as { unmapped: Array<{ goods_in_sku: string; device_count: number }> }
    const entry = body.unmapped.find(r => r.goods_in_sku === 'UNMAPPED-GROUP-SKU')
    expect(entry).toBeDefined()
    expect(entry!.device_count).toBe(3)
    // Exactly one row for this SKU — never one row per device.
    expect(body.unmapped.filter(r => r.goods_in_sku === 'UNMAPPED-GROUP-SKU')).toHaveLength(1)
  })

  it('a SKU with a live (non-orphaned) mapping does not appear in the queue', async () => {
    await db().prepare(
      `INSERT INTO received_devices (organisation_id, uuid, imei, sku, source, status) VALUES (1, ?, ?, 'MAPPED-EXCLUDED-SKU', 'manual', 'RECEIVED')`
    ).bind('mapped-excluded-uuid', '992000000000001').run()
    await apiAs(MANAGER_USER, '/api/sku-map', {
      method: 'POST',
      body: JSON.stringify({
        goods_in_sku: 'MAPPED-EXCLUDED-SKU', zoho_item_id: '900000000000000116',
        zoho_sku: 'R116', zoho_item_name: 'Excluded Test 116', brand: 'APPLE', model: 'TEST',
      }),
    })
    const res = await apiAs(MANAGER_USER, '/api/sku-map/unmapped')
    const body = await res.json() as { unmapped: Array<{ goods_in_sku: string }> }
    expect(body.unmapped.find(r => r.goods_in_sku === 'MAPPED-EXCLUDED-SKU')).toBeUndefined()
  })
})

describe('GUARD: /api/sku-map re-mounted on the deployed production app (2026-09-11, Quick Item B)', () => {
  // Flipped from the prior "stays unmounted" guard (2026-09-10 incident
  // response) per its own documented trigger: Quick Item B's precondition
  // (item 6's low-yield acknowledgment gate) is complete and tested green,
  // so app.route('/api/sku-map', skuMapRoute) was re-added in src/index.tsx.
  // This guard now proves the OPPOSITE fact — that the route IS live on
  // the real production app, not just the test-local `localApp` harness
  // above (which was always decoupled and provable either way) — so a
  // future accidental removal of the mount line is caught here, the same
  // way its removal was caught by the retired 404 assertion.
  it('the IMPORTED production app (src/index.tsx) returns a real response (200), not 404, for /api/sku-map', async () => {
    const token = await signAuthToken(JWT_SECRET, MANAGER_USER)
    const res = await app.request('/api/sku-map', {
      headers: { Authorization: `Bearer ${token}` },
    }, testEnv)
    expect(res.status).toBe(200)
    const body = await res.json() as { sku_map?: unknown[] }
    expect(Array.isArray(body.sku_map)).toBe(true)
  })

  it('/api/zoho-sale-import remains unmounted on the same production app (unaffected by the sku-map re-mount)', async () => {
    const token = await signAuthToken(JWT_SECRET, MANAGER_USER)
    const res = await app.request('/api/zoho-sale-import', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: 'irrelevant',
    }, testEnv)
    expect(res.status).toBe(404)
  })
})
