import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { drawSignatureMark } from './signatureAssets.js';

const ASSET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/assets');

let ganeshaImg: Buffer | null = null;
try {
  ganeshaImg = fs.readFileSync(path.join(ASSET_DIR, 'kata-ganesha.jpg'));
} catch {
  try {
    ganeshaImg = fs.readFileSync(path.join(ASSET_DIR, 'ganesha.jpg'));
  } catch {}
}

type TicketLike = {
  ticketNo: number;
  vehicleNumber: string;
  partyName: string | null;
  isStorageTransfer: boolean;
  storageLocation: string | null;
  transferDirection: string | null;
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

    // ── Top Left: Lord Ganesha Emblem in Sacred Circular Frame ──
    if (ganeshaImg) {
      doc.save();
      // Outer red & inner gold ring
      doc.circle(left + 27, 54, 25).lineWidth(2).strokeColor('#b91c1c').stroke();
      doc.circle(left + 27, 54, 23).lineWidth(1).strokeColor('#eab308').stroke();
      doc.image(ganeshaImg, left + 5, 32, { fit: [44, 44], align: 'center' });
      doc.restore();
    }

    // ── Center Header: RVP WEIGH BRIDGE ──
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#b91c1c').text('RVP WEIGH BRIDGE', left + 56, 34, { width: width - 112, align: 'center' });
    
    // Govt Approved Badge
    const badgeW = 92;
    const badgeH = 11;
    const badgeMid = left + (width / 2) - (badgeW / 2);
    doc.roundedRect(badgeMid, 57, badgeW, badgeH, 5).fill('#facc15');
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#000000').text('GOVT APPROVED', badgeMid, 59, { width: badgeW, align: 'center' });

    doc.font('Helvetica').fontSize(8).fillColor('#27272a').text(
      '3/86, New By-Pass Road, Near Rajuluru, BG Palli, PUNGANUR - 517 247, Chittoor Dist., A.P.',
      left + 56,
      72,
      { width: width - 112, align: 'center' }
    );
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#18181b').text(
      'Ph : 91215 53909, 94909 21002',
      left + 56,
      83,
      { width: width - 112, align: 'center' }
    );

    // ── Top Right: 24 Hrs Service Badge ──
    doc.save();
    const badgeX = left + width - 28;
    const badgeY = 54;
    doc.circle(badgeX, badgeY, 21).lineWidth(1.5).strokeColor('#18181b').stroke();
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#18181b').text('24', badgeX - 15, badgeY - 14, { width: 30, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#18181b').text('HRS', badgeX - 15, badgeY - 2, { width: 30, align: 'center' });
    doc.roundedRect(badgeX - 14, badgeY + 6, 28, 7.5, 1.5).fill('#18181b');
    doc.font('Helvetica-Bold').fontSize(5).fillColor('#ffffff').text('SERVICE', badgeX - 14, badgeY + 7.5, { width: 28, align: 'center' });
    doc.restore();

    doc.moveTo(left, 97).lineTo(left + width, 97).lineWidth(1.5).strokeColor('#b91c1c').stroke();
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#292524').text('OFFICIAL WEIGHMENT CERTIFICATE', left, 108, { width, align: 'center' });
    doc.font('Helvetica').fontSize(9).fillColor('#78716c').text(`Ticket #${String(ticket.ticketNo).padStart(2, '0')}  |  Weighment: ${fmtDate(ticket.secondWeighedAt || ticket.firstWeighedAt)}`, left, 126, { width, align: 'center' });

    const partyOrRoute = ticket.isStorageTransfer && ticket.storageLocation
      ? ticket.transferDirection === 'STORAGE_TO_RVP'
        ? `${ticket.storageLocation} -> RVP`
        : `RVP -> ${ticket.storageLocation}`
      : ticket.partyName || '-';
    const rows: Array<[string, string, string, string]> = [
      ['Vehicle Number', ticket.vehicleNumber, ticket.isStorageTransfer ? 'Internal Transfer' : 'Party / Customer', partyOrRoute],
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

    doc.font('Helvetica').fontSize(8).fillColor('#78716c').text('This computer-generated certificate is issued with the official RVP INDUSTRIES stamp and authorised signature.', left, y + 12, { width: 315 });
    const markBottom = drawSignatureMark(doc, { x: left + 345, width: 150, y: y - 2, align: 'center', stampSize: 74, signHeight: 42 });
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#44403c').text('AUTHORISED SIGNATORY', left + 345, markBottom + 2, { width: 150, align: 'center' });
    doc.font('Helvetica').fontSize(7).fillColor('#a8a29e').text(`Generated ${fmtDate(ticket.paidAt || ticket.secondWeighedAt)}`, left, 790, { width, align: 'center' });
    doc.end();
  });
}
