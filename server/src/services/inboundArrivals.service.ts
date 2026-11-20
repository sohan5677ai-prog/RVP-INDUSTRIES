import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { FACTORY, resolvePlace, kmBetween, ROAD_FACTOR, AVG_LORRY_KMPH } from '../lib/gpsPlaces.js';
import { normaliseVehicleNumber, deriveState, type TrackedState } from '../controllers/gps.controller.js';
import { istCalendar } from '../lib/istDate.js';

/**
 * Arriving purchase lorries - the inbound mirror of the dispatch board.
 *
 * A transporter is sent a requirement with a `DDMON-NN` code on it; he replies
 * with a lorry number, a driver's phone and that code; parseInboundIntoRegister
 * files the reply against the purchase order the code belongs to. From that
 * moment there is a lorry on its way to the factory that nobody has told the
 * yard about. This file is what tells them.
 *
 * Two things it is built around:
 *
 * 1. **Distance from the factory is the only state that matters.** For an
 *    outbound dispatch the interesting number is progress towards a buyer; for
 *    an arriving lorry it is simply how far out it still is, which the fleet
 *    board already computes for every vehicle it holds a fix for. So there is
 *    no new geometry here - just a reading of kmBetween(FACTORY, fix) against
 *    two configured rings.
 * 2. **Many of these lorries are not tracked at all, and that has to show.**
 *    The provider's feed is one transporter's account. A lorry booked out of
 *    Sahada by a Gujarat transporter simply is not on it, and a confident
 *    "4 km away" computed from a booking time would be a guess wearing the
 *    clothes of a measurement. An untracked arrival is marked untracked and
 *    carries an ETA derived from its loading place, labelled as an estimate.
 */

/* ---------------------------------------------------------------- the rings */

/** Ring defaults, used when CompanyProfile has nothing set. */
export const DEFAULT_APPROACH_RING_KM = 10;
export const DEFAULT_GATE_RING_KM = 2;

export interface ArrivalRings {
  approachKm: number;
  gateKm: number;
  alertsEnabled: boolean;
}

/**
 * The configured rings, clamped into a shape that cannot misfire.
 *
 * The gate ring has to be strictly inside the approach ring: if an admin typed
 * them the other way round, every lorry would cross both on the same fix and
 * the hamali team would be told to stand by at the same moment the kata ticket
 * went up, which defeats the point of having two. Rather than refuse the
 * configuration, the smaller value is taken as the gate.
 */
export async function resolveArrivalRings(): Promise<ArrivalRings> {
  let approach = DEFAULT_APPROACH_RING_KM;
  let gate = DEFAULT_GATE_RING_KM;
  let alertsEnabled = true;
  try {
    const profile = await prisma.companyProfile.findFirst({
      select: {
        inboundApproachRingKm: true,
        inboundGateRingKm: true,
        inboundApproachAlertsEnabled: true,
      },
    });
    if (profile) {
      approach = profile.inboundApproachRingKm;
      gate = profile.inboundGateRingKm;
      alertsEnabled = profile.inboundApproachAlertsEnabled;
    }
  } catch {
    /* DB unreachable - the defaults are honest ones */
  }
  const hi = Math.max(1, Math.max(approach, gate));
  const lo = Math.max(1, Math.min(approach, gate));
  // Equal values would make the gate ring unreachable (the approach ring claims
  // the crossing first), so pull the gate in by one km.
  return { approachKm: hi, gateKm: hi === lo ? Math.max(1, hi - 1) : lo, alertsEnabled };
}

/* --------------------------------------------------------------- the shapes */

/** How close an arriving lorry is, in the words the yard uses. */
export type ArrivalPhase = 'BOOKED' | 'EN_ROUTE' | 'APPROACHING' | 'AT_GATE';

/**
 * Why the lorry is coming.
 *
 * Both kinds are "a lorry on its way to the gate that nobody has told the yard
 * about", which is why they share this board, the rings and the cabin strip.
 * They differ in what happens when it gets here: a PURCHASE lorry arrives
 * loaded and is weighed in, a LOADING lorry arrives empty for a sale load and
 * is weighed for its tare. The kata cabin needs to know which, because the
 * ticket it opens is a different ticket.
 */
