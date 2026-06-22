import PDFDocument from 'pdfkit';
import { inr, rupeesInWords } from './invoice.js';

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
}

const PAGE = { margin: 36, width: 595.28 };
const LEFT = PAGE.margin;
const RIGHT = PAGE.width - PAGE.margin;
const W = RIGHT - LEFT;

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '-');
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

    // Small drawing helpers --------------------------------------------------
    const hline = (y: number, x1 = LEFT, x2 = RIGHT) => doc.moveTo(x1, y).lineTo(x2, y).stroke();
    const vline = (x: number, y1: number, y2: number) => doc.moveTo(x, y1).lineTo(x, y2).stroke();
    const label = (t: string, x: number, y: number, w: number, size = 8) =>
      doc.font('Helvetica').fontSize(size).fillColor('#000').text(t, x + 3, y + 2, { width: w - 6 });
    const bold = (t: string, x: number, y: number, w: number, size = 9, align: 'left' | 'right' | 'center' = 'left') =>
      doc.font('Helvetica-Bold').fontSize(size).fillColor('#000').text(t, x + 3, y + 2, { width: w - 6, align });

    doc.lineWidth(0.7).strokeColor('#000');

    // Title ------------------------------------------------------------------
    doc.font('Helvetica-Bold').fontSize(15).text('Tax Invoice', LEFT, PAGE.margin, { width: W, align: 'center' });
    let y = PAGE.margin + 26;

    // Header box: seller/buyer (left) + invoice meta (right) -----------------
    const splitX = LEFT + W * 0.56;
    const headerTop = y;

    // Right meta column — three rows.
    const metaRowH = 30;
    const metaMidX = splitX + (RIGHT - splitX) / 2;
    // Row 1: Invoice No | Dated
    label('Invoice No.', splitX, headerTop, metaMidX - splitX);
    label('Dated', metaMidX, headerTop, RIGHT - metaMidX);
    bold(data.invoiceNumber, splitX, headerTop + 11, metaMidX - splitX, 9);
    bold(fmtDate(data.invoiceDate), metaMidX, headerTop + 11, RIGHT - metaMidX, 9);
    // Row 2: Destination | Vehicle No
    const r2 = headerTop + metaRowH;
    label('Destination', splitX, r2, metaMidX - splitX);
    label('Motor Vehicle No.', metaMidX, r2, RIGHT - metaMidX);
    bold(data.destination ?? '', splitX, r2 + 11, metaMidX - splitX, 9);
    bold(data.vehicleNumber ?? '', metaMidX, r2 + 11, RIGHT - metaMidX, 9);
    // Row 3: Dispatched through
    const r3 = headerTop + metaRowH * 2;
    label('Dispatched through', splitX, r3, RIGHT - splitX);
    bold('Road', splitX, r3 + 11, RIGHT - splitX, 9);

    // Left column — seller then buyer.
    let ly = headerTop + 4;
    doc.font('Helvetica-Bold').fontSize(10).text(data.company.name, LEFT + 4, ly, { width: splitX - LEFT - 8 });
    ly = doc.y + 1;
    doc.font('Helvetica').fontSize(8);
    if (data.company.address) { doc.text(data.company.address, LEFT + 4, ly, { width: splitX - LEFT - 8 }); ly = doc.y; }
    if (data.company.gstin) { doc.text(`GSTIN/UIN: ${data.company.gstin}`, LEFT + 4, ly, { width: splitX - LEFT - 8 }); ly = doc.y; }
    if (data.company.stateName) {
      doc.text(`State Name : ${data.company.stateName}${data.company.stateCode ? ', Code : ' + data.company.stateCode : ''}`, LEFT + 4, ly, { width: splitX - LEFT - 8 });
      ly = doc.y;
    }
    if (data.company.contact) { doc.text(`Contact : ${data.company.contact}`, LEFT + 4, ly, { width: splitX - LEFT - 8 }); ly = doc.y; }

    ly += 6;
    const buyerLabelY = ly;
    doc.font('Helvetica').fontSize(8).text('Buyer (Bill to)', LEFT + 4, ly); ly = doc.y + 1;
    doc.font('Helvetica-Bold').fontSize(9.5).text(data.buyer.name, LEFT + 4, ly, { width: splitX - LEFT - 8 }); ly = doc.y + 1;
    doc.font('Helvetica').fontSize(8);
    if (data.buyer.address) { doc.text(data.buyer.address, LEFT + 4, ly, { width: splitX - LEFT - 8 }); ly = doc.y; }
    if (data.buyer.gstin) { doc.text(`GSTIN/UIN : ${data.buyer.gstin}`, LEFT + 4, ly, { width: splitX - LEFT - 8 }); ly = doc.y; }
    if (data.buyer.stateName) {
      doc.text(`State Name : ${data.buyer.stateName}${data.buyer.stateCode ? ', Code : ' + data.buyer.stateCode : ''}`, LEFT + 4, ly, { width: splitX - LEFT - 8 });
      ly = doc.y;
    }
    if (data.buyer.placeOfSupply) { doc.text(`Place of Supply : ${data.buyer.placeOfSupply}`, LEFT + 4, ly, { width: splitX - LEFT - 8 }); ly = doc.y; }

    const headerBottom = Math.max(ly + 6, headerTop + metaRowH * 3);

    // Header box borders.
    doc.rect(LEFT, headerTop, W, headerBottom - headerTop).stroke();
    vline(splitX, headerTop, headerBottom);
    hline(headerTop + metaRowH, splitX, RIGHT);
    hline(r3, splitX, RIGHT);
    vline(metaMidX, headerTop, r3); // split only top two meta rows
    // Separator between seller and buyer on the left.
    hline(buyerLabelY - 3, LEFT, splitX);

    y = headerBottom;

    // Goods table -----------------------------------------------------------
    // Columns: Sl | Description | HSN/SAC | Quantity | Rate | per | Amount
    const cols = [
      { key: 'sl', w: 26, align: 'center' as const },
      { key: 'desc', w: 170, align: 'left' as const },
      { key: 'hsn', w: 58, align: 'center' as const },
      { key: 'qty', w: 78, align: 'right' as const },
      { key: 'rate', w: 60, align: 'right' as const },
      { key: 'per', w: 32, align: 'center' as const },
      { key: 'amt', w: 0, align: 'right' as const },
    ];
    const used = cols.reduce((s, c) => s + c.w, 0);
    cols[cols.length - 1].w = W - used;
    const colX: number[] = [];
    let cx = LEFT;
    for (const c of cols) { colX.push(cx); cx += c.w; }
    const cell = (i: number, t: string, ty: number, font: 'Helvetica' | 'Helvetica-Bold' = 'Helvetica', size = 8.5) => {
      doc.font(font).fontSize(size).fillColor('#000').text(t, colX[i] + 4, ty, { width: cols[i].w - 8, align: cols[i].align });
    };

    // Header row.
    const thY = y;
    const thH = 26;
    cell(0, 'Sl\nNo.', thY + 3, 'Helvetica-Bold', 8);
    cell(1, 'Description of Goods', thY + 8, 'Helvetica-Bold', 8.5);
    cell(2, 'HSN/SAC', thY + 8, 'Helvetica-Bold', 8);
    cell(3, 'Quantity', thY + 8, 'Helvetica-Bold', 8.5);
    cell(4, 'Rate', thY + 8, 'Helvetica-Bold', 8.5);
    cell(5, 'per', thY + 8, 'Helvetica-Bold', 8.5);
    cell(6, 'Amount', thY + 8, 'Helvetica-Bold', 8.5);
    y = thY + thH;

    // Item row (with room for the IGST sub-row).
    const itemTop = y;
    cell(0, '1', itemTop + 4, 'Helvetica-Bold', 9);
    cell(1, data.line.description, itemTop + 4, 'Helvetica-Bold', 9);
    cell(2, data.line.hsn, itemTop + 4, 'Helvetica', 8.5);
    cell(3, `${inr(data.line.quantityKg).replace('.00', '')} Kgs`, itemTop + 4, 'Helvetica-Bold', 8.5);
    cell(4, data.line.ratePerKg.toFixed(2), itemTop + 4, 'Helvetica', 8.5);
    cell(5, 'Kgs', itemTop + 4, 'Helvetica', 8.5);
    cell(6, inr(amount), itemTop + 4, 'Helvetica-Bold', 8.5);

    // IGST sub-row.
    const igstY = itemTop + 30;
    cell(1, `IGST ${gstPct}%`, igstY, 'Helvetica-Bold', 8.5);
    cell(4, `${gstPct} %`, igstY, 'Helvetica', 8.5);
    cell(6, inr(gst), igstY, 'Helvetica', 8.5);
    const itemBottom = igstY + 18;

    // Total row.
    const totRowY = itemBottom;
    const totH = 18;
    cell(1, 'Total', totRowY + 4, 'Helvetica-Bold', 9);
    cell(3, `${inr(data.line.quantityKg).replace('.00', '')} Kgs`, totRowY + 4, 'Helvetica-Bold', 8.5);
    cell(6, `Rs. ${inr(total)}`, totRowY + 4, 'Helvetica-Bold', 9);
    const tableBottom = totRowY + totH;

    // Table borders.
    doc.rect(LEFT, thY, W, tableBottom - thY).stroke();
    for (let i = 1; i < cols.length; i++) vline(colX[i], thY, tableBottom);
    hline(itemTop); // below header
    hline(totRowY); // above total
    y = tableBottom;

    // Amount in words --------------------------------------------------------
    label('Amount Chargeable (in words)', LEFT, y, W * 0.7);
    doc.font('Helvetica-Bold').fontSize(9).text('E. & O.E', LEFT, y + 2, { width: W - 4, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(9.5).text(rupeesInWords(total), LEFT + 3, y + 13, { width: W - 6 });
    y += 30;
    hline(y);

    // Tax summary table ------------------------------------------------------
    const tcols = [
      { w: W * 0.28, align: 'left' as const },   // HSN/SAC
      { w: W * 0.22, align: 'right' as const },  // Taxable Value
      { w: W * 0.12, align: 'center' as const }, // IGST Rate
      { w: W * 0.19, align: 'right' as const },  // IGST Amount
      { w: 0, align: 'right' as const },         // Total Tax Amount
    ];
    tcols[4].w = W - tcols.slice(0, 4).reduce((s, c) => s + c.w, 0);
    const tX: number[] = [];
    let tcx = LEFT;
    for (const c of tcols) { tX.push(tcx); tcx += c.w; }
    const tcell = (i: number, t: string, ty: number, font: 'Helvetica' | 'Helvetica-Bold' = 'Helvetica', size = 8) =>
      doc.font(font).fontSize(size).fillColor('#000').text(t, tX[i] + 3, ty, { width: tcols[i].w - 6, align: tcols[i].align });

    const tsTop = y;
    // Header (two-line for IGST split).
    tcell(0, 'HSN/SAC', tsTop + 8, 'Helvetica-Bold');
    tcell(1, 'Taxable Value', tsTop + 8, 'Helvetica-Bold');
    tcell(2, 'IGST Rate', tsTop + 4, 'Helvetica-Bold', 7.5);
    tcell(3, 'IGST Amount', tsTop + 8, 'Helvetica-Bold', 7.5);
    tcell(4, 'Total Tax Amount', tsTop + 4, 'Helvetica-Bold', 7.5);
    const tsHeadH = 22;
    const tsRow = tsTop + tsHeadH;
    tcell(0, data.line.hsn, tsRow + 4);
    tcell(1, inr(amount), tsRow + 4);
    tcell(2, `${gstPct}%`, tsRow + 4);
    tcell(3, inr(gst), tsRow + 4);
    tcell(4, inr(gst), tsRow + 4);
    const tsTotRow = tsRow + 16;
    tcell(0, 'Total', tsTotRow + 4, 'Helvetica-Bold');
    tcell(1, inr(amount), tsTotRow + 4, 'Helvetica-Bold');
    tcell(3, inr(gst), tsTotRow + 4, 'Helvetica-Bold');
    tcell(4, inr(gst), tsTotRow + 4, 'Helvetica-Bold');
    const tsBottom = tsTotRow + 16;

    doc.rect(LEFT, tsTop, W, tsBottom - tsTop).stroke();
    for (let i = 1; i < tcols.length; i++) vline(tX[i], tsTop, tsBottom);
    hline(tsRow);
    hline(tsTotRow);
    y = tsBottom + 4;

    label(`Tax Amount (in words) : `, LEFT, y, W);
    doc.font('Helvetica-Bold').fontSize(8.5).text(rupeesInWords(gst), LEFT + 110, y + 2, { width: W - 114 });
    y += 18;

    // Declaration + bank details --------------------------------------------
    const decTop = y;
    const decW = W * 0.55;
    const bankX = LEFT + decW;
    doc.font('Helvetica').fontSize(8).fillColor('#000');
    doc.text('Declaration', LEFT + 3, decTop + 3, { width: decW - 6 });
    doc.text(
      'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.',
      LEFT + 3, doc.y + 1, { width: decW - 6 }
    );
    doc.font('Helvetica-Bold').fontSize(8).text('Terms & Conditions', LEFT + 3, doc.y + 4, { width: decW - 6 });
    doc.font('Helvetica').fontSize(7.5).text(
      '1. Goods once sold will not be taken back.\n2. Interest @ 18% p.a. will be charged if the payment is not made within the stipulated time.' +
      (data.company.stateName ? `\n3. Subject to '${data.company.stateName}' Jurisdiction only.` : ''),
      LEFT + 3, doc.y + 1, { width: decW - 6 }
    );

    // Bank box.
    const bankW = RIGHT - bankX;
    doc.font('Helvetica-Bold').fontSize(8).text("Company's Bank Details", bankX + 4, decTop + 3, { width: bankW - 8 });
    doc.font('Helvetica').fontSize(8);
    const bankRows: [string, string | null | undefined][] = [
      ["A/c Holder's Name", data.company.bankAccountName || data.company.name],
      ['Bank Name', data.company.bankName],
      ['A/c No.', data.company.bankAccountNumber],
      ['Branch & IFS Code', data.company.bankBranchIfsc],
    ];
    let by = doc.y + 2;
    for (const [k, v] of bankRows) {
      doc.font('Helvetica').fontSize(8).text(`${k} :`, bankX + 4, by, { width: bankW * 0.45 });
      doc.font('Helvetica-Bold').fontSize(8).text(v || '', bankX + bankW * 0.45, by, { width: bankW * 0.55 - 6 });
      by = doc.y + 1;
    }
    doc.font('Helvetica-Bold').fontSize(8).text(`for ${data.company.name}`, bankX + 4, by + 8, { width: bankW - 8, align: 'right' });
    doc.font('Helvetica').fontSize(8).text('Authorised Signatory', bankX + 4, by + 40, { width: bankW - 8, align: 'right' });

    const decBottom = Math.max(doc.y + 6, by + 56);
    doc.rect(LEFT, decTop, W, decBottom - decTop).stroke();
    vline(bankX, decTop, decBottom);
    y = decBottom + 8;

    doc.font('Helvetica').fontSize(8).fillColor('#444').text('This is a Computer Generated Invoice', LEFT, y, { width: W, align: 'center' });

    doc.end();
  });
}
