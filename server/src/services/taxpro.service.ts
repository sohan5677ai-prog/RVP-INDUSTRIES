import { createHash } from 'node:crypto';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getCompanyProfileRow } from '../controllers/settings.controller.js';
import { istParts } from '../lib/istDate.js';
import { resolveProductHsn } from '../lib/calc.js';
import { resolveOrderEffectiveDetails } from '../lib/orderAddress.js';

interface TaxproConfig {
  taxproGspId?: string | null;      // ASP id (aspid)           e.g. 1806883726
  taxproGspSecret?: string | null;  // ASP password             e.g. Rvpapi@2026
  taxproGstUser?: string | null;    // NIC e-invoice API user   -> User_Name
  taxproGstPass?: string | null;    // NIC e-invoice password   -> eInvPwd
  taxproSandbox: boolean;
  gstin?: string | null;
}

/**
 * TaxPro GSP e-invoice client, using the *decrypted* ("/dec/") URL-based API.
 * This is a pass-through to the NIC IRP: plain JSON in/out, no AES/RSA, and the
 * GSP ClientId is injected server-side by TaxPro based on `aspid`.
 *
 * Verified working contract (2026-07-10, sandbox):
 *   Auth (GET) : {base}/eivital/dec/v1.04/auth
 *   Invoice    : {base}/eicore/dec/v1.03/Invoice?QrCodeSize=250   (HTTPS required)
 *   Headers    : aspid, password (=ASP pwd), Gstin, User_Name, eInvPwd, AuthToken
 */
export class TaxproService {
  // Production is HTTPS with DNS round-robin backups; sandbox is a single host.
  // NOTE: the /eicore Invoice endpoint REQUIRES HTTPS (HTTP returns a bogus 405),
  // so we always use https, including sandbox.
  private static readonly PRODUCTION_BASE_URLS = [
    'https://einvapi.charteredinfo.com',
    'https://einvapimum1.charteredinfo.com',
  ];
  private static readonly SANDBOX_BASE_URLS = ['https://gstsandbox.charteredinfo.com'];

  private static baseUrls(isSandbox: boolean): string[] {
    return isSandbox ? this.SANDBOX_BASE_URLS : this.PRODUCTION_BASE_URLS;
  }

  // Per-attempt network timeout and how many times to retry a transient
  // transport failure (DNS/TLS/connection blip) against the SAME base URL.
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  private static readonly TRANSPORT_RETRIES = 2;

  /**
   * Unwraps Node's opaque `fetch failed` TypeError to the real reason carried in
   * `err.cause` (e.g. ENOTFOUND, ECONNREFUSED, ETIMEDOUT, cert errors).
   */
  private static describeError(err: any): string {
    const cause = err?.cause;
    if (cause) {
      const parts = [cause.code, cause.message].filter(Boolean).join(' ');
      if (parts) return `${err.message} (${parts})`;
    }
    return err?.message || String(err);
  }

  private static baseHeaders(config: TaxproConfig, gstin: string, extra: Record<string, string> = {}) {
    return {
      'Content-Type': 'application/json',
      aspid: config.taxproGspId || '',
      password: config.taxproGspSecret || '',
      Gstin: gstin,
      user_name: config.taxproGstUser || '',
      ...extra,
    } as Record<string, string>;
  }

  private static ewbQueryString(config: TaxproConfig, gstin: string, action: string, extra: Record<string, string> = {}) {
    const params = new URLSearchParams({
      action,
      aspid: config.taxproGspId || '',
      password: config.taxproGspSecret || '',
      gstin: gstin || config.gstin || '',
      username: config.taxproGstUser || '',
      ...extra,
    });
    return params.toString();
  }

  private static credsMissing(config: TaxproConfig): boolean {
    return !config.taxproGspId || !config.taxproGspSecret || !config.taxproGstUser || !config.taxproGstPass;
  }

