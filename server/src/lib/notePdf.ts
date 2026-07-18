import PDFDocument from 'pdfkit';
import { inr, rupeesInWords } from './invoice.js';

export interface NotePdfData {
  kind: 'CREDIT' | 'DEBIT';
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
  party: {
    name: string;
    address?: string | null;
    gstin?: string | null;
    stateName?: string | null;
    stateCode?: string | null;
  };
  noteNumber: string;
  noteDate: Date;
  reason: string;
  taxableValue: number;
  gstRate: number; // percent, e.g. 5
  gstAmount: number;
  totalAmount: number;
  referenceInvoiceNumber?: string | null;
}

const PAGE = { margin: 36, width: 595.28 };
const LEFT = PAGE.margin;
const RIGHT = PAGE.width - PAGE.margin;
const W = RIGHT - LEFT;

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '-');
}

/** Render a credit/debit note as a PDF and resolve with the full Buffer. */
export function renderNotePdf(data: NotePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.lineWidth(0.7).strokeColor('#000');

    const hline = (y: number, x1 = LEFT, x2 = RIGHT) => doc.moveTo(x1, y).lineTo(x2, y).stroke();
    const vline = (x: number, y1: number, y2: number) => doc.moveTo(x, y1).lineTo(x, y2).stroke();
    const label = (t: string, x: number, y: number, w: number, size = 8) =>
      doc.font('Helvetica').fontSize(size).fillColor('#000').text(t, x + 3, y + 2, { width: w - 6 });
    const bold = (t: string, x: number, y: number, w: number, size = 9) =>
      doc.font('Helvetica-Bold').fontSize(size).fillColor('#000').text(t, x + 3, y + 2, { width: w - 6 });

    const title = data.kind === 'CREDIT' ? 'Credit Note' : 'Debit Note';
    doc.font('Helvetica-Bold').fontSize(15).text(title, LEFT, PAGE.margin, { width: W, align: 'center' });
    let y = PAGE.margin + 26;

    // Header box: seller/party (left) + note meta (right) -----------------
    const splitX = LEFT + W * 0.56;
    const headerTop = y;
    const metaRowH = 30;

    label('Note No.', splitX, headerTop, W - (splitX - LEFT));
    bold(data.noteNumber, splitX, headerTop + 11, W - (splitX - LEFT));
    const r2 = headerTop + metaRowH;
    label('Dated', splitX, r2, (RIGHT - splitX) / 2);
    label('Ref. Invoice', splitX + (RIGHT - splitX) / 2, r2, (RIGHT - splitX) / 2);
    bold(fmtDate(data.noteDate), splitX, r2 + 11, (RIGHT - splitX) / 2);
    bold(data.referenceInvoiceNumber || '-', splitX + (RIGHT - splitX) / 2, r2 + 11, (RIGHT - splitX) / 2);

    let ly = headerTop + 4;
    doc.font('Helvetica-Bold').fontSize(10).text(data.company.name, LEFT + 4, ly, { width: splitX - LEFT - 8 });
    ly = doc.y + 1;
    doc.font('Helvetica').fontSize(8);
    if (data.company.address) { doc.text(data.company.address, LEFT + 4, ly, { width: splitX - LEFT - 8 }); ly = doc.y; }
    if (data.company.gstin) { doc.text(`GSTIN/UIN: ${data.company.gstin}`, LEFT + 4, ly, { width: splitX - LEFT - 8 }); ly = doc.y; }
    if (data.company.stateName) { doc.text(`State Name : ${data.company.stateName}`, LEFT + 4, ly, { width: splitX - LEFT - 8 }); ly = doc.y; }

    ly += 6;
    const partyLabelY = ly;
    doc.font('Helvetica').fontSize(8).text(data.kind === 'CREDIT' ? 'Buyer' : 'To', LEFT + 4, ly); ly = doc.y + 1;
    doc.font('Helvetica-Bold').fontSize(9.5).text(data.party.name, LEFT + 4, ly, { width: splitX - LEFT - 8 }); ly = doc.y + 1;
    doc.font('Helvetica').fontSize(8);
    if (data.party.address) { doc.text(data.party.address, LEFT + 4, ly, { width: splitX - LEFT - 8 }); ly = doc.y; }
    if (data.party.gstin) { doc.text(`GSTIN/UIN : ${data.party.gstin}`, LEFT + 4, ly, { width: splitX - LEFT - 8 }); ly = doc.y; }
    if (data.party.stateName) { doc.text(`State Name : ${data.party.stateName}`, LEFT + 4, ly, { width: splitX - LEFT - 8 }); ly = doc.y; }

    const headerBottom = Math.max(ly + 6, headerTop + metaRowH * 2);
    doc.rect(LEFT, headerTop, W, headerBottom - headerTop).stroke();
    vline(splitX, headerTop, headerBottom);
    hline(headerTop + metaRowH, splitX, RIGHT);
    hline(partyLabelY - 3, LEFT, splitX);
    y = headerBottom;

    // Reason / amount table ---------------------------------------------------
    const cols = [
      { key: 'reason', w: W * 0.4, align: 'left' as const },
      { key: 'taxable', w: W * 0.18, align: 'right' as const },
      { key: 'rate', w: W * 0.12, align: 'center' as const },
      { key: 'gst', w: W * 0.15, align: 'right' as const },
      { key: 'total', w: 0, align: 'right' as const },
    ];
    cols[cols.length - 1].w = W - cols.slice(0, -1).reduce((s, c) => s + c.w, 0);
    const colX: number[] = []; let cx = LEFT;
    for (const c of cols) { colX.push(cx); cx += c.w; }
    const cell = (i: number, t: string, ty: number, font: 'Helvetica' | 'Helvetica-Bold' = 'Helvetica', size = 8.5) =>
      doc.font(font).fontSize(size).fillColor('#000').text(t, colX[i] + 4, ty, { width: cols[i].w - 8, align: cols[i].align });

    const thY = y, thH = 20;
    cell(0, 'Reason', thY + 6, 'Helvetica-Bold');
    cell(1, 'Taxable Value', thY + 6, 'Helvetica-Bold');
    cell(2, 'GST %', thY + 6, 'Helvetica-Bold');
    cell(3, 'GST Amount', thY + 6, 'Helvetica-Bold');
    cell(4, 'Total', thY + 6, 'Helvetica-Bold');
    y = thY + thH;

    const rowTop = y;
    cell(0, data.reason, rowTop + 6, 'Helvetica', 8.5);
    cell(1, inr(data.taxableValue), rowTop + 6);
    cell(2, `${data.gstRate}%`, rowTop + 6);
    cell(3, inr(data.gstAmount), rowTop + 6);
    cell(4, inr(data.totalAmount), rowTop + 6, 'Helvetica-Bold');
    const rowBottom = rowTop + 28;

    doc.rect(LEFT, thY, W, rowBottom - thY).stroke();
    for (let i = 1; i < cols.length; i++) vline(colX[i], thY, rowBottom);
    hline(rowTop, LEFT, RIGHT);
    y = rowBottom + 8;

    label('Amount (in words)', LEFT, y, W);
    doc.font('Helvetica-Bold').fontSize(9.5).text(rupeesInWords(data.totalAmount), LEFT + 3, y + 12, { width: W - 6 });
    y += 32;
    hline(y);
    y += 8;

    // Declaration + bank details --------------------------------------------
    const decTop = y;
    const decW = W * 0.55;
    const bankX = LEFT + decW;
    doc.font('Helvetica').fontSize(8).fillColor('#000');
    doc.text('Declaration', LEFT + 3, decTop + 3, { width: decW - 6 });
    doc.text(
      `We confirm that this ${title.toLowerCase()} is issued in respect of the reference invoice noted above and reflects the actual adjustment agreed with the party.`,
      LEFT + 3, doc.y + 1, { width: decW - 6 }
    );

    doc.font('Helvetica-Bold').fontSize(8).text("Company's Bank Details", bankX + 4, decTop + 3, { width: RIGHT - bankX - 8 });
    doc.font('Helvetica').fontSize(8);
    const bankRows: [string, string | null | undefined][] = [
      ["A/c Holder's Name", data.company.bankAccountName || data.company.name],
      ['Bank Name', data.company.bankName],
      ['A/c No.', data.company.bankAccountNumber],
      ['Branch & IFS Code', data.company.bankBranchIfsc],
    ];
    let by = doc.y + 2;
    for (const [k, v] of bankRows) {
      doc.font('Helvetica').fontSize(8).text(`${k} :`, bankX + 4, by, { width: (RIGHT - bankX) * 0.45, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(8).text(v || '-', bankX + (RIGHT - bankX) * 0.45, by, { width: (RIGHT - bankX) * 0.55 - 6, lineBreak: false });
      by += 11; // fixed row height — doc.y after an empty-string .text() doesn't reliably advance
    }
    doc.font('Helvetica-Bold').fontSize(8).text(`for ${data.company.name}`, bankX + 4, by + 8, { width: RIGHT - bankX - 8, align: 'right' });
    doc.font('Helvetica').fontSize(8).text('Authorised Signatory', bankX + 4, by + 40, { width: RIGHT - bankX - 8, align: 'right' });

    const decBottom = Math.max(doc.y + 6, by + 56);
    doc.rect(LEFT, decTop, W, decBottom - decTop).stroke();
    vline(bankX, decTop, decBottom);
    y = decBottom + 8;

    doc.font('Helvetica').fontSize(8).fillColor('#444').text('This is a Computer Generated Document', LEFT, y, { width: W, align: 'center' });

    doc.end();
  });
}
