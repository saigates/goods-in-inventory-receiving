// sku_map / zoho_items loader — Z-G-MAPPING.csv import.
//
// Everything here is PURE where possible (parsing, validation, diff
// computation) — same convention as oprImport.ts/billBuilder.ts — so the
// bijection/duplicate/orphan rules are unit-testable without HTTP or D1.
// The actual DB write (applyImport) does need D1 since it has to read
// current sku_map/zoho_items state to compute the diff and pre-images.
//
// ───────── Source-of-truth shift (2026-09-08 brief) ─────────
// The CSV is a SEED / BULK-IMPORT format only. The database is authoritative
// from first load onward. Consequences encoded below:
//   - Column-scoped overwrite: an import only overwrites the columns it
//     carries (brand/model/capacity/color/grade/zoho_item_id/zoho_sku/
//     zoho_item_name). The CSV has no `note` column, so `sku_map.note` is
//     NEVER touched by an import, in either direction.
//   - Absence from the file is not a delete. A goods_in_sku present in DB
//     but missing from the file is marked orphaned (orphaned_at set) and
//     reported — never removed.
//   - Every zoho_item_id change on an existing row is written to
//     sku_map_audit with its pre-image (old_zoho_item_id), before the
//     overwrite, source='import', tagged with a shared import_batch_id so a
//     summary of "rows this import reverted" can be built afterwards by
//     comparing against source='ui_edit' rows for the same goods_in_sku.
//   - Hard-fail only on INTRA-FILE contradictions (duplicate goods_in_sku;
//     one zoho_item_id under two different zoho_sku strings within the
//     file; one zoho_sku under two different zoho_item_id values within the
//     file). Never fails against previously-loaded DB rows — a rename in
//     Zoho (same ID, new name/SKU) must import cleanly and is reported as a
//     rename, not an error.
//   - A zoho_item_id referenced by more than one goods_in_sku in the SAME
//     file is permitted and reported as informational (expected: exactly
//     three, per the physical/eSIM shared-item pairs).

export type SkuMapCsvRow = {
  SKU: string
  Brand: string
  Model: string
  Capacity: string
  Color: string
  Grade: string
  'Zoho Item ID': string
  'Zoho SKU': string
  'Zoho Item Name': string
}

const REQUIRED_HEADERS = [
  'SKU', 'Brand', 'Model', 'Capacity', 'Color', 'Grade',
  'Zoho Item ID', 'Zoho SKU', 'Zoho Item Name',
] as const

// Minimal RFC4180-ish CSV line splitter. Z-G-MAPPING.csv is confirmed (by
// direct inspection) to contain zero quoted fields and zero embedded commas
// — every data row splits cleanly on ',' into exactly 9 fields. This parser
// still supports basic double-quote quoting/escaping so it doesn't silently
// mis-split if a future export DOES need to quote a field (e.g. an item
// name containing a comma), rather than assuming today's shape forever.
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

export type CsvParseResult =
  | { ok: true; rows: SkuMapCsvRow[]; fileLineCount: number }
  | { ok: false; error: string }

// fileLineCount = number of DATA rows implied by the raw file's own line
// count (total lines minus header, minus a single trailing blank line if
// the file ends with a newline) — used to cross-check against rows.length
// and surface any parse-time drop rather than assume they always match.
export function parseSkuMapCsv(raw: string): CsvParseResult {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  // Drop exactly one trailing blank line (file ends with a newline) — do
  // NOT strip more than one, since a file with genuine blank rows in the
  // middle should surface as a parse problem, not be silently absorbed.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return { ok: false, error: 'Empty file' }

  const header = parseCsvLine(lines[0]).map(h => h.trim())
  for (const req of REQUIRED_HEADERS) {
    if (!header.includes(req)) {
      return { ok: false, error: `Missing required column: ${req}` }
    }
  }

  const dataLines = lines.slice(1)
  const rows: SkuMapCsvRow[] = []
  for (let i = 0; i < dataLines.length; i++) {
    const line = dataLines[i]
    if (line.trim() === '') continue // tolerate stray blank lines mid-file
    const cells = parseCsvLine(line)
    const row: Record<string, string> = {}
    header.forEach((h, idx) => { row[h] = (cells[idx] ?? '').trim() })
    rows.push(row as SkuMapCsvRow)
  }

  return { ok: true, rows, fileLineCount: dataLines.filter(l => l.trim() !== '').length }
}

// ───────── Load-time checks (intra-file only) ─────────

export type SharedZohoItem = { zoho_item_id: string; goods_in_skus: string[] }

export type SkuMapValidation = {
  ok: boolean
  errors: string[]
  // Informational, not failures.
  sharedZohoItems: SharedZohoItem[]
  rowCount: number
  fileLineCount: number
  rowCountDelta: number // rowCount - fileLineCount; report, never silently absorb
}

