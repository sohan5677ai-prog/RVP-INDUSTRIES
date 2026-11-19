import { logger } from '../lib/logger.js';
import { App } from '@slack/bolt';
import { registerPurchaseOrderFlow } from './flows/purchaseOrder.js';
import { registerStockInFlow } from './flows/stockIn.js';
import { registerPurchaseFlow } from './flows/purchase.js';
import { registerVerificationFlow } from './flows/verification.js';
import { registerStockTransferFlow } from './flows/stockTransfer.js';
import { registerSaleFlow } from './flows/sale.js';
import { registerDispatchFlow } from './flows/dispatch.js';
import { registerDriverKataFlow } from './flows/driverKata.js';

let slackAppInstance: App | null = null;

export function getSlackApp(): App | null {
  return slackAppInstance;
}

/** Where review cards and alerts go. Null when no channel is configured. */
export function slackAlertChannel(): string | null {
  return (
    process.env.SLACK_KATA_CHANNEL?.trim() || process.env.SLACK_DISPATCH_CHANNEL?.trim() || null
  );
}

/**
 * Post a message to Slack without needing the Socket-Mode bot to be running.
 *
 * `getSlackApp()` is null whenever startSlackBot() didn't run or its socket is
 * down, and every caller guarded on it - so a card that nobody was waiting for
 * a websocket to deliver was skipped anyway. Posting is an ordinary signed HTTP
 * call to chat.postMessage, so make it one: the bot token is enough.
 *
 * Returns the message ts (for later edits) or null if it could not be posted.
 */
export async function postSlackMessage(args: {
  channel?: string | null;
  text: string;
  blocks?: unknown[];
}): Promise<{ channel: string; ts: string } | null> {
  const channel = args.channel?.trim() || slackAlertChannel();
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!channel || !token) {
    logger.warn('[slack] no channel or bot token configured - message not posted');
    return null;
  }
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, text: args.text, blocks: args.blocks }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json()) as { ok?: boolean; ts?: string; error?: string };
    if (!json.ok || !json.ts) {
      logger.error(`[slack] chat.postMessage failed: ${json.error ?? 'unknown error'}`);
      return null;
    }
    return { channel, ts: json.ts };
  } catch (err) {
    logger.error('[slack] chat.postMessage threw', err);
    return null;
  }
}

/** Edit a message already posted, over the same token-only HTTP path. */
export async function updateSlackMessage(args: {
  channel: string;
  ts: string;
  text: string;
  blocks?: unknown[];
}): Promise<boolean> {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) return false;
  try {
    const res = await fetch('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: args.channel, ts: args.ts, text: args.text, blocks: args.blocks }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json()) as { ok?: boolean; error?: string };
    if (!json.ok) {
      logger.error(`[slack] chat.update failed: ${json.error ?? 'unknown error'}`);
      return false;
    }
    return true;
  } catch (err) {
    logger.error('[slack] chat.update threw', err);
    return false;
  }
}

/**
 * Start the Slack bot in Socket Mode (outbound WebSocket - no public URL needed).
 * Gated by SLACK_ENABLED in index.ts. Safe to call without a fully-configured
 * workspace: it validates the required tokens and no-ops with a warning if any
 * are missing, so a misconfigured Slack setup never blocks the API server.
 */
export async function startSlackBot(): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!token || !appToken) {
    console.warn(
      '[slack] SLACK_BOT_TOKEN / SLACK_APP_TOKEN not set - Slack bot disabled. ' +
        'Set them (and SLACK_ENABLED=true) to enable it.'
    );
    return;
  }

  const app = new App({
    token,
    appToken,
    socketMode: true,
    signingSecret: process.env.SLACK_SIGNING_SECRET, // unused in socket mode, harmless if set
  });
  slackAppInstance = app;

  app.error(async (error: Error) => {
    logger.error('[slack] error:', error);
  });

  // Global trace: logs EVERY incoming payload (commands, events, interactions),
  // so we can see whether Slack is delivering file/message events at all. Remove
  // once the bot is confirmed working.
  app.use(async (args) => {
    const body: any = (args as any).body ?? {};
    const evt = body.event ?? {};
    const kind = body.type ?? 'unknown';
    const detail = evt.type ? `event=${evt.type}${evt.subtype ? `/${evt.subtype}` : ''}` : (body.command ?? body.actions?.[0]?.action_id ?? '');
    const files = Array.isArray(evt.files) ? ` files=${evt.files.length}` : '';
    logger.info(`[slack] ← ${kind} ${detail}${files}`);
    await args.next();
  });

  registerPurchaseOrderFlow(app);
  registerStockInFlow(app);
  registerPurchaseFlow(app);
  registerVerificationFlow(app);
  registerStockTransferFlow(app);
  registerSaleFlow(app);
  registerDispatchFlow(app);
  registerDriverKataFlow(app);

  await app.start();
  logger.info('Slack bot connected (Socket Mode)');
}

