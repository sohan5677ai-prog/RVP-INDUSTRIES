import { describe, it, expect } from 'vitest';
import { bookingRoute } from './bookingRoute.js';

const home = 'Punganur';

describe('bookingRoute', () => {
  it('sends an outbound lorry from the factory to the order destination', () => {
    // The reply form gives one place and the order gives the destination; they
    // are the same town spelled two ways, and the register read it as a route.
    expect(
      bookingRoute({ direction: 'OUTBOUND', fromPlace: 'AHMEDNAGAR', destination: 'Ahilyanagar', home }),
    ).toEqual({ fromPlace: 'Punganur', toPlace: 'Ahilyanagar' });
  });

  it('falls back to the place the transporter named when no order destination is known', () => {
    expect(bookingRoute({ direction: 'OUTBOUND', fromPlace: 'SAHADA', home })).toEqual({
      fromPlace: 'Punganur',
      toPlace: 'SAHADA',
    });
  });

  it('brings an inbound lorry from its loading place to the factory', () => {
    expect(bookingRoute({ direction: 'INBOUND', fromPlace: 'Shahada', home })).toEqual({
      fromPlace: 'Shahada',
      toPlace: 'Punganur',
    });
  });

  it('keeps a sentence-style route the model already read correctly', () => {
    expect(
      bookingRoute({ direction: 'OUTBOUND', fromPlace: 'Punganur', toPlace: 'Surat', home }),
    ).toEqual({ fromPlace: 'Punganur', toPlace: 'Surat' });
    expect(
      bookingRoute({ direction: 'INBOUND', fromPlace: 'Sahada', toPlace: 'Punganur', home }),
    ).toEqual({ fromPlace: 'Sahada', toPlace: 'Punganur' });
  });

  it('draws no route at all when the message named no place', () => {
    expect(bookingRoute({ direction: 'OUTBOUND', home })).toEqual({
      fromPlace: null,
      toPlace: null,
    });
    expect(bookingRoute({ direction: 'OUTBOUND', fromPlace: 'Punganur', home })).toEqual({
      fromPlace: null,
      toPlace: null,
    });
  });

  it('uses the mill the company profile names', () => {
    expect(bookingRoute({ direction: 'OUTBOUND', fromPlace: 'Surat', home: 'Madanapalle' })).toEqual({
      fromPlace: 'Madanapalle',
      toPlace: 'Surat',
    });
  });
});
