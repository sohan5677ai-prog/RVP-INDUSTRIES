import type { App } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import { extractPurchaseOrderText } from '../../lib/gemini.js';
import { resolveErpUser, NOT_LINKED_MESSAGE } from '../users.js';
import { apiGet, apiPost, ErpApiError, type ErpUser } from '../erpClient.js';
import { getDraft, setDraft, clearDraft } from '../state.js';
import {
  headerBlock,
  contextBlock,
  fieldsSection,
  approveEditCancel,
  selectSection,
} from '../blocks.js';
import { tonnesToKg, rupees, fmtDate } from '../parse.js';

const FLOW = 'po';

interface Supplier {
  id: string;
  name: string;
}

interface PoDraftData {
  poDate?: string; // ISO
  partyId?: string;
  partyName?: string;
  tonnageTonnes?: number;
  lorryCount?: number;
  pricePerKg?: number;
  priceType: 'BASE' | 'DELIVERY';
  rawText: string;
  suppliers: Supplier[];
}

function keyFor(channel: string, user: string): string {
  return `${FLOW}:${channel}:${user}`;
}

/** Build the confirmation card from the current draft data. */
function summaryBlocks(d: PoDraftData): KnownBlock[] {
  const blocks: KnownBlock[] = [headerBlock('Purchase Order')];

  if (!d.partyId) {
    blocks.push(
      selectSection(
        `${FLOW}:party_select`,
        d.partyName
          ? `:warning: Couldn't match *${d.partyName}* to a supplier. Pick one:`
          : ':warning: Pick the supplier:',
        'Select supplier',
        d.suppliers.map((s) => ({ text: s.name, value: s.id }))
      )
    );
  }

  blocks.push(
    fieldsSection([
      { label: 'Party', value: d.partyId ? d.partyName ?? '-' : '_not set_' },
      { label: 'PO date', value: d.poDate ? fmtDate(d.poDate) : '_not set_' },
      {
        label: 'Tonnage',
        value: d.tonnageTonnes ? `${d.tonnageTonnes} t (${tonnesToKg(d.tonnageTonnes)} kg)` : '_not set_',
      },
      { label: 'Lorries', value: d.lorryCount ? String(d.lorryCount) : '_not set_' },
      { label: 'Price', value: d.pricePerKg ? `${rupees(d.pricePerKg)}/kg` : '_not set_' },
      { label: 'Price type', value: d.priceType },
    ])
  );

  const missing = poMissing(d);
  if (missing.length > 0) {
    blocks.push(contextBlock(`:pencil2: Missing: ${missing.join(', ')} - use *Edit* to fill in.`));
  }
  blocks.push(approveEditCancel(FLOW, { includeEdit: true }));
  return blocks;
}

function poMissing(d: PoDraftData): string[] {
  const missing: string[] = [];
  if (!d.partyId) missing.push('party');
  if (!d.poDate) missing.push('date');
  if (!d.tonnageTonnes && !d.lorryCount) missing.push('tonnage or lorries');
  if (!d.pricePerKg) missing.push('price');
  return missing;
}

