import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import multer from 'multer';

const uploadsDir = path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

// Only allow a small set of document/image extensions we actually accept, so a
// user can't upload an .html/.svg that would be served inline, or an executable.
const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.gif']);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const rawExt = path.extname(file.originalname).toLowerCase();
    const ext = ALLOWED_EXT.has(rawExt) ? rawExt : '';
    // Invoice files hold customer PII and are served as capability URLs, so the
    // filename must be unguessable — a 16-byte random token, not a timestamp.
    const token = crypto.randomBytes(16).toString('hex');
    cb(null, `${token}${ext}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

/**
 * In-memory upload for transient files we don't persist (e.g. an invoice sent
 * to Gemini for field extraction). The buffer lives on req.file.buffer.
 */
export const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

/** Public URL path for an uploaded file. */
export function fileUrl(filename: string): string {
  return `/uploads/${filename}`;
}
