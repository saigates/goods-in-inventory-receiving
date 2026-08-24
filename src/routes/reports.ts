import { Hono } from 'hono'
import type { Bindings, AuthUser, DeviceStatus, CostLedgerProvenance } from '../types'
import { DEVICE_STATUSES } from '../types'
import { currentUser } from '../lib/auth'
import { SUPPLIER_INVOICED, DEFAULT_UNVERIFIED_PROVENANCE } from '../lib/billBuilder'

const app = new Hono<{ Bindings: Bindings; Variables: { user: AuthUser } }>()

// Same manager-gate convention as src/routes/devices.ts:453-456
// (requireManager) — duplicated rather than imported because devices.ts
// does not export it; if this pattern is needed a third time, it should
// move to a shared lib module instead of being copied again.
function requireManager(c: any): boolean {
  const role = (c.var.user as AuthUser).role
  return role === 'manager' || role === 'admin'
}

// ───────── VAT bucket mapping — DECISION, documented not assumed ─────────
//
// The spec asked for "a VAT bucket with standard and reverse charge
// combined into one and marginal separate". This codebase's actual
// vat_type vocabulary (src/types.ts:113, src/lib/validate.ts:117) is
// ['MARGIN', 'STANDARD', 'ZERO', 'PVAT'] — there is NO 'REVERSE_CHARGE'
// value anywhere in the live schema or the TypeScript union. Checked,
// not assumed: 'REVERSE_CHARGE' and 'POSTPONED' both appear ONLY as
// REJECTED junk values in test/manifestValuation.spec.ts (lines 138,
// 263) — i.e. this system has already decided 'REVERSE_CHARGE' is not a
// real vat_type, and PVAT (Postponed VAT / import accounting per
// src/lib/validate.ts:115) is the closest thing this system has to a
// deferred/reverse-charge-style VAT treatment.
//
// DECISION (this endpoint only, documented in the response's own
// `basis` field so nobody has to remember this comment): PVAT is
// combined into the "standard_and_reverse_charge" bucket alongside
// STANDARD, since both are import/domestic non-margin VAT treatments
// where VAT is accounted for outside the margin scheme. MARGIN stays
// its own bucket per the spec. ZERO is not named by the spec at all;
// rather than silently folding it into either named bucket (which would
// misrepresent it either way), it gets its own third bucket so no
// device's value goes unaccounted-for or hidden inside a mislabelled
// bucket. NULL vat_type (not yet set) also gets its own bucket for the
// same reason. This mapping is a judgement call, not a spec-mandated
// fact — flagged here and in the response body for review.
const VAT_BUCKETS = ['margin', 'standard_and_reverse_charge', 'zero', 'unset'] as const
type VatBucket = typeof VAT_BUCKETS[number]

function vatBucketFor(vatType: string | null): VatBucket {
  if (vatType === 'MARGIN') return 'margin'
  if (vatType === 'STANDARD' || vatType === 'PVAT') return 'standard_and_reverse_charge'
  if (vatType === 'ZERO') return 'zero'
  return 'unset'
}

type MoneyCount = { count: number; value_gbp: number }

type InventoryValuationResponse = {
  generated_at: string
  headline: {
    purchase_only: MoneyCount
    purchase_plus_repair: MoneyCount
    repair_delta_gbp: number
  }
  costed_vs_uncosted: {
    costed: number
    uncosted: number
    total_devices: number
    // The figure to surface most prominently per spec — repeated here at
    // the top level too so a caller reading only `headline` can't miss it.
    note: string
  }
  by_stage: Array<{ status: DeviceStatus; count: number; purchase_value_gbp: number; purchase_plus_repair_value_gbp: number }>
  by_provenance: Array<{ provenance: CostLedgerProvenance | 'none'; count: number; value_gbp: number }>
  by_vat_bucket: Array<{ bucket: VatBucket; count: number; value_gbp: number }>
  data_quality: {
    devices_with_multiple_purchase_rows: number
    // Decision, documented per spec: multiple 'purchase' rows on one
    // device are SUMMED into the headline totals (not deduped or
    // rejected), but the count of such devices is surfaced separately
    // here as an anomaly signal, since >1 acquisition row per device
    // most likely indicates a data-entry error, not a legitimate
        // multi-invoice purchase.
    basis: string
  }
  exclusions: string[]
  vat_bucket_basis: string
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100
}

