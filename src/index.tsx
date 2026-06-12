import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { renderer } from './renderer'
import type { Bindings } from './types'
import manifestsRoute from './routes/manifests'
import scanRoute from './routes/scan'
import inventoryRoute from './routes/inventory'
import printRoute from './routes/print'

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())
app.use(renderer)

app.route('/api/manifests', manifestsRoute)
app.route('/api/scan', scanRoute)
app.route('/api/inventory', inventoryRoute)
app.route('/api/print', printRoute)

app.get('/api/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }))

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
