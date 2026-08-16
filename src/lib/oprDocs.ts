// OPR 2 — Export document generators.
//
// Pure functions: shipment + authorisation + frozen lines in, document out.
//   - buildCommercialInvoiceHtml: print-ready A4 commercial invoice (HTML,
//     browser print → PDF; no external service).
//   - buildScanOutList: IMEI/value list whose total MUST equal the invoice
//     total (both computed via the same pence-exact sum).
//   - buildPreAlertDraft: carrier customs pre-alert email draft, using the
//     mailbox/cut-off CONFIGURED ON THE AUTHORISATION (data, not code).
//
// All figures come from the frozen shipment_lines snapshots — never from
// live received_devices rows — so documents reproduce the declared truth
// even after later device edits.

import type { Shipment, ShipmentLine, OprAuthorisation } from '../types'
import { sumLineValues } from './oprValidation'

const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const gbp = (v: number): string => `£${v.toFixed(2)}`

export function buildScanOutList(shipment: Shipment, lines: ShipmentLine[]) {
  const total_value = sumLineValues(lines)
  return {
    shipment_reference: shipment.reference,
    generated_at: new Date().toISOString(),
    unit_count: lines.length,
    currency: 'GBP' as const,
    total_value,
    lines: lines.map((l, i) => ({
      position: i + 1,
      imei: l.imei,
      sku: l.sku,
      description: [l.brand, l.model, l.capacity, l.color].filter(Boolean).join(' '),
      grade: l.grade,
      unit_value: Number(l.unit_value),
    })),
  }
}

