import { Hono } from 'hono'
import type { Bindings, AuthUser } from '../types'
import { signAuthToken, signDocToken, currentUser } from '../lib/auth'
import { verifyPassword, hashPassword, passwordPolicyError } from '../lib/password'

const app = new Hono<{ Bindings: Bindings }>()

// ───────── Real credentialed login (replaces dev-login, 2026-07-28) ─────────
// Two per-person accounts under the single organisation (Saigates Limited),
// each with its own PBKDF2-SHA256 password hash (src/lib/password.ts,
// migration 0016). A correct email+password mints the SAME HS256 JWT as
// before — sub = the individual user id, org_id = 1 — so the middleware,
// org-scoping, per-user write attribution and 401 auto-logout downstream
// are all untouched. This change is only the credential check at the door.
//
// Deliberate behaviours:
//   • unknown email and wrong password return the SAME 401 body (no user
//     enumeration) and issue NOTHING;
//   • an account whose password_hash is NULL/malformed can never log in
//     (that's how the migration ships — passwords are provisioned out of
//     band, no plaintext ever enters the repo);
//   • the plaintext password is read once from the body and never stored,
//     logged, or echoed back.
//
// Body: { email, password }  →  { token, user }
app.post('/login', async (c) => {
  const body = await c.req
    .json<{ email?: string; password?: string }>()
    .catch(() => ({} as { email?: string; password?: string }))
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password ?? '')

  if (!email || !password) {
    return c.json({ error: 'Email and password are required' }, 400)
  }
  if (!c.env.JWT_SECRET) {
    return c.json({ error: 'Server auth is not configured (JWT_SECRET missing)' }, 500)
  }

  const row = await c.env.DB.prepare(
    'SELECT id, email, name, role, organisation_id, password_hash FROM users WHERE LOWER(email) = ?'
  ).bind(email).first<AuthUser & { password_hash: string | null }>()

  // Same 401 for unknown user and wrong password — and verifyPassword is
  // false for NULL/malformed hashes, so unprovisioned accounts can't enter.
  const ok = row ? await verifyPassword(password, row.password_hash) : false
  if (!row || !ok) {
    return c.json({ error: 'Invalid email or password' }, 401)
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

// The old email-only dev-login is GONE — hard 410 so nothing can ever mint
// a token without password verification again. (Not silently removed: an
// explicit tombstone is greppable, testable, and self-documenting.)
app.post('/dev-login', (c) =>
  c.json({ error: 'dev-login has been removed — use POST /api/auth/login with email + password' }, 410))

// ───────── Self-service password change (lightweight, in-session) ─────────
// Runs BEHIND the auth middleware (only /login and the dev-login tombstone
// are exempt in index.tsx), and still re-verifies the CURRENT password so a
// stolen/leftover token alone can't rotate a credential. Users can change
// only their own password — there is no admin reset here (owner re-seeds
// out of band if someone is locked out; email-based reset flows are
// deliberately out of scope).
//
// Body: { current_password, new_password }  →  { ok: true }
app.post('/change-password', async (c) => {
  const user = currentUser(c as never)
  const body = await c.req
    .json<{ current_password?: string; new_password?: string }>()
    .catch(() => ({} as { current_password?: string; new_password?: string }))
  const current = String(body.current_password ?? '')
  const next = String(body.new_password ?? '')

  const policyErr = passwordPolicyError(next)
  if (policyErr) return c.json({ error: policyErr }, 422)

  const row = await c.env.DB.prepare(
    'SELECT password_hash FROM users WHERE id = ? AND organisation_id = ?'
  ).bind(user.id, user.organisation_id).first<{ password_hash: string | null }>()

  if (!row || !(await verifyPassword(current, row.password_hash))) {
    return c.json({ error: 'Current password is incorrect' }, 401)
  }

  const newHash = await hashPassword(next)
  await c.env.DB.prepare(
    'UPDATE users SET password_hash = ? WHERE id = ? AND organisation_id = ?'
  ).bind(newHash, user.id, user.organisation_id).run()

  return c.json({ ok: true })
})

// ───────── Doc token minting (2026-07-30 hardening) ─────────
// Issues a short-lived (5-minute), purpose-scoped token for the handful of
// routes opened via window.open() — print labels, the OPR invoice / C&E1154
// print views — which can't carry an Authorization header on a plain
// browser navigation. Requires the caller to already be authenticated with
// a normal session token (this route sits BEHIND authMiddleware, same as
// every other /api/* route except /login and the dev-login tombstone).
//
// Replaces the old approach of putting the full 12h session token straight
// into the URL: that token would work on ANY route for up to 12 hours if
// the URL ever leaked (browser history, proxy logs, Referer header). A doc
// token minted here only works on the exact print/document route it's
// used against, and only for 5 minutes — call this immediately before each
// window.open(), not once and reused.
app.post('/doc-token', async (c) => {
  const user = currentUser(c as never)
  const token = await signDocToken(c.env.JWT_SECRET, user)
  return c.json({ token })
})

// Who am I — lets the SPA confirm the stored token is still valid and show
// the acting user in the UI. Protected (auth middleware runs on /api/*
// except /login + the tombstone), so a 200 here means the token verified.
app.get('/me', async (c) => {
  const user = c.get('user' as never) as AuthUser | undefined
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  return c.json({ user })
})

export default app
