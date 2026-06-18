import { useQuery } from '@tanstack/react-query';
import { Loader2, Warehouse, Scale, IndianRupee } from 'lucide-react';
import { api } from '@/lib/api';
import { kg, rupees, shortDate, toTonnes } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';

interface BlackSeedRow {
  purchaseId: string;
  date: string;
  invoiceNumber: string;
  partyName: string;
  poNumber: string | null;
  lorryNumber: string;
  rvpNetWeightKg: number;
  location: string;
  pricePerKg: number;
  hamaliCharge: number;
  companyHamali: number;
  value: number;
  verified: boolean;
}

export default function BlackSeedStock() {
  const { data: rows, isLoading } = useQuery({
    queryKey: ['black-seed-stock'],
    queryFn: () => api<BlackSeedRow[]>('/inventory/black-seed'),
  });

  const items = rows ?? [];
  const totalWeight = items.reduce((sum, r) => sum + r.rvpNetWeightKg, 0);
  const totalValue = items.reduce((sum, r) => sum + r.value, 0);
  const totalHamali = items.reduce((sum, r) => sum + r.companyHamali, 0);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Black Seed Stock</h1>
        <p className="text-muted-foreground">
          Raw black seed on hand, lorry by lorry. Value includes the company's 50% share of hamali.
        </p>
      </div>

      {/* KPI summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Raw Stock</CardTitle>
            <Warehouse className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{toTonnes(totalWeight).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">({kg(totalWeight)} across {items.length} lorries)</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Stock Valuation</CardTitle>
            <IndianRupee className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-600">{rupees(totalValue)}</div>
            <p className="text-[10px] text-muted-foreground mt-1">Seed cost + our hamali share</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Hamali Borne by Us (50%)</CardTitle>
            <Scale className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-600">{rupees(totalHamali)}</div>
            <p className="text-[10px] text-muted-foreground mt-1">Capitalised into stock value</p>
          </CardContent>
        </Card>
      </div>

      {/* Detailed stock ledger */}
      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Invoice No</TableHead>
              <TableHead>Party Name</TableHead>
              <TableHead className="text-right">RVP Net Weight</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-right">Value (incl. hamali)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  No black seed in stock. Approve purchases on the Verification page to add stock.
                </TableCell>
              </TableRow>
            )}
            {items.map((r) => (
              <TableRow key={r.purchaseId}>
                <TableCell>{shortDate(r.date)}</TableCell>
                <TableCell className="font-semibold">
                  {r.invoiceNumber}
                  {r.poNumber && <span className="ml-2 text-[11px] text-muted-foreground font-mono">({r.poNumber})</span>}
                </TableCell>
                <TableCell className="font-medium">{r.partyName}</TableCell>
                <TableCell className="text-right font-semibold">{kg(r.rvpNetWeightKg)}</TableCell>
                <TableCell><Badge variant="outline">{r.location}</Badge></TableCell>
                <TableCell className="text-right">
                  <div className="font-semibold text-emerald-600">{rupees(r.value)}</div>
                  <div className="text-[10px] text-muted-foreground">
                    incl. {rupees(r.companyHamali)} hamali
                    {!r.verified && <span className="ml-1 text-amber-600">· unverified</span>}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
