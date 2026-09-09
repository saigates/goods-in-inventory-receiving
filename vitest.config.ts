import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // Load every migration in ./migrations so tests run against the exact
      // schema production uses (see test/apply-migrations.ts, which applies
      // these to the in-test D1 binding before each test file runs).
      const migrationsPath = path.join(__dirname, 'migrations')
      const migrations = await readD1Migrations(migrationsPath)

      return {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // Test-only binding so the setup file can read + apply them.
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }
    }),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
    // test/oprImport.spec.ts is run separately, serially, by
    // vitest.serial.config.ts (see that file's header and
    // migrations-held/README.md's "Test gate" section for why: its
    // largest test does 324 sequential real HTTP round-trips and has
    // twice timed out at 60s under full-suite parallel contention while
    // passing 65/65 in isolation both times — a shared-runner capacity
    // problem, not a flaky test). Excluded here so the main suite stays
    // parallel; run BOTH `npm test` and `npm run test:serial` to satisfy
    // the full gate.
    exclude: ['**/node_modules/**', '**/.git/**', 'test/oprImport.spec.ts'],
  },
})
