// Integration seams for later phases (Priority 6): read endpoints the
// future CRM / OPR modules will consume, plus the status-transition
// endpoint that's the single entry point for lifecycle changes, CSV
// export, and outbound webhook configuration.
//
// These are deliberately generic device reads/writes — NOT grading/export/
// customs workflows (explicitly out of scope for this pass).

import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import type { Bindings, AuthUser, DeviceStatus } from '../types'
import { currentUser } from '../lib/auth'
import { DEVICE_STATUSES, transitionDevice, InvalidTransitionError, DeviceNotFoundError, TransitionGateError, ALLOWED_TRANSITIONS, OPR_WORKFLOW_ONLY_STATUSES, REPAIR_WORKFLOW_ONLY_STATUSES, REJECT_REASON_CODES, UNREJECT_REASON_CODES, checkRejectUnrejectGate } from '../lib/deviceLifecycle'
import { dispatchDeviceStatusWebhooks } from '../lib/webhook'
import { startRepair, scanBackRepair, recordQc, reopenRepair, closeToInventory, recordRepairCost, postRepairCostToLedger, RepairJobError } from '../lib/repairWorkflow'
import { postPurchaseCostToLedger, CostEntryError } from '../lib/costEntry'

const app = new Hono<{ Bindings: Bindings; Variables: { user: AuthUser } }>()

