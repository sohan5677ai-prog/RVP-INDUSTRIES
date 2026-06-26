import { prisma } from '../lib/prisma.js';
import { getCompanyProfileRow } from '../controllers/settings.controller.js';

interface TaxproConfig {
  taxproGspId?: string | null;
  taxproGspSecret?: string | null;
  taxproGstUser?: string | null;
  taxproGstPass?: string | null;
  taxproSandbox: boolean;
}

export class TaxproService {
  /**
   * Helper to format Date into DD/MM/YYYY format required by NIC.
   */
  private static formatNICDate(date: Date): string {
    const d = new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  }

  /**
   * Formats a dispatch into the standard NIC E-Invoice JSON payload.
   */
  public static async prepareEInvoicePayload(dispatchId: string) {
    const dispatch = await prisma.saleDispatch.findUnique({
      where: { id: dispatchId },
      include: {
        saleOrder: {
          include: {
            buyer: true,
          },
        },
      },
    });

    if (!dispatch) throw new Error('Dispatch not found');
    const order = dispatch.saleOrder;
    const buyer = order.buyer;
    const company = await getCompanyProfileRow();

    // Fetch HSN and Description from settings for this product
    const taxInfo = await prisma.productTaxInfo.findUnique({
      where: { product: order.product },
    });

    const description = taxInfo?.description || `${order.product} Sale`;
    const hsn = taxInfo?.hsn || '1207'; // fallback HSN

    if (!company.gstin) throw new Error('Company GSTIN is not set in Settings');
    if (!buyer.gstin) throw new Error('Buyer GSTIN is not set in Buyer profile');

    const weight = dispatch.weightKg;
    const rate = Number(order.ratePerKg);
    const baseAmount = Math.round(weight * rate * 100) / 100;
    const gstAmount = Number(dispatch.gstAmount);
    const totalAmount = Math.round((baseAmount + gstAmount) * 100) / 100;

    // Standard state codes derived from GSTIN (first 2 digits)
    const sellerStateCode = company.gstin.slice(0, 2);
    const buyerStateCode = buyer.gstin.slice(0, 2);

    // If buyer is in the same state, it is CGST+SGST, otherwise IGST.
    // However, our calc.ts and current schema.prisma default to IGST (5% IGST).
    // Let's match whatever is calculated in the ERP: inter-state/intra-state.
    const isSameState = sellerStateCode === buyerStateCode;
    const gstRate = 5; // 5% GST

    const cgstAmt = isSameState ? Math.round((gstAmount / 2) * 100) / 100 : 0;
    const sgstAmt = isSameState ? Math.round((gstAmount / 2) * 100) / 100 : 0;
    const igstAmt = isSameState ? 0 : gstAmount;

    const payload = {
      Version: "1.1",
      TranDtls: {
        TaxSch: "GST",
        SupTyp: "B2B",
        RegRev: "N",
        IgstOnIntra: "N"
      },
      DocDtls: {
        Typ: "INV",
        No: dispatch.invoiceNumber || `DISP-${dispatch.id.slice(-6)}`,
        Dt: this.formatNICDate(dispatch.invoiceDate || new Date())
      },
      SellerDtls: {
        Gstin: company.gstin,
        LglNm: company.name,
        Addr1: company.address || "Factory premises",
        Loc: company.stateName || "State",
        Pin: 370001, // Example PIN, should ideally match
        Stcd: sellerStateCode
      },
      BuyerDtls: {
        Gstin: buyer.gstin,
        LglNm: buyer.name,
        Pos: buyerStateCode,
        Addr1: buyer.address || "Buyer address",
        Loc: buyer.state || "State",
        Pin: 390001, // Example PIN
        Stcd: buyerStateCode
      },
      ItemDtls: [
        {
          SlNo: "1",
          PrdDesc: description,
          IsServc: "N",
          HsnCd: hsn,
          Qty: weight,
          Unit: "KGS",
          UnitPrice: rate,
          TotAmt: baseAmount,
          Discount: 0,
          PreTaxVal: baseAmount,
          AssAmt: baseAmount,
          GstRt: gstRate,
          CgstAmt: cgstAmt,
          SgstAmt: sgstAmt,
          IgstAmt: igstAmt,
          TotItemVal: totalAmount
        }
      ],
      ValDtls: {
        AssVal: baseAmount,
        CgstVal: cgstAmt,
        SgstVal: sgstAmt,
        IgstVal: igstAmt,
        TotInvVal: totalAmount
      }
    };

    return payload;
  }

