import { useState, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import type { Purchase, SaleOrder, Payment, CompanyProfile, SaleStatus } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { calcHamali, calcKataFee, pappuLoadingHamali } from '@/lib/calc';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, ArrowDownToLine, ArrowUpFromLine, Truck } from 'lucide-react';

type PurchaseRow = Purchase & {
  stockIn?: {
    arrivalDate?: string;
    lorryNumber?: string | null;
    invoiceNumber?: string | null;
    loadingLocation?: string | null;
    purchaseOrder?: { party?: { name?: string | null } | null } | null;
  };
};

type PaymentStatus = 'Paid' | 'Partial' | 'Pending';

interface FreightRow {
  id: string;
  date: string;
  lorry: string | null;
  invoice: string | null;
  freight: number;
  hamali: number;
  kata: number;
  transport: number;
  net: number;
  deliveryStatus: string;
  sourced: 'Purchase' | 'Sale';
  destination: string | null;
  party: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const deliveryVariant: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  PENDING: 'secondary',
  DISPATCHED: 'default',
  REACHED: 'outline',
  DELIVERED: 'destructive',
  RECEIVED: 'destructive',
};

function titleCase(s: string) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

function FreightTable({
  freightLabel,
  rows,
  paymentStatusFor,
  dueFor,
  onPay,
  hideDeductions = false,
  paymentsByLorry,
}: {
  freightLabel: string;
  rows: FreightRow[];
  paymentStatusFor: (row: FreightRow) => PaymentStatus;
  dueFor: (row: FreightRow) => number;
  onPay: (lorry: string, due: number) => void;
  hideDeductions?: boolean;
  paymentsByLorry: Map<string, { date: string, amount: number, reference: string | null }[]>;
}) {
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const t = {
    freight: rows.reduce((s, r) => s + r.freight, 0),
    hamali: rows.reduce((s, r) => s + r.hamali, 0),
    kata: rows.reduce((s, r) => s + r.kata, 0),
    transport: rows.reduce((s, r) => s + r.transport, 0),
    net: rows.reduce((s, r) => s + r.net, 0),
  };

  return (
    <div className="rounded-lg border bg-card overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Lorry No</TableHead>
            <TableHead>Invoice No</TableHead>
            {hideDeductions && <TableHead>Sourced</TableHead>}
            {hideDeductions && <TableHead>Destination</TableHead>}
            {hideDeductions && <TableHead>Party</TableHead>}
            <TableHead className="text-right">{freightLabel}</TableHead>
            {!hideDeductions && <TableHead className="text-right">Hamali</TableHead>}
            {!hideDeductions && <TableHead className="text-right">Kata</TableHead>}
            {!hideDeductions && <TableHead className="text-right">Transport</TableHead>}
            <TableHead className="text-right">Net Freight</TableHead>
            <TableHead>Delivery Status</TableHead>
            <TableHead>Payment Status</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow><TableCell colSpan={11} className="text-center text-muted-foreground py-8">No records.</TableCell></TableRow>
          )}
          {rows.map((r) => {
            const pay = paymentStatusFor(r);
            const due = dueFor(r);
            const isExpanded = expandedRow === r.lorry;
            return (
              <Fragment key={r.id}>
                <TableRow
                  className="cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() => r.lorry && setExpandedRow(isExpanded ? null : r.lorry)}
                >
                  <TableCell>{shortDate(r.date)}</TableCell>
                  <TableCell className="font-mono text-sm font-semibold">{r.lorry ?? '-'}</TableCell>
                  <TableCell className="font-mono text-sm">{r.invoice ?? '-'}</TableCell>
                  {hideDeductions && <TableCell>{r.sourced}</TableCell>}
                  {hideDeductions && <TableCell>{r.destination ?? '-'}</TableCell>}
                  {hideDeductions && <TableCell>{r.party ?? '-'}</TableCell>}
                  <TableCell className="text-right font-medium">{rupees(r.freight)}</TableCell>
                  {!hideDeductions && <TableCell className="text-right text-amber-600 dark:text-amber-400">{r.hamali ? `−${rupees(r.hamali)}` : '-'}</TableCell>}
                  {!hideDeductions && <TableCell className="text-right text-amber-600 dark:text-amber-400">{r.kata ? `−${rupees(r.kata)}` : '-'}</TableCell>}
                  {!hideDeductions && <TableCell className="text-right text-amber-600 dark:text-amber-400">{r.transport ? `−${rupees(r.transport)}` : '-'}</TableCell>}
                  <TableCell className="text-right font-bold">{rupees(r.net)}</TableCell>
                  <TableCell>
                    <Badge variant={deliveryVariant[r.deliveryStatus] ?? 'secondary'}>{titleCase(r.deliveryStatus)}</Badge>
                  </TableCell>
                  <TableCell>
                    <span
                      className={`text-xs font-semibold ${
                        pay === 'Paid'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : pay === 'Partial'
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-rose-600 dark:text-rose-400'
                      }`}
                    >
                      {pay}
                    </span>
                  </TableCell>
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    {r.lorry && pay !== 'Paid' ? (
                      <Button size="sm" variant="outline" onClick={() => onPay(r.lorry!, due)}>
                        Pay
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
                {isExpanded && r.lorry && (
                  <TableRow className="bg-muted/10 border-b">
                    <TableCell colSpan={hideDeductions ? 11 : 11} className="p-0 border-b-0">
                      <div className="p-4 border border-t-0 rounded-b-md bg-background m-2 mt-0">
                        <h4 className="font-semibold mb-2 text-sm">Payment History for {r.lorry}</h4>
                        {(() => {
                          const history = paymentsByLorry.get(r.lorry!);
                          if (!history || history.length === 0) {
                            return <p className="text-sm text-muted-foreground">No payments recorded.</p>;
                          }
                          return (
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Date</TableHead>
                                  <TableHead>Amount</TableHead>
                                  <TableHead>Reference</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {history.map((pay, i) => (
                                  <TableRow key={i}>
                                    <TableCell>{shortDate(pay.date)}</TableCell>
                                    <TableCell className="font-medium text-emerald-600 dark:text-emerald-400">{rupees(pay.amount)}</TableCell>
                                    <TableCell className="text-muted-foreground">{pay.reference || '-'}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          );
                        })()}
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
        {rows.length > 0 && (
          <tfoot>
            <TableRow className="border-t-2 font-bold bg-muted/30">
              <TableCell colSpan={hideDeductions ? 6 : 3}>Total</TableCell>
              <TableCell className="text-right">{rupees(t.freight)}</TableCell>
              {!hideDeductions && <TableCell className="text-right text-amber-600 dark:text-amber-400">−{rupees(t.hamali)}</TableCell>}
              {!hideDeductions && <TableCell className="text-right text-amber-600 dark:text-amber-400">−{rupees(t.kata)}</TableCell>}
              {!hideDeductions && <TableCell className="text-right text-amber-600 dark:text-amber-400">−{rupees(t.transport)}</TableCell>}
              <TableCell className="text-right">{rupees(t.net)}</TableCell>
              <TableCell colSpan={3} />
            </TableRow>
          </tfoot>
        )}
      </Table>
    </div>
  );
}

export default function FreightDuesPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState('outward');

  // Pay dialog state
  const [payLorry, setPayLorry] = useState<string | null>(null);
  const [payDate, setPayDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [payAmount, setPayAmount] = useState('');
  const [payReference, setPayReference] = useState('');

  const { data: purchases, isLoading: loadingPurchases } = useQuery({
    queryKey: ['purchases'],
    queryFn: () => api<PurchaseRow[]>('/purchases'),
  });
  const { data: saleOrders, isLoading: loadingSales } = useQuery({
    queryKey: ['sale-orders'],
    queryFn: () => api<SaleOrder[]>('/sale-orders'),
  });
  const { data: payments, isLoading: loadingPayments } = useQuery({
    queryKey: ['payments'],
    queryFn: () => api<Payment[]>('/payments'),
  });
  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: () => api<CompanyProfile>('/settings/company'),
  });

  const isLoading = loadingPurchases || loadingSales || loadingPayments;
  const retention = Number(company?.freightRetentionPerTrip ?? 3000);
  const knmList = (company?.companyVehicles || '').split(/[\n,]+/).map(v => v.trim().toLowerCase()).filter(v => v);

  // Outward freight (sales). Hamali deducted off the lorry's freight = the lorry
  // share of the loading hamali (pappu ₹80/t, else flat ₹160/t); Transport = the
  // ₹3,000 retention held for Surya Road Transport. Net = lorry owner's payable.
  const allOutwardRows: FreightRow[] = (saleOrders ?? [])
    .flatMap((o) => (o.dispatches ?? []).map((d) => ({ o, d })))
    .filter(({ d }) => Number(d.freightCharge) > 0)
    .map(({ o, d }) => {
      const freight = Number(d.freightCharge);
      const isKnm = d.vehicleNumber ? knmList.includes(d.vehicleNumber.trim().toLowerCase()) : false;
      const hamali = isKnm ? 0 : (o.product === 'PAPPU' ? pappuLoadingHamali(d.weightKg).lorry : calcHamali(d.weightKg));
      const kata = isKnm ? 0 : calcKataFee(d.weightKg);
      const transport = isKnm ? 0 : retention;
      return {
        id: d.id,
        date: d.dispatchDate,
        lorry: d.vehicleNumber?.trim().toUpperCase() ?? null,
        invoice: d.invoiceNumber ?? null,
        freight,
        hamali,
        kata,
        transport,
        net: round2(freight - hamali - kata - transport),
        deliveryStatus: d.status as SaleStatus,
        sourced: 'Sale',
        destination: o.destination ?? null,
        party: o.buyer?.name ?? null,
      };
    });

  // Inward freight (purchases). Hamali & kata are the recorded purchase charges;
  // no Surya transport retention applies inward.
  const allInwardRows: FreightRow[] = (purchases ?? [])
    .filter((p) => Number(p.freightCharge) > 0)
    .map((p) => {
      const freight = Number(p.freightCharge);
      const lorry = p.stockIn?.lorryNumber;
      const isKnm = lorry ? knmList.includes(lorry.trim().toLowerCase()) : false;
      // For KNM vehicles, hamali and kata lorry shares are 0. (The backend stores the total hamali in p.hamaliCharge)
      const hamali = isKnm ? 0 : Number(p.hamaliCharge ?? 0);
      const kata = isKnm ? 0 : Number(p.kataFee ?? 0);
      return {
        id: p.id,
        date: p.stockIn?.arrivalDate ?? p.createdAt,
        lorry: lorry?.trim().toUpperCase() ?? null,
        invoice: p.stockIn?.invoiceNumber ?? null,
        freight,
        hamali,
        kata,
        transport: 0,
        net: round2(freight - hamali - kata),
        deliveryStatus: 'RECEIVED',
        sourced: 'Purchase',
        destination: p.stockIn?.loadingLocation ?? null,
        party: p.stockIn?.purchaseOrder?.party?.name ?? null,
      };
    });

  const knmRows = [...allOutwardRows.filter(r => r.lorry && knmList.includes(r.lorry.toLowerCase())), ...allInwardRows.filter(r => r.lorry && knmList.includes(r.lorry.toLowerCase()))].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const outwardRows = allOutwardRows.filter(r => !r.lorry || !knmList.includes(r.lorry.toLowerCase()));
  const inwardRows = allInwardRows.filter(r => !r.lorry || !knmList.includes(r.lorry.toLowerCase()));

  // Payment status is settled per lorry (transporter payments aren't tagged to a
  // single invoice): a lorry's total net freight vs its total transporter paid.
  const paidByLorry = new Map<string, number>();
  const paymentsByLorry = new Map<string, { date: string, amount: number, reference: string | null }[]>();
  payments?.forEach((p) => {
    if (p.type === 'TRANSPORTER' && p.lorryNumber) {
      const k = p.lorryNumber.trim().toUpperCase();
      paidByLorry.set(k, (paidByLorry.get(k) ?? 0) + Number(p.amount));
      
      const list = paymentsByLorry.get(k) || [];
      list.push({ date: p.date, amount: Number(p.amount), reference: p.reference ?? null });
      paymentsByLorry.set(k, list);
    }
  });
  const rowStatus = new Map<string, PaymentStatus>();
  const rowDue = new Map<string, number>();
  
  const allRows = [...inwardRows, ...outwardRows, ...knmRows];
  const rowsByLorry = new Map<string, FreightRow[]>();
  
  allRows.forEach((r) => {
    if (r.lorry) {
      const list = rowsByLorry.get(r.lorry) || [];
      list.push(r);
      rowsByLorry.set(r.lorry, list);
    }
  });

  for (const [lorry, lorryRows] of rowsByLorry.entries()) {
    lorryRows.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    let remainingPaid = paidByLorry.get(lorry) ?? 0;
    
    for (const r of lorryRows) {
      if (remainingPaid <= 0) {
        rowStatus.set(r.id, 'Pending');
        rowDue.set(r.id, r.net);
      } else if (remainingPaid + 0.01 >= r.net) {
        rowStatus.set(r.id, 'Paid');
        rowDue.set(r.id, 0);
        remainingPaid -= r.net;
      } else {
        rowStatus.set(r.id, 'Partial');
        rowDue.set(r.id, round2(r.net - remainingPaid));
        remainingPaid = 0;
      }
    }
  }

  function paymentStatusFor(r: FreightRow): PaymentStatus {
    return r.lorry ? (rowStatus.get(r.id) ?? 'Pending') : 'Pending';
  }
  function dueFor(r: FreightRow): number {
    return r.lorry ? (rowDue.get(r.id) ?? r.net) : 0;
  }

  const payMutation = useMutation({
    mutationFn: () =>
      api<Payment>('/payments', {
        method: 'POST',
        body: {
          date: payDate,
          amount: Number(payAmount) || 0,
          type: 'TRANSPORTER',
          lorryNumber: payLorry,
          reference: payReference || null,
          description: `Freight payment - Lorry ${payLorry}`,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      toast.success('Freight payment recorded');
      setPayLorry(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function openPay(lorry: string, due: number) {
    setPayLorry(lorry);
    setPayDate(new Date().toISOString().slice(0, 10));
    setPayAmount(due > 0 ? String(due) : '');
    setPayReference('');
  }

  const outwardNet = outwardRows.reduce((s, r) => s + r.net, 0);
  const inwardNet = inwardRows.reduce((s, r) => s + r.net, 0);
  const knmNet = knmRows.reduce((s, r) => s + r.net, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Freight Dues</h1>
        <p className="text-muted-foreground">Transporter freight net of hamali, kata &amp; transport retention - outward and inward.</p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <Tabs value={tab} onValueChange={setTab} className="space-y-4">
          <TabsList>
            <TabsTrigger value="outward" className="gap-1.5">
              <ArrowUpFromLine className="h-4 w-4" /> Outward (Sales)
            </TabsTrigger>
            <TabsTrigger value="inward" className="gap-1.5">
              <ArrowDownToLine className="h-4 w-4" /> Inward (Purchases)
            </TabsTrigger>
            <TabsTrigger value="knm" className="gap-1.5">
              <Truck className="h-4 w-4" /> KNM Freight
            </TabsTrigger>
          </TabsList>

          <TabsContent value="outward" className="space-y-4">
            <Card className="bg-card/50 border shadow-sm max-w-xs">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Outward Net Freight</CardTitle>
              </CardHeader>
              <CardContent><div className="text-xl font-bold">{rupees(outwardNet)}</div></CardContent>
            </Card>
            <FreightTable freightLabel="Outward Freight" rows={outwardRows} paymentStatusFor={paymentStatusFor} dueFor={dueFor} onPay={openPay} paymentsByLorry={paymentsByLorry} />
          </TabsContent>

          <TabsContent value="inward" className="space-y-4">
            <Card className="bg-card/50 border shadow-sm max-w-xs">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Inward Net Freight</CardTitle>
              </CardHeader>
              <CardContent><div className="text-xl font-bold">{rupees(inwardNet)}</div></CardContent>
            </Card>
            <FreightTable freightLabel="Inward Freight" rows={inwardRows} paymentStatusFor={paymentStatusFor} dueFor={dueFor} onPay={openPay} paymentsByLorry={paymentsByLorry} />
          </TabsContent>

          <TabsContent value="knm" className="space-y-4">
            <Card className="bg-card/50 border shadow-sm max-w-xs">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">KNM Net Freight</CardTitle>
              </CardHeader>
              <CardContent><div className="text-xl font-bold">{rupees(knmNet)}</div></CardContent>
            </Card>
            <FreightTable freightLabel="KNM Freight" rows={knmRows} paymentStatusFor={paymentStatusFor} dueFor={dueFor} onPay={openPay} hideDeductions={true} paymentsByLorry={paymentsByLorry} />
          </TabsContent>
        </Tabs>
      )}

      <Dialog open={payLorry !== null} onOpenChange={(o) => { if (!o) setPayLorry(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Pay Freight - Lorry {payLorry}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="pay-date">Payment Date</Label>
                <Input id="pay-date" type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pay-amount">Amount (₹)</Label>
                <Input id="pay-amount" type="number" step="0.01" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="e.g. 50000" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="pay-ref">Reference (Cheque / UTR / Cash)</Label>
              <Input id="pay-ref" value={payReference} onChange={(e) => setPayReference(e.target.value)} placeholder="Optional" />
            </div>
            <DialogFooter>
              <Button onClick={() => payMutation.mutate()} disabled={!(Number(payAmount) > 0) || payMutation.isPending}>
                {payMutation.isPending ? 'Saving…' : 'Record Payment'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
