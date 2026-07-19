import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Receipt, ArrowUpRight, ArrowDownLeft, Scale, FileMinus2, FilePlus2, Building2 } from 'lucide-react';
import { api } from '@/lib/api';
import { rupees, shortDate } from '@/lib/format';
import type { GstReport as GstReportData, GstSalesLine, GstNoteLine, GstPurchaseLine } from '@/lib/types';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { PeriodFilter, periodFor, fyLabel } from '@/components/PeriodFilter';
import { ExportButtons } from '@/components/ExportButtons';
import { Card } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ExportColumn } from '@/lib/export';

function prettyProduct(p: string): string {
  return p.toLowerCase().split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const Num = ({ v, bold }: { v: number; bold?: boolean }) => (
  <span className={'font-mono tabular-nums ' + (bold ? 'font-semibold' : '')}>
    {Math.abs(v) < 0.005 ? '–' : rupees(v)}
  </span>
);

export default function GstReport() {
  const now = new Date();
  const [fy, setFy] = useState(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1);
  const [month, setMonth] = useState<number | 'ALL'>('ALL');

  const period = useMemo(() => periodFor(fy, month), [fy, month]);

  const { data, isLoading } = useQuery({
    queryKey: ['gst-report', period.from, period.to],
    queryFn: () => api<GstReportData>(`/reports/gst?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`),
  });

  const salesCols: ExportColumn<GstSalesLine>[] = [
    { header: 'Date', value: (r) => shortDate(r.date) },
    { header: 'Invoice', value: (r) => r.invoiceNumber ?? '-' },
    { header: 'Buyer', value: (r) => r.partyName },
    { header: 'GSTIN', value: (r) => r.gstin ?? '-' },
    { header: 'Product', value: (r) => prettyProduct(r.product) },
    { header: 'Taxable', value: (r) => r.taxableValue, numFmt: '#,##0.00' },
    { header: 'Rate %', value: (r) => r.gstRate, align: 'right' },
    { header: 'IGST', value: (r) => r.igst, numFmt: '#,##0.00' },
    { header: 'CGST', value: (r) => r.cgst, numFmt: '#,##0.00' },
    { header: 'SGST', value: (r) => r.sgst, numFmt: '#,##0.00' },
    { header: 'Invoice Total', value: (r) => r.invoiceTotal, numFmt: '#,##0.00' },
  ];

  const purchaseCols: ExportColumn<GstPurchaseLine>[] = [
    { header: 'Date', value: (r) => shortDate(r.date) },
    { header: 'Inv No', value: (r) => r.invoiceNumber },
    { header: 'PO', value: (r) => r.poNumber ?? '-' },
    { header: 'Supplier', value: (r) => r.partyName },
    { header: 'GSTIN', value: (r) => r.gstin ?? '-' },
    { header: 'Taxable', value: (r) => r.taxableValue, numFmt: '#,##0.00' },
    { header: 'Rate %', value: (r) => r.gstRate, align: 'right' },
    { header: 'IGST', value: (r) => r.igst, numFmt: '#,##0.00' },
    { header: 'CGST', value: (r) => r.cgst, numFmt: '#,##0.00' },
    { header: 'SGST', value: (r) => r.sgst, numFmt: '#,##0.00' },
    { header: 'Invoice Total', value: (r) => r.invoiceTotal, numFmt: '#,##0.00' },
  ];

  const out = data?.output;
  const inp = data?.input;
  const sum = data?.summary;
  const netPayablePositive = (sum?.netPayable ?? 0) >= 0;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Receipt}
        title="GST Report"
        description="Output tax on sales and input tax credit on purchases — reconciled for your GSTR filing."
        actions={
          data && (
            <div className="flex flex-wrap items-center gap-2">
              <PeriodFilter fy={fy} month={month} onFyChange={setFy} onMonthChange={setMonth} />
            </div>
          )
        }
      />

      {isLoading ? (
        <Card className="p-8 text-center text-muted-foreground">Loading GST report…</Card>
      ) : !data || !out || !inp || !sum ? (
        <Card className="p-8 text-center text-muted-foreground">Unable to load the GST report.</Card>
      ) : (
        <>
          {/* Company + period banner */}
          <Card className="p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Building2 className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-foreground truncate">{data.company?.name ?? 'RVP Industries'}</div>
                <div className="text-xs text-muted-foreground">
                  {data.company?.gstin ? <>GSTIN <span className="font-mono">{data.company.gstin}</span></> : 'GSTIN not set'}
                  {data.company?.stateName ? ` · ${data.company.stateName} (${data.company.stateCode ?? '—'})` : ''}
                </div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Return Period</div>
              <div className="font-semibold text-foreground">{period.label}</div>
            </div>
          </Card>

          {/* Summary KPIs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Output Tax (Sales)" value={rupees(sum.outputTax)} icon={ArrowUpRight} tone="rose"
              hint={`Taxable ${rupees(out.taxableTotal)}`} />
            <StatCard label="Input Tax Credit" value={rupees(sum.inputTaxCredit)} icon={ArrowDownLeft} tone="forest"
              hint={`Taxable ${rupees(inp.taxableTotal)}`} />
            <StatCard label="Net Note Adjustment" value={rupees(sum.debitNoteTax - sum.creditNoteTax)} icon={FileMinus2} tone="gold"
              hint={`CN ${rupees(sum.creditNoteTax)} · DN ${rupees(sum.debitNoteTax)}`} />
            <StatCard
              label={netPayablePositive ? 'Net GST Payable' : 'ITC Carried Forward'}
              value={rupees(Math.abs(sum.netPayable))}
              icon={Scale}
              tone={netPayablePositive ? 'clay' : 'forest'}
              hint={netPayablePositive ? 'Output − Input' : 'Input exceeds output'}
            />
          </div>

          {/* Liability reconciliation strip */}
          <Card className="p-0 overflow-hidden">
            <div className="px-5 py-3 border-b bg-muted/50 flex items-center gap-2">
              <Scale className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-bold uppercase tracking-wider text-foreground">Tax Liability Working</h2>
            </div>
            <div className="px-5 py-3 divide-y divide-border/60 text-sm">
              <ReconRow label="Output tax on sales (A)" value={sum.outputTax} />
              <ReconRow label="Add: Debit notes (B)" value={sum.debitNoteTax} />
              <ReconRow label="Less: Credit notes (C)" value={-sum.creditNoteTax} />
              <ReconRow label="Net output tax (A + B − C)" value={sum.netOutputTax} strong />
              <ReconRow label="Less: Input tax credit (D)" value={-sum.inputTaxCredit} />
              <div className="flex items-baseline justify-between pt-3">
                <span className="font-bold text-foreground">{netPayablePositive ? 'Net GST Payable' : 'ITC Carried Forward'}</span>
                <span className={'font-mono font-bold tabular-nums text-lg ' + (netPayablePositive ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400')}>
                  {rupees(Math.abs(sum.netPayable))}
                </span>
              </div>
            </div>
          </Card>

          <Tabs defaultValue="output" className="space-y-4">
            <TabsList className="bg-card border shadow-sm">
              <TabsTrigger value="output" className="gap-2"><ArrowUpRight className="h-4 w-4" /> Output (Sales)</TabsTrigger>
              <TabsTrigger value="input" className="gap-2"><ArrowDownLeft className="h-4 w-4" /> Input (Purchases)</TabsTrigger>
              <TabsTrigger value="notes" className="gap-2"><FilePlus2 className="h-4 w-4" /> Credit / Debit Notes</TabsTrigger>
            </TabsList>

            {/* ── OUTPUT ── */}
            <TabsContent value="output" className="space-y-3">
              <div className="flex justify-end">
                <ExportButtons filename={`GST-Output-${fyLabel(fy)}`} title="GST Output Tax — Sales" subtitle={period.label} columns={salesCols} rows={out.sales} />
              </div>
              <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead>Date</TableHead>
                      <TableHead>Invoice</TableHead>
                      <TableHead>Buyer</TableHead>
                      <TableHead>GSTIN</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Taxable</TableHead>
                      <TableHead className="text-right">Rate</TableHead>
                      <TableHead className="text-right">IGST</TableHead>
                      <TableHead className="text-right">CGST</TableHead>
                      <TableHead className="text-right">SGST</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {out.sales.length === 0 ? (
                      <TableRow><TableCell colSpan={11} className="text-center py-8 text-muted-foreground">No taxable sales in this period.</TableCell></TableRow>
                    ) : out.sales.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="whitespace-nowrap">{shortDate(r.date)}</TableCell>
                        <TableCell className="font-medium">{r.invoiceNumber ?? '-'}</TableCell>
                        <TableCell>{r.partyName}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{r.gstin ?? '-'}</TableCell>
                        <TableCell>{prettyProduct(r.product)}</TableCell>
                        <TableCell className="text-right"><Num v={r.taxableValue} /></TableCell>
                        <TableCell className="text-right text-muted-foreground">{r.gstRate}%</TableCell>
                        <TableCell className="text-right"><Num v={r.igst} /></TableCell>
                        <TableCell className="text-right"><Num v={r.cgst} /></TableCell>
                        <TableCell className="text-right"><Num v={r.sgst} /></TableCell>
                        <TableCell className="text-right"><Num v={r.invoiceTotal} bold /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  {out.sales.length > 0 && (
                    <TableFooter>
                      <TableRow className="bg-muted/50 font-semibold">
                        <TableCell colSpan={5}>Total ({out.sales.length})</TableCell>
                        <TableCell className="text-right"><Num v={out.taxableTotal} bold /></TableCell>
                        <TableCell />
                        <TableCell className="text-right"><Num v={out.igstTotal} bold /></TableCell>
                        <TableCell className="text-right"><Num v={out.cgstTotal} bold /></TableCell>
                        <TableCell className="text-right"><Num v={out.sgstTotal} bold /></TableCell>
                        <TableCell className="text-right"><Num v={out.taxableTotal + out.gstTotal} bold /></TableCell>
                      </TableRow>
                    </TableFooter>
                  )}
                </Table>
              </div>
            </TabsContent>

            {/* ── INPUT ── */}
            <TabsContent value="input" className="space-y-3">
              <div className="flex justify-end">
                <ExportButtons filename={`GST-Input-${fyLabel(fy)}`} title="GST Input Tax Credit — Purchases" subtitle={period.label} columns={purchaseCols} rows={inp.purchases} />
              </div>
              <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead>Date</TableHead>
                      <TableHead>Inv No</TableHead>
                      <TableHead>PO</TableHead>
                      <TableHead>Supplier</TableHead>
                      <TableHead>GSTIN</TableHead>
                      <TableHead className="text-right">Taxable</TableHead>
                      <TableHead className="text-right">Rate</TableHead>
                      <TableHead className="text-right">IGST</TableHead>
                      <TableHead className="text-right">CGST</TableHead>
                      <TableHead className="text-right">SGST</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inp.purchases.length === 0 ? (
                      <TableRow><TableCell colSpan={11} className="text-center py-8 text-muted-foreground">No GST purchases in this period.</TableCell></TableRow>
                    ) : inp.purchases.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="whitespace-nowrap">{shortDate(r.date)}</TableCell>
                        <TableCell className="font-medium">{r.invoiceNumber}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{r.poNumber ?? '-'}</TableCell>
                        <TableCell>{r.partyName}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{r.gstin ?? '-'}</TableCell>
                        <TableCell className="text-right"><Num v={r.taxableValue} /></TableCell>
                        <TableCell className="text-right text-muted-foreground">{r.gstRate}%</TableCell>
                        <TableCell className="text-right"><Num v={r.igst} /></TableCell>
                        <TableCell className="text-right"><Num v={r.cgst} /></TableCell>
                        <TableCell className="text-right"><Num v={r.sgst} /></TableCell>
                        <TableCell className="text-right"><Num v={r.invoiceTotal} bold /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  {inp.purchases.length > 0 && (
                    <TableFooter>
                      <TableRow className="bg-muted/50 font-semibold">
                        <TableCell colSpan={5}>Total ({inp.purchases.length})</TableCell>
                        <TableCell className="text-right"><Num v={inp.taxableTotal} bold /></TableCell>
                        <TableCell />
                        <TableCell className="text-right"><Num v={inp.igstTotal} bold /></TableCell>
                        <TableCell className="text-right"><Num v={inp.cgstTotal} bold /></TableCell>
                        <TableCell className="text-right"><Num v={inp.sgstTotal} bold /></TableCell>
                        <TableCell className="text-right"><Num v={inp.taxableTotal + inp.gstTotal} bold /></TableCell>
                      </TableRow>
                    </TableFooter>
                  )}
                </Table>
              </div>
            </TabsContent>

            {/* ── NOTES ── */}
            <TabsContent value="notes" className="space-y-6">
              <NotesTable title="Credit Notes (reduce output tax)" icon={FileMinus2} rows={out.creditNotes} tone="text-rose-600 dark:text-rose-400" />
              <NotesTable title="Debit Notes (increase output tax)" icon={FilePlus2} rows={out.debitNotes} tone="text-emerald-600 dark:text-emerald-400" />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

function ReconRow({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className={'flex items-baseline justify-between py-1.5 ' + (strong ? 'font-semibold text-foreground' : 'text-foreground/90')}>
      <span>{label}</span>
      <Num v={value} bold={strong} />
    </div>
  );
}

function NotesTable({ title, icon: Icon, rows, tone }: { title: string; icon: React.ComponentType<{ className?: string }>; rows: GstNoteLine[]; tone: string }) {
  const total = rows.reduce((a, r) => a + r.gstAmount, 0);
  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-5 py-3 border-b bg-muted/50 flex items-center gap-2">
        <Icon className={'h-4 w-4 ' + tone} />
        <h2 className="text-sm font-bold uppercase tracking-wider text-foreground">{title}</h2>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead>Date</TableHead>
              <TableHead>Note No</TableHead>
              <TableHead>Party</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead className="text-right">Taxable</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead className="text-right">GST</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="text-center py-6 text-muted-foreground">None in this period.</TableCell></TableRow>
            ) : rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="whitespace-nowrap">{shortDate(r.date)}</TableCell>
                <TableCell className="font-medium">{r.noteNumber}</TableCell>
                <TableCell>{r.partyName}</TableCell>
                <TableCell className="max-w-[240px] truncate text-muted-foreground" title={r.reason}>{r.reason}</TableCell>
                <TableCell className="text-right"><Num v={r.taxableValue} /></TableCell>
                <TableCell className="text-right text-muted-foreground">{r.gstRate}%</TableCell>
                <TableCell className="text-right"><Num v={r.gstAmount} /></TableCell>
                <TableCell className="text-right"><Num v={r.total} bold /></TableCell>
              </TableRow>
            ))}
          </TableBody>
          {rows.length > 0 && (
            <TableFooter>
              <TableRow className="bg-muted/50 font-semibold">
                <TableCell colSpan={6}>Total GST ({rows.length})</TableCell>
                <TableCell className="text-right"><Num v={total} bold /></TableCell>
                <TableCell />
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </div>
    </Card>
  );
}
