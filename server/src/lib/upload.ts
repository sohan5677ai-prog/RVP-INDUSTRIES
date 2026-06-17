import path from 'node:path';
import fs from 'node:fs';
import multer from 'multer';

const uploadsDir = path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9]/gi, '_').slice(0, 40);
    cb(null, `${Date.now()}-${base}${ext}`);
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
