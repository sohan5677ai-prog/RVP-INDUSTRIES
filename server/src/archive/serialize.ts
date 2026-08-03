/**
 * Canonical NDJSON encoding for archive rows.
 *
 * Three rules decide whether the round-trip is lossless:
 *
 *   1. Decimal -> string. `"48210993.00"`, never the number 48210993. Prisma
 *      hands back a Decimal; letting JSON.stringify turn it into a float loses
 *      paise once values pass 2^53/100, silently and irreversibly.
 *   2. DateTime -> ISO-8601 UTC with `Z`. Never a localised string - IST is
 *      re-derived on read through lib/istDate.
 *   3. Keys sorted, `undefined` omitted, `null` explicit. Sorting makes two
 *      exports of the same year byte-identical, so checksums are reproducible
 *      and two archives can be diffed.
 */
import { Prisma } from '@prisma/client';

/** One archive row as a single canonical JSON line (no trailing newline). */
export function encodeRow(row: Record<string, unknown>): string {
  return JSON.stringify(canonicalise(row));
}

/** Inverse of `encodeRow`'s value mapping is applied at import, not here. */
export function canonicalise(value: unknown): unknown {
  // Prisma returns `null` for absent columns; `undefined` only shows up when a
  // caller has deleted a key. Both collapse to an explicit null so the shape of
  // every row in a table stays stable.
  if (value === null || value === undefined) return null;

  if (value instanceof Date) return value.toISOString();

  // toFixed() (no argument) renders the full value without exponent notation,
  // which toString() will use for very large or very small magnitudes.
  if (Prisma.Decimal.isDecimal(value)) return value.toFixed();

  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return { $bytes: value.toString('base64') };

  if (Array.isArray(value)) return value.map(canonicalise);

  if (typeof value === 'object') {
    // Json columns (billAddables, qualityAdjustments, seedCostSnapshot) land
    // here too. JSON objects are unordered by definition, so sorting their keys
    // changes nothing semantically and buys reproducibility.
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalise((value as Record<string, unknown>)[key]);
    }
    return out;
  }

  // A raw JS number reaching here is an Int column (weights in kg, counts) -
  // always inside the safe-integer range. Floats are never stored as numbers:
  // every money column is Decimal, caught above.
  return value;
}

/**
 * Canonical JSON for the manifest, so its seal hash is reproducible.
 * Pretty-printed because a human opens this file.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value), null, 2);
}
