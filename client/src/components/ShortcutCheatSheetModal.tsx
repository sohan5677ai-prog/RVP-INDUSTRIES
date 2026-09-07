import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Keyboard,
  Search,
  SlidersHorizontal,
  X,
  ExternalLink,
  Sparkles,
} from 'lucide-react';
import { useShortcuts } from '@/lib/shortcuts/ShortcutContext';
import { formatKeyDisplay } from '@/lib/shortcuts/shortcutStorage';
import type { ShortcutCategory, ShortcutDefinition } from '@/lib/shortcuts/types';
import { Button } from '@/components/ui/button';

const CATEGORY_NAMES: Record<ShortcutCategory, string> = {
  actions: 'Quick Actions & System',
  navigation: 'Core Navigation',
  purchases: 'Purchases & Stock',
  sales: 'Sales & Dispatches',
  accounts: 'Accounts & Ledgers',
  reports: 'Reports & Transactions',
  custom: 'Custom Shortcuts',
};

const CATEGORY_ORDER: ShortcutCategory[] = [
  'actions',
  'navigation',
  'purchases',
  'sales',
  'accounts',
  'reports',
  'custom',
];

export default function ShortcutCheatSheetModal() {
  const { cheatSheetOpen, setCheatSheetOpen, shortcuts } = useShortcuts();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');

  const groupedShortcuts = useMemo(() => {
    const q = filter.toLowerCase().trim();
    const map = new Map<ShortcutCategory, ShortcutDefinition[]>();

    CATEGORY_ORDER.forEach((cat) => map.set(cat, []));

    shortcuts.forEach((s) => {
      if (!s.isEnabled) return;
      if (
        !q ||
        s.label.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.keys.some((k) => k.toLowerCase().includes(q))
      ) {
        const cat = s.category || 'actions';
        if (!map.has(cat)) map.set(cat, []);
        map.get(cat)!.push(s);
      }
    });

    return map;
  }, [shortcuts, filter]);

  if (!cheatSheetOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 md:p-10">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/65 backdrop-blur-sm transition-opacity animate-in fade-in duration-150"
        onClick={() => setCheatSheetOpen(false)}
      />

      {/* Modal Dialog Card */}
      <div className="relative w-full max-w-4xl max-h-[85vh] rounded-2xl bg-card border border-border shadow-2xl shadow-black/60 overflow-hidden flex flex-col z-10 animate-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/80 bg-muted/20">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-500">
              <Keyboard className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
                Keyboard Shortcuts Cheat Sheet
                <span className="text-[11px] font-normal px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                  Quick Reference
                </span>
              </h2>
              <p className="text-xs text-muted-foreground">
                Press keys directly from anywhere in the ERP to trigger actions
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setCheatSheetOpen(false);
                navigate('/settings?tab=shortcuts');
              }}
              className="gap-1.5 text-xs text-amber-600 dark:text-amber-400 border-amber-500/30 hover:bg-amber-500/10"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span>Customize in Settings</span>
              <ExternalLink className="h-3 w-3" />
            </Button>
            <button
              onClick={() => setCheatSheetOpen(false)}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Filter Input */}
        <div className="px-6 py-3 border-b border-border/60 bg-card">
          <div className="relative flex items-center">
            <Search className="h-4 w-4 text-muted-foreground absolute left-3" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search shortcuts by name, action or key..."
              className="w-full pl-9 pr-4 py-2 text-xs rounded-xl bg-muted/40 border border-border/80 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-amber-500/50"
            />
            {filter && (
              <button
                onClick={() => setFilter('')}
                className="absolute right-3 p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Shortcuts Directory Grid */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {Array.from(groupedShortcuts.entries())
            .filter(([_, list]) => list.length > 0)
            .map(([category, list]) => (
              <div key={category} className="space-y-3">
                <div className="flex items-center gap-2 pb-1 border-b border-border/50">
                  <span className="text-[11.5px] font-bold uppercase tracking-wider text-muted-foreground">
                    {CATEGORY_NAMES[category] || category}
                  </span>
                  <span className="text-[10px] px-1.5 py-0.2 text-muted-foreground/80 rounded bg-muted">
                    {list.length}
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                  {list.map((s) => {
                    const { parts, isSequence } = formatKeyDisplay(s.keys);

                    return (
                      <div
                        key={s.id}
                        className="flex items-center justify-between gap-3 p-2.5 rounded-xl border border-border/70 bg-card/60 hover:bg-muted/40 hover:border-amber-500/30 transition-all duration-150"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-foreground truncate">
                            {s.label}
                          </div>
                          <div className="text-[10.5px] text-muted-foreground truncate">
                            {s.description}
                          </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          {parts.map((p, pIdx) => (
                            <span key={pIdx} className="flex items-center gap-1">
                              {pIdx > 0 && (
                                <span className="text-[10px] text-muted-foreground/60 font-mono">
                                  {isSequence ? 'then' : '+'}
                                </span>
                              )}
                              <kbd className="min-w-6 px-2 py-1 text-[11px] font-mono font-semibold text-center rounded-md border border-border/90 bg-muted/80 text-foreground shadow-2xs">
                                {p}
                              </kbd>
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-border/80 bg-muted/30 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-amber-500" />
            <span>Pro tip: Press <kbd className="font-mono px-1 rounded border bg-card">Ctrl</kbd> + <kbd className="font-mono px-1 rounded border bg-card">K</kbd> anytime to open the Command Palette</span>
          </div>
          <div>
            <span>Press <kbd className="font-mono px-1 rounded border bg-card">ESC</kbd> to close</span>
          </div>
        </div>
      </div>
    </div>
  );
}
