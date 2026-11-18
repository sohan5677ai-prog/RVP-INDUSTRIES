import { prisma } from './prisma.js';
import { istCalendar } from './istDate.js';

/**
 * Requirement codes: the short key a transporter quotes back.
 *
 * `16NOV-02` - the day, then a sequence within the day. The sale side already
 * works this way (`slotCode` in dispatchSlot.service.ts): the day is in the code
 * so the transporter can read it at a glance, and the two-digit tail is what
 * makes his reply land on one requirement instead of being guessed at.
 *
 * The purchase side needed the same thing for the opposite reason. An inbound
 * booking used to be matched to a trip by lorry number alone, newest-first,
 * which breaks the moment the same lorry runs twice or two transporters answer
 * at once - and, worse, a mis-parsed message could file a booking against
 * nothing at all. With a code on the first line the match is exact, and a
 * message carrying no code simply never reaches the driver-brief path.
 *
 * The format is deliberately identical to the sale-side code rather than shared
 * with it: `slotCode` mints codes from the DispatchSlot sequence, this one from
 * a per-day counter over purchase orders, and the two sequences must be free to
 * collide (16NOV-02 can be both a loading slot and a requirement - they are
 * read in different conversations, with different transporters).
 */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** `16NOV-02`. Day and month in IST - Render runs UTC. */
export function formatLorryCode(date: Date, seq: number): string {
  const { month, day } = istCalendar(date);
  return `${String(day).padStart(2, '0')}${MONTHS[month - 1]}-${String(seq).padStart(2, '0')}`;
}

/**
 * Read a requirement code out of a transporter's message.
 *
 * Only the first few lines are searched, and the line must be *nothing but* the
 * code. Transporters write "35MT", "14W", "GJ18BV5741" and dates all through
 * these messages, and a loose scan reads half of them as codes. Asking for the
 * code on its own line is a rule the transporter can actually follow, and it is
 * what makes this parse deterministic enough to gate an outbound WhatsApp on.
 */
export function parseLorryCode(text: string | null | undefined): string | null {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/).slice(0, 4);
  for (const line of lines) {
    const m = /^\s*([0-3]?\d)\s*-?\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*-\s*(\d{1,3})\s*$/i.exec(line);
    if (!m) continue;
    const day = Number(m[1]);
    const seq = Number(m[3]);
    if (day < 1 || day > 31 || seq < 1) continue;
    return `${String(day).padStart(2, '0')}${m[2].toUpperCase()}-${String(seq).padStart(2, '0')}`;
  }
  return null;
}

/** The counter row key for a day. One sequence per calendar day, IST. */
function counterKey(date: Date): { seriesKey: string; fy: string } {
  const { year, month, day } = istCalendar(date);
  return {
    seriesKey: 'REQ',
    fy: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/**
 * The next code for `date`, taken atomically.
 *
 * Reuses PoSerialCounter rather than adding a table: it exists to hand out
 * gap-free per-key sequences under concurrency, which is exactly this. A
 * cancelled requirement keeps its number - the transporter has already seen it,
 * so reusing it would point two lorries at one code.
 */
export async function nextRequirementCode(date: Date = new Date()): Promise<string> {
  const key = counterKey(date);
  const row = await prisma.poSerialCounter.upsert({
    where: { seriesKey_fy: key },
    create: { ...key, lastSerial: 1 },
    update: { lastSerial: { increment: 1 } },
    select: { lastSerial: true },
  });
  return formatLorryCode(date, row.lastSerial);
}
