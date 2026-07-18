import { useState } from 'react';
import { FileSpreadsheet, FileText, Printer, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  exportToExcel, exportToPdf, printTable,
  type ExportColumn,
} from '@/lib/export';

type ExportButtonsProps<T> = {
  /** Base file name (no extension) + default report title. */
  filename: string;
  /** Report heading. Defaults to filename. */
  title?: string;
  /** Optional sub-heading (e.g. the active filter). */
  subtitle?: string;
  columns: ExportColumn<T>[];
  /** Full, already-filtered row set to export (not just the visible page). */
  rows: T[];
  /** Button size. Defaults to 'sm'. */
  size?: 'sm' | 'xs' | 'default';
  /** Show the Print button. Defaults to true. Set false when the page has its own print view. */
  showPrint?: boolean;
  className?: string;
};

/**
 * Excel / PDF / Print action group. Drop into a page header's `actions` slot or
 * next to a table. Heavy export libs are lazy-loaded on first click, so this is
 * cheap to mount on every page. See lib/export.ts for the column spec.
 */
export function ExportButtons<T>({
  filename, title, subtitle, columns, rows, size = 'sm', showPrint = true, className,
}: ExportButtonsProps<T>) {
  const [busy, setBusy] = useState<null | 'excel' | 'pdf'>(null);

  const opts = { filename, title, subtitle, columns, rows };
  const empty = rows.length === 0;

  async function run(kind: 'excel' | 'pdf') {
    if (empty) { toast.message('Nothing to export yet.'); return; }
    setBusy(kind);
    try {
      if (kind === 'excel') await exportToExcel(opts);
      else await exportToPdf(opts);
    } catch (e) {
      toast.error(`Export failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setBusy(null);
    }
  }

  function doPrint() {
    if (empty) { toast.message('Nothing to print yet.'); return; }
    try {
      printTable(opts);
    } catch (e) {
      toast.error(`Print failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  }

  return (
    <div className={'flex items-center gap-1.5 print:hidden ' + (className ?? '')}>
      <Button
        variant="outline" size={size} onClick={() => run('excel')}
        disabled={busy !== null} title="Export to Excel (.xlsx)"
      >
        {busy === 'excel'
          ? <Loader2 className="h-4 w-4 animate-spin" />
          : <FileSpreadsheet className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />}
        <span className="hidden sm:inline">Excel</span>
      </Button>
      <Button
        variant="outline" size={size} onClick={() => run('pdf')}
        disabled={busy !== null} title="Export to PDF"
      >
        {busy === 'pdf'
          ? <Loader2 className="h-4 w-4 animate-spin" />
          : <FileText className="h-4 w-4 text-rose-600 dark:text-rose-400" />}
        <span className="hidden sm:inline">PDF</span>
      </Button>
      {showPrint && (
        <Button
          variant="outline" size={size} onClick={doPrint}
          disabled={busy !== null} title="Print"
        >
          <Printer className="h-4 w-4" />
          <span className="hidden sm:inline">Print</span>
        </Button>
      )}
    </div>
  );
}
