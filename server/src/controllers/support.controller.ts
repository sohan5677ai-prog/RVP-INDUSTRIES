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

/** Reading someone else's ticket in full - screenshot and diagnostics - stays an
 *  admin job. Everyone else opens the page only to acknowledge replies. */
const SEES_EVERYTHING = new Set(['ADMIN', 'DEVELOPER']);

export async function listSupportTickets(req: Request, res: Response) {
  const { status, take } = listTicketsSchema.parse(req.query);
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  const viewerId = req.user.userId;
  const privileged = SEES_EVERYTHING.has(req.user.role);

  // A plain user sees their own reports plus every answered ticket - the same
  // set the login popup announces to them, so the "Checked" button on this page
  // can clear anything the popup could have raised.
  const visibility = privileged
    ? {}
    : { OR: [{ userId: viewerId }, { status: 'RESOLVED' as const, developerMessage: { not: null } }] };

  const tickets = await prisma.supportTicket.findMany({
    where: { ...visibility, ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    take,
    include: { acks: { where: { userId: viewerId }, select: { createdAt: true } } },
  });

  res.json(tickets.map((t) => shapeForViewer(t, viewerId, privileged)));
}

/**
 * Collapses the viewer's own ack into a boolean, and withholds the evidence on
 * other people's tickets from non-admins: a screen capture and a console dump
 * can carry anything that was on a colleague's screen, and none of it is needed
 * to read a reply and tick it off.
 */
function shapeForViewer<T extends { userId: string | null; acks: { createdAt: Date }[] }>(
  ticket: T,
  viewerId: string,
  privileged: boolean,
) {
  const { acks, ...rest } = ticket;
  const own = ticket.userId === viewerId;
  return {
    ...rest,
    ...(privileged || own ? {} : { screenshotUrl: null, browserInfo: null, consoleErrors: null }),
    acknowledged: acks.length > 0,
    acknowledgedAt: acks[0]?.createdAt ?? null,
  };
}

/**
 * Closing a ticket is a developer-only act, and it cannot be done silently: the
 * message written here is what every user and admin is shown on their next
 * login, so a resolve with nothing to say would raise an empty popup.
 *
 * Reopening clears the message and every acknowledgement with it - the ticket is
 * unanswered again, and whatever reply gets written next has to be read afresh.
 */
const updateTicketSchema = z
  .object({
    status: z.enum(['OPEN', 'RESOLVED']),
    developerMessage: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.status !== 'RESOLVED' || !!v.developerMessage, {
    message: 'Write a message for the team before resolving this ticket',
    path: ['developerMessage'],
  });

export async function updateSupportTicket(req: Request, res: Response) {
  const { status, developerMessage } = updateTicketSchema.parse(req.body);
  if (!req.user) throw new HttpError(401, 'Not authenticated');

  const resolver =
    status === 'RESOLVED'
      ? await prisma.user.findUnique({ where: { id: req.user.userId }, select: { name: true } })
      : null;

  const ticket = await prisma.$transaction(async (tx) => {
    if (status === 'OPEN') {
      await tx.supportTicketAck.deleteMany({ where: { ticketId: req.params.id } });
    }
    return tx.supportTicket.update({
      where: { id: req.params.id },
      data:
        status === 'RESOLVED'
          ? {
              status,
              resolvedAt: new Date(),
              developerMessage: developerMessage!,
              resolvedById: req.user!.userId,
              resolvedByName: resolver?.name ?? 'Developer',
            }
          : { status, resolvedAt: null, developerMessage: null, resolvedById: null, resolvedByName: null },
    });
  });

  res.json(ticket);
}

/**
 * The login announcement: answered tickets this person has not ticked off yet.
 *
 * The developer is left out - they wrote the replies. Everyone else sees every
 * answered ticket, reporter's name included, because a fix that lands on one
 * person's screen usually explains what the rest of the office saw too.
 */
export async function listSupportAnnouncements(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  if (req.user.role === 'DEVELOPER') return res.json([]);

  const tickets = await prisma.supportTicket.findMany({
    where: {
      status: 'RESOLVED',
      developerMessage: { not: null },
      acks: { none: { userId: req.user.userId } },
    },
    orderBy: { resolvedAt: 'desc' },
    take: 20,
    select: {
      id: true,
      userName: true,
      pageLabel: true,
      note: true,
      developerMessage: true,
      resolvedByName: true,
      resolvedAt: true,
    },
  });

  res.json(tickets);
}

/** "Yes, checked". Idempotent, so a second press (page and popup both offer it)
 *  is not an error. */
export async function acknowledgeSupportTicket(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: req.params.id },
    select: { status: true, developerMessage: true },
  });
  if (!ticket) throw new HttpError(404, 'Ticket not found');
  if (ticket.status !== 'RESOLVED' || !ticket.developerMessage) {
    throw new HttpError(400, 'This ticket has no developer message to acknowledge yet');
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { name: true },
  });

  const ack = await prisma.supportTicketAck.upsert({
    where: { ticketId_userId: { ticketId: req.params.id, userId: req.user.userId } },
    create: {
      ticketId: req.params.id,
      userId: req.user.userId,
      userName: user?.name ?? 'Unknown user',
    },
    update: {},
  });

  res.json({ acknowledged: true, acknowledgedAt: ack.createdAt });
}
