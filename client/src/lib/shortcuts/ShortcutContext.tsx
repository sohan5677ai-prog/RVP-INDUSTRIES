import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from 'next-themes';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import type {
  ShortcutDefinition,
  CustomShortcut,
  UserShortcutPreferences,
} from './types';
import {
  loadUserPreferences,
  saveUserPreferences,
  buildResolvedShortcuts,
  formatKeyDisplay,
  areKeysEqual,
  DEFAULT_PREFERENCES,
  exportShortcutsJson,
} from './shortcutStorage';
import { toast } from 'sonner';

interface ShortcutContextType {
  shortcuts: ShortcutDefinition[];
  preferences: UserShortcutPreferences;
  commandPaletteOpen: boolean;
  cheatSheetOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
  setCheatSheetOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;
  toggleCheatSheet: () => void;
  updateShortcutKeys: (id: string, keys: string[]) => void;
  toggleShortcutEnabled: (id: string, enabled?: boolean) => void;
  resetShortcut: (id: string) => void;
  resetAllShortcuts: () => void;
  addCustomShortcut: (shortcut: Omit<CustomShortcut, 'id' | 'createdAt'>) => void;
  updateCustomShortcut: (id: string, updates: Partial<CustomShortcut>) => void;
  deleteCustomShortcut: (id: string) => void;
  importPreferences: (prefs: UserShortcutPreferences) => void;
  exportPreferences: () => void;
  updatePreferences: (updates: Partial<UserShortcutPreferences>) => void;
}

const ShortcutContext = createContext<ShortcutContextType | undefined>(undefined);

