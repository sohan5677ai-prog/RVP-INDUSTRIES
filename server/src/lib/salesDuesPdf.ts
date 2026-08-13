import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { inr } from './invoice.js';
import { IST_TZ } from './istDate.js';
import { logger } from './logger.js';
import type { BuyerDues, DuesPortfolio, InvoiceDue } from '../services/salesDues.service.js';

/**
 * Renders the "Outstanding Sales Dues" report as a PDF Buffer - every unsettled
 * buyer invoice as on a given date, across every commodity, grouped by buyer.
 * Deliberately the same visual language as `renderStatementPdf` (letterhead,
 * summary strip, zebra table, footer) so a party or the owner reading this
 * alongside a Statement of Account sees one document family, not two.
 *
 * Each buyer gets a header band (name, invoice count, outstanding + overdue
 * totals) followed by its own invoices sorted oldest-due-first, mirroring how
 * the Sale Dues page reads per buyer. Fed by `computeBuyerDues`
 * (salesDues.service.ts), so the figures agree with the Sale Dues page and the
 * WhatsApp dues digest to the rupee.
 */

export interface DuesReportCompany {
  name: string;
  address?: string | null;
  gstin?: string | null;
  contact?: string | null;
  stateName?: string | null;
  stateCode?: string | null;
  pincode?: string | null;
}

/* ------------------------------------------------------------------ page */

const PAGE = { margin: 30, width: 595.28, height: 841.89 };
const LEFT = PAGE.margin;
const RIGHT = PAGE.width - PAGE.margin;
const W = RIGHT - LEFT;
const BOTTOM = PAGE.height - PAGE.margin;

// Same palette as statementPdf.ts - one document family.
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
const DANGER = '#be123c';
const AMBER = '#b45309';
const SKY = '#0369a1';
const GROUP_BG = '#f3f0ea';

/* ----------------------------------------------------------------- fonts */

const FONT_DIR = new URL('../../assets/fonts/', import.meta.url);
const FONT_FILES = {
  body: 'HankenGrotesk-Regular.ttf',
  semi: 'HankenGrotesk-SemiBold.ttf',
  bold: 'HankenGrotesk-Bold.ttf',
} as const;
const FALLBACK = { body: 'Helvetica', semi: 'Helvetica-Bold', bold: 'Helvetica-Bold' } as const;

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
      logger.warn(`[pdf] sales-dues report font missing at ${path} - falling back to base fonts`);
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

function longDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('en-IN', { timeZone: IST_TZ, day: '2-digit', month: 'short', year: 'numeric' });
}

