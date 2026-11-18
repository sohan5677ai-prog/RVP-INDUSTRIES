import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { resolvePinForStorage } from '../lib/destinationPin.js';

/**
 * Keeping Party.pinLat / PartyAddress.pinLat in step with the location links.
 *
 * Written as a reconcile over one party rather than threaded through the create
 * and update paths, for two reasons. Those paths already juggle an address
 * array against six denormalised columns on the party, and adding an async
 * coordinate resolution to both would double the places this can go wrong. And
 * resolving a short Google link means following a redirect with a ten-second
 * timeout - which must not sit inside the request that saves a party form.
 *
 * So it runs AFTER the save, fire-and-forget: the party is written, the pin
 * lands a moment later. Nothing reads the pin synchronously at save time, and
 * the worst case of a failed resolve is the state the app was in before this
 * existed - the town table.
 */

/** Resolve and store pins for one party and its addresses. Never throws. */
export async function reconcilePartyPins(partyId: string): Promise<void> {
  try {
    const party = await prisma.party.findUnique({
      where: { id: partyId },
      select: {
        id: true,
        locationLink: true,
        pinLat: true,
        pinResolvedAt: true,
        addresses: { select: { id: true, locationLink: true, pinLat: true, pinResolvedAt: true } },
      },
    });
    if (!party) return;

    // A link that has not changed is not re-resolved. Without this, every edit
    // to a party's phone number would re-follow its maps redirect.
    // A link worth resolving is a non-blank one. With no link, the only work is
    // clearing coordinates that a previous link left behind.
    const needsWork = (link: string | null, pinLat: number | null, at: Date | null) =>
      link?.trim() ? pinLat === null || at === null : pinLat !== null;

    if (needsWork(party.locationLink, party.pinLat, party.pinResolvedAt)) {
      const pin = await resolvePinForStorage(party.locationLink);
      await prisma.party.update({
        where: { id: party.id },
        data: {
          pinLat: pin.point?.lat ?? null,
          pinLng: pin.point?.lng ?? null,
          pinSource: pin.source,
          pinResolvedAt: new Date(),
        },
      });
    }

    for (const address of party.addresses) {
      if (!needsWork(address.locationLink, address.pinLat, address.pinResolvedAt)) continue;
      const pin = await resolvePinForStorage(address.locationLink);
      await prisma.partyAddress.update({
        where: { id: address.id },
        data: {
          pinLat: pin.point?.lat ?? null,
          pinLng: pin.point?.lng ?? null,
          pinSource: pin.source,
          pinResolvedAt: new Date(),
        },
      });
    }
  } catch (err) {
    logger.warn(`[party-pin] could not reconcile pins for ${partyId}: ${(err as Error)?.message ?? err}`);
  }
}

/**
 * Clear a stored pin so the next reconcile resolves it again.
 *
 * Called when a location link is edited: `reconcilePartyPins` deliberately
 * skips a party that already has a pin, so without this an edited link would
 * keep the coordinates of the old one.
 */
export async function invalidatePartyPin(partyId: string): Promise<void> {
  await prisma.party
    .update({
      where: { id: partyId },
      data: { pinLat: null, pinLng: null, pinSource: null, pinResolvedAt: null },
    })
    .catch(() => undefined);
}

export interface PinBackfillResult {
  considered: number;
  resolved: number;
  unresolved: number;
  /** Parties whose link carries no coordinates - these need a human. */
  needsAttention: { id: string; name: string; locationLink: string | null }[];
}

/**
 * Resolve pins for every party that has a link and no coordinates.
 *
 * One pass, for the parties that existed before these columns did. Sequential
 * on purpose: each unresolved short link is an outbound HTTP request, and
 * firing a few hundred at Google at once is how an IP gets throttled - which
 * would turn a slow backfill into a failed one.
 *
 * The `needsAttention` list is the useful output. Roughly half of Google's
 * share links carry no coordinates at all, so after this runs there will be a
 * set of buyers whose pin simply cannot be derived, and the fix is for someone
 * to long-press the gate in Google Maps and paste the numbers. That list is who
 * to ask.
 */
export async function backfillPartyPins(limit = 500): Promise<PinBackfillResult> {
  const parties = await prisma.party.findMany({
    // An empty string is not a link. Most of this table holds '' rather than
    // NULL - the party form writes a blank field through - and treating those
    // as links to resolve would stamp UNRESOLVED on every buyer who simply has
    // no pin yet, which is a different thing from one whose link cannot be
    // read and belongs in a different list.
    where: { locationLink: { not: null }, NOT: { locationLink: '' }, pinLat: null },
    take: limit,
    select: { id: true, name: true, locationLink: true },
  });

  const result: PinBackfillResult = {
    considered: parties.length,
    resolved: 0,
    unresolved: 0,
    needsAttention: [],
  };

  for (const party of parties) {
    const pin = await resolvePinForStorage(party.locationLink);
    await prisma.party
      .update({
        where: { id: party.id },
        data: {
          pinLat: pin.point?.lat ?? null,
          pinLng: pin.point?.lng ?? null,
          pinSource: pin.source,
          pinResolvedAt: new Date(),
        },
      })
      .catch(() => undefined);

    if (pin.point) {
      result.resolved += 1;
    } else {
      result.unresolved += 1;
      result.needsAttention.push({ id: party.id, name: party.name, locationLink: party.locationLink });
    }
  }

  logger.info(`[party-pin] backfill: ${result.resolved} resolved, ${result.unresolved} need a pasted coordinate`);
  return result;
}
