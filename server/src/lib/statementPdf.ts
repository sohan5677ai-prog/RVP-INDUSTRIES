import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { inr, rupeesInWords } from './invoice.js';
import { IST_TZ } from './istDate.js';
import { logger } from './logger.js';
import { drawSignatureMark } from './signatureAssets.js';
import type { PartyStatementData } from '../controllers/ledger.controller.js';

/**
 * Renders a party "Statement of Account" as a PDF Buffer - the document a
 * supplier or buyer actually receives on WhatsApp.
 *
 * This is a deliberate port of the browser-printed statement in
 * `client/src/lib/partyStatement.ts`: same letterhead, party/bank panels,
 * four-figure summary strip, per-voucher narration, closing band, balance in
 * words, lifetime-activity box and signed declaration. The two are sent to the
 * same parties, so they have to read as one document - a party that gets the
 * printed copy from the office and the WhatsApp copy on their phone must not
 * see two different-looking statements. Keep them in step when either changes.
 *
 * Figures come from `PartyStatementData` (the same builder the Party Ledger
 * page reads), so the sheet, the ledger and the screen agree to the paisa.
 */

export interface StatementCompany {
  name: string;
  address?: string | null;
  gstin?: string | null;
  contact?: string | null;
  stateName?: string | null;
  stateCode?: string | null;
  pincode?: string | null;
  bankAccountName?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  bankBranchIfsc?: string | null;
  signatureHeight?: number | null;
  stampSize?: number | null;
}

/**
 * Period scoping for a ranged statement. When `transactions` covers only part of
 * the ledger, `opening` is the running balance carried in from before the first
 * row - without it the rows don't add up to the closing figure and the statement
 * reads as wrong. Omit everything for a full A-to-Z statement.
 */
export interface StatementPeriod {
  /** Legacy free-text label, e.g. "2026-04-01 to 2026-08-09". Used only when
   *  `from`/`to` are absent. */
  label?: string;
  opening?: number;
  /** Period bounds - ISO dates or any free text ("Start", "As of today"). */
  from?: string | null;
  to?: string | null;
  /** Filter description shown under the period in the letterhead meta. */
  filterNote?: string | null;
}

type Txn = PartyStatementData['transactions'][number];
type LedgerKind = Txn['kind'];

/* ------------------------------------------------------------------ page */

const PAGE = { margin: 30, width: 595.28, height: 841.89 };
const LEFT = PAGE.margin;
const RIGHT = PAGE.width - PAGE.margin;
const W = RIGHT - LEFT;
const BOTTOM = PAGE.height - PAGE.margin;

// Same palette as the printed statement's CSS custom properties.
const INK = '#111827';
const SUB = '#374151';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const HAIR = '#d1d5db';
const BRAND = '#ad4f0a';
const BRAND_SOFT = '#fdf6ee';
const BAND = '#1f2937';
const ZEBRA = '#fafafa';
const FOOT_BG = '#f9fafb';
const FAINT = '#9ca3af';

/* ----------------------------------------------------------------- fonts */

// The app's own typefaces, mirrored under assets/ so the WhatsApp PDF reads as
// the same document as the page. `assets/` sits beside `src/` and `dist/`, so
// the relative hop is the same in dev (tsx) and in the built server.
const FONT_DIR = new URL('../../assets/fonts/', import.meta.url);
const FONT_FILES = {
  body: 'HankenGrotesk-Regular.ttf',
  semi: 'HankenGrotesk-SemiBold.ttf',
  bold: 'HankenGrotesk-Bold.ttf',
} as const;
const FALLBACK = { body: 'Helvetica', semi: 'Helvetica-Bold', bold: 'Helvetica-Bold' } as const;

// Hanken Grotesk has no U+20B9, so any string carrying a ₹ is drawn in Noto
// Sans instead (bundled for the Kannada statement - its Latin/currency set is
// plain Noto Sans and sits close enough to Hanken to be invisible at 7pt).
// Without this the symbol drops out of the PDF entirely.
const RUPEE_FONT_FILES = {
  rupee: 'indic/NotoSansKannada-400.woff',
  rupeeBold: 'indic/NotoSansKannada-700.woff',
} as const;

type FontKey = keyof typeof FONT_FILES | keyof typeof RUPEE_FONT_FILES;
type FontMap = Record<FontKey, string>;
type Weight = 'body' | 'semi' | 'bold';

let warnedMissingFonts = false;

