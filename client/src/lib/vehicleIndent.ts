// Vehicle Indent - the sheet of loading codes a transport office is sent.
//
// This used to be a PNG captured off the screen with html-to-image. A picture
// cannot be printed at a sane size, cannot be searched, blurs the moment the
// office forwards it twice, and - because it was drawn out of the app's own
// furniture - looked like a screenshot of software rather than a document from
// a mill.
//
// It is now built exactly the way the Statement of Account is (lib/partyStatement.ts):
// a self-contained A4 HTML document opened in a new tab, where the browser's
// own print dialog turns it into a PDF. Same letterhead, same panel grid, same
// dark-banded table, same signature block - so everything that leaves this
// company looks like it came from the same desk.
//
// Several transporters print as one file: each is a `.sheet` that starts on a
// fresh page, so the planner gets one PDF for the whole week's correspondence
// instead of six downloads.
//
// The buyer is deliberately absent, exactly as in the WhatsApp indent: the
// transporter needs the code, the day, the size and the two places; who bought
// the goods is ours, and on a shared number it would be a leak rather than a
// courtesy.

import type { CompanyProfile, DispatchSlot } from './types';
import { SIGNATURE_BLOCK_CSS, signatureBlockHtml } from './signatureAssets';

export interface VehicleIndentParty {
  name: string;
  phone?: string | null;
  phone2?: string | null;
}

export interface VehicleIndentSheet {
  transporter: VehicleIndentParty;
  /** Already filtered to live slots and sorted by date, then sequence. */
  slots: DispatchSlot[];
  /** "17 Nov - 23 Nov" or "17 Nov onwards" - the window this sheet covers. */
  rangeLabel: string;
}

export interface VehicleIndentOptions {
  company: CompanyProfile | null | undefined;
  sheets: VehicleIndentSheet[];
  /** Fires the print dialog on load. Off for an on-screen preview. */
  print?: boolean;
}

/* ------------------------------------------------------------------ format */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** `2026-11-17` -> `Monday, 17 Nov 2026`, read off the key with no timezone trip. */
function dayLong(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return `${DOW[new Date(y, m - 1, d).getDay()]}, ${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
}

function dayShort(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${String(y).slice(2)}`;
}

