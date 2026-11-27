/**
 * Reading an uploaded spreadsheet without `xlsx` (Phase 10).
 *
 * SheetJS carried a HIGH prototype-pollution advisory with no fixed version -
 * the package left the npm registry - and it was parsing user uploads. These
 * tests exist so the replacement can be trusted with the same files.
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { sheetBufferToCsv } from './spreadsheet.js';

/** A real .xlsx in memory, so this is a round-trip and not a mock. */
async function workbook(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('xlsx', () => {
  it('reads the first sheet as CSV', async () => {
    const buf = await workbook([
      ['Party', 'Tonnes', 'Rate'],
      ['KNM Agro', 29.5, 78500],
      ['Swami Industries', 12, 81000],
    ]);
    const csv = await sheetBufferToCsv(buf, 'xlsx');
    expect(csv.split('\n')).toEqual([
      'Party,Tonnes,Rate',
      'KNM Agro,29.5,78500',
      'Swami Industries,12,81000',
    ]);
  });

  it('quotes a cell containing a comma or a quote', async () => {
    const buf = await workbook([['Note'], ['Punganur, Chittoor'], ['He said "yes"']]);
    const csv = await sheetBufferToCsv(buf, 'xlsx');
    expect(csv).toContain('"Punganur, Chittoor"');
    expect(csv).toContain('"He said ""yes"""');
  });

  it('takes only the first sheet, as the old code did', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('First').addRow(['keep me']);
    wb.addWorksheet('Second').addRow(['ignore me']);
    const csv = await sheetBufferToCsv(Buffer.from(await wb.xlsx.writeBuffer()), 'xlsx');
    expect(csv).toContain('keep me');
    expect(csv).not.toContain('ignore me');
  });

  it('refuses a file that is not a workbook, rather than failing obscurely', async () => {
    await expect(sheetBufferToCsv(Buffer.from('not a spreadsheet'), 'xlsx')).rejects.toThrow(
      /could not be opened/i
    );
  });
});

describe('csv', () => {
  it('passes it through untouched', async () => {
    // Already CSV. Round-tripping through a spreadsheet library would only
    // risk mangling it.
    const text = 'Party,Tonnes\nKNM Agro,29.5\n"Punganur, Chittoor",12';
    expect(await sheetBufferToCsv(Buffer.from(text), 'csv')).toBe(text);
  });
});

describe('what it will not read', () => {
  it('tells the user what to do about a legacy .xls', async () => {
    // The one deliberate behaviour change from dropping xlsx. An obscure
    // parse failure would be worse than a clear instruction.
    await expect(sheetBufferToCsv(Buffer.from('old'), 'xls')).rejects.toThrow(/Save As.*\.xlsx/is);
  });

  it('refuses anything else by name', async () => {
    await expect(sheetBufferToCsv(Buffer.from('x'), 'pdf')).rejects.toThrow(/\.xlsx or \.csv/i);
  });
});
