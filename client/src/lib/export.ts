// Reusable table export helpers - Excel (.xlsx), PDF, and Print.
//
// The heavy libraries (exceljs, jspdf) are pulled in with dynamic import() so
// they never touch the main bundle; they only download the first time a user
// actually clicks an export button. Every page describes its table once with a
// small column spec and hands over the *full* (unpaginated, already-filtered)
// row set - see <ExportButtons /> for the shared UI.

import type { jsPDF } from 'jspdf';

export const COMPANY_NAME = 'RVP Industries';
export const COMPANY_TAGLINE = 'Tamarind Seed Processing';

/** Per-row colour cue. Used by all three exports so a status or an overdue
 *  balance reads at a glance instead of as one more line of grey text. */
export type ExportTone = 'default' | 'success' | 'warning' | 'danger' | 'muted';

/** One column of an exportable table. */
export type ExportColumn<T> = {
  /** Column heading shown in Excel/PDF/Print. */
  header: string;
  /** Display value used for PDF + Print (and Excel when `excel` is absent). */
  value: (row: T) => string | number | null | undefined;
  /**
   * Optional numeric value for Excel so the cell stays a real number
   * (sortable, sum-able) instead of a pre-formatted string. Return null to
   * fall back to `value`.
   */
  excel?: (row: T) => number | string | null | undefined;
  /** Text alignment for the column body. Defaults to 'left'. */
  align?: 'left' | 'right' | 'center';
  /** Excel number format, e.g. '#,##0.00' or '#,##0'. Implies right align. */
  numFmt?: string;
  /**
   * Sum this column into the report's totals row. Opt in only where a sum
   * actually means something - money and weights, never rates, day counts or
   * anything already averaged.
   */
  total?: boolean;
  /** Optional per-row colour cue (see ExportTone). */
  tone?: (row: T) => ExportTone;
};

export type ExportOptions<T> = {
  /** Base file name (no extension) and default report/sheet title. */
  filename: string;
  /** Report heading. Defaults to a title-cased filename. */
  title?: string;
  /** Optional sub-heading, e.g. an active filter description. */
  subtitle?: string;
  columns: ExportColumn<T>[];
  rows: T[];
};

function titleFrom(o: { title?: string; filename: string }): string {
  return o.title ?? o.filename;
}

function cellText(v: string | number | null | undefined): string {
  if (v == null) return '';
  return String(v);
}

function timestamp(): string {
  return new Date().toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Report palette - the app's "Tamarind & Bone" tokens, in the three colour
// notations the export libraries want.
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

const INK: Rgb = [37, 28, 18];          // espresso body text
const MASTHEAD: Rgb = [25, 20, 13];     // obsidian sidebar
const MASTHEAD_SUB: Rgb = [154, 137, 112];
const AMBER: Rgb = [173, 79, 10];       // tamarind primary
const CREAM: Rgb = [243, 238, 227];
const TAUPE: Rgb = [137, 122, 99];
const HAIRLINE: Rgb = [229, 217, 194];
const ZEBRA: Rgb = [250, 246, 238];
const TOTALS_BG: Rgb = [242, 230, 209];

const TONE_RGB: Record<ExportTone, Rgb> = {
  default: INK,
  success: [31, 91, 65],
  warning: [160, 100, 10],
  danger: [166, 45, 25],
  muted: TAUPE,
};

const TONE_HEX: Record<ExportTone, string> = {
  default: '#251c12',
  success: '#1f5b41',
  warning: '#a0640a',
  danger: '#a62d19',
  muted: '#897a63',
};

const TONE_ARGB: Record<ExportTone, string> = {
  default: 'FF251C12',
  success: 'FF1F5B41',
  warning: 'FFA0640A',
  danger: 'FFA62D19',
  muted: 'FF897A63',
};

// ---------------------------------------------------------------------------
// Totals row
// ---------------------------------------------------------------------------

/** Sum of a column across the export's rows. Prefers the raw `excel` number;
 *  falls back to digging the digits out of the formatted string. */
function columnTotal<T>(c: ExportColumn<T>, rows: T[]): number {
  let sum = 0;
  for (const row of rows) {
    const raw = c.excel ? c.excel(row) : c.value(row);
    const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/[^0-9.-]/g, ''));
    if (Number.isFinite(n)) sum += n;
  }
  return sum;
}

