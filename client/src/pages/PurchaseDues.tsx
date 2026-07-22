import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Party, Purchase, Payment, DustPurchase } from '@/lib/types';
import { rupees, shortDate, toTonnes } from '@/lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TrendingDown, Loader2, ChevronDown, ChevronRight, Undo2 } from 'lucide-react';
import { Fragment } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Segmented } from '@/components/ui/segmented';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { usePagedRows } from '@/lib/usePagedRows';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';

// Payment-status tabs. "Unpaid" catches anything with even ₹1 still outstanding
// (i.e. both fully-unpaid and partially-paid bills).
type PayFilter = 'ALL' | 'PAID' | 'UNPAID';

const PAY_FILTERS: { value: PayFilter; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'PAID', label: 'Paid' },
  { value: 'UNPAID', label: 'Unpaid' },
];

type PurchaseRow = Purchase & {
  stockIn?: {
    arrivalDate?: string;
    lorryNumber: string;
    invoiceNumber: string;
    purchaseOrder: {
      partyId: string;
    };
  };
};

interface OutstandingPurchase {
  id: string;
  // GRAIN = a verified stock-in purchase (FIFO-matched to payments).
  // DUST  = a pre-cleaner dust / tamarind byproduct purchase (matched to
  //         payments only by a direct DUST:<id>:<mode> reference — never FIFO).
  kind: 'GRAIN' | 'DUST';
  partyId: string;
  purchaseDate: Date;
  partyName: string;
  invoiceNumber: string | null;
  pricePerKg: string;
  tonnageKg: number;
  lorryNumber: string | null;
  dueAge: number;
  amount: number;
  totalAmount: number;
  status: string;
  appliedPayments: { date: string; amount: number; mode: string }[];
  deletablePaymentIds: string[];
}

interface PayDialogState {
  bill: OutstandingPurchase;
  date: string;
  amount: string;
  mode: string;
}

const PURCHASE_DUES_COLUMNS: ExportColumn<OutstandingPurchase>[] = [
  { header: 'Date Purchased', value: (b) => shortDate(b.purchaseDate.toISOString()) },
  { header: 'Party (Supplier)', value: (b) => b.partyName },
  { header: 'Invoice No', value: (b) => b.invoiceNumber ?? '' },
  { header: 'Price/kg', value: (b) => rupees(b.pricePerKg), excel: (b) => Number(b.pricePerKg), numFmt: '#,##0.00', align: 'right' },
  { header: 'Tonnage (t)', value: (b) => toTonnes(b.tonnageKg).toFixed(2), excel: (b) => toTonnes(b.tonnageKg), numFmt: '#,##0.00', align: 'right' },
  { header: 'Vehicle No', value: (b) => b.lorryNumber ?? '' },
  { header: 'Total Amount', value: (b) => rupees(b.totalAmount), excel: (b) => b.totalAmount, numFmt: '#,##0.00', align: 'right' },
  { header: 'Outstanding', value: (b) => rupees(b.amount), excel: (b) => b.amount, numFmt: '#,##0.00', align: 'right' },
  { header: 'Status', value: (b) => b.status, align: 'center' },
  { header: 'Due Age (days)', value: (b) => (b.status === 'Paid' ? '' : b.dueAge), align: 'center' },
];

