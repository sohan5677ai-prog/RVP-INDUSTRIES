import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Party, Purchase, SaleOrder } from '@/lib/types';
import { kg, rupees, shortDate } from '@/lib/format';
import { hamaliSplit, pappuLoadingHamali, calcHamali } from '@/lib/calc';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Coins, TrendingUp, Truck } from 'lucide-react';

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

// A unified hamali entry — from a purchase (inward unloading) or from the
// loading hamali deducted out of a sale's outward lorry freight. Both post to
// GL 20200 (crew) and 40030 (company margin → P/L).
interface HamaliEntry {
  id: string;
  date: string;
  source: 'PURCHASE' | 'SALE';
  partyId: string | null;
  partyName: string;
  lorryNumber: string | null;
  reference: string;
  netWeightKg: number;
  fullCharge: number;
  ourShare: number;
  lorryShare: number;
  crew: number;
  pl: number;
}

export default function HamaliLedger() {
  const [partyId, setPartyId] = useState<string>('ALL');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');

  const { data: parties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const { data: purchases, isLoading: loadingPurchases } = useQuery({
    queryKey: ['purchases'],
    queryFn: () => api<PurchaseRow[]>('/purchases'),
  });

  const { data: saleOrders, isLoading: loadingSales } = useQuery({
    queryKey: ['sale-orders'],
    queryFn: () => api<SaleOrder[]>('/sale-orders'),
  });

  const isLoading = loadingPurchases || loadingSales;
  const suppliers = parties?.filter((p) => p.type !== 'BUYER') ?? [];

  // Purchase (inward) hamali — funding split inventory/lorry, usage crew/margin.
  const purchaseEntries: HamaliEntry[] = (purchases ?? []).map((p) => {
    const s = hamaliSplit(Number(p.hamaliCharge));
    return {
      id: `PUR-${p.id}`,
      date: p.stockIn?.arrivalDate ?? p.createdAt,
      source: 'PURCHASE',
      partyId: p.stockIn?.purchaseOrder?.partyId ?? null,
      partyName: p.stockIn?.purchaseOrder?.party?.name ?? '—',
      lorryNumber: p.stockIn?.lorryNumber ?? null,
      reference: `Inv ${p.stockIn?.invoiceNumber ?? '—'}`,
      netWeightKg: p.netWeightKg,
      fullCharge: s.total,
      ourShare: s.inventory,
      lorryShare: s.lorry,
      crew: s.crew,
      pl: s.margin,
    };
  });

  // Sale (outward) loading hamali. Pappu uses the ₹220/t split (our 140 / lorry
  // 80, crew 210 / P/L 10); other products keep the flat ₹160/t fully on the lorry.
  const saleEntries: HamaliEntry[] = (saleOrders ?? [])
    .flatMap((o) => (o.dispatches ?? []).map((d) => ({ o, d })))
    .filter(({ d }) => Number(d.freightCharge) > 0)
    .map(({ o, d }) => {
      const base = {
        id: `SALE-${d.id}`,
        date: d.dispatchDate,
        source: 'SALE' as const,
        partyId: o.buyerId,
        partyName: o.buyer?.name ?? '—',
        lorryNumber: d.vehicleNumber ?? null,
        reference: d.invoiceNumber ?? '—',
        netWeightKg: d.weightKg,
      };
      if (o.product === 'PAPPU') {
        const lh = pappuLoadingHamali(d.weightKg);
        return { ...base, fullCharge: lh.total, ourShare: lh.company, lorryShare: lh.lorry, crew: lh.crew, pl: lh.margin };
      }
      const full = calcHamali(d.weightKg);
      return { ...base, fullCharge: full, ourShare: 0, lorryShare: full, crew: full, pl: 0 };
    });

  const filtered = [...purchaseEntries, ...saleEntries]
    .filter((e) => {
      if (partyId !== 'ALL' && e.partyId !== partyId) return false;
      const d = new Date(e.date).toISOString().slice(0, 10);
      if (startDate && d < startDate) return false;
      if (endDate && d > endDate) return false;
      return true;
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Metrics
  const totalHamali = filtered.reduce((acc, e) => acc + e.fullCharge, 0);
  const totalPl = filtered.reduce((acc, e) => acc + e.pl, 0);
  const totalTons = filtered.reduce((acc, e) => acc + e.netWeightKg, 0) / 1000;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Hamali Report</h1>
        <p className="text-muted-foreground">Unloading &amp; loading labor charges from purchases and outward sale freight</p>
      </div>

      {/* Filters Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 bg-muted/40 p-4 rounded-lg border">
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold">Filter by Supplier</Label>
          <Select value={partyId} onValueChange={setPartyId}>
            <SelectTrigger className="bg-card">
              <SelectValue placeholder="All Suppliers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Suppliers</SelectItem>
              {suppliers.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
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
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Hamali Charge</CardTitle>
                <Coins className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-primary">{rupees(totalHamali)}</div>
                <p className="text-[10px] text-muted-foreground mt-1">Full charge across purchases &amp; sale loading</p>
              </CardContent>
            </Card>
            <Card className="bg-card border shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Company P/L (Hamali Margin)</CardTitle>
                <TrendingUp className="h-4 w-4 text-emerald-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{rupees(totalPl)}</div>
                <p className="text-[10px] text-muted-foreground mt-1">Margin retained from hamali → P/L</p>
              </CardContent>
            </Card>
            <Card className="bg-card border shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Weight Handled</CardTitle>
                <Truck className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{(totalTons).toFixed(2)} tonnes</div>
                <p className="text-[10px] text-muted-foreground mt-1">Equal to {kg(totalTons * 1000)} net weight</p>
              </CardContent>
            </Card>
          </div>

          {/* Ledger Table */}
          <div className="rounded-lg border bg-card overflow-x-auto">
            <div className="px-5 py-4 border-b font-semibold text-sm">Hamali Disbursements</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Party</TableHead>
                  <TableHead>Lorry No</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Net Weight (kg)</TableHead>
                  <TableHead className="text-right">Full Charge</TableHead>
                  <TableHead className="text-right">Our Share</TableHead>
                  <TableHead className="text-right">Lorry Share</TableHead>
                  <TableHead className="text-right">Crew Paid</TableHead>
                  <TableHead className="text-right">Company P/L</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                      No hamali transactions match selected filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>{shortDate(e.date)}</TableCell>
                      <TableCell>
                        <Badge variant={e.source === 'SALE' ? 'default' : 'outline'} className="text-[10px]">
                          {e.source === 'SALE' ? 'Sale Loading' : 'Purchase'}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-semibold">{e.partyName}</TableCell>
                      <TableCell>{e.lorryNumber ?? '—'}</TableCell>
                      <TableCell className="font-mono text-xs">{e.reference}</TableCell>
                      <TableCell className="text-right font-medium">{kg(e.netWeightKg)}</TableCell>
                      <TableCell className="text-right font-bold text-primary">{rupees(e.fullCharge)}</TableCell>
                      <TableCell className="text-right font-semibold text-amber-600">{rupees(e.ourShare)}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{rupees(e.lorryShare)}</TableCell>
                      <TableCell className="text-right">{rupees(e.crew)}</TableCell>
                      <TableCell className="text-right font-semibold text-emerald-600 dark:text-emerald-400">{rupees(e.pl)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
