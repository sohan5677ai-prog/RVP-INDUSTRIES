import { prisma } from '../lib/prisma.js';
import { roadDistanceKm } from '../lib/roadDistance.js';
import { getCompanyProfileRow } from '../controllers/settings.controller.js';
import { resolveOrderEffectiveDetails } from '../lib/orderAddress.js';
import { TaxproService } from './taxpro.service.js';

export type EwbDistanceSource = 'manual' | 'previous-ewb' | 'official' | 'calculated';

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
 *  3. official government PIN-to-PIN distance via TaxPro GSP (action=GetDistance)
 *  4. a road-routing calculation from the dispatch-from PIN code to the buyer's (OpenStreetMap).
 *
 * Nothing here asks the operator for anything: (2), (3) and (4) between them cover
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
    include: {
      saleOrder: {
        include: {
          buyer: {
            include: { addresses: true },
          },
        },
      },
    },
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

  const { effectivePincode } = await resolveOrderEffectiveDetails(dispatch.saleOrder);
  const company = await getCompanyProfileRow();
  const fromPin = company.dispatchFromPincode || company.pincode;
  const toPin = effectivePincode;

  // 1. Official NIC PIN-to-PIN distance via TaxPro GSP
  if (fromPin && toPin) {
    try {
      const officialKm = await TaxproService.getOfficialDistance(fromPin, toPin);
      if (officialKm && officialKm > 0) {
        return {
          km: officialKm,
          source: 'official',
          detail: `official NIC PIN-to-PIN distance (${fromPin} → ${toPin})`,
        };
      }
    } catch {
      // Graceful fallback to road calculation
    }
  }

  // 2. OpenStreetMap road distance calculation
  const km = await roadDistanceKm(fromPin, toPin);
  if (!km) return null;

  return { km, source: 'calculated', detail: `road distance ${fromPin} → ${toPin}` };
}

