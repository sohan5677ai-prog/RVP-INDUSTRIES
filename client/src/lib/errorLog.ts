/**
 * A tiny rolling buffer of the errors the app has seen, so a support ticket can
 * carry the actual stack trace instead of "it broke".
 *
 * The user reporting a problem is almost never the person who can read the
 * console, and by the time anyone looks the tab has usually been reloaded. This
 * captures errors as they happen and keeps only the last few - it is evidence
 * attached to a report, not a logging system, so it stays in memory and is
 * deliberately capped.
 */

export interface CapturedError {
  at: string; // ISO timestamp
  kind: 'console' | 'window' | 'promise';
  message: string;
}

const MAX_ENTRIES = 15;
const MAX_MESSAGE_LEN = 300;

const buffer: CapturedError[] = [];

function record(kind: CapturedError['kind'], message: string) {
  const trimmed = message.slice(0, MAX_MESSAGE_LEN);
  if (!trimmed.trim()) return;
  buffer.push({ at: new Date().toISOString(), kind, message: trimmed });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

/** Snapshot of what's been captured, oldest first. */
export function getCapturedErrors(): CapturedError[] {
  return [...buffer];
}

/** Pre-formatted for the support ticket's `consoleErrors` field. */
export function formatCapturedErrors(): string {
  return buffer.map((e) => `[${e.at}] (${e.kind}) ${e.message}`).join('\n');
}

function stringifyArg(arg: unknown): string {
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

let installed = false;

/**
 * Start capturing. Called once at app start. The original console.error is
 * still invoked - devtools must keep working exactly as before.
 */
export function installErrorCapture() {
  if (installed) return;
  installed = true;

  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    record('console', args.map(stringifyArg).join(' '));
    originalError(...args);
  };

  window.addEventListener('error', (e) => {
    record('window', `${e.message} (${e.filename}:${e.lineno}:${e.colno})`);
  });

  window.addEventListener('unhandledrejection', (e) => {
    record('promise', stringifyArg(e.reason));
  });
}
