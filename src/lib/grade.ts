// Strict grade set for this prototype.
// Anything that isn't an exact match (case-insensitive) for A | B | C | UG
// is treated as UG (ungraded). Supplier-declared grades like "B+" / "A-"
// come in via the manifest and get normalised here at import time — the
// real grade is assigned downstream at QC.

export const VALID_GRADES = ['A', 'B', 'C', 'UG'] as const
export type Grade = typeof VALID_GRADES[number]

export function normalizeGrade(raw: unknown): Grade {
  if (raw == null) return 'UG'
  const s = String(raw).trim().toUpperCase()
  if (s === 'A' || s === 'B' || s === 'C' || s === 'UG') return s
  return 'UG'
}

// "UG" → "Ungraded" for human-facing display. Stored value stays "UG".
export function gradeLabel(g: string | null | undefined): string {
  if (!g) return 'Ungraded'
  return g === 'UG' ? 'Ungraded' : g
}
