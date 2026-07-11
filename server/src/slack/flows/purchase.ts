import type { App } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import { extractInvoiceData } from '../../lib/gemini.js';
import { resolveErpUser, NOT_LINKED_MESSAGE } from '../users.js';
import { apiGet, apiPost, ErpApiError, type ErpUser } from '../erpClient.js';
import { getDraft, setDraft, clearDraft } from '../state.js';
import { downloadSlackFile } from '../slackFiles.js';
import { headerBlock, contextBlock, fieldsSection, selectSection, approveEditCancel } from '../blocks.js';
import { rupees } from '../parse.js';
import { startVerification } from './verification.js';

const FLOW = 'purchase';

interface PurchaseDraftData {
  stockInId: string;
  label: string; // "PO · party · lorry"
  firstWeightKg: number; // RVP first (gross) weight from the stock-in
  location: string; // loading location (drives the bunker prompt)
  atProcess: boolean;
  step: 'review';
  secondWeightKg?: number; // RVP second (tare) weight, OCR'd from the kata slip
  bunkerPlace?: 'A' | 'B';
}

function keyFor(channel: string, threadTs: string): string {
  return `${FLOW}:${channel}:${threadTs}`;
}

function netWeight(d: PurchaseDraftData): number | undefined {
  if (!d.secondWeightKg) return undefined;
  return d.firstWeightKg - d.secondWeightKg;
}

/** True when the draft has a valid second weight (present and below the first). */
function secondValid(d: PurchaseDraftData): boolean {
  return !!d.secondWeightKg && d.secondWeightKg > 0 && d.secondWeightKg < d.firstWeightKg;
}

/** Modal to attach the RVP second-weight (tare) kata slip. */
function uploadModal(stockInId: string, channel: string) {
  return {
    type: 'modal' as const,
    callback_id: `${FLOW}:modal_submit`,
    private_metadata: JSON.stringify({ stockInId, channel }),
    title: { type: 'plain_text' as const, text: 'Record Purchase' },
    submit: { type: 'plain_text' as const, text: 'Read kata' },
    close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks: [
      contextBlock(':mag: Attach our RVP *second-weight (tare)* kata slip - the empty lorry after unloading. Or leave it empty and type the weight on the next card.'),
      {
        type: 'input',
        block_id: 'second',
        optional: true,
        label: { type: 'plain_text', text: 'RVP second-weight kata slip' },
        element: { type: 'file_input', action_id: 'f', max_files: 1 },
      },
    ],
  };
}

function reviewBlocks(d: PurchaseDraftData): KnownBlock[] {
  const net = netWeight(d);
  const blocks: KnownBlock[] = [
    headerBlock('Record Purchase'),
    contextBlock(d.label),
    fieldsSection([
      { label: 'RVP first (gross)', value: `${d.firstWeightKg} kg` },
      { label: 'RVP second (tare)', value: d.secondWeightKg ? `${d.secondWeightKg} kg` : '_not set_' },
      { label: 'Net weight (RVP kata)', value: net !== undefined ? `${net} kg` : '_pending_' },
      { label: 'Location', value: d.location },
    ]),
  ];
  if (d.secondWeightKg && !secondValid(d)) {
    blocks.push(
      contextBlock(
        `:x: Second weight (${d.secondWeightKg} kg) must be *less* than the first weight (${d.firstWeightKg} kg). Use *Edit* to fix it.`
      )
    );
  }

  blocks.push(approveEditCancel(FLOW, { includeEdit: true }));
  return blocks;
}

function editModal(d: PurchaseDraftData, channel: string, messageTs: string, threadTs: string) {
  const blocks: any[] = [
    {
      type: 'input',
      block_id: 'second',
      label: { type: 'plain_text', text: 'RVP second (tare) weight, kg' },
      element: {
        type: 'plain_text_input',
        action_id: 'v',
        ...(d.secondWeightKg ? { initial_value: String(d.secondWeightKg) } : {}),
      },
    },
  ];

  return {
    type: 'modal' as const,
    callback_id: `${FLOW}:edit_submit`,
    private_metadata: JSON.stringify({ channel, messageTs, threadTs }),
    title: { type: 'plain_text' as const, text: 'Edit Purchase' },
    submit: { type: 'plain_text' as const, text: 'Save' },
    close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks,
  };
}

