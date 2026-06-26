import type { App } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import { extractInvoiceData, type DocumentKind } from '../../lib/gemini.js';
import { resolveErpUser, NOT_LINKED_MESSAGE } from '../users.js';
import { apiGet, apiPostMultipart, ErpApiError, type ErpUser } from '../erpClient.js';
import { getDraft, setDraft, clearDraft } from '../state.js';
import { downloadSlackFile, type DownloadedFile } from '../slackFiles.js';
import {
  headerBlock,
  contextBlock,
  fieldsSection,
  approveEditCancel,
} from '../blocks.js';
import { fmtDate, rupees } from '../parse.js';
import { startPurchaseForStockIn } from './purchase.js';

const FLOW = 'stockin';
const LOCATIONS = ['At process', 'Rampalli', 'Murgan', 'Multi'];

// The flow now PICKS THE PO FIRST (reliable manual choice from the pending list)
// and then reads each slip on demand, ONE document = ONE Gemini call. This avoids
// the old three-call burst (which tripped Gemini's rate limit) and removes the
// fragile invoice→PO auto-matching that often failed. Every slip is optional:
// anything not read can be typed via Edit.

// The three readable slips. (Same DocumentKind values the OCR layer understands.)
type ReadKind = Extract<DocumentKind, 'invoice' | 'partyKata' | 'rvpWeight'>;
const DOC_LABEL: Record<ReadKind, string> = {
  invoice: 'Supplier invoice',
  partyKata: 'Party kata (weighbridge) slip',
  rvpWeight: 'Our RVP kata (first-weight) slip',
};

