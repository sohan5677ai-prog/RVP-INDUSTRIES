import { useState, useMemo, useRef, useEffect } from 'react';
import {
  Keyboard,
  Search,
  Plus,
  RotateCcw,
  Download,
  Upload,
  Sparkles,
  AlertTriangle,
  Check,
  X,
  SlidersHorizontal,
  Trash2,
  HelpCircle,
  Pencil,
} from 'lucide-react';
import { useShortcuts } from '@/lib/shortcuts/ShortcutContext';
import {
  formatKeyDisplay,
  checkShortcutConflict,
} from '@/lib/shortcuts/shortcutStorage';
import type {
  ShortcutCategory,
  ShortcutDefinition,
} from '@/lib/shortcuts/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const CATEGORY_NAMES: Record<ShortcutCategory, string> = {
  actions: 'Quick Actions & System',
  navigation: 'Core Navigation',
  purchases: 'Purchases & Stock',
  sales: 'Sales & Dispatches',
  accounts: 'Accounts & Ledgers',
  reports: 'Reports & Transactions',
  custom: 'Custom User Shortcuts',
};

const CATEGORIES: { id: ShortcutCategory | 'all'; label: string }[] = [
  { id: 'all', label: 'All Shortcuts' },
  { id: 'actions', label: 'Actions & Tools' },
  { id: 'navigation', label: 'Navigation' },
  { id: 'purchases', label: 'Purchases & Stock' },
  { id: 'sales', label: 'Sales & Dispatches' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'reports', label: 'Reports' },
  { id: 'custom', label: 'Custom Shortcuts' },
];