// GET /api/devices?status=&source=&q=&page=&page_size=
// Org-scoped, filterable, paginated. This is the primary read seam a
// future CRM integration will poll/subscribe against.
app.get('/', async (c) => {
  const user = currentUser(c)
  const q = c.req.query()
  const pageSize = Math.min(Math.max(Number(q.page_size) || 50, 1), 200)
  const page = Math.max(Number(q.page) || 1, 1)
  const offset = (page - 1) * pageSize

  const where: string[] = ['organisation_id = ?']
  const binds: unknown[] = [user.organisation_id]

  if (q.status) {
    const statuses = q.status.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    const invalid = statuses.filter(s => !DEVICE_STATUSES.includes(s as DeviceStatus))
    if (invalid.length) {
      return c.json({ error: `Invalid status value(s): ${invalid.join(', ')}` }, 400)
    }
    where.push(`status IN (${statuses.map(() => '?').join(',')})`)
    binds.push(...statuses)
  }
  if (q.source) {
    where.push('source = ?')
    binds.push(q.source)
  }
  if (q.q) {
    where.push('(imei LIKE ? OR sku LIKE ? OR uuid LIKE ?)')
    const w = `%${q.q}%`
    binds.push(w, w, w)
  }

  const whereSql = `WHERE ${where.join(' AND ')}`

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM received_devices ${whereSql}`
  ).bind(...binds).first<{ total: number }>()

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM received_devices ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).bind(...binds, pageSize, offset).all()

  return c.json({
    devices: results,
    page,
    page_size: pageSize,
    total: countRow?.total ?? 0,
  })
})

// GET /api/devices/repair-queue — devices currently IN_HOUSE_REPAIR or
// QC_FAILED, each joined with its most recent repair_jobs row so the
// Repair Queue UI can render the right action (scan-back / QC / reopen /
// cost) without a second round trip per device.
//
// MUST be registered before GET /:id — Hono resolves single-segment
// literal and param routes by REGISTRATION ORDER, not specificity, so
// "repair-queue" would otherwise be swallowed by /:id (Number("repair-
// queue") is NaN → a 400, not a 404 — this exact failure mode was caught
// by test #43 when the route was first added below /:id instead of above
// it).
app.get('/repair-queue', async (c) => {
  const user = currentUser(c)
  const { results } = await c.env.DB.prepare(`
    SELECT rd.*,
           rj.id AS repair_job_id, rj.status AS repair_job_status,
           rj.fault_code, rj.qc_result, rj.qc_fail_reason,
           rj.repair_cost_gbp, rj.parts_cost_gbp, rj.labour_cost_gbp,
           rj.cost_source, rj.cost_source_reference,
           rj.opened_at, rj.closed_at
      FROM received_devices rd
      LEFT JOIN repair_jobs rj ON rj.id = (
        SELECT id FROM repair_jobs WHERE device_id = rd.id ORDER BY id DESC LIMIT 1
      )
     WHERE rd.organisation_id = ? AND rd.status IN ('IN_HOUSE_REPAIR', 'QC_FAILED')
     ORDER BY rd.id DESC
     LIMIT 500
  `).bind(user.organisation_id).all()
  return c.json({ devices: results })
})

// GET /api/devices/:id — full record with current status + event history.
app.get('/:id', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const device = await c.env.DB.prepare(
    'SELECT * FROM received_devices WHERE id = ? AND organisation_id = ?'
  ).bind(id, user.organisation_id).first()
  if (!device) return c.json({ error: 'Not found' }, 404)

  const { results: events } = await c.env.DB.prepare(
    'SELECT * FROM device_events WHERE device_id = ? AND organisation_id = ? ORDER BY id DESC LIMIT 200'
  ).bind(id, user.organisation_id).all()

  return c.json({ device, events })
})

// GET /api/devices/export/csv?status=&source=&ids=  — CSV export for a
// received/selected batch. `ids` (comma-separated) takes precedence over
// the status/source filters when supplied, for exporting an exact
// operator-picked selection from the Inventory view.
//
// This file is an audit artefact, so every failure mode here is LOUD rather
// than a quiet wrong answer:
//   - `status`/`source` are validated against their enums (a typo like
//     `RECIEVED` used to return a headers-only CSV, indistinguishable from
//     "no devices in that state"); `status` accepts a comma-separated list
//     for parity with `GET /api/devices`.
//   - a non-numeric entry in `ids` is a 400, never silently dropped — the
//     operator must never believe they exported a selection they didn't.
// Values are written byte-faithfully: the only transformation is RFC 4180
// quoting (which must include `\r`, not just `\n` — a bare CR terminates a
// record in Excel and would corrupt one device into two malformed rows).
//
// B3 (2026-09-07) rewrite — four changes from the prior shape, all part of
// the same standing "export must never lie about what it contains" rule:
//   1. NO row cap / no LIMIT-OFFSET anywhere in this path. The previous
//      EXPORT_ROW_CAP=5000-then-413 pattern refused large selections
//      outright; the org's device count is well past four figures and
//      growing, so refusing is not an option — the query is a plain
//      unbounded SELECT and the response is STREAMED (hono/streaming's
//      `stream()`) row-by-row so an arbitrarily large result set never has
//      to live in memory as one giant string/array before being sent.
//   2. Column set is a SUPERSET of the old 16-column shape plus the new
//      lifecycle/costing fields — NOT a replacement (the first draft of
//      this rewrite wrongly dropped uuid/created_at/brand/capacity/color;
//      that was corrected before this landed). Two of the restored columns
//      are load-bearing for existing offline workflows, not just "nice to
//      keep": `created_at` is the field an earlier reconciliation pass
//      matched 398 rows against a 24 August roster snapshot — it is the
//      only full-roster export and losing that column would make that
//      class of check impossible without a fresh D1 query window.  `uuid`
//      is the natural idempotency key for append-only Zoho batch-insert
//      seeding (stable across any future IMEI correction, unlike IMEI
//      itself). `brand`/`capacity`/`color` are kept because they are free
//      to carry and Zoho item matching may want them un-parsed even though
//      the SKU likely encodes the same information.
//      DROPPED deliberately (not restored): `buy_price` — this column was
//      in the pre-B3 16-column shape and is dropped here NOT because it
//      was overlooked but because `purchase_cost_gbp` (this rewrite's new
//      cost_ledger-derived column, below) is its superseding aggregate:
//      buy_price is a single mutable field on received_devices with no
//      history and no source attribution, while purchase_cost_gbp sums
//      the append-only cost_ledger 'purchase' rows for the same device —
//      the more trustworthy figure for exactly the Zoho-reconciliation
//      audience this export serves, and the two are NOT meant to be
//      exported side by side (that would invite exactly the kind of
//      "which number is right" confusion a reconciliation file must
//      avoid). Neither of the user's two explicit column lists (restore /
//      developer's-call) named buy_price either way; this is the explicit
//      decision, recorded here rather than left silent. `currency` —
//      every remaining money column here (purchase_cost_gbp/
//      repair_cost_gbp) is a GBP-only cost_ledger aggregate, so a
//      per-device currency code has nothing left to qualify once
//      buy_price itself is gone from this export.
//      `label_printed_at` — a label-printing/warehouse-workflow field with
//      no bearing on the financial/Zoho reconciliation this export exists
//      for; dropping it keeps the shape focused. `source` is KEPT — it is
//      free, already validated as a filter on this same route, and is
//      useful provenance (manifest/unreconciled/manual) for the same
//      reconciliation use case that keeps uuid/created_at.
//        - `vendor`: suppliers.name via received_devices.supplier_id.
//        - `bill_ref`: bills.invoice_number for this device's cost_ledger
//          'purchase' row's source_bill_line_id, when one exists (bill-
//          backed costing, src/routes/bills.ts write-cost-ledger). NULL for
//          devices costed via the no-bill path (postPurchaseCostToLedger,
//          source_bill_line_id always NULL there) or not yet costed at all.
//        - cost fields: purchase_cost_gbp, repair_cost_gbp — summed from
//          cost_ledger by cost_type, same aggregation shape as
//          GET /api/reports/inventory-valuation (COALESCE(SUM(...),0) over
//          a LEFT JOIN so an uncosted device is 0.00, not an absent row).
//        - `received_date`: COALESCE(received_at, created_at) — the
//          genuine physical-receipt timestamp (migration 0023b) where
//          populated, falling back to created_at for historical rows that
//          predate that column. This sits ALONGSIDE created_at (both are
//          exported now), not in place of it — they answer different
//          questions and the roster-matching use case above needs the
//          original created_at specifically, not this fallback-blended one.
//   3. IMEI ENCODING IS QUERY-CONTROLLED, not fixed:
//        - default (no query param): plain digits in a normal quoted CSV
//          field — this is what machine consumers (the Zoho gap diff,
//          vitest) need, because the `="..."` form makes IMEI compare as
//          a 7-longer literal string in any downstream diff.
//        - `?excel=1`: emits `="<digits>"`, the Excel/Sheets text-forcing
//          formula form, which stops a 15-digit IMEI silently rendering as
//          8.6E+14 and being corrupted on re-save. This is what the UI
//          export button below targets, because a human clicking Export in
//          a browser is headed for Excel.
//      One route, one flag — no second endpoint for the two audiences.
// COST-COLUMN GATING (7th instance of the standing rule — see
// isManagerOrAdmin() in app.js for the matching UI-side gate, added in this
// SAME commit): purchase_cost_gbp/repair_cost_gbp/bill_ref are financial
// data and are OMITTED FROM THE HEADER ROW ENTIRELY for a non-manager
// caller — not blanked-out cells (a blank cell still confirms the column
// exists and invites probing), a narrower CSV with fewer columns.
const DEVICE_SOURCES = ['manifest', 'unreconciled', 'manual'] as const

// `?excel=1` formula-prefix wrapper, forcing Excel/Sheets to treat a
// numeric-looking string as text rather than re-parsing it into scientific
// notation. The bare (non-excel) path never calls this — see STEP 2 above.
const imeiAsText = (imei: unknown) => `="${String(imei ?? '')}"`

const escapeCsv = (v: unknown) => {
  if (v == null) return ''
  const s = String(v)
  return /["\r\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

app.get('/export/csv', async (c) => {
  const user = currentUser(c)
  const q = c.req.query()
  const includeCostColumns = requireManager(c)
  const excelSafe = q.excel === '1'

  const where: string[] = ['rd.organisation_id = ?']
  const binds: unknown[] = [user.organisation_id]

  if (q.ids) {
    const raw = q.ids.split(',').map(s => s.trim()).filter(s => s !== '')
    if (!raw.length) return c.json({ error: 'ids must contain at least one numeric id' }, 400)
    // Reject junk loudly: silently dropping an unparseable id would hand the
    // operator a file that is missing rows they believe they selected.
    const invalid = raw.filter(s => !/^[1-9][0-9]*$/.test(s))
    if (invalid.length) {
      return c.json({ error: `ids must be positive integers — invalid: ${invalid.join(', ')}` }, 400)
    }
    const ids = raw.map(Number)
    where.push(`rd.id IN (${ids.map(() => '?').join(',')})`)
    binds.push(...ids)
  } else {
    if (q.status) {
      const statuses = q.status.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
      const invalid = statuses.filter(s => !DEVICE_STATUSES.includes(s as DeviceStatus))
      if (invalid.length) {
        return c.json({ error: `Invalid status value(s): ${invalid.join(', ')}` }, 400)
      }
      if (statuses.length) {
        where.push(`rd.status IN (${statuses.map(() => '?').join(',')})`)
        binds.push(...statuses)
      }
    }
    if (q.source) {
      const source = q.source.trim().toLowerCase()
      if (!DEVICE_SOURCES.includes(source as typeof DEVICE_SOURCES[number])) {
        return c.json({ error: `Invalid source value: ${q.source} — must be one of: ${DEVICE_SOURCES.join(', ')}` }, 400)
      }
      where.push('rd.source = ?')
      binds.push(source)
    }
  }

  const whereSql = where.join(' AND ')

  // No LIMIT/OFFSET, no row cap — unbounded by design (see comment above).
  // bill_ref and the two cost sums are correlated subqueries rather than a
  // JOIN+GROUP BY: each device has at most one 'purchase' cost_ledger row
  // under the current guard (postPurchaseCostToLedger's duplicate-row
  // guard, src/lib/costEntry.ts), so a scalar subquery is exact and keeps
  // this a plain per-row streamed SELECT rather than an aggregate query.
  const sql = `
    SELECT
      rd.id AS id,
      rd.uuid AS uuid,
      rd.imei AS imei,
      rd.sku AS sku,
      rd.brand AS brand,
      rd.model AS model,
      rd.capacity AS capacity,
      rd.color AS color,
      rd.grade AS grade,
      rd.status AS status,
      rd.source AS source,
      rd.vat_type AS vat_type,
      rd.created_at AS created_at,
      COALESCE(rd.received_at, rd.created_at) AS received_date,
      s.name AS vendor,
      (SELECT b.invoice_number
         FROM cost_ledger cl
         JOIN bill_lines bl ON bl.id = cl.source_bill_line_id
         JOIN bills b ON b.id = bl.bill_id
        WHERE cl.received_device_id = rd.id AND cl.cost_type = 'purchase'
        LIMIT 1) AS bill_ref,
      COALESCE((SELECT SUM(cl.amount_gbp) FROM cost_ledger cl
                 WHERE cl.received_device_id = rd.id AND cl.cost_type = 'purchase'), 0) AS purchase_cost_gbp,
      COALESCE((SELECT SUM(cl.amount_gbp) FROM cost_ledger cl
                 WHERE cl.received_device_id = rd.id AND cl.cost_type = 'repair'), 0) AS repair_cost_gbp
    FROM received_devices rd
    LEFT JOIN suppliers s ON s.id = rd.supplier_id
    WHERE ${whereSql}
    ORDER BY rd.id ASC
  `

  // Superset shape (STEP 1 correction, 2026-09-07): restores uuid/
  // created_at/brand/capacity/color/source alongside the new lifecycle +
  // costing columns — see the module comment above for exactly what was
  // dropped (currency, label_printed_at) and why.
  const baseHeaders = ['id', 'uuid', 'imei', 'sku', 'brand', 'model', 'capacity', 'color', 'grade', 'status', 'source', 'vat_type', 'created_at', 'received_date', 'vendor']
  const costHeaders = ['bill_ref', 'purchase_cost_gbp', 'repair_cost_gbp']
  const headers = includeCostColumns ? [...baseHeaders, ...costHeaders] : baseHeaders

  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="devices-export-${Date.now()}.csv"`)

  return stream(c, async (writer) => {
    await writer.write(headers.join(',') + '\r\n')
    let rowCount = 0

    const { results } = await c.env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>()
    for (const row of results) {
      // STEP 2: IMEI encoding is query-controlled — see module comment.
      // Default = plain digits (machine-readable); ?excel=1 = ="..." form.
      const cells = headers.map(h => (h === 'imei' && excelSafe ? imeiAsText(row[h]) : escapeCsv(row[h])))
      await writer.write(cells.join(',') + '\r\n')
      rowCount++
    }

    // Row count can only be surfaced as a trailing custom header once the
    // stream has been fully written (Cloudflare Workers does not support
    // adding response headers after streaming has started) — a JS-style
    // comment line, prefixed so a spreadsheet importer trims/ignores it,
    // carrying the same cross-check value the old X-Export-Row-Count
    // header gave a non-streamed caller.
    await writer.write(`# row_count=${rowCount}\r\n`)
  })
})