/** Modal for editing or creating PO fields. private_metadata carries channel + message ts. */
function editModal(d: PoDraftData, channel: string, messageTs?: string) {
  const isCreate = !messageTs;
  return {
    type: 'modal' as const,
    callback_id: isCreate ? `${FLOW}:create_submit` : `${FLOW}:edit_submit`,
    private_metadata: JSON.stringify(isCreate ? { channel } : { channel, messageTs }),
    title: { type: 'plain_text' as const, text: isCreate ? 'Create Purchase Order' : 'Edit Purchase Order' },
    submit: { type: 'plain_text' as const, text: isCreate ? 'Create' : 'Save' },
    close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'party',
        label: { type: 'plain_text', text: 'Supplier' },
        element: {
          type: 'static_select',
          action_id: 'v',
          ...(d.partyId
            ? {
                initial_option: {
                  text: { type: 'plain_text', text: (d.partyName ?? '').slice(0, 75) },
                  value: d.partyId,
                },
              }
            : {}),
          options: d.suppliers.length > 0 
            ? d.suppliers.map((s) => ({
                text: { type: 'plain_text', text: s.name.slice(0, 75) },
                value: s.id,
              }))
            : [{ text: { type: 'plain_text', text: 'No suppliers found' }, value: 'none' }],
        },
      },
      {
        type: 'input',
        block_id: 'date',
        label: { type: 'plain_text', text: 'PO date' },
        element: {
          type: 'datepicker',
          action_id: 'v',
          ...(d.poDate ? { initial_date: d.poDate.slice(0, 10) } : {}),
        },
      },
      {
        type: 'input',
        block_id: 'tonnage',
        optional: true,
        label: { type: 'plain_text', text: 'Tonnage (tonnes)' },
        element: {
          type: 'plain_text_input',
          action_id: 'v',
          ...(d.tonnageTonnes ? { initial_value: String(d.tonnageTonnes) } : {}),
        },
      },
      {
        type: 'input',
        block_id: 'lorryCount',
        optional: true,
        label: { type: 'plain_text', text: 'Lorry count' },
        element: {
          type: 'plain_text_input',
          action_id: 'v',
          ...(d.lorryCount ? { initial_value: String(d.lorryCount) } : {}),
        },
      },
      {
        type: 'input',
        block_id: 'price',
        label: { type: 'plain_text', text: 'Price (₹/kg)' },
        element: {
          type: 'plain_text_input',
          action_id: 'v',
          ...(d.pricePerKg ? { initial_value: String(d.pricePerKg) } : {}),
        },
      },
      {
        type: 'input',
        block_id: 'priceType',
        label: { type: 'plain_text', text: 'Price type' },
        element: {
          type: 'static_select',
          action_id: 'v',
          initial_option: {
            text: { type: 'plain_text', text: d.priceType },
            value: d.priceType,
          },
          options: [
            { text: { type: 'plain_text', text: 'DELIVERY' }, value: 'DELIVERY' },
            { text: { type: 'plain_text', text: 'BASE' }, value: 'BASE' },
          ],
        },
      },
    ],
  };
}

async function loadSuppliers(user: ErpUser): Promise<Supplier[]> {
  const parties = await apiGet('/parties', user);
  return (parties as any[])
    .filter((p) => p.type === 'SUPPLIER' || p.type === 'BOTH')
    .map((p) => ({ id: p.id, name: p.name }));
}

