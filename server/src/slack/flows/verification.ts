import type { App } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import { crossVerify } from '../../lib/calc.js';
import { resolveErpUser, NOT_LINKED_MESSAGE } from '../users.js';
import { apiGet, apiPost, ErpApiError, type ErpUser } from '../erpClient.js';
import { getDraft, setDraft, clearDraft } from '../state.js';
import { headerBlock, contextBlock, fieldsSection, selectSection } from '../blocks.js';
import { rupees } from '../parse.js';

const FLOW = 'verify';
type DiscountType = 'WEIGHT' | 'PRICE' | 'AMOUNT';

interface VerifyDraftData {
  purchaseId: string;
  label: string;
  billingWeightKg: number;
  partyKataKg: number;
  rvpKataKg: number;
  pricePerKg: number;
  discountType?: DiscountType;
  discountValue: number;
}

function keyFor(channel: string, user: string): string {
  return `${FLOW}:${channel}:${user}`;
}

/** Pull the verification inputs out of a /purchases/:id response. */
function toDraftData(purchase: any): VerifyDraftData {
  const so = purchase.stockIn;
  const po = so?.purchaseOrder;
  return {
    purchaseId: purchase.id,
    label: `${po?.poNumber ?? ''} · ${po?.party?.name ?? ''} · lorry ${so?.lorryNumber ?? ''}`,
    billingWeightKg: so?.billingWeightKg ?? 0,
    partyKataKg: so?.partyKataKg ?? 0,
    rvpKataKg: purchase.netWeightKg ?? 0,
    pricePerKg: Number(po?.pricePerKg ?? 0),
    discountValue: 0,
  };
}

/** Estimated payable for the preview (no discount): final × price + 5% IGST on billing. */
function estPayable(d: VerifyDraftData, finalWeight: number): number {
  const igst = Math.round(d.billingWeightKg * d.pricePerKg * 0.05 * 100) / 100;
  return finalWeight * d.pricePerKg + igst;
}

function previewBlocks(d: VerifyDraftData): KnownBlock[] {
  const cv = crossVerify(d.billingWeightKg, d.partyKataKg, d.rvpKataKg);
  const discountLabel = d.discountType
    ? `${d.discountType} · ${d.discountType === 'PRICE' ? `${rupees(d.discountValue)}/kg` : d.discountType === 'WEIGHT' ? `${d.discountValue} kg` : rupees(d.discountValue)}`
    : 'None';
  return [
    headerBlock('Weight Verification'),
    contextBlock(d.label),
    fieldsSection([
      { label: 'Billing weight', value: `${d.billingWeightKg} kg` },
      { label: 'Party kata', value: `${d.partyKataKg} kg` },
      { label: 'RVP kata', value: `${d.rvpKataKg} kg` },
      { label: 'Reference', value: `${cv.reference} kg` },
      { label: 'Difference', value: `${cv.diff} kg${cv.exempt ? ' · exempt' : ''}` },
      { label: 'Final weight', value: `${cv.finalWeight} kg` },
      { label: 'Price', value: `${rupees(d.pricePerKg)}/kg` },
      { label: 'Est. payable', value: `${rupees(estPayable(d, cv.finalWeight))} _(before discount)_` },
    ]),
    selectSection(
      `${FLOW}:discount_select`,
      'Discount?',
      'No discount',
      [
        { text: 'None', value: 'NONE' },
        { text: 'Weight (kg off)', value: 'WEIGHT' },
        { text: 'Price (₹/kg off)', value: 'PRICE' },
        { text: 'Amount (₹ off)', value: 'AMOUNT' },
      ]
    ),
    contextBlock(`:information_source: Discount: *${discountLabel}*. Final payable + any shortage debit note are computed on approve.`),
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Approve', emoji: true }, style: 'primary', action_id: `${FLOW}:approve` },
        { type: 'button', text: { type: 'plain_text', text: 'Cancel', emoji: true }, style: 'danger', action_id: `${FLOW}:cancel` },
      ],
    },
  ];
}

function discountValueModal(type: DiscountType, channel: string, messageTs: string, user: string) {
  const label =
    type === 'WEIGHT' ? 'Weight to deduct (kg)' : type === 'PRICE' ? 'Price to deduct (₹/kg)' : 'Amount to deduct (₹)';
  return {
    type: 'modal' as const,
    callback_id: `${FLOW}:discount_submit`,
    private_metadata: JSON.stringify({ type, channel, messageTs, user }),
    title: { type: 'plain_text' as const, text: 'Discount' },
    submit: { type: 'plain_text' as const, text: 'Apply' },
    close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'val',
        label: { type: 'plain_text', text: label },
        element: { type: 'plain_text_input', action_id: 'v' },
      },
    ],
  };
}

async function startVerification(
  purchaseId: string,
  user: ErpUser,
  slackUserId: string,
  channel: string,
  client: any,
  respond?: any
): Promise<void> {
  let purchase: any;
  try {
    purchase = await apiGet(`/purchases/${purchaseId}`, user);
  } catch (err) {
    if (respond) await respond({ response_type: 'ephemeral', text: `:x: ${(err as Error).message}` });
    return;
  }
  if (purchase.verification) {
    if (respond) await respond({ response_type: 'ephemeral', text: 'This purchase is already verified.' });
    return;
  }
  const data = toDraftData(purchase);
  const posted = await client.chat.postMessage({ channel, text: 'Weight verification', blocks: previewBlocks(data) });
  setDraft(keyFor(channel, slackUserId), {
    flow: FLOW,
    user,
    slackUserId,
    channel,
    threadTs: posted.ts as string,
    data,
  });
}

