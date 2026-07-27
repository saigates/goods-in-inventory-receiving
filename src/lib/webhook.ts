// Outbound webhooks (Priority 6). Fired on device status change so
// downstream systems (future CRM, OPR modules) can react without polling.
//
// Payloads are signed with HMAC-SHA256 over the raw JSON body using the
// per-organisation webhook secret, sent as `X-Signature: sha256=<hex>` —
// the same pattern as GitHub/Stripe webhooks, so verification on the
// receiving end is a well-understood recipe.

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export type DeviceStatusChangePayload = {
  event: 'device.status_changed'
  organisation_id: number
  device_id: number
  imei: string
  uuid: string
  from_status: string | null
  to_status: string
  user_id: number | null
  occurred_at: string
}

// Fires every enabled webhook for the organisation. Failures are swallowed
// (logged to console) — a downstream system being down must never block or
// fail the device transition that triggered it.
export async function dispatchDeviceStatusWebhooks(
  db: D1Database,
  payload: DeviceStatusChangePayload,
): Promise<void> {
  const { results } = await db.prepare(
    'SELECT id, url, secret FROM webhooks WHERE organisation_id = ? AND enabled = 1'
  ).bind(payload.organisation_id).all<{ id: number; url: string; secret: string }>()

  if (!results.length) return

  const body = JSON.stringify(payload)
  await Promise.all(results.map(async (wh) => {
    try {
      const signature = await hmacSha256Hex(wh.secret, body)
      await fetch(wh.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': `sha256=${signature}`,
          'X-Webhook-Id': String(wh.id),
        },
        body,
      })
    } catch (err) {
      console.error(`Webhook ${wh.id} (${wh.url}) delivery failed:`, err)
    }
  }))
}