/** Format a total the way the column formats its cells - same decimal places,
 *  same currency sign - so the footer lines up with the numbers above it. */
function totalText<T>(c: ExportColumn<T>, rows: T[], sum: number): string {
  const decimals = c.numFmt?.includes('.0') ? 2 : 0;
  const sample = rows.length ? cellText(c.value(rows[0])) : '';
  const prefix = sample.includes('₹') ? '₹' : '';
  return prefix + sum.toLocaleString('en-IN', {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  });
}

/** Index of the cell that should carry the "TOTAL (n)" caption - the first
 *  column that isn't itself being summed, so the caption never overwrites a
 *  number. Returns -1 when every column is a total column. */
function totalsLabelIndex<T>(columns: ExportColumn<T>[]): number {
  return columns.findIndex((c) => !c.total);
}

/** 0-based column index -> Excel column letter (0 -> A, 26 -> AA). */
function colLetter(i: number): string {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
    s = String.fromCharCode(65 + (n % 26)) + s;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

export async function exportToExcel<T>(o: ExportOptions<T>): Promise<void> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = COMPANY_NAME;
  wb.created = new Date();
  const ws = wb.addWorksheet(titleFrom(o).slice(0, 28), {
    views: [{ state: 'frozen', ySplit: 3 }],
  });

  const lastCol = colLetter(o.columns.length - 1);

  // Title band
  ws.mergeCells(`A1:${lastCol}1`);
  const titleCell = ws.getCell('A1');
  titleCell.value = COMPANY_NAME + ' - ' + titleFrom(o);
  titleCell.font = { size: 14, bold: true, color: { argb: 'FFAD4F0A' } };
  titleCell.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 22;

  const headerRowIdx = 3;
  ws.mergeCells(`A2:${lastCol}2`);
  const sub = ws.getCell('A2');
  sub.value = (o.subtitle ? o.subtitle + '  ·  ' : '') + `Generated ${timestamp()}`;
  sub.font = { size: 9, italic: true, color: { argb: 'FF6B7280' } };

  // Header row
  const header = ws.getRow(headerRowIdx);
  o.columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFAD4F0A' } };
    cell.alignment = { horizontal: c.align ?? (c.numFmt ? 'right' : 'left'), vertical: 'middle' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
  });
  header.height = 18;

  // Data rows
  o.rows.forEach((row, r) => {
    const xlRow = ws.getRow(headerRowIdx + 1 + r);
    o.columns.forEach((c, i) => {
      const cell = xlRow.getCell(i + 1);
      const raw = c.excel ? c.excel(row) : undefined;
      if (raw != null && raw !== '') {
        const n = typeof raw === 'number' ? raw : Number(raw);
        cell.value = Number.isFinite(n) ? n : cellText(c.value(row));
      } else {
        cell.value = cellText(c.value(row));
      }
      if (c.numFmt) cell.numFmt = c.numFmt;
      cell.alignment = { horizontal: c.align ?? (c.numFmt ? 'right' : 'left') };
      const tone = c.tone?.(row) ?? 'default';
      if (tone !== 'default') cell.font = { bold: true, color: { argb: TONE_ARGB[tone] } };
      if (r % 2 === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBF6EF' } };
      }
    });
  });

  // Totals row - a real SUM cell, not a frozen number, so the sheet keeps
  // adding up if someone filters or edits it.
  if (o.columns.some((c) => c.total) && o.rows.length > 0) {
    const firstDataRow = headerRowIdx + 1;
    const lastDataRow = headerRowIdx + o.rows.length;
    const totalRow = ws.getRow(lastDataRow + 1);
    const labelIdx = totalsLabelIndex(o.columns);
    o.columns.forEach((c, i) => {
      const cell = totalRow.getCell(i + 1);
      const letter = colLetter(i);
      if (c.total) {
        cell.value = { formula: `SUM(${letter}${firstDataRow}:${letter}${lastDataRow})` };
        if (c.numFmt) cell.numFmt = c.numFmt;
      } else if (i === labelIdx) {
        cell.value = `TOTAL (${o.rows.length})`;
      }
      cell.font = { bold: true, color: { argb: 'FF251C12' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2E6D1' } };
      cell.alignment = { horizontal: c.align ?? (c.numFmt ? 'right' : 'left') };
      cell.border = { top: { style: 'medium', color: { argb: 'FFAD4F0A' } } };
    });
    totalRow.height = 18;
  }

  // Auto-fit column widths from content length (clamped).
  o.columns.forEach((c, i) => {
    let max = c.header.length;
    for (const row of o.rows) {
      const len = cellText(c.value(row)).length;
      if (len > max) max = len;
    }
    ws.getColumn(i + 1).width = Math.min(Math.max(max + 2, 10), 42);
  });

  const buf = await wb.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `${o.filename}.xlsx`,
  );
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/**
 * jsPDF's built-in Helvetica is WinAnsi-only: anything outside Latin-1 is
 * written straight through as bytes, so "₹" (U+20B9) printed as a stray "¹" and
 * - worse - autoTable measured the string at the wrong width and clipped the
 * money columns. Fold the currency sign to "Rs." and normalise the few typographic
 * characters the reports use, then drop whatever is still un-encodable.
 *
 * Inter (below) is embedded from the *latin* subset, which also stops short of
 * U+20B9, so the fold stays even with the real font in play.
 */
function pdfText(s: string): string {
  return s
    .replace(/₹\s?/g, 'Rs. ')
    .replace(/[‒—–―]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[^ -ÿ]/g, '');
}

// Inter, the app's own UI face, embedded so the reports stop looking like a
// generic Helvetica dump. Served from /public (not bundled) and fetched only
// when someone actually exports a PDF; the bytes are cached for the session.
const REPORT_FONT = 'Inter';
/** Where /public is served from. Optional-chained so the module also loads
 *  outside Vite (the export harness runs it under plain Node). */
const ASSET_BASE = import.meta.env?.BASE_URL ?? '/';
const FONT_FILES: { file: string; style: 'normal' | 'bold' }[] = [
  { file: 'Inter-Regular.ttf', style: 'normal' },
  { file: 'Inter-SemiBold.ttf', style: 'bold' },
];

let fontPromise: Promise<{ file: string; style: 'normal' | 'bold'; base64: string }[]> | null = null;

function loadReportFontFiles() {
  fontPromise ??= Promise.all(
    FONT_FILES.map(async (f) => {
      const res = await fetch(`${ASSET_BASE}fonts/${f.file}`);
      if (!res.ok) throw new Error(`font ${f.file}: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      // Chunked so a 68 KB font doesn't blow the argument limit on apply().
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return { ...f, base64: btoa(binary) };
    }),
  ).catch((err) => {
    fontPromise = null; // don't cache a failed fetch - the next click retries
    throw err;
  });
  return fontPromise;
}

/** Embed Inter into `doc` and return the family name to draw with. Falls back
 *  to the built-in Helvetica if the files can't be fetched, so an export never
 *  fails outright over a missing font. */
async function registerReportFont(doc: jsPDF): Promise<string> {
  try {
    for (const f of await loadReportFontFiles()) {
      doc.addFileToVFS(f.file, f.base64);
      doc.addFont(f.file, REPORT_FONT, f.style);
    }
    doc.setFont(REPORT_FONT, 'normal');
    return REPORT_FONT;
  } catch {
    doc.setFont('helvetica', 'normal');
    return 'helvetica';
  }
}

export async function exportToPdf<T>(o: ExportOptions<T>): Promise<void> {
  const { jsPDF: JsPdf } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;

  const landscape = o.columns.length > 6;
  const doc = new JsPdf({ orientation: landscape ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 34;

  const font = await registerReportFont(doc);

  // Wide reports (Sale Dues runs to 14 columns) have to give back some type
  // size and padding, or every other cell wraps to three lines.
  const n = o.columns.length;
  const bodySize = n > 12 ? 6.8 : n > 9 ? 7.4 : n > 6 ? 8 : 8.8;
  const padX = n > 12 ? 4 : 6;

  // Masthead geometry. The band and the meta strip repeat on every page, so a
  // page pulled out of the middle of a stack still says what it is.
  const BAND_H = 58;
  doc.setFont(font, 'normal');
  doc.setFontSize(7.6);
  const subLines: string[] = o.subtitle
    ? (doc.splitTextToSize(pdfText(o.subtitle), pageW - M * 2 - 90) as string[])
    : [];
  const metaTop = BAND_H + 20;
  const tableTop = metaTop + Math.max(subLines.length, 1) * 9.5 + 8;

  // A 14-column report cannot afford "Rs. " on five money columns - that alone
  // is what pushed the dates onto two lines. Drop the sign from the numeric
  // cells and say it once, in the footer imprint.
  const moneyCols = o.columns.map((c) => !!c.numFmt);
  const anyMoney = o.rows.length > 0
    && o.columns.some((c, i) => moneyCols[i] && cellText(c.value(o.rows[0])).includes('₹'));
  const bodyText = (c: ExportColumn<T>, i: number, row: T) => {
    const s = pdfText(cellText(c.value(row)));
    return moneyCols[i] ? s.replace(/^Rs\.\s*/, '') : s;
  };

  const head = [o.columns.map((c) => pdfText(c.header))];
  const body = o.rows.map((row) => o.columns.map((c, i) => bodyText(c, i, row)));

  const labelIdx = totalsLabelIndex(o.columns);
  const foot = o.columns.some((c) => c.total) && o.rows.length > 0
    ? [o.columns.map((c, i) => {
        if (c.total) return pdfText(totalText(c, o.rows, columnTotal(c, o.rows))).replace(/^Rs\.\s*/, '');
        return i === labelIdx ? `TOTAL (${o.rows.length})` : '';
      })]
    : undefined;

  // autoTable's own sizing spends the page evenly, which on a wide report means
  // "01 Aug 2026" breaks across two lines while a rate column sits half empty.
  // Pin every column that is naturally narrow to exactly what it needs, and let
  // the genuinely long text (customer names) share out whatever is left.
  const avail = pageW - M * 2;
  const widthOf = (text: string) => doc.getTextWidth(text);
  const natural = o.columns.map((c, i) => {
    doc.setFont(font, 'bold');
    doc.setFontSize(bodySize - 0.6);
    let w = widthOf(pdfText(c.header));
    doc.setFont(font, 'normal');
    doc.setFontSize(bodySize);
    for (const row of o.rows) w = Math.max(w, widthOf(bodyText(c, i, row)));
    if (foot) w = Math.max(w, widthOf(foot[0][i]));
    return Math.ceil(w) + padX * 2 + 2;
  });
  // Narrow enough to be worth pinning, and only if the pinned columns leave the
  // flexible ones room to breathe.
  const NARROW = 84;
  const pinned = natural.map((w) => (w <= NARROW ? w : 0));
  const flexCount = pinned.filter((w) => w === 0).length;
  const pinnedTotal = pinned.reduce((s, w) => s + w, 0);
  const usePinned = flexCount > 0 && pinnedTotal <= avail * 0.82;

  autoTable(doc, {
    head,
    body,
    foot,
    showFoot: 'lastPage',
    startY: tableTop,
    margin: { top: tableTop, left: M, right: M, bottom: 46 },
    styles: {
      font,
      fontSize: bodySize,
      cellPadding: { top: 5, right: padX, bottom: 5, left: padX },
      textColor: INK,
      lineColor: HAIRLINE,
      // Horizontal rules only. A full grid at 14 columns turns into graph paper.
      lineWidth: { top: 0, right: 0, bottom: 0.4, left: 0 },
      overflow: 'linebreak',
      valign: 'middle',
    },
    headStyles: {
      font,
      fillColor: AMBER,
      textColor: CREAM,
      fontStyle: 'bold',
      fontSize: bodySize - 0.6,
      cellPadding: { top: 7, right: padX, bottom: 7, left: padX },
      lineWidth: 0,
    },
    footStyles: {
      font,
      fillColor: TOTALS_BG,
      textColor: INK,
      fontStyle: 'bold',
      fontSize: bodySize,
      lineColor: AMBER,
      lineWidth: { top: 1.2, right: 0, bottom: 0, left: 0 },
    },
    alternateRowStyles: { fillColor: ZEBRA },
    columnStyles: Object.fromEntries(
      o.columns.map((c, i) => [i, {
        halign: c.align ?? (c.numFmt ? 'right' : 'left'),
        ...(usePinned && pinned[i] ? { cellWidth: pinned[i] } : {}),
      }]),
    ),
    didParseCell: (data) => {
      if (data.section !== 'body') return;
      const col = o.columns[data.column.index];
      const tone = col?.tone?.(o.rows[data.row.index]);
      if (tone && tone !== 'default') {
        data.cell.styles.textColor = TONE_RGB[tone];
        data.cell.styles.fontStyle = 'bold';
      }
    },
    didDrawPage: () => {
      // ---- masthead ----
      doc.setFillColor(...MASTHEAD);
      doc.rect(0, 0, pageW, BAND_H, 'F');
      doc.setFillColor(...AMBER);
      doc.rect(0, BAND_H, pageW, 2.5, 'F');

      doc.setFont(font, 'bold');
      doc.setFontSize(13);
      doc.setTextColor(...CREAM);
      doc.setCharSpace(1.4);
      doc.text(pdfText(COMPANY_NAME.toUpperCase()), M, 27);
      doc.setFont(font, 'normal');
      doc.setFontSize(6.6);
      doc.setTextColor(...MASTHEAD_SUB);
      doc.setCharSpace(1.6);
      doc.text(pdfText(COMPANY_TAGLINE.toUpperCase()), M, 41);
      doc.setCharSpace(0);

      doc.setFont(font, 'bold');
      doc.setFontSize(12);
      doc.setTextColor(...CREAM);
      doc.text(pdfText(titleFrom(o)), pageW - M, 27, { align: 'right' });
      doc.setFont(font, 'normal');
      doc.setFontSize(7);
      doc.setTextColor(...MASTHEAD_SUB);
      doc.text(pdfText(`Generated ${timestamp()}`), pageW - M, 41, { align: 'right' });

      // ---- meta strip: the active filters on the left, the count on the right
      if (subLines.length) {
        doc.setFontSize(7.6);
        doc.setTextColor(...TAUPE);
        doc.text(subLines, M, metaTop);
      }
      doc.setFont(font, 'bold');
      doc.setFontSize(7.6);
      doc.setTextColor(...AMBER);
      doc.text(
        `${o.rows.length} ${o.rows.length === 1 ? 'record' : 'records'}`,
        pageW - M, metaTop, { align: 'right' },
      );

      // ---- footer rule + imprint (page number is stamped in the pass below,
      //      once the total page count is actually known)
      doc.setDrawColor(...HAIRLINE);
      doc.setLineWidth(0.6);
      doc.line(M, pageH - 30, pageW - M, pageH - 30);
      doc.setFont(font, 'normal');
      doc.setFontSize(7);
      doc.setTextColor(...TAUPE);
      const imprint = `${COMPANY_NAME} · ${COMPANY_TAGLINE}`
        + (anyMoney ? ' · All amounts in Rs.' : '');
      doc.text(pdfText(imprint), M, pageH - 18);
    },
  });

  // "Page 2 of 5" needs the count, which only exists after the table has been
  // laid out. jsPDF's putTotalPages placeholder can't be used here: the string
  // is measured before substitution, so a right-aligned line would drift.
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont(font, 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...TAUPE);
    doc.text(`Page ${p} of ${pages}`, pageW - M, pageH - 18, { align: 'right' });
  }

  doc.save(`${o.filename}.pdf`);
}

// ---------------------------------------------------------------------------
// Print (opens a clean printable window; independent of on-screen layout)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function printTable<T>(o: ExportOptions<T>): void {
  const cols = o.columns;
  const align = (c: ExportColumn<T>) => c.align ?? (c.numFmt ? 'right' : 'left');

  const thead = cols
    .map((c) => `<th style="text-align:${align(c)}">${escapeHtml(c.header)}</th>`)
    .join('');

  const rows = o.rows
    .map((row) => {
      const tds = cols
        .map((c) => {
          const tone = c.tone?.(row) ?? 'default';
          const style = tone === 'default'
            ? ''
            : `;color:${TONE_HEX[tone]};font-weight:600`;
          return `<td style="text-align:${align(c)}${style}">${escapeHtml(cellText(c.value(row)))}</td>`;
        })
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');

  const labelIdx = totalsLabelIndex(cols);
  const tfoot = cols.some((c) => c.total) && o.rows.length > 0
    ? '<tfoot><tr>' + cols
        .map((c, i) => {
          const text = c.total
            ? totalText(c, o.rows, columnTotal(c, o.rows))
            : i === labelIdx ? `TOTAL (${o.rows.length})` : '';
          return `<td style="text-align:${align(c)}">${escapeHtml(text)}</td>`;
        })
        .join('') + '</tr></tfoot>'
    : '';

  // Absolute URL: the window is served from a blob:, against which a
  // path-absolute /fonts/... href does not resolve.
  const fontBase = new URL(`${ASSET_BASE}fonts/`, location.href).href;
  const info = (o.subtitle ? escapeHtml(o.subtitle) + '  ·  ' : '') + `Generated ${escapeHtml(timestamp())}`;
  const wide = cols.length > 8;

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(o.filename)}</title>
<style>
  @font-face { font-family: 'InterReport'; src: url('${fontBase}Inter-Regular.ttf') format('truetype'); font-weight: 400; font-display: swap; }
  @font-face { font-family: 'InterReport'; src: url('${fontBase}Inter-SemiBold.ttf') format('truetype'); font-weight: 600; font-display: swap; }
  * { box-sizing: border-box; }
  body {
    font-family: 'InterReport', 'Segoe UI', Roboto, Arial, sans-serif;
    color: #251c12; margin: 0; padding: 0 0 24px;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .masthead {
    background: #19140d; color: #f3eee3; border-bottom: 3px solid #ad4f0a;
    padding: 16px 28px 14px; display: flex; align-items: flex-start;
    justify-content: space-between; gap: 24px;
  }
  .brand { font-size: 15px; font-weight: 600; letter-spacing: .14em; }
  .tagline { font-size: 8px; font-weight: 400; letter-spacing: .2em; color: #9a8970; margin-top: 4px; }
  .rt { text-align: right; }
  .report-title { font-size: 14px; font-weight: 600; }
  .stamp { font-size: 8.5px; color: #9a8970; margin-top: 5px; }
  .meta {
    display: flex; justify-content: space-between; gap: 24px;
    padding: 10px 28px 12px; font-size: 9.5px; color: #897a63;
  }
  .count { color: #ad4f0a; font-weight: 600; white-space: nowrap; }
  .wrap { padding: 0 28px; }
  table { width: 100%; border-collapse: collapse; font-size: ${wide ? 9 : 11}px; }
  thead th {
    background: #ad4f0a; color: #f3eee3; padding: 7px 8px;
    font-weight: 600; font-size: ${wide ? 8 : 9.5}px;
    letter-spacing: .05em; text-transform: uppercase; white-space: nowrap;
  }
  tbody td { padding: 6px 8px; border-bottom: .5px solid #e5d9c2; vertical-align: middle; }
  tbody tr:nth-child(even) td { background: #faf6ee; }
  tfoot td {
    padding: 8px; background: #f2e6d1; font-weight: 600;
    color: #251c12; border-top: 1.5px solid #ad4f0a;
  }
  .foot {
    margin: 14px 28px 0; padding-top: 8px; border-top: .5px solid #e5d9c2;
    font-size: 8.5px; color: #897a63; display: flex; justify-content: space-between;
  }
  @media print {
    thead { display: table-header-group; }
    tfoot { display: table-footer-group; }
    tr { break-inside: avoid; }
    @page { margin: 10mm; size: ${wide ? 'A4 landscape' : 'A4 portrait'}; }
  }
</style>
</head>
<body>
  <div class="masthead">
    <div>
      <div class="brand">${escapeHtml(COMPANY_NAME.toUpperCase())}</div>
      <div class="tagline">${escapeHtml(COMPANY_TAGLINE.toUpperCase())}</div>
    </div>
    <div class="rt">
      <div class="report-title">${escapeHtml(titleFrom(o))}</div>
      <div class="stamp">Generated ${escapeHtml(timestamp())}</div>
    </div>
  </div>
  <div class="meta">
    <span>${o.subtitle ? escapeHtml(o.subtitle) : ''}</span>
    <span class="count">${o.rows.length} ${o.rows.length === 1 ? 'record' : 'records'}</span>
  </div>
  <div class="wrap">
    <table>
      <thead><tr>${thead}</tr></thead>
      <tbody>${rows}</tbody>
      ${tfoot}
    </table>
  </div>
  <div class="foot"><span>${escapeHtml(COMPANY_NAME)} · ${escapeHtml(COMPANY_TAGLINE)}</span><span>${escapeHtml(info)}</span></div>
  <script>window.onload = function(){ window.focus(); window.print(); };</script>
</body>
</html>`;

  // Served from a Blob URL rather than document.write(): a written-into popup
  // inherits the opener's byte decoding and rendered ₹ as mojibake.
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const win = window.open(url, '_blank', 'width=1000,height=700');
  if (!win) {
    URL.revokeObjectURL(url);
    throw new Error('Pop-up blocked - allow pop-ups for this site to print.');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
