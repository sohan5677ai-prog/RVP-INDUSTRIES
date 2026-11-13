import type { Prisma, DispatchSlotStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { istCalendar, istMidnight } from '../lib/istDate.js';

/**
 * The loading calendar's engine: slot codes, the planning arithmetic, and the
 * day-indent message.
 *
 * Planning is done in *slots* (one lorry on one day), never in orders, because
 * an order is routinely shipped across several days and the thing the office
 * and the transporter both care about is "which lorries on which date". The
 * reverse pairing never occurs - a lorry carries one buyer's goods only - so a
 * slot names exactly one SaleOrder and everything else (buyer, destination,
 * product) is derived from it.
 */

/** Statuses that still occupy tonnage on an order's plan. */
export const ACTIVE_SLOT_STATUSES: DispatchSlotStatus[] = ['PLANNED', 'REQUESTED', 'CONFIRMED'];

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** The vehicle classes the yard actually books. A custom size is still allowed. */
export const VEHICLE_CLASSES_KG = [25_000, 30_000, 35_000, 40_000];

/** Loading points, matching the stock vocabulary used elsewhere. */
export const LOADING_POINTS = ['RVP', 'KNM'];

/**
 * `16NOV-03`. The day is in the code so the transporter can read it at a
 * glance, and the two-digit tail is what he quotes back ("03 - AP39T8217"),
 * which is what lets a reply be matched to one slot instead of guessed at.
 */
export function slotCode(date: Date, seq: number): string {
  const { month, day } = istCalendar(date);
  return `${String(day).padStart(2, '0')}${MONTHS[month - 1]}-${String(seq).padStart(2, '0')}`;
}

/** Parse a `YYYY-MM-DD` day into the IST midnight instant slots are stored at. */
export function parseSlotDate(input: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!m) throw new HttpError(400, `Invalid date "${input}" - expected YYYY-MM-DD`);
  const [, y, mo, d] = m;
  const date = istMidnight(Number(y), Number(mo), Number(d));
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `Invalid date "${input}"`);
  return date;
}

