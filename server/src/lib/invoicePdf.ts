import PDFDocument from 'pdfkit';
import { inr, rupeesInWords } from './invoice.js';
import { IST_TZ } from './istDate.js';
import { drawSignatureMark } from './signatureAssets.js';

export interface InvoicePdfData {
  company: {
    name: string;
    address?: string | null;
    gstin?: string | null;
    stateName?: string | null;
    stateCode?: string | null;
    contact?: string | null;
    bankAccountName?: string | null;
    bankName?: string | null;
    bankAccountNumber?: string | null;
    bankBranchIfsc?: string | null;
  };
  buyer: {
    name: string;
    address?: string | null;
    gstin?: string | null;
    stateName?: string | null;
    stateCode?: string | null;
    placeOfSupply?: string | null;
  };
  invoiceNumber: string;
  invoiceDate: Date;
  destination?: string | null;
  vehicleNumber?: string | null;
  line: { description: string; hsn: string; quantityKg: number; ratePerKg: number };
  gstRate: number; // e.g. 0.05
  ewbNumber?: string | null;
  irn?: {
    irn: string;
    ackNo: string;
    ackDate: Date;
    qrPngBuffer?: Buffer;
  } | null;
}

const mm = (v: number) => (v * 72) / 25.4;

const PAGE = { margin: mm(15), width: 595.28 };
const LEFT = PAGE.margin;
const RIGHT = PAGE.width - PAGE.margin;
const W = RIGHT - LEFT;

// Type scale mirrors client/src/components/InvoiceDocument.tsx, whose 12px CSS
// base is 9pt here. Keep the two in step - they are the same document.
const BASE = 9;
const CAP = 8.1;      // small cell captions ("Invoice No.", "Dated", ...)
const NAME = 10.35;   // company / buyer name
const TITLE = 16.65;
const TIGHT = 8.28;   // HSN summary table
const LG = 1.3;       // approximates the 1.28 line-height
const PAD_X = 4.5;
const PAD_Y = 2.2;
const QR = mm(38);

/** Goods table column widths, as fractions of the content width. */
const GOODS_COLS = [0.04, 0.47, 0.09, 0.11, 0.06, 0.05, 0.18];

type Align = 'left' | 'right' | 'center';
interface Opt { bold?: boolean; italic?: boolean; size?: number; align?: Align }

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { timeZone: IST_TZ, day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '-');
}

function fontFor(o?: Opt): string {
  if (o?.italic) return o.bold ? 'Helvetica-BoldOblique' : 'Helvetica-Oblique';
  return o?.bold ? 'Helvetica-Bold' : 'Helvetica';
}