export function registerPurchaseOrderFlow(app: App): void {
  // /po <free text>
  app.command('/po', async ({ command, ack, client, respond }) => {
    await ack();
    const user = await resolveErpUser(command.user_id);
    if (!user) {
      await respond({ response_type: 'ephemeral', text: NOT_LINKED_MESSAGE });
      return;
    }
    const text = (command.text || '').trim();
    if (!text) {
      let suppliers: Supplier[];
      try {
        suppliers = await loadSuppliers(user);
      } catch (err) {
        await respond({ response_type: 'ephemeral', text: `:x: Couldn't load suppliers: ${(err as Error).message}` });
        return;
      }
      const data: PoDraftData = {
        poDate: new Date().toISOString().slice(0, 10),
        priceType: 'DELIVERY',
        rawText: '',
        suppliers,
      };
      await client.views.open({
        trigger_id: command.trigger_id,
        view: editModal(data, command.channel_id),
      });
      return;
    }

    let suppliers: Supplier[];
    try {
      suppliers = await loadSuppliers(user);
    } catch (err) {
      await respond({ response_type: 'ephemeral', text: `:x: Couldn't load suppliers: ${(err as Error).message}` });
      return;
    }

    let parsed;
    try {
      parsed = await extractPurchaseOrderText(text, suppliers.map((s) => s.name));
    } catch (err) {
      await respond({ response_type: 'ephemeral', text: `:x: Couldn't read that: ${(err as Error).message}` });
      return;
    }

    // Resolve the party: prefer the confident match, else a loose name contains.
    let partyId: string | undefined;
    let partyName: string | undefined = parsed.partyName;
    if (parsed.matchedPartyName) {
      const m = suppliers.find((s) => s.name === parsed.matchedPartyName);
      if (m) {
        partyId = m.id;
        partyName = m.name;
      }
    }
    if (!partyId && parsed.partyName) {
      const lc = parsed.partyName.toLowerCase();
      const m = suppliers.find((s) => s.name.toLowerCase().includes(lc) || lc.includes(s.name.toLowerCase()));
      if (m) {
        partyId = m.id;
        partyName = m.name;
      }
    }

    const data: PoDraftData = {
      poDate: parsed.poDate ?? new Date().toISOString().slice(0, 10),
      partyId,
      partyName,
      tonnageTonnes: parsed.tonnageTonnes,
      lorryCount: parsed.lorryCount,
      pricePerKg: parsed.pricePerKg,
      priceType: parsed.priceType ?? 'DELIVERY',
      rawText: text,
      suppliers,
    };

    const posted = await client.chat.postMessage({
      channel: command.channel_id,
      text: 'Purchase Order draft',
      blocks: summaryBlocks(data),
    });

    setDraft(keyFor(command.channel_id, command.user_id), {
      flow: FLOW,
      user,
      slackUserId: command.user_id,
      channel: command.channel_id,
      threadTs: posted.ts as string,
      data,
    });
  });

  // Supplier picked from the select menu.
  app.action(`${FLOW}:party_select`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    const key = keyFor(b.channel.id, b.user.id);
    const draft = getDraft<PoDraftData>(key);
    if (!draft) return;
    const selected = b.actions[0].selected_option;
    draft.data.partyId = selected.value;
    draft.data.partyName = draft.data.suppliers.find((s) => s.id === selected.value)?.name;
    setDraft(key, draft);
    await client.chat.update({
      channel: b.channel.id,
      ts: b.message.ts,
      text: 'Purchase Order draft',
      blocks: summaryBlocks(draft.data),
    });
  });

  // Edit → open modal.
  app.action(`${FLOW}:edit`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    const key = keyFor(b.channel.id, b.user.id);
    const draft = getDraft<PoDraftData>(key);
    if (!draft) return;
    await client.views.open({
      trigger_id: b.trigger_id,
      view: editModal(draft.data, b.channel.id, b.message.ts),
    });
  });

  // Create modal submitted (direct from /po without text).
  app.view(`${FLOW}:create_submit`, async ({ ack, body, view, client }) => {
    const v = view.state.values as any;
    const t = parseFloat(v.tonnage?.v?.value);
    const lc = parseInt(v.lorryCount?.v?.value, 10);
    const isValidT = !isNaN(t) && t > 0;
    const isValidLc = !isNaN(lc) && lc > 0;
    
    if (!isValidT && !isValidLc) {
      await ack({
        response_action: 'errors',
        errors: {
          tonnage: 'Provide either tonnage or lorry count',
          lorryCount: 'Provide either tonnage or lorry count',
        },
      });
      return;
    }
    await ack();

    const meta = JSON.parse(view.private_metadata || '{}');
    const user = await resolveErpUser(body.user.id);
    if (!user) return; // shouldn't happen, checked at command time
    
    const partyId = v.party?.v?.selected_option?.value;
    const partyName = v.party?.v?.selected_option?.text?.text;
    const poDate = v.date?.v?.selected_date ?? new Date().toISOString().slice(0, 10);
    const pricePerKg = parseFloat(v.price?.v?.value);
    const priceType = v.priceType?.v?.selected_option?.value === 'BASE' ? 'BASE' : 'DELIVERY';

    try {
      const created = await apiPost(
        '/purchase-orders',
        {
          poDate,
          partyId,
          pricePerKg,
          priceType,
          tonnageKg: isValidT ? tonnesToKg(t) : (isValidLc ? lc * 25000 : 0),
          lorryCount: isValidLc ? lc : undefined,
        },
        user
      );
      
      await client.chat.postMessage({
        channel: meta.channel,
        text: 'Purchase Order created',
        blocks: [
          headerBlock('✅ Purchase Order created'),
          fieldsSection([
            { label: 'PO number', value: created.poNumber ?? created.id },
            { label: 'Party', value: partyName ?? '-' },
            { label: 'PO date', value: poDate ? fmtDate(poDate) : '-' },
            { label: 'Tonnage', value: isValidT ? `${t} t` : `${lc} lorries` },
            { label: 'Price', value: `${rupees(pricePerKg)}/kg (${priceType})` },
          ]),
          contextBlock(`Created directly by <@${body.user.id}>. When a lorry arrives, run \`/stockin\` to receive it.`),
        ],
      });
    } catch (err) {
      const msg = err instanceof ErpApiError ? err.message : (err as Error).message;
      await client.chat.postEphemeral({
        channel: meta.channel,
        user: body.user.id,
        text: `:x: Couldn't create the PO: ${msg}`
      });
    }
  });

  // Edit modal submitted.
  app.view(`${FLOW}:edit_submit`, async ({ ack, body, view, client }) => {
    await ack();
    const meta = JSON.parse(view.private_metadata || '{}');
    const key = keyFor(meta.channel, body.user.id);
    const draft = getDraft<PoDraftData>(key);
    if (!draft) return;
    const v = view.state.values as any;
    const partyId = v.party?.v?.selected_option?.value;
    draft.data.partyId = partyId;
    draft.data.partyName = draft.data.suppliers.find((s) => s.id === partyId)?.name;
    draft.data.poDate = v.date?.v?.selected_date ?? draft.data.poDate;
    const t = parseFloat(v.tonnage?.v?.value);
    if (!isNaN(t) && t > 0) draft.data.tonnageTonnes = t;
    const lc = parseInt(v.lorryCount?.v?.value, 10);
    if (!isNaN(lc) && lc > 0) draft.data.lorryCount = lc;
    const p = parseFloat(v.price?.v?.value);
    if (!isNaN(p) && p > 0) draft.data.pricePerKg = p;
    draft.data.priceType = v.priceType?.v?.selected_option?.value === 'BASE' ? 'BASE' : 'DELIVERY';
    setDraft(key, draft);
    await client.chat.update({
      channel: meta.channel,
      ts: meta.messageTs,
      text: 'Purchase Order draft',
      blocks: summaryBlocks(draft.data),
    });
  });

  // Approve → create the PO via the ERP API as the mapped user.
  app.action(`${FLOW}:approve`, async ({ ack, body, client, respond }) => {
    await ack();
    const b = body as any;
    const key = keyFor(b.channel.id, b.user.id);
    const draft = getDraft<PoDraftData>(key);
    if (!draft) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: 'This draft has expired. Run `/po` again.' });
      return;
    }
    const d = draft.data;
    const missing = poMissing(d);
    if (missing.length > 0) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: `:x: Still missing: ${missing.join(', ')}. Use *Edit*.` });
      return;
    }

    try {
      const created = await apiPost(
        '/purchase-orders',
        {
          poDate: d.poDate,
          partyId: d.partyId,
          pricePerKg: d.pricePerKg,
          priceType: d.priceType,
          tonnageKg: d.tonnageTonnes ? tonnesToKg(d.tonnageTonnes) : (d.lorryCount ? d.lorryCount * 25000 : 0),
          lorryCount: d.lorryCount,
        },
        draft.user
      );
      clearDraft(key);
      const tonnage = d.tonnageTonnes ? `${d.tonnageTonnes} t (${tonnesToKg(d.tonnageTonnes)} kg)` : `${d.lorryCount} lorries`;
      await client.chat.update({
        channel: b.channel.id,
        ts: b.message.ts,
        text: 'Purchase Order created',
        blocks: [
          headerBlock('✅ Purchase Order created'),
          fieldsSection([
            { label: 'PO number', value: created.poNumber ?? created.id },
            { label: 'Party', value: d.partyName ?? '-' },
            { label: 'PO date', value: d.poDate ? fmtDate(d.poDate) : '-' },
            { label: 'Tonnage', value: tonnage },
            { label: 'Lorries', value: d.lorryCount ? String(d.lorryCount) : '1' },
            { label: 'Price', value: `${rupees(d.pricePerKg!)}/kg (${d.priceType})` },
          ]),
          contextBlock(`Created by <@${b.user.id}> · split per-lorry under one order group. When a lorry arrives, run \`/stockin\` to receive it.`),
        ],
      });
    } catch (err) {
      const msg = err instanceof ErpApiError ? err.message : (err as Error).message;
      await respond({ response_type: 'ephemeral', replace_original: false, text: `:x: Couldn't create the PO: ${msg}` });
    }
  });

  // Cancel → discard the draft.
  app.action(`${FLOW}:cancel`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    clearDraft(keyFor(b.channel.id, b.user.id));
    await client.chat.update({
      channel: b.channel.id,
      ts: b.message.ts,
      text: 'Cancelled',
      blocks: [headerBlock('Purchase Order'), contextBlock(':wastebasket: Draft cancelled.')],
    });
  });
}
