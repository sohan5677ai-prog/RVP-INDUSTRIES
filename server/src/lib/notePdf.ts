import PDFDocument from 'pdfkit';
import { inr, rupeesInWords } from './invoice.js';
import { IST_TZ } from './istDate.js';
import { drawSignatureMark } from './signatureAssets.js';

export interface NotePdfParty {
  name: string;
  address?: string | null;
  gstin?: string | null;
  stateName?: string | null;
  stateCode?: string | null;
}

export interface NotePdfData {
  kind: 'CREDIT' | 'DEBIT';
  company: {
    name: string;
    address?: string | null;
    gstin?: string | null;
    stateName?: string | null;
    stateCode?: string | null;
    contact?: string | null;
    email?: string | null;
    signatureHeight?: number;
    stampSize?: number;
    bankAccountName?: string | null;
    bankName?: string | null;
    bankAccountNumber?: string | null;
    bankBranchIfsc?: string | null;
  };
  consignee?: NotePdfParty | null;
  buyer: NotePdfParty;
  noteNumber: string;
  noteDate: Date;
  ewbNumber?: string | null;
  originalInvoiceNumber?: string | null;
  originalInvoiceDate?: Date | null;
  modeTermsOfPayment?: string | null;
  otherReferences?: string | null;
  poNumber?: string | null;
  poDate?: Date | null;
  dispatchDocNo?: string | null;
  dispatchedThrough?: string | null;
  destination?: string | null;
  termsOfDelivery?: string | null;
  motorVehicleNo?: string | null;
  line: {
    description: string;
    hsn: string;
    quantityKg?: number | null;
    ratePerKg?: number | null;
    unit?: string;
  };
  taxableValue: number;
  gstRate: number; // percent, e.g. 5
  gstAmount: number;
  totalAmount: number;
  reason?: string | null;
  referenceInvoiceNumber?: string | null; // legacy alias
}

const mm = (v: number) => (v * 72) / 25.4;

const PAGE = { margin: mm(15), width: 595.28 };
const LEFT = PAGE.margin;
const RIGHT = PAGE.width - PAGE.margin;
const W = RIGHT - LEFT;

const BASE = 9;
const CAP = 8.1;
const NAME = 10.35;
const TITLE = 16.65;
const TIGHT = 8.28;
const LG = 1.3;
const PAD_X = 4.5;
const PAD_Y = 2.2;

const GOODS_COLS = [0.048, 0.462, 0.09, 0.11, 0.06, 0.05, 0.18];
const FIT_FLOOR = 5;

type Align = 'left' | 'right' | 'center';
interface Opt { bold?: boolean; italic?: boolean; size?: number; align?: Align }

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '';
  const dateObj = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(dateObj.getTime())) return '';
  return dateObj.toLocaleDateString('en-GB', { timeZone: IST_TZ, day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '-');
}

function fontFor(o?: Opt): string {
  if (o?.italic) return o.bold ? 'Helvetica-BoldOblique' : 'Helvetica-Oblique';
  return o?.bold ? 'Helvetica-Bold' : 'Helvetica';
}

