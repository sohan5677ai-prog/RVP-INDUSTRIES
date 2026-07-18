import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { getSupabase, storageBucket } from './supabase.js';

// Only allow a small set of document/image extensions we actually accept, so a
// user can't upload an .html/.svg that would be served inline, or an executable.
const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.gif']);

function fileFilter(
  _req: unknown,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    cb(new Error(`Unsupported file type: ${ext || '(none)'}`));
    return;
  }
  cb(null, true);
}

/** Uploads persisted to Supabase Storage (invoice files, kata slips). */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter,
});

/**
 * In-memory upload for transient files we don't persist (e.g. an invoice sent
 * to Gemini for field extraction). The buffer lives on req.file.buffer.
 */
export const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

/**
 * Uploads a parsed multer file to Supabase Storage and returns its public URL.
 * Invoice files hold customer PII and are served as capability URLs, so the
 * object name must be unguessable — a 16-byte random token, not a timestamp.
 */
export async function uploadFileToStorage(file: Express.Multer.File): Promise<string> {
  const ext = path.extname(file.originalname).toLowerCase();
  const token = crypto.randomBytes(16).toString('hex');
  const objectName = `${token}${ALLOWED_EXT.has(ext) ? ext : ''}`;

  const supabase = getSupabase();
  const bucket = storageBucket();
  const { error } = await supabase.storage
    .from(bucket)
    .upload(objectName, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);

  const { data } = supabase.storage.from(bucket).getPublicUrl(objectName);
  return data.publicUrl;
}
