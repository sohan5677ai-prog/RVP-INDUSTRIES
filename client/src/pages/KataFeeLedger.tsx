import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { usePagedRows } from '@/lib/usePagedRows';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import type {
  Party,
  Purchase,
  SaleOrder,
  CompanyProfile,
  DustPurchase,
  StockTransfer,
  ShellTransfer,
  HuskTransfer,
} from '@/lib/types';
import { kg, rupees, shortDate } from '@/lib/format';
import { calcKataFee, isVehicleExempt } from '@/lib/calc';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Combobox } from '@/components/ui/combobox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Scale, Truck, PieChart } from 'lucide-react';

type PurchaseRow = Purchase & {
  stockIn?: {
    arrivalDate: string;
    invoiceNumber: string;
    lorryNumber: string;
    billingWeightKg: number;
    partyKataKg: number;
    purchaseOrder: {
      poNumber: string;
      pricePerKg: string;
      partyId: string;
      party: {
        name: string;
      };
    };
  };
};

interface KataEntry {
  id: string;
  date: string;
  source: 'PURCHASE' | 'DUST' | 'SALE' | 'TRANSFER';
  partyId: string | null;
  partyName: string;
  lorryNumber: string | null;
  reference: string;
  netWeightKg: number;
  kataFee: number;
}

function getWeightBracket(weightKg: number): string {
  const tonnes = weightKg / 1000;
  if (tonnes <= 15) return '≤ 15 tonnes (₹50)';
  if (tonnes <= 30) return '15-30 tonnes (₹150)';
  return '> 30 tonnes (₹200)';
}

function kataSourceLabel(source: KataEntry['source']): string {
  if (source === 'SALE') return 'Sale Freight';
  if (source === 'TRANSFER') return 'Transfer';
  if (source === 'DUST') return 'Dust Purchase';
  return 'Purchase';
}

const KATA_EXPORT_COLUMNS: ExportColumn<KataEntry>[] = [
  { header: 'Date', value: (e) => shortDate(e.date) },
  { header: 'Source', value: (e) => kataSourceLabel(e.source) },
  { header: 'Party', value: (e) => e.partyName },
  { header: 'Lorry No', value: (e) => e.lorryNumber ?? '' },
  { header: 'Reference', value: (e) => e.reference },
  { header: 'Net Weight (kg)', value: (e) => e.netWeightKg, numFmt: '#,##0', align: 'right' },
  { header: 'Weight Bracket', value: (e) => getWeightBracket(e.netWeightKg) },
  { header: 'Kata Fee', value: (e) => rupees(e.kataFee), excel: (e) => e.kataFee, numFmt: '#,##0.00', align: 'right' },
];