/** `YYYY-MM-DD` in IST, for grouping slots into day columns on the client. */
export function slotDateKey(date: Date): string {
  const { year, month, day } = istCalendar(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const fmtTonnes = (kg: number) => {
  const t = kg / 1000;
  return Number.isInteger(t) ? `${t} t` : `${t.toFixed(2).replace(/0$/, '')} t`;
};

/**
 * How much of an order is already spoken for by live slots.
 *
 * LOADED slots are excluded deliberately: once a slot loads it has become a
 * SaleDispatch, so its tonnage is already inside `dispatchedKg`. Counting it
 * here as well would make a fully shipped order look over-planned and block
 * the last lorry of the next one.
 */
export async function plannedKgForOrder(saleOrderId: string, excludeSlotId?: string): Promise<number> {
  const agg = await prisma.dispatchSlot.aggregate({
    where: {
      saleOrderId,
      status: { in: ACTIVE_SLOT_STATUSES },
      ...(excludeSlotId ? { id: { not: excludeSlotId } } : {}),
    },
    _sum: { plannedKg: true },
  });
  return agg._sum.plannedKg ?? 0;
}

export interface SlotInput {
  saleOrderId: string;
  date: Date;
  vehicleClassKg: number;
  plannedKg: number;
  loadingPoint: string;
  transportId: string | null;
  notes: string | null;
}

/**
 * Everything that must hold before a slot is written, checked in one place so
 * create and edit cannot drift apart.
 *
 * Two rules, both cheap and both worth enforcing in the database rather than
 * the UI: a lorry cannot be loaded past its own size, and an order cannot have
 * more tonnage planned than it still has left to ship. The second is the one
 * that actually protects you - it is what stops the same 100 t being promised
 * on the 16th and again on the 18th.
 */
export async function validateSlot(input: SlotInput, excludeSlotId?: string) {
  if (input.plannedKg <= 0) throw new HttpError(400, 'Planned weight must be greater than zero');
  if (input.vehicleClassKg <= 0) throw new HttpError(400, 'Vehicle size must be greater than zero');
  if (input.plannedKg > input.vehicleClassKg) {
    throw new HttpError(
      400,
      `${fmtTonnes(input.plannedKg)} will not fit a ${fmtTonnes(input.vehicleClassKg)} lorry`
    );
  }
  if (!LOADING_POINTS.includes(input.loadingPoint)) {
    throw new HttpError(400, `Unknown loading point "${input.loadingPoint}"`);
  }

  const order = await prisma.saleOrder.findUnique({
    where: { id: input.saleOrderId },
    select: {
      id: true,
      tonnageKg: true,
      closedAt: true,
      buyer: { select: { name: true } },
      dispatches: { select: { weightKg: true } },
    },
  });
  if (!order) throw new HttpError(404, 'Sale order not found');
  if (order.closedAt) throw new HttpError(400, 'That sale order is closed');

  const dispatchedKg = order.dispatches.reduce((s, d) => s + d.weightKg, 0);
  const remainingKg = Math.max(0, order.tonnageKg - dispatchedKg);
  const alreadyPlanned = await plannedKgForOrder(order.id, excludeSlotId);
  const unplannedKg = remainingKg - alreadyPlanned;

  if (input.plannedKg > unplannedKg) {
    throw new HttpError(
      400,
      unplannedKg <= 0
        ? `The order for ${order.buyer.name} is already fully planned`
        : `Only ${fmtTonnes(unplannedKg)} of the order for ${order.buyer.name} is still unplanned`
    );
  }

  if (input.transportId) {
    const transport = await prisma.transport.findUnique({ where: { id: input.transportId }, select: { id: true } });
    if (!transport) throw new HttpError(404, 'Transporter not found');
  }
}

/**
 * Allocate the next code for a date and create the slot.
 *
 * The sequence is taken from the highest `seq` on that date rather than a
 * count, so a cancelled slot never hands its number to a new lorry - the
 * transporter has already seen `16NOV-03` on WhatsApp and must never be sent a
 * different `16NOV-03` later. `@@unique([date, seq])` makes the race safe; a
 * collision under concurrency simply retries with the next number.
 */
export async function nextSeqForDate(date: Date): Promise<number> {
  const last = await prisma.dispatchSlot.findFirst({
    where: { date },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });
  return (last?.seq ?? 0) + 1;
}

export async function createSlot(input: SlotInput) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const seq = await nextSeqForDate(input.date);
    try {
      return await prisma.dispatchSlot.create({
        data: {
          code: slotCode(input.date, seq),
          date: input.date,
          seq,
          vehicleClassKg: input.vehicleClassKg,
          plannedKg: input.plannedKg,
          loadingPoint: input.loadingPoint,
          saleOrderId: input.saleOrderId,
          transportId: input.transportId,
          notes: input.notes,
        },
        include: SLOT_INCLUDE,
      });
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      throw err;
    }
  }
  throw new HttpError(409, 'Could not allocate a slot number for that date - please try again');
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

export const SLOT_INCLUDE = {
  saleOrder: {
    select: {
      id: true,
      product: true,
      tonnageKg: true,
      destination: true,
      saleDate: true,
      reminderDate: true,
      closedAt: true,
      buyer: { select: { id: true, name: true, city: true } },
      dispatches: { select: { weightKg: true } },
    },
  },
  transport: { select: { id: true, name: true, phone: true, phone2: true } },
} satisfies Prisma.DispatchSlotInclude;

export type SlotWithOrder = Prisma.DispatchSlotGetPayload<{ include: typeof SLOT_INCLUDE }>;

/** Shape the client reads: the slot plus the few order facts its card shows. */
export function serializeSlot(slot: SlotWithOrder) {
  const { saleOrder, ...rest } = slot;
  const dispatchedKg = saleOrder.dispatches.reduce((s, d) => s + d.weightKg, 0);
  return {
    ...rest,
    dateKey: slotDateKey(slot.date),
    saleOrder: {
      id: saleOrder.id,
      product: saleOrder.product,
      buyerId: saleOrder.buyer.id,
      buyerName: saleOrder.buyer.name,
      destination: saleOrder.destination || saleOrder.buyer.city || null,
      tonnageKg: saleOrder.tonnageKg,
      dispatchedKg,
      remainingKg: Math.max(0, saleOrder.tonnageKg - dispatchedKg),
      reminderDate: saleOrder.reminderDate,
    },
  };
}

/**
 * The orders the calendar plans against: everything still owed to a buyer,
 * with its tonnage split three ways - shipped, planned on the calendar, and
 * the unplanned remainder. That last figure is the whole point of the page:
 * tonnage you have sold and not yet put a lorry behind.
 */
export async function buildBacklog() {
  const orders = await prisma.saleOrder.findMany({
    where: { status: { in: ['PENDING', 'PARTIAL'] }, closedAt: null },
    orderBy: [{ reminderDate: 'asc' }, { saleDate: 'asc' }],
    select: {
      id: true,
      saleDate: true,
      product: true,
      tonnageKg: true,
      destination: true,
      reminderDate: true,
      dueDays: true,
      buyer: { select: { id: true, name: true, city: true } },
      dispatches: { select: { weightKg: true } },
      dispatchSlots: {
        where: { status: { in: ACTIVE_SLOT_STATUSES } },
        select: { plannedKg: true },
      },
    },
  });

  return orders
    .map((o) => {
      const dispatchedKg = o.dispatches.reduce((s, d) => s + d.weightKg, 0);
      const remainingKg = Math.max(0, o.tonnageKg - dispatchedKg);
      const plannedKg = o.dispatchSlots.reduce((s, d) => s + d.plannedKg, 0);
      return {
        id: o.id,
        saleDate: o.saleDate,
        product: o.product,
        buyerId: o.buyer.id,
        buyerName: o.buyer.name,
        destination: o.destination || o.buyer.city || null,
        reminderDate: o.reminderDate,
        tonnageKg: o.tonnageKg,
        dispatchedKg,
        remainingKg,
        plannedKg,
        unplannedKg: Math.max(0, remainingKg - plannedKg),
      };
    })
    .filter((o) => o.remainingKg > 0);
}

/**
 * The day-indent: one message per transporter per date, listing his slots by
 * code.
 *
 * Per transporter per *day* rather than per order, because that is how a
 * transport office plans - by tomorrow's fleet, not by our paperwork. An order
 * spread over three dates therefore appears in three different messages, each
 * alongside whatever else loads that day, which is exactly what he needs in
 * order to send the right lorries.
 */
export function buildIndentMessage(args: {
  companyName: string;
  transportName: string;
  date: Date;
  slots: SlotWithOrder[];
  revision: boolean;
}): string {
  const { month, day } = istCalendar(args.date);
  const weekday = args.date.toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'Asia/Kolkata' });
  const dateLabel = `${String(day).padStart(2, '0')}-${MONTHS[month - 1]} (${weekday})`;

  const byPoint = new Map<string, SlotWithOrder[]>();
  for (const slot of args.slots) {
    const list = byPoint.get(slot.loadingPoint) ?? [];
    list.push(slot);
    byPoint.set(slot.loadingPoint, list);
  }

  const lines: string[] = [];
  lines.push(`*${args.companyName} - Vehicle Requirement*`);
  lines.push(args.revision ? `${dateLabel} (REVISED)` : dateLabel);
  lines.push('');

  for (const [point, slots] of byPoint) {
    if (byPoint.size > 1) lines.push(`Loading at ${point}:`);
    for (const slot of slots) {
      const dest = slot.saleOrder.destination || slot.saleOrder.buyer.city || '-';
      const confirmed = slot.lorryNumber ? `  [${slot.lorryNumber}]` : '';
      lines.push(
        `${slot.code} - ${fmtTonnes(slot.vehicleClassKg)} to ${dest}${confirmed}`
      );
    }
    if (byPoint.size > 1) lines.push('');
  }

  const totalKg = args.slots.reduce((s, x) => s + x.plannedKg, 0);
  if (lines[lines.length - 1] !== '') lines.push('');
  lines.push(`Total: ${args.slots.length} ${args.slots.length === 1 ? 'lorry' : 'lorries'} · ${fmtTonnes(totalKg)}`);
  lines.push('');
  lines.push('Please reply with the lorry number and driver details against each code.');

  return lines.join('\n');
}
