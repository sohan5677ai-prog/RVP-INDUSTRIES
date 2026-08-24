import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Bell, Calendar, Tag, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import type { UserNote } from '@/lib/types';
import { shortDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import ReminderDialog from '@/components/ReminderDialog';
import { useReminderSlot } from '@/components/ReminderQueue';

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
      toast.success(updated.status === 'COMPLETED' ? 'Marked as completed' : 'Marked as pending');
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
      icon={Bell}
      tone="amber"
      title="Notes & Reminders"
      subtitle={
        pending.length === 1
          ? '1 reminder due today'
          : `${pending.length} reminders due or overdue`
      }
      count={pending.length}
      step={slot.step}
      total={slot.total}
    >
      <div className="flex items-center justify-between pb-1">
        <span className="text-xs text-muted-foreground">Actionable notes scheduled for today</span>
        <button
          type="button"
          onClick={goToNotes}
          className="text-xs text-primary hover:underline inline-flex items-center gap-1"
        >
          View all notes <ArrowRight className="h-3 w-3" />
        </button>
      </div>

      {pending.map((n) => {
        const d = n.reminderDate ? daysUntil(n.reminderDate) : 0;
        const whenText =
          d < 0 ? `${Math.abs(d)}d overdue` : d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : `In ${d}d`;

        return (
          <div
            key={n.id}
            className="rounded-xl border border-border bg-card p-3.5 space-y-2.5 shadow-xs transition-colors"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                {n.title ? (
                  <h4 className="font-semibold text-sm text-foreground truncate">{n.title}</h4>
                ) : (
                  <span className="font-semibold text-xs text-muted-foreground uppercase">{n.category}</span>
                )}
                <div className="flex items-center gap-1.5 flex-wrap mt-1">
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 uppercase">
                    {n.priority}
                  </Badge>
                  {n.reminderDate && (
                    <Badge
                      variant={d <= 0 ? 'destructive' : 'secondary'}
                      className="text-[10px] px-1.5 py-0 flex items-center gap-1"
                    >
                      <Calendar className="h-2.5 w-2.5" />
                      {shortDate(n.reminderDate)} ({whenText})
                    </Badge>
                  )}
                </div>
              </div>
            </div>

            <p className="text-xs text-foreground/90 whitespace-pre-wrap rounded-lg bg-muted/30 p-2.5 border border-border/40">
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
                  variant="outline"
                  onClick={() => markDone(n.id)}
                  disabled={toggleDoneMutation.isPending}
                  className="h-8 gap-1.5 text-xs text-success border-success/30 hover:bg-success/10"
                >
                  <Check className="h-3.5 w-3.5" /> Done
                </Button>
              </div>
            </div>
          </div>
        );
      })}
    </ReminderDialog>
  );
}
