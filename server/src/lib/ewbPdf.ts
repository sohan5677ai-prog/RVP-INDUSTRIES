import PDFDocument from 'pdfkit';
import { IST_TZ } from './istDate.js';

export interface EwbPdfData {
  company: {
    name: string;
    address?: string | null;
    gstin?: string | null;
    stateName?: string | null;
    pincode?: string | null;
  };
  buyer: {
    name: string;
    address?: string | null;
    gstin?: string | null;
    stateName?: string | null;
    pincode?: string | null;
  };
  /**
   * Dispatch-from block from Settings → Invoice Setup. The government print shows
   * the *town* goods leave from (and repeats it in the vehicle "From" column), so
   * it is kept separate from the registered address; blanks fall back to it.
   */
  dispatchFrom?: {
    place?: string | null;
    address1?: string | null;
    address2?: string | null;
    pincode?: string | null;
  };
  /** Buyer's ship-to town (Party → City). Falls back to the buyer's state. */
  shipToPlace?: string | null;
  /**
   * Transport block for sections 4 and 5 — the mode and transport document as
   * submitted with this particular bill. Absent on legacy dispatches recorded
   * before these were stored. No transporter is carried: RVP moves goods on its
   * own arrangement, so the portal's transporter fields stay blank.
   */
  transport?: {
    /** NIC mode code: '1' Road, '2' Rail, '3' Air, '4' Ship. Defaults to Road. */
    transMode?: string | null;
    transDocNo?: string | null;
    transDocDate?: Date | null;
  };
  invoiceNumber: string;
  invoiceDate: Date;
  vehicleNumber?: string | null;
  line: { description: string; hsn: string; quantityKg: number; ratePerKg: number };
  gstRate: number; // e.g. 0.05
  ewbNumber: string;
  ewbDate: Date;
  ewbValidUpto: Date;
  ewbDistance?: number | null;
  dispatchDate: Date;
  qrPngBuffer?: Buffer;
}

const PAGE = { margin: 36, width: 595.28 };
const LEFT = PAGE.margin;
const RIGHT = PAGE.width - PAGE.margin;
const W = RIGHT - LEFT;

/** Purple of the government print's section bars, and the paler sub-header band. */
const BAR = '#7a7aba';
const SUBBAR = '#a8a8cf';

const TRANS_MODES: Record<string, string> = { '1': 'Road', '2': 'Rail', '3': 'Air', '4': 'Ship' };

/**
 * Every stamp on this document is a government-facing IST time. Without an
 * explicit zone these formatters follow the process clock, which is UTC on
 * Render — printing an EWB generated at 12:37 IST as 07:07 AM.
 */
function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { timeZone: IST_TZ, day: '2-digit', month: 'short', year: 'numeric' });
}

/** "29 Jul 2026 10:35 AM" — the generated/valid-upto stamps carry a time. */
function fmtDateTime(d: Date): string {
  return d.toLocaleString('en-GB', {
    timeZone: IST_TZ,
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
  }).replace(',', '').replace(/\b(am|pm)\b/, (s) => s.toUpperCase());
}

/**
 * Render the e-Way Bill in the government **detailed print** layout (the same
 * five-section document the EWB portal's "Detailed Print" produces, and the one
 * the on-screen viewer replicates), and resolve with the full Buffer.
 *
 * This is the in-house replica: the real ASP-rendered print from TaxPro is
 * always preferred (see TaxproService.printEWayBillDetailPdf). It only renders
 * when that network call can't be made — so it has to carry the same detail a
 * checkpost officer expects, not a summary.
 */
