import { getSupabase, storageBucket } from './supabase.js';
import { objectNameFromStored } from './fileAccessToken.js';
import { logger } from './logger.js';

/**
 * Read one of our own stored files back as a Buffer, server-side.
 *
 * Every row in the database still holds the `getPublicUrl` link the upload
 * returned, and the invoices bucket is PRIVATE since Phase 5 - so a plain
 * `fetch` of that stored value now gets a 400 "Bucket not found". Anything the
 * client sees is fine, because fileUrlRewrite swaps those values for signed
 * /api/files links on the way out; but code running *inside* the server reads
 * the column directly and has nothing to swap it with. That is what emptied
 * the two CCTV photos on the server-rendered Kata slip - the one WhatsApp
 * sends and the one the purchase statement PDF embeds.
 *
 * Minting a link and fetching our own endpoint would work, and would be
 * wrong: it leaves the API, comes back through Render's billed outbound
 * traffic and hits a 60-second redirect, all to read a file we have
 * service-role access to. So go straight to storage.
 *
 * Returns null - never throws - when the value is not one of our objects or
 * the object is gone, so a caller can fall back or simply leave the box blank.
 */
export async function readStoredFile(
  stored: string | null | undefined
): Promise<Buffer | null> {
  const objectName = objectNameFromStored(stored);
  if (!objectName) return null;

  try {
    const { data, error } = await getSupabase()
      .storage.from(storageBucket())
      .download(objectName);
    if (error || !data) {
      logger.warn(`[storage] download failed for ${objectName}: ${error?.message ?? 'no data'}`);
      return null;
    }
    const buf = Buffer.from(await data.arrayBuffer());
    return buf.length > 0 ? buf : null;
  } catch (err: any) {
    logger.warn(`[storage] download threw for ${objectName}: ${err?.message ?? err}`);
    return null;
  }
}

/** True when this value is one of our own stored objects. */
export function isStoredFile(stored: string | null | undefined): boolean {
  return objectNameFromStored(stored) !== null;
}
