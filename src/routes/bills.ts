// Sprint B §1/§2/§4 — bill creation (purchase + repair, one builder),
// close/force-close, and cost-ledger writing on close. Thin HTTP shell
// over the pure billBuilder.ts / freightApportionment.ts logic — all
// domain rules live there and are independently unit-tested.
import { Hono } from 'hono'
import type { Bindings, AuthUser, BillType, BillPriceSource, RateSource } from '../types'
import { currentUser } from '../lib/auth'
import { cleanString, isValidCurrency } from '../lib/validate'
import { buildBill, checkBillCloseable, checkRepairBillAgainstDeclaredCharge, SUPPLIER_INVOICED, type BillImportRow, type BillHeaderInput } from '../lib/billBuilder'

const app = new Hono<{ Bindings: Bindings; Variables: { user: AuthUser } }>()

// GET /api/bills — list, org-scoped, optional ?bill_type=&status=
app.get('/', async (c) => {
  const user = currentUser(c)
  const q = c.req.query()
  const where: string[] = ['organisation_id = ?']
  const binds: unknown[] = [user.organisation_id]
  if (q.bill_type) { where.push('bill_type = ?'); binds.push(q.bill_type) }
  if (q.status) { where.push('status = ?'); binds.push(q.status) }
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM bills WHERE ${where.join(' AND ')} ORDER BY created_at DESC`
  ).bind(...binds).all()
  return c.json({ bills: results })
})

// GET /api/bills/:id — header + lines + serials
app.get('/:id', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const bill = await c.env.DB.prepare('SELECT * FROM bills WHERE id = ? AND organisation_id = ?')
    .bind(id, user.organisation_id).first()
  if (!bill) return c.json({ error: 'Bill not found' }, 404)
  const { results: lines } = await c.env.DB.prepare(
    'SELECT * FROM bill_lines WHERE bill_id = ? AND organisation_id = ? ORDER BY line_no ASC'
  ).bind(id, user.organisation_id).all()
  // Join the user's name/email so the UI can display WHO force-closed —
  // §1's close-rule override must capture variance, reason AND user; the
  // raw overridden_by_user_id alone isn't presentable.
  const { results: overrides } = await c.env.DB.prepare(
    `SELECT bco.*, u.name AS overridden_by_name, u.email AS overridden_by_email
       FROM bill_close_overrides bco
       LEFT JOIN users u ON u.id = bco.overridden_by_user_id
      WHERE bco.bill_id = ? AND bco.organisation_id = ?
      ORDER BY bco.overridden_at ASC`
  ).bind(id, user.organisation_id).all()
  const { results: serials } = await c.env.DB.prepare(
    `SELECT bls.bill_line_id, bls.imei, bls.received_device_id
       FROM bill_line_serials bls
       JOIN bill_lines bl ON bl.id = bls.bill_line_id
      WHERE bl.bill_id = ? AND bls.organisation_id = ?`
  ).bind(id, user.organisation_id).all()
  return c.json({ bill, lines, close_overrides: overrides, serials })
})

// POST /api/bills — ONE builder for both bill_type values ('purchase' |
// 'repair'). Body: header fields + rows[] (per-line/per-IMEI import rows).
// Goods-in without a bill remains permitted elsewhere (received_devices
// can be created with no bill_id at all — this endpoint is additive, not
// a gate on receiving); this is the owner's stated default, noted here
// per the explicit instruction to record it in the commit.
app.post('/', async (c) => {
  const user = currentUser(c)
  const orgId = user.organisation_id
  const body = await c.req.json<{
    bill_type: BillType
    vendor_name: string
    bill_date: string
    invoice_number: string
    currency_code: string
    exchange_rate?: number | null
    rate_date?: string | null
    rate_source?: RateSource | null
    customs_exchange_rate?: number | null
    price_source: BillPriceSource
    declared_total: number
    unit_count: number
    rows?: BillImportRow[]
  }>().catch(() => ({} as any))

  if (!body.bill_type || !['purchase', 'repair'].includes(body.bill_type)) {
    return c.json({ error: "bill_type must be 'purchase' or 'repair'" }, 400)
  }
  if (!cleanString(body.vendor_name)) return c.json({ error: 'vendor_name is required' }, 400)
  if (!cleanString(body.invoice_number)) return c.json({ error: 'invoice_number is required' }, 400)
  if (!isValidCurrency(body.currency_code)) return c.json({ error: `currency_code '${body.currency_code}' is not a recognised ISO 4217 code` }, 400)

  const dup = await c.env.DB.prepare(
    'SELECT id FROM bills WHERE organisation_id = ? AND vendor_name = ? AND invoice_number = ?'
  ).bind(orgId, body.vendor_name, body.invoice_number).first()
  if (dup) return c.json({ error: `A bill already exists for vendor '${body.vendor_name}' invoice '${body.invoice_number}'` }, 409)

  // Bulk cross-bill duplicate lookup — ONE query, matching the
  // resolveCatalogSkuBulk/manifests.ts discipline (O(1) round trips, not
  // O(rows)) rather than checking each IMEI against the DB individually.
  const { results: existingSerialRows } = await c.env.DB.prepare(
    'SELECT DISTINCT imei FROM bill_line_serials WHERE organisation_id = ?'
  ).bind(orgId).all<{ imei: string }>()
  const existingImeis = new Set(existingSerialRows.map(r => r.imei))

  const header: BillHeaderInput = {
    bill_type: body.bill_type,
    vendor_name: body.vendor_name,
    bill_date: body.bill_date,
    invoice_number: body.invoice_number,
    currency_code: body.currency_code,
    exchange_rate: body.exchange_rate ?? null,
    rate_date: body.rate_date ?? null,
    rate_source: body.rate_source ?? null,
    customs_exchange_rate: body.customs_exchange_rate ?? null,
    price_source: body.price_source,
    declared_total: body.declared_total,
    unit_count: body.unit_count,
  }

  const built = buildBill(header, body.rows || [], existingImeis)
  if (!built.ok) {
    return c.json({
      error: built.error,
      within_bill_duplicate_imeis: built.within_bill_duplicate_imeis || [],
      invalid_rows: built.invalid_rows || [],
    }, 422)
  }

  const ins = await c.env.DB.prepare(
    `INSERT INTO bills
       (organisation_id, bill_type, vendor_name, bill_date, invoice_number, currency_code,
        exchange_rate, rate_date, rate_source, customs_exchange_rate, unit_count, declared_total,
        price_source, gbp_total, declared_total_gbp, header_residual_gbp, status, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`
  ).bind(
    orgId, header.bill_type, header.vendor_name, header.bill_date, header.invoice_number, header.currency_code.toUpperCase(),
    header.exchange_rate, header.rate_date, header.rate_source, header.customs_exchange_rate, header.unit_count, header.declared_total,
    header.price_source, built.gbp_total, built.declared_total_gbp, built.header_residual_gbp, user.id,
  ).run()
  const billId = ins.meta.last_row_id as number

  const stmts: D1PreparedStatement[] = []
  built.lines.forEach((line, idx) => {
    stmts.push(c.env.DB.prepare(
      `INSERT INTO bill_lines
         (organisation_id, bill_id, line_no, sku, description, quantity, unit_price, exchange_rate_used, unit_price_gbp, is_continuation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(orgId, billId, idx + 1, line.sku, line.description, line.quantity, line.unit_price, line.exchange_rate_used, line.unit_price_gbp))
  })
  if (stmts.length) await c.env.DB.batch(stmts)

  // Attach serials — needs the line ids just inserted, so a second pass
  // (SQLite/D1 batch doesn't return per-statement ids reliably for a
  // mixed batch, so we re-select by (bill_id, line_no)).
  const { results: insertedLines } = await c.env.DB.prepare(
    'SELECT id, line_no FROM bill_lines WHERE bill_id = ? AND organisation_id = ?'
  ).bind(billId, orgId).all<{ id: number; line_no: number }>()
  const lineIdByNo = new Map(insertedLines.map(l => [l.line_no, l.id]))

  const serialStmts: D1PreparedStatement[] = []
  built.lines.forEach((line, idx) => {
    const lineId = lineIdByNo.get(idx + 1)
    if (!lineId) return
    for (const imei of line.imeis) {
      serialStmts.push(c.env.DB.prepare(
        `INSERT INTO bill_line_serials (organisation_id, bill_line_id, imei, received_device_id)
         VALUES (?, ?, ?, (SELECT id FROM received_devices WHERE imei = ? AND organisation_id = ? LIMIT 1))`
      ).bind(orgId, lineId, imei, imei, orgId))
    }
  })
  if (serialStmts.length) await c.env.DB.batch(serialStmts)

  return c.json({
    ok: true,
    bill_id: billId,
    gbp_total: built.gbp_total,
    header_residual_gbp: built.header_residual_gbp,
    dropped_non_imei_rows: built.dropped_non_imei_rows,
    cross_bill_duplicate_imeis: built.cross_bill_duplicate_imeis,
    invalid_rows: built.invalid_rows,
    line_count: built.lines.length,
  })
})

