import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer, FileText } from 'lucide-react';
import { api } from '@/lib/api';
import type { SaleDispatch, CompanyProfile, ProductTaxInfo } from '@/lib/types';
import { inr, rupeesInWords } from '@/lib/invoiceWords';
import { Button } from '@/components/ui/button';

/**
 * Official government-format e-Invoice print.
 *
 * This reproduces the standard NIC / e-invoice-portal print layout (e-Invoice
 * title, IRN / Ack block, supplier & recipient panels, item list, tax summary,
 * signed QR). There is NO government "print PDF" API — the authoritative print
 * is always rendered by the ASP from the signed IRN data + the SignedQRCode
 * (stored here as `irnSignedQr`), which is exactly what this page does.
 */

function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return '-';
  const date = new Date(d);
  if (isNaN(date.getTime())) return '-';
  return date.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '-';
  const date = new Date(d);
  if (isNaN(date.getTime())) return '-';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
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
  // GST from the commodity's configured rate (default 5%), 0 if the order is
  // GST-exempt — mirrors the tax invoice / e-way bill and what NIC signed.
  const gstPct = order.gstExempt ? 0 : (taxInfo?.gstRate != null ? Number(taxInfo.gstRate) : 5);
  const gstAmount = Math.round(baseAmount * gstPct) / 100;
  const totalAmount = Math.round((baseAmount + gstAmount) * 100) / 100;

  const sellerStateCode = company.gstin?.slice(0, 2) || '';
  const buyerStateCode = buyer.gstin?.slice(0, 2) || '';
  const isSameState = sellerStateCode === buyerStateCode && sellerStateCode !== '';

  const cgstAmt = isSameState ? Math.round((gstAmount / 2) * 100) / 100 : 0;
  const sgstAmt = isSameState ? Math.round((gstAmount / 2) * 100) / 100 : 0;
  const igstAmt = isSameState ? 0 : gstAmount;

  const docNo = dispatch.invoiceNumber || `DISP-${dispatch.id.slice(-6)}`;
  const cancelled = dispatch.irnStatus === 'CANCELLED';

  // The signed QR carries the government JWT; if for some reason it is missing
  // (e.g. legacy row) fall back to encoding the IRN so a QR still renders.
  const qrData = dispatch.irnSignedQr || dispatch.irn;

  return (
    <div className="min-h-screen bg-neutral-100 flex flex-col font-sans">
      <style dangerouslySetInnerHTML={{ __html: `
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
            <FileText className="h-4 w-4" /> e-Invoice Viewer
          </span>
        </div>
        <Button size="sm" onClick={() => window.print()} className="bg-indigo-600 hover:bg-indigo-700 text-white">
          <Printer className="h-4 w-4 mr-1" /> Print e-Invoice
        </Button>
      </div>

      <div className="flex justify-center py-8 inv-print-area bg-neutral-100">
        <div className="bg-white border shadow-sm inv-print-area w-[210mm] min-h-[297mm] p-[10mm] text-[12px] leading-snug text-black relative font-sans">
          {cancelled && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="text-[120px] font-black text-rose-500/15 rotate-[-25deg] select-none">CANCELLED</span>
            </div>
          )}

          {/* Header: title + signed QR */}
          <div className="flex justify-between items-start mb-2">
            <div>
              <h1 className="text-xl font-bold">e-Invoice</h1>
              <div className="text-[11px] text-gray-600">Generated under Rule 48 of CGST Rules, 2017</div>
            </div>
            <div className="w-[110px] h-[110px] flex items-center justify-center border border-gray-300">
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=110x110&data=${encodeURIComponent(qrData)}`}
                alt="Signed QR Code"
                className="w-full h-full object-contain mix-blend-multiply"
              />
            </div>
          </div>

          {/* 1. e-Invoice details (IRN) */}
          <div className="border border-gray-400 mb-1">
            <div className="bg-[#4f5b93] text-white font-bold px-2 py-1 text-xs">1. e-Invoice Details</div>
            <div className="p-2 text-[11px]">
              <table className="w-full">
                <tbody>
                  <tr>
                    <td className="py-0.5 align-top w-24 text-gray-600">IRN</td>
                    <td className="py-0.5 align-top font-mono font-bold break-all">{dispatch.irn}</td>
                  </tr>
                  <tr>
                    <td className="py-0.5 align-top text-gray-600">Ack No.</td>
                    <td className="py-0.5 align-top font-bold">{dispatch.irnAckNo || '-'}</td>
                  </tr>
                  <tr>
                    <td className="py-0.5 align-top text-gray-600">Ack Date</td>
                    <td className="py-0.5 align-top font-bold">{fmtDateTime(dispatch.irnAckDate)}</td>
                  </tr>
                  {cancelled && (
                    <tr>
                      <td className="py-0.5 align-top text-gray-600">Status</td>
                      <td className="py-0.5 align-top font-bold text-rose-600">CANCELLED{dispatch.irnCancelledDate ? ` on ${fmtDate(dispatch.irnCancelledDate)}` : ''}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* 2. Document details */}
          <div className="border border-gray-400 mb-1">
            <div className="bg-[#4f5b93] text-white font-bold px-2 py-1 text-xs">2. Document Details</div>
            <table className="w-full text-[11px]">
              <tbody>
                <tr>
                  <td className="p-2 w-1/3">Type: <b>Tax Invoice (INV)</b></td>
                  <td className="p-2 w-1/3">Document No: <b>{docNo}</b></td>
                  <td className="p-2 w-1/3">Document Date: <b>{fmtDate(dispatch.invoiceDate)}</b></td>
                </tr>
                <tr>
                  <td className="p-2">Category: <b>B2B</b></td>
                  <td className="p-2">Supply Type: <b>{isSameState ? 'Intra-State' : 'Inter-State'}</b></td>
                  <td className="p-2">Reverse Charge: <b>No</b></td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* 3. Supplier & Recipient */}
          <div className="border border-gray-400 mb-1">
            <div className="bg-[#4f5b93] text-white font-bold px-2 py-1 text-xs">3. Party Details</div>
            <div className="flex text-[11px]">
              <div className="w-1/2 border-r border-gray-400">
                <div className="bg-[#dfe2f0] font-bold px-2 py-0.5 border-b border-gray-400">Supplier</div>
                <div className="p-2 h-36 leading-relaxed">
                  <div className="font-bold">{company.name}</div>
                  <div>GSTIN: {company.gstin}</div>
                  {company.address && <div className="whitespace-pre-line">{company.address}</div>}
                  <div>{company.stateName}{company.stateCode ? ` (${company.stateCode})` : ''}{company.pincode ? ` - ${company.pincode}` : ''}</div>
                </div>
              </div>
              <div className="w-1/2">
                <div className="bg-[#dfe2f0] font-bold px-2 py-0.5 border-b border-gray-400">Recipient</div>
                <div className="p-2 h-36 leading-relaxed">
                  <div className="font-bold">{buyer.name}</div>
                  <div>GSTIN: {buyer.gstin || 'URP'}</div>
                  {buyer.address && <div className="whitespace-pre-line">{buyer.address}</div>}
                  <div>{buyer.state}{buyerStateCode ? ` (${buyerStateCode})` : ''}{buyer.pincode ? ` - ${buyer.pincode}` : ''}</div>
                  <div className="mt-1 text-gray-600">Place of Supply: <b>{buyer.state || '-'}</b></div>
                </div>
              </div>
            </div>
          </div>

          {/* 4. Item list */}
          <div className="border border-gray-400 mb-1">
            <div className="bg-[#4f5b93] text-white font-bold px-2 py-1 text-xs">4. Item Details</div>
            <table className="w-full text-[10.5px] text-center border-collapse">
              <thead>
                <tr className="border-b border-gray-400 font-bold bg-gray-50">
                  <td className="p-1 border-r border-gray-400 w-8">Sl</td>
                  <td className="p-1 border-r border-gray-400 text-left">Description</td>
                  <td className="p-1 border-r border-gray-400 w-16">HSN</td>
                  <td className="p-1 border-r border-gray-400 w-20">Qty</td>
                  <td className="p-1 border-r border-gray-400 w-20">Rate</td>
                  <td className="p-1 border-r border-gray-400 w-24">Taxable Amt</td>
                  <td className="p-1 border-r border-gray-400 w-12">GST %</td>
                  <td className="p-1 w-24">Item Total</td>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="p-1 border-r border-gray-400">1</td>
                  <td className="p-1 border-r border-gray-400 text-left">{description}</td>
                  <td className="p-1 border-r border-gray-400">{hsn}</td>
                  <td className="p-1 border-r border-gray-400">{weight.toLocaleString('en-IN')} KGS</td>
                  <td className="p-1 border-r border-gray-400 text-right">{rate.toFixed(2)}</td>
                  <td className="p-1 border-r border-gray-400 text-right">{inr(baseAmount)}</td>
                  <td className="p-1 border-r border-gray-400">{gstPct}%</td>
                  <td className="p-1 text-right">{inr(totalAmount)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* 5. Value / tax summary */}
          <div className="border border-gray-400 mb-1">
            <div className="bg-[#4f5b93] text-white font-bold px-2 py-1 text-xs">5. Value Details</div>
            <table className="w-full text-[11px]">
              <tbody>
                <SummaryRow k="Taxable Amount" v={inr(baseAmount)} />
                <SummaryRow k="CGST" v={inr(cgstAmt)} />
                <SummaryRow k="SGST" v={inr(sgstAmt)} />
                <SummaryRow k="IGST" v={inr(igstAmt)} />
                <SummaryRow k="Cess" v={inr(0)} />
                <tr className="border-t border-gray-400 font-bold">
                  <td className="p-2">Total Invoice Value</td>
                  <td className="p-2 text-right">₹ {inr(totalAmount)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Amount in words */}
          <div className="border border-gray-400 mb-1 p-2 text-[11px]">
            <span className="text-gray-600">Amount (in words): </span>
            <b>{rupeesInWords(totalAmount)}</b>
          </div>

          {/* Footer */}
          <div className="flex justify-between items-end mt-6 text-[11px]">
            <div className="text-gray-500">
              <div>Digitally signed e-Invoice — verify via the QR above on the e-invoice portal.</div>
              <div>This is a computer generated document.</div>
            </div>
            <div className="text-right">
              <div className="font-bold">for {company.name}</div>
              <div className="mt-8">Authorised Signatory</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryRow({ k, v }: { k: string; v: string }) {
  return (
    <tr className="border-b border-gray-200">
      <td className="p-2 text-gray-700">{k}</td>
      <td className="p-2 text-right">{v}</td>
    </tr>
  );
}
