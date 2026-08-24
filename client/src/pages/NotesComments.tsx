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

const COLOR_MAP: Record<string, { bg: string; border: string; ring: string; badge: string; text: string }> = {
  amber: {
    bg: 'bg-amber-500/10 dark:bg-amber-950/25',
    border: 'border-amber-500/30',
    ring: 'focus-within:ring-amber-500/30',
    badge: 'bg-amber-500/20 text-amber-800 dark:text-amber-300 border-amber-500/30',
    text: 'text-amber-900 dark:text-amber-200',
  },
  sky: {
    bg: 'bg-sky-500/10 dark:bg-sky-950/25',
    border: 'border-sky-500/30',
    ring: 'focus-within:ring-sky-500/30',
    badge: 'bg-sky-500/20 text-sky-800 dark:text-sky-300 border-sky-500/30',
    text: 'text-sky-900 dark:text-sky-200',
  },
  emerald: {
    bg: 'bg-emerald-500/10 dark:bg-emerald-950/25',
    border: 'border-emerald-500/30',
    ring: 'focus-within:ring-emerald-500/30',
    badge: 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border-emerald-500/30',
    text: 'text-emerald-900 dark:text-emerald-200',
  },
  purple: {
    bg: 'bg-purple-500/10 dark:bg-purple-950/25',
    border: 'border-purple-500/30',
    ring: 'focus-within:ring-purple-500/30',
    badge: 'bg-purple-500/20 text-purple-800 dark:text-purple-300 border-purple-500/30',
    text: 'text-purple-900 dark:text-purple-200',
  },
  rose: {
    bg: 'bg-rose-500/10 dark:bg-rose-950/25',
    border: 'border-rose-500/30',
    ring: 'focus-within:ring-rose-500/30',
    badge: 'bg-rose-500/20 text-rose-800 dark:text-rose-300 border-rose-500/30',
    text: 'text-rose-900 dark:text-rose-200',
  },
};

const COLOR_OPTIONS = [
  { id: 'amber', name: 'Amber', dot: 'bg-amber-500' },
  { id: 'sky', name: 'Sky Blue', dot: 'bg-sky-500' },
  { id: 'emerald', name: 'Emerald', dot: 'bg-emerald-500' },
  { id: 'purple', name: 'Purple', dot: 'bg-purple-500' },
  { id: 'rose', name: 'Rose', dot: 'bg-rose-500' },
];