// POST /api/bills/:id/close — normal close: only succeeds when
// sum(lines) == declared header GBP total.
app.post('/:id/close', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const bill = await c.env.DB.prepare('SELECT * FROM bills WHERE id = ? AND organisation_id = ?')
    .bind(id, user.organisation_id).first<{ id: number; gbp_total: number | null; declared_total_gbp: number | null; status: string }>()
  if (!bill) return c.json({ error: 'Bill not found' }, 404)
  if (bill.status === 'closed') return c.json({ error: 'Bill is already closed' }, 409)

  const { results: lines } = await c.env.DB.prepare(
    'SELECT unit_price_gbp FROM bill_lines WHERE bill_id = ? AND organisation_id = ?'
  ).bind(id, user.organisation_id).all<{ unit_price_gbp: number | null }>()
  const sumLines = Math.round(lines.reduce((s, l) => s + (l.unit_price_gbp ?? 0), 0) * 100) / 100

  // Compare against declared_total_gbp (the header's OWN claimed total,
  // converted to GBP) — NOT bill.gbp_total, which is itself defined as
  // the sum of lines and would make this check circular/always-true.
  const check = checkBillCloseable(sumLines, bill.declared_total_gbp ?? 0)
  if (!check.ok) {
    return c.json({ error: check.reason, variance_gbp: check.variance_gbp, code: 'bill_unbalanced' }, 409)
  }

  await c.env.DB.prepare("UPDATE bills SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = ? AND organisation_id = ?")
    .bind(id, user.organisation_id).run()

  return c.json({ ok: true, closed: true })
})

