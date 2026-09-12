# Runbook — finalising shipment OPR20260826003 (external ref OPR-20260902-003-155)

Prepared 2026-09-12, after the dry-run returned 12/12 GREEN,
`red_count = 0`, `amber_count = 0`, `validation.result = 'green'`.

**This is a runbook, not an action taken on the operator's behalf.**
Nothing in this pass called `/finalise`. The operator performs every step
below themselves.

## Where

Open the shipment in the app: Shipments → OPR20260826003 (internal
reference; external/FedEx-facing reference is OPR-20260902-003-155,
recorded in the shipment's notes field) → the shipment detail page.

## What you should see before clicking Finalise

All 12 validation checks green. If anything shows amber or red, STOP —
do not finalise — and get it corrected first. As of this runbook's
writing, all checks are green; if time has passed and something has
drifted (e.g. a device removed from the consignment), re-check before
proceeding.

## The action

Click the **Finalise export** button on the shipment detail page.

## Fields to leave EMPTY at finalise time

Do not fill in any of the following — they are outbound-declaration
fields captured later, once the actual customs entry exists, not
guessed or pre-filled now:
- `export_mrn`
- `ducr`
- `ead_mrn`
- `mucr`
- `import_mrn` (this is the RETURN leg's field in any case — never
  touched by an export shipment)

## What finalise does

- Blocks outright if `validation.result === 'red'` (any check red) —
  will not happen here, since the dry-run is clean, but this is the
  gate's actual behavior (`opr.ts:1529-1530`), not merely advisory.
- Sets `status = 'FINALISED'`, stamps `finalised_at` (defaults to now
  unless a value is explicitly supplied), stamps `finalised_by_user_id`.
- Transitions every device on the consignment (all 155 lines) from
  `IN_EXPORT_CONSIGNMENT` to `EXPORTED_UNDER_OPR`.

## ⚠️ THIS IS IRREVERSIBLE

There is no un-finalise route anywhere in this codebase. Once
`status = 'FINALISED'`, the shipment cannot be reopened, and the 155
devices cannot be pulled back into DRAFT via any button or API call.
If something is wrong after finalising, it becomes a correction problem
on the FINALISED record (and potentially a customs-declaration problem),
not an undo. Confirm everything is right before clicking.

## Not this runbook's concern (already handled or explicitly deferred)

- The supervising-office code (`GBLIV002`) was corrected on
  `opr_authorisations` this session — done, verified, not part of this
  action.
- The consignee identity (`Syncere Wireless FZE`, full address, `DAP`
  incoterm) was corrected this session — done, verified.
- The vendor code `SW001` is preserved in `notes` free text, pending a
  proper `consignee_code` column in a future Task L migration — not
  blocking finalise.
- The return leg (repair cost, freight, insurance, CIF/C&E1154 duty
  base) is a SEPARATE, later action on the import-side shipment once
  the devices come back — not part of finalising this export.