export default function KataFeeLedger() {
  const [partyId, setPartyId] = useState<string>('ALL');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');

  const { data: parties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const { data: purchases, isLoading: loadingPurchases } = useQuery({
    queryKey: ['purchases'],
    queryFn: () => api<PurchaseRow[]>('/purchases?all=true'),
  });

  const { data: saleOrders, isLoading: loadingSales } = useQuery({
    queryKey: ['sale-orders'],
    queryFn: () => api<SaleOrder[]>('/sale-orders'),
  });

  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: () => api<CompanyProfile>('/settings/company'),
  });

  const { data: dustPurchases, isLoading: loadingDust } = useQuery({
    queryKey: ['dust-purchases'],
    queryFn: () => api<DustPurchase[]>('/dust-purchases'),
  });

  const { data: stockTransfers, isLoading: loadingStockTransfers } = useQuery({
    queryKey: ['stock-transfers'],
    queryFn: () => api<StockTransfer[]>('/stock-transfers'),
  });

  const { data: shellTransfers, isLoading: loadingShellTransfers } = useQuery({
    queryKey: ['shell-transfers'],
    queryFn: () => api<ShellTransfer[]>('/shell-transfers'),
  });

  const { data: huskTransfers, isLoading: loadingHuskTransfers } = useQuery({
    queryKey: ['husk-transfers'],
    queryFn: () => api<HuskTransfer[]>('/husk-transfers'),
  });

  const isLoading =
    loadingPurchases ||
    loadingSales ||
    loadingDust ||
    loadingStockTransfers ||
    loadingShellTransfers ||
    loadingHuskTransfers;
  const suppliers = parties?.filter((p) => p.type !== 'BUYER' && p.type !== 'HAMALI_TEAM') ?? [];
  const supplierOptions = [
    { value: 'ALL', label: 'All Suppliers' },
    ...suppliers.map((s) => ({ value: s.id, label: s.name })),
  ];

  // Company (KNM) vehicles are exempt from the weighbridge fee — kata is never
  // charged on them, so they compute to ₹0 everywhere below.
  const companyVehicles = company?.companyVehicles;
  const exempt = (lorry: string | null | undefined) => isVehicleExempt(lorry, companyVehicles);

  // Purchase (inward) kata fees from the weighbridge on arrival. Black-seed
  // purchases store the already-exemption-aware fee on the record.
  const purchaseEntries: KataEntry[] = (purchases ?? [])
    .map((p) => ({
      id: `PUR-${p.id}`,
      date: p.stockIn?.arrivalDate ?? p.createdAt,
      source: 'PURCHASE' as const,
      partyId: p.stockIn?.purchaseOrder?.partyId ?? null,
      partyName: p.stockIn?.purchaseOrder?.party?.name ?? '-',
      lorryNumber: p.stockIn?.lorryNumber ?? null,
      reference: `Inv ${p.stockIn?.invoiceNumber ?? '-'}`,
      netWeightKg: p.netWeightKg,
      kataFee: Number(p.kataFee),
    }));

  // Pre-cleaner dust bought in from outside parties — the lorry is weighed on the
  // RVP kata just like a seed purchase, so it carries the same weighbridge fee.
  const dustEntries: KataEntry[] = (dustPurchases ?? [])
    .map((d) => ({
      id: `DUST-${d.id}`,
      date: d.purchaseDate,
      source: 'DUST' as const,
      partyId: d.partyId ?? null,
      partyName: d.party?.name ?? '-',
      lorryNumber: d.lorryNumber ?? null,
      reference: `Inv ${d.invoiceNumber ?? '-'}`,
      netWeightKg: d.weightKg,
      kataFee: calcKataFee(d.weightKg, exempt(d.lorryNumber)),
    }));

  // Sale (outward) kata fees deducted from the lorry's delivery freight. Company
  // (KNM) vehicles are exempt, so pass the exemption flag through.
  const saleEntries: KataEntry[] = (saleOrders ?? [])
    .flatMap((o) => (o.dispatches ?? []).map((d) => ({ o, d })))
    .map(({ o, d }) => ({
      id: `SALE-${d.id}`,
      date: d.dispatchDate,
      source: 'SALE' as const,
      partyId: o.buyerId,
      partyName: o.buyer?.name ?? '-',
      lorryNumber: d.vehicleNumber ?? null,
      reference: d.invoiceNumber ?? '-',
      netWeightKg: d.weightKg,
      kataFee: calcKataFee(d.weightKg, exempt(d.vehicleNumber)),
    }));

  // Byproduct transfers (husk / shell / black-seed storage moves). Each hired
  // lorry is weighed on the RVP kata, so it bears the fee unless it is a KNM vehicle.
  const transferEntries: KataEntry[] = [
    ...(stockTransfers ?? []).map((t) => ({
      id: `STOCK-${t.id}`,
      date: t.transferDate,
      source: 'TRANSFER' as const,
      partyId: null,
      partyName: `${t.fromLocation} → ${t.toLocation}`,
      lorryNumber: t.lorryNumber ?? null,
      reference: 'Seed Transfer',
      netWeightKg: t.weightKg,
      kataFee: calcKataFee(t.weightKg, exempt(t.lorryNumber)),
    })),
    ...(shellTransfers ?? []).map((t) => ({
      id: `SHELL-${t.id}`,
      date: t.transferDate,
      source: 'TRANSFER' as const,
      partyId: null,
      partyName: `${t.fromLocation} → ${t.toLocation}`,
      lorryNumber: t.lorryNumber ?? null,
      reference: 'Shell Transfer',
      netWeightKg: t.weightKg,
      kataFee: calcKataFee(t.weightKg, exempt(t.lorryNumber)),
    })),
    ...(huskTransfers ?? []).map((t) => ({
      id: `HUSK-${t.id}`,
      date: t.transferDate,
      source: 'TRANSFER' as const,
      partyId: null,
      partyName: `${t.fromLocation} → ${t.toLocation}`,
      lorryNumber: t.lorryNumber ?? null,
      reference: 'Husk Transfer',
      netWeightKg: t.weightKg,
      kataFee: calcKataFee(t.weightKg, exempt(t.lorryNumber)),
    })),
  ];

  const allEntries = [...purchaseEntries, ...dustEntries, ...saleEntries, ...transferEntries];

  const filtered = allEntries
    .filter((e) => {
      if (partyId !== 'ALL' && e.partyId !== partyId) return false;
      const d = new Date(e.date).toISOString().slice(0, 10);
      if (startDate && d < startDate) return false;
      if (endDate && d > endDate) return false;
      return true;
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows: visible = [] } = usePagedRows(filtered, 50);

  // Metrics
  const totalKataFee = filtered.reduce((acc, e) => acc + e.kataFee, 0);
  const lorryCount = filtered.length;

  // Bracket counts
  const brackets = filtered.reduce(
    (acc, e) => {
      const tonnes = e.netWeightKg / 1000;
      if (tonnes <= 15) acc.bracket1 += 1;
      else if (tonnes <= 30) acc.bracket2 += 1;
      else acc.bracket3 += 1;
      return acc;
    },
    { bracket1: 0, bracket2: 0, bracket3: 0 }
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Kata Report</h1>
          <p className="text-muted-foreground">Weighbridge fees across purchases, dust buys, sale freight and byproduct transfers (KNM vehicles exempt)</p>
        </div>
        <ExportButtons
          filename="Kata_Report"
          title="Kata (Weighbridge) Report"
          subtitle={`${filtered.length} transaction(s)`}
          columns={KATA_EXPORT_COLUMNS}
          rows={filtered}
        />
      </div>

      {/* Filters Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 bg-muted/40 p-4 rounded-lg border">
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold">Filter by Supplier</Label>
          <Combobox
            options={supplierOptions}
            value={partyId}
            onChange={setPartyId}
            placeholder="All Suppliers"
            searchPlaceholder="Search supplier…"
            ariaLabel="Filter by supplier"
            className="w-full bg-card"
          />
        </div>
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
            <Card className="bg-card border shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Kata Fees</CardTitle>
                <Scale className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-primary">{rupees(totalKataFee)}</div>
                <p className="text-[10px] text-muted-foreground mt-1">Sum of all weighbridge check costs</p>
              </CardContent>
            </Card>
            <Card className="bg-card border shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Lorries Weighed</CardTitle>
                <Truck className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{lorryCount} lorries</div>
                <p className="text-[10px] text-muted-foreground mt-1">Weighed empty and full on arrival</p>
              </CardContent>
            </Card>
            <Card className="bg-card border shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Category Distribution</CardTitle>
                <PieChart className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-xs space-y-1 mt-0.5">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">≤15t (₹50):</span>
                    <span className="font-semibold">{brackets.bracket1}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">15-30t (₹150):</span>
                    <span className="font-semibold">{brackets.bracket2}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">&gt;30t (₹200):</span>
                    <span className="font-semibold">{brackets.bracket3}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Ledger Table */}
          <div className="rounded-lg border bg-card">
            <div className="px-5 py-4 border-b font-semibold text-sm">Weighbridge Transactions Details</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Party</TableHead>
                  <TableHead>Lorry No</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Net Weight (kg)</TableHead>
                  <TableHead>Weight Bracket</TableHead>
                  <TableHead className="text-right">Kata Fee</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                      No kata fee transactions match selected filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  visible.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>{shortDate(e.date)}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            e.source === 'SALE'
                              ? 'default'
                              : e.source === 'TRANSFER'
                                ? 'secondary'
                                : 'outline'
                          }
                          className="text-[10px]"
                        >
                          {e.source === 'SALE'
                            ? 'Sale Freight'
                            : e.source === 'TRANSFER'
                              ? 'Transfer'
                              : e.source === 'DUST'
                                ? 'Dust Purchase'
                                : 'Purchase'}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-semibold">{e.partyName}</TableCell>
                      <TableCell>{e.lorryNumber ?? '-'}</TableCell>
                      <TableCell className="font-mono text-xs">{e.reference}</TableCell>
                      <TableCell className="text-right font-medium">{kg(e.netWeightKg)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{getWeightBracket(e.netWeightKg)}</TableCell>
                      <TableCell className="text-right font-bold text-primary">{rupees(e.kataFee)}</TableCell>
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
