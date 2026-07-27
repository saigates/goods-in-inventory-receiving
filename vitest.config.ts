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
  },
})
