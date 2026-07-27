// Outbound webhook configuration (Priority 6). Org-scoped CRUD for the
// URLs that get notified on device status change (see src/lib/webhook.ts
// for the dispatch side, wired from devices.ts#transition).

import { Hono } from 'hono'
import type { Bindings, AuthUser } from '../types'
import { currentUser } from '../lib/auth'

const app = new Hono<{ Bindings: Bindings; Variables: { user: AuthUser } }>()

function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map(b => b.toString(16).padStart(2, '0')).join('')
}

// List this org's webhooks. The secret is never echoed back in list/detail
// responses — only returned once, at creation time — same rule as the
// PrintNode API key handling.
app.get('/', async (c) => {
  const user = currentUser(c)
  const { results } = await c.env.DB.prepare(
    'SELECT id, url, enabled, created_at FROM webhooks WHERE organisation_id = ? ORDER BY id DESC'
  ).bind(user.organisation_id).all()
  return c.json({ webhooks: results })
})

// Body: { url }. Generates and returns the signing secret once.
app.post('/', async (c) => {
  const user = currentUser(c)
  const body = await c.req.json<{ url?: string }>().catch(() => ({} as { url?: string }))
  const url = (body.url || '').trim()
  if (!url || !/^https?:\/\//i.test(url)) {
    return c.json({ error: 'A valid http(s) url is required' }, 400)
  }
  const secret = randomSecret()
  const ins = await c.env.DB.prepare(
    'INSERT INTO webhooks (organisation_id, url, secret, enabled) VALUES (?, ?, ?, 1)'
  ).bind(user.organisation_id, url, secret).run()
  return c.json({ ok: true, id: ins.meta.last_row_id, url, secret, enabled: true })
})

app.post('/:id/toggle', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({} as { enabled?: boolean }))
  const res = await c.env.DB.prepare(
    'UPDATE webhooks SET enabled = ? WHERE id = ? AND organisation_id = ?'
  ).bind(body.enabled === false ? 0 : 1, id, user.organisation_id).run()
  if (!res.meta.changes) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

app.delete('/:id', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const res = await c.env.DB.prepare(
    'DELETE FROM webhooks WHERE id = ? AND organisation_id = ?'
  ).bind(id, user.organisation_id).run()
  if (!res.meta.changes) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

export default app
