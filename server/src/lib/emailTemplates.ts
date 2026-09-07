/**
 * RVP Industries — Resend Email Templates
 * ─────────────────────────────────────────
 * Clean, professional, typography-driven email templates.
 * No emojis, no colored badges, no gradients — just elegant business correspondence.
 *
 * Inspired by Apple transactional emails and Stripe receipts:
 * white card, thin borders, restrained color, strong type hierarchy.
 *
 * Web-safe font fallbacks:
 *   Display (headings) → Georgia, 'Times New Roman', serif   (≈ Fraunces)
 *   Body               → Helvetica, Arial, sans-serif        (≈ Hanken Grotesk)
 *   Mono (numbers)     → 'Courier New', monospace            (≈ Geist Mono)
 */

const T = {
  bg:         '#f5f2ec',
  card:       '#ffffff',
  ink:        '#1a1610',
  secondary:  '#6b6258',
  tertiary:   '#9a9084',
  border:     '#e8e2d8',
  accent:     '#8b4513',   // understated warm brown
  green:      '#2d6a4f',
  red:        '#8b3a2a',
  warm:       '#a0845c',

  display:    "Georgia, 'Times New Roman', serif",
  body:       "Helvetica, Arial, sans-serif",
  mono:       "'Courier New', Courier, monospace",
} as const;

/* ── Helpers ───────────────────────────────────────────────────────────── */

