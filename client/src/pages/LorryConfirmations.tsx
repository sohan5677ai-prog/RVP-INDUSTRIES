import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import { usePagedRows } from '@/lib/usePagedRows';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { SearchInput } from '@/components/ui/search-input';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import type { LorryConfirmation } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Segmented } from '@/components/ui/segmented';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2, Truck, Hourglass, MessageCircle, Pencil, X, Undo2, CheckCircle2 } from 'lucide-react';

type RegisterFilter = 'WAITING' | 'USED' | 'DISMISSED' | 'ALL';

/** WAITING/USED are the current states; DRAFT/CONFIRMED are their legacy names. */
function isWaiting(r: LorryConfirmation) {
  return r.status === 'WAITING' || r.status === 'DRAFT';
}
function isUsed(r: LorryConfirmation) {
  return r.status === 'USED' || r.status === 'CONFIRMED';
}

/** The date the booking is filed under - what the message said, else when it arrived. */
function bookingDate(r: LorryConfirmation) {
  return r.messageDate ?? r.createdAt;
}

function freightOf(r: LorryConfirmation): number | null {
  if (r.freightAmount == null || r.freightAmount === '') return null;
  const n = Number(r.freightAmount);
  return Number.isFinite(n) ? n : null;
}

/**
 * The lorry-booking register.
 *
 * Every transport message that lands on the WhatsApp number is parsed into a row
 * here - date, lorry, tonnage, driver, phone, freight - and sits WAITING until a
 * dispatch is raised on that lorry number, at which point it flips to USED and
 * names the shipment it went out on. Nothing here rewrites a dispatch: the row's
 * only reach into the rest of the ERP is filling the driver's name and phone on
 * the dispatch screen when the lorry number is typed.
 */
