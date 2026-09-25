// POST /api/manifests/:id/apply-sku-to-batch — baseline coverage (Z-1,
// 2026-09-25 Master Checklist item 1: "zero existing tests on a route that
// now throws a 409 is the gap I'd worry about most").
//
// Prior to this file, `grep -rln "apply-sku-to-batch" test/*.ts` returned
// zero matches — this route (src/routes/manifests.ts:368) had NO coverage
// at all, success path or otherwise, before or after the Z-1 chunking fix.
//
// Runs against the REAL Hono app + REAL D1 binding with every migration
// applied (see vitest.config.ts / test/apply-migrations.ts), matching the
// house style in inventoryGradeSkuResolution.spec.ts / manifestBillLink.spec.ts.
//
// IMEI namespace: 3579656xxxxxxx — a NEW prefix, distinct from 3579654
// (manifestBillLink.spec.ts) and 3579655 (manifestConditionDerivation.spec.ts),
// per explicit instruction, to avoid any cross-suite collision risk on the
// shared in-memory D1.
import { env } from 'cloudflare:workers'
import { describe, it, expect, beforeAll } from 'vitest'
import app from '../src/index'
import { signAuthToken } from '../src/lib/auth'

const JWT_SECRET = 'test-secret-apply-sku-to-batch'
const testEnv = { ...env, JWT_SECRET } as typeof env & { JWT_SECRET: string }
const db = () => (env as unknown as { DB: D1Database }).DB

let token = ''
let imeiSeq = 0
function luhnImei(): string {
  const body = `3579656${String(10000000 + imeiSeq++).slice(1)}`
  let sum = 0
  for (let i = 0; i < 14; i++) {
    let d = Number(body[i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return body + String((10 - (sum % 10)) % 10)
}

async function api(path: string, init: RequestInit = {}, overrideEnv: typeof testEnv = testEnv) {
  return app.request(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  }, overrideEnv)
}

beforeAll(async () => {
  token = await signAuthToken(JWT_SECRET, {
    id: 1, email: 'admin@goodsin.local', name: 'Seed Admin', role: 'admin', organisation_id: 1,
  })
})

let catalogSeq = 0
async function insertCatalogRow(row: {
  sku?: string; brand?: string; model: string; capacity?: string; color?: string; grade?: string; organisationId?: number
}): Promise<string> {
  catalogSeq += 1
  const sku = row.sku ?? `BATCH-TEST-SKU-${Date.now().toString(36)}-${catalogSeq}`
  await db().prepare(
    `INSERT INTO sku_catalog (organisation_id, sku, brand, model, capacity, color, grade)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    row.organisationId ?? 1, sku, row.brand ?? 'APPLE', row.model,
    row.capacity ?? null, row.color ?? null, row.grade ?? null,
  ).run()
  return sku
}

async function createManifestWithRows(rows: Array<{
  imei?: string; model_no: string; capacity?: string; color?: string; grade?: string; description?: string
}>): Promise<number> {
  const res = await api('/api/manifests', {
    method: 'POST',
    body: JSON.stringify({
      reference: `MF-BATCH-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      supplier: 'Batch Apply Test Vendor',
      rows: rows.map(r => ({
        imei: r.imei ?? luhnImei(),
        model_no: r.model_no,
        description: r.description,
        capacity: r.capacity,
        color: r.color,
        grade: r.grade,
      })),
    }),
  })
  expect(res.status).toBe(200)
  const data = await res.json() as { ok: boolean; manifest_id: number }
  expect(data.ok).toBe(true)
  return data.manifest_id
}

async function pendingLinesFor(manifestId: number) {
  const { results } = await db().prepare(
    `SELECT id, sku, status, model_no, capacity, color, grade FROM expected_devices WHERE manifest_id = ? ORDER BY id ASC`
  ).bind(manifestId).all<{ id: number; sku: string | null; status: string; model_no: string | null; capacity: string | null; color: string | null; grade: string | null }>()
  return results
}

