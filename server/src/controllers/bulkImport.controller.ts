import type { Request, Response } from 'express';
import * as XLSX from 'xlsx';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { extractBulkTableFromText, extractBulkTableFromImage, type BulkTableRow } from '../lib/gemini.js';

export async function parseBulkImport(req: Request, res: Response) {
  const type = (req.body.type ?? 'po') as 'po' | 'sale';
  const text: string | undefined = req.body.text;
  const file = req.file;

  if (!text && !file) throw new HttpError(400, 'Provide text or a file');

  let rows: BulkTableRow[] = [];

  if (file) {
    const ext = file.originalname.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'xlsx' || ext === 'csv' || ext === 'xls') {
      const wb = XLSX.read(file.buffer);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const csv = XLSX.utils.sheet_to_csv(ws);
      rows = await extractBulkTableFromText(csv, type);
    } else {
      // Image (jpg, png, webp, pdf screenshot, etc.)
      rows = await extractBulkTableFromImage(file.buffer, file.mimetype, type);
    }
  } else {
    rows = await extractBulkTableFromText(text!, type);
  }

  // Fetch all parties for the frontend dropdown
  const parties = await prisma.party.findMany({
    select: { id: true, name: true, type: true },
    orderBy: { name: 'asc' },
  });

  // Fuzzy-match each partyName to an existing party ID
  const rowsWithMatch = rows.map((row) => {
    let matchedPartyId: string | null = null;
    if (row.partyName) {
      const lower = row.partyName.toLowerCase();
      const exact = parties.find((p) => p.name.toLowerCase() === lower);
      const partial = !exact
        ? parties.find(
            (p) =>
              p.name.toLowerCase().includes(lower) ||
              lower.includes(p.name.toLowerCase())
          )
        : null;
      matchedPartyId = (exact ?? partial)?.id ?? null;
    }
    return { ...row, matchedPartyId };
  });

  res.json({ rows: rowsWithMatch, parties });
}