function resultBlocks(purchase: any): KnownBlock[] {
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
    ]),
    contextBlock(':arrow_down: Opening weight verification…'),
  ];
}

/**
 * Post the "Record purchase" card with an Upload button for an arrived stock-in.
 * Server-initiated (auto-chain from a recorded stock-in) so there's no trigger_id
 * yet - the button click opens the upload modal.
 */
export async function startPurchaseForStockIn(
  stockIn: any,
  _user: ErpUser,
  _slackUserId: string,
  channel: string,
  client: any
): Promise<void> {
  const label = `${stockIn.purchaseOrder?.poNumber ?? ''} · ${stockIn.purchaseOrder?.party?.name ?? ''} · lorry ${stockIn.lorryNumber ?? ''}`;
  await client.chat.postMessage({
    channel,
    text: 'Record purchase',
    blocks: [
      headerBlock('Record Purchase'),
      contextBlock(`${label}\nRVP first (gross) weight: *${stockIn.rvpFirstWeightKg} kg*`),
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Upload 2nd-weight kata', emoji: true },
            style: 'primary',
            action_id: `${FLOW}:upload_btn`,
            value: stockIn.id,
          },
        ],
      },
    ],
  });
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

  // Stock-in chosen → open the upload modal straight away.
  app.action(`${FLOW}:stockin_select`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    const stockInId = b.actions[0].selected_option.value;
    await client.views.open({ trigger_id: b.trigger_id, view: uploadModal(stockInId, b.channel.id) });
    await client.chat.update({
      channel: b.channel.id,
      ts: b.message.ts,
      text: 'Record purchase',
      blocks: [headerBlock('Record Purchase'), contextBlock(':inbox_tray: Opening the kata-upload dialog…')],
    });
  });

  // Upload button (auto-chain card) → open the upload modal.
  app.action(`${FLOW}:upload_btn`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    await client.views.open({ trigger_id: b.trigger_id, view: uploadModal(b.actions[0].value, b.channel.id) });
  });

  // Upload modal submitted → read the tare weight, post the review card.
  app.view(`${FLOW}:modal_submit`, async ({ ack, body, view, client }) => {
    await ack();
    const meta = JSON.parse(view.private_metadata || '{}');
    const channel = meta.channel as string;
    const user = await resolveErpUser(body.user.id);
    if (!user) return;

    let stockIn: any;
    try {
      stockIn = await apiGet(`/stock-in/${meta.stockInId}`, user);
    } catch (err) {
      await client.chat.postMessage({ channel, text: `:x: ${(err as Error).message}` });
      return;
    }

    const data: PurchaseDraftData = {
      stockInId: meta.stockInId,
      label: `${stockIn.purchaseOrder?.poNumber ?? ''} · ${stockIn.purchaseOrder?.party?.name ?? ''} · lorry ${stockIn.lorryNumber ?? ''}`,
      firstWeightKg: stockIn.rvpFirstWeightKg,
      location: stockIn.loadingLocation,
      atProcess: stockIn.loadingLocation === 'RVP',
      step: 'review',
    };

    const file = (view.state.values as any).second?.f?.files?.[0];
    let readError: string | undefined;
    if (file) {
      try {
        const f = await downloadSlackFile(file);
        const r = await extractInvoiceData(f.buffer, f.mimetype, 'rvpSecondWeight');
        if (r.rvpSecondWeightKg) data.secondWeightKg = r.rvpSecondWeightKg;
      } catch (err) {
        readError = (err as Error).message;
      }
    }

    const blocks = reviewBlocks(data);
    if (!data.secondWeightKg) {
      blocks.splice(
        2,
        0,
        contextBlock(
          readError
            ? `:warning: Couldn't read the slip (${readError}) - type the weight via *Edit*.`
            : ":warning: Couldn't read a tare weight off that slip - type it via *Edit*."
        )
      );
    }
    const posted = await client.chat.postMessage({ channel, text: 'Review purchase', blocks });
    await setDraft(keyFor(channel, posted.ts as string), {
      flow: FLOW,
      user,
      slackUserId: body.user.id,
      channel,
      threadTs: posted.ts as string,
      data,
    });
  });

  // Bunker chosen from the review card.
  app.action(`${FLOW}:bunker_select`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    const threadTs = b.message.thread_ts ?? b.message.ts;
    const key = keyFor(b.channel.id, threadTs);
    const draft = await getDraft<PurchaseDraftData>(key);
    if (!draft) return;
    draft.data.bunkerPlace = b.actions[0].selected_option.value as 'A' | 'B';
    await setDraft(key, draft);
    await client.chat.update({ channel: b.channel.id, ts: b.message.ts, text: 'Review purchase', blocks: reviewBlocks(draft.data) });
  });

  // Edit → modal (fix the second weight and/or bunker).
  app.action(`${FLOW}:edit`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    const threadTs = b.message.thread_ts ?? b.message.ts;
    const draft = await getDraft<PurchaseDraftData>(keyFor(b.channel.id, threadTs));
    if (!draft) return;
    await client.views.open({ trigger_id: b.trigger_id, view: editModal(draft.data, b.channel.id, b.message.ts, threadTs) });
  });

  app.view(`${FLOW}:edit_submit`, async ({ ack, view, client }) => {
    await ack();
    const meta = JSON.parse(view.private_metadata || '{}');
    const key = keyFor(meta.channel, meta.threadTs);
    const draft = await getDraft<PurchaseDraftData>(key);
    if (!draft) return;
    const v = view.state.values as any;
    const sec = parseInt(v.second?.v?.value, 10);
    if (!isNaN(sec) && sec > 0) draft.data.secondWeightKg = sec;
    if (draft.data.atProcess) {
      const bunker = v.bunker?.v?.selected_option?.value as 'A' | 'B' | undefined;
      if (bunker) draft.data.bunkerPlace = bunker;
    }
    await setDraft(key, draft);
    await client.chat.update({ channel: meta.channel, ts: meta.messageTs, text: 'Review purchase', blocks: reviewBlocks(draft.data) });
  });

  // Approve → create the purchase, then chain straight into verification.
  app.action(`${FLOW}:approve`, async ({ ack, body, client, respond }) => {
    await ack();
    const b = body as any;
    const threadTs = b.message.thread_ts ?? b.message.ts;
    const key = keyFor(b.channel.id, threadTs);
    const draft = await getDraft<PurchaseDraftData>(key);
    if (!draft) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: 'This draft has expired. Run `/purchase` again.' });
      return;
    }
    const d = draft.data;
    if (!secondValid(d)) {
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: `:x: A valid RVP second weight (below ${d.firstWeightKg} kg) is required. Use *Edit* to fix it.`,
      });
      return;
    }

    try {
      const purchase = await apiPost(
        '/purchases',
        { stockInId: d.stockInId, rvpSecondWeightKg: d.secondWeightKg, ...(d.bunkerPlace ? { bunkerPlace: d.bunkerPlace } : {}) },
        draft.user
      );
      await clearDraft(key);
      await client.chat.update({ channel: b.channel.id, ts: b.message.ts, text: 'Purchase recorded', blocks: resultBlocks(purchase) });
      // Seamlessly open the weight-verification preview for this purchase.
      await startVerification(purchase.id, draft.user, b.user.id, b.channel.id, client, respond);
    } catch (err) {
      const msg = err instanceof ErpApiError ? err.message : (err as Error).message;
      await respond({ response_type: 'ephemeral', replace_original: false, text: `:x: Couldn't record the purchase: ${msg}` });
    }
  });

  app.action(`${FLOW}:cancel`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    const threadTs = b.message.thread_ts ?? b.message.ts;
    await clearDraft(keyFor(b.channel.id, threadTs));
    await client.chat.update({
      channel: b.channel.id,
      ts: b.message.ts,
      text: 'Cancelled',
      blocks: [headerBlock('Record Purchase'), contextBlock(':wastebasket: Cancelled.')],
    });
  });
}
