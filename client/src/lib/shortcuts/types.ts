export type ShortcutCategory =
  | 'navigation'
  | 'purchases'
  | 'sales'
  | 'reports'
  | 'accounts'
  | 'actions'
  | 'custom';

export type ActionType =
  | 'navigate'
  | 'command-palette'
  | 'cheat-sheet'
  | 'toggle-theme'
  | 'toggle-sidebar'
  | 'focus-search'
  | 'quick-new'
  | 'print'
  | 'refresh'
  | 'custom-url';

export interface ShortcutDefinition {
  id: string;
  label: string;
  description: string;
  category: ShortcutCategory;
  /**
   * Keys definition.
   * If length > 1 and first item is not a modifier ('Ctrl', 'Alt', 'Shift', 'Meta'), it is treated as a sequence chord (e.g. ['g', 'd']).
   * If it contains modifiers, it's a combination (e.g. ['Ctrl', 'k'], ['Alt', 't']).
   */
  keys: string[];
  defaultKeys: string[];
  targetUrl?: string;
  actionType?: ActionType;
  /** Whether the shortcut is active */
  isEnabled: boolean;
  /** Whether user customized the keybinding */
  isCustomized?: boolean;
  /** User-created custom shortcut */
  isCustom?: boolean;
  /** If true, triggers even inside form inputs (e.g. Escape, Ctrl+K) */
  globalInInputs?: boolean;
}

export interface CustomShortcut {
  id: string;
  label: string;
  description?: string;
  category: ShortcutCategory;
  keys: string[];
  targetUrl: string;
  isEnabled: boolean;
  createdAt: string;
}

export interface UserShortcutPreferences {
  /** Map of built-in shortcut id -> custom keys & enabled flag */
  overrides: Record<string, { keys: string[]; isEnabled: boolean }>;
  /** Custom user-created shortcuts */
  customShortcuts: CustomShortcut[];
  /** Whether to show HUD toast notification when shortcut executes */
  showHudNotification: boolean;
  /** Timeout in ms for sequence chords like 'g' then 'd' */
  sequenceTimeoutMs: number;
}

export interface ShortcutConflict {
  hasConflict: boolean;
  conflictingShortcut?: ShortcutDefinition | CustomShortcut;
}