  /**
   * Authenticates and generates an E-Invoice (IRN) via TaxPro GSP.
   * If sandbox is active or credentials are empty, returns simulated values.
   */
  public static async generateIRN(dispatchId: string) {
    const company = await getCompanyProfileRow();
    const isMock = company.taxproSandbox || !company.taxproGspId || !company.taxproGspSecret;

    const payload = await this.prepareEInvoicePayload(dispatchId);

    if (isMock) {
      // Return simulated success response
      const irn = Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      const ackNo = String(100000000000 + Math.floor(Math.random() * 900000000000));
      const ackDate = new Date();
      // Embed essential IRN data in QR Code text
      const qrData = `IRN:${irn}|GSTIN:${payload.SellerDtls.Gstin}|InvNo:${payload.DocDtls.No}|Amt:${payload.ValDtls.TotInvVal}|Date:${payload.DocDtls.Dt}`;

      return {
        success: true,
        irn,
        ackNo,
        ackDate,
        signedQr: qrData,
        message: 'Simulated IRN generated successfully (SANDBOX MODE)',
      };
    }

    try {
      const token = await this.getAuthToken(company);
      const url = `${company.taxproSandbox ? 'http://gstsandbox.charteredinfo.com' : 'https://einvapi.charteredinfo.com'}/api/v1.03/irn/generate`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'gstin': company.gstin || '',
        },
        body: JSON.stringify(payload),
      });

      const resJson = await response.json() as any;

      if (!response.ok || resJson.status === 'ERROR') {
        throw new Error(resJson.error?.error_desc || resJson.message || 'Error generating IRN via TaxPro GSP');
      }

      return {
        success: true,
        irn: resJson.data.Irn,
        ackNo: String(resJson.data.AckNo),
        ackDate: new Date(resJson.data.AckDt),
        signedQr: resJson.data.SignedQrCode,
        message: 'IRN generated successfully',
      };
    } catch (err: any) {
      console.error('TaxPro IRN Generation Error:', err);
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Cancels an already generated E-Invoice (IRN)
   */
  public static async cancelIRN(dispatchId: string, cancelReason: string, cancelRemarks: string) {
    const dispatch = await prisma.saleDispatch.findUnique({
      where: { id: dispatchId },
    });
    if (!dispatch || !dispatch.irn) throw new Error('IRN not found on dispatch');

    const company = await getCompanyProfileRow();
    const isMock = company.taxproSandbox || !company.taxproGspId || !company.taxproGspSecret;

    const payload = {
      Irn: dispatch.irn,
      CnlRsn: cancelReason || "1", // 1-Duplicate, 2-Data Entry Mistake, 3-Order Cancelled, 4-Others
      CnlRem: cancelRemarks || "Cancelled from ERP system"
    };

    if (isMock) {
      return {
        success: true,
        cancelledDate: new Date(),
        message: 'Simulated IRN cancelled successfully (SANDBOX MODE)',
      };
    }

    try {
      const token = await this.getAuthToken(company);
      const url = `${company.taxproSandbox ? 'http://gstsandbox.charteredinfo.com' : 'https://einvapi.charteredinfo.com'}/api/v1.03/irn/cancel`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'gstin': company.gstin || '',
        },
        body: JSON.stringify(payload),
      });

      const resJson = await response.json() as any;

      if (!response.ok || resJson.status === 'ERROR') {
        throw new Error(resJson.error?.error_desc || resJson.message || 'Error cancelling IRN via TaxPro GSP');
      }

      return {
        success: true,
        cancelledDate: new Date(resJson.data.CancelDate),
        message: 'IRN cancelled successfully',
      };
    } catch (err: any) {
      console.error('TaxPro IRN Cancellation Error:', err);
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Generates E-Way Bill for a dispatch (based on active IRN)
   */
  public static async generateEWayBill(dispatchId: string, transportDetails: {
    transporterId?: string;
    transporterName?: string;
    transDistance: number;
    transMode: string; // '1' - Road, '2' - Rail, '3' - Air, '4' - Ship
    vehicleNumber: string;
    vehicleType: string; // 'R' - Regular, 'O' - Over Dimensional Cargo
  }) {
    const dispatch = await prisma.saleDispatch.findUnique({
      where: { id: dispatchId },
    });
    if (!dispatch || !dispatch.irn) throw new Error('E-Invoice IRN must be generated before E-Way Bill');

    const company = await getCompanyProfileRow();
    const isMock = company.taxproSandbox || !company.taxproGspId || !company.taxproGspSecret;

    const payload = {
      Irn: dispatch.irn,
      TransId: transportDetails.transporterId || "",
      TransName: transportDetails.transporterName || "",
      TransDocNo: "",
      TransDocDt: "",
      TransMode: transportDetails.transMode || "1",
      Distance: Number(transportDetails.transDistance),
      VehNo: transportDetails.vehicleNumber || dispatch.vehicleNumber || "",
      VehType: transportDetails.vehicleType || "R"
    };

    if (isMock) {
      const ewbNo = String(200000000000 + Math.floor(Math.random() * 800000000000));
      const ewbDate = new Date();
      const validUpto = new Date();
      // Add validity based on distance: ~1 day per 100km
      const daysValid = Math.max(1, Math.ceil(transportDetails.transDistance / 100));
      validUpto.setDate(validUpto.getDate() + daysValid);

      return {
        success: true,
        ewbNumber: ewbNo,
        ewbDate,
        ewbValidUpto: validUpto,
        message: 'Simulated E-Way Bill generated successfully (SANDBOX MODE)',
      };
    }

    try {
      const token = await this.getAuthToken(company);
      const url = `${company.taxproSandbox ? 'http://gstsandbox.charteredinfo.com' : 'https://einvapi.charteredinfo.com'}/api/v1.03/ewaybill/generate`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'gstin': company.gstin || '',
        },
        body: JSON.stringify(payload),
      });

      const resJson = await response.json() as any;

      if (!response.ok || resJson.status === 'ERROR') {
        throw new Error(resJson.error?.error_desc || resJson.message || 'Error generating E-Way Bill via TaxPro GSP');
      }

      return {
        success: true,
        ewbNumber: String(resJson.data.EwbNo),
        ewbDate: new Date(resJson.data.EwbDt),
        ewbValidUpto: new Date(resJson.data.EwbValidTill),
        message: 'E-Way Bill generated successfully',
      };
    } catch (err: any) {
      console.error('TaxPro EWB Generation Error:', err);
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Cancels E-Way Bill
   */
  public static async cancelEWayBill(dispatchId: string, cancelReason: string, cancelRemarks: string) {
    const dispatch = await prisma.saleDispatch.findUnique({
      where: { id: dispatchId },
    });
    if (!dispatch || !dispatch.ewbNumber) throw new Error('E-Way Bill number not found on dispatch');

    const company = await getCompanyProfileRow();
    const isMock = company.taxproSandbox || !company.taxproGspId || !company.taxproGspSecret;

    const payload = {
      ewbNo: Number(dispatch.ewbNumber),
      cancelRsnCode: Number(cancelReason || "1"), // 1-Duplicate, 2-Order Cancelled, 3-Mistake, 4-Other
      cancelRemarks: cancelRemarks || "Cancelled from ERP system"
    };

    if (isMock) {
      return {
        success: true,
        cancelledDate: new Date(),
        message: 'Simulated E-Way Bill cancelled successfully (SANDBOX MODE)',
      };
    }

    try {
      const token = await this.getAuthToken(company);
      const url = `${company.taxproSandbox ? 'http://gstsandbox.charteredinfo.com' : 'https://einvapi.charteredinfo.com'}/api/v1.03/ewaybill/cancel`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'gstin': company.gstin || '',
        },
        body: JSON.stringify(payload),
      });

      const resJson = await response.json() as any;

      if (!response.ok || resJson.status === 'ERROR') {
        throw new Error(resJson.error?.error_desc || resJson.message || 'Error cancelling E-Way Bill via TaxPro GSP');
      }

      return {
        success: true,
        cancelledDate: new Date(resJson.data.CancelDate),
        message: 'E-Way Bill cancelled successfully',
      };
    } catch (err: any) {
      console.error('TaxPro EWB Cancellation Error:', err);
      throw new Error(`TaxPro GSP Error: ${err.message}`);
    }
  }

  /**
   * Generates GSP Authentication Token (usually valid for 6 hours)
   */
  private static async getAuthToken(company: TaxproConfig): Promise<string> {
    const url = `${company.taxproSandbox ? 'http://gstsandbox.charteredinfo.com' : 'https://einvapi.charteredinfo.com'}/api/v1.03/auth`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'client_id': company.taxproGspId || '',
        'client_secret': company.taxproGspSecret || '',
      },
      body: JSON.stringify({
        UserName: company.taxproGstUser || '',
        Password: company.taxproGstPass || '', // Note: In high production, password might be encrypted
      }),
    });

    const resJson = await response.json() as any;

    if (!response.ok || resJson.status === 'ERROR') {
      throw new Error(resJson.error?.error_desc || resJson.message || 'Authentication with TaxPro GSP failed');
    }

    return resJson.data.AuthToken;
  }
}
