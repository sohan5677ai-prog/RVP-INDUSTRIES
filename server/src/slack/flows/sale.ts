import type { App } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import { extractSaleOrderText } from '../../lib/gemini.js';
import { resolveErpUser, NOT_LINKED_MESSAGE } from '../users.js';
import { apiGet, apiPost, ErpApiError, type ErpUser } from '../erpClient.js';
import { getDraft, setDraft, clearDraft } from '../state.js';
import { headerBlock, contextBlock, fieldsSection, approveEditCancel, selectSection } from '../blocks.js';
import { tonnesToKg, rupees, fmtDate } from '../parse.js';

const FLOW = 'sale';
const PRODUCTS = ['PAPPU', 'HUSK', 'WASTE', 'TPS', 'SHELL'];

interface NamedRef {
  id: string;
  name: string;
}

interface SaleDraftData {
  saleDate?: string;
  buyerId?: string;
  buyerName?: string;
  brokerId?: string;
  brokerName?: string;
  product: string;
  tonnageTonnes?: number;
  pricePerKg?: number;
  dueDays?: number;
  brokerageRatePerKg: number;
  marginOverride: boolean;
  buyers: NamedRef[];
  brokers: NamedRef[];
}

function keyFor(channel: string, user: string): string {
  return `${FLOW}:${channel}:${user}`;
}

function saleMissing(d: SaleDraftData): string[] {
  const m: string[] = [];
  if (!d.buyerId) m.push('buyer');
  if (!d.saleDate) m.push('date');
  if (!d.tonnageTonnes) m.push('tonnage');
  if (!d.pricePerKg) m.push('price');
  return m;
}

function summaryBlocks(d: SaleDraftData, marginError?: string): KnownBlock[] {
  const blocks: KnownBlock[] = [headerBlock('Sale Order')];
  if (!d.buyerId) {
    blocks.push(
      selectSection(
        `${FLOW}:buyer_select`,
        d.buyerName ? `:warning: Couldn't match *${d.buyerName}* to a buyer. Pick one:` : ':warning: Pick the buyer:',
        'Select buyer',
        d.buyers.map((b) => ({ text: b.name, value: b.id }))
      )
    );
  }
  blocks.push(
    fieldsSection([
      { label: 'Buyer', value: d.buyerId ? d.buyerName ?? '—' : '_not set_' },
      { label: 'Broker', value: d.brokerId ? d.brokerName ?? '—' : 'None' },
      { label: 'Product', value: d.product },
      { label: 'Sale date', value: d.saleDate ? fmtDate(d.saleDate) : '_not set_' },
      { label: 'Tonnage', value: d.tonnageTonnes ? `${d.tonnageTonnes} t (${tonnesToKg(d.tonnageTonnes)} kg)` : '_not set_' },
      { label: 'Rate', value: d.pricePerKg ? `${rupees(d.pricePerKg)}/kg` : '_not set_' },
      ...(d.dueDays != null ? [{ label: 'Credit days', value: String(d.dueDays) }] : []),
    ])
  );
  if (marginError) {
    blocks.push(contextBlock(`:no_entry: ${marginError}`));
    const elements: any[] = [];
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Override & approve (admin)', emoji: true },
      style: 'danger',
      action_id: `${FLOW}:override`,
    });
    elements.push({ type: 'button', text: { type: 'plain_text', text: 'Cancel', emoji: true }, action_id: `${FLOW}:cancel` });
    blocks.push({ type: 'actions', elements });
    return blocks;
  }
  const missing = saleMissing(d);
  if (missing.length > 0) blocks.push(contextBlock(`:pencil2: Missing: ${missing.join(', ')} — use *Edit*.`));
  blocks.push(approveEditCancel(FLOW, { includeEdit: true }));
  return blocks;
}