// GET /api/devices/statuses — expose the enum + allowed transition map so a
// CRM/UI can render valid next-states without hardcoding the state machine.
// reason_codes (2026-09-01) is the SAME single-source-of-truth principle
// applied to the two reject/un-reject edges: the UI must not carry its own
// copy of REJECT_REASON_CODES/UNREJECT_REASON_CODES (that would be exactly
// the "client-side copy of the transition map" failure mode this endpoint
// already exists to prevent for `transitions`) — it renders whichever list
// this returns, so a future reason-code change here needs zero frontend edit.
//
// Role-filtered `transitions` (2026-09-01, second pass): the raw
// ALLOWED_TRANSITIONS map is state-machine-only, with no concept of who
// may drive an edge — but two of its edges (RECEIVED<->REJECTED) ARE
// manager-gated in the route below. Serving the UNFILTERED map to an
// operator caller would repeat the exact bug this endpoint's `reason_codes`
// addition just fixed one layer up: the "Move to" dropdown would offer
// REJECTED/RECEIVED, the operator would fill in a reason and submit, and
// get a 403 they had no way to see coming. Filtering server-side (rather
// than shipping the full map and trusting the client to also know the
// role rule) keeps exactly one source of truth for "who may drive this
// edge" — the same requireManager() check the route enforces — instead of
// two copies that could drift. Only removes the two reject/un-reject
// edges for a non-manager; every other edge in the map is unfiltered
// because nothing else on the generic /transition route is role-gated yet
// (that is the separate, still-unstarted commit pending the operator's
// per-edge access answer — see ALLOWED_TRANSITIONS's own header comment
// and devices.ts's isRejectEdge/isUnrejectEdge block). When that commit
// lands, this same filter is the place its per-edge rules plug in too —
// one endpoint, one role-aware view of the map, not per-edge frontend logic.
app.get('/meta/statuses', (c) => {
  const user = currentUser(c)
  const managerOk = user.role === 'manager' || user.role === 'admin'
  const transitions: Record<string, DeviceStatus[]> = managerOk
    ? ALLOWED_TRANSITIONS
    : Object.fromEntries(
        Object.entries(ALLOWED_TRANSITIONS).map(([from, tos]) => [
          from,
          tos.filter((to) => !(
            (from === 'RECEIVED' && to === 'REJECTED') ||
            (from === 'REJECTED' && to === 'RECEIVED')
          )),
        ])
      ) as Record<string, DeviceStatus[]>
  return c.json({
    statuses: DEVICE_STATUSES,
    transitions,
    // reason_codes stays keyed off the FULL edge set regardless of role —
    // it is a lookup table for the modal's <select> options, not itself a
    // grant of permission (the manager gate already happened above, in
    // which edges are visible to begin with). A manager caller still needs
    // both lists; an operator caller sees neither reject edge in
    // `transitions` in the first place, so their UI never opens the modal
    // that would read this.
    reason_codes: {
      REJECTED: REJECT_REASON_CODES,   // required when moving RECEIVED -> REJECTED
      UNREJECT: UNREJECT_REASON_CODES, // required when moving REJECTED -> RECEIVED (keyed apart from RECEIVED, which has no reason requirement on its OTHER inbound edges)
    },
  })
})

