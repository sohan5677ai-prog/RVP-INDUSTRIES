import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { SaleOrder } from '@/lib/types';
import { rupees, shortDate, toTonnes } from '@/lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Scale, Loader2 } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';

type InternalWeightRow = {
  id: string;
  date: Date;
  partyName: string;
  internalWeightKg: number;
  partyWeightKg: number;
  balanceKg: number;
  profitAmount: number;
};

const INTERNAL_WEIGHT_COLUMNS: ExportColumn<InternalWeightRow>[] = [
  { header: 'Date', value: (e) => shortDate(e.date.toISOString()) },
  { header: 'Party', value: (e) => e.partyName },
  { header: 'Internal Wt (t)', value: (e) => toTonnes(e.internalWeightKg).toFixed(3), excel: (e) => toTonnes(e.internalWeightKg), numFmt: '#,##0.000', align: 'right' },
  { header: 'Party Wt (t)', value: (e) => toTonnes(e.partyWeightKg).toFixed(3), excel: (e) => toTonnes(e.partyWeightKg), numFmt: '#,##0.000', align: 'right' },
  { header: 'Balance (t)', value: (e) => toTonnes(e.balanceKg).toFixed(3), excel: (e) => toTonnes(e.balanceKg), numFmt: '#,##0.000', align: 'right' },
  { header: 'Profit', value: (e) => rupees(e.profitAmount), excel: (e) => e.profitAmount, numFmt: '#,##0.00', align: 'right' },
];

export default function InternalWeightLedger() {
  const { data: saleOrders, isLoading } = useQuery({
    queryKey: ['sale-orders'],
    queryFn: () => api<SaleOrder[]>('/sale-orders'),
  });

  const ledgerEntries: InternalWeightRow[] = [];

  let totalProfit = 0;
  let totalBalanceKg = 0;

  (saleOrders ?? []).forEach((order) => {
    if (order.product !== 'PAPPU') return;
    
    (order.dispatches ?? []).forEach((dispatch) => {
      // We only care about delivered shipments that have an internal weight and buyer kata weight
      if (dispatch.status !== 'DELIVERED') return;
      if (dispatch.internalWeightKg == null || dispatch.buyerKataKg == null) return;
      
      const balanceKg = dispatch.buyerKataKg - dispatch.internalWeightKg;
      
      // Only include rows where there is a moisture gain profit
      if (balanceKg > 0) {
        const profitAmount = Number(dispatch.internalWeightProfitAmount || 0);
        
        totalProfit += profitAmount;
        totalBalanceKg += balanceKg;
        
        ledgerEntries.push({
          id: dispatch.id,
          date: new Date(dispatch.deliveredDate || dispatch.dispatchDate),
          partyName: order.buyer?.name || 'Unknown',
          internalWeightKg: dispatch.internalWeightKg,
          partyWeightKg: dispatch.buyerKataKg,
          balanceKg,
          profitAmount,
        });
      }
    });
  });

  // Sort by date descending
  ledgerEntries.sort((a, b) => b.date.getTime() - a.date.getTime());

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Scale}
        title="Internal Weight Ledger"
        description="Track moisture gains when the delivered party weight exceeds our internal dispatched weight."
        actions={
          <ExportButtons
            filename="Internal_Weight_Ledger"
            title="Internal Weight Ledger"
            subtitle={`${ledgerEntries.length} record(s)`}
            columns={INTERNAL_WEIGHT_COLUMNS}
            rows={ledgerEntries}
          />
        }
      />

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Moisture Gain</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{toTonnes(totalBalanceKg).toFixed(3)} t</div>
              </CardContent>
            </Card>
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Profit Generated</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{rupees(totalProfit)}</div>
              </CardContent>
            </Card>
          </div>

          <div className="rounded-lg border bg-card">
            <div className="px-5 py-4 border-b font-semibold text-sm">Moisture Gain Records</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Party</TableHead>
                  <TableHead className="text-right">Internal Wt.</TableHead>
                  <TableHead className="text-right">Party Wt.</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead className="text-right">Profit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledgerEntries.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No internal weight profits recorded yet.</TableCell></TableRow>
                ) : (
                  ledgerEntries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-medium">{shortDate(entry.date.toISOString())}</TableCell>
                      <TableCell>{entry.partyName}</TableCell>
                      <TableCell className="text-right font-mono">{toTonnes(entry.internalWeightKg).toFixed(3)} t</TableCell>
                      <TableCell className="text-right font-mono">{toTonnes(entry.partyWeightKg).toFixed(3)} t</TableCell>
                      <TableCell className="text-right font-mono text-emerald-600 font-medium">+{toTonnes(entry.balanceKg).toFixed(3)} t</TableCell>
                      <TableCell className="text-right font-bold text-emerald-600 dark:text-emerald-400">
                        {rupees(entry.profitAmount)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
