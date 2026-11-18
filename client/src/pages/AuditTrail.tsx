import { useState } from 'react';
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getErrorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/PageHeader';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  History,
  Loader2,
  Lock,
  ShieldCheck,
  Unlock,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

/**
 * The audit trail (Phase 4, plan item 4.7).
 *
 * Its own page rather than a Settings tab: this is where someone goes to
 * answer "who changed this, and when", which is a task, not a setting.
 *
 * Nothing here is a permission boundary. The server decides - /audit-log needs
 * audit.view, and writing a period lock needs system.manage - and this page
 * only avoids offering a control that is certain to come back 403.
 */

interface AuditRow {
  id: string;
  seq: string;
  action: string;
  entity: string | null;
  entityId: string | null;
  entityLabel: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  userName: string | null;
  userRole: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  method: string | null;
  path: string | null;
  createdAt: string;
}

interface AuditPage {
  rows: AuditRow[];
  nextCursor: string | null;
}

interface ChainReport {
  ok: boolean;
  checked: number;
  failures: string[];
}

interface PeriodLockRow {
  id: string;
  fromDate: string;
  toDate: string;
  reason: string | null;
  lockedByName: string | null;
  lockedAt: string;
  unlockedAt: string | null;
  unlockedByName: string | null;
  unlockReason: string | null;
}

/** The column is UTC; people here read IST. */
const istDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
const istDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