export type ArrivalKind = 'PURCHASE' | 'LOADING';

export interface InboundArrival {
  /** Stable row key across both kinds: `tc:<id>` or `slot:<id>`. */
  id: string;
  kind: ArrivalKind;
  /** The register row, when there is one. Null on a slot confirmed by hand. */
  bookingId: string | null;
  /** The loading slot, on a LOADING arrival. */
  slotId: string | null;
  /** The code the transporter was given and quoted back, either side. */
  requirementCode: string | null;
  lorryNumber: string | null;
  driverName: string | null;
  driverPhone: string | null;
  /** Where he loaded, in the transporter's own words ("Sahada-MH"). */
  fromPlace: string | null;
  /** The transporter's WhatsApp number - who to ring when the lorry goes quiet. */
  fromPhone: string;
  bookedAt: string;
  briefSentAt: string | null;

  purchaseOrderId: string | null;
  poNumber: string | null;
  /**
   * Who this lorry concerns: the supplier on a purchase arrival, the buyer on a
   * loading one. One field rather than two because every screen that shows an
   * arrival shows exactly one name next to the plate, and a board with both a
   * supplier and a buyer column, each empty half the time, reads worse.
   */
  counterparty: string;
  /** The transport agency supplying the lorry, where we know it. */
  transportName: string | null;
  /** Where a LOADING lorry is going once it is loaded. Null on a purchase. */
  destination: string | null;
  /** Product and tonnage, as the driver brief words it. */
  load: string;
  /**
   * The commodity in the weighbridge's own vocabulary, so the kata cabin can
   * fill its material box without translating a sale-product enum. Mapped here
   * rather than on the screen because this is where the enum is known.
   */
  kataMaterial: string;
  tonnageKg: number | null;

  /**
   * Whether this lorry is on the GPS feed at all. False is a common case and
   * is not an error - see the file header.
   */
  tracked: boolean;
  /**
   * On the feed, but its last fix is too old to be read as a position. The row
   * carries `ageMinutes` and the coordinates as a last-known, and no distance,
   * ETA or phase. See POSITION_MAX_AGE_MINUTES.
   */
  positionIsStale: boolean;
  /**
   * The day this lorry is due, for a LOADING arrival - the slot's loading date.
   * Null on a purchase arrival, which has no date of its own.
   */
  dueAt: string | null;
  /**
   * The lorry is due (today or overdue) and there is no live position to say
   * where it is. The kata cabin shows these alongside the ones it can see
   * approaching: a lorry booked to load on Wednesday that is standing in the
   * yard on Friday with a dead tracker is exactly the lorry the operator is
   * about to weigh, and leaving it off the strip is what sent him hunting for
   * it by hand.
   */
  awaitingAtMill: boolean;
  latitude: number | null;
  longitude: number | null;
  speedKmph: number | null;
  headingDeg: number | null;
  address: string | null;
  recordedAt: string | null;
  ageMinutes: number | null;
  state: TrackedState;
  /** Road-adjusted km still to run. Null when the lorry is not tracked. */
  distanceKm: number | null;
  /** ISO. From the live fix when tracked, from the loading place when not. */
  etaAt: string | null;
  /** True when etaAt is a guess off the booking rather than a live fix. */
  etaIsEstimate: boolean;
  phase: ArrivalPhase;
  /** Rings already announced for this lorry, for the "told at 10 km" tick. */
  ringsFired: number[];
}

/* --------------------------------------------------------------- the reading */

interface BookingRow {
  id: string;
  requirementCode: string | null;
  lorryNumber: string | null;
  driverName: string | null;
  driverPhone: string | null;
  fromPlace: string | null;
  fromPhone: string;
  tonnageKg: number | null;
  createdAt: Date;
  driverBriefSentAt: Date | null;
  purchaseOrderId: string | null;
  purchaseOrder: {
    poNumber: string | null;
    tonnageKg: number;
    party: { name: string } | null;
  } | null;
}

/** The window a booking stays on the board for. Matches the dispatch side. */
const ARRIVAL_WINDOW_DAYS = 14;