function editModal(d: SaleDraftData, channel: string, messageTs: string) {
  const brokerOptions = [
    { text: { type: 'plain_text', text: '— none —' }, value: 'NONE' },
    ...d.brokers.map((b) => ({ text: { type: 'plain_text', text: b.name.slice(0, 75) }, value: b.id })),
  ];
  return {
    type: 'modal' as const,
    callback_id: `${FLOW}:edit_submit`,
    private_metadata: JSON.stringify({ channel, messageTs }),
    title: { type: 'plain_text' as const, text: 'Edit Sale Order' },
    submit: { type: 'plain_text' as const, text: 'Save' },
    close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'buyer',
        label: { type: 'plain_text', text: 'Buyer' },
        element: {
          type: 'static_select',
          action_id: 'v',
          ...(d.buyerId ? { initial_option: { text: { type: 'plain_text', text: (d.buyerName ?? '').slice(0, 75) }, value: d.buyerId } } : {}),
          options: d.buyers.map((b) => ({ text: { type: 'plain_text', text: b.name.slice(0, 75) }, value: b.id })),
        },
      },
      {
        type: 'input',
        block_id: 'broker',
        optional: true,
        label: { type: 'plain_text', text: 'Broker' },
        element: {
          type: 'static_select',
          action_id: 'v',
          initial_option: d.brokerId
            ? { text: { type: 'plain_text', text: (d.brokerName ?? '').slice(0, 75) }, value: d.brokerId }
            : brokerOptions[0],
          options: brokerOptions,
        },
      },
      {
        type: 'input',
        block_id: 'product',
        label: { type: 'plain_text', text: 'Product' },
        element: {
          type: 'static_select',
          action_id: 'v',
          initial_option: { text: { type: 'plain_text', text: d.product }, value: d.product },
          options: PRODUCTS.map((p) => ({ text: { type: 'plain_text', text: p }, value: p })),
        },
      },
      {
        type: 'input',
        block_id: 'date',
        label: { type: 'plain_text', text: 'Sale date' },
        element: { type: 'datepicker', action_id: 'v', ...(d.saleDate ? { initial_date: d.saleDate.slice(0, 10) } : {}) },
      },
      {
        type: 'input',
        block_id: 'tonnage',
        label: { type: 'plain_text', text: 'Tonnage (tonnes)' },
        element: { type: 'plain_text_input', action_id: 'v', ...(d.tonnageTonnes ? { initial_value: String(d.tonnageTonnes) } : {}) },
      },
      {
        type: 'input',
        block_id: 'price',
        label: { type: 'plain_text', text: 'Rate (₹/kg)' },
        element: { type: 'plain_text_input', action_id: 'v', ...(d.pricePerKg ? { initial_value: String(d.pricePerKg) } : {}) },
      },
      {
        type: 'input',
        block_id: 'dueDays',
        optional: true,
        label: { type: 'plain_text', text: 'Credit days' },
        element: { type: 'plain_text_input', action_id: 'v', ...(d.dueDays != null ? { initial_value: String(d.dueDays) } : {}) },
      },
    ],
  };
}

async function loadRefs(user: ErpUser): Promise<{ buyers: NamedRef[]; brokers: NamedRef[] }> {
  const [parties, brokers] = await Promise.all([apiGet('/parties', user), apiGet('/brokers', user)]);
  return {
    buyers: (parties as any[]).filter((p) => p.type === 'BUYER' || p.type === 'BOTH').map((p) => ({ id: p.id, name: p.name })),
    brokers: (brokers as any[]).map((b) => ({ id: b.id, name: b.name })),
  };
}

