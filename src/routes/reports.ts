import { Hono } from 'hono'
import type { Bindings, AuthUser, DeviceStatus, CostLedgerProvenance, VatType } from '../types'
import { DEVICE_STATUSES, VAT_TYPES } from '../types'
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

// ───────── Valuation status inclusion — DECISION, documented not derived ─────────
//
// Which of the 14 DEVICE_STATUSES count as "owned stock" for the headline
// valuation totals. Written as an explicit list, NOT as "DEVICE_STATUSES
// minus an exclusion list" — the deliberate reason is that a 15th status
// added to the lifecycle in future must force whoever adds it to look at
// this file and decide where it goes, rather than silently joining (or
// silently leaving) the valuation total just because it wasn't named in
// an exclusion array. The operator's own criterion: is this still the
// operator's owned stock, capable of being sold from inventory? Goods
// out under OPR or temporary standard export remain the operator's
// stock throughout — that's the whole basis of "temporary" export — so
// they stay included even though they're physically abroad.
export const VALUATION_INCLUDED_STATUSES: readonly DeviceStatus[] = [
  'RECEIVED',
  'SORTING',
  'ACTIVE_INVENTORY',
  'IN_HOUSE_REPAIR',
  'READY_FOR_EXPORT',
  'IN_EXPORT_CONSIGNMENT',
  'EXPORTED_UNDER_OPR',
  'RETURNED_UNDER_OPR',
  'QC_FAILED',
  'READY_FOR_ZOHO',
  'TEMP_EXPORTED_STANDARD',
  'RETURNED_UNDER_STANDARD',
]

// REJECTED is still owned stock (it can be corrected back to RECEIVED
// through the state machine — see REJECTED -> RECEIVED in
// ALLOWED_TRANSITIONS, src/lib/deviceLifecycle.ts), so it is NOT a
// valuation exclusion. It is reported on its OWN separate line instead
// of folded into the main included-statuses total, so a manager can see
// "how much value is currently sitting in rejected stock" as its own
// figure rather than it disappearing into the same number as active
// inventory.
//
// SOLD is the sole true exclusion: once sold, the device is no longer
// the operator's stock. SOLD is currently unreachable — no
// ALLOWED_TRANSITIONS entry produces it and no code path writes it
// (confirmed via grep across deviceLifecycle.ts, every route, and every
// test) — so this exclusion is inert today, but is written explicitly
// now as a hard prerequisite for the future sales-import work, not
// discovered retroactively once SOLD becomes reachable.
//
// Reconciliation invariant this endpoint enforces at runtime, not just
// in a comment: VALUATION_INCLUDED_STATUSES + REJECTED + SOLD must
// equal the full 14-value DEVICE_STATUSES set, with no status counted
// twice and none omitted. Checked once at module load (not per-request)
// so a future edit to either list that breaks the partition fails
// loudly at import time (surfaces in tsc/test runs) rather than
// silently producing a valuation total that quietly excludes or
// double-counts a status.
const VALUATION_EXCLUDED_AS_OWN_LINE: readonly DeviceStatus[] = ['REJECTED']
const VALUATION_EXCLUDED_TOTALLY: readonly DeviceStatus[] = ['SOLD']
;(() => {
  const partition = [...VALUATION_INCLUDED_STATUSES, ...VALUATION_EXCLUDED_AS_OWN_LINE, ...VALUATION_EXCLUDED_TOTALLY]
  const partitionSet = new Set(partition)
  if (partition.length !== partitionSet.size) {
    throw new Error('reports.ts: a DeviceStatus appears more than once across VALUATION_INCLUDED_STATUSES/REJECTED/SOLD')
  }
  const deviceStatusSet = new Set<string>(DEVICE_STATUSES)
  for (const s of partition) {
    if (!deviceStatusSet.has(s)) {
      throw new Error(`reports.ts: '${s}' in the valuation partition is not a DeviceStatus`)
    }
  }
  if (partitionSet.size !== DEVICE_STATUSES.length) {
    const missing = DEVICE_STATUSES.filter(s => !partitionSet.has(s))
    throw new Error(`reports.ts: DEVICE_STATUSES value(s) [${missing.join(', ')}] are in none of VALUATION_INCLUDED_STATUSES/REJECTED/SOLD — a status was added to the lifecycle without a valuation-inclusion decision being made for it`)
  }
})()

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
// real vat_type it stores.
//
// NAMING CORRECTION (reviewer feedback): the bucket below is NOT named
// 'standard_and_reverse_charge' — that name would assert this schema can
// hold a value it cannot, which is exactly the kind of thing that sends
// a future reader hunting for a value that was never there. It is named
// 'standard_and_net_recoverable' instead, and the response's own
// `vat_bucket_basis` field says explicitly "no REVERSE_CHARGE value
// exists in this schema" — recorded as an absence, not a mapping.
//
// DECISION (this endpoint only, for the GROUPED/human-reading view
// only): STANDARD and PVAT are combined into one bucket for readability.
// MARGIN stays its own bucket per spec. ZERO and unset vat_type each get
// their own bucket rather than being folded into a named one, so no
// device's value goes unaccounted-for or hidden inside a mislabelled
// bucket. This grouping is a judgement call for human readability, not a
// spec-mandated fact, and NOT a VAT calculation of any kind — the app
// only groups a stored field, it never computes VAT liability, input-tax
// recoverability, or reverse-charge applicability. That determination is
// out of scope for this endpoint and belongs with the org's accountant.
//
// For any consumer that is NOT a human reading a report (e.g. an
// external accounting-system integration), see `by_vat_type_raw` below —
// the ungrouped, per-stored-value figures for all four VAT_TYPES values,
// with no grouping/editorialising applied. Grouping a stored field is
// not the same operation as calculating VAT; this endpoint does only the
// former, on both counts.
const VAT_BUCKETS = ['margin', 'standard_and_net_recoverable', 'zero', 'unset'] as const
type VatBucket = typeof VAT_BUCKETS[number]

