import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PackageCheck, Truck, X } from 'lucide-react';
import { api } from '@/lib/api';
import type { CompanyProfile, PurchaseOrder } from '@/lib/types';
import { shortDate, toTonnes } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import ReminderDialog from '@/components/ReminderDialog';
import { useReminderSlot } from '@/components/ReminderQueue';

// Purchase-order arrival reminders. A PO that has been PENDING (ordered, lorry
// never stocked in) for at least CompanyProfile.poReminderDays days surfaces
// here on login, so an order the supplier quietly sat on doesn't go unnoticed.
// Threshold 0 switches the popup off.
const DISMISS_KEY = 'poReminders:dismissed';

const dayStart = (iso: string) => {
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const daysSince = (iso: string) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - dayStart(iso)) / 86400000);
};

// Ignoring snoozes a PO for one more reminder interval rather than killing the
// reminder for good - a lorry that never turns up should come back and nag.
// Stored as { [groupKey]: 'YYYY-MM-DD' } (the day it was ignored).
type Snoozes = Record<string, string>;

function loadSnoozes(): Snoozes {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Snoozes) : {};
  } catch {
    return {};
  }
}

interface PendingPoGroup {
  key: string;
  /** The concrete PO the Stock In button should preselect (oldest lorry of the group). */
  poId: string;
  partyName: string;
  poLabel: string;
  oldestPoDate: string;
  ageDays: number;
  lorries: number;
  pendingKg: number;
}

export default function PurchaseOrderReminders() {
  const navigate = useNavigate();
  const [snoozes, setSnoozes] = useState<Snoozes>(() => loadSnoozes());
  const [closed, setClosed] = useState(false);

  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: () => api<CompanyProfile>('/settings/company'),
    enabled: !closed,
  });

  const thresholdDays = Number(company?.poReminderDays ?? 3);
  const enabled = !closed && thresholdDays > 0;

  const { data: orders } = useQuery({
    queryKey: ['purchase-orders', 'PENDING'],
    queryFn: () => api<PurchaseOrder[]>('/purchase-orders?all=true&status=PENDING'),
    enabled,
  });

  const due = useMemo<PendingPoGroup[]>(() => {
    if (!enabled) return [];

    // One order is split into one PO per lorry (shared poGroupId); regroup so a
    // six-lorry order is one line in the popup, not six.
    const groups = new Map<string, PurchaseOrder[]>();
    for (const po of orders ?? []) {
      if (po.stockIns?.length) continue; // lorry already arrived
      if (daysSince(po.poDate) < thresholdDays) continue; // still within the grace window
      const key = po.poGroupId ?? po.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(po);
    }

    const rows: PendingPoGroup[] = [];
    groups.forEach((pos, key) => {
      const snoozedOn = snoozes[key];
      if (snoozedOn && daysSince(snoozedOn) < thresholdDays) return;

      const oldest = pos.reduce((a, p) => (dayStart(p.poDate) < dayStart(a.poDate) ? p : a), pos[0]);
      const oldestPoDate = oldest.poDate;
      const serials = pos.map((p) => p.poSerial).filter((n): n is number => typeof n === 'number');
      const first = pos[0];
      const poLabel =
        pos.length === 1
          ? (first.poNumber ?? '—')
          : serials.length && first.poSeriesKey
            ? `${first.poSeriesKey}/${Math.min(...serials)}-${Math.max(...serials)}/${first.poFy ?? ''}`
            : `${pos.length} lorries`;

      rows.push({
        key,
        poId: oldest.id,
        partyName: first.party?.name ?? '-',
        poLabel,
        oldestPoDate,
        ageDays: daysSince(oldestPoDate),
        lorries: pos.length,
        pendingKg: pos.reduce((s, p) => s + p.tonnageKg, 0),
      });
    });

    return rows.sort((a, b) => b.ageDays - a.ageDays);
  }, [orders, snoozes, thresholdDays, enabled]);

  const slot = useReminderSlot('purchase-orders', enabled && due.length > 0);

  const close = () => {
    setClosed(true);
    slot.close();
  };

  if (!enabled || !slot.open || due.length === 0) return null;

  const ignore = (g: PendingPoGroup) => {
    const next = { ...snoozes, [g.key]: new Date().toISOString().slice(0, 10) };
    setSnoozes(next);
    localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
  };

  // Opens the Record Stock In form with this PO already chosen, rather than
  // dropping the user on the arrivals list to find it again.
  const stockIn = (g: PendingPoGroup) => {
    close();
    navigate(`/stock-in?record=${encodeURIComponent(g.poId)}`);
  };

  const totalKg = due.reduce((s, g) => s + g.pendingKg, 0);

  return (
    <ReminderDialog
      open
      onClose={close}
      icon={PackageCheck}
      tone="blue"
      title="Purchase orders awaiting arrival"
      subtitle={`${toTonnes(totalKg).toFixed(2)} t ordered ${thresholdDays}+ days ago and still not stocked in`}
      count={due.length}
      step={slot.step}
      total={slot.total}
    >
      {due.map((g) => (
        <div key={g.key} className="rounded-lg border bg-card p-3 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold truncate">{g.partyName}</span>
              <Badge variant="outline" className="text-[10px]">{g.lorries === 1 ? '1 lorry' : `${g.lorries} lorries`}</Badge>
              <Badge variant={g.ageDays >= thresholdDays * 2 ? 'destructive' : 'warning'} className="text-[10px]">
                {g.ageDays}d waiting
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {g.poLabel} · Ordered <b>{shortDate(g.oldestPoDate)}</b> · {toTonnes(g.pendingKg).toFixed(2)} t not yet stocked in
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button size="sm" onClick={() => stockIn(g)}>
              <Truck className="h-4 w-4" /> Stock In
            </Button>
            <Button size="sm" variant="ghost" onClick={() => ignore(g)} title={`Ignore for ${thresholdDays} day(s)`}>
              <X className="h-4 w-4" /> Ignore
            </Button>
          </div>
        </div>
      ))}
    </ReminderDialog>
  );
}
