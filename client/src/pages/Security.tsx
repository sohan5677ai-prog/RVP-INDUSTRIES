import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/PageHeader';
import { AlertTriangle, CheckCircle2, Info, Loader2, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

/**
 * The security page (Phase 8).
 *
 * Answers two questions, in this order: what needs attention, and are the
 * safeguards themselves still working. The second is there because every
 * failure this phase was built for was a safeguard that had quietly stopped -
 * the backup, the chain, the storage prune. "Last ran" matters as much as
 * "last result": a check that has not run is not a check that passed.
 */

interface SecurityAlert {
  id: string;
  rule: string;
  subject: string | null;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  detail: Record<string, unknown> | null;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  acknowledgedAt: string | null;
  acknowledgedByName: string | null;
  acknowledgeNote: string | null;
}

interface Overview {
  openAlerts: number;
  criticalAlerts: number;
  failedLogins7d: number;
  failedLogins24h: number;
  permissionDenials7d: number;
  lastBackup: { at: string; detail: Record<string, unknown> | null } | null;
  lastChainCheck: { at: string; detail: Record<string, unknown> | null } | null;
  lastStoragePrune: { at: string; summary: string | null } | null;
  alertEmailConfigured: boolean;
}

const istDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });

function ageHours(iso: string | undefined | null): number | null {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / 3600_000;
}

