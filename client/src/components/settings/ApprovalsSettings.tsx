import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertTriangle, Check, Clock, Loader2, ShieldAlert, X } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Changes waiting for a second person (plan items 2.6, 3.1).
 *
 * The before-and-after is shown in full, unmasked. This is the screen where
 * someone decides whether an account number is right, and they cannot do that
 * against four digits. The alert emails mask; this does not.
 */

interface PendingChange {
  id: string;
  subject: string;
  summary: string;
  action: string;
  proposed: Record<string, string | null>;
  previous: Record<string, string | null> | null;
  approvePermission: string;
  requestedByName: string | null;
  requestedAt: string;
  /** False when you raised it yourself — you cannot approve your own. */
  canDecide: boolean;
}

const FIELD_LABELS: Record<string, string> = {
  bankAccountNumber: 'Bank account number',
  bankIfsc: 'IFSC code',
  bankName: 'Bank name',
  bankAccountName: 'Account holder name',
  bankBranchIfsc: 'IFSC code',
  gstin: 'GSTIN',
  email: 'Email address',
};

export default function ApprovalsSettings() {
  const qc = useQueryClient();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const { data, isLoading } = useQuery<PendingChange[]>({
    queryKey: ['pending-changes'],
    queryFn: () => api<PendingChange[]>('/pending-changes'),
    refetchInterval: 60_000,
  });

  const decide = useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: 'approve' | 'reject'; reason?: string }) =>
      api(`/pending-changes/${id}/${action}`, {
        method: 'POST',
        ...(action === 'reject' ? { body: { reason } } : {}),
      }),
    onSuccess: (_r, vars) => {
      toast.success(vars.action === 'approve' ? 'Approved and applied.' : 'Rejected.');
      setRejecting(null);
      setReason('');
      qc.invalidateQueries({ queryKey: ['pending-changes'] });
      qc.invalidateQueries({ queryKey: ['parties'] });
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const pending = data ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Waiting for approval
          </CardTitle>
          <CardDescription>
            Bank details, GSTIN and email addresses cannot be changed in one step. Until someone
            other than the person who asked approves, <strong>the existing details stay in use</strong>.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {pending.length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing is waiting.</p>
          )}

          {pending.map((change) => {
            const fields = Object.keys(change.proposed ?? {});
            return (
              <div key={change.id} className="rounded-lg border">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b bg-muted/40 px-4 py-3">
                  <div className="space-y-0.5">
                    <p className="font-medium">{change.summary}</p>
                    <p className="text-xs text-muted-foreground">
                      Requested by {change.requestedByName ?? 'unknown'} ·{' '}
                      {new Date(change.requestedAt).toLocaleString('en-IN')}
                    </p>
                  </div>
                  {!change.canDecide && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs text-amber-600 dark:text-amber-400">
                      <ShieldAlert className="h-3.5 w-3.5" />
                      You raised this
                    </span>
                  )}
                </div>

                <div className="space-y-2 p-4">
                  {fields.map((f) => (
                    <div key={f} className="grid gap-1 text-sm sm:grid-cols-[180px_1fr]">
                      <span className="text-muted-foreground">{FIELD_LABELS[f] ?? f}</span>
                      <span className="font-mono">
                        <span className="text-muted-foreground line-through">
                          {change.previous?.[f] || '(empty)'}
                        </span>
                        <span className="mx-2">→</span>
                        <span className="font-semibold">{change.proposed?.[f] || '(empty)'}</span>
                      </span>
                    </div>
                  ))}

                  {fields.some((f) => /bank|ifsc|account/i.test(f)) && (
                    <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                      <p className="text-muted-foreground">
                        Confirm this against something other than the message that asked for it —
                        a phone call to the number you already had for them. An emailed request to
                        change an account is the usual shape of this fraud.
                      </p>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
                  {rejecting === change.id ? (
                    <>
                      <Input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Why are you rejecting this?"
                        className="h-9 max-w-md"
                        autoFocus
                      />
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={reason.trim().length < 3 || decide.isPending}
                        onClick={() => decide.mutate({ id: change.id, action: 'reject', reason })}
                      >
                        Confirm rejection
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => { setRejecting(null); setReason(''); }}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        disabled={!change.canDecide || decide.isPending}
                        onClick={() => decide.mutate({ id: change.id, action: 'approve' })}
                      >
                        {decide.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )}
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!change.canDecide || decide.isPending}
                        onClick={() => setRejecting(change.id)}
                      >
                        <X className="h-3.5 w-3.5" /> Reject
                      </Button>
                      {!change.canDecide && (
                        <span className="text-xs text-muted-foreground">
                          Someone else has to decide this one.
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
