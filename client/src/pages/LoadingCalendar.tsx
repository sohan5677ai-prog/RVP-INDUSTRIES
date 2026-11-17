import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CalendarDays, ChevronLeft, ChevronRight, Plus, Minus, Truck, Check, X, Pencil,
  Trash2, Copy, Send, AlertTriangle, PackageOpen, Loader2,
} from 'lucide-react';
import { WhatsAppIcon } from '@/components/icons/WhatsAppIcon';
import { api, getErrorMessage } from '@/lib/api';
import type {
  DispatchSlot, DispatchBacklogOrder, DispatchIndentPreview, DispatchSlotStatus, Transport,
} from '@/lib/types';
import { PageHeader } from '@/components/PageHeader';
import { LorryCodeSheet } from '@/components/LorryCodeSheet';
import { Segmented } from '@/components/ui/segmented';
import { StatCard } from '@/components/StatCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

/**
 * The loading calendar - the page the dispatch plan lives on.
 *
 * It plans in *slots*: one card is one lorry on one day, drawing its tonnage
 * from one sale order. An order shipped across the 16th, 18th and 20th is three
 * cards, which is the whole reason this page exists - a per-order dialog cannot
 * show you what Tuesday looks like. The backlog rail on the left is the other
 * half: tonnage sold with no lorry behind it yet.
 */

const VEHICLE_CLASSES = [25_000, 30_000, 35_000, 40_000];
/** Matches the server's cap on one "plan several lorries" request. */
const MAX_LORRIES = 25;
const LOADING_POINTS = ['RVP', 'KNM'];

const t = (kgValue: number) => {
  const tonnes = kgValue / 1000;
  return Number.isInteger(tonnes) ? `${tonnes} t` : `${tonnes.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} t`;
};

/** `YYYY-MM-DD` for a Date, read in local time (the browser sits in IST). */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The day a backlog order's lorry should be planned for.
 *
 * The order's due date, because that is the day the buyer is waiting on and
 * the day the planner would have typed anyway. An overdue order keeps its own
 * date too: the lorry it is waiting for belongs against the day it was
 * promised, not against today. Only an order with no due date opens on today.
 */
function dueDateKey(order: { reminderDate: string | null }, todayKey: string): string {
  return order.reminderDate ? ymd(new Date(order.reminderDate)) : todayKey;
}

