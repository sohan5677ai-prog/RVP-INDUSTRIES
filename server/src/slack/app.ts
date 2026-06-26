import { App } from '@slack/bolt';
import { registerPurchaseOrderFlow } from './flows/purchaseOrder.js';
import { registerStockInFlow } from './flows/stockIn.js';
import { registerPurchaseFlow } from './flows/purchase.js';
import { registerVerificationFlow } from './flows/verification.js';
import { registerStockTransferFlow } from './flows/stockTransfer.js';
import { registerSaleFlow } from './flows/sale.js';
import { registerDispatchFlow } from './flows/dispatch.js';

/**
 * Start the Slack bot in Socket Mode (outbound WebSocket — no public URL needed).
 * Gated by SLACK_ENABLED in index.ts. Safe to call without a fully-configured
 * workspace: it validates the required tokens and no-ops with a warning if any
 * are missing, so a misconfigured Slack setup never blocks the API server.
 */
export async function startSlackBot(): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!token || !appToken) {
    console.warn(
      '[slack] SLACK_BOT_TOKEN / SLACK_APP_TOKEN not set — Slack bot disabled. ' +
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

  app.error(async (error: Error) => {
    console.error('[slack] error:', error);
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
    console.log(`[slack] ← ${kind} ${detail}${files}`);
    await args.next();
  });

  registerPurchaseOrderFlow(app);
  registerStockInFlow(app);
  registerPurchaseFlow(app);
  registerVerificationFlow(app);
  registerStockTransferFlow(app);
  registerSaleFlow(app);
  registerDispatchFlow(app);

  await app.start();
  console.log('Slack bot connected (Socket Mode)');
}
