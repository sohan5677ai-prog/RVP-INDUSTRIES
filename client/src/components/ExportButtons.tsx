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
  /**
   * Full, already-filtered row set to export (not just the visible page). Pass an
   * array when the page already holds every row, or a function (sync or async)
   * that fetches them on demand — used by server-paginated pages so the export
   * still covers the whole dataset without the page loading it all upfront.
   */
  rows: T[] | (() => T[] | Promise<T[]>);
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
  const [busy, setBusy] = useState<null | 'excel' | 'pdf' | 'print'>(null);

  // With an array we know upfront whether there's anything to export; with an
  // on-demand fetcher we only find out after resolving, so don't pre-disable.
  const resolveRows = async (): Promise<T[]> =>
    typeof rows === 'function' ? await rows() : rows;

  async function run(kind: 'excel' | 'pdf') {
    setBusy(kind);
    try {
      const data = await resolveRows();
      if (data.length === 0) { toast.message('Nothing to export yet.'); return; }
      const opts = { filename, title, subtitle, columns, rows: data };
      if (kind === 'excel') await exportToExcel(opts);
      else await exportToPdf(opts);
    } catch (e) {
      toast.error(`Export failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setBusy(null);
    }
  }

  async function doPrint() {
    setBusy('print');
    try {
      const data = await resolveRows();
      if (data.length === 0) { toast.message('Nothing to print yet.'); return; }
      printTable({ filename, title, subtitle, columns, rows: data });
    } catch (e) {
      toast.error(`Print failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setBusy(null);
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
