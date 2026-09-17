import PDFDocument from 'pdfkit';
import { drawSignatureMark } from './signatureAssets.js';

type TicketLike = {
  ticketNo: number;
  vehicleNumber: string;
  partyName: string | null;
  material: string | null;
  loadType: string;
  firstWeightKg: number | null;
  secondWeightKg: number | null;
  netWeightKg: number | null;
  amount: unknown;
  paidAmount: unknown;
  paidAt: Date | null;
  paymentStatus: string;
  paymentReference: string | null;
  operatorName: string | null;
  firstWeighedAt: Date | null;
  secondWeighedAt: Date | null;
};

type CompanyLike = { name: string; address: string | null; gstin: string | null; contact: string | null };

const fmtKg = (value: number | null) => `${Number(value || 0).toLocaleString('en-IN')} kg`;
const fmtMoney = (value: unknown) => `Rs. ${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (value: Date | null) => value
  ? value.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
  : '-';

/** Official signed weighbridge certificate used for the driver's WhatsApp copy. */
export function renderWeighbridgeSlipPdf(ticket: TicketLike, company: CompanyLike): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 44 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 44;
    const width = 507;
    doc.font('Helvetica-Bold').fontSize(19).fillColor('#1c1917').text(company.name.toUpperCase(), left, 42, { width, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor('#78716c').text([company.address, company.gstin ? `GSTIN: ${company.gstin}` : '', company.contact ? `Ph: ${company.contact}` : ''].filter(Boolean).join('  |  '), left, 68, { width, align: 'center' });
    doc.moveTo(left, 91).lineTo(left + width, 91).lineWidth(1.2).strokeColor('#b45309').stroke();
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#292524').text('WEIGHBRIDGE CERTIFICATE', left, 106, { width, align: 'center' });
    doc.font('Helvetica').fontSize(9).fillColor('#78716c').text(`Ticket #${ticket.ticketNo}  |  Final weighment: ${fmtDate(ticket.secondWeighedAt)}`, left, 127, { width, align: 'center' });

    const rows: Array<[string, string, string, string]> = [
      ['Vehicle Number', ticket.vehicleNumber, 'Party / Customer', ticket.partyName || '-'],
      ['Material', ticket.material || '-', 'Load Condition', ticket.loadType],
      ['First Weight', fmtKg(ticket.firstWeightKg), 'First Weighed At', fmtDate(ticket.firstWeighedAt)],
      ['Second Weight', fmtKg(ticket.secondWeightKg), 'Second Weighed At', fmtDate(ticket.secondWeighedAt)],
      ['NET WEIGHT', fmtKg(ticket.netWeightKg), 'Kata Charge', fmtMoney(ticket.amount)],
      ['Payment', ticket.paymentStatus === 'NOT_REQUIRED' ? 'FREE / NO CHARGE' : ticket.paymentStatus, 'Amount Received', fmtMoney(ticket.paidAmount)],
      ['Payment Reference', ticket.paymentReference || '-', 'Operator', ticket.operatorName || '-'],
    ];
    let y = 160;
    const rowH = 42;
    for (const [l1, v1, l2, v2] of rows) {
      doc.roundedRect(left, y, width, rowH - 4, 4).fillAndStroke(y / rowH % 2 > 1 ? '#fafaf9' : '#f5f5f4', '#e7e5e4');
      doc.font('Helvetica').fontSize(7.5).fillColor('#78716c').text(l1.toUpperCase(), left + 10, y + 7, { width: 105 });
      doc.font('Helvetica-Bold').fontSize(l1 === 'NET WEIGHT' ? 12 : 9.5).fillColor(l1 === 'NET WEIGHT' ? '#047857' : '#1c1917').text(v1, left + 118, y + 10, { width: 125 });
      doc.font('Helvetica').fontSize(7.5).fillColor('#78716c').text(l2.toUpperCase(), left + 265, y + 7, { width: 105 });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#1c1917').text(v2, left + 368, y + 10, { width: 128 });
      y += rowH;
    }

    doc.font('Helvetica').fontSize(8).fillColor('#78716c').text('This computer-generated certificate is valid with the authorised digital signature and company seal shown below.', left, y + 12, { width: 315 });
    const markBottom = drawSignatureMark(doc, { x: left + 345, width: 150, y: y - 2, align: 'center', stampSize: 74, signHeight: 42 });
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#44403c').text('AUTHORISED SIGNATORY', left + 345, markBottom + 2, { width: 150, align: 'center' });
    doc.font('Helvetica').fontSize(7).fillColor('#a8a29e').text(`Generated ${fmtDate(ticket.paidAt || ticket.secondWeighedAt)}`, left, 790, { width, align: 'center' });
    doc.end();
  });
}
