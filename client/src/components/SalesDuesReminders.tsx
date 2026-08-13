import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { IndianRupee, X } from 'lucide-react';
import { api } from '@/lib/api';
import type { Party, SaleOrder, Receipt, SaleProduct } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { settledByDispatch, isDispatchPaid, dispatchTotal } from '@/lib/saleStatus';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import ReminderDialog from '@/components/ReminderDialog';
import { useReminderSlot } from '@/components/ReminderQueue';

const DISMISS_KEY = 'salesDuesReminders:dismissed';

const dayStart = (d: Date) => {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c.getTime();
};

const daysOverdue = (dueDate: Date) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - dayStart(dueDate)) / 86400000);
};

const reminderKey = (dispatchId: string, dueDate: Date) => `${dispatchId}|${dueDate.toISOString().slice(0, 10)}`;

function loadDismissed(): Set<string> {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]'));
  } catch {
    return new Set<string>();
  }
}

interface OverdueDueItem {
  dispatchId: string;
  partyId: string;
  partyName: string;
  product: SaleProduct;
  invoiceNumber: string | null;
  dueDate: Date;
  billAmount: number;
  netAmount: number;
  daysOverdue: number;
}

export default function SalesDuesReminders() {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());
  const [closed, setClosed] = useState(false);

  const { data: parties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
    enabled: !closed,
  });

  const { data: saleOrders } = useQuery({
    queryKey: ['sale-orders', { all: true }],
    queryFn: () => api<SaleOrder[]>('/sale-orders?all=true'),
    enabled: !closed,
  });

  const { data: receipts } = useQuery({
    queryKey: ['receipts', { all: true }],
    queryFn: () => api<Receipt[]>('/receipts?all=true'),
    enabled: !closed,
  });

  const dueItems = useMemo<OverdueDueItem[]>(() => {
    if (!parties || !saleOrders || !receipts) return [];
    const buyers = parties.filter((p) => p.type === 'BUYER' || p.type === 'BOTH');
    const settled = settledByDispatch(receipts);
    const items: OverdueDueItem[] = [];

    buyers.forEach((b) => {
      const shipments = (saleOrders ?? [])
        .filter((o) => o.buyerId === b.id)
        .flatMap((o) => (o.dispatches ?? []).map((d) => ({ d, o })));

      shipments.forEach(({ d, o }) => {
        const rate = Number(o.ratePerKg);
        const total = dispatchTotal(d, rate);
        const cleared = settled.get(d.id) ?? 0;
        const paid = isDispatchPaid(d, rate, settled);
        const remaining = paid ? 0 : Math.max(0, total - cleared);

        if (paid || remaining <= 0.01) return;

        // Not delivered → the credit clock hasn't started, so there is no due
        // date to be past. Without this the popup nags about a lorry that is
        // still on the road (dispatch date + credit days looks overdue the
        // moment it leaves). Same rule as Sale Dues and the ledger's reminder.
        if (d.status !== 'DELIVERED') return;

        const start = d.deliveredDate || d.dispatchDate;
        const dueDate = new Date(start);
        dueDate.setDate(dueDate.getDate() + (o.dueDays || 0));

        const overDays = daysOverdue(dueDate);
        // Popup trigger: due date is today or has passed
        if (overDays < 0) return;

        const key = reminderKey(d.id, dueDate);
        if (dismissed.has(key)) return;

        items.push({
          dispatchId: d.id,
          partyId: b.id,
          partyName: b.name,
          product: o.product,
          invoiceNumber: d.invoiceNumber,
          dueDate,
          billAmount: total,
          netAmount: remaining,
          daysOverdue: overDays,
        });
      });
    });

    items.sort((a, b) => b.daysOverdue - a.daysOverdue);
    return items;
  }, [parties, saleOrders, receipts, dismissed]);

  const slot = useReminderSlot('sales-dues', dueItems.length > 0);

  const close = () => {
    setClosed(true);
    slot.close();
  };

  if (closed || !slot.open || dueItems.length === 0) return null;

  const ignore = (item: OverdueDueItem) => {
    const key = reminderKey(item.dispatchId, item.dueDate);
    const next = new Set(dismissed);
    next.add(key);
    setDismissed(next);
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...next]));
  };

  // Straight into Record Receipt on the Receipts page, with the buyer chosen
  // and this invoice already ticked - the popup knows which bill is overdue, so
  // landing on a list and hunting for it again is a wasted step. (The old link
  // pointed at /sales/dues, which is not a route: it rendered a blank page.)
  const collect = (item: OverdueDueItem) => {
    close();
    navigate(
      `/transactions/receipts?party=${encodeURIComponent(item.partyId)}`
      + `&collect=${encodeURIComponent(item.dispatchId)}`,
    );
  };

  const totalDue = dueItems.reduce((s, i) => s + i.netAmount, 0);

  return (
    <ReminderDialog
      open
      onClose={close}
      icon={IndianRupee}
      tone="rose"
      title="Overdue sales dues"
      subtitle={`${rupees(totalDue)} past its due date across ${dueItems.length} invoice${dueItems.length > 1 ? 's' : ''}`}
      count={dueItems.length}
      step={slot.step}
      total={slot.total}
    >
      {dueItems.map((item) => {
        const when = item.daysOverdue === 0 ? 'Due Today' : `${item.daysOverdue}d overdue`;
        return (
          <div key={item.dispatchId} className="rounded-lg border bg-card p-3 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold truncate">{item.partyName}</span>
                <Badge variant="outline" className="text-[10px]">{item.product}</Badge>
                <Badge variant={item.daysOverdue === 0 ? 'warning' : 'destructive'} className="text-[10px]">
                  {when}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {item.invoiceNumber ? `Invoice #${item.invoiceNumber}` : 'Uninvoiced dispatch'} · Due <b>{shortDate(item.dueDate.toISOString())}</b>
              </p>
              <p className="text-xs font-semibold text-rose-600 dark:text-rose-400 mt-0.5">
                Net Due: {rupees(item.netAmount)} <span className="font-normal text-muted-foreground">(of {rupees(item.billAmount)})</span>
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Button size="sm" onClick={() => collect(item)}>
                <IndianRupee className="h-4 w-4" /> Collect
              </Button>
              <Button size="sm" variant="ghost" onClick={() => ignore(item)} title="Ignore this reminder">
                <X className="h-4 w-4" /> Ignore
              </Button>
            </div>
          </div>
        );
      })}
    </ReminderDialog>
  );
}
