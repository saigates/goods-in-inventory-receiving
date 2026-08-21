import { Hono } from 'hono'
import type { Bindings, AuthUser } from '../types'
import { buildSku, brandFromOem } from '../lib/sku'
import { normalizeGrade, VALID_GRADES } from '../lib/grade'
import { normalizeCapacity, resolveCatalogSku } from '../lib/catalog'
import { currentUser } from '../lib/auth'
import { cleanString } from '../lib/validate'

const app = new Hono<{ Bindings: Bindings; Variables: { user: AuthUser } }>()

// List catalogue entries (optionally filtered by free-text q), org-scoped.
//
// NOTE (2026-07-29): this used to be a flat `LIMIT 1000` with no pagination.
// That silently truncated the unfiltered listing well before it could reach
// alphabetically-later brands/models — e.g. with ~2,780 rows and ~1,472 of
// them being Apple models sorting before "IPHONE 17", the 1000-row cap cut
// off partway through "IPHONE 13...", so no iPhone 17/Air/SE/XR row (and no
// Samsung row at all, since APPLE < SAMSUNG) was ever returned to the UI —
// even though every one of those rows was correctly present in D1. This
// wasn't a missing-data bug, it was a hidden truncation the UI never
// surfaced. Fixed by raising the cap well above the current+near-future
// catalogue size (matches the 5000-row cap used elsewhere in this project,
// e.g. the CSV device export) so an unfiltered browse always returns every
// row. If the catalogue keeps growing past that, this endpoint should move
// to real pagination (page/page_size) rather than raising the cap again.
app.get('/', async (c) => {
  const user = currentUser(c)
  const q = c.req.query('q')?.trim()
  let sql = 'SELECT * FROM sku_catalog WHERE organisation_id = ?'
  const binds: unknown[] = [user.organisation_id]
  if (q) {
    sql += ' AND (sku LIKE ? OR brand LIKE ? OR model LIKE ?)'
    const w = `%${q}%`
    binds.push(w, w, w)
  }
  sql += ' ORDER BY brand ASC, model ASC, capacity ASC LIMIT 5000'
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all()
  return c.json({ catalog: results })
})

