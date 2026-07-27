// Runs once per test worker (per test file) before any test in that file
// executes. Applies every migration in ./migrations to the in-memory D1
// binding so tests exercise the real production schema (received_devices
// status CHECK constraint, device_events table, etc.) rather than a
// hand-rolled stand-in.
import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'

// TEST_MIGRATIONS is injected via vitest.config.ts's miniflare.bindings,
// populated by readD1Migrations() at config-build time (Node.js side).
const anyEnv = env as unknown as { DB: D1Database; TEST_MIGRATIONS: any }

await applyD1Migrations(anyEnv.DB, anyEnv.TEST_MIGRATIONS)
