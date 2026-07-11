import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Party, SaleOrder, Receipt } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TrendingUp, Loader2, ChevronDown, ChevronRight, Undo2 } from 'lucide-react';
import { Fragment } from 'react';

const TDS_RATE = 0.001; // 0.1% of sale value

interface OutstandingInvoice {
  id: string;
  partyId: string;
  brokerName: string | null;
  dueDate: Date;
  partyName: string;
  invoiceNumber: string | null;
  billDate: Date;
  billAmount: number;   // original invoice value (used for TDS calc base)
  discount: number;
  netAmount: number;    // remaining due after FIFO allocation
  totalAmount: number;
  dueDaysAfter: number;
  status: string;
  appliedReceipts: { date: string; amount: number; isTdsOrShortage?: boolean }[];
  deletableReceiptIds: string[];
}

interface ReceiveDialogState {
  inv: OutstandingInvoice;
  date: string;
  amountReceived: string;
  tdsAmount: string;
  shortageAmount: string;
}

export default function SaleDuesPage() {
  const qc = useQueryClient();
  const [receiveDialog, setReceiveDialog] = useState<ReceiveDialogState | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: parties, isLoading: loadingParties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const { data: saleOrders, isLoading: loadingSales } = useQuery({
    queryKey: ['sale-orders'],
    queryFn: () => api<SaleOrder[]>('/sale-orders'),
  });

  const { data: receipts, isLoading: loadingReceipts } = useQuery({
    queryKey: ['receipts'],
    queryFn: () => api<Receipt[]>('/receipts'),
  });

  const receiveMutation = useMutation({
    mutationFn: (body: {
      date: string; amount: number; tdsAmount: number; shortageAmount: number;
      type: string; partyId: string; saleDispatchId?: string;
    }) => api('/receipts', { method: 'POST', body }),
    onSuccess: () => {
      toast.success('Receipt recorded');
      qc.invalidateQueries({ queryKey: ['receipts'] });
      setReceiveDialog(null);
    },
    onError: () => toast.error('Failed to record receipt'),
  });

  const undoMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) {
        await api(`/receipts/${id}`, { method: 'DELETE' });
      }
    },
    onSuccess: () => {
      toast.success('Receipt removed');
      qc.invalidateQueries({ queryKey: ['receipts'] });
    },
    onError: () => toast.error('Failed to remove receipt'),
  });

  const isLoading = loadingParties || loadingSales || loadingReceipts;

  const buyers = parties?.filter((p) => p.type === 'BUYER') ?? [];

  const outstandingInvoices: OutstandingInvoice[] = [];

  let totalBillingAll = 0;
  let totalReceiptsAll = 0; // actual cash received only

  buyers.forEach((b) => {
    const shipments = (saleOrders ?? [])
      .filter((o) => o.buyerId === b.id)
      .flatMap((o) => (o.dispatches ?? []).map((d) => ({ d, o })))
      .sort((a, z) => new Date(a.d.dispatchDate).getTime() - new Date(z.d.dispatchDate).getTime())
      .map(({ d, o }) => {
        const base = Number(d.weightKg) * Number(o.ratePerKg);
        const gst = Number(d.gstAmount) || 0;
        const total = Math.round(base + gst);
        return {
          d,
          o,
          billAmount: total,
          totalAmount: total,
          remainingAmount: total,
          appliedReceipts: [] as OutstandingInvoice['appliedReceipts'],
          deletableReceiptIds: [] as string[],
        };
      });

    shipments.forEach((s) => { totalBillingAll += s.totalAmount; });

    // FIFO: count cash + TDS + shortage all as clearing amounts
    const buyerReceipts = receipts?.filter((r) => r.type === 'BUYER' && r.partyId === b.id)
      .sort((a, z) => new Date(a.date).getTime() - new Date(z.date).getTime()) ?? [];
    
    // For the stat card, show only actual cash (not TDS or shortage)
    totalReceiptsAll += buyerReceipts.reduce((sum, r) => sum + Number(r.amount), 0);

    // Apply direct receipts first
    shipments.forEach((s) => {
      const directReceipts = buyerReceipts.filter((r) => r.saleDispatchId === s.d.id);
      directReceipts.forEach((receipt) => {
        s.deletableReceiptIds.push(receipt.id);
        const available = Number(receipt.amount) + Number(receipt.tdsAmount ?? 0) + Number(receipt.shortageAmount ?? 0);
        if (s.remainingAmount > 0) {
          const applied = Math.min(available, s.remainingAmount);
          s.remainingAmount -= applied;
          s.appliedReceipts.push({
            date: receipt.date,
            amount: applied,
            isTdsOrShortage: Number(receipt.amount) === 0 // If it was pure TDS/Shortage
          });
        }
      });
    });

    let availableReceipts = buyerReceipts
      .filter((r) => !r.saleDispatchId)
      .map(r => ({
        ...r,
        available: Number(r.amount) + Number(r.tdsAmount ?? 0) + Number(r.shortageAmount ?? 0),
      }));

    shipments.forEach((s) => {
      for (const receipt of availableReceipts) {
        if (s.remainingAmount <= 0) break;
        if (receipt.available > 0) {
          const applied = Math.min(receipt.available, s.remainingAmount);
          receipt.available -= applied;
          s.remainingAmount -= applied;
          
          s.appliedReceipts.push({
            date: receipt.date,
            amount: applied,
            isTdsOrShortage: Number(receipt.amount) === 0 // If it was pure TDS/Shortage
          });
        }
      }
    });

    const today = new Date();
    shipments.forEach((s) => {
      let status = 'Unpaid';
      if (s.remainingAmount <= 0.01) status = 'Paid';
      else if (s.remainingAmount < s.totalAmount - 0.01) status = 'Partially Paid';

      const start = s.d.deliveredDate || s.d.dispatchDate;
      const limitDays = s.o.dueDays || 0;
      const dueDate = new Date(start);
      dueDate.setDate(dueDate.getDate() + limitDays);

      const diffTime = today.getTime() - dueDate.getTime();
      const dueDaysAfter = Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));

      outstandingInvoices.push({
        id: s.d.id,
        partyId: b.id,
        brokerName: s.o.broker?.name ?? null,
        dueDate,
        partyName: b.name,
        invoiceNumber: s.d.invoiceNumber,
        billDate: new Date(s.d.dispatchDate),
        billAmount: s.billAmount,
        discount: 0,
        netAmount: s.remainingAmount,
        totalAmount: s.totalAmount,
        dueDaysAfter,
        status,
        appliedReceipts: s.appliedReceipts,
        deletableReceiptIds: s.deletableReceiptIds,
      });
    });
  });

  outstandingInvoices.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

  const totalOutstanding = outstandingInvoices.reduce((sum, item) => sum + item.netAmount, 0);

  function openReceiveDialog(inv: OutstandingInvoice) {
    const today = new Date().toISOString().slice(0, 10);
    const tds = parseFloat((inv.billAmount * TDS_RATE).toFixed(2));
    setReceiveDialog({
      inv,
      date: today,
      amountReceived: inv.netAmount.toFixed(2),
      tdsAmount: tds.toFixed(2),
      shortageAmount: '0.00',
    });
  }

  // Derived: shortage = outstanding - amountReceived - TDS (when short)
  function getAutoShortage(d: ReceiveDialogState): number {
    const received = parseFloat(d.amountReceived) || 0;
    const tds = parseFloat(d.tdsAmount) || 0;
    return Math.max(0, d.inv.netAmount - received - tds);
  }

  function submitReceive() {
    if (!receiveDialog) return;
    const received = parseFloat(receiveDialog.amountReceived);
    const tds = parseFloat(receiveDialog.tdsAmount) || 0;
    const shortage = parseFloat(receiveDialog.shortageAmount) || 0;
    if (!receiveDialog.date || isNaN(received) || received < 0) {
      toast.error('Please enter a valid date and amount received');
      return;
    }
    if (received === 0 && tds === 0 && shortage === 0) {
      toast.error('At least one of Amount Received, TDS, or Shortage must be non-zero');
      return;
    }
    receiveMutation.mutate({
      date: receiveDialog.date,
      amount: received,
      tdsAmount: tds,
      shortageAmount: shortage,
      type: 'BUYER',
      partyId: receiveDialog.inv.partyId,
      saleDispatchId: receiveDialog.inv.id,
    });
  }

  const autoShortage = receiveDialog ? getAutoShortage(receiveDialog) : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Sale Dues</h1>
        <p className="text-muted-foreground font-medium">Aging list of outstanding buyer sales invoices matching receipts via FIFO allocation.</p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Billed Sales</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{rupees(totalBillingAll)}</div>
              </CardContent>
            </Card>
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Cash Received</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{rupees(totalReceiptsAll)}</div>
              </CardContent>
            </Card>
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Net Outstanding Receivables</CardTitle>
                <TrendingUp className="h-4 w-4 text-emerald-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{rupees(totalOutstanding)}</div>
              </CardContent>
            </Card>
          </div>

          <div className="rounded-lg border bg-card overflow-auto max-h-[70vh]">
            <div className="px-5 py-4 border-b font-semibold text-sm">Sales Aging List</div>
            <Table>
              <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-muted [&_th]:shadow-[0_1px_0_0] [&_th]:shadow-border">
                <TableRow>
                  <TableHead>Broker</TableHead>
                  <TableHead>Due Date</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Invoice No</TableHead>
                  <TableHead>Bill Date</TableHead>
                  <TableHead className="text-right">Bill Amount</TableHead>
                  <TableHead className="text-right">Net Amount Due</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead className="text-center">Due Days</TableHead>
                  <TableHead className="text-center">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outstandingInvoices.length === 0 ? (
                  <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground py-8">No sales dues found.</TableCell></TableRow>
                ) : (
                  outstandingInvoices.map((inv) => (
                    <Fragment key={inv.id}>
                      <TableRow className="cursor-pointer hover:bg-muted/50" onClick={() => setExpandedId(expandedId === inv.id ? null : inv.id)}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {expandedId === inv.id ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                            {inv.brokerName ?? '-'}
                          </div>
                        </TableCell>
                        <TableCell className="font-medium">{shortDate(inv.dueDate.toISOString())}</TableCell>
                        <TableCell>{inv.partyName}</TableCell>
                        <TableCell className="font-mono text-xs">{inv.invoiceNumber ?? '-'}</TableCell>
                        <TableCell>{shortDate(inv.billDate.toISOString())}</TableCell>
                        <TableCell className="text-right">{rupees(inv.billAmount)}</TableCell>
                        <TableCell className="text-right font-bold text-emerald-600 dark:text-emerald-400">
                          {rupees(inv.netAmount)}
                        </TableCell>
                        <TableCell className="text-center">
                          <span className={`font-semibold ${inv.status === 'Paid' ? 'text-emerald-600 dark:text-emerald-400' : inv.status === 'Unpaid' ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400'}`}>
                            {inv.status}
                          </span>
                        </TableCell>
                        <TableCell className="text-center">
                          {inv.status !== 'Paid' ? (
                            inv.dueDaysAfter > 0 ? (
                              <span className="text-rose-600 dark:text-rose-400 font-bold">{inv.dueDaysAfter} days</span>
                            ) : (
                              <span className="text-muted-foreground">Not due</span>
                            )
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell className="text-center">
                          <div className="flex items-center justify-center gap-2">
                            {inv.status !== 'Paid' && (
                              <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); openReceiveDialog(inv); }}>
                                Received
                              </Button>
                            )}
                            {inv.deletableReceiptIds.length > 0 && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-rose-600 hover:text-rose-700 dark:text-rose-400"
                                disabled={undoMutation.isPending}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (window.confirm(`Undo receipt for ${inv.partyName}${inv.invoiceNumber ? ` (${inv.invoiceNumber})` : ''}? This deletes the receipt and its ledger entry.`)) {
                                    undoMutation.mutate(inv.deletableReceiptIds);
                                  }
                                }}
                              >
                                <Undo2 className="h-3.5 w-3.5 mr-1" /> Undo
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                      {expandedId === inv.id && (
                        <TableRow className="bg-muted/20">
                          <TableCell colSpan={10} className="p-0 border-b-0">
                            <div className="px-10 py-4">
                              <h4 className="font-semibold text-sm mb-3">Allocated Receipts</h4>
                              {inv.appliedReceipts.length > 0 ? (
                                <Table className="bg-background border rounded-md shadow-sm w-full max-w-lg">
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead className="w-[150px]">Date</TableHead>
                                      <TableHead>Amount Paid</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {inv.appliedReceipts.map((ar, idx) => (
                                      <TableRow key={idx}>
                                        <TableCell>{shortDate(new Date(ar.date).toISOString())}</TableCell>
                                        <TableCell className="font-medium text-emerald-600">
                                          {rupees(ar.amount)}
                                          {ar.isTdsOrShortage && <span className="text-xs text-muted-foreground ml-2">(TDS/Shortage)</span>}
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              ) : (
                                <p className="text-sm text-muted-foreground">No receipts have been allocated to this invoice yet.</p>
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
        </>
      )}

      {/* Receive dialog */}
      <Dialog open={!!receiveDialog} onOpenChange={(open) => { if (!open) setReceiveDialog(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Record Receipt</DialogTitle>
          </DialogHeader>
          {receiveDialog && (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">
                {receiveDialog.inv.partyName} · {receiveDialog.inv.invoiceNumber ?? 'No invoice'}
              </p>
              <p className="text-sm font-medium">
                Outstanding: <span className="text-emerald-600">{rupees(receiveDialog.inv.netAmount)}</span>
              </p>

              <div className="space-y-1">
                <Label htmlFor="recv-date">Date Received</Label>
                <Input
                  id="recv-date"
                  type="date"
                  value={receiveDialog.date}
                  onChange={(e) => setReceiveDialog((d) => d && ({ ...d, date: e.target.value }))}
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="recv-amount">Amount Received (₹)</Label>
                <Input
                  id="recv-amount"
                  type="number"
                  step="0.01"
                  value={receiveDialog.amountReceived}
                  onChange={(e) => setReceiveDialog((d) => d && ({ ...d, amountReceived: e.target.value }))}
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="recv-tds">
                  TDS (₹)
                  <span className="ml-2 text-xs text-muted-foreground font-normal">
                    0.1% of bill = {rupees(receiveDialog.inv.billAmount * TDS_RATE)}
                  </span>
                </Label>
                <Input
                  id="recv-tds"
                  type="number"
                  step="0.01"
                  value={receiveDialog.tdsAmount}
                  onChange={(e) => setReceiveDialog((d) => d && ({ ...d, tdsAmount: e.target.value }))}
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="recv-shortage">
                  Shortage / Kata (₹)
                  {autoShortage > 0 && (
                    <span className="ml-2 text-xs text-amber-600 font-normal">
                      auto: {rupees(autoShortage)}
                    </span>
                  )}
                </Label>
                <Input
                  id="recv-shortage"
                  type="number"
                  step="0.01"
                  value={receiveDialog.shortageAmount}
                  onChange={(e) => setReceiveDialog((d) => d && ({ ...d, shortageAmount: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">
                  Enter the shortage/weight deduction from party kata. Leave 0 if full amount received.
                </p>
              </div>

              {/* Settlement summary */}
              {(() => {
                const received = parseFloat(receiveDialog.amountReceived) || 0;
                const tds = parseFloat(receiveDialog.tdsAmount) || 0;
                const shortage = parseFloat(receiveDialog.shortageAmount) || 0;
                const total = received + tds + shortage;
                return (
                  <div className="rounded-md bg-muted/50 px-3 py-2 text-xs space-y-0.5">
                    <div className="flex justify-between"><span>Cash received</span><span>{rupees(received)}</span></div>
                    <div className="flex justify-between"><span>TDS</span><span>{rupees(tds)}</span></div>
                    <div className="flex justify-between"><span>Shortage</span><span>{rupees(shortage)}</span></div>
                    <div className="flex justify-between font-semibold border-t pt-1 mt-1">
                      <span>Total settled</span>
                      <span className={total > receiveDialog.inv.netAmount + 0.01 ? 'text-amber-600' : 'text-emerald-600'}>
                        {rupees(total)}
                      </span>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReceiveDialog(null)}>Cancel</Button>
            <Button onClick={submitReceive} disabled={receiveMutation.isPending}>
              {receiveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm Receipt'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
