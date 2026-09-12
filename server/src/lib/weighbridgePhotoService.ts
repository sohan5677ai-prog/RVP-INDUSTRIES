import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCameraSnapshot } from './cctvService.js';
import { uploadBufferToStorage } from './upload.js';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_DIR = path.resolve(__dirname, '../../uploads/weighbridge');

// Ensure local directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

/**
 * Capture and store a camera snapshot for a weighbridge ticket.
 * Accepts optional base64 from the client; falls back to server-side camera snapshot.
 * Saves to local disk AND attempts cloud upload to Supabase Storage.
 */
export async function saveWeighbridgeSnapshot(
  ticketNo: number,
  camNum: 1 | 2,
  clientBase64?: string | null,
  isSecondWeight: boolean = false
): Promise<string | null> {
  let buffer: Buffer | null = null;

  // 1. Try client-supplied base64 snapshot (captured at the instant user pressed Save)
  if (clientBase64 && typeof clientBase64 === 'string') {
    try {
      const cleanBase64 = clientBase64.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(cleanBase64, 'base64');
      if (buf.length > 500) {
        buffer = buf;
      }
    } catch (err) {
      logger.warn(`[weighbridge] Failed to parse client base64 for Cam ${camNum}:`, err);
    }
  }

  // 2. If client didn't supply frame or parsing failed, capture from server CCTV feed
  if (!buffer) {
    try {
      buffer = await getCameraSnapshot(camNum);
    } catch (err: any) {
      logger.warn(`[weighbridge] Could not fetch server snapshot for Cam ${camNum} on ticket #${ticketNo}:`, err.message);
    }
  }

  if (!buffer || buffer.length < 500) {
    logger.warn(`[weighbridge] No valid snapshot buffer for ticket #${ticketNo} Cam ${camNum}`);
    return null;
  }

  const prefix = isSecondWeight ? 'second_' : '';
  const timestamp = Date.now();
  const filename = `ticket_${ticketNo}_${prefix}cam${camNum}_${timestamp}.jpg`;
  const localFilePath = path.join(UPLOADS_DIR, filename);

  // 3. Save to local disk
  try {
    fs.writeFileSync(localFilePath, buffer);
  } catch (err) {
    logger.error(`[weighbridge] Failed to write local snapshot file ${localFilePath}:`, err);
  }

  // 4. Try upload to Supabase storage for cloud persistence across devices
  try {
    const supabaseUrl = await uploadBufferToStorage(buffer, 'image/jpeg', '.jpg');
    if (supabaseUrl) {
      return supabaseUrl;
    }
  } catch (err: any) {
    logger.warn(`[weighbridge] Supabase storage upload failed for ticket #${ticketNo} Cam ${camNum}, falling back to local URL:`, err.message);
  }

  // Fallback to local endpoint
  return `/api/weighbridge/snapshots/${filename}`;
}

export function getLocalSnapshotPath(filename: string): string | null {
  // Sanitize filename to prevent path traversal
  const sanitized = path.basename(filename);
  const filePath = path.join(UPLOADS_DIR, sanitized);
  if (fs.existsSync(filePath)) {
    return filePath;
  }
  return null;
}