export function registerVerificationFlow(app: App): void {
  // /verify → pick a purchase that has no verification yet.
  app.command('/verify', async ({ command, ack, client, respond }) => {
    await ack();
    const user = await resolveErpUser(command.user_id);
    if (!user) {
      await respond({ response_type: 'ephemeral', text: NOT_LINKED_MESSAGE });
      return;
    }
    let purchases: any[];
    try {
      purchases = await apiGet('/purchases', user);
    } catch (err) {
      await respond({ response_type: 'ephemeral', text: `:x: Couldn't load purchases: ${(err as Error).message}` });
      return;
    }
    const pending = purchases.filter((p) => !p.verification);
    if (!pending.length) {
      await respond({ response_type: 'ephemeral', text: 'No purchases are awaiting verification.' });
      return;
    }
    await client.chat.postMessage({
      channel: command.channel_id,
      text: 'Verify a purchase',
      blocks: [
        headerBlock('Weight Verification'),
        selectSection(
          `${FLOW}:select`,
          'Which purchase do you want to verify?',
          'Select purchase',
          pending.map((p) => ({
            text: `${p.stockIn?.purchaseOrder?.poNumber ?? ''} · ${p.stockIn?.purchaseOrder?.party?.name ?? ''} · lorry ${p.stockIn?.lorryNumber ?? ''} · ${p.netWeightKg}kg`,
            value: p.id,
          }))
        ),
      ],
    });
  });

  // Selected from the /verify list.
  app.action(`${FLOW}:select`, async ({ ack, body, client, respond }) => {
    await ack();
    const b = body as any;
    const user = await resolveErpUser(b.user.id);
    if (!user) return;
    await startVerification(b.actions[0].selected_option.value, user, b.user.id, b.channel.id, client, respond);
  });

  // "Verify now" button on a freshly-recorded purchase (value = purchaseId).
  app.action('verify:start', async ({ ack, body, client, respond }) => {
    await ack();
    const b = body as any;
    const user = await resolveErpUser(b.user.id);
    if (!user) return;
    await startVerification(b.actions[0].value, user, b.user.id, b.channel.id, client, respond);
  });

  // Discount type chosen.
  app.action(`${FLOW}:discount_select`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    const key = keyFor(b.channel.id, b.user.id);
    const draft = getDraft<VerifyDraftData>(key);
    if (!draft) return;
    const choice = b.actions[0].selected_option.value as 'NONE' | DiscountType;
    if (choice === 'NONE') {
      draft.data.discountType = undefined;
      draft.data.discountValue = 0;
      setDraft(key, draft);
      await client.chat.update({ channel: b.channel.id, ts: b.message.ts, text: 'Weight verification', blocks: previewBlocks(draft.data) });
    } else {
      // Need a value → open a modal (we have a trigger_id here).
      await client.views.open({ trigger_id: b.trigger_id, view: discountValueModal(choice, b.channel.id, b.message.ts, b.user.id) });
    }
  });

  // Discount value entered.
  app.view(`${FLOW}:discount_submit`, async ({ ack, view, client }) => {
    const meta = JSON.parse(view.private_metadata || '{}');
    const raw = (view.state.values as any).val?.v?.value;
    const num = parseFloat(raw);
    if (isNaN(num) || num < 0) {
      await ack({ response_action: 'errors', errors: { val: 'Enter a non-negative number.' } });
      return;
    }
    await ack();
    const key = keyFor(meta.channel, meta.user);
    const draft = getDraft<VerifyDraftData>(key);
    if (!draft) return;
    draft.data.discountType = meta.type;
    draft.data.discountValue = num;
    setDraft(key, draft);
    await client.chat.update({ channel: meta.channel, ts: meta.messageTs, text: 'Weight verification', blocks: previewBlocks(draft.data) });
  });

  // Approve → create the verification.
  app.action(`${FLOW}:approve`, async ({ ack, body, client, respond }) => {
    await ack();
    const b = body as any;
    const key = keyFor(b.channel.id, b.user.id);
    const draft = getDraft<VerifyDraftData>(key);
    if (!draft) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: 'This draft has expired. Run `/verify` again.' });
      return;
    }
    const d = draft.data;
    try {
      const result = await apiPost(
        '/verifications',
        { purchaseId: d.purchaseId, discountType: d.discountType ?? null, discountValue: d.discountValue },
        draft.user
      );
      clearDraft(key);
      const blocks: KnownBlock[] = [
        headerBlock('✅ Verification approved'),
        contextBlock(d.label),
        fieldsSection([
          { label: 'Final weight', value: `${result.finalWeightKg} kg` },
          { label: 'Exempt', value: result.exempt ? 'Yes' : 'No' },
          { label: 'Payable (incl. 5% IGST)', value: rupees(Number(result.totalAmount)) },
          { label: 'Price', value: `${rupees(Number(result.pricePerKg))}/kg` },
        ]),
      ];
      if (result.debitNoteAmount) {
        blocks.push(contextBlock(`:warning: *Debit note ${rupees(Number(result.debitNoteAmount))}* — ${result.debitNoteReason}`));
      }
      blocks.push(contextBlock('Stock value & ledger updated; verified batch auto-milled.'));
      await client.chat.update({ channel: b.channel.id, ts: b.message.ts, text: 'Verification approved', blocks });
    } catch (err) {
      const msg = err instanceof ErpApiError ? err.message : (err as Error).message;
      await respond({ response_type: 'ephemeral', replace_original: false, text: `:x: Couldn't verify: ${msg}` });
    }
  });

  app.action(`${FLOW}:cancel`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    clearDraft(keyFor(b.channel.id, b.user.id));
    await client.chat.update({
      channel: b.channel.id,
      ts: b.message.ts,
      text: 'Cancelled',
      blocks: [headerBlock('Weight Verification'), contextBlock(':wastebasket: Cancelled.')],
    });
  });
}
