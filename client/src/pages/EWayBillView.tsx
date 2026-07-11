import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer, FileText } from 'lucide-react';
import { api } from '@/lib/api';
import type { SaleDispatch, CompanyProfile, ProductTaxInfo } from '@/lib/types';
import { Button } from '@/components/ui/button';

function fmtDate(d: Date | string): string {
  const date = new Date(d);
  return date.toLocaleString('en-GB', { 
    day: 'numeric', month: 'short', year: 'numeric', 
    hour: '2-digit', minute: '2-digit' 
  });
}

function fmtDateOnly(d: Date | string): string {
  const date = new Date(d);
  return date.toLocaleDateString('en-GB', { 
    day: 'numeric', month: 'short', year: 'numeric'
  });
}

const PRODUCT_FALLBACK: Record<string, string> = {
  PAPPU: 'Tamarind Seed Kernel', HUSK: 'Tamarind Husk', WASTE: 'Tamarind Waste', TPS: 'Tamarind Seed Brokens', SHELL: 'Tamarind Shell',
};

export default function EWayBillView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: dispatch, isLoading } = useQuery({ 
    queryKey: ['sale-dispatch', id], 
    queryFn: () => api<SaleDispatch>(`/sale-dispatches/${id}`), 
    enabled: !!id 
  });
  
  const order = dispatch?.saleOrder;
  const buyer = order?.buyer;
  
  const { data: company } = useQuery({ 
    queryKey: ['company'], 
    queryFn: () => api<CompanyProfile>('/settings/company') 
  });
  
  const { data: taxRows } = useQuery({ 
    queryKey: ['product-tax'], 
    queryFn: () => api<ProductTaxInfo[]>('/settings/product-tax') 
  });

  if (isLoading || !dispatch || !company || !order || !buyer) {
    return <div className="p-8 text-center text-muted-foreground animate-pulse">Loading E-Way Bill Data...</div>;
  }

  if (!dispatch.ewbNumber) {
    return (
      <div className="p-8 text-center">
        <h2 className="text-xl font-bold text-rose-600 mb-2">E-Way Bill Not Generated</h2>
        <p className="text-muted-foreground mb-4">Please generate the E-Way Bill first before printing.</p>
        <Button onClick={() => navigate(-1)}><ArrowLeft className="mr-2 h-4 w-4" /> Go Back</Button>
      </div>
    );
  }

  const taxInfo = taxRows?.find(t => t.product === order.product);
  const description = taxInfo?.description || PRODUCT_FALLBACK[order.product] || `${order.product} Sale`;
  const hsn = taxInfo?.hsn || '1207';
  
  const weight = dispatch.weightKg;
  const rate = Number(order.ratePerKg);
  const baseAmount = Math.round(weight * rate * 100) / 100;
  // GST from the commodity's configured rate (default 5%), not the stored value
  // which can be 0 on legacy dispatches — mirrors the tax invoice / e-invoice.
  const gstPct = taxInfo?.gstRate != null ? Number(taxInfo.gstRate) : 5;
  const gstAmount = Math.round(baseAmount * gstPct) / 100;
  const totalAmount = Math.round((baseAmount + gstAmount) * 100) / 100;

  const sellerStateCode = company.gstin?.slice(0, 2) || '';
  const buyerStateCode = buyer.gstin?.slice(0, 2) || '';
  const isSameState = sellerStateCode === buyerStateCode && sellerStateCode !== '';

  const cgstAmt = isSameState ? gstAmount / 2 : 0;
  const sgstAmt = isSameState ? gstAmount / 2 : 0;
  const igstAmt = isSameState ? 0 : gstAmount;

  // Per-component tax-rate string, e.g. intra "2.50+2.50+0.00+..." / inter "0.00+0.00+5.00+..."
  const half = (gstPct / 2).toFixed(2);
  const full = gstPct.toFixed(2);
  const taxRateStr = isSameState
    ? `${half}+${half}+0.00+0.000+0.00`
    : `0.00+0.00+${full}+0.000+0.00`;

  return (
    <div className="min-h-screen bg-neutral-100 flex flex-col font-sans">
      <style dangerouslySetInnerHTML={{__html: `
        @media print {
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; background-color: white !important; }
          .inv-no-print { display: none !important; }
          .inv-print-area { margin: 0; padding: 0; box-shadow: none !important; width: 100% !important; max-width: none !important; border: none !important; }
          @page { size: A4 portrait; margin: 10mm; }
        }
      `}} />

      {/* Toolbar (not printed) */}
      <div className="inv-no-print sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b bg-background px-4 py-2 shadow-sm">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => navigate(-1)}><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
          <span className="text-sm font-medium text-muted-foreground ml-2 flex items-center gap-1">
            <FileText className="h-4 w-4" /> E-Way Bill Viewer
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => window.print()} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            <Printer className="h-4 w-4 mr-1" /> Print E-Way Bill
          </Button>
        </div>
      </div>

      <div className="flex justify-center py-8 inv-print-area bg-neutral-100">
        <div className="bg-white border shadow-sm inv-print-area w-[210mm] min-h-[297mm] p-[10mm] text-[12px] leading-snug text-black relative font-sans">
          <div className="flex justify-between items-start mb-2">
            <h1 className="text-xl font-bold font-sans">e-Way Bill</h1>
            <div className="w-[100px] h-[100px] flex items-center justify-center">
              {dispatch.ewbNumber && (
                <img src={`https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${dispatch.ewbNumber}`} alt="QR Code" className="w-full h-full object-contain mix-blend-multiply opacity-90" />
              )}
            </div>
          </div>

          <div className="border border-gray-400 mb-1">
            <div className="bg-[#7a7aba] text-white font-bold px-2 py-1 text-xs">1. E-WAY BILL Details</div>
            <div className="p-1">
              <table className="w-full text-[11px]">
                <tbody>
                  <tr>
                    <td className="w-1/3 py-1">eWay Bill No: <b className="text-[12px]">{dispatch.ewbNumber}</b></td>
                    <td className="w-1/3 py-1">Generated Date: <b>{dispatch.ewbDate ? fmtDate(dispatch.ewbDate) : '-'}</b></td>
                    <td className="w-1/3 py-1 text-right">Generated By: <b>{company.gstin}</b><br/>Valid Upto: <b>{dispatch.ewbValidUpto ? fmtDate(dispatch.ewbValidUpto) : '-'}</b></td>
                  </tr>
                  <tr>
                    <td colSpan={2} className="py-1">Mode: <b>Road</b><span className="ml-12">Approx Distance: <b>{dispatch.ewbDistance ? `${dispatch.ewbDistance} KM` : 'Auto-Calculated'}</b></span></td>
                    <td className="py-1"></td>
                  </tr>
                  <tr>
                    <td className="py-1">Type: <b>Outward - Supply</b></td>
                    <td className="py-1">Document Details: <b>Tax Invoice - {dispatch.invoiceNumber || `DISP-${dispatch.id.slice(-6)}`} - {dispatch.invoiceDate ? fmtDateOnly(dispatch.invoiceDate) : ''}</b></td>
                    <td className="py-1 text-right">Transaction type: <b>Regular</b><span className="ml-8">Portal: <b>1</b></span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="border border-gray-400 mb-1">
            <div className="bg-[#7a7aba] text-white font-bold px-2 py-1 text-xs">2. Address Details</div>
            <div className="flex text-[11px]">
              <div className="w-1/2 border-r border-gray-400">
                <div className="bg-[#a8a8cf] font-bold px-2 py-0.5 border-b border-gray-400">From</div>
                <div className="p-2 h-32 leading-relaxed">
                  <div>GSTIN : {company.gstin}</div>
                  <div>{company.name}</div>
                  <div>{company.stateName}</div>
                  <div className="mt-3 text-gray-500">:: Dispatch From ::</div>
                  <div>{company.address}</div>
                  <div>{company.pincode ? `${company.pincode}` : ''}</div>
                </div>
              </div>
              <div className="w-1/2">
                <div className="bg-[#a8a8cf] font-bold px-2 py-0.5 border-b border-gray-400">To</div>
                <div className="p-2 h-32 leading-relaxed">
                  <div>GSTIN : {buyer.gstin || 'URP'}</div>
                  <div>{buyer.name}</div>
                  <div>{buyer.state}</div>
                  <div className="mt-3 text-gray-500">:: Ship To ::</div>
                  <div>{buyer.address}</div>
                  <div>{buyer.pincode ? `${buyer.pincode}` : ''}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="border border-gray-400 mb-1">
            <div className="bg-[#7a7aba] text-white font-bold px-2 py-1 text-xs">3. Goods Details</div>
            <table className="w-full text-[11px] text-center border-collapse">
              <thead>
                <tr className="border-b border-gray-400 font-bold">
                  <td className="p-1 border-r border-gray-400 w-12">HSN<br/>Code</td>
                  <td className="p-1 border-r border-gray-400 text-left">Product Name & Desc.</td>
                  <td className="p-1 border-r border-gray-400 w-20">Quantity</td>
                  <td className="p-1 border-r border-gray-400 w-24">Taxable Amount<br/>Rs.</td>
                  <td className="p-1 w-48">Tax Rate (C+S+I+Cess+Cess Non.Advol)</td>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="p-1 border-r border-gray-400">{hsn}</td>
                  <td className="p-1 border-r border-gray-400 text-left">{description}</td>
                  <td className="p-1 border-r border-gray-400">{weight.toFixed(2)}<br/>Kgs</td>
                  <td className="p-1 border-r border-gray-400">{baseAmount.toFixed(2)}</td>
                  <td className="p-1">{taxRateStr}</td>
                </tr>
              </tbody>
            </table>
            <table className="w-full text-[11px] text-center border-collapse border-t border-gray-400 mt-2">
              <thead>
                <tr className="font-bold">
                  <td className="p-1 border-r border-gray-400">Tot. Tax'ble Amt</td>
                  <td className="p-1 border-r border-gray-400">CGST Amt</td>
                  <td className="p-1 border-r border-gray-400">SGST Amt</td>
                  <td className="p-1 border-r border-gray-400">IGST Amt</td>
                  <td className="p-1 border-r border-gray-400">CESS Amt</td>
                  <td className="p-1 border-r border-gray-400">CESS Non.Advol Amt</td>
                  <td className="p-1 border-r border-gray-400">Other Amt</td>
                  <td className="p-1 font-bold">Total Inv.Amt</td>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="p-1 border-t border-gray-400 border-r">{baseAmount.toFixed(2)}</td>
                  <td className="p-1 border-t border-gray-400 border-r">{cgstAmt.toFixed(2)}</td>
                  <td className="p-1 border-t border-gray-400 border-r">{sgstAmt.toFixed(2)}</td>
                  <td className="p-1 border-t border-gray-400 border-r">{igstAmt.toFixed(2)}</td>
                  <td className="p-1 border-t border-gray-400 border-r">0.00</td>
                  <td className="p-1 border-t border-gray-400 border-r">0.00</td>
                  <td className="p-1 border-t border-gray-400 border-r">0.00</td>
                  <td className="p-1 border-t border-gray-400">{totalAmount.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="border border-gray-400 mb-1">
            <div className="bg-[#7a7aba] text-white font-bold px-2 py-1 text-xs">4. Transportation Details</div>
            <div className="p-1 text-[11px] flex justify-between">
              <div>Transporter ID & Name :</div>
              <div className="mr-32">Transporter Doc. No & Date : & <b>{fmtDateOnly(dispatch.dispatchDate)}</b></div>
            </div>
          </div>

          <div className="border border-gray-400 mb-6">
            <div className="bg-[#7a7aba] text-white font-bold px-2 py-1 text-xs">5. Vehicle Details</div>
            <table className="w-full text-[11px] text-center border-collapse">
              <thead>
                <tr className="border-b border-gray-400 font-bold">
                  <td className="p-1 border-r border-gray-400">Mode</td>
                  <td className="p-1 border-r border-gray-400">Vehicle / Trans<br/>Doc No & Dt.</td>
                  <td className="p-1 border-r border-gray-400">From</td>
                  <td className="p-1 border-r border-gray-400">Entered Date</td>
                  <td className="p-1 border-r border-gray-400">Entered By</td>
                  <td className="p-1 border-r border-gray-400">CEWB No.<br/>(If any)</td>
                  <td className="p-1 border-r border-gray-400">Multi Veh.Info<br/>(If any)</td>
                  <td className="p-1">Portal</td>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="p-1 border-r border-gray-400">Road</td>
                  <td className="p-1 border-r border-gray-400">{dispatch.vehicleNumber || '-'}</td>
                  <td className="p-1 border-r border-gray-400">{company.stateName}</td>
                  <td className="p-1 border-r border-gray-400">{dispatch.ewbDate ? fmtDate(dispatch.ewbDate) : '-'}</td>
                  <td className="p-1 border-r border-gray-400">{company.gstin}</td>
                  <td className="p-1 border-r border-gray-400">-</td>
                  <td className="p-1 border-r border-gray-400">-</td>
                  <td className="p-1">1</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="flex justify-center mt-4">
            {dispatch.ewbNumber && (
              <img src={`https://bwipjs-api.metafloor.com/?bcid=code128&text=${dispatch.ewbNumber}&scale=2&height=10&includetext`} alt="Barcode" className="h-14 mix-blend-multiply opacity-80" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