// Bulk upload. Body:
//   { rows: [{ brand, model, capacity?, color?, sku? }, ...] }
//
// Per row we:
//   1. Compute a canonical sku_code if the row didn't supply one. We use the
//      same buildSku helper that the receive path uses, so manual entries
//      and catalogue entries share the same naming scheme.
//   2. Check for an existing row with the same sku. If it exists with the
//      SAME (brand, model, capacity, color), we report it as 'duplicate'.
//      If it exists with DIFFERENT fields we report it as 'collision' — we
//      do NOT merge, do NOT overwrite. The operator has to resolve manually
//      (rename one side or delete the conflicting row).
//   3. Otherwise insert.
//
// The whole upload is dry-run-able with ?dry_run=1 — useful for the UI
// preview step before the user commits.
app.post('/upload', async (c) => {
  const user = currentUser(c)
  const orgId = user.organisation_id
  const dryRun = c.req.query('dry_run') === '1'
  const body = await c.req.json<{
    rows: Array<{
      brand?: string | null
      model?: string | null
      capacity?: string | null
      color?: string | null
      sku?: string | null
      grade?: string | null
    }>
  }>().catch(() => ({} as any))

  const rows = Array.isArray(body.rows) ? body.rows : []
  if (rows.length === 0) return c.json({ error: 'rows[] required' }, 400)

  type Outcome = 'inserted' | 'duplicate' | 'collision' | 'invalid'
  type Report = {
    row_index: number
    outcome: Outcome
    sku: string | null
    brand: string | null
    model: string | null
    capacity: string | null
    color: string | null
    grade: string | null
    existing?: { sku: string; brand: string; model: string; capacity: string | null; color: string | null; grade: string | null }
    message?: string
  }

  // Build a canonical SKU for a catalogue row when none is supplied.
  // Pattern: {BRAND}-{MODELSHORT}-{CAP}-{COLOR}-{GRADE}
  function deriveSku(
    brand: string, model: string, capacity: string | null, color: string | null, grade: string,
  ): string {
    void brandFromOem
    const built = buildSku({
      oem: brand,
      description: capacity ? `${model} ${capacity}` : model,
      color,
      capacity,
    })
    return `${built.sku}-${grade}`
  }

  // Pre-load existing SKUs into a map so we can check without N+1 queries.
  // For a prototype catalogue (< ~10k rows) this is fine. Org-scoped.
  const { results: existingRows } = await c.env.DB.prepare(
    'SELECT sku, brand, model, capacity, color, grade FROM sku_catalog WHERE organisation_id = ?'
  ).bind(orgId).all<{ sku: string; brand: string; model: string; capacity: string | null; color: string | null; grade: string | null }>()
  const existingMap = new Map(existingRows.map(r => [r.sku, r]))

  const report: Report[] = []

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {}
    const brand = cleanString(r.brand, 128) || ''
    const model = cleanString(r.model, 128) || ''
    const capacity = normalizeCapacity(r.capacity)
    const color = cleanString(r.color, 64)
    // Grade is now first-class on catalog. Anything missing/invalid → UG so
    // the row is still usable; this matches receive-side normalisation.
    const rawGrade = (r.grade ?? '').toString().trim()
    const gradeValid = VALID_GRADES.includes(rawGrade.toUpperCase() as never)
    const grade = gradeValid ? rawGrade.toUpperCase() : normalizeGrade(rawGrade)

    if (!brand || !model) {
      report.push({
        row_index: i, outcome: 'invalid', sku: null,
        brand: brand || null, model: model || null, capacity, color, grade,
        message: 'brand and model are required',
      })
      continue
    }

    const sku = cleanString(r.sku, 128) || deriveSku(brand, model, capacity, color, grade)

    // Check existing (DB + any rows we've inserted/seen earlier in this upload).
    const prior = existingMap.get(sku)
    if (prior) {
      const same =
        prior.brand === brand &&
        prior.model === model &&
        (prior.capacity || null) === capacity &&
        (prior.color || null) === color &&
        (prior.grade || null) === grade
      report.push({
        row_index: i,
        outcome: same ? 'duplicate' : 'collision',
        sku, brand, model, capacity, color, grade,
        existing: prior,
        message: same
          ? 'SKU already exists with identical fields — skipped'
          : 'SKU exists but with different brand/model/capacity/color/grade — NOT merged, please resolve manually',
      })
      continue
    }

    // Good to insert
    if (!dryRun) {
      await c.env.DB.prepare(
        `INSERT INTO sku_catalog (organisation_id, sku, brand, model, capacity, color, grade) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(orgId, sku, brand, model, capacity, color, grade).run()
    }
    report.push({ row_index: i, outcome: 'inserted', sku, brand, model, capacity, color, grade })
    // Mark as known so the next row in this upload sees it (in-upload duplicate detection)
    existingMap.set(sku, { sku, brand, model, capacity, color, grade })
  }

  const summary = {
    inserted: report.filter(r => r.outcome === 'inserted').length,
    duplicate: report.filter(r => r.outcome === 'duplicate').length,
    collision: report.filter(r => r.outcome === 'collision').length,
    invalid: report.filter(r => r.outcome === 'invalid').length,
    total: report.length,
    dry_run: dryRun,
  }
  return c.json({ ok: true, summary, report })
})

// Live lookup endpoint for the ConfirmSkuModal. The modal calls this as the
// operator edits model/capacity/color/grade so it can re-resolve to a
// catalog SKU on every change, without having to re-scan the IMEI.
// Body: { model, capacity, color, grade }
app.post('/lookup', async (c) => {
  const user = currentUser(c)
  const body = await c.req.json<{
    model?: string | null
    capacity?: string | null
    color?: string | null
    grade?: string | null
  }>().catch(() => ({} as any))
  const grade = normalizeGrade(body.grade)
  const result = await resolveCatalogSku(c.env.DB, {
    model: body.model,
    capacity: body.capacity,
    color: body.color,
    grade,
  }, user.organisation_id)
  return c.json(result)
})

// D1's exact error text distinguishes an index-level collision (the
// ux_sku_catalog_org_config_grade constraint added by migration 0031) from
// a column-level collision (the pre-existing `sku` UNIQUE constraint) by
// naming an INDEX vs a TABLE.COLUMN — confirmed empirically against the
// real D1 binding (probe run 2026-08-20, spec deleted after capturing the
// output) and confirmed on review as a general, durable SQLite behaviour,
// not coincidental to these two constraints specifically:
//   index-based:  D1_ERROR: UNIQUE constraint failed: index 'ux_sku_catalog_org_config_grade': SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)
//   column-based: D1_ERROR: UNIQUE constraint failed: sku_catalog.sku: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)
// Two deliberate construction choices, per review (2026-08-21) — same
// precedent shape as isImeiUniqueError() in src/routes/scan.ts, but with
// these two riders layered on:
//  1. NOT anchored to start-of-string: both real strings happen to be
//     prefixed `D1_ERROR:`, but that prefix is wrapper-dependent and may
//     not be present/identical across every error-surfacing layer.
//  2. Matches the index/column name LITERALLY (exact substring, followed
//     immediately by the closing quote / a word boundary) so a future
//     index or column sharing a name PREFIX with this one (e.g.
//     'ux_sku_catalog_org_config_grade_v2') can never be accidentally
//     swallowed by a looser match.
function isCatalogConfigUniqueError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed:\s*index\s*'ux_sku_catalog_org_config_grade'/i.test(msg)
}
function isCatalogSkuUniqueError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed:\s*sku_catalog\.sku\b/i.test(msg)
}

// Add a catalog entry on the fly from the ConfirmSkuModal when no matching
// SKU exists — now with four-grade-variant auto-generation (G5 item 2).
// Body: { brand, model, capacity, color, grade, sku? }
//
// ── Two design decisions, made and documented here 2026-08-21 (per
// explicit instruction: "what comes back is a real decision, not an
// implementation detail... pick one and state it") ──
//
// DECISION 1 — response shape when up to 4 rows may be created in one
// call: `row` stays the SINGLE row matching the REQUESTED grade, exactly
// as before — this preserves the existing contract every current caller
// relies on (addToCatalogAndReceive()/confirmIt() in public/static/app.js
// read `r.row.sku` and immediately receive against it; nothing about that
// changes). The up-to-3 sibling rows generated in the SAME call are
// reported SEPARATELY in `generated_siblings` ({id, sku, grade}[]) —
// additive, never merged into or substituted for `row`.
//
// DECISION 2 — the mixed case: the REQUESTED grade already has a row, but
// one or more siblings are still missing (exactly the shape of the known
// 9-config/27-row gap the sweep found). Two options were both defensible:
//   (a) refuse — {error, existing} as today, no side effects.
//   (b) success that opportunistically fills the missing siblings even
//       though the requested grade pre-existed.
// PICKED: (a). Migration 0031's own header requires that "the eventual
// auto-generation logic" close the race window WITHOUT turning ordinary
// receive traffic into a remediation channel, and this project has
// separately, deliberately scoped "any bulk remediation (writing the 27
// missing rows)" as its OWN future approval, out of this item's commit.
// Option (b) would make POST / a silent, incremental backdoor for exactly
// that remediation: any ordinary receive against one of the 9 known-bad
// configs, requesting its already-existing UG grade, would side-effect-
// create the missing A/B/C rows with no explicit approval step. That
// blurs a boundary this project has kept explicit elsewhere, so
// auto-generation only ever fires on a genuinely NEW grade for a config —
// i.e. below, only when existingMatch.status !== 'match'.
app.post('/', async (c) => {
  const user = currentUser(c)
  const orgId = user.organisation_id
  const body = await c.req.json<{
    brand?: string | null
    model?: string | null
    capacity?: string | null
    color?: string | null
    grade?: string | null
    sku?: string | null
  }>().catch(() => ({} as any))
  const brand = cleanString(body.brand, 128) || ''
  const model = cleanString(body.model, 128) || ''
  const capacity = normalizeCapacity(body.capacity)
  const color = cleanString(body.color, 64)
  const grade = normalizeGrade(body.grade)

  if (!brand || !model) {
    return c.json({ error: 'brand and model are required' }, 400)
  }

  // Decision 2: refuse if a row already matches (model+capacity+color+
  // grade) exactly — operator should pick that one rather than trigger
  // auto-generation as a side effect of an ordinary duplicate request.
  const existingMatch = await resolveCatalogSku(c.env.DB, { model, capacity, color, grade }, orgId)
  if (existingMatch.status === 'match') {
    return c.json({
      error: 'A catalog SKU already exists for this combination',
      existing: existingMatch.row,
    }, 409)
  }

  // Genuinely new grade for this config: find every grade CURRENTLY
  // missing from this exact config (organisation_id + brand + model +
  // capacity + color, same key shape as ux_sku_catalog_org_config_grade)
  // in one query, diffed in memory against VALID_GRADES — the same
  // "fetch once, diff in memory" pattern matchCatalogRows/
  // resolveCatalogSkuBulk already use elsewhere in this file, rather than
  // up to 4 sequential existence checks. `grade` (the requested one) is
  // guaranteed to be among the missing set here, since existingMatch
  // already confirmed no exact row exists for it.
  const sameConfig = await c.env.DB.prepare(
    `SELECT grade FROM sku_catalog
      WHERE organisation_id = ?
        AND UPPER(brand) = UPPER(?)
        AND UPPER(model) = UPPER(?)
        AND COALESCE(capacity, '') = COALESCE(?, '')
        AND UPPER(COALESCE(color, '')) = UPPER(COALESCE(?, ''))`
  ).bind(orgId, brand, model, capacity, color).all<{ grade: string | null }>()
  const existingGrades = new Set(sameConfig.results.map(r => (r.grade || 'UG').toUpperCase()))
  const missingGrades = (VALID_GRADES as readonly string[]).filter(g => !existingGrades.has(g))

  const explicitSku = cleanString(body.sku, 128)
  const deriveGradeSku = (g: string): string => {
    if (explicitSku && g === grade) return explicitSku
    const built = buildSku({ oem: brand, description: model, color, capacity })
    return `${built.sku}-${g}`
  }

  let row: Record<string, unknown> | null = null
  const generated_siblings: Array<{ id: number; sku: string; grade: string }> = []
  const sku_conflicts: Array<{ grade: string; sku: string; existing: unknown }> = []

  for (const g of missingGrades) {
    const sku = deriveGradeSku(g)
    try {
      const ins = await c.env.DB.prepare(
        'INSERT INTO sku_catalog (organisation_id, sku, brand, model, capacity, color, grade) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(orgId, sku, brand, model, capacity, color, g).run()
      const insertedRow = await c.env.DB.prepare('SELECT * FROM sku_catalog WHERE id = ?')
        .bind(ins.meta.last_row_id).first<Record<string, unknown>>()
      if (g === grade) {
        row = insertedRow
      } else if (insertedRow) {
        generated_siblings.push({ id: ins.meta.last_row_id, sku, grade: g })
      }
    } catch (err) {
      if (isCatalogConfigUniqueError(err)) {
        // Raced: another request inserted this exact grade for this exact
        // config between our SELECT above and this INSERT. Idempotent —
        // re-read what's there instead of failing the whole call.
        const raced = await c.env.DB.prepare(
          `SELECT id, sku, brand, model, capacity, color, grade FROM sku_catalog
            WHERE organisation_id = ?
              AND UPPER(brand) = UPPER(?) AND UPPER(model) = UPPER(?)
              AND COALESCE(capacity, '') = COALESCE(?, '')
              AND UPPER(COALESCE(color, '')) = UPPER(COALESCE(?, ''))
              AND grade = ?`
        ).bind(orgId, brand, model, capacity, color, g).first<Record<string, unknown>>()
        if (g === grade && raced) row = raced
        continue
      }
      if (isCatalogSkuUniqueError(err)) {
        // Genuine anomaly: the derived SKU string collides with an
        // UNRELATED row (different config) that already holds it. Do not
        // abort the whole request — record it, leave that one grade
        // variant unwritten, and continue with the rest.
        const conflict = await c.env.DB.prepare(
          'SELECT id, sku, brand, model, capacity, color, grade FROM sku_catalog WHERE sku = ? AND organisation_id = ?'
        ).bind(sku, orgId).first()
        sku_conflicts.push({ grade: g, sku, existing: conflict })
        continue
      }
      throw err
    }
  }

  if (!row) {
    // Should not happen on the normal path (grade was confirmed missing
    // above, and its insert either succeeded or was raced-and-refetched)
    // — but if the REQUESTED grade's own derived SKU hit a sku_conflicts
    // case, surface that as the same 409 shape POST / already used for a
    // SKU collision, rather than returning ok:true with no row.
    const requestedConflict = sku_conflicts.find(sc => sc.grade === grade)
    if (requestedConflict) {
      return c.json({
        error: `SKU '${requestedConflict.sku}' already exists with different fields`,
        existing: requestedConflict.existing,
      }, 409)
    }
    return c.json({ error: 'Failed to create or locate the requested catalog row' }, 500)
  }

  return c.json({
    ok: true,
    row,
    generated_siblings,
    ...(sku_conflicts.length ? { sku_conflicts } : {}),
  })
})

// Delete a single catalogue entry by id. Does NOT affect received_devices that
// reference this SKU — those keep their copy of the SKU string.
app.delete('/:id', async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
  await c.env.DB.prepare('DELETE FROM sku_catalog WHERE id = ? AND organisation_id = ?')
    .bind(id, user.organisation_id).run()
  return c.json({ ok: true })
})

export default app
