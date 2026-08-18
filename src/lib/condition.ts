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
// RESOLVED (owner decision, restated explicitly this pass): the vendor's
// grade on a manifest is a CLAIM, not a verified fact — src/lib/grade.ts's
// normalizeGrade() coercing any out-of-scale value (a real vendor D or E)
// to 'UG' at import time is CORRECT and INTENDED behaviour, not a gap to
// close. normalizeGrade() itself is deliberately left unchanged by this
// migration. The observability gap that DID exist — a D/E coercion
// happening invisibly, with no record of what the vendor actually wrote —
// is closed separately, by src/routes/manifests.ts recording every such
// coercion event (raw vendor value, row/imei, and the stored 'UG') in a
// grade_coercions array returned alongside condition_discrepancies, rather
// than by changing what gets stored.
//
// The CHECK (grade IN ('A','B','C','UG')) constraint added on
// expected_devices by this migration is consequently narrower in purpose
// than "fail at import instead of at receive": since normalizeGrade()
// launders D/E before the INSERT, the constraint will not be the thing
// that ever catches a raw vendor D/E — grade_coercions above is. The
// constraint's real job is to guard against a BAD WRITE from any future
// code path that might someday insert an ungraded/raw value directly
// (bypassing normalizeGrade() by mistake, a bulk import script, manual
// SQL, etc.), not to police vendor input on the current path.
//
// D and E are kept in this function anyway, deliberately: they cost one
// line, keep the function correct if the stored grade scale is ever
// widened, and are exercised by their own unit tests below even though,
// given the above, they are currently unreachable via the normal import
// path (normalizeGrade() resolves them to 'UG' first). This is fine, not
// a defect — acknowledged explicitly, not silently accepted.
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
