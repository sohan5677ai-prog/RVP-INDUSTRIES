/**
 * Masking sensitive values on the way out of the API (Phase 5, plan item 3).
 *
 * ---------------------------------------------------------------------------
 * What this closes
 *
 * `listParties` returned the whole Party row - `bankAccountNumber` included -
 * to anyone holding `master.party.view`, which every USER has. The narrower
 * `master.party.bank.view` and `pii.view` permissions existed in the
 * permission table and were enforced *nowhere*, so the distinction already
 * modelled in the code was decorative.
 *
 * Masking happens here, on the server, before the value is serialised. Hiding
 * a field in the UI is not security: the row is in the JSON either way, and
 * the browser's network tab is one keystroke away.
 * ---------------------------------------------------------------------------
 *
 * Why only the account number, and not the IFSC or the bank name:
 *
 * An IFSC identifies a branch and is published by the bank; a bank name is a
 * bank. Neither is secret, and masking them would make a party statement
 * unreadable while protecting nothing. The account number is the part that,
 * combined with the public IFSC, lets someone move money - so it is the part
 * that gets masked. Narrow and explicable beats broad and resented.
 */

/** What a masked value looks like. Last four kept, as the plan specifies. */
export function maskAccountNumber(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  // Too short to usefully mask: show nothing rather than most of it. A
  // four-digit account would otherwise be revealed in full by its own mask.
  if (trimmed.length <= 4) return 'X'.repeat(trimmed.length);
  return `${'X'.repeat(Math.min(trimmed.length - 4, 6))}${trimmed.slice(-4)}`;
}

/** The Party fields this module masks. */
export const PARTY_MASKED_FIELDS = ['bankAccountNumber'] as const;

/**
 * True when the row carries a value that masking would change.
 *
 * Used to decide whether a reveal is worth auditing: recording "looked at a
 * party with no bank details on file" is noise, and the audit trail has
 * already been through one round of being 61% noise.
 */
export function hasMaskableValue(row: Record<string, unknown> | null | undefined): boolean {
  if (!row) return false;
  return PARTY_MASKED_FIELDS.some((f) => {
    const v = row[f];
    return typeof v === 'string' && v.trim() !== '';
  });
}

/**
 * Return a copy of a party row with its account number masked.
 *
 * A copy, not a mutation - the row may be a Prisma object the caller still
 * needs, and silently rewriting it is how a mask ends up written back to the
 * database by a later update.
 */
export function maskParty<T extends Record<string, unknown>>(
  party: T
): T & { bankMasked: boolean } {
  const out = { ...party } as Record<string, unknown>;
  for (const field of PARTY_MASKED_FIELDS) {
    if (field in out) out[field] = maskAccountNumber(out[field] as string | null);
  }
  // A flag the client can use to show a "reveal" affordance, rather than
  // guessing from the Xs. Not a permission check - the server already decided.
  out.bankMasked = hasMaskableValue(party);
  return out as T & { bankMasked: boolean };
}

export function maskParties<T extends Record<string, unknown>>(
  parties: T[]
): (T & { bankMasked: boolean })[] {
  return parties.map(maskParty);
}
