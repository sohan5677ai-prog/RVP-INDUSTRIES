import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Sparkles,
  Send,
  CalendarDays,
  PartyPopper,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  getUpcomingFestivalsList,
  FESTIVAL_TYPE_LABELS,
  type FestivalCategory,
  type FestivalItem,
} from '@/lib/festivals';
import { WISH_CATEGORY_LABELS } from '@/lib/types';
import { cn } from '@/lib/utils';

const CATEGORY_TABS: { label: string; value: FestivalCategory }[] = [
  { label: 'All Occasions', value: 'ALL' },
  { label: 'Hindu', value: 'HINDU' },
  { label: 'Muslim', value: 'MUSLIM' },
  { label: 'Christian', value: 'CHRISTIAN' },
  { label: 'Other', value: 'OTHER' },
];

export default function FestivalCalendarWidget({ className }: { className?: string }) {
  const navigate = useNavigate();
  const [activeCategory, setActiveCategory] = useState<FestivalCategory>('ALL');
  const [daysSpan, setDaysSpan] = useState<number>(60);
  const [showAll, setShowAll] = useState(false);

  const festivals = useMemo(
    () => getUpcomingFestivalsList(new Date(), daysSpan, activeCategory),
    [daysSpan, activeCategory]
  );

  const displayedList = showAll ? festivals : festivals.slice(0, 4);
  const hasToday = festivals.some((f) => f.daysUntil === 0);

  const handleSendWishes = (f: FestivalItem) => {
    const params = new URLSearchParams();
    params.set('occasion', f.name);
    if (f.category !== 'ALL') {
      params.set('category', f.category);
    }
    navigate(`/wishes?${params.toString()}`);
  };

  return (
    <Card className={cn('relative overflow-hidden border-border/80 shadow-xs', className)}>
      {/* Subtle festive background glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 h-44 w-44 rounded-full bg-amber-500/[0.07] blur-2xl"
      />

      <CardHeader className="pb-3 border-b border-border/50">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/20 shrink-0">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <span>Festival & Holiday Calendar</span>
                {hasToday && (
                  <Badge className="bg-amber-600 text-white hover:bg-amber-700 text-[10px] px-2 py-0 animate-pulse">
                    Today 🎉
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="text-xs text-muted-foreground">
                Upcoming major festivals & national holidays in India
              </CardDescription>
            </div>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <div className="inline-flex rounded-lg border border-border p-0.5 bg-muted/40 text-xs">
              <button
                type="button"
                onClick={() => setDaysSpan(30)}
                className={cn(
                  'px-2.5 py-1 rounded-md transition-all text-xs font-medium',
                  daysSpan === 30 ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                30 Days
              </button>
              <button
                type="button"
                onClick={() => setDaysSpan(90)}
                className={cn(
                  'px-2.5 py-1 rounded-md transition-all text-xs font-medium',
                  daysSpan === 90 ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                90 Days
              </button>
              <button
                type="button"
                onClick={() => setDaysSpan(365)}
                className={cn(
                  'px-2.5 py-1 rounded-md transition-all text-xs font-medium',
                  daysSpan === 365 ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                Full Year
              </button>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate('/wishes')}
              className="h-7 text-xs gap-1 hover:bg-amber-500/10 hover:border-amber-500/30"
            >
              <Send className="h-3 w-3 text-amber-600 dark:text-amber-400" />
              <span>Broadcast Wishes</span>
            </Button>
          </div>
        </div>

        {/* Category filtering tabs */}
        <div className="flex items-center gap-1.5 pt-2.5 overflow-x-auto no-scrollbar">
          {CATEGORY_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setActiveCategory(tab.value)}
              className={cn(
                'px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors',
                activeCategory === tab.value
                  ? 'bg-amber-600 text-white shadow-xs'
                  : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </CardHeader>

      <CardContent className="p-4 space-y-2.5">
        {festivals.length === 0 ? (
          <div className="text-center py-8 px-4 rounded-xl border border-dashed border-border text-muted-foreground">
            <CalendarDays className="h-8 w-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm font-medium">No upcoming festivals found for this filter in the next {daysSpan} days.</p>
            <p className="text-xs mt-1">Try switching to &apos;All Occasions&apos; or expanding to &apos;Full Year&apos;.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {displayedList.map((f) => {
              const typeInfo = FESTIVAL_TYPE_LABELS[f.type];
              const isToday = f.daysUntil === 0;
              const isTomorrow = f.daysUntil === 1;
              const festDate = new Date(f.date);
              const monthName = festDate.toLocaleString('en-US', { month: 'short' });
              const dayNum = festDate.getDate();

              return (
                <div
                  key={f.id}
                  className={cn(
                    'group flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-xl border transition-all',
                    isToday
                      ? 'border-amber-500/40 bg-gradient-to-r from-amber-500/[0.08] via-amber-500/[0.04] to-card ring-1 ring-amber-500/20'
                      : isTomorrow
                      ? 'border-amber-500/25 bg-amber-500/[0.02] hover:bg-muted/40'
                      : 'border-border/60 bg-card hover:bg-muted/30'
                  )}
                >
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    {/* Date Block */}
                    <div
                      className={cn(
                        'flex flex-col items-center justify-center h-12 w-12 rounded-xl shrink-0 font-medium leading-none border',
                        isToday
                          ? 'bg-amber-600 text-white border-amber-600 shadow-xs'
                          : 'bg-muted/70 text-foreground border-border/80'
                      )}
                    >
                      <span className="text-[10px] uppercase tracking-wider font-semibold opacity-85">
                        {monthName}
                      </span>
                      <span className="text-base font-bold mt-0.5">{dayNum}</span>
                    </div>

                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-foreground group-hover:text-primary transition-colors">
                          {f.name}
                        </span>

                        <Badge
                          variant={isToday ? 'default' : isTomorrow ? 'secondary' : 'outline'}
                          className={cn(
                            'text-[10.5px] px-1.5 py-0',
                            isToday && 'bg-amber-600 text-white hover:bg-amber-700'
                          )}
                        >
                          {f.statusLabel}
                        </Badge>

                        <Badge variant={typeInfo.badgeVariant} className="text-[10px] px-1.5 py-0">
                          {typeInfo.label}
                        </Badge>
                      </div>

                      <p className="text-xs text-muted-foreground line-clamp-1">{f.description}</p>

                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground pt-0.5">
                        <span className="inline-flex items-center gap-1">
                          <PartyPopper className="h-3 w-3 opacity-60" />
                          Audience: <strong className="text-foreground/80 font-medium">{f.category === 'ALL' ? 'Everyone' : WISH_CATEGORY_LABELS[f.category]}</strong>
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                    <Button
                      size="sm"
                      onClick={() => handleSendWishes(f)}
                      className={cn(
                        'h-8 text-xs gap-1.5 transition-all shadow-xs',
                        isToday
                          ? 'bg-amber-600 hover:bg-amber-700 text-white'
                          : 'bg-primary hover:bg-primary/90 text-primary-foreground'
                      )}
                    >
                      <Send className="h-3 w-3" />
                      <span>Send Wishes</span>
                    </Button>
                  </div>
                </div>
              );
            })}

            {festivals.length > 4 && (
              <div className="pt-1 text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAll(!showAll)}
                  className="text-xs text-muted-foreground hover:text-foreground h-8"
                >
                  {showAll
                    ? 'Show fewer festivals'
                    : `Show all ${festivals.length} upcoming festivals`}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