/** Render the tax invoice as a PDF and resolve with the full Buffer. */
export function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const amount = data.line.quantityKg * data.line.ratePerKg;
    const gst = Math.round(amount * data.gstRate * 100) / 100;
    const total = amount + gst;
    const gstPct = Math.round(data.gstRate * 100);
    const taxed = data.gstRate > 0;

    const sellerStateCode = data.company.gstin?.slice(0, 2) || '';
    const buyerGstin = data.buyer.gstin || null;
    const buyerStateCode = buyerGstin && /^\d{2}/.test(buyerGstin) ? buyerGstin.slice(0, 2) : null;
    const buyerPan = buyerGstin && buyerGstin.length >= 12 ? buyerGstin.slice(2, 12) : null;
    const isSameState = !!sellerStateCode && sellerStateCode === buyerStateCode;
    const halfPct = (gstPct / 2).toFixed(1);
    const qtyStr = `${inr(data.line.quantityKg).replace(/\.00$/, '')} Kgs`;

    doc.lineWidth(0.7).strokeColor('#000');

    // Drawing helpers --------------------------------------------------------
    const hline = (y: number, x1 = LEFT, x2 = RIGHT) => doc.moveTo(x1, y).lineTo(x2, y).stroke();
    const vline = (x: number, y1: number, y2: number) => doc.moveTo(x, y1).lineTo(x, y2).stroke();

    /** Draw text and return the y the cursor ended on. */
    const txt = (t: string, x: number, y: number, w: number, o?: Opt): number => {
      doc.font(fontFor(o)).fontSize(o?.size ?? BASE).fillColor('#000')
        .text(t, x, y, { width: w, align: o?.align ?? 'left', lineGap: LG });
      return doc.y;
    };
    const hgt = (t: string, w: number, o?: Opt): number => {
      doc.font(fontFor(o)).fontSize(o?.size ?? BASE);
      return doc.heightOfString(t, { width: w, lineGap: LG });
    };
    /** Text inset by the shared cell padding. */
    const cell = (t: string, x: number, y: number, w: number, o?: Opt) =>
      txt(t, x + PAD_X, y + PAD_Y, w - PAD_X * 2, o);

    /**
     * Short values - invoice numbers, EWB numbers, amounts - have no space for
     * PDFKit to wrap at, so an oversized one runs straight past the column rule
     * and collides with its neighbour. The HTML solves this by letting the
     * column grow; a PDF's columns are fixed, so shrink the text to fit instead.
     */
    const fit = (t: string, w: number, o?: Opt): Opt => {
      const size = o?.size ?? BASE;
      doc.font(fontFor(o)).fontSize(size);
      const need = doc.widthOfString(t);
      return need <= w ? { ...o, size } : { ...o, size: Math.max(5.5, size * (w / need)) };
    };
    /** Cell text that never overflows its column. */
    const cellFit = (t: string, x: number, y: number, w: number, o?: Opt) =>
      cell(t, x, y, w, fit(t, w - PAD_X * 2, o));

    /**
     * PDFKit only breaks on whitespace, so an unspaced 64-char IRN would run off
     * the page. Chop it into width-sized pieces ourselves.
     */
    const hardWrap = (s: string, w: number, o?: Opt): string => {
      doc.font(fontFor(o)).fontSize(o?.size ?? BASE);
      if (doc.widthOfString(s) <= w) return s;
      const out: string[] = [];
      let cur = '';
      for (const ch of s) {
        if (cur && doc.widthOfString(cur + ch) > w) { out.push(cur); cur = ch; } else cur += ch;
      }
      if (cur) out.push(cur);
      return out.join('\n');
    };

    /** "Label : bold value" with the colons lined up in a column. */
    const keyed = (k: string, v: string, x: number, y: number, w: number, keyW: number, plain?: boolean): number => {
      txt(k, x, y, keyW);
      txt(':', x + keyW, y, mm(3));
      return txt(v, x + keyW + mm(3), y, w - keyW - mm(3), { bold: !plain });
    };

    /** "Label: bold value" flowing on one line. */
    const inlineKv = (k: string, v: string, x: number, y: number, w: number): number => {
      doc.font('Helvetica').fontSize(BASE).fillColor('#000')
        .text(k, x, y, { width: w, lineGap: LG, continued: true })
        .font('Helvetica-Bold').text(v, { lineGap: LG });
      return doc.y;
    };

    let y = PAGE.margin;

    // Title + IRN / QR header block ------------------------------------------
    if (data.irn) {
      const qrX = RIGHT - QR;
      const headW = qrX - mm(6) - LEFT;

      txt('Tax Invoice', LEFT, y, headW, { bold: true, size: TITLE, align: 'center' });
      let iy = y + hgt('Tax Invoice', headW, { bold: true, size: TITLE }) + mm(9);

      const keyW = mm(17);
      const valW = headW - keyW - mm(3);
      const irnRows: [string, string][] = [
        ['IRN', hardWrap(data.irn.irn, valW, { bold: true })],
        ['Ack No.', data.irn.ackNo || '-'],
        ['Ack Date', data.irn.ackDate ? fmtDate(data.irn.ackDate) : '-'],
      ];
      for (const [k, v] of irnRows) {
        iy = keyed(k, v, LEFT, iy, headW, keyW) + mm(1.5);
      }

      txt('e-Invoice', qrX, y, QR, { bold: true, align: 'center' });
      const qrTop = y + hgt('e-Invoice', QR, { bold: true }) + mm(2);
      if (data.irn.qrPngBuffer) doc.image(data.irn.qrPngBuffer, qrX, qrTop, { width: QR, height: QR });

      y = Math.max(iy, qrTop + QR) + mm(5);
    } else {
      txt('Tax Invoice', LEFT, y, W, { bold: true, size: TITLE, align: 'center' });
      y += hgt('Tax Invoice', W, { bold: true, size: TITLE }) + mm(5);
    }

    // Header table: seller/buyer (left) + 8-row meta grid (right) -------------
    const headerTop = y;
    const splitX = LEFT + W * 0.51;
    const metaW = (RIGHT - splitX) / 4;
    const leftInner = splitX - LEFT - PAD_X * 2;
    const bx = LEFT + PAD_X;

    let ly = headerTop + PAD_Y;
    ly = txt(data.company.name, bx, ly, leftInner, { bold: true, size: NAME });
    if (data.company.address) ly = txt(data.company.address, bx, ly, leftInner);
    if (data.company.gstin) ly = inlineKv('GSTIN/UIN: ', data.company.gstin, bx, ly, leftInner);
    if (data.company.stateName) {
      ly = txt(`State Name : ${data.company.stateName}${data.company.stateCode ? `, Code : ${data.company.stateCode}` : ''}`, bx, ly, leftInner);
    }
    if (data.company.contact) ly = txt(`Contact : ${data.company.contact}`, bx, ly, leftInner);

    const sellerBottom = ly + PAD_Y;
    ly = sellerBottom + PAD_Y;
    const buyerKeyW = mm(30);
    ly = txt('Buyer (Bill to)', bx, ly, leftInner);
    ly = txt(data.buyer.name, bx, ly, leftInner, { bold: true, size: NAME });
    if (data.buyer.address) ly = txt(data.buyer.address, bx, ly, leftInner);
    if (buyerGstin) ly = keyed('GSTIN/UIN', buyerGstin, bx, ly, leftInner, buyerKeyW);
    if (buyerPan) ly = keyed('PAN/IT No', buyerPan, bx, ly, leftInner, buyerKeyW);
    if (data.buyer.stateName) {
      ly = keyed('State Name', `${data.buyer.stateName}${buyerStateCode ? `, Code : ${buyerStateCode}` : ''}`, bx, ly, leftInner, buyerKeyW, true);
    }
    if (data.buyer.placeOfSupply) ly = keyed('Place of Supply', data.buyer.placeOfSupply, bx, ly, leftInner, buyerKeyW, true);

    // Meta rows stretch to match the seller/buyer column, exactly as the HTML
    // table's rowSpan does.
    const minRowH = CAP * 1.35 + BASE * 1.35 + PAD_Y * 2;
    const rowH = Math.max(minRowH, (ly + PAD_Y - headerTop) / 8);
    const headerBottom = headerTop + rowH * 8;

    const metaCell = (label: string, value: string, x: number, ry: number, w: number, bold?: boolean) => {
      txt(label, x + PAD_X, ry + PAD_Y, w - PAD_X * 2, { size: CAP });
      if (value) txt(value, x + PAD_X, ry + PAD_Y + CAP * 1.35, w - PAD_X * 2, { bold });
    };

    const rY = (i: number) => headerTop + rowH * i;
    metaCell('Invoice No.', data.invoiceNumber, splitX, rY(0), metaW, true);
    metaCell('e-Way Bill No.', data.ewbNumber ?? '', splitX + metaW, rY(0), metaW, true);
    metaCell('Dated', fmtDate(data.invoiceDate), splitX + metaW * 2, rY(0), metaW * 2, true);

    const pairs: [string, string, string, string, boolean?][] = [
      ['Delivery Note', '', 'Mode/Terms of Payment', ''],
      ['Reference No. & Date.', '', 'Other References', ''],
      ["Buyer's Order No.", '', 'Dated', ''],
      ['Dispatch Doc No.', '', 'Delivery Note Date', ''],
      ['Dispatched through', 'Road', 'Destination', data.destination ?? '', true],
      ['Bill of Lading/LR-RR No.', '', 'Motor Vehicle No.', data.vehicleNumber ?? '', true],
    ];
    pairs.forEach(([lk, lv, rk, rv, bold], i) => {
      metaCell(lk, lv, splitX, rY(i + 1), metaW * 2, bold);
      metaCell(rk, rv, splitX + metaW * 2, rY(i + 1), metaW * 2, bold);
    });
    metaCell('Terms of Delivery', '', splitX, rY(7), metaW * 4);

    // Header borders.
    doc.rect(LEFT, headerTop, W, headerBottom - headerTop).stroke();
    vline(splitX, headerTop, headerBottom);
    hline(sellerBottom, LEFT, splitX);
    for (let i = 1; i < 8; i++) hline(rY(i), splitX, RIGHT);
    vline(splitX + metaW, rY(0), rY(1));
    vline(splitX + metaW * 2, rY(0), rY(7));

    y = headerBottom;

    // Goods table ------------------------------------------------------------
    const gw = GOODS_COLS.map((p) => p * W);
    const gx: number[] = [];
    let acc = LEFT;
    for (const w of gw) { gx.push(acc); acc += w; }
    gw[gw.length - 1] = RIGHT - gx[gx.length - 1];

    const thTop = y;
    const thH = BASE * 1.35 * 2 + PAD_Y * 2;
    cell('Sl\nNo.', gx[0], thTop, gw[0], { bold: true });
    const heads: [number, string][] = [
      [1, 'Description of Goods'], [2, 'HSN/SAC'], [3, 'Quantity'], [4, 'Rate'], [5, 'per'], [6, 'Amount'],
    ];
    for (const [i, t] of heads) cell(t, gx[i], thTop, gw[i], { bold: true, align: 'center' });

    const itemTop = thTop + thH;
    cell('1', gx[0], itemTop, gw[0], { bold: true, align: 'center' });
    cell(data.line.description, gx[1], itemTop, gw[1], { bold: true });
    cell(data.line.hsn, gx[2], itemTop, gw[2]);
    cell(qtyStr, gx[3], itemTop, gw[3], { bold: true, align: 'right' });
    cell(data.line.ratePerKg.toFixed(2), gx[4], itemTop, gw[4], { align: 'right' });
    cell('Kgs', gx[5], itemTop, gw[5]);
    cell(inr(amount), gx[6], itemTop, gw[6], { bold: true, align: 'right' });

    let ty = itemTop + BASE * 1.35 + PAD_Y * 2;
    const taxLine = (label: string, rate: string, amt: number) => {
      cell(label, gx[1], ty, gw[1], { bold: true, italic: true, align: 'right' });
      cell(rate, gx[4], ty, gw[4], { align: 'right' });
      cell('%', gx[5], ty, gw[5]);
      cell(inr(amt), gx[6], ty, gw[6], { bold: true, align: 'right' });
      ty += BASE * 1.35 + PAD_Y;
    };
    if (taxed) {
      if (isSameState) {
        taxLine(`CGST ${halfPct}%`, halfPct, gst / 2);
        taxLine(`SGST ${halfPct}%`, halfPct, gst / 2);
      } else {
        taxLine(`IGST ${gstPct}%`, String(gstPct), gst);
      }
    }

    const totTop = ty + mm(3);
    const totH = BASE * 1.35 + PAD_Y * 2;
    cell('Total', gx[0], totTop, gw[0] + gw[1], { bold: true, align: 'right' });
    cell(qtyStr, gx[3], totTop, gw[3], { bold: true, align: 'right' });
    cell(`Rs. ${inr(total)}`, gx[6], totTop, gw[6], { bold: true, align: 'right' });
    const goodsBottom = totTop + totH;

    doc.rect(LEFT, thTop, W, goodsBottom - thTop).stroke();
    hline(itemTop);
    hline(totTop);
    // The item/tax band is one open block: vertical rules run through it, no
    // horizontal ones. The Sl|Description rule stops at the merged Total cell.
    vline(gx[1], thTop, totTop);
    for (let i = 2; i < gx.length; i++) vline(gx[i], thTop, goodsBottom);

    y = goodsBottom;

    // Amount chargeable in words ---------------------------------------------
    const awTop = y;
    txt('Amount Chargeable (in words)', LEFT + PAD_X, awTop + PAD_Y, W * 0.6, { size: CAP });
    txt('E. & O.E', LEFT, awTop + PAD_Y, W - PAD_X, { size: CAP, italic: true, align: 'right' });
    const wordsY = awTop + PAD_Y + CAP * 1.35;
    txt(rupeesInWords(total), LEFT + PAD_X, wordsY, W - PAD_X * 2, { bold: true });
    const awBottom = wordsY + hgt(rupeesInWords(total), W - PAD_X * 2, { bold: true }) + PAD_Y;
    doc.rect(LEFT, awTop, W, awBottom - awTop).stroke();
    y = awBottom;

    // HSN / tax summary ------------------------------------------------------
    const sp = isSameState ? [0.41, 0.11, 0.06, 0.12, 0.06, 0.12, 0.12] : [0.59, 0.11, 0.06, 0.12, 0.12];
    const sw = sp.map((p) => p * W);
    const sx: number[] = [];
    let sacc = LEFT;
    for (const w of sw) { sx.push(sacc); sacc += w; }
    sw[sw.length - 1] = RIGHT - sx[sx.length - 1];
    const last = sx.length - 1;

    const sPadY = 1;
    const sRowH = TIGHT * 1.35 + sPadY * 2;
    const sCell = (t: string, i: number, ry: number, o?: Opt, spanTo = i) =>
      txt(t, sx[i] + PAD_X, ry + sPadY, sx[spanTo] + sw[spanTo] - sx[i] - PAD_X * 2, { size: TIGHT, ...o });

    const sTop = y;
    const sHeadMid = sTop + sRowH;
    const sHeadBottom = sTop + sRowH * 2;
    sCell('HSN/SAC', 0, sTop, { align: 'center' });
    sCell('Taxable\nValue', 1, sTop, { align: 'center' });
    if (isSameState) {
      sCell('Central Tax', 2, sTop, { align: 'center' }, 3);
      sCell('State Tax', 4, sTop, { align: 'center' }, 5);
      sCell('Rate', 2, sHeadMid, { align: 'center' });
      sCell('Amount', 3, sHeadMid, { align: 'center' });
      sCell('Rate', 4, sHeadMid, { align: 'center' });
      sCell('Amount', 5, sHeadMid, { align: 'center' });
    } else {
      sCell('IGST', 2, sTop, { align: 'center' }, 3);
      sCell('Rate', 2, sHeadMid, { align: 'center' });
      sCell('Amount', 3, sHeadMid, { align: 'center' });
    }
    sCell('Total\nTax Amount', last, sTop, { align: 'center' });

    const sDataY = sHeadBottom;
    const sTotY = sDataY + sRowH;
    const sBottom = sTotY + sRowH;
    sCell(data.line.hsn, 0, sDataY);
    sCell(inr(amount), 1, sDataY, { align: 'right' });
    if (isSameState) {
      sCell(`${halfPct}%`, 2, sDataY, { align: 'center' });
      sCell(inr(gst / 2), 3, sDataY, { align: 'right' });
      sCell(`${halfPct}%`, 4, sDataY, { align: 'center' });
      sCell(inr(gst / 2), 5, sDataY, { align: 'right' });
    } else {
      sCell(`${gstPct}%`, 2, sDataY, { align: 'center' });
      sCell(inr(gst), 3, sDataY, { align: 'right' });
    }
    sCell(inr(gst), last, sDataY, { align: 'right' });

    sCell('Total', 0, sTotY, { bold: true, align: 'right' });
    sCell(inr(amount), 1, sTotY, { bold: true, align: 'right' });
    if (isSameState) {
      sCell(inr(gst / 2), 3, sTotY, { bold: true, align: 'right' });
      sCell(inr(gst / 2), 5, sTotY, { bold: true, align: 'right' });
    } else {
      sCell(inr(gst), 3, sTotY, { bold: true, align: 'right' });
    }
    sCell(inr(gst), last, sTotY, { bold: true, align: 'right' });

    doc.rect(LEFT, sTop, W, sBottom - sTop).stroke();
    hline(sHeadBottom);
    hline(sTotY);
    for (let i = 1; i < sx.length; i++) vline(sx[i], sTop, sBottom);
    // The rate/amount splits only exist under the tax group headers.
    hline(sHeadMid, sx[2], sx[last]);
    y = sBottom;

    // Tax amount in words ----------------------------------------------------
    const twTop = y;
    doc.font('Helvetica').fontSize(BASE).fillColor('#000')
      .text('Tax Amount (in words) : ', LEFT + PAD_X, twTop + PAD_Y, { width: W - PAD_X * 2, lineGap: LG, continued: true })
      .font('Helvetica-Bold').text(rupeesInWords(gst), { lineGap: LG });
    const twBottom = doc.y + PAD_Y;
    doc.rect(LEFT, twTop, W, twBottom - twTop).stroke();
    y = twBottom;

    // Declaration + bank details ---------------------------------------------
    const decTop = y;
    const midX = LEFT + W * 0.5;
    const decW = midX - LEFT - PAD_X * 2;

    let dy = decTop + PAD_Y;
    txt('Declaration', LEFT + PAD_X, dy, decW);
    doc.moveTo(LEFT + PAD_X, doc.y - 1).lineTo(LEFT + PAD_X + doc.widthOfString('Declaration'), doc.y - 1).stroke();
    dy = doc.y;
    dy = txt('We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.', LEFT + PAD_X, dy, decW);
    dy = txt('Terms & Conditions', LEFT + PAD_X, dy + 3, decW, { bold: true });
    dy = txt('E. & O.E.', LEFT + PAD_X, dy, decW);
    dy = txt('1. Goods once sold will not be taken back.', LEFT + PAD_X, dy, decW);
    dy = txt('2. Interest @ 18% p.a. will be charged', LEFT + PAD_X, dy, decW);
    dy = txt('if the payment is not made with in the stipulated time.', LEFT + PAD_X, dy, decW);
    if (data.company.stateName) {
      dy = txt(`3. Subject to '${data.company.stateName}' Jurisdiction only.`, LEFT + PAD_X, dy, decW);
    }

    const bankX = midX + PAD_X;
    const bankW = RIGHT - midX - PAD_X * 2;
    let by = decTop + PAD_Y;
    by = txt("Company's Bank Details", bankX, by, bankW, { bold: true });
    const bankKeyW = mm(34);
    const bankRows: [string, string | null | undefined][] = [
      ["A/c Holder's Name", data.company.bankAccountName || data.company.name],
      ['Bank Name', data.company.bankName],
      ['A/c No.', data.company.bankAccountNumber],
      ['Branch & IFS Code', data.company.bankBranchIfsc],
    ];
    for (const [k, v] of bankRows) by = keyed(k, v || '', bankX, by, bankW, bankKeyW);

    // Signature box sits below the bank rows, in the right column only.
    const sigTop = Math.max(by + PAD_Y, decTop + mm(22));
    let sy = txt(`for ${data.company.name}`, bankX, sigTop + PAD_Y, bankW, { bold: true, align: 'right' });
    const signH = (data.company as any).signatureHeight || 48;
    const stampS = (data.company as any).stampSize || 80;
    sy = drawSignatureMark(doc, { x: bankX, width: bankW, y: sy + 1, signHeight: signH, stampSize: stampS });
    txt('Authorised Signatory', bankX, sy + 1, bankW, { align: 'right' });
    const sigBottom = sy + 1 + BASE * 1.35 + PAD_Y;

    const decBottom = Math.max(dy + PAD_Y, sigBottom);
    doc.rect(LEFT, decTop, W, decBottom - decTop).stroke();
    vline(midX, decTop, decBottom);
    hline(sigTop, midX, RIGHT);
    y = decBottom + mm(2);

    txt('This is a Computer Generated Invoice', LEFT, y, W, { align: 'center' });

    doc.end();
  });
}