function describeAge(iso: string | undefined | null): string {
  const h = ageHours(iso);
  if (h === null) return 'never';
  if (h < 1) return `${Math.round(h * 60)} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

const SEVERITY = {
  CRITICAL: { icon: ShieldAlert, cls: 'text-rose-500', badge: 'bg-rose-500/10 text-rose-600 dark:text-rose-400' },
  WARNING: { icon: AlertTriangle, cls: 'text-amber-500', badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  INFO: { icon: Info, cls: 'text-sky-500', badge: 'bg-sky-500/10 text-sky-600 dark:text-sky-400' },
} as const;

/** A safeguard, with how long ago it last ran and whether that is too long. */
function Safeguard({
  name,
  at,
  summary,
  staleAfterHours,
}: {
  name: string;
  at: string | null | undefined;
  summary: string;
  staleAfterHours: number;
}) {
  const h = ageHours(at);
  const stale = h === null || h > staleAfterHours;
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2">
      <div className="min-w-0">
        <p className="text-sm font-medium">{name}</p>
        <p className="truncate text-xs text-muted-foreground">{summary}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className={`text-sm font-medium ${stale ? 'text-rose-600 dark:text-rose-400' : ''}`}>
          {describeAge(at)}
        </p>
        {at && <p className="text-[11px] text-muted-foreground">{istDateTime(at)}</p>}
      </div>
    </div>
  );
}

export default function Security() {
  const qc = useQueryClient();
  const [showAcknowledged, setShowAcknowledged] = useState(false);

  const overview = useQuery<Overview>({
    queryKey: ['security-overview'],
    queryFn: () => api<Overview>('/security/overview'),
  });

  const alerts = useQuery<SecurityAlert[]>({
    queryKey: ['security-alerts', showAcknowledged],
    queryFn: () =>
      api<SecurityAlert[]>(`/security/alerts${showAcknowledged ? '?includeAcknowledged=true' : ''}`),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['security-overview'] });
    qc.invalidateQueries({ queryKey: ['security-alerts'] });
  };

  const runNow = useMutation({
    mutationFn: () => api<{ raised: number; resolved: number }>('/security/run', { method: 'POST' }),
    onSuccess: (r) => {
      toast.success(
        r.raised === 0 && r.resolved === 0
          ? 'Checks ran. Nothing new.'
          : `Checks ran: ${r.raised} raised, ${r.resolved} cleared.`
      );
      refresh();
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const acknowledge = useMutation({
    mutationFn: (v: { id: string; note: string }) =>
      api(`/security/alerts/${v.id}/acknowledge`, { method: 'POST', body: { note: v.note } }),
    onSuccess: () => {
      toast.success('Acknowledged.');
      refresh();
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const o = overview.data;
  const open = (alerts.data ?? []).filter((a) => !a.acknowledgedAt);
  const done = (alerts.data ?? []).filter((a) => a.acknowledgedAt);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Security"
        icon={ShieldCheck}
        description="What needs attention, and whether the safeguards are still working."
        actions={
          <Button onClick={() => runNow.mutate()} disabled={runNow.isPending}>
            {runNow.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Run checks now
          </Button>
        }
      />

      {/* --------------------------------------------------- at a glance -- */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Open alerts', value: o?.openAlerts ?? '—', bad: (o?.openAlerts ?? 0) > 0 },
          { label: 'Critical', value: o?.criticalAlerts ?? '—', bad: (o?.criticalAlerts ?? 0) > 0 },
          { label: 'Failed sign-ins, 24h', value: o?.failedLogins24h ?? '—', bad: false },
          { label: 'Denied requests, 7d', value: o?.permissionDenials7d ?? '—', bad: false },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent className="pt-6">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className={`text-2xl font-semibold ${s.bad ? 'text-rose-600 dark:text-rose-400' : ''}`}>
                {s.value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {o && !o.alertEmailConfigured && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="flex items-start gap-2 pt-6 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div>
              <p className="font-medium">Alerts are stored here, but no email goes out.</p>
              <p className="text-muted-foreground">
                No security alert addresses are set, so an alert raised at 3am waits until someone
                opens this page. Settings → Company profile → security alert emails.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* --------------------------------------------------- safeguards --- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Are the safeguards running?</CardTitle>
          <CardDescription>
            A check that has not run is not a check that passed. Each of these stopped quietly at
            least once.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Safeguard
            name="Database backup"
            at={o?.lastBackup?.at}
            summary={
              o?.lastBackup
                ? String((o.lastBackup.detail as { file?: string } | null)?.file ?? 'taken')
                : 'no backup has ever been recorded'
            }
            staleAfterHours={36}
          />
          <Safeguard
            name="Audit chain verification"
            at={o?.lastChainCheck?.at}
            summary={
              o?.lastChainCheck
                ? (o.lastChainCheck.detail as { ok?: boolean; checked?: number } | null)?.ok
                  ? `intact, ${(o.lastChainCheck.detail as { checked?: number }).checked} rows`
                  : 'BROKEN — see the runbook'
                : 'never verified'
            }
            staleAfterHours={25}
          />
          <Safeguard
            name="Storage prune"
            at={o?.lastStoragePrune?.at}
            summary={o?.lastStoragePrune?.summary ?? 'has not run'}
            staleAfterHours={36}
          />
        </CardContent>
      </Card>

      {/* ------------------------------------------------------- alerts --- */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">Alerts</CardTitle>
              <CardDescription>
                Repeats fold into one entry with a count, rather than filling the page.
              </CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={() => setShowAcknowledged((v) => !v)}>
              {showAcknowledged ? 'Open only' : 'Include acknowledged'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {alerts.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : open.length === 0 && done.length === 0 ? (
            <div className="flex items-center gap-2 py-4 text-sm text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              Nothing open. The checks ran and found nothing.
            </div>
          ) : (
            <>
              {open.map((a) => {
                const s = SEVERITY[a.severity] ?? SEVERITY.INFO;
                const Icon = s.icon;
                return (
                  <div key={a.id} className="rounded-lg border p-3">
                    <div className="flex items-start gap-3">
                      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${s.cls}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${s.badge}`}>
                            {a.severity}
                          </span>
                          <span className="font-mono text-[11px] text-muted-foreground">{a.rule}</span>
                          {a.occurrences > 1 && (
                            <span className="text-[11px] text-muted-foreground">
                              ×{a.occurrences} since {istDateTime(a.firstSeenAt)}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-sm">{a.title}</p>
                        {a.detail && (
                          <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                            {JSON.stringify(a.detail)}
                          </p>
                        )}
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          last seen {istDateTime(a.lastSeenAt)}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        disabled={acknowledge.isPending}
                        onClick={() => {
                          const note = window.prompt('Acknowledge — what did you find? (optional)');
                          if (note === null) return;
                          acknowledge.mutate({ id: a.id, note });
                        }}
                      >
                        Acknowledge
                      </Button>
                    </div>
                  </div>
                );
              })}

              {done.length > 0 && (
                <div className="space-y-1 border-t pt-3">
                  <p className="text-xs font-medium text-muted-foreground">Acknowledged</p>
                  {done.map((a) => (
                    <p key={a.id} className="text-xs text-muted-foreground">
                      {a.title} — {a.acknowledgedByName ?? 'someone'}
                      {a.acknowledgeNote ? `: ${a.acknowledgeNote}` : ''}
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
