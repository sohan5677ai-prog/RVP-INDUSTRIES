import type { ErpUser } from './erpClient.js';

/**
 * In-memory per-conversation draft store. Each Slack flow (PO, stock-in, …)
 * accumulates its partially-built record here until the user taps Approve.
 *
 * Keyed by channel + thread (or user when there is no thread). This is
 * deliberately simple — drafts are lost if the server restarts mid-flow, which
 * is acceptable for the MVP. A DB-backed store is a clean later hardening.
 */
export interface Draft<T = Record<string, any>> {
  flow: string; // e.g. "po", "stockin"
  step?: string; // current step within a multi-step flow
  user: ErpUser; // the ERP user this draft is being created as
  slackUserId: string;
  channel: string;
  threadTs?: string;
  data: T; // flow-specific accumulated fields
}

const drafts = new Map<string, Draft>();

/** Stable key for a conversation: channel + thread (falls back to user). */
export function draftKey(channel: string, threadTs?: string, user?: string): string {
  return `${channel}:${threadTs ?? user ?? 'na'}`;
}

export function setDraft(key: string, draft: Draft): void {
  drafts.set(key, draft);
}

export function getDraft<T = Record<string, any>>(key: string): Draft<T> | undefined {
  return drafts.get(key) as Draft<T> | undefined;
}

export function clearDraft(key: string): void {
  drafts.delete(key);
}
