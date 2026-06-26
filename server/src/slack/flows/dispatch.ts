import type { App } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import { extractInvoiceData } from '../../lib/gemini.js';
import { resolveErpUser, NOT_LINKED_MESSAGE } from '../users.js';
import { apiGet, apiPostMultipart, apiPost, ErpApiError, type ErpUser } from '../erpClient.js';
import { getDraft, setDraft, clearDraft } from '../state.js';
import { downloadSlackFile, type DownloadedFile } from '../slackFiles.js';
import { headerBlock, contextBlock, fieldsSection, approveEditCancel, selectSection } from '../blocks.js';
import { rupees } from '../parse.js';

const FLOW = 'dispatch';

/** A sale order with weight still to ship, summarised for the picker. */
interface OpenOrder {
  id: string;
  label: string;
  buyerName: string;
  product: string;
  ratePerKg: number;
  remainingKg: number;
}

interface DispatchDraftData {
  step: 'review';
  // Resolved once a sale order is matched/picked (undefined until then).
  saleOrderId?: string;
  label?: string;
  product?: string;
  ratePerKg?: number;
  // OCR'd / typed off the kata slip.
  vehicleNumber?: string;
  tonnageKg?: number;
  kataFile?: DownloadedFile;
  // Open sale orders, kept so the review-card dropdown can resolve a pick.
  openOrders: OpenOrder[];
}

function keyFor(channel: string, threadTs: string): string {
  return `${FLOW}:${channel}:${threadTs}`;
}

function toOpenOrder(o: any): OpenOrder {
  return {
    id: o.id,
    buyerName: o.buyer?.name ?? '?',
    product: o.product,
    ratePerKg: Number(o.ratePerKg),
    remainingKg: o.remainingKg ?? 0,
    label: `${o.buyer?.name ?? '?'} · ${o.product} · ${Math.round((o.remainingKg ?? 0) / 1000)}t left · ${rupees(Number(o.ratePerKg))}/kg`,
  };
}

/** Apply a matched/picked sale order onto the draft. */
function applyOrder(d: DispatchDraftData, o: OpenOrder): void {
  d.saleOrderId = o.id;
  d.product = o.product;
  d.ratePerKg = o.ratePerKg;
  d.label = `${o.buyerName} · ${o.product} · ${rupees(o.ratePerKg)}/kg`;
}

/** Dropdown listing open sale orders, shown on the review card until one is chosen. */
function soSelectBlock(orders: OpenOrder[]): KnownBlock {
  return selectSection(
    `${FLOW}:so_select`,
    'Which sale order is this dispatch against?',
    'Select sale order',
    orders.map((o) => ({ text: o.label, value: o.id }))
  );
}

/**
 * The upload modal: attach the RVP weighbridge / carter slip (read for weight +
 * lorry number) and optionally type the vehicle. This workspace doesn't deliver
 * message/file events, so files come in via a modal file_input (like stock-in).
 */
function uploadModal(channel: string) {
  return {
    type: 'modal' as const,
    callback_id: `${FLOW}:modal_submit`,
    private_metadata: JSON.stringify({ channel }),
    title: { type: 'plain_text' as const, text: 'Dispatch' },
    submit: { type: 'plain_text' as const, text: 'Read kata' },
    close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks: [
      contextBlock(":mag: Attach the *RVP weighbridge / carter slip* — I'll read the dispatched weight and lorry number. Anything I can't read, you can type on the next card."),
      {
        type: 'input',
        block_id: 'kata',
        optional: true,
        label: { type: 'plain_text', text: 'RVP kata / carter slip' },
        element: { type: 'file_input', action_id: 'f', max_files: 1 },
      },
      {
        type: 'input',
        block_id: 'vehicle',
        optional: true,
        label: { type: 'plain_text', text: 'Vehicle number' },
        element: { type: 'plain_text_input', action_id: 'v' },
      },
    ],
  };
}

