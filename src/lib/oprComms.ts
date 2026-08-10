// OPR — communication tracker (Ticket C): pure logic for the follow-up
// (chase) flag and the per-return outstanding-items checklist.
//
// The engine is pure (no DB access): callers fetch the rows (sent_emails,
// shipment_replies, shipments) and pass them in, keeping every rule
// unit-testable without HTTP — same discipline as oprValidation.ts /
// oprImport.ts.
//
// Follow-up rule (from the ticket): a flag trips once 3 *working* days
// (Mon–Fri only — bank holidays are explicitly ignored, per instruction)
// have elapsed since the most recent genuine send with no reply logged
// against the shipment since. A 'manual' or 'failed' send still counts as
// the thing to chase a reply on — the honesty rule (never log a non-send
// as sent) governs sent_emails.status, not whether a flag can trip; even a
// failed attempt still needs a human chase. A shipment with no sends yet
// has nothing to chase (no flag).

export type SentEmailLite = {
  status: 'sent' | 'failed' | 'manual'
  created_at: string   // ISO datetime
}

export type ShipmentReplyLite = {
  received_at: string  // ISO datetime
}

// ───────── Working-day helpers ─────────

// True for Mon–Fri. Bank holidays are deliberately NOT considered — the
// ticket explicitly says "ignore bank holidays".
export function isWorkingDay(isoDate: string): boolean {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`)
  const day = d.getUTCDay() // 0=Sun … 6=Sat
  return day >= 1 && day <= 5
}

// Number of whole working days elapsed strictly between fromIso and toIso
// (both may be full datetimes; only the calendar date is used). The start
// day itself is never counted; each subsequent Mon–Fri calendar date up to
// and including toIso's date counts once. E.g. Mon → Thu = 3 (Tue, Wed,
// Thu). Mon → Tue (next cal day) = 1. Fri → Mon = 1 (weekend skipped).
export function workingDaysBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso.slice(0, 10)}T00:00:00Z`)
  const to = new Date(`${toIso.slice(0, 10)}T00:00:00Z`)
  if (to.getTime() <= from.getTime()) return 0
  let count = 0
  const cursor = new Date(from.getTime())
  while (cursor.getTime() < to.getTime()) {
    cursor.setUTCDate(cursor.getUTCDate() + 1)
    const day = cursor.getUTCDay()
    if (day >= 1 && day <= 5) count++
  }
  return count
}

// ───────── Follow-up (chase) flag ─────────

export type FollowUpStatus = {
  flagged: boolean
  reason: string
  last_send_at: string | null
  working_days_since_send: number | null
  reply_logged_since_send: boolean
}

const FOLLOW_UP_THRESHOLD_WORKING_DAYS = 3

// nowIso defaults to real time — pass it explicitly in tests for
// deterministic fixtures.
export function computeFollowUpStatus(
  sends: SentEmailLite[],
  replies: ShipmentReplyLite[],
  nowIso: string = new Date().toISOString(),
): FollowUpStatus {
  if (sends.length === 0) {
    return { flagged: false, reason: 'No correspondence sent yet — nothing to chase', last_send_at: null, working_days_since_send: null, reply_logged_since_send: false }
  }
  const lastSend = sends.reduce((latest, s) => (s.created_at > latest.created_at ? s : latest), sends[0])
  const replyLoggedSince = replies.some(r => r.received_at > lastSend.created_at)
  if (replyLoggedSince) {
    return { flagged: false, reason: 'A reply has been logged since the last send', last_send_at: lastSend.created_at, working_days_since_send: workingDaysBetween(lastSend.created_at, nowIso), reply_logged_since_send: true }
  }
  const workingDays = workingDaysBetween(lastSend.created_at, nowIso)
  if (workingDays >= FOLLOW_UP_THRESHOLD_WORKING_DAYS) {
    return { flagged: true, reason: `${workingDays} working day(s) since the last send with no reply logged (threshold ${FOLLOW_UP_THRESHOLD_WORKING_DAYS})`, last_send_at: lastSend.created_at, working_days_since_send: workingDays, reply_logged_since_send: false }
  }
  return { flagged: false, reason: `Only ${workingDays} working day(s) since the last send (threshold ${FOLLOW_UP_THRESHOLD_WORKING_DAYS})`, last_send_at: lastSend.created_at, working_days_since_send: workingDays, reply_logged_since_send: false }
}

// ───────── Outstanding-items checklist (per return / import shipment) ─────────
//
// VAT evidence is deliberately checked as "present or not" against a
// generic free-text reference field (vat_evidence_ref) — NOT a PVA/C79
// flag. Do not hard-code either evidence type here; that decision is
// explicitly awaiting the agent (Section D point 4).

export type ChecklistItem = {
  code: string
  label: string
  done: boolean
  detail: string | null
}

export type ChecklistResult = {
  items: ChecklistItem[]
  outstanding_count: number
  complete: boolean
}

export type ChecklistShipmentLite = {
  import_mrn: string | null
  customs_entry_ref: string | null
  vat_evidence_ref: string | null
  repair_cost_confirmed_at: string | null
}

export function computeOutstandingChecklist(shipment: ChecklistShipmentLite): ChecklistResult {
  const items: ChecklistItem[] = [
    { code: 'IMPORT_MRN', label: 'Import MRN (6121 declaration)', done: !!shipment.import_mrn, detail: shipment.import_mrn ?? null },
    { code: 'CUSTOMS_ENTRY', label: 'C88 / CDS entry recorded', done: !!shipment.customs_entry_ref, detail: shipment.customs_entry_ref ?? null },
    { code: 'VAT_EVIDENCE', label: 'VAT evidence recorded', done: !!shipment.vat_evidence_ref, detail: shipment.vat_evidence_ref ?? null },
    { code: 'REPAIR_COST_CONFIRMED', label: 'Repair cost confirmed', done: !!shipment.repair_cost_confirmed_at, detail: shipment.repair_cost_confirmed_at ?? null },
  ]
  const outstanding = items.filter(i => !i.done).length
  return { items, outstanding_count: outstanding, complete: outstanding === 0 }
}
