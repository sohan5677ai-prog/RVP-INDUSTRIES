import type { App } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { headerBlock, contextBlock, fieldsSection } from '../blocks.js';
import { confirmDelivery } from '../../services/delivery.service.js';
import { notifyDriverKataConfirmed, notifyDriverKataRejected } from '../../services/whatsapp.service.js';
import type { DriverKataSubmission, SaleDispatch, SaleOrder, Party } from '@prisma/client';

export const FLOW = 'driver-kata';

function fmtInr(n: number): string {
  return n.toLocaleString('en-IN');
}

export function kataCardBlocks(
  sub: DriverKataSubmission,
  dispatch: SaleDispatch,
  order: SaleOrder & { buyer: Party },
  extraNote?: string
): KnownBlock[] {
  const dispatchedKg = dispatch.weightKg;
  const kataKg = sub.ocrBuyerKataKg ?? 0;
  const shortageKg = kataKg > 0 ? Math.max(0, dispatchedKg - kataKg) : 0;
  const shortagePct = dispatchedKg > 0 && shortageKg > 0 ? ((shortageKg / dispatchedKg) * 100).toFixed(2) : '0';

  const blocks: KnownBlock[] = [
    headerBlock('📷 Buyer Kata Received (Delivery Review)'),
  ];

  if (extraNote) {
    blocks.push(contextBlock(extraNote));
  }

  // Display the image of the kata slip if available
  if (sub.imageUrl) {
    blocks.push({
      type: 'image',
      image_url: sub.imageUrl,
      alt_text: `Kata slip for lorry ${dispatch.vehicleNumber || 'unknown'}`,
      title: { type: 'plain_text', text: `Kata Slip — ${dispatch.vehicleNumber || ''}`, emoji: true },
    });
  }

  const fields = [
    { label: 'Lorry Number', value: `*${dispatch.vehicleNumber || sub.ocrLorryNumber || 'N/A'}*` },
    { label: 'Driver Phone', value: sub.driverPhone || dispatch.driverPhone || 'N/A' },
    { label: 'Buyer', value: order.buyer.name },
    { label: 'Product / Order', value: `${order.product} (${order.poNumber || order.id.slice(-6)})` },
    { label: 'Dispatched Weight', value: `${fmtInr(dispatchedKg)} kg (${(dispatchedKg / 1000).toFixed(2)} MT)` },
    {
      label: 'Buyer Kata (OCR)',
      value: sub.ocrBuyerKataKg
        ? `*${fmtInr(sub.ocrBuyerKataKg)} kg* (${(sub.ocrBuyerKataKg / 1000).toFixed(2)} MT)`
        : ':warning: Could not read weight',
    },
    {
      label: 'Shortage (Loss)',
      value: shortageKg > 0 ? `*${fmtInr(shortageKg)} kg* (${shortagePct}%)` : 'No shortage (0 kg)',
    },
    {
      label: 'Status',
      value: `*${sub.status}*`,
    },
  ];

  blocks.push(fieldsSection(fields));

  if (sub.status === 'PENDING') {
    blocks.push({
      type: 'actions',
      block_id: `${FLOW}:actions_${sub.id}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Approve & Deliver', emoji: true },
          style: 'primary',
          action_id: `${FLOW}:approve`,
          value: sub.id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '✏️ Edit Weight', emoji: true },
          action_id: `${FLOW}:edit`,
          value: sub.id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '❌ Reject', emoji: true },
          style: 'danger',
          action_id: `${FLOW}:reject`,
          value: sub.id,
        },
      ],
    });
  } else if (sub.status === 'APPROVED') {
    blocks.push(
      contextBlock(
        `✅ *DELIVERED & CONFIRMED* by ${sub.confirmedBy || 'team'} at ${sub.confirmedAt ? new Date(sub.confirmedAt).toLocaleTimeString('en-IN') : ''} | Confirmed: *${fmtInr(sub.confirmedKg ?? sub.ocrBuyerKataKg ?? 0)} kg*`
      )
    );
  } else if (sub.status === 'REJECTED') {
    blocks.push(
      contextBlock(
        `❌ *REJECTED* by ${sub.confirmedBy || 'team'} | Reason: ${sub.rejectionReason || 'Unspecified'}`
      )
    );
  }

  return blocks;
}

export function registerDriverKataFlow(app: App) {
  // 1. Approve action: driver-kata:approve
  app.action(`${FLOW}:approve`, async ({ ack, body, client, respond }) => {
    await ack();
    const b = body as any;
    const submissionId = b.actions?.[0]?.value;
    const userName = (b.user as any)?.name || (b.user as any)?.username || 'Slack user';

    const sub = await prisma.driverKataSubmission.findUnique({
      where: { id: submissionId },
      include: {
        saleDispatch: {
          include: { saleOrder: { include: { buyer: true } } },
        },
      },
    });

    if (!sub) {
      await respond({ text: ':x: Submission not found', replace_original: false });
      return;
    }

    if (sub.status !== 'PENDING') {
      await respond({ text: `:warning: Already ${sub.status}`, replace_original: false });
      return;
    }

    if (!sub.ocrBuyerKataKg || sub.ocrBuyerKataKg <= 0) {
      await respond({
        text: ':warning: Cannot approve without a valid weight. Click *Edit Weight* to enter it manually.',
        replace_original: false,
      });
      return;
    }

    try {
      // Execute delivery
      await confirmDelivery({
        dispatchId: sub.saleDispatchId,
        buyerKataKg: sub.ocrBuyerKataKg,
        deliveredDate: new Date(),
        buyerKataFileUrl: sub.imageUrl,
        submissionId: sub.id,
        confirmedBy: userName,
      });

      const updatedSub = await prisma.driverKataSubmission.findUnique({
        where: { id: sub.id },
      });

      // Update the Slack message card
      if (b.channel?.id && b.message?.ts && updatedSub) {
        await client.chat.update({
          channel: b.channel.id,
          ts: b.message.ts,
          text: `✅ Kata approved for lorry ${sub.saleDispatch.vehicleNumber || ''}`,
          blocks: kataCardBlocks(updatedSub, sub.saleDispatch, sub.saleDispatch.saleOrder),
        });
      }

      // Notify driver via WhatsApp
      const lorry = sub.saleDispatch.vehicleNumber || 'your lorry';
      const buyer = sub.saleDispatch.saleOrder.buyer.name;
      const shortage = Math.max(0, sub.saleDispatch.weightKg - sub.ocrBuyerKataKg);
      await notifyDriverKataConfirmed(sub.driverPhone, lorry, buyer, shortage).catch((err) => {
        logger.error('[whatsapp] driver confirmation notify failed', err);
      });
    } catch (err: any) {
      logger.error('[slack] approve kata failed', err);
      await respond({
        text: `:x: Delivery error: ${err?.message || 'Could not mark delivered'}`,
        replace_original: false,
      });
    }
  });

  // 2. Edit action: driver-kata:edit
  app.action(`${FLOW}:edit`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    const submissionId = b.actions?.[0]?.value;

    const sub = await prisma.driverKataSubmission.findUnique({
      where: { id: submissionId },
      include: {
        saleDispatch: { include: { saleOrder: { include: { buyer: true } } } },
      },
    });

    if (!sub || sub.status !== 'PENDING') return;

    await client.views.open({
      trigger_id: b.trigger_id,
      view: {
        type: 'modal',
        callback_id: `${FLOW}:edit_submit`,
        private_metadata: JSON.stringify({
          submissionId: sub.id,
          channel: b.channel?.id,
          ts: b.message?.ts,
        }),
        title: { type: 'plain_text', text: 'Edit Buyer Kata Weight', emoji: true },
        submit: { type: 'plain_text', text: 'Confirm & Deliver', emoji: true },
        close: { type: 'plain_text', text: 'Cancel', emoji: true },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Lorry:* ${sub.saleDispatch.vehicleNumber || '-'}\n*Buyer:* ${sub.saleDispatch.saleOrder.buyer.name}\n*Dispatched Weight:* ${fmtInr(sub.saleDispatch.weightKg)} kg`,
            },
          },
          {
            type: 'input',
            block_id: 'weight_block',
            element: {
              type: 'plain_text_input',
              action_id: 'weight_input',
              initial_value: sub.ocrBuyerKataKg ? String(sub.ocrBuyerKataKg) : '',
              placeholder: { type: 'plain_text', text: 'Enter buyer kata in kg (e.g. 24850)' },
            },
            label: { type: 'plain_text', text: 'Buyer Kata Weight (kg)' },
          },
        ],
      },
    });
  });

  // 2b. Edit modal submission
  app.view(`${FLOW}:edit_submit`, async ({ ack, view, body, client }) => {
    const meta = JSON.parse(view.private_metadata || '{}');
    const inputVal = (view.state.values as any)?.weight_block?.weight_input?.value;
    const weightKg = parseInt(inputVal, 10);

    if (isNaN(weightKg) || weightKg <= 0) {
      await ack({
        response_action: 'errors',
        errors: { weight_block: 'Please enter a valid weight in kg.' },
      });
      return;
    }

    const sub = await prisma.driverKataSubmission.findUnique({
      where: { id: meta.submissionId },
      include: {
        saleDispatch: { include: { saleOrder: { include: { buyer: true } } } },
      },
    });

    if (!sub || sub.status !== 'PENDING') {
      await ack();
      return;
    }

    if (weightKg > sub.saleDispatch.weightKg) {
      await ack({
        response_action: 'errors',
        errors: { weight_block: `Weight cannot exceed dispatched weight (${sub.saleDispatch.weightKg} kg).` },
      });
      return;
    }

    await ack();
    const userName = (body.user as any)?.name || (body.user as any)?.username || 'Slack user';

    try {
      await confirmDelivery({
        dispatchId: sub.saleDispatchId,
        buyerKataKg: weightKg,
        deliveredDate: new Date(),
        buyerKataFileUrl: sub.imageUrl,
        submissionId: sub.id,
        confirmedBy: userName,
      });

      const updatedSub = await prisma.driverKataSubmission.findUnique({
        where: { id: sub.id },
      });

      if (meta.channel && meta.ts && updatedSub) {
        await client.chat.update({
          channel: meta.channel,
          ts: meta.ts,
          text: `✅ Kata approved for lorry ${sub.saleDispatch.vehicleNumber || ''}`,
          blocks: kataCardBlocks(updatedSub, sub.saleDispatch, sub.saleDispatch.saleOrder),
        });
      }

      // Notify driver via WhatsApp
      const lorry = sub.saleDispatch.vehicleNumber || 'your lorry';
      const buyer = sub.saleDispatch.saleOrder.buyer.name;
      const shortage = Math.max(0, sub.saleDispatch.weightKg - weightKg);
      await notifyDriverKataConfirmed(sub.driverPhone, lorry, buyer, shortage).catch((err) => {
        logger.error('[whatsapp] driver confirmation notify failed', err);
      });
    } catch (err: any) {
      logger.error('[slack] edit submit error', err);
    }
  });

  // 3. Reject action: driver-kata:reject
  app.action(`${FLOW}:reject`, async ({ ack, body, client }) => {
    await ack();
    const b = body as any;
    const submissionId = b.actions?.[0]?.value;

    const sub = await prisma.driverKataSubmission.findUnique({
      where: { id: submissionId },
      include: { saleDispatch: true },
    });

    if (!sub || sub.status !== 'PENDING') return;

    await client.views.open({
      trigger_id: b.trigger_id,
      view: {
        type: 'modal',
        callback_id: `${FLOW}:reject_submit`,
        private_metadata: JSON.stringify({
          submissionId: sub.id,
          channel: b.channel?.id,
          ts: b.message?.ts,
        }),
        title: { type: 'plain_text', text: 'Reject Kata Slip', emoji: true },
        submit: { type: 'plain_text', text: 'Reject & Notify Driver', emoji: true },
        close: { type: 'plain_text', text: 'Cancel', emoji: true },
        blocks: [
          {
            type: 'input',
            block_id: 'reason_block',
            element: {
              type: 'plain_text_input',
              action_id: 'reason_input',
              placeholder: { type: 'plain_text', text: 'e.g. Blurry photo, wrong weighbridge slip' },
            },
            label: { type: 'plain_text', text: 'Reason for rejection' },
          },
        ],
      },
    });
  });

  // 3b. Reject modal submission
  app.view(`${FLOW}:reject_submit`, async ({ ack, view, body, client }) => {
    await ack();
    const meta = JSON.parse(view.private_metadata || '{}');
    const reason = (view.state.values as any)?.reason_block?.reason_input?.value || 'Slip not clear';
    const userName = (body.user as any)?.name || (body.user as any)?.username || 'Slack user';

    const sub = await prisma.driverKataSubmission.update({
      where: { id: meta.submissionId },
      data: {
        status: 'REJECTED',
        rejectionReason: reason,
        confirmedBy: userName,
        confirmedAt: new Date(),
      },
      include: {
        saleDispatch: { include: { saleOrder: { include: { buyer: true } } } },
      },
    });

    if (meta.channel && meta.ts) {
      await client.chat.update({
        channel: meta.channel,
        ts: meta.ts,
        text: `❌ Kata rejected for lorry ${sub.saleDispatch.vehicleNumber || ''}`,
        blocks: kataCardBlocks(sub, sub.saleDispatch, sub.saleDispatch.saleOrder),
      });
    }

    // Notify driver via WhatsApp
    const lorry = sub.saleDispatch.vehicleNumber || 'your lorry';
    await notifyDriverKataRejected(sub.driverPhone, lorry, reason).catch((err) => {
      logger.error('[whatsapp] driver reject notify failed', err);
    });
  });
}