export function buildCommercialInvoiceHtml(
  shipment: Shipment,
  authorisation: OprAuthorisation,
  lines: ShipmentLine[],
): string {
  const total = sumLineValues(lines)
  const rows = lines.map((l, i) => `
      <tr>
        <td>${i + 1}</td>
        <td class="mono">${esc(l.imei)}</td>
        <td>${esc([l.brand, l.model, l.capacity, l.color].filter(Boolean).join(' '))}</td>
        <td>${esc(l.grade ?? '')}</td>
        <td class="num">1</td>
        <td class="num">${gbp(Number(l.unit_value))}</td>
      </tr>`).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Commercial Invoice — ${esc(shipment.reference)}</title>
<style>
  @page { size: A4; margin: 18mm; }
  body { font: 11pt/1.45 Arial, Helvetica, sans-serif; color: #111; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #111; padding-bottom: 10px; }
  h1 { font-size: 20pt; margin: 0; letter-spacing: 1px; }
  .meta { font-size: 9.5pt; text-align: right; }
  .parties { display: flex; gap: 24px; margin: 16px 0; }
  .party { flex: 1; border: 1px solid #bbb; padding: 10px 12px; font-size: 9.5pt; }
  .party h2 { font-size: 9pt; text-transform: uppercase; color: #666; margin: 0 0 6px; }
  .customs { background: #f4f4f4; border: 1px solid #bbb; padding: 10px 12px; font-size: 9.5pt; margin-bottom: 14px; }
  .customs strong { display: inline-block; min-width: 220px; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  th { background: #111; color: #fff; text-align: left; padding: 6px 8px; }
  td { border-bottom: 1px solid #ddd; padding: 5px 8px; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; }
  .mono { font-family: 'Courier New', monospace; }
  tfoot td { border-top: 2px solid #111; border-bottom: none; font-weight: bold; padding-top: 8px; }
  .decl { margin-top: 18px; font-size: 9pt; color: #333; border-top: 1px solid #bbb; padding-top: 10px; }
  .sig { margin-top: 28px; display: flex; gap: 40px; font-size: 9.5pt; }
  .sig div { flex: 1; border-top: 1px solid #111; padding-top: 4px; }
</style>
</head>
<body>
<header id="invoice-header">
  <div>
    <h1>COMMERCIAL INVOICE</h1>
    <div style="font-size:9.5pt; color:#555;">Goods temporarily exported for repair — Outward Processing Relief</div>
  </div>
  <div class="meta">
    <div><strong>Invoice / Consignment ref:</strong> ${esc(shipment.reference)}</div>
    <div><strong>Ship date:</strong> ${esc(shipment.ship_date ?? '(not set)')}</div>
    <div><strong>Incoterm:</strong> ${esc(shipment.incoterm ?? '(not set)')}</div>
    <div><strong>Currency:</strong> GBP</div>
  </div>
</header>

<section class="parties" id="invoice-parties">
  <div class="party">
    <h2>Exporter / Consignor</h2>
    <strong>${esc(authorisation.holder_name)}</strong><br>
    EORI: ${esc(authorisation.eori)}
  </div>
  <div class="party">
    <h2>Consignee (overseas repairer)</h2>
    <strong>${esc(shipment.consignee_name ?? '(consignee not set)')}</strong><br>
    ${esc(shipment.consignee_address ?? '')}
  </div>
</section>

<section class="customs" id="invoice-customs">
  <div><strong>Customs procedure code:</strong> ${esc(shipment.procedure_code)}${shipment.additional_procedure_code ? ' + ' + esc(shipment.additional_procedure_code) : ''}</div>
  <div><strong>OPR authorisation (CDS):</strong> ${esc(authorisation.cds_number)}</div>
  <div><strong>Supervising office:</strong> ${esc(authorisation.supervising_office_name ?? '')}</div>
  <div><strong>Commodity code(s):</strong> ${esc(authorisation.commodity_codes ?? '')}</div>
  <div><strong>Carrier:</strong> ${esc(shipment.carrier ?? '(not set)')}${shipment.carrier_account ? ' — account ' + esc(shipment.carrier_account) : ''}</div>
  <div><strong>Reason for export:</strong> Temporary export for repair and return under Outward Processing. Goods remain the property of the exporter. Values shown for customs purposes only — no sale has taken place.</div>
</section>

<table id="invoice-lines">
  <thead>
    <tr><th>#</th><th>IMEI</th><th>Description</th><th>Grade</th><th class="num">Qty</th><th class="num">Unit value (GBP)</th></tr>
  </thead>
  <tbody>${rows}
  </tbody>
  <tfoot>
    <tr>
      <td colspan="4">TOTAL</td>
      <td class="num">${lines.length}</td>
      <td class="num">${gbp(total)}</td>
    </tr>
  </tfoot>
</table>

<section class="decl" id="invoice-declaration">
  Goods identified by IMEI (serial number). The goods are being exported under Outward Processing Relief
  authorisation ${esc(authorisation.cds_number)} for repair and subsequent re-importation. Declared values represent
  the value of the goods at export and are stated in GBP.
</section>

<section class="sig">
  <div>Signature</div>
  <div>Name / position</div>
  <div>Date</div>
</section>
</body>
</html>`
}

export function buildPreAlertDraft(
  shipment: Shipment,
  authorisation: OprAuthorisation,
  lines: ShipmentLine[],
) {
  const total = sumLineValues(lines)
  const to = authorisation.prealert_email || null
  const cutoff = authorisation.prealert_cutoff || null
  const subject = `OPR export pre-alert — ${shipment.reference} — ${lines.length} unit(s) — ship ${shipment.ship_date ?? 'TBC'}`
  const body = [
    `Hello,`,
    ``,
    `Please treat this as our customs pre-alert for the following Outward Processing Relief export:`,
    ``,
    `  Consignment reference: ${shipment.reference}`,
    `  Exporter: ${authorisation.holder_name} (EORI ${authorisation.eori})`,
    `  OPR authorisation (CDS): ${authorisation.cds_number}`,
    `  Customs procedure code: ${shipment.procedure_code}${shipment.additional_procedure_code ? ' + ' + shipment.additional_procedure_code : ''}`,
    `  Supervising office: ${authorisation.supervising_office_name ?? 'see authorisation'}${authorisation.supervising_office_code ? ' (' + authorisation.supervising_office_code + ')' : ''}`,
    `  Commodity code(s): ${authorisation.commodity_codes ?? 'see invoice'}`,
    `  Consignee: ${shipment.consignee_name ?? 'TBC'}`,
    `  Carrier: ${shipment.carrier ?? 'TBC'}${shipment.carrier_account ? ' (account ' + shipment.carrier_account + ')' : ''}`,
    `  Ship date: ${shipment.ship_date ?? 'TBC'}`,
    `  Units: ${lines.length}`,
    `  Total declared value: £${total.toFixed(2)} GBP`,
    ``,
    `The commercial invoice and IMEI scan-out list are attached. Goods are identified by IMEI.`,
    `Please confirm receipt${cutoff ? ` — pre-alert cut-off ${cutoff}` : ''}.`,
    ``,
    `Kind regards`,
  ].join('\n')

  return {
    to,
    to_configured: to !== null,
    cutoff,
    subject,
    body,
    note: to
      ? `Draft only — no email is sent by the system. Send to ${to}${cutoff ? ` before ${cutoff}` : ''}.`
      : 'Draft only — no pre-alert mailbox is configured on the authorisation (set prealert_email); no email is sent by the system.',
  }
}