const PRIORITY_META: Record<UserNotePriority, { label: string; badge: string }> = {
  LOW: { label: 'Low', badge: 'border-slate-400/20 bg-slate-500/10 text-slate-600 dark:text-slate-400' },
  MEDIUM: { label: 'Medium', badge: 'border-blue-400/20 bg-blue-500/10 text-blue-600 dark:text-blue-400' },
  HIGH: { label: 'High', badge: 'border-amber-400/20 bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  URGENT: { label: 'Urgent 🔥', badge: 'border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400 font-semibold' },
};

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
  const [color, setColor] = useState('amber');
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
        updated.status === 'COMPLETED' ? 'Marked as completed! (Will not alert anymore)' : 'Marked as pending'
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
    setColor('amber');
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
    setColor(n.color ?? 'amber');
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
      color,
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
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/25">
              <StickyNote className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-foreground">Notes / Comments</h1>
              <p className="text-xs text-muted-foreground">
                Manage personal & team notes, to-dos, comments and reminder alerts
              </p>
            </div>
          </div>
        </div>

        <Button onClick={openCreateModal} className="bg-amber-600 hover:bg-amber-700 text-white gap-1.5 self-start sm:self-auto">
          <Plus className="h-4 w-4" /> New Note / Reminder
        </Button>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-border/80">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Active Tasks & Notes</p>
              <p className="text-2xl font-bold text-foreground mt-0.5">{stats.pending}</p>
            </div>
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600 ring-1 ring-amber-500/20">
              <StickyNote className="h-5 w-5" />
            </span>
          </CardContent>
        </Card>

        <Card className="border-border/80">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Due / Overdue Reminders</p>
              <p className="text-2xl font-bold text-rose-600 dark:text-rose-400 mt-0.5">{stats.dueReminders}</p>
            </div>
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-500/10 text-rose-600 ring-1 ring-rose-500/20">
              <AlertCircle className="h-5 w-5" />
            </span>
          </CardContent>
        </Card>

        <Card className="border-border/80">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Completed Tasks</p>
              <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">{stats.completed}</p>
            </div>
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/20">
              <CheckCircle2 className="h-5 w-5" />
            </span>
          </CardContent>
        </Card>

        <Card className="border-border/80">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Total Created</p>
              <p className="text-2xl font-bold text-foreground mt-0.5">{stats.total}</p>
            </div>
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/20">
              <CheckSquare className="h-5 w-5" />
            </span>
          </CardContent>
        </Card>
      </div>

      {/* Filter and Search Bar */}
      <Card className="border-border/80">
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-col md:flex-row items-center justify-between gap-3">
            {/* Status Pills */}
            <div className="flex items-center gap-1 bg-muted/60 p-1 rounded-xl w-full md:w-auto">
              {(
                [
                  { id: 'PENDING', label: `Active (${stats.pending})` },
                  { id: 'COMPLETED', label: `Completed (${stats.completed})` },
                  { id: 'ALL', label: `All (${stats.total})` },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setStatusFilter(tab.id)}
                  className={cn(
                    'flex-1 md:flex-initial px-3 py-1.5 rounded-lg text-xs font-semibold transition-all',
                    statusFilter === tab.id
                      ? 'bg-background shadow-xs text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Search Input */}
            <div className="relative w-full md:w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search notes, comments, user..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 h-9 text-xs"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-border/50 text-xs">
            <span className="text-muted-foreground flex items-center gap-1">
              <ListFilter className="h-3.5 w-3.5" /> Filters:
            </span>

            {/* Category Filter */}
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="h-8 rounded-lg border border-input bg-background px-2 text-xs outline-none"
            >
              <option value="ALL">All Types</option>
              <option value="NOTE">Notes</option>
              <option value="REMINDER">Reminders</option>
              <option value="TODO">To-Dos</option>
              <option value="COMMENT">Comments</option>
            </select>

            {/* Priority Filter */}
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              className="h-8 rounded-lg border border-input bg-background px-2 text-xs outline-none"
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
                className="h-8 text-xs text-muted-foreground hover:text-foreground"
              >
                Reset filters
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Notes Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">
          <Loader2 className="h-6 w-6 animate-spin mr-2" /> Loading notes & reminders…
        </div>
      ) : filteredNotes.length === 0 ? (
        <div className="text-center py-16 rounded-2xl border border-dashed border-border p-8 space-y-3 bg-muted/10">
          <StickyNote className="h-10 w-10 mx-auto text-amber-500/40" />
          <h3 className="text-sm font-semibold text-foreground">No notes found</h3>
          <p className="text-xs text-muted-foreground max-w-sm mx-auto">
            {search || categoryFilter !== 'ALL' || priorityFilter !== 'ALL'
              ? 'No notes match your current filters. Try changing or resetting them.'
              : 'You have no notes in this view. Click "New Note / Reminder" to create one.'}
          </p>
          <Button size="sm" onClick={openCreateModal} className="bg-amber-600 hover:bg-amber-700 text-white text-xs">
            <Plus className="h-3.5 w-3.5 mr-1" /> Add New Note
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredNotes.map((n) => {
            const isDone = n.status === 'COMPLETED';
            const colorTheme = COLOR_MAP[n.color ?? 'amber'] ?? COLOR_MAP.amber;
            const priorityMeta = PRIORITY_META[n.priority] ?? PRIORITY_META.MEDIUM;

            const d = n.reminderDate ? daysUntil(n.reminderDate) : null;
            const whenText =
              d !== null
                ? d < 0
                  ? `${Math.abs(d)}d overdue`
                  : d === 0
                  ? 'Due Today'
                  : d === 1
                  ? 'Due Tomorrow'
                  : `In ${d} days`
                : null;

            return (
              <div
                key={n.id}
                className={cn(
                  'rounded-2xl border p-4 space-y-3 flex flex-col justify-between transition-all duration-150 relative shadow-sm',
                  colorTheme.bg,
                  colorTheme.border,
                  isDone && 'opacity-75 bg-muted/40 border-border/80'
                )}
              >
                <div className="space-y-2.5">
                  {/* Card Top Row: Checkbox, Title, Pin, Actions */}
                  <div className="flex items-start gap-2.5 justify-between">
                    <div className="flex items-start gap-2 flex-1 min-w-0">
                      {/* 1-Click Done Toggle Button */}
                      <button
                        type="button"
                        onClick={() => toggleStatusMutation.mutate(n.id)}
                        disabled={toggleStatusMutation.isPending}
                        title={isDone ? 'Mark as Pending' : 'Mark as Done'}
                        className={cn(
                          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors',
                          isDone
                            ? 'border-emerald-600 bg-emerald-600 text-white'
                            : 'border-muted-foreground/40 hover:border-emerald-600 hover:bg-emerald-500/10'
                        )}
                      >
                        {isDone && <Check className="h-3.5 w-3.5 stroke-[3]" />}
                      </button>

                      <div className="min-w-0 flex-1">
                        {n.title ? (
                          <h3
                            className={cn(
                              'font-bold text-sm text-foreground truncate',
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
                          <Pin className="h-3.5 w-3.5 text-amber-600 fill-amber-600" />
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
                          if (confirm('Are you sure you want to delete this note?')) {
                            deleteMutation.mutate(n.id);
                          }
                        }}
                        className="p-1 rounded-md text-muted-foreground hover:text-rose-600 hover:bg-rose-500/10 transition-colors"
                        title="Delete note"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Badges Row */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0', priorityMeta.badge)}>
                      {priorityMeta.label}
                    </Badge>
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 uppercase">
                      {n.category}
                    </Badge>
                    {n.isReminder && n.reminderDate && (
                      <Badge
                        variant={!isDone && d !== null && d <= 0 ? 'destructive' : 'secondary'}
                        className="text-[10px] px-1.5 py-0 flex items-center gap-1"
                      >
                        <Calendar className="h-2.5 w-2.5" />
                        {shortDate(n.reminderDate)} {whenText ? `(${whenText})` : ''}
                      </Badge>
                    )}
                  </div>

                  {/* Note Content */}
                  <p
                    className={cn(
                      'text-xs text-foreground/90 whitespace-pre-wrap rounded-xl bg-background/60 p-3 border border-border/50 font-sans',
                      isDone && 'text-muted-foreground line-through bg-muted/20'
                    )}
                  >
                    {n.content}
                  </p>
                </div>

                {/* Footer Meta */}
                <div className="pt-2 border-t border-border/40 text-[11px] text-muted-foreground space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span>By {n.userName}</span>
                    <span>{shortDate(n.createdAt)}</span>
                  </div>

                  {/* Page link context if created on another page */}
                  {n.pageLabel && n.pagePath && (
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Tag className="h-2.5 w-2.5 text-amber-600" /> Attached to:{' '}
                      <Link
                        to={n.pagePath}
                        className="text-amber-600 dark:text-amber-400 hover:underline font-medium inline-flex items-center gap-0.5"
                      >
                        {n.pageLabel} <ExternalLink className="h-2.5 w-2.5" />
                      </Link>
                    </div>
                  )}

                  {/* Completed info banner */}
                  {isDone && (
                    <div className="flex items-center gap-1 text-[10.5px] font-medium text-emerald-600 dark:text-emerald-400 pt-0.5">
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

      {/* Create / Edit Dialog Modal */}
      <Dialog open={createOpen || Boolean(editingNote)} onOpenChange={(v) => !v && (setCreateOpen(false), setEditingNote(null))}>
        <DialogContent className="sm:max-w-lg border-border">
          <form onSubmit={handleSave} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{editingNote ? 'Edit Note / Reminder' : 'New Note / Reminder'}</DialogTitle>
              <DialogDescription>
                Write comments, track to-dos, or set reminders that alert on login.
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
                      'py-1.5 px-2 rounded-lg text-xs font-medium border text-center transition-all',
                      category === cat
                        ? 'border-amber-500 bg-amber-500/15 text-amber-700 dark:text-amber-300 font-semibold'
                        : 'border-border bg-card text-muted-foreground hover:bg-muted'
                    )}
                  >
                    {cat === 'NOTE' ? 'Note' : cat === 'REMINDER' ? 'Reminder' : cat === 'TODO' ? 'To-Do' : 'Comment'}
                  </button>
                ))}
              </div>
            </div>

            {/* Title (optional) */}
            <div className="space-y-1.5">
              <Label htmlFor="dlg-title" className="text-xs font-semibold">
                Title <span className="text-muted-foreground font-normal">(Optional)</span>
              </Label>
              <Input
                id="dlg-title"
                placeholder="e.g. Follow up on CST transport bill"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={150}
                className="h-9 text-sm"
              />
            </div>

            {/* Content (required) */}
            <div className="space-y-1.5">
              <Label htmlFor="dlg-content" className="text-xs font-semibold">
                Note / Comment <span className="text-rose-500">*</span>
              </Label>
              <textarea
                id="dlg-content"
                required
                rows={4}
                placeholder="Enter details, instructions, or notes..."
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="w-full resize-y rounded-lg border border-input bg-background p-2.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </div>

            {/* Priority and Color */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Priority</Label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as UserNotePriority)}
                  className="w-full h-9 rounded-lg border border-input bg-background px-2.5 text-xs outline-none"
                >
                  <option value="LOW">Low</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="HIGH">High</option>
                  <option value="URGENT">Urgent 🔥</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Color Tag</Label>
                <div className="flex items-center gap-2 pt-1.5">
                  {COLOR_OPTIONS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setColor(c.id)}
                      className={cn(
                        'h-6 w-6 rounded-full border-2 transition-all flex items-center justify-center',
                        c.dot,
                        color === c.id ? 'scale-125 border-foreground ring-2 ring-primary/30' : 'border-transparent opacity-70 hover:opacity-100'
                      )}
                      title={c.name}
                    />
                  ))}
                </div>
              </div>
            </div>

            {/* Reminder Date */}
            <div className="rounded-xl border border-border/80 bg-muted/20 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="dlg-toggle-reminder" className="text-xs font-semibold flex items-center gap-1.5 cursor-pointer">
                  <Calendar className="h-3.5 w-3.5 text-amber-500" /> Set Reminder Date
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
                  className="rounded border-input h-4 w-4 accent-amber-600 cursor-pointer"
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
                    Will appear in the login reminder dialog starting on this date until marked done.
                  </p>
                </div>
              )}
            </div>

            {/* Pin checkbox */}
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={pinned}
                  onChange={(e) => setPinned(e.target.checked)}
                  className="rounded border-input h-4 w-4 accent-amber-600"
                />
                <span>Pin this note to top</span>
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
                className="bg-amber-600 hover:bg-amber-700 text-white"
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