/** Monday of the week containing `d`. */
function weekStart(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (out.getDay() + 6) % 7; // Mon = 0
  out.setDate(out.getDate() - dow);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const STATUS_STYLE: Record<DispatchSlotStatus, { label: string; chip: string; dot: string }> = {
  PLANNED: { label: 'Planned', chip: 'bg-stone-500/12 text-stone-700 dark:text-stone-300', dot: 'bg-stone-400' },
  REQUESTED: { label: 'Asked', chip: 'bg-amber-500/15 text-amber-700 dark:text-amber-400', dot: 'bg-amber-500' },
  CONFIRMED: { label: 'Confirmed', chip: 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400', dot: 'bg-emerald-600' },
  LOADED: { label: 'Loaded', chip: 'bg-blue-600/15 text-blue-700 dark:text-blue-400', dot: 'bg-blue-600' },
  CANCELLED: { label: 'Cancelled', chip: 'bg-rose-600/15 text-rose-700 dark:text-rose-400', dot: 'bg-rose-500' },
};

/**
 * What the plan dialog collects: a day's fleet for one order, as a count
 * against each lorry size. "Two 25 t and a 40 t on the 16th" is one draft.
 */
type PlanDraft = {
  saleOrderId: string;
  date: string;
  loadingPoint: string;
  transportId: string;
  notes: string;
  /** vehicleClassKg -> how many of that size. */
  counts: Record<number, number>;
};

/** Editing works on one lorry, so the per-lorry figures come back here. */
type EditDraft = {
  id: string;
  saleOrderId: string;
  date: string;
  vehicleClassKg: number;
  plannedKg: number;
  loadingPoint: string;
  transportId: string;
  notes: string;
};

/**
 * Turn "two 25 t and a 40 t" into the lorries the API is handed.
 *
 * The fleet is laid out largest first, and the last lorry takes whatever is
 * left of the order rather than its full size: an order with 29.99 t to go
 * gets a 30 t lorry carrying 29.99 t, which is what actually leaves the gate.
 * That is why the dialog needs no kg boxes - the only load worth typing by
 * hand is a correction, and corrections are made on the card.
 */
/**
 * The transporter the dialog opens on.
 *
 * Nearly every lorry goes to Sree Madhupuri Transport, so that is the one the
 * planner should find already chosen; anything else is a deliberate switch.
 * Matched on the distinctive half of the name alone, so Sree/Sri and whatever
 * follows it in the record all land on the same transporter.
 */
const HOUSE_TRANSPORT = 'madhupuri';

function defaultTransportId(transports: Transport[]) {
  const key = (name: string) => name.toLowerCase().replace(/[^a-z]/g, '');
  const house = transports.find((x) => key(x.name).includes(HOUSE_TRANSPORT));
  return house?.id ?? transports[0]?.id ?? '';
}

function lorriesFor(counts: Record<number, number>, roomKg: number) {
  const out: { vehicleClassKg: number; plannedKg: number }[] = [];
  let left = roomKg;
  for (const cls of [...VEHICLE_CLASSES].sort((a, b) => b - a)) {
    for (let i = 0; i < (counts[cls] ?? 0); i += 1) {
      const plannedKg = Math.min(cls, left);
      if (plannedKg <= 0) return out;
      out.push({ vehicleClassKg: cls, plannedKg });
      left -= plannedKg;
    }
  }
  return out;
}

export default function LoadingCalendarPage() {
  const qc = useQueryClient();
  const [anchor, setAnchor] = useState(() => weekStart(new Date()));
  // Two readings of one plan: the week, and the codes each transporter holds.
  const [view, setView] = useState<'calendar' | 'codes'>('calendar');
  const [plan, setPlan] = useState<PlanDraft | null>(null);
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [confirming, setConfirming] = useState<DispatchSlot | null>(null);
  const [indent, setIndent] = useState<{ date: string; transportId: string } | null>(null);
  const [dragOrderId, setDragOrderId] = useState<string | null>(null);
  const [dragSlotId, setDragSlotId] = useState<string | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(anchor, i)), [anchor]);
  const from = ymd(days[0]);
  const to = ymd(days[6]);
  const todayKey = ymd(new Date());

  const slotsQ = useQuery({
    queryKey: ['dispatch-slots', from, to],
    queryFn: () => api<DispatchSlot[]>(`/dispatch-slots?from=${from}&to=${to}`),
    staleTime: 30_000,
  });
  const backlogQ = useQuery({
    queryKey: ['dispatch-backlog'],
    queryFn: () => api<DispatchBacklogOrder[]>('/dispatch-slots/backlog'),
    staleTime: 30_000,
  });
  const transportsQ = useQuery({
    queryKey: ['transports'],
    queryFn: () => api<Transport[]>('/transports'),
    staleTime: 300_000,
  });

  const slots = slotsQ.data ?? [];
  const backlog = backlogQ.data ?? [];
  const transports = (transportsQ.data ?? []).filter((x) => x.active !== false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['dispatch-slots'] });
    void qc.invalidateQueries({ queryKey: ['dispatch-backlog'] });
  };

  const byDay = useMemo(() => {
    const map = new Map<string, DispatchSlot[]>();
    for (const s of slots) {
      const list = map.get(s.dateKey) ?? [];
      list.push(s);
      map.set(s.dateKey, list);
    }
    return map;
  }, [slots]);

  const planLorries = useMutation({
    mutationFn: (d: PlanDraft & { lorries: { vehicleClassKg: number; plannedKg: number }[] }) =>
      api<DispatchSlot[]>('/dispatch-slots', {
        method: 'POST',
        body: JSON.stringify({
          saleOrderId: d.saleOrderId,
          date: d.date,
          loadingPoint: d.loadingPoint,
          transportId: d.transportId || null,
          notes: d.notes.trim() || null,
          lorries: d.lorries,
        }),
      }),
    onSuccess: (planned) => {
      const codes = planned.map((s) => s.code);
      toast.success(
        codes.length === 1
          ? `${codes[0]} planned`
          : codes.length <= 3
            ? `${codes.length} lorries planned · ${codes.join(', ')}`
            : `${codes.length} lorries planned · ${codes[0]} to ${codes[codes.length - 1]}`
      );
      setPlan(null);
      refresh();
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const saveSlot = useMutation({
    mutationFn: (d: EditDraft) =>
      api<DispatchSlot>(`/dispatch-slots/${d.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          saleOrderId: d.saleOrderId,
          date: d.date,
          vehicleClassKg: d.vehicleClassKg,
          plannedKg: d.plannedKg,
          loadingPoint: d.loadingPoint,
          transportId: d.transportId || null,
          notes: d.notes.trim() || null,
        }),
      }),
    onSuccess: (slot) => {
      toast.success(`${slot.code} updated`);
      setEditing(null);
      refresh();
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const moveSlot = useMutation({
    mutationFn: ({ id, date }: { id: string; date: string }) =>
      api<DispatchSlot>(`/dispatch-slots/${id}`, { method: 'PUT', body: JSON.stringify({ date }) }),
    onSuccess: (slot) => {
      toast.success(`Moved to ${slot.code}`);
      refresh();
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const removeSlot = useMutation({
    mutationFn: (id: string) => api<{ deleted: boolean }>(`/dispatch-slots/${id}`, { method: 'DELETE' }),
    onSuccess: (r) => {
      toast.success(r.deleted ? 'Slot removed' : 'Slot cancelled');
      refresh();
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const confirmSlot = useMutation({
    mutationFn: (args: { id: string; lorryNumber: string; driverName: string; driverPhone: string }) =>
      api<DispatchSlot>(`/dispatch-slots/${args.id}/confirm`, {
        method: 'POST',
        body: JSON.stringify({
          lorryNumber: args.lorryNumber,
          driverName: args.driverName.trim() || null,
          driverPhone: args.driverPhone.trim() || null,
        }),
      }),
    onSuccess: (slot) => {
      toast.success(`${slot.code} confirmed - ${slot.lorryNumber}`);
      setConfirming(null);
      refresh();
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const unconfirmSlot = useMutation({
    mutationFn: (id: string) => api<DispatchSlot>(`/dispatch-slots/${id}/unconfirm`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Confirmation cleared');
      refresh();
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const totals = useMemo(() => {
    const live = slots.filter((s) => s.status !== 'CANCELLED');
    return {
      lorries: live.length,
      kg: live.reduce((s, x) => s + x.plannedKg, 0),
      unconfirmed: live.filter((s) => s.status === 'PLANNED' || s.status === 'REQUESTED').length,
      unplannedKg: backlog.reduce((s, o) => s + o.unplannedKg, 0),
    };
  }, [slots, backlog]);

  const openEdit = (slot: DispatchSlot) =>
    setEditing({
      id: slot.id,
      saleOrderId: slot.saleOrderId,
      date: slot.dateKey,
      vehicleClassKg: slot.vehicleClassKg,
      plannedKg: slot.plannedKg,
      loadingPoint: slot.loadingPoint,
      transportId: slot.transportId ?? '',
      notes: slot.notes ?? '',
    });

  const openPlan = (date: string, order?: DispatchBacklogOrder) => {
    const chosen = order ?? backlog[0];
    if (!chosen) {
      toast.error('No orders are waiting for a lorry');
      return;
    }
    // Open with nothing counted. The sizes are the planner's call, and a size
    // put there for him is one he has to notice and undo before he can count
    // his own.
    setPlan({
      saleOrderId: chosen.id,
      date,
      loadingPoint: 'RVP',
      transportId: defaultTransportId(transports),
      notes: '',
      counts: {},
    });
    // A lorry planned for a date off-screen would be saved into a week the
    // planner is not looking at, so bring that week to him.
    const [y, m, d] = date.split('-').map(Number);
    setAnchor(weekStart(new Date(y, m - 1, d)));
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Loading Calendar"
        icon={CalendarDays}
        description={
          view === 'calendar'
            ? "Plan the lorries, not the orders. One card is one lorry on one day; drag an order from the backlog onto a date, then send each transporter his day's requirement."
            : 'Every code a transporter is holding, with the day, the size and where it goes - as one picture you can send him.'
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented<'calendar' | 'codes'>
              value={view}
              onValueChange={setView}
              size="sm"
              options={[
                { label: 'Calendar', value: 'calendar' },
                { label: 'Code sheet', value: 'codes' },
              ]}
            />
            {/* The week arrows only mean anything to the calendar; the code
                sheet carries its own range. */}
            {view === 'calendar' && (
              <>
                <Button variant="outline" size="sm" onClick={() => setAnchor(addDays(anchor, -7))}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" onClick={() => setAnchor(weekStart(new Date()))}>
                  This week
                </Button>
                <Button variant="outline" size="sm" onClick={() => setAnchor(addDays(anchor, 7))}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>
        }
      />

      {view === 'codes' ? (
        <LorryCodeSheet transports={transports} weekFrom={from} weekTo={to} />
      ) : (
      <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Lorries this week" value={totals.lorries} icon={Truck} tone="amber" />
        <StatCard label="Planned tonnage" value={t(totals.kg)} icon={PackageOpen} tone="forest" />
        <StatCard
          label="Not yet confirmed"
          value={totals.unconfirmed}
          icon={AlertTriangle}
          tone={totals.unconfirmed > 0 ? 'rose' : 'taupe'}
          hint="Lorries with no number against them"
        />
        <StatCard
          label="Sold, no lorry"
          value={t(totals.unplannedKg)}
          icon={CalendarDays}
          tone={totals.unplannedKg > 0 ? 'clay' : 'taupe'}
          hint="Across every open order"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        {/* ---- backlog rail ---- */}
        <aside className="glass rounded-2xl p-4 h-fit lg:sticky lg:top-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Waiting for a lorry</h2>
            {backlogQ.isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
          <div className="mt-3 space-y-2 max-h-[70vh] overflow-y-auto pr-1">
            {backlog.length === 0 && (
              <p className="text-sm text-muted-foreground py-6 text-center">Every open order has its lorries planned.</p>
            )}
            {backlog.map((o) => {
              const pct = o.remainingKg > 0 ? Math.min(100, (o.plannedKg / o.remainingKg) * 100) : 100;
              const done = o.unplannedKg === 0;
              return (
                <div
                  key={o.id}
                  draggable={!done}
                  onDragStart={() => setDragOrderId(o.id)}
                  onDragEnd={() => setDragOrderId(null)}
                  className={cn(
                    'rounded-xl border bg-card/60 p-3 transition',
                    done ? 'opacity-55' : 'cursor-grab active:cursor-grabbing hover:border-primary/40'
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{o.buyerName}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {o.destination || 'No destination'} · {o.product}
                      </p>
                    </div>
                    {!done && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        title="Plan a lorry"
                        onClick={() => openPlan(dueDateKey(o, todayKey), o)}
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary/70" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{t(o.plannedKg)} planned</span>
                    <span className={cn(!done && 'font-semibold text-foreground')}>
                      {done ? 'all planned' : `${t(o.unplannedKg)} left`}
                    </span>
                  </div>
                  {o.reminderDate && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Due {new Date(o.reminderDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        {/* ---- week ---- */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
          {days.map((day) => {
            const key = ymd(day);
            const daySlots = byDay.get(key) ?? [];
            const dayKg = daySlots.reduce((s, x) => s + x.plannedKg, 0);
            const isToday = key === todayKey;
            const transportIds = [...new Set(daySlots.map((s) => s.transportId).filter(Boolean))] as string[];
            return (
              <div
                key={key}
                onDragOver={(e) => {
                  if (dragOrderId || dragSlotId) {
                    e.preventDefault();
                    setDropDay(key);
                  }
                }}
                onDragLeave={() => setDropDay((d) => (d === key ? null : d))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropDay(null);
                  if (dragSlotId) {
                    const slot = slots.find((s) => s.id === dragSlotId);
                    setDragSlotId(null);
                    if (slot && slot.dateKey !== key) moveSlot.mutate({ id: slot.id, date: key });
                    return;
                  }
                  if (dragOrderId) {
                    const order = backlog.find((o) => o.id === dragOrderId);
                    setDragOrderId(null);
                    if (order) openPlan(key, order);
                  }
                }}
                className={cn(
                  'flex min-h-[220px] flex-col rounded-2xl border bg-card/40 p-3 transition',
                  isToday && 'border-primary/50 ring-1 ring-primary/20',
                  dropDay === key && 'border-primary bg-primary/5'
                )}
              >
                <div className="flex items-baseline justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {DOW[(day.getDay() + 6) % 7]}
                    </p>
                    <p className={cn('text-lg font-bold leading-tight', isToday && 'text-primary')}>
                      {day.getDate()}
                      <span className="ml-1 text-xs font-medium text-muted-foreground">
                        {day.toLocaleDateString('en-IN', { month: 'short' })}
                      </span>
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    title="Plan a lorry on this day"
                    onClick={() => openPlan(key)}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>

                <div className="mt-2 flex-1 space-y-2">
                  {daySlots.length === 0 && (
                    <p className="pt-6 text-center text-xs text-muted-foreground">No lorries</p>
                  )}
                  {daySlots.map((slot) => {
                    const st = STATUS_STYLE[slot.status];
                    return (
                      <div
                        key={slot.id}
                        draggable={slot.status !== 'LOADED'}
                        onDragStart={() => setDragSlotId(slot.id)}
                        onDragEnd={() => setDragSlotId(null)}
                        className="group rounded-xl border bg-card p-2.5 text-xs shadow-sm transition hover:border-primary/40"
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-mono text-[11px] font-semibold text-muted-foreground">{slot.code}</span>
                          <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-semibold', st.chip)}>
                            {st.label}
                          </span>
                        </div>
                        <p className="mt-1 font-semibold leading-tight">{t(slot.vehicleClassKg)} · {slot.saleOrder.destination || '-'}</p>
                        <p className="truncate text-muted-foreground">{slot.saleOrder.buyerName}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {t(slot.plannedKg)} · {slot.loadingPoint}
                          {slot.transport ? ` · ${slot.transport.name}` : ' · no transporter'}
                        </p>
                        {slot.lorryNumber && (
                          <p className="mt-1 font-mono text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                            {slot.lorryNumber}
                          </p>
                        )}
                        <div className="mt-1.5 flex items-center gap-0.5 opacity-70 transition group-hover:opacity-100">
                          {slot.status === 'CONFIRMED' ? (
                            <Button
                              variant="ghost" size="icon" className="h-6 w-6"
                              title="Clear the confirmation"
                              onClick={() => unconfirmSlot.mutate(slot.id)}
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          ) : (
                            <Button
                              variant="ghost" size="icon" className="h-6 w-6"
                              title="Enter the lorry number"
                              onClick={() => setConfirming(slot)}
                            >
                              <Check className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button
                            variant="ghost" size="icon" className="h-6 w-6"
                            title="Edit" onClick={() => openEdit(slot)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost" size="icon" className="h-6 w-6 text-destructive"
                            title="Remove this lorry from the plan"
                            onClick={() => removeSlot.mutate(slot.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {daySlots.length > 0 && (
                  <div className="mt-2 border-t pt-2">
                    <p className="text-[11px] text-muted-foreground">
                      {daySlots.length} {daySlots.length === 1 ? 'lorry' : 'lorries'} · {t(dayKg)}
                    </p>
                    {transportIds.map((id) => {
                      const name = transports.find((x) => x.id === id)?.name ?? 'Transporter';
                      return (
                        <Button
                          key={id}
                          variant="outline"
                          size="sm"
                          className="mt-1.5 h-7 w-full justify-start gap-1.5 text-[11px]"
                          onClick={() => setIndent({ date: key, transportId: id })}
                        >
                          <Send className="h-3 w-3" />
                          <span className="truncate">Indent · {name}</span>
                        </Button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      </>
      )}

      {plan && (
        <PlanDialog
          draft={plan}
          backlog={backlog}
          transports={transports}
          saving={planLorries.isPending}
          onChange={setPlan}
          onClose={() => setPlan(null)}
          onSave={(lorries) => planLorries.mutate({ ...plan, lorries })}
        />
      )}

      {editing && (
        <EditSlotDialog
          draft={editing}
          backlog={backlog}
          transports={transports}
          saving={saveSlot.isPending}
          onChange={setEditing}
          onClose={() => setEditing(null)}
          onSave={() => saveSlot.mutate(editing)}
        />
      )}

      {confirming && (
        <ConfirmDialog
          slot={confirming}
          saving={confirmSlot.isPending}
          onClose={() => setConfirming(null)}
          onSave={(v) => confirmSlot.mutate({ id: confirming.id, ...v })}
        />
      )}

      {indent && (
        <IndentDialog
          date={indent.date}
          transportId={indent.transportId}
          onClose={() => setIndent(null)}
          onSent={refresh}
        />
      )}
    </div>
  );
}

/** Create or edit one lorry. */
/**
 * Plan a day's fleet.
 *
 * The dialog asks the two things that actually vary - which sizes, and how
 * many of each - and works the rest out. There is no loading-point select, no
 * lorry-size box and no load box, because for a fleet all three are either the
 * same for every lorry or follow from the size: a 40 t lorry carries 40 t
 * unless it is the one finishing the order, and then it carries what is left.
 * The odd lorry that needs a figure of its own is corrected on its card.
 */
function PlanDialog(props: {
  draft: PlanDraft;
  backlog: DispatchBacklogOrder[];
  transports: Transport[];
  saving: boolean;
  onChange: (d: PlanDraft) => void;
  onClose: () => void;
  onSave: (lorries: { vehicleClassKg: number; plannedKg: number }[]) => void;
}) {
  const { draft, backlog, transports, saving, onChange } = props;
  const order = backlog.find((o) => o.id === draft.saleOrderId);
  const roomKg = order?.unplannedKg ?? 0;

  const lorries = lorriesFor(draft.counts, roomKg);
  const totalKg = lorries.reduce((sum, l) => sum + l.plannedKg, 0);
  // The lorry finishing the order, when it is not a full load.
  const partLoad = lorries.find((l) => l.plannedKg < l.vehicleClassKg);
  const full = totalKg >= roomKg || lorries.length >= MAX_LORRIES;

  const setCount = (cls: number, n: number) =>
    onChange({
      ...draft,
      counts: { ...draft.counts, [cls]: Math.max(0, Math.min(MAX_LORRIES, n)) },
    });

  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Plan lorries</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>Order</Label>
            <Select
              value={draft.saleOrderId}
              onValueChange={(v) => onChange({ ...draft, saleOrderId: v })}
            >
              <SelectTrigger><SelectValue placeholder="Choose the order" /></SelectTrigger>
              <SelectContent>
                {backlog.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.buyerName} · {o.destination || '-'} · {t(o.unplannedKg)} left
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="plan-date">Loading date</Label>
              <Input
                id="plan-date" type="date" value={draft.date}
                onChange={(e) => onChange({ ...draft, date: e.target.value })}
              />
            </div>
            <div>
              <Label>Transporter</Label>
              <Select
                value={draft.transportId || 'none'}
                onValueChange={(v) => onChange({ ...draft, transportId: v === 'none' ? '' : v })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not decided yet</SelectItem>
                  {transports.map((x) => <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label>How many of each</Label>
            <div className="mt-1 divide-y rounded-md border">
              {VEHICLE_CLASSES.map((cls) => {
                const n = draft.counts[cls] ?? 0;
                return (
                  <div key={cls} className="flex items-center gap-3 px-3 py-2">
                    <span className={cn('w-12 text-sm', n > 0 ? 'font-semibold' : 'text-muted-foreground')}>
                      {t(cls)}
                    </span>
                    <div className="ml-auto flex items-center gap-2">
                      <Button
                        type="button" variant="outline" size="icon" className="h-8 w-8"
                        disabled={n === 0} onClick={() => setCount(cls, n - 1)}
                        aria-label={'One ' + t(cls) + ' lorry fewer'}
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </Button>
                      <Input
                        type="number" min={0} max={MAX_LORRIES}
                        className="h-8 w-14 text-center" value={n}
                        aria-label={'How many ' + t(cls) + ' lorries'}
                        onChange={(e) => setCount(cls, Number(e.target.value) || 0)}
                      />
                      <Button
                        type="button" variant="outline" size="icon" className="h-8 w-8"
                        disabled={full} onClick={() => setCount(cls, n + 1)}
                        aria-label={'One ' + t(cls) + ' lorry more'}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <Label htmlFor="plan-notes">Note for the transporter (optional)</Label>
            <Input
              id="plan-notes" value={draft.notes} maxLength={500}
              onChange={(e) => onChange({ ...draft, notes: e.target.value })}
            />
          </div>

          <div className="space-y-1 rounded-md bg-muted/40 px-3 py-2">
            <p className="text-sm">
              {lorries.length === 0 ? (
                <span className="text-muted-foreground">No lorries yet</span>
              ) : (
                <>
                  <span className="font-semibold">
                    {lorries.length} {lorries.length === 1 ? 'lorry' : 'lorries'} · {t(totalKg)}
                  </span>
                  {order && <span className="text-muted-foreground"> of {t(roomKg)} free to plan</span>}
                </>
              )}
            </p>
            {partLoad && (
              <p className="text-xs text-muted-foreground">
                The last lorry takes {t(partLoad.plannedKg)} - what is left of the order.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Loading at <span className="font-medium text-foreground">{draft.loadingPoint}</span>
              {LOADING_POINTS.filter((pt) => pt !== draft.loadingPoint).map((pt) => (
                <button
                  key={pt} type="button"
                  className="ml-2 underline underline-offset-2 hover:text-foreground"
                  onClick={() => onChange({ ...draft, loadingPoint: pt })}
                >
                  load at {pt} instead
                </button>
              ))}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>Cancel</Button>
          <Button
            onClick={() => props.onSave(lorries)}
            disabled={saving || !draft.saleOrderId || lorries.length === 0}
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {lorries.length <= 1 ? 'Add lorry' : 'Add ' + lorries.length + ' lorries'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Correct one lorry.
 *
 * This is where the figures the plan dialog works out by itself can be
 * overruled - a part load, an odd vehicle size, a lorry loading at the other
 * point - so it keeps every field.
 */
function EditSlotDialog(props: {
  draft: EditDraft;
  backlog: DispatchBacklogOrder[];
  transports: Transport[];
  saving: boolean;
  onChange: (d: EditDraft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { draft, backlog, transports, saving, onChange } = props;
  const order = backlog.find((o) => o.id === draft.saleOrderId);
  const custom = !VEHICLE_CLASSES.includes(draft.vehicleClassKg);
  const overClass = draft.plannedKg > draft.vehicleClassKg;
  // An edit re-plans tonnage the slot itself already holds, so the rail's
  // unplanned figure understates what is available by exactly this slot.
  const roomKg = order ? order.unplannedKg + draft.plannedKg : Infinity;
  const overOrder = Number.isFinite(roomKg) && draft.plannedKg > roomKg;

  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit lorry</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>Order</Label>
            <Select value={draft.saleOrderId} onValueChange={(v) => onChange({ ...draft, saleOrderId: v })}>
              <SelectTrigger><SelectValue placeholder="Choose the order" /></SelectTrigger>
              <SelectContent>
                {backlog.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.buyerName} · {o.destination || '-'} · {t(o.unplannedKg)} left
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="slot-date">Loading date</Label>
              <Input
                id="slot-date" type="date" value={draft.date}
                onChange={(e) => onChange({ ...draft, date: e.target.value })}
              />
            </div>
            <div>
              <Label>Loading point</Label>
              <Select value={draft.loadingPoint} onValueChange={(v) => onChange({ ...draft, loadingPoint: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LOADING_POINTS.map((pt) => <SelectItem key={pt} value={pt}>{pt}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label>Lorry size</Label>
            <div className="mt-1 flex flex-wrap gap-2">
              {VEHICLE_CLASSES.map((c) => (
                <Button
                  key={c}
                  type="button"
                  variant={draft.vehicleClassKg === c ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => onChange({
                    ...draft,
                    vehicleClassKg: c,
                    plannedKg: Math.min(c, order ? order.unplannedKg + draft.plannedKg : c),
                  })}
                >
                  {t(c)}
                </Button>
              ))}
              <Button
                type="button"
                variant={custom ? 'default' : 'outline'}
                size="sm"
                onClick={() => onChange({ ...draft, vehicleClassKg: draft.plannedKg })}
              >
                Custom
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="slot-class">Lorry size (kg)</Label>
              <Input
                id="slot-class" type="number" value={draft.vehicleClassKg}
                onChange={(e) => onChange({ ...draft, vehicleClassKg: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label htmlFor="slot-kg">Load (kg)</Label>
              <Input
                id="slot-kg" type="number" value={draft.plannedKg}
                onChange={(e) => onChange({ ...draft, plannedKg: Number(e.target.value) })}
              />
            </div>
          </div>

          <div>
            <Label>Transporter</Label>
            <Select
              value={draft.transportId || 'none'}
              onValueChange={(v) => onChange({ ...draft, transportId: v === 'none' ? '' : v })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not decided yet</SelectItem>
                {transports.map((x) => <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="slot-notes">Note for the transporter (optional)</Label>
            <Input
              id="slot-notes" value={draft.notes} maxLength={500}
              onChange={(e) => onChange({ ...draft, notes: e.target.value })}
            />
          </div>

          {order && (
            <p className="text-xs text-muted-foreground">
              {order.buyerName}: {t(order.tonnageKg)} ordered · {t(order.dispatchedKg)} shipped · {t(roomKg)} free to plan
            </p>
          )}
          {overClass && (
            <p className="text-xs font-medium text-destructive">
              {t(draft.plannedKg)} will not fit a {t(draft.vehicleClassKg)} lorry.
            </p>
          )}
          {overOrder && !overClass && (
            <p className="text-xs font-medium text-destructive">
              Only {t(roomKg)} of this order is still unplanned.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>Cancel</Button>
          <Button
            onClick={props.onSave}
            disabled={saving || !draft.saleOrderId || draft.plannedKg <= 0 || overClass || overOrder}
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Record the lorry the transporter gave against a slot. */
function ConfirmDialog(props: {
  slot: DispatchSlot;
  saving: boolean;
  onClose: () => void;
  onSave: (v: { lorryNumber: string; driverName: string; driverPhone: string }) => void;
}) {
  const [lorryNumber, setLorryNumber] = useState(props.slot.lorryNumber ?? '');
  const [driverName, setDriverName] = useState(props.slot.driverName ?? '');
  const [driverPhone, setDriverPhone] = useState(props.slot.driverPhone ?? '');

  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Confirm {props.slot.code}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t(props.slot.vehicleClassKg)} to {props.slot.saleOrder.destination || '-'} for {props.slot.saleOrder.buyerName}
          {props.slot.transport ? ` · ${props.slot.transport.name}` : ''}
        </p>
        <div className="space-y-3">
          <div>
            <Label htmlFor="c-lorry">Lorry number</Label>
            <Input
              id="c-lorry" autoFocus value={lorryNumber} placeholder="AP39T8217"
              onChange={(e) => setLorryNumber(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="c-driver">Driver</Label>
              <Input id="c-driver" value={driverName} onChange={(e) => setDriverName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="c-phone">Driver phone</Label>
              <Input id="c-phone" value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>Cancel</Button>
          <Button
            disabled={props.saving || lorryNumber.trim().length < 4}
            onClick={() => props.onSave({ lorryNumber, driverName, driverPhone })}
          >
            {props.saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What `POST /dispatch-slots/indent` answers with, on either channel. */
interface IndentSendResult {
  ok: boolean;
  sent: boolean;
  requestedCount: number;
  message: string;
  sendError?: string | null;
  transport: DispatchIndentPreview['transport'];
}

/**
 * The day's requirement for one transporter: the message, and the two ways to
 * put it in front of him.
 *
 * Pressing send fires the approved `transport_sent` template from the server,
 * straight to the transporter's number. Nothing opens, nothing is handed to
 * the user's own WhatsApp - the message simply goes.
 *
 * Where the ERP cannot send it - no number on file for him, or Fast2SMS
 * refusing - the failure is SHOWN, with its reason, and no slot is marked as
 * asked for. Only a second, deliberate press takes the same text out of the
 * user's own WhatsApp instead. A silent reroute would leave the office
 * believing the ERP had sent something it never did.
 */
function IndentDialog(props: { date: string; transportId: string; onClose: () => void; onSent: () => void }) {
  const preview = useQuery({
    queryKey: ['dispatch-indent', props.date, props.transportId],
    queryFn: () =>
      api<DispatchIndentPreview>(`/dispatch-slots/indent?date=${props.date}&transportId=${props.transportId}`),
  });

  // A failed template send is shown, not silently rerouted: the office has to
  // know the transporter is holding nothing, and the manual escape hatch below
  // is a deliberate second press rather than something that happens behind it.
  const [sendError, setSendError] = useState<string | null>(null);

  const post = (channel: 'TEMPLATE' | 'MANUAL') =>
    api<IndentSendResult>('/dispatch-slots/indent', {
      method: 'POST',
      body: JSON.stringify({ date: props.date, transportId: props.transportId, channel }),
    });

  const askedFor = (r: IndentSendResult) =>
    r.requestedCount > 0
      ? `${r.requestedCount} ${r.requestedCount === 1 ? 'lorry' : 'lorries'} marked as asked for`
      : 'Requirement re-sent';

  const send = useMutation({
    mutationFn: () => post('TEMPLATE'),
    onSuccess: (r) => {
      if (!r.sent) {
        // Nothing left, nothing was marked - the dialog stays open on the reason.
        setSendError(r.sendError || 'WhatsApp refused the send');
        return;
      }
      toast.success(`Sent to ${r.transport.name} on WhatsApp · ${askedFor(r)}`);
      props.onSent();
      props.onClose();
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  /** The escape hatch: the same text, out of the user's own WhatsApp. */
  const sendManually = useMutation({
    mutationFn: () => post('MANUAL'),
    onSuccess: (r) => {
      const phone = (r.transport.phone || r.transport.phone2 || '').replace(/[^0-9]/g, '');
      const target = phone.length === 10 ? `91${phone}` : phone;
      window.open(
        target ? `https://wa.me/${target}?text=${encodeURIComponent(r.message)}`
               : `https://wa.me/?text=${encodeURIComponent(r.message)}`,
        '_blank'
      );
      toast.success(askedFor(r));
      props.onSent();
      props.onClose();
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const data = preview.data;

  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Vehicle requirement{data ? ` · ${data.transport.name}` : ''}
          </DialogTitle>
        </DialogHeader>

        {preview.isLoading && (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        )}
        {preview.isError && <p className="text-sm text-destructive">{getErrorMessage(preview.error)}</p>}

        {data && (
          <>
            {sendError && (
          <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <p className="font-medium">Not sent - nothing has been marked as asked for.</p>
            <p className="mt-0.5">{sendError}</p>
          </div>
        )}
        {data.revision && (
              <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                This day has already been sent. The message goes out marked REVISED.
              </p>
            )}
            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl border bg-muted/40 p-3 text-xs leading-relaxed">
              {data.message}
            </pre>
            <p className="text-xs text-muted-foreground">
              {data.slotCount} {data.slotCount === 1 ? 'lorry' : 'lorries'} · {t(data.totalKg)}
              {data.transport.phone ? ` · ${data.transport.phone}` : ' · no phone on file'}
            </p>
          </>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            disabled={!data}
            onClick={() => {
              void navigator.clipboard.writeText(data!.message);
              toast.success('Message copied');
            }}
          >
            <Copy className="mr-2 h-4 w-4" /> Copy
          </Button>
          {sendError && (
            <Button
              variant="outline"
              disabled={!data || sendManually.isPending}
              onClick={() => sendManually.mutate()}
            >
              {sendManually.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Send from my WhatsApp
            </Button>
          )}
          <Button disabled={!data || send.isPending} onClick={() => send.mutate()}>
            {send.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <WhatsAppIcon className="mr-2 h-4 w-4" />}
            {sendError ? 'Try again' : 'Send on WhatsApp'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