export function validateSkuMapCsv(rows: SkuMapCsvRow[], fileLineCount: number): SkuMapValidation {
  const errors: string[] = []

  // 1. Duplicate goods_in_sku fails the load.
  const skuSeen = new Map<string, number>()
  rows.forEach((r, idx) => {
    const sku = r.SKU.trim()
    if (!sku) { errors.push(`Row ${idx + 2}: SKU is blank`); return }
    if (skuSeen.has(sku)) {
      errors.push(`Duplicate goods_in_sku "${sku}" at rows ${skuSeen.get(sku)! + 2} and ${idx + 2}`)
    } else {
      skuSeen.set(sku, idx)
    }
  })

  // 2. Bijection: zoho_item_id -> single zoho_sku, and zoho_sku -> single zoho_item_id.
  const idToSkus = new Map<string, Set<string>>()
  const skuToIds = new Map<string, Set<string>>()
  for (const r of rows) {
    const id = r['Zoho Item ID'].trim()
    const zsku = r['Zoho SKU'].trim()
    if (!id || !zsku) continue // blank-field errors already reported below
    if (!idToSkus.has(id)) idToSkus.set(id, new Set())
    idToSkus.get(id)!.add(zsku)
    if (!skuToIds.has(zsku)) skuToIds.set(zsku, new Set())
    skuToIds.get(zsku)!.add(id)
  }
  for (const [id, skus] of idToSkus) {
    if (skus.size > 1) {
      errors.push(`Zoho Item ID ${id} maps to ${skus.size} different Zoho SKUs: ${[...skus].join(', ')} — bijection broken, likely transcription error`)
    }
  }
  for (const [zsku, ids] of skuToIds) {
    if (ids.size > 1) {
      errors.push(`Zoho SKU ${zsku} maps to ${ids.size} different Zoho Item IDs: ${[...ids].join(', ')} — bijection broken, likely transcription error`)
    }
  }

  // 3. Empty required fields (beyond SKU, already checked above).
  rows.forEach((r, idx) => {
    for (const field of ['Brand', 'Model', 'Zoho Item ID', 'Zoho SKU', 'Zoho Item Name'] as const) {
      if (!r[field] || !r[field].trim()) {
        errors.push(`Row ${idx + 2}: ${field} is blank`)
      }
    }
  })

  // 4. Shared zoho_item_id across multiple goods_in_sku — informational.
  const idToGoodsSkus = new Map<string, string[]>()
  for (const r of rows) {
    const id = r['Zoho Item ID'].trim()
    const sku = r.SKU.trim()
    if (!id || !sku) continue
    if (!idToGoodsSkus.has(id)) idToGoodsSkus.set(id, [])
    idToGoodsSkus.get(id)!.push(sku)
  }
  const sharedZohoItems: SharedZohoItem[] = [...idToGoodsSkus.entries()]
    .filter(([, skus]) => skus.length > 1)
    .map(([zoho_item_id, goods_in_skus]) => ({ zoho_item_id, goods_in_skus }))

  return {
    ok: errors.length === 0,
    errors,
    sharedZohoItems,
    rowCount: rows.length,
    fileLineCount,
    rowCountDelta: rows.length - fileLineCount,
  }
}

// ───────── Diff preview (dry-run) ─────────
// Compares the parsed file against current DB state. Column-scoped: a
// "change" is only reported for columns the CSV actually carries, and
// sku_map.note is never part of the diff (import never touches it).

export type ExistingSkuMapRow = {
  goods_in_sku: string
  zoho_item_id: string
  brand: string
  model: string
  capacity: string | null
  color: string | null
  grade: string | null
  orphaned_at: string | null
}
export type ExistingZohoItemRow = {
  zoho_item_id: string
  zoho_sku: string
  zoho_item_name: string
}

export type ImportDiffAdd = { goods_in_sku: string; zoho_item_id: string }
export type ImportDiffChange = {
  goods_in_sku: string
  field: 'zoho_item_id' | 'brand' | 'model' | 'capacity' | 'color' | 'grade'
  old_value: string | null
  new_value: string | null
}
export type ImportDiffRename = {
  zoho_item_id: string
  field: 'zoho_sku' | 'zoho_item_name'
  old_value: string
  new_value: string
}
export type ImportDiffOrphan = { goods_in_sku: string } // in DB, missing from file, not yet orphaned

export type ImportDiff = {
  adds: ImportDiffAdd[]
  changes: ImportDiffChange[]
  renames: ImportDiffRename[]
  newOrphans: ImportDiffOrphan[]
  reReOrphaned: string[] // goods_in_sku that WAS orphaned and reappears in this file (un-orphan)
}

