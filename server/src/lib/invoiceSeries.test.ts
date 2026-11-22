import { describe, it, expect } from 'vitest';
import { nextInvoiceSeq, maxConsumedInvoiceSeq, formatInvoiceNumber } from './invoiceSeries.js';

/** Minimal stand-in for the two aggregates the allocator reads. */
function fakeDb(maxLive: number | null, maxVoided: number | null) {
  return {
    saleDispatch: { aggregate: async () => ({ _max: { invoiceSeq: maxLive } }) },
    voidInvoiceNumber: { aggregate: async () => ({ _max: { invoiceSeq: maxVoided } }) },
  } as never;
}

describe('invoice numbering', () => {
  it('counts withdrawn numbers as consumed', async () => {
    // 186 live, 187-189 raised then cancelled: the next number is 190, not 187.
    expect(await maxConsumedInvoiceSeq(fakeDb(186, 189), 'RVP', '2026-27')).toBe(189);
    expect(await nextInvoiceSeq(fakeDb(186, 189), 'RVP', '2026-27', 1)).toBe(190);
  });

  it('never walks back into a burnt number when the live max is higher', async () => {
    expect(await nextInvoiceSeq(fakeDb(190, 189), 'RVP', '2026-27', 1)).toBe(191);
  });

  it('respects the sequence floor configured in Settings', async () => {
    expect(await nextInvoiceSeq(fakeDb(10, null), 'RVP', '2026-27', 200)).toBe(200);
    expect(await nextInvoiceSeq(fakeDb(null, null), 'URS', '2026-27', 1)).toBe(1);
  });

  it('formats the displayed number with the short financial year', () => {
    expect(formatInvoiceNumber('RVP', 190, '2026-27')).toBe('RVP/190/26-27');
    expect(formatInvoiceNumber('URS', 7, '2026-27')).toBe('URS/07/26-27');
  });
});
