// Cloudflare Workers has Web Crypto: crypto.randomUUID()
export function newUuid(): string {
  return crypto.randomUUID()
}

// Short internal UUID for labels: 8 hex chars
export function shortUuid(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()
}
