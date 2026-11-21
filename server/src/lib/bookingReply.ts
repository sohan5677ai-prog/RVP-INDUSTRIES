import { parseLorryCode } from './lorryCode.js';
import type { ParsedTransportConfirmation } from './gemini.js';

/**
 * Read the reply shape the ERP itself asks transporters for.
 *
 * `issueRequirementCode` hands the transporter a form to copy back:
 *
 *   18NOV-01
 *   GJ18BV1872
 *   +919772764986
 *   35MT
 *   SAHADA
 *
 * That is a fixed shape, so it must not be read by a model. It was: every
 * booking went through `parseTransportConfirmationText`, whose prompt only
 * describes the old sentence-style broker message ("18/7/26 Punganur To Surat
 * 30 Tones ... Driver Moula ... Freight 80000") and asks for "route/driver/
 * freight" before it will call something a booking. Handed these five bare
 * lines the model answered yes some of the time and no the rest - three
 * identical messages on 19 Nov filed one row between them, and the two it
 * dropped were the lorries the office was waiting on.
 *
 * A message in this shape therefore never reaches Gemini. It is read here, line
 * by line, and the sentence-style parser stays for everything else.
 *
 * Returns null when the text is not in this shape, so the caller can fall back.
 *
 * A day's indent lists several codes, so a transporter often answers for his
 * whole fleet in one message - five lines per lorry, one block after another.
 * That is `parseBookingReplies`, which splits the text on its code lines and
 * reads each block by these same rules.
 */

/** `GJ18BV1872`, `AP 39 T 8217`, `TN-38-AB-1234`. */
const PLATE = /^[A-Z]{2}\s*-?\s*\d{1,2}\s*-?\s*[A-Z]{0,3}\s*-?\s*\d{3,4}$/;
/**
 * `35MT`, `35 MT`, `30 Tonnes`, `35 T`, `35M`, and the same with the body type
 * run on after it: `30MT OPAN`, `35 MT CONTAINER`.
 *
 * The unit is written every way a hurried man writes it, and the line was
 * dropped whole when it did not match - which costs the tonnage off an
 * otherwise good booking. Letters after the unit are the body type, never a
 * number, so nothing we would have stored is lost by allowing them.
 */
const TONNAGE = /^(\d+(?:\.\d+)?)\s*(?:MTS?|M\.T\.?|M|TONNES?|TONS?|T)\b\s*(?:[A-Z][A-Z ]{0,19})?$/;
/** `14W`, `12 wheeler`, `22 W` - body type, carried on the shape but not stored. */
const BODY = /^\d{1,2}\s*(?:W|WHEELER|WHEELS?)$/;

/** `+919772764986`, `919772764986`, `9772764986` -> `9772764986`. */
function readPhone(line: string): string | null {
  const digits = line.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13) return null;
  const ten = digits.slice(-10);
  // An Indian mobile starts 6-9. Anything else on a line of its own is some
  // other number (a freight figure, a date) and must not become a driver.
  if (!/^[6-9]\d{9}$/.test(ten)) return null;
  // 12/13 digits are only a phone when the extra digits are the country code.
  if (digits.length > 10 && !/^(?:0{0,2}91)/.test(digits.slice(0, digits.length - 10))) return null;
  return ten;
}

/**
 * One block: the code it answers for, and the lorry read out of it.
 *
 * The code is returned alongside the parse rather than re-read by the caller,
 * because in a multi-lorry reply there is no single code to re-read.
 */
export interface BookingReplyBlock {
  code: string;
  parsed: ParsedTransportConfirmation;
}

/** Trimmed, non-empty lines - the only form the readers below work on. */
function cleanLines(text: string | null | undefined): string[] {
  if (!text) return [];
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function readBlock(lines: string[]): ParsedTransportConfirmation | null {
  if (lines.length < 2 || lines.length > 10) return null;

  // The code must be the FIRST line. `parseLorryCode` scans the first four, but
  // this shape is only this shape when the transporter copied it from the top -
  // a code further down is a sentence-style message that happens to quote one,
  // and that belongs to the model.
  if (!parseLorryCode(lines[0])) return null;

  const out: ParsedTransportConfirmation = { isTransportConfirmation: true };
  const leftovers: string[] = [];

  for (const line of lines.slice(1)) {
    const upper = line.toUpperCase();
    if (!out.lorryNumber && PLATE.test(upper)) {
      out.lorryNumber = upper.replace(/[^A-Z0-9]/g, '');
      continue;
    }
    if (!out.tonnageKg) {
      const m = TONNAGE.exec(upper);
      if (m) {
        const tonnes = Number(m[1]);
        if (tonnes > 0 && tonnes < 100) {
          out.tonnageKg = Math.round(tonnes * 1000);
          continue;
        }
      }
    }
    if (!out.driverPhone) {
      const phone = readPhone(line);
      if (phone) {
        out.driverPhone = phone;
        continue;
      }
    }
    if (BODY.test(upper)) continue;
    leftovers.push(line);
  }

  // Nothing actionable - let the model have a look rather than filing a row
  // with neither a lorry nor a driver on it.
  if (!out.lorryNumber && !out.driverPhone) return null;

  // Whatever is left over that reads like a place name is the loading place -
  // the last line of the shape. Digits mean it is something we failed to read,
  // and a misread must not be stored as a route.
  const place = leftovers.filter((l) => /^[A-Za-z][A-Za-z .&'-]{1,40}$/.test(l)).pop();
  if (place) out.fromPlace = place;

  return out;
}

/**
 * Every lorry in a reply, in the order the transporter wrote them.
 *
 * The split is on code lines, and a code line is a line that is *nothing but* a
 * code - the same rule `parseLorryCode` already enforces, which is why this can
 * be a split rather than a guess. The first line has to be a code: a sentence
 * that happens to quote one further down is a broker message and belongs to the
 * model, exactly as before. A block whose details are unreadable is dropped
 * rather than filed empty, so a six-lorry message with one mangled entry still
 * books the other five.
 *
 * Returns an empty array when the text is not in this shape at all, which is
 * the signal to fall back to the sentence-style parser.
 */
export function parseBookingReplies(text: string | null | undefined): BookingReplyBlock[] {
  const lines = cleanLines(text);
  if (lines.length === 0) return [];

  const starts: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (parseLorryCode(lines[i])) starts.push(i);
  }
  if (starts.length === 0 || starts[0] !== 0) return [];

  const out: BookingReplyBlock[] = [];
  for (let b = 0; b < starts.length; b += 1) {
    const block = lines.slice(starts[b], starts[b + 1] ?? lines.length);
    const code = parseLorryCode(block[0]);
    const parsed = readBlock(block);
    if (code && parsed) out.push({ code, parsed });
  }
  return out;
}

/**
 * The single-lorry case.
 *
 * A message carrying two codes is deliberately NOT answered here: its caller
 * files one row, and filing the first lorry of a five-lorry reply would lose
 * four bookings silently. Those callers go through `parseBookingReplies`.
 */
export function parseBookingReply(text: string | null | undefined): ParsedTransportConfirmation | null {
  const blocks = parseBookingReplies(text);
  return blocks.length === 1 ? blocks[0].parsed : null;
}
