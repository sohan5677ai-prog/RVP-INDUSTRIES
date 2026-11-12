import { emailService } from './email.service.js';
import { logger } from '../lib/logger.js';
import { describeUserAgent } from '../lib/userAgent.js';
import { formatIstDateTime } from '../lib/istDate.js';
import { prisma } from '../lib/prisma.js';
import { maskAccount } from '../lib/masterFields.js';

/**
 * Security emails: password reset links and new-device sign-in alerts
 * (plan items 1.6 and 1.8).
 *
 * Every send here is best-effort and never throws. A reset link that fails to
 * send must not turn into a 500 that tells the caller whether the address
 * exists, and an alert that fails must not fail the login it is reporting on.
 */

function appBaseUrl(): string {
  return (process.env.APP_BASE_URL || 'https://www.rvpindustries.co.in').replace(/\/+$/, '');
}

/** Plain-text only: a security email should look like what it is. */
export async function sendPasswordResetEmail(params: {
  to: string;
  name: string;
  token: string;
  expiresAt: Date;
  requestIp?: string | null;
}): Promise<void> {
  // The token is in a path-style query on the reset page. It is single-use and
  // expires in 15 minutes, which is what makes putting it in a URL acceptable.
  const link = `${appBaseUrl()}/reset-password?token=${encodeURIComponent(params.token)}`;
  try {
    await emailService.sendEmail({
      to: params.to,
      subject: 'Reset your RVP ERP password',
      text: [
        `Hello ${params.name},`,
        '',
        'Someone asked to reset the password for your RVP Industries ERP account.',
        'Open the link below to choose a new one. It can be used once, and it',
        `expires at ${formatIstDateTime(params.expiresAt)} IST.`,
        '',
        link,
        '',
        params.requestIp ? `Requested from IP address ${params.requestIp}.` : '',
        '',
        'If this was not you, you can ignore this email - your current password',
        'still works and nothing has changed. If you get these repeatedly, tell',
        'whoever administers the ERP.',
      ]
        .filter((l) => l !== undefined)
        .join('\n'),
    });
  } catch (err) {
    logger.error('failed to send password reset email', err);
  }
}

/**
 * Alert on a sensitive master change (plan item 3.2).
 *
 * Goes to two different audiences for two different reasons, and the split is
 * the point:
 *
 * - **Internally**, to the security alert recipients, so somebody who can act
 *   finds out. Deliberately not companyBccEmail, which already receives a copy
 *   of every invoice - an alert in that stream is an alert nobody reads.
 * - **To the vendor**, at the address **currently on file**, never the
 *   proposed one. If the change being made is an email change, writing to the
 *   new address tells the attacker and leaves the vendor none the wiser.
 *
 * Account numbers are masked. An email warning that an account number changed
 * should not be the thing that carries the new account number to an inbox.
 */
export async function sendMasterChangeAlert(params: {
  stage: 'requested' | 'approved';
  entity: string;
  entityName: string;
  entityId: string;
  changes: { field: string; label: string; oldValue: string | null; newValue: string | null }[];
  actorName: string;
  approverName?: string | null;
  vendorEmail?: string | null;
}): Promise<void> {
  const internal = await securityAlertRecipients();
  const masked = (field: string, value: string | null) =>
    /account|ifsc/i.test(field) ? maskAccount(value) : (value ?? '(empty)');

  const lines = params.changes.map(
    (c) => `  ${c.label}: ${masked(c.field, c.oldValue)}  ->  ${masked(c.field, c.newValue)}`
  );

  const what = params.stage === 'requested' ? 'requested' : 'approved and applied';
  const subject =
    params.stage === 'requested'
      ? `Approval needed: ${params.entityName} details changed`
      : `Applied: ${params.entityName} details changed`;

  if (internal.length > 0) {
    try {
      await emailService.sendEmail({
        to: internal,
        subject,
        text: [
          `A change to ${params.entityName} was ${what}.`,
          '',
          ...lines,
          '',
          `Requested by: ${params.actorName}`,
          params.approverName ? `Approved by:  ${params.approverName}` : '',
          `When:         ${formatIstDateTime(new Date())} IST`,
          '',
          params.stage === 'requested'
            ? 'It has NOT taken effect. The existing details stay in use until someone other than the requester approves it, in Settings.'
            : 'This is now in effect.',
          '',
          'If this was not expected, treat it as urgent: a changed bank account is how',
          'a payment gets diverted.',
        ]
          .filter(Boolean)
          .join('\n'),
      });
    } catch (err) {
      logger.error('failed to send internal master-change alert', err);
    }
  } else {
    logger.warn(
      'master change alert not sent: no securityAlertEmails configured in the company profile'
    );
  }

  // The vendor only needs to know about their own banking and contact details,
  // and only once it is real.
  const vendorRelevant = params.changes.some((c) =>
    /bank|ifsc|account|email/i.test(c.field)
  );
  if (params.stage === 'approved' && params.vendorEmail && vendorRelevant) {
    try {
      await emailService.sendEmail({
        to: params.vendorEmail,
        subject: 'Your details with RVP Industries were changed',
        text: [
          'The details we hold for you have been changed:',
          '',
          ...lines,
          '',
          `When: ${formatIstDateTime(new Date())} IST`,
          '',
          'If you asked for this, nothing needs doing.',
          '',
          'If you did NOT ask for this, contact us immediately on the number you',
          'normally use - not one from this email - and do not expect payment to',
          'the new account until we have spoken.',
        ].join('\n'),
      });
    } catch (err) {
      logger.error('failed to send vendor master-change alert', err);
    }
  }
}

/** Addresses configured to receive security alerts, as a list. */
async function securityAlertRecipients(): Promise<string[]> {
  try {
    const profile = await prisma.companyProfile.findFirst({
      select: { securityAlertEmails: true },
    });
    return (profile?.securityAlertEmails ?? '')
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.includes('@'));
  } catch (err) {
    logger.error('could not read security alert recipients', err);
    return [];
  }
}

export async function sendNewDeviceAlert(params: {
  to: string;
  name: string;
  username: string;
  ip?: string | null;
  userAgent?: string | null;
  at: Date;
}): Promise<void> {
  try {
    await emailService.sendEmail({
      to: params.to,
      subject: 'New sign-in to your RVP ERP account',
      text: [
        `Hello ${params.name},`,
        '',
        `Your account (${params.username}) was signed in to from a device it has`,
        'not been used on before.',
        '',
        `When:    ${formatIstDateTime(params.at)} IST`,
        `Device:  ${describeUserAgent(params.userAgent ?? null)}`,
        `IP:      ${params.ip ?? 'unknown'}`,
        '',
        'If that was you, nothing needs doing.',
        '',
        'If it was not, change your password straight away - that signs out every',
        'other device at once - and tell whoever administers the ERP.',
      ].join('\n'),
    });
  } catch (err) {
    logger.error('failed to send new-device alert', err);
  }
}
