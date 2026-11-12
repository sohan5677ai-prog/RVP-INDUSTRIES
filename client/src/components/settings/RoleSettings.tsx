import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertTriangle, Eye, Loader2, RotateCcw, Save, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Role permissions and the audit-mode log.
 *
 * These two belong on one screen: the log says what a role is missing, and the
 * matrix is where you grant it. Splitting them would mean reading one tab and
 * acting in another from memory.
 */

interface RoleRow {
  role: string;
  permissions: string[];
  defaults: string[];
  customised: boolean;
}

interface Matrix {
  enforcing: boolean;
  permissions: string[];
  roles: RoleRow[];
}

interface Denial {
  role: string;
  permission: string;
  method: string;
  path: string;
  enforced: boolean;
  count: number;
  lastSeen: string;
}

/** Group `area.thing.action` by its first segment, for a readable table. */
function groupPermissions(permissions: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const p of permissions) {
    const area = p.split('.')[0];
    (groups[area] ??= []).push(p);
  }
  return groups;
}

export default function RoleSettings() {
  const qc = useQueryClient();
  const [edits, setEdits] = useState<Record<string, Set<string>>>({});

  const { data, isLoading } = useQuery<Matrix>({
    queryKey: ['role-matrix'],
    queryFn: () => api<Matrix>('/roles'),
  });

  const { data: denials } = useQuery<Denial[]>({
    queryKey: ['permission-denials'],
    queryFn: () => api<Denial[]>('/permission-denials'),
  });

  const save = useMutation({
    mutationFn: ({ role, permissions }: { role: string; permissions: string[] }) =>
      api(`/roles/${role}`, { method: 'PUT', body: { permissions } }),
    onSuccess: (_r, vars) => {
      toast.success(`Saved permissions for ${vars.role}.`);
      setEdits((prev) => {
        const next = { ...prev };
        delete next[vars.role];
        return next;
      });
      qc.invalidateQueries({ queryKey: ['role-matrix'] });
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const reset = useMutation({
    mutationFn: (role: string) => api(`/roles/${role}/reset`, { method: 'POST' }),
    onSuccess: (_r, role) => {
      toast.success(`${role} is back on the built-in defaults.`);
      setEdits((prev) => {
        const next = { ...prev };
        delete next[role];
        return next;
      });
      qc.invalidateQueries({ queryKey: ['role-matrix'] });
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const grouped = useMemo(() => groupPermissions(data?.permissions ?? []), [data?.permissions]);

  if (isLoading || !data) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  const editableRoles = data.roles.filter((r) => r.role !== 'DEVELOPER');

  function held(role: RoleRow): Set<string> {
    return edits[role.role] ?? new Set(role.permissions);
  }

  function toggle(role: RoleRow, permission: string) {
    setEdits((prev) => {
      const current = new Set(prev[role.role] ?? role.permissions);
      if (current.has(permission)) current.delete(permission);
      else current.add(permission);
      return { ...prev, [role.role]: current };
    });
  }

  return (
    <div className="space-y-4">
      {!data.enforcing && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm">
          <Eye className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="space-y-1">
            <p className="font-medium">Audit mode — nothing is being blocked yet</p>
            <p className="text-muted-foreground">
              Permissions are checked and failures recorded below, but every request still goes
              through. Run a normal month, grant whatever people legitimately need, then set{' '}
              <code className="rounded bg-muted px-1">RBAC_ENFORCE=true</code> on the server to
              start enforcing.
            </p>
          </div>
        </div>
      )}

      {data.enforcing && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
          <p className="text-muted-foreground">
            Enforcing. A role without a permission is refused, and the attempt is recorded below.
          </p>
        </div>
      )}

      {/* ------------------------------------------------- the matrix ---- */}
      <Card>
        <CardHeader>
          <CardTitle>Role permissions</CardTitle>
          <CardDescription>
            What each role may do. The developer role is fixed and not shown as editable — locking
            it out would leave no way back into a broken deployment.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {editableRoles.map((role) => {
            const current = held(role);
            const dirty = !!edits[role.role];
            return (
              <div key={role.role} className="rounded-lg border">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/40 px-4 py-3">
                  <div>
                    <span className="font-semibold">{role.role}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {current.size} of {data.permissions.length}
                      {role.customised ? ' · customised' : ' · using built-in defaults'}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    {role.customised && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => reset.mutate(role.role)}
                        disabled={reset.isPending}
                      >
                        <RotateCcw className="h-3.5 w-3.5" /> Reset to defaults
                      </Button>
                    )}
                    <Button
                      size="sm"
                      disabled={!dirty || save.isPending}
                      onClick={() =>
                        save.mutate({ role: role.role, permissions: [...current] })
                      }
                    >
                      {save.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5" />
                      )}
                      Save
                    </Button>
                  </div>
                </div>

                <div className="grid gap-x-6 gap-y-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
                  {Object.entries(grouped).map(([area, perms]) => (
                    <div key={area} className="space-y-1.5">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {area}
                      </p>
                      {perms.map((p) => (
                        <label
                          key={p}
                          className="flex cursor-pointer select-none items-center gap-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={current.has(p)}
                            onChange={() => toggle(role, p)}
                            className="h-3.5 w-3.5"
                          />
                          <span
                            className={
                              p.endsWith('.delete') || p.endsWith('.approve')
                                ? 'text-foreground'
                                : 'text-muted-foreground'
                            }
                          >
                            {p.split('.').slice(1).join('.')}
                          </span>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* --------------------------------------------- the denial log ---- */}
      <Card>
        <CardHeader>
          <CardTitle>Permission failures, last 30 days</CardTitle>
          <CardDescription>
            Each row is either something that role legitimately needs — grant it above — or exactly
            the gap this is meant to close. Worth reading after a full month, so anything used only
            at closing has had a chance to appear.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!denials?.length ? (
            <p className="text-sm text-muted-foreground">
              Nothing recorded. In audit mode that means no one has hit a permission they lack.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-4">Role</th>
                    <th className="py-2 pr-4">Permission</th>
                    <th className="py-2 pr-4">Request</th>
                    <th className="py-2 pr-4 text-right">Times</th>
                    <th className="py-2">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {denials.map((d, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-medium">{d.role}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{d.permission}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                        {d.method} {d.path}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{d.count}</td>
                      <td className="py-2">
                        {d.enforced ? (
                          <span className="inline-flex items-center gap-1 text-rose-500">
                            <AlertTriangle className="h-3.5 w-3.5" /> blocked
                          </span>
                        ) : (
                          <span className="text-muted-foreground">allowed (audit)</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
