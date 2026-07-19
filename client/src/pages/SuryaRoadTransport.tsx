import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import { usePagedRows } from '@/lib/usePagedRows';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import type { SaleOrder, CompanyProfile } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Segmented } from '@/components/ui/segmented';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Truck, Wallet, Hourglass, MessageCircle, Check, X } from 'lucide-react';

type TransportTab = 'SURYA' | 'KNM' | 'OTHER';

interface RetentionRow {
  id: string;
  date: string;
  buyer: string;
  lorryNumber: string | null;
  invoice: string | null;
  destination: string | null;
  amount: number;
  released: boolean;
  provider: TransportTab;
}

export default function SuryaRoadTransport() {
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [tab, setTab] = useState<TransportTab>('SURYA');

  const { data: saleOrders, isLoading } = useQuery({
    queryKey: ['sale-orders'],
    queryFn: () => api<SaleOrder[]>('/sale-orders'),
  });

  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: () => api<CompanyProfile>('/settings/company'),
  });

  const retention = Number(company?.freightRetentionPerTrip ?? 3000);
  const knmList = (company?.companyVehicles || '').split(/[\n,]+/).map(v => v.trim().toLowerCase()).filter(v => v);

  /** Infer transport provider for legacy dispatches without the field. */
  function inferProvider(d: any): TransportTab {
    if (d.transportProvider) return d.transportProvider as TransportTab;
    if (d.vehicleNumber && knmList.includes(d.vehicleNumber.trim().toLowerCase())) return 'KNM';
    return 'SURYA';
  }

  /** Retention amount for a dispatch based on its provider. */
  function retentionAmount(d: any, provider: TransportTab): number {
    if (provider === 'SURYA') return retention;
    if (provider === 'OTHER') return Number(d.customRetention ?? 0);
    return 0; // KNM
  }

  const allRows: RetentionRow[] = (saleOrders ?? [])
    .flatMap((o) => (o.dispatches ?? []).map((d) => ({ o, d })))
    .filter(({ d }) => Number(d.freightCharge) > 0)
    .map(({ o, d }) => {
      const provider = inferProvider(d);
      return {
        id: d.id,
        date: d.dispatchDate,
        buyer: o.buyer?.name ?? '-',
        lorryNumber: d.vehicleNumber ?? null,
        invoice: d.invoiceNumber ?? null,
        destination: o.destination ?? null,
        amount: retentionAmount(d, provider),
        released: d.status === 'DELIVERED',
        provider,
      };
    })
    .filter((r) => {
      const d = new Date(r.date).toISOString().slice(0, 10);
      if (startDate && d < startDate) return false;
      if (endDate && d > endDate) return false;
      return true;
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const rows = allRows.filter((r) => r.provider === tab);
  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows: visible = [] } = usePagedRows(rows, 50);

  const exportColumns: ExportColumn<RetentionRow>[] = [
    { header: 'Date', value: (r) => shortDate(r.date) },
    { header: 'Buyer', value: (r) => r.buyer },
    { header: 'Lorry No', value: (r) => r.lorryNumber ?? '' },
    { header: 'Invoice No', value: (r) => r.invoice ?? '' },
    { header: 'Destination', value: (r) => r.destination ?? '' },
    ...(tab !== 'KNM' ? [{ header: 'Retention', value: (r: RetentionRow) => rupees(r.amount), excel: (r: RetentionRow) => r.amount, numFmt: '#,##0.00', align: 'right' as const }] : []),
    { header: 'Status', value: (r) => (r.released ? 'Delivered' : 'In Transit') },
  ];
  const totalReleased = rows.filter((r) => r.released).reduce((s, r) => s + r.amount, 0);
  const totalHeld = rows.filter((r) => !r.released).reduce((s, r) => s + r.amount, 0);
  const totalFreightTrips = rows.length;

  const tabLabels: Record<TransportTab, string> = {
    SURYA: 'Surya Road Lines',
    KNM: 'K.N.M. Transport',
    OTHER: 'Others',
  };

  const tabCounts: Record<TransportTab, number> = {
    SURYA: allRows.filter((r) => r.provider === 'SURYA').length,
    KNM: allRows.filter((r) => r.provider === 'KNM').length,
    OTHER: allRows.filter((r) => r.provider === 'OTHER').length,
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Transport Report</h1>
          <p className="text-muted-foreground">Per-trip freight retention by transport provider — bifurcated view</p>
        </div>
        <ExportButtons
          filename={`Transport_${tab}`}
          title={`Transport Report — ${tabLabels[tab]}`}
          subtitle={`${rows.length} trip(s)`}
          columns={exportColumns}
          rows={rows}
        />
      </div>

      {/* Inbound WhatsApp lorry confirmations awaiting review */}
      <TransportConfirmationDrafts saleOrders={saleOrders ?? []} />

      {/* Transport Provider Tabs */}
      <Segmented
        value={tab}
        onValueChange={(v) => setTab(v as TransportTab)}
        options={[
          { value: 'SURYA', label: `Surya Road Lines (${tabCounts.SURYA})` },
          { value: 'KNM',   label: `K.N.M. (${tabCounts.KNM})` },
          { value: 'OTHER', label: `Others (${tabCounts.OTHER})` },
        ]}
      />

      {/* Filters Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-muted/40 p-4 rounded-lg border">
        <div className="space-y-1.5">
          <Label htmlFor="start" className="text-xs font-semibold">From Date</Label>
          <Input id="start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="bg-card" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="end" className="text-xs font-semibold">To Date</Label>
          <Input id="end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="bg-card" />
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <div className="grid gap-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {tab !== 'KNM' && (
              <Card className="bg-card border shadow-sm">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {tab === 'SURYA' ? 'Released to Surya (Payable)' : 'Released (Payable)'}
                  </CardTitle>
                  <Wallet className="h-4 w-4 text-emerald-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{rupees(totalReleased)}</div>
                  <p className="text-[10px] text-muted-foreground mt-1">Delivered trips · retention owed to {tabLabels[tab]}</p>
                </CardContent>
              </Card>
            )}
            {tab !== 'KNM' && (
              <Card className="bg-card border shadow-sm">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Retention Held</CardTitle>
                  <Hourglass className="h-4 w-4 text-amber-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">{rupees(totalHeld)}</div>
                  <p className="text-[10px] text-muted-foreground mt-1">Dispatched but not yet delivered</p>
                </CardContent>
              </Card>
            )}
            <Card className="bg-card border shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Trips</CardTitle>
                <Truck className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{totalFreightTrips} trips</div>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {tab === 'SURYA' ? `@ ${rupees(retention)} retention per trip` : tab === 'KNM' ? 'Company-owned vehicles · no retention' : 'Custom retention per trip'}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Ledger Table */}
          <div className="rounded-lg border bg-card">
            <div className="px-5 py-4 border-b font-semibold text-sm">
              {tab === 'KNM' ? 'K.N.M. Transport Trips' : 'Freight Retention Movements'}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Buyer</TableHead>
                  <TableHead>Lorry No</TableHead>
                  <TableHead>Invoice No</TableHead>
                  <TableHead>Destination</TableHead>
                  {tab !== 'KNM' && <TableHead className="text-right">Retention</TableHead>}
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={tab !== 'KNM' ? 7 : 6} className="text-center text-muted-foreground py-8">
                      No {tabLabels[tab]} trips match selected filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  visible.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{shortDate(r.date)}</TableCell>
                      <TableCell className="font-semibold">{r.buyer}</TableCell>
                      <TableCell className="font-mono text-sm">{r.lorryNumber ?? '-'}</TableCell>
                      <TableCell className="font-mono text-xs">{r.invoice ?? '-'}</TableCell>
                      <TableCell>{r.destination ?? '-'}</TableCell>
                      {tab !== 'KNM' && (
                        <TableCell className="text-right font-bold text-primary">{rupees(r.amount)}</TableCell>
                      )}
                      <TableCell>
                        <Badge variant={r.released ? 'default' : 'outline'} className="text-[10px]">
                          {r.released ? 'Delivered' : 'In Transit'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Inbound WhatsApp lorry confirmations (parsed by the server webhook) held   */
/* as drafts until reviewed. Confirming can copy the driver/lorry details     */
/* onto a chosen dispatch; dismissing hides mis-parsed or irrelevant ones.    */
/* ------------------------------------------------------------------------- */

interface TransportConfirmationDraft {
  id: string;
  fromPhone: string;
  rawText: string;
  messageDate: string | null;
  fromPlace: string | null;
  toPlace: string | null;
  tonnageKg: number | null;
  lorryNumber: string | null;
  driverName: string | null;
  driverPhone: string | null;
  freightAmount: number | null;
  createdAt: string;
}

function TransportConfirmationDrafts({ saleOrders }: { saleOrders: SaleOrder[] }) {
  const qc = useQueryClient();
  const [linkTarget, setLinkTarget] = useState<Record<string, string>>({});

  const { data: drafts } = useQuery({
    queryKey: ['transport-confirmations'],
    queryFn: () => api<TransportConfirmationDraft[]>('/whatsapp/transport-confirmations?status=DRAFT'),
    refetchInterval: 60_000, // new confirmations arrive from outside the app
  });

  // Undelivered dispatches a confirmation could belong to, newest first.
  const openDispatches = saleOrders
    .flatMap((o) => (o.dispatches ?? []).filter((d) => d.status === 'DISPATCHED').map((d) => ({ o, d })))
    .sort((a, b) => new Date(b.d.dispatchDate).getTime() - new Date(a.d.dispatchDate).getTime());

  const confirmMutation = useMutation({
    mutationFn: ({ id, saleDispatchId }: { id: string; saleDispatchId?: string }) =>
      api(`/whatsapp/transport-confirmations/${id}/confirm`, {
        method: 'POST',
        body: saleDispatchId ? { saleDispatchId } : {},
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transport-confirmations'] });
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      toast.success('Confirmation applied');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const dismissMutation = useMutation({
    mutationFn: (id: string) => api(`/whatsapp/transport-confirmations/${id}/dismiss`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transport-confirmations'] });
      toast.success('Dismissed');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  if (!drafts || drafts.length === 0) return null;

  return (
    <div className="rounded-lg border border-green-200 dark:border-green-900 bg-green-50/50 dark:bg-green-950/20">
      <div className="px-5 py-3 border-b border-green-200 dark:border-green-900 flex items-center gap-2 font-semibold text-sm">
        <MessageCircle className="h-4 w-4 text-green-600" />
        WhatsApp Lorry Confirmations ({drafts.length} to review)
      </div>
      <div className="divide-y divide-green-200/60 dark:divide-green-900/60">
        {drafts.map((c) => {
          // Default the link target to the open dispatch whose lorry number matches.
          const matched = openDispatches.find(
            ({ d }) => c.lorryNumber && d.vehicleNumber?.replace(/\s+/g, '').toUpperCase() === c.lorryNumber
          );
          const selected = linkTarget[c.id] ?? matched?.d.id ?? 'NONE';
          return (
            <div key={c.id} className="p-4 space-y-2.5">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {c.lorryNumber && <span className="font-mono font-semibold">{c.lorryNumber}</span>}
                {(c.fromPlace || c.toPlace) && (
                  <span>{c.fromPlace ?? '?'} → {c.toPlace ?? '?'}</span>
                )}
                {c.tonnageKg != null && <span>{(c.tonnageKg / 1000).toFixed(1)} t</span>}
                {c.driverName && <span>Driver: <span className="font-medium">{c.driverName}</span></span>}
                {c.driverPhone && <span className="font-mono">{c.driverPhone}</span>}
                {c.freightAmount != null && <span>Freight: {rupees(c.freightAmount)}</span>}
              </div>
              <p className="text-xs text-muted-foreground italic line-clamp-2">"{c.rawText}"</p>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={selected}
                  onValueChange={(v) => setLinkTarget((s) => ({ ...s, [c.id]: v }))}
                >
                  <SelectTrigger className="h-8 w-64 text-xs bg-card">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NONE">Don't link to a dispatch</SelectItem>
                    {openDispatches.map(({ o, d }) => (
                      <SelectItem key={d.id} value={d.id}>
                        {shortDate(d.dispatchDate)} · {o.buyer?.name} · {d.vehicleNumber ?? 'no vehicle'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  className="h-8 gap-1.5"
                  disabled={confirmMutation.isPending}
                  onClick={() =>
                    confirmMutation.mutate({
                      id: c.id,
                      saleDispatchId: selected !== 'NONE' ? selected : undefined,
                    })
                  }
                >
                  <Check className="h-3.5 w-3.5" /> Confirm
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1.5 text-muted-foreground"
                  disabled={dismissMutation.isPending}
                  onClick={() => dismissMutation.mutate(c.id)}
                >
                  <X className="h-3.5 w-3.5" /> Dismiss
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
