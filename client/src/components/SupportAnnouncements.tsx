import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, Clock, LifeBuoy } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import ReminderDialog from '@/components/ReminderDialog';
import { useReminderSlot } from '@/components/ReminderQueue';

export interface SupportAnnouncement {
  id: string;
  userName: string;
  pageLabel: string;
  note: string;
  developerMessage: string;
  resolvedByName: string | null;
  resolvedAt: string | null;
}

/**
 * The developer's answer, delivered to the people who have to live with it.
 *
 * When a ticket is resolved the developer writes a line explaining what was
 * done; this popup carries that line to every user and admin on their next
 * login, naming the colleague who reported it so the reply has context.
 *
 * Two ways out, and the difference matters:
 *   "Yes, checked" writes an acknowledgement server-side - that person never
 *      sees this reply again, on any device.
 *   "Let me check" writes nothing. It clears the card for this page-load only,
 *      so the reply is waiting again after a refresh or the next sign-in.
 *
 * The same "Checked" button lives on the Support tickets page, for anyone who
 * closed the popup meaning to look properly first.
 */
export default function SupportAnnouncements() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [closed, setClosed] = useState(false);
  // Cards taken off this popup by either button. Deliberately component state
  // and nothing more: "Let me check" must not survive a refresh.
  const [handled, setHandled] = useState<Set<string>>(new Set());

  // The developer wrote these replies; the server returns them nothing.
  const isDeveloper = user?.role === 'DEVELOPER';

  const { data } = useQuery({
    queryKey: ['support-announcements'],
    queryFn: () => api<SupportAnnouncement[]>('/support/announcements'),
    enabled: !!user && !isDeveloper && !closed,
  });

  const pending = (data ?? []).filter((t) => !handled.has(t.id));
  const slot = useReminderSlot('support-reply', pending.length > 0);

  const ack = useMutation({
    mutationFn: (id: string) => api(`/support/tickets/${id}/ack`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['support-announcements'] });
      qc.invalidateQueries({ queryKey: ['support-tickets'] });
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const close = () => {
    setClosed(true);
    slot.close();
  };

  /** Take a card off the screen; if it was the last one, close the popup so the
   *  queue hands over cleanly instead of the dialog blinking out from under it. */
  const handle = (id: string) => {
    setHandled((prev) => new Set(prev).add(id));
    if (pending.length <= 1) close();
  };

  const checked = (id: string) => {
    ack.mutate(id);
    handle(id);
  };

  if (isDeveloper || closed || !slot.open || pending.length === 0) return null;

  return (
    <ReminderDialog
      open
      onClose={close}
      icon={LifeBuoy}
      tone="blue"
      title="Message from the developer"
      subtitle={pending.length === 1 ? 'About an issue reported from the ERP' : 'About issues reported from the ERP'}
      count={pending.length}
      step={slot.step}
      total={slot.total}
    >
      {pending.map((t) => (
        <div key={t.id} className="rounded-lg border bg-card p-3 space-y-2.5">
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              Reported by {t.userName}
              <span className="ml-1.5 font-normal text-xs text-muted-foreground">· {t.pageLabel}</span>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{t.note}</p>
          </div>

          <p className="rounded-lg border border-sky-500/25 bg-sky-500/[0.07] p-2.5 text-sm whitespace-pre-wrap">
            {t.developerMessage}
          </p>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground truncate">
              {t.resolvedByName ? `Resolved by ${t.resolvedByName}` : 'Resolved'}
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              <Button size="sm" onClick={() => checked(t.id)} disabled={ack.isPending}>
                <CheckCircle2 className="h-4 w-4" /> Yes, checked
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handle(t.id)}
                title="Show this again next time I sign in"
              >
                <Clock className="h-4 w-4" /> Let me check
              </Button>
            </div>
          </div>
        </div>
      ))}
    </ReminderDialog>
  );
}
