import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Runs ONLY test/oprImport.spec.ts, serially (fileParallelism: false —
// moot with a single file, but explicit so this config's intent survives
// a future second file being added here by mistake). See vitest.config.ts's
// matching `exclude` entry and migrations-held/README.md's "Test gate"
// section for why this file is split out: oprImport.spec.ts's largest
// test does 324 sequential real HTTP round-trips against the real Worker
// and has twice timed out at 60s under full-suite parallel contention
// (shared workerd pool across 28+ other files) while passing 65/65 in
// isolation both times — a shared-runner capacity problem, not flaky test
// logic. Running it alone, with no sibling files competing for the pool,
// removes the contention rather than raising the per-test timeout a third
// time.
//
// Gate definition (write this down wherever the previous single-command
// gate was assumed): passing means BOTH `npm test` (main suite, this file
// excluded) AND `npm run test:serial` (this config, oprImport.spec.ts
// only) are green, totalling 611 passed / 8 skipped / 0 failed across the
// two runs combined — not one green `npx vitest run`. A single green
// `npm test` alone no longer proves the whole suite passes.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrationsPath = path.join(__dirname, 'migrations')
      const migrations = await readD1Migrations(migrationsPath)

      return {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }
    }),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
    include: ['test/oprImport.spec.ts'],
    fileParallelism: false,
  },
})