function useFonts(doc: PDFKit.PDFDocument): FontMap {
  const names = {} as FontMap;
  const load = (key: FontKey, file: string, fallback: string) => {
    const path = fileURLToPath(new URL(file, FONT_DIR));
    if (existsSync(path)) {
      doc.registerFont(key, path);
      names[key] = key;
      return;
    }
    names[key] = fallback;
    if (!warnedMissingFonts) {
      warnedMissingFonts = true;
      logger.warn(`[pdf] statement font missing at ${path} - falling back to base fonts`);
    }
  };
  for (const key of Object.keys(FONT_FILES) as (keyof typeof FONT_FILES)[]) {
    load(key, FONT_FILES[key], FALLBACK[key]);
  }
  load('rupee', RUPEE_FONT_FILES.rupee, names.body);
  load('rupeeBold', RUPEE_FONT_FILES.rupeeBold, names.semi);
  return names;
}

/* ---------------------------------------------------------------- format */

const numFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

function longDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-IN', {
    timeZone: IST_TZ, day: '2-digit', month: 'short', year: 'numeric',
  });
}

/** Period bounds may be an ISO date or free text ("Start") - format only dates. */
function periodLabel(v: string | null | undefined, fallback: string): string {
  if (!v) return fallback;
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? longDate(v) : v;
}