/**
 * How far back and forward a confirmed loading slot counts as "coming".
 *
 * Tighter than the purchase window on purpose. A purchase booking has no date
 * of its own - it is live until its order is stocked in, however long the lorry
 * takes - whereas a loading slot is planned for a day. Three days past that day
 * it is a slot somebody forgot to close, not a lorry at the gate; a week ahead
 * is as far as the yard can usefully look.
 */
const SLOT_WINDOW_BACK_DAYS = 3;
const SLOT_WINDOW_AHEAD_DAYS = 7;

/** A fix older than this says where the lorry WAS, and cannot ring a bell. */
export const ALERT_MAX_FIX_AGE_MINUTES = 30;

/**
 * How old a fix may be and still be read as a position at all.
 *
 * Longer than the alert window on purpose: thirty minutes is the bar for waking
 * the hamali team, but a lorry halted overnight with a four-hour-old fix is
 * still honestly "180 km out", and blanking that would make the board useless
 * every morning. Twelve hours covers a night halt and a long stop.
 *
 * Beyond it the fix is not a position, it is a memory. GJ18BV1872 last reported
 * on 5 Nov and the board drew it at 286 km with a progress bar and an ETA, on a
 * day the lorry was standing in the yard - the device had simply been off for a
 * fortnight. A stale fix therefore yields no distance, no ETA and no phase, and
 * the row shows how long ago it was last seen instead. The same principle the
 * untracked branch below already follows: a guess wearing the clothes of a
 * measurement is worse than admitting there is nothing to measure.
 */
export const POSITION_MAX_AGE_MINUTES = 12 * 60;

/**
 * Bookings that are still lorries on their way here.
 *
 * The lifecycle is the purchase order's, not a status of its own: a PO is
 * PENDING until its lorry is stocked in, at which point it becomes ARRIVED and
 * drops off this list. That is deliberate - an arrivals board with its own
 * "arrived" flag is a second thing to keep in step with the weighbridge, and it
 * is the one that would be forgotten.
 */
async function liveBookings(): Promise<BookingRow[]> {
  return prisma.transportConfirmation.findMany({
    where: {
      direction: 'INBOUND',
      status: { in: ['WAITING', 'CONFIRMED'] },
      purchaseOrderId: { not: null },
      createdAt: { gte: new Date(Date.now() - ARRIVAL_WINDOW_DAYS * 24 * 3_600_000) },
      purchaseOrder: { status: 'PENDING' },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      requirementCode: true,
      lorryNumber: true,
      driverName: true,
      driverPhone: true,
      fromPlace: true,
      fromPhone: true,
      tonnageKg: true,
      createdAt: true,
      driverBriefSentAt: true,
      purchaseOrderId: true,
      purchaseOrder: {
        select: {
          poNumber: true,
          tonnageKg: true,
          party: { select: { name: true } },
        },
      },
    },
  });
}

interface SlotRow {
  id: string;
  code: string;
  date: Date;
  plannedKg: number;
  lorryNumber: string | null;
  driverName: string | null;
  driverPhone: string | null;
  confirmedAt: Date | null;
  createdAt: Date;
  transportConfirmationId: string | null;
  transport: { name: string; phone: string | null } | null;
  saleOrder: {
    product: string;
    destination: string | null;
    buyer: { name: string; city: string | null };
  };
}

/**
 * Confirmed loading slots that are still empty lorries on their way here.
 *
 * `saleDispatchId: null` is the lifecycle, and it is the slot's equivalent of
 * the purchase side reading its order's status: a slot drops off this board the
 * moment it is loaded, because that is the same event the weighbridge records,
 * and an arrivals board with its own "arrived" flag is a second thing to keep
 * in step with the kata.
 *
 * A plate is required. A slot the transporter has not answered yet is a lorry
 * that does not exist, and putting it on a tracking board would invite the yard
 * to wait for it.
 */
