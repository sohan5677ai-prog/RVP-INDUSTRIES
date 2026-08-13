import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, Plus, Trash2, Monitor } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/PageHeader';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';

/** One signed-in device, as reported by GET /users. */
type Device = {
  id: string;
  tag: string;
  label: string;
  signedInAt: string;
  lastSeenAt: string;
  current: boolean;
};

type UserRow = {
  id: string;
  name: string;
  username: string;
  role: string;
  email?: string;
  devices?: Device[];
};

const USER_COLUMNS: ExportColumn<UserRow>[] = [
  { header: 'Name', value: (u) => u.name },
  { header: 'Username', value: (u) => u.username },
  { header: 'Role', value: (u) => u.role },
  { header: 'Email', value: (u) => u.email ?? '' },
  { header: 'Active devices', value: (u) => String(u.devices?.length ?? 0) },
];

function lastSeen(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'active now';
  return `${mins} min ago`;
}

export default function Users() {
  const { user: currentUser } = useAuth();
  const isDeveloper = currentUser?.role === 'DEVELOPER';
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<UserRow | null>(null);
  const [formData, setFormData] = useState({ name: '', username: '', password: '', role: 'USER' });

  const { data: users, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<UserRow[]>('/users'),
    // Device rows go stale as people sign in and out.
    refetchInterval: 60_000,
  });
  const visibleUsers = isDeveloper ? users : users?.filter(u => u.role !== 'DEVELOPER');

  const createMutation = useMutation({
    mutationFn: (data: { name: string; username: string; role: string; password?: string }) => api('/users', { method: 'POST', body: data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success('User created successfully');
      setOpen(false);
      setFormData({ name: '', username: '', password: '', role: 'USER' });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success('User deleted');
      setConfirmDelete(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate(formData);
  };

  /**
   * Why this row's delete button is off, or null if it may be deleted. Mirrors
   * the rules the server enforces in deleteUser - the server is the authority,
   * this just stops the click.
   */
  const deleteBlockedBecause = (u: UserRow): string | null => {
    if (u.id === currentUser?.id) return 'You cannot delete your own account';
    if (!isDeveloper && u.role !== 'USER') {
      const article = /^[AEIOU]/.test(u.role) ? 'an' : 'a';
      return `Only a developer can delete ${article} ${u.role.toLowerCase()} account`;
    }
    return null;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageHeader icon={Shield} title="User Management" description="Manage access and roles across the ERP." />
        <div className="flex items-center gap-2">
          <ExportButtons filename="Users" title="Users" subtitle={`${visibleUsers?.length ?? 0} user(s)`} columns={USER_COLUMNS} rows={visibleUsers ?? []} />
          <Button onClick={() => setOpen(true)} className="gap-2"><Plus className="h-4 w-4" /> Add User</Button>
        </div>
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Username</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Active devices</TableHead>
              <TableHead className="w-[100px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && <TableRow><TableCell colSpan={5} className="text-center">Loading...</TableCell></TableRow>}
            {visibleUsers?.map(u => {
              const blocked = deleteBlockedBecause(u);
              return (
              <TableRow key={u.id}>
                <TableCell className="font-medium">{u.name}</TableCell>
                <TableCell>{u.username}</TableCell>
                <TableCell><Badge variant="outline">{u.role}</Badge></TableCell>
                <TableCell>
                  {!u.devices?.length ? (
                    <span className="text-xs text-muted-foreground">Not signed in</span>
                  ) : (
                    <div className="space-y-1">
                      {u.devices.map(d => (
                        <div key={d.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                          <Monitor className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="font-medium">{d.label}</span>
                          <span className="font-mono text-muted-foreground">#{d.tag}</span>
                          {d.current && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">this device</Badge>}
                          <span className="text-muted-foreground">· {lastSeen(d.lastSeenAt)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={!!blocked}
                    title={blocked ?? 'Delete user'}
                    onClick={() => setConfirmDelete(u)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!confirmDelete} onOpenChange={(v) => !v && setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete user</DialogTitle>
            <DialogDescription>
              {confirmDelete && (
                <>
                  Permanently remove <b>{confirmDelete.name}</b> ({confirmDelete.username})? They are signed
                  out everywhere and cannot sign in again. This cannot be undone.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => confirmDelete && deleteMutation.mutate(confirmDelete.id)}
            >
              Delete user
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New User</DialogTitle>
            <DialogDescription>Add a new user and assign their authorization level.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>Full Name</Label>
              <Input required value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Username</Label>
              <Input type="text" required value={formData.username} onChange={e => setFormData({ ...formData, username: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Password</Label>
              <Input type="password" required minLength={6} value={formData.password} onChange={e => setFormData({ ...formData, password: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <select 
                className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={formData.role} 
                onChange={e => setFormData({ ...formData, role: e.target.value })}
              >
                <option value="ADMIN">Admin</option>
                <option value="USER">User</option>
                <option value="OWNER">Owner</option>
                {isDeveloper && <option value="DEVELOPER">Developer</option>}
              </select>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={createMutation.isPending}>Save User</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
