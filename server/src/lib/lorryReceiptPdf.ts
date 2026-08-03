import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IST_TZ } from './istDate.js';

/**
 * Surya Road Lines' printed stationery fixed details - mirrors the constant of
 * the same name in client/src/pages/LorryReceiptView.tsx. Keep the two in step;
 * this is the same physical GC book rendered as a real PDF instead of a browser
 * print, so it can be merged into the WhatsApp dispatch bundle.
 */
const SRL = {
  name: 'SURYA ROAD LINES',
  tagline: 'Transport Contractors & Commission Agents',
  address: 'M.B.T. Road, PUNGANUR - 517 247, Chittoor Dist., A.P.,',
  phones: 'Jagan : 9440216173, 8019152521, Resi.: 9490830413.',
  pan: 'AACBS0915N',
  labourReg: 'AP-10-37-015-0242317',
  udyam: 'UDAYAM AP-02-0002343',
};

/** Goods description per product, worded as the transporter's book expects it -
 *  mirrors client/src/lib/productNames.ts (PRODUCT_DESCRIPTION). */
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

export function lorryReceiptProductDescription(product?: string | null): string {
  return PRODUCT_DESCRIPTION[product ?? 'PAPPU'] ?? 'Tamarind Seed Pappu';
}

export interface LorryReceiptPdfData {
  company: { name: string; address?: string | null; dispatchFromPlace?: string | null; stateName?: string | null };
  buyer: { name: string; address?: string | null; city?: string | null; state?: string | null; pincode?: string | null };
  destination?: string | null;
  product?: string | null;
  invoiceNumber?: string | null;
  vehicleNumber?: string | null;
  driverName?: string | null;
  weightKg: number;
  gcNo: string;
  gcDate: Date;
  bags?: number | null;
  kgPerBag?: number | null;
}

const ASSET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets');
function readAsset(name: string): Buffer | null {
  try {
    return fs.readFileSync(path.join(ASSET_DIR, name));
  } catch {
    return null;
  }
}

const NAVY = '#1a4a99';
const RED = '#cc1111';

const mm = (v: number) => (v * 72) / 25.4;
const PAGE = { width: 595.28, height: 841.89, marginX: mm(12), marginY: mm(10) };
const LEFT = PAGE.marginX;
const RIGHT = PAGE.width - PAGE.marginX;
const W = RIGHT - LEFT;

