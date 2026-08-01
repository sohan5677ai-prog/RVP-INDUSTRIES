import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getCompanyProfileRow } from '../controllers/settings.controller.js';
import { istParts } from '../lib/istDate.js';

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
    'https://einvapidel2.charteredinfo.com',
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
      password: config.taxproGspSecret || '', // GSP layer validates this as the ASP password
      Gstin: gstin,
      User_Name: config.taxproGstUser || '',
      eInvPwd: config.taxproGstPass || '',
      ...extra,
    } as Record<string, string>;
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
            if (String(json.error.error_cd) === '1017' || msg.includes('1017')) {
              msg = `1017: Incorrect user id/User does not exists. Please verify: 1) Is your NIC E-Invoice API User created under GSP "TaxPro / Chartered Information Systems" on the NIC E-Invoice Portal? 2) Is "Sandbox Mode" correctly toggled in Settings?`;
            }
            const err: any = new Error(msg);
            err.isBusinessError = true;
            throw err;
          }

          // NIC business error shape: { Status:'0', ErrorDetails:[{ErrorCode,ErrorMessage}] }
          const status = String(json?.Status ?? json?.status ?? '');
          if (status === '0' && Array.isArray(json?.ErrorDetails) && json.ErrorDetails.length) {
            let msg = json.ErrorDetails
              .map((e: any) => `${e.ErrorCode}: ${e.ErrorMessage}`)
              .join('; ');
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
            err.isBusinessError = true;
            err.errorDetails = json.ErrorDetails;
            throw err;
          }

          if (!res.ok) throw new Error(`HTTP Error ${res.status}`);

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
   * GET AuthToken (decrypted variant uses GET). Valid ~6h; ClientId is injected
   * by TaxPro. We fetch a fresh token per operation (simple + safe).
   */
  private static async getAuthToken(config: TaxproConfig, gstin: string): Promise<string> {
    const json = await this.request(config.taxproSandbox, '/eivital/dec/v1.04/auth', {
      method: 'GET',
      headers: this.baseHeaders(config, gstin),
    });
    const token = json?.Data?.AuthToken || json?.AuthToken;
    if (!token) throw new Error('TaxPro auth succeeded but returned no AuthToken');
    return token;
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
      include: { saleOrder: { include: { buyer: true } } },
    });

    if (!dispatch) throw new Error('Dispatch not found');
    const order = dispatch.saleOrder;
    const buyer = order.buyer;
    const company = await getCompanyProfileRow();

    const taxInfo = await prisma.productTaxInfo.findUnique({ where: { product: order.product } });
    const description = taxInfo?.description || `${order.product} Sale`;
    const hsn = taxInfo?.hsn || '120799'; // must be 6+ digits for AATO >= 5 Cr

    if (!company.gstin) throw new Error('Company GSTIN is not set in Settings');
    if (!buyer.gstin) throw new Error('Buyer GSTIN is not set in Buyer profile');

    const dispatchFrom = this.dispatchFromDetails(company as any);
    const shipTo = this.shipToDetails(buyer as any);

    const weight = dispatch.weightKg;
    const rate = Number(order.ratePerKg);
    const baseAmount = Math.round(weight * rate * 100) / 100;

    const sellerStateCode = company.gstin.slice(0, 2);
    const buyerStateCode = buyer.gstin.slice(0, 2);
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
        LglNm: company.name,
        Addr1: dispatchFrom.addr1 || 'Factory premises',
        ...(dispatchFrom.addr2 ? { Addr2: dispatchFrom.addr2 } : {}),
        Loc: dispatchFrom.place,
        Pin: dispatchFrom.pincode,
        Stcd: sellerStateCode,
      },
      BuyerDtls: {
        Gstin: buyer.gstin,
        LglNm: buyer.name,
        Pos: buyerStateCode,
        Addr1: buyer.address || 'Buyer address',
        Loc: shipTo.place,
        Pin: shipTo.pincode,
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
      const token = await this.getAuthToken(company, company.gstin || '');
      const json = await this.request(company.taxproSandbox, '/eicore/dec/v1.03/Invoice?QrCodeSize=250', {
        method: 'POST',
        headers: this.baseHeaders(company, company.gstin || '', { AuthToken: token }),
        body: JSON.stringify(payload),
      });

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
      const token = await this.getAuthToken(company, company.gstin || '');
      const json = await this.request(company.taxproSandbox, '/eicore/dec/v1.03/Invoice/Cancel', {
        method: 'POST',
        headers: this.baseHeaders(company, company.gstin || '', { AuthToken: token }),
        body: JSON.stringify(payload),
      });
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
      const token = await this.getAuthToken(company, company.gstin || '');
      const json = await this.request(company.taxproSandbox, '/eiewb/dec/v1.03/ewaybill', {
        method: 'POST',
        headers: this.baseHeaders(company, company.gstin || '', { AuthToken: token }),
        body: JSON.stringify(payload),
      });
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
    const hsn = taxInfo?.hsn || '120799';

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
      fromTrdName: company.name,
      fromAddr1: dispatchFrom.addr1,
      fromAddr2: dispatchFrom.addr2,
      fromPlace: dispatchFrom.place,
      fromPincode: dispatchFrom.pincode,
      fromStateCode: Number(sellerStateCode) || 0,
      toGstin: buyer.gstin || 'URP',
      toTrdName: buyer.name,
      toAddr1: buyer.address || '',
      toAddr2: '',
      toPlace: shipTo.place,
      toPincode: shipTo.pincode,
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
    const url = `${this.PRODUCTION_BASE_URLS[0]}/aspapi/v1.0/${endpoint}?${qs}`;

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
      const token = await this.getAuthToken(company, company.gstin || '');
      const json = await this.request(company.taxproSandbox, '/ewaybillapi/dec/v1.03/ewayapi?action=CANEWB', {
        method: 'POST',
        headers: this.baseHeaders(company, company.gstin || '', { AuthToken: token }),
        body: JSON.stringify(payload),
      });
      const data = this.parseData(json.Data) || {};
      return {
        success: true,
        cancelledDate: data.CancelDate ? new Date(data.CancelDate) : new Date(),
        message: 'E-Way Bill cancelled successfully',
      };
    } catch (err: any) {
      logger.error('TaxPro EWB Cancellation Error:', err);
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }
}
