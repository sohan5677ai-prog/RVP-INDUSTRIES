import { prisma } from '../lib/prisma.js';
import type { ErpUser } from './erpClient.js';

/**
 * Resolve a Slack member ID to the ERP user it is linked to (User.slackUserId).
 * Returns null when no ERP user is mapped — callers must refuse the action and
 * tell the user to ask an admin to link their account.
 */
export async function resolveErpUser(slackUserId: string): Promise<ErpUser | null> {
  const user = await prisma.user.findUnique({
    where: { slackUserId },
    select: { id: true, role: true },
  });
  if (!user) return null;
  return { userId: user.id, role: user.role };
}

export const NOT_LINKED_MESSAGE =
  ":lock: Your Slack account isn't linked to an ERP user yet. Ask an admin to set your Slack ID on your ERP account before using the bot.";
