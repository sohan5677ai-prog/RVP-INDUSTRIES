import type { App } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import { extractInvoiceData } from '../../lib/gemini.js';
import { resolveErpUser, NOT_LINKED_MESSAGE } from '../users.js';
import { apiGet, apiPostMultipart, ErpApiError } from '../erpClient.js';
import { getDraft, setDraft, clearDraft } from '../state.js';
import { downloadSlackFile, type DownloadedFile } from '../slackFiles.js';
import {
  headerBlock,
  contextBlock,
  fieldsSection,
  approveEditCancel,
  selectSection,
} from '../blocks.js';
import { fmtDate, rupees } from '../parse.js';

const FLOW = 'stockin';
const LOCATIONS = ['At process', 'Rampalli', 'Murgan', 'Multi'];

type Step = 'await_invoice' | 'await_partykata' | 'await_rvp' | 'review';

interface StockInDraftData {
  poId: string;
  poNumber: string;
  partyName: string;
  priceType: 'BASE' | 'DELIVERY';
  step: Step;
  // OCR'd fields
  arrivalDate?: string; // ISO
  lorryNumber?: string;
  invoiceNumber?: string;
  billingWeightKg?: number;
  partyKataKg?: number;
  rvpFirstWeightKg?: number;
  loadingLocation: string;
  freightCharge: number;
  // The invoice file is the only document persisted by the ERP.
  invoiceFile?: DownloadedFile;
}

function keyFor(channel: string, threadTs: string): string {
  return `${FLOW}:${channel}:${threadTs}`;
}

const STEP_PROMPT: Record<Exclude<Step, 'review'>, string> = {
  await_invoice: ':arrow_up: Upload the *supplier invoice* in this thread.',
  await_partykata: ':arrow_up: Now upload the *party kata (weighbridge) slip*.',
  await_rvp: ':arrow_up: Now upload the *RVP first-weight slip*.',
};

function reviewMissing(d: StockInDraftData): string[] {
  const missing: string[] = [];
  if (!d.arrivalDate) missing.push('arrival date');
  if (!d.lorryNumber) missing.push('lorry number');
  if (!d.invoiceNumber) missing.push('invoice number');
  if (!d.billingWeightKg) missing.push('billing weight');
  if (!d.partyKataKg) missing.push('party kata weight');
  if (!d.rvpFirstWeightKg) missing.push('RVP first weight');
  return missing;
}

function reviewBlocks(d: StockInDraftData): KnownBlock[] {
  const blocks: KnownBlock[] = [
    headerBlock('Stock-in'),
    contextBlock(`PO *${d.poNumber}* · ${d.partyName}`),
    fieldsSection([
      { label: 'Arrival date', value: d.arrivalDate ? fmtDate(d.arrivalDate) : '_not set_' },
      { label: 'Lorry', value: d.lorryNumber ?? '_not set_' },
      { label: 'Invoice #', value: d.invoiceNumber ?? '_not set_' },
      { label: 'Billing weight', value: d.billingWeightKg ? `${d.billingWeightKg} kg` : '_not set_' },
      { label: 'Party kata', value: d.partyKataKg ? `${d.partyKataKg} kg` : '_not set_' },
      { label: 'RVP first weight', value: d.rvpFirstWeightKg ? `${d.rvpFirstWeightKg} kg` : '_not set_' },
      { label: 'Location', value: d.loadingLocation },
      ...(d.priceType === 'BASE' ? [{ label: 'Inward freight', value: rupees(d.freightCharge) }] : []),
    ]),
  ];
  const missing = reviewMissing(d);
  if (missing.length > 0) {
    blocks.push(contextBlock(`:pencil2: Missing: ${missing.join(', ')} — use *Edit* to fill in.`));
  }
  blocks.push(approveEditCancel(FLOW, { includeEdit: true }));
  return blocks;
}