export function ShortcutProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();
  const queryClient = useQueryClient();

  // Load preferences for active user
  const [preferences, setPreferencesState] = useState<UserShortcutPreferences>(() =>
    loadUserPreferences(user?.id)
  );

  // Sync when user changes (e.g. login/logout or switch accounts)
  useEffect(() => {
    setPreferencesState(loadUserPreferences(user?.id));
  }, [user?.id]);

  // Persist preferences whenever they change
  const savePrefs = useCallback(
    (newPrefs: UserShortcutPreferences) => {
      setPreferencesState(newPrefs);
      saveUserPreferences(newPrefs, user?.id);
    },
    [user?.id]
  );

  // Resolved list of shortcuts
  const shortcuts = useMemo(() => buildResolvedShortcuts(preferences), [preferences]);

  // Modals state
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [cheatSheetOpen, setCheatSheetOpen] = useState(false);
  const toggleCommandPalette = useCallback(() => setCommandPaletteOpen((prev) => !prev), []);
  const toggleCheatSheet = useCallback(() => setCheatSheetOpen((prev) => !prev), []);

  // Visual HUD notification state
  const [hudNotice, setHudNotice] = useState<{ label: string; keys: string } | null>(null);
  const hudTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showHud = useCallback(
    (label: string, keys: string[]) => {
      if (!preferences.showHudNotification) return;
      if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
      const formatted = formatKeyDisplay(keys).displayString;
      setHudNotice({ label, keys: formatted });
      hudTimerRef.current = setTimeout(() => {
        setHudNotice(null);
      }, 1600);
    },
    [preferences.showHudNotification]
  );

  // Key tracking state for sequence chords (e.g. 'g' then 'd')
  const sequenceBufferRef = useRef<string[]>([]);
  const sequenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Shortcut modifier actions
  const updateShortcutKeys = useCallback(
    (id: string, keys: string[]) => {
      savePrefs({
        ...preferences,
        overrides: {
          ...preferences.overrides,
          [id]: {
            keys,
            isEnabled: preferences.overrides[id]?.isEnabled ?? true,
          },
        },
      });
      toast.success('Shortcut updated successfully');
    },
    [preferences, savePrefs]
  );

  const toggleShortcutEnabled = useCallback(
    (id: string, explicitEnabled?: boolean) => {
      const current = shortcuts.find((s) => s.id === id);
      if (!current) return;
      const nextEnabled = explicitEnabled !== undefined ? explicitEnabled : !current.isEnabled;

      if (current.isCustom) {
        savePrefs({
          ...preferences,
          customShortcuts: preferences.customShortcuts.map((c) =>
            c.id === id ? { ...c, isEnabled: nextEnabled } : c
          ),
        });
      } else {
        savePrefs({
          ...preferences,
          overrides: {
            ...preferences.overrides,
            [id]: {
              keys: current.keys,
              isEnabled: nextEnabled,
            },
          },
        });
      }
    },
    [shortcuts, preferences, savePrefs]
  );

  const resetShortcut = useCallback(
    (id: string) => {
      const nextOverrides = { ...preferences.overrides };
      delete nextOverrides[id];
      savePrefs({
        ...preferences,
        overrides: nextOverrides,
      });
      toast.success('Shortcut reset to factory default');
    },
    [preferences, savePrefs]
  );

  const resetAllShortcuts = useCallback(() => {
    savePrefs({
      ...DEFAULT_PREFERENCES,
      customShortcuts: preferences.customShortcuts, // preserve user custom shortcuts
    });
    toast.success('All shortcuts restored to defaults');
  }, [preferences.customShortcuts, savePrefs]);

  const addCustomShortcut = useCallback(
    (shortcut: Omit<CustomShortcut, 'id' | 'createdAt'>) => {
      const newCustom: CustomShortcut = {
        ...shortcut,
        id: `custom:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
        createdAt: new Date().toISOString(),
      };
      savePrefs({
        ...preferences,
        customShortcuts: [...preferences.customShortcuts, newCustom],
      });
      toast.success(`Custom shortcut "${shortcut.label}" created`);
    },
    [preferences, savePrefs]
  );

  const updateCustomShortcut = useCallback(
    (id: string, updates: Partial<CustomShortcut>) => {
      savePrefs({
        ...preferences,
        customShortcuts: preferences.customShortcuts.map((c) =>
          c.id === id ? { ...c, ...updates } : c
        ),
      });
      toast.success('Custom shortcut updated');
    },
    [preferences, savePrefs]
  );

  const deleteCustomShortcut = useCallback(
    (id: string) => {
      savePrefs({
        ...preferences,
        customShortcuts: preferences.customShortcuts.filter((c) => c.id !== id),
      });
      toast.success('Custom shortcut deleted');
    },
    [preferences, savePrefs]
  );

  const importPreferences = useCallback(
    (newPrefs: UserShortcutPreferences) => {
      savePrefs(newPrefs);
      toast.success('Keyboard shortcuts configuration imported successfully');
    },
    [savePrefs]
  );

  const exportPreferences = useCallback(() => {
    exportShortcutsJson(preferences, user?.username);
    toast.success('Exported keyboard shortcuts configuration');
  }, [preferences, user?.username]);

  const updatePreferences = useCallback(
    (updates: Partial<UserShortcutPreferences>) => {
      savePrefs({
        ...preferences,
        ...updates,
      });
    },
    [preferences, savePrefs]
  );

  // Execute an action
  const executeAction = useCallback(
    (def: ShortcutDefinition) => {
      showHud(def.label, def.keys);

      switch (def.actionType) {
        case 'navigate':
        case 'custom-url':
          if (def.targetUrl) {
            navigate(def.targetUrl);
          }
          break;

        case 'command-palette':
          setCommandPaletteOpen((prev) => !prev);
          break;

        case 'cheat-sheet':
          setCheatSheetOpen((prev) => !prev);
          break;

        case 'toggle-theme':
          setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
          break;

        case 'toggle-sidebar':
          window.dispatchEvent(new CustomEvent('rvp:toggle-sidebar'));
          break;

        case 'focus-search': {
          const searchInput = document.querySelector<HTMLInputElement>(
            'input[type="search"], input[data-search="true"], input[placeholder*="search" i], input[placeholder*="filter" i]'
          );
          if (searchInput) {
            searchInput.focus();
            searchInput.select();
          } else {
            // Fallback: open command palette if no on-page search
            setCommandPaletteOpen(true);
          }
          break;
        }

        case 'quick-new': {
          window.dispatchEvent(new CustomEvent('rvp:quick-new'));
          // Also try finding standard primary action buttons
          const createBtn = document.querySelector<HTMLButtonElement>(
            'button[data-action="create"], button[data-action="new"], button[aria-label*="create" i], button[aria-label*="add" i]'
          );
          if (createBtn) {
            createBtn.click();
          }
          break;
        }

        case 'refresh':
          queryClient.invalidateQueries();
          toast.info('Refreshed data queries');
          break;

        default:
          if (def.targetUrl) {
            navigate(def.targetUrl);
          }
          break;
      }
    },
    [navigate, resolvedTheme, setTheme, queryClient, showHud]
  );

  // Global Keydown Event Listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is inside form inputs UNLESS it's an Escape or a modifier combination
      const target = e.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      const isModifierOnly = ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key);
      if (isModifierOnly) return;

      const hasModifier = e.ctrlKey || e.altKey || e.metaKey;

      // Handle Escape specially for modals
      if (e.key === 'Escape') {
        if (commandPaletteOpen) {
          e.preventDefault();
          setCommandPaletteOpen(false);
          return;
        }
        if (cheatSheetOpen) {
          e.preventDefault();
          setCheatSheetOpen(false);
          return;
        }
      }

      // If user is typing inside an input and no Ctrl/Meta/Alt modifiers, do NOT intercept
      if (isInput && !hasModifier) {
        return;
      }

      // 1. Check for Modifier Key Combinations (e.g. ['Ctrl', 'k'], ['Alt', 't'])
      if (hasModifier) {
        const pressedKeys: string[] = [];
        if (e.ctrlKey || e.metaKey) pressedKeys.push('Ctrl');
        if (e.altKey) pressedKeys.push('Alt');
        if (e.shiftKey) pressedKeys.push('Shift');
        pressedKeys.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);

        const match = shortcuts.find(
          (s) => s.isEnabled && areKeysEqual(s.keys, pressedKeys)
        );

        if (match) {
          e.preventDefault();
          e.stopPropagation();
          executeAction(match);
          return;
        }
      }

      // 2. Check for Single Special Keys when NOT in text input (e.g. '?', '/')
      if (!isInput && !hasModifier) {
        const singleKey = e.key;

        // Direct single key match (e.g. '?')
        const singleMatch = shortcuts.find(
          (s) => s.isEnabled && s.keys.length === 1 && s.keys[0] === singleKey
        );
        if (singleMatch) {
          e.preventDefault();
          e.stopPropagation();
          executeAction(singleMatch);
          return;
        }

        // 3. Sequence Chords (e.g. 'g' then 'd')
        const charKey = singleKey.toLowerCase();
        sequenceBufferRef.current.push(charKey);

        if (sequenceTimerRef.current) {
          clearTimeout(sequenceTimerRef.current);
        }

        const currentSequence = [...sequenceBufferRef.current];

        // Check if currentSequence matches any shortcut
        const sequenceMatch = shortcuts.find(
          (s) => s.isEnabled && areKeysEqual(s.keys, currentSequence)
        );

        if (sequenceMatch) {
          e.preventDefault();
          e.stopPropagation();
          sequenceBufferRef.current = [];
          executeAction(sequenceMatch);
          return;
        }

        // Check if any shortcut STARTS with the current sequence
        const hasPotentialFollowup = shortcuts.some(
          (s) =>
            s.isEnabled &&
            s.keys.length > currentSequence.length &&
            s.keys
              .slice(0, currentSequence.length)
              .every((k, idx) => k.toLowerCase() === currentSequence[idx])
        );

        if (hasPotentialFollowup) {
          e.preventDefault();
          sequenceTimerRef.current = setTimeout(() => {
            sequenceBufferRef.current = [];
          }, preferences.sequenceTimeoutMs || 1000);
        } else {
          // No match and no potential followup -> clear buffer
          sequenceBufferRef.current = [];
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      if (sequenceTimerRef.current) clearTimeout(sequenceTimerRef.current);
    };
  }, [
    shortcuts,
    commandPaletteOpen,
    cheatSheetOpen,
    preferences.sequenceTimeoutMs,
    executeAction,
  ]);

  return (
    <ShortcutContext.Provider
      value={{
        shortcuts,
        preferences,
        commandPaletteOpen,
        cheatSheetOpen,
        setCommandPaletteOpen,
        setCheatSheetOpen,
        toggleCommandPalette,
        toggleCheatSheet,
        updateShortcutKeys,
        toggleShortcutEnabled,
        resetShortcut,
        resetAllShortcuts,
        addCustomShortcut,
        updateCustomShortcut,
        deleteCustomShortcut,
        importPreferences,
        exportPreferences,
        updatePreferences,
      }}
    >
      {children}

      {/* Floating HUD Micro-Notification */}
      {hudNotice && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 right-6 z-50 pointer-events-none animate-in fade-in slide-in-from-bottom-2 duration-200"
        >
          <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-card/95 border border-amber-500/30 text-card-foreground shadow-2xl backdrop-blur-md">
            <div className="h-2 w-2 rounded-full bg-amber-400 animate-ping" />
            <div className="text-xs font-medium text-foreground">
              {hudNotice.label}
            </div>
            <kbd className="px-2 py-0.5 text-[10.5px] font-mono font-semibold rounded bg-muted text-muted-foreground border border-border shadow-xs">
              {hudNotice.keys}
            </kbd>
          </div>
        </div>
      )}
    </ShortcutContext.Provider>
  );
}

export function useShortcuts() {
  const context = useContext(ShortcutContext);
  if (!context) {
    throw new Error('useShortcuts must be used within a ShortcutProvider');
  }
  return context;
}
