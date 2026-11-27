import ExcelJS from 'exceljs';
import { HttpError } from './httpError.js';

/**
 * Turning an uploaded spreadsheet into CSV (Phase 10).
 *
 * ---------------------------------------------------------------------------
 * Why this exists at all: `xlsx` had to go
 *
 * SheetJS's `xlsx` carried a HIGH prototype-pollution advisory with **no fixed
 * version** - the package left the public npm registry, so `npm audit fix`
 * can never resolve it. It was imported in exactly one place, and that place
 * parses spreadsheets a user uploaded, which is precisely where prototype
 * pollution gets exploited. Contained blast radius, real exposure.
 *
 * `exceljs` replaces it. It was already a dependency of the client, so it is
 * not a new thing to trust.
 * ---------------------------------------------------------------------------
 *
 * One deliberate behaviour change: **legacy `.xls` is no longer accepted.**
 * ExcelJS reads the modern zipped format and CSV, not the old OLE2 binary.
 * Rather than fail obscurely on a file it cannot parse, this says what to do
 * about it. Anything saved by Excel this decade is already `.xlsx`.
 */

/** Quote a field for CSV only when it needs it. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text: string;
  if (value instanceof Date) {
    text = value.toISOString().slice(0, 10);
  } else if (typeof value === 'object') {
    // ExcelJS returns objects for formulas, rich text and hyperlinks. The
    // readable part is what the sheet shows, which is what the reader needs.
    const v = value as { result?: unknown; text?: unknown; richText?: { text: string }[] };
    if (Array.isArray(v.richText)) text = v.richText.map((r) => r.text).join('');
    else if (v.result !== undefined) text = String(v.result);
    else if (v.text !== undefined) text = String(v.text);
    else text = '';
  } else {
    text = String(value);
  }

  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The first sheet of an uploaded workbook, as CSV.
 *
 * A `.csv` upload is returned as-is: it is already CSV, and round-tripping it
 * through a spreadsheet library would only risk mangling it.
 */
export async function sheetBufferToCsv(buffer: Buffer, extension: string): Promise<string> {
  const ext = extension.toLowerCase().replace(/^\./, '');

  if (ext === 'csv') {
    return buffer.toString('utf8');
  }

  if (ext === 'xls') {
    throw new HttpError(
      400,
      'That is an old-format .xls file, which this cannot read. Open it in Excel and ' +
        'use "Save As" to make a .xlsx, then upload that.'
    );
  }

  if (ext !== 'xlsx') {
    throw new HttpError(400, `Cannot read a .${ext} file. Upload a .xlsx or .csv.`);
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new HttpError(400, 'That file could not be opened as a spreadsheet.');
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new HttpError(400, 'That workbook has no sheets.');

  const lines: string[] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    // `row.values` is 1-based with a leading hole, which is the single most
    // surprising thing about this library.
    const cells = (row.values as unknown[]).slice(1);
    lines.push(cells.map(csvCell).join(','));
  });

  return lines.join('\n');
}
