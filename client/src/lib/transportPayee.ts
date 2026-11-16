import type { Transport } from './types';

export interface TransportOwnerPayee {
  /** Shown on the receipt dialog, e.g. "Rakesh (Madhupuri Transport)". */
  name: string;
  /** The owner's WhatsApp number. Empty when the agency has none on file yet. */
  phone: string;
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
  const phone = String(t.phone || t.phone2 || '').trim();
  const person = String(t.contactPerson || '').trim();
  const agency = String(t.name || 'Transport').trim();
  return { name: person ? `${person} (${agency})` : `${agency} (Owner)`, phone };
}
