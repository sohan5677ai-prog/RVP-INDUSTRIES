import { describe, it, expect } from 'vitest';
import { pinFromLink, resolveDestination, checkPin, PIN_TOWN_TOLERANCE_KM } from './destinationPin.js';

describe('pinFromLink', () => {
  it('reads bare coordinates, which is the best input this system gets', () => {
    const pin = pinFromLink('21.132722, 72.833611');
    expect(pin.source).toBe('BARE');
    expect(pin.point?.lat).toBeCloseTo(21.132722, 6);
    expect(pin.point?.lng).toBeCloseTo(72.833611, 6);
  });

  it('reads coordinates out of a map-view URL', () => {
    const pin = pinFromLink('https://www.google.com/maps/@21.132722,72.833611,17z');
    expect(pin.source).toBe('URL');
    expect(pin.point?.lat).toBeCloseTo(21.132722, 6);
  });

  it('does NOT follow a short link - that costs a network call', () => {
    // The whole reason pins are resolved once at save time and persisted. A
    // read path that followed redirects would make a board render dozens of
    // outbound requests on a cold instance.
    const pin = pinFromLink('https://maps.app.goo.gl/AbCdEf123');
    expect(pin.point).toBeNull();
    expect(pin.source).toBe('UNRESOLVED');
  });

  it('treats an empty or missing link as no pin', () => {
    expect(pinFromLink(null).point).toBeNull();
    expect(pinFromLink('   ').point).toBeNull();
  });
});

describe('resolveDestination', () => {
  const suratPin = { pinLat: 21.1702, pinLng: 72.8311, pinSource: 'REDIRECT' as const };

  it('prefers the order’s own snapshot over the buyer’s current pin', () => {
    // What was true when the order was taken wins - the buyer may have moved
    // their pin since, and a shipped lorry must not be re-measured.
    const resolved = resolveDestination({
      orderLocationLink: '21.0833, 72.8833',
      partyPin: suratPin,
      destinationText: 'Surat',
    });
    expect(resolved.source).toBe('BARE');
    expect(resolved.point?.lat).toBeCloseTo(21.0833, 4);
  });

  it('prefers the branch address over the head office', () => {
    const resolved = resolveDestination({
      addressPin: { pinLat: 21.0833, pinLng: 72.8833, pinSource: 'URL' },
      partyPin: suratPin,
      destinationText: 'Surat',
    });
    expect(resolved.point?.lat).toBeCloseTo(21.0833, 4);
  });

  it('falls back to the buyer’s pin', () => {
    const resolved = resolveDestination({ partyPin: suratPin, destinationText: 'Surat' });
    expect(resolved.source).toBe('REDIRECT');
    expect(resolved.point?.lat).toBeCloseTo(21.1702, 4);
  });

  it('falls back to the town table last, and says so', () => {
    const resolved = resolveDestination({ destinationText: 'Surat' });
    expect(resolved.source).toBe('TOWN_CENTRE');
    expect(resolved.placeName).toBe('Surat');
  });

  it('gives up rather than guessing when nothing locates the destination', () => {
    const resolved = resolveDestination({ destinationText: 'Somewhere nobody has typed before' });
    expect(resolved.point).toBeNull();
    expect(resolved.source).toBe('UNRESOLVED');
  });

  it('ignores a stored pin that is only half present', () => {
    const resolved = resolveDestination({
      partyPin: { pinLat: 21.17, pinLng: null, pinSource: 'URL' },
      destinationText: 'Surat',
    });
    expect(resolved.source).toBe('TOWN_CENTRE');
  });
});

describe('checkPin', () => {
  it('passes a pin near the town the order names', () => {
    // Sachin is about 10 km from Surat - a legitimate industrial estate.
    const verdict = checkPin(pinFromLink('21.0833, 72.8833'), 'Surat');
    expect(verdict.ok).toBe(true);
    expect(verdict.offByKm).toBeLessThan(PIN_TOWN_TOLERANCE_KM);
  });

  it('catches swapped latitude and longitude', () => {
    // 72.83, 21.17 instead of 21.17, 72.83 lands in the sea off Somalia - the
    // single most common way a pasted coordinate pair goes wrong.
    const verdict = checkPin(pinFromLink('72.8311, 21.1702'), 'Surat');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/outside India/i);
  });

  it('catches a pin for the wrong city entirely', () => {
    // The buyer's Surat office pasted against a Solapur delivery.
    const verdict = checkPin(pinFromLink('21.1702, 72.8311'), 'Solapur');
    expect(verdict.ok).toBe(false);
    expect(verdict.offByKm).toBeGreaterThan(PIN_TOWN_TOLERANCE_KM);
  });

  it('does not second-guess a town-centre pin against its own table', () => {
    const verdict = checkPin(resolveDestination({ destinationText: 'Surat' }), 'Surat');
    expect(verdict.ok).toBe(true);
  });

  it('has no opinion when there is no pin, or no town to compare against', () => {
    expect(checkPin({ point: null, source: 'UNRESOLVED' }, 'Surat').ok).toBe(true);
    expect(checkPin(pinFromLink('21.1702, 72.8311'), 'Nowhere in the table').ok).toBe(true);
  });
});