export default function KeyboardShortcutsSection() {
  const {
    shortcuts,
    preferences,
    updateShortcutKeys,
    toggleShortcutEnabled,
    resetShortcut,
    resetAllShortcuts,
    addCustomShortcut,
    deleteCustomShortcut,
    importPreferences,
    exportPreferences,
    updatePreferences,
    toggleCommandPalette,
    toggleCheatSheet,
  } = useShortcuts();

  const [activeCategory, setActiveCategory] = useState<ShortcutCategory | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Recorder Modal State
  const [recordingShortcut, setRecordingShortcut] = useState<ShortcutDefinition | null>(null);
  const [recordedKeys, setRecordedKeys] = useState<string[]>([]);
  const [isRecording, setIsRecording] = useState(false);

  // Add Custom Shortcut Modal State
  const [isAddCustomOpen, setIsAddCustomOpen] = useState(false);
  const [customForm, setCustomForm] = useState<{
    label: string;
    targetUrl: string;
    description: string;
    category: ShortcutCategory;
    keys: string[];
  }>({
    label: '',
    targetUrl: '/',
    description: '',
    category: 'custom',
    keys: ['Alt', 'x'],
  });

  // File import ref
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Filtered list
  const filteredShortcuts = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return shortcuts.filter((s) => {
      const matchCat = activeCategory === 'all' || s.category === activeCategory;
      if (!matchCat) return false;
      if (!q) return true;
      return (
        s.label.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.keys.some((k) => k.toLowerCase().includes(q)) ||
        (s.targetUrl && s.targetUrl.toLowerCase().includes(q))
      );
    });
  }, [shortcuts, activeCategory, searchQuery]);

  // Conflict detection for current recorded keys
  const conflict = useMemo(() => {
    if (!recordingShortcut || recordedKeys.length === 0) return { hasConflict: false };
    return checkShortcutConflict(recordedKeys, recordingShortcut.id, shortcuts);
  }, [recordingShortcut, recordedKeys, shortcuts]);

  // Start recording keypresses
  const openRecorder = (shortcut: ShortcutDefinition) => {
    setRecordingShortcut(shortcut);
    setRecordedKeys([...shortcut.keys]);
    setIsRecording(true);
  };

  const closeRecorder = () => {
    setRecordingShortcut(null);
    setRecordedKeys([]);
    setIsRecording(false);
  };

  const saveRecorded = () => {
    if (!recordingShortcut) return;
    if (recordedKeys.length === 0) {
      toast.error('Please record at least one key combination.');
      return;
    }

    // If there's a conflict, prompt and reassign
    if (conflict.hasConflict && conflict.conflictingShortcut) {
      updateShortcutKeys(conflict.conflictingShortcut.id, []);
      toast.info(`Unassigned conflicting key from "${conflict.conflictingShortcut.label}"`);
    }

    updateShortcutKeys(recordingShortcut.id, recordedKeys);
    closeRecorder();
  };

  // Recording listener
  useEffect(() => {
    if (!isRecording) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Ignore single modifier presses while holding down
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
        return;
      }

      const keys: string[] = [];
      if (e.ctrlKey || e.metaKey) keys.push('Ctrl');
      if (e.altKey) keys.push('Alt');
      if (e.shiftKey) keys.push('Shift');

      let mainKey = e.key;
      if (mainKey === ' ') mainKey = 'Space';
      else if (mainKey.length === 1) mainKey = mainKey.toLowerCase();

      keys.push(mainKey);
      setRecordedKeys(keys);
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isRecording]);

  // Import JSON handler
  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const parsed = JSON.parse(text);
        importPreferences(parsed);
      } catch (err) {
        toast.error('Invalid configuration file. Please choose a valid JSON export.');
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSaveCustom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customForm.label.trim() || !customForm.targetUrl.trim()) {
      toast.error('Please enter a name and destination route.');
      return;
    }
    if (customForm.keys.length === 0) {
      toast.error('Please specify key combination.');
      return;
    }

    addCustomShortcut({
      label: customForm.label.trim(),
      description: customForm.description.trim() || `Custom route: ${customForm.targetUrl}`,
      category: customForm.category,
      targetUrl: customForm.targetUrl.trim(),
      keys: customForm.keys,
      isEnabled: true,
    });

    setIsAddCustomOpen(false);
    setCustomForm({
      label: '',
      targetUrl: '/',
      description: '',
      category: 'custom',
      keys: ['Alt', 'x'],
    });
  };

  const customizedCount = useMemo(
    () => shortcuts.filter((s) => s.isCustomized).length,
    [shortcuts]
  );
  const customCount = useMemo(
    () => shortcuts.filter((s) => s.isCustom).length,
    [shortcuts]
  );

  return (
    <div className="space-y-6 animate-in fade-in duration-150">
      {/* Top Banner & Quick Controls */}
      <div className="rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/10 via-card to-card p-6 shadow-sm">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <div className="h-9 w-9 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-500">
                <Keyboard className="h-5 w-5" />
              </div>
              <h2 className="text-xl font-display font-semibold tracking-tight text-foreground">
                Custom Keyboard Shortcuts
              </h2>
              <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                Flagship Feature
              </span>
            </div>
            <p className="text-xs sm:text-sm text-muted-foreground max-w-2xl">
              Power users can customize any shortcut in RVP-ERP, create custom bookmarks, and navigate at blazing speeds.
              Changes are saved specifically to your account.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={() => setIsAddCustomOpen(true)}
              className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white font-medium"
            >
              <Plus className="h-4 w-4" />
              <span>Add Custom Shortcut</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={toggleCommandPalette}
              className="gap-1.5"
            >
              <Sparkles className="h-4 w-4 text-amber-500" />
              <span>Command Palette (Ctrl+K)</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={toggleCheatSheet}
              className="gap-1.5"
            >
              <HelpCircle className="h-4 w-4" />
              <span>Cheat Sheet (?)</span>
            </Button>
          </div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6 pt-5 border-t border-border/80 text-xs">
          <div className="p-3 rounded-xl bg-card/70 border border-border/60">
            <div className="text-muted-foreground">Total Shortcuts</div>
            <div className="text-lg font-bold text-foreground mt-0.5">{shortcuts.length}</div>
          </div>
          <div className="p-3 rounded-xl bg-card/70 border border-border/60">
            <div className="text-muted-foreground">Customized by You</div>
            <div className="text-lg font-bold text-amber-500 mt-0.5">{customizedCount}</div>
          </div>
          <div className="p-3 rounded-xl bg-card/70 border border-border/60">
            <div className="text-muted-foreground">Custom Bookmarks</div>
            <div className="text-lg font-bold text-blue-500 mt-0.5">{customCount}</div>
          </div>
          <div className="p-3 rounded-xl bg-card/70 border border-border/60 flex items-center justify-between">
            <div>
              <div className="text-muted-foreground">Config Backup</div>
              <div className="text-xs text-muted-foreground/80 mt-0.5">Export / Import</div>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                title="Export shortcuts as JSON"
                onClick={exportPreferences}
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
              >
                <Download className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title="Import shortcuts JSON"
                onClick={() => fileInputRef.current?.click()}
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
              >
                <Upload className="h-4 w-4" />
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                onChange={handleImportFile}
                className="hidden"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={cn(
                'px-3 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap transition-colors',
                activeCategory === cat.id
                  ? 'bg-amber-500 text-white shadow-xs'
                  : 'bg-muted/70 text-muted-foreground hover:text-foreground hover:bg-muted'
              )}
            >
              {cat.label}
            </button>
          ))}
        </div>

        <div className="relative flex items-center min-w-[240px]">
          <Search className="h-4 w-4 text-muted-foreground absolute left-3 pointer-events-none" />
          <Input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search shortcuts or keys..."
            className="pl-9 h-9 text-xs"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Shortcuts Table Card */}
      <Card className="border border-border/80 shadow-xs overflow-hidden">
        <CardHeader className="py-4 px-6 border-b border-border/80 bg-muted/20 flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-sm font-semibold">Configured Shortcuts</CardTitle>
            <CardDescription className="text-xs">
              Showing {filteredShortcuts.length} of {shortcuts.length} shortcuts
            </CardDescription>
          </div>

          {customizedCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (window.confirm('Reset all customized shortcuts back to factory defaults?')) {
                  resetAllShortcuts();
                }
              }}
              className="gap-1.5 text-xs text-rose-500 border-rose-500/30 hover:bg-rose-500/10"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Reset All to Defaults</span>
            </Button>
          )}
        </CardHeader>

        <div className="divide-y divide-border/60 overflow-x-auto">
          {filteredShortcuts.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground text-sm">
              No shortcuts found matching "{searchQuery}".
            </div>
          ) : (
            filteredShortcuts.map((s) => {
              const { parts, isSequence } = formatKeyDisplay(s.keys);

              return (
                <div
                  key={s.id}
                  className={cn(
                    'flex items-center justify-between gap-4 px-6 py-3.5 hover:bg-muted/30 transition-colors',
                    !s.isEnabled && 'opacity-50'
                  )}
                >
                  {/* Left info */}
                  <div className="min-w-0 max-w-md">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground truncate">
                        {s.label}
                      </span>
                      {s.isCustom && (
                        <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                          Custom
                        </span>
                      )}
                      {s.isCustomized && (
                        <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                          Modified
                        </span>
                      )}
                      <span className="text-[10.5px] text-muted-foreground/70 hidden md:inline">
                        • {CATEGORY_NAMES[s.category] || s.category}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {s.description}
                      {s.targetUrl && (
                        <span className="text-muted-foreground/60 ml-1 font-mono">
                          ({s.targetUrl})
                        </span>
                      )}
                    </p>
                  </div>

                  {/* Right: Key Display & Actions */}
                  <div className="flex items-center gap-3 shrink-0">
                    {/* Key Badges */}
                    <button
                      onClick={() => openRecorder(s)}
                      title="Click to re-record this key combination"
                      className="group flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border bg-card hover:border-amber-500/50 hover:bg-amber-500/10 transition-all cursor-pointer shadow-2xs"
                    >
                      {s.keys.length === 0 ? (
                        <span className="text-xs text-muted-foreground italic font-mono">
                          Unassigned (Click to set)
                        </span>
                      ) : (
                        parts.map((p, pIdx) => (
                          <span key={pIdx} className="flex items-center gap-1">
                            {pIdx > 0 && (
                              <span className="text-[10px] text-muted-foreground/60 font-mono">
                                {isSequence ? 'then' : '+'}
                              </span>
                            )}
                            <kbd className="min-w-6 px-1.5 py-0.5 text-xs font-mono font-semibold text-center rounded bg-muted/80 text-foreground border border-border shadow-xs group-hover:border-amber-400/50">
                              {p}
                            </kbd>
                          </span>
                        ))
                      )}
                      <Pencil className="h-3 w-3 ml-1 text-muted-foreground opacity-40 group-hover:opacity-100 group-hover:text-amber-500" />
                    </button>

                    {/* Enable / Disable Switch */}
                    <button
                      type="button"
                      onClick={() => toggleShortcutEnabled(s.id)}
                      title={s.isEnabled ? 'Disable shortcut' : 'Enable shortcut'}
                      className={cn(
                        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none',
                        s.isEnabled ? 'bg-amber-500' : 'bg-muted-foreground/30'
                      )}
                    >
                      <span
                        className={cn(
                          'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
                          s.isEnabled ? 'translate-x-4' : 'translate-x-0'
                        )}
                      />
                    </button>

                    {/* Reset to Default */}
                    {s.isCustomized && !s.isCustom && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Reset to default keybinding"
                        onClick={() => resetShortcut(s.id)}
                        className="h-8 w-8 text-muted-foreground hover:text-amber-500"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    )}

                    {/* Delete Custom */}
                    {s.isCustom && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Delete custom shortcut"
                        onClick={() => deleteCustomShortcut(s.id)}
                        className="h-8 w-8 text-rose-500 hover:bg-rose-500/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </Card>

      {/* Engine Settings & Preferences Card */}
      <Card className="border border-border/80">
        <CardHeader className="py-4 px-6 border-b border-border/80 bg-muted/10">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-amber-500" />
            <span>Shortcuts Engine Preferences</span>
          </CardTitle>
          <CardDescription className="text-xs">
            Fine-tune how keyboard shortcuts react and notify you
          </CardDescription>
        </CardHeader>
        <CardContent className="p-6 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-foreground">
                Visual HUD Toast Indicator
              </div>
              <div className="text-xs text-muted-foreground">
                Display a subtle floating badge at the bottom-right confirming the action when a key is pressed.
              </div>
            </div>
            <button
              type="button"
              onClick={() =>
                updatePreferences({
                  showHudNotification: !preferences.showHudNotification,
                })
              }
              className={cn(
                'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none',
                preferences.showHudNotification ? 'bg-amber-500' : 'bg-muted-foreground/30'
              )}
            >
              <span
                className={cn(
                  'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
                  preferences.showHudNotification ? 'translate-x-4' : 'translate-x-0'
                )}
              />
            </button>
          </div>

          <div className="pt-3 border-t border-border/60 flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-foreground">
                Sequence Chord Timeout
              </div>
              <div className="text-xs text-muted-foreground">
                Time allowed between pressing the first key and second key in chords like (g then d).
              </div>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={preferences.sequenceTimeoutMs}
                onChange={(e) =>
                  updatePreferences({ sequenceTimeoutMs: Number(e.target.value) })
                }
                className="h-8 px-2 text-xs rounded-lg border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-amber-500"
              >
                <option value={750}>Fast (750 ms)</option>
                <option value={1000}>Normal (1000 ms)</option>
                <option value={1500}>Relaxed (1500 ms)</option>
                <option value={2000}>Generous (2000 ms)</option>
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Key Recorder Modal ──────────────────────────────────────────────── */}
      {isRecording && recordingShortcut && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-black/65 backdrop-blur-sm transition-opacity"
            onClick={closeRecorder}
          />
          <div className="relative w-full max-w-md rounded-2xl bg-card border border-border shadow-2xl p-6 z-10 space-y-5 animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="h-8 w-8 rounded-lg bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-500">
                  <Keyboard className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">
                    Record Key Combination
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    For: <span className="text-foreground font-medium">{recordingShortcut.label}</span>
                  </p>
                </div>
              </div>
              <button
                onClick={closeRecorder}
                className="p-1 rounded-md text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Live Key Recorder Display */}
            <div className="p-6 rounded-xl border-2 border-dashed border-amber-500/40 bg-amber-500/5 text-center space-y-3">
              <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
                Press your desired key combination now
              </div>
              <div className="min-h-12 flex items-center justify-center gap-2 flex-wrap">
                {recordedKeys.length === 0 ? (
                  <span className="text-sm text-muted-foreground/60 italic animate-pulse">
                    Waiting for keystrokes...
                  </span>
                ) : (
                  formatKeyDisplay(recordedKeys).parts.map((p, idx) => (
                    <kbd
                      key={idx}
                      className="px-3 py-1.5 text-base font-mono font-bold rounded-lg border-2 border-amber-500/60 bg-card text-foreground shadow-md animate-in zoom-in-90 duration-100"
                    >
                      {p}
                    </kbd>
                  ))
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Supports combinations like <kbd className="font-mono px-1 rounded border">Ctrl</kbd> + <kbd className="font-mono px-1 rounded border">Shift</kbd> + <kbd className="font-mono px-1 rounded border">P</kbd> or <kbd className="font-mono px-1 rounded border">Alt</kbd> + <kbd className="font-mono px-1 rounded border">K</kbd>
              </p>
            </div>

            {/* Conflict Warning */}
            {conflict.hasConflict && conflict.conflictingShortcut && (
              <div className="p-3.5 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300 text-xs flex items-start gap-2.5">
                <AlertTriangle className="h-4 w-4 shrink-0 text-rose-500 mt-0.5" />
                <div>
                  <div className="font-semibold">Shortcut Conflict Detected</div>
                  <div className="mt-0.5 opacity-90">
                    This key is already used by{' '}
                    <span className="font-semibold underline">
                      {conflict.conflictingShortcut.label}
                    </span>
                    . Saving will reassign this key.
                  </div>
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex items-center justify-between pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setRecordedKeys([])}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Clear Keys
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={closeRecorder}
                  className="text-xs"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={saveRecorded}
                  className="text-xs bg-amber-600 hover:bg-amber-700 text-white gap-1.5"
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>Save Combination</span>
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Custom Shortcut Modal ───────────────────────────────────────── */}
      {isAddCustomOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-black/65 backdrop-blur-sm transition-opacity"
            onClick={() => setIsAddCustomOpen(false)}
          />
          <div className="relative w-full max-w-lg rounded-2xl bg-card border border-border shadow-2xl p-6 z-10 space-y-5 animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-border/80 pb-4">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-500">
                  <Plus className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">
                    Create Custom Shortcut
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Map any ERP route or query URL to your favorite hotkey
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsAddCustomOpen(false)}
                className="p-1 rounded-md text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSaveCustom} className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Shortcut Name / Label</Label>
                <Input
                  required
                  placeholder="e.g. Pending Pappu Dispatches"
                  value={customForm.label}
                  onChange={(e) => setCustomForm({ ...customForm, label: e.target.value })}
                  className="h-9 text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Target Route / URL</Label>
                <Input
                  required
                  placeholder="e.g. /sales/pappu?status=PENDING or /reports/freight-dues"
                  value={customForm.targetUrl}
                  onChange={(e) => setCustomForm({ ...customForm, targetUrl: e.target.value })}
                  className="h-9 text-xs font-mono"
                />
                <p className="text-[11px] text-muted-foreground">
                  Can be any internal route with parameters
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Category</Label>
                  <select
                    value={customForm.category}
                    onChange={(e) =>
                      setCustomForm({
                        ...customForm,
                        category: e.target.value as ShortcutCategory,
                      })
                    }
                    className="w-full h-9 px-3 text-xs rounded-lg border border-border bg-card text-foreground"
                  >
                    <option value="navigation">Navigation</option>
                    <option value="sales">Sales</option>
                    <option value="purchases">Purchases</option>
                    <option value="reports">Reports</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Key Combination</Label>
                  <Input
                    required
                    placeholder="e.g. Alt, p or Ctrl, Shift, S"
                    value={customForm.keys.join(', ')}
                    onChange={(e) =>
                      setCustomForm({
                        ...customForm,
                        keys: e.target.value
                          .split(',')
                          .map((k) => k.trim())
                          .filter(Boolean),
                      })
                    }
                    className="h-9 text-xs font-mono"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Description (Optional)</Label>
                <Input
                  placeholder="Optional notes or context"
                  value={customForm.description}
                  onChange={(e) => setCustomForm({ ...customForm, description: e.target.value })}
                  className="h-9 text-xs"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-border/80">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsAddCustomOpen(false)}
                  className="text-xs"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  className="text-xs bg-amber-600 hover:bg-amber-700 text-white font-medium"
                >
                  Create Shortcut
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