export function computeImportDiff(
  rows: SkuMapCsvRow[],
  existingSkuMap: ExistingSkuMapRow[],
  existingZohoItems: ExistingZohoItemRow[],
): ImportDiff {
  const existingBySku = new Map(existingSkuMap.map(r => [r.goods_in_sku, r]))
  const existingZohoById = new Map(existingZohoItems.map(r => [r.zoho_item_id, r]))
  const fileSkus = new Set(rows.map(r => r.SKU.trim()))

  const adds: ImportDiffAdd[] = []
  const changes: ImportDiffChange[] = []
  const renamesSeen = new Set<string>()
  const renames: ImportDiffRename[] = []
  const reReOrphaned: string[] = []

  for (const r of rows) {
    const sku = r.SKU.trim()
    const zid = r['Zoho Item ID'].trim()
    const existing = existingBySku.get(sku)
    if (!existing) {
      adds.push({ goods_in_sku: sku, zoho_item_id: zid })
    } else {
      if (existing.orphaned_at) reReOrphaned.push(sku)
      const fields: Array<[ImportDiffChange['field'], string | null, string]> = [
        ['zoho_item_id', existing.zoho_item_id, zid],
        ['brand', existing.brand, r.Brand.trim()],
        ['model', existing.model, r.Model.trim()],
        ['capacity', existing.capacity, r.Capacity.trim() || null as any],
        ['color', existing.color, r.Color.trim() || null as any],
        ['grade', existing.grade, r.Grade.trim() || null as any],
      ]
      for (const [field, oldV, newV] of fields) {
        const oldNorm = oldV ?? null
        const newNorm = newV ?? null
        if (oldNorm !== newNorm) {
          changes.push({ goods_in_sku: sku, field, old_value: oldNorm, new_value: newNorm })
        }
      }
    }

    // zoho_items rename detection (dedupe per zoho_item_id — the file may
    // list the same shared ID on two rows, only report the rename once).
    const zexisting = existingZohoById.get(zid)
    if (zexisting && !renamesSeen.has(zid)) {
      const newSku = r['Zoho SKU'].trim()
      const newName = r['Zoho Item Name'].trim()
      if (zexisting.zoho_sku !== newSku) {
        renames.push({ zoho_item_id: zid, field: 'zoho_sku', old_value: zexisting.zoho_sku, new_value: newSku })
      }
      if (zexisting.zoho_item_name !== newName) {
        renames.push({ zoho_item_id: zid, field: 'zoho_item_name', old_value: zexisting.zoho_item_name, new_value: newName })
      }
      renamesSeen.add(zid)
    }
  }

  const newOrphans: ImportDiffOrphan[] = existingSkuMap
    .filter(r => !fileSkus.has(r.goods_in_sku) && !r.orphaned_at)
    .map(r => ({ goods_in_sku: r.goods_in_sku }))

  return { adds, changes, renames, newOrphans, reReOrphaned }
}

// ───────── D1-backed apply (upsert on zoho_item_id) ─────────
//
// Not pure — reads current sku_map/zoho_items state to build the diff and
// pre-images, then writes. Column-scoped: only writes brand/model/capacity/
// color/grade/zoho_item_id (sku_map) and zoho_sku/zoho_item_name
// (zoho_items). NEVER touches sku_map.note. Every zoho_item_id CHANGE on an
// existing sku_map row is audited with its pre-image before the write.
// mapping_version is bumped exactly once per successful import call.
//
// dryRun=true computes and returns the diff WITHOUT writing anything —
// informational preview, not a hard gate (per explicit instruction), but
// the intended UI "confirm import" flow calls this first, shows the diff,
// then re-calls with dryRun=false only on confirmation.

import { newUuid } from './uuid'

export type ApplyImportResult = {
  ok: boolean
  errors: string[]
  dryRun: boolean
  importBatchId: string | null
  diff: ImportDiff
  sharedZohoItems: SharedZohoItem[]
  rowCount: number
  fileLineCount: number
  rowCountDelta: number
  mappingVersion: number | null
}