async function liveLoadingSlots(): Promise<SlotRow[]> {
  const now = Date.now();
  return prisma.dispatchSlot.findMany({
    where: {
      status: 'CONFIRMED',
      lorryNumber: { not: null },
      saleDispatchId: null,
      date: {
        gte: new Date(now - SLOT_WINDOW_BACK_DAYS * 24 * 3_600_000),
        lte: new Date(now + SLOT_WINDOW_AHEAD_DAYS * 24 * 3_600_000),
      },
    },
    orderBy: { date: 'asc' },
    select: {
      id: true,
      code: true,
      date: true,
      plannedKg: true,
      lorryNumber: true,
      driverName: true,
      driverPhone: true,
      confirmedAt: true,
      createdAt: true,
      transportConfirmationId: true,
      transport: { select: { name: true, phone: true } },
      saleOrder: {
        select: {
          product: true,
          destination: true,
          buyer: { select: { name: true, city: true } },
        },
      },
    },
  });
}

export interface Fix {
  latitude: number;
  longitude: number;
  speedKmph: number | null;
  headingDeg: number | null;
  address: string | null;
  providerStatus: string | null;
  recordedAt: Date;
}

/**
 * The newest stored fix for each of a set of plates.
 *
 * One grouped query to find the winning timestamps, then the rows themselves -
 * the same shape latestPingPerVehicle uses on the fleet board, and for the same
 * reason it was rewritten that way: reading the whole ping history to find a
 * handful of lorries is what made that board slow.
 */
async function latestFixes(plates: string[]): Promise<Map<string, Fix>> {
  const out = new Map<string, Fix>();
  if (plates.length === 0) return out;

  const newest = await prisma.vehiclePing.groupBy({
    by: ['vehicleNumber'],
    where: { vehicleNumber: { in: plates } },
    _max: { recordedAt: true },
  });

  const rows = await Promise.all(
    newest
      .filter((n) => n._max.recordedAt)
      .map((n) =>
        prisma.vehiclePing.findFirst({
          where: { vehicleNumber: n.vehicleNumber, recordedAt: n._max.recordedAt as Date },
          select: {
            vehicleNumber: true, latitude: true, longitude: true, speedKmph: true,
            headingDeg: true, address: true, providerStatus: true, recordedAt: true,
          },
        }),
      ),
  );

  for (const r of rows) {
    if (!r) continue;
    out.set(r.vehicleNumber, {
      latitude: r.latitude,
      longitude: r.longitude,
      speedKmph: r.speedKmph,
      headingDeg: r.headingDeg,
      address: r.address,
      providerStatus: r.providerStatus,
      recordedAt: r.recordedAt,
    });
  }
  return out;
}

/** Product and tonnage in one phrase, worded as the driver brief words it. */
function loadLabel(kg: number | null): string {
  return kg ? `Black seed - ${(kg / 1000).toFixed(2)} MT` : 'Black seed';
}

/**
 * `YYYY-MM-DD` in IST. Render runs UTC, so "is this lorry due today" asked with
 * getDate() would roll over at 5:30 in the morning - half a loading day early.
 */
