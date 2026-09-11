// Step 2A gap (a) — bulk serial list with per-serial outcome, for the
// consignment builder (POST /shipments/:id/bulk-serials, src/routes/opr.ts).
//
// Everything PARSING/CLASSIFICATION-related here is PURE (no D1), matching
// the established convention in oprImport.ts/skuMapImport.ts/
// zohoSaleImport.ts — so the column-mapping, duplicate-detection and
// outcome-bucketing rules are unit-testable without HTTP or a database.
// The actual write (inserting shipment_lines / calling transitionDevice)
// stays in the route handler, which reuses the EXISTING
// addDeviceToShipment / addDeviceToReturnShipment gates verbatim — this
// module never duplicates that write-path logic, only decides which
// serials are even worth attempting and reports the rest with an
// explicit, never-silent-default outcome.
//
// Matching discipline: case-insensitive, no Luhn validation — same
// precedent as zohoSaleImport.ts's normaliseSerialForMatch/
// classifySerialShape (an IMEI shape is never validated against its
// check digit anywhere in this codebase; shape/case normalisation only).

// ───────── Input parsing: bare list OR column-mapped CSV ─────────
//
// "Paste or upload, one column of serials is the only hard requirement,
// small column-mapping step (supplier layouts vary)" — so two input
// shapes are supported:
//   1. No column mapping requested: every non-blank line IS a serial
//      (the common "paste a list" case — one column, nothing else).
//   2. Column mapping requested (serialColumn given): line 1 is treated
//      as a CSV header row, and the named column is extracted from every
//      subsequent data row (the "upload a supplier manifest" case).

// Minimal RFC4180-ish CSV line splitter — same shape as the parser
// already used in skuMapImport.ts/zohoSaleImport.ts (kept as a local
// copy rather than a shared import so this module has zero dependencies
// on those unrelated importers' modules).
function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = false }
      } else {
        cur += ch
      }
    } else {
      if (ch === '"') inQuotes = true
      else if (ch === ',') { cells.push(cur); cur = '' }
      else cur += ch
    }
  }
  cells.push(cur)
  return cells
}

export type BulkSerialParseResult =
  | { ok: true; serials: string[] }
  | { ok: false; error: string }

export function parseBulkSerialInput(raw: string, serialColumn?: string): BulkSerialParseResult {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n').filter(l => l.trim() !== '')
  if (lines.length === 0) return { ok: false, error: 'No serials found in input' }

  if (!serialColumn) {
    // Bare list: every non-blank line is a serial, verbatim (trimmed of
    // surrounding whitespace only — case normalisation happens later, at
    // matching time, never at parse time, so the ORIGINAL text is what
    // gets reported back to the operator per serial).
    return { ok: true, serials: lines.map(l => l.trim()) }
  }

  const header = parseCsvLine(lines[0]).map(h => h.trim())
  const idx = header.indexOf(serialColumn)
  if (idx === -1) {
    return { ok: false, error: `Column '${serialColumn}' not found in header (found: ${header.join(', ')})` }
  }
  const serials: string[] = []
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line)
    serials.push((cells[idx] ?? '').trim())
  }
  return { ok: true, serials }
}

// ───────── Per-serial outcome classification ─────────
//
// Outcome vocabulary, exactly as specified: matched / unknown /
// already_sold / already_out — plus duplicate_in_submission, a SEPARATE
// concern (submission-shape hygiene, not device-state) reported
// independently so it is never confused with a real already_out
// conflict. NEVER a silent default: every serial gets exactly one of
// these five explicit outcomes, never an implicit "ok" or an omission.
//
// already_on_this_shipment is the idempotency case: re-submitting the
// identical list must not error or double-insert a line that's already
// on THIS shipment — it is reported as its own explicit, non-error
// outcome (ok:true, no new write attempted) rather than being folded
// into the true-conflict already_out bucket (which means the device is
// unavailable for a DIFFERENT reason — sitting elsewhere in the
// lifecycle, not idempotently already-here).
export type BulkSerialOutcome =
  | { serial: string; normalised: string; outcome: 'unknown' }
  | { serial: string; normalised: string; outcome: 'duplicate_in_submission' }
  | { serial: string; normalised: string; outcome: 'already_sold'; deviceId: number }
  | { serial: string; normalised: string; outcome: 'already_on_this_shipment'; deviceId: number }
  | { serial: string; normalised: string; outcome: 'already_out'; deviceId: number; status: string }
  | { serial: string; normalised: string; outcome: 'matched'; deviceId: number }

export function normaliseBulkSerial(serial: string): string {
  return serial.trim().toUpperCase()
}

export interface BulkSerialDeviceLookup {
  id: number
  status: string
}

// devicesByImeiUpper: IMEI (upper-cased) -> { id, status }, built by the
// route from a single batched D1 read before calling this function — no
// D1 access happens inside this module.
// deviceIdsOnThisShipment: ids already present as a shipment_lines row
// on the TARGET shipment (for the idempotent-resubmission case).
export function classifyBulkSerials(
  serials: string[],
  devicesByImeiUpper: ReadonlyMap<string, BulkSerialDeviceLookup>,
  expectedStatus: string,
  deviceIdsOnThisShipment: ReadonlySet<number>,
): BulkSerialOutcome[] {
  const seen = new Set<string>()
  const outcomes: BulkSerialOutcome[] = []

  for (const serial of serials) {
    const normalised = normaliseBulkSerial(serial)

    if (!normalised) {
      outcomes.push({ serial, normalised, outcome: 'unknown' })
      continue
    }

    // Duplicate-within-submission check runs BEFORE the device lookup —
    // a serial repeated in the same paste/upload is reported once as
    // 'matched'/etc for its first occurrence, and every subsequent
    // occurrence is 'duplicate_in_submission', never re-attempted.
    if (seen.has(normalised)) {
      outcomes.push({ serial, normalised, outcome: 'duplicate_in_submission' })
      continue
    }
    seen.add(normalised)

    const device = devicesByImeiUpper.get(normalised)
    if (!device) {
      outcomes.push({ serial, normalised, outcome: 'unknown' })
      continue
    }

    if (device.status === 'SOLD') {
      outcomes.push({ serial, normalised, outcome: 'already_sold', deviceId: device.id })
      continue
    }

    if (device.status === expectedStatus) {
      outcomes.push({ serial, normalised, outcome: 'matched', deviceId: device.id })
      continue
    }

    // Not eligible AND not SOLD. If it's already a line on THIS exact
    // shipment, that's the idempotent-resubmission case (e.g. the
    // device moved READY_FOR_EXPORT -> IN_EXPORT_CONSIGNMENT the first
    // time it was added here) — report it as informational, not a
    // conflict, and never attempt a second insert.
    if (deviceIdsOnThisShipment.has(device.id)) {
      outcomes.push({ serial, normalised, outcome: 'already_on_this_shipment', deviceId: device.id })
      continue
    }

    // Any other non-eligible, non-SOLD status: genuinely unavailable for
    // this operation right now (on a different open consignment, already
    // exported/returned, mid-repair, rejected, etc). Reported verbatim
    // with the real status string so the operator can see WHY, never
    // collapsed into an unexplained generic failure.
    outcomes.push({ serial, normalised, outcome: 'already_out', deviceId: device.id, status: device.status })
  }

  return outcomes
}
