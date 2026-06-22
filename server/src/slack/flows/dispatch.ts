import type { App } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import { extractInvoiceData } from '../../lib/gemini.js';
import { resolveErpUser, NOT_LINKED_MESSAGE } from '../users.js';
import { apiGet, apiPostMultipart, apiPost, ErpApiError } from '../erpClient.js';
import { getDraft, setDraft, clearDraft } from '../state.js';
import { downloadSlackFile, type DownloadedFile } from '../slackFiles.js';
import { headerBlock, contextBlock, fieldsSection, approveEditCancel, selectSection } from '../blocks.js';
import { rupees } from '../parse.js';

const FLOW = 'dispatch';
type Step = 'await_kata' | 'review';

interface DispatchDraftData {
  saleOrderId: string;
  label: string;
  product: string;
  ratePerKg: number;
  step: Step;
  vehicleNumber?: string;
  tonnageKg?: number;
  kataFile?: DownloadedFile;
}

function keyFor(channel: string, threadTs: string): string {
  return `${FLOW}:${channel}:${threadTs}`;
}

function reviewBlocks(d: DispatchDraftData): KnownBlock[] {
  const base = d.tonnageKg ? d.tonnageKg * d.ratePerKg : 0;
  const gst = Math.round(base * 0.05 * 100) / 100;
  const blocks: KnownBlock[] = [
    headerBlock('Dispatch'),
    contextBlock(d.label),
    fieldsSection([
      { label: 'Product', value: d.product },
      { label: 'Rate', value: `${rupees(d.ratePerKg)}/kg` },
      { label: 'Vehicle', value: d.vehicleNumber ?? '_not set_' },
      { label: 'Dispatched weight', value: d.tonnageKg ? `${d.tonnageKg} kg` : '_not set_' },
      { label: 'Amount', value: d.tonnageKg ? rupees(base) : '—' },
      { label: 'GST (5%)', value: d.tonnageKg ? rupees(gst) : '—' },
    ]),
  ];
  if (!d.tonnageKg) blocks.push(contextBlock(':pencil2: Dispatched weight missing — use *Edit*.'));
  blocks.push(approveEditCancel(FLOW, { includeEdit: true }));
  return blocks;
}

function editModal(d: DispatchDraftData, channel: string, messageTs: string, threadTs: string) {
  return {
    type: 'modal' as const,
    callback_id: `${FLOW}:edit_submit`,
    private_metadata: JSON.stringify({ channel, messageTs, threadTs }),
    title: { type: 'plain_text' as const, text: 'Edit Dispatch' },
    submit: { type: 'plain_text' as const, text: 'Save' },
    close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'vehicle',
        optional: true,
        label: { type: 'plain_text', text: 'Vehicle number' },
        element: { type: 'plain_text_input', action_id: 'v', ...(d.vehicleNumber ? { initial_value: d.vehicleNumber } : {}) },
      },
      {
        type: 'input',
        block_id: 'weight',
        label: { type: 'plain_text', text: 'Dispatched weight (kg)' },
        element: { type: 'plain_text_input', action_id: 'v', ...(d.tonnageKg ? { initial_value: String(d.tonnageKg) } : {}) },
      },
    ],
  };
}

