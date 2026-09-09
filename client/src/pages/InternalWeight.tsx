import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Scale, Phone, Pencil, Check, X, Search } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { SaleOrder } from '@/lib/types';
import { shortDate, toTonnes } from '@/lib/format';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/PageHeader';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { usePagedRows } from '@/lib/usePagedRows';
import { cn } from '@/lib/utils';
import ScaleCaptureButton from '@/components/ScaleCaptureButton';

/** A single flattened row: one dispatch with its parent order info inlined. */
interface WeightRow {
  dispatchId: string;
  dispatchDate: string;
  partyName: string;
  vehicleNumber: string | null;
  weightKg: number;           // dispatched weight (RVP kata)
  internalWeightKg: number | null;
  buyerKataKg: number | null; // delivered weight (buyer kata)
  driverName: string | null;
  driverPhone: string | null;
  status: string;
}

function getDeliveredDiff(buyerKataKg: number | null, internalWeightKg: number | null): {
  text: string;
  diffKg: number | null;
  tone: 'green' | 'red' | 'neutral' | 'empty';
} {
  if (buyerKataKg == null || internalWeightKg == null) {
    return { text: '-', diffKg: null, tone: 'empty' };
  }
  const diffKg = buyerKataKg - internalWeightKg;
  const diffT = diffKg / 1000;
  const sign = diffT > 0 ? '+' : '';
  const text = `${sign}${diffT.toFixed(2)}`;
  if (diffKg > 0) return { text, diffKg, tone: 'green' };
  if (diffKg < 0) return { text, diffKg, tone: 'red' };
  return { text, diffKg, tone: 'neutral' };
}

