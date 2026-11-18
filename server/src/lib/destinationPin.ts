import { parseLatLng, resolveLatLngFromMapsLink } from './mapsLink.js';
import { resolvePlace, kmBetween } from './gpsPlaces.js';
import type { LatLng } from './routeGeometry.js';

/**
 * Where a lorry is actually going, and how sure we are about it.
 *
 * The destination on a sale order is free text the office types ("Surat",
 * "Barshi", "Nagar"), and until now that text was all the dispatch board had:
 * matched against the hand-kept town table in gpsPlaces.ts, it gave the town
 * centre or nothing. But the buyer's own delivery pin has been stored all along
 * on Party.locationLink, snapshotted per order on SaleOrder.buyerLocationLink,
 * and sent to the driver on every dispatch. This resolves that pin, and keeps
 * the town table only as the fallback it should always have been.
 *
 * `source` is carried everywhere because the four cases are not
 * interchangeable. A routed distance to a real pin is a measurement; a town
 * centre is up to ten km out and is why a lorry can read "arrived" while it is
 * still looking for the gate. Screens must be able to say which they are
 * showing.
 */

export type PinSourceValue = 'BARE' | 'URL' | 'REDIRECT' | 'TOWN_CENTRE' | 'UNRESOLVED';

export interface ResolvedPin {
  point: LatLng | null;
  source: PinSourceValue;
  /** The place name, when it came from the town table. */
  placeName?: string | null;
}

/**
 * Resolve a stored link WITHOUT touching the network.
 *
 * This is the form every read path uses. Bare coordinates and long map URLs
 * spell their coordinates out, so they resolve here; a short share link does
 * not, and gets UNRESOLVED rather than a ten-second fetch on the request path.
 * Short links are resolved once when the party is saved and persisted to
 * Party.pinLat - see resolvePinForStorage.
 */
export function pinFromLink(link: string | null | undefined): ResolvedPin {
  if (!link?.trim()) return { point: null, source: 'UNRESOLVED' };
  const coords = parseLatLng(link);
  if (!coords) return { point: null, source: 'UNRESOLVED' };
  // Bare "lat, lng" versus coordinates dug out of a map URL. Both exact; worth
  // telling apart only because a bare pair was typed deliberately by someone
  // standing at the gate, which is the best input this system gets.
  const bare = /^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*$/.test(link);
  return { point: { lat: coords.lat, lng: coords.lng }, source: bare ? 'BARE' : 'URL' };
}

/**
 * Resolve a link for STORAGE, following a short link if that is what it takes.
 *
 * Called when a party or an address is saved - once per edit, off the read
 * path. Everything else reads the stored columns.
 */
export async function resolvePinForStorage(link: string | null | undefined): Promise<ResolvedPin> {
  const direct = pinFromLink(link);
  if (direct.point) return direct;
  if (!link?.trim()) return { point: null, source: 'UNRESOLVED' };

  const followed = await resolveLatLngFromMapsLink(link);
  if (!followed) return { point: null, source: 'UNRESOLVED' };
  return { point: { lat: followed.lat, lng: followed.lng }, source: 'REDIRECT' };
}

/** A stored pin, as the Party/PartyAddress columns hold it. */
export interface StoredPin {
  pinLat: number | null;
  pinLng: number | null;
  pinSource: PinSourceValue | null;
}

/**
 * The delivery point for a dispatch, in precedence order.
 *
 * The order mirrors how the rest of the app already resolves a delivery
 * address (lib/orderAddress.ts): the branch the order was placed against wins
 * over the party's head office, and the order's own snapshot wins over both,
 * because it is what was true when the order was taken.
 *
 * The town table comes last, and only as TOWN_CENTRE. That ordering is the
 * whole change: the buyer's gate is used when it is known, and the town is
 * admitted as a town.
 */
export function resolveDestination(args: {
  /** Snapshot taken on the order when it was placed. */
  orderLocationLink?: string | null;
  /** The branch address the order was placed against, if any. */
  addressPin?: StoredPin | null;
  /** The buyer's own stored pin. */
  partyPin?: StoredPin | null;
  /** Free-text destination, for the town-table fallback. */
  destinationText?: string | null;
}): ResolvedPin {
  const fromStored = (pin: StoredPin | null | undefined): ResolvedPin | null => {
    if (!pin || pin.pinLat === null || pin.pinLng === null) return null;
    return { point: { lat: pin.pinLat, lng: pin.pinLng }, source: pin.pinSource ?? 'URL' };
  };

  // The order's own snapshot first, resolved without the network - a link that
  // needed a redirect followed was already persisted on the party.
  const fromOrder = pinFromLink(args.orderLocationLink);
  if (fromOrder.point) return fromOrder;

  const fromAddress = fromStored(args.addressPin);
  if (fromAddress) return fromAddress;

  const fromParty = fromStored(args.partyPin);
  if (fromParty) return fromParty;

  const town = resolvePlace(args.destinationText);
  if (town) {
    return {
      point: { lat: town.latitude, lng: town.longitude },
      source: 'TOWN_CENTRE',
      placeName: town.name,
    };
  }

  return { point: null, source: 'UNRESOLVED' };
}

/**
 * How far a pin may sit from the town its destination text names before it is
 * treated as suspect.
 *
 * A pasted link pointing at the wrong place is the failure mode that matters
 * here, because it is silent: the board does not go blank, it confidently
 * reports the distance to somewhere else entirely. Fifty km is wide enough for
 * a legitimate industrial estate outside a city - Sachin is 10 km from Surat -
 * and narrow enough to catch a link for the buyer's Mumbai office pasted
 * against a Solapur delivery.
 */
export const PIN_TOWN_TOLERANCE_KM = 50;

export interface PinSanity {
  ok: boolean;
  /** Km between the pin and the named town, when both are known. */
  offByKm: number | null;
  reason?: string;
}

/**
 * Sanity-check a resolved pin against the destination text and the map.
 *
 * Deliberately advisory: it returns a verdict rather than discarding the pin,
 * because the town table is the less trustworthy of the two and a false
 * rejection would throw away the better coordinate. The caller surfaces this
 * so a human can look, which is the only thing that actually fixes a wrong
 * link.
 */
export function checkPin(pin: ResolvedPin, destinationText: string | null | undefined): PinSanity {
  if (!pin.point) return { ok: true, offByKm: null };
  const { lat, lng } = pin.point;

  // India's bounding box, generously drawn. Catches a swapped lat/lng, which is
  // the single most common way a coordinate pair goes wrong: 72.83, 21.17
  // instead of 21.17, 72.83 lands in the Arabian Sea off Somalia.
  if (lat < 6 || lat > 37 || lng < 68 || lng > 98) {
    return { ok: false, offByKm: null, reason: 'The pin is outside India - the latitude and longitude may be swapped' };
  }

  // A town-centre pin cannot disagree with the town table it came from.
  if (pin.source === 'TOWN_CENTRE') return { ok: true, offByKm: null };

  const town = resolvePlace(destinationText);
  if (!town) return { ok: true, offByKm: null };

  const offByKm = kmBetween(lat, lng, town.latitude, town.longitude);
  if (offByKm > PIN_TOWN_TOLERANCE_KM) {
    return {
      ok: false,
      offByKm: Math.round(offByKm),
      reason: `The pin is ${Math.round(offByKm)} km from ${town.name}, which is the destination on the order`,
    };
  }
  return { ok: true, offByKm: Math.round(offByKm) };
}
