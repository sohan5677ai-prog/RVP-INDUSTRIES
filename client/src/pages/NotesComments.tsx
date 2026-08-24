import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  StickyNote,
  Plus,
  Search,
  Calendar,
  CheckCircle2,
  Pin,
  Trash2,
  Edit2,
  Tag,
  AlertCircle,
  CheckSquare,
  Check,
  ListFilter,
  ExternalLink,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import type { UserNote, UserNoteCategory, UserNotePriority } from '@/lib/types';
import { shortDate } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { Segmented } from '@/components/ui/segmented';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const CATEGORY_LABELS: Record<UserNoteCategory, string> = {
  NOTE: 'Note',
  REMINDER: 'Reminder',
  TODO: 'To-Do',
  COMMENT: 'Comment',
};

const PRIORITY_OPTIONS: { id: UserNotePriority; label: string }[] = [
  { id: 'LOW', label: 'Low' },
  { id: 'MEDIUM', label: 'Medium' },
  { id: 'HIGH', label: 'High' },
  { id: 'URGENT', label: 'Urgent' },
];

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

export default function NotesComments() {
  const qc = useQueryClient();

  // Filters
  const [statusFilter, setStatusFilter] = useState<'PENDING' | 'COMPLETED' | 'ALL'>('PENDING');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [priorityFilter, setPriorityFilter] = useState<string>('ALL');
  const [search, setSearch] = useState('');

  // Dialog State
  const [createOpen, setCreateOpen] = useState(false);
  const [editingNote, setEditingNote] = useState<UserNote | null>(null);

  // Form fields
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState<UserNoteCategory>('NOTE');
  const [priority, setPriority] = useState<UserNotePriority>('MEDIUM');
  const [isReminder, setIsReminder] = useState(false);
  const [reminderDate, setReminderDate] = useState('');
  const [pinned, setPinned] = useState(false);

  // Fetch all notes
  const { data: notes, isLoading } = useQuery({
    queryKey: ['user-notes', statusFilter, categoryFilter, priorityFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter !== 'ALL') params.set('status', statusFilter);
      if (categoryFilter !== 'ALL') params.set('category', categoryFilter);
      if (priorityFilter !== 'ALL') params.set('priority', priorityFilter);
      const qs = params.toString();
      return api<UserNote[]>(`/user-notes${qs ? `?${qs}` : ''}`);
    },
  });

  // Query for counts across all statuses
  const { data: allNotes } = useQuery({
    queryKey: ['user-notes', 'ALL'],
    queryFn: () => api<UserNote[]>('/user-notes?status=ALL'),
  });

  // Calculations for Stat Cards
  const stats = useMemo(() => {
    const list = allNotes ?? [];
    const total = list.length;
    const pending = list.filter((n) => n.status === 'PENDING').length;
    const completed = list.filter((n) => n.status === 'COMPLETED').length;
    const dueReminders = list.filter((n) => {
      if (n.status !== 'PENDING' || !n.isReminder || !n.reminderDate) return false;
      return daysUntil(n.reminderDate) <= 0;
    }).length;
    return { total, pending, completed, dueReminders };
  }, [allNotes]);

  // Filtered Notes by Search Text
  const filteredNotes = useMemo(() => {
    if (!notes) return [];
    if (!search.trim()) return notes;
    const q = search.toLowerCase().trim();
    return notes.filter(
      (n) =>
        (n.title && n.title.toLowerCase().includes(q)) ||
        n.content.toLowerCase().includes(q) ||
        n.userName.toLowerCase().includes(q) ||
        (n.pageLabel && n.pageLabel.toLowerCase().includes(q))
    );
  }, [notes, search]);

  // Mutations
  const createMutation = useMutation({
    mutationFn: (body: any) => api<UserNote>('/user-notes', { method: 'POST', body }),
    onSuccess: (res) => {
      toast.success(res.isReminder ? 'Reminder created' : 'Note saved');
      qc.invalidateQueries({ queryKey: ['user-notes'] });
      qc.invalidateQueries({ queryKey: ['due-user-notes'] });
      setCreateOpen(false);
      resetForm();
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) =>
      api<UserNote>(`/user-notes/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      toast.success('Note updated');
      qc.invalidateQueries({ queryKey: ['user-notes'] });
      qc.invalidateQueries({ queryKey: ['due-user-notes'] });
      setEditingNote(null);
      resetForm();
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const toggleStatusMutation = useMutation({
    mutationFn: (id: string) => api<UserNote>(`/user-notes/${id}/toggle-status`, { method: 'PATCH' }),
    onSuccess: (updated) => {
      toast.success(
        updated.status === 'COMPLETED' ? 'Marked as completed' : 'Marked as pending'
      );
      qc.invalidateQueries({ queryKey: ['user-notes'] });
      qc.invalidateQueries({ queryKey: ['due-user-notes'] });
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/user-notes/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Note deleted');
      qc.invalidateQueries({ queryKey: ['user-notes'] });
      qc.invalidateQueries({ queryKey: ['due-user-notes'] });
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  function resetForm() {
    setTitle('');
    setContent('');
    setCategory('NOTE');
    setPriority('MEDIUM');
    setIsReminder(false);
    setReminderDate('');
    setPinned(false);
  }

  function openCreateModal() {
    resetForm();
    setCreateOpen(true);
  }

  function openEditModal(n: UserNote) {
    setEditingNote(n);
    setTitle(n.title ?? '');
    setContent(n.content);
    setCategory(n.category);
    setPriority(n.priority);
    setIsReminder(n.isReminder);
    setReminderDate(n.reminderDate ? n.reminderDate.slice(0, 10) : '');
    setPinned(n.pinned);
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) {
      toast.error('Please enter note content');
      return;
    }

    const payload = {
      title: title.trim() || null,
      content: content.trim(),
      category,
      priority,
      isReminder: isReminder || category === 'REMINDER' || Boolean(reminderDate),
      reminderDate: (isReminder || category === 'REMINDER') && reminderDate ? new Date(reminderDate).toISOString() : null,
      pinned,
    };

    if (editingNote) {
      updateMutation.mutate({ id: editingNote.id, body: payload });
    } else {
      createMutation.mutate({
        ...payload,
        pagePath: '/notes-comments',
        pageLabel: 'Notes / Comments',
      });
    }
  }

  return (
    <div className="space-y-6">
      {/* Editorial Page Header */}
      <PageHeader
        title="Notes & Comments"
        description="Internal remarks, task reminders and operational notes."
        icon={StickyNote}
        actions={
          <Button onClick={openCreateModal} className="gap-1.5">
            <Plus className="h-4 w-4" /> New Note
          </Button>
        }
      />

      {/* KPI Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Active Notes"
          value={stats.pending}
          tone="amber"
          icon={StickyNote}
          hint="Pending tasks & notes"
        />
        <StatCard
          label="Due Reminders"
          value={stats.dueReminders}
          tone="rose"
          icon={AlertCircle}
          hint="Due today or overdue"
        />
        <StatCard
          label="Completed"
          value={stats.completed}
          tone="forest"
          icon={CheckCircle2}
          hint="Resolved notes"
        />
        <StatCard
          label="Total Logged"
          value={stats.total}
          tone="taupe"
          icon={CheckSquare}
          hint="All time records"
        />
      </div>

      {/* Filter and Search Bar */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <Segmented
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v)}
              options={[
                { value: 'PENDING', label: 'Active', count: stats.pending },
                { value: 'COMPLETED', label: 'Completed', count: stats.completed },
                { value: 'ALL', label: 'All', count: stats.total },
              ]}
            />

            <div className="relative w-full sm:w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search notes, author, page..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-8 text-xs"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border/50 text-xs">
            <span className="text-muted-foreground flex items-center gap-1">
              <ListFilter className="h-3.5 w-3.5" /> Filters:
            </span>

            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="h-7 rounded-lg border border-input bg-background px-2 text-xs outline-none"
            >
              <option value="ALL">All Types</option>
              <option value="NOTE">Notes</option>
              <option value="REMINDER">Reminders</option>
              <option value="TODO">To-Dos</option>
              <option value="COMMENT">Comments</option>
            </select>

            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              className="h-7 rounded-lg border border-input bg-background px-2 text-xs outline-none"
            >
              <option value="ALL">All Priorities</option>
              <option value="LOW">Low</option>
              <option value="MEDIUM">Medium</option>
              <option value="HIGH">High</option>
              <option value="URGENT">Urgent</option>
            </select>

            {(categoryFilter !== 'ALL' || priorityFilter !== 'ALL' || search) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCategoryFilter('ALL');
                  setPriorityFilter('ALL');
                  setSearch('');
                }}
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
              >
                Reset
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Notes Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
        </div>
      ) : filteredNotes.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="text-center py-16 space-y-2">
            <StickyNote className="h-8 w-8 mx-auto text-muted-foreground/40" />
            <h3 className="text-sm font-semibold text-foreground">No notes found</h3>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              {search || categoryFilter !== 'ALL' || priorityFilter !== 'ALL'
                ? 'No notes match the current filters.'
                : 'No notes in this view.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredNotes.map((n) => {
            const isDone = n.status === 'COMPLETED';
            const d = n.reminderDate ? daysUntil(n.reminderDate) : null;
            const whenText =
              d !== null
                ? d < 0
                  ? `${Math.abs(d)}d overdue`
                  : d === 0
                  ? 'Today'
                  : d === 1
                  ? 'Tomorrow'
                  : `In ${d}d`
                : null;

            return (
              <div
                key={n.id}
                className={cn(
                  'rounded-xl border border-border bg-card p-4 space-y-3 flex flex-col justify-between transition-colors shadow-xs',
                  isDone && 'opacity-70 bg-muted/20'
                )}
              >
                <div className="space-y-2.5">
                  {/* Top: Checkbox, Title, Pin, Actions */}
                  <div className="flex items-start gap-2.5 justify-between">
                    <div className="flex items-start gap-2.5 flex-1 min-w-0">
                      <button
                        type="button"
                        onClick={() => toggleStatusMutation.mutate(n.id)}
                        disabled={toggleStatusMutation.isPending}
                        title={isDone ? 'Mark as Active' : 'Mark as Done'}
                        className={cn(
                          'mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-md border transition-colors',
                          isDone
                            ? 'border-success bg-success text-success-foreground'
                            : 'border-border hover:border-success hover:bg-success/10'
                        )}
                      >
                        {isDone && <Check className="h-3 w-3 stroke-[3]" />}
                      </button>

                      <div className="min-w-0 flex-1">
                        {n.title ? (
                          <h3
                            className={cn(
                              'font-semibold text-sm text-foreground truncate',
                              isDone && 'line-through text-muted-foreground'
                            )}
                          >
                            {n.title}
                          </h3>
                        ) : (
                          <span
                            className={cn(
                              'text-xs font-semibold text-muted-foreground uppercase',
                              isDone && 'line-through'
                            )}
                          >
                            {n.category}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {n.pinned && (
                        <span title="Pinned to top">
                          <Pin className="h-3.5 w-3.5 text-primary" />
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => openEditModal(n)}
                        className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                        title="Edit note"
                      >
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm('Delete this note?')) {
                            deleteMutation.mutate(n.id);
                          }
                        }}
                        className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                        title="Delete note"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Badges */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 uppercase">
                      {n.priority}
                    </Badge>
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 uppercase">
                      {n.category}
                    </Badge>
                    {n.isReminder && n.reminderDate && (
                      <Badge
                        variant={!isDone && d !== null && d <= 0 ? 'destructive' : 'secondary'}
                        className="text-[10px] px-1.5 py-0 flex items-center gap-1 font-mono"
                      >
                        <Calendar className="h-2.5 w-2.5" />
                        {shortDate(n.reminderDate)} {whenText ? `(${whenText})` : ''}
                      </Badge>
                    )}
                  </div>

                  {/* Content */}
                  <p
                    className={cn(
                      'text-xs text-foreground/90 whitespace-pre-wrap rounded-lg bg-muted/30 p-2.5 border border-border/50 font-sans',
                      isDone && 'text-muted-foreground line-through bg-muted/15'
                    )}
                  >
                    {n.content}
                  </p>
                </div>

                {/* Footer Meta */}
                <div className="pt-2 border-t border-border/60 text-[11px] text-muted-foreground space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span>{n.userName}</span>
                    <span className="font-mono">{shortDate(n.createdAt)}</span>
                  </div>

                  {/* Attached Page */}
                  {n.pageLabel && n.pagePath && (
                    <div className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
                      <Tag className="h-2.5 w-2.5 text-primary" /> Attached to:{' '}
                      <Link
                        to={n.pagePath}
                        className="text-primary hover:underline font-medium inline-flex items-center gap-0.5"
                      >
                        {n.pageLabel} <ExternalLink className="h-2.5 w-2.5" />
                      </Link>
                    </div>
                  )}

                  {/* Completed info */}
                  {isDone && (
                    <div className="flex items-center gap-1 text-[10.5px] font-medium text-success pt-0.5">
                      <CheckCircle2 className="h-3 w-3" /> Done
                      {n.completedByName ? ` by ${n.completedByName}` : ''}
                      {n.completedAt ? ` on ${shortDate(n.completedAt)}` : ''}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Dialog Modal */}
      <Dialog open={createOpen || Boolean(editingNote)} onOpenChange={(v) => !v && (setCreateOpen(false), setEditingNote(null))}>
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={handleSave} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{editingNote ? 'Edit Note' : 'New Note / Reminder'}</DialogTitle>
              <DialogDescription>
                Internal remark, to-do item or scheduled reminder.
              </DialogDescription>
            </DialogHeader>

            {/* Type selector */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Type</Label>
              <div className="grid grid-cols-4 gap-1.5">
                {(['NOTE', 'REMINDER', 'TODO', 'COMMENT'] as UserNoteCategory[]).map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => {
                      setCategory(cat);
                      if (cat === 'REMINDER') setIsReminder(true);
                    }}
                    className={cn(
                      'py-1.5 px-2 rounded-lg text-xs font-medium border text-center transition-colors',
                      category === cat
                        ? 'border-primary bg-primary/10 text-primary font-semibold'
                        : 'border-border bg-card text-muted-foreground hover:bg-muted'
                    )}
                  >
                    {CATEGORY_LABELS[cat]}
                  </button>
                ))}
              </div>
            </div>

            {/* Title */}
            <div className="space-y-1.5">
              <Label htmlFor="dlg-title" className="text-xs font-semibold">
                Title <span className="text-muted-foreground font-normal">(Optional)</span>
              </Label>
              <Input
                id="dlg-title"
                placeholder="e.g. Call broker regarding moisture allowance"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={150}
                className="h-9 text-xs"
              />
            </div>

            {/* Content */}
            <div className="space-y-1.5">
              <Label htmlFor="dlg-content" className="text-xs font-semibold">
                Details <span className="text-destructive">*</span>
              </Label>
              <textarea
                id="dlg-content"
                required
                rows={4}
                placeholder="Enter details..."
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="w-full resize-y rounded-lg border border-input bg-background p-2.5 text-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </div>

            {/* Priority */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Priority</Label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as UserNotePriority)}
                className="w-full h-9 rounded-lg border border-input bg-background px-2.5 text-xs outline-none"
              >
                {PRIORITY_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Reminder Date */}
            <div className="rounded-xl border border-border bg-muted/20 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="dlg-toggle-reminder" className="text-xs font-semibold flex items-center gap-1.5 cursor-pointer">
                  <Calendar className="h-3.5 w-3.5 text-primary" /> Schedule Reminder
                </Label>
                <input
                  id="dlg-toggle-reminder"
                  type="checkbox"
                  checked={isReminder || category === 'REMINDER'}
                  onChange={(e) => {
                    setIsReminder(e.target.checked);
                    if (!e.target.checked && category === 'REMINDER') setCategory('NOTE');
                    if (e.target.checked && !reminderDate) {
                      setReminderDate(new Date().toISOString().slice(0, 10));
                    }
                  }}
                  className="rounded border-input h-4 w-4 accent-primary cursor-pointer"
                />
              </div>

              {(isReminder || category === 'REMINDER') && (
                <div className="pt-1">
                  <Input
                    type="date"
                    value={reminderDate}
                    onChange={(e) => setReminderDate(e.target.value)}
                    className="h-9 text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Surfaces in the daily reminder dialog until marked done.
                  </p>
                </div>
              )}
            </div>

            {/* Pin */}
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={pinned}
                  onChange={(e) => setPinned(e.target.checked)}
                  className="rounded border-input h-4 w-4 accent-primary"
                />
                <span>Pin to top</span>
              </label>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setCreateOpen(false);
                  setEditingNote(null);
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={createMutation.isPending || updateMutation.isPending}
              >
                {(createMutation.isPending || updateMutation.isPending) && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                )}
                {editingNote ? 'Save Changes' : 'Create Note'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
