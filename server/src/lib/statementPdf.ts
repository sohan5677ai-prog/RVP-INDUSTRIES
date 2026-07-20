import PDFDocument from 'pdfkit';
import { inr } from './invoice.js';
import type { PartyStatementData } from '../controllers/ledger.controller.js';

/**
 * Renders a party account statement (Tally-style running ledger) as a PDF Buffer.
 * Shared shape with the ledger endpoint via `PartyStatementData` so the figures
 * match the on-screen Party Ledger exactly. Sent to suppliers on WhatsApp after a
 * lorry is unloaded & verified (use case #4).
 */

export interface StatementCompany {
  name: string;
  address?: string | null;
  gstin?: string | null;
  contact?: string | null;
}

const PAGE = { margin: 36, width: 595.28, height: 841.89 };
const LEFT = PAGE.margin;
const RIGHT = PAGE.width - PAGE.margin;
const W = RIGHT - LEFT;
const BOTTOM = PAGE.height - PAGE.margin;

// Column x-offsets (widths sum to W = 523.28).
const COL = { date: LEFT, particulars: LEFT + 56, ref: LEFT + 246, debit: LEFT + 336, credit: LEFT + 424 };
const COL_END = RIGHT; // balance column runs to the right edge
const w = {
  date: 56,
  particulars: 190,
  ref: 90,
  debit: 88,
  credit: 88,
  balance: RIGHT - (LEFT + 424 + 88),
};

function fmtDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '-');
}

function money(n: number): string {
  return n ? inr(Math.round(n)) : '';
}

export function renderStatementPdf(company: StatementCompany, data: PartyStatementData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { party, transactions, summary } = data;

    // --- Header -------------------------------------------------------------
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#0f172a').text(company.name, LEFT, PAGE.margin, { width: W, align: 'left' });
    let y = PAGE.margin + 20;
    doc.font('Helvetica').fontSize(8).fillColor('#334155');
    if (company.address) {
      doc.text(company.address.replace(/\n/g, ', '), LEFT, y, { width: W * 0.65 });
      y = doc.y + 1;
    }
    const idBits = [company.gstin ? `GSTIN: ${company.gstin}` : null, company.contact ? `Ph: ${company.contact}` : null].filter(Boolean).join('   ');
    if (idBits) { doc.text(idBits, LEFT, y, { width: W }); y = doc.y; }

    doc.font('Helvetica-Bold').fontSize(13).fillColor('#0f172a').text('ACCOUNT STATEMENT', LEFT, PAGE.margin, { width: W, align: 'right' });
    doc.font('Helvetica').fontSize(8).fillColor('#334155').text(`As on ${fmtDate(new Date())}`, LEFT, PAGE.margin + 18, { width: W, align: 'right' });

    y = Math.max(y, PAGE.margin + 34) + 8;
    doc.lineWidth(0.7).strokeColor('#cbd5e1').moveTo(LEFT, y).lineTo(RIGHT, y).stroke();
    y += 8;

    // Party block
    doc.font('Helvetica').fontSize(8).fillColor('#64748b').text('STATEMENT FOR', LEFT, y);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text(party.name, LEFT, y + 10, { width: W * 0.7 });
    y = doc.y + 10;

    // --- Table header -------------------------------------------------------
    const drawTableHeader = (yy: number): number => {
      doc.rect(LEFT, yy, W, 18).fill('#0f172a');
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
      doc.text('Date', COL.date + 3, yy + 5, { width: w.date - 4 });
      doc.text('Particulars', COL.particulars + 3, yy + 5, { width: w.particulars - 4 });
      doc.text('Ref / Inv', COL.ref + 3, yy + 5, { width: w.ref - 4 });
      doc.text('Debit', COL.debit, yy + 5, { width: w.debit - 4, align: 'right' });
      doc.text('Credit', COL.credit, yy + 5, { width: w.credit - 4, align: 'right' });
      doc.text('Balance', COL.credit + w.credit, yy + 5, { width: w.balance - 4, align: 'right' });
      return yy + 18;
    };
    y = drawTableHeader(y);

    // --- Rows ---------------------------------------------------------------
    doc.font('Helvetica').fontSize(7.5).fillColor('#0f172a');
    let zebra = false;
    for (const t of transactions) {
      const particulars = t.particulars || t.kind;
      const refText = t.invoiceNumber || t.reference || t.vehicleNumber || '';
      // Estimate row height from the tallest wrapping cell.
      const pHeight = doc.heightOfString(particulars, { width: w.particulars - 6 });
      const rowH = Math.max(14, pHeight + 6);

      if (y + rowH > BOTTOM - 60) {
        doc.addPage();
        y = PAGE.margin;
        y = drawTableHeader(y);
        doc.font('Helvetica').fontSize(7.5).fillColor('#0f172a');
      }

      if (zebra) doc.rect(LEFT, y, W, rowH).fill('#f1f5f9');
      zebra = !zebra;
      doc.fillColor('#0f172a');
      doc.text(fmtDate(t.date), COL.date + 3, y + 3, { width: w.date - 4 });
      doc.text(particulars, COL.particulars + 3, y + 3, { width: w.particulars - 6 });
      doc.text(refText, COL.ref + 3, y + 3, { width: w.ref - 4 });
      doc.text(money(t.debit), COL.debit, y + 3, { width: w.debit - 4, align: 'right' });
      doc.text(money(t.credit), COL.credit, y + 3, { width: w.credit - 4, align: 'right' });
      const bal = t.runningBalance ?? 0;
      doc.text(`${inr(Math.abs(Math.round(bal)))} ${bal >= 0 ? 'Dr' : 'Cr'}`, COL.credit + w.credit, y + 3, { width: w.balance - 4, align: 'right' });
      y += rowH;
    }

    // --- Summary ------------------------------------------------------------
    y += 6;
    doc.lineWidth(0.7).strokeColor('#0f172a').moveTo(LEFT, y).lineTo(RIGHT, y).stroke();
    y += 8;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#0f172a');
    doc.text('Total', COL.particulars + 3, y, { width: w.particulars - 4 });
    doc.text(inr(summary.totalDebit), COL.debit, y, { width: w.debit - 4, align: 'right' });
    doc.text(inr(summary.totalCredit), COL.credit, y, { width: w.credit - 4, align: 'right' });
    y += 16;

    doc.rect(LEFT, y, W, 26).fill('#0f172a');
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#ffffff');
    const closingLabel = summary.balanceType === 'DR' ? 'Balance Receivable' : 'Balance Payable';
    doc.text(closingLabel, COL.particulars + 3, y + 8, { width: 260 });
    doc.text(`₹ ${inr(summary.balance)} ${summary.balanceType}`, COL.debit, y + 8, { width: w.debit + w.credit + w.balance - 4, align: 'right' });
    y += 26;

    doc.font('Helvetica').fontSize(7).fillColor('#94a3b8').text(
      'This is a computer-generated statement and does not require a signature. Please report any discrepancy within 7 days.',
      LEFT, y + 12, { width: W, align: 'center' }
    );

    doc.end();
  });
}
