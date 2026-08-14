import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { inr, rupeesInWords } from './invoice.js';
import { IST_TZ } from './istDate.js';
import { logger } from './logger.js';
import { drawSignatureMark } from './signatureAssets.js';
import type { BrokerLedgerData, BrokerLedgerTxn } from '../services/brokerLedger.service.js';

/**
 * Renders a broker's brokerage-ledger "Account Statement" as a PDF Buffer -
 * the document a broker receives on WhatsApp when the office sends their
 * ledger. Deliberately the same visual language as `renderStatementPdf`
 * (letterhead, summary strip, zebra table, closing band, footer), so this
 * reads as the same document family as a party's statement - just with the
 * broker's simpler two-line-kind ledger (Brokerage / Payment only, no
 * product/rate columns) in place of the party ledger's eight voucher kinds.
 *
 * Fed by `buildBrokerLedgerData` (brokerLedger.service.ts), the same builder
 * behind the WhatsApp send, so the PDF and the message body agree to the rupee.
 */

export interface BrokerStatementCompany {
  name: string;
  address?: string | null;
  gstin?: string | null;
  contact?: string | null;
  stateName?: string | null;
  stateCode?: string | null;
  pincode?: string | null;
  signatureHeight?: number | null;
  stampSize?: number | null;
}

export interface BrokerStatementPeriod {
  opening?: number;
  from?: string | null;
  to?: string | null;
}

/* ------------------------------------------------------------------ page */

const PAGE = { margin: 30, width: 595.28, height: 841.89 };
const LEFT = PAGE.margin;
const RIGHT = PAGE.width - PAGE.margin;
const W = RIGHT - LEFT;
const BOTTOM = PAGE.height - PAGE.margin;

// Same palette as statementPdf.ts / salesDuesPdf.ts - one document family.
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
      logger.warn(`[pdf] broker ledger font missing at ${path} - falling back to base fonts`);
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

function longDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-IN', { timeZone: IST_TZ, day: '2-digit', month: 'short', year: 'numeric' });
}

function periodLabel(v: string | null | undefined, fallback: string): string {
  if (!v) return fallback;
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? longDate(v) : v;
}