// POST /api/devices/bulk-transition — { target_status, imeis: string[] }
// Bulk equivalent of POST /:id/transition, mirroring scan.ts's /bulk
// pattern exactly: every IMEI is processed INDEPENDENTLY (a bad/missing/
// blocked IMEI never stops the rest), capped at BULK_TRANSITION_CAP per
// call, and the response carries a per-IMEI outcome array plus summary
// counts so the UI can show exactly what happened to each scanned unit.
//
// Same guardrails as the single-device endpoint: target_status (and a
// device's CURRENT status) may never be one of the OPR/repair
// workflow-only statuses — those must move exclusively through their own
// dedicated routes, or shipment_lines/repair_jobs would desynchronise
// from the device ledger. The target check is global (checked once,
// before the loop); the current-status check is per-device.
//
// Cap history (2026-08-15): raised 200 -> 500. The 200-item cap itself
// was never the actual production defect (it rejects overflow explicitly
// with a 422, it never truncates silently) — the real bug was client-side
// (public/static/app.js): both this endpoint's modal and the /scan/bulk
// modal deduped pasted/scanned IMEIs via a Set BEFORE checking the count
// against the cap, so e.g. 205 pasted lines with 5 duplicates produced
// 200 unique IMEIs, silently under the cap, with the UI only ever
// showing the post-dedup count and no indication 5 lines had been merged
// away ("205 scanned, 200 shown, five silently dropped" — the exact
// production report). That silent-merge gap is fixed on the client
// (parseBulkImeis() now always surfaces raw-vs-unique counts). 500 here
// is a genuine, separate improvement so the owner has real headroom
// above their observed real-world batch sizes (162-item backfill,
// 200+-item scans) without needing to split runs — still bounded because
// this loop makes several sequential D1 round trips per IMEI (a lookup
// SELECT plus everything transitionDevice() itself does), and an
// unbounded per-request loop risks the platform's subrequest/CPU limits.
const BULK_TRANSITION_CAP = 500

