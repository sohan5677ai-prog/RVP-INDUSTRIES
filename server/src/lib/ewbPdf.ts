import PDFDocument from 'pdfkit';

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

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Render an e-way bill summary as a PDF and resolve with the full Buffer. */
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
    const sectionTitle = (t: string, y: number) => {
      doc.rect(LEFT, y, W, 16).fill('#7a7aba');
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8.5).text(t, LEFT + 4, y + 4);
      doc.fillColor('#000');
      return y + 16;
    };

    const amount = data.line.quantityKg * data.line.ratePerKg;
    const gst = Math.round(amount * data.gstRate * 100) / 100;
    const total = amount + gst;
    const sellerStateCode = data.company.gstin?.slice(0, 2) || '';
    const buyerStateCode = data.buyer.gstin?.slice(0, 2) || '';
    const isSameState = !!sellerStateCode && sellerStateCode === buyerStateCode;
    const cgst = isSameState ? gst / 2 : 0;
    const sgst = isSameState ? gst / 2 : 0;
    const igst = isSameState ? 0 : gst;

    // Title + QR --------------------------------------------------------------
    doc.font('Helvetica-Bold').fontSize(15).text('e-Way Bill', LEFT, PAGE.margin);
    if (data.qrPngBuffer) doc.image(data.qrPngBuffer, RIGHT - 60, PAGE.margin - 4, { width: 60, height: 60 });
    let y = PAGE.margin + 24;

    // 1. E-Way Bill details ----------------------------------------------------
    y = sectionTitle('1. E-WAY BILL Details', y);
    const boxTop1 = y;
    doc.font('Helvetica').fontSize(8);
    doc.text(`eWay Bill No: `, LEFT + 4, y + 4, { continued: true }).font('Helvetica-Bold').text(data.ewbNumber);
    doc.font('Helvetica').text(`Generated Date: `, LEFT + 4, doc.y + 3, { continued: true }).font('Helvetica-Bold').text(fmtDate(data.ewbDate));
    doc.font('Helvetica').text(`Valid Upto: `, LEFT + 4, doc.y + 3, { continued: true }).font('Helvetica-Bold').text(fmtDate(data.ewbValidUpto));
    doc.font('Helvetica').text(`Mode: `, LEFT + 4, doc.y + 3, { continued: true }).font('Helvetica-Bold').text('Road', { continued: true })
      .font('Helvetica').text(`     Approx Distance: `, { continued: true }).font('Helvetica-Bold').text(data.ewbDistance ? `${data.ewbDistance} KM` : '-');
    doc.font('Helvetica').text(`Document: `, LEFT + 4, doc.y + 3, { continued: true }).font('Helvetica-Bold').text(`Tax Invoice - ${data.invoiceNumber} - ${fmtDate(data.invoiceDate)}`);
    const boxBottom1 = doc.y + 6;
    doc.rect(LEFT, boxTop1, W, boxBottom1 - boxTop1).stroke();
    y = boxBottom1 + 4;

    // 2. Address details --------------------------------------------------------
    y = sectionTitle('2. Address Details', y);
    const addrTop = y;
    const halfW = W / 2;
    doc.font('Helvetica-Bold').fontSize(8).text('From', LEFT + 4, addrTop + 3);
    doc.font('Helvetica-Bold').text('To', LEFT + halfW + 4, addrTop + 3);
    doc.font('Helvetica').fontSize(8);
    let fy = doc.y + 2;
    const fromLines = [`GSTIN: ${data.company.gstin ?? ''}`, data.company.name, data.company.stateName ?? '', data.company.address ?? ''];
    let by = addrTop + 3 + 12;
    const toLines = [`GSTIN: ${data.buyer.gstin || 'URP'}`, data.buyer.name, data.buyer.stateName ?? '', data.buyer.address ?? ''];
    for (const line of fromLines) { doc.text(line, LEFT + 4, fy, { width: halfW - 8 }); fy = doc.y + 1; }
    for (const line of toLines) { doc.text(line, LEFT + halfW + 4, by, { width: halfW - 8 }); by = doc.y + 1; }
    const addrBottom = Math.max(fy, by) + 4;
    doc.rect(LEFT, addrTop, W, addrBottom - addrTop).stroke();
    vline(LEFT + halfW, addrTop, addrBottom);
    y = addrBottom + 4;

    // 3. Goods details -----------------------------------------------------------
    y = sectionTitle('3. Goods Details', y);
    const gcols = [
      { t: 'HSN', w: W * 0.1 },
      { t: 'Description', w: W * 0.34 },
      { t: 'Qty (Kgs)', w: W * 0.18 },
      { t: 'Taxable Amt', w: W * 0.18 },
      { t: 'GST %', w: 0 },
    ];
    gcols[4].w = W - gcols.slice(0, 4).reduce((s, c) => s + c.w, 0);
    const gX: number[] = []; let gcx = LEFT;
    for (const c of gcols) { gX.push(gcx); gcx += c.w; }
    const gTop = y;
    doc.font('Helvetica-Bold').fontSize(8);
    gcols.forEach((c, i) => doc.text(c.t, gX[i] + 3, gTop + 4, { width: c.w - 6, align: 'center' }));
    const gRowY = gTop + 16;
    doc.font('Helvetica').fontSize(8);
    doc.text(data.line.hsn, gX[0] + 3, gRowY + 4, { width: gcols[0].w - 6, align: 'center' });
    doc.text(data.line.description, gX[1] + 3, gRowY + 4, { width: gcols[1].w - 6 });
    doc.text(data.line.quantityKg.toLocaleString('en-IN'), gX[2] + 3, gRowY + 4, { width: gcols[2].w - 6, align: 'center' });
    doc.text(amount.toFixed(2), gX[3] + 3, gRowY + 4, { width: gcols[3].w - 6, align: 'center' });
    doc.text(`${Math.round(data.gstRate * 100)}%`, gX[4] + 3, gRowY + 4, { width: gcols[4].w - 6, align: 'center' });
    const gBottom = gRowY + 20;
    doc.rect(LEFT, gTop, W, gBottom - gTop).stroke();
    hline(gRowY, LEFT, RIGHT);
    for (let i = 1; i < gcols.length; i++) vline(gX[i], gTop, gBottom);
    y = gBottom + 4;

    const scols = [
      { t: 'Taxable Amt', v: amount.toFixed(2) },
      { t: 'CGST', v: cgst.toFixed(2) },
      { t: 'SGST', v: sgst.toFixed(2) },
      { t: 'IGST', v: igst.toFixed(2) },
      { t: 'Total', v: total.toFixed(2) },
    ];
    const sW = W / scols.length;
    const sTop = y;
    doc.font('Helvetica-Bold').fontSize(7.5);
    scols.forEach((c, i) => doc.text(c.t, LEFT + i * sW + 3, sTop + 3, { width: sW - 6, align: 'center' }));
    doc.font('Helvetica').fontSize(8.5);
    const sRowY = sTop + 14;
    scols.forEach((c, i) => doc.text(c.v, LEFT + i * sW + 3, sRowY + 3, { width: sW - 6, align: 'center' }));
    const sBottom = sRowY + 18;
    doc.rect(LEFT, sTop, W, sBottom - sTop).stroke();
    hline(sRowY, LEFT, RIGHT);
    for (let i = 1; i < scols.length; i++) vline(LEFT + i * sW, sTop, sBottom);
    y = sBottom + 4;

    // 4. Vehicle details -----------------------------------------------------
    y = sectionTitle('4. Vehicle Details', y);
    const vTop = y;
    doc.font('Helvetica').fontSize(8);
    doc.text(`Mode: `, LEFT + 4, vTop + 4, { continued: true }).font('Helvetica-Bold').text('Road', { continued: true })
      .font('Helvetica').text(`     Vehicle No.: `, { continued: true }).font('Helvetica-Bold').text(data.vehicleNumber || '-');
    doc.font('Helvetica').text(`Dispatch Date: `, LEFT + 4, doc.y + 3, { continued: true }).font('Helvetica-Bold').text(fmtDate(data.dispatchDate));
    const vBottom = doc.y + 6;
    doc.rect(LEFT, vTop, W, vBottom - vTop).stroke();
    y = vBottom + 10;

    doc.font('Helvetica').fontSize(8).fillColor('#444').text('This is a system-generated e-Way Bill summary.', LEFT, y, { width: W, align: 'center' });

    doc.end();
  });
}