/** Only the fields that differ, so a row reads as a change and not a dump. */
function changedFields(row: AuditRow): { field: string; before: unknown; after: unknown }[] {
  const before = (row.oldValues ?? {}) as Record<string, unknown>;
  const after = (row.newValues ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys
    .map((field) => ({ field, before: before[field], after: after[field] }))
    .filter((c) => JSON.stringify(c.before ?? null) !== JSON.stringify(c.after ?? null));
}

function show(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const EMPTY_FILTERS = { action: '', entity: '', entityId: '', requestId: '', from: '', to: '' };
type Filters = typeof EMPTY_FILTERS;

export default function AuditTrail() {
  const qc = useQueryClient();
  const { user } = useAuth();
  // Writing a period lock needs system.manage, which OWNER does not hold by
  // default. Offering the form to someone guaranteed a 403 is just a worse way
  // of saying no.
  const canLock = user?.role === 'ADMIN' || user?.role === 'DEVELOPER';

  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newLock, setNewLock] = useState({ fromDate: '', toDate: '', reason: '' });

  const queryString = new URLSearchParams(
    Object.entries(filters).filter((e): e is [string, string] => Boolean(e[1]))
  ).toString();

  /**
   * Cursor-paged, not offset-paged: the table only ever grows, so an offset
   * page would shift under the reader as new rows arrive while they read.
   */
  const log = useInfiniteQuery<AuditPage, Error, { pages: AuditPage[] }, string[], string | null>({
    queryKey: ['audit-log', queryString],
    initialPageParam: null,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams(queryString);
      if (pageParam) qs.set('cursor', pageParam);
      const s = qs.toString();
      return api<AuditPage>(`/audit-log${s ? `?${s}` : ''}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });

  const rows = log.data?.pages.flatMap((p) => p.rows) ?? [];

  const locks = useQuery<PeriodLockRow[]>({
    queryKey: ['period-locks'],
    queryFn: () => api<PeriodLockRow[]>('/period-locks'),
  });

  const verify = useMutation({
    mutationFn: () => api<ChainReport>('/audit-log/verify', { method: 'POST' }),
    onSuccess: (r) => {
      if (r.ok) toast.success(`Chain intact — ${r.checked} entries verified.`);
      else toast.error(`Chain broken — ${r.failures.length} problem(s). Treat this as serious.`);
      // Verifying writes an audit row of its own, so the list is now stale.
      void log.refetch();
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const createLock = useMutation({
    mutationFn: () => api('/period-locks', { method: 'POST', body: newLock }),
    onSuccess: () => {
      toast.success('Period closed. Nothing can be posted into it now.');
      setNewLock({ fromDate: '', toDate: '', reason: '' });
      qc.invalidateQueries({ queryKey: ['period-locks'] });
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const release = useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      api(`/period-locks/${v.id}/release`, { method: 'POST', body: { reason: v.reason } }),
    onSuccess: () => {
      toast.success('Period reopened — recorded against your name.');
      qc.invalidateQueries({ queryKey: ['period-locks'] });
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const apply = (next: Filters) => {
    setDraft(next);
    setFilters(next);
  };

  const closed = (locks.data ?? []).filter((l) => !l.unlockedAt);
  const reopened = (locks.data ?? []).filter((l) => l.unlockedAt);
  const anyFilter = Object.values(filters).some(Boolean);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Audit trail"
        icon={History}
        description="Every change to the books, who made it and when. Entries are never edited or removed — a cancellation is itself an entry."
        actions={
          <Button onClick={() => verify.mutate()} disabled={verify.isPending}>
            {verify.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            Verify chain
          </Button>
        }
      />

      {/* ------------------------------------------------ tamper check ---- */}
      {verify.data && (
        <Card>
          <CardContent className="pt-6">
            {verify.data.ok ? (
              <div className="flex items-start gap-2 text-sm">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <div>
                  <p className="font-medium text-emerald-700 dark:text-emerald-400">
                    Chain intact — {verify.data.checked} entries verified.
                  </p>
                  <p className="text-muted-foreground">
                    Each entry carries a fingerprint of the one before it, so altering or removing
                    any entry would break every fingerprint after it. None are broken.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-lg border border-rose-500/20 bg-rose-500/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
                <div className="space-y-1">
                  <p className="font-medium text-rose-600 dark:text-rose-400">
                    Chain broken — {verify.data.failures.length} problem(s) across{' '}
                    {verify.data.checked} entries.
                  </p>
                  <p className="text-muted-foreground">
                    An entry was altered, removed or inserted after it was written. This is not a
                    glitch to retry — treat it as serious.
                  </p>
                  <ul className="space-y-0.5 pt-1 font-mono text-xs text-muted-foreground">
                    {verify.data.failures.slice(0, 10).map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                    {verify.data.failures.length > 10 && (
                      <li>…and {verify.data.failures.length - 10} more</li>
                    )}
                  </ul>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ------------------------------------------------ period locks ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lock className="h-4 w-4" />
            Closed periods
          </CardTitle>
          <CardDescription>
            Nothing can be posted into a closed period — no payment, receipt, purchase, sale or
            set-off. Reopening one is recorded against your name, with your reason.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {canLock && (
            <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
              <div className="grid gap-3 sm:grid-cols-4">
                <div className="space-y-1.5">
                  <Label htmlFor="lock-from">From</Label>
                  <Input
                    id="lock-from"
                    type="date"
                    value={newLock.fromDate}
                    onChange={(e) => setNewLock({ ...newLock, fromDate: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lock-to">To</Label>
                  <Input
                    id="lock-to"
                    type="date"
                    value={newLock.toDate}
                    onChange={(e) => setNewLock({ ...newLock, toDate: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="lock-reason">Reason</Label>
                  <Input
                    id="lock-reason"
                    placeholder="FY 2025-26 filed"
                    value={newLock.reason}
                    onChange={(e) => setNewLock({ ...newLock, reason: e.target.value })}
                  />
                </div>
              </div>
              <Button
                size="sm"
                disabled={!newLock.fromDate || !newLock.toDate || createLock.isPending}
                onClick={() => createLock.mutate()}
              >
                <Lock className="h-3.5 w-3.5" /> Close this period
              </Button>
            </div>
          )}

          {locks.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : closed.length === 0 ? (
            <p className="text-sm text-muted-foreground">No periods are closed.</p>
          ) : (
            <div className="space-y-2">
              {closed.map((l) => (
                <div
                  key={l.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
                >
                  <span>
                    <strong>
                      {istDate(l.fromDate)} – {istDate(l.toDate)}
                    </strong>
                    {l.reason ? <span className="text-muted-foreground"> · {l.reason}</span> : null}
                    <span className="text-muted-foreground">
                      {' '}
                      · closed by {l.lockedByName ?? 'unknown'} on {istDate(l.lockedAt)}
                    </span>
                  </span>
                  {canLock && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={release.isPending}
                      onClick={() => {
                        const reason = window.prompt(
                          'Why are you reopening this period? This is recorded against your name.'
                        );
                        if (reason === null) return;
                        if (reason.trim().length < 3) {
                          toast.error('Give a reason of at least three characters.');
                          return;
                        }
                        release.mutate({ id: l.id, reason: reason.trim() });
                      }}
                    >
                      <Unlock className="h-3.5 w-3.5" /> Reopen
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}

          {reopened.length > 0 && (
            <div className="space-y-1 border-t pt-3">
              {/* Kept visible rather than tidied away: that a closed period was
                  reopened is exactly what an auditor asks about. */}
              <p className="text-xs font-medium text-muted-foreground">Reopened</p>
              {reopened.map((l) => (
                <p key={l.id} className="text-xs text-muted-foreground">
                  {istDate(l.fromDate)} – {istDate(l.toDate)} · reopened by{' '}
                  {l.unlockedByName ?? 'unknown'}
                  {l.unlockedAt ? ` on ${istDate(l.unlockedAt)}` : ''}
                  {l.unlockReason ? ` · ${l.unlockReason}` : ''}
                </p>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ------------------------------------------------------- the log -- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Changes</CardTitle>
          <CardDescription>Newest first. Open an entry to see what changed.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Input
              placeholder="Action, e.g. payment"
              value={draft.action}
              onChange={(e) => setDraft({ ...draft, action: e.target.value })}
            />
            <Input
              placeholder="Record type, e.g. Payment"
              value={draft.entity}
              onChange={(e) => setDraft({ ...draft, entity: e.target.value })}
            />
            <Input
              placeholder="Record id"
              value={draft.entityId}
              onChange={(e) => setDraft({ ...draft, entityId: e.target.value })}
            />
            <Input
              type="date"
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
            <Input
              type="date"
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
            <div className="flex gap-2">
              <Button size="sm" className="flex-1" onClick={() => setFilters(draft)}>
                Filter
              </Button>
              {anyFilter && (
                <Button size="sm" variant="outline" onClick={() => apply(EMPTY_FILTERS)}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>

          {filters.requestId && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                Showing one request: <span className="font-mono">{filters.requestId}</span> — every
                row written while serving it.
              </span>
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => apply({ ...filters, requestId: '' })}
              >
                clear
              </button>
            </div>
          )}

          {log.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : log.isError ? (
            <p className="text-sm text-rose-600 dark:text-rose-400">{getErrorMessage(log.error)}</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing recorded for that filter.</p>
          ) : (
            <>
              <div className="space-y-1">
                {rows.map((row) => {
                  const open = expanded === row.id;
                  const changes = changedFields(row);
                  return (
                    <div key={row.id} className="rounded-lg border">
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : row.id)}
                        className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted/40"
                      >
                        {open ? (
                          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">
                          #{row.seq}
                        </span>
                        <span className="w-44 shrink-0 truncate font-mono text-xs">
                          {row.action}
                        </span>
                        <span className="hidden flex-1 truncate text-muted-foreground sm:block">
                          {row.entityLabel ?? row.entityId ?? ''}
                        </span>
                        <span className="w-32 shrink-0 truncate">{row.userName ?? 'system'}</span>
                        <span className="w-40 shrink-0 text-right text-xs text-muted-foreground">
                          {istDateTime(row.createdAt)}
                        </span>
                      </button>

                      {open && (
                        <div className="space-y-3 border-t px-3 py-3 text-sm">
                          {changes.length === 0 ? (
                            <p className="text-muted-foreground">
                              No field-level detail recorded for this entry.
                            </p>
                          ) : (
                            <div className="space-y-1">
                              {changes.map((c) => (
                                <div
                                  key={c.field}
                                  className="grid gap-1 sm:grid-cols-[180px_1fr] sm:gap-3"
                                >
                                  <span className="text-muted-foreground">{c.field}</span>
                                  <span className="break-all font-mono text-xs">
                                    <span className="text-muted-foreground line-through">
                                      {show(c.before)}
                                    </span>
                                    <span className="mx-2">→</span>
                                    <span className="font-semibold">{show(c.after)}</span>
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}

                          <div className="grid gap-x-6 gap-y-1 border-t pt-2 text-xs text-muted-foreground sm:grid-cols-2">
                            <span>Role: {row.userRole ?? '—'}</span>
                            <span>IP: {row.ip ?? '—'}</span>
                            <span className="truncate">
                              Request: {row.method ?? '—'} {row.path ?? ''}
                            </span>
                            <span className="truncate">
                              Record: {row.entity ?? '—'} {row.entityId ?? ''}
                            </span>
                          </div>

                          {/* Everything written while serving one request shares
                              this id, so one action that touched four tables
                              reads as one event. */}
                          {row.requestId && (
                            <button
                              type="button"
                              className="text-xs underline underline-offset-2"
                              onClick={() =>
                                apply({ ...EMPTY_FILTERS, requestId: row.requestId as string })
                              }
                            >
                              Show the whole request ({row.requestId})
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {rows.length} entr{rows.length === 1 ? 'y' : 'ies'} shown
                </span>
                {log.hasNextPage && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={log.isFetchingNextPage}
                    onClick={() => void log.fetchNextPage()}
                  >
                    {log.isFetchingNextPage && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Load older
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
