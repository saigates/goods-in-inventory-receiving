// OPR 4: actually SENDING email via the Gmail REST API (not just drafting).
//
// Configuration is via Cloudflare secrets (never code, never D1):
//   GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN — an OAuth2
//   "offline" grant for the sending mailbox, exchanged for a short-lived
//   access token per send (standard Google refresh-token flow), then
//   POST /gmail/v1/users/me/messages/send with a base64url RFC 2822 message.
//
// HONESTY RULE: when the secrets are absent the send endpoints refuse with
// 503 `gmail_not_configured` and write NOTHING to the sent_emails outbox.
// The system never pretends an email went out. The drafts (`/prealert`,
// `/clearance`) keep working without configuration.
//
// Everything network-shaped goes through global fetch, so tests can prove
// the exact wire behaviour with vitest-pool-workers' fetchMock (token
// exchange + send call, failure paths) without real Google credentials.

export type GmailConfig = {
  clientId: string
  clientSecret: string
  refreshToken: string
}

// Reads the three secrets off the env; returns null unless ALL are present.
export function gmailConfigFromEnv(env: Record<string, unknown>): GmailConfig | null {
  const clientId = typeof env.GMAIL_CLIENT_ID === 'string' ? env.GMAIL_CLIENT_ID.trim() : ''
  const clientSecret = typeof env.GMAIL_CLIENT_SECRET === 'string' ? env.GMAIL_CLIENT_SECRET.trim() : ''
  const refreshToken = typeof env.GMAIL_REFRESH_TOKEN === 'string' ? env.GMAIL_REFRESH_TOKEN.trim() : ''
  if (!clientId || !clientSecret || !refreshToken) return null
  return { clientId, clientSecret, refreshToken }
}

// Minimal RFC 2822 message with optional text/html attachments (the OPR
// documents are HTML files by design — printed to PDF by the browser).
// Subject is RFC 2047 UTF-8 encoded so "—" etc. survive transport.
export type EmailAttachment = { filename: string; contentType: string; content: string }

export function buildMimeMessage(opts: {
  to: string
  subject: string
  body: string
  attachments?: EmailAttachment[]
}): string {
  const encodedSubject = `=?UTF-8?B?${btoa(unescape(encodeURIComponent(opts.subject)))}?=`
  const atts = opts.attachments ?? []
  if (!atts.length) {
    return [
      `To: ${opts.to}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      btoa(unescape(encodeURIComponent(opts.body))),
    ].join('\r\n')
  }
  const boundary = `opr-${crypto.randomUUID()}`
  const parts: string[] = [
    `To: ${opts.to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    btoa(unescape(encodeURIComponent(opts.body))),
  ]
  for (const a of atts) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType}; name="${a.filename}"`,
      `Content-Disposition: attachment; filename="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      btoa(unescape(encodeURIComponent(a.content))),
    )
  }
  parts.push(`--${boundary}--`)
  return parts.join('\r\n')
}

// Gmail wants base64url (RFC 4648 §5) of the raw message.
export function base64Url(raw: string): string {
  return btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string }

// Refresh-token → access-token exchange. Failure detail is surfaced (and
// stored in the outbox) WITHOUT ever echoing the secrets themselves.
async function fetchAccessToken(cfg: GmailConfig): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, error: `Gmail token exchange failed (HTTP ${res.status}): ${text.slice(0, 200)}` }
  }
  const data = await res.json().catch(() => null) as { access_token?: string } | null
  if (!data?.access_token) return { ok: false, error: 'Gmail token exchange returned no access_token' }
  return { ok: true, token: data.access_token }
}

export async function sendGmail(
  cfg: GmailConfig,
  message: { to: string; subject: string; body: string; attachments?: EmailAttachment[] },
): Promise<SendResult> {
  const tok = await fetchAccessToken(cfg)
  if (!tok.ok) return { ok: false, error: tok.error }

  const raw = base64Url(buildMimeMessage(message))
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tok.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, error: `Gmail send failed (HTTP ${res.status}): ${text.slice(0, 200)}` }
  }
  const data = await res.json().catch(() => null) as { id?: string } | null
  return { ok: true, messageId: data?.id ?? 'unknown' }
}
