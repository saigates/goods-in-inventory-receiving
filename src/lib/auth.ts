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

// ───────── Doc tokens (2026-07-30 hardening) ─────────
//
// PROBLEM this section fixes: a handful of routes are opened via
// `window.open(url)` (print labels, the OPR invoice/C&E1154 print views) —
// a plain browser navigation that can't carry an Authorization header. The
// PRE-EXISTING fix was to accept the SAME full 12h session JWT as a
// `?token=` query param on ANY /api/* route. That is a real exposure: a
// query string can leak via browser history, proxy/server access logs, or
// a Referer header — and whoever obtains it gets full API access (every
// route, every write) for up to 12 hours, not just "view this one label".
//
// FIX: a separate, purpose-scoped, SHORT-LIVED token type ("doc token"):
//   - 5-minute TTL (DOC_TOKEN_TTL_SECONDS) instead of 12 hours;
//   - tagged `typ: 'doc'` in the JWT payload so it is cryptographically
//     distinguishable from a normal session token;
//   - accepted via `?token=` ONLY on the exact route paths that need it
//     (DOC_TOKEN_ALLOWED_PATHS below) — useless anywhere else even before
//     it expires;
//   - a normal session token presented via `?token=` is now REJECTED
//     everywhere (no `typ:'doc'` claim) — a session JWT can no longer end
//     up "live" in a URL at all, closing the log/history/Referer exposure
//     at its root;
//   - a doc token presented via the Authorization HEADER is also REJECTED
//     (source must be 'query' + path must be allow-listed) — it cannot be
//     used as a general-purpose session credential either direction.
//
// The frontend mints a fresh doc token (POST /api/auth/doc-token, itself
// behind the normal 12h session auth) immediately before each
// window.open(), instead of embedding the long-lived session token.
export const DOC_TOKEN_TTL_SECONDS = 5 * 60 // 5 minutes

// Exact route paths (c.req.path — no query string) allowed to authenticate
// via the `?token=` fallback, and ONLY with a doc token. Keep this list as
// short as the real window.open() call sites — every entry here is a
// route that becomes reachable from a bare URL.
const DOC_TOKEN_ALLOWED_PATHS: RegExp[] = [
  /^\/api\/print\/label\/\d+$/,
  /^\/api\/print\/labels$/,
  /^\/api\/opr\/shipments\/\d+\/invoice$/,
  /^\/api\/opr\/shipments\/\d+\/ce1154$/,
]

export async function signDocToken(
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
      typ: 'doc',
      iat: now,
      exp: now + DOC_TOKEN_TTL_SECONDS,
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

// Extract a bearer token, tracking WHERE it came from (header vs. `?token=`
// query param) so authMiddleware can enforce which token TYPE is allowed on
// which transport — that pairing is the actual fix (see the "Doc tokens"
// block above): a doc token must arrive via query on an allow-listed path,
// a session token must arrive via the Authorization header.
function extractToken(c: Context): { token: string; source: 'header' | 'query' } | null {
  const header = c.req.header('Authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (match) return { token: match[1].trim(), source: 'header' }
  const q = c.req.query('token')
  return q ? { token: q.trim(), source: 'query' } : null
}

function isDocTokenAllowedPath(path: string): boolean {
  return DOC_TOKEN_ALLOWED_PATHS.some((re) => re.test(path))
}

// Applied to /api/* (minus /api/health and /api/auth/*) in index.tsx.
export async function authMiddleware(
  c: Context<{ Bindings: Bindings; Variables: { user: AuthUser } }>,
  next: Next,
) {
  const extracted = extractToken(c)
  if (!extracted) {
    return c.json({ error: 'Unauthorized: missing bearer token' }, 401)
  }
  const { token, source } = extracted
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
    const isDocToken = (payload as any).typ === 'doc'
    // The hardening rule: a doc token only works via `?token=` on its
    // exact allow-listed paths; a session token only works via the
    // Authorization header. Either mismatch is rejected outright — this is
    // what stops a session token from ever being usable once it's in a URL
    // (query), and stops a doc token from being replayed as a general
    // Authorization-header credential on some OTHER route.
    if (isDocToken) {
      if (source !== 'query' || !isDocTokenAllowedPath(c.req.path)) {
        return c.json({ error: 'Unauthorized: doc token not valid for this route' }, 401)
      }
    } else if (source === 'query') {
      return c.json({ error: 'Unauthorized: session tokens cannot be presented via ?token= — use a doc token' }, 401)
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