app.post('/bulk-transition', async (c) => {
  const user = currentUser(c)
  const body = await c.req.json<{ target_status?: string; imeis?: unknown[]; reason_code?: string }>().catch(() => ({} as any))

  const targetStatus = String(body.target_status || '').toUpperCase() as DeviceStatus
  if (!DEVICE_STATUSES.includes(targetStatus)) {
    return c.json({ error: `target_status must be one of: ${DEVICE_STATUSES.join(', ')}` }, 400)
  }
  if (OPR_WORKFLOW_ONLY_STATUSES.includes(targetStatus)) {
    return c.json({ error: `${targetStatus} is managed by the OPR consignment workflow — it cannot be set via bulk transition` }, 409)
  }
  if (REPAIR_WORKFLOW_ONLY_STATUSES.includes(targetStatus)) {
    return c.json({ error: `${targetStatus} is managed by the repair workflow — it cannot be set via bulk transition` }, 409)
  }

  // ── Reject / un-reject gating (2026-09-07 — closes the bulk bypass) ──
  // Bug this replaces: this route used to call transitionDevice() directly
  // for every row with no check at all, so an operator token could
  // bulk-reject or bulk-un-reject with a plain HTTP 200 and no reason_code
  // recorded — the single-device /:id/transition route's manager-gate and
  // mandatory reason_code (2026-09-01) simply had no equivalent here.
  //
  // Gated ONCE per call, not per IMEI: role and reason_code are properties
  // of the CALLER and the CALL, not of any individual device, and (per
  // ALLOWED_TRANSITIONS in deviceLifecycle.ts) REJECTED and RECEIVED are
  // each reachable from exactly one other status via a bulk-eligible edge
  // — RECEIVED->REJECTED and REJECTED->RECEIVED respectively — so a batch
  // whose target_status is REJECTED or RECEIVED IS, in its entirety, a
  // bulk reject/un-reject request; there is no other transition a bulk
  // call to either target could represent. Individual rows whose device
  // is NOT actually eligible for that edge (e.g. already ACTIVE_INVENTORY
  // when target_status is REJECTED) still fail per-row with the ordinary
  // InvalidTransitionError skip below (#40), unaffected by this gate.
  //
  // Deliberately NOT a blanket refusal like the OPR/REPAIR_WORKFLOW_ONLY
  // checks above (which always 409, no caller can ever pass) — rejecting
  // or un-rejecting a scanned batch is a legitimate manager operation, so
  // this GATES the call (403 non-manager, 422 missing/invalid reason) and
  // then PERMITS it, rather than refusing it outright. Uses the exact same
  // checkRejectUnrejectGate() the single-device route calls, so the two
  // never drift; transitionDevice() itself also re-checks per-row as a
  // defence-in-depth backstop (see its own comment) — this is not the
  // only place the rule is enforced, just the fast, pre-write check.
  const bulkGateFromStatus: DeviceStatus | null =
    targetStatus === 'REJECTED' ? 'RECEIVED' : targetStatus === 'RECEIVED' ? 'REJECTED' : null
  let batchReasonCode: string | undefined
  if (bulkGateFromStatus) {
    const gate = checkRejectUnrejectGate(bulkGateFromStatus, targetStatus, user, body.reason_code)
    if (gate.applicable && !gate.ok) {
      return c.json(
        gate.status === 422 ? { error: gate.error, valid_reason_codes: gate.valid_reason_codes } : { error: gate.error },
        gate.status,
      )
    }
    if (gate.applicable && gate.ok) batchReasonCode = gate.reasonCode
  }

  if (!Array.isArray(body.imeis)) return c.json({ error: 'Body must be { target_status, imeis: [...] }' }, 422)
  if (!body.imeis.length) return c.json({ error: 'imeis is empty' }, 422)
  if (body.imeis.length > BULK_TRANSITION_CAP) {
    return c.json({ error: `Maximum ${BULK_TRANSITION_CAP} IMEIs per bulk-transition call` }, 422)
  }

  type BulkTransitionOutcome = {
    imei: string
    ok: boolean
    outcome: 'transitioned' | 'skipped' | 'error'
    message?: string
    from_status?: string
    device_id?: number
  }
  const results: BulkTransitionOutcome[] = []
  const notifyPromises: Promise<unknown>[] = []

  for (const raw of body.imeis) {
    const imei = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim()
    if (!imei) {
      results.push({ imei: String(raw ?? ''), ok: false, outcome: 'error', message: 'Empty IMEI' })
      continue
    }

    const device = await c.env.DB.prepare(
      'SELECT id, status FROM received_devices WHERE imei = ? AND organisation_id = ?'
    ).bind(imei, user.organisation_id).first<{ id: number; status: DeviceStatus }>()
    if (!device) {
      results.push({ imei, ok: false, outcome: 'error', message: 'No device found for this IMEI' })
      continue
    }

    if (OPR_WORKFLOW_ONLY_STATUSES.includes(device.status)) {
      results.push({
        imei, ok: false, outcome: 'skipped', device_id: device.id, from_status: device.status,
        message: `Device is ${device.status}, managed by the OPR consignment workflow — cannot bulk-transition`,
      })
      continue
    }
    if (REPAIR_WORKFLOW_ONLY_STATUSES.includes(device.status)) {
      results.push({
        imei, ok: false, outcome: 'skipped', device_id: device.id, from_status: device.status,
        message: `Device is ${device.status}, managed by the repair workflow — cannot bulk-transition`,
      })
      continue
    }

    // Per-row edge kind, purely for event_type/metadata labelling — the
    // gate itself already ran once above (see its comment for why a
    // once-per-call check is exhaustive for these two specific edges: the
    // state machine has exactly one valid from-status for each of
    // target_status REJECTED / RECEIVED, so every row that could possibly
    // succeed here already matches bulkGateFromStatus). A row whose
    // CURRENT status doesn't match (e.g. ACTIVE_INVENTORY when target is
    // REJECTED) still falls through to the ordinary InvalidTransitionError
    // skip in the catch block below, unaffected by this gate.
    const rowIsRejectEdge = device.status === 'RECEIVED' && targetStatus === 'REJECTED'
    const rowIsUnrejectEdge = device.status === 'REJECTED' && targetStatus === 'RECEIVED'
    const metadata: Record<string, unknown> = { bulk: true }
    if (batchReasonCode) metadata.reason_code = batchReasonCode

    try {
      const { device: updated, event } = await transitionDevice(c.env.DB, device.id, targetStatus, {
        user,
        eventType: rowIsRejectEdge ? 'REJECT' : rowIsUnrejectEdge ? 'UNREJECT' : 'STATUS_CHANGE',
        metadata,
      })
      results.push({ imei, ok: true, outcome: 'transitioned', device_id: device.id, from_status: device.status })
      notifyPromises.push(dispatchDeviceStatusWebhooks(c.env.DB, {
        event: 'device.status_changed',
        organisation_id: user.organisation_id,
        device_id: device.id,
        imei: String((updated as any).imei),
        uuid: String((updated as any).uuid),
        from_status: (event as any).from_status ?? null,
        to_status: targetStatus,
        user_id: user.id,
        occurred_at: new Date().toISOString(),
      }))
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        results.push({ imei, ok: false, outcome: 'skipped', device_id: device.id, from_status: device.status, message: err.message })
      } else if (err instanceof DeviceNotFoundError) {
        results.push({ imei, ok: false, outcome: 'error', message: err.message })
      } else if (err instanceof TransitionGateError) {
        // Backstop only (see transitionDevice()'s own comment) — the
        // route-level gate above should already have returned before this
        // row is ever reached. Reported as a per-row error, not a whole-
        // call failure, so one row's gate re-check can never silently
        // swallow the rest of an otherwise-valid batch.
        results.push({ imei, ok: false, outcome: 'error', device_id: device.id, from_status: device.status, message: err.message })
      } else {
        results.push({ imei, ok: false, outcome: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  let execCtx: { waitUntil?: (p: Promise<unknown>) => void } | undefined
  try { execCtx = c.executionCtx as any } catch { execCtx = undefined }
  const allNotify = Promise.all(notifyPromises)
  if (typeof execCtx?.waitUntil === 'function') execCtx.waitUntil(allNotify)
  else await allNotify

  const transitioned = results.filter(r => r.ok).length
  return c.json({
    ok: true,
    target_status: targetStatus,
    requested: results.length,
    transitioned,
    failed: results.length - transitioned,
    results,
  })
})

// POST /api/devices/:id/transition — the single API entry point for status
// changes. Body: { to_status, reference?, metadata? }
app.post('/:id/transition', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const body = await c.req.json<{ to_status?: string; reference?: string; metadata?: Record<string, unknown>; reason_code?: string }>().catch(() => ({} as any))
  const toStatus = String(body.to_status || '').toUpperCase() as DeviceStatus
  if (!DEVICE_STATUSES.includes(toStatus)) {
    return c.json({ error: `to_status must be one of: ${DEVICE_STATUSES.join(', ')}` }, 400)
  }

  // Consignment-derived statuses may only be driven by the OPR workflow
  // endpoints — moving a device in/out of them here would desynchronise
  // shipment_lines from the device ledger.
  if (OPR_WORKFLOW_ONLY_STATUSES.includes(toStatus)) {
    return c.json({ error: `${toStatus} is managed by the OPR consignment workflow — use /api/opr/shipments/:id/lines (add/remove) and /finalise instead of a direct transition` }, 409)
  }
  // Repair-job-derived statuses (Device Lifecycle slice 1) may only be
  // driven by the repair-workflow endpoints below — moving a device
  // in/out of them here would desynchronise repair_jobs from the device
  // ledger. Same pattern/reasoning as the OPR guard above.
  if (REPAIR_WORKFLOW_ONLY_STATUSES.includes(toStatus)) {
    return c.json({ error: `${toStatus} is managed by the repair workflow — use /api/devices/:id/repair/* instead of a direct transition` }, 409)
  }

  // Fetched once, reused both for the OPR/repair workflow guard below and
  // for the reject/un-reject gating (need the device's CURRENT status to
  // tell RECEIVED->REJECTED apart from every other ...->RECEIVED edge).
  const device0 = await c.env.DB.prepare(
    'SELECT status FROM received_devices WHERE id = ? AND organisation_id = ?'
  ).bind(id, user.organisation_id).first<{ status: DeviceStatus }>()
  if (device0 && OPR_WORKFLOW_ONLY_STATUSES.includes(device0.status)) {
    return c.json({ error: `Device is ${device0.status}, which is managed by the OPR consignment workflow — it cannot be transitioned via this endpoint` }, 409)
  }
  if (device0 && REPAIR_WORKFLOW_ONLY_STATUSES.includes(device0.status)) {
    return c.json({ error: `Device is ${device0.status}, which is managed by the repair workflow — it cannot be transitioned via this endpoint` }, 409)
  }

  // ── Reject / un-reject gating (2026-09-01 live-incident fix; extracted
  // into checkRejectUnrejectGate() 2026-09-07 so bulk-transition below —
  // and transitionDevice() itself, as a defence-in-depth backstop — run
  // the exact same check instead of a hand-copied second implementation
  // drifting from this one) ──
  // Scoped to EXACTLY these two edges, not the whole route: every other
  // transition here is untested against a non-admin caller today, so a
  // blanket manager-gate would ship an unreviewed access restriction
  // alongside an unrelated incident fix. A required reason code alone is
  // not access control, so both edges are manager-gated AND require one
  // of the enumerated reason codes — an unrecognised code is rejected
  // (422), not silently stored.
  const gate = device0 ? checkRejectUnrejectGate(device0.status, toStatus, user, body.reason_code) : { applicable: false as const }
  if (gate.applicable && !gate.ok) {
    return c.json(
      gate.status === 422 ? { error: gate.error, valid_reason_codes: gate.valid_reason_codes } : { error: gate.error },
      gate.status,
    )
  }
  const isRejectEdge = gate.applicable && gate.ok && gate.edgeKind === 'reject'
  const isUnrejectEdge = gate.applicable && gate.ok && gate.edgeKind === 'unreject'
  if (gate.applicable && gate.ok) {
    body.metadata = { ...(body.metadata ?? {}), reason_code: gate.reasonCode }
  }

  try {
    const { device, event } = await transitionDevice(c.env.DB, id, toStatus, {
      user,
      reference: body.reference ?? null,
      metadata: body.metadata ?? null,
      eventType: isRejectEdge ? 'REJECT' : isUnrejectEdge ? 'UNREJECT' : 'STATUS_CHANGE',
    })

    // Fire-and-forget webhook. Not awaited-blocking the response would be
    // ideal, but Workers require awaiting async work before the response
    // finishes unless we use waitUntil — do that where available.
    const notify = dispatchDeviceStatusWebhooks(c.env.DB, {
      event: 'device.status_changed',
      organisation_id: user.organisation_id,
      device_id: id,
      imei: String((device as any).imei),
      uuid: String((device as any).uuid),
      from_status: (event as any).from_status ?? null,
      to_status: toStatus,
      user_id: user.id,
      occurred_at: new Date().toISOString(),
    })
    // NOTE: c.executionCtx is a THROWING getter in Hono when no
    // ExecutionContext exists (e.g. app.request() in tests) — it cannot be
    // probed with optional chaining alone.
    let execCtx: { waitUntil?: (p: Promise<unknown>) => void } | undefined
    try { execCtx = c.executionCtx as any } catch { execCtx = undefined }
    if (typeof execCtx?.waitUntil === 'function') {
      execCtx.waitUntil(notify)
    } else {
      await notify
    }

    return c.json({ ok: true, device, event })
  } catch (err) {
    if (err instanceof InvalidTransitionError) return c.json({ error: err.message, code: err.code }, 409)
    if (err instanceof DeviceNotFoundError) return c.json({ error: err.message, code: err.code }, 404)
    // Backstop only — the route-level gate check above should already
    // have returned before transitionDevice() is ever called on this
    // route. Kept so a future edit here fails the same way bulk-transition
    // did rather than an unhandled 500 (see TransitionGateError's comment).
    if (err instanceof TransitionGateError) {
      return c.json(
        err.status === 422 ? { error: err.message, valid_reason_codes: err.validReasonCodes } : { error: err.message },
        err.status,
      )
    }
    throw err
  }
})

// ───────── Device Lifecycle slice 1 — in-house repair workflow (Workstream C) ─────────
// See docs/plan/device-lifecycle-slice1.md and src/lib/repairWorkflow.ts.
// QC recording (repair/qc) is manager-only per the agreed placeholder —
// NOT hard-coded against a future separate QC role, just checked against
// the current 'manager'/'admin' roles (test #29 asserts operator -> 403,
// manager -> 200).
function requireManager(c: any): boolean {
  const role = (c.var.user as AuthUser).role
  return role === 'manager' || role === 'admin'
}

app.post('/:id/repair/start', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  const body = await c.req.json<{ fault_code?: string }>().catch(() => ({} as any))
  try {
    const result = await startRepair(c.env.DB, id, body.fault_code, user)
    return c.json(result, 201)
  } catch (err) {
    if (err instanceof RepairJobError) return c.json({ error: err.message }, err.status)
    throw err
  }
})

app.post('/:id/repair/scan-back', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  try {
    const result = await scanBackRepair(c.env.DB, id, user)
    return c.json(result, 200)
  } catch (err) {
    if (err instanceof RepairJobError) return c.json({ error: err.message }, err.status)
    throw err
  }
})

app.post('/:id/repair/qc', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  if (!requireManager(c)) return c.json({ error: 'QC recording is manager-only' }, 403)
  const body = await c.req.json<{ result?: string; reason?: string }>().catch(() => ({} as any))
  try {
    const result = await recordQc(c.env.DB, id, body.result, body.reason, user)
    return c.json(result, 200)
  } catch (err) {
    if (err instanceof RepairJobError) return c.json({ error: err.message }, err.status)
    throw err
  }
})

