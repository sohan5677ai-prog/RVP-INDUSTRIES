import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BellRing, Truck, X } from 'lucide-react';
import { api } from '@/lib/api';
import type { SaleOrder, SaleProduct } from '@/lib/types';
import { shortDate, toTonnes } from '@/lib/format';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

// Dispatch reminders surface from 3 days before an order's reminder date. Ignored
// reminders are remembered locally (keyed by order id + reminder date) so re-saving
// a new date re-arms the reminder.
const REMIND_WINDOW_DAYS = 3;
const DISMISS_KEY = 'dispatchReminders:dismissed';

// Where the dispatch flow lives for each commodity.
const DISPATCH_ROUTE: Record<SaleProduct, string> = {
  PAPPU: '/sales/pappu',
  TPS: '/sales/tps',
  HUSK: '/sales/husk',
  WASTE: '/sales/byproducts',
  SHELL: '/sales/byproducts',
  PRECLEANER_DUST: '/sales/byproducts',
  NALLA_POKKULU: '/sales/byproducts',
  NALLA_CHINTAPANDU: '/sales/byproducts',
};

const dayStart = (iso: string) => {
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const daysUntil = (iso: string) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((dayStart(iso) - today.getTime()) / 86400000);
};

const reminderKey = (o: SaleOrder) => `${o.id}|${(o.reminderDate ?? '').slice(0, 10)}`;

function loadDismissed(): Set<string> {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]'));
  } catch {
    return new Set<string>();
  }
}

export default function DispatchReminders() {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());
  const [closed, setClosed] = useState(false);

  const { data: orders } = useQuery({ queryKey: ['sale-orders'], queryFn: () => api<SaleOrder[]>('/sale-orders'), enabled: !closed });

  const due = useMemo(() => {
    return (orders ?? [])
      .filter((o) => {
        if (!o.reminderDate) return false;
        if (o.status === 'DISPATCHED') return false; // nothing left to dispatch
        if ((o.remainingKg ?? o.tonnageKg) <= 0) return false;
        if (daysUntil(o.reminderDate) > REMIND_WINDOW_DAYS) return false; // still too early
        if (dismissed.has(reminderKey(o))) return false;
        return true;
      })
      .sort((a, b) => dayStart(a.reminderDate!) - dayStart(b.reminderDate!));
  }, [orders, dismissed]);

  if (closed || due.length === 0) return null;

  const ignore = (o: SaleOrder) => {
    const next = new Set(dismissed);
    next.add(reminderKey(o));
    setDismissed(next);
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...next]));
  };

  const dispatch = (o: SaleOrder) => {
    setClosed(true);
    navigate(DISPATCH_ROUTE[o.product] ?? '/sale-orders');
  };

  return (
    <Dialog open onOpenChange={(v) => !v && setClosed(true)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BellRing className="h-5 w-5 text-amber-500" />
            Upcoming dispatches ({due.length})
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 max-h-[60vh] overflow-y-auto">
          {due.map((o) => {
            const d = daysUntil(o.reminderDate!);
            const when = d < 0 ? `${Math.abs(d)}d overdue` : d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : `In ${d} days`;
            return (
              <div key={o.id} className="rounded-lg border bg-card p-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold truncate">{o.buyer?.name ?? '-'}</span>
                    <Badge variant="outline" className="text-[10px]">{o.product}</Badge>
                    <Badge variant={d < 0 ? 'destructive' : 'secondary'} className="text-[10px]">{when}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Dispatch by <b>{shortDate(o.reminderDate!)}</b> · {toTonnes(o.remainingKg ?? o.tonnageKg).toFixed(2)} t remaining
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button size="sm" onClick={() => dispatch(o)}>
                    <Truck className="h-4 w-4" /> Dispatch
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => ignore(o)} title="Ignore this reminder">
                    <X className="h-4 w-4" /> Ignore
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
