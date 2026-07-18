// Reusable table export helpers — Excel (.xlsx), PDF, and Print.
//
// The heavy libraries (exceljs, jspdf) are pulled in with dynamic import() so
// they never touch the main bundle; they only download the first time a user
// actually clicks an export button. Every page describes its table once with a
// small column spec and hands over the *full* (unpaginated, already-filtered)
// row set — see <ExportButtons /> for the shared UI.

export const COMPANY_NAME = 'RVP Industries';
export const COMPANY_TAGLINE = 'Tamarind Seed Processing';

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
// Excel
// ---------------------------------------------------------------------------

export async function exportToExcel<T>(o: ExportOptions<T>): Promise<void> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = COMPANY_NAME;
  wb.created = new Date();
  const ws = wb.addWorksheet(titleFrom(o).slice(0, 28), {
    views: [{ state: 'frozen', ySplit: o.subtitle ? 4 : 3 }],
  });

  const colCount = o.columns.length;
  const lastCol = String.fromCharCode(64 + Math.min(colCount, 26));

  // Title band
  ws.mergeCells(`A1:${lastCol}1`);
  const titleCell = ws.getCell('A1');
  titleCell.value = COMPANY_NAME + ' — ' + titleFrom(o);
  titleCell.font = { size: 14, bold: true, color: { argb: 'FFAD4F0A' } };
  titleCell.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 22;

  let headerRowIdx = 3;
  ws.mergeCells(`A2:${lastCol}2`);
  const sub = ws.getCell('A2');
  sub.value = (o.subtitle ? o.subtitle + '  ·  ' : '') + `Generated ${timestamp()}`;
  sub.font = { size: 9, italic: true, color: { argb: 'FF6B7280' } };
  if (o.subtitle) {
    // keep on one info row
  }

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
      if (r % 2 === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBF6EF' } };
      }
    });
  });

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

export async function exportToPdf<T>(o: ExportOptions<T>): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;

  const landscape = o.columns.length > 6;
  const doc = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();

  const head = [o.columns.map((c) => c.header)];
  const body = o.rows.map((row) => o.columns.map((c) => cellText(c.value(row))));

  autoTable(doc, {
    head,
    body,
    startY: o.subtitle ? 74 : 66,
    margin: { left: 32, right: 32 },
    styles: { fontSize: 8, cellPadding: 4, overflow: 'linebreak' },
    headStyles: { fillColor: [173, 79, 10], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [251, 246, 239] },
    columnStyles: Object.fromEntries(
      o.columns.map((c, i) => [i, { halign: c.align ?? (c.numFmt ? 'right' : 'left') }]),
    ),
    didDrawPage: () => {
      // Header band
      doc.setFontSize(14);
      doc.setTextColor(173, 79, 10);
      doc.setFont('helvetica', 'bold');
      doc.text(COMPANY_NAME, 32, 34);
      doc.setFontSize(11);
      doc.setTextColor(40, 40, 40);
      doc.text(titleFrom(o), 32, 50);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(120, 120, 120);
      const info = (o.subtitle ? o.subtitle + '  ·  ' : '') + `Generated ${timestamp()}`;
      doc.text(info, 32, o.subtitle ? 64 : 62);

      // Footer with page number
      const page = doc.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text(
        `${COMPANY_NAME} · ${COMPANY_TAGLINE}`,
        32,
        doc.internal.pageSize.getHeight() - 18,
      );
      doc.text(
        `Page ${page}`,
        pageWidth - 32,
        doc.internal.pageSize.getHeight() - 18,
        { align: 'right' },
      );
    },
  });

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
  const win = window.open('', '_blank', 'width=1000,height=700');
  if (!win) return;

  const cols = o.columns;
  const thead = cols
    .map((c) => `<th style="text-align:${c.align ?? (c.numFmt ? 'right' : 'left')}">${escapeHtml(c.header)}</th>`)
    .join('');
  const rows = o.rows
    .map(
      (row) =>
        '<tr>' +
        cols
          .map(
            (c) =>
              `<td style="text-align:${c.align ?? (c.numFmt ? 'right' : 'left')}">${escapeHtml(cellText(c.value(row)))}</td>`,
          )
          .join('') +
        '</tr>',
    )
    .join('');

  const info = (o.subtitle ? escapeHtml(o.subtitle) + '  ·  ' : '') + `Generated ${escapeHtml(timestamp())}`;

  win.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(o.filename)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Roboto, Arial, sans-serif; color: #1f2937; margin: 28px; }
  .brand { font-size: 20px; font-weight: 700; color: #ad4f0a; }
  .report-title { font-size: 14px; font-weight: 600; margin-top: 2px; }
  .meta { font-size: 11px; color: #6b7280; margin-top: 4px; }
  hr { border: none; border-top: 2px solid #ad4f0a; margin: 12px 0 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  thead th { background: #ad4f0a; color: #fff; padding: 7px 9px; text-align: left; }
  tbody td { padding: 6px 9px; border-bottom: 1px solid #e5e7eb; }
  tbody tr:nth-child(even) { background: #fbf6ef; }
  .foot { margin-top: 18px; font-size: 10px; color: #9ca3af; display: flex; justify-content: space-between; }
  @media print {
    body { margin: 0; }
    thead { display: table-header-group; }
    @page { margin: 14mm; }
  }
</style>
</head>
<body>
  <div class="brand">${escapeHtml(COMPANY_NAME)}</div>
  <div class="report-title">${escapeHtml(titleFrom(o))}</div>
  <div class="meta">${info}</div>
  <hr />
  <table>
    <thead><tr>${thead}</tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="foot"><span>${escapeHtml(COMPANY_NAME)} · ${escapeHtml(COMPANY_TAGLINE)}</span><span>${o.rows.length} record(s)</span></div>
  <script>window.onload = function(){ window.focus(); window.print(); };</script>
</body>
</html>`);
  win.document.close();
}
