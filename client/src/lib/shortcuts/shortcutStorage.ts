import { DEFAULT_SHORTCUTS } from './defaultShortcuts';
import type {
  ShortcutDefinition,
  CustomShortcut,
  UserShortcutPreferences,
  ShortcutConflict,
} from './types';

const STORAGE_PREFIX = 'rvp_shortcuts_v1_';

export const DEFAULT_PREFERENCES: UserShortcutPreferences = {
  overrides: {},
  customShortcuts: [],
  showHudNotification: true,
  sequenceTimeoutMs: 1000,
};

/** Get the localStorage key for a specific user ID */
export function getStorageKey(userId?: string | null): string {
  return `${STORAGE_PREFIX}${userId || 'default'}`;
}

/** Load user preferences from localStorage */
export function loadUserPreferences(userId?: string | null): UserShortcutPreferences {
  try {
    const raw = localStorage.getItem(getStorageKey(userId));
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw);
    return {
      overrides: parsed.overrides || {},
      customShortcuts: Array.isArray(parsed.customShortcuts) ? parsed.customShortcuts : [],
      showHudNotification: parsed.showHudNotification ?? true,
      sequenceTimeoutMs: parsed.sequenceTimeoutMs ?? 1000,
    };
  } catch (err) {
    console.error('Failed to parse keyboard shortcut preferences:', err);
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Save user preferences to localStorage */
export function saveUserPreferences(
  prefs: UserShortcutPreferences,
  userId?: string | null
): void {
  try {
    localStorage.setItem(getStorageKey(userId), JSON.stringify(prefs));
  } catch (err) {
    console.error('Failed to save keyboard shortcut preferences:', err);
  }
}

/** Merge default shortcuts with user overrides and custom shortcuts */
export function buildResolvedShortcuts(
  prefs: UserShortcutPreferences
): ShortcutDefinition[] {
  // 1. Process built-in shortcuts
  const builtIns: ShortcutDefinition[] = DEFAULT_SHORTCUTS.map((def) => {
    const override = prefs.overrides[def.id];
    if (override) {
      const isCustomized =
        JSON.stringify(override.keys) !== JSON.stringify(def.defaultKeys) ||
        override.isEnabled !== def.isEnabled;
      return {
        ...def,
        keys: override.keys,
        isEnabled: override.isEnabled,
        isCustomized,
      };
    }
    return {
      ...def,
      isCustomized: false,
    };
  });

  // 2. Convert custom user shortcuts to ShortcutDefinition shape
  const customs: ShortcutDefinition[] = prefs.customShortcuts.map((c) => ({
    id: c.id,
    label: c.label,
    description: c.description || `Custom URL: ${c.targetUrl}`,
    category: c.category || 'custom',
    keys: c.keys,
    defaultKeys: c.keys,
    targetUrl: c.targetUrl,
    actionType: 'custom-url',
    isEnabled: c.isEnabled,
    isCustomized: false,
    isCustom: true,
  }));

  return [...builtIns, ...customs];
}

/** Compare two key arrays for equality (case-insensitive for characters) */
export function areKeysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const normA = a.map((k) => k.toLowerCase());
  const normB = b.map((k) => k.toLowerCase());
  return normA.every((k, idx) => k === normB[idx]);
}

/** Check if keys conflict with an existing shortcut */
export function checkShortcutConflict(
  newKeys: string[],
  currentShortcutId: string,
  allShortcuts: ShortcutDefinition[]
): ShortcutConflict {
  if (!newKeys || newKeys.length === 0) {
    return { hasConflict: false };
  }

  const conflicting = allShortcuts.find(
    (s) => s.id !== currentShortcutId && s.isEnabled && areKeysEqual(s.keys, newKeys)
  );

  if (conflicting) {
    return {
      hasConflict: true,
      conflictingShortcut: conflicting,
    };
  }

  return { hasConflict: false };
}

/** Nicely format key array for display, e.g. ['Ctrl', 'k'] -> 'Ctrl + K' */
export function formatKeyDisplay(keys: string[]): {
  isSequence: boolean;
  parts: string[];
  displayString: string;
} {
  if (!keys || keys.length === 0) {
    return { isSequence: false, parts: ['Unassigned'], displayString: 'None' };
  }

  const isSequence =
    keys.length > 1 && !['ctrl', 'alt', 'shift', 'meta', 'control'].includes(keys[0].toLowerCase());

  const formattedParts = keys.map((k) => {
    const lower = k.toLowerCase();
    if (lower === 'control' || lower === 'ctrl') return 'Ctrl';
    if (lower === 'alt') return 'Alt';
    if (lower === 'shift') return 'Shift';
    if (lower === 'meta' || lower === 'cmd' || lower === 'command') return '⌘ Cmd';
    if (lower === 'escape' || lower === 'esc') return 'Esc';
    if (lower === 'enter') return '↵ Enter';
    if (lower === 'arrowup') return '↑';
    if (lower === 'arrowdown') return '↓';
    if (lower === 'arrowleft') return '←';
    if (lower === 'arrowright') return '→';
    if (lower === ' ') return 'Space';
    return k.toUpperCase();
  });

  const displayString = isSequence
    ? formattedParts.join(' then ')
    : formattedParts.join(' + ');

  return {
    isSequence,
    parts: formattedParts,
    displayString,
  };
}

/** Export shortcut preferences as downloadable JSON */
export function exportShortcutsJson(prefs: UserShortcutPreferences, username?: string): void {
  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(prefs, null, 2));
  const dlAnchorElem = document.createElement('a');
  dlAnchorElem.setAttribute('href', dataStr);
  const dateStr = new Date().toISOString().slice(0, 10);
  const safeName = username ? `${username}-` : '';
  dlAnchorElem.setAttribute('download', `rvp-shortcuts-${safeName}${dateStr}.json`);
  dlAnchorElem.click();
}

/** Parse imported JSON file and validate structure */
export function parseImportedShortcuts(jsonString: string): UserShortcutPreferences {
  const parsed = JSON.parse(jsonString);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid JSON: Must be an object.');
  }

  const overrides: Record<string, { keys: string[]; isEnabled: boolean }> = {};
  if (parsed.overrides && typeof parsed.overrides === 'object') {
    for (const [id, val] of Object.entries(parsed.overrides)) {
      if (typeof val === 'object' && val !== null && Array.isArray((val as any).keys)) {
        overrides[id] = {
          keys: (val as any).keys.map(String),
          isEnabled: Boolean((val as any).isEnabled ?? true),
        };
      }
    }
  }

  const customShortcuts: CustomShortcut[] = [];
  if (Array.isArray(parsed.customShortcuts)) {
    for (const item of parsed.customShortcuts) {
      if (item && item.id && item.label && Array.isArray(item.keys) && item.targetUrl) {
        customShortcuts.push({
          id: String(item.id),
          label: String(item.label),
          description: item.description ? String(item.description) : undefined,
          category: item.category || 'custom',
          keys: item.keys.map(String),
          targetUrl: String(item.targetUrl),
          isEnabled: Boolean(item.isEnabled ?? true),
          createdAt: item.createdAt || new Date().toISOString(),
        });
      }
    }
  }

  return {
    overrides,
    customShortcuts,
    showHudNotification: Boolean(parsed.showHudNotification ?? true),
    sequenceTimeoutMs: Number(parsed.sequenceTimeoutMs) || 1000,
  };
}
