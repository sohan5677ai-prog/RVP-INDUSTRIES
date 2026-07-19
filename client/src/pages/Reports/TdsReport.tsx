import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Landmark, Users, IndianRupee, ReceiptText, FileCheck2 } from 'lucide-react';
import { api } from '@/lib/api';
import { rupees, shortDate } from '@/lib/format';
import type { TdsReport as TdsReportData, TdsEntry, TdsDeductorSummary } from '@/lib/types';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { PeriodFilter, periodFor, fyLabel } from '@/components/PeriodFilter';
import { ExportButtons } from '@/components/ExportButtons';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ExportColumn } from '@/lib/export';

const Num = ({ v, bold }: { v: number; bold?: boolean }) => (
  <span className={'font-mono tabular-nums ' + (bold ? 'font-semibold' : '')}>
    {Math.abs(v) < 0.005 ? '–' : rupees(v)}
  </span>
);

export default function TdsReport() {
  const now = new Date();
  const [fy, setFy] = useState(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1);
  const [month, setMonth] = useState<number | 'ALL'>('ALL');

  const period = useMemo(() => periodFor(fy, month), [fy, month]);

  const { data, isLoading } = useQuery({
    queryKey: ['tds-report', period.from, period.to],
    queryFn: () => api<TdsReportData>(`/reports/tds?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`),
  });

  const entryCols: ExportColumn<TdsEntry>[] = [
    { header: 'Date', value: (r) => shortDate(r.date) },
    { header: 'Deductor (Buyer)', value: (r) => r.deductorName },
    { header: 'PAN', value: (r) => r.pan ?? '-' },
    { header: 'GSTIN', value: (r) => r.gstin ?? '-' },
    { header: 'Invoice', value: (r) => r.invoiceNumber ?? '-' },
    { header: 'Section', value: (r) => r.section },
    { header: 'Sale Value', value: (r) => r.saleValue, numFmt: '#,##0.00' },
    { header: 'Rate %', value: (r) => r.tdsRate, align: 'right' },
    { header: 'TDS', value: (r) => r.tdsAmount, numFmt: '#,##0.00' },
  ];

  const deductorCols: ExportColumn<TdsDeductorSummary>[] = [
    { header: 'Deductor (Buyer)', value: (r) => r.deductorName },
    { header: 'PAN', value: (r) => r.pan ?? '-' },
    { header: 'GSTIN', value: (r) => r.gstin ?? '-' },
    { header: 'Transactions', value: (r) => r.entryCount, align: 'right' },
    { header: 'Sale Value', value: (r) => r.saleValue, numFmt: '#,##0.00' },
    { header: 'TDS Deducted', value: (r) => r.tdsAmount, numFmt: '#,##0.00' },
  ];

  const sum = data?.summary;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Landmark}
        title="TDS Report"
        description="TDS deducted by buyers on your sales under Section 194Q — your credit in Form 26AS at income-tax filing."
        actions={data && <PeriodFilter fy={fy} month={month} onFyChange={setFy} onMonthChange={setMonth} />}
      />

      {isLoading ? (
        <Card className="p-8 text-center text-muted-foreground">Loading TDS report…</Card>
      ) : !data || !sum ? (
        <Card className="p-8 text-center text-muted-foreground">Unable to load the TDS report.</Card>
      ) : (
        <>
          {/* Period banner */}
          <Card className="p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <FileCheck2 className="h-5 w-5" />
              </div>
              <div>
                <div className="font-semibold text-foreground">TDS Receivable — Section 194Q</div>
                <div className="text-xs text-muted-foreground">Deducted by buyers @ 0.1% of the taxable sale value. Reconcile against Form 26AS.</div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Assessment Period</div>
              <div className="font-semibold text-foreground">{period.label}</div>
            </div>
          </Card>

          {/* Summary KPIs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Total TDS Credit" value={rupees(sum.totalTds)} icon={IndianRupee} tone="forest" hint="Claimable at ITR" />
            <StatCard label="Sale Value (TDS base)" value={rupees(sum.totalSaleValue)} icon={ReceiptText} tone="amber" />
            <StatCard label="Deductors (Buyers)" value={sum.deductorCount} icon={Users} tone="taupe" />
            <StatCard label="Transactions" value={sum.entryCount} icon={FileCheck2} tone="gold" />
          </div>

          <Tabs defaultValue="deductor" className="space-y-4">
            <TabsList className="bg-card border shadow-sm">
              <TabsTrigger value="deductor" className="gap-2"><Users className="h-4 w-4" /> By Deductor</TabsTrigger>
              <TabsTrigger value="entries" className="gap-2"><ReceiptText className="h-4 w-4" /> Transaction-wise</TabsTrigger>
            </TabsList>

            {/* ── BY DEDUCTOR (26AS-style) ── */}
            <TabsContent value="deductor" className="space-y-3">
              <div className="flex justify-end">
                <ExportButtons filename={`TDS-by-Deductor-${fyLabel(fy)}`} title="TDS 194Q — Summary by Deductor" subtitle={period.label} columns={deductorCols} rows={data.byDeductor} />
              </div>
              <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead>Deductor (Buyer)</TableHead>
                      <TableHead>PAN</TableHead>
                      <TableHead>GSTIN</TableHead>
                      <TableHead className="text-right">Txns</TableHead>
                      <TableHead className="text-right">Sale Value</TableHead>
                      <TableHead className="text-right">TDS Deducted</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.byDeductor.length === 0 ? (
                      <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No TDS deducted in this period.</TableCell></TableRow>
                    ) : data.byDeductor.map((r) => (
                      <TableRow key={r.gstin ?? r.deductorName}>
                        <TableCell className="font-medium">{r.deductorName}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{r.pan ?? '-'}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{r.gstin ?? '-'}</TableCell>
                        <TableCell className="text-right text-muted-foreground">{r.entryCount}</TableCell>
                        <TableCell className="text-right"><Num v={r.saleValue} /></TableCell>
                        <TableCell className="text-right"><Num v={r.tdsAmount} bold /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  {data.byDeductor.length > 0 && (
                    <TableFooter>
                      <TableRow className="bg-muted/50 font-semibold">
                        <TableCell colSpan={4}>Total</TableCell>
                        <TableCell className="text-right"><Num v={sum.totalSaleValue} bold /></TableCell>
                        <TableCell className="text-right"><Num v={sum.totalTds} bold /></TableCell>
                      </TableRow>
                    </TableFooter>
                  )}
                </Table>
              </div>
            </TabsContent>

            {/* ── TRANSACTION-WISE ── */}
            <TabsContent value="entries" className="space-y-3">
              <div className="flex justify-end">
                <ExportButtons filename={`TDS-Transactions-${fyLabel(fy)}`} title="TDS 194Q — Transaction Detail" subtitle={period.label} columns={entryCols} rows={data.entries} />
              </div>
              <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead>Date</TableHead>
                      <TableHead>Deductor (Buyer)</TableHead>
                      <TableHead>PAN</TableHead>
                      <TableHead>Invoice</TableHead>
                      <TableHead>Section</TableHead>
                      <TableHead className="text-right">Sale Value</TableHead>
                      <TableHead className="text-right">Rate</TableHead>
                      <TableHead className="text-right">TDS</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.entries.length === 0 ? (
                      <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">No TDS deducted in this period.</TableCell></TableRow>
                    ) : data.entries.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="whitespace-nowrap">{shortDate(r.date)}</TableCell>
                        <TableCell className="font-medium">{r.deductorName}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{r.pan ?? '-'}</TableCell>
                        <TableCell>{r.invoiceNumber ?? '-'}</TableCell>
                        <TableCell><Badge variant="secondary" className="font-mono text-[10px]">{r.section}</Badge></TableCell>
                        <TableCell className="text-right"><Num v={r.saleValue} /></TableCell>
                        <TableCell className="text-right text-muted-foreground">{r.tdsRate}%</TableCell>
                        <TableCell className="text-right"><Num v={r.tdsAmount} bold /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  {data.entries.length > 0 && (
                    <TableFooter>
                      <TableRow className="bg-muted/50 font-semibold">
                        <TableCell colSpan={5}>Total ({data.entries.length})</TableCell>
                        <TableCell className="text-right"><Num v={sum.totalSaleValue} bold /></TableCell>
                        <TableCell />
                        <TableCell className="text-right"><Num v={sum.totalTds} bold /></TableCell>
                      </TableRow>
                    </TableFooter>
                  )}
                </Table>
              </div>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
