import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { FACTORY, resolvePlace, kmBetween, ROAD_FACTOR, AVG_LORRY_KMPH } from '../lib/gpsPlaces.js';
import { normaliseVehicleNumber, deriveState, type TrackedState } from '../controllers/gps.controller.js';

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
export const DEFAULT_GATE_RING_KM = 3;

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

export interface InboundArrival {
  bookingId: string;
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
  supplier: string;
  /** Product and tonnage, as the driver brief words it. */
  load: string;
  tonnageKg: number | null;

  /**
   * Whether this lorry is on the GPS feed at all. False is a common case and
   * is not an error - see the file header.
   */
  tracked: boolean;
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

/** A fix older than this says where the lorry WAS, and cannot ring a bell. */
export const ALERT_MAX_FIX_AGE_MINUTES = 30;

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

interface Fix {
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
export async function buildArrivalsBoard(): Promise<{
  rings: ArrivalRings;
  arrivals: InboundArrival[];
}> {
  const [rings, bookings] = await Promise.all([resolveArrivalRings(), liveBookings()]);

  const plates = [...new Set(
    bookings.map((b) => normaliseVehicleNumber(b.lorryNumber ?? '')).filter(Boolean),
  )];

  const [fixes, firedRows] = await Promise.all([
    latestFixes(plates),
    bookings.length
      ? prisma.approachAlert.findMany({
          where: { transportConfirmationId: { in: bookings.map((b) => b.id) } },
          select: { transportConfirmationId: true, ringKm: true },
        })
      : Promise.resolve([] as { transportConfirmationId: string; ringKm: number }[]),
  ]);

  const firedByBooking = new Map<string, number[]>();
  for (const row of firedRows) {
    const list = firedByBooking.get(row.transportConfirmationId) ?? [];
    list.push(row.ringKm);
    firedByBooking.set(row.transportConfirmationId, list);
  }

  const now = Date.now();

  const arrivals: InboundArrival[] = bookings.map((b) => {
    const plate = normaliseVehicleNumber(b.lorryNumber ?? '');
    const fix = plate ? fixes.get(plate) : undefined;
    const kg = b.tonnageKg ?? b.purchaseOrder?.tonnageKg ?? null;

    let distanceKm: number | null = null;
    let etaAt: string | null = null;
    let etaIsEstimate = true;
    let ageMinutes: number | null = null;
    let state: TrackedState = 'NO_SIGNAL';

    if (fix) {
      ageMinutes = Math.max(0, Math.round((now - fix.recordedAt.getTime()) / 60_000));
      state = deriveState(fix.providerStatus, fix.speedKmph, ageMinutes);
      distanceKm = Math.round(
        kmBetween(fix.latitude, fix.longitude, FACTORY.latitude, FACTORY.longitude) * ROAD_FACTOR,
      );
      // Off the long-run average rather than the instantaneous speed, for the
      // same reason the dispatch board does it: a lorry stopped for chai is not
      // going to take forever, and one doing 70 on a bypass will not keep it.
      etaAt = distanceKm > 1
        ? new Date(now + (distanceKm / AVG_LORRY_KMPH) * 3_600_000).toISOString()
        : null;
      etaIsEstimate = false;
    } else {
      // Untracked: the best that can honestly be said is "this far from the
      // loading place at lorry speed, from the day it was booked". Marked an
      // estimate, and absent entirely when the loading place is not in the
      // places table - a made-up ETA is worse than no ETA.
      const origin = resolvePlace(b.fromPlace);
      if (origin) {
        const totalKm = kmBetween(origin.latitude, origin.longitude, FACTORY.latitude, FACTORY.longitude) * ROAD_FACTOR;
        // Lorries run about ten hours a day on these lanes, not twenty-four.
        const days = totalKm / (AVG_LORRY_KMPH * 10);
        etaAt = new Date(b.createdAt.getTime() + days * 24 * 3_600_000).toISOString();
      }
    }

    return {
      bookingId: b.id,
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
      supplier: b.purchaseOrder?.party?.name ?? '-',
      load: loadLabel(kg),
      tonnageKg: kg,
      tracked: Boolean(fix),
      latitude: fix?.latitude ?? null,
      longitude: fix?.longitude ?? null,
      speedKmph: fix?.speedKmph ?? null,
      headingDeg: fix?.headingDeg ?? null,
      address: fix?.address ?? null,
      recordedAt: fix?.recordedAt.toISOString() ?? null,
      ageMinutes,
      state,
      distanceKm,
      etaAt,
      etaIsEstimate,
      phase: phaseOf(distanceKm, rings),
      ringsFired: (firedByBooking.get(b.id) ?? []).sort((a, z) => z - a),
    };
  });

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
    bookingId: string;
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

    for (const ringKm of [rings.approachKm, rings.gateKm]) {
      if (arrival.distanceKm > ringKm) continue;
      if (arrival.ringsFired.includes(ringKm)) continue;

      try {
        await prisma.approachAlert.create({
          data: {
            transportConfirmationId: arrival.bookingId,
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
          `[arrivals] ring ${ringKm}km fired for ${arrival.lorryNumber ?? arrival.bookingId} but the alert failed: ${(err as Error)?.message ?? err}`,
        );
      }

      if (notified > 0) {
        await prisma.approachAlert
          .update({
            where: {
              transportConfirmationId_ringKm: {
                transportConfirmationId: arrival.bookingId,
                ringKm,
              },
            },
            data: { notifiedCount: notified },
          })
          .catch(() => undefined);
      }

      result.fired.push({
        bookingId: arrival.bookingId,
        lorryNumber: arrival.lorryNumber,
        ringKm,
        distanceKm: arrival.distanceKm,
        notified,
      });
      logger.info(
        `[arrivals] ${arrival.lorryNumber ?? arrival.bookingId} crossed the ${ringKm} km ring at ${arrival.distanceKm} km - ${notified} notified`,
      );
    }
  }

  return result;
}
