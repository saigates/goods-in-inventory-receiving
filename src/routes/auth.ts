import { Hono } from 'hono'
import type { Bindings, AuthUser } from '../types'
import { signAuthToken } from '../lib/auth'

const app = new Hono<{ Bindings: Bindings }>()

// Minimal dev/demo login: exchanges a known seeded user's email for a JWT.
// There is no password here on purpose — this sandbox app has no real IdP
// yet. Swapping this route for real credential checking (or Cloudflare
// Access) is a self-contained change: everything downstream just consumes
// the signed token via the `authMiddleware` in src/lib/auth.ts.
//
// Body: { email }  →  { token, user }
app.post('/dev-login', async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => ({} as { email?: string }))
  const email = (body.email || 'admin@goodsin.local').trim().toLowerCase()

  const row = await c.env.DB.prepare(
    'SELECT id, email, name, role, organisation_id FROM users WHERE LOWER(email) = ?'
  ).bind(email).first<AuthUser>()

  if (!row) {
    return c.json({ error: `No user found for email '${email}'` }, 404)
  }
  if (!c.env.JWT_SECRET) {
    return c.json({ error: 'Server auth is not configured (JWT_SECRET missing)' }, 500)
  }

  const user: AuthUser = {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    organisation_id: row.organisation_id,
  }
  const token = await signAuthToken(c.env.JWT_SECRET, user)
  return c.json({ token, user })
})

// Who am I — lets the SPA confirm the stored token is still valid and show
// the acting user in the UI. Protected (auth middleware runs on /api/*
// except this list), so a 200 here means the token verified.
app.get('/me', async (c) => {
  const user = c.get('user' as never) as AuthUser | undefined
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  return c.json({ user })
})

export default app
