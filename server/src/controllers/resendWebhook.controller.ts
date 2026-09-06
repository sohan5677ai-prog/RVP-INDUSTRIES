import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import type { EmailStatus } from '@prisma/client';

interface ResendWebhookPayload {
  type: string;
  created_at: string;
  data: {
    email_id?: string;
    from?: string;
    to?: string[];
    subject?: string;
    bounce_message?: string;
    [key: string]: unknown;
  };
}

/**
 * Validates Svix signature sent by Resend if RESEND_WEBHOOK_SECRET is set.
 */
function verifyResendSignature(
  rawBody: Buffer | string | undefined,
  headers: Record<string, string | string[] | undefined>,
  secret: string
): boolean {
  try {
    const svixId = headers['svix-id'];
    const svixTimestamp = headers['svix-timestamp'];
    const svixSignature = headers['svix-signature'];

    if (
      !svixId ||
      !svixTimestamp ||
      !svixSignature ||
      typeof svixId !== 'string' ||
      typeof svixTimestamp !== 'string' ||
      typeof svixSignature !== 'string'
    ) {
      return false;
    }

    // Guard against timestamp older than 5 minutes
    const now = Math.floor(Date.now() / 1000);
    const ts = parseInt(svixTimestamp, 10);
    if (isNaN(ts) || Math.abs(now - ts) > 300) {
      return false;
    }

    const key = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret, 'utf-8');
    const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf-8') : typeof rawBody === 'string' ? rawBody : '';
    const signedContent = `${svixId}.${svixTimestamp}.${bodyStr}`;

    const computed = crypto.createHmac('sha256', key).update(signedContent).digest('base64');
    const expectedSig = `v1,${computed}`;

    const signatures = svixSignature.split(' ');
    return signatures.some((sig) => {
      try {
        return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
      } catch {
        return false;
      }
    });
  } catch (err) {
    logger.error('Resend webhook signature verification failed with error', err);
    return false;
  }
}

/**
 * Handles incoming webhooks from Resend (email.sent, email.delivered, email.opened, etc.)
 */
export async function handleResendWebhook(req: Request, res: Response) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;

  if (secret) {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    const isValid = verifyResendSignature(rawBody, req.headers, secret);
    if (!isValid) {
      logger.warn('Unauthorized Resend webhook attempt: signature mismatch');
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
  }

  const payload = req.body as ResendWebhookPayload;
  if (!payload || !payload.type || !payload.data?.email_id) {
    return res.status(200).json({ received: true, ignored: 'Missing type or email_id' });
  }

  const emailId = payload.data.email_id;
  const eventType = payload.type;
  const eventTime = payload.created_at ? new Date(payload.created_at) : new Date();

  // Find the EmailLog entry
  const log = await prisma.emailLog.findFirst({
    where: { resendMessageId: emailId },
  });

  if (!log) {
    logger.info(`Resend webhook received for untracked email_id: ${emailId} (${eventType})`);
    return res.status(200).json({ received: true, matched: false });
  }

  let statusToUpdate: EmailStatus | undefined;
  const dataToUpdate: Record<string, unknown> = {};

  switch (eventType) {
    case 'email.delivered':
      statusToUpdate = 'DELIVERED';
      dataToUpdate.deliveredAt = eventTime;
      break;
    case 'email.opened':
      statusToUpdate = 'OPENED';
      dataToUpdate.openedAt = eventTime;
      break;
    case 'email.clicked':
      statusToUpdate = 'CLICKED';
      dataToUpdate.clickedAt = eventTime;
      break;
    case 'email.bounced':
      statusToUpdate = 'BOUNCED';
      dataToUpdate.bouncedAt = eventTime;
      if (payload.data.bounce_message) {
        dataToUpdate.errorMessage = String(payload.data.bounce_message);
      }
      break;
    case 'email.complained':
      statusToUpdate = 'COMPLAINED';
      break;
    case 'email.sent':
      if (log.status === 'FAILED') {
        statusToUpdate = 'SENT';
      }
      break;
  }

  // If the log is already at a higher progression (e.g. already OPENED),
  // do not downgrade it back to DELIVERED.
  const rank: Record<EmailStatus, number> = {
    FAILED: 0,
    BOUNCED: 0,
    COMPLAINED: 0,
    SENT: 1,
    DELIVERED: 2,
    OPENED: 3,
    CLICKED: 4,
  };

  if (statusToUpdate) {
    if (rank[statusToUpdate] >= rank[log.status] || statusToUpdate === 'BOUNCED' || statusToUpdate === 'COMPLAINED') {
      dataToUpdate.status = statusToUpdate;
    }
  }

  if (Object.keys(dataToUpdate).length > 0) {
    await prisma.emailLog.update({
      where: { id: log.id },
      data: dataToUpdate,
    });
    logger.info(`Updated EmailLog ${log.id} (${log.referenceLabel}) from Resend webhook: ${eventType}`);
  }

  return res.status(200).json({ received: true, updated: true, eventType });
}
