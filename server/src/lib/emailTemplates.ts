/**
 * RVP Industries — Resend Email Templates
 * ─────────────────────────────────────────
 * "Tamarind & Bone" themed HTML email templates for all document types.
 *
 * Every template uses inline styles + table layout for maximum email client
 * compatibility (Outlook, Gmail, Yahoo, Apple Mail). No CSS variables, no
 * flexbox, no external stylesheets, no Google Fonts link tags.
 *
 * Web-safe font fallbacks:
 *   Display (headings) → Georgia, 'Times New Roman', serif   (≈ Fraunces)
 *   Body               → Helvetica, Arial, sans-serif        (≈ Hanken Grotesk)
 *   Mono (numbers)     → 'Courier New', monospace            (≈ Geist Mono)
 */

/* ── Design Tokens (hardcoded for email HTML) ──────────────────────────── */
const T = {
  // Canvas & surfaces
  canvasBg:       '#f3eee3',   // warm bone
  cardBg:         '#fffcf6',   // cream
  cardBorder:     '#e5d9c2',   // warm hairline

  // Text
  ink:            '#251c12',   // espresso
  muted:          '#897a63',   // warm taupe
  light:          '#b5a68e',   // lighter taupe for subtle text

  // Accents
  tamarind:       '#ad4f0a',   // primary
  tamarindLight:  '#fdf6ea',   // primary foreground
  forest:         '#1f5b41',   // success / green
  forestLight:    '#f1f6f2',
  warning:        '#c07c12',
  warningLight:   '#fff8ec',
  brick:          '#b23a22',   // destructive / overdue
  brickLight:     '#fff5f1',
  amber:          '#f0b34a',   // sidebar accent / gold

  // Fonts
  display:        "Georgia, 'Times New Roman', serif",
  body:           "Helvetica, Arial, sans-serif",
  mono:           "'Courier New', Courier, monospace",
} as const;

/* ── Helpers ───────────────────────────────────────────────────────────── */

/** Format a number as ₹X,XX,XXX.XX (Indian locale) */
function formatINR(amount: number): string {
  return '₹' + amount.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Format a Date as "15 Sep 2025" */
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
  companyTagline?: string;
  companyAddress?: string | null;
  companyGstin?: string | null;
  companyContact?: string | null;
}

/**
 * Master email shell. Every template wraps its body content through this.
 * Produces a full HTML document with DOCTYPE, head, and table-based layout.
 */
