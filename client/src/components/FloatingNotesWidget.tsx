import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  StickyNote,
  Plus,
  Calendar,
  Check,
  Trash2,
  Pin,
  Tag,
  Loader2,
  ArrowRight,
  Clock,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import type { UserNote, UserNoteCategory, UserNotePriority } from '@/lib/types';
import { shortDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const STORAGE_KEY = 'rvp_floating_notes_pos_v3';

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

export default function FloatingNotesWidget({ pageLabel }: { pageLabel: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'create' | 'list'>('create');

  // Form State
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState<UserNoteCategory>('NOTE');
  const [priority, setPriority] = useState<UserNotePriority>('MEDIUM');
  const [isReminder, setIsReminder] = useState(false);
  const [reminderDate, setReminderDate] = useState('');
  const [pinned, setPinned] = useState(false);

  // Dragging State
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; initialX: number; initialY: number; moved: boolean }>({
    startX: 0,
    startY: 0,
    initialX: 0,
    initialY: 0,
    moved: false,
  });
  const widgetRef = useRef<HTMLDivElement>(null);

  // Initialize position from localStorage or default to bottom-right
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          const clampedX = Math.max(16, Math.min(window.innerWidth - 60, parsed.x));
          const clampedY = Math.max(16, Math.min(window.innerHeight - 60, parsed.y));
          setPosition({ x: clampedX, y: clampedY });
          return;
        }
      }
    } catch {
      /* ignore */
    }
    // Default fallback position
    setPosition({
      x: window.innerWidth - 64,
      y: window.innerHeight - 76,
    });
  }, []);

  // Handle window resizing
  useEffect(() => {
    const handleResize = () => {
      setPosition((prev) => {
        if (!prev) return null;
        return {
          x: Math.max(16, Math.min(window.innerWidth - 60, prev.x)),
          y: Math.max(16, Math.min(window.innerHeight - 60, prev.y)),
        };
      });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Fetch active notes
  const { data: notes, isLoading } = useQuery({
    queryKey: ['user-notes', 'PENDING'],
    queryFn: () => api<UserNote[]>('/user-notes?status=PENDING'),
    refetchInterval: 30_000,
  });

  const dueNotesCount = (notes ?? []).filter((n) => {
    if (!n.isReminder || !n.reminderDate) return false;
    const d = new Date(n.reminderDate);
    d.setHours(23, 59, 59, 999);
    return d.getTime() <= Date.now() + 86400000;
  }).length;

  const activeNotesCount = notes?.length ?? 0;

  // Create Note Mutation
  const createMutation = useMutation({
    mutationFn: (body: any) => api<UserNote>('/user-notes', { method: 'POST', body }),
    onSuccess: () => {
      toast.success(isReminder ? 'Reminder created' : 'Note saved');
      qc.invalidateQueries({ queryKey: ['user-notes'] });
      qc.invalidateQueries({ queryKey: ['due-user-notes'] });
      // Reset form
      setTitle('');
      setContent('');
      setIsReminder(false);
      setReminderDate('');
      setCategory('NOTE');
      setPriority('MEDIUM');
      setPinned(false);
      setOpen(false);
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  // Toggle Done Mutation
  const toggleStatusMutation = useMutation({
    mutationFn: (id: string) => api<UserNote>(`/user-notes/${id}/toggle-status`, { method: 'PATCH' }),
    onSuccess: (updated) => {
      toast.success(updated.status === 'COMPLETED' ? 'Marked as completed' : 'Marked as pending');
      qc.invalidateQueries({ queryKey: ['user-notes'] });
      qc.invalidateQueries({ queryKey: ['due-user-notes'] });
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  // Delete Note Mutation
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/user-notes/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Note removed');
      qc.invalidateQueries({ queryKey: ['user-notes'] });
      qc.invalidateQueries({ queryKey: ['due-user-notes'] });
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  // Pointer drag handlers
  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (!position) return;

    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialX: position.x,
      initialY: position.y,
      moved: false,
    };
    setIsDragging(true);

    const onPointerMove = (moveEv: PointerEvent) => {
      const dx = moveEv.clientX - dragRef.current.startX;
      const dy = moveEv.clientY - dragRef.current.startY;

      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        dragRef.current.moved = true;
      }

      const nextX = Math.max(16, Math.min(window.innerWidth - 60, dragRef.current.initialX + dx));
      const nextY = Math.max(16, Math.min(window.innerHeight - 60, dragRef.current.initialY + dy));

      setPosition({ x: nextX, y: nextY });
    };

    const onPointerUp = () => {
      setIsDragging(false);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);

      setPosition((finalPos) => {
        if (finalPos) {
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(finalPos));
          } catch {
            /* ignore */
          }
        }
        return finalPos;
      });
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const handleWidgetClick = useCallback(() => {
    if (dragRef.current.moved) {
      dragRef.current.moved = false;
      return;
    }
    setOpen(true);
  }, []);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = content.trim();
    if (!trimmed) {
      toast.error('Please enter note content');
      return;
    }

    createMutation.mutate({
      title: title.trim() || null,
      content: trimmed,
      category,
      priority,
      isReminder: isReminder || category === 'REMINDER' || Boolean(reminderDate),
      reminderDate: (isReminder || category === 'REMINDER') && reminderDate ? new Date(reminderDate).toISOString() : null,
      pinned,
      pagePath: location.pathname,
      pageLabel,
    });
  };

  if (!position) return null;

  return (
    <>
      {/* ── Professional Draggable Floating Action Button ── */}
      <div
        ref={widgetRef}
        data-support-exclude="true"
        onPointerDown={handlePointerDown}
        onClick={handleWidgetClick}
        style={{
          position: 'fixed',
          left: `${position.x}px`,
          top: `${position.y}px`,
          touchAction: 'none',
          zIndex: 9999,
        }}
        title="Notes & Reminders"
        aria-label="Notes & Reminders"
        className={cn(
          'group flex h-11 w-11 items-center justify-center rounded-xl cursor-grab active:cursor-grabbing select-none',
          'border border-border/90 bg-card/95 text-foreground shadow-md backdrop-blur-md',
          'transition-all duration-150 hover:border-primary/60 hover:shadow-lg hover:text-primary',
          isDragging && 'scale-105 border-primary shadow-xl opacity-95'
        )}
      >
        <div className="relative flex items-center justify-center">
          <StickyNote className="h-5 w-5 text-primary transition-transform group-hover:scale-105" />
          {dueNotesCount > 0 ? (
            <span className="absolute -top-2.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9.5px] font-mono font-bold text-destructive-foreground ring-2 ring-card">
              {dueNotesCount}
            </span>
          ) : activeNotesCount > 0 ? (
            <span className="absolute -top-2.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9.5px] font-mono font-bold text-primary-foreground ring-2 ring-card">
              {activeNotesCount}
            </span>
          ) : null}
        </div>
      </div>

      {/* ── Modal Dialog ── */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-support-exclude="true" className="sm:max-w-lg p-0 gap-0 overflow-hidden">
          <DialogHeader className="p-5 pb-3 border-b border-border/80 bg-muted/20">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/20">
                  <StickyNote className="h-4 w-4" />
                </div>
                <div>
                  <DialogTitle className="text-base font-semibold">Notes & Reminders</DialogTitle>
                  <DialogDescription className="text-xs">
                    Quick note or scheduled reminder
                  </DialogDescription>
                </div>
              </div>

              <div className="flex items-center gap-1 bg-muted p-0.5 rounded-lg text-xs mr-6">
                <button
                  type="button"
                  onClick={() => setActiveTab('create')}
                  className={cn(
                    'px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                    activeTab === 'create'
                      ? 'bg-card text-foreground shadow-xs font-semibold'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Plus className="h-3 w-3 inline mr-1" /> New
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('list')}
                  className={cn(
                    'px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                    activeTab === 'list'
                      ? 'bg-card text-foreground shadow-xs font-semibold'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  Active ({activeNotesCount})
                </button>
              </div>
            </div>
          </DialogHeader>

          {activeTab === 'create' ? (
            <form onSubmit={handleSave} className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
              {/* Context Tag */}
              <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Tag className="h-3 w-3 text-primary" /> Current page:
                </span>
                <span className="font-medium text-foreground truncate max-w-[220px]">
                  {pageLabel}
                </span>
              </div>

              {/* Type Selector */}
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

              {/* Optional Title */}
              <div className="space-y-1.5">
                <Label htmlFor="quick-note-title" className="text-xs font-semibold">
                  Title <span className="text-muted-foreground font-normal">(Optional)</span>
                </Label>
                <Input
                  id="quick-note-title"
                  placeholder="e.g. Follow up on payment or weights"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={150}
                  className="h-9 text-xs"
                />
              </div>

              {/* Content */}
              <div className="space-y-1.5">
                <Label htmlFor="quick-note-content" className="text-xs font-semibold">
                  Note <span className="text-destructive">*</span>
                </Label>
                <textarea
                  id="quick-note-content"
                  required
                  rows={3}
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
                  <Label htmlFor="quick-toggle-reminder" className="text-xs font-semibold flex items-center gap-1.5 cursor-pointer">
                    <Calendar className="h-3.5 w-3.5 text-primary" /> Schedule Reminder
                  </Label>
                  <input
                    id="quick-toggle-reminder"
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
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    navigate('/notes-comments');
                  }}
                  className="text-xs text-primary hover:underline flex items-center gap-1"
                >
                  All notes <ArrowRight className="h-3 w-3" />
                </button>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
                <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={createMutation.isPending}
                >
                  {createMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
                  Save
                </Button>
              </div>
            </form>
          ) : (
            /* ── Active Notes Tab ── */
            <div className="p-4 space-y-3 max-h-[75vh] overflow-y-auto">
              <div className="flex items-center justify-between text-xs text-muted-foreground pb-1">
                <span>{activeNotesCount} active items</span>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    navigate('/notes-comments');
                  }}
                  className="text-xs text-primary hover:underline flex items-center gap-1"
                >
                  Open Notes Page <ArrowRight className="h-3 w-3" />
                </button>
              </div>

              {isLoading ? (
                <div className="flex items-center justify-center py-10 text-muted-foreground text-xs">
                  <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
                </div>
              ) : activeNotesCount === 0 ? (
                <div className="text-center py-10 space-y-2">
                  <StickyNote className="h-6 w-6 mx-auto text-muted-foreground/50" />
                  <p className="text-xs text-muted-foreground">No active notes.</p>
                  <Button size="sm" variant="outline" onClick={() => setActiveTab('create')} className="text-xs">
                    <Plus className="h-3.5 w-3.5 mr-1" /> Add Note
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  {notes?.map((n) => (
                    <div
                      key={n.id}
                      className="rounded-xl border border-border bg-card p-3 space-y-2 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {n.pinned && <Pin className="h-3 w-3 text-primary" />}
                            {n.title ? (
                              <h4 className="font-semibold text-xs text-foreground truncate">{n.title}</h4>
                            ) : (
                              <Badge variant="outline" className="text-[10px] py-0 uppercase">
                                {n.category}
                              </Badge>
                            )}
                            {n.isReminder && n.reminderDate && (
                              <Badge variant="secondary" className="text-[10px] py-0 flex items-center gap-0.5">
                                <Clock className="h-2.5 w-2.5" /> {shortDate(n.reminderDate)}
                              </Badge>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => toggleStatusMutation.mutate(n.id)}
                            title="Mark Done"
                            className="h-7 px-2 text-xs text-success border-success/30 hover:bg-success/10"
                          >
                            <Check className="h-3.5 w-3.5 mr-1" /> Done
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => deleteMutation.mutate(n.id)}
                            title="Delete"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>

                      <p className="text-xs text-foreground/90 whitespace-pre-wrap line-clamp-3">
                        {n.content}
                      </p>

                      <div className="flex items-center justify-between text-[10.5px] text-muted-foreground pt-0.5">
                        <span>{n.userName}</span>
                        {n.pageLabel && (
                          <span className="flex items-center gap-0.5 truncate max-w-[150px]">
                            <Tag className="h-2.5 w-2.5" /> {n.pageLabel}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
