import { Hono } from 'hono'
import type { Bindings, AuthUser } from '../types'
import { currentUser } from '../lib/auth'

const app = new Hono<{ Bindings: Bindings; Variables: { user: AuthUser } }>()

type Settings = {
  print_mode: 'browser' | 'printnode' | 'manual'
  printnode_api_key: string | null
  printnode_printer_id_large: number | null
  printnode_printer_id_small: number | null
}

// app_settings is keyed by organisation_id (Priority 1: each tenant gets
// its own print configuration / PrintNode account).
async function loadSettings(db: D1Database, organisationId: number): Promise<Settings> {
  const row = await db.prepare(
    'SELECT print_mode, printnode_api_key, printnode_printer_id_large, printnode_printer_id_small FROM app_settings WHERE organisation_id = ?'
  ).bind(organisationId).first<Settings>()
  if (row) return row
  // First time this org touches print settings — create the default row.
  await db.prepare(
    'INSERT OR IGNORE INTO app_settings (organisation_id, print_mode) VALUES (?, ?)'
  ).bind(organisationId, 'browser').run()
  return { print_mode: 'browser', printnode_api_key: null, printnode_printer_id_large: null, printnode_printer_id_small: null }
}

// Build a printable HTML for a single label (used by browser-print mode).
// The page renders a screen-only preflight banner (paper size + header-off
// checklist) — the @media print block hides it so the printed page is
// JUST the label, sized exactly to the @page box.
function labelHtml(payload: any, size: 'large' | 'small', rotate: boolean = false): string {
  const isSmall = size === 'small'
  // Real label dimensions in mm. When rotate=true we swap them so the printer
  // sees the label feed direction the same way physical DYMO rolls feed
  // (short edge along the feed direction) while our content stays landscape.
  // Use rotate=true if your DYMO is printing the label 90° rotated and
  // spreading content across two stickers.
  const contentW = isSmall ? 32 : 57
  const contentH = isSmall ? 57 : 32
  const pageW = rotate ? contentH : contentW
  const pageH = rotate ? contentW : contentH
  const subtitle = payload.brand || ''
  const variant = [payload.capacity, payload.color].filter(Boolean).join(' · ')

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>${payload.sku} · ${payload.imei}</title>
<script src="https://cdn.jsdelivr.net/npm/qrious@4.0.2/dist/qrious.min.js"></script>
<style>
  @page { size: ${pageW}mm ${pageH}mm; margin: 0; }
  html, body { margin: 0; padding: 0; background: #f5f5f5; font-family: system-ui, sans-serif; }
  /* Screen-only preflight (hidden when printing) */
  @media screen {
    body { padding: 20px; }
    .preflight { max-width: 520px; margin: 0 auto 20px; background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 16px; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
    .preflight h2 { margin: 0 0 8px; font-size: 14px; color: #0f172a; }
    .preflight ol { margin: 8px 0 12px 18px; padding: 0; font-size: 12px; color: #334155; line-height: 1.6; }
    .preflight .btn { display: inline-block; background: linear-gradient(135deg,#06b6d4,#6366f1); color:#fff; border:none; border-radius:6px; padding:8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .preflight .btn:hover { filter: brightness(1.08); }
    .label-frame { max-width: 520px; margin: 0 auto; background:#fff; border: 1px dashed #94a3b8; padding: 12px; border-radius: 6px; }
    .label-frame > .label { box-shadow: 0 0 0 1px #cbd5e1; }
    .scale-note { text-align:center; font-size: 11px; color: #64748b; margin-top: 8px; }
  }
  @media print {
    html, body { background: #fff !important; padding: 0 !important; margin: 0 !important; width: ${pageW}mm !important; height: ${pageH}mm !important; overflow: hidden !important; }
    /* Hide every chrome wrapper */
    .preflight, .scale-note { display: none !important; }
    /* Strip the screen-only frame around the label */
    .label-frame { max-width: none !important; margin: 0 !important; padding: 0 !important; border: 0 !important; background: #fff !important; box-shadow: none !important; ${rotate ? `position: relative; width: ${pageW}mm !important; height: ${pageH}mm !important;` : ''} }
    /* Label itself must be exactly the page size, no extras */
    .label { box-shadow: none !important; margin: 0 !important; ${rotate ? `position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(90deg); transform-origin: center center;` : ''} }
  }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .label {
    width: ${contentW}mm; height: ${contentH}mm;
    padding: 1.2mm; color: #000; font-family: Arial, Helvetica, sans-serif;
    display: ${isSmall ? 'flex' : 'grid'};
    ${isSmall
      ? 'flex-direction: column; gap: 0.4mm;'
      : 'grid-template-columns: 1fr 13mm; gap: 1mm;'}
  }
  .mono { font-family: 'Courier New', monospace; }
  ${isSmall ? `
  .h { display:flex; justify-content:space-between; align-items:center; border-bottom: 0.15mm dashed #888; padding-bottom: 0.4mm; }
  .brand { font-size: 1.6mm; font-weight: 700; letter-spacing: 0.3mm; color: #555; }
  .grade { font-size: 2.4mm; font-weight: 800; padding: 0.2mm 0.8mm; border: 0.25mm solid #000; border-radius: 0.4mm; }
  .sku   { font-size: 3.2mm; font-weight: 800; text-align: center; line-height: 1.05; word-break: break-all; margin-top: 0.3mm; }
  .sub   { font-size: 1.8mm; font-weight: 600; text-align: center; }
  .var   { font-size: 1.6mm; text-align: center; color: #444; }
  .qr-main   { display:flex; justify-content:center; margin: 0.3mm 0; }
  .qr-cap    { font-size: 1.2mm; text-align:center; color: #666; letter-spacing: 0.2mm; }
  .imei-blk  { border-top: 0.15mm dashed #888; padding-top: 0.4mm; display:flex; flex-direction:column; align-items:center; gap:0.2mm; }
  .imei-num  { font-size: 2mm; font-weight: 700; }
  .imei-cap  { font-size: 1.2mm; color: #666; letter-spacing: 0.2mm; }
  .foot      { border-top: 0.15mm dashed #888; padding-top: 0.3mm; margin-top: auto; }
  .row       { display:flex; justify-content:space-between; font-size: 1.5mm; }
  ` : `
  .left      { display:flex; flex-direction:column; justify-content:space-between; min-width: 0; }
  .sku       { font-size: 4.6mm; font-weight: 800; letter-spacing: 0.1mm; line-height: 1.05; word-break: break-all; }
  .sub       { font-size: 2mm; color: #444; margin-top: 0.4mm; }
  .imei-blk  { display:flex; align-items:center; gap:1.2mm; border-top: 0.15mm dashed #888; padding-top: 0.8mm; }
  .imei-side { display:flex; flex-direction:column; justify-content:center; }
  .imei-cap  { font-size: 1.4mm; font-weight: 700; letter-spacing: 0.3mm; color: #666; }
  .imei-num  { font-size: 2.6mm; font-weight: 700; }
  .right     { display:flex; flex-direction:column; align-items:center; justify-content:space-between; border-left: 0.15mm dashed #888; padding-left: 1mm; }
  .uuid      { font-size: 1.8mm; font-weight: 600; }
  .grade     { font-size: 3mm; font-weight: 800; padding: 0.2mm 1mm; border: 0.25mm solid #000; border-radius: 0.4mm; }
  `}
</style></head>
<body>
<div class="preflight">
  <h2>🖨️ Print preflight — ${contentW}×${contentH} mm DYMO label${rotate ? ' <span style="font-size:11px;color:#64748b;font-weight:500">(rotated 90° for sideways feed)</span>' : ''}</h2>
  <ol>
    <li>In the print dialog, set <b>Destination</b> to your DYMO LabelWriter (e.g. <i>DYMO LabelWriter 450</i>).</li>
    <li>Set <b>Paper size</b> to <b>${pageW} × ${pageH} mm</b> (or the closest DYMO preset — once the DYMO is selected the right size usually appears as "${pageW}mm x ${pageH}mm").</li>
    <li>Set <b>Margins</b> to <b>None</b> and <b>Scale</b> to <b>100%</b>.</li>
    <li>Open <b>More settings</b> and <b>uncheck "Headers and footers"</b> — this removes the date/URL printed at the top of the label.</li>
    <li>Click <b>Print</b>.</li>
  </ol>
  <button class="btn" onclick="window.print()">Open print dialog</button>
  <span style="margin-left:10px; font-size:11px; color:#64748b">Tip: tick "Remember settings" or save as a Chrome preset so you only set this up once.</span>
</div>
<div class="label-frame">
<div class="label">
${isSmall ? `
  <div class="h">
    <div class="brand">GOODS IN</div>
    ${payload.grade ? `<div class="grade">${payload.grade}</div>` : ''}
  </div>
  <div class="sku">${payload.sku || ''}</div>
  ${subtitle ? `<div class="sub">${subtitle}</div>` : ''}
  ${variant ? `<div class="var">${variant}</div>` : ''}
  <div class="qr-main"><canvas id="qmain"></canvas></div>
  <div class="imei-blk">
    <canvas id="qimei"></canvas>
    <div class="imei-num mono">${payload.imei}</div>
    <div class="imei-cap">IMEI</div>
  </div>
  <div class="foot"><div class="row"><span>UUID</span><span class="mono">${payload.uuid}</span></div></div>
` : `
  <div class="left">
    <div>
      <div class="sku">${payload.sku || ''}</div>
      <div class="sub">${[payload.brand, payload.capacity, payload.color].filter(Boolean).join(' · ')}</div>
    </div>
    <div class="imei-blk">
      <canvas id="qimei"></canvas>
      <div class="imei-side">
        <div class="imei-cap">IMEI</div>
        <div class="imei-num mono">${payload.imei}</div>
      </div>
    </div>
  </div>
  <div class="right">
    <canvas id="qmain"></canvas>
    <div class="uuid mono">${payload.uuid}</div>
    ${payload.grade ? `<div class="grade">${payload.grade}</div>` : ''}
  </div>
`}
</div>
<div class="scale-note">Preview rendered at real ${contentW}×${contentH} mm — the print dialog should produce the same size${rotate ? ' (label will be rotated 90° to match the DYMO feed direction)' : ''}.</div>
</div>
<script>
  (function(){
    const payload = ${JSON.stringify(JSON.stringify({ uuid: payload.uuid, sku: payload.sku, imei: payload.imei }))};
    const imei = ${JSON.stringify(payload.imei)};
    const mainPx = ${isSmall ? 105 : 95};
    const imeiPx = ${isSmall ? 90 : 70};
    function render() {
      if (!window.QRious) { setTimeout(render, 50); return; }
      new QRious({ element: document.getElementById('qmain'), value: payload, size: mainPx, level: 'M' });
      new QRious({ element: document.getElementById('qimei'), value: imei, size: imeiPx, level: 'M' });
      // No auto-print — user clicks the button after confirming settings
    }
    render();
    window.addEventListener('afterprint', () => { setTimeout(() => window.close(), 100); });
  })();
</script>
</body></html>`
}

// ───────── Settings ─────────
app.get('/settings', async (c) => {
  const user = currentUser(c)
  const s = await loadSettings(c.env.DB, user.organisation_id)
  // Don't return the raw API key — return whether it's set
  return c.json({
    print_mode: s.print_mode,
    printnode_api_key_set: !!s.printnode_api_key,
    printnode_printer_id_large: s.printnode_printer_id_large,
    printnode_printer_id_small: s.printnode_printer_id_small,
  })
})

app.post('/settings', async (c) => {
  const user = currentUser(c)
  const body = await c.req.json<{
    print_mode?: 'browser' | 'printnode' | 'manual'
    printnode_api_key?: string | null  // null = clear, undefined = unchanged
    printnode_printer_id_large?: number | null
    printnode_printer_id_small?: number | null
  }>()

  const cur = await loadSettings(c.env.DB, user.organisation_id)
  const next: Settings = {
    print_mode: body.print_mode ?? cur.print_mode,
    printnode_api_key:
      body.printnode_api_key === undefined ? cur.printnode_api_key : body.printnode_api_key,
    printnode_printer_id_large:
      body.printnode_printer_id_large === undefined ? cur.printnode_printer_id_large : body.printnode_printer_id_large,
    printnode_printer_id_small:
      body.printnode_printer_id_small === undefined ? cur.printnode_printer_id_small : body.printnode_printer_id_small,
  }

  await c.env.DB.prepare(`
    UPDATE app_settings
    SET print_mode = ?, printnode_api_key = ?, printnode_printer_id_large = ?, printnode_printer_id_small = ?, updated_at = CURRENT_TIMESTAMP
    WHERE organisation_id = ?
  `).bind(
    next.print_mode,
    next.printnode_api_key,
    next.printnode_printer_id_large,
    next.printnode_printer_id_small,
    user.organisation_id,
  ).run()

  return c.json({ ok: true })
})

// List PrintNode printers (proxy that calls the PrintNode API so we don't
// leak the API key into the browser). Useful for the settings dropdown.
app.get('/printnode/printers', async (c) => {
  const user = currentUser(c)
  const s = await loadSettings(c.env.DB, user.organisation_id)
  if (!s.printnode_api_key) return c.json({ error: 'PrintNode API key not configured' }, 400)
  const r = await fetch('https://api.printnode.com/printers', {
    headers: {
      Authorization: 'Basic ' + btoa(s.printnode_api_key + ':'),
    },
  })
  if (!r.ok) return c.json({ error: `PrintNode error ${r.status}` }, 502)
  const printers = await r.json()
  return c.json({ printers })
})

// ───────── Queue ─────────
app.get('/queue', async (c) => {
  const user = currentUser(c)
  const { results } = await c.env.DB.prepare(`
    SELECT pj.*, rd.uuid, rd.imei, rd.sku, rd.brand, rd.model, rd.capacity, rd.color, rd.grade
    FROM print_jobs pj
    JOIN received_devices rd ON rd.id = pj.received_device_id
    WHERE pj.status = 'queued' AND pj.organisation_id = ?
    ORDER BY pj.id ASC
    LIMIT 100
  `).bind(user.organisation_id).all()
  return c.json({ queue: results })
})

// Fetch a single job (used by browser-print mode to retrieve payload)
app.get('/job/:id', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const job = await c.env.DB.prepare(`
    SELECT pj.*, rd.uuid, rd.imei, rd.sku, rd.brand, rd.model, rd.capacity, rd.color, rd.grade
    FROM print_jobs pj
    JOIN received_devices rd ON rd.id = pj.received_device_id
    WHERE pj.id = ? AND pj.organisation_id = ?
  `).bind(id, user.organisation_id).first()
  if (!job) return c.json({ error: 'Not found' }, 404)
  return c.json({ job })
})

// Stand-alone HTML page for a label (browser-print path).
// The page renders the label, calls window.print() automatically, and closes.
app.get('/label/:id', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const size = (c.req.query('size') as 'large' | 'small') || 'large'
  const rotate = c.req.query('rotate') === '1'
  const row = await c.env.DB.prepare(`
    SELECT pj.payload_json, rd.uuid, rd.imei, rd.sku, rd.brand, rd.model, rd.capacity, rd.color, rd.grade
    FROM print_jobs pj
    JOIN received_devices rd ON rd.id = pj.received_device_id
    WHERE pj.id = ? AND pj.organisation_id = ?
  `).bind(id, user.organisation_id).first<any>()
  if (!row) return c.text('Not found', 404)
  const payload = {
    uuid: row.uuid, imei: row.imei, sku: row.sku,
    brand: row.brand, model: row.model, capacity: row.capacity,
    color: row.color, grade: row.grade,
  }
  return c.html(labelHtml(payload, size, rotate))
})

// Mark a job as sent (called by the browser-print path after it's dispatched
// the label to window.print, or by the operator when using manual mode).
app.post('/mark-sent/:id', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const job = await c.env.DB.prepare('SELECT * FROM print_jobs WHERE id = ? AND organisation_id = ?').bind(id, user.organisation_id).first<{
    id: number; received_device_id: number; status: string
  }>()
  if (!job) return c.json({ error: 'Not found' }, 404)
  if (job.status === 'sent') return c.json({ ok: true, already: true })
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE print_jobs SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id),
    c.env.DB.prepare("UPDATE received_devices SET label_printed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(job.received_device_id),
  ])
  return c.json({ ok: true })
})

// Server-driven send. Behaviour depends on the configured print_mode:
//   - 'browser' / 'manual': just returns { mode: 'browser', url: '/api/print/label/:id?size=...' }
//                           and the frontend opens that URL in a print window.
//   - 'printnode': server calls PrintNode API directly and the job is sent
//                  to a real DYMO LabelWriter on the warehouse PC.
// Shared PrintNode dispatch used by both /send/:id and /send-all so the
// latter doesn't have to self-fetch its own authenticated endpoint (a
// Worker can't attach the caller's Authorization header to a same-origin
// fetch of itself without re-deriving it, which is fragile).
async function sendToPrintNode(
  db: D1Database,
  s: Settings,
  job: { id: number; received_device_id: number; sku: string; imei: string },
  size: 'large' | 'small',
  labelUrlBase: string,
  authToken: string,
): Promise<{ ok: true; printnode_job_id: unknown } | { ok: false; error: string; status: number }> {
  if (!s.printnode_api_key) return { ok: false, error: 'PrintNode API key not configured', status: 400 }
  const printerId = size === 'small' ? s.printnode_printer_id_small : s.printnode_printer_id_large
  if (!printerId) return { ok: false, error: `PrintNode printer for size '${size}' not configured`, status: 400 }

  // Render the label HTML and send to PrintNode as pdf_uri pointing at our
  // endpoint. PrintNode's headless renderer fetches this URL itself — it
  // can't send our normal Authorization header, so we pass the same bearer
  // token as a `?token=` query param (see extractToken() fallback in
  // src/lib/auth.ts, scoped to exactly this use case).
  const labelUrl = new URL(labelUrlBase)
  labelUrl.pathname = `/api/print/label/${job.id}`
  labelUrl.search = `?size=${size}&token=${encodeURIComponent(authToken)}`

  const pnResp = await fetch('https://api.printnode.com/printjobs', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(s.printnode_api_key + ':'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      printerId,
      title: `Goods In · ${job.sku} · ${job.imei}`,
      contentType: 'pdf_uri',
      content: labelUrl.toString(),
      source: 'goods-in-app',
    }),
  })

  if (!pnResp.ok) {
    const errText = await pnResp.text()
    return { ok: false, error: `PrintNode rejected job: ${pnResp.status} ${errText}`, status: 502 }
  }
  const pnJobId = await pnResp.json()

  await db.batch([
    db.prepare("UPDATE print_jobs SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?").bind(job.id),
    db.prepare("UPDATE received_devices SET label_printed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(job.received_device_id),
  ])
  return { ok: true, printnode_job_id: pnJobId }
}

app.post('/send/:id', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const size = (c.req.query('size') as 'large' | 'small') || 'large'
  const rotate = c.req.query('rotate') === '1'
  const s = await loadSettings(c.env.DB, user.organisation_id)

  const job = await c.env.DB.prepare(`
    SELECT pj.id, pj.received_device_id, pj.status, pj.payload_json,
           rd.uuid, rd.imei, rd.sku, rd.brand, rd.model, rd.capacity, rd.color, rd.grade
    FROM print_jobs pj
    JOIN received_devices rd ON rd.id = pj.received_device_id
    WHERE pj.id = ? AND pj.organisation_id = ?
  `).bind(id, user.organisation_id).first<any>()
  if (!job) return c.json({ error: 'Not found' }, 404)

  if (s.print_mode === 'browser' || s.print_mode === 'manual') {
    // Frontend will open the label HTML in a window and trigger print.
    return c.json({ ok: true, mode: 'browser', url: `/api/print/label/${id}?size=${size}${rotate ? '&rotate=1' : ''}` })
  }

  if (s.print_mode === 'printnode') {
    const authHeader = c.req.header('Authorization') || ''
    const authToken = authHeader.replace(/^Bearer\s+/i, '')
    const result = await sendToPrintNode(c.env.DB, s, job, size, c.req.url, authToken)
    if (!result.ok) return c.json({ error: result.error }, result.status as any)
    return c.json({ ok: true, mode: 'printnode', printnode_job_id: result.printnode_job_id })
  }

  return c.json({ error: `Unknown print_mode: ${s.print_mode}` }, 500)
})

// Bulk send. For browser-print mode, the frontend will open ONE print window
// containing all queued labels stacked — much faster than spawning N windows.
app.post('/send-all', async (c) => {
  const user = currentUser(c)
  const size = (c.req.query('size') as 'large' | 'small') || 'large'
  const rotate = c.req.query('rotate') === '1'
  const s = await loadSettings(c.env.DB, user.organisation_id)
  const { results } = await c.env.DB.prepare(
    "SELECT pj.id, pj.received_device_id, rd.sku, rd.imei FROM print_jobs pj JOIN received_devices rd ON rd.id = pj.received_device_id WHERE pj.status = 'queued' AND pj.organisation_id = ? ORDER BY pj.id ASC"
  ).bind(user.organisation_id).all<{ id: number; received_device_id: number; sku: string; imei: string }>()

  if (results.length === 0) return c.json({ ok: true, sent: 0 })

  if (s.print_mode === 'browser' || s.print_mode === 'manual') {
    const ids = results.map(r => r.id).join(',')
    return c.json({
      ok: true,
      mode: 'browser',
      url: `/api/print/labels?ids=${ids}&size=${size}${rotate ? '&rotate=1' : ''}`,
      count: results.length,
    })
  }

  if (s.print_mode === 'printnode') {
    // For simplicity, kick off jobs sequentially. They are sent to PrintNode
    // independently so the warehouse printer queues them in order.
    const authHeader = c.req.header('Authorization') || ''
    const authToken = authHeader.replace(/^Bearer\s+/i, '')
    let sent = 0
    for (const job of results) {
      const result = await sendToPrintNode(c.env.DB, s, job, size, c.req.url, authToken)
      if (result.ok) sent++
    }
    return c.json({ ok: true, mode: 'printnode', sent })
  }

  return c.json({ error: `Unknown print_mode: ${s.print_mode}` }, 500)
})

// Bulk label HTML — all jobs in a single printable page (browser-print mode).
app.get('/labels', async (c) => {
  const user = currentUser(c)
  const idsParam = c.req.query('ids') || ''
  const size = (c.req.query('size') as 'large' | 'small') || 'large'
  const rotate = c.req.query('rotate') === '1'
  const ids = idsParam.split(',').map(Number).filter(Boolean)
  if (!ids.length) return c.text('No ids', 400)

  // Fetch one-by-one (D1 has no easy IN-clause with ?n binding here)
  const rows: any[] = []
  for (const id of ids) {
    const row = await c.env.DB.prepare(`
      SELECT pj.id, rd.uuid, rd.imei, rd.sku, rd.brand, rd.model, rd.capacity, rd.color, rd.grade
      FROM print_jobs pj JOIN received_devices rd ON rd.id = pj.received_device_id
      WHERE pj.id = ? AND pj.organisation_id = ?
    `).bind(id, user.organisation_id).first()
    if (row) rows.push(row)
  }

  // Build a multi-label HTML — each label is one @page in the print preview.
  // contentW/H is the visual layout of the label; pageW/H is what we tell the
  // printer the page is. When rotate=true they swap, and we CSS-rotate each
  // label 90° so the printer sees its expected feed direction without us
  // having to redesign the layout.
  const isSmall = size === 'small'
  const contentW = isSmall ? 32 : 57
  const contentH = isSmall ? 57 : 32
  const pageW = rotate ? contentH : contentW
  const pageH = rotate ? contentW : contentH

  const labels = rows.map((row, idx) => {
    const subtitle = row.brand || ''
    const variant = [row.capacity, row.color].filter(Boolean).join(' · ')
    return `
    <div class="label-page">
    <div class="label" data-uuid="${row.uuid}" data-imei="${row.imei}">
      ${isSmall ? `
        <div class="h">
          <div class="brand">GOODS IN</div>
          ${row.grade ? `<div class="grade">${row.grade}</div>` : ''}
        </div>
        <div class="sku">${row.sku || ''}</div>
        ${subtitle ? `<div class="sub">${subtitle}</div>` : ''}
        ${variant ? `<div class="var">${variant}</div>` : ''}
        <div class="qr-main"><canvas id="qmain-${idx}"></canvas></div>
        <div class="imei-blk">
          <canvas id="qimei-${idx}"></canvas>
          <div class="imei-num mono">${row.imei}</div>
          <div class="imei-cap">IMEI</div>
        </div>
        <div class="foot"><div class="row"><span>UUID</span><span class="mono">${row.uuid}</span></div></div>
      ` : `
        <div class="left">
          <div>
            <div class="sku">${row.sku || ''}</div>
            <div class="sub">${[row.brand, row.capacity, row.color].filter(Boolean).join(' · ')}</div>
          </div>
          <div class="imei-blk">
            <canvas id="qimei-${idx}"></canvas>
            <div class="imei-side">
              <div class="imei-cap">IMEI</div>
              <div class="imei-num mono">${row.imei}</div>
            </div>
          </div>
        </div>
        <div class="right">
          <canvas id="qmain-${idx}"></canvas>
          <div class="uuid mono">${row.uuid}</div>
          ${row.grade ? `<div class="grade">${row.grade}</div>` : ''}
        </div>
      `}
    </div>
    </div>`
  }).join('\n')

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Print ${rows.length} labels (${contentW}×${contentH}mm${rotate ? ', rotated 90°' : ''})</title>
<script src="https://cdn.jsdelivr.net/npm/qrious@4.0.2/dist/qrious.min.js"></script>
<style>
  @page { size: ${pageW}mm ${pageH}mm; margin: 0; }
  html, body { margin: 0; padding: 0; background: #f5f5f5; font-family: system-ui, sans-serif; }
  @media screen {
    body { padding: 20px; }
    .preflight { max-width: 560px; margin: 0 auto 20px; background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 16px; }
    .preflight h2 { margin: 0 0 8px; font-size: 14px; color: #0f172a; }
    .preflight ol { margin: 8px 0 12px 18px; padding: 0; font-size: 12px; color: #334155; line-height: 1.6; }
    .preflight .btn { background: linear-gradient(135deg,#06b6d4,#6366f1); color:#fff; border:none; border-radius:6px; padding:8px 16px; font-size:13px; font-weight:600; cursor:pointer; }
    .labels-wrap { max-width: 560px; margin: 0 auto; }
    .labels-wrap .label-page { display:flex; align-items:center; justify-content:center; margin-bottom: 8px; }
    .labels-wrap .label { background: #fff; box-shadow: 0 0 0 1px #cbd5e1; }
  }
  @media print {
    html, body { background: #fff !important; padding: 0 !important; margin: 0 !important; overflow: hidden !important; }
    .preflight { display: none !important; }
    .labels-wrap { max-width: none !important; margin: 0 !important; padding: 0 !important; }
    .label-page {
      width: ${pageW}mm; height: ${pageH}mm;
      page-break-after: always; break-after: page;
      ${rotate ? 'position: relative;' : ''}
      overflow: hidden;
    }
    .label-page:last-child { page-break-after: auto; break-after: auto; }
    .label {
      box-shadow: none !important; margin: 0 !important;
      ${rotate ? `position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(90deg); transform-origin: center center;` : ''}
    }
  }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .label {
    width: ${contentW}mm; height: ${contentH}mm;
    padding: 1.2mm; color: #000; font-family: Arial, Helvetica, sans-serif;
    display: ${isSmall ? 'flex' : 'grid'};
    ${isSmall
      ? 'flex-direction: column; gap: 0.4mm;'
      : 'grid-template-columns: 1fr 13mm; gap: 1mm;'}
  }
  .mono { font-family: 'Courier New', monospace; }
  ${isSmall ? `
  .h { display:flex; justify-content:space-between; align-items:center; border-bottom: 0.15mm dashed #888; padding-bottom: 0.4mm; }
  .brand { font-size: 1.6mm; font-weight: 700; letter-spacing: 0.3mm; color: #555; }
  .grade { font-size: 2.4mm; font-weight: 800; padding: 0.2mm 0.8mm; border: 0.25mm solid #000; border-radius: 0.4mm; }
  .sku   { font-size: 3.2mm; font-weight: 800; text-align: center; line-height: 1.05; word-break: break-all; margin-top: 0.3mm; }
  .sub   { font-size: 1.8mm; font-weight: 600; text-align: center; }
  .var   { font-size: 1.6mm; text-align: center; color: #444; }
  .qr-main   { display:flex; justify-content:center; margin: 0.3mm 0; }
  .imei-blk  { border-top: 0.15mm dashed #888; padding-top: 0.4mm; display:flex; flex-direction:column; align-items:center; gap:0.2mm; }
  .imei-num  { font-size: 2mm; font-weight: 700; }
  .imei-cap  { font-size: 1.2mm; color: #666; letter-spacing: 0.2mm; }
  .foot      { border-top: 0.15mm dashed #888; padding-top: 0.3mm; margin-top: auto; }
  .row       { display:flex; justify-content:space-between; font-size: 1.5mm; }
  ` : `
  .left      { display:flex; flex-direction:column; justify-content:space-between; min-width: 0; }
  .sku       { font-size: 4.6mm; font-weight: 800; letter-spacing: 0.1mm; line-height: 1.05; word-break: break-all; }
  .sub       { font-size: 2mm; color: #444; margin-top: 0.4mm; }
  .imei-blk  { display:flex; align-items:center; gap:1.2mm; border-top: 0.15mm dashed #888; padding-top: 0.8mm; }
  .imei-side { display:flex; flex-direction:column; justify-content:center; }
  .imei-cap  { font-size: 1.4mm; font-weight: 700; letter-spacing: 0.3mm; color: #666; }
  .imei-num  { font-size: 2.6mm; font-weight: 700; }
  .right     { display:flex; flex-direction:column; align-items:center; justify-content:space-between; border-left: 0.15mm dashed #888; padding-left: 1mm; }
  .uuid      { font-size: 1.8mm; font-weight: 600; }
  .grade     { font-size: 3mm; font-weight: 800; padding: 0.2mm 1mm; border: 0.25mm solid #000; border-radius: 0.4mm; }
  `}
</style></head>
<body>
<div class="preflight">
  <h2>🖨️ Print preflight — ${rows.length} × ${contentW}×${contentH} mm DYMO labels${rotate ? ' <span style="font-size:11px;color:#64748b;font-weight:500">(rotated 90° for sideways feed)</span>' : ''}</h2>
  <ol>
    <li><b>Destination</b>: DYMO LabelWriter 450</li>
    <li><b>Paper size</b>: ${pageW} × ${pageH} mm</li>
    <li><b>Margins</b>: None &nbsp; · &nbsp; <b>Scale</b>: 100%</li>
    <li>Open <b>More settings</b> and <b>uncheck "Headers and footers"</b> (otherwise the date/URL prints on each label).</li>
  </ol>
  <button class="btn" onclick="window.print()">Open print dialog (${rows.length} label${rows.length === 1 ? '' : 's'})</button>
</div>
<div class="labels-wrap">
${labels}
</div>
<script>
  const rows = ${JSON.stringify(rows.map(r => ({ uuid: r.uuid, sku: r.sku, imei: r.imei })))};
  const mainPx = ${isSmall ? 105 : 95};
  const imeiPx = ${isSmall ? 90 : 70};
  function render() {
    if (!window.QRious) { setTimeout(render, 50); return; }
    rows.forEach((r, i) => {
      const payload = JSON.stringify({ uuid: r.uuid, sku: r.sku, imei: r.imei });
      new QRious({ element: document.getElementById('qmain-'+i), value: payload, size: mainPx, level: 'M' });
      new QRious({ element: document.getElementById('qimei-'+i), value: r.imei, size: imeiPx, level: 'M' });
    });
    // No auto-print — user clicks the button after confirming dialog settings
  }
  render();
  // Tell the parent window to mark all jobs as sent
  window.addEventListener('afterprint', () => {
    if (window.opener && !window.opener.closed) {
      try { window.opener.postMessage({ type: 'labels-printed', ids: ${JSON.stringify(ids)} }, '*'); } catch(e){}
    }
    setTimeout(() => window.close(), 200);
  });
</script>
</body></html>`
  return c.html(html)
})

// Mark a batch of jobs as sent (called by browser-print after window.print)
app.post('/mark-sent-batch', async (c) => {
  const user = currentUser(c)
  const body = await c.req.json<{ ids: number[] }>()
  const ids = (body.ids || []).map(Number).filter(Boolean)
  if (!ids.length) return c.json({ ok: true, sent: 0 })

  const stmts = []
  for (const id of ids) {
    const job = await c.env.DB.prepare('SELECT received_device_id, status FROM print_jobs WHERE id = ? AND organisation_id = ?').bind(id, user.organisation_id).first<{ received_device_id: number; status: string }>()
    if (!job || job.status === 'sent') continue
    stmts.push(c.env.DB.prepare("UPDATE print_jobs SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id))
    stmts.push(c.env.DB.prepare("UPDATE received_devices SET label_printed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(job.received_device_id))
  }
  if (stmts.length) await c.env.DB.batch(stmts)
  return c.json({ ok: true, sent: stmts.length / 2 })
})

export default app
