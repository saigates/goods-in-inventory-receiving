// sku_map / zoho_items — mapping list, import, orphans, shared-ID view, edit.
//
// This is the first legitimate WRITE surface in production outside the
// core scan/lifecycle/bill flows (explicit carve-out from the read-only
// rule, per the 2026-09-08 brief) — gated to the same role tier that sees
// cost columns (manager/admin), same convention as requireManager() in
// devices.ts.
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import type { Bindings, AuthUser } from '../types'
import { currentUser } from '../lib/auth'
import { cleanString, validateZohoItemId } from '../lib/validate'
import {
  applySkuMapImport,
  parseSkuMapCsv,
  validateSkuMapCsv,
} from '../lib/skuMapImport'
import { SKU_MAP_RELEVANT_STATUSES } from '../lib/deviceLifecycle'

const app = new Hono<{ Bindings: Bindings; Variables: { user: AuthUser } }>()

// Same minimal CSV-cell escaping devices.ts's /export/csv uses — quote only
// when the value actually needs it (contains a comma/quote/newline).
const escapeCsv = (v: unknown) => {
  if (v == null) return ''
  const s = String(v)
  return /["\r\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function requireManager(c: any): boolean {
  const role = (c.var.user as AuthUser).role
  return role === 'manager' || role === 'admin'
}

// GET /api/sku-map — list, optional ?q= search on goods_in_sku or zoho fields.
app.get('/', async (c) => {
  const user = currentUser(c)
  const q = c.req.query('q')
  const includeOrphaned = c.req.query('include_orphaned') === '1'
  const where: string[] = ['m.organisation_id = ?']
  const binds: unknown[] = [user.organisation_id]
  if (!includeOrphaned) where.push('m.orphaned_at IS NULL')
  if (q) {
    where.push('(m.goods_in_sku LIKE ? OR z.zoho_sku LIKE ? OR z.zoho_item_name LIKE ?)')
    const like = `%${q}%`
    binds.push(like, like, like)
  }
  const { results } = await c.env.DB.prepare(
    `SELECT m.goods_in_sku, m.zoho_item_id, m.brand, m.model, m.capacity, m.color, m.grade,
            m.note, m.orphaned_at, m.row_version, m.updated_at,
            z.zoho_sku, z.zoho_item_name
     FROM sku_map m
     JOIN zoho_items z ON z.zoho_item_id = m.zoho_item_id
     WHERE ${where.join(' AND ')}
     ORDER BY m.goods_in_sku ASC`
  ).bind(...binds).all()
  return c.json({ sku_map: results })
})

// GET /api/sku-map/orphans — goods-in SKUs with no live Zoho item link, plus
// Zoho items referenced by no goods-in SKU.
app.get('/orphans', async (c) => {
  const user = currentUser(c)
  const { results: orphanedSkus } = await c.env.DB.prepare(
    `SELECT goods_in_sku, zoho_item_id, orphaned_at FROM sku_map
     WHERE organisation_id = ? AND orphaned_at IS NOT NULL ORDER BY orphaned_at DESC`
  ).bind(user.organisation_id).all()
  const { results: unreferencedZohoItems } = await c.env.DB.prepare(
    `SELECT z.zoho_item_id, z.zoho_sku, z.zoho_item_name FROM zoho_items z
     WHERE z.organisation_id = ?
       AND NOT EXISTS (SELECT 1 FROM sku_map m WHERE m.zoho_item_id = z.zoho_item_id AND m.orphaned_at IS NULL)
     ORDER BY z.zoho_item_id ASC`
  ).bind(user.organisation_id).all()
  return c.json({ orphaned_goods_in_skus: orphanedSkus, unreferenced_zoho_items: unreferencedZohoItems })
})

// GET /api/sku-map/unmapped — the unmapped queue (Z-4 phase 1). Grouped by
// OUR sku (goods_in_sku / received_devices.sku), one row per SKU with a
// device count — never per-device rows, per explicit instruction, since
// the operator acts on "this SKU needs a mapping", not on individual
// units. A goods_in_sku whose ONLY sku_map row is orphaned still counts as
// unmapped here (operator ruling, this pass): an orphaned mapping must not
// satisfy the export gate, so it must not disappear from this queue either
// — NOT EXISTS is scoped to orphaned_at IS NULL, deliberately not just "any
// row exists".
//
// Bug fix (2026-09-28, operator §1): this query used to have NO status
// filter at all, so a device already SOLD/REJECTED/QC_FAILED, or moved
// into any OPR_WORKFLOW_ONLY_STATUSES status (already exported/returned/
// on a consignment), counted as "unmapped" identically to a device still
// in goods-in. On production data this inflated the queue from 32
// distinct SKUs / 42 devices (the real, bill-relevant set) to 90 SKUs /
// 248 devices — see SKU_MAP_RELEVANT_STATUSES's own comment in
// deviceLifecycle.ts for the full status list and why QC_FAILED is
// deliberately excluded from it.
app.get('/unmapped', async (c) => {
  const user = currentUser(c)
  const statusPlaceholders = SKU_MAP_RELEVANT_STATUSES.map(() => '?').join(',')
  const { results } = await c.env.DB.prepare(
    `SELECT rd.sku AS goods_in_sku, COUNT(*) AS device_count
     FROM received_devices rd
     WHERE rd.organisation_id = ?
       AND rd.status IN (${statusPlaceholders})
       AND NOT EXISTS (
         SELECT 1 FROM sku_map m
         WHERE m.goods_in_sku = rd.sku AND m.organisation_id = rd.organisation_id AND m.orphaned_at IS NULL
       )
     GROUP BY rd.sku
     ORDER BY device_count DESC, rd.sku ASC`
  ).bind(user.organisation_id, ...SKU_MAP_RELEVANT_STATUSES).all()
  return c.json({ unmapped: results })
})

// GET /api/sku-map/unmapped/export — Z-4 phase 2 (Excel round trip), the
// DOWNLOAD half. A plain browser navigation (window.open(), same
// Authorization-header limitation as devices.ts's /export/csv — see
// src/lib/auth.ts's DOC_TOKEN_ALLOWED_PATHS, which this path must be
// added to), so this needs the ?token= doc-token fallback, not header
// auth.
//
// Column order is EXACTLY parseSkuMapCsv's REQUIRED_HEADERS
// (SKU,Brand,Model,Capacity,Color,Grade,Zoho Item ID,Zoho SKU,Zoho Item
// Name) so the completed file round-trips straight into POST /import
// unchanged — no separate "phase 2 import format" was introduced. One
// extra trailing "Device Count" column is informational only; the parser
// only requires its own 9 headers to be PRESENT (extra columns are
// ignored, confirmed by reading parseSkuMapCsv — it builds each row from
// `header` positions, never rejects an unrecognised extra column).
//
// SKU/Brand/Model/Capacity/Color/Grade are pre-filled from
// received_devices (one representative row per goods_in_sku — brand/
// model/capacity/color/grade are already uniform per-SKU in practice,
// since goods_in_sku is itself derived from exactly these fields via
// buildSku(); MIN(id) picks a stable, deterministic representative
// rather than an arbitrary one). The three Zoho columns are left BLANK
// for the operator to complete — this is the whole point of the
// template, not an oversight.
//
// PAYLOAD-SCOPE CONSTRAINT ON THE DOC-TOKEN GATING (operator ruling,
// 2026-09-27, this pass's §3): doc-token gating this route alongside
// devices.ts's /export/csv is a real exception to this project's
// otherwise header-only-bearer auth wall, and it was accepted ONLY
// because today's payload is our own SKU list, attribute strings, and
// device counts — no IMEIs, no costs, no customs values. This is a
// narrower bar than "manager/admin can see it" (requireManager() above
// already covers that); it is specifically about what is safe to let
// leak into browser history / a shared link / a proxy log via a doc
// token's 5-minute window, however short.
// IF a future change adds acquisition cost, IMEI, or any customs-facing
// column to this SELECT, remove this path from DOC_TOKEN_ALLOWED_PATHS
// (src/lib/auth.ts) FIRST — the export must become bearer-only (regular
// Authorization header, no browser-navigation download) before that
// column ships, not after. Do not assume "it already has a doc-token
// route" extends to a payload nobody scoped it for.
app.get('/unmapped/export', async (c) => {
  const user = currentUser(c)
  if (!requireManager(c)) return c.json({ error: 'Manager or admin role required' }, 403)

  // Bug fix (2026-09-28, operator §1): same missing status filter as
  // GET /unmapped above — see that route's comment and
  // SKU_MAP_RELEVANT_STATUSES's own comment in deviceLifecycle.ts for the
  // full history (32 real SKUs/42 devices vs. 90/248 unfiltered).
  const statusPlaceholders = SKU_MAP_RELEVANT_STATUSES.map(() => '?').join(',')
  const { results } = await c.env.DB.prepare(
    `SELECT rd.sku AS goods_in_sku, COUNT(*) AS device_count,
            MIN(rd.brand) AS brand, MIN(rd.model) AS model,
            MIN(rd.capacity) AS capacity, MIN(rd.color) AS color, MIN(rd.grade) AS grade
     FROM received_devices rd
     WHERE rd.organisation_id = ?
       AND rd.status IN (${statusPlaceholders})
       AND NOT EXISTS (
         SELECT 1 FROM sku_map m
         WHERE m.goods_in_sku = rd.sku AND m.organisation_id = rd.organisation_id AND m.orphaned_at IS NULL
       )
     GROUP BY rd.sku
     ORDER BY device_count DESC, rd.sku ASC`
  ).bind(user.organisation_id, ...SKU_MAP_RELEVANT_STATUSES).all<{
    goods_in_sku: string; device_count: number
    brand: string | null; model: string | null; capacity: string | null; color: string | null; grade: string | null
  }>()

  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="sku-map-unmapped-${Date.now()}.csv"`)

  const headers = ['SKU', 'Brand', 'Model', 'Capacity', 'Color', 'Grade', 'Zoho Item ID', 'Zoho SKU', 'Zoho Item Name', 'Device Count']
  return stream(c, async (writer) => {
    await writer.write(headers.join(',') + '\r\n')
    for (const row of results) {
      const cells = [
        row.goods_in_sku, row.brand, row.model, row.capacity, row.color, row.grade,
        '', '', '', // Zoho Item ID / Zoho SKU / Zoho Item Name — blank, operator fills these
        row.device_count,
      ]
      await writer.write(cells.map(escapeCsv).join(',') + '\r\n')
    }
  })
})

// POST /api/sku-map — manual single-row create (Z-4 phase 1's "manual
// CRUD"; POST /import remains the ONLY bulk path, unchanged). Body:
// { goods_in_sku, zoho_item_id, zoho_sku?, zoho_item_name?, brand, model,
//   capacity?, color?, grade?, note? }.
//
// Cardinality, enforced here exactly as the schema already enforces it
// (migration 0032): goods_in_sku is unique (sku_map's PRIMARY KEY) — a
// second create for the same live goods_in_sku is a 409, use PATCH to
// edit it instead. zoho_item_id has NO uniqueness constraint on this side
// — reusing an existing Zoho item across multiple goods_in_sku rows
// (physical-SIM/eSIM pairs) is allowed and expected.
//
// Revive-on-remap (operator ruling, this pass): if goods_in_sku already
// exists but is ORPHANED, this is NOT a 409 — the existing row is revived
// (orphaned_at cleared) and updated in place rather than a second row
// being inserted, which the PRIMARY KEY would reject anyway. This is the
// counterpart to DELETE below setting orphaned_at, not a separate code
// path re-deciding the same rule.
app.post('/', async (c) => {
  const user = currentUser(c)
  if (!requireManager(c)) return c.json({ error: 'Manager or admin role required' }, 403)
  const body = await c.req.json<{
    goods_in_sku?: string
    zoho_item_id?: string
    zoho_sku?: string
    zoho_item_name?: string
    brand?: string
    model?: string
    capacity?: string | null
    color?: string | null
    grade?: string | null
    note?: string | null
  }>().catch(() => ({} as any))

  const goodsInSku = cleanString(body.goods_in_sku, 100)
  if (!goodsInSku) return c.json({ error: 'goods_in_sku is required' }, 400)

  const zid = validateZohoItemId(body.zoho_item_id)
  if (!zid.ok) return c.json({ error: zid.reason }, 422)

  const brand = cleanString(body.brand, 100)
  const model = cleanString(body.model, 200)
  if (!brand) return c.json({ error: 'brand is required' }, 400)
  if (!model) return c.json({ error: 'model is required' }, 400)

  // zoho_items side: reuse if the ID already exists (many-to-one — this is
  // the expected physical/eSIM-pair path), otherwise create it. When
  // reusing, the EXISTING zoho_sku/zoho_item_name win — this endpoint never
  // silently renames a Zoho item as a side effect of mapping a new
  // goods_in_sku to it; that's the loader's rename-detection job, not this
  // one's.
  const existingZoho = await c.env.DB.prepare(
    'SELECT zoho_item_id, zoho_sku, zoho_item_name FROM zoho_items WHERE zoho_item_id = ? AND organisation_id = ?'
  ).bind(zid.value, user.organisation_id).first<{ zoho_item_id: string; zoho_sku: string; zoho_item_name: string }>()

  if (!existingZoho) {
    const zsku = cleanString(body.zoho_sku, 100)
    const zname = cleanString(body.zoho_item_name, 300)
    if (!zsku || !zname) {
      return c.json({ error: `Zoho Item ID ${zid.value} does not exist yet — zoho_sku and zoho_item_name are required to create it` }, 400)
    }
    const clash = await c.env.DB.prepare(
      'SELECT zoho_item_id FROM zoho_items WHERE zoho_sku = ? AND organisation_id = ?'
    ).bind(zsku, user.organisation_id).first<{ zoho_item_id: string }>()
    if (clash) {
      // Name the conflicting our-SKU(s), not just the Zoho Item ID — the
      // operator needs to find the existing row without a separate query.
      // zoho_item_id can legitimately have several live goods_in_sku
      // (many-to-one), so list all of them, not just one.
      const { results: clashingSkus } = await c.env.DB.prepare(
        'SELECT goods_in_sku FROM sku_map WHERE zoho_item_id = ? AND organisation_id = ? AND orphaned_at IS NULL'
      ).bind(clash.zoho_item_id, user.organisation_id).all<{ goods_in_sku: string }>()
      const skuList = clashingSkus.map(r => r.goods_in_sku)
      return c.json({
        error: `Zoho SKU ${zsku} is already used by Zoho Item ID ${clash.zoho_item_id}`
          + (skuList.length ? ` (mapped from our SKU${skuList.length > 1 ? 's' : ''}: ${skuList.join(', ')})` : ' (not yet mapped from any our-SKU)')
          + ' — bijection would break',
        conflicting_zoho_item_id: clash.zoho_item_id,
        conflicting_goods_in_skus: skuList,
      }, 409)
    }
    await c.env.DB.prepare(
      'INSERT INTO zoho_items (zoho_item_id, zoho_sku, zoho_item_name, organisation_id) VALUES (?, ?, ?, ?)'
    ).bind(zid.value, zsku, zname, user.organisation_id).run()
  }

  const existingMap = await c.env.DB.prepare(
    'SELECT goods_in_sku, orphaned_at, row_version, zoho_item_id FROM sku_map WHERE goods_in_sku = ? AND organisation_id = ?'
  ).bind(goodsInSku, user.organisation_id).first<{ goods_in_sku: string; orphaned_at: string | null; row_version: number; zoho_item_id: string }>()

  if (existingMap && !existingMap.orphaned_at) {
    return c.json({ error: `${goodsInSku} is already mapped — use PATCH to edit it`, current_row_version: existingMap.row_version }, 409)
  }

  const capacity = cleanString(body.capacity, 50)
  const color = cleanString(body.color, 50)
  const grade = cleanString(body.grade, 20)
  const note = cleanString(body.note, 500)

  if (existingMap) {
    // Revive: clear orphaned_at, overwrite the mapped-side columns.
    if (existingMap.zoho_item_id !== zid.value) {
      await c.env.DB.prepare(
        `INSERT INTO sku_map_audit (organisation_id, goods_in_sku, old_zoho_item_id, new_zoho_item_id, source, actor_user_id, reason)
         VALUES (?, ?, ?, ?, 'ui_edit', ?, ?)`
      ).bind(user.organisation_id, goodsInSku, existingMap.zoho_item_id, zid.value, user.id, 'revived from orphaned via manual create').run()
    }
    await c.env.DB.prepare(
      `UPDATE sku_map SET
         zoho_item_id = ?, brand = ?, model = ?, capacity = ?, color = ?, grade = ?,
         orphaned_at = NULL, row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE goods_in_sku = ? AND organisation_id = ?`
    ).bind(zid.value, brand, model, capacity, color, grade, goodsInSku, user.organisation_id).run()
  } else {
    await c.env.DB.prepare(
      `INSERT INTO sku_map (goods_in_sku, organisation_id, zoho_item_id, brand, model, capacity, color, grade, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(goodsInSku, user.organisation_id, zid.value, brand, model, capacity, color, grade, note).run()
  }

  await c.env.DB.prepare(
    'UPDATE sku_map_version SET mapping_version = mapping_version + 1, updated_at = CURRENT_TIMESTAMP WHERE organisation_id = ?'
  ).bind(user.organisation_id).run()

  const row = await c.env.DB.prepare(
    'SELECT * FROM sku_map WHERE goods_in_sku = ? AND organisation_id = ?'
  ).bind(goodsInSku, user.organisation_id).first()
  return c.json({ sku_map: row }, existingMap ? 200 : 201)
})

// DELETE /api/sku-map/:goods_in_sku — "Remove mapping" (labelled that way
// in the UI, deliberately not "Delete"). Soft delete only: sets
// orphaned_at, never removes the row. Ruled this pass for three reasons —
// (1) matches the schema's own existing convention that absence is never
// a delete, so the manual page and the Excel round trip behave
// consistently; (2) sku_map_audit already exists to record changes, and a
// hard delete would leave audit rows pointing at a vanished parent;
// (3) once Y-3 snapshots a mapping into zoho_batch_devices, deleting the
// mapping here would break the ability to explain a bill already sent to
// Zoho. Idempotent — removing an already-orphaned row is a no-op 200, not
// a 404 or 409.
app.delete('/:goods_in_sku', async (c) => {
  const user = currentUser(c)
  if (!requireManager(c)) return c.json({ error: 'Manager or admin role required' }, 403)
  const goodsInSku = c.req.param('goods_in_sku')

  const existing = await c.env.DB.prepare(
    'SELECT goods_in_sku, orphaned_at FROM sku_map WHERE goods_in_sku = ? AND organisation_id = ?'
  ).bind(goodsInSku, user.organisation_id).first<{ goods_in_sku: string; orphaned_at: string | null }>()
  if (!existing) return c.json({ error: 'Mapping not found' }, 404)

  if (!existing.orphaned_at) {
    await c.env.DB.prepare(
      `UPDATE sku_map SET orphaned_at = CURRENT_TIMESTAMP, row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE goods_in_sku = ? AND organisation_id = ?`
    ).bind(goodsInSku, user.organisation_id).run()
    await c.env.DB.prepare(
      'UPDATE sku_map_version SET mapping_version = mapping_version + 1, updated_at = CURRENT_TIMESTAMP WHERE organisation_id = ?'
    ).bind(user.organisation_id).run()
  }

  const row = await c.env.DB.prepare(
    'SELECT * FROM sku_map WHERE goods_in_sku = ? AND organisation_id = ?'
  ).bind(goodsInSku, user.organisation_id).first()
  return c.json({ sku_map: row })
})

// GET /api/sku-map/shared — the intentional-shared-ID view: Zoho items
// referenced by more than one live goods-in SKU, with their editable note.
app.get('/shared', async (c) => {
  const user = currentUser(c)
  const { results } = await c.env.DB.prepare(
    `SELECT m.zoho_item_id, GROUP_CONCAT(m.goods_in_sku) AS goods_in_skus,
            MAX(m.note) AS note, z.zoho_sku, z.zoho_item_name
     FROM sku_map m
     JOIN zoho_items z ON z.zoho_item_id = m.zoho_item_id
     WHERE m.organisation_id = ? AND m.orphaned_at IS NULL
     GROUP BY m.zoho_item_id
     HAVING COUNT(*) > 1
     ORDER BY m.zoho_item_id ASC`
  ).bind(user.organisation_id).all()
  return c.json({
    shared: (results as any[]).map(r => ({ ...r, goods_in_skus: String(r.goods_in_skus).split(',') })),
  })
})

// POST /api/sku-map/import — CSV body (text/csv or text/plain), ?dry_run=1
// for a diff-preview-only pass (default false = write).
app.post('/import', async (c) => {
  const user = currentUser(c)
  if (!requireManager(c)) return c.json({ error: 'Manager or admin role required' }, 403)
  const csvText = await c.req.text()
  if (!csvText || !csvText.trim()) return c.json({ error: 'Empty CSV body' }, 400)
  const dryRun = c.req.query('dry_run') === '1'

  const result = await applySkuMapImport(c.env.DB, user.organisation_id, csvText, {
    dryRun, actorUserId: user.id,
  })
  if (!result.ok) return c.json(result, 422)
  return c.json(result, dryRun ? 200 : 201)
})

// PATCH /api/sku-map/:goods_in_sku — UI edit: attach/detach/reassign the
// Zoho item, and/or edit the note. Optimistic locking via row_version:
// caller must supply the row_version it last read; a mismatch means
// another editor (or an import) has since written this row.
app.patch('/:goods_in_sku', async (c) => {
  const user = currentUser(c)
  if (!requireManager(c)) return c.json({ error: 'Manager or admin role required' }, 403)
  const goodsInSku = c.req.param('goods_in_sku')
  const body = await c.req.json<{
    zoho_item_id?: string
    note?: string | null
    reason?: string
    row_version?: number
  }>().catch(() => ({} as any))

  if (body.row_version == null) return c.json({ error: 'row_version is required (optimistic lock)' }, 400)

  const existing = await c.env.DB.prepare(
    'SELECT goods_in_sku, zoho_item_id, row_version FROM sku_map WHERE goods_in_sku = ? AND organisation_id = ?'
  ).bind(goodsInSku, user.organisation_id).first<{ goods_in_sku: string; zoho_item_id: string; row_version: number }>()
  if (!existing) return c.json({ error: 'Mapping not found' }, 404)
  if (existing.row_version !== body.row_version) {
    return c.json({ error: 'Conflict: row has been modified since you loaded it', current_row_version: existing.row_version }, 409)
  }

  const newZohoItemId = body.zoho_item_id != null ? cleanString(body.zoho_item_id) : existing.zoho_item_id
  if (newZohoItemId && newZohoItemId !== existing.zoho_item_id) {
    const zohoExists = await c.env.DB.prepare(
      'SELECT 1 FROM zoho_items WHERE zoho_item_id = ? AND organisation_id = ?'
    ).bind(newZohoItemId, user.organisation_id).first()
    if (!zohoExists) return c.json({ error: `Zoho Item ID ${newZohoItemId} does not exist` }, 400)
  }

  const noteProvided = Object.prototype.hasOwnProperty.call(body, 'note')
  const statements = []
  if (newZohoItemId && newZohoItemId !== existing.zoho_item_id) {
    statements.push(c.env.DB.prepare(
      `INSERT INTO sku_map_audit (organisation_id, goods_in_sku, old_zoho_item_id, new_zoho_item_id, source, actor_user_id, reason)
       VALUES (?, ?, ?, ?, 'ui_edit', ?, ?)`
    ).bind(user.organisation_id, goodsInSku, existing.zoho_item_id, newZohoItemId, user.id, cleanString(body.reason)))
  }
  statements.push(c.env.DB.prepare(
    `UPDATE sku_map SET
       zoho_item_id = ?,
       note = ${noteProvided ? '?' : 'note'},
       row_version = row_version + 1,
       updated_at = CURRENT_TIMESTAMP
     WHERE goods_in_sku = ? AND organisation_id = ? AND row_version = ?`
  ).bind(
    ...(noteProvided
      ? [newZohoItemId, body.note, goodsInSku, user.organisation_id, body.row_version]
      : [newZohoItemId, goodsInSku, user.organisation_id, body.row_version]),
  ))

  await c.env.DB.batch(statements as any)

  // mapping_version bump on every write (UI edit counts too, per spec).
  await c.env.DB.prepare(
    'UPDATE sku_map_version SET mapping_version = mapping_version + 1, updated_at = CURRENT_TIMESTAMP WHERE organisation_id = ?'
  ).bind(user.organisation_id).run()

  const updated = await c.env.DB.prepare(
    'SELECT * FROM sku_map WHERE goods_in_sku = ? AND organisation_id = ?'
  ).bind(goodsInSku, user.organisation_id).first()
  return c.json({ sku_map: updated })
})

// GET /api/sku-map/version — current mapping_version, for callers that need
// to freeze it on a valuation/attribution run.
app.get('/version', async (c) => {
  const user = currentUser(c)
  const row = await c.env.DB.prepare(
    'SELECT mapping_version, updated_at FROM sku_map_version WHERE organisation_id = ?'
  ).bind(user.organisation_id).first()
  return c.json(row || { mapping_version: 0, updated_at: null })
})

export default app
