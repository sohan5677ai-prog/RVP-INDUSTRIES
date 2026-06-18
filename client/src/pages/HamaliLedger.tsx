import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Party, Purchase } from '@/lib/types';
import { kg, rupees, shortDate } from '@/lib/format';
import { companyHamaliShare } from '@/lib/calc';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, Coins, Truck, BarChart3 } from 'lucide-react';

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

export default function HamaliLedger() {
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
  const totalHamali = filteredPurchases.reduce((acc, p) => acc + Number(p.hamaliCharge), 0);
  const totalCompanyHamali = filteredPurchases.reduce((acc, p) => acc + companyHamaliShare(Number(p.hamaliCharge)), 0);
  const totalTons = filteredPurchases.reduce((acc, p) => acc + p.netWeightKg, 0) / 1000;
  const avgRate = filteredPurchases.length > 0
    ? filteredPurchases.reduce((acc, p) => acc + Number(p.hamaliRate), 0) / filteredPurchases.length
    : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Hamali Expense Ledger</h1>
        <p className="text-muted-foreground">Reconcile unloading labor payouts and hamali charges by lorry</p>
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
                <p className="text-[10px] text-muted-foreground mt-1">
                  Full charge @ ₹160/tonne · <span className="text-amber-600 font-semibold">{rupees(totalCompanyHamali)} borne by us (50%)</span>
                </p>
              </CardContent>
            </Card>
            <Card className="bg-card border shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Weight Unloaded</CardTitle>
                <Truck className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{(totalTons).toFixed(2)} tonnes</div>
                <p className="text-[10px] text-muted-foreground mt-1">Equal to {kg(totalTons * 1000)} net weight</p>
              </CardContent>
            </Card>
            <Card className="bg-card border shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Average Hamali Rate</CardTitle>
                <BarChart3 className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{rupees(avgRate)}/t</div>
                <p className="text-[10px] text-muted-foreground mt-1">Average rate paid per ton</p>
              </CardContent>
            </Card>
          </div>

          {/* Ledger Table */}
          <div className="rounded-lg border bg-card">
            <div className="px-5 py-4 border-b font-semibold text-sm">Hamali Disbursements</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Lorry No</TableHead>
                  <TableHead>Invoice Reference</TableHead>
                  <TableHead className="text-right">Net Weight (kg)</TableHead>
                  <TableHead className="text-right">Rate (₹/tonne)</TableHead>
                  <TableHead className="text-right">Full Charge</TableHead>
                  <TableHead className="text-right">Our Share (50%)</TableHead>
                  <TableHead className="text-right">Lorry Share (50%)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredPurchases.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                      No hamali transactions match selected filters.
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
                      <TableCell className="text-right">{rupees(p.hamaliRate)}</TableCell>
                      <TableCell className="text-right font-bold text-primary">{rupees(p.hamaliCharge)}</TableCell>
                      <TableCell className="text-right font-semibold text-amber-600">{rupees(companyHamaliShare(Number(p.hamaliCharge)))}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{rupees(companyHamaliShare(Number(p.hamaliCharge)))}</TableCell>
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