function editModal(d: StockInDraftData, channel: string, messageTs: string, threadTs: string) {
  const blocks: any[] = [
    {
      type: 'input',
      block_id: 'date',
      label: { type: 'plain_text', text: 'Arrival date' },
      element: { type: 'datepicker', action_id: 'v', ...(d.arrivalDate ? { initial_date: d.arrivalDate.slice(0, 10) } : {}) },
    },
    {
      type: 'input',
      block_id: 'lorry',
      label: { type: 'plain_text', text: 'Lorry number' },
      element: { type: 'plain_text_input', action_id: 'v', ...(d.lorryNumber ? { initial_value: d.lorryNumber } : {}) },
    },
    {
      type: 'input',
      block_id: 'invoice',
      label: { type: 'plain_text', text: 'Invoice number' },
      element: { type: 'plain_text_input', action_id: 'v', ...(d.invoiceNumber ? { initial_value: d.invoiceNumber } : {}) },
    },
    {
      type: 'input',
      block_id: 'billing',
      label: { type: 'plain_text', text: 'Billing weight (kg)' },
      element: { type: 'plain_text_input', action_id: 'v', ...(d.billingWeightKg ? { initial_value: String(d.billingWeightKg) } : {}) },
    },
    {
      type: 'input',
      block_id: 'partykata',
      label: { type: 'plain_text', text: 'Party kata weight (kg)' },
      element: { type: 'plain_text_input', action_id: 'v', ...(d.partyKataKg ? { initial_value: String(d.partyKataKg) } : {}) },
    },
    {
      type: 'input',
      block_id: 'rvp',
      label: { type: 'plain_text', text: 'RVP first weight (kg)' },
      element: { type: 'plain_text_input', action_id: 'v', ...(d.rvpFirstWeightKg ? { initial_value: String(d.rvpFirstWeightKg) } : {}) },
    },
    {
      type: 'input',
      block_id: 'location',
      label: { type: 'plain_text', text: 'Loading location' },
      element: {
        type: 'static_select',
        action_id: 'v',
        initial_option: { text: { type: 'plain_text', text: d.loadingLocation }, value: d.loadingLocation },
        options: LOCATIONS.map((l) => ({ text: { type: 'plain_text', text: l }, value: l })),
      },
    },
  ];
  if (d.priceType === 'BASE') {
    blocks.push({
      type: 'input',
      block_id: 'freight',
      label: { type: 'plain_text', text: 'Inward freight (₹)' },
      element: { type: 'plain_text_input', action_id: 'v', initial_value: String(d.freightCharge) },
    });
  }
  return {
    type: 'modal' as const,
    callback_id: `${FLOW}:edit_submit`,
    private_metadata: JSON.stringify({ channel, messageTs, threadTs }),
    title: { type: 'plain_text' as const, text: 'Edit Stock-in' },
    submit: { type: 'plain_text' as const, text: 'Save' },
    close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks,
  };
}

