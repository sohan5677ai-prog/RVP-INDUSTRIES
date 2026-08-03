/**
 * CRC-32 (IEEE 802.3), required by the zip central directory.
 *
 * node:zlib gained a `crc32` export in Node 20.15/22.2, but Render's image and
 * the office machines aren't pinned to those, and a wrong-by-omission checksum
 * would only surface as a corrupt archive months later. 20 lines is cheaper than
 * that risk.
 */

const TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** Rolling CRC-32. Pass the previous result back in to continue a stream. */
export function crc32(chunk: Buffer, previous = 0): number {
  let c = ~previous;
  for (let i = 0; i < chunk.length; i++) {
    c = TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
  }
  return ~c >>> 0;
}
