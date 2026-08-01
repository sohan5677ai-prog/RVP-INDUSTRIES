import { prisma } from '../lib/prisma.js';
import { roadDistanceKm } from '../lib/roadDistance.js';
import { getCompanyProfileRow } from '../controllers/settings.controller.js';

export type EwbDistanceSource = 'manual' | 'previous-ewb' | 'calculated';

export type EwbDistance = {
  km: number;
  source: EwbDistanceSource;
  /** Human-readable note for the UI, e.g. "same as EWB 1125…" */
  detail: string;
};

/**
 * Where a dispatch's E-Way Bill distance comes from, in order of authority:
 *
 *  1. what the operator typed, if they typed anything;
 *  2. the distance already filed for the SAME buyer - the lorry runs the same
 *     route every time, and if that earlier figure was corrected to match the
 *     NIC portal, reusing it keeps every bill for that buyer consistent;
 *  3. a road-routing calculation from the dispatch-from PIN code to the buyer's.
 *
 * Nothing here asks the operator for anything: (2) and (3) between them cover
 * every normal dispatch. Returns null only when the route can't be worked out
 * at all (buyer has no PIN code on file, or the routing service is unreachable),
 * which is the one case the caller has to handle.
 */
export async function resolveEwbDistance(
  dispatchId: string,
  manualKm?: number | null,
): Promise<EwbDistance | null> {
  if (manualKm && manualKm > 0) {
    return { km: Math.round(manualKm), source: 'manual', detail: 'entered manually' };
  }

  const dispatch = await prisma.saleDispatch.findUnique({
    where: { id: dispatchId },
    include: { saleOrder: { include: { buyer: { select: { id: true, pincode: true } } } } },
  });
  if (!dispatch) return null;

  // A distance already recorded on THIS dispatch wins over a recalculation -
  // it may have been corrected by hand to the portal's figure.
  if (dispatch.ewbDistance) {
    return { km: dispatch.ewbDistance, source: 'previous-ewb', detail: 'already recorded on this dispatch' };
  }

  const previous = await prisma.saleDispatch.findFirst({
    where: {
      id: { not: dispatch.id },
      ewbDistance: { not: null },
      saleOrder: { buyerId: dispatch.saleOrder.buyerId },
    },
    orderBy: { ewbDate: 'desc' },
    select: { ewbDistance: true, ewbNumber: true },
  });
  if (previous?.ewbDistance) {
    return {
      km: previous.ewbDistance,
      source: 'previous-ewb',
      detail: `same as E-Way Bill ${previous.ewbNumber} for this buyer`,
    };
  }

  const company = await getCompanyProfileRow();
  const fromPin = company.dispatchFromPincode || company.pincode;
  const toPin = dispatch.saleOrder.buyer.pincode;
  const km = await roadDistanceKm(fromPin, toPin);
  if (!km) return null;

  return { km, source: 'calculated', detail: `road distance ${fromPin} → ${toPin}` };
}
