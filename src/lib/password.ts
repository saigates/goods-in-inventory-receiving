// Password hashing for the two-user internal login (Saigates Limited).
//
// PBKDF2-SHA256 via WebCrypto — available natively in the Workers runtime,
// no dependency. 100,000 iterations (the Cloudflare Workers enforced cap
// for PBKDF2), 16-byte random salt per user, 32-byte derived key.
//
// Stored format (single TEXT column users.password_hash):
//   pbkdf2$<iterations>$<salt-hex>$<hash-hex>
//
// A NULL/empty password_hash can NEVER authenticate — that is how the two
// seeded accounts ship in the migration (no plaintext anywhere in the repo);
// the owner provisions real passwords out of band via scripts/set-password.mjs
// (local) or a one-off hash-only UPDATE (production).
//
// verifyPassword does a constant-time comparison over the derived bytes so
// a timing side-channel can't leak hash prefixes. Plaintext passwords are
// never stored, logged, or echoed back — callers must treat them the same.

const ITERATIONS = 100_000
const SALT_BYTES = 16
const KEY_BYTES = 32

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    keyMaterial,
    KEY_BYTES * 8,
  )
  return new Uint8Array(bits)
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const hash = await derive(password, salt, ITERATIONS)
  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${toHex(hash)}`
}

// Constant-time byte comparison — never early-exits on the first mismatch.
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

// Returns true ONLY for a well-formed stored hash whose derived bytes match.
// NULL / empty / malformed stored values always return false — an account
// without a provisioned password cannot log in.
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = Number(parts[1])
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100_000) return false
  if (!/^[0-9a-f]+$/.test(parts[2]) || !/^[0-9a-f]+$/.test(parts[3])) return false
  const salt = fromHex(parts[2])
  const expected = fromHex(parts[3])
  const actual = await derive(password, salt, iterations)
  return timingSafeEqual(actual, expected)
}

// Minimal strength floor for the change-password endpoint. Deliberately not
// a complexity zoo — length is the defensible internal-grade requirement.
export const MIN_PASSWORD_LENGTH = 10
export function passwordPolicyError(password: string): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
  }
  return null
}
