import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Calendar, ArrowRight, Send, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import ReminderDialog from '@/components/ReminderDialog';
import { useReminderSlot } from '@/components/ReminderQueue';
import {
  getUpcomingReminders,
  FESTIVAL_TYPE_LABELS,
  type FestivalItem,
} from '@/lib/festivals';
import { WISH_CATEGORY_LABELS } from '@/lib/types';
import { shortDate } from '@/lib/format';

const DISMISS_KEY = 'festivalReminders:dismissed_dates';

function getTodayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw);
    const today = getTodayString();
    // Only keep dismissals recorded for today
    if (parsed.date === today && Array.isArray(parsed.ids)) {
      return new Set<string>(parsed.ids);
    }
    return new Set<string>();
  } catch {
    return new Set<string>();
  }
}

function saveDismissed(ids: Set<string>) {
  try {
    localStorage.setItem(
      DISMISS_KEY,
      JSON.stringify({
        date: getTodayString(),
        ids: Array.from(ids),
      })
    );
  } catch {
    // ignore
  }
}

export default function FestivalReminders() {
  const navigate = useNavigate();
  const [closed, setClosed] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());

  // Upcoming reminders for today and the next 3 days
  const upcoming = useMemo(() => getUpcomingReminders(new Date(), 3), []);

  // Filter out any dismissed for today
  const pending = useMemo(
    () => upcoming.filter((f) => !dismissed.has(f.id)),
    [upcoming, dismissed]
  );

  const slot = useReminderSlot('festivals', !closed && pending.length > 0);

  const closeDialog = () => {
    setClosed(true);
    slot.close();
  };

  const dismissOne = (id: string) => {
    const updated = new Set(dismissed).add(id);
    setDismissed(updated);
    saveDismissed(updated);
    if (pending.length <= 1) {
      closeDialog();
    }
  };

  const dismissAllForToday = () => {
    const updated = new Set([...dismissed, ...upcoming.map((f) => f.id)]);
    setDismissed(updated);
    saveDismissed(updated);
    closeDialog();
  };

  const handleSendWishes = (f: FestivalItem) => {
    // Pre-fill parameters and navigate to Wishes broadcast page
    const params = new URLSearchParams();
    params.set('occasion', f.name);
    if (f.category !== 'ALL') {
      params.set('category', f.category);
    }
    closeDialog();
    navigate(`/wishes?${params.toString()}`);
  };

  if (closed || !slot.open || pending.length === 0) return null;

  const hasToday = pending.some((f) => f.daysUntil === 0);

  return (
    <ReminderDialog
      open
      onClose={dismissAllForToday}
      icon={Sparkles}
      tone="amber"
      title={hasToday ? 'Festival Greeting Today!' : 'Upcoming Festivals & Holidays'}
      subtitle={
        pending.length === 1
          ? '1 festival / holiday in the next 3 days'
          : `${pending.length} festivals & holidays arriving soon`
      }
      count={pending.length}
      step={slot.step}
      total={slot.total}
    >
      <div className="flex items-center justify-between pb-1">
        <span className="text-xs text-muted-foreground">
          Send timely wishes to your buyers, suppliers, and drivers
        </span>
        <button
          type="button"
          onClick={() => {
            closeDialog();
            navigate('/wishes');
          }}
          className="text-xs text-primary hover:underline inline-flex items-center gap-1 font-medium"
        >
          Open Wishes <ArrowRight className="h-3 w-3" />
        </button>
      </div>

      {pending.map((f) => {
        const typeInfo = FESTIVAL_TYPE_LABELS[f.type];
        const isToday = f.daysUntil === 0;
        const isTomorrow = f.daysUntil === 1;

        return (
          <div
            key={f.id}
            className="rounded-xl border border-amber-500/20 bg-gradient-to-br from-amber-500/[0.04] to-card p-3.5 space-y-2.5 shadow-xs transition-colors"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h4 className="font-semibold text-sm text-foreground">{f.name}</h4>
                  <Badge
                    variant={isToday ? 'default' : isTomorrow ? 'secondary' : 'outline'}
                    className={
                      isToday
                        ? 'bg-amber-600 text-white hover:bg-amber-700 text-[10.5px] px-2 py-0 animate-pulse'
                        : 'text-[10.5px] px-1.5 py-0'
                    }
                  >
                    {f.statusLabel}
                  </Badge>
                </div>

                <div className="flex items-center gap-1.5 flex-wrap mt-1">
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                    <Calendar className="h-2.5 w-2.5 mr-1" />
                    {shortDate(f.date)}
                  </Badge>
                  <Badge variant={typeInfo.badgeVariant} className="text-[10px] px-1.5 py-0">
                    {typeInfo.label}
                  </Badge>
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">
                    Target: {f.category === 'ALL' ? 'Everyone' : WISH_CATEGORY_LABELS[f.category]}
                  </Badge>
                </div>
              </div>
            </div>

            <p className="text-xs text-foreground/85 rounded-lg bg-amber-500/[0.06] p-2.5 border border-amber-500/15 leading-relaxed">
              {f.description}
            </p>

            <div className="flex items-center justify-between gap-2 pt-0.5">
              <span className="text-[11px] text-muted-foreground truncate max-w-[180px]">
                {f.category === 'ALL' ? 'Broadcast to all parties' : `Filtered for ${WISH_CATEGORY_LABELS[f.category]} parties`}
              </span>

              <div className="flex items-center gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => dismissOne(f.id)}
                  className="h-8 text-xs text-muted-foreground hover:text-foreground"
                >
                  <Check className="h-3.5 w-3.5 mr-1" /> Skip
                </Button>
                <Button
                  size="sm"
                  onClick={() => handleSendWishes(f)}
                  className="h-8 gap-1.5 text-xs bg-amber-600 hover:bg-amber-700 text-white shadow-xs"
                >
                  <Send className="h-3 w-3" /> Send Wishes
                </Button>
              </div>
            </div>
          </div>
        );
      })}
    </ReminderDialog>
  );
}