function reviewBlocks(d: DispatchDraftData, note?: string): KnownBlock[] {
  const base = d.tonnageKg && d.ratePerKg ? d.tonnageKg * d.ratePerKg : 0;
  const gst = Math.round(base * 0.05 * 100) / 100;
  const blocks: KnownBlock[] = [headerBlock('Dispatch')];
  if (note) blocks.push(contextBlock(note));
  if (d.saleOrderId) {
    blocks.push(contextBlock(d.label ?? ''));
  } else {
    blocks.push(soSelectBlock(d.openOrders));
  }
  blocks.push(
    fieldsSection([
      { label: 'Buyer / order', value: d.saleOrderId ? (d.label ?? '—') : '_pick above_' },
      { label: 'Product', value: d.product ?? '—' },
      { label: 'Rate', value: d.ratePerKg ? `${rupees(d.ratePerKg)}/kg` : '—' },
      { label: 'Vehicle', value: d.vehicleNumber ?? '_not set_' },
      { label: 'Dispatched weight', value: d.tonnageKg ? `${d.tonnageKg} kg` : '_not set_' },
      { label: 'Amount', value: base ? rupees(base) : '—' },
      { label: 'GST (5%)', value: base ? rupees(gst) : '—' },
    ])
  );
  const missing: string[] = [];
  if (!d.saleOrderId) missing.push('sale order');
  if (!d.tonnageKg) missing.push('dispatched weight');
  if (missing.length) blocks.push(contextBlock(`:pencil2: Missing: ${missing.join(', ')} — pick above or use *Edit*.`));
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

/** Raise the tax invoice for a dispatch and render the final card. */
async function raiseInvoiceCard(
  dispatchId: string,
  user: ErpUser,
  channel: string,
  messageTs: string,
  byUserId: string,
  client: any
): Promise<void> {
  const invoice = await apiPost(`/sale-dispatches/${dispatchId}/invoice`, {}, user);
  await client.chat.update({
    channel,
    ts: messageTs,
    text: 'Dispatched & invoiced',
    blocks: [
      headerBlock('🧾 Dispatched & invoiced'),
      fieldsSection([
        { label: 'Invoice number', value: invoice.invoiceNumber ?? '—' },
        { label: 'Buyer', value: invoice.saleOrder?.buyer?.name ?? '—' },
        { label: 'Weight', value: `${invoice.weightKg} kg` },
        { label: 'GST (5%)', value: rupees(Number(invoice.gstAmount)) },
        { label: 'Status', value: invoice.status },
      ]),
      contextBlock(`Dispatched & invoiced by <@${byUserId}>. Print/render the invoice from the web app.`),
    ],
  });
}

export function registerDispatchFlow(app: App): void {
  // /dispatch → open the kata-upload modal straight away (no sale-order picker first).
  app.command('/dispatch', async ({ command, ack, client, respond }) => {
    await ack();
    const user = await resolveErpUser(command.user_id);
    if (!user) {
      await respond({ response_type: 'ephemeral', text: NOT_LINKED_MESSAGE });
      return;
    }
    let orders: any[];
    try {
      orders = await apiGet('/sale-orders', user);
    } catch (err) {
      await respond({ response_type: 'ephemeral', text: `:x: Couldn't load sale orders: ${(err as Error).message}` });
      return;
    }
    // Anything not yet fully dispatched (PENDING or PARTIAL) can take another lorry.
    const open = orders.filter((o) => (o.remainingKg ?? 0) > 0);
    if (!open.length) {
      await respond({ response_type: 'ephemeral', text: 'No sale orders with weight left to dispatch. Create one with `/sale` first.' });
      return;
    }
    await client.views.open({ trigger_id: command.trigger_id, view: uploadModal(command.channel_id) });
  });

  // Upload modal submitted → read the kata, auto-match the sale order, post review.
  app.view(`${FLOW}:modal_submit`, async ({ ack, body, view, client }) => {
    await ack();
    const meta = JSON.parse(view.private_metadata || '{}');
    const channel = meta.channel as string;
    const user = await resolveErpUser(body.user.id);
    if (!user) return;

    let openOrders: OpenOrder[] = [];
    try {
      const orders = (await apiGet('/sale-orders', user)) as any[];
      openOrders = orders.filter((o) => (o.remainingKg ?? 0) > 0).map(toOpenOrder);
    } catch (err) {
      await client.chat.postMessage({ channel, text: `:x: Couldn't load sale orders: ${(err as Error).message}` });
      return;
    }
    if (!openOrders.length) {
      await client.chat.postMessage({ channel, text: 'No sale orders with weight left to dispatch.' });
      return;
    }

    const data: DispatchDraftData = { step: 'review', openOrders };

    const file = (view.state.values as any).kata?.f?.files?.[0];
    let readError: string | undefined;
    if (file) {
      try {
        const f: DownloadedFile = await downloadSlackFile(file);
        data.kataFile = f; // keep the buffer even if OCR fails — approve re-uploads it
        const r = await extractInvoiceData(f.buffer, f.mimetype, 'partyKata');
        if (r.partyKataKg) data.tonnageKg = r.partyKataKg;
        if (r.lorryNumber) data.vehicleNumber = r.lorryNumber;
      } catch (err) {
        readError = (err as Error).message;
      }
    }
    const vehicleTyped = (view.state.values as any).vehicle?.v?.value?.trim();
    if (vehicleTyped) data.vehicleNumber = vehicleTyped;

    // Auto-fetch the sale order when there's only one open — otherwise the
    // review card shows a dropdown to pick it (a kata slip carries no buyer/rate).
    if (openOrders.length === 1) applyOrder(data, openOrders[0]);

    const note = !data.tonnageKg
      ? readError
        ? `:warning: Couldn't read the slip (${readError}) — type the weight via *Edit*.`
        : ":warning: Couldn't read a weight off that slip — type it via *Edit*."
      : undefined;
    const posted = await client.chat.postMessage({ channel, text: 'Review dispatch', blocks: reviewBlocks(data, note) });
    setDraft(keyFor(channel, posted.ts as string), {
      flow: FLOW,
      user,
      slackUserId: body.user.id,
      channel,
      threadTs: posted.ts as string,
      data,
    });
  });

  // Sale order chosen from the review-card dropdown.
  app.action(`${FLOW}:so_select`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    const threadTs = b.message.thread_ts ?? b.message.ts;
    const key = keyFor(b.channel.id, threadTs);
    const draft = getDraft<DispatchDraftData>(key);
    if (!draft) return;
    const o = draft.data.openOrders.find((x) => x.id === b.actions[0].selected_option.value);
    if (o) applyOrder(draft.data, o);
    setDraft(key, draft);
    await client.chat.update({ channel: b.channel.id, ts: b.message.ts, text: 'Review dispatch', blocks: reviewBlocks(draft.data) });
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

  // Approve → dispatch (multipart kata) → auto-raise the invoice.
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
    if (!d.saleOrderId) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: ':x: Pick the sale order first (dropdown on the card).' });
      return;
    }
    if (!d.tonnageKg) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: ':x: Dispatched weight missing — use *Edit*.' });
      return;
    }
    let dispatch: any;
    try {
      dispatch = await apiPostMultipart(
        `/sale-orders/${d.saleOrderId}/dispatch`,
        { vehicleNumber: d.vehicleNumber, tonnageKg: d.tonnageKg },
        d.kataFile ? [{ field: 'kata', buffer: d.kataFile.buffer, filename: d.kataFile.filename, mimetype: d.kataFile.mimetype }] : [],
        draft.user
      );
    } catch (err) {
      const msg = err instanceof ErpApiError ? err.message : (err as Error).message;
      await respond({ response_type: 'ephemeral', replace_original: false, text: `:x: Couldn't dispatch: ${msg}` });
      return;
    }

    clearDraft(key);
    // Auto-raise the invoice so the dispatch is immediately tracked/numbered.
    try {
      await raiseInvoiceCard(dispatch.id, draft.user, b.channel.id, b.message.ts, b.user.id, client);
    } catch (err) {
      // Dispatch succeeded but invoicing failed — show the dispatched card with a
      // manual Raise Invoice button so it can be retried.
      const msg = err instanceof ErpApiError ? err.message : (err as Error).message;
      await client.chat.update({
        channel: b.channel.id,
        ts: b.message.ts,
        text: 'Dispatched',
        blocks: [
          headerBlock('✅ Dispatched'),
          contextBlock(d.label ?? ''),
          fieldsSection([
            { label: 'Vehicle', value: d.vehicleNumber ?? '—' },
            { label: 'Weight', value: `${dispatch.weightKg} kg` },
            { label: 'GST (5%)', value: rupees(Number(dispatch.gstAmount)) },
            { label: 'Status', value: dispatch.status },
          ]),
          contextBlock(`:warning: Couldn't auto-raise the invoice (${msg}).`),
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Raise Invoice', emoji: true },
                style: 'primary',
                action_id: `${FLOW}:raise_invoice`,
                value: dispatch.id,
              },
            ],
          },
        ],
      });
    }
  });

  // Manual Raise Invoice (fallback when auto-raise failed at approve).
  app.action(`${FLOW}:raise_invoice`, async ({ ack, body, client, respond }) => {
    await ack();
    const b = body as any;
    const user = await resolveErpUser(b.user.id);
    if (!user) return;
    try {
      await raiseInvoiceCard(b.actions[0].value, user, b.channel.id, b.message.ts, b.user.id, client);
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
