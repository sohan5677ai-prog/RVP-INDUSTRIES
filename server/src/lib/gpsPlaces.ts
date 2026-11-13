/**
 * Coordinates for the places a lorry leaves from and goes to.
 *
 * Deliberately a small hand-kept table rather than a geocoder: the destination
 * on a sale order is free text the office types ("Surat", "Barshi", "Nagar"),
 * the list of places RVP actually ships to is short and changes a few times a
 * year, and a wrong auto-geocode would put a confident, false "142 km to go"
 * on the dispatch board. An unknown destination simply shows no ETA, which is
 * honest.
 *
 * To add a destination: put its town centre here, lower case, plus any spelling
 * the office uses. `resolvePlace` matches on a normalised, space-stripped key
 * and then on a substring, so "surat (sachin)" still finds Surat.
 */
export interface Place {
  name: string;
  latitude: number;
  longitude: number;
}

/**
 * Our own gate. Everything outbound starts here, and it is the origin for
 * every "km from the factory" and the start of every consignment's progress
 * bar - so it is the mill itself (New Bypass Road, Kummaranatham Village,
 * Punganur, Chittoor), not the town centre, and it matches the address on
 * CompanyProfile.
 */
export const FACTORY: Place = { name: 'RVP Industries, Punganur', latitude: 13.3658707, longitude: 78.5882473 };

const PLACES: Record<string, Place> = {
  punganur: FACTORY,
  kummaranatham: FACTORY,
  rvp: FACTORY,
  chittoor: { name: 'Chittoor', latitude: 13.2172, longitude: 79.1003 },
  raichur: { name: 'Raichur', latitude: 16.2120, longitude: 77.3439 },
  madanapalle: { name: 'Madanapalle', latitude: 13.5503, longitude: 78.5029 },
  tirupati: { name: 'Tirupati', latitude: 13.6288, longitude: 79.4192 },
  chikkaballapur: { name: 'Chikkaballapur', latitude: 13.4355, longitude: 77.7315 },
  hosur: { name: 'Hosur', latitude: 12.7409, longitude: 77.8253 },
  vellore: { name: 'Vellore', latitude: 12.9165, longitude: 79.1325 },
  surat: { name: 'Surat', latitude: 21.1702, longitude: 72.8311 },
  sachin: { name: 'Sachin, Surat', latitude: 21.0833, longitude: 72.8833 },
  barshi: { name: 'Barshi', latitude: 18.2333, longitude: 75.6833 },
  nagar: { name: 'Ahmednagar', latitude: 19.0948, longitude: 74.7480 },
  ahmednagar: { name: 'Ahmednagar', latitude: 19.0948, longitude: 74.7480 },
  solapur: { name: 'Solapur', latitude: 17.6599, longitude: 75.9064 },
  sholapur: { name: 'Solapur', latitude: 17.6599, longitude: 75.9064 },
  pune: { name: 'Pune', latitude: 18.5204, longitude: 73.8567 },
  hyderabad: { name: 'Hyderabad', latitude: 17.3850, longitude: 78.4867 },
  bengaluru: { name: 'Bengaluru', latitude: 12.9716, longitude: 77.5946 },
  bangalore: { name: 'Bengaluru', latitude: 12.9716, longitude: 77.5946 },
  hubli: { name: 'Hubballi', latitude: 15.3647, longitude: 75.1240 },
  hubballi: { name: 'Hubballi', latitude: 15.3647, longitude: 75.1240 },
  belgaum: { name: 'Belagavi', latitude: 15.8497, longitude: 74.4977 },
  belagavi: { name: 'Belagavi', latitude: 15.8497, longitude: 74.4977 },
  kolhapur: { name: 'Kolhapur', latitude: 16.7050, longitude: 74.2433 },
  sangli: { name: 'Sangli', latitude: 16.8524, longitude: 74.5815 },
  latur: { name: 'Latur', latitude: 18.4088, longitude: 76.5604 },
  nanded: { name: 'Nanded', latitude: 19.1383, longitude: 77.3210 },
  akola: { name: 'Akola', latitude: 20.7002, longitude: 77.0082 },
  nagpur: { name: 'Nagpur', latitude: 21.1458, longitude: 79.0882 },
  indore: { name: 'Indore', latitude: 22.7196, longitude: 75.8577 },
  ahmedabad: { name: 'Ahmedabad', latitude: 23.0225, longitude: 72.5714 },
  rajkot: { name: 'Rajkot', latitude: 22.3039, longitude: 70.8022 },
  gandhidham: { name: 'Gandhidham', latitude: 23.0753, longitude: 70.1337 },
  vijayawada: { name: 'Vijayawada', latitude: 16.5062, longitude: 80.6480 },
  guntur: { name: 'Guntur', latitude: 16.3067, longitude: 80.4365 },
  chennai: { name: 'Chennai', latitude: 13.0827, longitude: 80.2707 },
  erode: { name: 'Erode', latitude: 11.3410, longitude: 77.7172 },
  salem: { name: 'Salem', latitude: 11.6643, longitude: 78.1460 },
  coimbatore: { name: 'Coimbatore', latitude: 11.0168, longitude: 76.9558 },
  namakkal: { name: 'Namakkal', latitude: 11.2189, longitude: 78.1677 },
  bellary: { name: 'Ballari', latitude: 15.1394, longitude: 76.9214 },
  ballari: { name: 'Ballari', latitude: 15.1394, longitude: 76.9214 },
  sindhanur: { name: 'Sindhanur', latitude: 15.7690, longitude: 76.7560 },
  gangavathi: { name: 'Gangavathi', latitude: 15.4311, longitude: 76.5308 },
  koppal: { name: 'Koppal', latitude: 15.3547, longitude: 76.1548 },
  kurnool: { name: 'Kurnool', latitude: 15.8281, longitude: 78.0373 },
};

function key(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '');
}

/** Best guess at where a free-text destination is, or null if we do not know. */
export function resolvePlace(destination: string | null | undefined): Place | null {
  if (!destination) return null;
  const k = key(destination);
  if (!k) return null;
  if (PLACES[k]) return PLACES[k];
  // "surat (sachin)", "near solapur": the most specific known place named
  // inside the text. Longest key wins, so "surat sachin" resolves to the
  // Sachin estate rather than to Surat city, which is 10 km away and the
  // difference between "arriving" and "arrived".
  let best: Place | null = null;
  let bestLength = 0;
  for (const [name, place] of Object.entries(PLACES)) {
    if (k.includes(name) && name.length > bestLength) {
      best = place;
      bestLength = name.length;
    }
  }
  return best;
}

/** Great-circle kilometres between two points. */
export function kmBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLng = (bLng - aLng) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Straight-line kilometres understate a road trip. 1.25 is the usual ratio on
 * Indian highways and is good enough for "will it reach tomorrow"; anything
 * more precise would need a routing API and a bill.
 */
export const ROAD_FACTOR = 1.25;

/** Working average for a loaded lorry, including the halts a driver takes. */
export const AVG_LORRY_KMPH = 40;
