#!/usr/bin/env node
// One-off password provisioning for the two Saigates Limited accounts.
//
// Computes the SAME PBKDF2-SHA256 hash format as src/lib/password.ts
// (pbkdf2$100000$salt-hex$hash-hex) and prints ONLY the hash + a ready-made
// UPDATE statement. The plaintext is read from argv or generated randomly,
// shown ONCE on this terminal, and never written to disk, git, or any log.
//
// Usage:
//   node scripts/set-password.mjs <email>              # generate a random password
//   node scripts/set-password.mjs <email> <password>   # use a supplied password
//
// Then apply the printed UPDATE via:
//   npx wrangler d1 execute webapp-production --local --command="<UPDATE...>"   (local)
//   gsk hosted d1_execute --sql "<UPDATE...>"                                    (production)
import { webcrypto as crypto } from 'node:crypto'

const ITERATIONS = 100000
const email = process.argv[2]
if (!email) {
  console.error('usage: node scripts/set-password.mjs <email> [password]')
  process.exit(1)
}

// Random password: 4 groups of 4 from an unambiguous alphabet (no 0/O/1/l).
function generatePassword() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length])
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}-${chars.slice(12).join('')}`
}
const password = process.argv[3] || generatePassword()

const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')
const salt = crypto.getRandomValues(new Uint8Array(16))
const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, keyMaterial, 256)
const hash = `pbkdf2$${ITERATIONS}$${toHex(salt)}$${toHex(new Uint8Array(bits))}`

console.log(`account : ${email}`)
console.log(`password: ${password}   <-- deliver out of band; NOT saved anywhere`)
console.log(`hash    : ${hash}`)
console.log('')
console.log('apply with:')
console.log(`UPDATE users SET password_hash = '${hash}' WHERE LOWER(email) = '${email.toLowerCase()}';`)
