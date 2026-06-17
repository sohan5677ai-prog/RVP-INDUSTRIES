import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Party, Purchase } from '@/lib/types';
import { kg, rupees, shortDate } from '@/lib/format';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

function getWeightBracket(weightKg: number): string {
  const tonnes = weightKg / 1000;
  if (tonnes < 10) return '< 10 tonnes (₹50)';
  if (tonnes <= 15) return '10-15 tonnes (₹100)';
  if (tonnes <= 30) return '15-30 tonnes (₹150)';
  return '> 30 tonnes (₹200)';
}

export default function KataFeeLedger() {
  const [partyId, setPartyId] = useState<string>('ALL');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');

  const { data: parties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const { data: purchases, isLoading } = useQuery({
    queryKey: ['purchases'],
    queryFn: () => api<PurchaseRow[]>('/purchases'),
  });

  const suppliers = parties?.filter((p) => p.type !== 'BUYER') ?? [];

  // Filter transactions
  const filteredPurchases = purchases?.filter((p) => {
    // 1. Party Filter
    if (partyId !== 'ALL' && p.stockIn?.purchaseOrder?.partyId !== partyId) {
      return false;
    }
    // 2. Start Date Filter
    if (startDate) {
      const date = new Date(p.createdAt).toISOString().slice(0, 10);
      if (date < startDate) return false;
    }
    // 3. End Date Filter
    if (endDate) {
      const date = new Date(p.createdAt).toISOString().slice(0, 10);
      if (date > endDate) return false;
    }
    return true;
  }) ?? [];

  // Metrics
  const totalKataFee = filteredPurchases.reduce((acc, p) => acc + Number(p.kataFee), 0);
  const lorryCount = filteredPurchases.length;

  // Bracket counts
  const brackets = filteredPurchases.reduce(
    (acc, p) => {
      const tonnes = p.netWeightKg / 1000;
      if (tonnes < 10) acc.bracket1 += 1;
      else if (tonnes <= 15) acc.bracket2 += 1;
      else if (tonnes <= 30) acc.bracket3 += 1;
      else acc.bracket4 += 1;
      return acc;
    },
    { bracket1: 0, bracket2: 0, bracket3: 0, bracket4: 0 }
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Kata Fee Ledger</h1>
        <p className="text-muted-foreground">Monitor weighbridge expenses and categories incurred per shipment</p>
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
                    <span className="text-muted-foreground">&lt;10t (₹50):</span>
                    <span className="font-semibold">{brackets.bracket1}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">10-15t (₹100):</span>
                    <span className="font-semibold">{brackets.bracket2}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">15-30t (₹150):</span>
                    <span className="font-semibold">{brackets.bracket3}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">&gt;30t (₹200):</span>
                    <span className="font-semibold">{brackets.bracket4}</span>
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
                  <TableHead>Supplier</TableHead>
                  <TableHead>Lorry No</TableHead>
                  <TableHead>Invoice Reference</TableHead>
                  <TableHead className="text-right">Net Weight (kg)</TableHead>
                  <TableHead>Weight Bracket</TableHead>
                  <TableHead className="text-right">Kata Fee</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredPurchases.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                      No kata fee transactions match selected filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredPurchases.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>{shortDate(p.createdAt)}</TableCell>
                      <TableCell className="font-semibold">{p.stockIn?.purchaseOrder?.party?.name ?? '—'}</TableCell>
                      <TableCell>{p.stockIn?.lorryNumber ?? '—'}</TableCell>
                      <TableCell className="font-mono text-xs">Inv {p.stockIn?.invoiceNumber ?? '—'}</TableCell>
                      <TableCell className="text-right font-medium">{kg(p.netWeightKg)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{getWeightBracket(p.netWeightKg)}</TableCell>
                      <TableCell className="text-right font-bold text-primary">{rupees(p.kataFee)}</TableCell>
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
