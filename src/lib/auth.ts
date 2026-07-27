// Authentication + multi-tenancy (Priority 1).
//
// Implemented as a Hono middleware validating an HS256 JWT on every
// /api/* route except /api/health. The verified claims are exposed on
// `c.var.user` (see types.ts AuthUser) for the rest of the request
// lifecycle so every write can attribute user_id + organisation_id.
//
// This is intentionally a minimal, self-contained JWT auth (rather than
// wiring up a full OAuth/Cloudflare Access flow) so the sandbox / local dev
// story stays simple: `POST /api/auth/dev-login` mints a token for the
// seeded user, and the SPA stores it in localStorage and sends it as
// `Authorization: Bearer <token>` on every request. Swapping this for
// Cloudflare Access or a real IdP later only touches this file — routes
// consume `c.var.user` and don't care how it got populated.

import type { Context, Next } from 'hono'
import { sign, verify } from 'hono/jwt'
import type { Bindings, AuthUser } from '../types'

const TOKEN_TTL_SECONDS = 60 * 60 * 12 // 12h

export async function signAuthToken(
  secret: string,
  user: AuthUser,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return sign(
    {
      sub: String(user.id),
      email: user.email,
      name: user.name,
      role: user.role,
      org_id: user.organisation_id,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    },
    secret,
  )
}

// Hono's ContextVariableMap augmentation lives in index.tsx; here we just
// export the type-safe accessor used by every route.
export function currentUser(c: Context<{ Bindings: Bindings; Variables: { user: AuthUser } }>): AuthUser {
  const u = c.get('user')
  if (!u) {
    // Should be unreachable — authMiddleware runs before every handler that
    // calls this. Fail loudly rather than silently defaulting org_id, which
    // would be a tenancy leak.
    throw new Error('currentUser() called without an authenticated request context')
  }
  return u
}

// Extract bearer token from the Authorization header, falling back to a
// `?token=` query param. The fallback exists ONLY for the handful of
// print-label routes that the SPA opens via `window.open(url)` — a plain
// browser navigation can't attach an Authorization header. Every other API
// call goes through axios and always sends the header form.
function extractToken(c: Context): string | null {
  const header = c.req.header('Authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (match) return match[1].trim()
  const q = c.req.query('token')
  return q ? q.trim() : null
}

// Applied to /api/* (minus /api/health and /api/auth/*) in index.tsx.
export async function authMiddleware(
  c: Context<{ Bindings: Bindings; Variables: { user: AuthUser } }>,
  next: Next,
) {
  const token = extractToken(c)
  if (!token) {
    return c.json({ error: 'Unauthorized: missing bearer token' }, 401)
  }
  if (!c.env.JWT_SECRET) {
    // Server misconfiguration — never silently let requests through.
    return c.json({ error: 'Server auth is not configured (JWT_SECRET missing)' }, 500)
  }
  try {
    const payload = await verify(token, c.env.JWT_SECRET, 'HS256')
    const userId = Number(payload.sub)
    const orgId = Number((payload as any).org_id)
    if (!userId || !orgId) {
      return c.json({ error: 'Unauthorized: malformed token claims' }, 401)
    }
    const user: AuthUser = {
      id: userId,
      email: String((payload as any).email || ''),
      name: (payload as any).name ?? null,
      role: ((payload as any).role || 'operator') as AuthUser['role'],
      organisation_id: orgId,
    }
    c.set('user', user)
  } catch (err) {
    return c.json({ error: 'Unauthorized: invalid or expired token' }, 401)
  }
  await next()
}
