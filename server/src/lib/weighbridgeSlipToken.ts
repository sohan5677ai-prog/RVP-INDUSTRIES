import { createHmac } from 'node:crypto';

/**
 * The HMAC that authorises the public Kata-slip links
 * (`/weighbridge/tickets/:id/slip.jpg` and `.../slip.pdf`), which WhatsApp's
 * media fetcher pulls server-to-server with no credentials.
 *
 * It lives here, in one function, because it used to live in two: the sender
 * in whatsapp.service.ts signed over `paidAt ?? secondWeighedAt ?? createdAt`
 * while the endpoint verified `paidAt ?? createdAt`. For any ticket whose cash
 * had not been marked paid yet - i.e. the ordinary outside-party ticket - the
 * two disagreed, the media URL came back 403, and the internal Kata alert went
 * out without its slip (or not at all). Tickets that are auto-exempt (KNM
 * vehicles, storage transfers) get `paidAt` stamped at completion, so those
 * agreed by accident and kept working. That is the whole of "sometimes".
 *
 * The time component is `paidAt` when the ticket has been paid, `createdAt`
 * otherwise - never `secondWeighedAt`, which is written after the row is
 * created and so is not what a later verification can reconstruct. Note the
 * link does therefore change once a pending ticket is paid; a link minted
 * before payment stops working after it, which is acceptable because WhatsApp
 * has already fetched and cached the image by then.
 */
export function weighbridgeSlipToken(
  id: string,
  paidAt: Date | string | null | undefined,
  createdAt: Date | string | null | undefined,
): string | null {
  const stamp = paidAt ?? createdAt;
  if (!stamp) return null;
  const time = stamp instanceof Date ? stamp.getTime() : new Date(stamp).getTime();
  if (!Number.isFinite(time)) return null;
  const secret = process.env.JWT_SECRET || 'rvp-default-kata-secret-key-2026';
  return createHmac('sha256', secret).update(`weighbridge-slip:${id}:${time}`).digest('hex');
}
