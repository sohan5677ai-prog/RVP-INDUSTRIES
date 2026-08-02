import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { inr, rupeesInWords } from './invoice.js';
import { IST_TZ } from './istDate.js';
import { logger } from './logger.js';
import type { QualityAdjustmentRow, QualityAdjustmentMode } from './calc.js';
import { drawSignatureMark } from './signatureAssets.js';

/**
 * Renders the per-lorry PURCHASE STATEMENT (the bill we settle a supplier on)
 * as a PDF Buffer. This is what goes to the party on WhatsApp once a lorry is
 * unloaded & weight-verified - it shows the full arithmetic (weighments, kata
 * difference, every quality/expense/freight deduction, GST, billed-on addables,
 * self-vehicle recoveries) instead of a single bare amount, and closes with the
 * party's running account balance.
 *
 * Figures come from the stored WeightVerification, so the sheet, the ledger and
 * the on-screen statement all agree to the paisa.
 */

export interface PurchaseStatementCompany {
  name: string;
  address?: string | null;
  gstin?: string | null;
  contact?: string | null;
}

export interface PurchaseStatementParty {
  name: string;
  address?: string | null;
  gstin?: string | null;
  phone?: string | null;
}

export interface PurchaseStatementData {
  company: PurchaseStatementCompany;
  party: PurchaseStatementParty;
  invoiceNumber: string;
  statementDate: Date;
  lorryNumber: string;
  poNumber?: string | null;
  selfVehicle: boolean;
  /** Weighments, all in kg. `payableKg` is post kata-difference, pre quality rows. */
  weights: {
    billingKg: number;
    partyKataKg: number;
    rvpKataKg: number;
    referenceKg: number;
    diffKg: number;
    exempt: boolean;
    payableKg: number;
  };
  /** Free allowance on the kata difference (kg). */
  allowanceKg: number;
  pricePerKg: number;
  qualityAdjustments: QualityAdjustmentRow[];
  billAddables: { label: string; amount: number }[];
  gstRate: number;
  gstAmount: number;
  /** Weight the IGST is charged on (the invoice tonnage, not our recalc). */
  gstBasisKg: number;
  selfVehicleHamali: number;
  selfVehicleKata: number;
  /** Net balance payable - the ledger's figure, printed as-is. */
  netPayable: number;
}

const PAGE = { margin: 36, width: 595.28, height: 841.89 };
const LEFT = PAGE.margin;
const RIGHT = PAGE.width - PAGE.margin;
const W = RIGHT - LEFT;
const BOTTOM = PAGE.height - PAGE.margin;

const INK = '#0f172a';
const MUTED = '#64748b';
const HAIR = '#d7dee8';
const RULE = '#94a3b8';
const NEG = '#b91c1c';
const BAND = '#f1f5f9';

// The app's own typefaces - Fraunces for display headings, Hanken Grotesk for
// everything else - so the WhatsApp PDF reads as the same document as the page.
// `assets/` sits beside `src/` and `dist/`, so the relative hop is the same in
// dev (tsx) and in the built server. Falls back to the PDF base-14 fonts if a
// file is ever missing, since a statement that prints is worth more than one
// that matches.
const FONT_DIR = new URL('../../assets/fonts/', import.meta.url);
const FONT_FILES = {
  body: 'HankenGrotesk-Regular.ttf',
  semi: 'HankenGrotesk-SemiBold.ttf',
  bold: 'HankenGrotesk-Bold.ttf',
  display: 'Fraunces-Bold.ttf',
} as const;
const FALLBACK = { body: 'Helvetica', semi: 'Helvetica-Bold', bold: 'Helvetica-Bold', display: 'Times-Bold' } as const;

type FontKey = keyof typeof FONT_FILES;
type FontMap = Record<FontKey, string>;

let warnedMissingFonts = false;

/** Register the bundled faces on a document; returns the names to draw with. */
function useFonts(doc: PDFKit.PDFDocument): FontMap {
  const names = {} as FontMap;
  for (const key of Object.keys(FONT_FILES) as FontKey[]) {
    const path = fileURLToPath(new URL(FONT_FILES[key], FONT_DIR));
    if (existsSync(path)) {
      doc.registerFont(key, path);
      names[key] = key;
    } else {
      names[key] = FALLBACK[key];
      if (!warnedMissingFonts) {
        warnedMissingFonts = true;
        logger.warn(`[pdf] statement font missing at ${path} - falling back to base fonts`);
      }
    }
  }
  return names;
}

