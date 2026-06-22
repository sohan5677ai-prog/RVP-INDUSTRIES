import type { App } from '@slack/bolt';
import { resolveErpUser, NOT_LINKED_MESSAGE } from '../users.js';
import { apiGet, apiPost, ErpApiError } from '../erpClient.js';
import { headerBlock, contextBlock, fieldsSection, selectSection } from '../blocks.js';
import { rupees } from '../parse.js';

const FLOW = 'purchase';

/**
 * Build the modal that captures the RVP second (tare) weight — and the bunker
 * when the seed lands directly at the process. private_metadata carries the
 * stock-in id, its first weight (for validation) and where to update the card.
 */
function recordModal(stockIn: any, channel: string, messageTs: string) {
  const atProcess = stockIn.loadingLocation === 'At process';
  const blocks: any[] = [
    contextBlock(
      `*${stockIn.purchaseOrder?.poNumber ?? ''}* · ${stockIn.purchaseOrder?.party?.name ?? ''} · lorry ${stockIn.lorryNumber}\n` +
        `RVP first (gross) weight: *${stockIn.rvpFirstWeightKg} kg*`
    ),
    {
      type: 'input',
      block_id: 'second',
      label: { type: 'plain_text', text: 'RVP second (tare) weight, kg' },
      element: { type: 'plain_text_input', action_id: 'v' },
    },
  ];
  if (atProcess) {
    blocks.push({
      type: 'input',
      block_id: 'bunker',
      optional: true,
      label: { type: 'plain_text', text: 'Bunker (bag-cutting)' },
      element: {
        type: 'static_select',
        action_id: 'v',
        options: [
          { text: { type: 'plain_text', text: 'A (₹3/bag)' }, value: 'A' },
          { text: { type: 'plain_text', text: 'B (₹6/bag)' }, value: 'B' },
        ],
      },
    });
  }
  return {
    type: 'modal' as const,
    callback_id: `${FLOW}:create_submit`,
    private_metadata: JSON.stringify({
      stockInId: stockIn.id,
      firstWeight: stockIn.rvpFirstWeightKg,
      channel,
      messageTs,
    }),
    title: { type: 'plain_text' as const, text: 'Record Purchase' },
    submit: { type: 'plain_text' as const, text: 'Record' },
    close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks,
  };
}

function resultBlocks(purchase: any) {
  const net = purchase.netWeightKg;
  return [
    headerBlock('✅ Purchase recorded'),
    contextBlock(
      `*${purchase.stockIn?.purchaseOrder?.poNumber ?? ''}* · ${purchase.stockIn?.purchaseOrder?.party?.name ?? ''} · lorry ${purchase.stockIn?.lorryNumber ?? ''}`
    ),
    fieldsSection([
      { label: 'Net weight (RVP kata)', value: `${net} kg` },
      { label: 'Hamali', value: rupees(Number(purchase.hamaliCharge)) },
      { label: 'Kata fee', value: rupees(Number(purchase.kataFee)) },
      {
        label: 'Bag-cutting',
        value: purchase.bunkerPlace
          ? `${rupees(Number(purchase.bagCuttingCharge))} (bunker ${purchase.bunkerPlace}, ${purchase.bagCount} bags)`
          : '—',
      },
    ]),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Verify now', emoji: true },
          style: 'primary',
          action_id: 'verify:start',
          value: purchase.id,
        },
      ],
    },
  ];
}

export function registerPurchaseFlow(app: App): void {
  // /purchase → pick a stock-in that has no purchase yet.
  app.command('/purchase', async ({ command, ack, client, respond }) => {
    await ack();
    const user = await resolveErpUser(command.user_id);
    if (!user) {
      await respond({ response_type: 'ephemeral', text: NOT_LINKED_MESSAGE });
      return;
    }
    let stockIns: any[];
    try {
      stockIns = await apiGet('/stock-in', user);
    } catch (err) {
      await respond({ response_type: 'ephemeral', text: `:x: Couldn't load stock-ins: ${(err as Error).message}` });
      return;
    }
    const pending = stockIns.filter((s) => !s.purchase);
    if (!pending.length) {
      await respond({ response_type: 'ephemeral', text: 'No stock-ins are awaiting a purchase record.' });
      return;
    }
    await client.chat.postMessage({
      channel: command.channel_id,
      text: 'Record a purchase',
      blocks: [
        headerBlock('Record Purchase'),
        selectSection(
          `${FLOW}:stockin_select`,
          'Which arrived lorry are you recording?',
          'Select stock-in',
          pending.map((s) => ({
            text: `${s.lorryNumber} · inv ${s.invoiceNumber} · ${s.purchaseOrder?.poNumber ?? ''} · ${s.purchaseOrder?.party?.name ?? ''}`,
            value: s.id,
          }))
        ),
      ],
    });
  });

  // Stock-in chosen → open the record modal.
  app.action(`${FLOW}:stockin_select`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    const user = await resolveErpUser(b.user.id);
    if (!user) return;
    const stockInId = b.actions[0].selected_option.value;
    let stockIn: any;
    try {
      stockIn = await apiGet(`/stock-in/${stockInId}`, user);
    } catch {
      return;
    }
    await client.views.open({
      trigger_id: b.trigger_id,
      view: recordModal(stockIn, b.channel.id, b.message.ts),
    });
  });

  // Modal submitted → create the purchase.
  app.view(`${FLOW}:create_submit`, async ({ ack, body, view, client }) => {
    const meta = JSON.parse(view.private_metadata || '{}');
    const v = view.state.values as any;
    const second = parseInt(v.second?.v?.value, 10);
    if (isNaN(second) || second <= 0) {
      await ack({ response_action: 'errors', errors: { second: 'Enter a weight in kg.' } });
      return;
    }
    if (second >= meta.firstWeight) {
      await ack({ response_action: 'errors', errors: { second: `Must be less than the first weight (${meta.firstWeight} kg).` } });
      return;
    }
    await ack();

    const user = await resolveErpUser(body.user.id);
    if (!user) return;
    const bunker = v.bunker?.v?.selected_option?.value as 'A' | 'B' | undefined;

    try {
      const purchase = await apiPost(
        '/purchases',
        { stockInId: meta.stockInId, rvpSecondWeightKg: second, ...(bunker ? { bunkerPlace: bunker } : {}) },
        user
      );
      await client.chat.update({
        channel: meta.channel,
        ts: meta.messageTs,
        text: 'Purchase recorded',
        blocks: resultBlocks(purchase),
      });
    } catch (err) {
      const msg = err instanceof ErpApiError ? err.message : (err as Error).message;
      await client.chat.postMessage({ channel: meta.channel, text: `:x: Couldn't record the purchase: ${msg}` });
    }
  });
}
