// MANIFEST_CLEANUP_PROMPT snapshot/consistency test — pure text assertions
// against public/static/app.js's source, no DB/HTTP/browser involved.
//
// This prompt is copy-pasted by an operator into an in-Excel AI assistant
// (Copilot in Excel / Claude in Excel) to reorganise a supplier's manifest
// BEFORE it ever reaches our upload mapper. Nothing here enforces that the
// AI assistant actually follows the prompt — that can only be checked by
// eye on a real cleaned sheet. What this test DOES guard against is silent
// drift between:
//   (a) the prompt's STEP 2 canonical header line, and
//   (b) MAPPABLE_FIELDS (public/static/app.js) — the accepted-column list
//       the upload mapper actually auto-detects against,
// plus regression coverage for the rule fixes made in the v2-2026-08-18
// pass (LW001 manifest-14 follow-up): the Storage/capacity direction bug
// (Rule 4 used to instruct "1TB -> convert to 1024GB", backwards relative
// to normalizeCapacity()'s real canonical form — see src/lib/catalog.ts
// and test/catalog.spec.ts), the D/E-grade coercion, the silent
// duplicate-IMEI deletion, and the missing mixed-currency stop rule.
//
// Runs against the raw app.js TEXT (Vite `?raw` import, same technique as
// test/ce1154Golden.spec.ts's fixture files) rather than executing the
// file — app.js is a browser IIFE that reaches for `document`/
// `localStorage` at module-eval time and isn't meant to run under
// workerd/node.
import { describe, it, expect } from 'vitest'
// eslint-disable-next-line import/no-unresolved
import appJsRaw from '../public/static/app.js?raw'

const appJs: string = appJsRaw

function extractConst(name: string): string {
  // Matches: const NAME = 'value';  (single-quoted string literal)
  const m = appJs.match(new RegExp(`const ${name} = '([^']*)';`))
  if (!m) throw new Error(`Could not find const ${name} in app.js`)
  return m[1]
}

function extractTemplateConst(name: string): string {
  // Matches: const NAME = `....`;  (template literal, non-greedy to the
  // first line that is just a closing backtick+semicolon at the start of
  // a statement — MANIFEST_CLEANUP_PROMPT's own closing is `...`; on its
  // own trailing text, so anchor on the specific `);` pattern that ends it).
  const start = appJs.indexOf(`const ${name} = \``)
  if (start === -1) throw new Error(`Could not find const ${name} in app.js`)
  const contentStart = start + `const ${name} = \``.length
  const end = appJs.indexOf('`;', contentStart)
  if (end === -1) throw new Error(`Could not find closing backtick for ${name}`)
  return appJs.slice(contentStart, end)
}

const PROMPT_VERSION = extractConst('MANIFEST_CLEANUP_PROMPT_VERSION')
const PROMPT = extractTemplateConst('MANIFEST_CLEANUP_PROMPT')

describe('MANIFEST_CLEANUP_PROMPT version', () => {
  it('has a version string', () => {
    expect(PROMPT_VERSION).toMatch(/^v\d+-\d{4}-\d{2}-\d{2}$/)
  })

  it('is the expected v2-2026-08-18 pass (bump both together if this ever changes)', () => {
    expect(PROMPT_VERSION).toBe('v2-2026-08-18')
  })

  it('the version string is echoed inside the prompt text itself', () => {
    expect(PROMPT).toContain(PROMPT_VERSION.replace('v2-', 'v2 — '))
  })
})

describe('MANIFEST_CLEANUP_PROMPT STEP 2 header vs MAPPABLE_FIELDS', () => {
  // The exact accepted-column order/labels the upload mapper auto-detects
  // against, transcribed from MAPPABLE_FIELDS' `label` values (with the
  // required-field "*" markers stripped, since the prompt's header line
  // is plain column names, not the mapper's UI labels).
  const EXPECTED_HEADER_COLUMNS = [
    'IMEI', 'OEM', 'Model No.', 'Storage', 'Color', 'Grade',
    'Description', 'Condition', 'Unit Cost', 'Currency', 'VAT Type',
  ]

  it('STEP 2 declares exactly the 11 canonical columns, in order', () => {
    const headerLine = EXPECTED_HEADER_COLUMNS.join(' | ')
    expect(PROMPT).toContain(headerLine)
  })

  it('every MAPPABLE_FIELDS key has a corresponding column named in the prompt', () => {
    const mappableMatch = appJs.match(/const MAPPABLE_FIELDS = \[([\s\S]*?)\n  \];/)
    expect(mappableMatch).not.toBeNull()
    const fieldsBlock = mappableMatch![1]
    // 11 field entries expected (imei, oem, model_no, capacity, color,
    // grade, description, condition, unit_cost, currency, vat_type).
    const keys = [...fieldsBlock.matchAll(/key:\s*'(\w+)'/g)].map((m) => m[1])
    expect(keys).toEqual([
      'imei', 'oem', 'model_no', 'capacity', 'color', 'grade',
      'description', 'condition', 'unit_cost', 'currency', 'vat_type',
    ])
  })
})