export function renderEwbPdf(data: EwbPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.lineWidth(0.7).strokeColor('#000');

    const hline = (y: number, x1 = LEFT, x2 = RIGHT) => doc.moveTo(x1, y).lineTo(x2, y).stroke();
    const vline = (x: number, y1: number, y2: number) => doc.moveTo(x, y1).lineTo(x, y2).stroke();

    /** Numbered purple section bar. Returns the y the section's box starts at. */
    const sectionTitle = (t: string, y: number) => {
      doc.rect(LEFT, y, W, 15).fill(BAR);
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8).text(t, LEFT + 4, y + 4);
      doc.fillColor('#000');
      return y + 15;
    };

    /** Pale band used for the From/To captions inside the address block. */
    const subBand = (x: number, y: number, w: number, t: string) => {
      doc.rect(x, y, w, 12).fill(SUBBAR);
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(7.5).text(t, x + 4, y + 3);
      return y + 12;
    };

    /**
     * `label: ` in regular then the value in bold at (x, y), wrapping inside
     * `width`. Returns the y it ended at so a box can be sized around a value
     * that took more than one line (long transporter names do).
     */
    const kv = (label: string, value: string, x: number, y: number, width: number): number => {
      doc.font('Helvetica').fontSize(7.5)
        .text(label, x, y, { width, continued: true })
        .font('Helvetica-Bold').text(value);
      doc.font('Helvetica');
      return doc.y;
    };

    type Cell = { t: string; w: number; align?: 'left' | 'center' };
    /**
     * One table row across `cells`, auto-sized to its tallest cell. Returns the
     * row height so the caller can lay out the grid lines.
     */
    const row = (cells: Cell[], y: number, bold: boolean, minH = 0): number => {
      const pad = 3;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7);
      let h = minH;
      for (const c of cells) {
        h = Math.max(h, doc.heightOfString(c.t, { width: c.w - pad * 2, align: c.align ?? 'center' }));
      }
      h += pad * 2;
      let cx = LEFT;
      for (const c of cells) {
        doc.text(c.t, cx + pad, y + pad, { width: c.w - pad * 2, align: c.align ?? 'center' });
        cx += c.w;
      }
      return h;
    };

    /** Grid for a header+body table: outer box, the separator, and the column rules. */
    const grid = (cells: Cell[], top: number, split: number, bottom: number) => {
      doc.rect(LEFT, top, W, bottom - top).stroke();
      hline(split);
      let cx = LEFT;
      for (let i = 0; i < cells.length - 1; i++) { cx += cells[i].w; vline(cx, top, bottom); }
    };

    const amount = Math.round(data.line.quantityKg * data.line.ratePerKg * 100) / 100;
    const gst = Math.round(amount * data.gstRate * 100) / 100;
    const total = Math.round((amount + gst) * 100) / 100;
    const gstPct = data.gstRate * 100;
    const sellerStateCode = data.company.gstin?.slice(0, 2) || '';
    const buyerStateCode = data.buyer.gstin?.slice(0, 2) || '';
    const isSameState = !!sellerStateCode && sellerStateCode === buyerStateCode;
    const cgst = isSameState ? Math.round((gst / 2) * 100) / 100 : 0;
    const sgst = isSameState ? Math.round((gst / 2) * 100) / 100 : 0;
    const igst = isSameState ? 0 : gst;
    // Per-component rate string the government print carries, e.g. intra-state
    // "2.50+2.50+0.00+0.000+0.00", inter-state "0.00+0.00+5.00+0.000+0.00".
    const taxRateStr = isSameState
      ? `${(gstPct / 2).toFixed(2)}+${(gstPct / 2).toFixed(2)}+0.00+0.000+0.00`
      : `0.00+0.00+${gstPct.toFixed(2)}+0.000+0.00`;

    /** "Punganur, Andhra Pradesh, 517247" — minus any part that repeats the one
     *  before it, since an unconfigured place falls back to the state name. */
    const placeLine = (...parts: (string | null | undefined)[]) => {
      const seen: string[] = [];
      for (const p of parts) {
        if (p && !seen.some((s) => s.toLowerCase() === p.toLowerCase())) seen.push(p);
      }
      return seen.join(', ');
    };
    const dispatchPlace = data.dispatchFrom?.place || data.company.stateName || '';
    const dispatchPin = data.dispatchFrom?.pincode || data.company.pincode || '';
    const shipToPlace = data.shipToPlace || data.buyer.stateName || '';
    const transMode = TRANS_MODES[data.transport?.transMode || '1'] || 'Road';
    const transDocLine = [
      data.transport?.transDocNo,
      fmtDate(data.transport?.transDocDate || data.dispatchDate),
    ].filter(Boolean).join(' & ');

    // Title + QR ---------------------------------------------------------------
    // The QR sits beside the title, where the portal puts it. It has to be laid
    // out BEFORE the first section bar and the body pushed below it — a bar drawn
    // over the code paints a solid band through it and leaves it unscannable.
    const qrSize = 68;
    doc.font('Helvetica-Bold').fontSize(15).text('e-Way Bill', LEFT, PAGE.margin);
    if (data.qrPngBuffer) {
      doc.image(data.qrPngBuffer, RIGHT - qrSize, PAGE.margin - 6, { width: qrSize, height: qrSize });
    }
    let y = PAGE.margin + (data.qrPngBuffer ? qrSize : 22);

    // 1. E-Way Bill details ----------------------------------------------------
    y = sectionTitle('1. E-WAY BILL Details', y);
    const b1Top = y;
    const cw = W / 3;
    const c1 = LEFT + 4, c2 = LEFT + cw + 4, c3 = LEFT + 2 * cw + 4;
    const r1 = b1Top + 5;
    kv('eWay Bill No: ', data.ewbNumber, c1, r1, cw - 8);
    kv('Generated Date: ', fmtDateTime(data.ewbDate), c2, r1, cw - 8);
    kv('Generated By: ', data.company.gstin ?? '', c3, r1, cw - 8);
    kv('Valid Upto: ', fmtDateTime(data.ewbValidUpto), c3, r1 + 10, cw - 8);
    const r2 = r1 + 22;
    kv('Mode: ', transMode, c1, r2, cw - 8);
    kv('Approx Distance: ', data.ewbDistance ? `${data.ewbDistance} KM` : '-', c2, r2, cw - 8);
    const r3 = r2 + 12;
    kv('Type: ', 'Outward - Supply', c1, r3, cw - 8);
    kv('Document Details: ', `Tax Invoice - ${data.invoiceNumber} - ${fmtDate(data.invoiceDate)}`, c2, r3, 2 * cw - 12);
    const r4 = r3 + 12;
    kv('Transaction type: ', 'Regular', c1, r4, cw - 8);
    kv('Portal: ', '1', c2, r4, cw - 8);
    const b1Bottom = r4 + 14;
    doc.rect(LEFT, b1Top, W, b1Bottom - b1Top).stroke();
    y = b1Bottom + 3;

    // 2. Address details --------------------------------------------------------
    y = sectionTitle('2. Address Details', y);
    const addrTop = y;
    const halfW = W / 2;
    subBand(LEFT, addrTop, halfW, 'From');
    subBand(LEFT + halfW, addrTop, halfW, 'To');
    const addrBodyTop = addrTop + 12;
    doc.font('Helvetica').fontSize(7.5);
    const fromLines = [
      `GSTIN : ${data.company.gstin ?? ''}`,
      data.company.name,
      data.company.stateName ?? '',
      ':: Dispatch From ::',
      data.dispatchFrom?.address1 || data.company.address || '',
      data.dispatchFrom?.address2 || '',
      placeLine(dispatchPlace, data.company.stateName, dispatchPin),
    ].filter((l) => l !== '');
    const toLines = [
      `GSTIN : ${data.buyer.gstin || 'URP'}`,
      data.buyer.name,
      data.buyer.stateName ?? '',
      ':: Ship To ::',
      data.buyer.address ?? '',
      placeLine(shipToPlace, data.buyer.stateName, data.buyer.pincode),
    ].filter((l) => l !== '');
    const writeAddr = (lines: string[], x: number) => {
      let ly = addrBodyTop + 4;
      for (const line of lines) {
        const marker = line.startsWith('::');
        doc.fillColor(marker ? '#666' : '#000');
        doc.text(line, x + 4, marker ? ly + 3 : ly, { width: halfW - 8 });
        ly = doc.y + 1;
      }
      doc.fillColor('#000');
      return ly;
    };
    const addrBottom = Math.max(writeAddr(fromLines, LEFT), writeAddr(toLines, LEFT + halfW)) + 4;
    doc.rect(LEFT, addrTop, W, addrBottom - addrTop).stroke();
    hline(addrBodyTop);
    vline(LEFT + halfW, addrTop, addrBottom);
    y = addrBottom + 3;

    // 3. Goods details -----------------------------------------------------------
    y = sectionTitle('3. Goods Details', y);
    const gHead: Cell[] = [
      { t: 'HSN\nCode', w: W * 0.1 },
      { t: 'Product Name & Desc.', w: W * 0.32, align: 'left' },
      { t: 'Quantity', w: W * 0.13 },
      { t: 'Taxable Amount\nRs.', w: W * 0.18 },
      { t: 'Tax Rate\n(C+S+I+Cess+Cess Non.Advol)', w: 0 },
    ];
    gHead[4].w = W - gHead.slice(0, 4).reduce((s, c) => s + c.w, 0);
    const gTop = y;
    const gHeadH = row(gHead, gTop, true);
    const gSplit = gTop + gHeadH;
    const gBody: Cell[] = [
      { t: data.line.hsn, w: gHead[0].w },
      { t: data.line.description, w: gHead[1].w, align: 'left' },
      { t: `${data.line.quantityKg.toFixed(2)}\nKgs`, w: gHead[2].w },
      { t: amount.toFixed(2), w: gHead[3].w },
      { t: taxRateStr, w: gHead[4].w },
    ];
    const gBottom = gSplit + row(gBody, gSplit, false);
    grid(gHead, gTop, gSplit, gBottom);
    y = gBottom;

    // Tax summary strip, directly under the goods table (shares its left/right rules).
    const sHead: Cell[] = [
      { t: "Tot. Tax'ble Amt", w: W * 0.15 },
      { t: 'CGST Amt', w: W * 0.11 },
      { t: 'SGST Amt', w: W * 0.11 },
      { t: 'IGST Amt', w: W * 0.11 },
      { t: 'CESS Amt', w: W * 0.11 },
      { t: 'CESS Non.\nAdvol Amt', w: W * 0.13 },
      { t: 'Other Amt', w: W * 0.13 },
      { t: 'Total Inv.Amt', w: 0 },
    ];
    sHead[7].w = W - sHead.slice(0, 7).reduce((s, c) => s + c.w, 0);
    const sTop = y;
    const sSplit = sTop + row(sHead, sTop, true);
    const sBody: Cell[] = [
      { t: amount.toFixed(2), w: sHead[0].w },
      { t: cgst.toFixed(2), w: sHead[1].w },
      { t: sgst.toFixed(2), w: sHead[2].w },
      { t: igst.toFixed(2), w: sHead[3].w },
      { t: '0.00', w: sHead[4].w },
      { t: '0.00', w: sHead[5].w },
      { t: '0.00', w: sHead[6].w },
      { t: total.toFixed(2), w: sHead[7].w },
    ];
    const sBottom = sSplit + row(sBody, sSplit, false);
    grid(sHead, sTop, sSplit, sBottom);
    y = sBottom + 3;

    // 4. Transportation details ---------------------------------------------------
    y = sectionTitle('4. Transportation Details', y);
    const tTop = y;
    const tLeftEnd = kv('Transporter ID & Name : ', '', LEFT + 4, tTop + 5, halfW - 8);
    const tRightEnd = kv('Transporter Doc. No & Date : ', transDocLine, LEFT + halfW + 4, tTop + 5, halfW - 8);
    const tBottom = Math.max(tLeftEnd, tRightEnd) + 4;
    doc.rect(LEFT, tTop, W, tBottom - tTop).stroke();
    y = tBottom + 3;

    // 5. Vehicle details -----------------------------------------------------------
    y = sectionTitle('5. Vehicle Details', y);
    const vHead: Cell[] = [
      { t: 'Mode', w: W * 0.09 },
      { t: 'Vehicle / Trans\nDoc No & Dt.', w: W * 0.17 },
      { t: 'From', w: W * 0.14 },
      { t: 'Entered Date', w: W * 0.16 },
      { t: 'Entered By', w: W * 0.17 },
      { t: 'CEWB No.\n(If any)', w: W * 0.11 },
      { t: 'Multi Veh.Info\n(If any)', w: W * 0.11 },
      { t: 'Portal', w: 0 },
    ];
    vHead[7].w = W - vHead.slice(0, 7).reduce((s, c) => s + c.w, 0);
    const vTop = y;
    const vSplit = vTop + row(vHead, vTop, true);
    const vBody: Cell[] = [
      { t: transMode, w: vHead[0].w },
      { t: data.vehicleNumber || data.transport?.transDocNo || '-', w: vHead[1].w },
      { t: dispatchPlace || '-', w: vHead[2].w },
      { t: fmtDateTime(data.ewbDate), w: vHead[3].w },
      { t: data.company.gstin ?? '-', w: vHead[4].w },
      { t: '-', w: vHead[5].w },
      { t: '-', w: vHead[6].w },
      { t: '1', w: vHead[7].w },
    ];
    const vBottom = vSplit + row(vBody, vSplit, false);
    grid(vHead, vTop, vSplit, vBottom);
    y = vBottom + 12;

    doc.font('Helvetica').fontSize(7.5).fillColor('#444')
      .text('This is a system-generated copy of the e-Way Bill in the government detailed-print format.', LEFT, y, { width: W, align: 'center' });

    doc.end();
  });
}
