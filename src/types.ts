export type Bindings = {
  DB: D1Database
  // HS256 shared secret used to sign/verify auth JWTs. Set via `.dev.vars`
  // locally and `wrangler pages secret put JWT_SECRET` in production.
  JWT_SECRET: string
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

export const VAT_TYPES = ['MARGIN', 'STANDARD', 'ZERO'] as const
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