describe('MANIFEST_CLEANUP_PROMPT rule content (v2 fixes)', () => {
  it('Rule 4 (Storage) no longer instructs converting TB into "1024GB" (the bug)', () => {
    expect(PROMPT).not.toMatch(/convert to "1024GB"/)
    expect(PROMPT).not.toMatch(/convert to "2048GB"/)
  })

  it('Rule 4 (Storage) instructs folding 1024/2048 GB into 1TB/2TB, matching the catalogue', () => {
    expect(PROMPT).toMatch(/1024.*(?:->|→).*1TB|convert to "1TB"/s)
    expect(PROMPT).toMatch(/2048.*(?:->|→).*2TB|convert to "2TB"/s)
  })

  it('Rule 1 (IMEI) requires the Luhn checksum on the 15-digit form only', () => {
    expect(PROMPT).toMatch(/Luhn/)
    expect(PROMPT).toContain('Bad IMEI checksum')
    // The 10-char alphanumeric serial path must still be explicitly exempt.
    expect(PROMPT).toMatch(/10 alphanumeric characters[^.]*—\s*no checksum/i)
  })

  it('Rule 1 (IMEI) reports duplicates instead of silently deleting them', () => {
    expect(PROMPT).not.toMatch(/Delete exact duplicate IMEI rows/)
    expect(PROMPT).toContain('Duplicate IMEI')
    expect(PROMPT).toMatch(/do not do this yourself|leave every occurrence|Do NOT delete duplicate IMEI/i)
  })

  it('Rule 6 (Grade) passes a vendor D or E through literally instead of coercing to UG', () => {
    expect(PROMPT).toMatch(/"Grade D"[\s\S]{0,20}→ D/)
    expect(PROMPT).toMatch(/"Grade E"[\s\S]{0,40}→ E/)
    expect(PROMPT).toMatch(/passed through\s+as literal D or E/i)
  })

  it('Rule 8 (Condition) is optional and uses the app\'s uppercase stored values', () => {
    expect(PROMPT).toMatch(/OPTIONAL/)
    expect(PROMPT).toContain('RAW')
    expect(PROMPT).toContain('USED')
    expect(PROMPT).toContain('REFURBISHED')
    // lowercase "Raw"/"Used"/"Refurbished" as column VALUES (not just as
    // mapped-from supplier wording in quotes) should no longer appear.
    expect(PROMPT).not.toMatch(/- Raw {10}—/)
  })

  // Owner decision 2026-08-18 (see src/lib/condition.ts's "RESOLVED" note):
  // NEW is dropped, not merely deprioritised. deriveConditionFromGrade()
  // cannot produce it and migration 0030's CHECK constraint doesn't admit
  // it, so a prompt that told operators to write NEW would produce a
  // permanent, unclearable condition_discrepancies flag on every such row
  // — worse than the value not existing at all.
  it('Rule 8 (Condition) no longer offers NEW as a valid value', () => {
    expect(PROMPT).not.toMatch(/-\s*NEW\s+—/)
    expect(PROMPT).not.toMatch(/"New"\/\s*\n?\s*"Brand New"\/"Sealed"\/"Unused" → NEW/)
    // "New"/"Brand New" etc. may still appear as vendor wording to detect
    // and leave blank (not map away silently), but never as a mapping
    // target — the four-way conjunction "→ NEW" must not occur anywhere.
    expect(PROMPT).not.toMatch(/→ NEW\b/)
  })

  it('the MAPPABLE_FIELDS Condition hint no longer lists New as an option', () => {
    const hintMatch = appJs.match(/key: 'condition',\s*label: 'Condition',\s*hint: '([^']*)'/)
    expect(hintMatch).not.toBeNull()
    expect(hintMatch![1]).not.toMatch(/New/)
  })

  it('Rule 10 (Currency) stops on mixed currencies rather than silently merging them', () => {
    expect(PROMPT).toMatch(/STOP if you find more than one distinct currency/i)
  })

  it('General cleanup keeps extra operational columns to the right, not interleaved', () => {
    expect(PROMPT).toMatch(/to the RIGHT of the 11 canonical headers/)
    expect(PROMPT).toContain('Invoice No.')
  })

  it('STEP 1 no longer asks the operator to pick one Condition for the whole file', () => {
    // The dead "if there is no condition column at all, ASK ME whether
    // every device..." STEP 1 bullet must be gone — Condition is now an
    // optional cross-check (Rule 8), not something to interrogate upfront.
    expect(PROMPT).not.toMatch(/no condition column at all, ASK ME whether every\s*\n\s*device/i)
  })

  it('the closing summary reports duplicate IMEI rows by number, not a deleted count', () => {
    expect(PROMPT).not.toMatch(/how many duplicate IMEIs were removed/)
    expect(PROMPT).toMatch(/list their row numbers/i)
  })
})