// MANAGER-ONLY as of commit 3 (2026-09-02). Previously open to any role —
// the only repair-workflow route with that shape apart from /repair/start
// and /repair/scan-back (both deliberately operator-accessible, everyday
// work; see this route's own history for why THIS edge is different).
// reopenRepair() puts a QC_FAILED device straight back into IN_HOUSE_REPAIR
// with no fresh inspection required to make that call — QC recording
// itself (/repair/qc) is already manager-only for the same reason (test
// #29's placeholder note), so leaving the re-open decision open to any
// role let an operator silently reverse a manager's QC_FAILED verdict.
// Not a new restriction on judgement calls in general: /repair/start and
// /repair/scan-back stay exactly as open as they always were — this gate
// is scoped to this one edge, same scoping discipline as the reject/
// un-reject gate in the generic /transition route above.
app.post('/:id/repair/reopen', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  if (!requireManager(c)) return c.json({ error: 'Re-opening a QC-failed repair is manager-only' }, 403)
  try {
    const result = await reopenRepair(c.env.DB, id, user)
    return c.json(result, 200)
  } catch (err) {
    if (err instanceof RepairJobError) return c.json({ error: err.message }, err.status)
    throw err
  }
})

// POST /api/devices/:id/repair/close-to-inventory — {}
// READY_FOR_ZOHO -> ACTIVE_INVENTORY. Manager-only, same authorisation
// level as /:id/repair/qc (this is the action that completes the job QC
// started). See closeToInventory()'s header comment in
// src/lib/repairWorkflow.ts for the ordering rationale and idempotency
// contract.
//
// EDGE-VERSUS-ROUTE NOTE: READY_FOR_ZOHO is a REPAIR_WORKFLOW_ONLY_STATUS
// (see deviceLifecycle.ts), so even though ALLOWED_TRANSITIONS now lists
// READY_FOR_ZOHO -> ACTIVE_INVENTORY (needed for transitionDevice()'s own
// validation to accept the edge when called from here), the GENERIC
// /:id/transition route above still refuses it outright (409) regardless
// — see that route's REPAIR_WORKFLOW_ONLY_STATUSES guard. This route is
// the ONLY way to drive this edge. Consequently GET /meta/statuses'
// `transitions` map (scoped to what the generic route can execute) must
// NOT be extended with this edge — doing so would advertise a move the
// generic route will 409 on. The UI's role-gating for the corresponding
// button therefore cannot reuse that server-filtered-map pattern; it
// uses the same client-side isManagerOrAdmin() check RepairQueueSubview()
// already uses for its sibling repair-dedicated-route actions (QC pass/
// fail, cost recording) — see public/static/app.js's ReadyForZohoSubview().
app.post('/:id/repair/close-to-inventory', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  if (!requireManager(c)) return c.json({ error: 'Closing a device to inventory is manager-only' }, 403)
  try {
    const result = await closeToInventory(c.env.DB, id, user)
    return c.json(result, 200)
  } catch (err) {
    if (err instanceof RepairJobError) return c.json({ error: err.message }, err.status)
    throw err
  }
})

