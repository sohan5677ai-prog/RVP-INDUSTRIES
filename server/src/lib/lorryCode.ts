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
 * The two series share ONE sequence per day, and that is not a tidiness choice.
 * They were independent to begin with, on the reasoning that a loading slot and
 * a purchase requirement are read in different conversations by different
 * transporters, so `16NOV-02` could safely mean two things. That stopped being
 * true the moment both kinds of lorry appeared on one arrivals board, were
 * searched by one box, and - the part that actually breaks - were resolved by
 * one lookup from one shared WhatsApp number. 18NOV-01 was minted as both a
 * Shahada loading slot and a purchase requirement, and a reply quoting it can
 * only be filed against one of them: whichever side the resolver happens to try
 * first. The wrong guess books a lorry onto a stranger's order and, on the
 * purchase side, texts that driver the factory pin.
 *
 * So `nextDaySequence` below is the only place either side takes a number from,
 * and it will not hand out one that is already in use on either. Codes already
 * minted in the old scheme are left alone - the transporter has seen them - and
 * are simply skipped over.
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
 * Only the first few lines are searched, and the code must START its line.
 * Transporters write "35MT", "14W", "GJ18BV5741" and dates all through these
 * messages, and a loose scan reads half of them as codes. Asking for the code
 * at the head of the line is a rule the transporter can actually follow, and it
 * is what makes this parse deterministic enough to gate an outbound WhatsApp on.
 */
export function parseLorryCode(text: string | null | undefined): string | null {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/).slice(0, 4);
  for (const line of lines) {
    const code = readCodeAtHead(line);
    if (code) return code;
  }
  return null;
}

/**
 * The code at the START of one line, with whatever the transporter wrote after
 * it on that line.
 *
 * The rule was once "the line is nothing but the code", and it cost bookings. A
 * transporter answering a particular indent writes its code and then says which
 * indent it was - "20NOV-01 30 Tons to Surat" - before giving the plate, the
 * driver and the tonnage on the lines below. That line is a code line by every
 * reading except the regex's, so the whole message fell through to the model,
 * came back with no code, and the lorry was filed against nothing: no slot
 * confirmed, nothing on the Upcoming tab, and an office waiting on a lorry the
 * register could not point at.
 *
 * What the strictness actually protected against is a code read out of the
 * MIDDLE of a sentence, where "35MT", "14W" and plates live. Anchoring to the
 * head of the line keeps all of that out - "Lorry for 16NOV-02 is GJ18BV5741"
 * still reads as no code - while letting the transporter annotate his own
 * answer. The sequence must end at a boundary, so "20NOV-012" is not 20NOV-01.
 *
 * The brackets are allowed for the same reason. A transporter quoting a code
 * back out of our own indent copies its punctuation with it - "(21NOV-01)) 1-
 * SURAT" - and a stray parenthesis is not a reason to lose a lorry.
 */
function readCodeAtHead(line: string): string | null {
  const m =
    /^[\s(\[{"'*#]*([0-3]?\d)\s*-?\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*-\s*(\d{1,3})(?![\d-])(.*)$/i.exec(
      line,
    );
  if (!m) return null;
  // Whatever follows has to be separated from the code: a letter or digit
  // running straight on is part of some other token, not a note about it.
  if (m[4].trim() && !/^[\s,;:.\/|)\]}"'*#]/.test(m[4])) return null;
  const day = Number(m[1]);
  const seq = Number(m[3]);
  if (day < 1 || day > 31 || seq < 1) return null;
  return `${String(day).padStart(2, '0')}${m[2].toUpperCase()}-${String(seq).padStart(2, '0')}`;
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
 * The next free sequence number for `date`, across BOTH code series.
 *
 * Reuses PoSerialCounter rather than adding a table: it exists to hand out
 * gap-free per-key sequences under concurrency, which is exactly this. A
 * cancelled requirement or slot keeps its number - the transporter has already
 * seen it, so reusing it would point two lorries at one code.
 *
 * The counter alone is not enough, for one transitional reason: codes minted
 * before the two series were joined are not in it. 20NOV-03 exists as a loading
 * slot on a day whose counter has never been touched, so a bare increment would
 * hand 20NOV-01 straight back out. Each candidate is therefore checked against
 * both tables and a taken one is skipped.
 *
 * The check is a read-then-use, which would normally be a race - but it is not,
 * because the counter increment above it is atomic: two callers never test the
 * same number, so the worst a concurrent mint can do is make both of them skip.
 * The unique keys on `PurchaseOrder.requirementCode` and `DispatchSlot.code`
 * remain the real guarantee, and both callers retry on a violation.
 */
export async function nextDaySequence(date: Date = new Date()): Promise<number> {
  const key = counterKey(date);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const row = await prisma.poSerialCounter.upsert({
      where: { seriesKey_fy: key },
      create: { ...key, lastSerial: 1 },
      update: { lastSerial: { increment: 1 } },
      select: { lastSerial: true },
    });
    const code = formatLorryCode(date, row.lastSerial);
    const [po, slot] = await Promise.all([
      prisma.purchaseOrder.findUnique({ where: { requirementCode: code }, select: { id: true } }),
      prisma.dispatchSlot.findUnique({ where: { code }, select: { id: true } }),
    ]);
    if (!po && !slot) return row.lastSerial;
  }
  // Fifty taken numbers in a row on one day is not a busy day, it is a bug.
  throw new Error(`Could not find a free requirement code for ${formatLorryCode(date, 1).slice(0, 5)}`);
}

/** The next code for `date`, taken atomically from the shared day sequence. */
export async function nextRequirementCode(date: Date = new Date()): Promise<string> {
  return formatLorryCode(date, await nextDaySequence(date));
}
