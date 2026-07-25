import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer, FileText } from 'lucide-react';
import { api } from '@/lib/api';
import type { SaleDispatch, CompanyProfile, ProductTaxInfo } from '@/lib/types';
import { inr, rupeesInWords } from '@/lib/invoiceWords';
import { Button } from '@/components/ui/button';

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '';
  const dateObj = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(dateObj.getTime())) return '';
  return dateObj.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '-');
}

const PRODUCT_FALLBACK: Record<string, string> = {
  PAPPU: 'Tamarind Seed Kernel', HUSK: 'Tamarind Husk', WASTE: 'Tamarind Waste', TPS: 'Tamarind Seed Brokens', SHELL: 'Tamarind Shell',
};

export default function EInvoiceView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: dispatch, isLoading } = useQuery({
    queryKey: ['sale-dispatch', id],
    queryFn: () => api<SaleDispatch>(`/sale-dispatches/${id}`),
    enabled: !!id,
  });

  const order = dispatch?.saleOrder;
  const buyer = order?.buyer;

  const { data: company } = useQuery({ queryKey: ['company'], queryFn: () => api<CompanyProfile>('/settings/company') });
  const { data: taxRows } = useQuery({ queryKey: ['product-tax'], queryFn: () => api<ProductTaxInfo[]>('/settings/product-tax') });

  if (isLoading || !dispatch || !company || !order || !buyer) {
    return <div className="p-8 text-center text-muted-foreground animate-pulse">Loading e-Invoice data…</div>;
  }

  if (!dispatch.irn) {
    return (
      <div className="p-8 text-center">
        <h2 className="text-xl font-bold text-rose-600 mb-2">E-Invoice Not Generated</h2>
        <p className="text-muted-foreground mb-4">Generate the IRN first before printing the e-Invoice.</p>
        <Button onClick={() => navigate(-1)}><ArrowLeft className="mr-2 h-4 w-4" /> Go Back</Button>
      </div>
    );
  }

  const taxInfo = taxRows?.find((t) => t.product === order.product);
  const description = taxInfo?.description || PRODUCT_FALLBACK[order.product] || `${order.product} Sale`;
  const hsn = taxInfo?.hsn || '1207';

  const weight = dispatch.weightKg;
  const rate = Number(order.ratePerKg);
  const baseAmount = Math.round(weight * rate * 100) / 100;
  const gstPct = order.gstExempt ? 0 : (taxInfo?.gstRate != null ? Number(taxInfo.gstRate) : 5);
  const gstAmount = Math.round(baseAmount * gstPct) / 100;
  const totalAmount = Math.round((baseAmount + gstAmount) * 100) / 100;

  const buyerGstin = buyer.gstin || null;
  const buyerStateCode = buyerGstin && /^\d{2}/.test(buyerGstin) ? buyerGstin.slice(0, 2) : null;
  const buyerPan = buyerGstin && buyerGstin.length >= 12 ? buyerGstin.slice(2, 12) : null;

  const sellerStateCode = company.gstin?.slice(0, 2) || '';
  const isSameState = sellerStateCode === buyerStateCode && sellerStateCode !== '';

  const qrData = dispatch.irnSignedQr || dispatch.irn;
  const qtyStr = `${weight.toLocaleString('en-IN')} Kgs`;

  return (
    <div className="min-h-screen bg-neutral-100 flex flex-col font-sans">
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; background-color: white !important; }
          .inv-no-print { display: none !important; }
          .inv-print-area { margin: 0; padding: 0; box-shadow: none !important; width: 100% !important; max-width: none !important; border: none !important; }
          @page { size: A4 portrait; margin: 8mm; }
        }
        .inv-page { font-family: 'Times New Roman', Times, serif; color: #000; background: #fff; }
        .inv-page table { border-collapse: collapse; width: 100%; }
        .inv-page td, .inv-page th { border: 1px solid #000; vertical-align: top; padding: 2px 5px; }
        .inv-page .lbl { font-size: 0.82em; line-height: 1.15; }
        .inv-page .val { font-weight: bold; line-height: 1.2; }
      `}} />

      {/* Toolbar (not printed) */}
      <div className="inv-no-print sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b bg-background px-4 py-2 shadow-sm">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => navigate(-1)}><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
          <span className="text-sm font-medium text-muted-foreground ml-2 flex items-center gap-1">
            <FileText className="h-4 w-4" /> e-Invoice Viewer
          </span>
        </div>
        <Button size="sm" onClick={() => window.print()} className="bg-indigo-600 hover:bg-indigo-700 text-white">
          <Printer className="h-4 w-4 mr-1" /> Print e-Invoice
        </Button>
      </div>

      <div className="flex justify-center py-6 inv-print-area bg-neutral-100">
        <div className="inv-page bg-white border shadow-sm w-[210mm] p-[8mm] text-[11px] text-black relative font-sans">
          
          {/* Header title & e-Invoice IRN/QR block */}
          <div className="relative mb-2 pb-2 border-b border-black">
            <div className="text-center font-bold text-2xl">Tax Invoice</div>
            <div className="absolute right-0 top-0 text-sm font-sans">e-Invoice</div>
            
            <div className="flex justify-between items-start mt-2">
              <div className="text-[0.85em] space-y-0.5">
                <div className="flex"><span className="font-bold w-16">IRN</span><span className="font-mono font-bold break-all">: {dispatch.irn}</span></div>
                <div className="flex"><span className="font-bold w-16">Ack No.</span><span className="font-bold">: {dispatch.irnAckNo || '-'}</span></div>
                <div className="flex"><span className="font-bold w-16">Ack Date</span><span className="font-bold">: {dispatch.irnAckDate ? fmtDate(new Date(dispatch.irnAckDate)) : '-'}</span></div>
              </div>

              {qrData && (
                <div className="w-24 h-24 border border-black p-1 flex items-center justify-center shrink-0">
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(qrData)}`}
                    alt="e-Invoice QR Code"
                    className="w-full h-full object-contain"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Header grid: seller/buyer + meta grid */}
          <table className="w-full border-collapse border border-black">
            <colgroup>
              <col style={{ width: '56%' }} />
              <col style={{ width: '14.6%' }} />
              <col style={{ width: '14.6%' }} />
              <col style={{ width: '14.8%' }} />
            </colgroup>
            <tbody>
              <tr>
                <td rowSpan={8} className="p-0 border border-black align-top">
                  <div className="p-1.5 border-b border-black leading-tight">
                    <div className="font-bold text-sm">{company.name}</div>
                    {company.address && <div className="lbl whitespace-pre-line">{company.address}</div>}
                    {company.gstin && <div className="lbl">GSTIN/UIN: <span className="font-semibold">{company.gstin}</span></div>}
                    {company.stateName && (
                      <div className="lbl">State Name : {company.stateName}{company.stateCode ? `, Code : ${company.stateCode}` : ''}</div>
                    )}
                    {company.contact && <div className="lbl">Contact : {company.contact}</div>}
                  </div>
                  <div className="p-1.5 leading-tight">
                    <div className="lbl text-gray-700">Buyer (Bill to)</div>
                    <div className="font-bold text-sm mt-0.5">{buyer.name}</div>
                    {buyer.address && <div className="lbl whitespace-pre-line">{buyer.address}</div>}
                    {buyerGstin && <div className="lbl">GSTIN/UIN : <span className="font-semibold">{buyerGstin}</span></div>}
                    {buyerPan && <div className="lbl">PAN/IT No : <span className="font-semibold">{buyerPan}</span></div>}
                    {buyer.state && (
                      <div className="lbl">State Name : {buyer.state}{buyerStateCode ? `, Code : ${buyerStateCode}` : ''}</div>
                    )}
                    {buyer.state && <div className="lbl">Place of Supply : {buyer.state}</div>}
                  </div>
                </td>
                <MetaCell label="Invoice No." value={dispatch.invoiceNumber ?? ''} isBold />
                <MetaCell label="e-Way Bill No." value={dispatch.ewbNumber ?? ''} isBold />
                <MetaCell label="Dated" value={dispatch.invoiceDate ? fmtDate(new Date(dispatch.invoiceDate)) : ''} isBold />
              </tr>
              <tr><MetaCell colSpan={2} label="Delivery Note" value="" /><MetaCell label="Mode/Terms of Payment" value="" /></tr>
              <tr><MetaCell colSpan={2} label="Reference No. & Date." value="" /><MetaCell label="Other References" value="" /></tr>
              <tr><MetaCell colSpan={2} label="Buyer's Order No." value="" /><MetaCell label="Dated" value="" /></tr>
              <tr><MetaCell colSpan={2} label="Dispatch Doc No." value="" /><MetaCell label="Delivery Note Date" value="" /></tr>
              <tr><MetaCell colSpan={2} label="Dispatched through" value="Road" /><MetaCell label="Destination" value={order.destination || buyer.state || ''} /></tr>
              <tr><MetaCell colSpan={2} label="Bill of Lading/LR-RR No." value="" /><MetaCell label="Motor Vehicle No." value={dispatch.vehicleNumber ?? ''} isBold /></tr>
              <tr><MetaCell colSpan={3} label="Terms of Delivery" value="" /></tr>
            </tbody>
          </table>

          {/* Goods table */}
          <table className="w-full border-collapse border border-black -mt-px">
            <colgroup>
              <col style={{ width: '6%' }} />
              <col style={{ width: '34%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '15%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '7%' }} />
              <col style={{ width: '16%' }} />
            </colgroup>
            <thead>
              <tr className="text-center font-bold border-b border-black">
                <th className="border border-black p-1">Sl<br />No.</th>
                <th className="border border-black p-1">Description of Goods</th>
                <th className="border border-black p-1">HSN/SAC</th>
                <th className="border border-black p-1">Quantity</th>
                <th className="border border-black p-1">Rate</th>
                <th className="border border-black p-1">per</th>
                <th className="border border-black p-1">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border border-black p-1 text-center font-semibold">1</td>
                <td className="border border-black p-1 font-bold">{description}</td>
                <td className="border border-black p-1 text-center">{hsn}</td>
                <td className="border border-black p-1 text-right font-bold">{qtyStr}</td>
                <td className="border border-black p-1 text-right">{rate.toFixed(2)}</td>
                <td className="border border-black p-1 text-center">Kgs</td>
                <td className="border border-black p-1 text-right font-bold">{inr(baseAmount)}</td>
              </tr>

              {!order.gstExempt && (
                isSameState ? (
                  <>
                    <tr>
                      <td className="border-x border-black p-1"></td>
                      <td className="border-x border-black p-1 font-semibold italic text-right">CGST {(gstPct / 2).toFixed(1)}%</td>
                      <td className="border-x border-black p-1"></td>
                      <td className="border-x border-black p-1"></td>
                      <td className="border-x border-black p-1 text-right">{(gstPct / 2).toFixed(1)} %</td>
                      <td className="border-x border-black p-1"></td>
                      <td className="border-x border-black p-1 text-right font-semibold">{inr(gstAmount / 2)}</td>
                    </tr>
                    <tr>
                      <td className="border-x border-black p-1"></td>
                      <td className="border-x border-black p-1 font-semibold italic text-right">SGST {(gstPct / 2).toFixed(1)}%</td>
                      <td className="border-x border-black p-1"></td>
                      <td className="border-x border-black p-1"></td>
                      <td className="border-x border-black p-1 text-right">{(gstPct / 2).toFixed(1)} %</td>
                      <td className="border-x border-black p-1"></td>
                      <td className="border-x border-black p-1 text-right font-semibold">{inr(gstAmount / 2)}</td>
                    </tr>
                  </>
                ) : (
                  <tr>
                    <td className="border-x border-black p-1"></td>
                    <td className="border-x border-black p-1 font-semibold italic text-right">IGST {gstPct}%</td>
                    <td className="border-x border-black p-1"></td>
                    <td className="border-x border-black p-1"></td>
                    <td className="border-x border-black p-1 text-right">{gstPct} %</td>
                    <td className="border-x border-black p-1"></td>
                    <td className="border-x border-black p-1 text-right font-semibold">{inr(gstAmount)}</td>
                  </tr>
                )
              )}

              <tr style={{ height: '36px' }}>
                <td className="border-x border-black"></td><td className="border-x border-black"></td><td className="border-x border-black"></td><td className="border-x border-black"></td><td className="border-x border-black"></td><td className="border-x border-black"></td><td className="border-x border-black"></td>
              </tr>

              <tr className="font-bold border-t border-b border-black">
                <td className="border border-black p-1 text-right" colSpan={3}>Total</td>
                <td className="border border-black p-1 text-right">{qtyStr}</td>
                <td className="border border-black p-1" colSpan={2}></td>
                <td className="border border-black p-1 text-right">₹ {inr(totalAmount)}</td>
              </tr>
            </tbody>
          </table>

          {/* Amount Chargeable Box */}
          <table className="w-full border-collapse border border-black -mt-px">
            <tbody>
              <tr>
                <td className="p-1">
                  <div className="lbl text-gray-700">Amount Chargeable (in words)</div>
                  <div className="val text-sm mt-0.5">{rupeesInWords(totalAmount)}</div>
                </td>
                <td className="p-1 text-right font-bold align-top w-28">E. &amp; O.E</td>
              </tr>
            </tbody>
          </table>

          {/* HSN / Tax Summary */}
          <table className="w-full border-collapse border border-black -mt-px">
            <thead>
              <tr className="text-center font-bold border-b border-black">
                <th className="border border-black p-1" rowSpan={2}>HSN/SAC</th>
                <th className="border border-black p-1" rowSpan={2}>Taxable Value</th>
                {isSameState ? (
                  <>
                    <th className="border border-black p-1" colSpan={2}>Central Tax</th>
                    <th className="border border-black p-1" colSpan={2}>State Tax</th>
                  </>
                ) : (
                  <th className="border border-black p-1" colSpan={2}>IGST</th>
                )}
                <th className="border border-black p-1" rowSpan={2}>Total Tax Amount</th>
              </tr>
              <tr className="text-center font-bold border-b border-black">
                {isSameState ? (
                  <>
                    <th className="border border-black p-1">Rate</th><th className="border border-black p-1">Amount</th>
                    <th className="border border-black p-1">Rate</th><th className="border border-black p-1">Amount</th>
                  </>
                ) : (
                  <>
                    <th className="border border-black p-1">Rate</th><th className="border border-black p-1">Amount</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border border-black p-1 text-center">{hsn}</td>
                <td className="border border-black p-1 text-right">{inr(baseAmount)}</td>
                {isSameState ? (
                  <>
                    <td className="border border-black p-1 text-center">{(gstPct / 2).toFixed(1)}%</td>
                    <td className="border border-black p-1 text-right">{inr(gstAmount / 2)}</td>
                    <td className="border border-black p-1 text-center">{(gstPct / 2).toFixed(1)}%</td>
                    <td className="border border-black p-1 text-right">{inr(gstAmount / 2)}</td>
                  </>
                ) : (
                  <>
                    <td className="border border-black p-1 text-center">{gstPct}%</td>
                    <td className="border border-black p-1 text-right">{inr(gstAmount)}</td>
                  </>
                )}
                <td className="border border-black p-1 text-right">{inr(gstAmount)}</td>
              </tr>
              <tr className="font-bold border-t border-black">
                <td className="border border-black p-1 text-right">Total</td>
                <td className="border border-black p-1 text-right">{inr(baseAmount)}</td>
                {isSameState ? (
                  <>
                    <td className="border border-black p-1"></td>
                    <td className="border border-black p-1 text-right">{inr(gstAmount / 2)}</td>
                    <td className="border border-black p-1"></td>
                    <td className="border border-black p-1 text-right">{inr(gstAmount / 2)}</td>
                  </>
                ) : (
                  <>
                    <td className="border border-black p-1"></td>
                    <td className="border border-black p-1 text-right">{inr(gstAmount)}</td>
                  </>
                )}
                <td className="border border-black p-1 text-right">{inr(gstAmount)}</td>
              </tr>
            </tbody>
          </table>

          {/* Tax Amount In Words */}
          <table className="w-full border-collapse border border-black -mt-px">
            <tbody>
              <tr>
                <td className="p-1 lbl">
                  Tax Amount (in words) : <span className="val">{rupeesInWords(gstAmount)}</span>
                </td>
              </tr>
            </tbody>
          </table>

          {/* Declaration + Bank Details */}
          <table className="w-full border-collapse border border-black -mt-px">
            <colgroup>
              <col style={{ width: '55%' }} />
              <col style={{ width: '45%' }} />
            </colgroup>
            <tbody>
              <tr>
                <td className="p-1.5 border-r border-black align-top lbl">
                  <div className="font-bold">Declaration</div>
                  <div className="leading-tight">We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.</div>
                  <div className="font-bold mt-1.5">Terms &amp; Conditions</div>
                  <div className="text-gray-700">E. &amp; O.E.</div>
                  <div className="leading-tight">1. Goods once sold will not be taken back.</div>
                  <div className="leading-tight">2. Interest @ 18% p.a. will be charged if the payment is not made within the stipulated time.</div>
                  {company.stateName && (
                    <div className="leading-tight">3. Subject to '{company.stateName}' Jurisdiction only.</div>
                  )}
                </td>
                <td className="p-1.5 align-top lbl">
                  <div className="font-bold mb-1">Company's Bank Details</div>
                  <div className="space-y-0.5">
                    <div className="flex"><span className="w-28 shrink-0">A/c Holder's Name :</span><span className="val">{company.bankAccountName || company.name}</span></div>
                    <div className="flex"><span className="w-28 shrink-0">Bank Name :</span><span className="val">{company.bankName || '-'}</span></div>
                    <div className="flex"><span className="w-28 shrink-0">A/c No. :</span><span className="val">{company.bankAccountNumber || '-'}</span></div>
                    <div className="flex"><span className="w-28 shrink-0">Branch &amp; IFS Code :</span><span className="val">{company.bankBranchIfsc || '-'}</span></div>
                  </div>
                  <div className="text-right font-bold mt-4">for {company.name}</div>
                  <div className="text-right mt-6">Authorised Signatory</div>
                </td>
              </tr>
            </tbody>
          </table>

          {/* Footer */}
          <div className="text-center text-[10px] text-gray-600 mt-2">This is a Computer Generated Invoice</div>
        </div>
      </div>
    </div>
  );
}

function MetaCell({ label, value, colSpan, isBold }: { label: string; value: string; colSpan?: number; isBold?: boolean }) {
  return (
    <td colSpan={colSpan} style={{ minHeight: 24 }}>
      <div className="lbl text-gray-700 text-[10px]">{label}</div>
      <div className={isBold ? "val text-[11px]" : "text-[11px]"} style={{ minHeight: '1em' }}>{value}</div>
    </td>
  );
}
