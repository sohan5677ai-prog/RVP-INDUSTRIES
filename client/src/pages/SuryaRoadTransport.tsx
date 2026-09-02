import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import { usePagedRows } from '@/lib/usePagedRows';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { SearchInput } from '@/components/ui/search-input';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import type { SaleOrder, SaleProduct, CompanyProfile, Transport } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { companyVehicleNumbers } from '@/lib/calc';
import { productDescription } from '@/lib/productNames';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Segmented } from '@/components/ui/segmented';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2, Truck, Wallet, Hourglass, FileText, Trash2 } from 'lucide-react';

interface RetentionRow {
  id: string;
  date: string;
  buyer: string;
  lorryNumber: string | null;
  invoice: string | null;
  destination: string | null;
  amount: number;
  released: boolean;
  transportKey: string;
  transportName: string;
  // Lorry receipt (GC note) written for this trip, when one has been issued.
  product: SaleProduct;
  weightKg: number;
  freight: number;
  driverName: string | null;
  gcNumber: string | null;
  gcDate: string | null;
  bags: number | null;
  kgPerBag: number | null;
  /** Whether the buyer's party record has lorry receipts switched on. */
  gcEnabled: boolean;
}

export default function SuryaRoadTransport({ embedded = false }: { embedded?: boolean } = {}) {
  const [search, setSearch] = useState<string>('');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [tab, setTab] = useState<string>('');

  const { data: saleOrders, isLoading: loadingSales } = useQuery({
    queryKey: ['sale-orders', { all: true }],
    queryFn: () => api<SaleOrder[]>('/sale-orders?all=true'),
  });

  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: () => api<CompanyProfile>('/settings/company'),
  });

  const { data: transportsList, isLoading: loadingTransports } = useQuery({
    queryKey: ['transports'],
    queryFn: () => api<Transport[]>('/transports'),
  });

  const retention = Number(company?.freightRetentionPerTrip ?? 3000);
  const knmList = useMemo(() => companyVehicleNumbers(company?.companyVehicles), [company?.companyVehicles]);

  // Available transport tab configurations
  const transportTabs = useMemo(() => {
    const list: { key: string; label: string; name: string; isSurya: boolean; isKnm: boolean; defaultRetention: number }[] = [];
    (transportsList ?? []).forEach((t) => {
      const isSurya = t.code === 'SURYA' || t.name.toLowerCase().includes('surya');
      const isKnm = t.code === 'KNM' || t.name.toLowerCase().includes('knm');
      list.push({
        key: t.id,
        label: t.name,
        name: t.name,
        isSurya,
        isKnm,
        defaultRetention: Number(t.defaultRetention || 0),
      });
    });

    // Add 'OTHER' tab for unassigned or custom trips
    list.push({
      key: 'OTHER',
      label: 'Others / Unassigned',
      name: 'Others',
      isSurya: false,
      isKnm: false,
      defaultRetention: 0,
    });
    return list;
  }, [transportsList]);

  // Auto-initialize active tab to Surya Road Lines or first transport
  useEffect(() => {
    if (!tab && transportTabs.length > 0) {
      const surya = transportTabs.find((t) => t.isSurya);
      setTab(surya ? surya.key : transportTabs[0].key);
    }
  }, [transportTabs, tab]);

  /** Infer transport provider key for a dispatch. */
  function resolveTripTransportKey(d: any): string {
    if (d.transportId) {
      const match = (transportsList ?? []).find((t) => t.id === d.transportId);
      if (match) return match.id;
    }
    if (d.transportProvider) {
      const match = (transportsList ?? []).find(
        (t) =>
          t.code === d.transportProvider ||
          t.name.toLowerCase() === d.transportProvider.toLowerCase() ||
          t.id === d.transportProvider
      );
      if (match) return match.id;
      if (d.transportProvider === 'SURYA') {
        const surya = (transportsList ?? []).find((t) => t.code === 'SURYA' || t.name.toLowerCase().includes('surya'));
        if (surya) return surya.id;
      }
      if (d.transportProvider === 'KNM') {
        const knm = (transportsList ?? []).find((t) => t.code === 'KNM' || t.name.toLowerCase().includes('knm'));
        if (knm) return knm.id;
      }
    }
    if (d.vehicleNumber && knmList.includes(d.vehicleNumber.trim().toLowerCase())) {
      const knm = (transportsList ?? []).find((t) => t.code === 'KNM' || t.name.toLowerCase().includes('knm'));
      if (knm) return knm.id;
    }
    const surya = (transportsList ?? []).find((t) => t.code === 'SURYA' || t.name.toLowerCase().includes('surya'));
    return surya ? surya.id : 'OTHER';
  }

  /** Retention amount for a dispatch based on its transport. */
  function retentionAmount(d: any, transportKey: string): number {
    const t = (transportsList ?? []).find((x) => x.id === transportKey);
    if (t) {
      if (t.code === 'KNM' || t.name.toLowerCase().includes('knm')) return 0;
      if (d.customRetention != null && Number(d.customRetention) >= 0) return Number(d.customRetention);
      return Number(t.defaultRetention ?? retention);
    }
    if (d.customRetention != null && Number(d.customRetention) >= 0) return Number(d.customRetention);
    return 0;
  }

  const allRows: RetentionRow[] = useMemo(() => {
    return (saleOrders ?? [])
      .flatMap((o) => (o.dispatches ?? []).map((d) => ({ o, d })))
      .filter(({ d }) => Number(d.freightCharge) > 0)
      .map(({ o, d }) => {
        const transportKey = resolveTripTransportKey(d);
        const transportObj = (transportsList ?? []).find((t) => t.id === transportKey);
        const transportName = transportObj ? transportObj.name : 'Others';
        return {
          id: d.id,
          date: d.dispatchDate,
          buyer: o.buyer?.name ?? '-',
          lorryNumber: d.vehicleNumber ?? null,
          invoice: d.invoiceNumber ?? null,
          destination: o.destination ?? null,
          amount: retentionAmount(d, transportKey),
          released: d.status === 'DELIVERED',
          transportKey,
          transportName,
          product: o.product,
          weightKg: d.weightKg,
          freight: Number(d.freightCharge ?? 0),
          driverName: d.driverName ?? null,
          gcNumber: d.lrNumber ?? null,
          gcDate: d.lrDate ?? null,
          bags: d.lrBags ?? null,
          kgPerBag: d.lrKgPerBag ?? null,
          gcEnabled: o.buyer?.lorryReceiptEnabled ?? false,
        };
      })
      .filter((r) => {
        const d = new Date(r.date).toISOString().slice(0, 10);
        if (startDate && d < startDate) return false;
        if (endDate && d > endDate) return false;
        return true;
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [saleOrders, transportsList, knmList, retention, startDate, endDate]);

  const activeTabInfo = transportTabs.find((t) => t.key === tab) || transportTabs[0] || {
    key: 'OTHER',
    label: 'Others',
    name: 'Others',
    isSurya: false,
    isKnm: false,
    defaultRetention: 0,
  };

  const rows = useMemo(() => {
    const tabFiltered = allRows.filter((r) => r.transportKey === activeTabInfo.key);
    const q = search.trim().toLowerCase();
    if (!q) return tabFiltered;
    const qNorm = q.replace(/[^a-z0-9]/g, '');
    return tabFiltered.filter((r) => {
      const matchBuyer = r.buyer.toLowerCase().includes(q);
      const matchLorry = (r.lorryNumber ?? '').toLowerCase().includes(q) || (qNorm !== '' && (r.lorryNumber ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(qNorm));
      const matchInvoice = (r.invoice ?? '').toLowerCase().includes(q) || (qNorm !== '' && (r.invoice ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(qNorm));
      const matchDest = (r.destination ?? '').toLowerCase().includes(q);
      const matchDriver = (r.driverName ?? '').toLowerCase().includes(q);
      const matchGc = (r.gcNumber ?? '').toLowerCase().includes(q);
      const matchStatus = (r.released ? 'delivered' : 'in transit').includes(q);
      return matchBuyer || matchLorry || matchInvoice || matchDest || matchDriver || matchGc || matchStatus;
    });
  }, [allRows, activeTabInfo.key, search]);

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows: visible = [] } = usePagedRows(rows, 50);

  const exportColumns: ExportColumn<RetentionRow>[] = [
    { header: 'Date', value: (r) => shortDate(r.date) },
    { header: 'Buyer', value: (r) => r.buyer },
    { header: 'Lorry No', value: (r) => r.lorryNumber ?? '' },
    { header: 'Invoice No', value: (r) => r.invoice ?? '' },
    { header: 'Destination', value: (r) => r.destination ?? '' },
    ...(!activeTabInfo.isKnm
      ? [{ header: 'Retention', value: (r: RetentionRow) => rupees(r.amount), excel: (r: RetentionRow) => r.amount, numFmt: '#,##0.00', align: 'right' as const }]
      : []),
    { header: 'Status', value: (r) => (r.released ? 'Delivered' : 'In Transit') },
  ];

  const totalReleased = rows.filter((r) => r.released).reduce((s, r) => s + r.amount, 0);
  const totalHeld = rows.filter((r) => !r.released).reduce((s, r) => s + r.amount, 0);
  const totalFreightTrips = rows.length;

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of transportTabs) {
      counts[t.key] = allRows.filter((r) => r.transportKey === t.key).length;
    }
    return counts;
  }, [allRows, transportTabs]);

  const isLoading = loadingSales || loadingTransports;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {!embedded ? (
          <div>
            <h1 className="text-2xl font-bold">Transport Report</h1>
            <p className="text-muted-foreground">Per-trip freight retention and trips by transport agency - bifurcated view</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Per-trip freight retention and trips by transport agency - bifurcated view</p>
        )}
        <ExportButtons
          filename={`Transport_${activeTabInfo.name.replace(/\s+/g, '_')}`}
          title={`Transport Report - ${activeTabInfo.name}`}
          subtitle={`${rows.length} trip(s)`}
          columns={exportColumns}
          rows={rows}
        />
      </div>

      {/* Transport Provider Tabs */}
      <div className="overflow-x-auto pb-1">
        <Segmented
          value={tab}
          onValueChange={(v) => setTab(v)}
          options={transportTabs
            .filter((t) => t.key !== 'OTHER' || (tabCounts['OTHER'] ?? 0) > 0)
            .map((t) => ({
              value: t.key,
              label: `${t.name} (${tabCounts[t.key] ?? 0})`,
            }))}
        />
      </div>

      {/* Filters Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 bg-muted/40 p-4 rounded-lg border">
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold">Search</Label>
          <SearchInput
            value={search}
            onValueChange={setSearch}
            placeholder="Search lorry, buyer, invoice, destination…"
            className="h-9 bg-card"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="start" className="text-xs font-semibold">From Date</Label>
          <Input id="start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="bg-card h-9" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="end" className="text-xs font-semibold">To Date</Label>
          <Input id="end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="bg-card h-9" />
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : activeTabInfo.isSurya ? (
        <Tabs defaultValue="retention" className="space-y-6">
          <TabsList className="bg-card border shadow-sm">
            <TabsTrigger value="retention" className="gap-2 text-sm font-semibold">
              <Wallet className="h-4 w-4" /> Freight Retention
            </TabsTrigger>
            <TabsTrigger value="gc-notes" className="gap-2 text-sm font-semibold">
              <FileText className="h-4 w-4" /> G.C. Notes
            </TabsTrigger>
          </TabsList>

          <TabsContent value="retention" className="space-y-6">
            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Card className="bg-card border shadow-sm">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Released to Surya (Payable)
                  </CardTitle>
                  <Wallet className="h-4 w-4 text-emerald-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{rupees(totalReleased)}</div>
                  <p className="text-[10px] text-muted-foreground mt-1">Delivered trips · retention owed to Surya Road Lines</p>
                </CardContent>
              </Card>
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
              <Card className="bg-card border shadow-sm">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Trips</CardTitle>
                  <Truck className="h-4 w-4 text-primary" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{totalFreightTrips} trips</div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    @ {rupees(activeTabInfo.defaultRetention || retention)} retention per trip
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Ledger Table */}
            <div className="rounded-lg border bg-card">
              <div className="px-5 py-4 border-b font-semibold text-sm">
                Freight Retention Movements
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Buyer</TableHead>
                    <TableHead>Lorry No</TableHead>
                    <TableHead>Invoice No</TableHead>
                    <TableHead>Destination</TableHead>
                    <TableHead className="text-right">Retention</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                        No Surya Road Lines trips match selected filters.
                      </TableCell>
                    </TableRow>
                  ) : (
                    visible.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell>{shortDate(r.date)}</TableCell>
                        <TableCell className="font-semibold">{r.buyer}</TableCell>
                        <TableCell className="font-sans text-xs font-medium text-foreground/80">{r.lorryNumber ?? '-'}</TableCell>
                        <TableCell className="font-sans text-xs font-medium text-muted-foreground">{r.invoice ?? '-'}</TableCell>
                        <TableCell>{r.destination ?? '-'}</TableCell>
                        <TableCell className="text-right font-bold text-primary">{rupees(r.amount)}</TableCell>
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
          </TabsContent>

          <TabsContent value="gc-notes">
            <LorryReceiptRegister rows={rows} />
          </TabsContent>
        </Tabs>
      ) : (
        <div className="grid gap-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {!activeTabInfo.isKnm && (
              <Card className="bg-card border shadow-sm">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Released (Payable)
                  </CardTitle>
                  <Wallet className="h-4 w-4 text-emerald-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{rupees(totalReleased)}</div>
                  <p className="text-[10px] text-muted-foreground mt-1">Delivered trips · retention owed to {activeTabInfo.name}</p>
                </CardContent>
              </Card>
            )}
            {!activeTabInfo.isKnm && (
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
                  {activeTabInfo.isKnm ? 'Company-owned vehicles · no retention' : `${rupees(activeTabInfo.defaultRetention)} standard retention per trip`}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Ledger Table */}
          <div className="rounded-lg border bg-card">
            <div className="px-5 py-4 border-b font-semibold text-sm">
              {activeTabInfo.isKnm ? `${activeTabInfo.name} Trips` : `Freight Retention Movements - ${activeTabInfo.name}`}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Buyer</TableHead>
                  <TableHead>Lorry No</TableHead>
                  <TableHead>Invoice No</TableHead>
                  <TableHead>Destination</TableHead>
                  {!activeTabInfo.isKnm && <TableHead className="text-right">Retention</TableHead>}
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={!activeTabInfo.isKnm ? 7 : 6} className="text-center text-muted-foreground py-8">
                      No {activeTabInfo.name} trips match selected filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  visible.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{shortDate(r.date)}</TableCell>
                      <TableCell className="font-semibold">{r.buyer}</TableCell>
                      <TableCell className="font-sans text-xs font-medium text-foreground/80">{r.lorryNumber ?? '-'}</TableCell>
                      <TableCell className="font-sans text-xs font-medium text-muted-foreground">{r.invoice ?? '-'}</TableCell>
                      <TableCell>{r.destination ?? '-'}</TableCell>
                      {!activeTabInfo.isKnm && (
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
/* Lorry receipt (GC) register - the printed consignment notes for the trips  */
/* shown above, so the book can be read back without opening each shipment.   */
/* ------------------------------------------------------------------------- */

function LorryReceiptRegister({ rows }: { rows: RetentionRow[] }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [issuedOnly, setIssuedOnly] = useState(false);
  const [gcSearch, setGcSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<RetentionRow | null>(null);

  const deleteGcMutation = useMutation({
    mutationFn: (id: string) => api(`/sale-dispatches/${id}/lorry-receipt`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      toast.success('GC Note deleted successfully');
      setDeleteTarget(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // Only buyers switched on for the GC note belong in the book - plus any older
  // shipment that already carries a number, so nothing written disappears.
  const gcRows = rows.filter((r) => r.gcEnabled || r.gcNumber);
  const filtered = useMemo(() => {
    const base = issuedOnly ? gcRows.filter((r) => r.gcNumber) : gcRows;
    const q = gcSearch.trim().toLowerCase();
    if (!q) return base;
    const qNorm = q.replace(/[^a-z0-9]/g, '');
    return base.filter((r) => {
      const matchGc = (r.gcNumber ?? '').toLowerCase().includes(q);
      const matchLorry = (r.lorryNumber ?? '').toLowerCase().includes(q) || (qNorm !== '' && (r.lorryNumber ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(qNorm));
      const matchInvoice = (r.invoice ?? '').toLowerCase().includes(q) || (qNorm !== '' && (r.invoice ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(qNorm));
      const matchBuyer = r.buyer.toLowerCase().includes(q);
      const matchDest = (r.destination ?? '').toLowerCase().includes(q);
      const matchDriver = (r.driverName ?? '').toLowerCase().includes(q);
      const matchProd = productDescription(r.product).toLowerCase().includes(q);
      return matchGc || matchLorry || matchInvoice || matchBuyer || matchDest || matchDriver || matchProd;
    });
  }, [gcRows, issuedOnly, gcSearch]);

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows: visible = [] } = usePagedRows(filtered, 50);
  const issuedCount = gcRows.filter((r) => r.gcNumber).length;

  const exportColumns: ExportColumn<RetentionRow>[] = [
    { header: 'G.C. No', value: (r) => r.gcNumber ?? '' },
    { header: 'GC Date', value: (r) => (r.gcDate ? shortDate(r.gcDate) : shortDate(r.date)) },
    { header: 'Lorry No', value: (r) => r.lorryNumber ?? '' },
    { header: 'Invoice No', value: (r) => r.invoice ?? '' },
    { header: 'Consignee', value: (r) => r.buyer },
    { header: 'To', value: (r) => r.destination ?? '' },
    { header: 'Description', value: (r) => productDescription(r.product) },
    { header: 'Bags', value: (r) => r.bags ?? '', numFmt: '#,##0', align: 'right' },
    { header: 'Each Bag (Kgs)', value: (r) => r.kgPerBag ?? '', numFmt: '#,##0', align: 'right' },
    { header: 'Weight (t)', value: (r) => (r.weightKg / 1000).toFixed(2), excel: (r) => r.weightKg / 1000, numFmt: '#,##0.00', align: 'right' },
    { header: 'Freight', value: (r) => rupees(r.freight), excel: (r) => r.freight, numFmt: '#,##0.00', align: 'right' },
    { header: 'Driver', value: (r) => r.driverName ?? '' },
    { header: 'Status', value: (r) => (r.released ? 'Delivered' : 'In Transit') },
  ];

  return (
    <>
      <div className="rounded-lg border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b">
          <div className="flex items-center gap-2 font-semibold text-sm">
            <FileText className="h-4 w-4 text-primary" />
            Lorry Receipts (G.C. Notes)
            <span className="text-xs font-normal text-muted-foreground">
              {issuedCount} of {gcRows.length} trip(s) issued
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              value={gcSearch}
              onValueChange={setGcSearch}
              placeholder="Search G.C. no, lorry, invoice, buyer…"
              containerClassName="w-full sm:w-64"
              className="h-8 text-xs"
            />
            <Segmented
              value={issuedOnly ? 'issued' : 'all'}
              onValueChange={(v) => setIssuedOnly(v === 'issued')}
              options={[
                { value: 'all', label: 'All trips' },
                { value: 'issued', label: 'Issued only' },
              ]}
            />
            <ExportButtons
              filename="Lorry_Receipts_Surya"
              title="Lorry Receipts - Surya Road Lines"
              subtitle={`${filtered.length} receipt(s)`}
              columns={exportColumns}
              rows={filtered}
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>G.C. No</TableHead>
                <TableHead>GC Date</TableHead>
                <TableHead>Lorry No</TableHead>
                <TableHead>Invoice No</TableHead>
                <TableHead>Consignee</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Bags</TableHead>
                <TableHead className="text-right">Weight</TableHead>
                <TableHead className="text-right">Freight</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={12} className="text-center text-muted-foreground py-8">
                    {gcRows.length === 0
                      ? 'No buyer is switched on for lorry receipts. Turn on "Lorry receipt (GC)" on a buyer in Parties.'
                      : 'No lorry receipts match the selected filters.'}
                  </TableCell>
                </TableRow>
              ) : (
                visible.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-sans text-xs font-semibold text-foreground/90">
                      {r.gcNumber ?? <span className="font-sans text-xs font-normal text-muted-foreground">Not issued</span>}
                    </TableCell>
                    <TableCell>{shortDate(r.gcDate ?? r.date)}</TableCell>
                    <TableCell className="font-sans text-xs font-medium text-foreground/80">{r.lorryNumber ?? '-'}</TableCell>
                    <TableCell className="font-sans text-xs font-medium text-muted-foreground">{r.invoice ?? '-'}</TableCell>
                    <TableCell className="font-semibold">{r.buyer}</TableCell>
                    <TableCell>{r.destination ?? '-'}</TableCell>
                    <TableCell className="text-xs">{productDescription(r.product)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-sm">
                      {r.bags != null ? `${r.bags}${r.kgPerBag != null ? ` × ${r.kgPerBag}kg` : ''}` : '-'}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-sm">{(r.weightKg / 1000).toFixed(2)} t</TableCell>
                    <TableCell className="text-right font-semibold">{rupees(r.freight)}</TableCell>
                    <TableCell>
                      <Badge variant={r.released ? 'default' : 'outline'} className="text-[10px]">
                        {r.released ? 'Delivered' : 'In Transit'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1.5 text-xs"
                          onClick={() => navigate(`/sale-dispatches/${r.id}/lorry-receipt`)}
                        >
                          <FileText className="h-3.5 w-3.5" /> {r.gcNumber ? 'Open' : 'Create'}
                        </Button>
                        {r.gcNumber && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                            title="Delete GC Note"
                            onClick={() => setDeleteTarget(r)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
      </div>

      <Dialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete GC Note</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete GC Note #{deleteTarget?.gcNumber}? This will clear the GC details for invoice #{deleteTarget?.invoice ?? '-'}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteGcMutation.isPending}
              onClick={() => deleteTarget && deleteGcMutation.mutate(deleteTarget.id)}
            >
              {deleteGcMutation.isPending ? 'Deleting…' : 'Delete GC Note'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