function longDate(d: Date): string {
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function stamp(): string {
  return new Date().toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** `35 Tons` - the size as the transport office says it out loud. */
function tonsLabel(kg: number): string {
  const t = kg / 1000;
  return `${Number.isInteger(t) ? t : Number(t.toFixed(2))} Tons`;
}

function tonsShort(kg: number): string {
  const t = kg / 1000;
  return Number.isInteger(t) ? `${t} t` : `${t.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} t`;
}

/**
 * `17-11-2026` -> `RVP/VI/171126`, plus a per-sheet suffix so two transporters
 * printed the same day do not quote the same reference back at us.
 */
export function indentRefNo(companyName: string, issued: Date, seq = 1): string {
  const w = companyName.trim().split(/\s+/).filter(Boolean);
  const mark = (w[0]?.length ?? 0) <= 4 ? (w[0] ?? 'RVP') : w.map((x) => x[0]).join('').slice(0, 3);
  const dd = String(issued.getDate()).padStart(2, '0');
  const mm = String(issued.getMonth() + 1).padStart(2, '0');
  const yy = String(issued.getFullYear()).slice(2);
  return `${mark.toUpperCase()}/VI/${dd}${mm}${yy}-${String(seq).padStart(2, '0')}`;
}

export const indentFileName = (name: string) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'transporter'}-vehicle-indent`;

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function kv(label: string, value: string | null | undefined, mono = false): string {
  if (!value) return '';
  return `<div class="kv"><span class="kv-l">${esc(label)}</span><span class="kv-v${mono ? ' mono' : ''}">${esc(value)}</span></div>`;
}

/* -------------------------------------------------------------------- CSS */

const INDENT_CSS = `
  :root{
    --ink:#111827; --muted:#6b7280; --line:#e5e7eb; --hair:#d1d5db;
    --brand:#ad4f0a; --brand-soft:#fdf6ee; --band:#1f2937;
  }
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;}
  body{
    font-family:"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    color:var(--ink); background:#eef0f3; font-size:11px; line-height:1.35;
    -webkit-print-color-adjust:exact; print-color-adjust:exact;
  }
  .sheet{width:210mm; min-height:297mm; margin:14px auto; padding:12mm 11mm 16mm;
         background:#fff; box-shadow:0 6px 28px rgba(15,23,42,.16);
         display:flex; flex-direction:column;}
  .sheet + .sheet{break-before:page; page-break-before:always;}
  .mono{font-family:"Consolas","SF Mono",monospace; letter-spacing:.2px;}

  /* ---------- letterhead ---------- */
  .head{display:flex; justify-content:space-between; align-items:flex-start; gap:16px;
        border-bottom:2.5px solid var(--brand); padding-bottom:9px;}
  .co-name{font-size:22px; font-weight:800; letter-spacing:.4px; color:var(--brand);
           text-transform:uppercase; line-height:1.1;}
  .co-tag{font-size:9.5px; letter-spacing:2.2px; text-transform:uppercase; color:var(--muted); margin-top:2px;}
  .co-lines{margin-top:6px; font-size:10px; color:#374151; max-width:105mm;}
  .co-lines div{margin-top:1px;}
  .doc{text-align:right; flex:0 0 auto;}
  .doc-title{font-size:15px; font-weight:800; letter-spacing:2.4px; text-transform:uppercase;}
  .doc-rule{height:2px; background:var(--band); margin:4px 0 6px;}
  .doc-meta{font-size:9.5px; color:var(--muted);}
  .doc-meta b{color:var(--ink); font-weight:600;}

  /* ---------- panels ---------- */
  .panels{display:grid; grid-template-columns:1.15fr 1fr 1fr; margin-top:10px; border:1px solid var(--hair);}
  .panel{padding:8px 10px; border-right:1px solid var(--hair);}
  .panel:last-child{border-right:0;}
  .panel-h{font-size:8px; letter-spacing:1.6px; text-transform:uppercase; color:var(--muted);
           font-weight:700; margin-bottom:4px;}
  .party-name{font-size:14px; font-weight:700; line-height:1.2;}
  .party-sub{font-size:9.5px; color:var(--muted); margin-top:2px;}
  .tag{display:inline-block; font-size:8px; font-weight:700; letter-spacing:.8px; text-transform:uppercase;
       border:1px solid var(--hair); border-radius:99px; padding:1px 7px; color:#374151;
       margin-left:6px; vertical-align:1px;}
  .kv{display:flex; gap:6px; font-size:9.5px; margin-top:2px;}
  .kv-l{color:var(--muted); flex:0 0 62px;}
  .kv-v{font-weight:600; flex:1;}
  .note{font-size:8.8px; color:var(--muted); line-height:1.45;}

  /* ---------- summary strip ---------- */
  .summary{display:grid; grid-template-columns:repeat(4,1fr); margin-top:9px;
           border:1px solid var(--hair); background:var(--brand-soft);}
  .sum{padding:7px 10px; border-right:1px solid var(--hair);}
  .sum:last-child{border-right:0;}
  .sum-l{font-size:8px; letter-spacing:1.3px; text-transform:uppercase; color:var(--muted); font-weight:700;}
  .sum-v{font-size:14px; font-weight:700; margin-top:2px; font-variant-numeric:tabular-nums;}
  .sum-v small{font-size:9px; font-weight:700; margin-left:3px; color:var(--muted);}
  .sum.accent{background:var(--band);}
  .sum.accent .sum-l{color:#9ca3af;}
  .sum.accent .sum-v{color:#fff;}
  .sum.accent .sum-v small{color:#9ca3af;}

  /* ---------- register ---------- */
  table{width:100%; border-collapse:collapse; margin-top:10px; table-layout:fixed;}
  thead th{background:var(--band); color:#fff; font-size:8.5px; font-weight:700;
           letter-spacing:1.1px; text-transform:uppercase; padding:6px; text-align:left;
           border-right:1px solid rgba(255,255,255,.14);}
  thead th:last-child{border-right:0;}
  thead th.c{text-align:center;}
  tbody td{padding:6px; border-bottom:1px solid var(--line); vertical-align:middle;}
  tbody tr.zebra td{background:#fafafa;}
  tbody tr.day td{background:var(--brand-soft); border-bottom:1px solid var(--hair);
                  border-top:1px solid var(--hair); padding:4px 6px;}
  .day-l{font-size:10px; font-weight:700; letter-spacing:.3px;}
  .day-r{float:right; font-size:8.5px; font-weight:700; letter-spacing:1.2px;
         text-transform:uppercase; color:var(--brand);}
  .c-no{text-align:center; color:var(--muted); font-size:9.5px;}
  .code{font-family:"Consolas","SF Mono",monospace; font-size:12px; font-weight:700; letter-spacing:.6px;}
  .size{font-weight:700; white-space:nowrap;}
  .dest{font-size:10.5px; font-weight:600;}
  .dest small{display:block; font-weight:400; color:var(--muted); font-size:8.8px; margin-top:1px;}
  .pt{display:inline-block; font-size:8px; font-weight:700; letter-spacing:.8px; text-transform:uppercase;
      border:1px solid var(--hair); background:#f3f4f6; border-radius:3px; padding:1px 6px;}
  .veh{font-family:"Consolas","SF Mono",monospace; font-weight:700; font-size:10.5px;}
  .blank{display:block; border-bottom:1px dotted #9ca3af; height:12px;}
  tfoot td{border-top:1.5px solid var(--band); border-bottom:1.5px solid var(--band);
           padding:6px; font-weight:700; font-size:10.5px; background:#f9fafb;}
  tr{break-inside:avoid; page-break-inside:avoid;}
  .empty{text-align:center; color:var(--muted); padding:22px 0;}

  /* ---------- lower ---------- */
  .lower{display:grid; grid-template-columns:1.3fr 1fr; gap:12px; margin-top:12px;}
  .box{border:1px solid var(--hair); padding:8px 10px; break-inside:avoid; page-break-inside:avoid;}
  .box-h{font-size:8px; letter-spacing:1.6px; text-transform:uppercase; color:var(--muted);
         font-weight:700; margin-bottom:5px;}
  .terms{margin:0; padding-left:14px; font-size:9.2px; color:#374151; line-height:1.55;}
  .terms li{margin-top:2px;}
  .terms b{font-weight:700;}
  .sign{margin-top:14px; text-align:right;}
  ${SIGNATURE_BLOCK_CSS}
  .sig-for{font-size:10px;}
  .sig-mark{margin-top:4px;}
  .sig-caption{border-top-color:var(--hair); font-size:9px; color:var(--muted);}
  .foot{display:flex; justify-content:space-between; margin-top:auto; padding-top:6px;
        border-top:1px solid var(--line); font-size:8.5px; color:#9ca3af;}

  @page{size:A4 portrait; margin:11mm 10mm 12mm;}
  @media print{
    body{background:#fff;}
    .sheet{width:auto; min-height:0; margin:0; padding:0; box-shadow:none;}
    thead{display:table-header-group;}
  }
`;

/* ------------------------------------------------------------------ sheet */

function sheetHtml(s: VehicleIndentSheet, company: CompanyProfile | null | undefined, refNo: string): string {
  const companyName = company?.tradeName || company?.name || 'RVP INDUSTRIES';
  const companyAddr = [company?.address?.replace(/\n/g, ', '), company?.pincode].filter(Boolean).join(' - ');
  const companyState = [company?.stateName, company?.stateCode ? `(${company.stateCode})` : null]
    .filter(Boolean).join(' ');

  // One block per loading day, in date order; the day is a band across the
  // register rather than a merged cell, so a day split by a page break still
  // reads correctly on the second page.
  const byDay = new Map<string, DispatchSlot[]>();
  for (const slot of s.slots) {
    const list = byDay.get(slot.dateKey) ?? [];
    list.push(slot);
    byDay.set(slot.dateKey, list);
  }
  const days = [...byDay.entries()];

  const totalKg = s.slots.reduce((sum, x) => sum + x.vehicleClassKg, 0);
  const pending = s.slots.filter((x) => !x.lorryNumber).length;
  const points = [...new Set(s.slots.map((x) => x.loadingPoint))].join(' / ');
  const phones = [s.transporter.phone, s.transporter.phone2].filter(Boolean).join(' / ');

  let n = 0;
  const rows = days.map(([key, daySlots]) => {
    const band = `
      <tr class="day">
        <td colspan="7">
          <span class="day-l">${esc(dayLong(key))}</span>
          <span class="day-r">${daySlots.length} ${daySlots.length === 1 ? 'vehicle' : 'vehicles'} &nbsp;·&nbsp; ${esc(tonsShort(daySlots.reduce((t, x) => t + x.vehicleClassKg, 0)))}</span>
        </td>
      </tr>`;
    const body = daySlots.map((slot) => {
      n += 1;
      return `
      <tr${n % 2 === 0 ? ' class="zebra"' : ''}>
        <td class="c-no">${n}</td>
        <td class="code">${esc(slot.code)}</td>
        <td>${esc(dayShort(key))}</td>
        <td class="size">${esc(tonsLabel(slot.vehicleClassKg))}</td>
        <td class="dest">${esc(slot.saleOrder.destination || '-')}<small>${esc(String(slot.saleOrder.product || '').replace(/_/g, ' '))}</small></td>
        <td style="text-align:center"><span class="pt">${esc(slot.loadingPoint)}</span></td>
        <td class="veh">${slot.lorryNumber ? esc(slot.lorryNumber) : '<span class="blank"></span>'}</td>
      </tr>`;
    }).join('');
    return band + body;
  }).join('');

  return `
<div class="sheet">

  <div class="head">
    <div>
      <div class="co-name">${esc(companyName)}</div>
      <div class="co-tag">Tamarind Seed Processing</div>
      <div class="co-lines">
        ${companyAddr ? `<div>${esc(companyAddr)}</div>` : ''}
        <div>${[
          company?.gstin ? `GSTIN: ${company.gstin}` : null,
          companyState ? `State: ${companyState}` : null,
        ].filter(Boolean).map(esc).join('&nbsp;&nbsp;·&nbsp;&nbsp;')}</div>
        ${company?.contact ? `<div>Phone: ${esc(company.contact)}</div>` : ''}
      </div>
    </div>
    <div class="doc">
      <div class="doc-title">Vehicle Indent</div>
      <div class="doc-rule"></div>
      <div class="doc-meta">
        <div>Indent No.&nbsp; <b class="mono">${esc(refNo)}</b></div>
        <div>Date&nbsp; <b>${esc(longDate(new Date()))}</b></div>
        <div>Period&nbsp; <b>${esc(s.rangeLabel)}</b></div>
      </div>
    </div>
  </div>

  <div class="panels">
    <div class="panel">
      <div class="panel-h">Indent Raised On</div>
      <div class="party-name">M/s. ${esc(s.transporter.name)}<span class="tag">Transporter</span></div>
      <div class="party-sub">Placement of vehicles as scheduled below</div>
      <div style="margin-top:5px">
        ${kv('Phone', phones)}
        ${kv('Vehicles', `${s.slots.length} against ${days.length} ${days.length === 1 ? 'loading day' : 'loading days'}`)}
      </div>
    </div>
    <div class="panel">
      <div class="panel-h">Reporting Point</div>
      ${kv('Load at', points, false)}
      ${kv('Place', company?.dispatchFromPlace ?? null)}
      <div class="panel-h" style="margin-top:8px">Confirm To</div>
      ${kv('Dispatch', company?.contact ?? null)}
    </div>
    <div class="panel">
      <div class="panel-h">How To Read This</div>
      <div class="note">
        Every vehicle carries a <b>loading code</b>. The code never changes, even if the
        date moves. Quote the code - not the date - in every message, and write the
        vehicle number against it below before placement.
      </div>
    </div>
  </div>

  <div class="summary">
    <div class="sum">
      <div class="sum-l">Vehicles Indented</div>
      <div class="sum-v">${s.slots.length}<small>nos</small></div>
    </div>
    <div class="sum">
      <div class="sum-l">Total Capacity</div>
      <div class="sum-v">${esc(tonsShort(totalKg))}</div>
    </div>
    <div class="sum">
      <div class="sum-l">Loading Days</div>
      <div class="sum-v">${days.length}</div>
    </div>
    <div class="sum accent">
      <div class="sum-l">Numbers Awaited</div>
      <div class="sum-v">${pending}<small>of ${s.slots.length}</small></div>
    </div>
  </div>

  <table>
    <colgroup>
      <col style="width:5.5%"><col style="width:15%"><col style="width:11%">
      <col style="width:12%"><col style="width:26%"><col style="width:11.5%"><col style="width:19%">
    </colgroup>
    <thead>
      <tr>
        <th class="c">#</th>
        <th>Loading Code</th>
        <th>Date</th>
        <th>Vehicle Size</th>
        <th>Delivery To</th>
        <th class="c">Load At</th>
        <th>Vehicle No. (to be filled)</th>
      </tr>
    </thead>
    <tbody>
      ${s.slots.length ? rows : `<tr><td colspan="7" class="empty">No vehicles indented for this period.</td></tr>`}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="3">Total - ${s.slots.length} ${s.slots.length === 1 ? 'vehicle' : 'vehicles'}</td>
        <td>${esc(tonsLabel(totalKg))}</td>
        <td colspan="2">${days.length} ${days.length === 1 ? 'loading day' : 'loading days'}</td>
        <td>${pending > 0 ? `${pending} awaited` : 'All confirmed'}</td>
      </tr>
    </tfoot>
  </table>

  <div class="lower">
    <div class="box">
      <div class="box-h">Terms of Placement</div>
      <ol class="terms">
        <li>Confirm the <b>vehicle number, driver name and driver mobile</b> against each code before the loading date.</li>
        <li>Always quote the <b>loading code</b> in every call and message; dates may move, codes do not.</li>
        <li>Vehicles must report at the loading point with valid <b>RC, insurance, fitness and driving licence</b>, and with a clean, dry and tarpaulin-covered body.</li>
        <li>Capacity shown is the vehicle size to be placed; the actual loaded weight will be as per the mill weighbridge.</li>
        <li>Freight is payable as mutually agreed, against the signed lorry receipt and the delivery acknowledgement at destination.</li>
        <li>Any vehicle not placed must be intimated at least <b>24 hours</b> in advance so the code can be re-allotted.</li>
      </ol>
    </div>
    <div class="box">
      <div class="box-h">Acknowledgement</div>
      <div class="note">
        Kindly acknowledge receipt of this indent and confirm placement of the vehicles
        listed against each loading code for the period stated above.
      </div>
      <div class="sign">
        ${signatureBlockHtml({ companyName: esc(companyName) })}
      </div>
    </div>
  </div>

  <div class="foot">
    <span>${esc(companyName)} &nbsp;·&nbsp; Vehicle Indent &nbsp;·&nbsp; ${esc(s.transporter.name)}</span>
    <span>Computer-generated indent &nbsp;·&nbsp; ${esc(refNo)} &nbsp;·&nbsp; ${esc(stamp())}</span>
  </div>
</div>`;
}

export function buildVehicleIndentHtml(o: VehicleIndentOptions): string {
  const companyName = o.company?.tradeName || o.company?.name || 'RVP INDUSTRIES';
  const issued = new Date();
  const title = o.sheets.length === 1
    ? `Vehicle Indent - ${o.sheets[0].transporter.name}`
    : `Vehicle Indent - ${o.sheets.length} transporters`;

  const body = o.sheets
    .map((s, i) => sheetHtml(s, o.company, indentRefNo(companyName, issued, i + 1)))
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>${INDENT_CSS}</style>
</head>
<body>
${body}
${o.print ? `<script>window.onload=function(){window.focus();setTimeout(function(){window.print();},350);};</script>` : ''}
</body>
</html>`;
}

/**
 * Opens the indent in a new tab and fires the print dialog (Save as PDF).
 * Served from a Blob URL rather than document.write so the UTF-8 charset is
 * honoured - otherwise · and ₹ arrive as mojibake.
 */
export function openVehicleIndent(o: VehicleIndentOptions): void {
  const html = buildVehicleIndentHtml({ ...o, print: o.print ?? true });
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const win = window.open(url, '_blank');
  if (!win) {
    URL.revokeObjectURL(url);
    throw new Error('Pop-up blocked - allow pop-ups for this site to download the indent.');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
