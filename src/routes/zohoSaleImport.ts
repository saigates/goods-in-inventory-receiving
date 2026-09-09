// Zoho outbound sale-import route — CSV body, ?dry_run=1 preview, manager-
// gated (same tier as sku-map's write surface, requireManager() precedent).
//
// See src/lib/zohoSaleImport.ts for the full design-basis comment block
// and .deploy-checks/zoho-outbound-reconnaissance-2026-09-09.md for the
// reconnaissance record this importer is built against.
import { Hono } from 'hono'
import type { Bindings, AuthUser } from '../types'
import { currentUser } from '../lib/auth'
import { applyZohoSaleImport } from '../lib/zohoSaleImport'

const app = new Hono<{ Bindings: Bindings; Variables: { user: AuthUser } }>()

function requireManager(c: any): boolean {
  const role = (c.var.user as AuthUser).role
  return role === 'manager' || role === 'admin'
}

// POST /api/zoho-sale-import — CSV body (text/csv or text/plain),
// ?dry_run=1 for a preview-only pass (default false = write). Mirrors
// POST /api/sku-map/import's exact request/response shape (skuMap.ts).
app.post('/', async (c) => {
  const user = currentUser(c)
  if (!requireManager(c)) return c.json({ error: 'Manager or admin role required' }, 403)
  const csvText = await c.req.text()
  if (!csvText || !csvText.trim()) return c.json({ error: 'Empty CSV body' }, 400)
  const dryRun = c.req.query('dry_run') === '1'

  const result = await applyZohoSaleImport(c.env.DB, user.organisation_id, csvText, {
    dryRun, actorUserId: user.id, user,
  })
  if (!result.ok) return c.json(result, 422)
  return c.json(result, dryRun ? 200 : 201)
})

export default app