function vatBucketFor(vatType: string | null): VatBucket {
  if (vatType === 'MARGIN') return 'margin'
  if (vatType === 'STANDARD' || vatType === 'PVAT') return 'standard_and_net_recoverable'
  if (vatType === 'ZERO') return 'zero'
  return 'unset'
}

type MoneyCount = { count: number; value_gbp: number }

type InventoryValuationResponse = {
  generated_at: string
  headline: {
    // purchase_only / purchase_plus_repair now cover ONLY devices whose
    // status is in VALUATION_INCLUDED_STATUSES (see that constant's own
    // comment for the full decision) — this is a behaviour change from
    // this endpoint's first version, which summed every device
    // regardless of status. REJECTED and SOLD devices are deliberately
    // NOT part of these two totals; see the `rejected` / `sold` fields
    // below for where their value goes instead.
    purchase_only: MoneyCount
    purchase_plus_repair: MoneyCount
    repair_delta_gbp: number
    // REJECTED devices are still the operator's owned stock (they can
    // be corrected back to RECEIVED through the state machine), so
    // their value is not simply dropped — it is reported on this own
    // separate line instead of being folded into purchase_only/
    // purchase_plus_repair above, so a manager can see "how much value
    // is sitting in rejected stock" as its own figure. Basis:
    // purchase_plus_repair (the fuller cost figure), matching the same
    // methodology as the main total.
    rejected: MoneyCount
    // SOLD is the sole true valuation exclusion (see
    // VALUATION_INCLUDED_STATUSES's comment) — once sold, a device is
    // no longer the operator's stock. SOLD is currently unreachable (no
    // ALLOWED_TRANSITIONS entry produces it, no code path writes it),
    // so this is expected to be {count: 0, value_gbp: 0} today. It
    // exists now, ahead of that becoming reachable, so the future sales
    // import has a place to reconcile against rather than this field
    // being added retroactively once SOLD devices start appearing.
    sold: MoneyCount
  }
  // The arithmetic invariant named in the valuation-inclusion decision,
  // made a first-class checkable field rather than left as something a
  // human has to eyeball across three different numbers: every device
  // counts exactly once across included/rejected/sold, so their sum
  // must equal the total device count. `balanced` is computed from the
  // actual counts above, not asserted — if it is ever false, either the
  // VALUATION_INCLUDED_STATUSES/REJECTED/SOLD partition has a gap that
  // slipped past the module-load check, or (more likely, if this ever
  // happens) a device row's status fell outside the live CHECK
  // constraint's 14 values entirely.
  reconciliation: {
    included_count: number
    rejected_count: number
    sold_count: number
    total_devices: number
    balanced: boolean
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
  // Ungrouped, per-stored-value figures for all four VAT_TYPES values
  // (MARGIN/STANDARD/ZERO/PVAT) plus a null/unset row, with NO grouping
  // applied — this is the field an external integration should read,
  // per reviewer instruction that a data feed should not editorialise by
  // bucketing. by_vat_bucket above remains for human reading only.
  by_vat_type_raw: Array<{ vat_type: VatType | 'unset'; count: number; value_gbp: number }>
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
  // Contract statement for any consumer of this response, human or
  // machine (reviewer instruction: once this crosses an API boundary
  // into another system, the receiving side has no way to know what's
  // in it unless this response says so on its own face). Deliberately
  // makes no claim about statutory/accounting standards — that
  // determination belongs to the org's accountant, not this endpoint.
  basis: string
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
//
// SCOPE, confirmed with reviewer: this endpoint captures and reports a
// stored field; it never determines or calculates VAT treatment
// (margin-scheme eligibility, input-tax recoverability, reverse-charge
// applicability, etc). vat_type is data entered elsewhere and trusted as
// given -- its accuracy at the point of capture is a data-entry concern,
// not something this report investigates or corrects. Any VAT
// determination question belongs with the org's accountant.
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
  // These four now accumulate ONLY devices in VALUATION_INCLUDED_STATUSES
  // — see that constant's comment for the full decision. REJECTED and
  // SOLD devices are tracked in their own separate accumulators below
  // and never added into these.
  let purchaseCount = 0
  let purchaseValue = 0
  let purchasePlusRepairCount = 0
  let purchasePlusRepairValue = 0
  // costed_vs_uncosted intentionally covers EVERY device in the org
  // regardless of valuation-inclusion category — it is a data-quality
  // metric ("how much of our cost data is actually populated"), not a
  // valuation total, so REJECTED/SOLD devices still count here even
  // though their value is excluded from purchase_only/
  // purchase_plus_repair above.
  let costedCount = 0
  let uncostedCount = 0
  let multiPurchaseRowDeviceCount = 0

  // ── rejected / sold headline lines — own accumulators, same
  // purchase-plus-repair basis as the main total, kept separate so
  // their value never silently joins the main included-statuses sum. ──
  let rejectedCount = 0
  let rejectedValue = 0
  let soldCount = 0
  let soldValue = 0
  const includedStatusSet = new Set<DeviceStatus>(VALUATION_INCLUDED_STATUSES)
  const excludedAsOwnLineSet = new Set<DeviceStatus>(VALUATION_EXCLUDED_AS_OWN_LINE)
  const excludedTotallySet = new Set<DeviceStatus>(VALUATION_EXCLUDED_TOTALLY)

  // ── by_stage accumulator, pre-seeded with every DEVICE_STATUSES value
  // at zero so stages with no devices still appear (spec requirement:
  // "a stage with zero devices should appear with zeros rather than
  // being omitted, so the breakdown is stable across runs"). ──
  const stageAgg = new Map<DeviceStatus, { count: number; purchase: number; purchasePlusRepair: number }>()
  for (const s of DEVICE_STATUSES) stageAgg.set(s, { count: 0, purchase: 0, purchasePlusRepair: 0 })

  // ── by_vat_bucket accumulator, pre-seeded with all four buckets. ──
  const vatAgg = new Map<VatBucket, { count: number; value: number }>()
  for (const b of VAT_BUCKETS) vatAgg.set(b, { count: 0, value: 0 })

  // ── by_vat_type_raw accumulator, pre-seeded with all four VAT_TYPES
  // values plus 'unset', UNGROUPED — the integration-facing figure. ──
  const vatRawAgg = new Map<VatType | 'unset', { count: number; value: number }>()
  for (const v of VAT_TYPES) vatRawAgg.set(v, { count: 0, value: 0 })
  vatRawAgg.set('unset', { count: 0, value: 0 })

  for (const row of deviceRows) {
    const purchaseGbp = round2(row.purchase_gbp)
    const purchasePlusRepairGbp = round2(row.purchase_plus_repair_gbp)

    // Headline totals: every device in VALUATION_INCLUDED_STATUSES
    // contributes its count, even at zero value (spec: "devices with no
    // ledger row contribute zero to value but must still appear in the
    // stage and uncosted counts") — but REJECTED and SOLD devices are
    // routed to their own separate accumulators below instead, per the
    // valuation-inclusion decision (VALUATION_INCLUDED_STATUSES above).
    if (includedStatusSet.has(row.status)) {
      purchaseCount++
      purchaseValue += purchaseGbp
      purchasePlusRepairCount++
      purchasePlusRepairValue += purchasePlusRepairGbp
    } else if (excludedAsOwnLineSet.has(row.status)) {
      rejectedCount++
      rejectedValue += purchasePlusRepairGbp
    } else if (excludedTotallySet.has(row.status)) {
      soldCount++
      soldValue += purchasePlusRepairGbp
    }
    // No `else`: the module-load partition check above guarantees every
    // DeviceStatus lands in exactly one of the three branches, and the
    // live CHECK constraint guarantees row.status is one of the 14
    // known values — so falling through all three is not reachable.

    // costed_vs_uncosted is a data-quality metric over EVERY device in
    // the org, independent of valuation-inclusion category (see the
    // accumulator declarations above) — REJECTED/SOLD devices still
    // count here.
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

    const rawKey: VatType | 'unset' = (row.vat_type as VatType | null) ?? 'unset'
    const rawEntry = vatRawAgg.get(rawKey) ?? vatRawAgg.get('unset')!
    rawEntry.count++
    rawEntry.value += purchaseGbp
  }

  purchaseValue = round2(purchaseValue)
  purchasePlusRepairValue = round2(purchasePlusRepairValue)
  rejectedValue = round2(rejectedValue)
  soldValue = round2(soldValue)

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
      rejected: { count: rejectedCount, value_gbp: rejectedValue },
      sold: { count: soldCount, value_gbp: soldValue },
    },
    reconciliation: {
      included_count: purchaseCount,
      rejected_count: rejectedCount,
      sold_count: soldCount,
      total_devices: deviceRows.length,
      balanced: purchaseCount + rejectedCount + soldCount === deviceRows.length,
    },
    costed_vs_uncosted: {
      costed: costedCount,
      uncosted: uncostedCount,
      total_devices: deviceRows.length,
      // Computed at runtime, not static prose, so this can never say one
      // thing while the totals above say another (reviewer correction:
      // an earlier draft's surrounding commentary asserted "device cost
      // + repair cost" in one place and "£0 across the board" in
      // another for the same all-uncosted state — those must not be
      // able to diverge again).
      note: uncostedCount === deviceRows.length && deviceRows.length > 0
        ? `All ${deviceRows.length} device(s) in this organisation are currently uncosted (0 cost_ledger rows) — every value total in this response is £0 for that reason, not because purchase prices are actually zero.`
        : 'An uncosted device contributes zero to every value total above; costed/uncosted counts determine how much of the headline figures reflect real data versus missing data.',
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
    by_vat_type_raw: ([...VAT_TYPES, 'unset'] as Array<VatType | 'unset'>).map(vatType => {
      const v = vatRawAgg.get(vatType)!
      return { vat_type: vatType, count: v.count, value_gbp: round2(v.value) }
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
      'SOLD devices (headline.sold; excluded because a sold device is no longer the operator\'s owned stock — currently always £0/0 because SOLD is unreachable by any transition today)',
    ],
    basis: 'This is a management valuation at device purchase price plus any posted repair cost — an "item cost" figure, not a "landed cost" figure. It excludes freight, duty, VAT and write-downs, and is not a statutory inventory-cost figure under any accounting standard. Any system consuming this response should treat it as device purchase/repair cost only, not a balance-sheet or landed-cost number. LIMITATION: the "repair" component of "purchase plus repair" covers bought-in (third-party-invoiced) repair costs only — cost_ledger rows with cost_type=\'repair\' are written exclusively by postRepairCostToLedger() for bought-in work. Nothing is currently recorded anywhere in this system for in-house repair parts or labour, so purchase_plus_repair systematically UNDERSTATES true cost for any device repaired in-house, with no flag distinguishing an in-house-repaired device from one that was never repaired at all. Devices in headline.rejected and headline.sold are excluded from purchase_only/purchase_plus_repair above — see reconciliation for how every device is accounted for across included/rejected/sold.',
    vat_bucket_basis: "The grouped by_vat_bucket breakdown is for human reading only: STANDARD and PVAT are combined into 'standard_and_net_recoverable' for readability, MARGIN and ZERO stay separate, unset vat_type gets its own row. This system's vat_type vocabulary (MARGIN/STANDARD/ZERO/PVAT) has no 'REVERSE_CHARGE' value — that is recorded here as an absence, not something mapped onto another bucket. Grouping a stored field is not the same operation as calculating VAT: this endpoint only does the former. Any system consuming this response programmatically should use by_vat_type_raw (ungrouped, per-stored-value) instead of by_vat_bucket.",
  }

  return c.json(response)
})

export default app