export default function LorryConfirmations() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<RegisterFilter>('WAITING');
  const [search, setSearch] = useState('');
  const [editTarget, setEditTarget] = useState<LorryConfirmation | null>(null);

  const { data: rows, isLoading } = useQuery({
    queryKey: ['lorry-confirmations', filter],
    queryFn: () => api<LorryConfirmation[]>(`/whatsapp/transport-confirmations?status=${filter}`),
    // Bookings arrive from outside the app, so the list has to come to the user.
    refetchInterval: 60_000,
  });

  // The waiting count drives the tab badge in Freight Dues, so it's always read
  // regardless of which filter is showing.
  const { data: waiting } = useQuery({
    queryKey: ['lorry-confirmations', 'WAITING'],
    queryFn: () => api<LorryConfirmation[]>('/whatsapp/transport-confirmations?status=WAITING'),
    refetchInterval: 60_000,
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows ?? [];
    const qNorm = q.replace(/[^a-z0-9]/g, '');
    return (rows ?? []).filter((r) => {
      const lorry = (r.lorryNumber ?? '').toLowerCase();
      const lorryNorm = lorry.replace(/[^a-z0-9]/g, '');
      const driver = (r.driverName ?? '').toLowerCase();
      const phone = (r.driverPhone ?? '').replace(/\D/g, '');
      const route = `${r.fromPlace ?? ''} ${r.toPlace ?? ''}`.toLowerCase();
      const buyer = (r.dispatch?.buyer ?? '').toLowerCase();
      return (
        lorry.includes(q) ||
        (qNorm !== '' && lorryNorm.includes(qNorm)) ||
        driver.includes(q) ||
        (qNorm !== '' && phone.includes(qNorm)) ||
        route.includes(q) ||
        buyer.includes(q)
      );
    });
  }, [rows, search]);

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows: visible = [] } = usePagedRows(filtered, 50);

  const dismissMutation = useMutation({
    mutationFn: (id: string) => api(`/whatsapp/transport-confirmations/${id}/dismiss`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lorry-confirmations'] });
      toast.success('Booking dismissed');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const restoreMutation = useMutation({
    mutationFn: (id: string) => api(`/whatsapp/transport-confirmations/${id}/restore`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lorry-confirmations'] });
      toast.success('Back on the waiting list');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const waitingCount = waiting?.length ?? 0;
  const waitingTonnes = (waiting ?? []).reduce((s, r) => s + (r.tonnageKg ?? 0), 0) / 1000;
  const waitingFreight = (waiting ?? []).reduce((s, r) => s + (freightOf(r) ?? 0), 0);

  const exportColumns: ExportColumn<LorryConfirmation>[] = [
    { header: 'Date', value: (r) => shortDate(bookingDate(r)) },
    { header: 'Lorry No', value: (r) => r.lorryNumber ?? '' },
    { header: 'Route', value: (r) => [r.fromPlace, r.toPlace].filter(Boolean).join(' → ') },
    { header: 'Tonnage (t)', value: (r) => (r.tonnageKg != null ? (r.tonnageKg / 1000).toFixed(2) : ''), excel: (r) => (r.tonnageKg != null ? r.tonnageKg / 1000 : ''), numFmt: '#,##0.00', align: 'right' },
    { header: 'Driver', value: (r) => r.driverName ?? '' },
    { header: 'Driver Phone', value: (r) => r.driverPhone ?? '' },
    { header: 'Freight', value: (r) => { const f = freightOf(r); return f != null ? rupees(f) : ''; }, excel: (r) => freightOf(r) ?? '', numFmt: '#,##0.00', align: 'right' },
    { header: 'Status', value: (r) => (isWaiting(r) ? 'Waiting' : isUsed(r) ? 'Used' : 'Dismissed') },
    { header: 'Dispatched To', value: (r) => r.dispatch?.buyer ?? '' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Lorries booked over WhatsApp. Each message is filed here as <span className="font-medium">Waiting</span>;
          typing the lorry number on a dispatch fills in its driver and marks the booking used.
        </p>
        <ExportButtons
          filename={`Lorry_Confirmations_${filter}`}
          title="Lorry Confirmations"
          subtitle={`${filtered.length} booking(s)`}
          columns={exportColumns}
          rows={filtered}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-3xl">
        <Card className="bg-card border shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Waiting Lorries</CardTitle>
            <Hourglass className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">{waitingCount}</div>
            <p className="text-[10px] text-muted-foreground mt-1">Booked, not yet dispatched</p>
          </CardContent>
        </Card>
        <Card className="bg-card border shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Tonnage Booked</CardTitle>
            <Truck className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{waitingTonnes.toFixed(2)} t</div>
            <p className="text-[10px] text-muted-foreground mt-1">Across the waiting lorries</p>
          </CardContent>
        </Card>
        <Card className="bg-card border shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Freight Quoted</CardTitle>
            <MessageCircle className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{rupees(waitingFreight)}</div>
            <p className="text-[10px] text-muted-foreground mt-1">As quoted in the messages</p>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={filter}
          onValueChange={(v) => { setFilter(v as RegisterFilter); setPage(1); }}
          options={[
            { value: 'WAITING', label: `Waiting${waitingCount ? ` (${waitingCount})` : ''}` },
            { value: 'USED', label: 'Used' },
            { value: 'DISMISSED', label: 'Dismissed' },
            { value: 'ALL', label: 'All' },
          ]}
        />
        <SearchInput
          value={search}
          onValueChange={(v) => { setSearch(v); setPage(1); }}
          placeholder="Search lorry no, driver, phone, route…"
          containerClassName="w-full sm:w-80"
          className="h-9"
        />
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <div className="rounded-lg border bg-card">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Lorry No</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead className="text-right">Tonnage</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Driver Phone</TableHead>
                  <TableHead className="text-right">Freight</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                      {search
                        ? 'No booking matches that search.'
                        : filter === 'WAITING'
                          ? 'No lorries waiting. New transport messages appear here automatically.'
                          : 'Nothing here yet.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  visible.map((r) => {
                    const freight = freightOf(r);
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="whitespace-nowrap">{shortDate(bookingDate(r))}</TableCell>
                        <TableCell className="font-mono text-sm font-semibold">{r.lorryNumber ?? '-'}</TableCell>
                        <TableCell className="text-xs">
                          {r.fromPlace || r.toPlace ? `${r.fromPlace ?? '?'} → ${r.toPlace ?? '?'}` : '-'}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums text-sm">
                          {r.tonnageKg != null ? `${(r.tonnageKg / 1000).toFixed(2)} t` : '-'}
                        </TableCell>
                        <TableCell className="font-medium">{r.driverName ?? '-'}</TableCell>
                        <TableCell className="font-mono text-xs">{r.driverPhone ?? '-'}</TableCell>
                        <TableCell className="text-right font-semibold">{freight != null ? rupees(freight) : '-'}</TableCell>
                        <TableCell>
                          {isWaiting(r) ? (
                            <Badge variant="outline" className="text-[10px] border-amber-400 text-amber-600 dark:text-amber-400">
                              Waiting
                            </Badge>
                          ) : isUsed(r) ? (
                            <div className="space-y-0.5">
                              <Badge variant="default" className="text-[10px] gap-1">
                                <CheckCircle2 className="h-3 w-3" /> Used
                              </Badge>
                              {r.dispatch && (
                                <div className="text-[10px] text-muted-foreground">
                                  {r.dispatch.buyer ?? 'dispatch'} · {shortDate(r.dispatch.dispatchDate)}
                                </div>
                              )}
                            </div>
                          ) : (
                            <Badge variant="secondary" className="text-[10px]">Dismissed</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 gap-1.5 text-xs"
                              title="Correct the parsed details"
                              onClick={() => setEditTarget(r)}
                            >
                              <Pencil className="h-3.5 w-3.5" /> Edit
                            </Button>
                            {isWaiting(r) && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0 text-muted-foreground"
                                title="Dismiss this booking"
                                disabled={dismissMutation.isPending}
                                onClick={() => dismissMutation.mutate(r.id)}
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {r.status === 'DISMISSED' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0 text-muted-foreground"
                                title="Put back on the waiting list"
                                disabled={restoreMutation.isPending}
                                onClick={() => restoreMutation.mutate(r.id)}
                              >
                                <Undo2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
          <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
        </div>
      )}

      <EditBookingDialog booking={editTarget} onClose={() => setEditTarget(null)} />
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Corrections. Gemini reads these off free-text messages, so a transposed    */
/* lorry number or a dropped driver name has to be fixable - an unmatched row */
/* never fills anything in at dispatch.                                       */
/* ------------------------------------------------------------------------- */

function EditBookingDialog({ booking, onClose }: { booking: LorryConfirmation | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    lorryNumber: '', driverName: '', driverPhone: '', tonnes: '', freightAmount: '', messageDate: '',
  });
  // Re-seed whenever a different booking is opened.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (booking && seededFor !== booking.id) {
    setSeededFor(booking.id);
    setForm({
      lorryNumber: booking.lorryNumber ?? '',
      driverName: booking.driverName ?? '',
      driverPhone: booking.driverPhone ?? '',
      tonnes: booking.tonnageKg != null ? String(booking.tonnageKg / 1000) : '',
      freightAmount: booking.freightAmount != null ? String(booking.freightAmount) : '',
      messageDate: (booking.messageDate ?? booking.createdAt).slice(0, 10),
    });
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      api(`/whatsapp/transport-confirmations/${booking!.id}`, {
        method: 'PATCH',
        body: {
          lorryNumber: form.lorryNumber,
          driverName: form.driverName,
          driverPhone: form.driverPhone,
          tonnageKg: form.tonnes.trim() === '' ? null : Math.round(Number(form.tonnes) * 1000),
          freightAmount: form.freightAmount.trim() === '' ? null : Number(form.freightAmount),
          messageDate: form.messageDate || null,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lorry-confirmations'] });
      toast.success('Booking updated');
      onClose();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const tonnesNum = Number(form.tonnes);
  const freightNum = Number(form.freightAmount);
  // Per-tonne readout: the quickest way to spot a figure read on the wrong basis,
  // since these routes run ~2,000-3,000/t.
  const perTonne =
    form.freightAmount.trim() !== '' && Number.isFinite(freightNum) && Number.isFinite(tonnesNum) && tonnesNum > 0
      ? Math.round((freightNum / tonnesNum) * 100) / 100
      : null;

  return (
    <Dialog open={booking !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Lorry Booking</DialogTitle>
          <DialogDescription>
            Correct anything the message was read wrong on. The lorry number is what a dispatch matches against.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {booking && (
            <p className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground italic">"{booking.rawText}"</p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Lorry No</Label>
              <Input value={form.lorryNumber} onChange={(e) => setForm((s) => ({ ...s, lorryNumber: e.target.value }))} placeholder="e.g. AP39T8217" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Date</Label>
              <Input type="date" value={form.messageDate} onChange={(e) => setForm((s) => ({ ...s, messageDate: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Driver Name</Label>
              <Input value={form.driverName} onChange={(e) => setForm((s) => ({ ...s, driverName: e.target.value }))} placeholder="e.g. Moula" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Driver Phone</Label>
              <Input value={form.driverPhone} onChange={(e) => setForm((s) => ({ ...s, driverPhone: e.target.value }))} placeholder="e.g. 7207012803" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Tonnage (tonnes)</Label>
              <Input type="number" step="0.01" value={form.tonnes} onChange={(e) => setForm((s) => ({ ...s, tonnes: e.target.value }))} placeholder="e.g. 30" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Freight (₹)</Label>
              <Input type="number" step="1" value={form.freightAmount} onChange={(e) => setForm((s) => ({ ...s, freightAmount: e.target.value }))} placeholder="e.g. 75000" />
              {perTonne != null && <p className="text-[11px] text-muted-foreground">= {rupees(perTonne)}/tonne</p>}
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            The freight here is the transporter's quote, kept for the record - it does not change what a dispatch was costed at.
          </p>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            {saveMutation.isPending ? 'Saving…' : 'Save Booking'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