// CONTRAST WITH /:id/repair/cost-ledger BELOW: this route UPDATEs
// repair_jobs' own mutable cost columns — recordRepairCost() is a
// compatibility shim pending a future device_costs table (see
// docs/plan/device-lifecycle-slice1.md), NOT the durable cost record.
// The route below appends an immutable row to cost_ledger instead.
app.post('/:id/repair/cost', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  if (!requireManager(c)) return c.json({ error: 'Repair cost entry is manager-only' }, 403)
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as any))
  try {
    const result = await recordRepairCost(c.env.DB, id, body, user)
    return c.json(result, 200)
  } catch (err) {
    if (err instanceof RepairJobError) return c.json({ error: err.message }, err.status)
    throw err
  }
})

// POST /api/devices/:id/repair/cost-ledger — { amount_gbp, source_bill_line_id? }
// CONTRAST WITH /:id/repair/cost ABOVE: that route UPDATEs repair_jobs'
// mutable cost columns (a compatibility shim pending device_costs); THIS
// route only ever INSERTs a new, immutable row into cost_ledger — the
// durable path. Same near-identical name, opposite mutability semantics —
// do not confuse the two (the exact collision risk repairWorkflow.ts's
// header already warns about for OPR vs. in-house repair cost).
// Manager-only, matching recordRepairCost() above (a ledger write is at
// least as privileged as the repair_jobs cost-column write). Writes an
// append-only cost_ledger row — see postRepairCostToLedger()'s header
// comment in src/lib/repairWorkflow.ts for the full nullability/
// provenance/append-only contract.
//
// NO TRAILING SLASH: called as POST /api/devices/:id/repair/cost-ledger,
// never with a trailing slash. Every sub-router mounted via app.route()
// in this codebase 404s on its own root when called WITH a trailing
// slash under Hono's default strict matching (root-caused 2026-08-21,
// public/tracker/index.html backlog) — this route inherits that same
// behaviour since it lives on this mounted sub-router.
app.post('/:id/repair/cost-ledger', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  if (!requireManager(c)) return c.json({ error: 'Cost-ledger entry is manager-only' }, 403)
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as any))
  try {
    const result = await postRepairCostToLedger(c.env.DB, id, body, user)
    return c.json(result, 201)
  } catch (err) {
    if (err instanceof RepairJobError) return c.json({ error: err.message }, err.status)
    throw err
  }
})