interface StockInDraftData {
  // The PO is chosen up front, so these are always set on the review card.
  poId: string;
  poNumber: string;
  partyName: string;
  priceType: 'BASE' | 'DELIVERY';
  // Fields filled by OCR or typed on the Edit modal.
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

/** Build the initial draft once a PO has been picked. */
function draftFromPo(po: any, location: string): StockInDraftData {
  return {
    poId: po.id,
    poNumber: po.poNumber ?? po.id,
    partyName: po.party?.name ?? '?',
    priceType: po.priceType === 'BASE' ? 'BASE' : 'DELIVERY',
    loadingLocation: location,
    freightCharge: 0,
    arrivalDate: new Date().toISOString().slice(0, 10),
  };
}

/** Step 1 modal: pick the pending PO this lorry is against + loading location. */
function poPickModal(pos: any[], channel: string) {
  return {
    type: 'modal' as const,
    callback_id: `${FLOW}:po_submit`,
    private_metadata: JSON.stringify({ channel }),
    title: { type: 'plain_text' as const, text: 'Stock-in' },
    submit: { type: 'plain_text' as const, text: 'Start' },
    close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks: [
      contextBlock(
        ":package: Pick the purchase order this lorry is against. On the next card you can read each slip with AI — *one at a time* — or just type the values."
      ),
      {
        type: 'input',
        block_id: 'po',
        label: { type: 'plain_text', text: 'Purchase order' },
        element: {
          type: 'static_select',
          action_id: 'v',
          // Slack caps a static_select at 100 options. Pending POs come back
          // newest-first, so the 100 most recent are the ones a lorry is most
          // likely against; older ones can still be received via the web ERP.
          options: pos.slice(0, 100).map((p) => ({
            text: {
              type: 'plain_text',
              text: `${p.poNumber ?? p.id} · ${p.party?.name ?? '?'} · ${Math.round((p.tonnageKg ?? 0) / 1000)}t · ₹${Number(p.pricePerKg)}/kg`.slice(0, 75),
            },
            value: p.id,
          })),
        },
      },
      {
        type: 'input',
        block_id: 'location',
        label: { type: 'plain_text', text: 'Loading location' },
        element: {
          type: 'static_select',
          action_id: 'v',
          initial_option: { text: { type: 'plain_text', text: 'At process' }, value: 'At process' },
          options: LOCATIONS.map((l) => ({ text: { type: 'plain_text', text: l }, value: l })),
        },
      },
    ],
  };
}

/** A single-file upload modal for one slip kind (one Gemini call on submit). */
function readDocModal(kind: ReadKind, channel: string, threadTs: string) {
  return {
    type: 'modal' as const,
    callback_id: `${FLOW}:read_submit`,
    private_metadata: JSON.stringify({ channel, threadTs, kind }),
    title: { type: 'plain_text' as const, text: 'Read slip' },
    submit: { type: 'plain_text' as const, text: 'Read' },
    close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks: [
      contextBlock(`:mag: Attach the *${DOC_LABEL[kind]}* — I'll read it and fill the matching fields.`),
      {
        type: 'input',
        block_id: 'file',
        label: { type: 'plain_text', text: DOC_LABEL[kind] },
        element: { type: 'file_input', action_id: 'f', max_files: 1 },
      },
    ],
  };
}

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

/** Action row of the three "read a slip" buttons (one Gemini call each). */
function readButtons(): KnownBlock {
  return {
    type: 'actions',
    elements: [
      { type: 'button', text: { type: 'plain_text', text: '📄 Read invoice', emoji: true }, action_id: `${FLOW}:read_invoice` },
      { type: 'button', text: { type: 'plain_text', text: '⚖️ Read party kata', emoji: true }, action_id: `${FLOW}:read_partykata` },
      { type: 'button', text: { type: 'plain_text', text: '🏭 Read RVP weight', emoji: true }, action_id: `${FLOW}:read_rvp` },
    ],
  };
}

function reviewBlocks(d: StockInDraftData, note?: string): KnownBlock[] {
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
  if (note) blocks.push(contextBlock(note));
  const missing = reviewMissing(d);
  if (missing.length > 0) {
    blocks.push(contextBlock(`:pencil2: Missing: ${missing.join(', ')} — read the slip above or tap *Edit* to type it.`));
  }
  blocks.push(readButtons());
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
  // /stockin → pick the pending PO first (reliable), then read slips on demand.
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
      await respond({ response_type: 'ephemeral', text: 'No pending purchase orders to receive against. Create one with `/po` first.' });
      return;
    }
    await client.views.open({ trigger_id: command.trigger_id, view: poPickModal(pos, command.channel_id) });
  });

  // PO picked → post the review card (no OCR yet; slips are read on demand).
  app.view(`${FLOW}:po_submit`, async ({ ack, body, view, client }) => {
    await ack();
    const meta = JSON.parse(view.private_metadata || '{}');
    const channel = meta.channel as string;
    const user = await resolveErpUser(body.user.id);
    if (!user) return;
    const v = view.state.values as any;
    const poId = v.po?.v?.selected_option?.value;
    const location = v.location?.v?.selected_option?.value ?? 'At process';
    let po: any;
    try {
      po = await apiGet(`/purchase-orders/${poId}`, user);
    } catch (err) {
      await client.chat.postMessage({ channel, text: `:x: ${(err as Error).message}` });
      return;
    }
    const data = draftFromPo(po, location);
    const posted = await client.chat.postMessage({ channel, text: 'Review stock-in', blocks: reviewBlocks(data) });
    setDraft(keyFor(channel, posted.ts as string), {
      flow: FLOW,
      user,
      slackUserId: body.user.id,
      channel,
      threadTs: posted.ts as string,
      data,
    });
  });

  // "Read <slip>" buttons → open a single-file upload modal for that slip kind.
  const READ_ACTIONS: Record<string, ReadKind> = {
    read_invoice: 'invoice',
    read_partykata: 'partyKata',
    read_rvp: 'rvpWeight',
  };
  for (const [action, kind] of Object.entries(READ_ACTIONS)) {
    app.action(`${FLOW}:${action}`, async ({ ack, body, client }) => {
      await ack();
      const b = body as any;
      const threadTs = b.message.thread_ts ?? b.message.ts;
      await client.views.open({ trigger_id: b.trigger_id, view: readDocModal(kind, b.channel.id, threadTs) });
    });
  }

  // Slip uploaded → ONE Gemini call, fill the relevant fields, refresh the card.
  app.view(`${FLOW}:read_submit`, async ({ ack, view, client }) => {
    await ack();
    const meta = JSON.parse(view.private_metadata || '{}');
    const channel = meta.channel as string;
    const threadTs = meta.threadTs as string;
    const kind = meta.kind as ReadKind;
    const key = keyFor(channel, threadTs);
    const draft = getDraft<StockInDraftData>(key);
    if (!draft) return;
    const d = draft.data;
    const v = view.state.values as any;
    const file = v.file?.f?.files?.[0];
    if (!file) return;

    // Show progress while Gemini reads (the modal has already closed on ack).
    await client.chat.update({
      channel,
      ts: threadTs,
      text: 'Reading slip…',
      blocks: reviewBlocks(d, `:hourglass_flowing_sand: Reading the ${DOC_LABEL[kind]}…`),
    });

    try {
      const f = await downloadSlackFile(file);
      // The PO is already chosen, so the invoice read needs no supplier matching.
      const r = await extractInvoiceData(f.buffer, f.mimetype, kind);
      if (kind === 'invoice') {
        d.invoiceFile = f; // persist the invoice file even if some fields didn't read
        if (r.invoiceNumber) d.invoiceNumber = r.invoiceNumber;
        if (r.billingWeightKg) d.billingWeightKg = r.billingWeightKg;
        if (r.arrivalDate) d.arrivalDate = r.arrivalDate;
        if (!d.lorryNumber && r.lorryNumber) d.lorryNumber = r.lorryNumber;
      } else if (kind === 'partyKata') {
        if (r.partyKataKg) d.partyKataKg = r.partyKataKg;
        if (!d.lorryNumber && r.lorryNumber) d.lorryNumber = r.lorryNumber;
      } else if (kind === 'rvpWeight') {
        if (r.rvpFirstWeightKg) d.rvpFirstWeightKg = r.rvpFirstWeightKg;
        if (!d.lorryNumber && r.lorryNumber) d.lorryNumber = r.lorryNumber;
      }
      setDraft(key, draft);
      await client.chat.update({
        channel,
        ts: threadTs,
        text: 'Review stock-in',
        blocks: reviewBlocks(d, `:white_check_mark: Read the ${DOC_LABEL[kind]}. Check the values below.`),
      });
    } catch (err) {
      // A single failed read is non-fatal — keep the PO/other fields and let the
      // user type this one. (Common cause: Gemini quota/billing — far rarer now
      // that we make one call at a time.)
      setDraft(key, draft);
      await client.chat.update({
        channel,
        ts: threadTs,
        text: 'Review stock-in',
        blocks: reviewBlocks(d, `:warning: Couldn't read the ${DOC_LABEL[kind]} (${(err as Error).message}). Tap *Edit* to type it.`),
      });
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

    try {
      // The invoice file is optional (the ERP stores a blank URL when absent —
      // e.g. the invoice values were typed rather than read from a photo).
      const files = d.invoiceFile
        ? [{ field: 'invoice', buffer: d.invoiceFile.buffer, filename: d.invoiceFile.filename, mimetype: d.invoiceFile.mimetype }]
        : [];
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
        files,
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
          contextBlock(`PO *${d.poNumber}* · ${d.partyName}`),
          fieldsSection([
            { label: 'Arrival date', value: d.arrivalDate ? fmtDate(d.arrivalDate) : '—' },
            { label: 'Lorry', value: d.lorryNumber ?? '—' },
            { label: 'Invoice #', value: d.invoiceNumber ?? '—' },
            { label: 'Billing weight', value: `${d.billingWeightKg} kg` },
            { label: 'Party kata', value: `${d.partyKataKg} kg` },
            { label: 'RVP first weight', value: `${d.rvpFirstWeightKg} kg` },
            { label: 'Location', value: d.loadingLocation },
            ...(d.priceType === 'BASE' ? [{ label: 'Inward freight', value: rupees(d.freightCharge) }] : []),
          ]),
          contextBlock(`Stock-in \`${created.id}\` created by <@${b.user.id}>${status}. :arrow_down: Now record the purchase.`),
        ],
      });

      // Auto-chain into the purchase step (upload the RVP second-weight kata).
      try {
        const fullStockIn = await apiGet(`/stock-in/${created.id}`, draft.user);
        await startPurchaseForStockIn(fullStockIn, draft.user, b.user.id, b.channel.id, client);
      } catch {
        /* non-fatal — the user can still run /purchase manually */
      }
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
