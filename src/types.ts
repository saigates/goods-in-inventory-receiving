export type Bindings = {
  DB: D1Database
  // HS256 shared secret used to sign/verify auth JWTs. Set via `.dev.vars`
  // locally and `wrangler pages secret put JWT_SECRET` in production.
  JWT_SECRET: string
  // OPR 4: Gmail OAuth2 offline-grant secrets for the sending mailbox.
  // ALL THREE must be set for /prealert/send and /clearance/send to work —
  // otherwise those endpoints refuse with 503 gmail_not_configured (drafts
  // keep working). Set via `wrangler pages secret put GMAIL_*`.
  GMAIL_CLIENT_ID?: string
  GMAIL_CLIENT_SECRET?: string
  GMAIL_REFRESH_TOKEN?: string
}

// ───────── Auth / multi-tenancy ─────────

export type UserRole = 'operator' | 'manager' | 'admin'

export type User = {
  id: number
  email: string
  name: string | null
  role: UserRole
  organisation_id: number
  created_at: string
}

export type Organisation = {
  id: number
  name: string
  slug: string | null
  created_at: string
}

// Shape of the context value set by the auth middleware on every request.
export type AuthUser = {
  id: number
  email: string
  name: string | null
  role: UserRole
  organisation_id: number
}

export type Manifest = {
  id: number
  organisation_id: number
  reference: string
  supplier: string
  notes: string | null
  status: 'open' | 'closed'
  created_at: string
  closed_at: string | null
}

export type ExpectedDevice = {
  id: number
  organisation_id: number
  manifest_id: number
  oem: string | null
  condition: string | null
  description: string | null
  grade: string | null
  model_no: string | null
  imei: string
  unit_cost: number | null
  currency: string | null   // ISO 4217 hint from the supplier file (0015)
  vat_type: string | null   // MARGIN | STANDARD | ZERO | PVAT hint (0015)
  sku: string | null
  status: 'pending' | 'received'
  received_at: string | null
  received_device_id: number | null
  capacity?: string | null
  color?: string | null
}

// ───────── Device lifecycle (Priority 2) ─────────

export const DEVICE_STATUSES = [
  'RECEIVED',
  'SORTING',
  'ACTIVE_INVENTORY',
  'IN_HOUSE_REPAIR',
  'READY_FOR_EXPORT',
  'IN_EXPORT_CONSIGNMENT',
  'EXPORTED_UNDER_OPR',
  'RETURNED_UNDER_OPR',
  'SOLD',
  'REJECTED',
] as const

export type DeviceStatus = typeof DEVICE_STATUSES[number]

export const VAT_TYPES = ['MARGIN', 'STANDARD', 'ZERO', 'PVAT'] as const
export type VatType = typeof VAT_TYPES[number]

export type ReceivedDevice = {
  id: number
  organisation_id: number
  uuid: string
  imei: string
  sku: string
  brand: string | null
  model: string | null
  capacity: string | null
  color: string | null
  grade: string | null
  source: 'manifest' | 'unreconciled' | 'manual'
  manifest_id: number | null
  expected_device_id: number | null
  status: DeviceStatus
  label_printed_at: string | null
  notes: string | null
  created_at: string
  updated_at?: string | null
  created_by_user_id?: number | null
  // Valuation / VAT (Priority 4)
  buy_price: number | null
  currency: string
  vat_type: VatType | null
  supplier_id: number | null
}

// ───────── Device event log (Priority 3) ─────────

export type DeviceEvent = {
  id: number
  organisation_id: number
  device_id: number
  event_type: string
  from_status: DeviceStatus | null
  to_status: DeviceStatus | null
  user_id: number | null
  reference: string | null
  metadata: string | null // JSON-encoded
  created_at: string
}

export type SkuCatalog = {
  id: number
  organisation_id: number
  sku: string
  brand: string
  model: string
  capacity: string | null
  color: string | null
  grade?: string | null
}

export type Supplier = {
  id: number
  organisation_id: number
  name: string
  created_at: string
}

export type Webhook = {
  id: number
  organisation_id: number
  url: string
  secret: string
  enabled: number
  created_at: string
}

// ───────── OPR foundation (OPR 1) ─────────

export type OprAuthorisation = {
  id: number
  organisation_id: number
  holder_name: string
  eori: string
  cds_number: string      // CDS Authorisation Number — for CDS declarations and the cross-reference statement
  op_authorisation_number: string | null // OPR Authorisation Number (e.g. OP/0922/601/31) — for the C&E1154 authorisation field. NOT a "CHIEF number" — no such identifier exists on this authorisation.
  valid_from: string
  valid_to: string
  supervising_office_name: string | null
  supervising_office_code: string | null
  commodity_scope: string | null
  commodity_codes: string | null
  rate_of_yield: string
  discharge_period_months: number
  notes: string | null
  prealert_email: string | null   // carrier customs pre-alert mailbox (0011)
  prealert_cutoff: string | null  // e.g. '16:00' — same-day pre-alert cut-off (0011)
  created_at: string
  updated_at: string | null
}

export type ShipmentDirection = 'export' | 'import'
export type ShipmentStatus = 'DRAFT' | 'FINALISED' | 'CANCELLED'

export type Shipment = {
  id: number
  organisation_id: number
  reference: string
  direction: ShipmentDirection
  shipment_type: 'OPR_REPAIR'
  status: ShipmentStatus
  authorisation_id: number
  procedure_code: string
  additional_procedure_code: string | null
  consignee_name: string | null
  consignee_address: string | null
  carrier: string | null
  carrier_account: string | null
  incoterm: string | null
  currency: 'GBP'
  ship_date: string | null
  related_export_shipment_id: number | null
  export_mrn: string | null
  ducr: string | null             // Declaration UCR — proof of export (0011)
  ead_mrn: string | null          // EAD MRN — proof of export (0011)
  mucr: string | null             // Master UCR — consolidation ref (0014)
  finalised_at: string | null
  finalised_by_user_id: number | null
  // ── OPR 3 (0012): C&E1154 inputs + re-import proof (import shipments) ──
  repair_cost: number | null            // repairer invoice amount, as invoiced
  repair_cost_currency: string | null   // ISO 4217 of that invoice
  customs_exchange_rate: number | null  // HMRC monthly rate (foreign units per £1)
  duty_rate_pct: number | null          // duty rate for the commodity (0 valid)
  import_mrn: string | null             // MRN of the 6121 import declaration
  // ── Value reconciliation (0019): export shipments only ──
  // Declared/reconciled goods value for this export batch. NULL until ops
  // explicitly reconciles it (defaults to the computed sum of lines until
  // then); every correction after that is recorded in shipment_value_deltas.
  reconciled_value_gbp: number | null
  notes: string | null
  created_by_user_id: number | null
  created_at: string
  updated_at: string | null
}

export type ShipmentLine = {
  id: number
  organisation_id: number
  shipment_id: number
  received_device_id: number
  // Snapshot columns — frozen at add time
  imei: string
  sku: string | null
  brand: string | null
  model: string | null
  capacity: string | null
  color: string | null
  grade: string | null
  unit_value: number
  currency: string
  added_by_user_id: number | null
  created_at: string
}

// Permanent audit record of every declared-goods-value correction on a
// shipment (0019). Never updated or deleted — a full history of old →
// new value, difference, timestamp and actor.
export type ShipmentValueDelta = {
  id: number
  organisation_id: number
  shipment_id: number
  old_value_gbp: number
  new_value_gbp: number
  difference_gbp: number
  note: string | null
  user_id: number | null
  created_at: string
}