function stamp(): string {
  return new Date().toLocaleString('en-IN', {
    timeZone: IST_TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

const amt = (n: number): string => (n ? inr(n) : '');
const drcr = (n: number): string => (n === 0 ? '' : n > 0 ? 'Dr' : 'Cr');
const words = (n: number): string => rupeesInWords(Math.abs(n)).replace(/^INR /, 'Rupees ');

const KIND_LABEL: Record<BrokerLedgerTxn['kind'], string> = {
  BROKERAGE: 'Brokerage',
  PAYMENT: 'Payment',
};
const KIND_TONE: Record<BrokerLedgerTxn['kind'], [string, string]> = {
  BROKERAGE: ['#e0edff', '#1d4ed8'],
  PAYMENT: ['#ffe4e6', '#be123c'],
};

/* ----------------------------------------------------------------- table */

const COL_PCT = { date: 0.11, particulars: 0.39, ref: 0.17, debit: 0.11, credit: 0.11, balance: 0.11 } as const;
type ColKey = keyof typeof COL_PCT;

const CW = Object.fromEntries((Object.keys(COL_PCT) as ColKey[]).map((k) => [k, W * COL_PCT[k]])) as Record<ColKey, number>;

const CX = (() => {
  const order: ColKey[] = ['date', 'particulars', 'ref', 'debit', 'credit', 'balance'];
  const out = {} as Record<ColKey, number>;
  let x = LEFT;
  for (const k of order) { out[k] = x; x += CW[k]; }
  return out;
})();

const PAD = 4.5;

/* ---------------------------------------------------------------- render */

export function renderBrokerLedgerPdf(
  company: BrokerStatementCompany,
  data: BrokerLedgerData,
  period: BrokerStatementPeriod = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const F = useFonts(doc);
    const { broker, transactions: txns } = data;

    const faceFor = (weight: Weight, s: string): string => (s.includes('₹') ? (weight === 'body' ? F.rupee : F.rupeeBold) : F[weight]);
    const use = (weight: Weight, size: number, color: string, s = ''): PDFKit.PDFDocument =>
      doc.font(faceFor(weight, s)).fontSize(size).fillColor(color);

    const ascenderOf = (name: string): number => {
      doc.font(name);
      return (doc as unknown as { _font?: { ascender?: number } })._font?.ascender ?? 0;
    };
    const RUPEE_NUDGE = (ascenderOf(F.body) - ascenderOf(F.rupee)) / 1000;
    const yAdj = (s: string, size: number): number => (s.includes('₹') ? RUPEE_NUDGE * size : 0);

    const fill = (x: number, y: number, w: number, h: number, color: string) => doc.rect(x, y, w, h).fill(color);
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

    const balanceCell = (n: number, x: number, w: number, y: number, weight: Weight, size: number, color = INK, markColor = MUTED) => {
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

    const panelHeading = (label: string, x: number, y: number, w: number): number => {
      use('bold', 5.8, MUTED).text(label.toUpperCase(), x, y, { width: w, characterSpacing: 1.2 });
      return doc.y + 2.5;
    };

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

    const opening = period.opening ?? (txns.length ? (txns[0].runningBalance ?? 0) - txns[0].debit + txns[0].credit : 0);
    const closing = txns.length ? (txns[txns.length - 1].runningBalance ?? 0) : 0;
    const periodDebit = txns.reduce((s, t) => s + t.debit, 0);
    const periodCredit = txns.reduce((s, t) => s + t.credit, 0);
    const brokerageCount = txns.filter((t) => t.kind === 'BROKERAGE').length;

    const fromLabel = periodLabel(period.from, txns.length ? longDate(txns[0].date) : '-');
    const toLabel = periodLabel(period.to, txns.length ? longDate(txns[txns.length - 1].date) : '-');

    const companyName = company.name || 'RVP INDUSTRIES';
    const companyAddr = [company.address?.replace(/\n/g, ', '), company.pincode].filter(Boolean).join(' - ');
    const companyState = [company.stateName, company.stateCode ? `(${company.stateCode})` : null].filter(Boolean).join(' ');

    /* -- letterhead -------------------------------------------------------- */

    const headW = W * 0.6;
    use('bold', 16.5, BRAND).text(companyName.toUpperCase(), LEFT, PAGE.margin, { width: headW, characterSpacing: 0.3 });
    let ly = doc.y + 1.5;
    use('body', 6.4, MUTED).text('TAMARIND SEED PROCESSING', LEFT, ly, { width: headW, characterSpacing: 1.6 });
    ly = doc.y + 3.5;
    use('body', 7.2, SUB);
    if (companyAddr) { doc.text(companyAddr, LEFT, ly, { width: headW }); ly = doc.y + 0.5; }
    const idLine = [company.gstin ? `GSTIN: ${company.gstin}` : null, companyState ? `State: ${companyState}` : null]
      .filter(Boolean).join('  ·  ');
    if (idLine) { doc.text(idLine, LEFT, ly, { width: headW }); ly = doc.y + 0.5; }
    if (company.contact) { doc.text(`Phone: ${company.contact}`, LEFT, ly, { width: headW }); ly = doc.y; }

    const docX = LEFT + W * 0.55;
    const docW = RIGHT - docX;
    use('bold', 11, INK).text('BROKERAGE STATEMENT', docX, PAGE.margin, { width: docW, align: 'right', characterSpacing: 1.5 });
    let ry = doc.y + 3;
    fill(docX, ry, docW, 1.5, BAND);
    ry += 5.5;
    const metaPairs: [string, string][] = [
      ['Period', `${fromLabel}  to  ${toLabel}`],
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

    /* -- broker / account panels -------------------------------------------- */

    const panelTop = y;
    const pw = W / 2;
    const inset = 7;
    const colW = pw - inset * 2;

    let c1 = panelHeading('Statement For', LEFT + inset, panelTop + 6, colW);
    use('bold', 10.5, INK).text(broker.name, LEFT + inset, c1, { width: colW });
    c1 = doc.y + 1.5;
    c1 = kv('Phone', broker.phone, LEFT + inset, c1, colW);
    c1 = kv('Rate', 'Flat per dispatch', LEFT + inset, c1, colW);

    let c2 = panelHeading('Account Status', LEFT + pw + inset, panelTop + 6, colW);
    c2 = kv('Ledger A/C', broker.name, LEFT + pw + inset, c2, colW);
    c2 = kv('Vouchers', String(txns.length), LEFT + pw + inset, c2, colW);
    c2 = kv('Dispatches', String(brokerageCount), LEFT + pw + inset, c2, colW);

    const panelBottom = Math.max(c1, c2) + 6;
    stroke(LEFT, panelTop, W, panelBottom - panelTop);
    vline(LEFT + pw, panelTop, panelBottom);
    y = panelBottom + 7;

    /* -- summary strip ------------------------------------------------------ */

    const stripH = 27;
    const cellW = W / 4;
    fill(LEFT, y, W, stripH, BRAND_SOFT);
    fill(LEFT + cellW * 3, y, cellW, stripH, BAND);
    const sums: [string, number, boolean][] = [
      ['Opening Balance', opening, false],
      ['Total Brokerage', periodCredit, false],
      ['Total Paid', periodDebit, false],
      ['Closing Balance', closing, true],
    ];
    sums.forEach(([label, value, accent], i) => {
      const x = LEFT + cellW * i;
      if (i > 0) vline(x, y, y + stripH);
      use('bold', 5.8, accent ? FAINT : MUTED).text(label.toUpperCase(), x + 8, y + 6, { width: cellW - 16, characterSpacing: 1.1 });
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
      doc.text('PARTICULARS', CX.particulars + PAD, yy + 4.8, { width: CW.particulars - PAD, ...head });
      doc.text('INVOICE / VEHICLE', CX.ref + PAD, yy + 4.8, { width: CW.ref - PAD, ...head });
      const ry2 = yy + 4.8 + yAdj('₹', 6.2);
      use('bold', 6.2, '#ffffff', '₹');
      doc.text('DEBIT (₹)', CX.debit, ry2, { width: CW.debit - PAD, align: 'right', ...head });
      doc.text('CREDIT (₹)', CX.credit, ry2, { width: CW.credit - PAD, align: 'right', ...head });
      doc.text('BALANCE (₹)', CX.balance, ry2, { width: CW.balance - PAD, align: 'right', ...head });
      return yy + HEAD_H;
    };
    y = drawTableHead(y);

    const drawRow = (opts: {
      date: string; title: string; chip?: BrokerLedgerTxn['kind']; ref?: string;
      debit?: string; credit?: string; balance: number; background?: string; boldTitle?: boolean;
    }) => {
      const titleFont: Weight = opts.boldTitle ? 'bold' : 'semi';
      const chipW = opts.chip ? use('bold', 5.2, INK).widthOfString(KIND_LABEL[opts.chip].toUpperCase()) + 8 : 0;
      const titleX = CX.particulars + PAD + (chipW ? chipW + 4 : 0);
      const titleW = CW.particulars - PAD * 2 - (chipW ? chipW + 4 : 0);
      const titleH = use(titleFont, 7.6, INK, opts.title).heightOfString(opts.title, { width: titleW });
      const rowH = Math.max(17, 4.5 + titleH + 4.5);

      if (y + rowH > BOTTOM - 30) {
        doc.addPage();
        y = drawTableHead(PAGE.margin);
      }

      if (opts.background) fill(LEFT, y, W, rowH, opts.background);

      use('body', 6.8, SUB).text(opts.date, CX.date + PAD, y + 5, { width: CW.date - PAD, lineBreak: false });

      if (opts.chip) {
        const [bg, ink] = KIND_TONE[opts.chip];
        doc.roundedRect(CX.particulars + PAD, y + 4.5, chipW, 7.5, 1.8).fill(bg);
        use('bold', 5.2, ink).text(KIND_LABEL[opts.chip].toUpperCase(), CX.particulars + PAD, y + 6.3, {
          width: chipW, align: 'center', characterSpacing: 0.4, lineBreak: false,
        });
      }
      use(titleFont, 7.6, INK, opts.title).text(opts.title, titleX, y + 5, { width: titleW });

      if (opts.ref) use('body', 6.4, SUB).text(opts.ref, CX.ref + PAD, y + 5, { width: CW.ref - PAD * 2 });

      rightText(opts.debit ?? '', CX.debit, CW.debit - PAD, y + 5, 'body', 7, INK);
      rightText(opts.credit ?? '', CX.credit, CW.credit - PAD, y + 5, 'body', 7, INK);
      balanceCell(opts.balance, CX.balance, CW.balance - PAD, y + 5, 'bold', 7);

      y += rowH;
      hline(y, LINE, 0.5);
    };

    drawRow({
      date: fromLabel,
      title: 'Opening Balance',
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
      const ref = [t.invoiceNumber, t.vehicleNumber, t.reference].filter(Boolean).join(' · ');
      drawRow({
        date: longDate(t.date),
        title: t.particulars,
        chip: t.kind,
        ref,
        debit: amt(t.debit),
        credit: amt(t.credit),
        balance: t.runningBalance ?? 0,
        background: i % 2 ? ZEBRA : undefined,
      });
    });

    const footH = 16;
    if (y + footH > BOTTOM - 20) { doc.addPage(); y = drawTableHead(PAGE.margin); }
    fill(LEFT, y, W, footH, FOOT_BG);
    hline(y, BAND, 1.1);
    use('bold', 7.6, INK).text(
      `Total for the period - ${txns.length} voucher(s)`, CX.date + PAD, y + 4.5,
      { width: CW.date + CW.particulars + CW.ref - PAD, lineBreak: false },
    );
    rightText(inr(periodDebit), CX.debit, CW.debit - PAD, y + 4.5, 'bold', 7.6, INK);
    rightText(inr(periodCredit), CX.credit, CW.credit - PAD, y + 4.5, 'bold', 7.6, INK);
    balanceCell(closing, CX.balance, CW.balance - PAD, y + 4.5, 'bold', 7.6);
    y += footH;
    hline(y, BAND, 1.1);

    /* -- closing band + words ----------------------------------------------- */

    const TAIL_H = 190;
    if (y + TAIL_H > BOTTOM) { doc.addPage(); y = PAGE.margin; }

    const closingLabel = closing === 0 ? 'Account settled - nil balance' : closing > 0 ? 'Balance payable to broker' : 'Balance recoverable from broker';

    const bandH = 24;
    fill(LEFT, y, W, bandH, BAND);
    use('bold', 7.5, '#ffffff').text(closingLabel.toUpperCase(), LEFT + 10, y + 8.5, { width: W * 0.6, characterSpacing: 1.2, lineBreak: false });
    const closingText = `₹ ${inr(Math.abs(closing))}`;
    const closingMark = drcr(closing);
    let closingRight = RIGHT - 10;
    if (closingMark) {
      const mw = use('bold', 8, FAINT).widthOfString(closingMark);
      doc.text(closingMark, closingRight - mw, y + 10, { lineBreak: false });
      closingRight -= mw + 4;
    }
    use('bold', 14, '#ffffff', closingText);
    doc.text(closingText, closingRight - doc.widthOfString(closingText), y + 5.5, { lineBreak: false });
    y += bandH;

    const wordsH = 21;
    use('bold', 5.8, MUTED).text('CLOSING BALANCE IN WORDS', LEFT + 10, y + 4.5, { characterSpacing: 1.2 });
    use('bold', 7.5, INK).text(closing === 0 ? 'Nil' : words(closing), LEFT + 10, y + 12, { width: W - 20 });
    stroke(LEFT, y, W, wordsH);
    y += wordsH + 9;

    /* -- declaration + signature --------------------------------------------- */

    const boxTop = y;
    const boxW = W;
    let dy = panelHeading('Declaration', LEFT + 8, boxTop + 6, boxW - 16) + 1;
    const declaration =
      'This is a computer-generated Brokerage Statement listing every dispatch-based brokerage credit and '
      + 'every payment made against this account for the period stated above. All amounts are in Indian '
      + 'Rupees. Kindly verify these entries and report any discrepancy in writing within 7 days of receipt, '
      + 'after which the balance shown will be treated as confirmed.';
    use('body', 6.4, MUTED).text(declaration, LEFT + 8, dy, { width: boxW - 200, lineGap: 0.8 });
    const leftBottom = doc.y + 4;

    use('semi', 7.4, INK).text(`for ${companyName}`, RIGHT - 180, boxTop + 6, { width: 172, align: 'right' });
    let sy = doc.y + 2;
    const signBottom = drawSignatureMark(doc, {
      x: RIGHT - 180,
      width: 172,
      y: sy,
      signHeight: company.signatureHeight || 40,
      stampSize: company.stampSize || 62,
    });
    hline(signBottom + 3, HAIR, 0.6, RIGHT - 100, RIGHT - 8);
    use('body', 6.6, MUTED).text('Authorised Signatory', RIGHT - 180, signBottom + 6, { width: 172, align: 'right' });
    const rightBottom = doc.y + 4;

    const boxBottom = Math.max(leftBottom, rightBottom);
    stroke(LEFT, boxTop, boxW, boxBottom - boxTop);
    y = boxBottom + 10;

    /* -- footer -------------------------------------------------------------- */

    hline(y, LINE, 0.6);
    y += 5;
    use('body', 6.4, FAINT).text(`${companyName}  ·  Brokerage Statement  ·  ${broker.name}`, LEFT, y, { width: W * 0.6, lineBreak: false });
    doc.text(`Computer-generated statement  ·  ${stamp()}`, LEFT + W * 0.6, y, { width: W * 0.4, align: 'right', lineBreak: false });

    doc.end();
  });
}