/** Create the sale order; on a 3% margin 403, surface an admin override. */
async function doCreate(key: string, draft: any, b: any, client: any, respond: any): Promise<void> {
  const d = draft.data as SaleDraftData;
  const missing = saleMissing(d);
  if (missing.length > 0) {
    await respond({ response_type: 'ephemeral', replace_original: false, text: `:x: Still missing: ${missing.join(', ')}. Use *Edit*.` });
    return;
  }
  try {
    const order = await apiPost(
      '/sale-orders',
      {
        saleDate: d.saleDate,
        product: d.product,
        buyerId: d.buyerId,
        brokerId: d.brokerId ?? null,
        tonnageKg: tonnesToKg(d.tonnageTonnes!),
        ratePerKg: d.pricePerKg,
        dueDays: d.dueDays ?? null,
        brokerageRatePerKg: d.brokerageRatePerKg,
        marginOverride: d.marginOverride,
      },
      draft.user
    );
    clearDraft(key);
    await client.chat.update({
      channel: b.channel.id,
      ts: b.message.ts,
      text: 'Sale order created',
      blocks: [
        headerBlock('✅ Sale Order created'),
        fieldsSection([
          { label: 'Buyer', value: d.buyerName ?? '—' },
          { label: 'Product', value: d.product },
          { label: 'Tonnage', value: `${d.tonnageTonnes} t` },
          { label: 'Rate', value: `${rupees(d.pricePerKg!)}/kg` },
          { label: 'Broker', value: d.brokerName ?? 'None' },
          { label: 'GST (5%)', value: rupees(Number(order.gstAmount)) },
        ]),
        contextBlock(`Created by <@${b.user.id}>${d.marginOverride ? ' · margin override applied' : ''}.`),
      ],
    });
  } catch (err) {
    if (err instanceof ErpApiError && err.status === 403) {
      // 3% pappu-margin guard. Offer an override to admins only.
      if (draft.user.role === 'ADMIN') {
        await client.chat.update({ channel: b.channel.id, ts: b.message.ts, text: 'Margin check', blocks: summaryBlocks(d, err.message) });
      } else {
        await respond({ response_type: 'ephemeral', replace_original: false, text: `:no_entry: ${err.message}` });
      }
      return;
    }
    const msg = err instanceof ErpApiError ? err.message : (err as Error).message;
    await respond({ response_type: 'ephemeral', replace_original: false, text: `:x: Couldn't create the sale order: ${msg}` });
  }
}

