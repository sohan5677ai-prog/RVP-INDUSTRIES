import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Printer, FileText, FileDown, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { api, getToken } from '@/lib/api';
import type { SaleDispatch, CompanyProfile, ProductTaxInfo } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** Fetch the official government-format EWB PDF (rendered by TaxPro from the
 * live NIC record) and open it in a new tab. Uses fetch rather than a plain
 * window.open because the API requires the Authorization header. */
async function openOfficialEwbPdf(
  dispatchId: string,
  detailed: boolean,
  setLoading: (v: 'std' | 'detail' | null) => void,
) {
  setLoading(detailed ? 'detail' : 'std');
  try {
    const base = import.meta.env.VITE_API_URL ?? '/api';
    const token = getToken();
    const res = await fetch(
      `${base}/sale-dispatches/${dispatchId}/ewaybill/print-pdf${detailed ? '?detail=1' : ''}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(body?.error || 'Failed to load the official EWB PDF');
      return;
    }
    const blob = await res.blob();
    window.open(URL.createObjectURL(blob), '_blank');
  } catch {
    toast.error('Could not reach the server to fetch the official EWB PDF');
  } finally {
    setLoading(null);
  }
}

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

const TRANS_MODES: Record<string, string> = { '1': 'Road', '2': 'Rail', '3': 'Air', '4': 'Ship' };

const PRODUCT_FALLBACK: Record<string, string> = {
  PAPPU: 'Tamarind Seed Kernel', HUSK: 'Tamarind Husk', WASTE: 'Tamarind Waste', TPS: 'Tamarind Seed Brokens', SHELL: 'Tamarind Shell',
};

export default function EWayBillView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [pdfLoading, setPdfLoading] = useState<'std' | 'detail' | null>(null);

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

  // ── Approx distance ────────────────────────────────────────────────────────
  // The government print renders whatever distance WE hold: NIC works its own
  // figure out when the bill is raised with 0 but never hands it back, so a bill
  // raised that way must have the portal's figure typed in once, here, before it
  // can be printed or WhatsApp'd - otherwise the copy would read "0 KM".
  const qc = useQueryClient();
  const [distanceInput, setDistanceInput] = useState('');
  useEffect(() => {
    setDistanceInput(dispatch?.ewbDistance ? String(dispatch.ewbDistance) : '');
  }, [dispatch?.ewbDistance]);

  const saveDistance = useMutation({
    mutationFn: () => api(`/sale-dispatches/${id}/ewaybill/distance`, {
      method: 'PATCH',
      body: { distance: Number(distanceInput) },
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sale-dispatch', id] });
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      toast.success('Approx distance saved');
    },
    onError: (e: Error) => toast.error(e.message),
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
  // which can be 0 on legacy dispatches - mirrors the tax invoice / e-invoice.
  const gstPct = taxInfo?.gstRate != null ? Number(taxInfo.gstRate) : 5;
  const gstAmount = Math.round(baseAmount * gstPct) / 100;
  const totalAmount = Math.round((baseAmount + gstAmount) * 100) / 100;

  const sellerStateCode = company.gstin?.slice(0, 2) || '';
  const buyerStateCode = buyer.gstin?.slice(0, 2) || '';
  const isSameState = sellerStateCode === buyerStateCode && sellerStateCode !== '';

  const cgstAmt = isSameState ? gstAmount / 2 : 0;
  const sgstAmt = isSameState ? gstAmount / 2 : 0;
  const igstAmt = isSameState ? 0 : gstAmount;

  // Dispatch-from / ship-to blocks come from Settings → Invoice Setup and the
  // buyer's party record. The *place* is the town (Punganur / Surat) - the state
  // is already on its own line - with the registered address as the fallback.
  const dispatchPlace = company.dispatchFromPlace || company.stateName || '';
  const dispatchAddr1 = company.dispatchFromAddress1 || company.address || '';
  const dispatchAddr2 = company.dispatchFromAddress2 || '';
  const dispatchPin = company.dispatchFromPincode || company.pincode || '';
  const shipToPlace = buyer.city || buyer.state || '';
  const transMode = TRANS_MODES[dispatch.ewbTransMode || '1'] || 'Road';

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
            <span className="ml-1 text-xs text-amber-600">(on-screen replica - use “Official PDF” for the government document)</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={pdfLoading !== null}
            onClick={() => id && openOfficialEwbPdf(id, false, setPdfLoading)}
            title="The real government-format e-Way Bill PDF, rendered from the live NIC record (requires TaxPro credentials in Settings)"
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            <FileDown className="h-4 w-4 mr-1" /> {pdfLoading === 'std' ? 'Loading…' : 'Official PDF'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pdfLoading !== null}
            onClick={() => id && openOfficialEwbPdf(id, true, setPdfLoading)}
            title="The government 'detailed print' layout of the e-Way Bill"
          >
            <FileDown className="h-4 w-4 mr-1" /> {pdfLoading === 'detail' ? 'Loading…' : 'Official (Detailed)'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.print()} title="Print this on-screen replica (not the government document)">
            <Printer className="h-4 w-4 mr-1" /> Print Replica
          </Button>
        </div>
      </div>

      {/* Approx distance - the one field the government print takes from us and
          NIC will not give back, so it has to be captured here. */}
      <div
        className={`inv-no-print flex flex-wrap items-center gap-3 border-b px-4 py-2 text-sm ${
          dispatch.ewbDistance ? 'bg-background' : 'bg-amber-50 dark:bg-amber-950/30'
        }`}
      >
        {!dispatch.ewbDistance && (
          <span className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4" />
            No approx distance recorded - the official PDF and the WhatsApp copy are blocked until it's saved.
          </span>
        )}
        <span className="text-muted-foreground">Approx Distance</span>
        <Input
          type="number"
          min="1"
          max="4000"
          value={distanceInput}
          onChange={(e) => setDistanceInput(e.target.value)}
          placeholder="km as per the NIC portal"
          className="h-8 w-48"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={saveDistance.isPending || !(Number(distanceInput) > 0) || Number(distanceInput) === dispatch.ewbDistance}
          onClick={() => saveDistance.mutate()}
        >
          {saveDistance.isPending ? 'Saving…' : 'Save distance'}
        </Button>
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
                    <td colSpan={2} className="py-1">Mode: <b>{transMode}</b><span className="ml-12">Approx Distance: <b>{dispatch.ewbDistance ? `${dispatch.ewbDistance} KM` : '-'}</b></span></td>
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
                  <div>{dispatchAddr1}</div>
                  {dispatchAddr2 && <div>{dispatchAddr2}</div>}
                  <div>{[dispatchPlace, company.stateName, dispatchPin].filter(Boolean).join(', ')}</div>
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
                  <div>{[shipToPlace, buyer.state, buyer.pincode].filter(Boolean).join(', ')}</div>
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
              <div>Transporter ID &amp; Name :</div>
              <div className="mr-32">
                Transporter Doc. No &amp; Date :{' '}
                <b>
                  {dispatch.ewbTransDocNo ? `${dispatch.ewbTransDocNo} & ` : ''}
                  {fmtDateOnly(dispatch.ewbTransDocDate || dispatch.dispatchDate)}
                </b>
              </div>
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
                  <td className="p-1 border-r border-gray-400">{transMode}</td>
                  <td className="p-1 border-r border-gray-400">{dispatch.vehicleNumber || dispatch.ewbTransDocNo || '-'}</td>
                  <td className="p-1 border-r border-gray-400">{dispatchPlace}</td>
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
