import { freightDestinationKey } from './transportFreight.js';

/**
 * Both ends of a booked lorry's trip, with the mill always on one of them.
 *
 * Every lorry on the register either comes to us loaded or leaves us loaded, so
 * one end of the route is always the factory. The transporter never writes it:
 * the reply form the ERP issues asks him for a single place, and that place is
 * the *other* end - where he loads on a purchase, where he delivers on a sale.
 *
 * Filing that lone place as `fromPlace` and then taking the sale order's
 * destination as `toPlace` wrote the same town twice: "AHMEDNAGAR -> Ahilyanagar"
 * is one lorry going to one place, spelled the two ways our own orders spell it.
 * A route read off the register has to be the trip, so it is composed here:
 *
 *  - **Inbound** (a purchase requirement): the place he named -> Punganur.
 *  - **Outbound** (a loading slot, or a code we could not place): Punganur ->
 *    the destination on the order, or failing that the place he named.
 *
 * The away end is picked by folding each candidate through
 * `freightDestinationKey`, which is what lets "Sahada" on his message and
 * "Shahada" on our order be recognised as one town rather than a route.
 */

/** Where the mill sits when the company profile has not been filled in. */
export const DEFAULT_HOME_PLACE = 'Punganur';

/** True when this place is the factory, however it was spelled. */
export function isHomePlace(place: string | null | undefined, home: string): boolean {
  const k = freightDestinationKey(place);
  return !!k && k === freightDestinationKey(home);
}

export interface BookingRouteInput {
  direction: 'INBOUND' | 'OUTBOUND' | string;
  /** The place the transporter named, as parsed. */
  fromPlace?: string | null;
  toPlace?: string | null;
  /** The destination on the sale order the loading slot belongs to, if any. */
  destination?: string | null;
  home: string;
}

export function bookingRoute(input: BookingRouteInput): {
  fromPlace: string | null;
  toPlace: string | null;
} {
  const home = input.home.trim() || DEFAULT_HOME_PLACE;
  // The order matters: the destination on our own order outranks whatever was
  // typed on the message, and a message end that is the factory is not news.
  const away =
    [input.destination, input.toPlace, input.fromPlace]
      .map((p) => (typeof p === 'string' ? p.trim() : ''))
      .find((p) => p && !isHomePlace(p, home)) ?? null;

  // No away end means no trip to draw. Writing "Punganur -> ?" on a booking
  // whose message named no place would put the factory on a row that says
  // nothing, so such a row keeps both ends empty and the register shows a dash.
  if (!away) return { fromPlace: null, toPlace: null };

  return input.direction === 'INBOUND'
    ? { fromPlace: away, toPlace: home }
    : { fromPlace: home, toPlace: away };
}
