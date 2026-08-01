import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Printer, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import type { SaleDispatch, CompanyProfile } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/* -------------------------------------------------------------------------- */
/* Surya Road Lines' printed stationery fixed details                       */
/* -------------------------------------------------------------------------- */
const SRL = {
  name: 'SURYA ROAD LINES',
  tagline: 'Transport Contractors & Commission Agents',
  address: 'M.B.T. Road, PUNGANUR - 517 247, Chittoor Dist., A.P.,',
  phones: 'Jagan : 9440216173, 8019152521, Resi.: 9490830413.',
  pan: 'AACBS0915N',
  labourReg: 'AP-10-37-015-0242317',
  udyam: 'UDAYAM AP-02-0002343',
};

const PRODUCT_DESCRIPTION: Record<string, string> = {
  PAPPU: 'Tamarind Seed Pappu',
  HUSK: 'Tamarind Husk',
  WASTE: 'Tamarind Waste',
  TPS: 'Tamarind Seed Brokens',
  SHELL: 'Tamarind Shell',
  PRECLEANER_DUST: 'Pre Cleaner Dust',
  NALLA_POKKULU: 'Nalla Pokkulu',
  NALLA_CHINTAPANDU: 'Nalla Chintapandu',
};

function dmy(d?: string | null): string {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getDate()}/${date.getMonth() + 1}/${String(date.getFullYear()).slice(-2)}`;
}

function isoDay(d?: string | null): string {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

export default function LorryReceiptView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: dispatch, isLoading } = useQuery({
    queryKey: ['sale-dispatch', id],
    queryFn: () => api<SaleDispatch>(`/sale-dispatches/${id}`),
    enabled: !!id,
  });

  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: () => api<CompanyProfile>('/settings/company'),
  });

  const [gcNo, setGcNo] = useState('');
  const [lrDate, setLrDate] = useState('');
  const [bags, setBags] = useState('');
  const [kgPerBag, setKgPerBag] = useState('');

  useEffect(() => {
    if (!dispatch) return;
    setGcNo(dispatch.lrNumber ?? '');
    setLrDate(isoDay(dispatch.lrDate ?? dispatch.invoiceDate ?? dispatch.dispatchDate));
    setBags(dispatch.lrBags != null ? String(dispatch.lrBags) : '');
    setKgPerBag(dispatch.lrKgPerBag != null ? String(dispatch.lrKgPerBag) : '');
  }, [dispatch]);

  const save = useMutation({
    mutationFn: () =>
      api<SaleDispatch>(`/sale-dispatches/${id}/lorry-receipt`, {
        method: 'PATCH',
        body: {
          lrNumber: gcNo || null,
          lrDate: lrDate || null,
          lrBags: bags === '' ? null : Number(bags),
          lrKgPerBag: kgPerBag === '' ? null : Number(kgPerBag),
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sale-dispatch', id] });
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      toast.success('Lorry receipt details saved');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  if (isLoading || !dispatch || !company) {
    return <div className="p-8 text-center text-muted-foreground animate-pulse">Loading lorry receipt…</div>;
  }

  const order = dispatch.saleOrder;
  const buyer = order?.buyer;

  const description = PRODUCT_DESCRIPTION[order?.product ?? 'PAPPU'] ?? 'Tamarind Seed Pappu';
  const fromPlace = (company.dispatchFromPlace || company.stateName || 'PUNGANUR').toUpperCase();
  const toPlace = (order?.destination || buyer?.city || buyer?.state || '').toUpperCase();
  const truckNo = dispatch.vehicleNumber ?? '';
  const gcDate = dmy(lrDate || dispatch.invoiceDate || dispatch.dispatchDate);

  const consignorAddress = company.address ?? '';
  const consigneeAddress = [buyer?.address, [buyer?.city, buyer?.state, buyer?.pincode].filter(Boolean).join(', ')]
    .filter(Boolean)
    .join('\n');

  return (
    <div className="min-h-screen bg-[#f4f2eb] flex flex-col font-sans">
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; background-color: white !important; }
          .lr-no-print { display: none !important; }
          .lr-print-area { margin: 0 !important; padding: 0 !important; box-shadow: none !important; width: 100% !important; max-width: none !important; }
          @page { size: A4 portrait; margin: 6mm; }
        }
      `}} />

      {/* Toolbar (Screen only) */}
      <div className="lr-no-print sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b bg-background px-4 py-2 shadow-sm">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
          <span className="ml-2 flex items-center gap-1 text-sm font-semibold text-[#0b2b5a]">
            <FileText className="h-4 w-4" /> Surya Road Lines — Lorry Receipt (GC)
          </span>
        </div>
        <Button size="sm" className="bg-[#0b2b5a] hover:bg-[#081e40] text-white" onClick={() => window.print()}>
          <Printer className="h-4 w-4 mr-1" /> Print Lorry Receipt
        </Button>
      </div>

      {/* Form Bar */}
      <div className="lr-no-print grid grid-cols-2 gap-3 border-b bg-background px-4 py-3 sm:grid-cols-5 sm:items-end">
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-[#0b2b5a]">G.C. No.</Label>
          <Input value={gcNo} onChange={(e) => setGcNo(e.target.value)} placeholder="e.g. 55" className="h-8 border-[#0b2b5a]/30 focus:border-[#0b2b5a]" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-[#0b2b5a]">GC Date</Label>
          <Input type="date" value={lrDate} onChange={(e) => setLrDate(e.target.value)} className="h-8 border-[#0b2b5a]/30 focus:border-[#0b2b5a]" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-[#0b2b5a]">Bags</Label>
          <Input type="number" min="0" value={bags} onChange={(e) => setBags(e.target.value)} placeholder="e.g. 600" className="h-8 border-[#0b2b5a]/30 focus:border-[#0b2b5a]" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-[#0b2b5a]">Each Bag (Kgs)</Label>
          <Input type="number" min="0" value={kgPerBag} onChange={(e) => setKgPerBag(e.target.value)} placeholder="e.g. 50" className="h-8 border-[#0b2b5a]/30 focus:border-[#0b2b5a]" />
        </div>
        <Button size="sm" variant="outline" className="h-8 border-[#0b2b5a] text-[#0b2b5a] hover:bg-[#0b2b5a]/5" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save Details'}
        </Button>
      </div>

      {/* Main Print Container - Portrait A4 Sheet Format */}
      <div className="flex justify-center bg-[#f4f2eb] py-6 lr-print-area">
        <div className="lr-print-area relative w-[210mm] min-h-[285mm] bg-[#fcfbf7] p-[6mm] text-[#0b2b5a] shadow-md ring-1 ring-neutral-300 font-serif text-[11px] leading-tight">
          
          {/* Outer Deep Navy Blue Border */}
          <div className="border-[2.5px] border-[#0b2b5a] flex flex-col h-full bg-[#fcfbf7]">

            {/* ── MASTHEAD HEADER (Full Width Top) ────────────────────────── */}
            <div className="border-b-[2.5px] border-[#0b2b5a] p-2 flex items-center justify-between gap-2">
              {/* Top Left: Ganesha Image */}
              <div className="w-[75px] flex justify-center items-center">
                <img 
                  src="/ganesha-original.jpg" 
                  alt="Ganesha" 
                  className="h-[76px] w-[68px] object-contain mix-blend-multiply filter contrast-150 brightness-75"
                />
              </div>

              {/* Center Masthead Text */}
              <div className="flex-1 text-center space-y-0.5">
                <div className="flex items-center justify-center gap-1">
                  <span className="inline-flex h-[18px] w-[26px] items-center justify-center rounded-full border border-[#0b2b5a] text-[9px] font-black font-sans">
                    SRL
                  </span>
                  <span className="text-[9.5px] italic font-semibold">Subject to Punganur Jurisdiction</span>
                </div>

                <div className="font-sans text-[26px] font-black tracking-tight leading-none text-[#0b2b5a] uppercase pt-0.5">
                  {SRL.name}
                </div>

                <div className="border border-[#0b2b5a] px-2 py-[1px] text-[9.5px] font-bold inline-block">
                  {SRL.tagline}
                </div>

                <div className="text-[10px] font-bold leading-tight pt-0.5">
                  {SRL.address}
                </div>

                <div className="text-[9.5px] font-bold leading-tight">
                  {SRL.phones}
                </div>
              </div>

              {/* Top Right: Balaji Image */}
              <div className="w-[75px] flex justify-center items-center">
                <img 
                  src="/balaji-original.jpg" 
                  alt="Balaji" 
                  className="h-[76px] w-[68px] object-contain mix-blend-multiply filter contrast-150 brightness-75"
                />
              </div>
            </div>

            {/* ── 3-COLUMN MIDDLE SECTION ───────────────────────────────── */}
            <div className="flex border-b-[2.5px] border-[#0b2b5a] text-[8.5px] leading-tight">
              {/* Col 1: Registrations & Caution */}
              <div className="w-[30%] border-r-[2px] border-[#0b2b5a] p-1.5 space-y-1">
                <div className="font-sans text-[8px] font-semibold space-y-0.5">
                  <div>PAN CARD : <span className="font-bold">{SRL.pan}</span></div>
                  <div>LABOUR Reg. No. : <span className="font-bold">{SRL.labourReg}</span></div>
                  <div>msme UDAYAM Reg. No.: <span className="font-bold">{SRL.udyam}</span></div>
                </div>

                <div className="border border-[#0b2b5a] p-1 bg-[#f7f5ed] mt-1">
                  <div className="font-bold text-center uppercase tracking-wider text-[8.5px] mb-0.5">Caution</div>
                  <div>This Consignment will not detained</div>
                  <div>Re routed or booked without consignee</div>
                  <div>Banks written promission will be</div>
                  <div>delivered at the destinaltion</div>
                </div>
              </div>

              {/* Col 2: Consignor Risk & Insurance */}
              <div className="w-[32%] border-r-[2px] border-[#0b2b5a] p-1.5 flex flex-col justify-between">
                <div>
                  <div className="text-center font-bold text-[9px] leading-snug">
                    CONSIGNOR&apos;S COPY<br />
                    AT OWNERS RISK<br />
                    INSURANCE
                  </div>
                  <div className="mt-1 border-t border-[#0b2b5a]/40 pt-1 text-justify text-[8px]">
                    The Customer has stated that the has not insurance the consignment or he has insured the consignment.
                  </div>
                  <div className="mt-1 space-y-0.5 text-[8px]">
                    <div>Company:.........................................</div>
                    <div>Policy No.:......................................</div>
                    <div>Amount:..........................................</div>
                    <div>Risk:............................................</div>
                  </div>
                </div>
              </div>

              {/* Col 3: NOTE Paragraph & GC No */}
              <div className="w-[38%] p-1.5 flex flex-col justify-between">
                <div className="text-justify text-[8.5px] leading-snug">
                  <span className="font-bold">NOTE :</span> This Consignment covered by this of special lorry receipt from shall be stored at the destination under control of the Transport order and shall be delivered to order of then consignee bank whose name mentioned in the lorry receipt it will under no circumstance be delivered to any one without the written authority from the consignee copy or on a separate letter of Authority.
                </div>
                <div className="border-t border-[#0b2b5a] pt-1 flex items-center justify-between mt-1">
                  <span className="font-bold font-serif text-[11px]">G.C. No.</span>
                  <span className="text-[20px] font-black text-[#cc1111] tracking-wider leading-none">
                    {gcNo || '────'}
                  </span>
                </div>
              </div>
            </div>

            {/* ── ADDRESSES & ROUTE SECTION ─────────────────────────────── */}
            <div className="flex border-b-[2.5px] border-[#0b2b5a]">
              {/* Left: Consignor & Consignee */}
              <div className="w-[62%] border-r-[2px] border-[#0b2b5a] flex flex-col">
                <div className="flex-1 border-b border-[#0b2b5a] p-1.5 min-h-[72px]">
                  <div className="text-[9px] font-bold underline">Consignors Name &amp; Address :</div>
                  <div className="mt-1 whitespace-pre-line font-sans text-[10.5px] font-bold uppercase leading-snug tracking-tight">
                    {company.name}
                    {consignorAddress ? `\n${consignorAddress}` : ''}
                  </div>
                </div>
                <div className="flex-1 p-1.5 min-h-[72px]">
                  <div className="text-[9px] font-bold underline">Consignee Name &amp; Address :</div>
                  <div className="mt-1 whitespace-pre-line font-sans text-[10.5px] font-bold uppercase leading-snug tracking-tight">
                    {buyer?.name ?? ''}
                    {consigneeAddress ? `\n${consigneeAddress}` : ''}
                  </div>
                </div>
              </div>

              {/* Right: Invoice No, Date, Truck, From, To, Freight */}
              <div className="w-[38%] font-sans text-[10px] flex flex-col justify-between">
                <div className="border-b border-[#0b2b5a] px-2 py-1 flex justify-between">
                  <span className="font-semibold text-[9.5px]">Invoice No.:</span>
                  <span className="font-bold text-[10.5px]">{dispatch.invoiceNumber ?? '────'}</span>
                </div>
                <div className="border-b border-[#0b2b5a] px-2 py-1 flex justify-between">
                  <span className="font-semibold text-[9.5px]">DATE:</span>
                  <span className="font-bold text-[10.5px]">{gcDate || '────'}</span>
                </div>
                <div className="border-b border-[#0b2b5a] px-2 py-1 flex justify-between">
                  <span className="font-semibold text-[9.5px]">TRUCK NO.</span>
                  <span className="font-bold text-[10.5px] uppercase">{truckNo || '────'}</span>
                </div>
                <div className="border-b border-[#0b2b5a] px-2 py-1 flex justify-between">
                  <span className="font-semibold text-[9.5px]">FROM</span>
                  <span className="font-bold text-[10.5px] uppercase">{fromPlace}</span>
                </div>
                <div className="border-b border-[#0b2b5a] px-2 py-1 flex justify-between">
                  <span className="font-semibold text-[9.5px]">TO</span>
                  <span className="font-bold text-[10.5px] uppercase">{toPlace}</span>
                </div>
                <div className="border-b border-[#0b2b5a] py-0.5 text-center text-[10px] font-black font-serif uppercase tracking-widest bg-[#f4f1e6]">
                  FREIGHT
                </div>
                <div className="flex text-[9px] font-bold text-center">
                  <div className="w-1/2 border-r border-[#0b2b5a] py-0.5">Paid</div>
                  <div className="w-1/2 py-0.5">To Pay</div>
                </div>
              </div>
            </div>

            {/* ── GOODS TABLE GRID ──────────────────────────────────────── */}
            <div className="flex border-b-[2.5px] border-[#0b2b5a] text-[9.5px] min-h-[120px]">
              <div className="w-[18%] border-r border-[#0b2b5a] flex flex-col">
                <div className="border-b border-[#0b2b5a] py-1 text-center font-bold font-serif text-[10px]">Package</div>
                <div className="p-1.5 space-y-1 leading-snug flex-1">
                  <div><span className="font-sans font-bold text-[11px]">{bags || '────'}</span> Bags</div>
                  <div className="text-[9px]">Each Bag</div>
                  <div><span className="font-sans font-bold text-[11px]">{kgPerBag || '────'}</span> Kgs.</div>
                </div>
              </div>

              <div className="w-[30%] border-r border-[#0b2b5a] flex flex-col">
                <div className="border-b border-[#0b2b5a] py-1 text-center font-bold font-serif text-[10px] leading-tight">
                  Descriptions<br />said to contain
                </div>
                <div className="p-1.5 leading-snug flex-1">
                  <div className="line-through text-[#0b2b5a]/60 text-[9px]">FEED</div>
                  <div className="font-sans text-[11px] font-bold text-[#0b2b5a] uppercase">{description}</div>
                </div>
              </div>

              <div className="w-[18%] border-r border-[#0b2b5a] flex flex-col">
                <div className="border-b border-[#0b2b5a] py-1 text-center font-bold font-serif text-[10px]">Freight</div>
                <div className="p-1.5 space-y-1 leading-snug flex-1 text-[9px]">
                  <div>Per Bag</div>
                  <div>Lorry Freight</div>
                  <div>Rs. ________</div>
                </div>
              </div>

              <div className="w-[34%] flex">
                {['Paid', 'To Pay'].map((col) => (
                  <div key={col} className="flex w-1/2 flex-col border-r border-[#0b2b5a] last:border-r-0">
                    <div className="flex border-b border-[#0b2b5a] text-[8.5px] font-bold text-center">
                      <div className="w-2/3 border-r border-[#0b2b5a] py-0.5">Rs.</div>
                      <div className="w-1/3 py-0.5">Ps.</div>
                    </div>
                    <div className="flex flex-1">
                      <div className="w-2/3 border-r border-[#0b2b5a]" />
                      <div className="w-1/3" />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── RUPEES IN WORDS & CHARGES SUMMARY ─────────────────────── */}
            <div className="flex border-b-[2.5px] border-[#0b2b5a] text-[9.5px]">
              <div className="w-[48%] border-r border-[#0b2b5a] p-1.5 flex flex-col justify-between">
                <div>
                  <div className="font-semibold text-[9px]">To pay Lorry freight Rupees in words</div>
                  <div className="mt-1 text-[8.5px] tracking-widest text-[#0b2b5a]/50">.........................................................................</div>
                  <div className="mt-1 text-[8.5px] tracking-widest text-[#0b2b5a]/50">.........................................................................</div>
                </div>
                <div className="text-[8.5px] italic font-semibold mt-1">Unloading by Party</div>
              </div>

              <div className="w-[18%] border-r border-[#0b2b5a] font-serif font-bold text-[9.5px]">
                <div className="border-b border-[#0b2b5a] px-1.5 py-1">Hamali</div>
                <div className="border-b border-[#0b2b5a] px-1.5 py-1">GC Charges</div>
                <div className="px-1.5 py-1 text-[10px] font-black uppercase">TOTAL</div>
              </div>

              <div className="w-[34%] flex">
                {['Paid', 'To Pay'].map((col) => (
                  <div key={col} className="flex w-1/2 flex-col border-r border-[#0b2b5a] last:border-r-0">
                    {[0, 1, 2].map((row) => (
                      <div key={row} className={`flex flex-1 ${row < 2 ? 'border-b border-[#0b2b5a]' : ''}`}>
                        <div className="w-2/3 border-r border-[#0b2b5a] py-1" />
                        <div className="w-1/3 py-1" />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            {/* ── FOOTER NOTES & SIGNATURES ──────────────────────────────── */}
            <div className="p-2 flex flex-col justify-between flex-1">
              <div className="flex items-start justify-between gap-4 text-[8.5px] leading-tight">
                <div className="space-y-0.5 flex-1">
                  <div className="text-justify">
                    <span className="font-bold underline">Note :</span> Our leakage and damage we are not responsible. Insurance to be covered by the party. Any claim towards damage/shortage etc., should not settled with Driver at the unloading it self later date no complaint will be entertained by us.
                  </div>
                  <div className="font-bold">
                    <span className="underline">Note :</span> WE ARE NOT COLLECTING ANY GST AMOUNT TO PARTY.
                  </div>
                </div>
                <div className="w-[30%] text-right font-bold text-[11px] font-serif pt-1">
                  For Surya Road Lines
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-[#0b2b5a]/40 pt-1 mt-3 text-[9.5px] font-semibold">
                <div>Driver&apos;s Name : <span className="font-bold uppercase font-sans text-[10.5px]">{dispatch.driverName ?? ''}</span></div>
                <div className="pr-4">D.L. No. :</div>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
