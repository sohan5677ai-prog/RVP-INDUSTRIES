import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Purchase, SaleOrder, Payment, CompanyProfile, SaleStatus } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { calcHamali, calcKataFee, pappuLoadingHamali } from '@/lib/calc';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';

type PurchaseRow = Purchase & {
  stockIn?: {
    arrivalDate?: string;
    lorryNumber?: string | null;
    invoiceNumber?: string | null;
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
}: {
  freightLabel: string;
  rows: FreightRow[];
  paymentStatusFor: (lorry: string | null) => PaymentStatus;
}) {
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
            <TableHead className="text-right">{freightLabel}</TableHead>
            <TableHead className="text-right">Hamali</TableHead>
            <TableHead className="text-right">Kata</TableHead>
            <TableHead className="text-right">Transport</TableHead>
            <TableHead className="text-right">Net Freight</TableHead>
            <TableHead>Delivery Status</TableHead>
            <TableHead>Payment Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground py-8">No records.</TableCell></TableRow>
          )}
          {rows.map((r) => {
            const pay = paymentStatusFor(r.lorry);
            return (
              <TableRow key={r.id}>
                <TableCell>{shortDate(r.date)}</TableCell>
                <TableCell className="font-mono text-sm font-semibold">{r.lorry ?? '—'}</TableCell>
                <TableCell className="font-mono text-sm">{r.invoice ?? '—'}</TableCell>
                <TableCell className="text-right font-medium">{rupees(r.freight)}</TableCell>
                <TableCell className="text-right text-amber-600 dark:text-amber-400">{r.hamali ? `−${rupees(r.hamali)}` : '—'}</TableCell>
                <TableCell className="text-right text-amber-600 dark:text-amber-400">{r.kata ? `−${rupees(r.kata)}` : '—'}</TableCell>
                <TableCell className="text-right text-amber-600 dark:text-amber-400">{r.transport ? `−${rupees(r.transport)}` : '—'}</TableCell>
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
              </TableRow>
            );
          })}
        </TableBody>
        {rows.length > 0 && (
          <tfoot>
            <TableRow className="border-t-2 font-bold bg-muted/30">
              <TableCell colSpan={3}>Total</TableCell>
              <TableCell className="text-right">{rupees(t.freight)}</TableCell>
              <TableCell className="text-right text-amber-600 dark:text-amber-400">−{rupees(t.hamali)}</TableCell>
              <TableCell className="text-right text-amber-600 dark:text-amber-400">−{rupees(t.kata)}</TableCell>
              <TableCell className="text-right text-amber-600 dark:text-amber-400">−{rupees(t.transport)}</TableCell>
              <TableCell className="text-right">{rupees(t.net)}</TableCell>
              <TableCell colSpan={2} />
            </TableRow>
          </tfoot>
        )}
      </Table>
    </div>
  );
}

export default function FreightDuesPage() {
  const [tab, setTab] = useState('outward');

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

  // Outward freight (sales). Hamali deducted off the lorry's freight = the lorry
  // share of the loading hamali (pappu ₹80/t, else flat ₹160/t); Transport = the
  // ₹3,000 retention held for Surya Road Transport. Net = lorry owner's payable.
  const outwardRows: FreightRow[] = (saleOrders ?? [])
    .flatMap((o) => (o.dispatches ?? []).map((d) => ({ o, d })))
    .filter(({ d }) => Number(d.freightCharge) > 0)
    .map(({ o, d }) => {
      const freight = Number(d.freightCharge);
      const hamali = o.product === 'PAPPU' ? pappuLoadingHamali(d.weightKg).lorry : calcHamali(d.weightKg);
      const kata = calcKataFee(d.weightKg);
      return {
        id: d.id,
        date: d.dispatchDate,
        lorry: d.vehicleNumber?.trim().toUpperCase() ?? null,
        invoice: d.invoiceNumber ?? null,
        freight,
        hamali,
        kata,
        transport: retention,
        net: round2(freight - hamali - kata - retention),
        deliveryStatus: d.status as SaleStatus,
      };
    });

  // Inward freight (purchases). Hamali & kata are the recorded purchase charges;
  // no Surya transport retention applies inward.
  const inwardRows: FreightRow[] = (purchases ?? [])
    .filter((p) => Number(p.freightCharge) > 0)
    .map((p) => {
      const freight = Number(p.freightCharge);
      const hamali = Number(p.hamaliCharge ?? 0);
      const kata = Number(p.kataFee ?? 0);
      return {
        id: p.id,
        date: p.stockIn?.arrivalDate ?? p.createdAt,
        lorry: p.stockIn?.lorryNumber?.trim().toUpperCase() ?? null,
        invoice: p.stockIn?.invoiceNumber ?? null,
        freight,
        hamali,
        kata,
        transport: 0,
        net: round2(freight - hamali - kata),
        deliveryStatus: 'RECEIVED',
      };
    });

  // Payment status is settled per lorry (transporter payments aren't tagged to a
  // single invoice): a lorry's total net freight vs its total transporter paid.
  const paidByLorry = new Map<string, number>();
  payments?.forEach((p) => {
    if (p.type === 'TRANSPORTER' && p.lorryNumber) {
      const k = p.lorryNumber.trim().toUpperCase();
      paidByLorry.set(k, (paidByLorry.get(k) ?? 0) + Number(p.amount));
    }
  });
  const netByLorry = new Map<string, number>();
  [...inwardRows, ...outwardRows].forEach((r) => {
    if (r.lorry) netByLorry.set(r.lorry, (netByLorry.get(r.lorry) ?? 0) + r.net);
  });
  function paymentStatusFor(lorry: string | null): PaymentStatus {
    if (!lorry) return 'Pending';
    const net = netByLorry.get(lorry) ?? 0;
    const paid = paidByLorry.get(lorry) ?? 0;
    if (paid <= 0) return 'Pending';
    if (paid + 0.01 >= net) return 'Paid';
    return 'Partial';
  }

  const outwardNet = outwardRows.reduce((s, r) => s + r.net, 0);
  const inwardNet = inwardRows.reduce((s, r) => s + r.net, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Freight Dues</h1>
        <p className="text-muted-foreground">Transporter freight net of hamali, kata &amp; transport retention — outward and inward.</p>
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
          </TabsList>

          <TabsContent value="outward" className="space-y-4">
            <Card className="bg-card/50 border shadow-sm max-w-xs">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Outward Net Freight</CardTitle>
              </CardHeader>
              <CardContent><div className="text-xl font-bold">{rupees(outwardNet)}</div></CardContent>
            </Card>
            <FreightTable freightLabel="Outward Freight" rows={outwardRows} paymentStatusFor={paymentStatusFor} />
          </TabsContent>

          <TabsContent value="inward" className="space-y-4">
            <Card className="bg-card/50 border shadow-sm max-w-xs">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Inward Net Freight</CardTitle>
              </CardHeader>
              <CardContent><div className="text-xl font-bold">{rupees(inwardNet)}</div></CardContent>
            </Card>
            <FreightTable freightLabel="Inward Freight" rows={inwardRows} paymentStatusFor={paymentStatusFor} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
