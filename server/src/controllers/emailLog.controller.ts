import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { sendInvoiceEmail, sendEwbEmail } from '../services/saleDocumentEmail.service.js';
import { sendNoteEmailById } from './notes.controller.js';
import type { EmailDocumentType, EmailStatus } from '@prisma/client';

export async function listEmailLogs(req: Request, res: Response) {
  const partyId = req.query.partyId as string | undefined;
  const documentType = req.query.documentType as EmailDocumentType | undefined;
  const status = req.query.status as EmailStatus | undefined;
  const search = req.query.search ? (req.query.search as string).trim() : undefined;
  const fromDate = req.query.fromDate as string | undefined;
  const toDate = req.query.toDate as string | undefined;

  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (fromDate) {
    dateFilter.gte = new Date(fromDate);
  }
  if (toDate) {
    const end = new Date(toDate);
    end.setHours(23, 59, 59, 999);
    dateFilter.lte = end;
  }

  const whereClause: any = {
    ...(partyId ? { partyId } : {}),
    ...(documentType ? { documentType } : {}),
    ...(status ? { status } : {}),
    ...(Object.keys(dateFilter).length > 0 ? { sentAt: dateFilter } : {}),
    ...(search
      ? {
          OR: [
            { referenceLabel: { contains: search, mode: 'insensitive' } },
            { recipientEmail: { contains: search, mode: 'insensitive' } },
            { subject: { contains: search, mode: 'insensitive' } },
            { party: { name: { contains: search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const rows = await prisma.emailLog.findMany({
    where: whereClause,
    include: { party: true },
    orderBy: { sentAt: 'desc' },
  });
  res.json(rows);
}

export async function getEmailLogStats(req: Request, res: Response) {
  const [total, sent, delivered, opened, failed, bounced] = await Promise.all([
    prisma.emailLog.count(),
    prisma.emailLog.count({ where: { status: 'SENT' } }),
    prisma.emailLog.count({ where: { status: 'DELIVERED' } }),
    prisma.emailLog.count({ where: { status: 'OPENED' } }),
    prisma.emailLog.count({ where: { status: 'FAILED' } }),
    prisma.emailLog.count({ where: { status: 'BOUNCED' } }),
  ]);
  res.json({ total, sent, delivered, opened, failed, bounced });
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