// POST /api/devices/:id/purchase/cost-ledger —
// { amount_gbp, note?, allow_duplicate_purchase_row? }
// SIBLING OF /:id/repair/cost-ledger ABOVE: same append-only,
// immutable-row, manager-only pattern, but for the ACQUISITION
// ('purchase') cost rather than the repair cost, and via a writer
// (postPurchaseCostToLedger(), src/lib/costEntry.ts) that has NO
// bill-derived counterpart's nullable fields — source_bill_line_id is
// always NULL and provenance is always DEFAULT_UNVERIFIED_PROVENANCE
// here, since this writer exists specifically for devices with no bill
// to attribute a cost to (see src/routes/bills.ts's write-cost-ledger
// for the bill-derived 'purchase' writer this route does NOT replace —
// both writers coexist; a device costed via a later-closed bill still
// goes through that path, not this one).
//
// Manager-only, same authorisation level as /:id/repair/cost-ledger.
// Writes an append-only cost_ledger row — see
// postPurchaseCostToLedger()'s header comment in src/lib/costEntry.ts
// for the full duplicate-guard/provenance-limitation contract.
//
// NO TRAILING SLASH: called as POST /api/devices/:id/purchase/cost-ledger,
// never with a trailing slash — same sub-router trailing-slash 404
// behaviour as every other route in this file (root-caused 2026-08-21,
// public/tracker/index.html backlog).
app.post('/:id/purchase/cost-ledger', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  if (!requireManager(c)) return c.json({ error: 'Cost-ledger entry is manager-only' }, 403)
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as any))
  try {
    const result = await postPurchaseCostToLedger(c.env.DB, id, body, user)
    return c.json(result, 201)
  } catch (err) {
    if (err instanceof CostEntryError) return c.json({ error: err.message }, err.status)
    throw err
  }
})

export default app
