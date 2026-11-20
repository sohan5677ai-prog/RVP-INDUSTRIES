import type { Transport } from './types';

export interface TransportOwnerPayee {
  /** Shown on the receipt dialog, e.g. "Praveen (Sree Madhupuri Transport)". */
  name: string;
  /** The first number to tell. Empty when the agency has none on file yet. */
  phone: string;
  /**
   * The agency's second number, when it has one. An agency is often two people
   * - Madhupuri has a manager and an owner - and both must get every message
   * about it, so a single `phone` here was quietly cutting one of them out.
   * Empty when there is no second number, or when it repeats the first.
   */
  phone2: string;
  /** Both numbers, de-duplicated: what a send should actually address. */
  phones: string[];
}

/**
 * Single-owner fleets (Transport.payToOwner) are paid as one person: every
 * lorry running under the agency belongs to the same owner, the money goes to
 * his one account, and the freight receipt must reach him - never the driver
 * who happened to be behind the wheel.
 *
 * Returns null for ordinary agencies, where the driver stays the recipient.
 * A flagged agency with no phone on file still returns a payee (with an empty
 * number) so the receipt is addressed to the owner and asks for his number,
 * rather than quietly falling back to the driver's.
 */
export function ownerPayeeOf(t?: Partial<Transport> | null): TransportOwnerPayee | null {
  if (!t?.payToOwner) return null;
  const person = String(t.contactPerson || '').trim();
  const agency = String(t.name || 'Transport').trim();
  const phones: string[] = [];
  for (const raw of [t.phone, t.phone2]) {
    const p = String(raw || '').trim();
    if (p && !phones.includes(p)) phones.push(p);
  }
  return {
    name: person ? `${person} (${agency})` : `${agency} (Owner)`,
    phone: phones[0] ?? '',
    phone2: phones[1] ?? '',
    phones,
  };
}
