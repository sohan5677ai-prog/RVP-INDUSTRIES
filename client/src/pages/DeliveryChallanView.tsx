import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer, ShieldCheck, Truck } from 'lucide-react';
import { api } from '@/lib/api';
import { rupeesInWords, inr } from '@/lib/invoiceWords';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { DeliveryChallan } from '@/pages/DeliveryChallans';
import type { CompanyProfile } from '@/lib/types';

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '';
  const dateObj = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(dateObj.getTime())) return '';
  return dateObj.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).replace(/ /g, '-');
}

const PURPOSE_LABELS: Record<string, string> = {
  JOB_WORK: 'Job Work (Rule 55(1)(a))',
  GODOWN_TRANSFER: 'Internal / Godown Stock Transfer (Rule 55(1)(c))',
  SUPPLY_ON_APPROVAL: 'Supply on Approval (Rule 55(1)(c))',
  FOR_EXHIBITION: 'Transportation for Exhibition / Demo',
  OTHERS: 'Others (Not for Sale)',
};

export default function DeliveryChallanView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: challan, isLoading: loadingChallan } = useQuery<DeliveryChallan>({
    queryKey: ['delivery-challan', id],
    queryFn: () => api<DeliveryChallan>(`/delivery-challans/${id}`),
    enabled: !!id,
  });

  const { data: company } = useQuery<CompanyProfile>({
    queryKey: ['company'],
    queryFn: () => api<CompanyProfile>('/settings/company'),
  });

  if (loadingChallan) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8 text-muted-foreground">
        Loading Delivery Challan...
      </div>
    );
  }

  if (!challan) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-8 gap-4">
        <div className="text-xl font-semibold text-rose-600">Delivery Challan not found</div>
        <Button variant="outline" onClick={() => navigate('/delivery-challans')}>
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Delivery Challans
        </Button>
      </div>
    );
  }

  const items = Array.isArray(challan.items) ? challan.items : [];
  const purposeText = PURPOSE_LABELS[challan.challanType] || challan.challanType || 'Transportation under Rule 55';
  const totalValNum = Number(challan.totalValue || 0);

  return (
    <div className="min-h-screen bg-muted/40 font-sans">
      {/* Print Styles */}
      <style>{`
        @page { size: A4; margin: 12mm; }
        @media print {
          body { background: #fff !important; }
          .dc-no-print { display: none !important; }
          .dc-page { box-shadow: none !important; margin: 0 !important; width: 100% !important; border: 1.5px solid #000 !important; }
        }
        .dc-page {
          font-family: Arial, Helvetica, sans-serif;
          color: #000;
          background: #fff;
          width: 210mm;
          min-height: 297mm;
          box-sizing: border-box;
          border: 1px solid #1f2937;
        }
        .dc-page table {
          border-collapse: collapse;
          width: 100%;
        }
        .dc-page th, .dc-page td {
          border: 1px solid #000;
          padding: 4px 6px;
          font-size: 11px;
          vertical-align: top;
        }
        .dc-page th {
          background-color: #f3f4f6;
          font-weight: bold;
        }
      `}</style>

      {/* Top Toolbar */}
      <div className="dc-no-print sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b bg-background px-6 py-3 shadow-sm">
        <Button variant="ghost" size="sm" onClick={() => navigate('/delivery-challans')}>
          <ArrowLeft className="h-4 w-4 mr-1.5" /> Back
        </Button>
        <Button size="sm" onClick={() => window.print()} className="bg-primary text-primary-foreground gap-1.5 shadow-sm">
          <Printer className="h-4 w-4" /> Print / Save PDF
        </Button>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <span className="text-muted-foreground font-medium">Challan:</span>
          <span className="font-bold text-foreground font-mono">{challan.challanNumber}</span>
          {challan.ewbNumber && (
            <Badge variant="outline" className="gap-1 bg-emerald-50 text-emerald-700 border-emerald-300">
              <ShieldCheck className="w-3.5 h-3.5" /> EWB: {challan.ewbNumber}
            </Badge>
          )}
        </div>
      </div>

      {/* A4 Printable Document Container */}
      <div className="flex justify-center py-6 px-4">
        <div className="dc-page p-6 bg-white shadow-xl rounded-sm">
          {/* Header Banner */}
          <div className="text-center pb-3 border-b-2 border-black">
            <div className="text-xs uppercase tracking-wider font-semibold text-gray-700">
              FORM GST - 01 / RULE 55
            </div>
            <h1 className="text-2xl font-black tracking-tight text-gray-950 uppercase mt-0.5">
              DELIVERY CHALLAN
            </h1>
            <div className="text-[11px] font-semibold text-gray-800 tracking-wide mt-0.5">
              (Issued under Rule 55 of Central Goods and Services Tax Rules, 2017)
            </div>
            <div className="inline-block mt-1.5 px-3 py-0.5 rounded border border-gray-900 bg-gray-100 text-[11px] font-bold uppercase">
              NOT FOR SALE · MOVEMENT PURPOSE: {purposeText}
            </div>
          </div>

          {/* Company & Challan Metadata Grid */}
          <div className="grid grid-cols-2 border-b border-black text-xs">
            {/* Left: Consignor (Sender) */}
            <div className="p-3 border-r border-black space-y-1">
              <div className="font-bold uppercase text-gray-600 text-[10px] tracking-wider">Consignor (Issued By):</div>
              <div className="font-black text-base text-gray-950 leading-tight">
                {company?.legalName || challan.fromName}
              </div>
              {company?.tradeName && company.tradeName !== company.legalName && (
                <div className="text-[11px] font-semibold text-gray-700">({company.tradeName})</div>
              )}
              <div className="text-gray-800 text-[11px] leading-snug whitespace-pre-line">
                {challan.fromAddress || company?.address}
              </div>
              <div className="pt-1 text-[11px]">
                <span className="font-bold">GSTIN: </span>
                <span className="font-mono font-bold tracking-wider">{challan.fromGstin || company?.gstin || '–'}</span>
              </div>
              <div className="text-[11px]">
                <span className="font-bold">Place & State: </span>
                <span>{challan.fromPlace}, State Code: {challan.fromStateCode}</span>
              </div>
            </div>

            {/* Right: Challan & Document Details */}
            <div className="p-3 space-y-1.5 bg-gray-50/50">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[10px] font-bold uppercase text-gray-600">Challan No:</div>
                  <div className="font-mono font-black text-sm text-gray-950">{challan.challanNumber}</div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase text-gray-600">Challan Date:</div>
                  <div className="font-bold text-xs text-gray-950">{fmtDate(challan.challanDate)}</div>
                </div>
              </div>

              <div className="pt-1 border-t border-gray-300">
                <div className="text-[10px] font-bold uppercase text-gray-600">Purpose of Supply:</div>
                <div className="font-bold text-xs text-indigo-950">{purposeText}</div>
              </div>

              {challan.ewbNumber && (
                <div className="pt-1 border-t border-gray-300 grid grid-cols-2 gap-2">
                  <div>
                    <div className="text-[10px] font-bold uppercase text-emerald-800">E-Way Bill No:</div>
                    <div className="font-mono font-bold text-xs text-emerald-950">{challan.ewbNumber}</div>
                  </div>
                  <div>
                    <div className="text-[10px] font-bold uppercase text-gray-600">EWB Date:</div>
                    <div className="font-bold text-xs text-gray-950">{fmtDate(challan.ewbDate)}</div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Consignee (To) Details */}
          <div className="border-b border-black p-3 text-xs bg-white">
            <div className="font-bold uppercase text-gray-600 text-[10px] tracking-wider">Consignee (Delivered To / Job Worker / Godown):</div>
            <div className="mt-1 font-black text-sm text-gray-950">{challan.toName}</div>
            <div className="text-gray-800 text-[11px] leading-snug mt-0.5">
              {challan.toAddress}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-6 gap-y-1 text-[11px]">
              <div>
                <span className="font-bold">GSTIN / UIN: </span>
                <span className="font-mono font-bold">{challan.toGstin || 'URP (Unregistered)'}</span>
              </div>
              <div>
                <span className="font-bold">Destination Place: </span>
                <span>{challan.toPlace}</span>
              </div>
              <div>
                <span className="font-bold">Destination Pincode: </span>
                <span>{challan.toPincode}</span>
              </div>
              <div>
                <span className="font-bold">State Code: </span>
                <span>{challan.toStateCode}</span>
              </div>
            </div>
          </div>

          {/* Transport & Vehicle Section */}
          <div className="border-b border-black px-3 py-2 text-xs bg-gray-50 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <Truck className="w-4 h-4 text-gray-700" />
              <span className="font-bold">Vehicle No: </span>
              <span className="font-mono font-bold uppercase text-gray-950 bg-white px-2 py-0.5 border border-gray-400 rounded">
                {challan.vehicleNumber || 'NOT ASSIGNED'}
              </span>
            </div>
            {challan.transporterName && (
              <div>
                <span className="font-bold">Transporter: </span>
                <span>{challan.transporterName}</span>
              </div>
            )}
            <div>
              <span className="font-bold">Mode of Transport: </span>
              <span>{challan.transMode === '1' ? 'Road' : challan.transMode}</span>
            </div>
            {challan.distanceKm > 0 && (
              <div>
                <span className="font-bold">Distance: </span>
                <span>{challan.distanceKm} KM</span>
              </div>
            )}
          </div>

          {/* Itemized Table */}
          <div className="my-0">
            <table>
              <thead>
                <tr>
                  <th style={{ width: '4%' }} className="text-center">#</th>
                  <th style={{ width: '38%' }} className="text-left">Description of Goods</th>
                  <th style={{ width: '10%' }} className="text-center">HSN Code</th>
                  <th style={{ width: '10%' }} className="text-right">Quantity</th>
                  <th style={{ width: '8%' }} className="text-center">Unit</th>
                  <th style={{ width: '15%' }} className="text-right">Taxable Value (₹)</th>
                  <th style={{ width: '15%' }} className="text-right">Total Value (₹)</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, idx) => (
                  <tr key={idx}>
                    <td className="text-center font-mono">{idx + 1}</td>
                    <td className="font-semibold text-gray-900">{it.productName}</td>
                    <td className="text-center font-mono">{it.hsnCode || '–'}</td>
                    <td className="text-right font-mono font-bold">
                      {Number(it.quantity).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="text-center uppercase font-medium">{it.unit || 'KGS'}</td>
                    <td className="text-right font-mono">
                      {Number(it.taxableAmount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="text-right font-mono font-semibold">
                      {Number(it.taxableAmount + (it.cgstAmount || 0) + (it.sgstAmount || 0) + (it.igstAmount || 0)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}

                {items.length < 4 && Array.from({ length: 4 - items.length }).map((_, i) => (
                  <tr key={`fill-${i}`}>
                    <td className="text-center text-transparent">&nbsp;</td>
                    <td>&nbsp;</td>
                    <td>&nbsp;</td>
                    <td>&nbsp;</td>
                    <td>&nbsp;</td>
                    <td>&nbsp;</td>
                    <td>&nbsp;</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-bold bg-gray-100">
                  <td colSpan={3} className="text-right uppercase text-[10px] tracking-wider">Total Quantity & Valuation:</td>
                  <td className="text-right font-mono">
                    {items.reduce((acc, it) => acc + Number(it.quantity || 0), 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </td>
                  <td className="text-center uppercase">KGS</td>
                  <td className="text-right font-mono">
                    ₹{Number(challan.taxableValue || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  <td className="text-right font-mono text-xs">
                    ₹{Number(challan.totalValue || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Amount in Words */}
          <div className="border border-t-0 border-black p-2 text-xs bg-gray-50 flex items-center justify-between">
            <div>
              <span className="font-bold text-[10px] uppercase text-gray-700">Value of Goods (in words): </span>
              <span className="font-bold text-gray-900">{rupeesInWords(totalValNum)}</span>
            </div>
            <div className="font-mono font-bold text-sm text-gray-950">
              Total: {inr(totalValNum)}
            </div>
          </div>

          {/* Terms & Declarations */}
          <div className="border border-t-0 border-black p-3 text-[10px] leading-relaxed text-gray-700 space-y-1">
            <div className="font-bold uppercase text-gray-900 tracking-wider">Statutory Terms & Declaration:</div>
            <p>
              1. This Delivery Challan is issued under <strong>Rule 55 of the CGST Rules, 2017</strong> for the movement of goods without sale.
            </p>
            <p>
              2. Goods dispatched under this Challan are being moved strictly for the purpose indicated above ({purposeText}).
            </p>
            <p>
              3. We declare that this Delivery Challan shows the actual quantity and valuation of the goods described and that all particulars are true and correct.
            </p>
          </div>

          {/* Signatures */}
          <div className="grid grid-cols-2 border border-t-0 border-black text-xs">
            <div className="p-4 border-r border-black flex flex-col justify-between min-h-[90px]">
              <div className="font-bold text-[10px] uppercase text-gray-600">Receiver&apos;s Acknowledgment:</div>
              <div className="pt-8 text-[11px] text-gray-800 border-t border-dashed border-gray-400 flex justify-between">
                <span>Receiver&apos;s Signature & Stamp</span>
                <span>Date: ____________</span>
              </div>
            </div>
            <div className="p-4 flex flex-col justify-between items-end min-h-[90px]">
              <div className="text-right">
                <div className="font-bold text-[11px] text-gray-900">For {company?.tradeName || company?.legalName || challan.fromName}</div>
              </div>
              <div className="w-full pt-8 text-[11px] text-right text-gray-800 border-t border-dashed border-gray-400">
                Authorised Signatory
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
