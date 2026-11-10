import { emailService } from './email.service.js';
import { logger } from '../lib/logger.js';
import { describeUserAgent } from '../lib/userAgent.js';
import { formatIstDateTime } from '../lib/istDate.js';

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
