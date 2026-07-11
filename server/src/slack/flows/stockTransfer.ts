import type { App } from '@slack/bolt';
import { resolveErpUser, NOT_LINKED_MESSAGE } from '../users.js';
import { apiGet, apiPost, ErpApiError, type ErpUser } from '../erpClient.js';
import { headerBlock, contextBlock, fieldsSection } from '../blocks.js';
import { rupees } from '../parse.js';

const FLOW = 'transfer';
const SOURCES = ['PGR COLD', 'Murugan', 'KNM Multi'];

/**
 * Modal for a storage→process black-seed transfer. Hamali, transport and loan
 * interest are computed server-side, so we only collect source, weight, lorry,
 * destination bunker and date. (The ERP transfer record has no file field, so a
 * carter slip can't be attached here - it isn't tracked by the web app either.)
 */
async function transferModal(user: ErpUser, channel: string) {
  // Show current availability per source location to help the user.
  let avail: Record<string, number> = {};
  try {
    const silos = await apiGet('/inventory/silos', user);
    for (const s of silos as any[]) {
      if (s.itemType === 'BLACK_SEED') avail[s.location] = s.weightKg;
    }
  } catch {
    /* non-fatal - show the modal without availability */
  }
  const availLine = SOURCES.map((l) => `${l}: *${(avail[l] ?? 0).toLocaleString('en-IN')} kg*`).join('  ·  ');

  return {
    type: 'modal' as const,
    callback_id: `${FLOW}:submit`,
    private_metadata: JSON.stringify({ channel }),
    title: { type: 'plain_text' as const, text: 'Stock Transfer' },
    submit: { type: 'plain_text' as const, text: 'Transfer' },
    close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks: [
      contextBlock(`Black seed available - ${availLine}`),
      {
        type: 'input',
        block_id: 'source',
        label: { type: 'plain_text', text: 'From storage' },
        element: {
          type: 'static_select',
          action_id: 'v',
          options: SOURCES.map((l) => ({ text: { type: 'plain_text', text: l }, value: l })),
        },
      },
      {
        type: 'input',
        block_id: 'weight',
        label: { type: 'plain_text', text: 'Weight to transfer (kg)' },
        element: { type: 'plain_text_input', action_id: 'v' },
      },
      {
        type: 'input',
        block_id: 'lorry',
        optional: true,
        label: { type: 'plain_text', text: 'Lorry number' },
        element: { type: 'plain_text_input', action_id: 'v' },

      },
      {
        type: 'input',
        block_id: 'date',
        label: { type: 'plain_text', text: 'Transfer date' },
        element: { type: 'datepicker', action_id: 'v', initial_date: new Date().toISOString().slice(0, 10) },
      },
    ],
  };
}

export function registerStockTransferFlow(app: App): void {
  app.command('/transfer', async ({ command, ack, client, respond }) => {
    await ack();
    const user = await resolveErpUser(command.user_id);
    if (!user) {
      await respond({ response_type: 'ephemeral', text: NOT_LINKED_MESSAGE });
      return;
    }
    await client.views.open({ trigger_id: command.trigger_id, view: await transferModal(user, command.channel_id) });
  });

  app.view(`${FLOW}:submit`, async ({ ack, body, view, client }) => {
    const v = view.state.values as any;
    const weight = parseInt(v.weight?.v?.value, 10);
    if (isNaN(weight) || weight <= 0) {
      await ack({ response_action: 'errors', errors: { weight: 'Enter a weight in kg.' } });
      return;
    }
    await ack();

    const user = await resolveErpUser(body.user.id);
    if (!user) return;
    const fromLocation = v.source?.v?.selected_option?.value;
    const lorry = v.lorry?.v?.value || undefined;

    const date = v.date?.v?.selected_date ?? new Date().toISOString().slice(0, 10);

    // Post the result back to the channel the command was invoked from.
    const meta = JSON.parse(view.private_metadata || '{}');
    const channel = meta.channel;
    try {
      const t = await apiPost(
        '/stock-transfers',
        { fromLocation, weightKg: weight, lorryNumber: lorry, transferDate: date },
        user
      );
      await client.chat.postMessage({
        channel,
        text: 'Stock transfer recorded',
        blocks: [
          headerBlock('✅ Stock transfer recorded'),
          contextBlock(`${t.fromLocation} → ${t.toLocation} · ${t.weightKg.toLocaleString('en-IN')} kg${lorry ? ` · lorry ${lorry}` : ''}`),
          fieldsSection([
            { label: 'Seed value moved', value: rupees(Number(t.seedCostMoved)) },
            { label: 'Transport', value: rupees(Number(t.transportCharge)) },
            { label: 'Hamali (unload+handling)', value: rupees(Number(t.loadingHamali) + Number(t.unloadingHamali)) },

            { label: 'Loan interest', value: `${rupees(Number(t.interestCharge))} (${t.interestDays}d)` },
            { label: 'Total value at RVP', value: rupees(Number(t.movedValue)) },
          ]),
          contextBlock(':information_source: Carter slip is not stored on the ERP transfer record.'),
        ],
      });
    } catch (err) {
      const msg = err instanceof ErpApiError ? err.message : (err as Error).message;
      await client.chat.postMessage({ channel, text: `:x: Couldn't record the transfer: ${msg}` });
    }
  });
}
