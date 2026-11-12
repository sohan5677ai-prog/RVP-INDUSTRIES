import { HttpError } from './httpError.js';

/**
 * Object-level ownership checks (plan item 2.3).
 *
 * The plan frames this as preventing IDOR across companies. This is a
 * single-company deployment, so there is no tenant boundary to cross — every
 * authenticated user is entitled to the company's purchases and ledgers. What
 * genuinely is per-user is small and specific: a person's own notes, their own
 * support tickets, their own sessions. Those are where changing an id in a URL
 * reaches someone else's data, and they were unguarded: the user-note
 * handlers looked a note up by id and checked only that it existed.
 *
 * **404, not 403.** Telling someone "that exists but is not yours" confirms
 * the id is real, which is information they should not have about another
 * person's note. The answer for a record that is not yours is the same as for
 * one that does not exist.
 */

export interface OwnedRecord {
  userId: string | null;
}

/**
 * Return the record, or throw, when it must belong to this user.
 *
 * `privileged` lets a role that is meant to see everything through — support
 * tickets work this way, where a developer must read tickets they did not
 * raise. It defaults to false so a caller has to opt in deliberately.
 */
export function assertOwned<T extends OwnedRecord>(
  record: T | null,
  userId: string,
  label: string,
  privileged = false
): T {
  if (!record) throw new HttpError(404, `${label} not found`);
  if (!privileged && record.userId !== userId) {
    throw new HttpError(404, `${label} not found`);
  }
  return record;
}

/** True when this role is meant to see other people's records of a kind. */
export function seesAllOf(role: string, kinds: ReadonlySet<string>, kind: string): boolean {
  return kinds.has(kind) && (role === 'DEVELOPER' || role === 'ADMIN');
}