export function registerStockInFlow(app: App): void {
  // /stockin → pick a pending PO
  app.command('/stockin', async ({ command, ack, client, respond }) => {
    await ack();
    const user = await resolveErpUser(command.user_id);
    if (!user) {
      await respond({ response_type: 'ephemeral', text: NOT_LINKED_MESSAGE });
      return;
    }
    let pos: any[];
    try {
      pos = await apiGet('/purchase-orders?status=PENDING', user);
    } catch (err) {
      await respond({ response_type: 'ephemeral', text: `:x: Couldn't load pending POs: ${(err as Error).message}` });
      return;
    }
    if (!pos.length) {
      await respond({ response_type: 'ephemeral', text: 'No pending purchase orders to receive against.' });
      return;
    }
    await client.chat.postMessage({
      channel: command.channel_id,
      text: 'Start a stock-in',
      blocks: [
        headerBlock('Stock-in'),
        selectSection(
          `${FLOW}:po_select`,
          'Which lorry / PO is arriving?',
          'Select PO',
          pos.map((p) => ({
            text: `${p.poNumber ?? p.id} · ${p.party?.name ?? '?'} · ${Math.round((p.tonnageKg ?? 0) / 1000)}t`,
            value: p.id,
          }))
        ),
      ],
    });
  });

  // PO selected → open the upload thread.
  app.action(`${FLOW}:po_select`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    const user = await resolveErpUser(b.user.id);
    if (!user) return;
    const poId = b.actions[0].selected_option.value;
    const po = await apiGet(`/purchase-orders/${poId}`, user);

    const threadTs = b.message.ts as string;
    const data: StockInDraftData = {
      poId,
      poNumber: po.poNumber ?? poId,
      partyName: po.party?.name ?? '?',
      priceType: po.priceType === 'BASE' ? 'BASE' : 'DELIVERY',
      step: 'await_invoice',
      loadingLocation: 'At process',
      freightCharge: 0,
    };
    setDraft(keyFor(b.channel.id, threadTs), {
      flow: FLOW,
      user,
      slackUserId: b.user.id,
      channel: b.channel.id,
      threadTs,
      data,
    });

    await client.chat.update({
      channel: b.channel.id,
      ts: threadTs,
      text: 'Stock-in started',
      blocks: [
        headerBlock('Stock-in'),
        contextBlock(`PO *${data.poNumber}* · ${data.partyName}`),
        contextBlock(STEP_PROMPT.await_invoice),
      ],
    });
  });

  // Files uploaded into an active stock-in thread.
  app.message(async ({ message, client }) => {
    const m = message as any;
    if (m.bot_id || !m.files?.length || !m.thread_ts) return;
    const key = keyFor(m.channel, m.thread_ts);
    const draft = getDraft<StockInDraftData>(key);
    if (!draft || draft.data.step === 'review') return;

    const d = draft.data;
    const file = m.files[0];
    let downloaded: DownloadedFile;
    try {
      downloaded = await downloadSlackFile(file);
    } catch (err) {
      await client.chat.postMessage({ channel: m.channel, thread_ts: m.thread_ts, text: `:x: ${(err as Error).message}` });
      return;
    }

    try {
      if (d.step === 'await_invoice') {
        const r = await extractInvoiceData(downloaded.buffer, downloaded.mimetype, 'invoice', [d.partyName]);
        if (r.invoiceNumber) d.invoiceNumber = r.invoiceNumber;
        if (r.lorryNumber) d.lorryNumber = r.lorryNumber;
        if (r.arrivalDate) d.arrivalDate = r.arrivalDate;
        if (r.billingWeightKg) d.billingWeightKg = r.billingWeightKg;
        d.invoiceFile = downloaded;
        d.step = 'await_partykata';
      } else if (d.step === 'await_partykata') {
        const r = await extractInvoiceData(downloaded.buffer, downloaded.mimetype, 'partyKata');
        if (r.partyKataKg) d.partyKataKg = r.partyKataKg;
        if (!d.lorryNumber && r.lorryNumber) d.lorryNumber = r.lorryNumber;
        d.step = 'await_rvp';
      } else if (d.step === 'await_rvp') {
        const r = await extractInvoiceData(downloaded.buffer, downloaded.mimetype, 'rvpWeight');
        if (r.rvpFirstWeightKg) d.rvpFirstWeightKg = r.rvpFirstWeightKg;
        if (!d.lorryNumber && r.lorryNumber) d.lorryNumber = r.lorryNumber;
        d.step = 'review';
      }
    } catch (err) {
      await client.chat.postMessage({ channel: m.channel, thread_ts: m.thread_ts, text: `:x: Couldn't read that document: ${(err as Error).message}. Try again.` });
      return;
    }

    if (!d.arrivalDate) d.arrivalDate = new Date().toISOString().slice(0, 10);
    setDraft(key, draft);

    if (d.step === 'review') {
      await client.chat.postMessage({ channel: m.channel, thread_ts: m.thread_ts, text: 'Review stock-in', blocks: reviewBlocks(d) });
    } else {
      await client.chat.postMessage({ channel: m.channel, thread_ts: m.thread_ts, text: STEP_PROMPT[d.step], blocks: [contextBlock(STEP_PROMPT[d.step as Exclude<Step, 'review'>])] });
    }
  });

  // Edit → modal
  app.action(`${FLOW}:edit`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    const threadTs = b.message.thread_ts ?? b.message.ts;
    const draft = getDraft<StockInDraftData>(keyFor(b.channel.id, threadTs));
    if (!draft) return;
    await client.views.open({ trigger_id: b.trigger_id, view: editModal(draft.data, b.channel.id, b.message.ts, threadTs) });
  });

  app.view(`${FLOW}:edit_submit`, async ({ ack, view, client }) => {
    await ack();
    const meta = JSON.parse(view.private_metadata || '{}');
    const key = keyFor(meta.channel, meta.threadTs);
    const draft = getDraft<StockInDraftData>(key);
    if (!draft) return;
    const d = draft.data;
    const v = view.state.values as any;
    d.arrivalDate = v.date?.v?.selected_date ?? d.arrivalDate;
    d.lorryNumber = v.lorry?.v?.value ?? d.lorryNumber;
    d.invoiceNumber = v.invoice?.v?.value ?? d.invoiceNumber;
    const bw = parseInt(v.billing?.v?.value, 10);
    if (!isNaN(bw) && bw > 0) d.billingWeightKg = bw;
    const pk = parseInt(v.partykata?.v?.value, 10);
    if (!isNaN(pk) && pk > 0) d.partyKataKg = pk;
    const rv = parseInt(v.rvp?.v?.value, 10);
    if (!isNaN(rv) && rv > 0) d.rvpFirstWeightKg = rv;
    d.loadingLocation = v.location?.v?.selected_option?.value ?? d.loadingLocation;
    if (d.priceType === 'BASE') {
      const fr = parseFloat(v.freight?.v?.value);
      if (!isNaN(fr) && fr >= 0) d.freightCharge = fr;
    }
    setDraft(key, draft);
    await client.chat.update({ channel: meta.channel, ts: meta.messageTs, text: 'Review stock-in', blocks: reviewBlocks(d) });
  });

  // Approve → create the stock-in (multipart, invoice file forwarded).
  app.action(`${FLOW}:approve`, async ({ ack, body, client, respond }) => {
    await ack();
    const b = body as any;
    const threadTs = b.message.thread_ts ?? b.message.ts;
    const key = keyFor(b.channel.id, threadTs);
    const draft = getDraft<StockInDraftData>(key);
    if (!draft) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: 'This draft has expired. Run `/stockin` again.' });
      return;
    }
    const d = draft.data;
    const missing = reviewMissing(d);
    if (missing.length > 0) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: `:x: Still missing: ${missing.join(', ')}. Use *Edit*.` });
      return;
    }
    if (!d.invoiceFile) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: ':x: The invoice file is missing — re-run `/stockin` and upload the invoice.' });
      return;
    }

    try {
      const created = await apiPostMultipart(
        '/stock-in',
        {
          purchaseOrderId: d.poId,
          arrivalDate: d.arrivalDate,
          lorryNumber: d.lorryNumber,
          invoiceNumber: d.invoiceNumber,
          rvpFirstWeightKg: d.rvpFirstWeightKg,
          billingWeightKg: d.billingWeightKg,
          partyKataKg: d.partyKataKg,
          loadingLocation: d.loadingLocation,
          freightCharge: d.priceType === 'BASE' ? d.freightCharge : 0,
        },
        [{ field: 'invoice', buffer: d.invoiceFile.buffer, filename: d.invoiceFile.filename, mimetype: d.invoiceFile.mimetype }],
        draft.user
      );

      // Re-read the PO to report whether all lorries have now arrived.
      let status = '';
      try {
        const po = await apiGet(`/purchase-orders/${d.poId}`, draft.user);
        status = po.status ? ` · PO now *${po.status}*` : '';
      } catch {
        /* non-fatal */
      }

      clearDraft(key);
      await client.chat.update({
        channel: b.channel.id,
        ts: b.message.ts,
        text: 'Stock-in recorded',
        blocks: [
          headerBlock('✅ Stock-in recorded'),
          fieldsSection([
            { label: 'PO', value: d.poNumber },
            { label: 'Lorry', value: d.lorryNumber ?? '—' },
            { label: 'Invoice #', value: d.invoiceNumber ?? '—' },
            { label: 'RVP first weight', value: `${d.rvpFirstWeightKg} kg` },
          ]),
          contextBlock(`Stock-in \`${created.id}\` created by <@${b.user.id}>${status}.`),
        ],
      });
    } catch (err) {
      const msg = err instanceof ErpApiError ? err.message : (err as Error).message;
      await respond({ response_type: 'ephemeral', replace_original: false, text: `:x: Couldn't record the stock-in: ${msg}` });
    }
  });

  app.action(`${FLOW}:cancel`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    const threadTs = b.message.thread_ts ?? b.message.ts;
    clearDraft(keyFor(b.channel.id, threadTs));
    await client.chat.update({
      channel: b.channel.id,
      ts: b.message.ts,
      text: 'Cancelled',
      blocks: [headerBlock('Stock-in'), contextBlock(':wastebasket: Draft cancelled.')],
    });
  });
}