function formatINR(amount: number): string {
  return '₹' + amount.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

/* ── Base Layout ───────────────────────────────────────────────────────── */

interface LayoutOptions {
  preheader?: string;
  companyName?: string | null;
  companyAddress?: string | null;
  companyGstin?: string | null;
  companyContact?: string | null;
}

function baseLayout(bodyContent: string, opts: LayoutOptions = {}): string {
  const preheader = opts.preheader ?? '';
  const companyName = opts.companyName ?? 'RVP Industries';
  const companyAddress = opts.companyAddress ?? undefined;
  const companyGstin = opts.companyGstin ?? undefined;
  const companyContact = opts.companyContact ?? undefined;

  const footerParts: string[] = [];
  if (companyAddress) footerParts.push(companyAddress);
  if (companyGstin) footerParts.push(`GSTIN: ${companyGstin}`);
  if (companyContact) footerParts.push(companyContact);

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
  <title>${companyName}</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <style>table,td{border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0}</style>
  <![endif]-->
  <style type="text/css">
    body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
    table,td{mso-table-lspace:0;mso-table-rspace:0}
    body{margin:0;padding:0;width:100%!important;min-width:100%}
    @media only screen and (max-width:620px){
      .outer{width:100%!important;max-width:100%!important}
      .inner{padding-left:24px!important;padding-right:24px!important}
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:${T.bg};font-family:${T.body};color:${T.ink};line-height:1.6;">
  ${preheader ? `<div style="display:none;font-size:1px;color:${T.bg};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>` : ''}

  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:${T.bg};">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" class="outer" style="max-width:560px;width:100%;background-color:${T.card};border:1px solid ${T.border};border-radius:4px;">

          <!-- Header -->
          <tr>
            <td style="padding:36px 44px 28px 44px;" class="inner">
              <div style="font-family:${T.display};font-size:18px;font-weight:700;color:${T.ink};letter-spacing:0.02em;">${companyName}</div>
            </td>
          </tr>

          <!-- Divider -->
          <tr><td style="padding:0 44px;" class="inner"><div style="border-top:1px solid ${T.border};"></div></td></tr>

          <!-- Body -->
          <tr>
            <td style="padding:28px 44px;" class="inner">
              ${bodyContent}
            </td>
          </tr>

          <!-- Footer divider -->
          <tr><td style="padding:0 44px;" class="inner"><div style="border-top:1px solid ${T.border};"></div></td></tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 44px 32px 44px;" class="inner">
              ${footerParts.length > 0 ? `<p style="margin:0 0 12px 0;font-size:12px;color:${T.tertiary};line-height:1.6;">${footerParts.join('<br>')}</p>` : ''}
              <p style="margin:0;font-size:11px;color:${T.tertiary};line-height:1.5;">
                This is an automatically generated email. Please do not reply directly.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/* ── Composable blocks ─────────────────────────────────────────────────── */

function heading(text: string): string {
  return `<h1 style="margin:0 0 20px 0;font-family:${T.display};font-size:22px;font-weight:700;color:${T.ink};letter-spacing:-0.01em;line-height:1.3;">${text}</h1>`;
}

function greeting(name: string): string {
  return `<p style="margin:0 0 16px 0;font-size:14px;color:${T.ink};line-height:1.7;">Dear ${name},</p>`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 16px 0;font-size:14px;color:${T.secondary};line-height:1.7;">${text}</p>`;
}

interface DetailRow {
  label: string;
  value: string;
  strong?: boolean;
}

function detailTable(rows: DetailRow[]): string {
  const html = rows.map((r, i) => {
    const borderTop = i === 0 ? '' : `border-top:1px solid ${T.border};`;
    return `<tr>
      <td style="padding:10px 0;${borderTop}font-size:13px;color:${T.tertiary};vertical-align:top;width:40%;">${r.label}</td>
      <td style="padding:10px 0;${borderTop}font-size:13px;color:${T.ink};text-align:right;vertical-align:top;${r.strong ? 'font-weight:700;' : ''}">${r.value}</td>
    </tr>`;
  }).join('');

  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:20px 0;">${html}</table>`;
}

function amount(label: string, value: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:20px 0;border-top:2px solid ${T.ink};border-bottom:1px solid ${T.border};">
    <tr>
      <td style="padding:12px 0;font-size:13px;color:${T.tertiary};text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${label}</td>
      <td style="padding:12px 0;font-size:18px;font-family:${T.display};font-weight:700;color:${T.ink};text-align:right;">${value}</td>
    </tr>
  </table>`;
}

function signoff(companyName: string): string {
  return `<p style="margin:24px 0 0 0;font-size:14px;color:${T.ink};line-height:1.7;">Regards,<br><span style="font-weight:600;">${companyName}</span></p>`;
}

function note(text: string): string {
  return `<p style="margin:20px 0 0 0;font-size:12px;color:${T.tertiary};line-height:1.6;font-style:italic;">${text}</p>`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   TEMPLATE 1: E-INVOICE
   ═══════════════════════════════════════════════════════════════════════════ */

export interface InvoiceEmailData {
  partyName: string;
  invoiceNumber: string;
  invoiceDate: Date | string;
  amount: number;
  irn?: string;
  vehicleNumber?: string | null;
  companyName?: string | null;
  companyAddress?: string | null;
  companyGstin?: string | null;
  companyContact?: string | null;
  ewbNumber?: string | null;
  ewbValidUpto?: Date | string | null;
  lrNumber?: string | null;
  attachedDocs?: string[];
}

export function invoiceEmailHtml(data: InvoiceEmailData): string {
  const cName = data.companyName || 'RVP Industries';
  const hasBundle = (data.attachedDocs && data.attachedDocs.length > 1) || !!data.ewbNumber || !!data.lrNumber;

  const rows: DetailRow[] = [
    { label: 'Invoice No.', value: data.invoiceNumber, strong: true },
    { label: 'Date', value: formatDate(data.invoiceDate) },
  ];
  if (data.irn) rows.push({ label: 'IRN', value: data.irn.length > 24 ? data.irn.slice(0, 24) + '…' : data.irn });
  if (data.vehicleNumber) rows.push({ label: 'Vehicle', value: data.vehicleNumber });
  if (data.ewbNumber) rows.push({ label: 'E-Way Bill No.', value: data.ewbNumber, strong: true });
  if (data.ewbValidUpto) rows.push({ label: 'EWB Valid Until', value: formatDate(data.ewbValidUpto) });
  if (data.lrNumber) rows.push({ label: 'Lorry Receipt No.', value: data.lrNumber, strong: true });
  if (data.attachedDocs && data.attachedDocs.length > 0) {
    rows.push({ label: 'Attached', value: data.attachedDocs.join(' + ') });
  }

  const docDesc = [
    'tax invoice <strong>' + data.invoiceNumber + '</strong>',
    data.ewbNumber ? 'e-way bill (' + data.ewbNumber + ')' : '',
    data.lrNumber ? 'lorry receipt (' + data.lrNumber + ')' : '',
  ].filter(Boolean).join(', ');

  const body = [
    heading(hasBundle ? 'Tax Invoice & Dispatch Documents' : 'Tax Invoice'),
    greeting(data.partyName),
    paragraph(`Please find attached your ${docDesc}.`),
    amount('Total Amount', formatINR(data.amount)),
    detailTable(rows),
    paragraph(
      hasBundle
        ? 'The combined document package (Tax Invoice, E-Way Bill & Lorry Receipt) is attached to this email as a single PDF.'
        : 'The invoice PDF is attached to this email.'
    ),
    signoff(cName),
  ].join('\n');

  return baseLayout(body, {
    preheader: `Invoice ${data.invoiceNumber} — ${formatINR(data.amount)}`,
    companyName: cName,
    companyAddress: data.companyAddress,
    companyGstin: data.companyGstin,
    companyContact: data.companyContact,
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   TEMPLATE 2: E-WAY BILL
   ═══════════════════════════════════════════════════════════════════════════ */

export interface EwbEmailData {
  partyName: string;
  ewbNumber: string;
  invoiceNumber: string;
  invoiceDate: Date | string;
  validUpto?: Date | string | null;
  vehicleNumber?: string | null;
  companyName?: string | null;
  companyAddress?: string | null;
  companyGstin?: string | null;
  companyContact?: string | null;
}

export function ewbEmailHtml(data: EwbEmailData): string {
  const cName = data.companyName || 'RVP Industries';

  const rows: DetailRow[] = [
    { label: 'E-Way Bill No.', value: data.ewbNumber, strong: true },
    { label: 'Invoice No.', value: data.invoiceNumber },
    { label: 'Invoice Date', value: formatDate(data.invoiceDate) },
  ];
  if (data.validUpto) rows.push({ label: 'Valid Until', value: formatDate(data.validUpto), strong: true });
  if (data.vehicleNumber) rows.push({ label: 'Vehicle', value: data.vehicleNumber });

  const body = [
    heading('E-Way Bill'),
    greeting(data.partyName),
    paragraph(`Please find attached the e-way bill <strong>${data.ewbNumber}</strong> for invoice ${data.invoiceNumber}.`),
    data.validUpto ? paragraph(`Valid until <strong>${formatDate(data.validUpto)}</strong>.`) : '',
    detailTable(rows),
    paragraph('The E-Way Bill PDF is attached to this email.'),
    signoff(cName),
  ].filter(Boolean).join('\n');

  return baseLayout(body, {
    preheader: `E-Way Bill ${data.ewbNumber} — Invoice ${data.invoiceNumber}`,
    companyName: cName,
    companyAddress: data.companyAddress,
    companyGstin: data.companyGstin,
    companyContact: data.companyContact,
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   TEMPLATE 3: CREDIT NOTE
   ═══════════════════════════════════════════════════════════════════════════ */

export interface CreditNoteEmailData {
  partyName: string;
  creditNoteNumber: string;
  creditNoteDate: Date | string;
  amount: number;
  againstInvoice?: string | null;
  reason?: string | null;
  companyName?: string | null;
  companyAddress?: string | null;
  companyGstin?: string | null;
  companyContact?: string | null;
}

export function creditNoteEmailHtml(data: CreditNoteEmailData): string {
  const cName = data.companyName || 'RVP Industries';

  const rows: DetailRow[] = [
    { label: 'Credit Note No.', value: data.creditNoteNumber, strong: true },
    { label: 'Date', value: formatDate(data.creditNoteDate) },
    { label: 'Amount', value: formatINR(data.amount), strong: true },
  ];
  if (data.againstInvoice) rows.push({ label: 'Against Invoice', value: data.againstInvoice });
  if (data.reason) rows.push({ label: 'Reason', value: data.reason });

  const body = [
    heading('Credit Note'),
    greeting(data.partyName),
    paragraph(`A credit note <strong>${data.creditNoteNumber}</strong> for <strong>${formatINR(data.amount)}</strong> has been issued in your favour.`),
    amount('Credit Amount', formatINR(data.amount)),
    detailTable(rows),
    paragraph('The credit note PDF is attached to this email.'),
    signoff(cName),
  ].join('\n');

  return baseLayout(body, {
    preheader: `Credit Note ${data.creditNoteNumber} — ${formatINR(data.amount)}`,
    companyName: cName,
    companyAddress: data.companyAddress,
    companyGstin: data.companyGstin,
    companyContact: data.companyContact,
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   TEMPLATE 4: DEBIT NOTE
   ═══════════════════════════════════════════════════════════════════════════ */

export interface DebitNoteEmailData {
  partyName: string;
  debitNoteNumber: string;
  debitNoteDate: Date | string;
  amount: number;
  againstInvoice?: string | null;
  reason?: string | null;
  companyName?: string | null;
  companyAddress?: string | null;
  companyGstin?: string | null;
  companyContact?: string | null;
}

export function debitNoteEmailHtml(data: DebitNoteEmailData): string {
  const cName = data.companyName || 'RVP Industries';

  const rows: DetailRow[] = [
    { label: 'Debit Note No.', value: data.debitNoteNumber, strong: true },
    { label: 'Date', value: formatDate(data.debitNoteDate) },
    { label: 'Amount', value: formatINR(data.amount), strong: true },
  ];
  if (data.againstInvoice) rows.push({ label: 'Against Invoice', value: data.againstInvoice });
  if (data.reason) rows.push({ label: 'Reason', value: data.reason });

  const body = [
    heading('Debit Note'),
    greeting(data.partyName),
    paragraph(`A debit note <strong>${data.debitNoteNumber}</strong> for <strong>${formatINR(data.amount)}</strong> has been raised.`),
    amount('Debit Amount', formatINR(data.amount)),
    detailTable(rows),
    paragraph('The debit note PDF is attached to this email.'),
    signoff(cName),
  ].join('\n');

  return baseLayout(body, {
    preheader: `Debit Note ${data.debitNoteNumber} — ${formatINR(data.amount)}`,
    companyName: cName,
    companyAddress: data.companyAddress,
    companyGstin: data.companyGstin,
    companyContact: data.companyContact,
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   TEMPLATE 5: PAYMENT RECEIVED
   ═══════════════════════════════════════════════════════════════════════════ */

export interface PaymentReceivedEmailData {
  partyName: string;
  amount: number;
  paymentDate: Date | string;
  paymentMode?: string | null;
  referenceNumber?: string | null;
  againstInvoices?: string | null;
  balanceOutstanding?: number | null;
  companyName?: string | null;
  companyAddress?: string | null;
  companyGstin?: string | null;
  companyContact?: string | null;
}

export function paymentReceivedEmailHtml(data: PaymentReceivedEmailData): string {
  const cName = data.companyName || 'RVP Industries';

  const rows: DetailRow[] = [
    { label: 'Amount', value: formatINR(data.amount), strong: true },
    { label: 'Date', value: formatDate(data.paymentDate) },
  ];
  if (data.paymentMode) rows.push({ label: 'Mode', value: data.paymentMode });
  if (data.referenceNumber) rows.push({ label: 'Reference', value: data.referenceNumber });
  if (data.againstInvoices) rows.push({ label: 'Against', value: data.againstInvoices });
  if (data.balanceOutstanding != null) {
    rows.push({ label: 'Balance Outstanding', value: formatINR(data.balanceOutstanding), strong: true });
  }

  const body = [
    heading('Payment Received'),
    greeting(data.partyName),
    paragraph(`We acknowledge receipt of your payment of <strong>${formatINR(data.amount)}</strong>. Thank you.`),
    amount('Amount Received', formatINR(data.amount)),
    detailTable(rows),
    signoff(cName),
  ].join('\n');

  return baseLayout(body, {
    preheader: `Payment received — ${formatINR(data.amount)}`,
    companyName: cName,
    companyAddress: data.companyAddress,
    companyGstin: data.companyGstin,
    companyContact: data.companyContact,
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   TEMPLATE 6: RECEIPT
   ═══════════════════════════════════════════════════════════════════════════ */

export interface ReceiptEmailData {
  partyName: string;
  receiptNumber: string;
  receiptDate: Date | string;
  amount: number;
  paymentMode?: string | null;
  referenceNumber?: string | null;
  againstInvoices?: string | null;
  companyName?: string | null;
  companyAddress?: string | null;
  companyGstin?: string | null;
  companyContact?: string | null;
}

export function receiptEmailHtml(data: ReceiptEmailData): string {
  const cName = data.companyName || 'RVP Industries';

  const rows: DetailRow[] = [
    { label: 'Receipt No.', value: data.receiptNumber, strong: true },
    { label: 'Date', value: formatDate(data.receiptDate) },
    { label: 'Amount', value: formatINR(data.amount), strong: true },
  ];
  if (data.paymentMode) rows.push({ label: 'Mode', value: data.paymentMode });
  if (data.referenceNumber) rows.push({ label: 'Reference', value: data.referenceNumber });
  if (data.againstInvoices) rows.push({ label: 'Against', value: data.againstInvoices });

  const body = [
    heading('Payment Receipt'),
    greeting(data.partyName),
    paragraph(`Please find attached receipt <strong>${data.receiptNumber}</strong> for <strong>${formatINR(data.amount)}</strong>.`),
    amount('Receipt Amount', formatINR(data.amount)),
    detailTable(rows),
    paragraph('The receipt PDF is attached to this email.'),
    signoff(cName),
  ].join('\n');

  return baseLayout(body, {
    preheader: `Receipt ${data.receiptNumber} — ${formatINR(data.amount)}`,
    companyName: cName,
    companyAddress: data.companyAddress,
    companyGstin: data.companyGstin,
    companyContact: data.companyContact,
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   TEMPLATE 7: PAYMENT REMINDER
   ═══════════════════════════════════════════════════════════════════════════ */

export interface PaymentReminderEmailData {
  partyName: string;
  totalOutstanding: number;
  invoiceCount: number;
  invoiceSummary?: string | null;
  overdueSince?: Date | string | null;
  companyName?: string | null;
  companyAddress?: string | null;
  companyGstin?: string | null;
  companyContact?: string | null;
  bankName?: string;
  bankAccountNumber?: string;
  bankIfsc?: string;
  bankAccountName?: string;
}

export function paymentReminderEmailHtml(data: PaymentReminderEmailData): string {
  const cName = data.companyName || 'RVP Industries';

  const rows: DetailRow[] = [
    { label: 'Outstanding', value: formatINR(data.totalOutstanding), strong: true },
    { label: 'Invoices', value: `${data.invoiceCount}` },
  ];
  if (data.overdueSince) rows.push({ label: 'Overdue Since', value: formatDate(data.overdueSince) });

  let bankBlock = '';
  if (data.bankName && data.bankAccountNumber && data.bankIfsc) {
    const bankRows: string[] = [];
    if (data.bankAccountName) bankRows.push(`<tr><td style="padding:4px 0;font-size:12px;color:${T.tertiary};width:35%;">Account Name</td><td style="padding:4px 0;font-size:12px;color:${T.ink};font-weight:600;">${data.bankAccountName}</td></tr>`);
    bankRows.push(`<tr><td style="padding:4px 0;font-size:12px;color:${T.tertiary};width:35%;">Bank</td><td style="padding:4px 0;font-size:12px;color:${T.ink};font-weight:600;">${data.bankName}</td></tr>`);
    bankRows.push(`<tr><td style="padding:4px 0;font-size:12px;color:${T.tertiary};">A/C No.</td><td style="padding:4px 0;font-size:12px;color:${T.ink};font-weight:600;font-family:${T.mono};">${data.bankAccountNumber}</td></tr>`);
    bankRows.push(`<tr><td style="padding:4px 0;font-size:12px;color:${T.tertiary};">IFSC</td><td style="padding:4px 0;font-size:12px;color:${T.ink};font-weight:600;font-family:${T.mono};">${data.bankIfsc}</td></tr>`);

    bankBlock = `
      <div style="margin:20px 0 0 0;padding:16px 0 0 0;border-top:1px solid ${T.border};">
        <p style="margin:0 0 8px 0;font-size:12px;font-weight:700;color:${T.secondary};text-transform:uppercase;letter-spacing:0.05em;">Bank Details</p>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">${bankRows.join('')}</table>
      </div>`;
  }

  let invoiceBlock = '';
  if (data.invoiceSummary) {
    invoiceBlock = `
      <div style="margin:16px 0 0 0;padding:14px 0 0 0;border-top:1px solid ${T.border};">
        <p style="margin:0 0 6px 0;font-size:12px;font-weight:700;color:${T.secondary};text-transform:uppercase;letter-spacing:0.05em;">Pending Invoices</p>
        <p style="margin:0;font-size:13px;color:${T.ink};line-height:1.8;font-family:${T.mono};">${data.invoiceSummary}</p>
      </div>`;
  }

  const body = [
    heading('Payment Reminder'),
    greeting(data.partyName),
    paragraph(`This is a reminder regarding your outstanding balance of <strong>${formatINR(data.totalOutstanding)}</strong> across ${data.invoiceCount} invoice${data.invoiceCount !== 1 ? 's' : ''}.`),
    paragraph('We request you to kindly arrange payment at your earliest convenience.'),
    amount('Amount Due', formatINR(data.totalOutstanding)),
    detailTable(rows),
    invoiceBlock,
    bankBlock,
    note('If payment has already been made, please disregard this notice.'),
    signoff(cName),
  ].filter(Boolean).join('\n');

  return baseLayout(body, {
    preheader: `Payment Reminder — ${formatINR(data.totalOutstanding)} outstanding`,
    companyName: cName,
    companyAddress: data.companyAddress,
    companyGstin: data.companyGstin,
    companyContact: data.companyContact,
  });
}