// Particulars / Qty / Rate / Amount
const COL_W = { particulars: W * 0.5, qty: W * 0.16, rate: W * 0.14, amount: 0 };
COL_W.amount = W - COL_W.particulars - COL_W.qty - COL_W.rate;
const COL_X = {
  particulars: LEFT,
  qty: LEFT + COL_W.particulars,
  rate: LEFT + COL_W.particulars + COL_W.qty,
  amount: LEFT + COL_W.particulars + COL_W.qty + COL_W.rate,
};

/** Short note appended to a deduction row so the party knows what it is. */
const MODE_NOTE: Record<QualityAdjustmentMode, string> = {
  WEIGHT: 'quality weight cut',
  PRICE: 'rate reduction',
  AMOUNT: 'quality discount',
  EXPENSE: 'expenses recovered',
  FREIGHT: 'lorry freight borne by party',
};

function fmtDate(d: Date): string {
  return d
    .toLocaleDateString('en-GB', { timeZone: IST_TZ, day: '2-digit', month: 'short', year: 'numeric' })
    .replace(/ /g, '-');
}

const qtyFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
function kg(n: number): string {
  return `${qtyFmt.format(Math.round(n * 100) / 100)} kg`;
}
function rate(n: number): string {
  return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

export function renderPurchaseStatementPdf(data: PurchaseStatementData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const F = useFonts(doc);
    const { company, party, weights } = data;
    const price = data.pricePerKg;

    // The kata difference is already folded into the verified payable weight, so
    // bill the reference weight and show the cut as its own line. When RVP
    // weighed HEAVIER than the reference there is no cut - we pay the RVP net.
    const billedKg = Math.max(weights.referenceKg, weights.payableKg);
    const kataDeductKg = Math.max(0, weights.referenceKg - weights.payableKg);
    const grossSeed = billedKg * price;
    const kataDeductAmount = kataDeductKg * price;

    const hline = (y: number, color = HAIR, width = 0.6) =>
      doc.lineWidth(width).strokeColor(color).moveTo(LEFT, y).lineTo(RIGHT, y).stroke();

    // --- Letterhead ---------------------------------------------------------
    doc.font(F.display).fontSize(17).fillColor(INK).text(company.name.toUpperCase(), LEFT, PAGE.margin - 2, {
      width: W * 0.62,
      characterSpacing: 0.2,
    });
    let y = doc.y + 3;
    doc.font(F.body).fontSize(7.5).fillColor(MUTED);
    if (company.address) {
      doc.text(company.address.replace(/\n/g, ', '), LEFT, y, { width: W * 0.62 });
      y = doc.y;
    }
    const idBits = [company.gstin ? `GSTIN: ${company.gstin}` : null, company.contact ? `Ph: ${company.contact}` : null]
      .filter(Boolean)
      .join('    ');
    if (idBits) {
      doc.text(idBits, LEFT, y, { width: W * 0.62 });
      y = doc.y;
    }

    doc.font(F.display).fontSize(14).fillColor(INK).text('PURCHASE STATEMENT', LEFT, PAGE.margin, {
      width: W,
      align: 'right',
      characterSpacing: 0.2,
    });
    doc
      .font(F.body)
      .fontSize(8)
      .fillColor(MUTED)
      .text(`Dated ${fmtDate(data.statementDate)}`, LEFT, PAGE.margin + 19, { width: W, align: 'right' });
    doc
      .font(F.body)
      .fontSize(7.5)
      .fillColor(MUTED)
      .text('Unloaded & weight-verified', LEFT, PAGE.margin + 31, { width: W, align: 'right' });

    y = Math.max(y, PAGE.margin + 44) + 6;
    hline(y, RULE, 1);
    y += 10;

    // --- Party / document meta ---------------------------------------------
    const metaTop = y;
    const metaSplit = LEFT + W * 0.56;
    const metaRow = 15;

    doc
      .font(F.body)
      .fontSize(7)
      .fillColor(MUTED)
      .text('STATEMENT FOR', LEFT + 6, metaTop + 5, { characterSpacing: 1 });
    doc.font(F.bold).fontSize(11.5).fillColor(INK).text(party.name, LEFT + 6, metaTop + 16, {
      width: metaSplit - LEFT - 12,
    });
    let py = doc.y + 1;
    doc.font(F.body).fontSize(7.5).fillColor(MUTED);
    if (party.address) {
      doc.text(party.address.replace(/\n/g, ', '), LEFT + 6, py, { width: metaSplit - LEFT - 12 });
      py = doc.y;
    }
    const partyBits = [party.gstin ? `GSTIN: ${party.gstin}` : null, party.phone ? `Ph: ${party.phone}` : null]
      .filter(Boolean)
      .join('    ');
    if (partyBits) {
      doc.text(partyBits, LEFT + 6, py, { width: metaSplit - LEFT - 12 });
      py = doc.y;
    }

    const metaPairs: [string, string][] = [
      ['Invoice No.', data.invoiceNumber || '-'],
      ['Vehicle', `${data.lorryNumber}${data.selfVehicle ? '  (party vehicle)' : ''}`],
      ['Purchase Order', data.poNumber || '-'],
    ];
    let my = metaTop + 5;
    for (const [k, v] of metaPairs) {
      doc.font(F.body).fontSize(7.5).fillColor(MUTED).text(k, metaSplit + 8, my, {
        width: (RIGHT - metaSplit) * 0.42,
        lineBreak: false,
      });
      doc
        .font(F.semi)
        .fontSize(8)
        .fillColor(INK)
        .text(v, metaSplit + 8 + (RIGHT - metaSplit) * 0.42, my - 0.5, {
          width: (RIGHT - metaSplit) * 0.58 - 14,
          lineBreak: false,
        });
      my += metaRow;
    }

    const metaBottom = Math.max(py + 8, my + 2);
    doc.lineWidth(0.6).strokeColor(HAIR).rect(LEFT, metaTop, W, metaBottom - metaTop).stroke();
    doc.moveTo(metaSplit, metaTop).lineTo(metaSplit, metaBottom).stroke();
    y = metaBottom + 10;

    // --- Weighment strip ----------------------------------------------------
    const cells: [string, string][] = [
      ['Invoice Weight', kg(weights.billingKg)],
      ['Party Kata', kg(weights.partyKataKg)],
      ['RVP Kata', kg(weights.rvpKataKg)],
      ['Difference', kg(weights.diffKg)],
      ['Payable Weight', kg(weights.payableKg)],
    ];
    const cellW = W / cells.length;
    const stripH = 34;
    doc.rect(LEFT, y, W, stripH).fill(BAND);
    cells.forEach(([label, value], i) => {
      const cx = LEFT + i * cellW;
      if (i > 0) doc.lineWidth(0.6).strokeColor(HAIR).moveTo(cx, y + 5).lineTo(cx, y + stripH - 5).stroke();
      doc.font(F.body).fontSize(6.5).fillColor(MUTED).text(label.toUpperCase(), cx, y + 7, {
        width: cellW,
        align: 'center',
        characterSpacing: 0.9,
      });
      doc
        .font(F.bold)
        .fontSize(i === cells.length - 1 ? 10 : 9.5)
        .fillColor(INK)
        .text(value, cx, y + 17.5, { width: cellW, align: 'center' });
    });
    doc.lineWidth(0.6).strokeColor(HAIR).rect(LEFT, y, W, stripH).stroke();
    y += stripH + 4;

    const kataNote =
      weights.payableKg >= weights.referenceKg && weights.diffKg === 0
        ? 'Both weighbridges agree - payable at the full reference weight.'
        : weights.payableKg > weights.referenceKg
          ? `RVP weighbridge read heavier than the party kata - paid on our higher net of ${kg(weights.rvpKataKg)}.`
          : weights.exempt
            ? `Difference of ${kg(weights.diffKg)} is within the ${data.allowanceKg} kg free allowance - no weight deduction.`
            : `Difference of ${kg(weights.diffKg)} exceeds the ${data.allowanceKg} kg free allowance - ${kg(kataDeductKg)} deducted below.`;
    doc.font(F.body).fontSize(7.5).fillColor(MUTED).text(kataNote, LEFT + 2, y, { width: W - 4 });
    y = doc.y + 8;

    // --- Particulars table --------------------------------------------------
    const drawTableHead = (yy: number): number => {
      doc.rect(LEFT, yy, W, 19).fill(INK);
      doc.font(F.semi).fontSize(7.5).fillColor('#ffffff');
      const head = { characterSpacing: 0.9 } as const;
      doc.text('PARTICULARS', COL_X.particulars + 6, yy + 6, { width: COL_W.particulars - 12, ...head });
      doc.text('QUANTITY', COL_X.qty, yy + 6, { width: COL_W.qty - 6, align: 'right', ...head });
      doc.text('RATE / KG', COL_X.rate, yy + 6, { width: COL_W.rate - 6, align: 'right', ...head });
      doc.text('AMOUNT (INR)', COL_X.amount, yy + 6, { width: COL_W.amount - 8, align: 'right', ...head });
      return yy + 19;
    };
    y = drawTableHead(y);

    interface Row {
      label: string;
      note?: string;
      qty?: string;
      rate?: string;
      amount?: number;
      /** Deduction - printed in brackets and red. */
      negative?: boolean;
      /** Subtotal / total styling. */
      emphasis?: 'none' | 'subtotal';
    }

    const rows: Row[] = [];

    rows.push({
      label: 'Tamarind seed (black seed)',
      note: data.selfVehicle ? "Delivered in party's own vehicle" : undefined,
      qty: kg(billedKg),
      rate: rate(price),
      amount: grossSeed,
    });

    if (kataDeductKg > 0) {
      rows.push({
        label: 'Less : Kata difference',
        note: `${kg(weights.diffKg)} short against ${kg(weights.referenceKg)} reference, ${data.allowanceKg} kg allowed free`,
        qty: kg(kataDeductKg),
        rate: rate(price),
        amount: kataDeductAmount,
        negative: true,
      });
    }

    for (const r of data.qualityAdjustments) {
      const amount = Number(r.amount) || 0;
      if (!amount) continue;
      const note = MODE_NOTE[r.mode];
      rows.push({
        label: `Less : ${r.label}`,
        note: r.label.toLowerCase() === note ? undefined : note,
        qty: r.mode === 'WEIGHT' ? kg(r.value) : undefined,
        rate: r.mode === 'WEIGHT' ? rate(price) : r.mode === 'PRICE' ? `${rate(r.value)}/kg` : undefined,
        amount,
        negative: true,
      });
    }

    const deductionsTotal = kataDeductAmount + data.qualityAdjustments.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const netSeedValue = grossSeed - deductionsTotal;
    const hasAdditions = data.gstAmount > 0 || data.billAddables.length > 0;
    const hasRecoveries = data.selfVehicleHamali > 0 || data.selfVehicleKata > 0;

    if (deductionsTotal > 0 && (hasAdditions || hasRecoveries)) {
      rows.push({ label: 'Net seed value', amount: netSeedValue, emphasis: 'subtotal' });
    }

    if (data.gstAmount > 0) {
      rows.push({
        label: `Add : IGST @ ${data.gstRate}%`,
        note: `on invoice value ${kg(data.gstBasisKg)} × ${rate(price)}`,
        amount: data.gstAmount,
      });
    }

    for (const a of data.billAddables) {
      const amount = Number(a.amount) || 0;
      if (!amount) continue;
      rows.push({ label: `Add : ${a.label}`, amount });
    }

    if (data.selfVehicleHamali > 0) {
      rows.push({
        label: 'Less : Hamali (unloading)',
        note: "lorry's share recovered - party's own vehicle",
        amount: data.selfVehicleHamali,
        negative: true,
      });
    }
    if (data.selfVehicleKata > 0) {
      rows.push({
        label: 'Less : Kata charges (weighbridge)',
        note: "recovered - party's own vehicle",
        amount: data.selfVehicleKata,
        negative: true,
      });
    }

    doc.font(F.body).fontSize(8.5);
    for (const r of rows) {
      const rowH = r.note ? 26 : 18;
      if (y + rowH > BOTTOM - 150) {
        doc.addPage();
        y = drawTableHead(PAGE.margin);
      }
      if (r.emphasis === 'subtotal') doc.rect(LEFT, y, W, rowH).fill(BAND);

      const labelFont = r.emphasis === 'subtotal' ? F.semi : F.body;
      // Adjustment rows sit one notch in from the goods line they act on.
      const indent = /^(Less|Add) :/.test(r.label) ? 14 : 6;
      doc.font(labelFont).fontSize(8.5).fillColor(INK).text(r.label, COL_X.particulars + indent, y + 5, {
        width: COL_W.particulars - indent - 6,
        lineBreak: false,
        ellipsis: true,
      });
      if (r.note) {
        doc.font(F.body).fontSize(6.5).fillColor(MUTED).text(r.note, COL_X.particulars + indent + 6, y + 15.5, {
          width: COL_W.particulars + COL_W.qty - indent - 12,
          lineBreak: false,
          ellipsis: true,
        });
      }
      doc.font(F.body).fontSize(8.5).fillColor(INK);
      if (r.qty) doc.text(r.qty, COL_X.qty, y + 5, { width: COL_W.qty - 6, align: 'right', lineBreak: false });
      if (r.rate) doc.text(r.rate, COL_X.rate, y + 5, { width: COL_W.rate - 6, align: 'right', lineBreak: false });
      if (r.amount != null) {
        const text = r.negative ? `(${inr(r.amount)})` : inr(r.amount);
        doc
          .font(r.emphasis === 'subtotal' ? F.semi : F.body)
          .fontSize(8.5)
          .fillColor(r.negative ? NEG : INK)
          .text(text, COL_X.amount, y + 5, { width: COL_W.amount - 8, align: 'right', lineBreak: false });
      }
      y += rowH;
      doc.lineWidth(0.5).strokeColor(HAIR).moveTo(LEFT, y).lineTo(RIGHT, y).stroke();
    }

    // --- Net payable band ---------------------------------------------------
    const bandH = 30;
    if (y + bandH > BOTTOM - 120) {
      doc.addPage();
      y = PAGE.margin;
    }
    doc.rect(LEFT, y, W, bandH).fill(INK);
    doc.font(F.bold).fontSize(10).fillColor('#ffffff');
    doc.text('NET BALANCE PAYABLE', COL_X.particulars + 6, y + 10, {
      width: COL_W.particulars + COL_W.qty,
      characterSpacing: 0.9,
    });
    doc.fontSize(13).text(`${inr(data.netPayable)}`, COL_X.rate, y + 8, {
      width: COL_W.rate + COL_W.amount - 8,
      align: 'right',
    });
    y += bandH + 8;

    doc.font(F.body).fontSize(7).fillColor(MUTED).text('Amount in words', LEFT + 2, y);
    doc.font(F.semi).fontSize(8.5).fillColor(INK).text(rupeesInWords(data.netPayable), LEFT + 2, y + 10, {
      width: W - 4,
    });
    y = doc.y + 12;

    // --- Footer -------------------------------------------------------------
    const footerY = Math.max(y, BOTTOM - 92);
    doc.lineWidth(0.6).strokeColor(HAIR).dash(2, { space: 2 }).moveTo(LEFT, footerY).lineTo(RIGHT, footerY).stroke();
    doc.undash();
    doc.font(F.body).fontSize(7).fillColor(MUTED).text(
      'Computer-generated statement. Please report any discrepancy within 7 days of receipt.',
      LEFT, footerY + 8, { width: W * 0.55 }
    );
    doc.font(F.semi).fontSize(8.5).fillColor(INK).text(`For ${company.name}`, LEFT + W * 0.6, footerY + 8, {
      width: W * 0.4,
      align: 'right',
    });
    drawSignatureMark(doc, {
      x: LEFT + W * 0.6,
      width: W * 0.4,
      y: footerY + 20,
      signHeight: 22,
      stampSize: 38,
    });
    doc
      .lineWidth(0.6)
      .strokeColor(HAIR)
      .moveTo(RIGHT - 110, footerY + 60)
      .lineTo(RIGHT, footerY + 60)
      .stroke();
    doc.font(F.body).fontSize(7.5).fillColor(MUTED).text('Authorised Signatory', LEFT + W * 0.6, footerY + 64, {
      width: W * 0.4,
      align: 'right',
    });

    doc.end();
  });
}
