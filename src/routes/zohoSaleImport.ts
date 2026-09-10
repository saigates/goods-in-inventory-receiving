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
//
// ?acknowledge_qc_failed=1 (same query-param convention as ?dry_run=1):
// required to actually write a matched_sale row whose target device is
// currently QC_FAILED. Without it, that row alone is excluded from the
// write batch and reported back as warningUnacknowledged — every other
// row in the same import still writes normally. Ignored (harmless) on a
// dryRun request, since dryRun never writes anything regardless; dryRun
// always lists QC_FAILED-source rows informationally via qcFailedPreview.
// The rule attaches to the QC_FAILED -> SOLD edge itself (DEVELOPER
// INSTRUCTION 2026-09-09) — any future single-device sale route reaching
// that same edge must apply the identical acknowledgment gate and reuse
// QC_FAILED_WARNING_MESSAGE verbatim, not invent its own copy.
app.post('/', async (c) => {
  const user = currentUser(c)
  if (!requireManager(c)) return c.json({ error: 'Manager or admin role required' }, 403)
  const csvText = await c.req.text()
  if (!csvText || !csvText.trim()) return c.json({ error: 'Empty CSV body' }, 400)
  const dryRun = c.req.query('dry_run') === '1'
  const acknowledgeQcFailed = c.req.query('acknowledge_qc_failed') === '1'

  const result = await applyZohoSaleImport(c.env.DB, user.organisation_id, csvText, {
    dryRun, actorUserId: user.id, user, acknowledgeQcFailed,
  })
  if (!result.ok) return c.json(result, 422)
  return c.json(result, dryRun ? 200 : 201)
})

export default app
