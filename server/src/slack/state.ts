import { prisma } from '../lib/prisma.js';
import type { ErpUser } from './erpClient.js';

export interface Draft<T = Record<string, any>> {
  flow: string;
  step?: string;
  user: ErpUser;
  slackUserId: string;
  channel: string;
  threadTs?: string;
  data: T;
}

export function draftKey(channel: string, threadTs?: string, user?: string): string {
  return `${channel}:${threadTs ?? user ?? 'na'}`;
}

export async function setDraft(key: string, draft: Draft): Promise<void> {
  await prisma.slackDraft.upsert({
    where: { key },
    update: {
      flow: draft.flow,
      step: draft.step,
      userId: draft.user.userId,
      role: draft.user.role,
      slackUserId: draft.slackUserId,
      channel: draft.channel,
      threadTs: draft.threadTs,
      data: JSON.stringify(draft.data),
    },
    create: {
      key,
      flow: draft.flow,
      step: draft.step,
      userId: draft.user.userId,
      role: draft.user.role,
      slackUserId: draft.slackUserId,
      channel: draft.channel,
      threadTs: draft.threadTs,
      data: JSON.stringify(draft.data),
    },
  });
}

export async function getDraft<T = Record<string, any>>(key: string): Promise<Draft<T> | undefined> {
  const row = await prisma.slackDraft.findUnique({ where: { key } });
  if (!row) return undefined;
  return {
    flow: row.flow,
    step: row.step ?? undefined,
    user: { userId: row.userId, role: row.role as any },
    slackUserId: row.slackUserId,
    channel: row.channel,
    threadTs: row.threadTs ?? undefined,
    data: JSON.parse(row.data),
  };
}

export async function findDraft<T = Record<string, any>>(
  predicate: (d: Draft) => boolean
): Promise<Draft<T> | undefined> {
  const all = await prisma.slackDraft.findMany();
  for (const row of all) {
    const draft: Draft<any> = {
      flow: row.flow,
      step: row.step ?? undefined,
      user: { userId: row.userId, role: row.role as any },
      slackUserId: row.slackUserId,
      channel: row.channel,
      threadTs: row.threadTs ?? undefined,
      data: JSON.parse(row.data),
    };
    if (predicate(draft)) return draft;
  }
  return undefined;
}

export async function clearDraft(key: string): Promise<void> {
  try {
    await prisma.slackDraft.delete({ where: { key } });
  } catch (e) {
  }
}