export function registerSaleFlow(app: App): void {
  app.command('/sale', async ({ command, ack, client, respond }) => {
    await ack();
    const user = await resolveErpUser(command.user_id);
    if (!user) {
      await respond({ response_type: 'ephemeral', text: NOT_LINKED_MESSAGE });
      return;
    }
    const text = (command.text || '').trim();
    if (!text) {
      await respond({
        response_type: 'ephemeral',
        text: 'Usage: `/sale <buyer>, broker <name>, <tonnage> <product>, <rate>` — e.g. `/sale Krishna Exports, broker Ramesh, 20t pappu, 95/kg`',
      });
      return;
    }

    let refs;
    try {
      refs = await loadRefs(user);
    } catch (err) {
      await respond({ response_type: 'ephemeral', text: `:x: Couldn't load buyers/brokers: ${(err as Error).message}` });
      return;
    }

    let parsed;
    try {
      parsed = await extractSaleOrderText(text, refs.buyers.map((b) => b.name), refs.brokers.map((b) => b.name));
    } catch (err) {
      await respond({ response_type: 'ephemeral', text: `:x: Couldn't read that: ${(err as Error).message}` });
      return;
    }

    let buyerId: string | undefined;
    let buyerName: string | undefined = parsed.buyerName;
    if (parsed.matchedBuyerName) {
      const m = refs.buyers.find((b) => b.name === parsed.matchedBuyerName);
      if (m) { buyerId = m.id; buyerName = m.name; }
    }
    if (!buyerId && parsed.buyerName) {
      const lc = parsed.buyerName.toLowerCase();
      const m = refs.buyers.find((b) => b.name.toLowerCase().includes(lc) || lc.includes(b.name.toLowerCase()));
      if (m) { buyerId = m.id; buyerName = m.name; }
    }
    let brokerId: string | undefined;
    let brokerName: string | undefined = parsed.brokerName;
    if (parsed.matchedBrokerName) {
      const m = refs.brokers.find((b) => b.name === parsed.matchedBrokerName);
      if (m) { brokerId = m.id; brokerName = m.name; }
    }

    const data: SaleDraftData = {
      saleDate: parsed.saleDate ?? new Date().toISOString().slice(0, 10),
      buyerId,
      buyerName,
      brokerId,
      brokerName,
      product: parsed.product ?? 'PAPPU',
      tonnageTonnes: parsed.tonnageTonnes,
      pricePerKg: parsed.pricePerKg,
      brokerageRatePerKg: 0,
      marginOverride: false,
      buyers: refs.buyers,
      brokers: refs.brokers,
    };

    const posted = await client.chat.postMessage({ channel: command.channel_id, text: 'Sale Order draft', blocks: summaryBlocks(data) });
    setDraft(keyFor(command.channel_id, command.user_id), {
      flow: FLOW,
      user,
      slackUserId: command.user_id,
      channel: command.channel_id,
      threadTs: posted.ts as string,
      data,
    });
  });

  app.action(`${FLOW}:buyer_select`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    const key = keyFor(b.channel.id, b.user.id);
    const draft = getDraft<SaleDraftData>(key);
    if (!draft) return;
    const sel = b.actions[0].selected_option;
    draft.data.buyerId = sel.value;
    draft.data.buyerName = draft.data.buyers.find((x) => x.id === sel.value)?.name;
    setDraft(key, draft);
    await client.chat.update({ channel: b.channel.id, ts: b.message.ts, text: 'Sale Order draft', blocks: summaryBlocks(draft.data) });
  });

  app.action(`${FLOW}:edit`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    const draft = getDraft<SaleDraftData>(keyFor(b.channel.id, b.user.id));
    if (!draft) return;
    await client.views.open({ trigger_id: b.trigger_id, view: editModal(draft.data, b.channel.id, b.message.ts) });
  });

  app.view(`${FLOW}:edit_submit`, async ({ ack, body, view, client }) => {
    await ack();
    const meta = JSON.parse(view.private_metadata || '{}');
    const key = keyFor(meta.channel, body.user.id);
    const draft = getDraft<SaleDraftData>(key);
    if (!draft) return;
    const d = draft.data;
    const v = view.state.values as any;
    const buyerId = v.buyer?.v?.selected_option?.value;
    if (buyerId) { d.buyerId = buyerId; d.buyerName = d.buyers.find((x) => x.id === buyerId)?.name; }
    const brokerVal = v.broker?.v?.selected_option?.value;
    if (brokerVal === 'NONE' || !brokerVal) { d.brokerId = undefined; d.brokerName = undefined; }
    else { d.brokerId = brokerVal; d.brokerName = d.brokers.find((x) => x.id === brokerVal)?.name; }
    d.product = v.product?.v?.selected_option?.value ?? d.product;
    d.saleDate = v.date?.v?.selected_date ?? d.saleDate;
    const t = parseFloat(v.tonnage?.v?.value);
    if (!isNaN(t) && t > 0) d.tonnageTonnes = t;
    const p = parseFloat(v.price?.v?.value);
    if (!isNaN(p) && p > 0) d.pricePerKg = p;
    const dd = parseInt(v.dueDays?.v?.value, 10);
    d.dueDays = isNaN(dd) ? undefined : dd;
    setDraft(key, draft);
    await client.chat.update({ channel: meta.channel, ts: meta.messageTs, text: 'Sale Order draft', blocks: summaryBlocks(d) });
  });

  app.action(`${FLOW}:approve`, async ({ ack, body, client, respond }) => {
    await ack();
    const b = body as any;
    const key = keyFor(b.channel.id, b.user.id);
    const draft = getDraft<SaleDraftData>(key);
    if (!draft) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: 'This draft has expired. Run `/sale` again.' });
      return;
    }
    await doCreate(key, draft, b, client, respond);
  });

  app.action(`${FLOW}:override`, async ({ ack, body, client, respond }) => {
    await ack();
    const b = body as any;
    const key = keyFor(b.channel.id, b.user.id);
    const draft = getDraft<SaleDraftData>(key);
    if (!draft) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: 'This draft has expired. Run `/sale` again.' });
      return;
    }
    if (draft.user.role !== 'ADMIN') {
      await respond({ response_type: 'ephemeral', replace_original: false, text: ':lock: Only an admin can override the margin guard.' });
      return;
    }
    draft.data.marginOverride = true;
    setDraft(key, draft);
    await doCreate(key, draft, b, client, respond);
  });

  app.action(`${FLOW}:cancel`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    clearDraft(keyFor(b.channel.id, b.user.id));
    await client.chat.update({ channel: b.channel.id, ts: b.message.ts, text: 'Cancelled', blocks: [headerBlock('Sale Order'), contextBlock(':wastebasket: Draft cancelled.')] });
  });
}