function istDayKey(date: Date): string {
  const { year, month, day } = istCalendar(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The sale products, in the words the office and the hamali team use. */
const SALE_PRODUCT_LABEL: Record<string, string> = {
  PAPPU: 'Pappu',
  HUSK: 'Husk',
  WASTE: 'Tamarind waste',
  TPS: 'TPS',
  SHELL: 'Shell',
  PRECLEANER_DUST: 'Pre cleaner dust',
  NALLA_POKKULU: 'Nalla pokkulu',
  NALLA_CHINTAPANDU: 'Nalla chintapandu',
};

/**
 * The sale products in the words the weighbridge's material box uses.
 *
 * Deliberately a second map and not a re-use of SALE_PRODUCT_LABEL: those are
 * sentences for people, these are exactly the strings in the cabin's dropdown,
 * and an unlisted value would leave the box empty on a lorry at the gate.
 */
const KATA_MATERIAL: Record<string, string> = {
  PAPPU: 'PAPPU',
  HUSK: 'HUSK',
  WASTE: 'T WASTE',
  TPS: 'TPS BROKENS',
  SHELL: 'T SHELL',
  PRECLEANER_DUST: 'PRE CLEANER DUST',
  NALLA_POKKULU: 'NALLA POKKULU',
  NALLA_CHINTAPANDU: 'NALLA CHINTAPANDU',
};

/** What an empty lorry has come to collect. */
function slotLoadLabel(product: string, kg: number): string {
  const name = SALE_PRODUCT_LABEL[product] ?? product;
  return `${name} - ${(kg / 1000).toFixed(2)} MT`;
}

/**
 * The part of an arrival that comes from a position rather than from paperwork.
 *
 * One function for both kinds, because "how far out is it" must be one piece of
 * arithmetic: the distance the cabin shows, the distance in the WhatsApp and the
 * distance a ring fired on are all read from here.
 */
export function positionOf(
  fix: Fix | undefined,
  fromPlace: string | null,
  bookedAt: Date,
  now: number,
): {
  tracked: boolean;
  positionIsStale: boolean;
  distanceKm: number | null;
  etaAt: string | null;
  etaIsEstimate: boolean;
  ageMinutes: number | null;
  state: TrackedState;
} {
  if (fix) {
    const ageMinutes = Math.max(0, Math.round((now - fix.recordedAt.getTime()) / 60_000));
    // Too old to be a position. `tracked` stays true - the lorry IS on the feed,
    // its device has just gone quiet, which is a different thing from a lorry we
    // never had a fix for and reads differently on screen.
    if (ageMinutes > POSITION_MAX_AGE_MINUTES) {
      return {
        tracked: true,
        positionIsStale: true,
        distanceKm: null,
        etaAt: null,
        etaIsEstimate: true,
        ageMinutes,
        state: deriveState(fix.providerStatus, fix.speedKmph, ageMinutes),
      };
    }
    const distanceKm = Math.round(
      kmBetween(fix.latitude, fix.longitude, FACTORY.latitude, FACTORY.longitude) * ROAD_FACTOR,
    );
    return {
      tracked: true,
      positionIsStale: false,
      distanceKm,
      // Off the long-run average rather than the instantaneous speed, for the
      // same reason the dispatch board does it: a lorry stopped for chai is not
      // going to take forever, and one doing 70 on a bypass will not keep it.
      etaAt:
        distanceKm > 1
          ? new Date(now + (distanceKm / AVG_LORRY_KMPH) * 3_600_000).toISOString()
          : null,
      etaIsEstimate: false,
      ageMinutes,
      state: deriveState(fix.providerStatus, fix.speedKmph, ageMinutes),
    };
  }

  // Untracked: the best that can honestly be said is "this far from the
  // loading place at lorry speed, from the day it was booked". Marked an
  // estimate, and absent entirely when the place is not in the places table -
  // a made-up ETA is worse than no ETA.
  const origin = resolvePlace(fromPlace);
  let etaAt: string | null = null;
  if (origin) {
    const totalKm =
      kmBetween(origin.latitude, origin.longitude, FACTORY.latitude, FACTORY.longitude) * ROAD_FACTOR;
    // Lorries run about ten hours a day on these lanes, not twenty-four.
    const days = totalKm / (AVG_LORRY_KMPH * 10);
    etaAt = new Date(bookedAt.getTime() + days * 24 * 3_600_000).toISOString();
  }
  return {
    tracked: false,
    positionIsStale: false,
    distanceKm: null,
    etaAt,
    etaIsEstimate: true,
    ageMinutes: null,
    state: 'NO_SIGNAL',
  };
}

/**
 * Which ring this lorry is inside.
 *
 * An untracked lorry is BOOKED however long ago it was filed: without a fix
 * there is no honest way to call it approaching, and a board that promises an
 * arrival it cannot see is worse than one that admits it cannot.
 */
export function phaseOf(distanceKm: number | null, rings: ArrivalRings): ArrivalPhase {
  if (distanceKm === null) return 'BOOKED';
  if (distanceKm <= rings.gateKm) return 'AT_GATE';
  if (distanceKm <= rings.approachKm) return 'APPROACHING';
  return 'EN_ROUTE';
}

/**
 * The whole arrivals board: every live booking, with its position if we hold
 * one.
 *
 * Shared by the Upcoming Vehicles tab, the kata cabin's arrivals strip and the
 * ring sweep below, so the distance the cabin shows, the distance in the
 * WhatsApp and the distance a ring fired on are one piece of arithmetic in one
 * place.
 */
/**
 * Just the plates of the lorries this board is watching, for callers that need
 * the set without the board.
 *
 * The Vehicle Tracking board uses it to decide which lorries belong on it at
 * all: ours on a dispatch, plus these on their way in. Everything else pinging
 * our account is somebody else's load and is not the mill's business.
 *
 * Deliberately the same two queries the board itself runs, so a lorry can
 * never be on one and missing from the other.
 */
export async function inboundPlates(): Promise<string[]> {
  const [bookings, slots] = await Promise.all([liveBookings(), liveLoadingSlots()]);
  return [
    ...new Set(
      [...bookings, ...slots]
        .map((row) => normaliseVehicleNumber(row.lorryNumber ?? ''))
        .filter(Boolean),
    ),
  ];
}

export async function buildArrivalsBoard(): Promise<{
  rings: ArrivalRings;
  arrivals: InboundArrival[];
}> {
  const [rings, bookings, slots] = await Promise.all([
    resolveArrivalRings(),
    liveBookings(),
    liveLoadingSlots(),
  ]);

  const plates = [
    ...new Set(
      [...bookings, ...slots]
        .map((row) => normaliseVehicleNumber(row.lorryNumber ?? ''))
        .filter(Boolean),
    ),
  ];

  // A ring is latched against whichever subject owns the arrival: the register
  // row for a purchase lorry, the slot for a loading one. Read in one query per
  // kind and merged into a map keyed by subject id, so the board does not care
  // which column the row came from.
  const [fixes, firedBookings, firedSlots] = await Promise.all([
    latestFixes(plates),
    bookings.length
      ? prisma.approachAlert.findMany({
          where: { transportConfirmationId: { in: bookings.map((b) => b.id) } },
          select: { transportConfirmationId: true, ringKm: true },
        })
      : Promise.resolve([] as { transportConfirmationId: string | null; ringKm: number }[]),
    slots.length
      ? prisma.approachAlert.findMany({
          where: { dispatchSlotId: { in: slots.map((s) => s.id) } },
          select: { dispatchSlotId: true, ringKm: true },
        })
      : Promise.resolve([] as { dispatchSlotId: string | null; ringKm: number }[]),
  ]);

  const firedBySubject = new Map<string, number[]>();
  const noteFired = (subject: string | null, ringKm: number) => {
    if (!subject) return;
    const list = firedBySubject.get(subject) ?? [];
    list.push(ringKm);
    firedBySubject.set(subject, list);
  };
  for (const row of firedBookings) noteFired(row.transportConfirmationId, row.ringKm);
  for (const row of firedSlots) noteFired(row.dispatchSlotId, row.ringKm);

  const now = Date.now();
  const todayKey = istDayKey(new Date(now));

  const fixFor = (lorryNumber: string | null) => {
    const plate = normaliseVehicleNumber(lorryNumber ?? '');
    return plate ? fixes.get(plate) : undefined;
  };

  const purchaseArrivals: InboundArrival[] = bookings.map((b) => {
    const fix = fixFor(b.lorryNumber);
    const kg = b.tonnageKg ?? b.purchaseOrder?.tonnageKg ?? null;
    const pos = positionOf(fix, b.fromPlace, b.createdAt, now);

    return {
      id: `tc:${b.id}`,
      kind: 'PURCHASE',
      bookingId: b.id,
      slotId: null,
      requirementCode: b.requirementCode,
      lorryNumber: b.lorryNumber,
      driverName: b.driverName,
      driverPhone: b.driverPhone,
      fromPlace: b.fromPlace,
      fromPhone: b.fromPhone,
      bookedAt: b.createdAt.toISOString(),
      briefSentAt: b.driverBriefSentAt?.toISOString() ?? null,
      purchaseOrderId: b.purchaseOrderId,
      poNumber: b.purchaseOrder?.poNumber ?? null,
      counterparty: b.purchaseOrder?.party?.name ?? '-',
      transportName: null,
      destination: null,
      // A purchase booking is live until its order is stocked in; there is no
      // day it is "due", so it is never pulled onto the cabin strip this way.
      dueAt: null,
      awaitingAtMill: false,
      load: loadLabel(kg),
      kataMaterial: 'TAMARIND SEED',
      tonnageKg: kg,
      latitude: fix?.latitude ?? null,
      longitude: fix?.longitude ?? null,
      speedKmph: fix?.speedKmph ?? null,
      headingDeg: fix?.headingDeg ?? null,
      address: fix?.address ?? null,
      recordedAt: fix?.recordedAt.toISOString() ?? null,
      ...pos,
      phase: phaseOf(pos.distanceKm, rings),
      ringsFired: (firedBySubject.get(b.id) ?? []).sort((a, z) => z - a),
    };
  });

  const loadingArrivals: InboundArrival[] = slots.map((s) => {
    const fix = fixFor(s.lorryNumber);
    // The slot is the booking date for an estimate: a lorry confirmed for
    // tomorrow's loading is not running towards us today.
    const pos = positionOf(fix, null, s.confirmedAt ?? s.createdAt, now);
    // Due today or overdue, with nothing live to say where it is. A lorry
    // booked for Wednesday standing in the yard on Friday with a dead tracker
    // is exactly the one the kata is about to weigh.
    const awaitingAtMill = pos.distanceKm === null && istDayKey(s.date) <= todayKey;

    return {
      id: `slot:${s.id}`,
      kind: 'LOADING',
      bookingId: s.transportConfirmationId,
      slotId: s.id,
      requirementCode: s.code,
      lorryNumber: s.lorryNumber,
      driverName: s.driverName,
      driverPhone: s.driverPhone,
      fromPlace: null,
      // The agency's own number, not a driver's: when a confirmed lorry goes
      // quiet, the transport office is who you ring.
      fromPhone: s.transport?.phone ?? '-',
      bookedAt: (s.confirmedAt ?? s.createdAt).toISOString(),
      briefSentAt: null,
      purchaseOrderId: null,
      poNumber: null,
      counterparty: s.saleOrder.buyer.name,
      transportName: s.transport?.name ?? null,
      destination: s.saleOrder.destination || s.saleOrder.buyer.city || null,
      dueAt: s.date.toISOString(),
      awaitingAtMill,
      load: slotLoadLabel(s.saleOrder.product, s.plannedKg),
      kataMaterial: KATA_MATERIAL[s.saleOrder.product] ?? 'OTHERS',
      tonnageKg: s.plannedKg,
      latitude: fix?.latitude ?? null,
      longitude: fix?.longitude ?? null,
      speedKmph: fix?.speedKmph ?? null,
      headingDeg: fix?.headingDeg ?? null,
      address: fix?.address ?? null,
      recordedAt: fix?.recordedAt.toISOString() ?? null,
      ...pos,
      phase: phaseOf(pos.distanceKm, rings),
      ringsFired: (firedBySubject.get(s.id) ?? []).sort((a, z) => z - a),
    };
  });

  const arrivals: InboundArrival[] = [...purchaseArrivals, ...loadingArrivals];

  // Closest first, and the untracked ones after everything that has a position:
  // the order someone standing in the cabin wants to read.
  arrivals.sort((a, b) => {
    if ((a.distanceKm === null) !== (b.distanceKm === null)) return a.distanceKm === null ? 1 : -1;
    if (a.distanceKm !== null && b.distanceKm !== null) return a.distanceKm - b.distanceKm;
    return b.bookedAt.localeCompare(a.bookedAt);
  });

  return { rings, arrivals };
}

/* ---------------------------------------------------------------- the alerts */

export interface RingSweepResult {
  checked: number;
  fired: {
    /** The arrival's row key - `tc:<id>` or `slot:<id>`. */
    arrivalId: string;
    kind: ArrivalKind;
    lorryNumber: string | null;
    ringKm: number;
    distanceKm: number;
    notified: number;
  }[];
  skipped?: string;
}

/**
 * Fire any approach ring an arriving lorry has newly crossed.
 *
 * Called from the GPS poll tick rather than a cron of its own: the poll already
 * has fresh positions in hand every 35 to 120 seconds, and a separate schedule
 * would re-read the same table to learn the same thing, at a cadence that could
 * only ever be worse than the data it was reading.
 *
 * The latch is ApproachAlert's unique key, not a check-then-send. Two poll
 * ticks overlapping, or two server instances, would both pass a findFirst guard
 * and both message the team; the second create instead loses to the constraint
 * and sends nothing. So the create comes FIRST and the WhatsApp second - a
 * message that fails to send leaves a latched ring and a row recording that
 * nobody was notified, which the register's manual button can act on. The other
 * order risks the same lorry being announced twice, and a yard that is told
 * twice stops reading the alerts at all.
 *
 * Inward crossings only, and every ring at or outside the lorry's current
 * distance fires together: a lorry first seen at 2 km - booked late, or its
 * device woke up near the factory - has crossed the ten km ring too, and the
 * team still needs to know it is here.
 */
export async function sweepApproachRings(): Promise<RingSweepResult> {
  const { rings, arrivals } = await buildArrivalsBoard();
  const result: RingSweepResult = { checked: arrivals.length, fired: [] };

  if (!rings.alertsEnabled) {
    return { ...result, skipped: 'Approach alerts are switched off in Settings' };
  }

  // Imported at call time: the notifier reaches into whatsapp.service, which
  // pulls in a good deal of the app, and this runs on every poll tick whether
  // or not a lorry is anywhere near.
  const { notifyInboundApproach } = await import('./inboundApproachNotify.service.js');

  for (const arrival of arrivals) {
    if (arrival.distanceKm === null) continue;
    // A stale fix says where the lorry WAS. Announcing an arrival off it would
    // put the team at the gate for a lorry still three districts away.
    if (arrival.ageMinutes === null || arrival.ageMinutes > ALERT_MAX_FIX_AGE_MINUTES) continue;

    // Whichever of the two columns owns this arrival. A loading lorry latches
    // on its slot even when a register row exists behind it: the slot is what
    // survives an office edit to the booking, and it is the one key the kata
    // cabin and the calendar both already hold.
    const latch =
      arrival.kind === 'LOADING'
        ? { dispatchSlotId: arrival.slotId }
        : { transportConfirmationId: arrival.bookingId };
    if (arrival.kind === 'LOADING' ? !arrival.slotId : !arrival.bookingId) continue;

    for (const ringKm of [rings.approachKm, rings.gateKm]) {
      if (arrival.distanceKm > ringKm) continue;
      if (arrival.ringsFired.includes(ringKm)) continue;

      try {
        await prisma.approachAlert.create({
          data: {
            ...latch,
            ringKm,
            distanceKm: arrival.distanceKm,
          },
        });
      } catch {
        // Lost the race, or already latched. Either way this ring is not ours
        // to announce.
        continue;
      }

      let notified = 0;
      try {
        notified = await notifyInboundApproach(arrival, ringKm, rings);
      } catch (err) {
        logger.warn(
          `[arrivals] ring ${ringKm}km fired for ${arrival.lorryNumber ?? arrival.id} but the alert failed: ${(err as Error)?.message ?? err}`,
        );
      }

      if (notified > 0) {
        await prisma.approachAlert
          .updateMany({
            // By the two latch columns rather than a compound where: which of
            // them is set depends on the kind, and `updateMany` takes the same
            // filter shape for either. There is exactly one matching row - the
            // unique keys guarantee it.
            where: { ...latch, ringKm },
            data: { notifiedCount: notified },
          })
          .catch(() => undefined);
      }

      result.fired.push({
        arrivalId: arrival.id,
        kind: arrival.kind,
        lorryNumber: arrival.lorryNumber,
        ringKm,
        distanceKm: arrival.distanceKm,
        notified,
      });
      logger.info(
        `[arrivals] ${arrival.lorryNumber ?? arrival.id} crossed the ${ringKm} km ring at ${arrival.distanceKm} km - ${notified} notified`,
      );
    }
  }

  return result;
}