function applyToBatch(manifestId: number, body: Record<string, unknown>) {
  return api(`/api/manifests/${manifestId}/apply-sku-to-batch`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

describe('POST /api/manifests/:id/apply-sku-to-batch — success path', () => {
  it('applies the catalogue sku to every OTHER pending line sharing the exact same signature, leaving the line count and everything else untouched', async () => {
    const sku = await insertCatalogRow({ model: 'IPHONE 17', capacity: '256GB', color: 'BLUE', grade: 'A' })
    // 3 lines share the target signature; a 4th has a different colour and
    // must NOT be touched.
    const manifestId = await createManifestWithRows([
      { model_no: 'iPhone 17', capacity: '256GB', color: 'Blue', grade: 'A' },
      { model_no: 'iPhone 17', capacity: '256GB', color: 'Blue', grade: 'A' },
      { model_no: 'iPhone 17', capacity: '256GB', color: 'Blue', grade: 'A' },
      { model_no: 'iPhone 17', capacity: '256GB', color: 'Red', grade: 'A' },
    ])

    const res = await applyToBatch(manifestId, {
      sku, model: 'iPhone 17', capacity: '256GB', color: 'Blue', grade: 'A',
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { ok: boolean; applied: number; sku: string; expected_device_ids: number[] }
    expect(json.ok).toBe(true)
    expect(json.applied).toBe(3)
    expect(json.sku).toBe(sku)
    expect(json.expected_device_ids).toHaveLength(3)

    const lines = await pendingLinesFor(manifestId)
    expect(lines).toHaveLength(4)
    const blueLines = lines.filter(l => l.color === 'Blue')
    const redLine = lines.find(l => l.color === 'Red')!
    expect(blueLines.every(l => l.sku === sku)).toBe(true)
    expect(blueLines.every(l => l.status === 'pending')).toBe(true)
    // The untouched line keeps whatever sku it had (none, pre-catalogue-match) —
    // never coerced onto the batch sku just because it's on the same manifest.
    expect(redLine.sku).not.toBe(sku)
  })

  it('matches using the same norm()/normalizeCapacity() rules the catalogue matcher uses — "128 GB" and "128GB" are the same signature, and grade/color/model comparisons are case-insensitive', async () => {
    const sku = await insertCatalogRow({ model: 'GALAXY S24', capacity: '128GB', color: 'BLACK', grade: 'B' })
    const manifestId = await createManifestWithRows([
      { model_no: 'galaxy s24', capacity: '128 GB', color: 'black', grade: 'b' },
      { model_no: 'GALAXY S24', capacity: '128G', color: 'BLACK', grade: 'B' },
    ])
    const res = await applyToBatch(manifestId, {
      sku, model: 'Galaxy S24', capacity: '128GB', color: 'Black', grade: 'B',
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { applied: number }
    expect(json.applied).toBe(2)
    const lines = await pendingLinesFor(manifestId)
    expect(lines.every(l => l.sku === sku)).toBe(true)
  })

  it('never touches a line whose status is not pending (a received line is a permanent audit record)', async () => {
    // Catalog row created AFTER the manifest upload deliberately — this
    // matches the ticket's own documented use case (operator resolves an
    // UNMATCHED line in the Confirm-SKU modal, i.e. no catalogue entry
    // existed at upload time, sku starts NULL) and, mechanically, keeps
    // resolveCatalogSkuBulk's upload-time auto-match from pre-filling the
    // sku field — which would otherwise mask this endpoint's own write.
    const manifestId = await createManifestWithRows([
      { model_no: 'Pixel 10', capacity: '256GB', color: 'Green', grade: 'A' },
      { model_no: 'Pixel 10', capacity: '256GB', color: 'Green', grade: 'A' },
    ])
    const before = await pendingLinesFor(manifestId)
    expect(before.every(l => l.sku === null)).toBe(true) // sanity: no catalogue match yet
    const sku = await insertCatalogRow({ model: 'PIXEL 10', capacity: '256GB', color: 'GREEN', grade: 'A' })
    // Flip one line to 'received' directly, simulating it having already
    // been scanned before the batch-apply runs.
    await db().prepare(`UPDATE expected_devices SET status = 'received' WHERE id = ?`).bind(before[0].id).run()

    const res = await applyToBatch(manifestId, {
      sku, model: 'Pixel 10', capacity: '256GB', color: 'Green', grade: 'A',
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { applied: number; expected_device_ids: number[] }
    expect(json.applied).toBe(1)
    expect(json.expected_device_ids).toEqual([before[1].id])

    const after = await pendingLinesFor(manifestId)
    const receivedLine = after.find(l => l.id === before[0].id)!
    expect(receivedLine.status).toBe('received')
    expect(receivedLine.sku).toBeNull() // untouched — never rewritten post-receipt
    const stillPendingLine = after.find(l => l.id === before[1].id)!
    expect(stillPendingLine.sku).toBe(sku)
  })

  // FINDING (2026-09-25, surfaced while writing this baseline suite): the
  // route's matching loop (manifests.ts:445-453) does NOT exclude
  // source_expected_device_id's own row from matchingIds — if that row is
  // itself still 'pending' (the normal case; this is called from the
  // Confirm-SKU modal typically before the source line has been scanned/
  // received), it self-matches its own derived signature and IS counted
  // in `applied`. This contradicts the route's own docstring framing
  // ("apply that SAME sku to every OTHER still-pending line") but is not
  // a route change made here — no operator instruction to alter matching
  // semantics, and re-applying the identical sku to the source row it was
  // just derived from is a harmless no-op, not a correctness bug on its
  // own. Documented here and asserted as the REAL behaviour rather than
  // the aspirational "OTHER" one, so a future change to that matching
  // loop breaks a test instead of going unnoticed either way.
  it('derives the target signature from source_expected_device_id when given, ignoring any body model/capacity/color/grade fields — and, per the finding above, also (harmlessly) re-applies to the source row itself since it is not excluded from matching', async () => {
    const manifestId = await createManifestWithRows([
      { model_no: 'iPhone 16', capacity: '512GB', color: 'Silver', grade: 'C' },
      { model_no: 'iPhone 16', capacity: '512GB', color: 'Silver', grade: 'C' },
    ])
    const sku = await insertCatalogRow({ model: 'IPHONE 16', capacity: '512GB', color: 'SILVER', grade: 'C' })
    const lines = await pendingLinesFor(manifestId)
    const sourceId = lines[0].id

    // Body fields deliberately describe a DIFFERENT, non-matching
    // signature — source_expected_device_id must win.
    const res = await applyToBatch(manifestId, {
      sku, model: 'Some Other Model', capacity: '1TB', color: 'Gold', grade: 'A',
      source_expected_device_id: sourceId,
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { applied: number; expected_device_ids: number[] }
    // Both lines match the SOURCE line's real signature (iPhone 16/512GB/
    // Silver/C) — the source row itself is NOT excluded (see finding
    // above), so both of the 2 uploaded lines are counted.
    expect(json.applied).toBe(2)
    expect(json.expected_device_ids.sort((a, b) => a - b)).toEqual(lines.map(l => l.id).sort((a, b) => a - b))
    const after = await pendingLinesFor(manifestId)
    expect(after.every(l => l.sku === sku)).toBe(true)
  })

  it('returns applied: 0 and a message, not an error, when no pending line on the manifest shares the target signature at all', async () => {
    const manifestId = await createManifestWithRows([
      { model_no: 'Unique Model X', capacity: '64GB', color: 'White', grade: 'UG' },
    ])
    // Deliberately NOT using source_expected_device_id here — passing a
    // signature via the body fields that matches NOTHING on the manifest
    // (not even the one uploaded line), which is the clean way to test
    // "zero matches" without touching the self-inclusion finding above.
    const sku = await insertCatalogRow({ model: 'COMPLETELY UNRELATED MODEL', capacity: '1TB', color: 'PURPLE', grade: 'B' })
    const res = await applyToBatch(manifestId, {
      sku, model: 'Completely Unrelated Model', capacity: '1TB', color: 'Purple', grade: 'B',
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { ok: boolean; applied: number; message?: string }
    expect(json.ok).toBe(true)
    expect(json.applied).toBe(0)
    expect(json.message).toMatch(/no other pending lines/i)
  })
})

describe('POST /api/manifests/:id/apply-sku-to-batch — validation and not-found paths', () => {
  it('400s when the manifest id is not a number', async () => {
    const res = await api('/api/manifests/NaN/apply-sku-to-batch', {
      method: 'POST', body: JSON.stringify({ sku: 'X' }),
    })
    expect(res.status).toBe(400)
  })

  it('404s when the manifest does not exist in this organisation', async () => {
    const res = await applyToBatch(999999999, { sku: 'ANY-SKU' })
    expect(res.status).toBe(404)
  })

  it('400s when sku is missing from the body', async () => {
    const manifestId = await createManifestWithRows([{ model_no: 'iPhone 17', capacity: '256GB', color: 'Blue', grade: 'A' }])
    const res = await applyToBatch(manifestId, { model: 'iPhone 17' })
    expect(res.status).toBe(400)
    const json = await res.json() as { error: string }
    expect(json.error).toMatch(/sku is required/i)
  })

  it('422s with code sku_not_in_catalog when the sku does not exist in this organisation\'s catalogue', async () => {
    const manifestId = await createManifestWithRows([{ model_no: 'iPhone 17', capacity: '256GB', color: 'Blue', grade: 'A' }])
    const res = await applyToBatch(manifestId, {
      sku: 'TOTALLY-MADE-UP-SKU-NOT-IN-CATALOG', model: 'iPhone 17', capacity: '256GB', color: 'Blue', grade: 'A',
    })
    expect(res.status).toBe(422)
    const json = await res.json() as { code: string; error: string }
    expect(json.code).toBe('sku_not_in_catalog')
    expect(json.error).toMatch(/not in the catalogue/i)
  })

  it('422s when the derived signature has no model (nothing to match other lines against)', async () => {
    const sku = await insertCatalogRow({ model: 'IPHONE 17 NO MODEL TEST', capacity: '256GB', color: 'BLUE', grade: 'A' })
    const manifestId = await createManifestWithRows([{ model_no: 'iPhone 17 No Model Test', capacity: '256GB', color: 'Blue', grade: 'A' }])
    const res = await applyToBatch(manifestId, { sku, model: '', capacity: '256GB', color: 'Blue', grade: 'A' })
    expect(res.status).toBe(422)
    const json = await res.json() as { error: string }
    expect(json.error).toMatch(/could not determine/i)
  })

  it('never applies a sku from ANOTHER organisation\'s catalogue, and never matches lines on another organisation\'s manifest', async () => {
    // Org 2's catalogue + manifest — belt-and-braces org isolation check.
    const otherOrgToken = await signAuthToken(JWT_SECRET, {
      id: 2, email: 'other-org@goodsin.local', name: 'Other Org Admin', role: 'admin', organisation_id: 2,
    })
    const otherSku = await insertCatalogRow({ model: 'IPHONE 17', capacity: '256GB', color: 'BLUE', grade: 'A', organisationId: 2 })

    const manifestId = await createManifestWithRows([{ model_no: 'iPhone 17', capacity: '256GB', color: 'Blue', grade: 'A' }])
    // Org 1's token, but org 2's sku.
    const res = await applyToBatch(manifestId, { sku: otherSku, model: 'iPhone 17', capacity: '256GB', color: 'Blue', grade: 'A' })
    expect(res.status).toBe(422)
    const json = await res.json() as { code: string }
    expect(json.code).toBe('sku_not_in_catalog')
    void otherOrgToken // referenced to document intent; org-1 token used above deliberately
  })
})

describe('POST /api/manifests/:id/apply-sku-to-batch — chunked UPDATE (>90 matching lines) and the 409 chunk_count_mismatch path', () => {
  it('applies the sku correctly when more than 90 pending lines share one signature (exercises 2 chunks under D1_IN_CHUNK_SIZE=90)', async () => {
    // Catalog row created AFTER the upload (see the note on the
    // 'never touches a line whose status is not pending' test above) so
    // every line starts sku=NULL and the 95/95 count below is genuinely
    // this endpoint's own write, not an upload-time auto-match echoed
    // back unchanged.
    const rows = Array.from({ length: 95 }, () => ({
      model_no: 'Chunk Test Model', capacity: '256GB', color: 'Black', grade: 'A',
    }))
    const manifestId = await createManifestWithRows(rows)
    const before = await pendingLinesFor(manifestId)
    expect(before.every(l => l.sku === null)).toBe(true)
    const sku = await insertCatalogRow({ model: 'CHUNK TEST MODEL', capacity: '256GB', color: 'BLACK', grade: 'A' })

    const res = await applyToBatch(manifestId, { sku, model: 'Chunk Test Model', capacity: '256GB', color: 'Black', grade: 'A' })
    expect(res.status).toBe(200)
    const json = await res.json() as { applied: number }
    expect(json.applied).toBe(95)

    const lines = await pendingLinesFor(manifestId)
    expect(lines).toHaveLength(95)
    expect(lines.every(l => l.sku === sku)).toBe(true)
  })

  // The route has zero test coverage for its 409 path prior to this file.
  // Reaching chunk_count_mismatch requires a genuine race — another write
  // moving a line off 'pending' strictly between chunk 1's UPDATE
  // resolving and chunk 2's UPDATE starting. Per the 2026-09-25 ruling:
  // no mocking library, no new dependency. A real SQLite TRIGGER (fired
  // natively by chunk 1's own UPDATE, no JS timing at all) was the first
  // choice attempted, but D1's Workers binding rejects ALL runtime DDL —
  // confirmed empirically: `CREATE TEMP TRIGGER` / `CREATE TEMP TABLE`
  // via both db.exec() and db.prepare().run() fail with
  // "D1_EXEC_ERROR: not authorized: SQLITE_AUTH". Not a syntax issue —
  // this is D1's SQLite authorizer blocking DDL from application code;
  // only migrations (via applyD1Migrations, a separate mechanism) can
  // create triggers/tables in this harness.
  //
  // Fallback used instead: a plain JS object wraps the REAL D1Database
  // binding for THIS TEST ONLY, delegating every call through to the real
  // binding untouched EXCEPT for the specific UPDATE...SET sku=? statement
  // this route issues — whose bound run() is extended to fire one real,
  // deterministic extra write (moving the chunk-2 victim off 'pending')
  // the instant chunk 1's OWN real UPDATE resolves, strictly before chunk
  // 2's UPDATE can start (runChunked awaits each chunk fully in sequence).
  // This is the same object-composition style already used everywhere in
  // this suite for `testEnv = { ...env, JWT_SECRET }` — not a mocking
  // library, not a new dependency, and every row read/write in the test
  // (including the 94 that DO get updated) is a real D1 write against the
  // real binding, not a stub return value.
  it('returns 409 chunk_count_mismatch with an operator-facing message when a line races off pending between chunks — and, per the 2026-09-25 finding, does NOT roll back the chunk(s) that already committed', async () => {
    // Catalog row created AFTER the upload, same reasoning as the two
    // tests above — every line starts sku=NULL, so "94 lines carry the
    // new sku after a 409" below is unambiguously this endpoint's own
    // partial write, not an upload-time auto-match sitting there
    // unrelated to the race.
    const rows = Array.from({ length: 95 }, () => ({
      model_no: 'Race Test Model', capacity: '256GB', color: 'Black', grade: 'A',
    }))
    const manifestId = await createManifestWithRows(rows)
    const linesBefore = await pendingLinesFor(manifestId)
    expect(linesBefore).toHaveLength(95)
    expect(linesBefore.every(l => l.sku === null)).toBe(true)
    const sku = await insertCatalogRow({ model: 'RACE TEST MODEL', capacity: '256GB', color: 'BLACK', grade: 'A' })
    const chunk2VictimId = linesBefore[90].id // first id of the 2nd 90-item chunk

    const realDb = db()
    let chunk1UpdateSeen = false
    const wrappedDb: D1Database = {
      ...realDb,
      prepare(sql: string) {
        const realStmt = realDb.prepare(sql)
        if (!sql.includes('UPDATE expected_devices SET sku = ?')) return realStmt
        return {
          ...realStmt,
          bind(...args: unknown[]) {
            const bound = realStmt.bind(...args)
            return {
              ...bound,
              async run() {
                const result = await bound.run()
                if (!chunk1UpdateSeen) {
                  chunk1UpdateSeen = true
                  // Real write against the real binding: the race itself.
                  await realDb.prepare(
                    `UPDATE expected_devices SET status = 'received' WHERE id = ? AND status = 'pending'`
                  ).bind(chunk2VictimId).run()
                }
                return result
              },
            } as unknown as D1PreparedStatement
          },
        } as unknown as D1PreparedStatement
      },
    } as unknown as D1Database

    const racedEnv = { ...testEnv, DB: wrappedDb }
    const res = await api(`/api/manifests/${manifestId}/apply-sku-to-batch`, {
      method: 'POST',
      body: JSON.stringify({ sku, model: 'Race Test Model', capacity: '256GB', color: 'Black', grade: 'A' }),
    }, racedEnv)

    expect(chunk1UpdateSeen).toBe(true) // sanity: the race actually fired
    expect(res.status).toBe(409)
    const json = await res.json() as { code: string; error: string; expected: number; actual: number }
    expect(json.code).toBe('chunk_count_mismatch')
    expect(json.expected).toBe(95)
    expect(json.actual).toBe(94)

    // Operator-facing message: must NOT claim nothing happened (that would
    // be false — see the assertion block below), and MUST tell the
    // operator retrying is safe.
    expect(json.error).not.toMatch(/no changes were made/i)
    expect(json.error.toLowerCase()).toContain('some lines may already carry the new sku')
    expect(json.error.toLowerCase()).toContain('retry')
    expect(json.error.toLowerCase()).toContain('safe')

    // The empirically-confirmed, NOT-rolled-back partial write: chunk 1's
    // 90 lines are committed with the new sku despite the 409. This is
    // asserted explicitly (not left as a console.log observation) because
    // it is the exact "worst of both outcomes" the 2026-09-25 message
    // asks to rule out — and it turns out NOT to be ruled out by the
    // current runChunked() design. Documented as a known, accepted gap
    // (see d1Chunk.ts's ChunkCountMismatchError docstring and this
    // route's catch block) rather than silently assumed fixed.
    const linesAfter = await pendingLinesFor(manifestId)
    const withNewSku = linesAfter.filter(l => l.sku === sku)
    expect(withNewSku).toHaveLength(94)
    const victim = linesAfter.find(l => l.id === chunk2VictimId)!
    expect(victim.status).toBe('received')
    expect(victim.sku).toBeNull() // the raced-off-pending line itself is untouched

    // Convergence check backing the "retrying is safe" claim in the
    // message: re-running the identical request (now with the race
    // removed) must reach a clean 200, must correctly EXCLUDE the
    // now-'received' victim (it's no longer 'pending', so the SELECT
    // never re-matches it — the route has no way to "finish" a line
    // that moved off pending, by design; that line stays excluded from
    // this signature-batch operation permanently, which is correct: a
    // received line is a permanent audit record and is never rewritten
    // here regardless of how it got there), and must NOT error or
    // double-apply anything harmful to the 94 lines that already carry
    // the correct sku (D1 counts a matched-but-unchanged row as
    // "changed" in meta.changes, so re-selecting and re-applying the
    // identical value to all 94 still-pending lines is expected and
    // harmless — this is exactly the "convergent" property the 409
    // message promises, not a no-op skip of already-correct rows).
    const retryRes = await applyToBatch(manifestId, {
      sku, model: 'Race Test Model', capacity: '256GB', color: 'Black', grade: 'A',
    })
    expect(retryRes.status).toBe(200)
    const retryJson = await retryRes.json() as { applied: number }
    expect(retryJson.applied).toBe(94) // the 94 still-pending matching lines, harmlessly re-applied
    const linesFinal = await pendingLinesFor(manifestId)
    expect(linesFinal.filter(l => l.sku === sku)).toHaveLength(94)
    const victimFinal = linesFinal.find(l => l.id === chunk2VictimId)!
    expect(victimFinal.status).toBe('received') // permanently excluded — never rewritten post-receipt
    expect(victimFinal.sku).toBeNull()
  })
})
