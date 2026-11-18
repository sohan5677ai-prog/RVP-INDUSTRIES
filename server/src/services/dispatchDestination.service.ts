import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { FACTORY } from '../lib/gpsPlaces.js';
import { resolveDestination, checkPin } from '../lib/destinationPin.js';
import { getLane } from './route.service.js';

/**
 * Stamp a dispatch with where it was going and how far that is.
 *
 * Runs AFTER the dispatch transaction has committed, never inside it. Measuring
 * a lane can mean a call to a routing provider with a twelve-second ceiling,
 * and holding a database transaction open across someone else's HTTP request is
 * how a busy afternoon turns into lock contention on the sale tables.
 *
 * Fire-and-forget, therefore, and safe to lose: when the stamp does not happen,
 * `destinationOf` in gps.controller resolves the pin live from the order and the
 * buyer instead. The snapshot is an optimisation plus a historical record, not
 * the only path to a distance.
 *
 * It is a record, though, and that is the point of storing it at all. Freight is
 * argued per tonne by destination, so the distance behind a settled trip has to
 * be the distance that was true when the lorry left - not whatever the buyer's
 * pin says six months later. Same reasoning as the cost-freeze columns on
 * SaleOrder.
 */
export async function snapshotDispatchDestination(dispatchId: string): Promise<void> {
  try {
    const dispatch = await prisma.saleDispatch.findUnique({
      where: { id: dispatchId },
      select: {
        id: true,
        destLat: true,
        saleOrder: {
          select: {
            destination: true,
            buyerLocationLink: true,
            buyerAddressId: true,
            buyer: { select: { name: true, pinLat: true, pinLng: true, pinSource: true } },
          },
        },
      },
    });
    if (!dispatch) return;
    // Already stamped - a re-run must not move a settled trip's distance.
    if (dispatch.destLat !== null) return;

    // The branch address the order was placed against, when there was one. Read
    // separately rather than through a relation so this works whether or not
    // buyerAddressId points at a row that still exists.
    const address = dispatch.saleOrder.buyerAddressId
      ? await prisma.partyAddress.findUnique({
          where: { id: dispatch.saleOrder.buyerAddressId },
          select: { pinLat: true, pinLng: true, pinSource: true },
        })
      : null;

    const resolved = resolveDestination({
      orderLocationLink: dispatch.saleOrder.buyerLocationLink,
      addressPin: address,
      partyPin: dispatch.saleOrder.buyer,
      destinationText: dispatch.saleOrder.destination,
    });

    if (!resolved.point) {
      await prisma.saleDispatch.update({
        where: { id: dispatch.id },
        data: { routeSource: 'NONE' },
      });
      return;
    }

    // A pin pointing at the wrong place is the silent failure here: the board
    // does not go blank, it confidently reports the distance to somewhere else.
    // Logged rather than rejected - the town table is the less trustworthy of
    // the two, so discarding the pin could throw away the better coordinate.
    const sanity = checkPin(resolved, dispatch.saleOrder.destination);
    if (!sanity.ok) {
      logger.warn(
        `[dispatch-dest] ${dispatch.saleOrder.buyer?.name ?? 'buyer'} pin looks wrong for dispatch ${dispatch.id}: ${sanity.reason}`,
      );
    }

    const lane = await getLane(
      { lat: FACTORY.latitude, lng: FACTORY.longitude },
      resolved.point,
    );

    await prisma.saleDispatch.update({
      where: { id: dispatch.id },
      data: {
        destLat: resolved.point.lat,
        destLng: resolved.point.lng,
        routeKm: Math.round(lane.roadKm),
        routeSource:
          resolved.source === 'TOWN_CENTRE'
            ? 'TOWN_CENTRE'
            : lane.routed
              ? 'PIN_ROUTED'
              : 'PIN_STRAIGHT',
      },
    });
  } catch (err) {
    logger.warn(
      `[dispatch-dest] could not stamp dispatch ${dispatchId}: ${(err as Error)?.message ?? err}`,
    );
  }
}

export interface DistanceBackfillResult {
  considered: number;
  stamped: number;
}

/**
 * Stamp past dispatches that have no distance.
 *
 * Worth running once: it turns the freight history into a ₹ per tonne per km
 * series on day one rather than in six months, which is the number that shows
 * which lanes are overpriced.
 *
 * Sequential, and newest first. Each distinct destination may cost one routing
 * call, and the recent dispatches are both the ones anyone will look at and the
 * ones whose buyers' pins are most likely to still be right.
 */
export async function backfillDispatchDistances(limit = 300): Promise<DistanceBackfillResult> {
  const rows = await prisma.saleDispatch.findMany({
    where: { destLat: null, routeSource: null },
    orderBy: { dispatchDate: 'desc' },
    take: limit,
    select: { id: true },
  });

  let stamped = 0;
  for (const row of rows) {
    await snapshotDispatchDestination(row.id);
    stamped += 1;
  }
  logger.info(`[dispatch-dest] backfill stamped ${stamped} of ${rows.length} dispatches`);
  return { considered: rows.length, stamped };
}