export default function PurchaseDuesPage() {
  const qc = useQueryClient();
  const [payDialog, setPayDialog] = useState<PayDialogState | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [payFilter, setPayFilter] = useState<PayFilter>('ALL');

  const { data: parties, isLoading: loadingParties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const { data: purchases, isLoading: loadingPurchases } = useQuery({
    queryKey: ['purchases', { all: true }],
    queryFn: () => api<PurchaseRow[]>('/purchases?all=true'),
  });

  const { data: payments, isLoading: loadingPayments } = useQuery({
    // Must fetch the FULL payment history (not the default latest-100). FIFO
    // allocation runs across every payment; capping it makes older fully-paid
    // bills reappear as unpaid and massively overstates Net Outstanding.
    queryKey: ['payments', { all: true }],
    queryFn: () => api<Payment[]>('/payments?all=true'),
  });

  // Pre-cleaner dust / tamarind byproduct purchases live in their own table and
  // raise a real supplier payable, but they never flow through the StockIn →
  // Purchase → verification chain the grain list is built from. Pull them in so
  // they show as dues too.
  const { data: dustPurchases, isLoading: loadingDust } = useQuery({
    queryKey: ['dust-purchases'],
    queryFn: () => api<DustPurchase[]>('/dust-purchases'),
  });

  const payMutation = useMutation({
    mutationFn: (body: { date: string; amount: number; type: string; partyId: string; purchaseId?: string; reference?: string }) =>
      api('/payments', { method: 'POST', body }),
    onSuccess: () => {
      toast.success('Payment recorded');
      qc.invalidateQueries({ queryKey: ['payments'] });
      setPayDialog(null);
    },
    onError: () => toast.error('Failed to record payment'),
  });

  const undoMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) {
        await api(`/payments/${id}`, { method: 'DELETE' });
      }
    },
    onSuccess: () => {
      toast.success('Payment removed');
      qc.invalidateQueries({ queryKey: ['payments'] });
    },
    onError: () => toast.error('Failed to remove payment'),
  });

  const isLoading = loadingParties || loadingPurchases || loadingPayments || loadingDust;

  // FIFO allocation across every supplier/purchase/payment — O(n²)-ish and must
  // be memoized so it doesn't recompute on every render (e.g. each keystroke in
  // the payment dialog, which only touches unrelated state).
  const { outstandingPurchases, totalBillingAll, totalPaymentsAll } = useMemo(() => {
  const isDustRef = (ref?: string | null) => !!ref && ref.startsWith('DUST:');
  const suppliers = parties?.filter((p) => p.type !== 'BUYER' && p.type !== 'HAMALI_TEAM') ?? [];

  const rows: OutstandingPurchase[] = [];

  let totalBillingAll = 0;
  let totalPaymentsAll = 0;

  suppliers.forEach((s) => {
    const activePurchases = purchases?.filter(
      (p) => p.stockIn?.purchaseOrder?.partyId === s.id && p.verification
    )
      .sort((a, b) => {
        const dateA = new Date(a.stockIn?.arrivalDate || a.createdAt).getTime();
        const dateB = new Date(b.stockIn?.arrivalDate || b.createdAt).getTime();
        return dateA - dateB;
      })
      .map((p) => {
        const total = p.verification ? Math.round(Number(p.verification.totalAmount)) : 0;
        return {
          ...p,
          totalAmount: total,
          remainingAmount: total,
          appliedPayments: [] as OutstandingPurchase['appliedPayments'],
          deletablePaymentIds: [] as string[],
        };
      }) ?? [];

    activePurchases.forEach((p) => { totalBillingAll += p.totalAmount; });

    const partyPayments = payments?.filter((p) => p.type === 'SUPPLIER' && p.partyId === s.id)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()) ?? [];
    
    const totalPaid = partyPayments.reduce((sum, p) => sum + Number(p.amount), 0);
    totalPaymentsAll += totalPaid;

    // Apply direct payments first
    activePurchases.forEach((p) => {
      const directPayments = partyPayments.filter((pay) => pay.purchaseId === p.id);
      directPayments.forEach((pay) => {
        p.deletablePaymentIds.push(pay.id);
        const amt = Number(pay.amount);
        if (p.remainingAmount > 0) {
          const applied = Math.min(amt, p.remainingAmount);
          p.remainingAmount -= applied;
          p.appliedPayments.push({
            date: pay.date,
            amount: applied,
            mode: pay.reference || 'Manual'
          });
        }
      });
    });

    // Grain FIFO pool = floating (non-bill-linked) general payments.
    // Process floating payments in chronological order of payment date so past payments
    // settle invoices existing at that time without retroactively absorbing newly verified bills.
    const floatingPayments = partyPayments
      .filter((p) => !p.purchaseId && !isDustRef(p.reference))
      .map((p) => ({
        ...p,
        available: Number(p.amount),
        payTime: new Date(p.date).getTime(),
      }))
      .sort((a, b) => a.payTime - b.payTime);

    floatingPayments.forEach((payment) => {
      if (payment.available <= 0) return;

      // Eligible purchases: unpaid purchases with purchaseDate <= paymentDate
      const eligiblePurchases = activePurchases
        .filter((p) => p.remainingAmount > 0 && new Date(p.stockIn?.arrivalDate || p.createdAt).getTime() <= payment.payTime);

      for (const p of eligiblePurchases) {
        if (payment.available <= 0) break;
        const applied = Math.min(payment.available, p.remainingAmount);
        payment.available -= applied;
        p.remainingAmount -= applied;

        if (!p.deletablePaymentIds.includes(payment.id)) {
          p.deletablePaymentIds.push(payment.id);
        }

        p.appliedPayments.push({
          date: payment.date,
          amount: applied,
          mode: payment.reference || 'Manual',
        });
      }

      // If the floating payment still has unused amount (advance payment), apply to remaining open purchases
      if (payment.available > 0) {
        const upcomingPurchases = activePurchases.filter((p) => p.remainingAmount > 0);

        for (const p of upcomingPurchases) {
          if (payment.available <= 0) break;
          const applied = Math.min(payment.available, p.remainingAmount);
          payment.available -= applied;
          p.remainingAmount -= applied;

          if (!p.deletablePaymentIds.includes(payment.id)) {
            p.deletablePaymentIds.push(payment.id);
          }

          p.appliedPayments.push({
            date: payment.date,
            amount: applied,
            mode: payment.reference || 'Manual',
          });
        }
      }
    });

    const today = new Date();
    activePurchases.forEach((p) => {
      let status = 'Unpaid';
      if (p.remainingAmount <= 0.01) status = 'Paid';
      else if (p.remainingAmount < p.totalAmount - 0.01) status = 'Partially Paid';

      const purchaseDate = new Date(p.stockIn?.arrivalDate || p.createdAt);
      const diffTime = today.getTime() - purchaseDate.getTime();
      const dueAge = Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));

      rows.push({
        id: p.id,
        kind: 'GRAIN',
        partyId: s.id,
        purchaseDate,
        partyName: s.name,
        invoiceNumber: p.stockIn?.invoiceNumber ?? null,
        pricePerKg: p.verification?.pricePerKg ?? '0',
        tonnageKg: p.verification?.finalWeightKg ?? p.verification?.billingWeightKg ?? p.netWeightKg,
        lorryNumber: p.stockIn?.lorryNumber ?? null,
        dueAge,
        amount: p.remainingAmount,
        totalAmount: p.totalAmount,
        status,
        appliedPayments: p.appliedPayments,
        deletablePaymentIds: p.deletablePaymentIds,
      });
    });

    // ── Dust / tamarind byproduct purchases for this supplier ────────────────
    // These are matched to payments by a DIRECT reference tag only (never FIFO):
    // the "Paid" button records a SUPPLIER payment with reference
    // "DUST:<dustId>:<mode>", and we settle each bill against payments carrying
    // its own tag. That keeps them fully isolated from the grain payment pool.
    const supplierDust = dustPurchases?.filter((d) => d.partyId === s.id) ?? [];
    supplierDust.forEach((d) => {
      const total = Math.round(Number(d.amount));
      totalBillingAll += total;

      const tag = `DUST:${d.id}:`;
      const linked = partyPayments.filter((pay) => pay.reference?.startsWith(tag));
      const paid = linked.reduce((sum, pay) => sum + Number(pay.amount), 0);
      const remaining = Math.max(0, total - paid);

      let status = 'Unpaid';
      if (remaining <= 0.01) status = 'Paid';
      else if (paid > 0.01) status = 'Partially Paid';

      const purchaseDate = new Date(d.purchaseDate);
      const diffTime = today.getTime() - purchaseDate.getTime();
      const dueAge = Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));

      rows.push({
        id: d.id,
        kind: 'DUST',
        partyId: s.id,
        purchaseDate,
        partyName: s.name,
        invoiceNumber: d.invoiceNumber ?? null,
        pricePerKg: d.pricePerKg,
        tonnageKg: d.weightKg,
        lorryNumber: d.lorryNumber ?? null,
        dueAge,
        amount: remaining,
        totalAmount: total,
        status,
        appliedPayments: linked.map((pay) => ({
          date: pay.date,
          amount: Number(pay.amount),
          mode: pay.reference?.split(':')[2] || 'Manual',
        })),
        deletablePaymentIds: linked.map((pay) => pay.id),
      });
    });
  });

  rows.sort((a, b) => a.purchaseDate.getTime() - b.purchaseDate.getTime());
  return { outstandingPurchases: rows, totalBillingAll, totalPaymentsAll };
  }, [parties, purchases, payments, dustPurchases]);

  const totalOutstanding = outstandingPurchases.reduce((sum, item) => sum + item.amount, 0);

  // Payment tab: All shows everything (incl. fully paid), Paid shows settled
  // bills, Unpaid shows anything still carrying a balance (partial or none).
  const paidCount = outstandingPurchases.filter((b) => b.status === 'Paid').length;
  const unpaidCount = outstandingPurchases.length - paidCount;
  const shownPurchases = outstandingPurchases.filter((b) => {
    if (payFilter === 'PAID') return b.status === 'Paid';
    if (payFilter === 'UNPAID') return b.status !== 'Paid';
    return true;
  });
  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows } = usePagedRows(shownPurchases, 50);

  function openPayDialog(bill: OutstandingPurchase) {
    const today = new Date().toISOString().slice(0, 10);
    setPayDialog({ bill, date: today, amount: String(Math.round(bill.amount)), mode: 'NEFT' });
  }

  function submitPay() {
    if (!payDialog) return;
    const amt = parseFloat(payDialog.amount);
    if (!payDialog.date || isNaN(amt) || amt <= 0) {
      toast.error('Please enter a valid date and amount');
      return;
    }
    const { bill } = payDialog;
    payMutation.mutate({
      date: payDialog.date,
      amount: amt,
      type: 'SUPPLIER',
      partyId: bill.partyId,
      // Dust/byproduct bills carry no Purchase row to link to, so instead of a
      // purchaseId we tag the payment with the bill's id + mode. The dues memo
      // settles the bill against payments carrying this exact tag (no FIFO).
      ...(bill.kind === 'DUST'
        ? { reference: `DUST:${bill.id}:${payDialog.mode}` }
        : { purchaseId: bill.id, reference: payDialog.mode }),
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Purchase Dues</h1>
          <p className="text-muted-foreground font-medium">Aging list of outstanding supplier purchases matching payments via FIFO allocation.</p>
        </div>
        <ExportButtons
          filename="Purchase_Dues"
          title="Purchase Dues (Aging)"
          subtitle={`${PAY_FILTERS.find((f) => f.value === payFilter)?.label} · ${shownPurchases.length} bill(s)`}
          columns={PURCHASE_DUES_COLUMNS}
          rows={shownPurchases}
        />
      </div>

      <Segmented
        options={PAY_FILTERS.map((f) => ({
          ...f,
          count: f.value === 'PAID' ? paidCount : f.value === 'UNPAID' ? unpaidCount : undefined,
        }))}
        value={payFilter}
        onValueChange={setPayFilter}
        size="sm"
      />

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Verified Purchases</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{rupees(totalBillingAll)}</div>
              </CardContent>
            </Card>
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Payments Made</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{rupees(totalPaymentsAll)}</div>
              </CardContent>
            </Card>
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Net Outstanding Dues</CardTitle>
                <TrendingDown className="h-4 w-4 text-rose-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-rose-600 dark:text-rose-400">{rupees(totalOutstanding)}</div>
              </CardContent>
            </Card>
          </div>

          <div className="rounded-lg border bg-card overflow-auto max-h-[70vh]">
            <div className="px-5 py-4 border-b font-semibold text-sm">Purchase Aging List</div>
            <Table>
              <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-muted [&_th]:shadow-[0_1px_0_0] [&_th]:shadow-border">
                <TableRow>
                  <TableHead>Date (Purchased)</TableHead>
                  <TableHead>Party (Supplier)</TableHead>
                  <TableHead>Invoice No</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Tonnage</TableHead>
                  <TableHead>Vehicle No</TableHead>
                  <TableHead className="text-right">Outstanding Amount</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead className="text-center">Due Age (days)</TableHead>
                  <TableHead className="text-center">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shownPurchases.length === 0 ? (
                  <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground py-8">No purchase dues found.</TableCell></TableRow>
                ) : (
                  (pageRows ?? []).map((bill) => (
                    <Fragment key={bill.id}>
                      <TableRow className="cursor-pointer hover:bg-muted/50" onClick={() => setExpandedId(expandedId === bill.id ? null : bill.id)}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            {expandedId === bill.id ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                            {shortDate(bill.purchaseDate.toISOString())}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {bill.partyName}
                            {bill.kind === 'DUST' && (
                              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                                Dust / Byproduct
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{bill.invoiceNumber ?? '-'}</TableCell>
                        <TableCell className="text-right">{rupees(bill.pricePerKg)}/kg</TableCell>
                        <TableCell className="text-right font-semibold">{toTonnes(bill.tonnageKg).toFixed(2)} t</TableCell>
                        <TableCell className="font-mono text-xs">{bill.lorryNumber ?? '-'}</TableCell>
                        <TableCell className="text-right font-bold text-rose-600 dark:text-rose-400">
                          {rupees(bill.amount)}
                        </TableCell>
                        <TableCell className="text-center">
                          <span className={`font-semibold ${bill.status === 'Paid' ? 'text-emerald-600 dark:text-emerald-400' : bill.status === 'Unpaid' ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400'}`}>
                            {bill.status}
                          </span>
                        </TableCell>
                        <TableCell className="text-center">
                          {bill.status !== 'Paid' ? (
                            <span className="text-rose-600 dark:text-rose-400 font-bold">{bill.dueAge} days</span>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell className="text-center">
                          <div className="flex items-center justify-center gap-2">
                            {bill.status !== 'Paid' && (
                              <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); openPayDialog(bill); }}>
                                Paid
                              </Button>
                            )}
                            {bill.deletablePaymentIds.length > 0 && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-rose-600 hover:text-rose-700 dark:text-rose-400"
                                disabled={undoMutation.isPending}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (window.confirm(`Undo payment for ${bill.partyName}${bill.invoiceNumber ? ` (${bill.invoiceNumber})` : ''}? This deletes the payment and its ledger entry.`)) {
                                    undoMutation.mutate(bill.deletablePaymentIds);
                                  }
                                }}
                              >
                                <Undo2 className="h-3.5 w-3.5 mr-1" /> Undo
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                      {expandedId === bill.id && (
                        <TableRow className="bg-muted/20">
                          <TableCell colSpan={10} className="p-0 border-b-0">
                            <div className="px-10 py-4">
                              <h4 className="font-semibold text-sm mb-3">Allocated Payments</h4>
                              {bill.appliedPayments.length > 0 ? (
                                <Table className="bg-background border rounded-md shadow-sm w-full max-w-2xl">
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead className="w-[150px]">Date</TableHead>
                                      <TableHead>Amount Paid</TableHead>
                                      <TableHead>Mode of Payment</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {bill.appliedPayments.map((ap, idx) => (
                                      <TableRow key={idx}>
                                        <TableCell>{shortDate(new Date(ap.date).toISOString())}</TableCell>
                                        <TableCell className="font-medium text-emerald-600">{rupees(ap.amount)}</TableCell>
                                        <TableCell>{ap.mode}</TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              ) : (
                                <p className="text-sm text-muted-foreground">No payments have been allocated to this purchase yet.</p>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
        </>
      )}

      {/* Pay dialog */}
      <Dialog open={!!payDialog} onOpenChange={(open) => { if (!open) setPayDialog(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Record Payment</DialogTitle>
          </DialogHeader>
          {payDialog && (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">
                {payDialog.bill.partyName} · {payDialog.bill.invoiceNumber ?? 'No invoice'}
              </p>
              <div className="space-y-1">
                <Label htmlFor="pay-date">Payment Date</Label>
                <Input
                  id="pay-date"
                  type="date"
                  value={payDialog.date}
                  onChange={(e) => setPayDialog((d) => d && ({ ...d, date: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pay-amount">Amount Paid (₹)</Label>
                <Input
                  id="pay-amount"
                  type="number"
                  step="0.01"
                  value={payDialog.amount}
                  onChange={(e) => setPayDialog((d) => d && ({ ...d, amount: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">Outstanding: {rupees(payDialog.bill.amount)}</p>
              </div>
              <div className="space-y-1">
                <Label>Mode of Payment</Label>
                <Select value={payDialog.mode} onValueChange={(val) => setPayDialog((d) => d && ({ ...d, mode: val }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select mode" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="RTGS">RTGS</SelectItem>
                    <SelectItem value="NEFT">NEFT</SelectItem>
                    <SelectItem value="IMPS">IMPS</SelectItem>
                    <SelectItem value="UPI">UPI</SelectItem>
                    <SelectItem value="Cheque">Cheque</SelectItem>
                    <SelectItem value="Cash">Cash</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayDialog(null)}>Cancel</Button>
            <Button onClick={submitPay} disabled={payMutation.isPending}>
              {payMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm Payment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
