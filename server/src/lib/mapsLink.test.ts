import { describe, expect, it } from 'vitest';
import { coordUrl, mapsUrlFor, parseLatLng, resolveLatLngFromMapsLink } from './mapsLink.js';

/**
 * These coordinates are what the driver's WhatsApp pin is built from
 * (driver_industries has a Location header). A link that reads as "no
 * coordinates" costs that driver his message; a link misread as coordinates
 * sends him to the wrong pin, which is worse. Hence both directions are pinned.
 *
 * Only the offline paths are covered - `resolveLatLngFromMapsLink` following a
 * short link is a live Google request and belongs in a manual check, not here.
 */
describe('parseLatLng', () => {
  it('reads plain coordinates typed into the party field', () => {
    expect(parseLatLng('21.132722, 72.833611')).toEqual({ lat: 21.132722, lng: 72.833611 });
    expect(parseLatLng('21.132722,72.833611')).toEqual({ lat: 21.132722, lng: 72.833611 });
  });

  it('reads coordinates out of a long maps URL without a network call', () => {
    // Colourtex - a real stored link, coordinates in the @ segment.
    expect(
      parseLatLng('https://www.google.com/maps/place/x/@21.1325133,72.8326854,17.48z/data=!4m4'),
    ).toEqual({ lat: 21.1325133, lng: 72.8326854 });
    // Krishi Nutrition - the place-page blob spells them out again as !3d/!4d.
    expect(parseLatLng('https://google.com/maps/place/y/data=!3m1!4b1!8m2!3d11.2375428!4d77.5593605')).toEqual({
      lat: 11.2375428,
      lng: 77.5593605,
    });
  });

  it('returns null for a share link that has to be followed to know', () => {
    expect(parseLatLng('https://maps.app.goo.gl/eNp31wJJXfVNtPA99')).toBeNull();
  });

  it('rejects impossible pairs rather than pinning the driver to nowhere', () => {
    expect(parseLatLng('91.5, 72.8')).toBeNull(); // past the north pole
    expect(parseLatLng('21.1, 181.2')).toBeNull();
    expect(parseLatLng('0,0')).toBeNull(); // null island - an empty field, not a place
  });

  it('is not fooled by other numbers in the field', () => {
    expect(parseLatLng('Plot 3701, Sachin GIDC')).toBeNull();
    expect(parseLatLng('')).toBeNull();
    expect(parseLatLng(null)).toBeNull();
  });

  it('resolves without touching the network when the value already has coordinates', async () => {
    await expect(resolveLatLngFromMapsLink('19.1505142,74.6902779')).resolves.toEqual({
      lat: 19.1505142,
      lng: 74.6902779,
    });
  });
});

describe('mapsUrlFor', () => {
  it('shortens a copied place URL to its coordinates', () => {
    // The 300-character link that wrapped over eight lines in the driver's message.
    const pasted =
      'https://google.com/maps/place/Krishi+Nutrition+Company+Private+Limited+office/@11.2375428,77.5593605,17z/data=!3m1!4b1!4m6!3m5!1s0x3ba96d6a4b3a30cf:0x2b803235e7b65cdc!8m2!3d11.2375428!4d77.5593605!16s%2Fg%2F11f08fyrzh?entry=tts&g_ep=EgoyMDI2MDgwMy4wIPu8ASoASAFQAw%3D%3D';
    const short = mapsUrlFor(pasted);
    expect(short).toBe('https://maps.google.com/?q=11.237543,77.55936');
    expect(short!.length).toBeLessThan(50);
  });

  it('turns bare coordinates into something the driver can tap', () => {
    expect(mapsUrlFor('21.132722, 72.833611')).toBe('https://maps.google.com/?q=21.132722,72.833611');
  });

  it('passes a share link through untouched - nothing to shorten it to', () => {
    const link = 'https://maps.app.goo.gl/cEwGDzoZK4Kdssy39?g_st=aw';
    expect(mapsUrlFor(link)).toBe(link);
  });

  it('gives nothing back for an empty field, so the slot falls to "-"', () => {
    expect(mapsUrlFor('   ')).toBeNull();
    expect(mapsUrlFor(null)).toBeNull();
  });
});

describe('coordUrl', () => {
  it('trims to six decimals without leaving trailing zeros', () => {
    expect(coordUrl({ lat: 11.2375428, lng: 77.5593605 })).toBe('https://maps.google.com/?q=11.237543,77.55936');
    expect(coordUrl({ lat: 21.13, lng: 72.8 })).toBe('https://maps.google.com/?q=21.13,72.8');
  });
});
