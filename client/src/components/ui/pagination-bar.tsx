import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PAGE_SIZE_OPTIONS } from '@/lib/usePagedRows';

interface PaginationBarProps {
  page: number;
  setPage: (page: number) => void;
  pageSize: number;
  setPageSize: (size: number) => void;
  totalPages: number;
  total: number;
}

export function PaginationBar({ page, setPage, pageSize, setPageSize, totalPages, total }: PaginationBarProps) {
  if (total === 0) return null;
  const start = pageSize === Infinity ? (total > 0 ? 1 : 0) : (page - 1) * pageSize + 1;
  const end = pageSize === Infinity ? total : Math.min(page * pageSize, total);

  return (
    <div className="flex items-center justify-between gap-4 px-1 py-2 text-sm text-muted-foreground">
      <div className="flex items-center gap-2">
        <span>Show</span>
        <Select
          value={pageSize === Infinity ? 'all' : String(pageSize)}
          onValueChange={(v) => setPageSize(v === 'all' ? Infinity : Number(v))}
        >
          <SelectTrigger size="sm" className="w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>{n}</SelectItem>
            ))}
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
        <span>entries</span>
      </div>
      <div className="flex items-center gap-3">
        <span>{start}–{end} of {total}</span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
