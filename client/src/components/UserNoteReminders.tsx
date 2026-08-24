import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, BellRing, Calendar, ExternalLink, Tag } from 'lucide-react';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import type { UserNote } from '@/lib/types';
import { shortDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import ReminderDialog from '@/components/ReminderDialog';
import { useReminderSlot } from '@/components/ReminderQueue';
import { cn } from '@/lib/utils';

const PRIORITY_STYLES: Record<string, { label: string; badge: string }> = {
  LOW: { label: 'Low', badge: 'border-slate-500/20 bg-slate-500/10 text-slate-600 dark:text-slate-400' },
  MEDIUM: { label: 'Medium', badge: 'border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-400' },
  HIGH: { label: 'High', badge: 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  URGENT: { label: 'Urgent', badge: 'border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400' },
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

export default function UserNoteReminders() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [closed, setClosed] = useState(false);
  const [handled, setHandled] = useState<Set<string>>(new Set());

  const { data: dueNotes } = useQuery({
    queryKey: ['due-user-notes'],
    queryFn: () => api<UserNote[]>('/user-notes/reminders/due'),
    enabled: !closed,
    refetchInterval: 60_000,
  });

  const pending = (dueNotes ?? []).filter((n) => !handled.has(n.id));
  const slot = useReminderSlot('user-notes', pending.length > 0);

  const toggleDoneMutation = useMutation({
    mutationFn: (id: string) => api<UserNote>(`/user-notes/${id}/toggle-status`, { method: 'PATCH' }),
    onSuccess: (updated) => {
      toast.success(updated.status === 'COMPLETED' ? 'Marked as done' : 'Marked as pending');
      qc.invalidateQueries({ queryKey: ['due-user-notes'] });
      qc.invalidateQueries({ queryKey: ['user-notes'] });
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const close = () => {
    setClosed(true);
    slot.close();
  };

  const handleCard = (id: string) => {
    setHandled((prev) => new Set(prev).add(id));
    if (pending.length <= 1) close();
  };

  const markDone = (id: string) => {
    toggleDoneMutation.mutate(id);
    handleCard(id);
  };

  const goToNotes = () => {
    close();
    navigate('/notes-comments');
  };

  if (closed || !slot.open || pending.length === 0) return null;

  return (
    <ReminderDialog
      open
      onClose={close}
      icon={BellRing}
      tone="amber"
      title="Notes & Reminders"
      subtitle={
        pending.length === 1
          ? 'You have 1 reminder due'
          : `You have ${pending.length} reminders due or overdue`
      }
      count={pending.length}
      step={slot.step}
      total={slot.total}
    >
      <div className="flex items-center justify-between pb-1">
        <span className="text-[11px] text-muted-foreground">Actionable notes tagged for today or overdue</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={goToNotes}
          className="h-7 px-2 text-xs text-amber-600 dark:text-amber-400 hover:text-amber-700 gap-1"
        >
          View all notes <ExternalLink className="h-3 w-3" />
        </Button>
      </div>

      {pending.map((n) => {
        const priorityMeta = PRIORITY_STYLES[n.priority] ?? PRIORITY_STYLES.MEDIUM;
        const d = n.reminderDate ? daysUntil(n.reminderDate) : 0;
        const whenText =
          d < 0 ? `${Math.abs(d)}d overdue` : d === 0 ? 'Due Today' : d === 1 ? 'Due Tomorrow' : `In ${d} days`;

        return (
          <div
            key={n.id}
            className="rounded-xl border border-border/80 bg-card p-3.5 space-y-2.5 shadow-sm transition-all"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                {n.title && <h4 className="font-semibold text-sm text-foreground truncate">{n.title}</h4>}
                <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                  <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0', priorityMeta.badge)}>
                    {priorityMeta.label}
                  </Badge>
                  {n.category && (
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 uppercase">
                      {n.category}
                    </Badge>
                  )}
                  {n.reminderDate && (
                    <Badge
                      variant={d < 0 ? 'destructive' : 'secondary'}
                      className="text-[10px] px-1.5 py-0 flex items-center gap-1"
                    >
                      <Calendar className="h-2.5 w-2.5" />
                      {shortDate(n.reminderDate)} ({whenText})
                    </Badge>
                  )}
                </div>
              </div>
            </div>

            <p className="text-xs text-foreground/90 whitespace-pre-wrap rounded-lg bg-muted/40 p-2.5 border border-border/40 font-mono sm:font-sans">
              {n.content}
            </p>

            <div className="flex items-center justify-between gap-2 pt-0.5">
              <div className="text-[11px] text-muted-foreground flex items-center gap-1.5 truncate">
                <span>By {n.userName}</span>
                {n.pageLabel && (
                  <>
                    <span>·</span>
                    <span className="flex items-center gap-0.5 truncate text-foreground/70" title={n.pagePath ?? ''}>
                      <Tag className="h-2.5 w-2.5" /> {n.pageLabel}
                    </span>
                  </>
                )}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => markDone(n.id)}
                  disabled={toggleDoneMutation.isPending}
                  className="h-8 gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" /> Mark Done
                </Button>
              </div>
            </div>
          </div>
        );
      })}
    </ReminderDialog>
  );
}