function fmtDmy(d: Date): string {
  return d.toLocaleDateString('en-GB', { timeZone: IST_TZ, day: '2-digit', month: '2-digit', year: '2-digit' }).replace(/\//g, '/');
}

/** 30 t at 50 kg/bag = 600 bags - the default packing when none was recorded. */
function bagsFor(weightKg: number, kgPerBag: number): string {
  if (!weightKg || !kgPerBag) return '';
  return String(Math.round(weightKg / kgPerBag));
}

/**
 * Render the Surya Road Lines lorry receipt (GC note) as an A4 PDF page,
 * matching the on-screen printable copy at client/src/pages/LorryReceiptView.tsx
 * so the WhatsApp bundle, the download, and the physical printout all agree.
 *
 * The stamp and authorised signature are deliberately NOT drawn here - unlike
 * the tax invoice, this document carries no company seal; the transporter's own
 * mark goes on by hand (or a dedicated lorry-receipt signature image, once one
 * is supplied) rather than the invoice's authorised-sign.png/company-stamp.png.
 */
export function renderLorryReceiptPdf(data: LorryReceiptPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE.marginX });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const ganesha = readAsset('ganesha.png');
    const balaji = readAsset('balaji.png');

    const kgPerBag = data.kgPerBag ?? 50;
    const bags = data.bags != null ? String(data.bags) : bagsFor(data.weightKg, kgPerBag);
    const fromPlace = (data.company.dispatchFromPlace || data.company.stateName || 'PUNGANUR').toUpperCase();
    const toPlace = (data.destination || data.buyer.city || data.buyer.state || '').toUpperCase();
    const description = lorryReceiptProductDescription(data.product);
    const consigneeAddress = [data.buyer.address, [data.buyer.city, data.buyer.state, data.buyer.pincode].filter(Boolean).join(', ')]
      .filter(Boolean).join('\n');

    doc.lineWidth(0.75).strokeColor(NAVY);
    const hline = (y: number, x1 = LEFT, x2 = RIGHT) => doc.moveTo(x1, y).lineTo(x2, y).stroke();
    const vline = (x: number, y1: number, y2: number) => doc.moveTo(x, y1).lineTo(x, y2).stroke();
    const rect = (x: number, y: number, w: number, h: number) => doc.rect(x, y, w, h).stroke();

    type O = { size?: number; bold?: boolean; align?: 'left' | 'center' | 'right'; color?: string; italic?: boolean };
    const txt = (t: string, x: number, y: number, w: number, o?: O): number => {
      const font = o?.italic ? (o?.bold ? 'Helvetica-BoldOblique' : 'Helvetica-Oblique') : (o?.bold ? 'Helvetica-Bold' : 'Helvetica');
      doc.font(font).fontSize(o?.size ?? 8).fillColor(o?.color ?? NAVY)
        .text(t, x, y, { width: w, align: o?.align ?? 'left', lineGap: 0.5 });
      return doc.y;
    };

    let y = PAGE.marginY;
    const outerTop = y;

    // ── MASTHEAD ────────────────────────────────────────────────────────────
    const mastTop = y + 6;
    const emblemW = 68;
    let my = mastTop;
    if (ganesha) doc.image(ganesha, LEFT + 6, mastTop, { fit: [emblemW, 95], align: 'center' });
    if (balaji) doc.image(balaji, RIGHT - emblemW - 6, mastTop, { fit: [emblemW, 88], align: 'center' });

    const centerX = LEFT + emblemW + 16;
    const centerW = W - (emblemW + 16) * 2;
    my = txt('Subject to Punganur Jurisdiction', centerX, my + 4, centerW, { size: 8.5, bold: true, align: 'center' }) + 3;
    my = txt(SRL.name, centerX, my, centerW, { size: 25, bold: true, align: 'center' }) + 3;
    my = txt(SRL.tagline, centerX, my, centerW, { size: 9.5, bold: true, align: 'center' }) + 4;
    my = txt(SRL.address, centerX, my, centerW, { size: 8.5, bold: true, align: 'center' }) + 2;
    my = txt(SRL.phones, centerX, my, centerW, { size: 8, bold: true, align: 'center' }) + 2;

    const mastBottom = Math.max(my, mastTop + 120);
    y = mastBottom + 4;
    hline(y, LEFT, RIGHT);
    y += 4;

    // ── 3-COLUMN MIDDLE SECTION ─────────────────────────────────────────────
    const midTop = y;
    const col1W = W * 0.3, col2W = W * 0.32, col3W = W - col1W - col2W;
    const col1X = LEFT, col2X = LEFT + col1W, col3X = LEFT + col1W + col2W;

    let c1y = midTop + 3;
    c1y = txt(`PAN CARD : ${SRL.pan}`, col1X + 4, c1y, col1W - 8, { size: 7, bold: true }) + 1;
    c1y = txt(`LABOUR Reg. No. : ${SRL.labourReg}`, col1X + 4, c1y, col1W - 8, { size: 7, bold: true }) + 1;
    c1y = txt(`msme UDAYAM Reg. No.: ${SRL.udyam}`, col1X + 4, c1y, col1W - 8, { size: 7, bold: true }) + 4;
    const cautionTop = c1y;
    c1y = txt('CAUTION', col1X + 4, c1y + 3, col1W - 16, { size: 7.5, bold: true, align: 'center' }) + 2;
    c1y = txt(
      'This Consignment will not detained Re routed or booked without consignee Banks written promission will be delivered at the destinaltion',
      col1X + 8, c1y, col1W - 16, { size: 6.8 },
    ) + 3;
    rect(col1X + 4, cautionTop, col1W - 8, c1y - cautionTop + 2);

    let c2y = midTop + 3;
    c2y = txt("CONSIGNOR'S COPY", col2X + 4, c2y, col2W - 8, { size: 8, bold: true, align: 'center' });
    c2y = txt('AT OWNERS RISK / INSURANCE', col2X + 4, c2y + 1, col2W - 8, { size: 8, bold: true, align: 'center' }) + 3;
    c2y = txt('The Customer has stated that the has not insurance the consignment or he has insured the consignment.', col2X + 4, c2y, col2W - 8, { size: 6.8, align: 'left' }) + 4;
    c2y = txt('Company: ..................................', col2X + 4, c2y, col2W - 8, { size: 6.8 }) + 1;
    c2y = txt('Policy No.: ..................................', col2X + 4, c2y, col2W - 8, { size: 6.8 }) + 1;
    c2y = txt('Amount: ..................................', col2X + 4, c2y, col2W - 8, { size: 6.8 }) + 1;
    txt('Risk: ..................................', col2X + 4, c2y, col2W - 8, { size: 6.8 });

    let c3y = midTop + 3;
    c3y = txt(
      'NOTE : This Consignment covered by this special lorry receipt shall be stored at the destination under control of the Transport order and shall be delivered to order of the consignee bank whose name is mentioned in the lorry receipt. It will under no circumstance be delivered to anyone without the written authority from the consignee copy or a separate letter of Authority.',
      col3X + 4, c3y, col3W - 8, { size: 6.8, align: 'left' },
    ) + 4;
    const midBottomEstimate = Math.max(c1y, c2y + 12, c3y + 20);
    const gcY = midBottomEstimate - 16;
    hline(gcY - 2, col3X, RIGHT);
    txt('G.C. No.', col3X + 4, gcY, col3W * 0.4, { size: 11, bold: true });
    txt(data.gcNo || '----', col3X + col3W * 0.42, gcY - 3, col3W * 0.56 - 4, { size: 20, bold: true, color: RED, align: 'right' });

    const midBottom = Math.max(midBottomEstimate, gcY + 22);
    rect(LEFT, midTop, W, midBottom - midTop);
    vline(col2X, midTop, midBottom);
    vline(col3X, midTop, midBottom);
    y = midBottom + 4;

    // ── ADDRESSES & ROUTE SECTION ───────────────────────────────────────────
    const addrTop = y;
    const addrLeftW = W * 0.62, addrRightW = W - addrLeftW;
    const addrRightX = LEFT + addrLeftW;
    const halfH = 98;

    txt('Consignors Name & Address :', LEFT + 4, addrTop + 4, addrLeftW - 8, { size: 8, bold: true });
    txt(`${data.company.name}${data.company.address ? `\n${data.company.address}` : ''}`, LEFT + 4, addrTop + 16, addrLeftW - 8, { size: 9.5, bold: true });
    const consigneeTop = addrTop + halfH;
    txt('Consignee Name & Address :', LEFT + 4, consigneeTop + 4, addrLeftW - 8, { size: 8, bold: true });
    txt(`${data.buyer.name}${consigneeAddress ? `\n${consigneeAddress}` : ''}`, LEFT + 4, consigneeTop + 16, addrLeftW - 8, { size: 9.5, bold: true });

    const rightRowH = 18.6;
    const rightRow = (label: string, value: string, i: number) => {
      const ry = addrTop + rightRowH * i;
      txt(label, addrRightX + 4, ry + 3, addrRightW * 0.42, { size: 7.5, bold: true, color: '#000' });
      txt(value || '----', addrRightX + addrRightW * 0.44, ry + 3, addrRightW * 0.56 - 4, { size: 8.5, bold: true, align: 'right' });
      hline(ry + rightRowH, addrRightX, RIGHT);
    };
    rightRow('Invoice No.:', data.invoiceNumber ?? '', 0);
    rightRow('DATE:', fmtDmy(data.gcDate), 1);
    rightRow('TRUCK NO.', (data.vehicleNumber ?? '').toUpperCase(), 2);
    rightRow('FROM', fromPlace, 3);
    rightRow('TO', toPlace, 4);

    const freightY = addrTop + rightRowH * 5;
    txt('FREIGHT', addrRightX, freightY + 2, addrRightW, { size: 8.5, bold: true, align: 'center' });
    const freightTickY = freightY + 13;
    hline(freightTickY - 2, addrRightX, RIGHT);
    txt('Paid ✓', addrRightX, freightTickY, addrRightW / 2, { size: 8, bold: true, align: 'center', color: RED });
    txt('To Pay', addrRightX + addrRightW / 2, freightTickY, addrRightW / 2, { size: 8, bold: true, align: 'center', color: '#000' });
    vline(addrRightX + addrRightW / 2, freightTickY - 2, freightTickY + 12);

    const addrBottom = Math.max(halfH * 2 + addrTop, freightTickY + 14);
    rect(LEFT, addrTop, W, addrBottom - addrTop);
    vline(addrRightX, addrTop, addrBottom);
    hline(consigneeTop, LEFT, addrRightX);
    y = addrBottom + 4;

    // ── GOODS TABLE GRID ─────────────────────────────────────────────────────
    const goodsTop = y;
    const goodsH = 125;
    const gCol = [W * 0.18, W * 0.3, W * 0.18, W * 0.34];
    const gX = [LEFT, LEFT + gCol[0], LEFT + gCol[0] + gCol[1], LEFT + gCol[0] + gCol[1] + gCol[2]];

    txt('Package', gX[0], goodsTop + 4, gCol[0], { size: 8.5, bold: true, align: 'center' });
    hline(goodsTop + 17, gX[0], gX[1]);
    txt(`${bags || '----'} Bags`, gX[0] + 4, goodsTop + 30, gCol[0] - 8, { size: 9.5, bold: true });
    txt('Each Bag', gX[0] + 4, goodsTop + 50, gCol[0] - 8, { size: 8.5 });
    txt(`${kgPerBag || '----'} Kgs.`, gX[0] + 4, goodsTop + 65, gCol[0] - 8, { size: 9.5, bold: true });

    txt('Descriptions said to contain', gX[1], goodsTop + 4, gCol[1], { size: 8.5, bold: true, align: 'center' });
    hline(goodsTop + 24, gX[1], gX[2]);
    txt(description, gX[1] + 4, goodsTop + 34, gCol[1] - 8, { size: 10, bold: true });

    txt('Freight', gX[2], goodsTop + 4, gCol[2], { size: 8.5, bold: true, align: 'center' });
    hline(goodsTop + 17, gX[2], gX[3]);
    txt('Per Bag', gX[2] + 4, goodsTop + 30, gCol[2] - 8, { size: 8.5 });
    txt('Lorry Freight', gX[2] + 4, goodsTop + 46, gCol[2] - 8, { size: 8.5 });
    txt('Rs. ________', gX[2] + 4, goodsTop + 62, gCol[2] - 8, { size: 8.5 });

    const pcW = gCol[3] / 2;
    ['Paid', 'To Pay'].forEach((label, i) => {
      const cx = gX[3] + pcW * i;
      txt('Rs.', cx, goodsTop + 4, pcW * 2 / 3, { size: 8, bold: true, align: 'center' });
      txt('Ps.', cx + pcW * 2 / 3, goodsTop + 4, pcW / 3, { size: 8, bold: true, align: 'center' });
      hline(goodsTop + 17, cx, cx + pcW);
      if (label === 'Paid') {
        doc.save();
        doc.rotate(-12, { origin: [cx + pcW / 2, goodsTop + 70] });
        doc.font('Helvetica-Bold').fontSize(15).fillColor(RED)
          .text('PAID', cx + pcW / 2 - 26, goodsTop + 62, { width: 52, align: 'center' });
        doc.restore();
        doc.strokeColor(RED).lineWidth(1.4)
          .roundedRect(cx + pcW / 2 - 30, goodsTop + 55, 60, 24, 3).stroke();
        doc.strokeColor(NAVY).lineWidth(0.75);
      }
    });

    rect(LEFT, goodsTop, W, goodsH);
    vline(gX[1], goodsTop, goodsTop + goodsH);
    vline(gX[2], goodsTop, goodsTop + goodsH);
    vline(gX[3], goodsTop, goodsTop + goodsH);
    vline(gX[3] + pcW, goodsTop, goodsTop + goodsH);
    y = goodsTop + goodsH + 4;

    // ── RUPEES IN WORDS & CHARGES SUMMARY ───────────────────────────────────
    const chargesTop = y;
    const chargesH = 92;
    const wordsW = W * 0.48, chargeLabelW = W * 0.18, chargeGridW = W - wordsW - chargeLabelW;
    const wordsX = LEFT, labelX = LEFT + wordsW, gridX = labelX + chargeLabelW;

    txt('To pay Lorry freight Rupees in words', wordsX + 4, chargesTop + 4, wordsW - 8, { size: 8, bold: true });
    txt('.........................................................................', wordsX + 4, chargesTop + 20, wordsW - 8, { size: 8, color: '#7f93bd' });
    txt('.........................................................................', wordsX + 4, chargesTop + 36, wordsW - 8, { size: 8, color: '#7f93bd' });
    txt('Unloading by Party', wordsX + 4, chargesTop + chargesH - 16, wordsW - 8, { size: 8, bold: true, italic: true });

    const chargeRowH = chargesH / 3;
    ['Hamali', 'GC Charges', 'TOTAL'].forEach((label, i) => {
      const ry = chargesTop + chargeRowH * i;
      txt(label, labelX + 4, ry + 5, chargeLabelW - 8, { size: i === 2 ? 8.5 : 8, bold: true });
      if (i < 2) hline(ry + chargeRowH, labelX, gridX);
    });

    const pcW2 = chargeGridW / 2;
    for (let i = 0; i < 3; i++) {
      const ry = chargesTop + chargeRowH * i;
      if (i < 2) hline(ry + chargeRowH, gridX, RIGHT);
    }
    vline(gridX + pcW2, chargesTop, chargesTop + chargesH);
    vline(gridX + pcW2 * (2 / 3), chargesTop, chargesTop + chargesH);
    vline(gridX + pcW2 + pcW2 * (2 / 3), chargesTop, chargesTop + chargesH);

    rect(LEFT, chargesTop, W, chargesH);
    vline(labelX, chargesTop, chargesTop + chargesH);
    vline(gridX, chargesTop, chargesTop + chargesH);
    y = chargesTop + chargesH + 6;

    // ── FOOTER NOTES & (BLANK) SIGNATURE ────────────────────────────────────
    const footerTop = y;
    const notesW = W * 0.68, sigW = W - notesW - 8;
    const sigX = LEFT + notesW + 8;

    let fy = footerTop;
    fy = txt(
      'Note : Our leakage and damage we are not responsible. Insurance to be covered by the party. Any claim towards damage/shortage etc., should not settled with Driver at the unloading it self later date no complaint will be entertained by us.',
      LEFT, fy, notesW, { size: 7.3, color: '#000' },
    ) + 3;
    fy = txt('Note : WE ARE NOT COLLECTING ANY GST AMOUNT TO PARTY.', LEFT, fy, notesW, { size: 7.3, bold: true, color: '#000' });

    // No stamp/signature image on this document - the transporter signs the
    // physical copy by hand (or a lorry-receipt-specific mark can be added here
    // later), unlike the tax invoice's authorised-sign.png/company-stamp.png.
    txt('For Surya Road Lines', sigX, footerTop, sigW, { size: 9.5, bold: true, align: 'right' });
    const sigLineY = footerTop + 76;
    hline(sigLineY, sigX, RIGHT);
    txt('Authorised Signatory', sigX, sigLineY + 3, sigW, { size: 8, align: 'right' });

    const footerBottom = Math.max(fy + 8, sigLineY + 14);
    y = footerBottom + 6;
    hline(y, LEFT, RIGHT);
    y += 6;

    txt(`Driver's Name : ${(data.driverName ?? '').toUpperCase()}`, LEFT, y, W * 0.6, { size: 8.5, bold: true, color: '#000' });
    txt('D.L. No. :', LEFT + W * 0.6, y, W * 0.4 - 4, { size: 8.5, bold: true, color: '#000', align: 'right' });
    y += 14;

    // Outer border around the whole sheet.
    doc.lineWidth(1.6).strokeColor(NAVY).rect(LEFT, outerTop, W, y - outerTop).stroke();
    doc.lineWidth(0.75);

    doc.end();
  });
}