// POST /api/bills/:id/force-close — writes an append-only
// bill_close_overrides row (the misdeclaration-ack pattern, reused) then
// closes regardless of variance.
app.post('/:id/force-close', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const body = await c.req.json<{ reason?: string }>().catch(() => ({} as any))
  const reason = cleanString(body.reason)
  if (!reason) return c.json({ error: 'reason is required to force-close an unbalanced bill' }, 422)

  const bill = await c.env.DB.prepare('SELECT * FROM bills WHERE id = ? AND organisation_id = ?')
    .bind(id, user.organisation_id).first<{ id: number; gbp_total: number | null; declared_total_gbp: number | null; status: string }>()
  if (!bill) return c.json({ error: 'Bill not found' }, 404)
  if (bill.status === 'closed') return c.json({ error: 'Bill is already closed' }, 409)

  const { results: lines } = await c.env.DB.prepare(
    'SELECT unit_price_gbp FROM bill_lines WHERE bill_id = ? AND organisation_id = ?'
  ).bind(id, user.organisation_id).all<{ unit_price_gbp: number | null }>()
  const sumLines = Math.round(lines.reduce((s, l) => s + (l.unit_price_gbp ?? 0), 0) * 100) / 100
  const variance = Math.round((sumLines - (bill.declared_total_gbp ?? 0)) * 100) / 100

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO bill_close_overrides (organisation_id, bill_id, variance_gbp, reason, overridden_by_user_id)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(user.organisation_id, id, variance, reason, user.id),
    c.env.DB.prepare("UPDATE bills SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = ? AND organisation_id = ?")
      .bind(id, user.organisation_id),
  ])

  return c.json({ ok: true, closed: true, force_closed: true, variance_gbp: variance })
})