function stamp(): string {
  return new Date().toLocaleString('en-IN', {
    timeZone: IST_TZ, day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Amount with Indian grouping and two decimals; blank for zero. */
const amt = (n: number | null | undefined): string => (n ? inr(n) : '');
/** Dr/Cr marker for a signed balance; blank when the account is square. */
const drcr = (n: number): string => (n === 0 ? '' : n > 0 ? 'Dr' : 'Cr');
/** "Rupees Four Lakh …" - the invoice helper's "INR" prefix reads oddly here. */
const words = (n: number): string => rupeesInWords(Math.abs(n)).replace(/^INR /, 'Rupees ');

const KIND_LABEL: Record<LedgerKind, string> = {
  PURCHASE: 'Purchase',
  SALE: 'Sale',
  PAYMENT: 'Payment',
  RECEIPT: 'Receipt',
  CREDIT_NOTE: 'Credit Note',
  TDS: 'TDS',
  SHORTAGE: 'Shortage',
};

/** Chip fill + ink per voucher kind, matching the printed statement's chips. */
const KIND_TONE: Record<LedgerKind, [string, string]> = {
  PURCHASE: ['#e0edff', '#1d4ed8'],
  SALE: ['#ede9fe', '#6d28d9'],
  PAYMENT: ['#ffe4e6', '#be123c'],
  RECEIPT: ['#d1fae5', '#047857'],
  CREDIT_NOTE: ['#fef3c7', '#b45309'],
  TDS: ['#fef3c7', '#b45309'],
  SHORTAGE: ['#fef3c7', '#b45309'],
};

const TYPE_LABEL: Record<string, string> = {
  SUPPLIER: 'Supplier', BUYER: 'Buyer', BOTH: 'Supplier & Buyer', HAMALI_TEAM: 'Hamali Team',
};

/**
 * Tally-style narration line ("Being …") assembled from whatever the voucher
 * carries - invoice, lorry, weight, rate, UTR. Kept as one sentence so it reads
 * naturally under the particulars. Mirrors the client's `narration()`.
 */
function narration(t: Txn): string {
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
      if (t.reference) bits.push(`- ${t.reference}`);
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

/* ----------------------------------------------------------------- table */

const COL_PCT = {
  date: 0.085, particulars: 0.31, ref: 0.12, qty: 0.08,
  rate: 0.07, debit: 0.11, credit: 0.11, balance: 0.115,
} as const;
type ColKey = keyof typeof COL_PCT;

const CW = Object.fromEntries(
  (Object.keys(COL_PCT) as ColKey[]).map((k) => [k, W * COL_PCT[k]]),
) as Record<ColKey, number>;

const CX = (() => {
  const order: ColKey[] = ['date', 'particulars', 'ref', 'qty', 'rate', 'debit', 'credit', 'balance'];
  const out = {} as Record<ColKey, number>;
  let x = LEFT;
  for (const k of order) { out[k] = x; x += CW[k]; }
  return out;
})();

const PAD = 4.5;

/* ---------------------------------------------------------------- render */

export function renderStatementPdf(
  company: StatementCompany,
  data: PartyStatementData,
  period: StatementPeriod = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const F = useFonts(doc);
    const { party, transactions: txns, summary } = data;

    /* -- drawing helpers -------------------------------------------------- */

    /** Any string carrying a ₹ has to be drawn in the Noto face (see above). */
    const faceFor = (weight: Weight, s: string): string =>
      s.includes('₹') ? (weight === 'body' ? F.rupee : F.rupeeBold) : F[weight];

    const use = (weight: Weight, size: number, color: string, s = ''): PDFKit.PDFDocument =>
      doc.font(faceFor(weight, s)).fontSize(size).fillColor(color);

    // PDFKit places a line by its ascender, so a ₹ run drawn in the Noto face
    // sits on a different baseline from the Hanken text beside it. This is the
    // per-point correction that puts them back on one line; zero when both
    // faces fall back to the same built-in.
    const ascenderOf = (name: string): number => {
      doc.font(name);
      return (doc as unknown as { _font?: { ascender?: number } })._font?.ascender ?? 0;
    };
    const RUPEE_NUDGE = (ascenderOf(F.body) - ascenderOf(F.rupee)) / 1000;
    /** y offset that lines a ₹-bearing string up with its plain neighbours. */
    const yAdj = (s: string, size: number): number => (s.includes('₹') ? RUPEE_NUDGE * size : 0);

    const fill = (x: number, y: number, w: number, h: number, color: string) =>
      doc.rect(x, y, w, h).fill(color);

    const stroke = (x: number, y: number, w: number, h: number, color = HAIR, lw = 0.6) =>
      doc.lineWidth(lw).strokeColor(color).rect(x, y, w, h).stroke();

    const hline = (y: number, color = LINE, lw = 0.6, x1 = LEFT, x2 = RIGHT) =>
      doc.lineWidth(lw).strokeColor(color).moveTo(x1, y).lineTo(x2, y).stroke();

    const vline = (x: number, y1: number, y2: number, color = HAIR, lw = 0.6) =>
      doc.lineWidth(lw).strokeColor(color).moveTo(x, y1).lineTo(x, y2).stroke();

    /** Right-aligned text that never wraps - the numeric cells. */
    const rightText = (
      s: string, x: number, w: number, y: number, weight: Weight, size: number, color: string,
    ) => {
      if (!s) return;
      use(weight, size, color, s).text(s, x, y, { width: w, align: 'right', lineBreak: false });
    };

    /** "5,13,240.00 Dr" - amount in ink, the marker smaller and muted. */
    const balanceCell = (
      n: number, x: number, w: number, y: number, weight: Weight, size: number, color = INK,
      markColor = MUTED,
    ) => {
      const mark = drcr(n);
      let right = x + w;
      if (mark) {
        use('bold', size - 2, markColor).text(mark, right - doc.widthOfString(mark), y + 0.8, { lineBreak: false });
        right -= doc.widthOfString(mark) + 2;
      }
      const text = inr(Math.abs(n));
      use(weight, size, color, text);
      doc.text(text, right - doc.widthOfString(text), y, { lineBreak: false });
    };

    /** Uppercase micro-heading used above every panel and box. */
    const panelHeading = (label: string, x: number, y: number, w: number): number => {
      use('bold', 5.8, MUTED).text(label.toUpperCase(), x, y, { width: w, characterSpacing: 1.2 });
      return doc.y + 2.5;
    };

    /** Label/value pair; returns the next y. Skipped entirely when empty. */
    const kv = (label: string, value: string | null | undefined, x: number, y: number, w: number): number => {
      if (!value) return y;
      const labelW = Math.min(46, w * 0.4);
      const valueX = x + labelW + 4;
      const valueW = w - labelW - 4;
      use('body', 6.8, MUTED).text(label, x, y, { width: labelW, lineBreak: false });
      const h = use('semi', 6.8, INK, value).heightOfString(value, { width: valueW });
      doc.text(value, valueX, y, { width: valueW });
      return y + Math.max(9, h + 1.5);
    };

    /* -- figures ---------------------------------------------------------- */

    const opening = period.opening ?? (
      txns.length ? (txns[0].runningBalance ?? 0) - txns[0].debit + txns[0].credit : 0
    );
    const closing = txns.length
      ? (txns[txns.length - 1].runningBalance ?? 0)
      : (summary.balanceType === 'DR' ? summary.balance : -summary.balance);
    const periodDebit = txns.reduce((s, t) => s + t.debit, 0);
    const periodCredit = txns.reduce((s, t) => s + t.credit, 0);

    const fromLabel = periodLabel(period.from, txns.length ? longDate(txns[0].date) : '-');
    const toLabel = periodLabel(period.to, txns.length ? longDate(txns[txns.length - 1].date) : '-');

    const companyName = company.name || 'RVP INDUSTRIES';
    const companyAddr = [company.address?.replace(/\n/g, ', '), company.pincode].filter(Boolean).join(' - ');
    const companyState = [company.stateName, company.stateCode ? `(${company.stateCode})` : null]
      .filter(Boolean).join(' ');
    const partyAddr = [party.address, party.city, party.state, party.pincode].filter(Boolean).join(', ');
    const partyPhones = [party.phone, party.phone2].filter(Boolean).join(' / ');

    /* -- letterhead -------------------------------------------------------- */

    const headW = W * 0.6;
    use('bold', 16.5, BRAND).text(companyName.toUpperCase(), LEFT, PAGE.margin, {
      width: headW, characterSpacing: 0.3,
    });
    let ly = doc.y + 1.5;
    use('body', 6.4, MUTED).text('TAMARIND SEED PROCESSING', LEFT, ly, {
      width: headW, characterSpacing: 1.6,
    });
    ly = doc.y + 3.5;
    use('body', 7.2, SUB);
    if (companyAddr) { doc.text(companyAddr, LEFT, ly, { width: headW }); ly = doc.y + 0.5; }
    const idLine = [
      company.gstin ? `GSTIN: ${company.gstin}` : null,
      companyState ? `State: ${companyState}` : null,
    ].filter(Boolean).join('  ·  ');
    if (idLine) { doc.text(idLine, LEFT, ly, { width: headW }); ly = doc.y + 0.5; }
    if (company.contact) { doc.text(`Phone: ${company.contact}`, LEFT, ly, { width: headW }); ly = doc.y; }

    const docX = LEFT + W * 0.55;
    const docW = RIGHT - docX;
    use('bold', 11, INK).text('STATEMENT OF ACCOUNT', docX, PAGE.margin, {
      width: docW, align: 'right', characterSpacing: 1.5,
    });
    let ry = doc.y + 3;
    fill(docX, ry, docW, 1.5, BAND);
    ry += 5.5;
    const metaPairs: [string, string][] = [
      ['Period', `${fromLabel}  to  ${toLabel}`],
      ['Currency', 'INR (₹)'],
      ['Generated', stamp()],
    ];
    if (period.filterNote) metaPairs.push(['Filter', period.filterNote]);
    for (const [label, value] of metaPairs) {
      const vw = use('semi', 7, INK, value).widthOfString(value);
      doc.text(value, RIGHT - vw, ry + yAdj(value, 7), { lineBreak: false });
      use('body', 7, MUTED).text(label, docX, ry, { width: docW - vw - 5, align: 'right', lineBreak: false });
      ry += 9.5;
    }

    let y = Math.max(ly, ry) + 5;
    hline(y, BRAND, 1.9);
    y += 8;

    /* -- party / bank panels ----------------------------------------------- */

    const panelTop = y;
    const pw1 = W * (1.15 / 3.15);
    const pw2 = W * (1 / 3.15);
    const panelX = [LEFT, LEFT + pw1, LEFT + pw1 + pw2];
    const panelW = [pw1, pw2, pw2];
    const inset = 7;
    const colW = panelW.map((w) => w - inset * 2);

    // Column 1 - statement for
    let c1 = panelHeading('Statement For', panelX[0] + inset, panelTop + 6, colW[0]);
    const typeTag = TYPE_LABEL[party.type] ?? String(party.type);
    const nameW = use('bold', 10.5, INK).widthOfString(party.name);
    const tagW = use('bold', 5.4, SUB).widthOfString(typeTag.toUpperCase()) + 11;
    const tagInline = nameW + 5 + tagW <= colW[0];
    use('bold', 10.5, INK).text(party.name, panelX[0] + inset, c1, {
      width: tagInline ? colW[0] : colW[0], lineBreak: !tagInline,
    });
    const nameBottom = doc.y;
    if (tagInline) {
      const tagY = c1 + 1.5;
      doc.lineWidth(0.6).strokeColor(HAIR)
        .roundedRect(panelX[0] + inset + nameW + 5, tagY, tagW, 8, 4).stroke();
      use('bold', 5.4, SUB).text(typeTag.toUpperCase(), panelX[0] + inset + nameW + 5, tagY + 2.2, {
        width: tagW, align: 'center', characterSpacing: 0.5, lineBreak: false,
      });
    }
    c1 = nameBottom + 1.5;
    if (partyAddr) {
      use('body', 6.8, MUTED).text(partyAddr, panelX[0] + inset, c1, { width: colW[0] });
      c1 = doc.y + 1;
    }
    c1 += 2;
    c1 = kv('GSTIN', party.gstin, panelX[0] + inset, c1, colW[0]);
    c1 = kv('Phone', partyPhones, panelX[0] + inset, c1, colW[0]);
    c1 = kv('Email', party.email, panelX[0] + inset, c1, colW[0]);
    c1 = kv('Destination', party.destination, panelX[0] + inset, c1, colW[0]);

    // Column 2 - party bank + account status
    let c2 = panelHeading('Party Bank Details', panelX[1] + inset, panelTop + 6, colW[1]);
    if (party.bankName || party.bankAccountNumber || party.bankIfsc) {
      c2 = kv('Bank', party.bankName, panelX[1] + inset, c2, colW[1]);
      c2 = kv('A/C No.', party.bankAccountNumber, panelX[1] + inset, c2, colW[1]);
      c2 = kv('IFSC', party.bankIfsc, panelX[1] + inset, c2, colW[1]);
    } else {
      use('body', 6.6, MUTED).text('No bank details on record.', panelX[1] + inset, c2, { width: colW[1] });
      c2 = doc.y + 1;
    }
    c2 = panelHeading('Account Status', panelX[1] + inset, c2 + 6, colW[1]);
    c2 = kv('Ledger A/C', party.name, panelX[1] + inset, c2, colW[1]);
    c2 = kv('Vouchers', String(txns.length), panelX[1] + inset, c2, colW[1]);
    c2 = kv('Last Entry', summary.lastTxnDate ? longDate(summary.lastTxnDate) : '-', panelX[1] + inset, c2, colW[1]);

    // Column 3 - remit to
    let c3 = panelHeading('Remit Payments To', panelX[2] + inset, panelTop + 6, colW[2]);
    if (company.bankName || company.bankAccountNumber) {
      c3 = kv('Account', company.bankAccountName || companyName, panelX[2] + inset, c3, colW[2]);
      c3 = kv('Bank', company.bankName, panelX[2] + inset, c3, colW[2]);
      c3 = kv('A/C No.', company.bankAccountNumber, panelX[2] + inset, c3, colW[2]);
      c3 = kv('IFSC', company.bankBranchIfsc, panelX[2] + inset, c3, colW[2]);
    } else {
      use('body', 6.6, MUTED).text('Bank details not configured in Settings.', panelX[2] + inset, c3, { width: colW[2] });
      c3 = doc.y;
    }

    const panelBottom = Math.max(c1, c2, c3) + 6;
    stroke(LEFT, panelTop, W, panelBottom - panelTop);
    vline(panelX[1], panelTop, panelBottom);
    vline(panelX[2], panelTop, panelBottom);
    y = panelBottom + 7;

    /* -- summary strip ------------------------------------------------------ */

    const stripH = 27;
    const cellW = W / 4;
    fill(LEFT, y, W, stripH, BRAND_SOFT);
    fill(LEFT + cellW * 3, y, cellW, stripH, BAND);
    const sums: [string, number, boolean][] = [
      ['Opening Balance', opening, false],
      ['Total Debit', periodDebit, false],
      ['Total Credit', periodCredit, false],
      ['Closing Balance', closing, true],
    ];
    sums.forEach(([label, value, accent], i) => {
      const x = LEFT + cellW * i;
      if (i > 0) vline(x, y, y + stripH);
      use('bold', 5.8, accent ? FAINT : MUTED).text(label.toUpperCase(), x + 8, y + 6, {
        width: cellW - 16, characterSpacing: 1.1,
      });
      const shown = inr(Math.abs(value));
      const mark = (i === 0 || accent) ? drcr(value) : '';
      use('bold', 10.5, accent ? '#ffffff' : INK, shown).text(shown, x + 8, y + 14, { lineBreak: false });
      if (mark) {
        const vw = doc.widthOfString(shown);
        use('bold', 6.6, accent ? FAINT : MUTED).text(mark, x + 8 + vw + 3, y + 17, { lineBreak: false });
      }
    });
    stroke(LEFT, y, W, stripH);
    y += stripH + 8;

    /* -- ledger table ------------------------------------------------------- */

    const HEAD_H = 15;
    const drawTableHead = (yy: number): number => {
      fill(LEFT, yy, W, HEAD_H, BAND);
      const head = { characterSpacing: 0.8 } as const;
      use('bold', 6.2, '#ffffff');
      doc.text('DATE', CX.date + PAD, yy + 4.8, { width: CW.date - PAD, ...head });
      doc.text('PARTICULARS & NARRATION', CX.particulars + PAD, yy + 4.8, { width: CW.particulars - PAD, ...head });
      doc.text('INVOICE / REF', CX.ref + PAD, yy + 4.8, { width: CW.ref - PAD, ...head });
      doc.text('QTY (KG)', CX.qty, yy + 4.8, { width: CW.qty - PAD, align: 'right', ...head });
      doc.text('RATE', CX.rate, yy + 4.8, { width: CW.rate - PAD, align: 'right', ...head });
      const ry2 = yy + 4.8 + yAdj('₹', 6.2);
      use('bold', 6.2, '#ffffff', '₹');
      doc.text('DEBIT (₹)', CX.debit, ry2, { width: CW.debit - PAD, align: 'right', ...head });
      doc.text('CREDIT (₹)', CX.credit, ry2, { width: CW.credit - PAD, align: 'right', ...head });
      doc.text('BALANCE (₹)', CX.balance, ry2, { width: CW.balance - PAD, align: 'right', ...head });
      return yy + HEAD_H;
    };
    y = drawTableHead(y);

    /** One ledger line - opening row included, since it has the same anatomy. */
    const drawRow = (opts: {
      date: string;
      title: string;
      narr: string;
      chip?: LedgerKind;
      ref?: string;
      refSub?: string;
      qty?: string;
      rate?: string;
      debit?: string;
      credit?: string;
      balance: number;
      background?: string;
      boldTitle?: boolean;
    }) => {
      const titleFont: Weight = opts.boldTitle ? 'bold' : 'semi';
      const chipW = opts.chip
        ? use('bold', 5.2, INK).widthOfString(KIND_LABEL[opts.chip].toUpperCase()) + 8
        : 0;
      const titleX = CX.particulars + PAD + (chipW ? chipW + 4 : 0);
      const titleW = CW.particulars - PAD * 2 - (chipW ? chipW + 4 : 0);
      const narrW = CW.particulars - PAD * 2;
      // Measured with the face each string is actually drawn in - the Noto
      // fallback runs a taller line, so a ₹ narration needs more room.
      const titleH = use(titleFont, 7.6, INK, opts.title).heightOfString(opts.title, { width: titleW });
      const narrH = use('body', 6.4, MUTED, opts.narr).heightOfString(opts.narr, { width: narrW });
      const rowH = Math.max(15, 3.5 + titleH + 1 + narrH + 3.5);

      if (y + rowH > BOTTOM - 30) {
        doc.addPage();
        y = drawTableHead(PAGE.margin);
      }

      if (opts.background) fill(LEFT, y, W, rowH, opts.background);

      use('body', 6.8, SUB).text(opts.date, CX.date + PAD, y + 4, { width: CW.date - PAD, lineBreak: false });

      if (opts.chip) {
        const [bg, ink] = KIND_TONE[opts.chip];
        doc.roundedRect(CX.particulars + PAD, y + 4, chipW, 7.5, 1.8).fill(bg);
        use('bold', 5.2, ink).text(KIND_LABEL[opts.chip].toUpperCase(), CX.particulars + PAD, y + 5.8, {
          width: chipW, align: 'center', characterSpacing: 0.4, lineBreak: false,
        });
      }
      use(titleFont, 7.6, INK, opts.title).text(opts.title, titleX, y + 4, { width: titleW });
      use('body', 6.4, MUTED, opts.narr).text(opts.narr, CX.particulars + PAD, y + 4 + titleH + 1, { width: narrW });

      if (opts.ref) {
        use('body', 6.4, SUB).text(opts.ref, CX.ref + PAD, y + 4, { width: CW.ref - PAD * 2 });
        if (opts.refSub) {
          use('body', 6, MUTED).text(opts.refSub, CX.ref + PAD, doc.y + 0.5, { width: CW.ref - PAD * 2 });
        }
      }
      rightText(opts.qty ?? '', CX.qty, CW.qty - PAD, y + 4, 'body', 7, INK);
      rightText(opts.rate ?? '', CX.rate, CW.rate - PAD, y + 4, 'body', 7, INK);
      rightText(opts.debit ?? '', CX.debit, CW.debit - PAD, y + 4, 'body', 7, INK);
      rightText(opts.credit ?? '', CX.credit, CW.credit - PAD, y + 4, 'body', 7, INK);
      balanceCell(opts.balance, CX.balance, CW.balance - PAD, y + 4, 'bold', 7);

      y += rowH;
      hline(y, LINE, 0.5);
    };

    drawRow({
      date: fromLabel,
      title: 'Opening Balance',
      narr: `Balance brought forward as on ${fromLabel}.`,
      debit: opening > 0 ? inr(opening) : '',
      credit: opening < 0 ? inr(-opening) : '',
      balance: opening,
      background: BRAND_SOFT,
      boldTitle: true,
    });

    if (txns.length === 0) {
      const emptyH = 26;
      use('body', 7.5, MUTED).text('No transactions in this period.', LEFT, y + 9, { width: W, align: 'center' });
      y += emptyH;
      hline(y, LINE, 0.5);
    }

    txns.forEach((t, i) => {
      const ref = t.invoiceNumber || t.utr || t.reference || '';
      const refSub = [
        t.invoiceNumber && (t.utr || t.reference) ? (t.utr || t.reference) : null,
        t.vehicleNumber,
      ].filter(Boolean).join(' · ');
      drawRow({
        date: longDate(t.date),
        title: t.particulars,
        narr: narration(t),
        chip: t.kind,
        ref,
        refSub,
        qty: t.weightKg != null ? numFmt.format(t.weightKg) : '',
        rate: t.ratePerKg != null ? inr(t.ratePerKg) : '',
        debit: amt(t.debit),
        credit: amt(t.credit),
        balance: t.runningBalance ?? 0,
        background: i % 2 ? ZEBRA : undefined,
      });
    });

    // Totals row - the table's tfoot.
    const footH = 16;
    if (y + footH > BOTTOM - 20) { doc.addPage(); y = drawTableHead(PAGE.margin); }
    fill(LEFT, y, W, footH, FOOT_BG);
    hline(y, BAND, 1.1);
    use('bold', 7.6, INK).text(
      `Total for the period - ${txns.length} voucher(s)`, CX.date + PAD, y + 4.5,
      { width: CW.date + CW.particulars + CW.ref + CW.qty + CW.rate - PAD, lineBreak: false },
    );
    rightText(inr(periodDebit), CX.debit, CW.debit - PAD, y + 4.5, 'bold', 7.6, INK);
    rightText(inr(periodCredit), CX.credit, CW.credit - PAD, y + 4.5, 'bold', 7.6, INK);
    balanceCell(closing, CX.balance, CW.balance - PAD, y + 4.5, 'bold', 7.6);
    y += footH;
    hline(y, BAND, 1.1);

    /* -- closing band + words ----------------------------------------------- */

    // Everything below travels together; a closing figure orphaned from its
    // declaration and signature reads as an unfinished document.
    // Measured against a full-length tail (closing band + words + a 7-row
    // activity box + the signed declaration + footer); short by even a little
    // and the signature block drops off the bottom of the page.
    const TAIL_H = 250;
    if (y + TAIL_H > BOTTOM) { doc.addPage(); y = PAGE.margin; }

    const closingLabel = closing === 0
      ? 'Account settled - nil balance'
      : closing > 0
        ? (party.type === 'BUYER' ? 'Balance receivable from party' : 'Balance recoverable from party')
        : 'Balance payable to party';

    const bandH = 24;
    fill(LEFT, y, W, bandH, BAND);
    use('bold', 7.5, '#ffffff').text(closingLabel.toUpperCase(), LEFT + 10, y + 8.5, {
      width: W * 0.6, characterSpacing: 1.2, lineBreak: false,
    });
    const closingText = `₹ ${inr(Math.abs(closing))}`;
    const closingMark = drcr(closing);
    let closingRight = RIGHT - 10;
    if (closingMark) {
      const mw = use('bold', 8, FAINT).widthOfString(closingMark);
      doc.text(closingMark, closingRight - mw, y + 10, { lineBreak: false });
      closingRight -= mw + 4;
    }
    // No baseline nudge here: this run is always in the ₹ face, so the offset
    // below is already the one that centres it in the band.
    use('bold', 14, '#ffffff', closingText);
    doc.text(closingText, closingRight - doc.widthOfString(closingText), y + 5.5, { lineBreak: false });
    y += bandH;

    const wordsH = 21;
    use('bold', 5.8, MUTED).text('CLOSING BALANCE IN WORDS', LEFT + 10, y + 4.5, { characterSpacing: 1.2 });
    use('bold', 7.5, INK).text(closing === 0 ? 'Nil' : words(closing), LEFT + 10, y + 12, { width: W - 20 });
    stroke(LEFT, y, W, wordsH);
    y += wordsH + 9;

    /* -- activity + declaration --------------------------------------------- */

    const gap = 9;
    const boxW = [(W - gap) * (1.3 / 2.3), (W - gap) * (1 / 2.3)];
    const boxX = [LEFT, LEFT + boxW[0] + gap];
    const boxTop = y;

    const stats: [string, string][] = [
      ['Total purchases from party', inr(summary.purchaseTotal)],
      ['Total sales to party', inr(summary.saleTotal)],
      ['Total paid to party', inr(summary.paidTotal)],
      ['Total received from party', inr(summary.receivedTotal)],
      ['Lifetime business volume', inr(summary.totalBusiness)],
      ['Total transactions on record', numFmt.format(summary.transactionCount)],
    ];
    if (summary.pendingCount) {
      stats.push(['Loads awaiting weight verification', numFmt.format(summary.pendingCount)]);
    }

    let sy = panelHeading('Account Activity (lifetime)', boxX[0] + 8, boxTop + 6, boxW[0] - 16) + 1.5;
    stats.forEach(([label, value], i) => {
      use('body', 7.4, SUB).text(label, boxX[0] + 8, sy, { width: boxW[0] - 100, lineBreak: false });
      rightText(value, boxX[0] + 8, boxW[0] - 16, sy, 'bold', 7.4, INK);
      sy += 10.5;
      if (i < stats.length - 1) {
        doc.lineWidth(0.5).strokeColor(LINE).dash(1, { space: 1.6 })
          .moveTo(boxX[0] + 8, sy - 3).lineTo(boxX[0] + boxW[0] - 8, sy - 3).stroke();
        doc.undash();
      }
    });
    const leftBottom = sy + 3;

    let dy = panelHeading('Declaration', boxX[1] + 8, boxTop + 6, boxW[1] - 16) + 1;
    const declaration =
      "This is a computer-generated Statement of Account listing every voucher posted to this party's "
      + 'ledger for the period stated above, covering purchases, sales, payments and receipts alike. '
      + 'All amounts are in Indian Rupees and remain subject to realisation of instruments and to '
      + 'pending weight verification, where applicable. Kindly verify these entries against your books '
      + 'and report any discrepancy in writing within 7 days of receipt, after which the balance shown '
      + 'will be treated as confirmed.';
    use('body', 6.4, MUTED).text(declaration, boxX[1] + 8, dy, { width: boxW[1] - 16, lineGap: 0.8 });
    dy = doc.y + 8;

    use('semi', 7.4, INK).text(`for ${companyName}`, boxX[1] + 8, dy, {
      width: boxW[1] - 16, align: 'right',
    });
    dy = doc.y + 2;
    const signBottom = drawSignatureMark(doc, {
      x: boxX[1] + 8,
      width: boxW[1] - 16,
      y: dy,
      signHeight: company.signatureHeight || 40,
      stampSize: company.stampSize || 62,
    });
    hline(signBottom + 3, HAIR, 0.6, boxX[1] + boxW[1] - 100, boxX[1] + boxW[1] - 8);
    use('body', 6.6, MUTED).text('Authorised Signatory', boxX[1] + 8, signBottom + 6, {
      width: boxW[1] - 16, align: 'right',
    });
    const rightBottom = doc.y + 4;

    const boxBottom = Math.max(leftBottom, rightBottom);
    stroke(boxX[0], boxTop, boxW[0], boxBottom - boxTop);
    stroke(boxX[1], boxTop, boxW[1], boxBottom - boxTop);
    y = boxBottom + 10;

    /* -- footer -------------------------------------------------------------- */

    hline(y, LINE, 0.6);
    y += 5;
    use('body', 6.4, FAINT).text(
      `${companyName}  ·  Statement of Account  ·  ${party.name}`, LEFT, y, { width: W * 0.6, lineBreak: false },
    );
    doc.text(`Computer-generated statement  ·  ${stamp()}`, LEFT + W * 0.6, y, {
      width: W * 0.4, align: 'right', lineBreak: false,
    });

    doc.end();
  });
}