export async function applySkuMapImport(
  db: D1Database,
  organisationId: number,
  csvText: string,
  opts: { dryRun: boolean; actorUserId: number },
): Promise<ApplyImportResult> {
  const parsed = parseSkuMapCsv(csvText)
  if (!parsed.ok) {
    return {
      ok: false, errors: [parsed.error], dryRun: opts.dryRun, importBatchId: null,
      diff: { adds: [], changes: [], renames: [], newOrphans: [], reReOrphaned: [] },
      sharedZohoItems: [], rowCount: 0, fileLineCount: 0, rowCountDelta: 0, mappingVersion: null,
    }
  }

  const validation = validateSkuMapCsv(parsed.rows, parsed.fileLineCount)
  if (!validation.ok) {
    return {
      ok: false, errors: validation.errors, dryRun: opts.dryRun, importBatchId: null,
      diff: { adds: [], changes: [], renames: [], newOrphans: [], reReOrphaned: [] },
      sharedZohoItems: validation.sharedZohoItems,
      rowCount: validation.rowCount, fileLineCount: validation.fileLineCount,
      rowCountDelta: validation.rowCountDelta, mappingVersion: null,
    }
  }

  const { results: skuMapRows } = await db.prepare(
    'SELECT goods_in_sku, zoho_item_id, brand, model, capacity, color, grade, orphaned_at FROM sku_map WHERE organisation_id = ?'
  ).bind(organisationId).all<ExistingSkuMapRow>()
  const { results: zohoRows } = await db.prepare(
    'SELECT zoho_item_id, zoho_sku, zoho_item_name FROM zoho_items WHERE organisation_id = ?'
  ).bind(organisationId).all<ExistingZohoItemRow>()

  const diff = computeImportDiff(parsed.rows, skuMapRows, zohoRows)

  if (opts.dryRun) {
    return {
      ok: true, errors: [], dryRun: true, importBatchId: null, diff,
      sharedZohoItems: validation.sharedZohoItems,
      rowCount: validation.rowCount, fileLineCount: validation.fileLineCount,
      rowCountDelta: validation.rowCountDelta, mappingVersion: null,
    }
  }

  const importBatchId = newUuid()
  const now = new Date().toISOString()
  const existingBySku = new Map(skuMapRows.map(r => [r.goods_in_sku, r]))
  const statements: D1PreparedStatement[] = []

  for (const r of parsed.rows) {
    const sku = r.SKU.trim()
    const zid = r['Zoho Item ID'].trim()
    const zsku = r['Zoho SKU'].trim()
    const zname = r['Zoho Item Name'].trim()

    // zoho_items upsert on zoho_item_id — column-scoped (zoho_sku, name only).
    statements.push(db.prepare(
      `INSERT INTO zoho_items (zoho_item_id, zoho_sku, zoho_item_name, organisation_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(zoho_item_id) DO UPDATE SET
         zoho_sku = excluded.zoho_sku,
         zoho_item_name = excluded.zoho_item_name,
         updated_at = excluded.updated_at`
    ).bind(zid, zsku, zname, organisationId, now))

    const existing = existingBySku.get(sku)
    if (existing && existing.zoho_item_id !== zid) {
      // Pre-image audit BEFORE the overwrite.
      statements.push(db.prepare(
        `INSERT INTO sku_map_audit (organisation_id, goods_in_sku, old_zoho_item_id, new_zoho_item_id, source, import_batch_id, actor_user_id)
         VALUES (?, ?, ?, ?, 'import', ?, ?)`
      ).bind(organisationId, sku, existing.zoho_item_id, zid, importBatchId, opts.actorUserId))
    }

    // sku_map upsert — column-scoped (never writes `note`), un-orphans on
    // reappearance, bumps row_version.
    statements.push(db.prepare(
      `INSERT INTO sku_map (goods_in_sku, organisation_id, zoho_item_id, brand, model, capacity, color, grade, orphaned_at, row_version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)
       ON CONFLICT(goods_in_sku) DO UPDATE SET
         zoho_item_id = excluded.zoho_item_id,
         brand = excluded.brand,
         model = excluded.model,
         capacity = excluded.capacity,
         color = excluded.color,
         grade = excluded.grade,
         orphaned_at = NULL,
         row_version = sku_map.row_version + 1,
         updated_at = excluded.updated_at`
    ).bind(
      sku, organisationId, zid, r.Brand.trim(), r.Model.trim(),
      r.Capacity.trim() || null, r.Color.trim() || null, r.Grade.trim() || null, now,
    ))
  }

  // Orphan marking — DB rows missing from the file. Never a DELETE.
  for (const orphan of diff.newOrphans) {
    statements.push(db.prepare(
      `UPDATE sku_map SET orphaned_at = ?, row_version = row_version + 1 WHERE goods_in_sku = ? AND organisation_id = ?`
    ).bind(now, orphan.goods_in_sku, organisationId))
  }

  // mapping_version bump — exactly once per import call, after all writes.
  statements.push(db.prepare(
    `UPDATE sku_map_version SET mapping_version = mapping_version + 1, updated_at = ? WHERE organisation_id = ?`
  ).bind(now, organisationId))

  await db.batch(statements)

  const versionRow = await db.prepare(
    'SELECT mapping_version FROM sku_map_version WHERE organisation_id = ?'
  ).bind(organisationId).first<{ mapping_version: number }>()

  return {
    ok: true, errors: [], dryRun: false, importBatchId, diff,
    sharedZohoItems: validation.sharedZohoItems,
    rowCount: validation.rowCount, fileLineCount: validation.fileLineCount,
    rowCountDelta: validation.rowCountDelta,
    mappingVersion: versionRow?.mapping_version ?? null,
  }
}
