import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createNoteSchema } from '../schemas/note.schema.js';
import { reserveNoteSerial, formatNoteNumber } from '../lib/noteNumber.js';
import { indianFinancialYear } from '../lib/invoice.js';
import { renderNotePdf, type NotePdfData } from '../lib/notePdf.js';
import { getCompanyProfileRow } from './settings.controller.js';
import { emailService } from '../services/email.service.js';

type Kind = 'CREDIT' | 'DEBIT';

function model(kind: Kind) {
  return kind === 'CREDIT' ? prisma.creditNote : prisma.debitNote;
}

export function listNotes(kind: Kind) {
  return async (req: Request, res: Response) => {
    const partyId = req.query.partyId as string | undefined;
    const rows = await (model(kind) as any).findMany({
      where: partyId ? { partyId } : undefined,
      include: { party: true, saleDispatch: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(rows);
  };
}

export function getNote(kind: Kind) {
  return async (req: Request, res: Response) => {
    const row = await (model(kind) as any).findUnique({
      where: { id: req.params.id },
      include: { party: true, saleDispatch: true },
    });
    if (!row) throw new HttpError(404, `${kind === 'CREDIT' ? 'Credit' : 'Debit'} note not found`);
    res.json(row);
  };
}

export function createNote(kind: Kind) {
  return async (req: Request, res: Response) => {
    const data = createNoteSchema.parse(req.body);
    const party = await prisma.party.findUnique({ where: { id: data.partyId } });
    if (!party) throw new HttpError(404, 'Party not found');

    if (data.saleDispatchId) {
      const dispatch = await prisma.saleDispatch.findUnique({ where: { id: data.saleDispatchId } });
      if (!dispatch) throw new HttpError(404, 'Sale dispatch not found');
    }

    const noteDate = data.noteDate ?? new Date();
    const fy = indianFinancialYear(noteDate);
    const seriesKey = kind === 'CREDIT' ? 'CN' : 'DN';
    const company = await getCompanyProfileRow();
    const prefix = company.invoicePrefix || 'RVP';

    const gstAmount = Math.round(data.taxableValue * (data.gstRate / 100) * 100) / 100;
    const totalAmount = data.taxableValue + gstAmount;

    const created = await prisma.$transaction(async (tx) => {
      const seq = await reserveNoteSerial(tx, seriesKey, fy);
      const noteNumber = formatNoteNumber(prefix, seriesKey, seq, fy);
      const createData = {
        noteNumber,
        noteSeq: seq,
        noteFy: fy,
        noteDate,
        partyId: data.partyId,
        saleDispatchId: data.saleDispatchId,
        reason: data.reason,
        taxableValue: data.taxableValue,
        gstRate: data.gstRate,
        gstAmount,
        totalAmount,
      };
      if (kind === 'CREDIT') return tx.creditNote.create({ data: createData, include: { party: true, saleDispatch: true } });
      return tx.debitNote.create({ data: createData, include: { party: true, saleDispatch: true } });
    });

    res.status(201).json(created);
  };
}

async function buildNotePdfData(kind: Kind, id: string) {
  const row = await (model(kind) as any).findUnique({
    where: { id },
    include: { party: true, saleDispatch: true },
  }) as any;
  if (!row) throw new HttpError(404, `${kind === 'CREDIT' ? 'Credit' : 'Debit'} note not found`);

  const company = await getCompanyProfileRow();
  const partyGstin = row.party.gstin ?? null;
  const partyStateCode = partyGstin && /^\d{2}/.test(partyGstin) ? partyGstin.slice(0, 2) : null;

  const pdfData: NotePdfData = {
    kind,
    company: {
      name: company.name,
      address: company.address,
      gstin: company.gstin,
      stateName: company.stateName,
      stateCode: company.stateCode,
      contact: company.contact,
      bankAccountName: company.bankAccountName,
      bankName: company.bankName,
      bankAccountNumber: company.bankAccountNumber,
      bankBranchIfsc: company.bankBranchIfsc,
    },
    party: {
      name: row.party.name,
      address: row.party.address,
      gstin: partyGstin,
      stateName: row.party.state,
      stateCode: partyStateCode,
    },
    noteNumber: row.noteNumber,
    noteDate: row.noteDate,
    reason: row.reason,
    taxableValue: Number(row.taxableValue),
    gstRate: Number(row.gstRate),
    gstAmount: Number(row.gstAmount),
    totalAmount: Number(row.totalAmount),
    referenceInvoiceNumber: row.saleDispatch?.invoiceNumber ?? null,
  };

  return { row, company, pdfData };
}

export function getNotePdf(kind: Kind) {
  return async (req: Request, res: Response) => {
    const { row, pdfData } = await buildNotePdfData(kind, req.params.id);
    const buffer = await renderNotePdf(pdfData);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${row.noteNumber.replace(/\//g, '-')}.pdf"`);
    res.send(buffer);
  };
}

export async function sendNoteEmailById(kind: Kind, id: string) {
  const { row, company, pdfData } = await buildNotePdfData(kind, id);
  if (!row.party.email) throw new HttpError(400, `${row.party.name} has no email on file — add one in Parties first`);

  const buffer = await renderNotePdf(pdfData);
  const title = kind === 'CREDIT' ? 'Credit Note' : 'Debit Note';
  const html = `<p>Dear ${row.party.name},</p>` +
    `<p>Please find attached the ${title.toLowerCase()} <strong>${row.noteNumber}</strong>.</p>` +
    `<p>Reason: ${row.reason}</p>` +
    `<p>Regards,<br/>${company.name}</p>`;

  return emailService.sendDocumentEmail({
    party: { id: row.party.id, email: row.party.email, name: row.party.name },
    documentType: kind === 'CREDIT' ? 'CREDIT_NOTE' : 'DEBIT_NOTE',
    referenceLabel: row.noteNumber,
    creditNoteId: kind === 'CREDIT' ? row.id : undefined,
    debitNoteId: kind === 'DEBIT' ? row.id : undefined,
    subject: `${title} ${row.noteNumber} - ${company.name}`,
    html,
    attachments: [{ filename: `${row.noteNumber.replace(/\//g, '-')}.pdf`, content: buffer }],
  });
}

export function emailNote(kind: Kind) {
  return async (req: Request, res: Response) => {
    const result = await sendNoteEmailById(kind, req.params.id);
    if (!result.ok) throw new HttpError(502, result.error || 'Failed to send email');
    res.json(result);
  };
}

/**
 * Shortage amounts already posted to the party ledger (SaleDispatch.creditNoteAmount
 * from buyer-kata mismatch, or Receipt.shortageAmount entered at payment time) but
 * with no formal CreditNote document raised yet. Mirrors the same-amount-once rule
 * used when building the party ledger: a receipt-level shortage on a dispatch takes
 * priority over the dispatch-level auto amount.
 */
export async function listPendingCreditNotes(_req: Request, res: Response) {
  const dispatches = await prisma.saleDispatch.findMany({
    where: {
      OR: [{ creditNoteAmount: { gt: 0 } }, { receipts: { some: { shortageAmount: { gt: 0 } } } }],
    },
    include: {
      saleOrder: { include: { buyer: true } },
      receipts: true,
      creditNotes: true,
    },
    orderBy: { dispatchDate: 'desc' },
  });

  const pending = dispatches
    .filter((d) => d.creditNotes.length === 0)
    .map((d) => {
      const receiptShortage = d.receipts.find((r) => Number(r.shortageAmount ?? 0) > 0);
      if (receiptShortage) {
        const amount = Number(receiptShortage.shortageAmount);
        return {
          saleDispatchId: d.id,
          invoiceNumber: d.invoiceNumber,
          date: receiptShortage.date,
          partyId: d.saleOrder.buyerId,
          partyName: d.saleOrder.buyer.name,
          shortageKg: d.shortageKg,
          taxableValue: amount,
          gstRate: 0,
          totalAmount: amount,
          source: 'RECEIPT' as const,
        };
      }
      const amount = Number(d.creditNoteAmount ?? 0);
      const gstExempt = d.saleOrder.gstExempt;
      const shortageKg = d.shortageKg ?? 0;
      const rate = Number(d.saleOrder.ratePerKg);
      const taxableValue = round2(shortageKg * rate);
      const gstRate = gstExempt || taxableValue <= 0 ? 0 : round2(((amount - taxableValue) / taxableValue) * 100);
      return {
        saleDispatchId: d.id,
        invoiceNumber: d.invoiceNumber,
        date: d.receivedDate ?? d.deliveredDate ?? d.dispatchDate,
        partyId: d.saleOrder.buyerId,
        partyName: d.saleOrder.buyer.name,
        shortageKg: d.shortageKg,
        taxableValue,
        gstRate,
        totalAmount: amount,
        source: 'DISPATCH' as const,
      };
    })
    .filter((p) => p.totalAmount > 0);

  res.json(pending);
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
