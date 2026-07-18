import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Party, Purchase, Payment } from '@/lib/types';
import { rupees, shortDate, toTonnes } from '@/lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Wallet, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { usePagedRows } from '@/lib/usePagedRows';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';

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
  partyId: string;
  purchaseDate: Date;
  partyName: string;
  invoiceNumber: string | null;
  pricePerKg: string;
  tonnageKg: number;
  lorryNumber: string | null;
  dueAge: number;
  amount: number;
}

interface PartyGroup {
  partyId: string;
  partyName: string;
  bills: OutstandingPurchase[];
  totalAmount: number;
  maxDueAge: number;
  oldestDate: Date;
}

export default function PaymentPlannerPage() {
  const [bankBalance, setBankBalance] = useState('');
  const [plans, setPlans] = useState<Record<string, string>>({});
  const [expandedParties, setExpandedParties] = useState<Set<string>>(new Set());

  const { data: parties, isLoading: loadingParties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const { data: purchases, isLoading: loadingPurchases } = useQuery({
    queryKey: ['purchases'],
    queryFn: () => api<PurchaseRow[]>('/purchases?all=true'),
  });

  const { data: payments, isLoading: loadingPayments } = useQuery({
    // Full history — dues are matched against every payment, not just latest 100.
    queryKey: ['payments', { all: true }],
    queryFn: () => api<Payment[]>('/payments?all=true'),
  });

  const isLoading = loadingParties || loadingPurchases || loadingPayments;

  // FIFO allocation is heavy and depends only on the fetched data. Memoize it so
  // typing in the plan-amount / bank-balance inputs doesn't recompute the whole
  // allocation on every keystroke.
  const outstandingPurchases = useMemo<OutstandingPurchase[]>(() => {
  const suppliers = parties?.filter((p) => p.type !== 'BUYER' && p.type !== 'HAMALI_TEAM') ?? [];

  const rows: OutstandingPurchase[] = [];

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
        return { ...p, totalAmount: total, remainingAmount: total };
      }) ?? [];

    const partyPayments = payments?.filter((p) => p.type === 'SUPPLIER' && p.partyId === s.id)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()) ?? [];

    // Apply direct payments first
    activePurchases.forEach((p) => {
      const directPayments = partyPayments.filter((pay) => pay.purchaseId === p.id);
      directPayments.forEach((pay) => {
        const amt = Number(pay.amount);
        if (p.remainingAmount > 0) {
          const applied = Math.min(amt, p.remainingAmount);
          p.remainingAmount -= applied;
        }
      });
    });

    const availablePayments = partyPayments
      .filter((p) => !p.purchaseId)
      .map((p) => ({ ...p, available: Number(p.amount) }));

    activePurchases.forEach((p) => {
      for (const payment of availablePayments) {
        if (p.remainingAmount <= 0) break;
        if (payment.available > 0) {
          const applied = Math.min(payment.available, p.remainingAmount);
          payment.available -= applied;
          p.remainingAmount -= applied;
        }
      }
    });

    const today = new Date();
    activePurchases.forEach((p) => {
      if (p.remainingAmount <= 0.01) return; // only unpaid / partially paid bills matter here

      const purchaseDate = new Date(p.stockIn?.arrivalDate || p.createdAt);
      const diffTime = today.getTime() - purchaseDate.getTime();
      const dueAge = Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));

      rows.push({
        id: p.id,
        partyId: s.id,
        purchaseDate,
        partyName: s.name,
        invoiceNumber: p.stockIn?.invoiceNumber ?? null,
        pricePerKg: p.verification?.pricePerKg ?? '0',
        tonnageKg: p.verification?.finalWeightKg ?? p.verification?.billingWeightKg ?? p.netWeightKg,
        lorryNumber: p.stockIn?.lorryNumber ?? null,
        dueAge,
        amount: p.remainingAmount,
      });
    });
  });

  // Oldest dues first — pay these before the newer ones.
  rows.sort((a, b) => a.purchaseDate.getTime() - b.purchaseDate.getTime());
  return rows;
  }, [parties, purchases, payments]);

  // Club invoices party-wise so dues are reviewed and settled per supplier.
  const partyGroups = useMemo<PartyGroup[]>(() => {
    const map = new Map<string, PartyGroup>();
    outstandingPurchases.forEach((bill) => {
      let group = map.get(bill.partyId);
      if (!group) {
        group = {
          partyId: bill.partyId,
          partyName: bill.partyName,
          bills: [],
          totalAmount: 0,
          maxDueAge: 0,
          oldestDate: bill.purchaseDate,
        };
        map.set(bill.partyId, group);
      }
      group.bills.push(bill);
      group.totalAmount += bill.amount;
      group.maxDueAge = Math.max(group.maxDueAge, bill.dueAge);
      if (bill.purchaseDate < group.oldestDate) group.oldestDate = bill.purchaseDate;
    });
    return Array.from(map.values()).sort((a, b) => a.oldestDate.getTime() - b.oldestDate.getTime());
  }, [outstandingPurchases]);

  function toggleParty(partyId: string) {
    setExpandedParties((prev) => {
      const next = new Set(prev);
      if (next.has(partyId)) next.delete(partyId);
      else next.add(partyId);
      return next;
    });
  }

  const totalOutstanding = outstandingPurchases.reduce((sum, item) => sum + item.amount, 0);

  const bankNum = parseFloat(bankBalance) || 0;
  const totalPlanned = outstandingPurchases.reduce(
    (sum, item) => sum + (parseFloat(plans[item.id]) || 0),
    0
  );
  const bankAfter = bankNum - totalPlanned;
  const duesAfter = totalOutstanding - totalPlanned;

  function setPlan(id: string, value: string) {
    setPlans((prev) => ({ ...prev, [id]: value }));
  }

  // Bulk "pay this much for this party" — distributes the entered amount across
  // that party's own dues, oldest invoice first, so a lump sum clears the oldest
  // bills before touching newer ones.
  function setPartyBulkPay(group: PartyGroup, value: string) {
    let remaining = parseFloat(value) || 0;
    setPlans((prev) => {
      const next = { ...prev };
      group.bills.forEach((bill) => {
        if (remaining <= 0) {
          next[bill.id] = '';
          return;
        }
        const pay = Math.round(Math.min(remaining, bill.amount)); // whole rupees
        next[bill.id] = pay > 0 ? String(pay) : '';
        remaining -= pay;
      });
      return next;
    });
  }

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows: pagedGroups = [] } = usePagedRows(partyGroups, 25);

  const exportColumns: ExportColumn<OutstandingPurchase>[] = [
    { header: 'Date', value: (b) => shortDate(b.purchaseDate.toISOString()) },
    { header: 'Party', value: (b) => b.partyName },
    { header: 'Invoice No', value: (b) => b.invoiceNumber ?? '' },
    { header: 'Price/kg', value: (b) => rupees(b.pricePerKg), excel: (b) => Number(b.pricePerKg), numFmt: '#,##0.00', align: 'right' },
    { header: 'Tonnes', value: (b) => toTonnes(b.tonnageKg).toFixed(2), excel: (b) => toTonnes(b.tonnageKg), numFmt: '#,##0.00', align: 'right' },
    { header: 'Vehicle No', value: (b) => b.lorryNumber ?? '' },
    { header: 'Outstanding', value: (b) => rupees(b.amount), excel: (b) => b.amount, numFmt: '#,##0.00', align: 'right' },
    { header: 'Due Days', value: (b) => b.dueAge, align: 'center' },
    { header: 'Amount to Pay', value: (b) => rupees(parseFloat(plans[b.id]) || 0), excel: (b) => parseFloat(plans[b.id]) || 0, numFmt: '#,##0.00', align: 'right' },
    { header: 'Remaining After', value: (b) => rupees(Math.max(0, b.amount - (parseFloat(plans[b.id]) || 0))), excel: (b) => Math.max(0, b.amount - (parseFloat(plans[b.id]) || 0)), numFmt: '#,##0.00', align: 'right' },
  ];

  function autoAllocate() {
    // Distribute the current bank balance across the oldest dues first.
    let remaining = bankNum;
    const next: Record<string, string> = {};
    for (const bill of outstandingPurchases) {
      if (remaining <= 0) {
        next[bill.id] = '';
        continue;
      }
      const pay = Math.round(Math.min(remaining, bill.amount)); // whole rupees
      next[bill.id] = String(pay);
      remaining -= pay;
    }
    setPlans(next);
  }

  function clearPlan() {
    setPlans({});
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Payment Planner</h1>
        <p className="text-muted-foreground font-medium">Plan supplier payments against your available bank balance. Nothing here is recorded — it is a what-if worksheet.</p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <>
          {/* Bank balance + summary */}
          <Card className="bg-card/50 border shadow-sm">
            <CardHeader className="pb-3 flex flex-row items-center gap-2">
              <Wallet className="h-4 w-4 text-primary" />
              <CardTitle className="text-sm font-semibold">Bank Balance &amp; Plan Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 items-end">
                <div className="space-y-1">
                  <Label htmlFor="bank-balance">Current Bank Balance (₹)</Label>
                  <Input
                    id="bank-balance"
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={bankBalance}
                    onChange={(e) => setBankBalance(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Total Outstanding Dues</Label>
                  <div className="h-10 flex items-center rounded-md border bg-muted/40 px-3 font-bold text-rose-600 dark:text-rose-400">
                    {rupees(totalOutstanding)}
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Total Planned Payment</Label>
                  <div className="h-10 flex items-center rounded-md border bg-muted/40 px-3 font-bold">
                    {rupees(totalPlanned)}
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Balance After Payment</Label>
                  <div className={`h-10 flex items-center rounded-md border px-3 font-bold ${bankAfter < 0 ? 'text-rose-600 dark:text-rose-400 bg-rose-500/10' : 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10'}`}>
                    {rupees(bankAfter)}
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Dues After Payment</Label>
                  <div className="h-10 flex items-center rounded-md border bg-muted/40 px-3 font-bold">
                    {rupees(Math.max(0, duesAfter))}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-4">
                <Button size="sm" variant="outline" onClick={autoAllocate} disabled={bankNum <= 0}>
                  Auto-allocate balance (oldest first)
                </Button>
                <Button size="sm" variant="ghost" onClick={clearPlan}>
                  Clear
                </Button>
                {bankAfter < 0 && (
                  <span className="text-xs text-rose-600 dark:text-rose-400 font-medium ml-auto">
                    Planned payments exceed your bank balance by {rupees(-bankAfter)}.
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Dues clubbed party-wise, expandable to the underlying invoices */}
          <div className="rounded-lg border bg-card overflow-hidden">
            <div className="px-5 py-4 border-b font-semibold text-sm flex items-center justify-between gap-3">
              <span>Outstanding Purchases <span className="text-muted-foreground font-normal">· {partyGroups.length} {partyGroups.length === 1 ? 'party' : 'parties'} · {outstandingPurchases.length} invoices</span></span>
              <ExportButtons
                filename="Payment_Plan"
                title="Payment Planner"
                subtitle={`Bank balance ${rupees(bankNum)} · Planned ${rupees(totalPlanned)}`}
                columns={exportColumns}
                rows={outstandingPurchases}
              />
            </div>

            {partyGroups.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">No outstanding purchase dues.</div>
            ) : (
              <div className="divide-y">
                {pagedGroups.map((group) => {
                  const isExpanded = expandedParties.has(group.partyId);
                  const groupPlanned = group.bills.reduce((sum, b) => sum + (parseFloat(plans[b.id]) || 0), 0);
                  const groupRemaining = group.totalAmount - groupPlanned;
                  return (
                    <div key={group.partyId}>
                      <div
                        onClick={() => toggleParty(group.partyId)}
                        className="w-full flex items-center justify-between gap-4 px-5 py-4 hover:bg-muted/40 transition-colors cursor-pointer"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="font-semibold truncate">{group.partyName}</div>
                            <div className="text-xs text-muted-foreground">
                              {group.bills.length} invoice{group.bills.length !== 1 ? 's' : ''} · oldest due{' '}
                              <span className="text-rose-600 dark:text-rose-400 font-medium">{group.maxDueAge} days</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-4 shrink-0" onClick={(e) => e.stopPropagation()}>
                          <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground block text-right">Amount to Pay (₹)</Label>
                            <Input
                              type="number"
                              step="0.01"
                              min="0"
                              placeholder="0.00"
                              value={groupPlanned > 0 ? String(groupPlanned) : ''}
                              onChange={(e) => setPartyBulkPay(group, e.target.value)}
                              className="h-9 w-36 text-right"
                            />
                          </div>
                          <div className="text-right">
                            <div className="text-xs text-muted-foreground">Total Balance</div>
                            <div className="font-bold text-rose-600 dark:text-rose-400">{rupees(group.totalAmount)}</div>
                          </div>
                          {groupPlanned > 0 && (
                            <div className="text-right">
                              <div className="text-xs text-muted-foreground">Remaining</div>
                              <div className={`font-bold ${groupRemaining <= 0.01 ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>
                                {rupees(Math.max(0, groupRemaining))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="border-t bg-muted/20 overflow-x-auto">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Date</TableHead>
                                <TableHead>Invoice No</TableHead>
                                <TableHead className="text-right">Price</TableHead>
                                <TableHead>Vehicle No</TableHead>
                                <TableHead className="text-right">Outstanding Amount</TableHead>
                                <TableHead className="text-center">Due Days</TableHead>
                                <TableHead className="text-right w-[160px]">Amount to Pay (₹)</TableHead>
                                <TableHead className="text-right">Remaining After</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {group.bills.map((bill) => {
                                const pay = parseFloat(plans[bill.id]) || 0;
                                const remaining = bill.amount - pay;
                                const overPaid = pay > bill.amount + 0.01;
                                return (
                                  <TableRow key={bill.id}>
                                    <TableCell className="font-medium whitespace-nowrap">{shortDate(bill.purchaseDate.toISOString())}</TableCell>
                                    <TableCell className="font-mono text-xs">{bill.invoiceNumber ?? '-'}</TableCell>
                                    <TableCell className="text-right whitespace-nowrap">
                                      {rupees(bill.pricePerKg)}/kg
                                      <span className="text-muted-foreground text-xs block">{toTonnes(bill.tonnageKg).toFixed(2)} t</span>
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">{bill.lorryNumber ?? '-'}</TableCell>
                                    <TableCell className="text-right font-bold text-rose-600 dark:text-rose-400">{rupees(bill.amount)}</TableCell>
                                    <TableCell className="text-center">
                                      <span className="text-rose-600 dark:text-rose-400 font-bold">{bill.dueAge} days</span>
                                    </TableCell>
                                    <TableCell className="text-right">
                                      <Input
                                        type="number"
                                        step="0.01"
                                        min="0"
                                        placeholder="0.00"
                                        value={plans[bill.id] ?? ''}
                                        onChange={(e) => setPlan(bill.id, e.target.value)}
                                        className={`h-9 text-right ${overPaid ? 'border-rose-500 focus-visible:ring-rose-500' : ''}`}
                                      />
                                    </TableCell>
                                    <TableCell className={`text-right font-semibold ${remaining <= 0.01 ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>
                                      {rupees(Math.max(0, remaining))}
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                              <TableRow className="bg-muted/40 font-semibold">
                                <TableCell colSpan={4} className="text-right text-xs text-muted-foreground">Party total</TableCell>
                                <TableCell className="text-right text-rose-600 dark:text-rose-400">{rupees(group.totalAmount)}</TableCell>
                                <TableCell />
                                <TableCell className="text-right">{rupees(groupPlanned)}</TableCell>
                                <TableCell className={`text-right ${groupRemaining <= 0.01 ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>
                                  {rupees(Math.max(0, groupRemaining))}
                                </TableCell>
                              </TableRow>
                            </TableBody>
                          </Table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
          </div>
        </>
      )}
    </div>
  );
}
