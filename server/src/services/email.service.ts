import { Resend } from 'resend';
import { prisma } from '../lib/prisma.js';
import type { EmailDocumentType } from '@prisma/client';

// Initialize Resend if the API key is present
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// The verified sender address. Falls back to Resend's test address (which can
// only deliver to the Resend account owner's own login email) until a real
// domain is verified — set RESEND_FROM_EMAIL once it is.
const DEFAULT_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Acme <onboarding@resend.dev>';

export interface EmailAttachment {
  filename: string;
  content: Buffer;
}

export const emailService = {
  /**
   * Send a basic email, optionally with PDF/file attachments.
   */
  async sendEmail({
    to,
    subject,
    text,
    html,
    attachments,
    from,
  }: {
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
    attachments?: EmailAttachment[];
    from?: string;
  }) {
    if (!resend) {
      console.warn('⚠️ RESEND_API_KEY is not set. Email not sent.');
      console.dir({ to, subject }, { depth: null });
      return null;
    }
    if (!html && !text) throw new Error('sendEmail requires html or text content');

    const data = await resend.emails.send({
      from: from || DEFAULT_FROM_EMAIL,
      to,
      subject,
      attachments,
      ...(html ? { html, text } : { text: text! }),
    });
    if (data.error) throw new Error(data.error.message);
    console.log(`✅ Email sent to ${to}: ${data.data?.id}`);
    return data;
  },

  /**
   * Send a document email (invoice/EWB/credit note/debit note) to a party and
   * record the outcome in EmailLog, regardless of success or failure.
   */
  async sendDocumentEmail(params: {
    party: { id: string; email: string | null; name: string };
    documentType: EmailDocumentType;
    referenceLabel: string;
    saleDispatchId?: string;
    creditNoteId?: string;
    debitNoteId?: string;
    subject: string;
    html: string;
    attachments: EmailAttachment[];
  }): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    const { party, documentType, referenceLabel, saleDispatchId, creditNoteId, debitNoteId, subject, html, attachments } = params;

    if (!party.email) {
      throw new Error(`${party.name} has no email address on file. Add one in Parties first.`);
    }

    let messageId: string | undefined;
    let errorMessage: string | undefined;
    try {
      const result = await this.sendEmail({ to: party.email, subject, html, attachments });
      if (result) {
        messageId = result.data?.id;
      } else {
        // RESEND_API_KEY isn't configured — sendEmail no-op'd, nothing left the
        // building. Record that honestly rather than logging a false SENT.
        errorMessage = 'RESEND_API_KEY is not configured — email was not actually sent (dev/test mode)';
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    await prisma.emailLog.create({
      data: {
        partyId: party.id,
        documentType,
        saleDispatchId,
        creditNoteId,
        debitNoteId,
        referenceLabel,
        recipientEmail: party.email,
        subject,
        resendMessageId: messageId,
        status: errorMessage ? 'FAILED' : 'SENT',
        errorMessage,
      },
    });

    if (errorMessage) return { ok: false, error: errorMessage };
    return { ok: true, messageId };
  },
};
