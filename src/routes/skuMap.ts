// sku_map / zoho_items — mapping list, import, orphans, shared-ID view, edit.
//
// This is the first legitimate WRITE surface in production outside the
// core scan/lifecycle/bill flows (explicit carve-out from the read-only
// rule, per the 2026-09-08 brief) — gated to the same role tier that sees
// cost columns (manager/admin), same convention as requireManager() in
// devices.ts.
import { Hono } from 'hono'
import type { Bindings, AuthUser } from '../types'
import { currentUser } from '../lib/auth'
import { cleanString } from '../lib/validate'
import {
  applySkuMapImport,
  parseSkuMapCsv,
  validateSkuMapCsv,
} from '../lib/skuMapImport'

const app = new Hono<{ Bindings: Bindings; Variables: { user: AuthUser } }>()

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
