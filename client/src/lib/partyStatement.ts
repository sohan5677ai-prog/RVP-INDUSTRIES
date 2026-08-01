// Party "Statement of Account" — a proper printed accounting document.
//
// The generic table exporters in lib/export.ts dump a grid; a statement that a
// supplier or buyer actually receives needs a letterhead, both parties' details,
// an opening balance, per-voucher narration, running balance, closing balance in
// words and a signature block. This module renders exactly that as a self-
// contained A4 HTML document and opens it in a new tab, where the browser's
// print dialog turns it into a PDF (same route as the Purchase Statement page).
//
// Rendering in the browser — instead of jsPDF — also fixes the ₹ glyph: jsPDF's
// built-in Helvetica is WinAnsi-only and prints U+20B9 as garbage.

import type { Party, PartyLedgerSummary, PartyLedgerTxn, LedgerKind } from './types';
import { inr, rupeesInWords } from './invoiceWords';

export interface StatementCompany {
  name: string;
  address?: string | null;
  gstin?: string | null;
  stateName?: string | null;
  stateCode?: string | null;
  pincode?: string | null;
  contact?: string | null;
  bankAccountName?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  bankBranchIfsc?: string | null;
}

export interface PartyStatementOptions {
  company: StatementCompany | null | undefined;
  party: Party;
  summary: PartyLedgerSummary;
  /** Rows already filtered to the period/kind the user is looking at. */
  transactions: PartyLedgerTxn[];
  /** Filter description shown under the period, e.g. "Payments only". */
  filterNote?: string;
  /** Explicit period bounds (yyyy-mm-dd) when the user set date filters. */
  fromDate?: string;
  toDate?: string;
}

/* ------------------------------------------------------------------ formats */

const numFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** Amount with Indian grouping and two decimals; blank for zero. */
const amt = (n: number | null | undefined): string => (n ? inr(n) : '');
const amt0 = (n: number): string => inr(n);
/** "Rupees Four Lakh …" — the invoice helper's "INR" prefix reads oddly on a statement. */
const words = (n: number): string => rupeesInWords(Math.abs(n)).replace(/^INR /, 'Rupees ');

function longDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function stamp(): string {
  return new Date().toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/* ------------------------------------------------------------- narration */

const KIND_LABEL: Record<LedgerKind, string> = {
  PURCHASE: 'Purchase',
  SALE: 'Sale',
  PAYMENT: 'Payment',
  RECEIPT: 'Receipt',
  CREDIT_NOTE: 'Credit Note',
  TDS: 'TDS',
  SHORTAGE: 'Shortage',
};

const KIND_TONE: Record<LedgerKind, string> = {
  PURCHASE: 'k-blue',
  SALE: 'k-violet',
  PAYMENT: 'k-rose',
  RECEIPT: 'k-green',
  CREDIT_NOTE: 'k-amber',
  TDS: 'k-amber',
  SHORTAGE: 'k-amber',
};

/**
 * Tally-style narration line ("Being …") assembled from whatever the voucher
 * carries — invoice, lorry, weight, rate, UTR. Kept as one sentence so it reads
 * naturally under the particulars.
 */
function narration(t: PartyLedgerTxn): string {
  const bits: string[] = [];
  const qty = t.weightKg != null ? `${numFmt.format(t.weightKg)} kg` : null;
  const rate = t.ratePerKg != null ? `₹${inr(t.ratePerKg)} per kg` : null;
  const product = t.product ? t.product.replace(/_/g, ' ').toLowerCase() : null;

  switch (t.kind) {
    case 'PURCHASE':
      bits.push(`Being ${product ?? 'goods'} purchased`);
      if (t.invoiceNumber) bits.push(`vide invoice no. ${t.invoiceNumber}`);
      if (qty && rate) bits.push(`for ${qty} @ ${rate}`);
      else if (qty) bits.push(`for ${qty}`);
      if (t.vehicleNumber) bits.push(`received in lorry ${t.vehicleNumber}`);
      break;
    case 'SALE':
      bits.push(`Being ${product ?? 'goods'} sold`);
      if (t.invoiceNumber) bits.push(`vide tax invoice ${t.invoiceNumber}`);
      if (qty && rate) bits.push(`for ${qty} @ ${rate}`);
      else if (qty) bits.push(`for ${qty}`);
      if (t.vehicleNumber) bits.push(`dispatched in lorry ${t.vehicleNumber}`);
      break;
    case 'PAYMENT':
      bits.push('Being amount paid to the party');
      if (t.reference) bits.push(`by ${t.reference}`);
      if (t.utr) bits.push(`UTR ${t.utr}`);
      if (t.invoiceNumber) bits.push(`against invoice no. ${t.invoiceNumber}`);
      break;
    case 'RECEIPT':
      bits.push('Being amount received from the party');
      if (t.reference) bits.push(`by ${t.reference}`);
      if (t.utr) bits.push(`UTR ${t.utr}`);
      if (t.invoiceNumber) bits.push(`against invoice no. ${t.invoiceNumber}`);
      break;
    case 'CREDIT_NOTE':
      bits.push('Being credit note issued');
      if (t.invoiceNumber) bits.push(`against invoice no. ${t.invoiceNumber}`);
      if (t.reference) bits.push(`— ${t.reference}`);
      break;
    case 'TDS':
      bits.push('Being TDS deducted at source');
      if (t.invoiceNumber) bits.push(`on invoice no. ${t.invoiceNumber}`);
      break;
    case 'SHORTAGE':
      bits.push('Being shortage / weight difference adjusted');
      if (qty) bits.push(`for ${qty}`);
      if (t.invoiceNumber) bits.push(`on invoice no. ${t.invoiceNumber}`);
      break;
  }
  // Only worth stating when the money actually moved on a different day.
  if (t.transferredDate && t.transferredDate.slice(0, 10) !== t.date.slice(0, 10)) {
    bits.push(`value dated ${longDate(t.transferredDate)}`);
  }
  return bits.join(' ') + '.';
}

/* ------------------------------------------------------------------- html */

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `<div class="kv">` pair, skipped entirely when the value is empty. */
function kv(label: string, value: string | null | undefined, mono = false): string {
  if (!value) return '';
  return `<div class="kv"><span class="kv-l">${esc(label)}</span><span class="kv-v${mono ? ' mono' : ''}">${esc(value)}</span></div>`;
}

const TYPE_LABEL: Record<string, string> = {
  SUPPLIER: 'Supplier', BUYER: 'Buyer', BOTH: 'Supplier & Buyer', HAMALI_TEAM: 'Hamali Team',
};

/** Dr/Cr marker for a signed balance; blank when the account is square. */
function drcr(n: number): string {
  return n === 0 ? '' : n > 0 ? 'Dr' : 'Cr';
}

/** Signed running balance -> "12,345.00 Dr". */
function balText(n: number): string {
  const m = drcr(n);
  return `${amt0(Math.abs(n))}${m ? ` <span class="drcr">${m}</span>` : ''}`;
}

export function buildPartyStatementHtml(o: PartyStatementOptions): string {
  const { company, party, summary, transactions: txns } = o;

  // Opening = balance just before the first listed row; closing = last row's.
  const opening = txns.length ? txns[0].runningBalance - txns[0].debit + txns[0].credit : 0;
  const closing = txns.length ? txns[txns.length - 1].runningBalance : (summary.balanceType === 'DR' ? summary.balance : -summary.balance);
  const periodDebit = txns.reduce((s, t) => s + t.debit, 0);
  const periodCredit = txns.reduce((s, t) => s + t.credit, 0);

  const fromLabel = o.fromDate ? longDate(o.fromDate) : txns.length ? longDate(txns[0].date) : '—';
  const toLabel = o.toDate ? longDate(o.toDate) : txns.length ? longDate(txns[txns.length - 1].date) : '—';

  const companyName = company?.name ?? 'RVP INDUSTRIES';
  const companyAddr = [company?.address?.replace(/\n/g, ', '), company?.pincode].filter(Boolean).join(' - ');
  const companyState = [company?.stateName, company?.stateCode ? `(${company.stateCode})` : null].filter(Boolean).join(' ');

  const partyAddr = [party.address, party.city, party.state, party.pincode].filter(Boolean).join(', ');
  const partyPhones = [party.phone, party.phone2].filter(Boolean).join(' / ');

  const closingLabel = closing === 0
    ? 'Account settled — nil balance'
    : closing > 0
      ? (party.type === 'BUYER' ? 'Balance receivable from party' : 'Balance recoverable from party')
      : 'Balance payable to party';
  const closingWords = closing === 0 ? 'Nil' : words(closing);

  // --- rows ---------------------------------------------------------------
  const openingRow = `
    <tr class="row-opening">
      <td class="c-date">${esc(fromLabel)}</td>
      <td class="c-part"><div class="p-title">Opening Balance</div><div class="p-narr">Balance brought forward as on ${esc(fromLabel)}.</div></td>
      <td class="c-ref"></td>
      <td class="c-num"></td>
      <td class="c-num"></td>
      <td class="c-num">${opening > 0 ? amt0(opening) : ''}</td>
      <td class="c-num">${opening < 0 ? amt0(-opening) : ''}</td>
      <td class="c-num c-bal">${balText(opening)}</td>
    </tr>`;

  const bodyRows = txns.map((t, i) => {
    const ref = t.invoiceNumber || t.utr || t.reference || '';
    const sub = [t.invoiceNumber && (t.utr || t.reference) ? (t.utr || t.reference) : null, t.vehicleNumber]
      .filter(Boolean).join(' · ');
    return `
    <tr${i % 2 ? ' class="zebra"' : ''}>
      <td class="c-date">${esc(longDate(t.date))}</td>
      <td class="c-part">
        <div class="p-title"><span class="chip ${KIND_TONE[t.kind]}">${esc(KIND_LABEL[t.kind])}</span>${esc(t.particulars)}</div>
        <div class="p-narr">${esc(narration(t))}</div>
      </td>
      <td class="c-ref">${esc(ref)}${sub ? `<span class="ref-sub">${esc(sub)}</span>` : ''}</td>
      <td class="c-num">${t.weightKg != null ? numFmt.format(t.weightKg) : ''}</td>
      <td class="c-num">${t.ratePerKg != null ? inr(t.ratePerKg) : ''}</td>
      <td class="c-num">${amt(t.debit)}</td>
      <td class="c-num">${amt(t.credit)}</td>
      <td class="c-num c-bal">${balText(t.runningBalance)}</td>
    </tr>`;
  }).join('');

  const emptyRow = `<tr><td colspan="8" class="empty">No transactions in this period.</td></tr>`;

  // --- document -----------------------------------------------------------
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Statement of Account — ${esc(party.name)}</title>
<style>
  :root{
    --ink:#111827; --muted:#6b7280; --line:#e5e7eb; --hair:#d1d5db;
    --brand:#ad4f0a; --brand-soft:#fdf6ee; --band:#1f2937;
    --dr:#047857; --cr:#b91c1c;
  }
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;}
  body{
    font-family:"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    color:var(--ink); background:#eef0f3; font-size:11px; line-height:1.35;
    -webkit-print-color-adjust:exact; print-color-adjust:exact;
  }
  .sheet{width:210mm; min-height:297mm; margin:14px auto; padding:12mm 11mm 16mm;
         background:#fff; box-shadow:0 6px 28px rgba(15,23,42,.16);}
  .mono{font-family:"Consolas","SF Mono",monospace; letter-spacing:.2px;}
  .num{font-variant-numeric:tabular-nums;}

  /* ---------- letterhead ---------- */
  .head{display:flex; justify-content:space-between; align-items:flex-start; gap:16px;
        border-bottom:2.5px solid var(--brand); padding-bottom:9px;}
  .co-name{font-size:22px; font-weight:800; letter-spacing:.4px; color:var(--brand); text-transform:uppercase; line-height:1.1;}
  .co-tag{font-size:9.5px; letter-spacing:2.2px; text-transform:uppercase; color:var(--muted); margin-top:2px;}
  .co-lines{margin-top:6px; font-size:10px; color:#374151; max-width:105mm;}
  .co-lines div{margin-top:1px;}
  .doc{text-align:right; flex:0 0 auto;}
  .doc-title{font-size:15px; font-weight:800; letter-spacing:2.4px; text-transform:uppercase;}
  .doc-rule{height:2px; background:var(--band); margin:4px 0 6px;}
  .doc-meta{font-size:9.5px; color:var(--muted);}
  .doc-meta b{color:var(--ink); font-weight:600;}

  /* ---------- party / bank panels ---------- */
  .panels{display:grid; grid-template-columns:1.15fr 1fr 1fr; gap:0; margin-top:10px;
          border:1px solid var(--hair);}
  .panel{padding:8px 10px; border-right:1px solid var(--hair);}
  .panel:last-child{border-right:0;}
  .panel-h{font-size:8px; letter-spacing:1.6px; text-transform:uppercase; color:var(--muted); font-weight:700; margin-bottom:4px;}
  .party-name{font-size:14px; font-weight:700; line-height:1.2;}
  .party-sub{font-size:9.5px; color:var(--muted); margin-top:2px;}
  .tag{display:inline-block; font-size:8px; font-weight:700; letter-spacing:.8px; text-transform:uppercase;
       border:1px solid var(--hair); border-radius:99px; padding:1px 7px; color:#374151; margin-left:6px; vertical-align:1px;}
  .kv{display:flex; gap:6px; font-size:9.5px; margin-top:2px;}
  .kv-l{color:var(--muted); flex:0 0 62px;}
  .kv-v{font-weight:600; flex:1;}

  /* ---------- summary strip ---------- */
  .summary{display:grid; grid-template-columns:repeat(4,1fr); gap:0; margin-top:9px;
           border:1px solid var(--hair); background:var(--brand-soft);}
  .sum{padding:7px 10px; border-right:1px solid var(--hair);}
  .sum:last-child{border-right:0;}
  .sum-l{font-size:8px; letter-spacing:1.3px; text-transform:uppercase; color:var(--muted); font-weight:700;}
  .sum-v{font-size:14px; font-weight:700; margin-top:2px; font-variant-numeric:tabular-nums;}
  .sum-v small{font-size:9px; font-weight:700; margin-left:3px;}
  .sum.accent{background:var(--band);}
  .sum.accent .sum-l{color:#9ca3af;}
  .sum.accent .sum-v{color:#fff;}

  /* ---------- ledger table ---------- */
  table{width:100%; border-collapse:collapse; margin-top:10px; table-layout:fixed;}
  thead th{background:var(--band); color:#fff; font-size:8.5px; font-weight:700;
           letter-spacing:1.1px; text-transform:uppercase; padding:6px 6px; text-align:left;
           border-right:1px solid rgba(255,255,255,.14);}
  thead th:last-child{border-right:0;}
  thead th.r{text-align:right;}
  tbody td{padding:5px 6px; border-bottom:1px solid var(--line); vertical-align:top;}
  tbody tr.zebra{background:#fafafa;}
  tbody tr.row-opening{background:var(--brand-soft);}
  tbody tr.row-opening .p-title{font-weight:700;}
  .c-date{font-size:9.5px; color:#374151; white-space:nowrap;}
  .c-ref{font-size:9px; color:#374151; word-break:break-word;}
  .ref-sub{display:block; color:var(--muted); font-size:8.5px; margin-top:1px;}
  .c-num{text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; font-size:10px;}
  .c-bal{font-weight:700;}
  .drcr{font-size:8px; font-weight:700; color:var(--muted); margin-left:2px;}
  .p-title{font-weight:600; font-size:10.5px;}
  .p-narr{font-size:8.8px; color:var(--muted); margin-top:1.5px; line-height:1.3;}
  .chip{display:inline-block; font-size:7.5px; font-weight:700; letter-spacing:.6px; text-transform:uppercase;
        padding:1px 5px; border-radius:3px; margin-right:5px; vertical-align:1px;}
  .k-blue{background:#e0edff; color:#1d4ed8;} .k-violet{background:#ede9fe; color:#6d28d9;}
  .k-rose{background:#ffe4e6; color:#be123c;} .k-green{background:#d1fae5; color:#047857;}
  .k-amber{background:#fef3c7; color:#b45309;}
  .empty{text-align:center; color:var(--muted); padding:22px 0;}
  tfoot td{border-top:1.5px solid var(--band); border-bottom:1.5px solid var(--band);
           padding:6px; font-weight:700; font-size:10.5px; background:#f9fafb;}
  tr{break-inside:avoid; page-break-inside:avoid;}

  /* ---------- closing ---------- */
  .closing{display:flex; justify-content:space-between; align-items:center; gap:14px;
           background:var(--band); color:#fff; padding:9px 12px; margin-top:0;
           break-inside:avoid; page-break-inside:avoid;}
  .closing-l{font-size:10px; letter-spacing:1.6px; text-transform:uppercase; font-weight:700;}
  .closing-v{font-size:19px; font-weight:800; font-variant-numeric:tabular-nums; white-space:nowrap;}
  .closing-v span{font-size:11px; margin-left:4px;}
  .words{border:1px solid var(--hair); border-top:0; padding:6px 12px; font-size:10px;
         break-inside:avoid; page-break-inside:avoid;}
  .words b{font-weight:700;}
  .words span{color:var(--muted); font-size:8px; letter-spacing:1.4px; text-transform:uppercase; display:block;}

  /* ---------- activity + footer ---------- */
  .lower{display:grid; grid-template-columns:1.3fr 1fr; gap:12px; margin-top:12px;}
  .box{border:1px solid var(--hair); padding:8px 10px; break-inside:avoid; page-break-inside:avoid;}
  .box-h{font-size:8px; letter-spacing:1.6px; text-transform:uppercase; color:var(--muted); font-weight:700; margin-bottom:5px;}
  .stat{display:flex; justify-content:space-between; font-size:10px; padding:2.5px 0; border-bottom:1px dotted var(--line);}
  .stat:last-child{border-bottom:0;}
  .stat span:last-child{font-weight:700; font-variant-numeric:tabular-nums;}
  .note{font-size:8.8px; color:var(--muted); line-height:1.45;}
  .sign{margin-top:16px; text-align:right;}
  .sign-for{font-size:10px; font-weight:700;}
  .sign-line{margin-top:26px; border-top:1px solid var(--hair); padding-top:3px; font-size:9px; color:var(--muted);}
  .foot{display:flex; justify-content:space-between; margin-top:14px; padding-top:6px;
        border-top:1px solid var(--line); font-size:8.5px; color:#9ca3af;}

  /* ---------- print ---------- */
  @page{size:A4 portrait; margin:11mm 10mm 12mm;}
  @media print{
    body{background:#fff;}
    .sheet{width:auto; min-height:0; margin:0; padding:0; box-shadow:none;}
    thead{display:table-header-group;}
    tfoot{display:table-row-group;}
    .no-print{display:none !important;}
  }
</style>
</head>
<body>
<div class="sheet">

  <!-- letterhead -->
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
      <div class="doc-title">Statement of Account</div>
      <div class="doc-rule"></div>
      <div class="doc-meta">
        <div>Period&nbsp; <b>${esc(fromLabel)} &nbsp;to&nbsp; ${esc(toLabel)}</b></div>
        <div>Currency&nbsp; <b>INR (₹)</b></div>
        <div>Generated&nbsp; <b>${esc(stamp())}</b></div>
        ${o.filterNote ? `<div>Filter&nbsp; <b>${esc(o.filterNote)}</b></div>` : ''}
      </div>
    </div>
  </div>

  <!-- party / bank -->
  <div class="panels">
    <div class="panel">
      <div class="panel-h">Statement For</div>
      <div class="party-name">${esc(party.name)}<span class="tag">${esc(TYPE_LABEL[party.type] ?? party.type)}</span></div>
      ${partyAddr ? `<div class="party-sub">${esc(partyAddr)}</div>` : ''}
      <div style="margin-top:5px">
        ${kv('GSTIN', party.gstin, true)}
        ${kv('Phone', partyPhones)}
        ${kv('Email', party.email ?? null)}
        ${kv('Destination', party.destination ?? null)}
      </div>
    </div>
    <div class="panel">
      <div class="panel-h">Party Bank Details</div>
      ${party.bankName || party.bankAccountNumber || party.bankIfsc
        ? `${kv('Bank', party.bankName)}${kv('A/C No.', party.bankAccountNumber, true)}${kv('IFSC', party.bankIfsc, true)}`
        : `<div class="note">No bank details on record.</div>`}
      <div class="panel-h" style="margin-top:8px">Account Status</div>
      ${kv('Ledger A/C', party.name)}
      ${kv('Vouchers', String(txns.length))}
      ${kv('Last Entry', summary.lastTxnDate ? longDate(summary.lastTxnDate) : '—')}
    </div>
    <div class="panel">
      <div class="panel-h">Remit Payments To</div>
      ${company?.bankName || company?.bankAccountNumber
        ? `${kv('Account', company?.bankAccountName ?? companyName)}${kv('Bank', company?.bankName ?? null)}${kv('A/C No.', company?.bankAccountNumber ?? null, true)}${kv('IFSC', company?.bankBranchIfsc ?? null, true)}`
        : `<div class="note">Bank details not configured in Settings → Company.</div>`}
    </div>
  </div>

  <!-- summary strip -->
  <div class="summary">
    <div class="sum">
      <div class="sum-l">Opening Balance</div>
      <div class="sum-v">${amt0(Math.abs(opening))}<small>${drcr(opening)}</small></div>
    </div>
    <div class="sum">
      <div class="sum-l">Total Debit</div>
      <div class="sum-v">${amt0(periodDebit)}</div>
    </div>
    <div class="sum">
      <div class="sum-l">Total Credit</div>
      <div class="sum-v">${amt0(periodCredit)}</div>
    </div>
    <div class="sum accent">
      <div class="sum-l">Closing Balance</div>
      <div class="sum-v">${amt0(Math.abs(closing))}<small>${drcr(closing)}</small></div>
    </div>
  </div>

  <!-- ledger -->
  <table>
    <colgroup>
      <col style="width:8.5%"><col style="width:31%"><col style="width:12%">
      <col style="width:8%"><col style="width:7%">
      <col style="width:11%"><col style="width:11%"><col style="width:11.5%">
    </colgroup>
    <thead>
      <tr>
        <th>Date</th>
        <th>Particulars &amp; Narration</th>
        <th>Invoice / Ref</th>
        <th class="r">Qty (kg)</th>
        <th class="r">Rate</th>
        <th class="r">Debit (₹)</th>
        <th class="r">Credit (₹)</th>
        <th class="r">Balance (₹)</th>
      </tr>
    </thead>
    <tbody>
      ${openingRow}
      ${txns.length ? bodyRows : emptyRow}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="5">Total for the period — ${txns.length} voucher(s)</td>
        <td class="c-num">${amt0(periodDebit)}</td>
        <td class="c-num">${amt0(periodCredit)}</td>
        <td class="c-num">${balText(closing)}</td>
      </tr>
    </tfoot>
  </table>

  <!-- closing -->
  <div class="closing">
    <div class="closing-l">${esc(closingLabel)}</div>
    <div class="closing-v">₹ ${amt0(Math.abs(closing))}<span>${drcr(closing)}</span></div>
  </div>
  <div class="words">
    <span>Closing balance in words</span>
    <b>${esc(closingWords)}</b>
  </div>

  <!-- activity + declaration -->
  <div class="lower">
    <div class="box">
      <div class="box-h">Account Activity (lifetime)</div>
      <div class="stat"><span>Total purchases from party</span><span>${amt0(summary.purchaseTotal)}</span></div>
      <div class="stat"><span>Total sales to party</span><span>${amt0(summary.saleTotal)}</span></div>
      <div class="stat"><span>Total paid to party</span><span>${amt0(summary.paidTotal)}</span></div>
      <div class="stat"><span>Total received from party</span><span>${amt0(summary.receivedTotal)}</span></div>
      <div class="stat"><span>Lifetime business volume</span><span>${amt0(summary.totalBusiness)}</span></div>
      <div class="stat"><span>Total transactions on record</span><span>${numFmt.format(summary.transactionCount)}</span></div>
      ${summary.pendingCount ? `<div class="stat"><span>Loads awaiting weight verification</span><span>${numFmt.format(summary.pendingCount)}</span></div>` : ''}
    </div>
    <div class="box">
      <div class="box-h">Declaration</div>
      <div class="note">
        This statement reflects all vouchers posted to the party's ledger account for the period stated above.
        <b>Dr</b> denotes an amount recoverable from the party and <b>Cr</b> an amount payable to the party.
        Kindly reconcile with your books and report any discrepancy in writing within 7 days of receipt,
        after which the balance shown will be treated as confirmed.
      </div>
      <div class="sign">
        <div class="sign-for">For ${esc(companyName)}</div>
        <div class="sign-line">Authorised Signatory</div>
      </div>
    </div>
  </div>

  <div class="foot">
    <span>${esc(companyName)} &nbsp;·&nbsp; Statement of Account &nbsp;·&nbsp; ${esc(party.name)}</span>
    <span>Computer-generated — no signature required &nbsp;·&nbsp; ${esc(stamp())}</span>
  </div>
</div>
<script>
  window.onload = function () { window.focus(); ${'setTimeout(function(){ window.print(); }, 250);'} };
</script>
</body>
</html>`;
}

/**
 * Opens the statement in a new tab and fires the print dialog (Save as PDF).
 * Served from a Blob URL rather than document.write so the UTF-8 charset is
 * honoured — otherwise ₹ arrives as mojibake.
 */
export function openPartyStatement(o: PartyStatementOptions): void {
  const html = buildPartyStatementHtml(o);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const win = window.open(url, '_blank');
  if (!win) {
    URL.revokeObjectURL(url);
    throw new Error('Pop-up blocked — allow pop-ups for this site to download the statement.');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
