import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Party, Purchase, SaleOrder } from '@/lib/types';
import { kg, rupees, shortDate } from '@/lib/format';
import { calcKataFee } from '@/lib/calc';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
  source: 'PURCHASE' | 'SALE';
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
  if (tonnes <= 25) return '15-25 tonnes (₹150)';
  return '> 25 tonnes (₹200)';
}

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
    queryFn: () => api<PurchaseRow[]>('/purchases'),
  });

  const { data: saleOrders, isLoading: loadingSales } = useQuery({
    queryKey: ['sale-orders'],
    queryFn: () => api<SaleOrder[]>('/sale-orders'),
  });

  const isLoading = loadingPurchases || loadingSales;
  const suppliers = parties?.filter((p) => p.type !== 'BUYER') ?? [];

  // Purchase (inward) kata fees from the weighbridge on arrival.
  const purchaseEntries: KataEntry[] = (purchases ?? []).map((p) => ({
    id: `PUR-${p.id}`,
    date: p.stockIn?.arrivalDate ?? p.createdAt,
    source: 'PURCHASE',
    partyId: p.stockIn?.purchaseOrder?.partyId ?? null,
    partyName: p.stockIn?.purchaseOrder?.party?.name ?? '—',
    lorryNumber: p.stockIn?.lorryNumber ?? null,
    reference: `Inv ${p.stockIn?.invoiceNumber ?? '—'}`,
    netWeightKg: p.netWeightKg,
    kataFee: Number(p.kataFee),
  }));

  // Sale (outward) kata fees deducted from the lorry's delivery freight.
  const saleEntries: KataEntry[] = (saleOrders ?? [])
    .filter((o) => Number(o.freightCharge) > 0 && o.status !== 'PENDING')
    .map((o) => ({
      id: `SALE-${o.id}`,
      date: o.saleDate,
      source: 'SALE',
      partyId: o.buyerId,
      partyName: o.buyer?.name ?? '—',
      lorryNumber: o.vehicleNumber ?? null,
      reference: o.invoiceNumber ?? '—',
      netWeightKg: o.tonnageKg,
      kataFee: calcKataFee(o.tonnageKg),
    }));

  const allEntries = [...purchaseEntries, ...saleEntries];

  const filtered = allEntries
    .filter((e) => {
      if (partyId !== 'ALL' && e.partyId !== partyId) return false;
      const d = new Date(e.date).toISOString().slice(0, 10);
      if (startDate && d < startDate) return false;
      if (endDate && d > endDate) return false;
      return true;
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Metrics
  const totalKataFee = filtered.reduce((acc, e) => acc + e.kataFee, 0);
  const lorryCount = filtered.length;

  // Bracket counts
  const brackets = filtered.reduce(
    (acc, e) => {
      const tonnes = e.netWeightKg / 1000;
      if (tonnes <= 15) acc.bracket1 += 1;
      else if (tonnes <= 25) acc.bracket2 += 1;
      else acc.bracket3 += 1;
      return acc;
    },
    { bracket1: 0, bracket2: 0, bracket3: 0 }
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Kata Fee Ledger</h1>
        <p className="text-muted-foreground">Weighbridge fees from purchases and outward sale freight</p>
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
                    <span className="text-muted-foreground">15-25t (₹150):</span>
                    <span className="font-semibold">{brackets.bracket2}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">&gt;25t (₹200):</span>
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
                  filtered.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>{shortDate(e.date)}</TableCell>
                      <TableCell>
                        <Badge variant={e.source === 'SALE' ? 'default' : 'outline'} className="text-[10px]">
                          {e.source === 'SALE' ? 'Sale Freight' : 'Purchase'}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-semibold">{e.partyName}</TableCell>
                      <TableCell>{e.lorryNumber ?? '—'}</TableCell>
                      <TableCell className="font-mono text-xs">{e.reference}</TableCell>
                      <TableCell className="text-right font-medium">{kg(e.netWeightKg)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{getWeightBracket(e.netWeightKg)}</TableCell>
                      <TableCell className="text-right font-bold text-primary">{rupees(e.kataFee)}</TableCell>
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