/** Render a credit/debit note as a Tally-compliant Tax Invoice PDF. */
export function renderNotePdf(data: NotePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const buyer = data.buyer || (data as any).party || { name: '-' };
    const consignee = data.consignee || buyer;

    const sellerStateCode = data.company.gstin?.slice(0, 2) || '';
    const buyerGstin = buyer.gstin || null;
    const buyerStateCode = buyerGstin && /^\d{2}/.test(buyerGstin) ? buyerGstin.slice(0, 2) : (buyer.stateCode || null);
    const isSameState = !!sellerStateCode && sellerStateCode === buyerStateCode;

    const gstPct = Math.round(data.gstRate);
    const halfPct = (data.gstRate / 2).toFixed(1).replace(/\.0$/, '');

    const origInvNumber = data.originalInvoiceNumber || data.referenceInvoiceNumber || null;
    const origInvDate = data.originalInvoiceDate || null;
    const origInvoiceStr = origInvNumber
      ? `${origInvNumber}${origInvDate ? ` dt. ${fmtDate(origInvDate)}` : ''}`
      : '';

    const lineQty = data.line?.quantityKg != null && data.line.quantityKg > 0 ? data.line.quantityKg : null;
    const lineUnit = data.line?.unit || 'Kgs';
    const qtyStr = lineQty ? `${inr(lineQty).replace(/\.00$/, '')} ${lineUnit}` : '';
    const rateStr = data.line?.ratePerKg != null && data.line.ratePerKg > 0 ? Number(data.line.ratePerKg).toFixed(2) : '';

    doc.lineWidth(0.7).strokeColor('#000');

    // Drawing helpers --------------------------------------------------------
    const hline = (y: number, x1 = LEFT, x2 = RIGHT) => doc.moveTo(x1, y).lineTo(x2, y).stroke();
    const vline = (x: number, y1: number, y2: number) => doc.moveTo(x, y1).lineTo(x, y2).stroke();

    const txt = (t: string, x: number, y: number, w: number, o?: Opt): number => {
      doc.font(fontFor(o)).fontSize(o?.size ?? BASE).fillColor('#000')
        .text(t, x, y, { width: w, align: o?.align ?? 'left', lineGap: LG });
      return doc.y;
    };

    const hgt = (t: string, w: number, o?: Opt): number => {
      doc.font(fontFor(o)).fontSize(o?.size ?? BASE);
      return doc.heightOfString(t, { width: w, lineGap: LG });
    };

    const fit = (t: string, w: number, o?: Opt): Opt => {
      const base = o?.size ?? BASE;
      const lines = t.split('\n');
      const widest = (size: number) => {
        doc.font(fontFor(o)).fontSize(size);
        return Math.max(...lines.map((s) => doc.widthOfString(s)));
      };
      const need = widest(base);
      if (need <= w) return { ...o, size: base };
      let size = Math.max(FIT_FLOOR, base * (w / need));
      while (size > FIT_FLOOR && widest(size) > w) size -= 0.1;
      return { ...o, size };
    };

    const cellFit = (t: string, x: number, y: number, w: number, o?: Opt) => {
      const inner = w - PAD_X * 2;
      return txt(t, x + PAD_X, y + PAD_Y, inner, fit(t, inner, o));
    };

    const keyed = (k: string, v: string, x: number, y: number, w: number, keyW: number, plain?: boolean): number => {
      txt(k, x, y, keyW);
      txt(':', x + keyW, y, mm(3));
      return txt(v, x + keyW + mm(3), y, w - keyW - mm(3), { bold: !plain });
    };

    let y = PAGE.margin;

    // Document Title: "Tax Invoice" centered at the top
    txt('Tax Invoice', LEFT, y, W, { bold: true, size: TITLE, align: 'center' });
    y += hgt('Tax Invoice', W, { bold: true, size: TITLE }) + mm(4);

    // Header Table: Left (Seller / Consignee / Buyer) + Right (7-Row Meta Grid)
    const headerTop = y;
    const splitX = LEFT + W * 0.51;
    const rightW = RIGHT - splitX;
    const leftInner = splitX - LEFT - PAD_X * 2;
    const bx = LEFT + PAD_X;

    // Render left column: Seller, Consignee, Buyer
    let ly = headerTop + PAD_Y;
    ly = txt(data.company.name, bx, ly, leftInner, { bold: true, size: NAME });
    if (data.company.address) ly = txt(data.company.address, bx, ly, leftInner);
    if (data.company.gstin) ly = txt(`GSTIN/UIN: ${data.company.gstin}`, bx, ly, leftInner);
    if (data.company.stateName) {
      ly = txt(`State Name : ${data.company.stateName}${data.company.stateCode ? `, Code : ${data.company.stateCode}` : ''}`, bx, ly, leftInner);
    }
    const companyEmail = data.company.email || 'rvpindustries2024@gmail.com';
    ly = txt(`E-Mail : ${companyEmail}`, bx, ly, leftInner);
    if (data.company.contact) ly = txt(`Contact : ${data.company.contact}`, bx, ly, leftInner);

    const sellerBottom = ly + PAD_Y;
    ly = sellerBottom + PAD_Y;

    // Consignee (Ship to)
    const partyKeyW = mm(26);
    ly = txt('Consignee (Ship to)', bx, ly, leftInner);
    ly = txt(consignee.name, bx, ly, leftInner, { bold: true, size: NAME });
    if (consignee.address) ly = txt(consignee.address, bx, ly, leftInner);
    if (consignee.gstin) ly = keyed('GSTIN/UIN', consignee.gstin, bx, ly, leftInner, partyKeyW);
    if (consignee.stateName) {
      ly = keyed('State Name', `${consignee.stateName}${consignee.stateCode ? `, Code : ${consignee.stateCode}` : ''}`, bx, ly, leftInner, partyKeyW, true);
    }

    const consigneeBottom = ly + PAD_Y;
    ly = consigneeBottom + PAD_Y;

    // Buyer (Bill to)
    ly = txt('Buyer (Bill to)', bx, ly, leftInner);
    ly = txt(buyer.name, bx, ly, leftInner, { bold: true, size: NAME });
    if (buyer.address) ly = txt(buyer.address, bx, ly, leftInner);
    if (buyer.gstin) ly = keyed('GSTIN/UIN', buyer.gstin, bx, ly, leftInner, partyKeyW);
    if (buyer.stateName) {
      ly = keyed('State Name', `${buyer.stateName}${buyer.stateCode ? `, Code : ${buyer.stateCode}` : ''}`, bx, ly, leftInner, partyKeyW, true);
    }

    const buyerBottom = ly + PAD_Y;

    // Calculate height of 7 right-hand meta rows to match the left column
    const minRowH = CAP * 1.35 + BASE * 1.35 + PAD_Y * 2;
    const rowH = Math.max(minRowH, (buyerBottom - headerTop) / 7);
    const headerBottom = headerTop + rowH * 7;

    const rY = (i: number) => headerTop + rowH * i;

    const metaCell = (label: string, value: string, x: number, ry: number, w: number, bold?: boolean) => {
      const inner = w - PAD_X * 2;
      txt(label, x + PAD_X, ry + PAD_Y, inner, fit(label, inner, { size: CAP }));
      if (value) txt(value, x + PAD_X, ry + PAD_Y + CAP * 1.35, inner, fit(value, inner, { bold }));
    };

    // Row 0: Note No. / e-Way Bill No. / Dated
    const halfRightW = rightW / 2;
    const noteColLabel = data.kind === 'CREDIT' ? 'Credit Note No.' : 'Debit Note No.';
    const col0W = rightW * 0.32;
    const col1W = rightW * 0.30;
    const col2W = rightW - col0W - col1W;

    metaCell(noteColLabel, data.noteNumber, splitX, rY(0), col0W, true);
    metaCell('e-Way Bill No.', data.ewbNumber ?? '', splitX + col0W, rY(0), col1W, true);
    metaCell('Dated', fmtDate(data.noteDate), splitX + col0W + col1W, rY(0), col2W, true);

    // Row 1: Spans left, Mode/Terms of Payment right
    metaCell('Mode/Terms of Payment', data.modeTermsOfPayment ?? '', splitX + halfRightW, rY(1), halfRightW);

    // Row 2: Original Invoice No. & Date. / Other References
    metaCell('Original Invoice No. & Date.', origInvoiceStr, splitX, rY(2), halfRightW, true);
    metaCell('Other References', data.otherReferences ?? '', splitX + halfRightW, rY(2), halfRightW, true);

    // Row 3: Buyer's Order No. / Dated
    metaCell("Buyer's Order No.", data.poNumber ?? '', splitX, rY(3), halfRightW, true);
    metaCell('Dated', data.poDate ? fmtDate(data.poDate) : '', splitX + halfRightW, rY(3), halfRightW, true);

    // Row 4: Dispatch Doc No. / blank
    metaCell('Dispatch Doc No.', data.dispatchDocNo ?? '', splitX, rY(4), halfRightW, true);

    // Row 5: Dispatched through / Destination
    metaCell('Dispatched through', data.dispatchedThrough || 'Road', splitX, rY(5), halfRightW, true);
    metaCell('Destination', data.destination ?? '', splitX + halfRightW, rY(5), halfRightW, true);

    // Row 6: Terms of Delivery (full width)
    metaCell('Terms of Delivery', data.termsOfDelivery ?? '', splitX, rY(6), rightW);

    // Header grid borders
    doc.rect(LEFT, headerTop, W, headerBottom - headerTop).stroke();
    vline(splitX, headerTop, headerBottom);

    // Horizontal dividers in left column
    hline(sellerBottom, LEFT, splitX);
    hline(consigneeBottom, LEFT, splitX);

    // Horizontal dividers in right column
    for (let i = 1; i < 7; i++) hline(rY(i), splitX, RIGHT);

    // Vertical dividers in right column
    vline(splitX + col0W, rY(0), rY(1));
    vline(splitX + col0W + col1W, rY(0), rY(1));
    vline(splitX + halfRightW, rY(1), rY(6));

    y = headerBottom;

    // Goods Table ------------------------------------------------------------
    const gw = GOODS_COLS.map((p) => p * W);
    const gx: number[] = [];
    let acc = LEFT;
    for (const w of gw) { gx.push(acc); acc += w; }
    gw[gw.length - 1] = RIGHT - gx[gx.length - 1];

    const thTop = y;
    const thH = BASE * 1.35 * 2 + PAD_Y * 2;
    cellFit('Sl\nNo.', gx[0], thTop, gw[0], { bold: true });
    const heads: [number, string][] = [
      [1, 'Description of Goods'], [2, 'HSN/SAC'], [3, 'Quantity'], [4, 'Rate'], [5, 'per'], [6, 'Amount'],
    ];
    for (const [i, t] of heads) cellFit(t, gx[i], thTop, gw[i], { bold: true, align: 'center' });

    const itemTop = thTop + thH;
    const itemDescription = data.line?.description || data.reason || (data.kind === 'CREDIT' ? 'Credit Note Adjustment' : 'Debit Note Adjustment');
    const itemHsn = data.line?.hsn || '1207';

    cellFit('1', gx[0], itemTop, gw[0], { bold: true, align: 'center' });
    cellFit(itemDescription, gx[1], itemTop, gw[1], { bold: true });
    cellFit(itemHsn, gx[2], itemTop, gw[2], { align: 'center' });
    if (qtyStr) cellFit(qtyStr, gx[3], itemTop, gw[3], { bold: true, align: 'right' });
    if (rateStr) cellFit(rateStr, gx[4], itemTop, gw[4], { align: 'right' });
    if (qtyStr) cellFit(lineUnit, gx[5], itemTop, gw[5], { align: 'center' });
    cellFit(inr(data.taxableValue), gx[6], itemTop, gw[6], { bold: true, align: 'right' });

    let ty = itemTop + BASE * 1.35 + PAD_Y * 2.5;

    // Tax rows inside goods table
    const taxLine = (label: string, rate: string, amt: number) => {
      cellFit(label, gx[1], ty, gw[1], { bold: true, italic: true, align: 'right' });
      cellFit(`${rate} %`, gx[5], ty, gw[5], { align: 'center' });
      cellFit(inr(amt), gx[6], ty, gw[6], { bold: true, align: 'right' });
      ty += BASE * 1.35 + PAD_Y;
    };

    if (data.gstRate > 0) {
      if (isSameState) {
        taxLine(`CGST ${halfPct}%`, halfPct, data.gstAmount / 2);
        taxLine(`SGST ${halfPct}%`, halfPct, data.gstAmount / 2);
      } else {
        taxLine(`IGST ${gstPct}%`, String(gstPct), data.gstAmount);
      }
    }

    // Allocate generous vertical height for goods table matching Tally printout
    const minGoodsHeight = 115;
    const totTop = Math.max(ty + mm(4), itemTop + minGoodsHeight);
    const totH = BASE * 1.35 + PAD_Y * 2;

    cellFit('Total', gx[0], totTop, gw[0] + gw[1], { bold: true, align: 'right' });
    if (qtyStr) cellFit(qtyStr, gx[3], totTop, gw[3], { bold: true, align: 'right' });
    cellFit(`Rs. ${inr(data.totalAmount)}`, gx[6], totTop, gw[6], { bold: true, align: 'right' });

    const goodsBottom = totTop + totH;

    doc.rect(LEFT, thTop, W, goodsBottom - thTop).stroke();
    hline(itemTop);
    hline(totTop);

    vline(gx[1], thTop, totTop);
    for (let i = 2; i < gx.length; i++) vline(gx[i], thTop, goodsBottom);

    y = goodsBottom;

    // Amount Chargeable in words ---------------------------------------------
    const awTop = y;
    txt('Amount Chargeable (in words)', LEFT + PAD_X, awTop + PAD_Y, W * 0.6, { size: CAP });
    txt('E. & O.E', LEFT, awTop + PAD_Y, W - PAD_X, { size: CAP, italic: true, align: 'right' });
    const wordsY = awTop + PAD_Y + CAP * 1.35;
    const totalInWords = rupeesInWords(data.totalAmount);
    txt(totalInWords, LEFT + PAD_X, wordsY, W - PAD_X * 2, { bold: true });
    const awBottom = wordsY + hgt(totalInWords, W - PAD_X * 2, { bold: true }) + PAD_Y;
    doc.rect(LEFT, awTop, W, awBottom - awTop).stroke();
    y = awBottom;

    // HSN / Tax summary table ------------------------------------------------
    const sNeed = (...texts: string[]) => {
      doc.font('Helvetica-Bold').fontSize(TIGHT);
      return Math.max(...texts.flatMap((t) => t.split('\n')).map((t) => doc.widthOfString(t))) + PAD_X * 2;
    };
    const rateTxt = isSameState ? `${halfPct}%` : `${gstPct}%`;
    const taxAmt = isSameState ? inr(data.gstAmount / 2) : inr(data.gstAmount);
    const sw: number[] = isSameState
      ? [0, sNeed('Taxable\nValue', inr(data.taxableValue)), sNeed('Rate', rateTxt), sNeed('Amount', taxAmt),
         sNeed('Rate', rateTxt), sNeed('Amount', taxAmt), sNeed('Total\nTax Amount', inr(data.gstAmount))]
      : [0, sNeed('Taxable\nValue', inr(data.taxableValue)), sNeed('Rate', rateTxt), sNeed('Amount', taxAmt),
         sNeed('Total\nTax Amount', inr(data.gstAmount))];

    const widenPair = (i: number, label: string) => {
      const need = sNeed(label);
      const have = sw[i] + sw[i + 1];
      if (need > have) { const add = (need - have) / 2; sw[i] += add; sw[i + 1] += add; }
    };
    if (isSameState) { widenPair(2, 'Central Tax'); widenPair(4, 'State Tax'); } else widenPair(2, 'IGST');
    sw[0] = W - sw.slice(1).reduce((a, b) => a + b, 0);

    const sx: number[] = [];
    let sacc = LEFT;
    for (const w of sw) { sx.push(sacc); sacc += w; }
    sw[sw.length - 1] = RIGHT - sx[sx.length - 1];
    const last = sx.length - 1;

    const sPadY = 1;
    const sRowH = TIGHT * 1.35 + sPadY * 2;

    const sCell = (t: string, i: number, ry: number, o?: Opt, spanTo = i) => {
      const w = sx[spanTo] + sw[spanTo] - sx[i] - PAD_X * 2;
      return txt(t, sx[i] + PAD_X, ry + sPadY, w, fit(t, w, { size: TIGHT, ...o }));
    };

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
    sCell(itemHsn, 0, sDataY);
    sCell(inr(data.taxableValue), 1, sDataY, { align: 'right' });
    if (isSameState) {
      sCell(`${halfPct}%`, 2, sDataY, { align: 'center' });
      sCell(inr(data.gstAmount / 2), 3, sDataY, { align: 'right' });
      sCell(`${halfPct}%`, 4, sDataY, { align: 'center' });
      sCell(inr(data.gstAmount / 2), 5, sDataY, { align: 'right' });
    } else {
      sCell(`${gstPct}%`, 2, sDataY, { align: 'center' });
      sCell(inr(data.gstAmount), 3, sDataY, { align: 'right' });
    }
    sCell(inr(data.gstAmount), last, sDataY, { align: 'right' });

    sCell('Total', 0, sTotY, { bold: true, align: 'right' });
    sCell(inr(data.taxableValue), 1, sTotY, { bold: true, align: 'right' });
    if (isSameState) {
      sCell(inr(data.gstAmount / 2), 3, sTotY, { bold: true, align: 'right' });
      sCell(inr(data.gstAmount / 2), 5, sTotY, { bold: true, align: 'right' });
    } else {
      sCell(inr(data.gstAmount), 3, sTotY, { bold: true, align: 'right' });
    }
    sCell(inr(data.gstAmount), last, sTotY, { bold: true, align: 'right' });

    doc.rect(LEFT, sTop, W, sBottom - sTop).stroke();
    hline(sHeadBottom);
    hline(sTotY);
    for (let i = 1; i < sx.length; i++) vline(sx[i], sTop, sBottom);
    hline(sHeadMid, sx[2], sx[last]);
    y = sBottom;

    // Tax Amount in words ----------------------------------------------------
    const twTop = y;
    doc.font('Helvetica').fontSize(BASE).fillColor('#000')
      .text('Tax Amount (in words) : ', LEFT + PAD_X, twTop + PAD_Y, { width: W - PAD_X * 2, lineGap: LG, continued: true })
      .font('Helvetica-Bold').text(rupeesInWords(data.gstAmount), { lineGap: LG });
    const twBottom = doc.y + PAD_Y;
    doc.rect(LEFT, twTop, W, twBottom - twTop).stroke();
    y = twBottom;

    // Bottom Signatory Box ---------------------------------------------------
    const sigTop = y;
    const sigSplitX = LEFT + W * 0.52;
    const sigW = RIGHT - sigSplitX - PAD_X * 2;
    const signH = data.company.signatureHeight || 55;
    const stampS = data.company.stampSize || 95;

    let sy = txt(`for ${data.company.name}`, sigSplitX + PAD_X, sigTop + PAD_Y + 4, sigW, { bold: true, align: 'right' });
    sy = drawSignatureMark(doc, { x: sigSplitX + PAD_X, width: sigW, y: sy + 1, signHeight: signH, stampSize: stampS });
    txt('Authorised Signatory', sigSplitX + PAD_X, sy + 1, sigW, { align: 'right' });
    const sigBottom = Math.max(doc.y + PAD_Y + 4, sigTop + mm(28));

    doc.rect(LEFT, sigTop, W, sigBottom - sigTop).stroke();
    vline(sigSplitX, sigTop, sigBottom);
    y = sigBottom + mm(3);

    // Document Footer
    txt('This is a Computer Generated Document', LEFT, y, W, { align: 'center', size: 8 });

    doc.end();
  });
}
