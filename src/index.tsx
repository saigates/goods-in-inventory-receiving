import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { renderer } from './renderer'
import type { Bindings, AuthUser } from './types'
import { authMiddleware } from './lib/auth'
import authRoute from './routes/auth'
import manifestsRoute from './routes/manifests'
import scanRoute from './routes/scan'
import inventoryRoute from './routes/inventory'
import printRoute from './routes/print'
import catalogRoute from './routes/catalog'
import devicesRoute from './routes/devices'
import webhooksRoute from './routes/webhooks'

const app = new Hono<{ Bindings: Bindings; Variables: { user: AuthUser } }>()

app.use('/api/*', cors())
app.use(renderer)

// ───────── Auth (Priority 1) ─────────
// Every /api/* route requires a valid bearer JWT EXCEPT /api/health and
// /api/auth/dev-login (the login endpoint itself, obviously, can't require
// auth). Note /api/auth/me DOES need auth (it's how the SPA validates a
// stored token) — only dev-login is exempt, not the whole /api/auth/* tree.
// authMiddleware sets c.var.user (organisation_id + user id + role) which
// every downstream route uses for tenancy scoping and write attribution.
app.get('/api/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }))

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health' || c.req.path === '/api/auth/dev-login') {
    return next()
  }
  return authMiddleware(c, next)
})

app.route('/api/auth', authRoute)
app.route('/api/manifests', manifestsRoute)
app.route('/api/scan', scanRoute)
app.route('/api/inventory', inventoryRoute)
app.route('/api/print', printRoute)
app.route('/api/catalog', catalogRoute)
app.route('/api/devices', devicesRoute)
app.route('/api/webhooks', webhooksRoute)

// SPA shell — all UI rendered client-side from /static/app.js
app.get('/', (c) => {
  return c.render(
    <div id="app">
      <div class="h-screen w-screen flex items-center justify-center">
        <div class="text-slate-400 text-sm">
          <i class="fas fa-spinner fa-spin mr-2"></i>Loading Goods In…
        </div>
      </div>
      <script src="/static/app.js"></script>
    </div>
  )
})

export default app
