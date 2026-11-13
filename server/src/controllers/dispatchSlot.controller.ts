import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import {
  ACTIVE_SLOT_STATUSES,
  LOADING_POINTS,
  SLOT_INCLUDE,
  buildBacklog,
  buildIndentMessage,
  createSlot,
  nextSeqForDate,
  parseSlotDate,
  slotCode,
  serializeSlot,
  validateSlot,
} from '../services/dispatchSlot.service.js';

/**
 * The loading calendar's API.
 *
 * Reads are a date range (the week on screen) plus the backlog of unplanned
 * tonnage; writes are the small set of things the office does to a plan -
 * create a lorry, move it to another day, confirm its number, cancel it - and
 * the day-indent that goes to the transporter.
 */

const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const listSchema = z.object({ from: dayString, to: dayString });

const slotBodySchema = z.object({
  saleOrderId: z.string().min(1),
  date: dayString,
  vehicleClassKg: z.coerce.number().int().positive().max(100_000),
  plannedKg: z.coerce.number().int().positive().max(100_000),
  loadingPoint: z.enum(LOADING_POINTS as [string, ...string[]]).default('RVP'),
  transportId: z.string().min(1).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

const updateSchema = slotBodySchema.partial().extend({ saleOrderId: z.string().min(1).optional() });

const confirmSchema = z.object({
  lorryNumber: z.string().trim().min(4).max(20),
  driverName: z.string().trim().max(80).nullable().optional(),
  driverPhone: z.string().trim().max(20).nullable().optional(),
});

const indentSchema = z.object({ date: dayString, transportId: z.string().min(1) });

export async function listDispatchSlots(req: Request, res: Response) {
  const { from, to } = listSchema.parse(req.query);
  const fromDate = parseSlotDate(from);
  const toDate = parseSlotDate(to);
  if (toDate < fromDate) throw new HttpError(400, '"to" cannot be before "from"');

  const slots = await prisma.dispatchSlot.findMany({
    // The range is inclusive of `to`: both ends are IST midnights, and the
    // caller means "this week", not "up to but excluding Sunday".
    where: { date: { gte: fromDate, lte: toDate }, status: { not: 'CANCELLED' } },
    orderBy: [{ date: 'asc' }, { seq: 'asc' }],
    include: SLOT_INCLUDE,
  });
  res.json(slots.map(serializeSlot));
}

/** Orders with tonnage still to ship, split into shipped / planned / unplanned. */
export async function listDispatchBacklog(_req: Request, res: Response) {
  res.json(await buildBacklog());
}

export async function createDispatchSlot(req: Request, res: Response) {
  const body = slotBodySchema.parse(req.body);
  const input = {
    saleOrderId: body.saleOrderId,
    date: parseSlotDate(body.date),
    vehicleClassKg: body.vehicleClassKg,
    plannedKg: body.plannedKg,
    loadingPoint: body.loadingPoint,
    transportId: body.transportId ?? null,
    notes: body.notes ?? null,
  };
  await validateSlot(input);
  const slot = await createSlot(input);
  res.status(201).json(serializeSlot(slot));
}

export async function updateDispatchSlot(req: Request, res: Response) {
  const body = updateSchema.parse(req.body);
  const existing = await prisma.dispatchSlot.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new HttpError(404, 'Slot not found');
  if (existing.status === 'LOADED') throw new HttpError(400, 'That lorry has already loaded');
  if (existing.status === 'CANCELLED') throw new HttpError(400, 'That slot is cancelled');

  const next = {
    saleOrderId: body.saleOrderId ?? existing.saleOrderId,
    date: body.date ? parseSlotDate(body.date) : existing.date,
    vehicleClassKg: body.vehicleClassKg ?? existing.vehicleClassKg,
    plannedKg: body.plannedKg ?? existing.plannedKg,
    loadingPoint: body.loadingPoint ?? existing.loadingPoint,
    transportId: body.transportId === undefined ? existing.transportId : body.transportId,
    notes: body.notes === undefined ? existing.notes : body.notes,
  };
  await validateSlot(next, existing.id);

  // Moving a lorry to another day re-numbers it.
  //
  // The code carries its loading day, so a 12NOV-01 parked on the 13th would
  // be a lie to the one person the code exists for. It also has to move: the
  // sequence is unique per date, so keeping seq 1 while landing on a day that
  // already has a seq 1 is a constraint violation, not a cosmetic problem.
  // The old number is retired rather than reused - the transporter may already
  // have it on his phone - and a moved slot that had been asked for drops back
  // to PLANNED, so the day's indent is sent again and he learns of the change.
  const dateChanged = next.date.getTime() !== existing.date.getTime();

  const slot = await (async () => {
    if (!dateChanged) {
      return prisma.dispatchSlot.update({ where: { id: existing.id }, data: next, include: SLOT_INCLUDE });
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const seq = await nextSeqForDate(next.date);
      try {
        return await prisma.dispatchSlot.update({
          where: { id: existing.id },
          data: {
            ...next,
            seq,
            code: slotCode(next.date, seq),
            ...(existing.status === 'REQUESTED' ? { status: 'PLANNED' as const, requestedAt: null } : {}),
          },
          include: SLOT_INCLUDE,
        });
      } catch (err) {
        if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') continue;
        throw err;
      }
    }
    throw new HttpError(409, 'Could not allocate a slot number on that date - please try again');
  })();

  res.json(serializeSlot(slot));
}

/**
 * Cancel, not delete.
 *
 * A slot that was only ever planned here can go for good - nobody outside has
 * seen it. Once it has been sent to a transporter its number is public, so it
 * is marked CANCELLED and keeps its place in the day's sequence; the next
 * lorry gets a fresh number rather than inheriting one he already has against
 * different instructions.
 */
export async function deleteDispatchSlot(req: Request, res: Response) {
  const existing = await prisma.dispatchSlot.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new HttpError(404, 'Slot not found');
  if (existing.status === 'LOADED') throw new HttpError(400, 'That lorry has already loaded');

  if (existing.status === 'PLANNED') {
    await prisma.dispatchSlot.delete({ where: { id: existing.id } });
    res.json({ ok: true, deleted: true });
    return;
  }
  await prisma.dispatchSlot.update({
    where: { id: existing.id },
    data: { status: 'CANCELLED', lorryNumber: null, driverName: null, driverPhone: null, confirmedAt: null },
  });
  res.json({ ok: true, deleted: false });
}

/** Record the lorry the transporter gave against this slot. */
export async function confirmDispatchSlot(req: Request, res: Response) {
  const body = confirmSchema.parse(req.body);
  const existing = await prisma.dispatchSlot.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new HttpError(404, 'Slot not found');
  if (existing.status === 'LOADED') throw new HttpError(400, 'That lorry has already loaded');
  if (existing.status === 'CANCELLED') throw new HttpError(400, 'That slot is cancelled');

  // Normalised the same way the WhatsApp booking register stores lorry numbers,
  // so "AP 39 T 8217" and "AP39T8217" are the same lorry to both.
  const lorryNumber = body.lorryNumber.toUpperCase().replace(/[\s-]/g, '');

  const slot = await prisma.dispatchSlot.update({
    where: { id: existing.id },
    data: {
      lorryNumber,
      driverName: body.driverName ?? null,
      driverPhone: body.driverPhone ?? null,
      status: 'CONFIRMED',
      confirmedAt: new Date(),
    },
    include: SLOT_INCLUDE,
  });
  res.json(serializeSlot(slot));
}

/** Undo a confirmation - the lorry fell through, the slot is open again. */
export async function unconfirmDispatchSlot(req: Request, res: Response) {
  const existing = await prisma.dispatchSlot.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new HttpError(404, 'Slot not found');
  if (existing.status === 'LOADED') throw new HttpError(400, 'That lorry has already loaded');

  const slot = await prisma.dispatchSlot.update({
    where: { id: existing.id },
    data: {
      lorryNumber: null,
      driverName: null,
      driverPhone: null,
      confirmedAt: null,
      status: existing.requestedAt ? 'REQUESTED' : 'PLANNED',
    },
    include: SLOT_INCLUDE,
  });
  res.json(serializeSlot(slot));
}

async function indentContext(date: string, transportId: string) {
  const day = parseSlotDate(date);
  const transport = await prisma.transport.findUnique({ where: { id: transportId } });
  if (!transport) throw new HttpError(404, 'Transporter not found');

  const slots = await prisma.dispatchSlot.findMany({
    where: { date: day, transportId, status: { in: ACTIVE_SLOT_STATUSES } },
    orderBy: { seq: 'asc' },
    include: SLOT_INCLUDE,
  });
  return { day, transport, slots };
}

/**
 * Preview the message without touching anything - what the office reads before
 * pressing send.
 */
export async function previewDispatchIndent(req: Request, res: Response) {
  const { date, transportId } = indentSchema.parse(req.query);
  const { day, transport, slots } = await indentContext(date, transportId);
  if (slots.length === 0) throw new HttpError(400, `No lorries planned for ${transport.name} on that date`);

  const revision = slots.some((s) => s.requestedAt != null);
  res.json({
    transport: { id: transport.id, name: transport.name, phone: transport.phone, phone2: transport.phone2 },
    date,
    revision,
    slotCount: slots.length,
    totalKg: slots.reduce((s, x) => s + x.plannedKg, 0),
    message: buildIndentMessage({ transportName: transport.name, date: day, slots, revision }),
  });
}

/**
 * Mark the day's slots as asked for.
 *
 * The message itself goes out of the user's own WhatsApp (a `wa.me` link the
 * client opens with this text pre-filled), because the approved template for a
 * vehicle requirement is not live yet - see docs/whatsapp-vehicle-indent-template.md.
 * Recording the request here regardless is what makes "asked but not yet
 * confirmed" a state the calendar can show and chase.
 */
export async function sendDispatchIndent(req: Request, res: Response) {
  const { date, transportId } = indentSchema.parse(req.body);
  const { day, transport, slots } = await indentContext(date, transportId);
  if (slots.length === 0) throw new HttpError(400, `No lorries planned for ${transport.name} on that date`);

  const revision = slots.some((s) => s.requestedAt != null);
  const message = buildIndentMessage({ transportName: transport.name, date: day, slots, revision });

  // Only the ones not yet asked for move to REQUESTED; a slot already
  // confirmed with a lorry number stays confirmed even though it appears in a
  // revised message for context.
  const now = new Date();
  await prisma.dispatchSlot.updateMany({
    where: { id: { in: slots.filter((s) => s.status === 'PLANNED').map((s) => s.id) } },
    data: { status: 'REQUESTED', requestedAt: now },
  });

  res.json({
    ok: true,
    requestedCount: slots.filter((s) => s.status === 'PLANNED').length,
    message,
    transport: { id: transport.id, name: transport.name, phone: transport.phone, phone2: transport.phone2 },
  });
}
