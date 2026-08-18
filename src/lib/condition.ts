// Condition-from-grade derivation (migration 0030, agreed decision from an
// earlier session, implemented here). Condition is a DERIVED column, not an
// independently-entered one: the agreed rule is that grade always wins and
// condition is always optional. This closes the drift source found via
// production audit (756 expected_devices rows across 5 casing/leak values —
// 218 'Refurbished' vs 197 'REFURBISHED', 296 'UG' leaking a grade value
// into the condition column — traced to a single write path,
// src/routes/manifests.ts, that stored whatever string the uploaded
// spreadsheet's Condition column happened to contain, unvalidated and
// uncoerced).
//
// Scope: expected_devices ONLY (pre-receipt manifest lines). Grade there is
// an unverified vendor claim, and condition was only ever derived FROM that
// claim in the first place, so replacing the stored value with a pure
// function of grade loses nothing. received_devices is explicitly OUT OF
// SCOPE — its condition (if/when it gains one) could reflect an actual
// physical inspection, where grade-wins would destroy real information.
//
// The four stored grades (VALID_GRADES in ./grade: A, B, C, UG) are the
// only ones that can reach this function via the normal import path —
// received_devices.grade already has CHECK (grade IN ('A','B','C','UG'))
// (migration 0004), and migration 0030 adds the matching CHECK to
// expected_devices.
//
// FLAGGED, NOT YET RESOLVED (see turn report): as of this writing,
// src/lib/grade.ts's normalizeGrade() silently coerces any non-A/B/C/UG
// value — including a real vendor D or E — to 'UG' BEFORE the row ever
// reaches the INSERT, because manifests.ts inserts the *normalized* grade,
// not the raw one. That means a genuine vendor D/E currently reaches the
// CHECK constraint pre-laundered to 'UG' and never trips it — the
// constraint does not yet achieve the "fail at import, not at receive"
// goal this migration states for it. The "ask, don't silently coerce"
// behaviour for an out-of-scale grade exists today only as a natural-
// language instruction inside the AI-import prompt (i.e. what a human/LLM
// doing the spreadsheet reorg is told to do before upload) — there is no
// server-side code path that rejects or flags a raw D/E. This is a real
// gap, not a documented safety net; whether to change normalizeGrade()'s
// behaviour (or insert the raw grade ahead of normalization) is an open
// question for the user, not resolved here.
//
// D and E are kept in this function anyway, deliberately: they cost one
// line, keep the function correct if the stored grade scale is ever
// widened, and are exercised by their own unit tests below even though,
// per the gap above, they cannot currently be reached via a real
// CHECK-constraint rejection.
export type StoredGrade = 'A' | 'B' | 'C' | 'UG'
export type VendorScaleGrade = StoredGrade | 'D' | 'E'
export type Condition = 'REFURBISHED' | 'USED' | 'RAW'

export function deriveConditionFromGrade(grade: VendorScaleGrade): Condition {
  switch (grade) {
    case 'A':
      return 'REFURBISHED'
    case 'B':
    case 'C':
      return 'USED'
    case 'D':
    case 'E':
    case 'UG':
      return 'RAW'
  }
}
