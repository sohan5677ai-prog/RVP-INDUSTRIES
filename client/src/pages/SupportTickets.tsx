import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { usePagedRows } from '@/lib/usePagedRows';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Segmented } from '@/components/ui/segmented';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, LifeBuoy, CheckCircle2, Undo2, ImageOff, MessageSquareReply } from 'lucide-react';

type TicketFilter = 'OPEN' | 'RESOLVED' | 'ALL';

interface SupportTicket {
  id: string;
  userId: string | null;
  userName: string;
  userRole: string;
  pagePath: string;
  pageLabel: string;
  note: string;
  screenshotUrl: string | null;
  browserInfo: string | null;
  consoleErrors: string | null;
  status: 'OPEN' | 'RESOLVED';
  notifiedStatus: string | null;
  notifiedError: string | null;
  createdAt: string;
  resolvedAt: string | null;
  developerMessage: string | null;
  resolvedByName: string | null;
  /** Whether the person looking at this page has ticked the reply off. */
  acknowledged: boolean;
  acknowledgedAt: string | null;
}

function when(iso: string) {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * The support inbox: every issue reported through the topbar's "Contact
 * support" button, with the screen the reporter was looking at.
 *
 * The WhatsApp alert is the thing that actually reaches someone; this page is
 * the durable record behind it, so a report is still actionable days later and
 * a message that never went out is visible as such (the "not sent" badge).
 */
export default function SupportTickets() {
  const qc = useQueryClient();
  const { user } = useAuth();
  // Only the developer closes tickets, because closing one means writing the
  // answer the whole company is shown. Everyone else reads and acknowledges.
  const isDeveloper = user?.role === 'DEVELOPER';
  const [filter, setFilter] = useState<TicketFilter>('OPEN');
  const [viewing, setViewing] = useState<SupportTicket | null>(null);
  // The ticket being resolved, and the message going out with it.
  const [resolving, setResolving] = useState<SupportTicket | null>(null);
  const [reply, setReply] = useState('');

  const { data: rows, isLoading } = useQuery({
    queryKey: ['support-tickets', filter],
    queryFn: () =>
      api<SupportTicket[]>(`/support/tickets${filter === 'ALL' ? '' : `?status=${filter}`}`),
    // Tickets arrive from other people's browsers, so the list has to come to us.
    refetchInterval: 60_000,
  });

  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: 'OPEN' | 'RESOLVED'; developerMessage?: string }) =>
      api(`/support/tickets/${v.id}`, {
        method: 'PATCH',
        body: { status: v.status, developerMessage: v.developerMessage },
      }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['support-tickets'] });
      qc.invalidateQueries({ queryKey: ['support-announcements'] });
      setResolving(null);
      // The detail dialog may be open behind this one, holding its own copy of
      // the row; patch it in place rather than closing it - two Radix dialogs
      // dismissed in the same tick leave the page unclickable.
      setViewing((prev) =>
        prev && prev.id === v.id
          ? {
              ...prev,
              status: v.status,
              developerMessage: v.developerMessage ?? null,
              resolvedByName: v.status === 'RESOLVED' ? user?.name ?? null : null,
              resolvedAt: v.status === 'RESOLVED' ? new Date().toISOString() : null,
              acknowledged: false,
            }
          : prev,
      );
      toast.success(
        v.status === 'RESOLVED'
          ? 'Resolved. Everyone will see your message on their next sign-in.'
          : 'Reopened - the message and everyone’s acknowledgements were cleared.',
      );
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const acknowledge = useMutation({
    mutationFn: (id: string) => api(`/support/tickets/${id}/ack`, { method: 'POST' }),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ['support-tickets'] });
      qc.invalidateQueries({ queryKey: ['support-announcements'] });
      // The open dialog holds its own copy of the row, so it has to be told.
      setViewing((prev) => (prev && prev.id === id ? { ...prev, acknowledged: true } : prev));
      toast.success('Marked as checked');
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  function startResolve(t: SupportTicket) {
    setReply('');
    setResolving(t);
  }

  function submitResolve() {
    const message = reply.trim();
    if (!message) {
      toast.error('Write a message for the team before resolving');
      return;
    }
    if (resolving) setStatus.mutate({ id: resolving.id, status: 'RESOLVED', developerMessage: message });
  }

  /** What this viewer can do with a row: resolve/reopen for the developer,
   *  acknowledge for everyone else once there is a reply to acknowledge. */
  const canAcknowledge = (t: SupportTicket) =>
    !isDeveloper && t.status === 'RESOLVED' && !!t.developerMessage && !t.acknowledged;

  const paged = usePagedRows(rows ?? []);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Support tickets</h1>
          <p className="text-sm text-muted-foreground">
            Issues reported from inside the ERP, with the screen the reporter was on.
          </p>
        </div>
        <Segmented
          value={filter}
          onValueChange={(v) => setFilter(v)}
          options={[
            { value: 'OPEN', label: 'Open' },
            { value: 'RESOLVED', label: 'Resolved' },
            { value: 'ALL', label: 'All' },
          ]}
        />
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (paged.pageRows ?? []).length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-sm text-muted-foreground">
              <LifeBuoy className="h-6 w-6 opacity-50" />
              {filter === 'OPEN' ? 'No open tickets. All quiet.' : 'Nothing here.'}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Reported by</TableHead>
                  <TableHead>Page</TableHead>
                  <TableHead>Issue</TableHead>
                  <TableHead>Alert</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(paged.pageRows ?? []).map((t) => (
                  <TableRow
                    key={t.id}
                    className="cursor-pointer"
                    onClick={() => setViewing(t)}
                  >
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {when(t.createdAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {t.userName}
                      <span className="ml-1 text-xs text-muted-foreground">{t.userRole}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">{t.pageLabel}</TableCell>
                    <TableCell className="max-w-md truncate text-sm">{t.note}</TableCell>
                    <TableCell>
                      {t.notifiedStatus === 'SENT' ? (
                        <Badge variant="outline" className="text-emerald-600">sent</Badge>
                      ) : (
                        <Badge variant="outline" className="text-amber-600" title={t.notifiedError ?? undefined}>
                          not sent
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      {isDeveloper ? (
                        t.status === 'OPEN' ? (
                          <Button size="sm" variant="outline" onClick={() => startResolve(t)}>
                            <CheckCircle2 className="h-3.5 w-3.5" /> Resolve
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setStatus.mutate({ id: t.id, status: 'OPEN' })}
                            disabled={setStatus.isPending}
                          >
                            <Undo2 className="h-3.5 w-3.5" /> Reopen
                          </Button>
                        )
                      ) : canAcknowledge(t) ? (
                        <Button
                          size="sm"
                          onClick={() => acknowledge.mutate(t.id)}
                          disabled={acknowledge.isPending}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" /> Checked
                        </Button>
                      ) : t.acknowledged ? (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Checked
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Awaiting the developer</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <PaginationBar {...paged} />

      <Dialog open={!!viewing} onOpenChange={(v) => !v && setViewing(null)}>
        <DialogContent className="sm:max-w-3xl">
          {viewing && (
            <>
              <DialogHeader>
                <DialogTitle>{viewing.pageLabel}</DialogTitle>
                <DialogDescription>
                  {viewing.userName} ({viewing.userRole}) · {when(viewing.createdAt)} · {viewing.pagePath}
                </DialogDescription>
              </DialogHeader>

              <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm whitespace-pre-wrap">
                {viewing.note}
              </p>

              {viewing.developerMessage && (
                <div className="space-y-1.5 rounded-lg border border-sky-500/25 bg-sky-500/[0.07] p-3">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-sky-700 dark:text-sky-400">
                    <MessageSquareReply className="h-3.5 w-3.5" />
                    {viewing.resolvedByName ? `${viewing.resolvedByName} replied` : 'Developer replied'}
                    {viewing.resolvedAt && <span className="font-normal text-muted-foreground">· {when(viewing.resolvedAt)}</span>}
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{viewing.developerMessage}</p>
                  {canAcknowledge(viewing) ? (
                    <Button
                      size="sm"
                      className="mt-1"
                      onClick={() => acknowledge.mutate(viewing.id)}
                      disabled={acknowledge.isPending}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" /> Yes, checked
                    </Button>
                  ) : viewing.acknowledged ? (
                    <p className="inline-flex items-center gap-1 pt-0.5 text-xs text-emerald-600">
                      <CheckCircle2 className="h-3.5 w-3.5" /> You have marked this as checked
                    </p>
                  ) : null}
                </div>
              )}

              {viewing.screenshotUrl ? (
                <a href={viewing.screenshotUrl} target="_blank" rel="noreferrer">
                  <img
                    src={viewing.screenshotUrl}
                    alt="Reported screen"
                    className="w-full rounded-lg border border-border"
                  />
                </a>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                  <ImageOff className="h-4 w-4" /> No screenshot was captured for this report.
                </div>
              )}

              {viewing.consoleErrors && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">Errors on the page</div>
                  <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-[11px] leading-relaxed">
                    {viewing.consoleErrors}
                  </pre>
                </div>
              )}

              {viewing.browserInfo && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">Browser</div>
                  <pre className="overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-[11px] leading-relaxed">
                    {viewing.browserInfo}
                  </pre>
                </div>
              )}

              {isDeveloper && (
                <DialogFooter>
                  {viewing.status === 'OPEN' ? (
                    <Button onClick={() => startResolve(viewing)}>
                      <CheckCircle2 className="h-4 w-4" /> Resolve…
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      onClick={() => setStatus.mutate({ id: viewing.id, status: 'OPEN' })}
                      disabled={setStatus.isPending}
                    >
                      <Undo2 className="h-4 w-4" /> Reopen
                    </Button>
                  )}
                </DialogFooter>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Resolving is answering: the message written here is what every user and
          admin is shown on their next sign-in, so there is no way to close a
          ticket without saying what was done about it. */}
      <Dialog open={!!resolving} onOpenChange={(v) => { if (!v && !setStatus.isPending) setResolving(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Resolve this ticket</DialogTitle>
            <DialogDescription>
              {resolving && <>Reported by {resolving.userName} on {resolving.pageLabel}. </>}
              Your message goes to everyone as a popup on their next sign-in.
            </DialogDescription>
          </DialogHeader>

          {resolving && (
            <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm whitespace-pre-wrap">
              {resolving.note}
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="developer-message">Message to the team</Label>
            <textarea
              id="developer-message"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={4}
              maxLength={2000}
              autoFocus
              placeholder="e.g. Fixed — the total now counts lorries that arrived today. Please reload the page once."
              className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setResolving(null)} disabled={setStatus.isPending}>
              Cancel
            </Button>
            <Button onClick={submitResolve} disabled={setStatus.isPending || !reply.trim()}>
              {setStatus.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              <CheckCircle2 className="h-4 w-4" /> Resolved
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
