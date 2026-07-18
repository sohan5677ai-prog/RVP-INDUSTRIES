import { useEffect, useMemo, useState } from 'react';

export const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;

/**
 * Client-side pagination over an already-fetched row array. Slices only the
 * final rendered rows - never re-fetches or trims the underlying dataset, so
 * pages doing FIFO/running-balance math over the full history stay correct.
 */
export function usePagedRows<T>(rows: T[] | undefined, defaultPageSize: number = 50) {
  const [pageSize, setPageSize] = useState<number>(defaultPageSize);
  const [page, setPage] = useState(1);

  const total = rows?.length ?? 0;
  const totalPages = pageSize === Infinity ? 1 : Math.max(1, Math.ceil(total / pageSize));

  // Reset to page 1 whenever the row count or page size changes (e.g. a search/filter
  // narrows the list) so the user isn't stranded on a now-empty page.
  useEffect(() => {
    setPage(1);
  }, [total, pageSize]);

  const pageRows = useMemo(() => {
    if (!rows) return rows;
    if (pageSize === Infinity) return rows;
    const start = (page - 1) * pageSize;
    return rows.slice(start, start + pageSize);
  }, [rows, page, pageSize]);

  return { page, setPage, pageSize, setPageSize, totalPages, total, pageRows };
}
