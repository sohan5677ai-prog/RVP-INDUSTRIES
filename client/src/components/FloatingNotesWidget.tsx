import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  StickyNote,
  Plus,
  Calendar,
  CheckCircle2,
  ExternalLink,
  Trash2,
  Pin,
  Tag,
  Loader2,
  Clock,
  Sparkles,
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

const STORAGE_KEY = 'rvp_floating_notes_pos_v2';

const COLOR_OPTIONS = [
  { id: 'amber', name: 'Amber', bg: 'bg-amber-500/15 border-amber-500/30 text-amber-900 dark:text-amber-200', dot: 'bg-amber-500' },
  { id: 'sky', name: 'Sky Blue', bg: 'bg-sky-500/15 border-sky-500/30 text-sky-900 dark:text-sky-200', dot: 'bg-sky-500' },
  { id: 'emerald', name: 'Emerald', bg: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-900 dark:text-emerald-200', dot: 'bg-emerald-500' },
  { id: 'purple', name: 'Purple', bg: 'bg-purple-500/15 border-purple-500/30 text-purple-900 dark:text-purple-200', dot: 'bg-purple-500' },
  { id: 'rose', name: 'Rose', bg: 'bg-rose-500/15 border-rose-500/30 text-rose-900 dark:text-rose-200', dot: 'bg-rose-500' },
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
  const [color, setColor] = useState('amber');
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
          const clampedX = Math.max(16, Math.min(window.innerWidth - 76, parsed.x));
          const clampedY = Math.max(16, Math.min(window.innerHeight - 76, parsed.y));
          setPosition({ x: clampedX, y: clampedY });
          return;
        }
      }
    } catch {
      /* ignore */
    }
    // Default fallback position
    setPosition({
      x: window.innerWidth - 76,
      y: window.innerHeight - 90,
    });
  }, []);

  // Handle window resizing to keep inside viewport
  useEffect(() => {
    const handleResize = () => {
      setPosition((prev) => {
        if (!prev) return null;
        return {
          x: Math.max(16, Math.min(window.innerWidth - 76, prev.x)),
          y: Math.max(16, Math.min(window.innerHeight - 76, prev.y)),
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

  // Create Note Mutation
  const createMutation = useMutation({
    mutationFn: (body: any) => api<UserNote>('/user-notes', { method: 'POST', body }),
    onSuccess: () => {
      toast.success(isReminder ? 'Reminder created successfully' : 'Note saved successfully');
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
    if (e.button !== 0) return; // only left click
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

      const nextX = Math.max(16, Math.min(window.innerWidth - 76, dragRef.current.initialX + dx));
      const nextY = Math.max(16, Math.min(window.innerHeight - 76, dragRef.current.initialY + dy));

      setPosition({ x: nextX, y: nextY });
    };

    const onPointerUp = () => {
      setIsDragging(false);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);

      // Save position to localStorage
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
      toast.error('Please type your note or comment');
      return;
    }

    createMutation.mutate({
      title: title.trim() || null,
      content: trimmed,
      category,
      priority,
      isReminder: isReminder || category === 'REMINDER' || Boolean(reminderDate),
      reminderDate: (isReminder || category === 'REMINDER') && reminderDate ? new Date(reminderDate).toISOString() : null,
      color,
      pinned,
      pagePath: location.pathname,
      pageLabel,
    });
  };

  if (!position) return null;

  const activeNotesCount = notes?.length ?? 0;

  return (
    <>
      {/* ── Draggable Floating Action Button ── */}
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
        title="Quick Notes, Comments & Reminders (Drag anywhere)"
        className={cn(
          'group flex h-14 w-14 items-center justify-center rounded-2xl cursor-grab active:cursor-grabbing select-none',
          'bg-gradient-to-br from-amber-500 via-amber-600 to-amber-700 text-white shadow-xl shadow-amber-950/40',
          'ring-2 ring-amber-300/40 hover:ring-amber-300/80 hover:scale-105 transition-all duration-150',
          isDragging && 'scale-110 shadow-2xl opacity-90'
        )}
      >
        <div className="relative flex items-center justify-center">
          <StickyNote className="h-6 w-6 transition-transform group-hover:rotate-6" />
          {dueNotesCount > 0 ? (
            <span className="absolute -top-3 -right-3 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-bold text-white shadow-md animate-pulse ring-2 ring-background">
              {dueNotesCount}
            </span>
          ) : activeNotesCount > 0 ? (
            <span className="absolute -top-3 -right-3 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-900 px-1 text-[10px] font-bold text-amber-100 shadow-md ring-2 ring-background">
              {activeNotesCount}
            </span>
          ) : null}
        </div>
      </div>

      {/* ── Quick Notes & Reminders Modal Dialog ── */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-support-exclude="true" className="sm:max-w-lg p-0 gap-0 overflow-hidden border-border">
          <DialogHeader className="p-5 pb-3 border-b border-border/70 bg-muted/20">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/25">
                  <StickyNote className="h-5 w-5" />
                </span>
                <div>
                  <DialogTitle className="text-base font-semibold">Notes & Reminders</DialogTitle>
                  <DialogDescription className="text-xs">
                    Capture thoughts, comments or set reminders on the fly
                  </DialogDescription>
                </div>
              </div>

              <div className="flex items-center gap-1 bg-muted/70 p-0.5 rounded-lg text-xs mr-6">
                <button
                  type="button"
                  onClick={() => setActiveTab('create')}
                  className={cn(
                    'px-2.5 py-1 rounded-md font-medium transition-colors',
                    activeTab === 'create' ? 'bg-background shadow-xs text-foreground' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Plus className="h-3.5 w-3.5 inline mr-1" /> New
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('list')}
                  className={cn(
                    'px-2.5 py-1 rounded-md font-medium transition-colors',
                    activeTab === 'list' ? 'bg-background shadow-xs text-foreground' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  Active ({activeNotesCount})
                </button>
              </div>
            </div>
          </DialogHeader>

          {activeTab === 'create' ? (
            <form onSubmit={handleSave} className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
              {/* Captured Page Context */}
              <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Tag className="h-3 w-3 text-amber-500" /> Attached page:
                </span>
                <span className="font-medium text-foreground truncate max-w-[240px]">
                  {pageLabel} <span className="text-muted-foreground font-normal">({location.pathname})</span>
                </span>
              </div>

              {/* Category / Type Selector */}
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

              {/* Title (Optional) */}
              <div className="space-y-1.5">
                <Label htmlFor="note-title" className="text-xs font-semibold">
                  Title <span className="text-muted-foreground font-normal">(Optional)</span>
                </Label>
                <Input
                  id="note-title"
                  placeholder="e.g. Call broker about moisture discount"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={150}
                  className="h-9 text-sm"
                />
              </div>

              {/* Note / Comment Content */}
              <div className="space-y-1.5">
                <Label htmlFor="note-content" className="text-xs font-semibold">
                  Note / Details <span className="text-rose-500">*</span>
                </Label>
                <textarea
                  id="note-content"
                  required
                  rows={3}
                  placeholder="Type your note, comment or reminder details here..."
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  className="w-full resize-y rounded-lg border border-input bg-background p-2.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                />
              </div>

              {/* Priority & Color Picker */}
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

              {/* Reminder Date & Time */}
              <div className="rounded-xl border border-border/80 bg-muted/20 p-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="toggle-reminder" className="text-xs font-semibold flex items-center gap-1.5 cursor-pointer">
                    <Calendar className="h-3.5 w-3.5 text-amber-500" /> Set Reminder Date
                  </Label>
                  <input
                    id="toggle-reminder"
                    type="checkbox"
                    checked={isReminder || category === 'REMINDER'}
                    onChange={(e) => {
                      setIsReminder(e.target.checked);
                      if (!e.target.checked && category === 'REMINDER') setCategory('NOTE');
                      if (e.target.checked && !reminderDate) {
                        const today = new Date();
                        setReminderDate(today.toISOString().slice(0, 10));
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
                      Will pop up in your daily reminder list on and after this date until marked done.
                    </p>
                  </div>
                )}
              </div>

              {/* Pinned toggle */}
              <div className="flex items-center justify-between text-xs text-muted-foreground pt-1">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={pinned}
                    onChange={(e) => setPinned(e.target.checked)}
                    className="rounded border-input h-4 w-4 accent-amber-600"
                  />
                  <span>Pin to top of notes list</span>
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setOpen(false);
                    navigate('/notes-comments');
                  }}
                  className="h-7 text-xs text-amber-600 dark:text-amber-400"
                >
                  View all in settings <ExternalLink className="h-3 w-3 ml-1" />
                </Button>
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
                  className="bg-amber-600 hover:bg-amber-700 text-white gap-1.5"
                >
                  {createMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Save Note
                </Button>
              </div>
            </form>
          ) : (
            /* ── Tab 2: Active Notes Quick List ── */
            <div className="p-4 space-y-3 max-h-[75vh] overflow-y-auto">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{notes?.length ?? 0} active notes/reminders</span>
                <Button
                  size="sm"
                  variant="link"
                  onClick={() => {
                    setOpen(false);
                    navigate('/notes-comments');
                  }}
                  className="h-auto p-0 text-xs text-amber-600 dark:text-amber-400"
                >
                  Go to Notes Page <ExternalLink className="h-3 w-3 ml-1" />
                </Button>
              </div>

              {isLoading ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground text-xs">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading notes…
                </div>
              ) : notes?.length === 0 ? (
                <div className="text-center py-10 space-y-2">
                  <Sparkles className="h-8 w-8 mx-auto text-amber-500/40" />
                  <p className="text-xs text-muted-foreground">No active notes right now.</p>
                  <Button size="sm" variant="outline" onClick={() => setActiveTab('create')} className="text-xs">
                    <Plus className="h-3.5 w-3.5 mr-1" /> Add a note
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  {notes?.map((n) => {
                    const colorStyle = COLOR_OPTIONS.find((c) => c.id === n.color) ?? COLOR_OPTIONS[0];

                    return (
                      <div
                        key={n.id}
                        className={cn(
                          'rounded-xl border p-3 space-y-2 transition-all',
                          colorStyle.bg
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {n.pinned && <Pin className="h-3 w-3 text-amber-600 fill-amber-600" />}
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
                              variant="ghost"
                              onClick={() => toggleStatusMutation.mutate(n.id)}
                              title="Mark Done"
                              className="h-7 w-7 p-0 text-emerald-600 hover:bg-emerald-500/20"
                            >
                              <CheckCircle2 className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => deleteMutation.mutate(n.id)}
                              title="Delete"
                              className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-500/20"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>

                        <p className="text-xs text-foreground/90 whitespace-pre-wrap line-clamp-3">
                          {n.content}
                        </p>

                        <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-0.5">
                          <span>By {n.userName}</span>
                          {n.pageLabel && (
                            <span className="flex items-center gap-0.5 truncate max-w-[150px]">
                              <Tag className="h-2.5 w-2.5" /> {n.pageLabel}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
