import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { HttpError } from '../lib/httpError.js';
import { uploadFileToStorage } from '../lib/upload.js';
import { whatsappService } from '../services/whatsapp.service.js';

/**
 * In-app support desk. The reporter presses "Contact support" in the topbar and
 * the client hands us three things it gathered on its own - the route, a PNG of
 * the screen and the browser diagnostics - alongside the one sentence they
 * actually typed.
 *
 * The body arrives as multipart (the screenshot is a file part), so every field
 * is a string on the wire and gets coerced here.
 */
const createTicketSchema = z.object({
  // The reporter is the only one who knows what went wrong; an empty note makes
  // the whole ticket unactionable, so it is the one required field.
  note: z.string().trim().min(1, 'Please describe the issue').max(2000),
  pagePath: z.string().trim().min(1).max(300),
  pageLabel: z.string().trim().min(1).max(120),
  browserInfo: z.string().trim().max(1000).optional(),
  consoleErrors: z.string().trim().max(4000).optional(),
});

export async function createSupportTicket(req: Request, res: Response) {
  const input = createTicketSchema.parse(req.body);
  if (!req.user) throw new HttpError(401, 'Not authenticated');

  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { name: true, role: true },
  });

  // The screenshot is best-effort on both sides: the browser may have failed to
  // capture, and Storage may be unreachable. Neither is a reason to drop a
  // report that a real person is waiting on - upload failures are logged and
  // the ticket continues without the image.
  let screenshotUrl: string | null = null;
  if (req.file) {
    try {
      screenshotUrl = await uploadFileToStorage(req.file);
    } catch (err) {
      logger.error('[support] screenshot upload failed', err);
    }
  }

  const ticket = await prisma.supportTicket.create({
    data: {
      userId: req.user.userId,
      userName: user?.name ?? 'Unknown user',
      userRole: user?.role ?? req.user.role,
      pagePath: input.pagePath,
      pageLabel: input.pageLabel,
      note: input.note,
      screenshotUrl,
      browserInfo: input.browserInfo ?? null,
      consoleErrors: input.consoleErrors ?? null,
    },
  });

  // Awaited, not fired and forgotten: the dialog is still open and the reporter
  // is told whether their issue actually reached a phone or only landed in the
  // support list. A WhatsApp failure must not 500 the request - the ticket is
  // already safely stored - so the outcome is recorded on the row instead.
  let notified: { ok: boolean; skipped?: boolean; error?: string } = { ok: false, error: 'not attempted' };
  try {
    notified = (await whatsappService.notifySupportTicket({
      id: ticket.id,
      userName: ticket.userName,
      userRole: ticket.userRole,
      pageLabel: ticket.pageLabel,
      pagePath: ticket.pagePath,
      note: ticket.note,
      screenshotUrl: ticket.screenshotUrl,
      createdAt: ticket.createdAt,
    })) ?? { ok: false, error: 'No alert recipients configured' };
  } catch (err) {
    notified = { ok: false, error: err instanceof Error ? err.message : String(err) };
    logger.error('[support] WhatsApp notify threw', err);
  }

  const notifiedStatus = notified.ok ? 'SENT' : notified.skipped ? 'SKIPPED' : 'FAILED';
  await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: { notifiedStatus, notifiedError: notified.ok ? null : notified.error ?? null },
  });

  res.status(201).json({
    id: ticket.id,
    screenshotUrl: ticket.screenshotUrl,
    notified: notified.ok,
    notifyError: notified.ok ? undefined : notified.error,
  });
}

const listTicketsSchema = z.object({
  status: z.enum(['OPEN', 'RESOLVED']).optional(),
  take: z.coerce.number().int().positive().max(500).optional().default(100),
});

export async function listSupportTickets(req: Request, res: Response) {
  const { status, take } = listTicketsSchema.parse(req.query);
  const tickets = await prisma.supportTicket.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
    take,
  });
  res.json(tickets);
}

const updateTicketSchema = z.object({ status: z.enum(['OPEN', 'RESOLVED']) });

export async function updateSupportTicket(req: Request, res: Response) {
  const { status } = updateTicketSchema.parse(req.body);
  const ticket = await prisma.supportTicket.update({
    where: { id: req.params.id },
    data: { status, resolvedAt: status === 'RESOLVED' ? new Date() : null },
  });
  res.json(ticket);
}