function baseLayout(bodyContent: string, opts: LayoutOptions = {}): string {
  const preheader = opts.preheader ?? '';
  const companyName = opts.companyName ?? 'RVP INDUSTRIES';
  const companyTagline = opts.companyTagline ?? 'Tamarind Processing & Export';
  const companyAddress = opts.companyAddress ?? undefined;
  const companyGstin = opts.companyGstin ?? undefined;
  const companyContact = opts.companyContact ?? undefined;

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
  <style>table,td{border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0}img{-ms-interpolation-mode:bicubic}</style>
  <![endif]-->
  <style type="text/css">
    body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
    table,td{mso-table-lspace:0;mso-table-rspace:0}
    img{-ms-interpolation-mode:bicubic;border:0;height:auto;line-height:100%;outline:none;text-decoration:none}
    body{margin:0;padding:0;width:100%!important;min-width:100%}
    @media only screen and (max-width:620px){
      .mobile-full{width:100%!important;max-width:100%!important}
      .mobile-pad{padding-left:16px!important;padding-right:16px!important}
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:${T.canvasBg};font-family:${T.body};color:${T.ink};line-height:1.6;-webkit-font-smoothing:antialiased;">
  ${preheader ? `<div style="display:none;font-size:1px;color:${T.canvasBg};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>` : ''}

  <!-- Outer canvas table -->
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:${T.canvasBg};">
    <tr>
      <td align="center" style="padding:32px 12px;">

        <!-- Card container -->
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" class="mobile-full" style="max-width:600px;width:100%;background-color:${T.cardBg};border:1px solid ${T.cardBorder};border-radius:8px;overflow:hidden;box-shadow:0 4px 14px rgba(30,22,14,0.08);">

          <!-- Top accent line -->
          <tr>
            <td style="height:4px;background:linear-gradient(90deg, ${T.tamarind}, ${T.amber}, ${T.forest});font-size:0;line-height:0;">&nbsp;</td>
          </tr>

          <!-- Header -->
          <tr>
            <td style="padding:28px 40px 20px 40px;border-bottom:1px solid ${T.cardBorder};" class="mobile-pad">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td>
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="vertical-align:middle;padding-right:14px;">
                          <div style="width:40px;height:40px;background:linear-gradient(135deg, #3b1a0e, #1a0a05);border-radius:10px;text-align:center;line-height:40px;">
                            <span style="color:${T.amber};font-size:20px;font-family:${T.display};font-weight:bold;">R</span>
                          </div>
                        </td>
                        <td style="vertical-align:middle;">
                          <div style="font-family:${T.display};font-size:20px;font-weight:700;color:${T.ink};letter-spacing:-0.02em;line-height:1.2;">${companyName}</div>
                          <div style="font-family:${T.body};font-size:12px;color:${T.muted};letter-spacing:0.04em;text-transform:uppercase;margin-top:1px;">${companyTagline}</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body Content -->
          <tr>
            <td style="padding:0;">
              ${bodyContent}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 40px 28px 40px;border-top:1px solid ${T.cardBorder};background-color:#faf7f0;" class="mobile-pad">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                ${companyAddress ? `<tr><td style="font-size:12px;color:${T.muted};line-height:1.5;padding-bottom:6px;">${companyAddress}</td></tr>` : ''}
                ${companyGstin ? `<tr><td style="font-size:12px;color:${T.muted};line-height:1.5;">GSTIN: <span style="font-family:${T.mono};color:${T.ink};font-weight:600;">${companyGstin}</span></td></tr>` : ''}
                ${companyContact ? `<tr><td style="font-size:12px;color:${T.muted};line-height:1.5;padding-bottom:12px;">${companyContact}</td></tr>` : ''}
                <tr>
                  <td style="padding-top:12px;border-top:1px solid ${T.cardBorder};">
                    <p style="margin:0;font-size:11px;color:${T.light};line-height:1.5;text-align:center;">
                      This is a system-generated email from ${companyName}. Please do not reply to this email.<br>
                      For queries, contact our accounts department.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

/* ── Document Badge ────────────────────────────────────────────────────── */

function documentBadge(label: string, color: string, bgColor: string, icon: string): string {
  return `
    <tr>
      <td style="padding:28px 40px 0 40px;" class="mobile-pad">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0">
          <tr>
            <td style="background-color:${bgColor};border:1px solid ${color}20;border-radius:6px;padding:8px 16px;">
              <span style="font-size:14px;margin-right:6px;">${icon}</span>
              <span style="font-family:${T.body};font-size:12px;font-weight:700;color:${color};letter-spacing:0.08em;text-transform:uppercase;">${label}</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

/* ── Key-Value Detail Table ────────────────────────────────────────────── */

interface DetailRow {
  label: string;
  value: string;
  bold?: boolean;
  valueColor?: string;
  mono?: boolean;
}

function detailTable(rows: DetailRow[]): string {
  const rowsHtml = rows.map((r, i) => {
    const isLast = i === rows.length - 1;
    const borderBottom = isLast ? '' : `border-bottom:1px solid ${T.cardBorder};`;
    const valueStyle = [
      `font-size:14px`,
      `color:${r.valueColor || T.ink}`,
      r.bold ? 'font-weight:700' : 'font-weight:600',
      r.mono ? `font-family:${T.mono}` : `font-family:${T.body}`,
      'text-align:right',
    ].join(';');

    return `
      <tr>
        <td style="padding:10px 0;${borderBottom}font-size:13px;color:${T.muted};font-family:${T.body};white-space:nowrap;width:40%;">${r.label}</td>
        <td style="padding:10px 0;${borderBottom}${valueStyle}">${r.value}</td>
      </tr>`;
  }).join('');

  return `
    <tr>
      <td style="padding:20px 40px;" class="mobile-pad">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#faf7f0;border:1px solid ${T.cardBorder};border-radius:8px;">
          <tr>
            <td style="padding:4px 20px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                ${rowsHtml}
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

/* ── Greeting Block ────────────────────────────────────────────────────── */

function greetingBlock(partyName: string, lines: string[]): string {
  const paras = lines.map(l => `<p style="margin:0 0 12px 0;font-size:14px;color:${T.ink};line-height:1.65;">${l}</p>`).join('');
  return `
    <tr>
      <td style="padding:24px 40px 0 40px;" class="mobile-pad">
        <p style="margin:0 0 14px 0;font-size:15px;color:${T.ink};font-weight:600;">Dear ${partyName},</p>
        ${paras}
      </td>
    </tr>`;
}

/* ── CTA / Note Block ─────────────────────────────────────────────────── */

function noteBlock(icon: string, text: string, bgColor: string = '#faf7f0'): string {
  return `
    <tr>
      <td style="padding:0 40px 24px 40px;" class="mobile-pad">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
          <tr>
            <td style="background-color:${bgColor};border-radius:6px;padding:14px 18px;text-align:center;">
              <span style="font-size:14px;margin-right:6px;">${icon}</span>
              <span style="font-size:13px;color:${T.muted};line-height:1.5;">${text}</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

/* ── Amount Highlight Block ────────────────────────────────────────────── */

function amountHighlight(label: string, amount: string, color: string, bgColor: string): string {
  return `
    <tr>
      <td style="padding:8px 40px 20px 40px;" class="mobile-pad">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
          <tr>
            <td style="background-color:${bgColor};border-left:4px solid ${color};border-radius:0 8px 8px 0;padding:18px 24px;text-align:center;">
              <div style="font-size:12px;color:${color};text-transform:uppercase;letter-spacing:0.06em;font-weight:600;margin-bottom:4px;">${label}</div>
              <div style="font-family:${T.display};font-size:28px;font-weight:700;color:${color};letter-spacing:-0.02em;">${amount}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

/* ── Regards / Sign-off Block ──────────────────────────────────────────── */

function regardsBlock(companyName: string): string {
  return `
    <tr>
      <td style="padding:4px 40px 28px 40px;" class="mobile-pad">
        <p style="margin:0;font-size:14px;color:${T.ink};line-height:1.65;">
          Warm regards,<br>
          <strong style="color:${T.tamarind};">${companyName}</strong>
        </p>
      </td>
    </tr>`;
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
}

export function invoiceEmailHtml(data: InvoiceEmailData): string {
  const cName = data.companyName || 'RVP INDUSTRIES';

  const details: DetailRow[] = [
    { label: 'Invoice Number', value: data.invoiceNumber, bold: true, mono: true },
    { label: 'Invoice Date', value: formatDate(data.invoiceDate) },
    { label: 'Total Amount', value: formatINR(data.amount), bold: true, valueColor: T.tamarind },
  ];
  if (data.irn) details.push({ label: 'IRN', value: data.irn.slice(0, 20) + '…', mono: true });
  if (data.vehicleNumber) details.push({ label: 'Vehicle Number', value: data.vehicleNumber, mono: true });

  const body = `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      ${documentBadge('Tax Invoice', T.tamarind, T.tamarindLight, '📄')}
      ${greetingBlock(data.partyName, [
        `Please find attached your tax invoice <strong style="color:${T.tamarind};">${data.invoiceNumber}</strong>${data.irn ? ' along with the e-invoice (IRN) details' : ''}.`,
      ])}
      ${amountHighlight('Invoice Amount', formatINR(data.amount), T.tamarind, T.tamarindLight)}
      ${detailTable(details)}
      ${noteBlock('📎', 'The tax invoice PDF is attached to this email for your records.')}
      ${regardsBlock(cName)}
    </table>`;

  return baseLayout(body, {
    preheader: `Tax Invoice ${data.invoiceNumber} — ${formatINR(data.amount)}`,
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
  const cName = data.companyName || 'RVP INDUSTRIES';

  const details: DetailRow[] = [
    { label: 'E-Way Bill No.', value: data.ewbNumber, bold: true, mono: true },
    { label: 'Invoice Number', value: data.invoiceNumber, mono: true },
    { label: 'Invoice Date', value: formatDate(data.invoiceDate) },
  ];
  if (data.validUpto) details.push({ label: 'Valid Until', value: formatDate(data.validUpto), bold: true, valueColor: T.forest });
  if (data.vehicleNumber) details.push({ label: 'Vehicle Number', value: data.vehicleNumber, mono: true });

  const body = `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      ${documentBadge('E-Way Bill', T.forest, T.forestLight, '🚛')}
      ${greetingBlock(data.partyName, [
        `Please find attached the e-way bill <strong style="color:${T.forest};">${data.ewbNumber}</strong> for invoice ${data.invoiceNumber}.`,
        data.validUpto ? `This e-way bill is valid until <strong>${formatDate(data.validUpto)}</strong>.` : '',
      ].filter(Boolean))}
      ${detailTable(details)}
      ${noteBlock('📎', 'The E-Way Bill PDF is attached to this email for your records.', T.forestLight)}
      ${regardsBlock(cName)}
    </table>`;

  return baseLayout(body, {
    preheader: `E-Way Bill ${data.ewbNumber} for Invoice ${data.invoiceNumber}`,
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
  const cName = data.companyName || 'RVP INDUSTRIES';

  const details: DetailRow[] = [
    { label: 'Credit Note No.', value: data.creditNoteNumber, bold: true, mono: true },
    { label: 'Date', value: formatDate(data.creditNoteDate) },
    { label: 'Credit Amount', value: formatINR(data.amount), bold: true, valueColor: T.forest },
  ];
  if (data.againstInvoice) details.push({ label: 'Against Invoice', value: data.againstInvoice, mono: true });
  if (data.reason) details.push({ label: 'Reason', value: data.reason });

  const body = `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      ${documentBadge('Credit Note', T.forest, T.forestLight, '💳')}
      ${greetingBlock(data.partyName, [
        `A credit note <strong style="color:${T.forest};">${data.creditNoteNumber}</strong> has been issued in your favour for <strong style="color:${T.forest};">${formatINR(data.amount)}</strong>.`,
        data.againstInvoice ? `This is against invoice <strong>${data.againstInvoice}</strong>.` : '',
      ].filter(Boolean))}
      ${amountHighlight('Credit Amount', formatINR(data.amount), T.forest, T.forestLight)}
      ${detailTable(details)}
      ${noteBlock('📎', 'The Credit Note PDF is attached to this email for your records.', T.forestLight)}
      ${regardsBlock(cName)}
    </table>`;

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
  const cName = data.companyName || 'RVP INDUSTRIES';

  const details: DetailRow[] = [
    { label: 'Debit Note No.', value: data.debitNoteNumber, bold: true, mono: true },
    { label: 'Date', value: formatDate(data.debitNoteDate) },
    { label: 'Debit Amount', value: formatINR(data.amount), bold: true, valueColor: T.warning },
  ];
  if (data.againstInvoice) details.push({ label: 'Against Invoice', value: data.againstInvoice, mono: true });
  if (data.reason) details.push({ label: 'Reason', value: data.reason });

  const body = `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      ${documentBadge('Debit Note', T.warning, T.warningLight, '📋')}
      ${greetingBlock(data.partyName, [
        `A debit note <strong style="color:${T.warning};">${data.debitNoteNumber}</strong> has been raised for <strong style="color:${T.warning};">${formatINR(data.amount)}</strong>.`,
        data.againstInvoice ? `This is against invoice <strong>${data.againstInvoice}</strong>.` : '',
      ].filter(Boolean))}
      ${amountHighlight('Debit Amount', formatINR(data.amount), T.warning, T.warningLight)}
      ${detailTable(details)}
      ${noteBlock('📎', 'The Debit Note PDF is attached to this email for your records.', T.warningLight)}
      ${regardsBlock(cName)}
    </table>`;

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
  const cName = data.companyName || 'RVP INDUSTRIES';

  const details: DetailRow[] = [
    { label: 'Amount Received', value: formatINR(data.amount), bold: true, valueColor: T.forest },
    { label: 'Payment Date', value: formatDate(data.paymentDate) },
  ];
  if (data.paymentMode) details.push({ label: 'Payment Mode', value: data.paymentMode });
  if (data.referenceNumber) details.push({ label: 'Reference / UTR', value: data.referenceNumber, mono: true });
  if (data.againstInvoices) details.push({ label: 'Against Invoices', value: data.againstInvoices });
  if (data.balanceOutstanding != null) {
    details.push({
      label: 'Balance Outstanding',
      value: formatINR(data.balanceOutstanding),
      bold: true,
      valueColor: data.balanceOutstanding > 0 ? T.warning : T.forest,
    });
  }

  const body = `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      ${documentBadge('Payment Received', T.forest, T.forestLight, '✅')}
      ${greetingBlock(data.partyName, [
        `We have received your payment of <strong style="color:${T.forest};">${formatINR(data.amount)}</strong>. Thank you for your prompt payment.`,
      ])}
      ${amountHighlight('Payment Received', formatINR(data.amount), T.forest, T.forestLight)}
      ${detailTable(details)}
      ${noteBlock('🙏', 'Thank you for your continued business with us.', T.forestLight)}
      ${regardsBlock(cName)}
    </table>`;

  return baseLayout(body, {
    preheader: `Payment of ${formatINR(data.amount)} received — Thank you`,
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
  const cName = data.companyName || 'RVP INDUSTRIES';

  const details: DetailRow[] = [
    { label: 'Receipt Number', value: data.receiptNumber, bold: true, mono: true },
    { label: 'Date', value: formatDate(data.receiptDate) },
    { label: 'Amount', value: formatINR(data.amount), bold: true, valueColor: T.tamarind },
  ];
  if (data.paymentMode) details.push({ label: 'Payment Mode', value: data.paymentMode });
  if (data.referenceNumber) details.push({ label: 'Reference / UTR', value: data.referenceNumber, mono: true });
  if (data.againstInvoices) details.push({ label: 'Against Invoices', value: data.againstInvoices });

  const body = `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      ${documentBadge('Payment Receipt', T.tamarind, T.tamarindLight, '🧾')}
      ${greetingBlock(data.partyName, [
        `Please find attached the payment receipt <strong style="color:${T.tamarind};">${data.receiptNumber}</strong> for <strong style="color:${T.tamarind};">${formatINR(data.amount)}</strong>.`,
      ])}
      ${amountHighlight('Receipt Amount', formatINR(data.amount), T.tamarind, T.tamarindLight)}
      ${detailTable(details)}
      ${noteBlock('📎', 'The receipt PDF is attached to this email for your records.')}
      ${regardsBlock(cName)}
    </table>`;

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
  /** Pre-formatted list: "INV-001 (₹50,000) · INV-002 (₹30,000)" */
  invoiceSummary?: string | null;
  overdueSince?: Date | string | null;
  companyName?: string | null;
  companyAddress?: string | null;
  companyGstin?: string | null;
  companyContact?: string | null;
  /** Company bank details for the payment section */
  bankName?: string;
  bankAccountNumber?: string;
  bankIfsc?: string;
  bankAccountName?: string;
}

export function paymentReminderEmailHtml(data: PaymentReminderEmailData): string {
  const cName = data.companyName || 'RVP INDUSTRIES';

  const details: DetailRow[] = [
    { label: 'Total Outstanding', value: formatINR(data.totalOutstanding), bold: true, valueColor: T.brick },
    { label: 'Invoices Pending', value: `${data.invoiceCount} invoice${data.invoiceCount !== 1 ? 's' : ''}`, bold: true },
  ];
  if (data.overdueSince) details.push({ label: 'Overdue Since', value: formatDate(data.overdueSince), valueColor: T.brick });

  // Bank details section
  let bankSection = '';
  if (data.bankName && data.bankAccountNumber && data.bankIfsc) {
    bankSection = `
    <tr>
      <td style="padding:0 40px 20px 40px;" class="mobile-pad">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:${T.forestLight};border:1px solid ${T.forest}20;border-radius:8px;">
          <tr>
            <td style="padding:16px 20px;">
              <div style="font-size:11px;color:${T.forest};text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:10px;">🏦 Bank Details for Payment</div>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                ${data.bankAccountName ? `<tr><td style="font-size:12px;color:${T.muted};padding:2px 0;width:40%;">Account Name</td><td style="font-size:12px;color:${T.ink};font-weight:600;padding:2px 0;">${data.bankAccountName}</td></tr>` : ''}
                <tr><td style="font-size:12px;color:${T.muted};padding:2px 0;width:40%;">Bank</td><td style="font-size:12px;color:${T.ink};font-weight:600;padding:2px 0;">${data.bankName}</td></tr>
                <tr><td style="font-size:12px;color:${T.muted};padding:2px 0;">A/C Number</td><td style="font-size:12px;color:${T.ink};font-weight:600;font-family:${T.mono};padding:2px 0;">${data.bankAccountNumber}</td></tr>
                <tr><td style="font-size:12px;color:${T.muted};padding:2px 0;">IFSC</td><td style="font-size:12px;color:${T.ink};font-weight:600;font-family:${T.mono};padding:2px 0;">${data.bankIfsc}</td></tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
  }

  // Invoice summary section
  let invoiceSummarySection = '';
  if (data.invoiceSummary) {
    invoiceSummarySection = `
    <tr>
      <td style="padding:0 40px 20px 40px;" class="mobile-pad">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#faf7f0;border:1px solid ${T.cardBorder};border-radius:8px;">
          <tr>
            <td style="padding:14px 20px;">
              <div style="font-size:11px;color:${T.muted};text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:8px;">📋 Pending Invoices</div>
              <div style="font-size:13px;color:${T.ink};line-height:1.7;font-family:${T.mono};">${data.invoiceSummary}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
  }

  const body = `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      ${documentBadge('Payment Reminder', T.brick, T.brickLight, '⏰')}
      ${greetingBlock(data.partyName, [
        `This is a gentle reminder regarding your outstanding dues of <strong style="color:${T.brick};">${formatINR(data.totalOutstanding)}</strong> across ${data.invoiceCount} invoice${data.invoiceCount !== 1 ? 's' : ''}.`,
        'We kindly request you to arrange the payment at the earliest convenience.',
      ])}
      ${amountHighlight('Outstanding Amount', formatINR(data.totalOutstanding), T.brick, T.brickLight)}
      ${detailTable(details)}
      ${invoiceSummarySection}
      ${bankSection}
      ${noteBlock('🤝', 'Please disregard this reminder if payment has already been made. We appreciate your business.', T.brickLight)}
      ${regardsBlock(cName)}
    </table>`;

  return baseLayout(body, {
    preheader: `Payment Reminder — ${formatINR(data.totalOutstanding)} outstanding`,
    companyName: cName,
    companyAddress: data.companyAddress,
    companyGstin: data.companyGstin,
    companyContact: data.companyContact,
  });
}
