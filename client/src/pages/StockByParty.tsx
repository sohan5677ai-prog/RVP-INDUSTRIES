import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Loader2, Users, ArrowUpRight, ArrowDownRight, Archive } from 'lucide-react';
import { api } from '@/lib/api';
import { kg, toTonnes } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';

interface PartyStock {
  partyId: string;
  partyName: string;
  phone: string;
  address: string;
  state: string;
  totalPurchasedKg: number;
  totalMilledKg: number;
  netStockKg: number;
}

export default function StockByParty() {
  const [searchQuery, setSearchQuery] = useState('');

  const { data: partyStocks, isLoading } = useQuery<PartyStock[]>({
    queryKey: ['party-stocks'],
    queryFn: () => api<PartyStock[]>('/inventory/by-party'),
  });

  const totalReceived = partyStocks?.reduce((sum, p) => sum + p.totalPurchasedKg, 0) ?? 0;
  const totalMilled = partyStocks?.reduce((sum, p) => sum + p.totalMilledKg, 0) ?? 0;
  const totalRemaining = partyStocks?.reduce((sum, p) => sum + p.netStockKg, 0) ?? 0;

  const filteredPartyStocks = partyStocks?.filter((p) => {
    const term = searchQuery.toLowerCase();
    return (
      p.partyName.toLowerCase().includes(term) ||
      p.address.toLowerCase().includes(term) ||
      p.state.toLowerCase().includes(term)
    );
  }) ?? [];

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
        <h1 className="text-2xl font-bold">Stock by Party</h1>
        <p className="text-muted-foreground">
          Track raw black seed stock balances credited to individual suppliers
        </p>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Purchased from Suppliers</CardTitle>
            <ArrowUpRight className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-600">{toTonnes(totalReceived).toFixed(2)} MT</div>
            <p className="text-xs text-muted-foreground mt-1">({kg(totalReceived)} raw weight)</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Milled (Processed)</CardTitle>
            <ArrowDownRight className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{toTonnes(totalMilled).toFixed(2)} MT</div>
            <p className="text-xs text-muted-foreground mt-1">({kg(totalMilled)} black seed milled)</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Remaining Raw Stock on Hand</CardTitle>
            <Archive className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{toTonnes(totalRemaining).toFixed(2)} MT</div>
            <p className="text-xs text-muted-foreground mt-1">({kg(totalRemaining)} net remaining)</p>
          </CardContent>
        </Card>
      </div>

      {/* Main Table Card */}
      <Card>
        <div className="px-5 py-4 border-b flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-muted/10 rounded-t-xl">
          <div>
            <h3 className="font-semibold text-sm">Supplier Inventory Ledger</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Summary of total quantities received, processed, and on-hand per party
            </p>
          </div>
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search supplier or location…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-card"
            />
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Supplier Party</TableHead>
              <TableHead>Location / Address</TableHead>
              <TableHead className="text-right">Total Purchased</TableHead>
              <TableHead className="text-right">Total Milled</TableHead>
              <TableHead className="text-right font-bold text-primary">Net Stock Remaining</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredPartyStocks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  No supplier stock details found.
                </TableCell>
              </TableRow>
            ) : (
              filteredPartyStocks.map((p) => (
                <TableRow key={p.partyId}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4 text-muted-foreground" />
                      <span>{p.partyName}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm">{p.address}</div>
                    {p.phone && <div className="text-xs text-muted-foreground font-mono">{p.phone}</div>}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {toTonnes(p.totalPurchasedKg).toFixed(2)} MT
                    <span className="block text-[10px] text-muted-foreground font-normal">({kg(p.totalPurchasedKg)})</span>
                  </TableCell>
                  <TableCell className="text-right font-medium text-blue-600">
                    {toTonnes(p.totalMilledKg).toFixed(2)} MT
                    <span className="block text-[10px] text-muted-foreground font-normal">({kg(p.totalMilledKg)})</span>
                  </TableCell>
                  <TableCell className="text-right font-bold text-primary">
                    {toTonnes(p.netStockKg).toFixed(2)} MT
                    <span className="block text-[10px] text-primary/70 font-semibold">({kg(p.netStockKg)})</span>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