  /** NIC sometimes returns Data as a JSON string, sometimes as an object. */
  private static parseData(data: any): any {
    if (data == null) return null;
    if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return data; }
    }
    return data;
  }

  /**
   * NIC/TaxPro returns date strings in Indian Standard Time (IST) without explicit
   * timezone offsets (e.g. "2026-08-01 09:59:00" or "01/08/2026 09:59:00 AM").
   * Running `new Date(str)` on a UTC server parses un-offsetted strings as UTC,
   * causing a +5:30 double-shift when rendered in India (e.g. 9:59 AM -> 3:29 PM).
   * This helper explicitly parses un-offsetted strings as IST (+05:30).
   */
  public static parseNicDate(raw: string | Date | null | undefined): Date {
    if (!raw) return new Date();
    if (raw instanceof Date) return raw;
    let str = String(raw).trim();
    if (!str) return new Date();

    if (/[Z+-]\d{2}:?\d{2}$/i.test(str)) {
      const parsed = new Date(str);
      return isNaN(parsed.getTime()) ? new Date(raw) : parsed;
    }

    if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(str)) {
      str = str.replace(' ', 'T');
    }

    if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) {
      const [d, m, yWithTime] = str.split('/');
      const y = yWithTime.slice(0, 4);
      const rest = yWithTime.slice(4).trim();
      str = `${y}-${m}-${d}${rest ? 'T' + rest : ''}`;
    }

    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str) && !/[Z+-]/.test(str.slice(10))) {
      str += '+05:30';
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      str += 'T00:00:00+05:30';
    }

    const d = new Date(str);
    return isNaN(d.getTime()) ? new Date(raw) : d;
  }

  /**
   * Low-level request with base-URL failover. Returns the parsed JSON body.
   * Throws Error with `.isBusinessError=true` for NIC/GSP validation failures
   * (which must not be retried against other base URLs).
   */
  private static async request(
    isSandbox: boolean,
    path: string,
    init: RequestInit,
  ): Promise<any> {
    let lastError: any = null;

    for (const base of this.baseUrls(isSandbox)) {
      // Retry transient transport failures against the same host before moving
      // on - important for sandbox, which has only a single base URL.
      for (let attempt = 0; attempt <= this.TRANSPORT_RETRIES; attempt++) {
        try {
          const res = await fetch(`${base}${path}`, {
            ...init,
            signal: AbortSignal.timeout(this.REQUEST_TIMEOUT_MS),
          });
          const json = (await res.json().catch(() => ({}))) as any;

          // Transport / infra failure -> try next base URL.
          if (res.status >= 500) throw new Error(`Server returned ${res.status}`);

          // GSP gateway error shape: { status_cd:'0', error:{ error_cd, message } }
          if (json?.error?.message) {
            let msg = `${json.error.error_cd || ''} ${json.error.message}`.trim();
            const rawMsg = String(json.error.message);
            const isUpstreamError =
              /upstream|server error|gateway|timeout|nic404|nic500|nic502|nic503|nic504/i.test(rawMsg) ||
              /upstream|server error|gateway|timeout|nic404|nic500|nic502|nic503|nic504/i.test(String(json.error.error_cd || ''));

            if (String(json.error.error_cd) === '1017' || msg.includes('1017')) {
              msg = `1017: Incorrect user id/User does not exists. Please verify: 1) Is your NIC E-Invoice API User created under GSP "TaxPro / Chartered Information Systems" on the NIC E-Invoice Portal? 2) Is "Sandbox Mode" correctly toggled in Settings?`;
            }
            const err: any = new Error(msg);
            if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
              err.isBusinessError = true;
            } else if (!isUpstreamError) {
              err.isBusinessError = true;
            }
            throw err;
          }

          // NIC business error shape: { Status:'0', ErrorDetails:[{ErrorCode,ErrorMessage}] }
          const status = String(json?.Status ?? json?.status ?? '');
          if (status === '0' && Array.isArray(json?.ErrorDetails) && json.ErrorDetails.length) {
            let msg = json.ErrorDetails
              .map((e: any) => `${e.ErrorCode}: ${e.ErrorMessage}`)
              .join('; ');
            const isTransientNicError = json.ErrorDetails.some(
              (e: any) =>
                ['5001', '5002', '5003', '5004', '5005'].includes(String(e.ErrorCode)) ||
                /upstream|server error|system error|maintenance/i.test(e.ErrorMessage || '')
            );
            // NIC 5001 "Application Error ... contact the help desk" is a generic,
            // usually-transient server-side fault (not a payload problem). Make the
            // message actionable rather than surfacing NIC's cryptic text verbatim.
            if (json.ErrorDetails.some((e: any) => String(e.ErrorCode) === '5001')) {
              msg = `NIC returned a temporary system error (5001). This is usually transient - please wait a moment and try again. [${msg}]`;
            }
            if (json.ErrorDetails.some((e: any) => String(e.ErrorCode) === '1017')) {
              msg = `1017: Incorrect user id/User does not exists. Please verify: 1) Is your NIC E-Invoice API User created under GSP "TaxPro / Chartered Information Systems" on the NIC E-Invoice Portal? 2) Is "Sandbox Mode" correctly toggled in Settings? [${msg}]`;
            }
            const err: any = new Error(msg);
            err.isBusinessError = !isTransientNicError;
            err.errorDetails = json.ErrorDetails;
            throw err;
          }

          if (!res.ok) {
            const err: any = new Error(`HTTP Error ${res.status}`);
            if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
              err.isBusinessError = true;
            }
            throw err;
          }

          return json;
        } catch (err: any) {
          if (err.isBusinessError) throw err; // never retry validation failures
          lastError = err;
          const retriesLeft = this.TRANSPORT_RETRIES - attempt;
          const detail = this.describeError(err);
          if (retriesLeft > 0) {
            console.warn(`TaxPro request failed for ${base}${path}: ${detail}. Retrying (${retriesLeft} left)...`);
          } else {
            console.warn(`TaxPro request failed for ${base}${path}: ${detail}. Trying next endpoint...`);
          }
        }
      }
    }
    throw new Error(`All TaxPro endpoints failed. Last error: ${this.describeError(lastError)}`);
  }

  /**
   * Cached AuthTokens, keyed by the identity the token was minted for. NIC issues
   * one token per (GSTIN, API user) and it is valid ~6h, so re-authenticating on
   * every operation doubled our call count against the GSP for no benefit - the
   * TaxPro log showed an AUTH row next to every INVOICE row, retries included.
   */
  private static readonly authCache = new Map<string, { token: string; expiresAt: number }>();

  /** Re-auth this long before the token actually lapses, to cover clock skew. */
  private static readonly AUTH_EXPIRY_MARGIN_MS = 5 * 60_000;
  /** Used when NIC omits (or garbles) TokenExpiry. Deliberately under the ~6h life. */
  private static readonly AUTH_FALLBACK_TTL_MS = 5 * 60 * 60_000;

  /**
   * The key fingerprints the credentials themselves, not just the GSTIN/user, so
   * that editing any of them in Settings misses the cache instead of reusing a
   * token minted under the old ones. (Hashed rather than stored raw - this map
   * should never hold a password in plain text.)
   */
  private static authCacheKey(config: TaxproConfig, gstin: string): string {
    const secretFingerprint = createHash('sha256')
      .update([config.taxproGspId, config.taxproGspSecret, config.taxproGstPass].join(' '))
      .digest('hex')
      .slice(0, 16);
    return [
      config.taxproSandbox ? 'sbx' : 'prod',
      gstin,
      config.taxproGstUser || '',
      secretFingerprint,
    ].join('|');
  }

  /**
   * GET AuthToken (decrypted variant uses GET). Valid ~6h; ClientId is injected
   * by TaxPro. Cached per identity until shortly before it expires; pass
   * `forceRefresh` to discard the cached one (see `withAuth`).
   */
  private static async getAuthToken(
    config: TaxproConfig,
    gstin: string,
    forceRefresh = false,
  ): Promise<string> {
    const key = this.authCacheKey(config, gstin);
    const cached = this.authCache.get(key);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.token;

    const json = await this.request(config.taxproSandbox, '/eivital/dec/v1.04/auth', {
      method: 'GET',
      headers: {
        aspid: config.taxproGspId || '',
        password: config.taxproGspSecret || '',
        Gstin: gstin,
        user_name: config.taxproGstUser || '',
        eInvPwd: config.taxproGstPass || '',
      },
    });
    const token = json?.Data?.AuthToken || json?.AuthToken;
    if (!token) throw new Error('TaxPro auth succeeded but returned no AuthToken');

    // TokenExpiry comes back as an un-offsetted IST timestamp, same as every other
    // NIC date - parseNicDate pins it to +05:30 so a UTC server doesn't read it as
    // 5.5h in the past and re-auth on every single call.
    const rawExpiry = json?.Data?.TokenExpiry || json?.TokenExpiry;
    const parsed = rawExpiry ? this.parseNicDate(rawExpiry).getTime() : NaN;
    const expiresAt = Number.isFinite(parsed) && parsed > Date.now()
      ? parsed - this.AUTH_EXPIRY_MARGIN_MS
      : Date.now() + this.AUTH_FALLBACK_TTL_MS;
    this.authCache.set(key, { token, expiresAt });

    return token;
  }

  /** Drops the cached token for an identity, forcing the next call to re-auth. */
  private static clearAuthToken(config: TaxproConfig, gstin: string) {
    this.authCache.delete(this.authCacheKey(config, gstin));
  }

  /**
   * NIC rejects a lapsed//revoked AuthToken with 1005 (and TaxPro's gateway can
   * answer 401 with its own wording). Both mean "get a new token", never "the
   * payload is wrong" - so they must not surface to the user as a failure.
   */
  private static isAuthTokenError(err: any): boolean {
    const codes = Array.isArray(err?.errorDetails)
      ? err.errorDetails.map((e: any) => String(e.ErrorCode))
      : [];
    if (codes.includes('1005')) return true;
    const msg = String(err?.message || '');
    return /\b1005\b/.test(msg) || (/token/i.test(msg) && /invalid|expire/i.test(msg));
  }

  /**
   * Runs an authenticated call with the cached token, and transparently retries
   * once with a fresh one if the token turns out to be stale. Without this, a
   * cached token would be strictly riskier than the old auth-every-time code.
   */
  private static async withAuth<T>(
    config: TaxproConfig,
    gstin: string,
    fn: (token: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await fn(await this.getAuthToken(config, gstin));
    } catch (err: any) {
      if (!this.isAuthTokenError(err)) throw err;
      this.clearAuthToken(config, gstin);
      logger.warn('TaxPro AuthToken rejected - re-authenticating and retrying once');
      return fn(await this.getAuthToken(config, gstin, true));
    }
  }

  /**
   * Format Date -> DD/MM/YYYY (IST) as required by NIC.
   *
   * Formatted in IST explicitly, not process-local time: Render runs the API in
   * UTC, so `getDate()` printed a midnight-IST invoice date as the previous
   * day. `parseNicDate` already pins the inbound side to +05:30; this is the
   * matching outbound half.
   */
  private static formatNICDate(date: Date): string {
    const p = istParts(date);
    return `${p.day}/${p.month}/${p.year}`;
  }

  /**
   * Format Date -> "DD/MM/YYYY hh:mm:ss AM/PM" (IST) for the printewb payload.
   *
   * The TaxPro print service renders back exactly what we POST, so a
   * process-local time here put the "official" e-way bill copy 5:30 behind
   * reality - an EWB generated 12:37 IST printed as 07:07 AM.
   */
  private static formatNICDateTime(date: Date): string {
    const p = istParts(date);
    return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second} ${p.ampm}`;
  }

  /**
   * The seller's DISPATCH-FROM block, as configured in Settings → Invoice Setup.
   *
   * NIC/EWB keeps the dispatch point separate from the registered address, and
   * `Loc`/`fromPlace` is the *town* the goods leave from (Punganur) - not the
   * state, which is already carried by the state code. Each field falls back to
   * the registered company address so an unconfigured profile still works.
   */
  private static dispatchFromDetails(company: Record<string, any>) {
    return {
      addr1: (company.dispatchFromAddress1 || company.address || '').trim(),
      addr2: (company.dispatchFromAddress2 || '').trim(),
      place: (company.dispatchFromPlace || company.stateName || '').trim(),
      pincode: Number(company.dispatchFromPincode || company.pincode) || 0,
    };
  }

  /**
   * NIC rejects an HSN shorter than 6 digits (e-invoice error 2311) once the
   * filer's AATO crosses 5 Cr. Catch it here so the ERP explains what to fix
   * instead of surfacing a raw GSP error code, and never pad the code with
   * zeroes - a made-up sub-heading would just fail the HSN master lookup.
   */
  private static requireHsn(hsn: string | null | undefined, product: string) {
    const code = (hsn || '').replace(/\s/g, '');
    if (code.length < 6) {
      throw new Error(
        `HSN for ${product} is "${code || 'not set'}" - the government requires at least 6 digits. ` +
        `Open Settings > HSN / SAC and set the full code (e.g. 120799 for pappu), then try again.`,
      );
    }
    return code;
  }

  /**
   * Sanitises and splits a street address so it adheres strictly to NIC schema:
   * Addr1: 1 to 100 characters
   * Addr2: optional, 0 to 100 characters
   */
  private static formatNICAddress(raw: string | null | undefined, fallback: string = 'Premises'): { addr1: string; addr2?: string } {
    const cleaned = (raw || '').trim().replace(/\s+/g, ' ');
    if (!cleaned) return { addr1: fallback.slice(0, 100) };
    if (cleaned.length <= 100) return { addr1: cleaned };

    let splitIdx = 100;
    const lastBreak = cleaned.slice(0, 100).search(/[, -][^, -]*$/);
    if (lastBreak > 30) {
      splitIdx = lastBreak + 1;
    }
    const addr1 = cleaned.slice(0, splitIdx).trim() || cleaned.slice(0, 100);
    const addr2 = cleaned.slice(splitIdx).trim().slice(0, 100);
    return {
      addr1: addr1.slice(0, 100),
      ...(addr2 ? { addr2: addr2.slice(0, 100) } : {}),
    };
  }

  private static formatNICPlace(raw: string | null | undefined, fallback: string = 'Town'): string {
    const cleaned = (raw || '').trim().replace(/\s+/g, ' ');
    return (cleaned || fallback).slice(0, 50);
  }

  /** The buyer's SHIP-TO block. Same rule: `Loc` is the town, not the state. */
  private static shipToDetails(buyer: Record<string, any>) {
    return {
      place: (buyer.city || buyer.state || '').trim(),
      pincode: Number(buyer.pincode) || 0,
    };
  }

  /**
   * Formats a dispatch into the NIC E-Invoice JSON payload (schema v1.1).
   */
  public static async prepareEInvoicePayload(dispatchId: string) {
    const dispatch = await prisma.saleDispatch.findUnique({
      where: { id: dispatchId },
      include: {
        saleOrder: {
          include: {
            buyer: {
              include: { addresses: true },
            },
          },
        },
      },
    });

    if (!dispatch) throw new Error('Dispatch not found');
    const order = dispatch.saleOrder;
    const buyer = order.buyer;
    const company = await getCompanyProfileRow();
    const addressDetails = await resolveOrderEffectiveDetails(order);

    const taxInfo = await prisma.productTaxInfo.findUnique({ where: { product: order.product } });
    const description = taxInfo?.description || `${order.product} Sale`;
    // A GST-exempt order files under the alternate no-GST HSN (e.g. husk),
    // falling back to the taxable code if no exempt-specific one is configured.
    // Krishi Nutrition Company Pvt Ltd always uses constant HSN 11063010.
    const rawHsn = resolveProductHsn(buyer, taxInfo, order.gstExempt);
    const hsn = this.requireHsn(rawHsn, order.product);

    if (!company.gstin) throw new Error('Company GSTIN is not set in Settings');
    const effectiveBuyerGstin = (addressDetails.effectiveGstin || order.buyerGstin || buyer.gstin || '').trim();
    if (!effectiveBuyerGstin) throw new Error('Buyer GSTIN is not set in Buyer profile or Sale Order');

    const dispatchFrom = this.dispatchFromDetails(company as any);
    const shipTo = this.shipToDetails(buyer as any);

    const sellerAddr = this.formatNICAddress(dispatchFrom.addr1, 'Factory premises');
    const buyerAddr = this.formatNICAddress(addressDetails.effectiveAddress || order.buyerAddress || buyer.address, 'Buyer address');
    const sellerLoc = this.formatNICPlace(dispatchFrom.place, 'Punganur');
    const buyerLoc = this.formatNICPlace(addressDetails.effectiveCity || order.buyerCity || shipTo.place, 'Town');

    const weight = dispatch.weightKg;
    const rate = Number(order.ratePerKg);
    const baseAmount = Math.round(weight * rate * 100) / 100;

    const sellerStateCode = company.gstin.slice(0, 2);
    const buyerStateCode = effectiveBuyerGstin.slice(0, 2);
    const isSameState = sellerStateCode === buyerStateCode;

    // GST rate is configured per commodity in Settings (ProductTaxInfo.gstRate),
    // defaulting to 5%. NIC recomputes the tax as (AssVal * GstRt) and rejects any
    // mismatch (error 2235), so we compute the tax from the assessable value at
    // that rate here - this is the source of truth and stays correct even when a
    // legacy dispatch row stored gstAmount as 0.
    // A GST-exempt order is billed WITHOUT tax - force 0% so NIC generates the IRN
    // GST-free (and it matches the invoice/EWB PDFs, which also honor gstExempt).
    const gstRate = order.gstExempt ? 0 : (taxInfo?.gstRate != null ? Number(taxInfo.gstRate) : 5);
    const gstAmount = Math.round(baseAmount * gstRate) / 100; // = AssVal * GstRt%
    const totalAmount = Math.round((baseAmount + gstAmount) * 100) / 100;

    const cgstAmt = isSameState ? Math.round((gstAmount / 2) * 100) / 100 : 0;
    const sgstAmt = isSameState ? Math.round((gstAmount / 2) * 100) / 100 : 0;
    const igstAmt = isSameState ? 0 : gstAmount;

    return {
      Version: '1.1',
      TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
      DocDtls: {
        Typ: 'INV',
        No: dispatch.invoiceNumber || `DISP-${dispatch.id.slice(-6)}`,
        Dt: this.formatNICDate(dispatch.invoiceDate || new Date()),
      },
      SellerDtls: {
        Gstin: company.gstin,
        LglNm: company.name.slice(0, 100),
        Addr1: sellerAddr.addr1,
        ...(sellerAddr.addr2 || dispatchFrom.addr2 ? { Addr2: (sellerAddr.addr2 || dispatchFrom.addr2).slice(0, 100) } : {}),
        Loc: sellerLoc,
        Pin: dispatchFrom.pincode,
        Stcd: sellerStateCode,
      },
      BuyerDtls: {
        Gstin: effectiveBuyerGstin,
        LglNm: buyer.name.slice(0, 100),
        Pos: buyerStateCode,
        Addr1: buyerAddr.addr1,
        ...(buyerAddr.addr2 ? { Addr2: buyerAddr.addr2 } : {}),
        Loc: buyerLoc,
        Pin: Number(addressDetails.effectivePincode || order.buyerPincode || buyer.pincode) || shipTo.pincode,
        Stcd: buyerStateCode,
      },
      ItemList: [
        {
          SlNo: '1',
          PrdDesc: description,
          IsServc: 'N',
          HsnCd: hsn,
          Qty: weight,
          Unit: 'KGS',
          UnitPrice: rate,
          TotAmt: baseAmount,
          Discount: 0,
          AssAmt: baseAmount,
          GstRt: gstRate,
          CgstAmt: cgstAmt,
          SgstAmt: sgstAmt,
          IgstAmt: igstAmt,
          TotItemVal: totalAmount,
        },
      ],
      ValDtls: {
        AssVal: baseAmount,
        CgstVal: cgstAmt,
        SgstVal: sgstAmt,
        IgstVal: igstAmt,
        TotInvVal: totalAmount,
      },
    };
  }

  /**
   * Authenticates and generates an E-Invoice (IRN) via TaxPro GSP.
   * If credentials are missing, returns a simulated response so the ERP flow
   * still works in a dev/unconfigured environment.
   */
  public static async generateIRN(dispatchId: string) {
    const company = await getCompanyProfileRow();
    const isMock = this.credsMissing(company);

    const payload = await this.prepareEInvoicePayload(dispatchId);

    if (isMock) {
      const irn = Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      const ackNo = String(100000000000 + Math.floor(Math.random() * 900000000000));
      const qrData = `IRN:${irn}|GSTIN:${payload.SellerDtls.Gstin}|InvNo:${payload.DocDtls.No}|Amt:${payload.ValDtls.TotInvVal}|Date:${payload.DocDtls.Dt}`;
      return {
        success: true,
        irn,
        ackNo,
        ackDate: new Date(),
        signedQr: qrData,
        message: 'Simulated IRN generated (TaxPro credentials not configured)',
      };
    }

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) =>
        this.request(company.taxproSandbox, '/eicore/dec/v1.03/Invoice?QrCodeSize=250', {
          method: 'POST',
          headers: this.baseHeaders(company, company.gstin || '', { AuthToken: token }),
          body: JSON.stringify(payload),
        }));

      const data = this.parseData(json.Data);
      return {
        success: true,
        irn: data.Irn,
        ackNo: String(data.AckNo),
        ackDate: this.parseNicDate(data.AckDt),
        signedQr: data.SignedQRCode,
        signedInvoice: data.SignedInvoice,
        message: company.taxproSandbox ? 'IRN generated (SANDBOX)' : 'IRN generated successfully',
      };
    } catch (err: any) {
      logger.error('TaxPro IRN Generation Error:', err);
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Cancels an already generated E-Invoice (IRN). Allowed within 24h of ack.
   */
  public static async cancelIRN(dispatchId: string, cancelReason: string, cancelRemarks: string) {
    const dispatch = await prisma.saleDispatch.findUnique({ where: { id: dispatchId } });
    if (!dispatch || !dispatch.irn) throw new Error('IRN not found on dispatch');

    const company = await getCompanyProfileRow();
    const isMock = this.credsMissing(company);

    const payload = {
      Irn: dispatch.irn,
      CnlRsn: cancelReason || '1', // 1-Duplicate, 2-Data Entry Mistake, 3-Order Cancelled, 4-Others
      CnlRem: cancelRemarks || 'Cancelled from ERP system',
    };

    if (isMock) {
      return { success: true, cancelledDate: new Date(), message: 'Simulated IRN cancelled (credentials not configured)' };
    }

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) =>
        this.request(company.taxproSandbox, '/eicore/dec/v1.03/Invoice/Cancel', {
          method: 'POST',
          headers: this.baseHeaders(company, company.gstin || '', { AuthToken: token }),
          body: JSON.stringify(payload),
        }));
      const data = this.parseData(json.Data) || {};
      return {
        success: true,
        cancelledDate: data.CancelDate ? this.parseNicDate(data.CancelDate) : new Date(),
        message: 'IRN cancelled successfully',
      };
    } catch (err: any) {
      logger.error('TaxPro IRN Cancellation Error:', err);
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Formats a Credit Note or Debit Note into the NIC E-Invoice JSON payload (schema v1.1).
   */
  public static async prepareNoteEInvoicePayload(noteId: string, kind: 'CREDIT' | 'DEBIT') {
    const note = await (kind === 'CREDIT' ? (prisma.creditNote as any) : (prisma.debitNote as any)).findUnique({
      where: { id: noteId },
      include: {
        party: {
          include: { addresses: true },
        },
        saleDispatch: {
          include: {
            saleOrder: {
              include: {
                buyer: {
                  include: { addresses: true },
                },
              },
            },
          },
        },
      },
    }) as any;

    if (!note) throw new Error(`${kind === 'CREDIT' ? 'Credit' : 'Debit'} note not found`);

    const company = await getCompanyProfileRow();
    if (!company.gstin) throw new Error('Company GSTIN is not set in Settings');

    const party = note.party;
    const dispatch = note.saleDispatch;
    const order = dispatch?.saleOrder;
    const addressDetails = order ? await resolveOrderEffectiveDetails(order) : null;

    const effectiveBuyerGstin = (addressDetails?.effectiveGstin || order?.buyerGstin || party.gstin || '').trim();
    if (!effectiveBuyerGstin) {
      throw new Error(`Party "${party.name}" has no GSTIN on file. E-Invoice (IRN) requires a registered B2B GSTIN.`);
    }

    const dispatchFrom = this.dispatchFromDetails(company as any);
    const sellerAddr = this.formatNICAddress(dispatchFrom.addr1, 'Factory premises');
    const sellerLoc = this.formatNICPlace(dispatchFrom.place, 'Punganur');
    const sellerStateCode = company.gstin.slice(0, 2);

    const buyerAddr = this.formatNICAddress(
      addressDetails?.effectiveAddress || order?.buyerAddress || party.address,
      'Buyer address',
    );
    const buyerLoc = this.formatNICPlace(
      addressDetails?.effectiveCity || order?.buyerCity || party.city || party.state,
      'Town',
    );
    const buyerPincode = Number(addressDetails?.effectivePincode || order?.buyerPincode || party.pincode) || 0;
    const buyerStateCode = effectiveBuyerGstin.slice(0, 2);
    const isSameState = sellerStateCode === buyerStateCode;

    // Commodity / HSN resolution
    let hsn = '120799';
    let description = `${kind === 'CREDIT' ? 'Credit Note' : 'Debit Note'} - ${note.reason}`;
    if (order?.product) {
      const taxInfo = await prisma.productTaxInfo.findUnique({ where: { product: order.product } });
      const rawHsn = resolveProductHsn(order.buyer || party, taxInfo, order.gstExempt);
      hsn = this.requireHsn(rawHsn, order.product);
      description = taxInfo?.description || `${order.product} ${kind === 'CREDIT' ? 'Credit' : 'Debit'} Note`;
    } else {
      hsn = this.requireHsn(hsn, 'Tamarind Goods');
    }

    const taxableValue = Number(note.taxableValue);
    const gstRate = Number(note.gstRate);
    const gstAmount = Math.round(taxableValue * gstRate) / 100;
    const totalAmount = Math.round((taxableValue + gstAmount) * 100) / 100;

    const cgstAmt = isSameState ? Math.round((gstAmount / 2) * 100) / 100 : 0;
    const sgstAmt = isSameState ? Math.round((gstAmount / 2) * 100) / 100 : 0;
    const igstAmt = isSameState ? 0 : gstAmount;

    // Quantity / Rate derivation
    let qty = 1;
    let unit = 'OTH';
    let unitPrice = taxableValue;

    if (dispatch?.shortageKg && dispatch.shortageKg > 0) {
      qty = dispatch.shortageKg;
      unit = 'KGS';
      unitPrice = Math.round((taxableValue / qty) * 100) / 100;
    } else if (order?.ratePerKg && Number(order.ratePerKg) > 0) {
      const rate = Number(order.ratePerKg);
      const derivedQty = Math.round(taxableValue / rate);
      if (derivedQty > 0) {
        qty = derivedQty;
        unit = 'KGS';
        unitPrice = rate;
      }
    }

    const origInvNo = dispatch?.invoiceNumber;
    const origInvDate = dispatch?.invoiceDate || dispatch?.dispatchDate || note.noteDate;

    return {
      Version: '1.1',
      TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
      DocDtls: {
        Typ: kind === 'CREDIT' ? 'CRN' : 'DBN',
        No: note.noteNumber,
        Dt: this.formatNICDate(note.noteDate || new Date()),
      },
      SellerDtls: {
        Gstin: company.gstin,
        LglNm: company.name.slice(0, 100),
        Addr1: sellerAddr.addr1,
        ...(sellerAddr.addr2 || dispatchFrom.addr2 ? { Addr2: (sellerAddr.addr2 || dispatchFrom.addr2).slice(0, 100) } : {}),
        Loc: sellerLoc,
        Pin: dispatchFrom.pincode,
        Stcd: sellerStateCode,
      },
      BuyerDtls: {
        Gstin: effectiveBuyerGstin,
        LglNm: party.name.slice(0, 100),
        Pos: buyerStateCode,
        Addr1: buyerAddr.addr1,
        ...(buyerAddr.addr2 ? { Addr2: buyerAddr.addr2 } : {}),
        Loc: buyerLoc,
        Pin: buyerPincode,
        Stcd: buyerStateCode,
      },
      ...(origInvNo ? {
        RefDtls: {
          PrecDocDtls: [
            {
              InvNo: origInvNo,
              InvDt: this.formatNICDate(origInvDate),
            },
          ],
        },
      } : {}),
      ItemList: [
        {
          SlNo: '1',
          PrdDesc: description.slice(0, 100),
          IsServc: 'N',
          HsnCd: hsn,
          Qty: qty,
          Unit: unit,
          UnitPrice: unitPrice,
          TotAmt: taxableValue,
          Discount: 0,
          AssAmt: taxableValue,
          GstRt: gstRate,
          CgstAmt: cgstAmt,
          SgstAmt: sgstAmt,
          IgstAmt: igstAmt,
          TotItemVal: totalAmount,
        },
      ],
      ValDtls: {
        AssVal: taxableValue,
        CgstVal: cgstAmt,
        SgstVal: sgstAmt,
        IgstVal: igstAmt,
        TotInvVal: totalAmount,
      },
    };
  }

  /**
   * Authenticates and generates an E-Invoice (IRN) for a Credit Note or Debit Note via TaxPro GSP.
   */
  public static async generateNoteIRN(noteId: string, kind: 'CREDIT' | 'DEBIT') {
    const company = await getCompanyProfileRow();
    const isMock = this.credsMissing(company);

    const payload = await this.prepareNoteEInvoicePayload(noteId, kind);

    if (isMock) {
      const irn = Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      const ackNo = String(100000000000 + Math.floor(Math.random() * 900000000000));
      const qrData = `IRN:${irn}|GSTIN:${payload.SellerDtls.Gstin}|DocType:${payload.DocDtls.Typ}|DocNo:${payload.DocDtls.No}|Amt:${payload.ValDtls.TotInvVal}|Date:${payload.DocDtls.Dt}`;
      return {
        success: true,
        irn,
        ackNo,
        ackDate: new Date(),
        signedQr: qrData,
        message: `Simulated IRN generated for ${kind === 'CREDIT' ? 'Credit' : 'Debit'} Note (TaxPro credentials not configured)`,
      };
    }

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) =>
        this.request(company.taxproSandbox, '/eicore/dec/v1.03/Invoice?QrCodeSize=250', {
          method: 'POST',
          headers: this.baseHeaders(company, company.gstin || '', { AuthToken: token }),
          body: JSON.stringify(payload),
        }));

      const data = this.parseData(json.Data);
      return {
        success: true,
        irn: data.Irn,
        ackNo: String(data.AckNo),
        ackDate: this.parseNicDate(data.AckDt),
        signedQr: data.SignedQRCode,
        signedInvoice: data.SignedInvoice,
        message: company.taxproSandbox
          ? `${kind === 'CREDIT' ? 'Credit' : 'Debit'} Note IRN generated (SANDBOX)`
          : `${kind === 'CREDIT' ? 'Credit' : 'Debit'} Note IRN generated successfully`,
      };
    } catch (err: any) {
      logger.error(`TaxPro ${kind} Note IRN Generation Error:`, err);
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Cancels an already generated E-Invoice (IRN) for a Credit Note or Debit Note. Allowed within 24h of ack.
   */
  public static async cancelNoteIRN(
    noteId: string,
    kind: 'CREDIT' | 'DEBIT',
    cancelReason: string,
    cancelRemarks: string,
  ) {
    const note = await (kind === 'CREDIT' ? (prisma.creditNote as any) : (prisma.debitNote as any)).findUnique({ where: { id: noteId } });
    if (!note || !note.irn) throw new Error(`IRN not found on ${kind === 'CREDIT' ? 'credit' : 'debit'} note`);

    const company = await getCompanyProfileRow();
    const isMock = this.credsMissing(company);

    const payload = {
      Irn: note.irn,
      CnlRsn: cancelReason || '1', // 1-Duplicate, 2-Data Entry Mistake, 3-Order Cancelled, 4-Others
      CnlRem: cancelRemarks || 'Cancelled from ERP system',
    };

    if (isMock) {
      return { success: true, cancelledDate: new Date(), message: 'Simulated IRN cancelled (credentials not configured)' };
    }

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) =>
        this.request(company.taxproSandbox, '/eicore/dec/v1.03/Invoice/Cancel', {
          method: 'POST',
          headers: this.baseHeaders(company, company.gstin || '', { AuthToken: token }),
          body: JSON.stringify(payload),
        }));
      const data = this.parseData(json.Data) || {};
      return {
        success: true,
        cancelledDate: data.CancelDate ? this.parseNicDate(data.CancelDate) : new Date(),
        message: `${kind === 'CREDIT' ? 'Credit' : 'Debit'} Note IRN cancelled successfully`,
      };
    } catch (err: any) {
      logger.error(`TaxPro ${kind} Note IRN Cancellation Error:`, err);
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Generates E-Way Bill for a dispatch (based on active IRN).
   */
  public static async generateEWayBill(dispatchId: string, transportDetails: {
    transporterId?: string;
    transporterName?: string;
    transDistance: number;
    transMode: string; // '1'-Road, '2'-Rail, '3'-Air, '4'-Ship
    vehicleNumber: string;
    vehicleType: string; // 'R'-Regular, 'O'-ODC
    transDocNo?: string; // LR/RR/Airway bill no (required for rail/air/ship)
    transDocDt?: string; // yyyy-mm-dd; sent to NIC as DD/MM/YYYY
  }) {
    const dispatch = await prisma.saleDispatch.findUnique({ where: { id: dispatchId } });
    if (!dispatch || !dispatch.irn) throw new Error('E-Invoice IRN must be generated before E-Way Bill');

    const company = await getCompanyProfileRow();
    const isMock = this.credsMissing(company);

    // NIC enforces exact min/max lengths on the transporter/document fields and
    // does NOT treat an empty string as "not supplied" (error 5002). So we build
    // the payload with only the required fields and add each optional field only
    // when a real value is present.
    const vehNo = (transportDetails.vehicleNumber || dispatch.vehicleNumber || '')
      .toUpperCase()
      .replace(/\s+/g, '');

    const transMode = transportDetails.transMode || '1';
    const isRoad = transMode === '1';

    const payload: Record<string, any> = {
      Irn: dispatch.irn,
      // A real distance is always sent (the route layer rejects 0). Submitting 0
      // does work - NIC then computes it from the PIN codes - but it keeps the
      // figure to itself, and the print service can only render what we hold.
      Distance: Number(transportDetails.transDistance) || 0,
      TransMode: transMode,
    };

    // Part-B (vehicle) - road movement only. For rail/air/ship the transport
    // document (below) is the Part-B, and sending a vehicle number conflicts.
    if (isRoad && vehNo) {
      payload.VehNo = vehNo;
      payload.VehType = transportDetails.vehicleType || 'R';
    }

    // Optional: transporter GSTIN (Transin) and name. NIC enforces exact formats
    // (GSTIN = 15 chars matching the pattern; name >= 3 chars) and rejects the
    // whole request otherwise, so only attach these when they are actually valid.
    const transId = (transportDetails.transporterId || '').trim().toUpperCase();
    if (/^[0-9]{2}[A-Z0-9]{13}$/.test(transId)) payload.TransId = transId;
    const transName = (transportDetails.transporterName || '').trim();
    if (transName.length >= 3) payload.TransName = transName;

    // Transport document (Part-A) - required for rail/air/ship, optional for road.
    const transDocNo = (transportDetails.transDocNo || '').trim();
    if (transDocNo) payload.TransDocNo = transDocNo;
    const transDocDt = (transportDetails.transDocDt || '').trim();
    if (transDocDt) payload.TransDocDt = this.formatNICDate(new Date(transDocDt)); // DD/MM/YYYY

    if (isMock) {
      const ewbNo = String(200000000000 + Math.floor(Math.random() * 800000000000));
      const validUpto = new Date();
      const daysValid = Math.max(1, Math.ceil(transportDetails.transDistance / 100));
      validUpto.setDate(validUpto.getDate() + daysValid);
      return {
        success: true,
        ewbNumber: ewbNo,
        ewbDate: new Date(),
        ewbValidUpto: validUpto,
        distance: Number(transportDetails.transDistance) || null,
        message: 'Simulated E-Way Bill generated (credentials not configured)',
      };
    }

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) =>
        this.request(company.taxproSandbox, '/eiewb/dec/v1.03/ewaybill', {
          method: 'POST',
          headers: this.baseHeaders(company, company.gstin || '', { AuthToken: token }),
          body: JSON.stringify(payload),
        }));
      const data = this.parseData(json.Data) || {};
      // When Distance was submitted as 0, NIC computes it from the two PIN codes
      // and echoes the figure back. Prefer that over what we sent, so the stored
      // (and reprinted) distance matches the live bill instead of showing 0 km.
      const nicDistance = Number(data.Distance ?? data.distance);
      const distance = Number.isFinite(nicDistance) && nicDistance > 0
        ? Math.round(nicDistance)
        : (Number(transportDetails.transDistance) || null);
      return {
        success: true,
        ewbNumber: String(data.EwbNo),
        ewbDate: this.parseNicDate(data.EwbDt),
        ewbValidUpto: this.parseNicDate(data.EwbValidTill),
        distance,
        message: 'E-Way Bill generated successfully',
      };
    } catch (err: any) {
      // If NIC rejected a non-zero distance because it deviates from its internal
      // PIN-to-PIN database, automatically retry with Distance: 0 so NIC auto-calculates it.
      const isDistanceError =
        /distance/i.test(err?.message || '') ||
        (Array.isArray(err?.errorDetails) &&
          err.errorDetails.some(
            (e: any) =>
              ['238', '239', '700', '5003'].includes(String(e?.ErrorCode)) ||
              /distance/i.test(e?.ErrorMessage || ''),
          ));

      if (payload.Distance !== 0 && isDistanceError) {
        logger.warn(
          `[taxpro] NIC rejected distance ${payload.Distance} km (${err.message}). Retrying with Distance: 0 (NIC PIN-to-PIN auto-calculation)...`,
        );
        try {
          const retryPayload = { ...payload, Distance: 0 };
          const retryJson = await this.withAuth(company, company.gstin || '', (token) =>
            this.request(company.taxproSandbox, '/eiewb/dec/v1.03/ewaybill', {
              method: 'POST',
              headers: this.baseHeaders(company, company.gstin || '', { AuthToken: token }),
              body: JSON.stringify(retryPayload),
            }),
          );
          const retryData = this.parseData(retryJson.Data) || {};
          const nicDistance = Number(retryData.Distance ?? retryData.distance);
          const distance = Number.isFinite(nicDistance) && nicDistance > 0
            ? Math.round(nicDistance)
            : (Number(transportDetails.transDistance) || null);
          return {
            success: true,
            ewbNumber: String(retryData.EwbNo),
            ewbDate: this.parseNicDate(retryData.EwbDt),
            ewbValidUpto: this.parseNicDate(retryData.EwbValidTill),
            distance,
            message: 'E-Way Bill generated successfully (NIC auto-calculated distance)',
          };
        } catch (retryErr: any) {
          logger.error('TaxPro EWB Generation Retry Error:', retryErr);
          throw new Error(`TaxPro GSP Error: ${retryErr.message}`);
        }
      }

      // If NIC rejected because an EWB was already generated for this document (e.g. earlier network blip),
      // attempt to recover it directly using GetEwayBillGeneratedByConsigner
      const isAlreadyExistsError =
        /already.*exist|duplicate.*ewb|1003|4013/i.test(err?.message || '') ||
        (Array.isArray(err?.errorDetails) &&
          err.errorDetails.some(
            (e: any) =>
              ['1003', '4013'].includes(String(e?.ErrorCode)) ||
              /already.*exist|duplicate/i.test(e?.ErrorMessage || ''),
          ));

      if (isAlreadyExistsError && dispatch.invoiceNumber) {
        logger.warn(`[taxpro] EWB reported already exists for invoice ${dispatch.invoiceNumber}. Attempting auto-recovery...`);
        try {
          const recovered = await this.recoverEwayBillByDoc(dispatch.invoiceNumber);
          if (recovered && (recovered.ewbNo || recovered.EwbNo)) {
            const ewbNo = String(recovered.ewbNo || recovered.EwbNo);
            const ewbDate = recovered.ewbDate || recovered.EwbDt || new Date();
            const validUpto = recovered.validUpto || recovered.EwbValidTill || recovered.validTill;
            return {
              success: true,
              ewbNumber: ewbNo,
              ewbDate: this.parseNicDate(ewbDate),
              ewbValidUpto: validUpto ? this.parseNicDate(validUpto) : new Date(),
              distance: Number(recovered.distance || recovered.Distance) || (Number(transportDetails.transDistance) || null),
              message: 'E-Way Bill auto-recovered from government portal',
            };
          }
        } catch (recErr: any) {
          logger.warn(`[taxpro] Auto-recovery failed: ${recErr.message}`);
        }
      }

      logger.error('TaxPro EWB Generation Error:', err);
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Builds the `printewb`/`printdetailewb` request body for a dispatch.
   * This is the flat EWB-portal record shape (NOT the NIC e-invoice schema) -
   * the ASP print service re-renders the government layout from these fields.
   */
  private static async buildEwbPrintPayload(dispatchId: string) {
    const dispatch = await prisma.saleDispatch.findUnique({
      where: { id: dispatchId },
      include: { saleOrder: { include: { buyer: true } } },
    });
    if (!dispatch || !dispatch.ewbNumber) throw new Error('E-Way Bill number not found on dispatch');
    if (!dispatch.ewbDate || !dispatch.ewbValidUpto) throw new Error('E-Way Bill dates missing on dispatch');
    // The ASP print service is a pure renderer of what we POST, and the NIC
    // e-invoice product gives us no way to read the portal's own figure back.
    // So an unrecorded distance would print "Approx Distance: 0 KM" on a
    // government-format bill - which makes the printed copy invalid. Refuse to
    // render it and say exactly how to fix it instead.
    if (!dispatch.ewbDistance) {
      throw new Error(
        `E-Way Bill ${dispatch.ewbNumber} has no approx distance recorded, so the government print would show 0 KM. ` +
        `Open the E-Way Bill page and save the distance shown on the NIC portal, then print again.`,
      );
    }

    const order = dispatch.saleOrder;
    const buyer = order.buyer;
    const company = await getCompanyProfileRow();
    if (this.credsMissing(company)) {
      throw new Error('TaxPro credentials are not configured - cannot fetch the official EWB PDF');
    }

    const taxInfo = await prisma.productTaxInfo.findUnique({ where: { product: order.product } });
    const description = taxInfo?.description || `${order.product} Sale`;
    // Same exemption swap as the e-invoice payload above; Krishi Nutrition uses constant HSN 11063010.
    const rawHsn = resolveProductHsn(buyer, taxInfo, order.gstExempt);
    const hsn = this.requireHsn(rawHsn, order.product);

    const sellerStateCode = company.gstin?.slice(0, 2) || '';
    const buyerStateCode = buyer.gstin?.slice(0, 2) || '';
    const isSameState = sellerStateCode === buyerStateCode && sellerStateCode !== '';

    const dispatchFrom = this.dispatchFromDetails(company as any);
    const shipTo = this.shipToDetails(buyer as any);

    const weight = dispatch.weightKg;
    const rate = Number(order.ratePerKg);
    const baseAmount = Math.round(weight * rate * 100) / 100;
    const gstRate = order.gstExempt ? 0 : (taxInfo?.gstRate != null ? Number(taxInfo.gstRate) : 5);
    const gstAmount = Math.round(baseAmount * gstRate) / 100;
    const totalAmount = Math.round((baseAmount + gstAmount) * 100) / 100;
    const cgstAmt = isSameState ? Math.round((gstAmount / 2) * 100) / 100 : 0;
    const sgstAmt = isSameState ? Math.round((gstAmount / 2) * 100) / 100 : 0;
    const igstAmt = isSameState ? 0 : gstAmount;

    const noValidDays = Math.max(
      1,
      Math.ceil((dispatch.ewbValidUpto.getTime() - dispatch.ewbDate.getTime()) / (24 * 60 * 60 * 1000)),
    );

    const sellerAddr = this.formatNICAddress(dispatchFrom.addr1, 'Factory premises');
    const buyerAddr = this.formatNICAddress(order.buyerAddress || buyer.address, 'Buyer address');
    const sellerLoc = this.formatNICPlace(dispatchFrom.place, 'Punganur');
    const buyerLoc = this.formatNICPlace(order.buyerCity || shipTo.place, 'Town');

    const payload = {
      ewbNo: Number(dispatch.ewbNumber),
      ewayBillDate: this.formatNICDateTime(dispatch.ewbDate),
      genMode: 'API',
      userGstin: company.gstin,
      supplyType: 'O',
      subSupplyType: '1',
      docType: 'INV',
      docNo: dispatch.invoiceNumber || `DISP-${dispatch.id.slice(-6)}`,
      docDate: this.formatNICDate(dispatch.invoiceDate || dispatch.dispatchDate),
      fromGstin: company.gstin,
      fromTrdName: company.name.slice(0, 100),
      fromAddr1: sellerAddr.addr1,
      fromAddr2: (sellerAddr.addr2 || dispatchFrom.addr2 || '').slice(0, 100),
      fromPlace: sellerLoc,
      fromPincode: dispatchFrom.pincode,
      fromStateCode: Number(sellerStateCode) || 0,
      toGstin: (order.buyerGstin || buyer.gstin || 'URP').trim(),
      toTrdName: buyer.name.slice(0, 100),
      toAddr1: buyerAddr.addr1,
      toAddr2: (buyerAddr.addr2 || '').slice(0, 100),
      toPlace: buyerLoc,
      toPincode: Number(order.buyerPincode) || shipTo.pincode,
      toStateCode: Number(buyerStateCode) || 0,
      totalValue: baseAmount,
      totInvValue: totalAmount,
      cgstValue: cgstAmt,
      sgstValue: sgstAmt,
      igstValue: igstAmt,
      cessValue: 0,
      transporterId: '',
      transporterName: '',
      status: dispatch.ewbStatus === 'CANCELLED' ? 'CNL' : 'ACT',
      actualDist: dispatch.ewbDistance,
      noValidDays,
      validUpto: this.formatNICDateTime(dispatch.ewbValidUpto),
      extendedTimes: 0,
      rejectStatus: 'N',
      vehicleType: dispatch.ewbVehicleType || 'R',
      actFromStateCode: Number(sellerStateCode) || 0,
      actToStateCode: Number(buyerStateCode) || 0,
      transactionType: 1,
      otherValue: 0,
      cessNonAdvolValue: 0,
      itemList: [
        {
          itemNo: 1,
          productId: 0,
          productName: description,
          productDesc: description,
          hsnCode: Number(hsn) || 0,
          quantity: weight,
          qtyUnit: 'KGS',
          cgstRate: isSameState ? gstRate / 2 : 0,
          sgstRate: isSameState ? gstRate / 2 : 0,
          igstRate: isSameState ? 0 : gstRate,
          cessRate: 0,
          cessNonAdvol: 0,
          taxableAmount: baseAmount,
        },
      ],
      VehiclListDetails: [
        {
          updMode: 'API',
          vehicleNo: dispatch.vehicleNumber || '',
          // The vehicle-details "From" column is the town the lorry loaded at,
          // not the state - same dispatch place as the address block above.
          fromPlace: dispatchFrom.place,
          fromState: Number(sellerStateCode) || 0,
          tripshtNo: 0,
          userGSTINTransin: company.gstin,
          enteredDate: this.formatNICDateTime(dispatch.ewbDate),
          transMode: dispatch.ewbTransMode || '1',
          transDocNo: dispatch.ewbTransDocNo || '',
          transDocDate: dispatch.ewbTransDocDate ? this.formatNICDate(dispatch.ewbTransDocDate) : null,
          groupNo: '0',
        },
      ],
    };

    return { company, payload };
  }

  /**
   * POSTs an EWB print payload to one of the ASP print endpoints and returns the PDF.
   *
   * Unlike every other call in this service, the `/aspapi` print endpoints are a
   * TaxPro *rendering* service rather than a NIC pass-through, so:
   *  - they live on the PRODUCTION host even when the rest of the integration is
   *    pointed at sandbox (TaxPro's own sandbox Postman collection calls them on
   *    einvapi.charteredinfo.com), and
   *  - they authenticate via QUERY STRING (aspid/password/Gstin). We also send the
   *    usual headers, which the /dec/ gateway accepts, so either style works.
   */
  private static async fetchEwbPrintPdf(
    company: TaxproConfig,
    endpoint: 'printewb' | 'printdetailewb',
    payload: unknown,
  ): Promise<Buffer> {
    const qs = new URLSearchParams({
      aspid: company.taxproGspId || '',
      password: company.taxproGspSecret || '',
      Gstin: company.gstin || '',
    });

    let lastError: any = null;

    for (const base of this.PRODUCTION_BASE_URLS) {
      try {
        const url = `${base}/aspapi/v1.0/${endpoint}?${qs}`;

        const res = await fetch(url, {
          method: 'POST',
          headers: this.baseHeaders(company, company.gstin || ''),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.REQUEST_TIMEOUT_MS),
        });

        const buf = Buffer.from(await res.arrayBuffer());
        // A PDF always starts with "%PDF-"; trust the magic bytes over Content-Type,
        // which TaxPro is not guaranteed to set correctly.
        if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return buf;

        let msg = `Unexpected non-PDF response (HTTP ${res.status})`;
        try {
          const json = JSON.parse(buf.toString('utf8'));
          msg = json?.error?.message || json?.ErrorDetails?.[0]?.ErrorMessage || json?.message || msg;
        } catch {
          const text = buf.toString('utf8').trim();
          if (text) msg = `${msg}: ${text.slice(0, 300)}`;
        }
        throw new Error(`TaxPro ${endpoint} error: ${msg}`);
      } catch (err: any) {
        lastError = err;
        logger.warn(`TaxPro PDF print failed on ${base}: ${err.message}. Trying next backup server...`);
      }
    }

    throw lastError || new Error(`All TaxPro PDF print endpoints failed`);
  }

  /** Official government-format E-Way Bill PDF (standard print). */
  public static async printEWayBillPdf(dispatchId: string): Promise<Buffer> {
    const { company, payload } = await this.buildEwbPrintPayload(dispatchId);
    return this.fetchEwbPrintPdf(company, 'printewb', payload);
  }

  /** Official government-format E-Way Bill PDF (detailed print). */
  public static async printEWayBillDetailPdf(dispatchId: string): Promise<Buffer> {
    const { company, payload } = await this.buildEwbPrintPayload(dispatchId);
    return this.fetchEwbPrintPdf(company, 'printdetailewb', payload);
  }

  /**
   * Cancels E-Way Bill.
   * NOTE: EWB *cancellation* is NOT part of the /eicore e-invoice pass-through -
   * it lives under the separate `/ewaybillapi` path. Endpoint + payload shape
   * confirmed against TaxPro's official sandbox Postman collection (2026-07-25):
   * POST /ewaybillapi/dec/v1.03/ewayapi?action=CANEWB, body {ewbNo, cancelRsnCode, cancelRmrk}.
   */
  public static async cancelEWayBill(dispatchId: string, cancelReason: string, cancelRemarks: string) {
    const dispatch = await prisma.saleDispatch.findUnique({ where: { id: dispatchId } });
    if (!dispatch || !dispatch.ewbNumber) throw new Error('E-Way Bill number not found on dispatch');

    const company = await getCompanyProfileRow();
    const isMock = this.credsMissing(company);

    const payload = {
      ewbNo: Number(dispatch.ewbNumber),
      cancelRsnCode: Number(cancelReason || '1'), // 1-Duplicate, 2-Order Cancelled, 3-Mistake, 4-Other
      cancelRmrk: cancelRemarks || 'Cancelled from ERP system',
    };

    if (isMock) {
      return { success: true, cancelledDate: new Date(), message: 'Simulated E-Way Bill cancelled (credentials not configured)' };
    }

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) => {
        const ewbPath = company.taxproSandbox
          ? `/ewaybillapi/dec/v1.03/ewayapi?${this.ewbQueryString(company, company.gstin || '', 'CANEWB', { authtoken: token })}`
          : `/v1.03/dec/ewayapi?action=CANEWB&authtoken=${encodeURIComponent(token)}`;
        const headers = this.baseHeaders(company, company.gstin || '', { authtoken: token, AuthToken: token });

        return this.request(company.taxproSandbox, ewbPath, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });
      });

      const data = this.parseData(json?.Data ?? json?.data) || json || {};
      const cancelDate = data.CancelDate || data.cancelDate || data.cancel_date;
      return {
        success: true,
        cancelledDate: cancelDate ? this.parseNicDate(cancelDate) : new Date(),
        message: 'E-Way Bill cancelled successfully',
      };
    } catch (err: any) {
      logger.error('TaxPro EWB Cancellation Error:', err);
      const msg = String(err?.message || '');
      if (/412|already.*cancel|multi.*vehicle/i.test(msg)) {
        return {
          success: true,
          cancelledDate: new Date(),
          message: 'E-Way Bill is already cancelled on the government portal (NIC 412 / Precondition Met)',
        };
      }
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Updates vehicle (Part-B) of an active E-Way Bill without cancelling it.
   * Allowed for road transport when a vehicle breaks down or is transshipped.
   */
  public static async updateVehicle(dispatchId: string, params: {
    vehicleNo: string;
    fromPlace: string;
    fromState: number;
    reasonCode: string; // '1'-Due to break down, '2'-Due to transshipment, '3'-Others, '4'-First time Part-B
    reasonRem: string;
    transDocNo?: string;
    transDocDate?: string;
    transMode?: string;
    vehicleType?: string;
  }) {
    const dispatch = await prisma.saleDispatch.findUnique({ where: { id: dispatchId } });
    if (!dispatch || !dispatch.ewbNumber) throw new Error('E-Way Bill number not found on dispatch');
    if (dispatch.ewbStatus === 'CANCELLED') throw new Error('Cannot update vehicle on a cancelled E-Way Bill');

    const company = await getCompanyProfileRow();
    const isMock = this.credsMissing(company);

    const payload: Record<string, any> = {
      ewbNo: Number(dispatch.ewbNumber),
      vehicleNo: params.vehicleNo.toUpperCase().replace(/\s+/g, ''),
      fromPlace: params.fromPlace.slice(0, 50),
      fromState: Number(params.fromState),
      reasonCode: params.reasonCode || '1',
      reasonRem: params.reasonRem || 'Vehicle updated from ERP',
      transMode: params.transMode || '1',
      vehicleType: params.vehicleType || 'R',
    };
    if (params.transDocNo) payload.transDocNo = params.transDocNo;
    if (params.transDocDate) payload.transDocDate = this.formatNICDate(new Date(params.transDocDate));

    if (isMock) {
      return {
        success: true,
        vehicleNo: payload.vehicleNo,
        updatedDate: new Date(),
        message: 'Simulated vehicle update successful (credentials not configured)',
      };
    }

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) => {
        const ewbPath = company.taxproSandbox
          ? `/ewaybillapi/dec/v1.03/ewayapi?${this.ewbQueryString(company, company.gstin || '', 'VEHEWB', { authtoken: token })}`
          : `/v1.03/dec/ewayapi?action=VEHEWB&authtoken=${encodeURIComponent(token)}`;
        return this.request(company.taxproSandbox, ewbPath, {
          method: 'POST',
          headers: this.baseHeaders(company, company.gstin || '', { authtoken: token, AuthToken: token }),
          body: JSON.stringify(payload),
        });
      });
      const data = this.parseData(json?.Data ?? json?.data) || json || {};
      const updatedDate = data.VehUpdDate ? this.parseNicDate(data.VehUpdDate) : new Date();
      return {
        success: true,
        vehicleNo: payload.vehicleNo,
        updatedDate,
        validUpto: data.validUpto ? this.parseNicDate(data.validUpto) : undefined,
        message: 'E-Way Bill vehicle updated successfully',
      };
    } catch (err: any) {
      logger.error('TaxPro VEHEWB Error:', err);
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Extends the validity period of an active E-Way Bill.
   * Allowed within 8 hours before or 8 hours after validity expiry.
   */
  public static async extendValidity(dispatchId: string, params: {
    vehicleNo: string;
    fromPlace: string;
    fromState: number;
    fromPincode: number;
    remainingDistance: number;
    extnRsnCode: number; // 1-Natural Calamity, 2-Law and Order, 3-Transshipment, 4-Accident, 5-Others
    extnRemarks: string;
    consignmentStatus?: string; // 'M'-In Movement, 'T'-In Transit
    transitType?: string; // 'R'-Road, 'W'-Warehouse, 'O'-Others
    transDocNo?: string;
    transDocDate?: string;
    transMode?: string;
    addressLine1?: string;
    addressLine2?: string;
    addressLine3?: string;
  }) {
    const dispatch = await prisma.saleDispatch.findUnique({ where: { id: dispatchId } });
    if (!dispatch || !dispatch.ewbNumber) throw new Error('E-Way Bill number not found on dispatch');
    if (dispatch.ewbStatus === 'CANCELLED') throw new Error('Cannot extend validity on a cancelled E-Way Bill');

    const company = await getCompanyProfileRow();
    const isMock = this.credsMissing(company);

    const payload: Record<string, any> = {
      ewbNo: Number(dispatch.ewbNumber),
      vehicleNo: params.vehicleNo.toUpperCase().replace(/\s+/g, ''),
      fromPlace: params.fromPlace.slice(0, 50),
      fromState: Number(params.fromState),
      fromPincode: Number(params.fromPincode),
      remainingDistance: Number(params.remainingDistance),
      extnRsnCode: Number(params.extnRsnCode || 1),
      extnRemarks: params.extnRemarks || 'Extended from ERP',
      transMode: params.transMode || '1',
      consignmentStatus: params.consignmentStatus || 'T',
      transitType: params.transitType || 'R',
      addressLine1: (params.addressLine1 || params.fromPlace).slice(0, 100),
      addressLine2: (params.addressLine2 || '').slice(0, 100),
      addressLine3: (params.addressLine3 || '').slice(0, 100),
    };
    if (params.transDocNo) payload.transDocNo = params.transDocNo;
    if (params.transDocDate) payload.transDocDate = this.formatNICDate(new Date(params.transDocDate));

    if (isMock) {
      const newValid = new Date();
      newValid.setDate(newValid.getDate() + Math.max(1, Math.ceil(params.remainingDistance / 100)));
      return {
        success: true,
        newValidUpto: newValid,
        message: 'Simulated validity extension successful (credentials not configured)',
      };
    }

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) => {
        const ewbPath = company.taxproSandbox
          ? `/ewaybillapi/dec/v1.03/ewayapi?${this.ewbQueryString(company, company.gstin || '', 'EXTENDVALIDITY', { authtoken: token })}`
          : `/v1.03/dec/ewayapi?action=EXTENDVALIDITY&authtoken=${encodeURIComponent(token)}`;
        return this.request(company.taxproSandbox, ewbPath, {
          method: 'POST',
          headers: this.baseHeaders(company, company.gstin || '', { authtoken: token, AuthToken: token }),
          body: JSON.stringify(payload),
        });
      });
      const data = this.parseData(json?.Data ?? json?.data) || json || {};
      const validUptoStr = data.validUpto || data.validTill || data.ValidUpto;
      return {
        success: true,
        newValidUpto: validUptoStr ? this.parseNicDate(validUptoStr) : new Date(),
        message: 'E-Way Bill validity extended successfully',
      };
    } catch (err: any) {
      logger.error('TaxPro EXTENDVALIDITY Error:', err);
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Fetches live E-Way Bill details directly from the government portal by EWB number.
   */
  public static async getLiveEwayBill(ewbNo: string) {
    const company = await getCompanyProfileRow();
    const isMock = this.credsMissing(company);

    if (isMock) {
      return {
        success: true,
        ewbNo,
        status: 'ACT',
        genMode: 'API',
        data: { ewbNo, status: 'ACT', userGstin: company.gstin },
        message: 'Simulated live EWB query (credentials not configured)',
      };
    }

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) => {
        const ewbPath = company.taxproSandbox
          ? `/ewaybillapi/dec/v1.03/ewayapi?${this.ewbQueryString(company, company.gstin || '', 'GetEwayBill', { authtoken: token, ewbNo })}`
          : `/v1.03/dec/ewayapi?action=GetEwayBill&authtoken=${encodeURIComponent(token)}&ewbNo=${encodeURIComponent(String(ewbNo))}`;
        return this.request(company.taxproSandbox, ewbPath, {
          method: 'GET',
          headers: this.baseHeaders(company, company.gstin || '', { authtoken: token, AuthToken: token }),
        });
      });
      const data = this.parseData(json?.Data ?? json?.data) || json || {};
      return {
        success: true,
        data,
      };
    } catch (err: any) {
      logger.error('TaxPro GetEwayBill Error:', err);
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Fetches live E-Invoice IRN details directly from NIC.
   */
  public static async getLiveIRN(irn: string) {
    const company = await getCompanyProfileRow();
    const isMock = this.credsMissing(company);

    if (isMock) {
      return {
        success: true,
        irn,
        status: 'ACT',
        data: { Irn: irn, Status: 'ACT' },
        message: 'Simulated live IRN query (credentials not configured)',
      };
    }

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) => {
        return this.request(company.taxproSandbox, `/eicore/dec/v1.03/Invoice/irn/${irn}`, {
          method: 'GET',
          headers: this.baseHeaders(company, company.gstin || '', { AuthToken: token }),
        });
      });
      const data = this.parseData(json?.Data ?? json?.data) || json || {};
      return {
        success: true,
        data,
      };
    } catch (err: any) {
      logger.error('TaxPro Get IRN Error:', err);
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Recovers an already-generated EWB by document type and document number.
   * Useful when network failure occurred during generation.
   */
  public static async recoverEwayBillByDoc(docNo: string, docType = 'INV') {
    const company = await getCompanyProfileRow();
    if (this.credsMissing(company)) return null;

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) => {
        const ewbPath = company.taxproSandbox
          ? `/ewaybillapi/dec/v1.03/ewayapi?${this.ewbQueryString(company, company.gstin || '', 'GetEwayBillGeneratedByConsigner', { authtoken: token, docType, docNo })}`
          : `/v1.03/dec/ewayapi?action=GetEwayBillGeneratedByConsigner&authtoken=${encodeURIComponent(token)}&docType=${encodeURIComponent(docType)}&docNo=${encodeURIComponent(docNo)}`;
        return this.request(company.taxproSandbox, ewbPath, {
          method: 'GET',
          headers: this.baseHeaders(company, company.gstin || '', { authtoken: token, AuthToken: token }),
        });
      });
      const data = this.parseData(json?.Data ?? json?.data) || json;
      return data;
    } catch {
      return null;
    }
  }

  /**
   * Looks up transporter details by GSTIN/TRANSIN from official master.
   */
  public static async getTransporterDetails(trnNo: string) {
    const company = await getCompanyProfileRow();
    const isMock = this.credsMissing(company);

    if (isMock) {
      return {
        success: true,
        transId: trnNo,
        transName: 'Verified Transporter (Simulated)',
        status: 'Active',
      };
    }

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) => {
        const path = company.taxproSandbox
          ? `/ewaybillapi/dec/v1.03/Master?${this.ewbQueryString(company, company.gstin || '', 'GetTransporterDetails', { authtoken: token, trn_no: trnNo })}`
          : `/v1.03/dec/Master?action=GetTransporterDetails&authtoken=${encodeURIComponent(token)}&trn_no=${encodeURIComponent(trnNo)}`;
        return this.request(company.taxproSandbox, path, {
          method: 'GET',
          headers: this.baseHeaders(company, company.gstin || '', { authtoken: token, AuthToken: token }),
        });
      });
      const data = this.parseData(json?.Data ?? json?.data) || json || {};
      return {
        success: true,
        data,
      };
    } catch (err: any) {
      logger.error('TaxPro GetTransporterDetails Error:', err);
      const msg = String(err?.message || '');
      if (msg.includes('328') || /could not retrieve/i.test(msg)) {
        throw new Error(`Transporter GSTIN "${trnNo}" could not be retrieved from NIC registry (Error 328). Please verify the GSTIN is active and registered as an enrolled transporter.`);
      }
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Fetches inward E-Way Bills generated by suppliers / third parties for our GSTIN on a given date.
   */
  public static async getInwardEwayBills(dateStr?: string) {
    const company = await getCompanyProfileRow();
    const isMock = this.credsMissing(company);
    const dateFormatted = dateStr
      ? this.formatNICDate(new Date(dateStr))
      : this.formatNICDate(new Date());

    if (isMock) {
      return {
        success: true,
        date: dateFormatted,
        ewayBills: [],
        message: 'Simulated inward EWB query (credentials not configured)',
      };
    }

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) => {
        const path = company.taxproSandbox
          ? `/ewaybillapi/dec/v1.03/ewayapi?${this.ewbQueryString(company, company.gstin || '', 'GetEwayBillsofOtherParty', { authtoken: token, date: dateFormatted })}`
          : `/v1.03/dec/ewayapi?action=GetEwayBillsofOtherParty&authtoken=${encodeURIComponent(token)}&date=${encodeURIComponent(dateFormatted)}`;
        return this.request(company.taxproSandbox, path, {
          method: 'GET',
          headers: this.baseHeaders(company, company.gstin || '', { authtoken: token, AuthToken: token }),
        });
      });
      const data = this.parseData(json?.Data ?? json?.data) || json || [];
      const bills = Array.isArray(data) ? data : (data.bills || (data.ewbNo ? [data] : []));
      return {
        success: true,
        date: dateFormatted,
        ewayBills: bills,
      };
    } catch (err: any) {
      logger.error('TaxPro GetEwayBillsofOtherParty Error:', err);
      const msg = String(err?.message || '');
      if (msg.includes('366') || /today/i.test(msg)) {
        throw new Error(`NIC policy restriction (Error 366): Inward E-Way Bills generated today cannot be retrieved. Please query yesterday (${(() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toLocaleDateString('en-GB'); })()}) or earlier.`);
      }
      if (msg.includes('325') || /could not retrieve/i.test(msg)) {
        return {
          success: true,
          date: dateFormatted,
          ewayBills: [],
          message: `No inward E-Way Bills found for GSTIN on ${dateFormatted} (NIC 325)`,
        };
      }
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Rejects an inward E-Way Bill generated for our GSTIN within 72 hours.
   */
  public static async rejectEwayBill(ewbNo: string) {
    const company = await getCompanyProfileRow();
    const isMock = this.credsMissing(company);

    if (isMock) {
      return { success: true, message: `Simulated rejection of EWB ${ewbNo}` };
    }

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) => {
        const path = company.taxproSandbox
          ? `/ewaybillapi/dec/v1.03/ewayapi?${this.ewbQueryString(company, company.gstin || '', 'REJEWB', { authtoken: token })}`
          : `/v1.03/dec/ewayapi?action=REJEWB&authtoken=${encodeURIComponent(token)}`;
        return this.request(company.taxproSandbox, path, {
          method: 'POST',
          headers: this.baseHeaders(company, company.gstin || '', { authtoken: token, AuthToken: token }),
          body: JSON.stringify({ ewbNo: String(ewbNo) }),
        });
      });
      return { success: true, message: 'E-Way Bill rejected successfully', data: json };
    } catch (err: any) {
      logger.error('TaxPro REJEWB Error:', err);
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Looks up GSTIN details (Legal Name, Trade Name, Address, Status, etc.) from NIC/TaxPro GSP Master API.
   * If sandbox / mock or if credentials missing, returns simulated/fallback verified data.
   */
  public static async lookupGstin(gstin: string) {
    const rawGstin = (gstin || '').trim().toUpperCase();
    if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(rawGstin)) {
      throw new Error('Invalid GSTIN format. Expected 15 characters (e.g. 29AAAAA0000A1Z5)');
    }

    const company = await getCompanyProfileRow();
    const isMock = this.credsMissing(company);

    if (isMock) {
      return {
        success: true,
        gstin: rawGstin,
        legalName: 'TEST ENTERPRISE PVT LTD',
        tradeName: 'TEST ENTERPRISE',
        status: 'ACT',
        taxpayerType: 'Regular',
        address1: 'Plot No. 42, Industrial Area, Phase 1',
        address2: 'Near Ring Road',
        place: 'Bengaluru',
        pincode: '560058',
        stateCode: parseInt(rawGstin.slice(0, 2), 10) || 29,
        state: 'Karnataka',
        message: 'Simulated GSTIN details (mock mode)',
      };
    }

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) => {
        const path = company.taxproSandbox
          ? `/ewaybillapi/dec/v1.03/Master?${this.ewbQueryString(company, company.gstin || '', 'GetGSTINDetails', { authtoken: token, gstin: rawGstin })}`
          : `/v1.03/dec/Master?action=GetGSTINDetails&authtoken=${encodeURIComponent(token)}&gstin=${encodeURIComponent(rawGstin)}`;
        return this.request(company.taxproSandbox, path, {
          method: 'GET',
          headers: this.baseHeaders(company, company.gstin || '', { authtoken: token, AuthToken: token }),
        });
      });

      const data = this.parseData(json?.Data ?? json?.data) || json || {};
      const statusStr = (data.status || data.Status || data.sts || 'ACT').toUpperCase();
      return {
        success: true,
        gstin: rawGstin,
        legalName: data.legalName || data.lgnm || data.tradeNam || data.TradeName || '',
        tradeName: data.tradeName || data.tradeNam || data.lgnm || data.legalName || '',
        status: statusStr.startsWith('ACT') ? 'ACT' : 'CNL',
        taxpayerType: data.taxpayerType || data.dty || 'Regular',
        address1: [data.bno, data.bnm, data.st].filter(Boolean).join(', ') || data.address1 || data.addrBnm || '',
        address2: data.loc || data.address2 || '',
        place: data.loc || data.dst || data.place || '',
        pincode: String(data.pncd || data.pincode || ''),
        stateCode: parseInt(data.stcd || rawGstin.slice(0, 2), 10) || 0,
        raw: data,
      };
    } catch (err: any) {
      logger.error('TaxPro GSTIN Lookup Error:', err);
      if (company.taxproSandbox) {
        return {
          success: true,
          gstin: rawGstin,
          legalName: `Party (${rawGstin})`,
          tradeName: `Party (${rawGstin})`,
          status: 'ACT',
          taxpayerType: 'Regular',
          address1: 'Main Market Road',
          address2: '',
          place: 'City',
          pincode: '517247',
          stateCode: parseInt(rawGstin.slice(0, 2), 10) || 37,
          message: 'Sandbox fallback GSTIN lookup result',
        };
      }
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Retrieves official PIN-to-PIN distance from TaxPro / NIC Master API.
   * Eliminates distance deviation rejections when raising E-Way Bills.
   */
  public static async getOfficialDistance(fromPin: string | number, toPin: string | number): Promise<number | null> {
    const fPin = String(fromPin).replace(/\D/g, '');
    const tPin = String(toPin).replace(/\D/g, '');
    if (!/^[1-9][0-9]{5}$/.test(fPin) || !/^[1-9][0-9]{5}$/.test(tPin)) return null;

    const company = await getCompanyProfileRow();
    if (this.credsMissing(company)) return null;

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) => {
        const path = company.taxproSandbox
          ? `/ewaybillapi/dec/v1.03/Master?${this.ewbQueryString(company, company.gstin || '', 'GetDistance', { authtoken: token, fromPincode: fPin, toPincode: tPin })}`
          : `/v1.03/dec/Master?action=GetDistance&authtoken=${encodeURIComponent(token)}&fromPincode=${fPin}&toPincode=${tPin}`;
        return this.request(company.taxproSandbox, path, {
          method: 'GET',
          headers: this.baseHeaders(company, company.gstin || '', { authtoken: token, AuthToken: token }),
        });
      });

      const data = this.parseData(json?.Data ?? json?.data);
      const dist = Number(data?.distance ?? data?.Distance ?? data);
      if (Number.isFinite(dist) && dist > 0) {
        return Math.round(dist);
      }
      return null;
    } catch (err: any) {
      logger.warn(`TaxPro GetDistance failed (${fPin} -> ${tPin}): ${err.message}`);
      return null;
    }
  }

  /**
   * Universal EWB cancellation by number.
   */
  public static async cancelEwbNumber(ewbNo: string | number, cancelReason: string, cancelRemarks: string) {
    const company = await getCompanyProfileRow();
    const isMock = this.credsMissing(company);

    const payload = {
      ewbNo: Number(ewbNo),
      cancelRsnCode: Number(cancelReason || '1'),
      cancelRmrk: cancelRemarks || 'Cancelled from ERP system',
    };

    if (isMock) {
      return { success: true, cancelledDate: new Date(), message: 'Simulated E-Way Bill cancelled (mock mode)' };
    }

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) => {
        const ewbPath = company.taxproSandbox
          ? `/ewaybillapi/dec/v1.03/ewayapi?${this.ewbQueryString(company, company.gstin || '', 'CANEWB', { authtoken: token })}`
          : `/v1.03/dec/ewayapi?action=CANEWB&authtoken=${encodeURIComponent(token)}`;
        const headers = this.baseHeaders(company, company.gstin || '', { authtoken: token, AuthToken: token });

        return this.request(company.taxproSandbox, ewbPath, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });
      });

      const data = this.parseData(json?.Data ?? json?.data) || json || {};
      const cancelDate = data.CancelDate || data.cancelDate || data.cancel_date;
      return {
        success: true,
        cancelledDate: cancelDate ? this.parseNicDate(cancelDate) : new Date(),
        message: 'E-Way Bill cancelled successfully',
      };
    } catch (err: any) {
      logger.error('TaxPro CANEWB Error:', err);
      const msg = String(err?.message || '');
      if (/412|already.*cancel|multi.*vehicle/i.test(msg)) {
        return {
          success: true,
          cancelledDate: new Date(),
          message: 'E-Way Bill is already cancelled on the government portal (NIC 412)',
        };
      }
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Generates a Consolidated E-Way Bill (CEWB) on NIC to bundle multiple active EWBs on one vehicle.
   */
  public static async generateConsolidatedEwb(params: {
    vehicleNo: string;
    fromPlace: string;
    fromState: number;
    transMode?: string;
    transDocNo?: string;
    transDocDate?: string;
    ewbNumbers: (string | number)[];
    remarks?: string;
  }) {
    if (!params.vehicleNo) throw new Error('Vehicle number is required for Consolidated E-Way Bill');
    if (!params.ewbNumbers || params.ewbNumbers.length === 0) {
      throw new Error('At least one E-Way Bill number is required');
    }

    const company = await getCompanyProfileRow();
    const isMock = this.credsMissing(company);

    const vehNo = params.vehicleNo.toUpperCase().replace(/\s+/g, '');
    const payload = {
      vehicleNo: vehNo,
      fromPlace: params.fromPlace.slice(0, 50),
      fromState: Number(params.fromState),
      transMode: params.transMode || '1',
      transDocNo: params.transDocNo || undefined,
      transDocDate: params.transDocDate ? this.formatNICDate(new Date(params.transDocDate)) : undefined,
      tripshtDtls: params.ewbNumbers.map((no) => ({ ewbNo: Number(no) })),
    };

    if (isMock) {
      const cEwbNo = String(700000000000 + Math.floor(Math.random() * 200000000000));
      const record = await prisma.consolidatedEwb.create({
        data: {
          cEwbNumber: cEwbNo,
          cEwbDate: new Date(),
          vehicleNumber: vehNo,
          fromPlace: params.fromPlace,
          fromState: Number(params.fromState),
          transMode: params.transMode || '1',
          transDocNo: params.transDocNo,
          transDocDate: params.transDocDate ? new Date(params.transDocDate) : null,
          ewbNumbers: params.ewbNumbers.map(String),
          remarks: params.remarks,
        },
      });
      return {
        success: true,
        cEwbNumber: cEwbNo,
        cEwbDate: record.cEwbDate,
        record,
        message: 'Simulated Consolidated E-Way Bill generated (mock mode)',
      };
    }

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) => {
        const path = company.taxproSandbox
          ? `/ewaybillapi/dec/v1.03/ewayapi?${this.ewbQueryString(company, company.gstin || '', 'GENCEWB', { authtoken: token })}`
          : `/v1.03/dec/ewayapi?action=GENCEWB&authtoken=${encodeURIComponent(token)}`;
        return this.request(company.taxproSandbox, path, {
          method: 'POST',
          headers: this.baseHeaders(company, company.gstin || '', { authtoken: token, AuthToken: token }),
          body: JSON.stringify(payload),
        });
      });

      const data = this.parseData(json?.Data ?? json?.data) || json || {};
      const cEwbNo = String(data.cEwbNo || data.cEWBNo || data.CEwbNo);
      const cEwbDate = data.cEWBDate || data.cEwbDate ? this.parseNicDate(data.cEWBDate || data.cEwbDate) : new Date();

      const record = await prisma.consolidatedEwb.create({
        data: {
          cEwbNumber: cEwbNo,
          cEwbDate,
          vehicleNumber: vehNo,
          fromPlace: params.fromPlace,
          fromState: Number(params.fromState),
          transMode: params.transMode || '1',
          transDocNo: params.transDocNo,
          transDocDate: params.transDocDate ? new Date(params.transDocDate) : null,
          ewbNumbers: params.ewbNumbers.map(String),
          remarks: params.remarks,
        },
      });

      return {
        success: true,
        cEwbNumber: cEwbNo,
        cEwbDate,
        record,
        message: 'Consolidated E-Way Bill generated successfully',
      };
    } catch (err: any) {
      logger.error('TaxPro GENCEWB Error:', err);
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Generates a Standalone E-Way Bill for a Delivery Challan (Outward, subSupplyType e.g. Job Work / Transfer / Others).
   */
  public static async generateDeliveryChallanEwb(challanId: string, transportDetails: {
    transporterId?: string;
    transporterName?: string;
    transDistance?: number;
    transMode?: string;
    vehicleNumber?: string;
    vehicleType?: string;
    transDocNo?: string;
    transDocDt?: string;
  }) {
    const challan = await prisma.deliveryChallan.findUnique({ where: { id: challanId } });
    if (!challan) throw new Error('Delivery Challan not found');
    if (challan.status === 'CANCELLED') throw new Error('Cannot generate E-Way Bill for a cancelled challan');
    if (challan.ewbNumber && challan.ewbStatus !== 'CANCELLED') {
      throw new Error(`E-Way Bill ${challan.ewbNumber} already active on this challan`);
    }

    const company = await getCompanyProfileRow();
    const isMock = this.credsMissing(company);

    const vehNo = (transportDetails.vehicleNumber || challan.vehicleNumber || '').toUpperCase().replace(/\s+/g, '');
    const transMode = transportDetails.transMode || challan.transMode || '1';

    let subSupplyType = '8';
    let subSupplyDesc = 'Delivery Challan';
    if (challan.challanType === 'JOB_WORK' || challan.subType === 'JOB_WORK') {
      subSupplyType = '3';
      subSupplyDesc = 'Job Work Movement';
    } else if (challan.challanType === 'FOR_EXHIBITION' || challan.subType === 'FOR_EXHIBITION') {
      subSupplyType = '6';
      subSupplyDesc = 'For Exhibition';
    } else if (challan.challanType === 'SUPPLY_ON_APPROVAL') {
      subSupplyType = '8';
      subSupplyDesc = 'Supply on Approval';
    } else if (challan.challanType === 'GODOWN_TRANSFER') {
      subSupplyType = '8';
      subSupplyDesc = 'Godown Transfer';
    }

    const items = (Array.isArray(challan.items) ? challan.items : []) as any[];
    const itemList = items.map((item, index) => ({
      itemNo: index + 1,
      productName: String(item.productName || 'Goods').slice(0, 100),
      productDesc: String(item.productName || 'Goods').slice(0, 100),
      hsnCode: Number(String(item.hsnCode || '120799').slice(0, 8)),
      quantity: Number(item.quantity) || 1,
      qtyUnit: String(item.unit || 'KGS').toUpperCase(),
      taxableAmount: Number(item.taxableAmount) || 0,
      cgstRate: Number(item.gstRate ? Number(item.gstRate) / 2 : 0),
      sgstRate: Number(item.gstRate ? Number(item.gstRate) / 2 : 0),
      igstRate: Number(item.igstRate || 0),
      cessRate: 0,
    }));

    const distance = Number(transportDetails.transDistance || challan.distanceKm) || 0;

    const payload: Record<string, any> = {
      supplyType: 'O',
      subSupplyType,
      subSupplyDesc,
      docType: 'CHL',
      docNo: challan.challanNumber,
      docDate: this.formatNICDate(challan.challanDate),
      fromGstin: challan.fromGstin || company.gstin,
      fromTrdName: challan.fromName || company.name || 'RVP Industries',
      fromAddr1: challan.fromAddress.slice(0, 100),
      fromPlace: challan.fromPlace.slice(0, 50),
      fromPincode: Number(challan.fromPincode),
      actFromStateCode: Number(challan.fromStateCode),
      fromStateCode: Number(challan.fromStateCode),
      toGstin: challan.toGstin || 'URP',
      toTrdName: challan.toName.slice(0, 100),
      toAddr1: challan.toAddress.slice(0, 100),
      toPlace: challan.toPlace.slice(0, 50),
      toPincode: Number(challan.toPincode),
      actToStateCode: Number(challan.toStateCode),
      toStateCode: Number(challan.toStateCode),
      transactionType: 1,
      totalValue: Number(challan.totalValue),
      cgstValue: Number(challan.cgstAmount),
      sgstValue: Number(challan.sgstAmount),
      igstValue: Number(challan.igstAmount),
      cessValue: 0,
      totInvValue: Number(challan.totalValue),
      transDistance: distance,
      transMode,
      itemList,
    };

    if (transMode === '1' && vehNo) {
      payload.vehicleNo = vehNo;
      payload.vehicleType = transportDetails.vehicleType || challan.vehicleType || 'R';
    }
    if (transportDetails.transporterId) payload.transporterId = transportDetails.transporterId;
    if (transportDetails.transporterName) payload.transporterName = transportDetails.transporterName;
    if (transportDetails.transDocNo) payload.transDocNo = transportDetails.transDocNo;
    if (transportDetails.transDocDt) payload.transDocDate = this.formatNICDate(new Date(transportDetails.transDocDt));

    if (isMock) {
      const ewbNo = String(300000000000 + Math.floor(Math.random() * 600000000000));
      const validUpto = new Date();
      const days = Math.max(1, Math.ceil((distance || 100) / 200));
      validUpto.setDate(validUpto.getDate() + days);

      const updated = await prisma.deliveryChallan.update({
        where: { id: challanId },
        data: {
          ewbNumber: ewbNo,
          ewbDate: new Date(),
          ewbValidUpto: validUpto,
          ewbStatus: 'GENERATED',
          distanceKm: distance,
          vehicleNumber: vehNo || challan.vehicleNumber,
        },
      });

      return {
        success: true,
        ewbNumber: ewbNo,
        ewbDate: updated.ewbDate,
        ewbValidUpto: validUpto,
        distance,
        challan: updated,
        message: 'Simulated Delivery Challan E-Way Bill generated (mock mode)',
      };
    }

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) => {
        const path = company.taxproSandbox
          ? `/ewaybillapi/dec/v1.03/ewayapi?${this.ewbQueryString(company, company.gstin || '', 'GENEWAYBILL', { authtoken: token })}`
          : `/v1.03/dec/ewayapi?action=GENEWAYBILL&authtoken=${encodeURIComponent(token)}`;
        return this.request(company.taxproSandbox, path, {
          method: 'POST',
          headers: this.baseHeaders(company, company.gstin || '', { authtoken: token, AuthToken: token }),
          body: JSON.stringify(payload),
        });
      });

      const data = this.parseData(json?.Data ?? json?.data) || json || {};
      const ewbNo = String(data.ewayBillNo || data.EwbNo || data.ewbNo);
      const ewbDate = data.ewayBillDate || data.EwbDt ? this.parseNicDate(data.ewayBillDate || data.EwbDt) : new Date();
      const validUpto = data.validUpto ? this.parseNicDate(data.validUpto) : new Date(Date.now() + 86400000 * 2);

      const updated = await prisma.deliveryChallan.update({
        where: { id: challanId },
        data: {
          ewbNumber: ewbNo,
          ewbDate,
          ewbValidUpto: validUpto,
          ewbStatus: 'GENERATED',
          distanceKm: distance,
          vehicleNumber: vehNo || challan.vehicleNumber,
        },
      });

      return {
        success: true,
        ewbNumber: ewbNo,
        ewbDate,
        ewbValidUpto: validUpto,
        distance,
        challan: updated,
        message: 'Delivery Challan E-Way Bill generated successfully',
      };
    } catch (err: any) {
      logger.error('TaxPro Delivery Challan EWB Error:', err);
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Cancels E-Way Bill on a Delivery Challan.
   */
  public static async cancelDeliveryChallanEwb(challanId: string, cancelReason: string, cancelRemarks: string) {
    const challan = await prisma.deliveryChallan.findUnique({ where: { id: challanId } });
    if (!challan || !challan.ewbNumber) throw new Error('Delivery Challan or EWB not found');

    const result = await this.cancelEwbNumber(challan.ewbNumber, cancelReason, cancelRemarks);

    const updated = await prisma.deliveryChallan.update({
      where: { id: challanId },
      data: {
        ewbStatus: 'CANCELLED',
        ewbCancelledDate: result.cancelledDate,
      },
    });

    return {
      success: true,
      cancelledDate: result.cancelledDate,
      challan: updated,
      message: result.message,
    };
  }

  /**
   * Generates an Inward E-Way Bill for raw materials arriving from unregistered suppliers (URP).
   */
  public static async generateInwardPurchaseEwb(stockInId: string, transportDetails: {
    transporterId?: string;
    transporterName?: string;
    transDistance?: number;
    transMode?: string;
    vehicleNumber?: string;
    vehicleType?: string;
    transDocNo?: string;
    transDocDt?: string;
  }) {
    const stockIn = await prisma.stockIn.findUnique({
      where: { id: stockInId },
      include: {
        purchaseOrder: {
          include: { party: true },
        },
      },
    });
    if (!stockIn) throw new Error('Stock-in record not found');
    if (stockIn.ewbNumber && stockIn.ewbStatus !== 'CANCELLED') {
      throw new Error(`E-Way Bill ${stockIn.ewbNumber} already active on this stock-in`);
    }

    const company = await getCompanyProfileRow();
    const isMock = this.credsMissing(company);

    const party = stockIn.purchaseOrder.party;
    const vehNo = (transportDetails.vehicleNumber || stockIn.lorryNumber || '').toUpperCase().replace(/\s+/g, '');
    const transMode = transportDetails.transMode || '1';

    const dispatchFrom = this.dispatchFromDetails(company);
    const weightKg = stockIn.rvpKataKg || stockIn.billingWeightKg || 1000;
    const ratePerKg = Number(stockIn.billingRatePerKg || stockIn.purchaseOrder.pricePerKg) || 10;
    const taxableAmount = Math.round(weightKg * ratePerKg);

    const distance = Number(transportDetails.transDistance) || stockIn.ewbDistance || 100;

    const payload: Record<string, any> = {
      supplyType: 'I',
      subSupplyType: '8',
      subSupplyDesc: 'Inward purchase from unregistered supplier',
      docType: 'INV',
      docNo: stockIn.invoiceNumber || `SI-${stockIn.id.slice(-6)}`,
      docDate: this.formatNICDate(stockIn.arrivalDate),
      fromGstin: party.gstin || 'URP',
      fromTrdName: (party.name || 'Unregistered Farmer/Supplier').slice(0, 100),
      fromAddr1: (party.address || 'Agricultural Area').slice(0, 100),
      fromPlace: (party.city || 'Rural').slice(0, 50),
      fromPincode: Number(party.pincode) || 517247,
      actFromStateCode: 37,
      fromStateCode: 37,
      toGstin: company.gstin,
      toTrdName: company.name || 'RVP Industries',
      toAddr1: dispatchFrom.addr1,
      toPlace: dispatchFrom.place,
      toPincode: dispatchFrom.pincode,
      actToStateCode: 37,
      toStateCode: 37,
      transactionType: 1,
      totalValue: taxableAmount,
      cgstValue: 0,
      sgstValue: 0,
      igstValue: 0,
      cessValue: 0,
      totInvValue: taxableAmount,
      transDistance: distance,
      transMode,
      itemList: [
        {
          itemNo: 1,
          productName: 'TAMARIND SEED (RAW MATERIAL)',
          productDesc: 'TAMARIND SEED (RAW MATERIAL)',
          hsnCode: 120799,
          quantity: weightKg,
          qtyUnit: 'KGS',
          taxableAmount,
          cgstRate: 0,
          sgstRate: 0,
          igstRate: 0,
          cessRate: 0,
        },
      ],
    };

    if (transMode === '1' && vehNo) {
      payload.vehicleNo = vehNo;
      payload.vehicleType = transportDetails.vehicleType || 'R';
    }
    if (transportDetails.transporterId) payload.transporterId = transportDetails.transporterId;
    if (transportDetails.transporterName) payload.transporterName = transportDetails.transporterName;
    if (transportDetails.transDocNo) payload.transDocNo = transportDetails.transDocNo;
    if (transportDetails.transDocDt) payload.transDocDate = this.formatNICDate(new Date(transportDetails.transDocDt));

    if (isMock) {
      const ewbNo = String(400000000000 + Math.floor(Math.random() * 500000000000));
      const validUpto = new Date();
      const days = Math.max(1, Math.ceil(distance / 200));
      validUpto.setDate(validUpto.getDate() + days);

      const updated = await prisma.stockIn.update({
        where: { id: stockInId },
        data: {
          ewbNumber: ewbNo,
          ewbDate: new Date(),
          ewbValidUpto: validUpto,
          ewbStatus: 'GENERATED',
          ewbDistance: distance,
          ewbTransMode: transMode,
          ewbVehicleType: transportDetails.vehicleType || 'R',
          ewbTransDocNo: transportDetails.transDocNo,
          ewbTransDocDate: transportDetails.transDocDt ? new Date(transportDetails.transDocDt) : null,
        },
      });

      return {
        success: true,
        ewbNumber: ewbNo,
        ewbDate: updated.ewbDate,
        ewbValidUpto: validUpto,
        distance,
        stockIn: updated,
        message: 'Simulated Inward Purchase E-Way Bill generated (mock mode)',
      };
    }

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) => {
        const path = company.taxproSandbox
          ? `/ewaybillapi/dec/v1.03/ewayapi?${this.ewbQueryString(company, company.gstin || '', 'GENEWAYBILL', { authtoken: token })}`
          : `/v1.03/dec/ewayapi?action=GENEWAYBILL&authtoken=${encodeURIComponent(token)}`;
        return this.request(company.taxproSandbox, path, {
          method: 'POST',
          headers: this.baseHeaders(company, company.gstin || '', { authtoken: token, AuthToken: token }),
          body: JSON.stringify(payload),
        });
      });

      const data = this.parseData(json?.Data ?? json?.data) || json || {};
      const ewbNo = String(data.ewayBillNo || data.EwbNo || data.ewbNo);
      const ewbDate = data.ewayBillDate || data.EwbDt ? this.parseNicDate(data.ewayBillDate || data.EwbDt) : new Date();
      const validUpto = data.validUpto ? this.parseNicDate(data.validUpto) : new Date(Date.now() + 86400000 * 2);

      const updated = await prisma.stockIn.update({
        where: { id: stockInId },
        data: {
          ewbNumber: ewbNo,
          ewbDate,
          ewbValidUpto: validUpto,
          ewbStatus: 'GENERATED',
          ewbDistance: distance,
          ewbTransMode: transMode,
          ewbVehicleType: transportDetails.vehicleType || 'R',
          ewbTransDocNo: transportDetails.transDocNo,
          ewbTransDocDate: transportDetails.transDocDt ? new Date(transportDetails.transDocDt) : null,
        },
      });

      return {
        success: true,
        ewbNumber: ewbNo,
        ewbDate,
        ewbValidUpto: validUpto,
        distance,
        stockIn: updated,
        message: 'Inward Purchase E-Way Bill generated successfully',
      };
    } catch (err: any) {
      logger.error('TaxPro Inward Purchase EWB Error:', err);
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Cancels Inward E-Way Bill on a StockIn record.
   */
  public static async cancelStockInEwb(stockInId: string, cancelReason: string, cancelRemarks: string) {
    const stockIn = await prisma.stockIn.findUnique({ where: { id: stockInId } });
    if (!stockIn || !stockIn.ewbNumber) throw new Error('Stock-in record or EWB not found');

    const result = await this.cancelEwbNumber(stockIn.ewbNumber, cancelReason, cancelRemarks);

    const updated = await prisma.stockIn.update({
      where: { id: stockInId },
      data: {
        ewbStatus: 'CANCELLED',
        ewbCancelledDate: result.cancelledDate,
      },
    });

    return {
      success: true,
      cancelledDate: result.cancelledDate,
      stockIn: updated,
      message: result.message,
    };
  }

  /**
   * Fetches official GSTR-2B statement from TaxPro GSP Returns API.
   * If mock mode / sandbox mode or credentials missing, returns realistic simulated GSTR-2B data
   * (zero production credits consumed).
   */
  public static async fetchGstr2b(returnPeriod: string) {
    const period = returnPeriod.replace(/[^0-9]/g, ''); // e.g. "082026"
    if (period.length !== 6) {
      throw new Error('Invalid return period. Expected MMYYYY format (e.g. 082026 for August 2026)');
    }

    const company = await getCompanyProfileRow();
    const isMock = this.credsMissing(company);

    if (isMock) {
      const suppliers = await prisma.party.findMany({
        where: { type: 'SUPPLIER', gstin: { not: null } },
        take: 10,
        select: { gstin: true, name: true },
      });

      const month = parseInt(period.slice(0, 2), 10);
      const year = parseInt(period.slice(2), 10);
      const simulatedB2b = suppliers.map((s, idx) => {
        const invNo = `INV/${year}/${100 + idx}`;
        const txval = 50000 + idx * 25000;
        const igst = Math.round(txval * 0.05);
        return {
          ctin: s.gstin!,
          trdnm: s.name,
          inv: [
            {
              inum: invNo,
              idt: `${String(10 + idx).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}`,
              val: txval + igst,
              pos: '37',
              rev: 'N',
              itcavl: 'Y',
              items: [
                {
                  num: 1,
                  txval,
                  rt: 5.0,
                  igst,
                  cgst: 0,
                  sgst: 0,
                  cess: 0,
                },
              ],
            },
          ],
        };
      });

      return {
        success: true,
        period,
        data: {
          gstin: company.gstin || '37AABCR1234F1Z5',
          fp: period,
          docdata: {
            b2b: simulatedB2b,
            b2ba: [],
            cdnr: [],
            cdnra: [],
          },
        },
        message: 'Simulated GSTR-2B return data (mock/sandbox mode - 0 credits consumed)',
      };
    }

    try {
      const json = await this.withAuth(company, company.gstin || '', (token) => {
        const path = company.taxproSandbox
          ? `/gstapi/dec/v1.0/returns/gstr2b?${this.ewbQueryString(company, company.gstin || '', 'GSTR2B', { authtoken: token, return_period: period })}`
          : `/v1.0/dec/returns/gstr2b?action=GSTR2B&authtoken=${encodeURIComponent(token)}&return_period=${encodeURIComponent(period)}`;
        return this.request(company.taxproSandbox, path, {
          method: 'GET',
          headers: this.baseHeaders(company, company.gstin || '', { authtoken: token, AuthToken: token }),
        });
      });

      const data = this.parseData(json?.Data ?? json?.data) || json;
      return {
        success: true,
        period,
        data,
      };
    } catch (err: any) {
      logger.error('TaxPro GSTR2B Error:', err);
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }
}