// GET /api/reports/inventory-valuation — read-only, manager-gated.
//
// NO TRAILING SLASH: called as GET /api/reports/inventory-valuation,
// never with a trailing slash. Every sub-router mounted via app.route()
// in this codebase 404s on its own root when called WITH a trailing
// slash under Hono's default strict matching (root-caused 2026-08-21,
// public/tracker/index.html backlog) — this route inherits that same
// behaviour since it lives on this mounted sub-router.
//
// Pre-work findings this route relies on (confirmed from LIVE schema,
// 2026-08-24, not migration text):
//   - cost_ledger.cost_type is TEXT with no CHECK constraint; the
//     TypeScript union (src/types.ts:439) is 'purchase' | 'repair' |
//     'freight'. Acquisition rows are cost_type = 'purchase'.
//   - cost_ledger.amount_gbp is REAL, already in POUNDS (not pence).
//   - received_devices.status is the lifecycle field, CHECK-constrained
//     to the 14 values in DEVICE_STATUSES (src/types.ts:84-109), which
//     this route iterates over completely (zero-count stages included).
//   - No VAT field exists on bills/bill_lines/suppliers (confirmed via
//     full live schema dump) — but received_devices.vat_type DOES exist
//     (MARGIN/STANDARD/ZERO/PVAT). This is a per-device field, which is
//     actually the more natural home for this report than the bill
//     tables the spec guessed at.
app.get('/inventory-valuation', async (c) => {
  if (!requireManager(c)) return c.json({ error: 'Inventory valuation reporting is manager-only' }, 403)
  const user = currentUser(c)
  const db = c.env.DB

  // One pass over every device in the org, LEFT JOINed to its
  // cost_ledger rows, aggregated in SQL by device so "no ledger row"
  // devices still appear (COUNT/SUM over a LEFT JOIN with no matching
  // rows yields 0/NULL, not an absent row) — this is what makes the
  // uncosted count and zero-value stage totals correct without a
  // separate query.
  const { results: deviceRows } = await db.prepare(
    `SELECT
        rd.id AS device_id,
        rd.status AS status,
        rd.vat_type AS vat_type,
        COALESCE(SUM(CASE WHEN cl.cost_type = 'purchase' THEN cl.amount_gbp ELSE 0 END), 0) AS purchase_gbp,
        COALESCE(SUM(CASE WHEN cl.cost_type IN ('purchase','repair') THEN cl.amount_gbp ELSE 0 END), 0) AS purchase_plus_repair_gbp,
        SUM(CASE WHEN cl.cost_type = 'purchase' THEN 1 ELSE 0 END) AS purchase_row_count,
        SUM(CASE WHEN cl.id IS NOT NULL THEN 1 ELSE 0 END) AS any_ledger_row_count
     FROM received_devices rd
     LEFT JOIN cost_ledger cl ON cl.received_device_id = rd.id AND cl.organisation_id = rd.organisation_id
     WHERE rd.organisation_id = ?
     GROUP BY rd.id, rd.status, rd.vat_type`
  ).bind(user.organisation_id).all<{
    device_id: number
    status: DeviceStatus
    vat_type: string | null
    purchase_gbp: number
    purchase_plus_repair_gbp: number
    purchase_row_count: number
    any_ledger_row_count: number
  }>()

  // Provenance breakdown needs its own query: it's a per-ROW (not
  // per-device) property of cost_ledger, and a device could in
  // principle carry rows of more than one provenance. Scoped to
  // cost_type = 'purchase' only, matching the headline totals' basis
  // (repair-row provenance is a different question, out of scope here).
  const { results: provenanceRows } = await db.prepare(
    `SELECT cl.provenance AS provenance,
            COUNT(*) AS row_count,
            COALESCE(SUM(cl.amount_gbp), 0) AS value_gbp
       FROM cost_ledger cl
       JOIN received_devices rd ON rd.id = cl.received_device_id
      WHERE rd.organisation_id = ? AND cl.cost_type = 'purchase'
      GROUP BY cl.provenance`
  ).bind(user.organisation_id).all<{ provenance: CostLedgerProvenance; row_count: number; value_gbp: number }>()

  // ── Headline ──
  let purchaseCount = 0
  let purchaseValue = 0
  let purchasePlusRepairCount = 0
  let purchasePlusRepairValue = 0
  let costedCount = 0
  let uncostedCount = 0
  let multiPurchaseRowDeviceCount = 0

  // ── by_stage accumulator, pre-seeded with every DEVICE_STATUSES value
  // at zero so stages with no devices still appear (spec requirement:
  // "a stage with zero devices should appear with zeros rather than
  // being omitted, so the breakdown is stable across runs"). ──
  const stageAgg = new Map<DeviceStatus, { count: number; purchase: number; purchasePlusRepair: number }>()
  for (const s of DEVICE_STATUSES) stageAgg.set(s, { count: 0, purchase: 0, purchasePlusRepair: 0 })

  // ── by_vat_bucket accumulator, pre-seeded with all four buckets. ──
  const vatAgg = new Map<VatBucket, { count: number; value: number }>()
  for (const b of VAT_BUCKETS) vatAgg.set(b, { count: 0, value: 0 })

  for (const row of deviceRows) {
    const purchaseGbp = round2(row.purchase_gbp)
    const purchasePlusRepairGbp = round2(row.purchase_plus_repair_gbp)

    // Headline totals: EVERY device contributes its count, even at zero
    // value (spec: "devices with no ledger row contribute zero to value
    // but must still appear in the stage and uncosted counts").
    purchaseCount++
    purchaseValue += purchaseGbp
    purchasePlusRepairCount++
    purchasePlusRepairValue += purchasePlusRepairGbp

    if (row.purchase_row_count > 0) {
      costedCount++
    } else {
      uncostedCount++
    }
    if (row.purchase_row_count > 1) multiPurchaseRowDeviceCount++

    const stage = stageAgg.get(row.status)
    if (stage) {
      stage.count++
      stage.purchase += purchaseGbp
      stage.purchasePlusRepair += purchasePlusRepairGbp
    }
    // A status outside the known 14-value CHECK constraint would land
    // here (stage undefined) — cannot happen given the live CHECK, but
    // if it ever did this device would simply not appear in by_stage
    // while still counting in the headline/uncosted totals above,
    // rather than throwing. Not expected to be reachable; not silently
    // dropping the device from the totals that matter most either way.

    const bucket = vatBucketFor(row.vat_type)
    const vatEntry = vatAgg.get(bucket)!
    vatEntry.count++
    vatEntry.value += purchaseGbp
  }

  purchaseValue = round2(purchaseValue)
  purchasePlusRepairValue = round2(purchasePlusRepairValue)

  const byProvenance: InventoryValuationResponse['by_provenance'] = provenanceRows.map(r => ({
    provenance: r.provenance,
    count: r.row_count,
    value_gbp: round2(r.value_gbp),
  }))
  // Ensure both named buckets from the spec always appear even with 0
  // rows, for the same run-to-run stability reason as by_stage.
  for (const p of [SUPPLIER_INVOICED, DEFAULT_UNVERIFIED_PROVENANCE] as CostLedgerProvenance[]) {
    if (!byProvenance.some(r => r.provenance === p)) {
      byProvenance.push({ provenance: p, count: 0, value_gbp: 0 })
    }
  }

  const response: InventoryValuationResponse = {
    generated_at: new Date().toISOString(),
    headline: {
      purchase_only: { count: purchaseCount, value_gbp: purchaseValue },
      purchase_plus_repair: { count: purchasePlusRepairCount, value_gbp: purchasePlusRepairValue },
      repair_delta_gbp: round2(purchasePlusRepairValue - purchaseValue),
    },
    costed_vs_uncosted: {
      costed: costedCount,
      uncosted: uncostedCount,
      total_devices: deviceRows.length,
      note: 'This is the figure that determines whether the totals above mean anything yet — an uncosted device contributes zero to every value total.',
    },
    by_stage: DEVICE_STATUSES.map(status => {
      const s = stageAgg.get(status)!
      return {
        status,
        count: s.count,
        purchase_value_gbp: round2(s.purchase),
        purchase_plus_repair_value_gbp: round2(s.purchasePlusRepair),
      }
    }),
    by_provenance: byProvenance,
    by_vat_bucket: VAT_BUCKETS.map(bucket => {
      const v = vatAgg.get(bucket)!
      return { bucket, count: v.count, value_gbp: round2(v.value) }
    }),
    data_quality: {
      devices_with_multiple_purchase_rows: multiPurchaseRowDeviceCount,
      basis: "Multiple cost_type='purchase' rows on one device are summed into the headline/stage totals above, not deduped or rejected — but this count exists because more than one acquisition row per device likely indicates a data-entry error, not a legitimate multi-invoice purchase, and should be reviewed if non-zero.",
    },
    exclusions: [
      'freight (cost_ledger cost_type = \'freight\', apportioned separately per src/lib/freightApportionment.ts)',
      'duty / customs charges',
      'VAT (the vat_type breakdown below is informational only — it does not adjust any value total)',
      'write-downs / impairment adjustments',
    ],
    vat_bucket_basis: "STANDARD and PVAT (Postponed VAT / import accounting — the closest existing analog to a reverse-charge treatment in this system's vat_type vocabulary, which has no literal 'REVERSE_CHARGE' value) are combined into 'standard_and_reverse_charge'. MARGIN is its own bucket per spec. ZERO and unset vat_type each get their own bucket rather than being folded into a named one. This mapping is a documented decision, not a spec-mandated fact.",
  }

  return c.json(response)
})

export default app
