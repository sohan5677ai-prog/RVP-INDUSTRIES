/**
 * Masking a supplier's bank account on the way out (Phase 5, plan item 3).
 *
 * The exposure this closes: `listParties` returned the whole Party row to
 * anyone with `master.party.view`, which every USER has, while the narrower
 * `master.party.bank.view` and `pii.view` were enforced nowhere.
 */
import { describe, it, expect } from 'vitest';
import { maskAccountNumber, maskParty, maskParties, hasMaskableValue } from './pii.js';

describe('maskAccountNumber', () => {
  it('keeps the last four, as the plan specifies', () => {
    expect(maskAccountNumber('50100234567890')).toBe('XXXXXX7890');
  });

  it('does not reveal the length of a long account', () => {
    // A mask as long as the value tells an attacker the account length, which
    // narrows a guess. Capped at six Xs whatever the input.
    expect(maskAccountNumber('1234567890123456789')).toBe('XXXXXX6789');
    expect(maskAccountNumber('123456789')).toBe('XXXXX6789');
  });

  it('hides a short value entirely rather than revealing it as its own mask', () => {
    // Keeping "the last four" of a four-digit number would print all of it.
    expect(maskAccountNumber('1234')).toBe('XXXX');
    expect(maskAccountNumber('12')).toBe('XX');
  });

  it('treats absent and blank the same way', () => {
    expect(maskAccountNumber(null)).toBeNull();
    expect(maskAccountNumber(undefined)).toBeNull();
    expect(maskAccountNumber('   ')).toBeNull();
  });
});

describe('maskParty', () => {
  const party = {
    id: 'p1',
    name: 'KNM Agro',
    bankAccountNumber: '50100234567890',
    bankIfsc: 'HDFC0001234',
    bankName: 'HDFC Bank',
    gstin: '37AACBS0915N1ZP',
  };

  it('masks the account number and nothing else', () => {
    // The IFSC is published by the bank and the bank name is a bank; masking
    // them would make a statement unreadable while protecting nothing.
    const out = maskParty(party);
    expect(out.bankAccountNumber).toBe('XXXXXX7890');
    expect(out.bankIfsc).toBe('HDFC0001234');
    expect(out.bankName).toBe('HDFC Bank');
    expect(out.gstin).toBe('37AACBS0915N1ZP');
    expect(out.name).toBe('KNM Agro');
  });

  it('never mutates the row it was given', () => {
    // The row is a Prisma object the caller may still use; rewriting it is how
    // a mask ends up written back to the database by a later update.
    const copy = { ...party };
    maskParty(copy);
    expect(copy.bankAccountNumber).toBe('50100234567890');
  });

  it('flags whether there was anything to reveal', () => {
    expect(maskParty(party).bankMasked).toBe(true);
    expect(maskParty({ ...party, bankAccountNumber: null }).bankMasked).toBe(false);
  });

  it('leaves a row with no bank details alone', () => {
    const out = maskParty({ id: 'p2', name: 'Feroz' });
    expect(out).toEqual({ id: 'p2', name: 'Feroz', bankMasked: false });
  });

  it('masks every row in a list', () => {
    const out = maskParties([party, { ...party, id: 'p2', bankAccountNumber: '999988887777' }]);
    expect(out.map((p) => p.bankAccountNumber)).toEqual(['XXXXXX7890', 'XXXXXX7777']);
  });
});

describe('hasMaskableValue', () => {
  it('is false when there is nothing on file, so a reveal is not audited', () => {
    // "Looked at a party with no bank details" is noise, and this trail has
    // already been through one round of being mostly noise.
    expect(hasMaskableValue({ bankAccountNumber: null })).toBe(false);
    expect(hasMaskableValue({ bankAccountNumber: '  ' })).toBe(false);
    expect(hasMaskableValue({})).toBe(false);
    expect(hasMaskableValue(null)).toBe(false);
  });

  it('is true when there is something to reveal', () => {
    expect(hasMaskableValue({ bankAccountNumber: '50100234567890' })).toBe(true);
  });
});
