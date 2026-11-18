import { prisma } from '../lib/prisma.js';
import { sendWhatsAppTemplate, resolveAlertRecipients } from './whatsapp.service.js';
import type { ArrivalRings, InboundArrival } from './inboundArrivals.service.js';

/**
 * The two WhatsApps that go out when an arriving lorry crosses a ring.
 *
 * Split out of inboundArrivals.service so the ring sweep - which runs on every
 * GPS poll tick - does not drag whatsapp.service and its template tables into
 * memory on a server where nothing is arriving. The sweep imports this lazily.
 *
 * Who gets told, and when:
 *
 * - **The approach ring (10 km by default) messages people.** The office needs
 *   to know a lorry is coming so the paperwork and the weighbridge are free,
 *   and the hamali team needs fifteen or twenty minutes to assemble. Ten km of
 *   this road is about that.
 * - **The gate ring (3 km) messages nobody.** It puts the lorry on the kata
 *   cabin's arrivals strip with its ticket pre-filled, which is the only thing
 *   anyone needs four minutes out. A second WhatsApp at that point is noise,
 *   and noise is how an alert channel dies. The ApproachAlert row is still
 *   written - it is the record of when the lorry actually reached the gate, and
 *   it is what the "told at" ticks on the board read.
 */

/** Hamali team phone, from the party the rest of the ERP already uses for it. */
async function hamaliPhone(): Promise<string | null> {
  const team = await prisma.party.findFirst({
    where: { type: 'HAMALI_TEAM' },
    select: { phone: true, phone2: true },
  });
  return team?.phone?.trim() || team?.phone2?.trim() || null;
}

/** "today 3:40 PM" / "tomorrow 6:05 AM" - how a yard says an arrival time. */
function etaLabel(iso: string | null): string {
  if (!iso) return 'shortly';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'shortly';
  const time = at.toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
  });
  const dayOf = (d: Date) =>
    d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const today = dayOf(new Date());
  const tomorrow = dayOf(new Date(Date.now() + 24 * 3_600_000));
  const day = dayOf(at);
  if (day === today) return `today ${time}`;
  if (day === tomorrow) return `tomorrow ${time}`;
  return at.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    hour12: true, timeZone: 'Asia/Kolkata',
  });
}

/**
 * Announce one ring crossing. Returns how many phones were actually messaged,
 * which the caller records on the latch row.
 *
 * Never throws for a send failure: the ring is already latched by the time this
 * is called, and an unapproved template must not look like a crash in the poll
 * loop.
 */
export async function notifyInboundApproach(
  arrival: InboundArrival,
  ringKm: number,
  rings: ArrivalRings,
): Promise<number> {
  // The gate ring is the cabin's, not WhatsApp's - see the file header.
  if (ringKm !== rings.approachKm) return 0;

  const lorry = arrival.lorryNumber ?? '-';
  const distance = arrival.distanceKm === null ? String(ringKm) : String(arrival.distanceKm);
  const eta = etaLabel(arrival.etaAt);

  const [office, hamali] = await Promise.all([resolveAlertRecipients(), hamaliPhone()]);

  let notified = 0;

  if (office.length > 0) {
    const result = await sendWhatsAppTemplate({
      templateKey: 'INBOUND_APPROACH_OFFICE',
      to: office,
      variables: [
        lorry,
        arrival.supplier,
        arrival.load,
        // The body already reads "Distance: {{4}} km away", so this slot
        // carries the bare number. Putting "9.4 km" here would print "km km" -
        // the same trap the sale-order template documents.
        distance,
        eta,
        arrival.driverPhone ?? '-',
        arrival.requirementCode ?? '-',
      ],
      relatedType: 'INBOUND_APPROACH',
      relatedId: arrival.bookingId,
    });
    if (result.ok) notified += office.length;
  }

  if (hamali) {
    const result = await sendWhatsAppTemplate({
      templateKey: 'INBOUND_APPROACH_HAMALI',
      to: hamali,
      variables: [lorry, arrival.load, arrival.supplier, arrival.driverPhone ?? '-'],
      // The team on the floor is Hindi-speaking; the English copy is the
      // fallback until the Hindi one is approved (see templateId).
      language: 'HI',
      relatedType: 'INBOUND_APPROACH',
      relatedId: arrival.bookingId,
    });
    if (result.ok) notified += 1;
  }

  return notified;
}