export default function InternalWeight() {
  const qc = useQueryClient();

  // Fetch all pappu orders with dispatches
  const { data: orders, isLoading } = useQuery<SaleOrder[]>({
    queryKey: ['sale-orders', 'PAPPU', 'all'],
    queryFn: () => api<SaleOrder[]>('/sale-orders?product=PAPPU&all=true'),
  });

  // ── Filters ────────────────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // ── Flatten dispatches into rows ───────────────────────────────────────────
  const allRows: WeightRow[] = useMemo(() => {
    if (!orders) return [];
    const rows: WeightRow[] = [];
    for (const o of orders) {
      for (const d of o.dispatches ?? []) {
        rows.push({
          dispatchId: d.id,
          dispatchDate: d.dispatchDate,
          partyName: o.buyer?.name ?? '-',
          vehicleNumber: d.vehicleNumber,
          weightKg: d.weightKg,
          internalWeightKg: d.internalWeightKg ?? null,
          buyerKataKg: d.buyerKataKg ?? null,
          driverName: d.driverName ?? null,
          driverPhone: d.driverPhone ?? null,
          status: d.status,
        });
      }
    }
    // Newest first
    rows.sort((a, b) => new Date(b.dispatchDate).getTime() - new Date(a.dispatchDate).getTime());
    return rows;
  }, [orders]);

  // Apply filters
  const filtered = useMemo(() => {
    let rows = allRows;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(
        (r) =>
          r.partyName.toLowerCase().includes(q) ||
          (r.vehicleNumber ?? '').toLowerCase().includes(q) ||
          (r.driverName ?? '').toLowerCase().includes(q),
      );
    }
    if (fromDate) {
      rows = rows.filter((r) => r.dispatchDate.slice(0, 10) >= fromDate);
    }
    if (toDate) {
      rows = rows.filter((r) => r.dispatchDate.slice(0, 10) <= toDate);
    }
    return rows;
  }, [allRows, search, fromDate, toDate]);

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows } = usePagedRows(filtered, 50);

  // ── Inline edit state ──────────────────────────────────────────────────────
  const [editId, setEditId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const startEdit = (row: WeightRow) => {
    setEditId(row.dispatchId);
    setEditValue(row.internalWeightKg != null ? toTonnes(row.internalWeightKg).toFixed(3) : '');
  };

  const cancelEdit = () => {
    setEditId(null);
    setEditValue('');
  };

  const updateMut = useMutation({
    mutationFn: async ({ id, kg }: { id: string; kg: number }) =>
      api(`/sale-dispatches/${id}/internal-weight`, {
        method: 'PATCH',
        body: { internalWeightKg: kg },
      }),
    onSuccess: () => {
      toast.success('Internal weight updated');
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      cancelEdit();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const saveEdit = (dispatchId: string) => {
    const num = Number(editValue);
    if (!editValue.trim() || isNaN(num) || num <= 0) {
      toast.error('Enter a valid weight in tonnes');
      return;
    }
    const kg = Math.round(num * 1000);
    updateMut.mutate({ id: dispatchId, kg });
  };

  // ── Summary stats ─────────────────────────────────────────────────────────
  const totalDispatched = filtered.reduce((s, r) => s + r.weightKg, 0);
  const totalInternal = filtered.reduce((s, r) => s + (r.internalWeightKg ?? 0), 0);
  const deliveredWithInternal = filtered.filter(
    (r) => r.buyerKataKg != null && r.internalWeightKg != null,
  );
  const totalDeliveredDiff = deliveredWithInternal.reduce(
    (s, r) => s + (r.buyerKataKg! - r.internalWeightKg!),
    0,
  );

  // ── Export columns ─────────────────────────────────────────────────────────
  const exportCols: ExportColumn<WeightRow>[] = [
    { header: 'Date', value: (r) => shortDate(r.dispatchDate) },
    { header: 'Party Name', value: (r) => r.partyName },
    { header: 'Lorry Number', value: (r) => r.vehicleNumber ?? '-' },
    { header: 'Dispatched (t)', value: (r) => toTonnes(r.weightKg).toFixed(2), align: 'right' },
    { header: 'Internal (t)', value: (r) => r.internalWeightKg != null ? toTonnes(r.internalWeightKg).toFixed(2) : '-', align: 'right' },
    { header: 'Delivered (t)', value: (r) => r.buyerKataKg != null ? toTonnes(r.buyerKataKg).toFixed(2) : '-', align: 'right' },
    { header: 'Difference (t)', value: (r) => getDeliveredDiff(r.buyerKataKg, r.internalWeightKg).text, align: 'right' },
    { header: 'Driver', value: (r) => r.driverName ?? '-' },
    { header: 'Driver Phone', value: (r) => r.driverPhone ?? '-' },
    { header: 'Status', value: (r) => r.status },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Internal Weight"
        description="Track and edit internal weights for all Pappu dispatches"
        icon={Scale}
        actions={
          <ExportButtons
            filename="Internal_Weight"
            title="Internal Weight Report"
            columns={exportCols}
            rows={filtered}
          />
        }
      />

      {/* ── Summary cards ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground font-medium">Dispatches</p>
          <p className="text-2xl font-bold tabular-nums">{filtered.length}</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground font-medium">Total Dispatched</p>
          <p className="text-2xl font-bold tabular-nums">{toTonnes(totalDispatched).toFixed(2)} t</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground font-medium">Total Internal</p>
          <p className="text-2xl font-bold tabular-nums">{toTonnes(totalInternal).toFixed(2)} t</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground font-medium">Total Delivered Diff</p>
          <p className={cn(
            "text-2xl font-bold tabular-nums",
            totalDeliveredDiff > 0 && "text-emerald-600 dark:text-emerald-400",
            totalDeliveredDiff < 0 && "text-rose-600 dark:text-rose-400",
            deliveredWithInternal.length === 0 && "text-muted-foreground",
          )}>
            {deliveredWithInternal.length > 0
              ? `${totalDeliveredDiff > 0 ? '+' : ''}${toTonnes(totalDeliveredDiff).toFixed(2)} t`
              : '-'}
          </p>
        </div>
      </div>

      {/* ── Filters ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search party, lorry, driver…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-muted-foreground">From</label>
          <Input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="w-36"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-muted-foreground">To</label>
          <Input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="w-36"
          />
        </div>
      </div>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">Date</TableHead>
                <TableHead>Party Name</TableHead>
                <TableHead className="w-36">Lorry Number</TableHead>
                <TableHead className="text-right w-32">Dispatched (t)</TableHead>
                <TableHead className="text-right w-44">Internal (t)</TableHead>
                <TableHead className="text-right w-32">Delivered (t)</TableHead>
                <TableHead className="text-right w-28">Diff (t)</TableHead>
                <TableHead className="w-36">Driver Phone</TableHead>
                <TableHead className="w-20 text-center">Call</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : (pageRows ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">
                    No dispatches found
                  </TableCell>
                </TableRow>
              ) : (
                (pageRows ?? []).map((r) => (
                  <TableRow key={r.dispatchId} className="group">
                    <TableCell className="whitespace-nowrap text-sm">{shortDate(r.dispatchDate)}</TableCell>
                    <TableCell className="font-medium text-sm">{r.partyName}</TableCell>
                    <TableCell className="font-mono text-sm">{r.vehicleNumber ?? '-'}</TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">
                      {toTonnes(r.weightKg).toFixed(2)}
                    </TableCell>

                    {/* ── Internal weight (editable) ─────────────────────── */}
                    <TableCell className="text-right">
                      {editId === r.dispatchId ? (
                        <div className="flex items-center justify-end gap-1">
                          <Input
                            type="number"
                            step="0.001"
                            min="0"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveEdit(r.dispatchId);
                              if (e.key === 'Escape') cancelEdit();
                            }}
                            className="w-28 h-8 text-right font-mono text-sm"
                            autoFocus
                          />
                          <ScaleCaptureButton
                            unit="tonnes"
                            tonnesDecimals={3}
                            size="sm"
                            onCapture={(_val, formatted) => setEditValue(formatted)}
                          />
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => saveEdit(r.dispatchId)}
                            disabled={updateMut.isPending}
                            className="h-7 w-7 p-0 text-green-600 hover:text-green-700 hover:bg-green-100 dark:hover:bg-green-900/30"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={cancelEdit}
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-end gap-1">
                          <span className="font-mono text-sm tabular-nums">
                            {r.internalWeightKg != null ? toTonnes(r.internalWeightKg).toFixed(2) : '-'}
                          </span>
                          <button
                            type="button"
                            onClick={() => startEdit(r)}
                            title="Edit internal weight"
                            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </TableCell>

                    <TableCell className="text-right font-mono text-sm tabular-nums">
                      {r.buyerKataKg != null ? toTonnes(r.buyerKataKg).toFixed(2) : (
                        <span className="text-muted-foreground/60">-</span>
                      )}
                    </TableCell>
                    {(() => {
                      const diff = getDeliveredDiff(r.buyerKataKg, r.internalWeightKg);
                      return (
                        <TableCell className={cn(
                          'text-right font-mono text-sm tabular-nums',
                          diff.tone === 'green' && 'text-emerald-600 dark:text-emerald-400 font-semibold',
                          diff.tone === 'red' && 'text-rose-600 dark:text-rose-400 font-semibold',
                          diff.tone === 'empty' && 'text-muted-foreground/60',
                        )}>
                          {diff.text}
                        </TableCell>
                      );
                    })()}
                    <TableCell className="text-sm">
                      {r.driverPhone ? (
                        <span className="font-mono">{r.driverPhone}</span>
                      ) : (
                        <span className="text-muted-foreground/60">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      {r.driverPhone ? (
                        <a
                          href={`tel:${r.driverPhone}`}
                          onClick={(e) => e.stopPropagation()}
                          className={cn(
                            'inline-flex items-center justify-center h-8 w-8 rounded-full',
                            'bg-green-500/10 text-green-600 hover:bg-green-500/20 dark:text-green-400',
                            'transition-colors',
                          )}
                          title={`Call ${r.driverName ?? 'driver'}`}
                        >
                          <Phone className="h-4 w-4" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground/40">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* ── Pagination ────────────────────────────────────────────────── */}
      {total > 0 && (
        <PaginationBar
          page={page}
          setPage={setPage}
          pageSize={pageSize}
          setPageSize={setPageSize}
          totalPages={totalPages}
          total={total}
        />
      )}
    </div>
  );
}