function stamp(): string {
  return new Date().toLocaleString('en-IN', {
    timeZone: IST_TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** What an in-transit shipment's due date will be measured FROM - mirrors the
 *  page's `creditTermLabel`, since there is no real due date to print yet. */
function creditTermLabel(dueDays: number): string {
  if (dueDays <= 0) return 'On delivery';
  return `+${dueDays}d from delivery`;
}

type Status = 'Unpaid' | 'Partial' | 'In Transit';

function statusOf(inv: InvoiceDue): Status {
  if (inv.inTransit) return 'In Transit';
  return inv.partiallyPaid ? 'Partial' : 'Unpaid';
}

const STATUS_TONE: Record<Status, string> = {
  'Unpaid': DANGER,
  'Partial': AMBER,
  'In Transit': SKY,
};

/** Goods description per product - mirrors client/src/lib/productNames.ts (PRODUCT_DESCRIPTION). */
const PRODUCT_DESCRIPTION: Record<string, string> = {
  PAPPU: 'Tamarind Seed Pappu',
  HUSK: 'Tamarind Husk',
  WASTE: 'Tamarind Waste',
  TPS: 'Tamarind Seed Brokens',
  SHELL: 'Tamarind Shell',
  PRECLEANER_DUST: 'Pre Cleaner Dust',
  NALLA_POKKULU: 'Nalla Pokkulu',
  NALLA_CHINTAPANDU: 'Nalla Chintapandu',
};
function productDescription(product?: string | null): string {
  return PRODUCT_DESCRIPTION[product ?? 'PAPPU'] ?? 'Tamarind Seed Pappu';
}

/* ----------------------------------------------------------------- table */

// No customer column - the buyer is named once in its group header instead,
// which is also what frees up the room the per-row cells needed to stop
// clipping/overlapping (invoice ref, status badge, product name).
const COL_PCT = {
  date: 0.10, product: 0.135, ref: 0.185,
  billDate: 0.09, bill: 0.125, outstanding: 0.135, status: 0.13, days: 0.10,
} as const;
type ColKey = keyof typeof COL_PCT;

const CW = Object.fromEntries(
  (Object.keys(COL_PCT) as ColKey[]).map((k) => [k, W * COL_PCT[k]]),
) as Record<ColKey, number>;

const CX = (() => {
  const order: ColKey[] = ['date', 'product', 'ref', 'billDate', 'bill', 'outstanding', 'status', 'days'];
  const out = {} as Record<ColKey, number>;
  let x = LEFT;
  for (const k of order) { out[k] = x; x += CW[k]; }
  return out;
})();

const PAD = 4.5;
const GROUP_H = 24;

/* ---------------------------------------------------------------- render */

export function renderSalesDuesReportPdf(
  company: DuesReportCompany,
  portfolio: DuesPortfolio,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const F = useFonts(doc);

    const faceFor = (weight: Weight, s: string): string =>
      s.includes('₹') ? (weight === 'body' ? F.rupee : F.rupeeBold) : F[weight];
    const use = (weight: Weight, size: number, color: string, s = ''): PDFKit.PDFDocument =>
      doc.font(faceFor(weight, s)).fontSize(size).fillColor(color);

    const ascenderOf = (name: string): number => {
      doc.font(name);
      return (doc as unknown as { _font?: { ascender?: number } })._font?.ascender ?? 0;
    };
    const RUPEE_NUDGE = (ascenderOf(F.body) - ascenderOf(F.rupee)) / 1000;
    const yAdj = (s: string, size: number): number => (s.includes('₹') ? RUPEE_NUDGE * size : 0);

    const fill = (x: number, y: number, w: number, h: number, color: string) =>
      doc.rect(x, y, w, h).fill(color);
    const stroke = (x: number, y: number, w: number, h: number, color = HAIR, lw = 0.6) =>
      doc.lineWidth(lw).strokeColor(color).rect(x, y, w, h).stroke();
    const hline = (y: number, color = LINE, lw = 0.6, x1 = LEFT, x2 = RIGHT) =>
      doc.lineWidth(lw).strokeColor(color).moveTo(x1, y).lineTo(x2, y).stroke();
    const vline = (x: number, y1: number, y2: number, color = HAIR, lw = 0.6) =>
      doc.lineWidth(lw).strokeColor(color).moveTo(x, y1).lineTo(x, y2).stroke();

    const rightText = (s: string, x: number, w: number, y: number, weight: Weight, size: number, color: string) => {
      if (!s) return;
      use(weight, size, color, s).text(s, x, y, { width: w, align: 'right', lineBreak: false });
    };

    const heightOf = (s: string, w: number, weight: Weight, size: number): number =>
      use(weight, size, INK, s).heightOfString(s, { width: w });

    /* -- figures ---------------------------------------------------------- */

    const totalReceivable = portfolio.totalReceivable;
    const totalOverdue = portfolio.totalOverdue;
    const totalInTransit = portfolio.buyers.reduce((s, b) => s + b.inTransitOutstanding, 0);
    const buyerCount = portfolio.buyers.length;
    const invoiceCount = portfolio.buyers.reduce((s, b) => s + b.invoices.length, 0);

    const companyName = company.name || 'RVP INDUSTRIES';
    const companyAddr = [company.address?.replace(/\n/g, ', '), company.pincode].filter(Boolean).join(' - ');
    const companyState = [company.stateName, company.stateCode ? `(${company.stateCode})` : null]
      .filter(Boolean).join(' ');

    /* -- letterhead -------------------------------------------------------- */

    const headW = W * 0.6;
    use('bold', 16.5, BRAND).text(companyName.toUpperCase(), LEFT, PAGE.margin, { width: headW, characterSpacing: 0.3 });
    let ly = doc.y + 1.5;
    use('body', 6.4, MUTED).text('TAMARIND SEED PROCESSING', LEFT, ly, { width: headW, characterSpacing: 1.6 });
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
    use('bold', 11, INK).text('OUTSTANDING SALES DUES', docX, PAGE.margin, { width: docW, align: 'right', characterSpacing: 1.3 });
    let ry = doc.y + 3;
    fill(docX, ry, docW, 1.5, BAND);
    ry += 5.5;
    const metaPairs: [string, string][] = [
      ['As On', longDate(portfolio.asOf)],
      ['Currency', 'INR (₹)'],
      ['Generated', stamp()],
    ];
    for (const [label, value] of metaPairs) {
      const vw = use('semi', 7, INK, value).widthOfString(value);
      doc.text(value, RIGHT - vw, ry + yAdj(value, 7), { lineBreak: false });
      use('body', 7, MUTED).text(label, docX, ry, { width: docW - vw - 5, align: 'right', lineBreak: false });
      ry += 9.5;
    }

    let y = Math.max(ly, ry) + 5;
    hline(y, BRAND, 1.9);
    y += 8;

    /* -- summary strip ------------------------------------------------------ */

    const stripH = 27;
    const cellW = W / 4;
    fill(LEFT, y, W, stripH, BRAND_SOFT);
    fill(LEFT + cellW * 3, y, cellW, stripH, BAND);
    const sums: [string, string, boolean][] = [
      ['Total Receivable', inr(totalReceivable), false],
      ['Overdue', inr(totalOverdue), false],
      ['In Transit (not yet due)', inr(totalInTransit), false],
      ['Buyers with Dues', String(buyerCount), true],
    ];
    sums.forEach(([label, value, accent], i) => {
      const x = LEFT + cellW * i;
      if (i > 0) vline(x, y, y + stripH);
      use('bold', 5.8, accent ? FAINT : MUTED).text(label.toUpperCase(), x + 8, y + 6, { width: cellW - 16, characterSpacing: 1 });
      use('bold', 10.5, accent ? '#ffffff' : INK, value).text(value, x + 8, y + 14, { lineBreak: false });
    });
    stroke(LEFT, y, W, stripH);
    y += stripH + 8;

    /* -- table --------------------------------------------------------------- */

    const HEAD_H = 15;
    const drawTableHead = (yy: number): number => {
      fill(LEFT, yy, W, HEAD_H, BAND);
      const head = { characterSpacing: 0.6 } as const;
      use('bold', 5.8, '#ffffff');
      doc.text('DUE DATE', CX.date + PAD, yy + 4.8, { width: CW.date - PAD, ...head });
      doc.text('PRODUCT', CX.product + PAD, yy + 4.8, { width: CW.product - PAD, ...head });
      doc.text('INVOICE / VEHICLE', CX.ref + PAD, yy + 4.8, { width: CW.ref - PAD, ...head });
      doc.text('BILL DATE', CX.billDate + PAD, yy + 4.8, { width: CW.billDate - PAD, ...head });
      const ry2 = yy + 4.8 + yAdj('₹', 5.8);
      use('bold', 5.8, '#ffffff', '₹');
      doc.text('BILL (₹)', CX.bill, ry2, { width: CW.bill - PAD, align: 'right', ...head });
      doc.text('OUTSTANDING (₹)', CX.outstanding, ry2, { width: CW.outstanding - PAD, align: 'right', ...head });
      use('bold', 5.8, '#ffffff');
      doc.text('STATUS', CX.status, yy + 4.8, { width: CW.status - PAD, align: 'center', ...head });
      doc.text('DAYS', CX.days, yy + 4.8, { width: CW.days - PAD, align: 'center', ...head });
      return yy + HEAD_H;
    };

    /** Buyer group header band - name, invoice count, and the buyer's own
     *  outstanding/overdue totals, so a reader can act on one buyer's block
     *  without re-adding rows by hand. `continued` marks a band redrawn after a
     *  page break splits the buyer's rows. */
    const drawGroupBand = (yy: number, buyer: BuyerDues, continued: boolean): number => {
      fill(LEFT, yy, W, GROUP_H, GROUP_BG);
      fill(LEFT, yy, 3, GROUP_H, BRAND);
      const nameW = W * 0.5;
      const label = continued ? `${buyer.name} (contd.)` : buyer.name;
      use('bold', 8.6, INK).text(label, LEFT + 10, yy + 4, { width: nameW, lineBreak: false });
      use('body', 6.2, MUTED).text(
        `${buyer.invoices.length} invoice(s)`,
        LEFT + 10, yy + 14, { width: nameW, lineBreak: false },
      );
      const outVal = `Outstanding ${inr(buyer.outstanding)}`;
      const outW = use('bold', 7.4, INK, outVal).widthOfString(outVal);
      doc.text(outVal, RIGHT - 10 - outW, yy + 4 + yAdj(outVal, 7.4), { lineBreak: false });
      if (buyer.overdueOutstanding > 0) {
        const overVal = `Overdue ${inr(buyer.overdueOutstanding)}`;
        const overW = use('bold', 6.6, DANGER, overVal).widthOfString(overVal);
        doc.text(overVal, RIGHT - 10 - overW, yy + 14 + yAdj(overVal, 6.6), { lineBreak: false });
      }
      return yy + GROUP_H;
    };

    y = drawTableHead(y);

    const drawRow = (inv: InvoiceDue, background: string | undefined, buyer: BuyerDues, isFirstOfGroup: boolean): void => {
      const status = statusOf(inv);
      const dueLabel = inv.inTransit ? creditTermLabel(inv.dueDays) : longDate(inv.dueDate);
      const productText = productDescription(inv.product);

      const refSub = [inv.vehicleNumber, inv.brokerName ? `via ${inv.brokerName}` : null].filter(Boolean).join(' · ');
      const refText = refSub ? `${inv.invoiceNumber}\n${refSub}` : inv.invoiceNumber;

      const productH = heightOf(productText, CW.product - PAD * 2, 'body', 6.6);
      const refH = heightOf(refText, CW.ref - PAD * 2, 'body', 6.5);
      const dateH = heightOf(dueLabel, CW.date - PAD, 'semi', 6.8);
      const rowH = Math.max(16, 4 + productH + 3.5, 4 + refH + 3.5, 4 + dateH + 3.5);

      if (y + rowH > BOTTOM - 20) {
        doc.addPage();
        y = drawTableHead(PAGE.margin);
        // Mid-group page break - re-announce whose invoices these are, so a
        // reader flipping straight to this page isn't looking at bare rows.
        if (!isFirstOfGroup) y = drawGroupBand(y, buyer, true);
      }

      if (background) fill(LEFT, y, W, rowH, background);

      use('semi', 6.8, inv.overdue ? DANGER : SUB).text(dueLabel, CX.date + PAD, y + 4, { width: CW.date - PAD });
      use('body', 6.6, SUB).text(productText, CX.product + PAD, y + 4, { width: CW.product - PAD * 2 });
      use('body', 6.5, SUB).text(inv.invoiceNumber, CX.ref + PAD, y + 4, { width: CW.ref - PAD * 2 });
      if (refSub) {
        use('body', 6, MUTED).text(refSub, CX.ref + PAD, doc.y + 0.5, { width: CW.ref - PAD * 2 });
      }
      use('body', 6.2, SUB).text(longDate(inv.billDate), CX.billDate + PAD, y + 4, { width: CW.billDate - PAD });

      rightText(inr(inv.billAmount), CX.bill, CW.bill - PAD, y + 4, 'body', 6.8, INK);
      rightText(inr(inv.outstanding), CX.outstanding, CW.outstanding - PAD, y + 4, 'bold', 6.8, INK);

      use('bold', 5.8, STATUS_TONE[status]).text(status.toUpperCase(), CX.status, y + 5, {
        width: CW.status - PAD, align: 'center', lineBreak: false, characterSpacing: 0.3,
      });

      const daysText = inv.inTransit ? '-' : inv.dueDaysAfter > 0 ? String(inv.dueDaysAfter) : '-';
      use('bold', 6.8, inv.dueDaysAfter > 0 && !inv.inTransit ? DANGER : MUTED).text(
        daysText, CX.days, y + 5, { width: CW.days - PAD, align: 'center', lineBreak: false },
      );

      y += rowH;
      hline(y, LINE, 0.5);
    };

    if (portfolio.buyers.length === 0) {
      const emptyH = 26;
      use('body', 7.5, MUTED).text('No outstanding sales dues.', LEFT, y + 9, { width: W, align: 'center' });
      y += emptyH;
      hline(y, LINE, 0.5);
    }

    portfolio.buyers.forEach((buyer) => {
      if (buyer.invoices.length === 0) return;

      if (y + GROUP_H + 16 > BOTTOM - 20) {
        doc.addPage();
        y = drawTableHead(PAGE.margin);
      }
      y = drawGroupBand(y, buyer, false);

      const invoices = [...buyer.invoices].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
      invoices.forEach((inv, i) => drawRow(inv, i % 2 ? ZEBRA : undefined, buyer, i === 0));
    });

    // Totals row.
    const footH = 16;
    if (y + footH > BOTTOM - 20) { doc.addPage(); y = drawTableHead(PAGE.margin); }
    fill(LEFT, y, W, footH, FOOT_BG);
    hline(y, BAND, 1.1);
    use('bold', 7.6, INK).text(
      `Total - ${invoiceCount} outstanding invoice(s) across ${buyerCount} buyer(s)`,
      CX.date + PAD, y + 4.5,
      { width: CW.date + CW.product + CW.ref + CW.billDate - PAD, lineBreak: false },
    );
    const totalBilled = portfolio.buyers.reduce((s, b) => s + b.invoices.reduce((s2, i) => s2 + i.billAmount, 0), 0);
    rightText(inr(totalBilled), CX.bill, CW.bill - PAD, y + 4.5, 'bold', 7.6, INK);
    rightText(inr(totalReceivable), CX.outstanding, CW.outstanding - PAD, y + 4.5, 'bold', 7.6, INK);
    y += footH;
    hline(y, BAND, 1.1);

    /* -- footer -------------------------------------------------------------- */

    y += 8;
    if (y + 20 > BOTTOM) { doc.addPage(); y = PAGE.margin; }
    use('body', 6.4, MUTED).text(
      'Computer-generated report. Each invoice is cleared only by receipts recorded directly against it - no on-account carry-over.',
      LEFT, y, { width: W },
    );
    y = doc.y + 8;
    hline(y, LINE, 0.6);
    y += 5;
    use('body', 6.4, FAINT).text(`${companyName}  ·  Outstanding Sales Dues`, LEFT, y, { width: W * 0.6, lineBreak: false });
    doc.text(`Computer-generated report  ·  ${stamp()}`, LEFT + W * 0.6, y, { width: W * 0.4, align: 'right', lineBreak: false });

    doc.end();
  });
}
