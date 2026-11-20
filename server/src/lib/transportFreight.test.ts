import { describe, it, expect } from 'vitest';
import {
  freightDestinationKey,
  withAssociationFee,
  readCostItems,
  ASSOCIATION_FEE_LABEL,
} from './transportFreight.js';

describe('freightDestinationKey', () => {
  it('ignores case, spacing and punctuation', () => {
    expect(freightDestinationKey('Ausa')).toBe('AUSA');
    expect(freightDestinationKey('  ausa  ')).toBe('AUSA');
    expect(freightDestinationKey('Sil-vassa')).toBe('SILVASSA');
  });

  it('folds the renamed town onto one key', () => {
    // Ahmednagar became Ahilyanagar in 2024 and both are typed on our own
    // orders. A rate agreed for one has to answer for the other, or the same
    // lane gets two different freights depending on which spelling the office
    // used that day.
    const key = freightDestinationKey('Ahilyanagar');
    expect(freightDestinationKey('Ahmednagar')).toBe(key);
    expect(freightDestinationKey('nagar')).toBe(key);
  });

  it('folds the two spellings of Shahada', () => {
    expect(freightDestinationKey('Sahada')).toBe(freightDestinationKey('Shahada'));
  });

  it('keeps unrelated towns apart', () => {
    // The fold is a short, explicit list - not a fuzzy match. Two towns that
    // merely look alike must never share a rate.
    expect(freightDestinationKey('Surat')).not.toBe(freightDestinationKey('Barshi'));
    expect(freightDestinationKey('Latur')).not.toBe(freightDestinationKey('Ausa'));
  });

  it('answers empty for nothing', () => {
    expect(freightDestinationKey(null)).toBe('');
    expect(freightDestinationKey('   ')).toBe('');
    expect(freightDestinationKey('123')).toBe('');
  });
});

describe('withAssociationFee', () => {
  it('adds the fee when it is missing', () => {
    const out = withAssociationFee([{ label: 'Diesel advance', amount: 2000 }], 300);
    expect(out).toEqual([
      { label: 'Diesel advance', amount: 2000 },
      { label: ASSOCIATION_FEE_LABEL, amount: 300 },
    ]);
  });

  it('is idempotent - re-asserting never doubles the fee', () => {
    // This runs on every save of the freight-cost form, so a second pass that
    // added a second line would quietly double the deduction on an edited trip.
    const once = withAssociationFee([], 300);
    expect(withAssociationFee(once, 300)).toEqual(once);
  });

  it('corrects an existing line to the agreed amount', () => {
    const out = withAssociationFee([{ label: 'Lorry Association Fee', amount: 100 }], 300);
    expect(out).toEqual([{ label: ASSOCIATION_FEE_LABEL, amount: 300 }]);
  });

  it('puts the fee back when the form dropped it', () => {
    // The whole point of the feature: the fee cannot be edited away.
    expect(withAssociationFee([{ label: 'Driver expense', amount: 500 }], 300)).toContainEqual({
      label: ASSOCIATION_FEE_LABEL,
      amount: 300,
    });
  });

  it('leaves the list alone for an agency that carries no fee', () => {
    const items = [{ label: 'Diesel advance', amount: 2000 }];
    expect(withAssociationFee(items, 0)).toBe(items);
    // And does not strip a fee from a trip settled under one earlier.
    const settled = [{ label: ASSOCIATION_FEE_LABEL, amount: 300 }];
    expect(withAssociationFee(settled, 0)).toBe(settled);
  });
});

describe('readCostItems', () => {
  it('reads stored JSON into numbers, dropping unlabelled rows', () => {
    expect(
      readCostItems([
        { label: 'Diesel', amount: '2000' },
        { label: '', amount: 500 },
        { label: '  TDS  ', amount: null },
      ]),
    ).toEqual([
      { label: 'Diesel', amount: 2000 },
      { label: 'TDS', amount: 0 },
    ]);
  });

  it('answers empty for anything that is not a list', () => {
    expect(readCostItems(null)).toEqual([]);
    expect(readCostItems({})).toEqual([]);
    expect(readCostItems('[]')).toEqual([]);
  });
});
