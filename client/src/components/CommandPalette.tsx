import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  ArrowRight,
  Sparkles,
  Command,
  SunMoon,
  PanelLeft,
  RefreshCw,
  Users,
  ClipboardList,
  ShoppingCart,
  SlidersHorizontal,
  X,
  Plus,
  Loader2,
} from 'lucide-react';
import { useShortcuts } from '@/lib/shortcuts/ShortcutContext';
import { formatKeyDisplay } from '@/lib/shortcuts/shortcutStorage';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface SearchResultItem {
  id: string;
  title: string;
  subtitle?: string;
  category: 'actions' | 'navigation' | 'parties' | 'orders' | 'custom';
  icon: React.ComponentType<{ className?: string }>;
  shortcut?: string[];
  action: () => void;
}

export default function CommandPalette() {
  const {
    commandPaletteOpen,
    setCommandPaletteOpen,
    shortcuts,
  } = useShortcuts();
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dbResults, setDbResults] = useState<{
    parties: any[];
    pos: any[];
    sales: any[];
  }>({ parties: [], pos: [], sales: [] });
  const [searchingDb, setSearchingDb] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Focus input when opened
  useEffect(() => {
    if (commandPaletteOpen) {
      setQuery('');
      setSelectedIndex(0);
      setDbResults({ parties: [], pos: [], sales: [] });
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [commandPaletteOpen]);

  // Live database search with debounce
  useEffect(() => {
    if (!commandPaletteOpen || !query.trim() || query.length < 2) {
      setDbResults({ parties: [], pos: [], sales: [] });
      return;
    }

    const timer = setTimeout(async () => {
      setSearchingDb(true);
      try {
        const [parties, pos, sales] = await Promise.all([
          api<any[]>(`/search?q=${encodeURIComponent(query)}&type=party`).catch(() => []),
          api<any[]>(`/search?q=${encodeURIComponent(query)}&type=po`).catch(() => []),
          api<any[]>(`/search?q=${encodeURIComponent(query)}&type=sale`).catch(() => []),
        ]);
        setDbResults({
          parties: parties.slice(0, 4),
          pos: pos.slice(0, 4),
          sales: sales.slice(0, 4),
        });
      } catch (err) {
        console.error('Palette DB search error:', err);
      } finally {
        setSearchingDb(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [query, commandPaletteOpen]);

  // Build searchable items
  const items: SearchResultItem[] = useMemo(() => {
    const q = query.toLowerCase().trim();
    const result: SearchResultItem[] = [];

    // 1. Built-in actions and navigation from shortcuts registry
    shortcuts.forEach((s) => {
      if (!s.isEnabled) return;
      if (
        !q ||
        s.label.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        (s.targetUrl && s.targetUrl.toLowerCase().includes(q))
      ) {
        let icon = Sparkles;
        if (s.category === 'navigation') icon = ArrowRight;
        if (s.actionType === 'toggle-theme') icon = SunMoon;
        if (s.actionType === 'toggle-sidebar') icon = PanelLeft;
        if (s.actionType === 'refresh') icon = RefreshCw;
        if (s.actionType === 'quick-new') icon = Plus;
        if (s.targetUrl?.includes('parties')) icon = Users;
        if (s.targetUrl?.includes('purchase-orders')) icon = ClipboardList;
        if (s.targetUrl?.includes('sales')) icon = ShoppingCart;
        if (s.targetUrl?.includes('settings')) icon = SlidersHorizontal;

        result.push({
          id: s.id,
          title: s.label,
          subtitle: s.description,
          category: s.category === 'actions' ? 'actions' : s.isCustom ? 'custom' : 'navigation',
          icon,
          shortcut: s.keys,
          action: () => {
            setCommandPaletteOpen(false);
            if (s.targetUrl) {
              navigate(s.targetUrl);
            } else if (s.actionType === 'toggle-theme') {
              window.dispatchEvent(new CustomEvent('rvp:toggle-theme'));
            } else if (s.actionType === 'toggle-sidebar') {
              window.dispatchEvent(new CustomEvent('rvp:toggle-sidebar'));
            } else if (s.actionType === 'refresh') {
              window.location.reload();
            } else if (s.actionType === 'cheat-sheet') {
              window.dispatchEvent(new CustomEvent('rvp:open-cheat-sheet'));
            }
          },
        });
      }
    });

    // 2. Database Parties
    dbResults.parties.forEach((p) => {
      result.push({
        id: `db:party:${p.id}`,
        title: p.name,
        subtitle: `${p.type || 'Party'} ${p.city ? `• ${p.city}` : ''} ${p.phone ? `• 📞 ${p.phone}` : ''}`,
        category: 'parties',
        icon: Users,
        action: () => {
          setCommandPaletteOpen(false);
          navigate(`/accounts/party-ledger?partyId=${p.id}`);
        },
      });
    });

    // 3. Database Purchase Orders
    dbResults.pos.forEach((po) => {
      result.push({
        id: `db:po:${po.id}`,
        title: po.poNumber || `PO #${po.id.slice(0, 6)}`,
        subtitle: `${po.party?.name || 'Supplier'} • ${po.tonnageKg ? `${(po.tonnageKg / 1000).toFixed(1)} MT` : ''} • Status: ${po.status}`,
        category: 'orders',
        icon: ClipboardList,
        action: () => {
          setCommandPaletteOpen(false);
          navigate('/purchase-orders');
        },
      });
    });

    // 4. Database Sales
    dbResults.sales.forEach((s) => {
      result.push({
        id: `db:sale:${s.id}`,
        title: s.buyer?.name || 'Sale Order',
        subtitle: `Dispatches: ${s.dispatches?.length || 0} • Status: ${s.status || 'Active'}`,
        category: 'orders',
        icon: ShoppingCart,
        action: () => {
          setCommandPaletteOpen(false);
          navigate('/sales/pappu');
        },
      });
    });

    return result;
  }, [query, shortcuts, dbResults, navigate, setCommandPaletteOpen]);

  // Adjust selected index if bounds change
  useEffect(() => {
    if (selectedIndex >= items.length) {
      setSelectedIndex(Math.max(0, items.length - 1));
    }
  }, [items.length, selectedIndex]);

  // Scroll active item into view
  useEffect(() => {
    const listEl = listRef.current;
    if (!listEl) return;
    const activeEl = listEl.querySelector(`[data-index="${selectedIndex}"]`);
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  // Keyboard navigation within the palette
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, items.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + items.length) % Math.max(1, items.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[selectedIndex]) {
        items[selectedIndex].action();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setCommandPaletteOpen(false);
    }
  };

  if (!commandPaletteOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4 sm:px-6">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/65 backdrop-blur-sm transition-opacity animate-in fade-in duration-150"
        onClick={() => setCommandPaletteOpen(false)}
      />

      {/* Palette Card */}
      <div
        className="relative w-full max-w-2xl rounded-2xl bg-card border border-border shadow-2xl shadow-black/60 overflow-hidden flex flex-col z-10 animate-in zoom-in-95 duration-150"
        onKeyDown={handleKeyDown}
      >
        {/* Top Search Input Bar */}
        <div className="relative flex items-center px-4 border-b border-border/80 bg-muted/20">
          <Search className="h-5 w-5 text-muted-foreground shrink-0 ml-1" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Type a command, page, party, order, or shortcut..."
            className="w-full px-3 py-4 bg-transparent text-[15px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
          />
          {searchingDb && (
            <Loader2 className="h-4 w-4 text-amber-500 animate-spin shrink-0 mr-2" />
          )}
          {query && (
            <button
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={() => setCommandPaletteOpen(false)}
            className="ml-2 text-xs font-mono px-1.5 py-0.5 rounded border border-border bg-muted/60 text-muted-foreground"
          >
            ESC
          </button>
        </div>

        {/* Results List */}
        <div
          ref={listRef}
          className="max-h-[60vh] overflow-y-auto p-2 divide-y divide-border/30 scroll-py-2"
        >
          {items.length === 0 ? (
            <div className="p-10 text-center text-muted-foreground">
              <Command className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-medium text-foreground">No matching commands or records found</p>
              <p className="text-xs text-muted-foreground mt-1">
                Try searching for "Parties", "Pappu", "PO", "Taxes", or "Theme"
              </p>
            </div>
          ) : (
            items.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              const Icon = item.icon;
              const keyDisplay = item.shortcut
                ? formatKeyDisplay(item.shortcut).displayString
                : null;

              return (
                <div
                  key={item.id}
                  data-index={idx}
                  onClick={item.action}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={cn(
                    'group flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl cursor-pointer text-sm transition-all duration-100',
                    isSelected
                      ? 'bg-amber-500/15 text-amber-900 dark:text-amber-100 font-medium'
                      : 'hover:bg-muted/60 text-foreground'
                  )}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={cn(
                        'flex h-8 w-8 items-center justify-center rounded-lg border transition-colors shrink-0',
                        isSelected
                          ? 'border-amber-400/50 bg-amber-400/20 text-amber-500 dark:text-amber-300'
                          : 'border-border bg-muted/40 text-muted-foreground group-hover:border-foreground/20'
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-[13.5px] font-medium leading-snug">
                        {item.title}
                      </div>
                      {item.subtitle && (
                        <div className="truncate text-xs text-muted-foreground/80 leading-tight">
                          {item.subtitle}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {keyDisplay && (
                      <kbd
                        className={cn(
                          'px-2 py-0.5 text-[11px] font-mono font-medium rounded border shadow-2xs transition-colors',
                          isSelected
                            ? 'bg-amber-500/20 border-amber-400/40 text-amber-700 dark:text-amber-200'
                            : 'bg-muted/80 border-border text-muted-foreground'
                        )}
                      >
                        {keyDisplay}
                      </kbd>
                    )}
                    <span
                      className={cn(
                        'text-[10px] uppercase font-semibold px-2 py-0.5 rounded-full tracking-wider border',
                        item.category === 'actions'
                          ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20'
                          : item.category === 'parties'
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
                          : item.category === 'orders'
                          ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20'
                          : item.category === 'custom'
                          ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
                          : 'bg-muted text-muted-foreground border-border'
                      )}
                    >
                      {item.category}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer Hint Bar */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-muted/40 border-t border-border/80 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-3">
            <span>
              <kbd className="font-mono px-1.5 py-0.5 rounded border border-border bg-card">↑</kbd>{' '}
              <kbd className="font-mono px-1.5 py-0.5 rounded border border-border bg-card">↓</kbd> Navigate
            </span>
            <span>
              <kbd className="font-mono px-1.5 py-0.5 rounded border border-border bg-card">↵</kbd> Select
            </span>
            <span>
              <kbd className="font-mono px-1.5 py-0.5 rounded border border-border bg-card">ESC</kbd> Dismiss
            </span>
          </div>
          <div className="flex items-center gap-1 text-muted-foreground/70">
            <Sparkles className="h-3 w-3 text-amber-400" />
            <span>RVP Universal Command Palette</span>
          </div>
        </div>
      </div>
    </div>
  );
}
