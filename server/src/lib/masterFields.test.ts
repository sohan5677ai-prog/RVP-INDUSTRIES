import { describe, it, expect } from 'vitest';
import {
  approvalPermissionFor,
  diffFields,
  humanise,
  isProtectedField,
  maskAccount,
  splitByProtection,
  summarise,
} from './masterFields.js';

const PARTY = {
  id: 'p1',
  name: 'Acme Traders',
  bankAccountNumber: '1234567890',
  bankIfsc: 'HDFC0001234',
  bankName: 'HDFC Bank',
  gstin: '37AACBS0915N1ZP',
  email: 'accounts@acme.example',
  phone: '9440000000',
  city: 'Punganur',
};

describe('which fields are protected', () => {
  it('protects the fields a payment diversion would need', () => {
    expect(isProtectedField('PARTY', 'bankAccountNumber')).toBe(true);
    expect(isProtectedField('PARTY', 'bankIfsc')).toBe(true);
    expect(isProtectedField('PARTY', 'bankName')).toBe(true);
    expect(isProtectedField('PARTY', 'gstin')).toBe(true);
  });

  it('protects the email too', () => {
    // The attack this closes: change the email first so the alert about the
    // account change goes to you, then change the account.
    expect(isProtectedField('PARTY', 'email')).toBe(true);
  });

  it('leaves the fields that change legitimately and often', () => {
    // Routing these through approval would teach people to approve without
    // reading, which is how the control stops working.
    for (const f of ['name', 'phone', 'city', 'address', 'commodities']) {
      expect(isProtectedField('PARTY', f), f).toBe(false);
    }
  });

  it('protects the company bank details', () => {
    expect(isProtectedField('COMPANY', 'bankAccountNumber')).toBe(true);
    expect(isProtectedField('COMPANY', 'bankAccountName')).toBe(true);
    expect(isProtectedField('COMPANY', 'bankBranchIfsc')).toBe(true);
  });

  it('protects nothing on brokers and transports, which hold no bank details', () => {
    expect(isProtectedField('BROKER', 'name')).toBe(false);
    expect(isProtectedField('TRANSPORT', 'name')).toBe(false);
  });
});

describe('diffFields', () => {
  it('reports only what actually changed', () => {
    const changes = diffFields('PARTY', PARTY, { name: 'Acme Traders', phone: '9441111111' });
    expect(changes.map((c) => c.field)).toEqual(['phone']);
  });

  it('ignores keys that were not sent, so a partial update clears nothing', () => {
    const changes = diffFields('PARTY', PARTY, { phone: '9441111111' });
    expect(changes).toHaveLength(1);
  });

  it('treats null, undefined and empty string as the same', () => {
    // A form posting "" for an untouched optional field must not read as a
    // change from null - a history full of phantom edits is one nobody reads.
    const existing = { gstin: null, bankName: '' };
    expect(diffFields('PARTY', existing, { gstin: '' })).toEqual([]);
    expect(diffFields('PARTY', existing, { bankName: null })).toEqual([]);
    expect(diffFields('PARTY', existing, { gstin: undefined })).toEqual([]);
  });

  it('records a real clearing of a value', () => {
    const changes = diffFields('PARTY', PARTY, { bankIfsc: '' });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ oldValue: 'HDFC0001234', newValue: null, protected: true });
  });

  it('marks protected fields and labels them for a human', () => {
    const changes = diffFields('PARTY', PARTY, { bankAccountNumber: '999' });
    expect(changes[0]).toMatchObject({
      field: 'bankAccountNumber',
      label: 'Bank account number',
      oldValue: '1234567890',
      newValue: '999',
      protected: true,
    });
  });
});

describe('splitByProtection', () => {
  it('separates what can be written now from what must wait', () => {
    const changes = diffFields('PARTY', PARTY, {
      phone: '9441111111',
      city: 'Chittoor',
      bankAccountNumber: '999',
      email: 'new@acme.example',
    });
    const { immediate, needsApproval } = splitByProtection(changes);
    expect(immediate.map((c) => c.field).sort()).toEqual(['city', 'phone']);
    expect(needsApproval.map((c) => c.field).sort()).toEqual(['bankAccountNumber', 'email']);
  });
});

describe('approvalPermissionFor', () => {
  it('requires the bank permission for a bank change', () => {
    const changes = diffFields('PARTY', PARTY, { bankAccountNumber: '999' });
    expect(approvalPermissionFor('PARTY', changes)).toBe('master.party.bank.edit');
  });

  it('takes the stricter permission when a batch mixes them', () => {
    // Bundling a GSTIN change with a bank change must not let the bank change
    // through on the weaker permission.
    const changes = diffFields('PARTY', PARTY, { gstin: '27AAAAA0000A1Z5', bankAccountNumber: '999' });
    expect(approvalPermissionFor('PARTY', changes)).toBe('master.party.bank.edit');
  });

  it('uses the settings permission for company bank details', () => {
    const changes = diffFields('COMPANY', { bankAccountNumber: '1' }, { bankAccountNumber: '2' });
    expect(approvalPermissionFor('COMPANY', changes)).toBe('settings.manage');
  });
});

describe('presentation', () => {
  it('summarises a batch for the approval screen', () => {
    const changes = diffFields('PARTY', PARTY, { bankAccountNumber: '999', bankIfsc: 'ICIC0000001' });
    expect(summarise('Acme Traders', changes)).toBe('Acme Traders: bank account number, ifsc code');
  });

  it('masks an account number down to its last four', () => {
    expect(maskAccount('1234567890')).toBe('••••7890');
    expect(maskAccount(null)).toBe('(empty)');
    expect(maskAccount('123')).toBe('••••');
  });

  it('turns a column name into something readable', () => {
    expect(humanise('bankAccountNumber')).toBe('Bank account number');
    expect(humanise('pincode')).toBe('Pincode');
  });
});