export function registerDispatchFlow(app: App): void {
  // /dispatch → pick a pending sale order.
  app.command('/dispatch', async ({ command, ack, client, respond }) => {
    await ack();
    const user = await resolveErpUser(command.user_id);
    if (!user) {
      await respond({ response_type: 'ephemeral', text: NOT_LINKED_MESSAGE });
      return;
    }
    let orders: any[];
    try {
      orders = await apiGet('/sale-orders?status=PENDING', user);
    } catch (err) {
      await respond({ response_type: 'ephemeral', text: `:x: Couldn't load sale orders: ${(err as Error).message}` });
      return;
    }
    if (!orders.length) {
      await respond({ response_type: 'ephemeral', text: 'No pending sale orders to dispatch.' });
      return;
    }
    await client.chat.postMessage({
      channel: command.channel_id,
      text: 'Dispatch a sale order',
      blocks: [
        headerBlock('Dispatch'),
        selectSection(
          `${FLOW}:select`,
          'Which sale order are you dispatching?',
          'Select sale order',
          orders.map((o) => ({
            text: `${o.buyer?.name ?? '?'} · ${o.product} · ${Math.round((o.tonnageKg ?? 0) / 1000)}t · ${rupees(Number(o.ratePerKg))}/kg`,
            value: o.id,
          }))
        ),
      ],
    });
  });

  // Order selected → open the kata-upload thread.
  app.action(`${FLOW}:select`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    const user = await resolveErpUser(b.user.id);
    if (!user) return;
    const orderId = b.actions[0].selected_option.value;
    const order = await apiGet(`/sale-orders/${orderId}`, user);
    const threadTs = b.message.ts as string;

    setDraft(keyFor(b.channel.id, threadTs), {
      flow: FLOW,
      user,
      slackUserId: b.user.id,
      channel: b.channel.id,
      threadTs,
      data: {
        saleOrderId: orderId,
        label: `${order.buyer?.name ?? ''} · ${order.product} · ${rupees(Number(order.ratePerKg))}/kg`,
        product: order.product,
        ratePerKg: Number(order.ratePerKg),
        step: 'await_kata',
      } as DispatchDraftData,
    });

    await client.chat.update({
      channel: b.channel.id,
      ts: threadTs,
      text: 'Dispatch started',
      blocks: [
        headerBlock('Dispatch'),
        contextBlock(`${order.buyer?.name ?? ''} · ${order.product}`),
        contextBlock(':arrow_up: Upload the *RVP kata / carter slip* in this thread.'),
      ],
    });
  });

  // Kata slip uploaded into a dispatch thread.
  app.message(async ({ message, client }) => {
    const m = message as any;
    if (m.bot_id || !m.files?.length || !m.thread_ts) return;
    const key = keyFor(m.channel, m.thread_ts);
    const draft = getDraft<DispatchDraftData>(key);
    if (!draft || draft.data.step !== 'await_kata') return;

    let downloaded: DownloadedFile;
    try {
      downloaded = await downloadSlackFile(m.files[0]);
    } catch (err) {
      await client.chat.postMessage({ channel: m.channel, thread_ts: m.thread_ts, text: `:x: ${(err as Error).message}` });
      return;
    }
    try {
      const r = await extractInvoiceData(downloaded.buffer, downloaded.mimetype, 'partyKata');
      if (r.partyKataKg) draft.data.tonnageKg = r.partyKataKg;
      if (r.lorryNumber) draft.data.vehicleNumber = r.lorryNumber;
    } catch (err) {
      await client.chat.postMessage({ channel: m.channel, thread_ts: m.thread_ts, text: `:x: Couldn't read the kata slip: ${(err as Error).message}. Try again.` });
      return;
    }
    draft.data.kataFile = downloaded;
    draft.data.step = 'review';
    setDraft(key, draft);
    await client.chat.postMessage({ channel: m.channel, thread_ts: m.thread_ts, text: 'Review dispatch', blocks: reviewBlocks(draft.data) });
  });

  app.action(`${FLOW}:edit`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    const threadTs = b.message.thread_ts ?? b.message.ts;
    const draft = getDraft<DispatchDraftData>(keyFor(b.channel.id, threadTs));
    if (!draft) return;
    await client.views.open({ trigger_id: b.trigger_id, view: editModal(draft.data, b.channel.id, b.message.ts, threadTs) });
  });

  app.view(`${FLOW}:edit_submit`, async ({ ack, view, client }) => {
    const meta = JSON.parse(view.private_metadata || '{}');
    const w = parseInt((view.state.values as any).weight?.v?.value, 10);
    if (isNaN(w) || w <= 0) {
      await ack({ response_action: 'errors', errors: { weight: 'Enter a weight in kg.' } });
      return;
    }
    await ack();
    const key = keyFor(meta.channel, meta.threadTs);
    const draft = getDraft<DispatchDraftData>(key);
    if (!draft) return;
    draft.data.tonnageKg = w;
    draft.data.vehicleNumber = (view.state.values as any).vehicle?.v?.value || draft.data.vehicleNumber;
    setDraft(key, draft);
    await client.chat.update({ channel: meta.channel, ts: meta.messageTs, text: 'Review dispatch', blocks: reviewBlocks(draft.data) });
  });

  // Approve → dispatch (multipart kata) → show Raise Invoice button.
  app.action(`${FLOW}:approve`, async ({ ack, body, client, respond }) => {
    await ack();
    const b = body as any;
    const threadTs = b.message.thread_ts ?? b.message.ts;
    const key = keyFor(b.channel.id, threadTs);
    const draft = getDraft<DispatchDraftData>(key);
    if (!draft) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: 'This draft has expired. Run `/dispatch` again.' });
      return;
    }
    const d = draft.data;
    if (!d.tonnageKg) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: ':x: Dispatched weight missing — use *Edit*.' });
      return;
    }
    try {
      const order = await apiPostMultipart(
        `/sale-orders/${d.saleOrderId}/dispatch`,
        { vehicleNumber: d.vehicleNumber, tonnageKg: d.tonnageKg },
        d.kataFile ? [{ field: 'kata', buffer: d.kataFile.buffer, filename: d.kataFile.filename, mimetype: d.kataFile.mimetype }] : [],
        draft.user
      );
      clearDraft(key);
      await client.chat.update({
        channel: b.channel.id,
        ts: b.message.ts,
        text: 'Dispatched',
        blocks: [
          headerBlock('✅ Dispatched'),
          contextBlock(d.label),
          fieldsSection([
            { label: 'Vehicle', value: d.vehicleNumber ?? '—' },
            { label: 'Weight', value: `${order.tonnageKg} kg` },
            { label: 'GST (5%)', value: rupees(Number(order.gstAmount)) },
            { label: 'Status', value: order.status },
          ]),
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Raise Invoice', emoji: true },
                style: 'primary',
                action_id: `${FLOW}:raise_invoice`,
                value: d.saleOrderId,
              },
            ],
          },
        ],
      });
    } catch (err) {
      const msg = err instanceof ErpApiError ? err.message : (err as Error).message;
      await respond({ response_type: 'ephemeral', replace_original: false, text: `:x: Couldn't dispatch: ${msg}` });
    }
  });

  // Raise the tax invoice (auto-numbered).
  app.action(`${FLOW}:raise_invoice`, async ({ ack, body, client, respond }) => {
    await ack();
    const b = body as any;
    const user = await resolveErpUser(b.user.id);
    if (!user) return;
    const saleOrderId = b.actions[0].value;
    try {
      const order = await apiPost(`/sale-orders/${saleOrderId}/invoice`, {}, user);
      await client.chat.update({
        channel: b.channel.id,
        ts: b.message.ts,
        text: 'Invoice raised',
        blocks: [
          headerBlock('🧾 Invoice raised'),
          fieldsSection([
            { label: 'Invoice number', value: order.invoiceNumber ?? '—' },
            { label: 'Buyer', value: order.buyer?.name ?? '—' },
            { label: 'Weight', value: `${order.tonnageKg} kg` },
            { label: 'Status', value: order.status },
          ]),
          contextBlock('Print/render the invoice from the web app.'),
        ],
      });
    } catch (err) {
      const msg = err instanceof ErpApiError ? err.message : (err as Error).message;
      await respond({ response_type: 'ephemeral', replace_original: false, text: `:x: Couldn't raise the invoice: ${msg}` });
    }
  });

  app.action(`${FLOW}:cancel`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    const threadTs = b.message.thread_ts ?? b.message.ts;
    clearDraft(keyFor(b.channel.id, threadTs));
    await client.chat.update({ channel: b.channel.id, ts: b.message.ts, text: 'Cancelled', blocks: [headerBlock('Dispatch'), contextBlock(':wastebasket: Cancelled.')] });
  });
}