// POST /api/bills/:id/write-cost-ledger — on a CLOSED bill, writes one
// append-only cost_ledger row per bill line/serial (cost_type = 'purchase'
// or 'repair' per the bill's bill_type; provenance = 'supplier-invoiced'
// since these figures come straight off an invoiced document). Separate
// from close() so a bill can be closed and reviewed before its costs are
// posted to devices, and so repeat calls are safely idempotent (skips
// serials that already have a ledger row for this bill).
app.post('/:id/write-cost-ledger', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const bill = await c.env.DB.prepare('SELECT * FROM bills WHERE id = ? AND organisation_id = ?')
    .bind(id, user.organisation_id).first<{ id: number; bill_type: string; status: string; currency_code: string }>()
  if (!bill) return c.json({ error: 'Bill not found' }, 404)
  if (bill.status !== 'closed') return c.json({ error: 'Bill must be closed before its costs are posted to devices' }, 409)

  const costType = bill.bill_type === 'repair' ? 'repair' : 'purchase'

  const { results: rows } = await c.env.DB.prepare(
    `SELECT bls.id AS serial_id, bls.received_device_id, bl.id AS bill_line_id, bl.unit_price_gbp,
            bl.exchange_rate_used, bl.unit_price, b.rate_date
       FROM bill_line_serials bls
       JOIN bill_lines bl ON bl.id = bls.bill_line_id
       JOIN bills b ON b.id = bl.bill_id
      WHERE bl.bill_id = ? AND bls.organisation_id = ? AND bls.received_device_id IS NOT NULL`
  ).bind(id, user.organisation_id).all<{
    serial_id: number; received_device_id: number; bill_line_id: number
    unit_price_gbp: number | null; exchange_rate_used: number | null; unit_price: number | null; rate_date: string | null
  }>()

  // Idempotency: skip any (device, source_bill_line) combination already posted.
  const { results: already } = await c.env.DB.prepare(
    `SELECT DISTINCT source_bill_line_id FROM cost_ledger
      WHERE organisation_id = ? AND source_bill_line_id IN (
        SELECT id FROM bill_lines WHERE bill_id = ?
      )`
  ).bind(user.organisation_id, id).all<{ source_bill_line_id: number }>()
  const alreadyPosted = new Set(already.map(r => r.source_bill_line_id))

  const stmts: D1PreparedStatement[] = []
  let posted = 0
  for (const row of rows) {
    if (alreadyPosted.has(row.bill_line_id)) continue
    if (row.unit_price_gbp == null) continue
    stmts.push(c.env.DB.prepare(
      `INSERT INTO cost_ledger
         (organisation_id, received_device_id, cost_type, amount_gbp, currency_code, exchange_rate, rate_date,
          source_bill_line_id, provenance, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      user.organisation_id, row.received_device_id, costType, row.unit_price_gbp, bill.currency_code,
      row.exchange_rate_used, row.rate_date, row.bill_line_id, SUPPLIER_INVOICED, user.id,
    ))
    posted++
  }
  if (stmts.length) await c.env.DB.batch(stmts)

  return c.json({ ok: true, posted, skipped_already_posted: rows.length - posted })
})

// POST /api/bills/:id/repair-control — §4: ties a REPAIR bill's per-IMEI
// lines sum to the customs-declared process charge (already established
// on the relevant OPR import shipment, e.g. Ce1154.process_charge_gbp /
// shipments.repair_cost). Flags variance; never reconciles silently.
app.post('/:id/repair-control', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const body = await c.req.json<{ declared_process_charge_gbp: number }>().catch(() => ({} as any))
  if (body.declared_process_charge_gbp == null || !Number.isFinite(body.declared_process_charge_gbp)) {
    return c.json({ error: 'declared_process_charge_gbp is required' }, 400)
  }

  const bill = await c.env.DB.prepare('SELECT * FROM bills WHERE id = ? AND organisation_id = ?')
    .bind(id, user.organisation_id).first<{ id: number; bill_type: string; gbp_total: number | null }>()
  if (!bill) return c.json({ error: 'Bill not found' }, 404)
  if (bill.bill_type !== 'repair') return c.json({ error: 'repair-control only applies to repair bills' }, 409)

  const result = checkRepairBillAgainstDeclaredCharge(bill.gbp_total ?? 0, body.declared_process_charge_gbp)
  return c.json({ ok: true, ...result })
})

export default app
