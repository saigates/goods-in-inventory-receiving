export type Bindings = {
  DB: D1Database
}

export type Manifest = {
  id: number
  reference: string
  supplier: string
  notes: string | null
  status: 'open' | 'closed'
  created_at: string
  closed_at: string | null
}

export type ExpectedDevice = {
  id: number
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
}

export type ReceivedDevice = {
  id: number
  uuid: string
  imei: string
  sku: string
  brand: string | null
  model: string | null
  capacity: string | null
  color: string | null
  grade: string | null
  source: 'manifest' | 'unreconciled'
  manifest_id: number | null
  expected_device_id: number | null
  status: string
  label_printed_at: string | null
  notes: string | null
  created_at: string
}

export type SkuCatalog = {
  id: number
  sku: string
  brand: string
  model: string
  capacity: string | null
  color: string | null
}
