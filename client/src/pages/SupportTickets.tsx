import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import { usePagedRows } from '@/lib/usePagedRows';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2, LifeBuoy, CheckCircle2, Undo2, ImageOff } from 'lucide-react';

type TicketFilter = 'OPEN' | 'RESOLVED' | 'ALL';

interface SupportTicket {
  id: string;
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
  const [filter, setFilter] = useState<TicketFilter>('OPEN');
  const [viewing, setViewing] = useState<SupportTicket | null>(null);

  const { data: rows, isLoading } = useQuery({
    queryKey: ['support-tickets', filter],
    queryFn: () =>
      api<SupportTicket[]>(`/support/tickets${filter === 'ALL' ? '' : `?status=${filter}`}`),
    // Tickets arrive from other people's browsers, so the list has to come to us.
    refetchInterval: 60_000,
  });

  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: 'OPEN' | 'RESOLVED' }) =>
      api(`/support/tickets/${v.id}`, { method: 'PATCH', body: { status: v.status } }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['support-tickets'] });
      toast.success(v.status === 'RESOLVED' ? 'Marked resolved' : 'Reopened');
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

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
                      {t.status === 'OPEN' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setStatus.mutate({ id: t.id, status: 'RESOLVED' })}
                          disabled={setStatus.isPending}
                        >
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
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
