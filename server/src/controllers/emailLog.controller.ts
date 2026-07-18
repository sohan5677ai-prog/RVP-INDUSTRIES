import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { sendInvoiceEmail, sendEwbEmail } from '../services/saleDocumentEmail.service.js';
import { sendNoteEmailById } from './notes.controller.js';
import type { EmailDocumentType } from '@prisma/client';

export async function listEmailLogs(req: Request, res: Response) {
  const partyId = req.query.partyId as string | undefined;
  const documentType = req.query.documentType as EmailDocumentType | undefined;
  const rows = await prisma.emailLog.findMany({
    where: {
      ...(partyId ? { partyId } : {}),
      ...(documentType ? { documentType } : {}),
    },
    include: { party: true },
    orderBy: { sentAt: 'desc' },
  });
  res.json(rows);
}

export async function resendEmailLog(req: Request, res: Response) {
  const log = await prisma.emailLog.findUnique({ where: { id: req.params.id } });
  if (!log) throw new HttpError(404, 'Email log entry not found');

  let result;
  switch (log.documentType) {
    case 'INVOICE':
      if (!log.saleDispatchId) throw new HttpError(400, 'Original dispatch reference missing');
      result = await sendInvoiceEmail(log.saleDispatchId);
      break;
    case 'EWB':
      if (!log.saleDispatchId) throw new HttpError(400, 'Original dispatch reference missing');
      result = await sendEwbEmail(log.saleDispatchId);
      break;
    case 'CREDIT_NOTE':
      if (!log.creditNoteId) throw new HttpError(400, 'Original credit note reference missing');
      result = await sendNoteEmailById('CREDIT', log.creditNoteId);
      break;
    case 'DEBIT_NOTE':
      if (!log.debitNoteId) throw new HttpError(400, 'Original debit note reference missing');
      result = await sendNoteEmailById('DEBIT', log.debitNoteId);
      break;
  }

  if (!result.ok) throw new HttpError(502, result.error || 'Failed to resend email');
  res.json(result);
}
