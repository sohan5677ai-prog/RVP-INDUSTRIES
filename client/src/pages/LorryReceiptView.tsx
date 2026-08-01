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

/* ── Vector Illustrations matching original receipt pictures ────────────── */

/** Seated Ganesha line-art matching the original receipt (Image 5). */
function Ganesha({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 120" className={className} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {/* Mukut / Crown */}
      <path d="M50 4 L44 18 H56 Z" fill="currentColor" fillOpacity="0.1" />
      <path d="M41 18 C41 18 50 12 59 18 M42 22 C42 22 50 16 58 22" />
      <path d="M36 26 C43 21 57 21 64 26 L66 32 C55 27 45 27 34 32 Z" />
      <line x1="50" y1="4" x2="50" y2="18" />
      
      {/* Ears */}
      <path d="M35 32 C18 28 14 44 17 56 C20 66 32 60 34 52" />
      <path d="M65 32 C82 28 86 44 83 56 C80 66 68 60 66 52" />
      
      {/* Face & Tilak */}
      <path d="M35 32 C45 28 55 28 65 32 C68 46 62 54 50 56 C38 54 32 46 35 32 Z" />
      <path d="M47 34 C47 31 53 31 53 34 C53 40 50 44 50 44 C50 44 47 40 47 34 Z" fill="currentColor" />
      <circle cx="43" cy="40" r="1.5" fill="currentColor" />
      <circle cx="57" cy="40" r="1.5" fill="currentColor" />
      
      {/* Tusks & Trunk */}
      <path d="M42 50 L36 53" />
      <path d="M58 50 L64 53" />
      <path d="M50 54 C54 66 42 70 42 78 C42 85 52 86 56 82 C59 79 57 74 52 75 C48 76 48 80 52 80" strokeWidth="1.8" />
      <path d="M63 76 C65 74 68 76 66 79 C64 81 61 79 63 76 Z" fill="currentColor" /> {/* Laddu */}

      {/* Body, Belly & Arms */}
      <path d="M31 54 C22 62 20 76 25 86 C30 92 38 88 38 84" />
      <path d="M69 54 C78 62 80 76 75 86 C70 92 62 88 62 84" />
      <path d="M36 68 C28 78 35 96 50 96 C65 96 72 78 64 68" />
      <path d="M44 72 C44 72 50 75 56 72" />
      
      {/* Seated Base / Lotus */}
      <path d="M22 96 C35 106 65 106 78 96" />
      <path d="M18 102 C35 116 65 116 82 102" />
      <path d="M26 108 C40 118 60 118 74 108" />
    </svg>
  );
}

/** Lord Venkateswara (Tirumala Balaji) Deity line-art matching original receipt. */
function DeityArch({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 90 120" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {/* Outer Temple Arch (Prabhavavali) */}
      <path d="M45 4 C12 22 10 98 10 114 H80 C80 98 78 22 45 4 Z" strokeWidth="1.8" />
      <path d="M45 10 C18 27 16 94 16 110 H74 C74 94 72 27 45 10 Z" />
      
      {/* Arch Flame Top Decorative Finial (Kirtimukha) */}
      <circle cx="45" cy="14" r="3" fill="currentColor" />
      
      {/* Crown (Kiritam) */}
      <path d="M34 40 L45 22 L56 40 Z" fill="currentColor" fillOpacity="0.1" />
      <path d="M32 40 H58 M35 34 H55 M38 28 H52" />
      
      {/* Face & Sacred Namam */}
      <path d="M35 40 C35 40 45 36 55 40 C57 54 53 62 45 64 C37 62 33 54 35 40 Z" />
      {/* U-Shaped Tiruman & Kasturi Tilak */}
      <path d="M40 42 L38 56 M50 42 L52 56 M45 46 L45 57" strokeWidth="2" />
      
      {/* Shankh (Conch) & Chakra (Discus) on Upper Hands */}
      <path d="M22 46 C20 40 28 38 28 46 C28 50 22 52 22 46 Z" /> {/* Chakra left */}
      <path d="M68 46 C66 40 74 38 74 46 C74 50 68 52 68 46 Z" /> {/* Shankh right */}
      <path d="M26 50 L34 56 M64 56 L70 50" strokeWidth="1.8" />
      
      {/* Main Body, Garlands & Lower Hands */}
      <path d="M33 64 C26 72 26 94 30 106 H60 C64 94 64 72 57 64 Z" />
      {/* Heavy Flower Garland (Vanamali) */}
      <path d="M30 60 C24 74 24 100 45 104 C66 100 66 74 60 60" strokeWidth="2" />
      <path d="M35 64 C30 76 30 94 45 98 C60 94 60 76 55 64" />
      
      {/* Lower Hand gestures (Varada & Kati Hasta) */}
      <path d="M34 68 C38 74 42 78 45 80" />
      <path d="M56 68 C52 74 48 78 45 80" />
      
      {/* Base / Lotus pedestal */}
      <path d="M20 106 H70 M16 110 H74" strokeWidth="1.8" />
    </svg>
  );
}

/** Devotional Roundels stamped along the top of the header. */
function Roundel({ glyph }: { glyph: string }) {
  return (
    <span className="inline-flex h-[20px] w-[20px] items-center justify-center rounded-full border border-current text-[11px] font-bold leading-none">
      {glyph}
    </span>
  );
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
          @page { size: A4 landscape; margin: 5mm; }
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

      {/* Transporter Details Form Bar */}
      <div className="lr-no-print grid grid-cols-2 gap-3 border-b bg-background px-4 py-3 sm:grid-cols-5 sm:items-end">
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-[#0b2b5a]">G.C. No.</Label>
          <Input value={gcNo} onChange={(e) => setGcNo(e.target.value)} placeholder="e.g. 51" className="h-8 border-[#0b2b5a]/30 focus:border-[#0b2b5a]" />
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

      {/* Main Print Container matching physical stationery format */}
      <div className="flex justify-center bg-[#f4f2eb] py-6 lr-print-area">
        <div className="lr-print-area relative w-[275mm] min-h-[190mm] bg-[#fbf9f4] p-[5mm] text-[#0b2b5a] shadow-md ring-1 ring-neutral-300 font-serif text-[11px] leading-tight">
          
          {/* Outer Deep Navy Blue Border */}
          <div className="border-[2.5px] border-[#0b2b5a] flex flex-col h-full bg-[#fbf9f4]">

            {/* Top Container: Sidebar on Left, Content Grid on Right */}
            <div className="flex flex-1 border-b-[2.5px] border-[#0b2b5a]">

              {/* ── LEFT SIDEBAR (Transporter Header, Info & Deities) ──────── */}
              <div className="w-[23%] border-r-[2.5px] border-[#0b2b5a] flex flex-col justify-between p-1.5 bg-[#fcfbf7]">
                
                <div className="space-y-1.5 text-center">
                  {/* Devotional Roundels */}
                  <div className="flex items-center justify-center gap-1.5 text-[#0b2b5a]">
                    <Roundel glyph="ॐ" />
                    <Roundel glyph="श्री" />
                    <Roundel glyph="ॐ" />
                  </div>

                  {/* SRL Jurisdiction Badge */}
                  <div className="flex items-center justify-center gap-1 pt-0.5">
                    <span className="inline-flex h-[16px] w-[24px] items-center justify-center rounded-full border border-[#0b2b5a] text-[8.5px] font-extrabold tracking-tight font-sans">
                      SRL
                    </span>
                    <span className="text-[8.5px] italic font-semibold">Subject to Punganur Jurisdiction</span>
                  </div>

                  {/* Big Transporter Brand Title */}
                  <div className="font-sans text-[20px] font-black tracking-tight leading-none text-[#0b2b5a] uppercase pt-1">
                    {SRL.name}
                  </div>
                  
                  {/* Tagline */}
                  <div className="border border-[#0b2b5a] px-1 py-[1px] text-[8.5px] font-bold tracking-tight inline-block">
                    {SRL.tagline}
                  </div>

                  {/* Address & Phone */}
                  <div className="text-[8.5px] font-bold leading-tight pt-0.5">
                    {SRL.address}
                  </div>
                  <div className="text-[8px] font-bold leading-tight border-b border-[#0b2b5a]/40 pb-1">
                    {SRL.phones}
                  </div>

                  {/* Registrations Block */}
                  <div className="text-[8px] leading-tight space-y-0.5 text-left font-sans pt-0.5 font-semibold">
                    <div>PAN CARD : <span className="font-bold">{SRL.pan}</span></div>
                    <div>LABOUR Reg. No. : <span className="font-bold">{SRL.labourReg}</span></div>
                    <div>msme UDAYAM Reg. No.: <span className="font-bold">{SRL.udyam}</span></div>
                  </div>

                  {/* Caution Block */}
                  <div className="border border-[#0b2b5a] p-1 text-[7.5px] leading-tight text-left mt-1 bg-[#f7f5ed]">
                    <div className="font-bold text-center uppercase tracking-wider text-[8.5px] mb-0.5">Caution</div>
                    <div>This Consignment will not detained</div>
                    <div>Re routed or booked without consignee</div>
                    <div>Banks written promission will be</div>
                    <div>delivered at the destinaltion</div>
                  </div>
                </div>

                {/* Bottom Deity Illustrations (Venkateswara Balaji & Ganesha) */}
                <div className="flex items-end justify-between pt-2 border-t border-[#0b2b5a]/30 mt-2 px-1">
                  <DeityArch className="h-[68px] w-[46px] text-[#0b2b5a]" />
                  <Ganesha className="h-[68px] w-[50px] text-[#0b2b5a]" />
                </div>
              </div>

              {/* ── RIGHT MAIN SECTION ───────────────────────────────────── */}
              <div className="w-[77%] flex flex-col">

                {/* Row 1: Consignor Copy / Insurance & Note Paragraph */}
                <div className="flex border-b-[2px] border-[#0b2b5a] text-[8.5px] leading-[1.25]">
                  {/* Left: Consignor Risk Box */}
                  <div className="w-[45%] border-r-[2px] border-[#0b2b5a] p-1.5">
                    <div className="text-center font-bold leading-[1.2]">
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

                  {/* Right: NOTE Paragraph */}
                  <div className="w-[55%] p-1.5 text-justify text-[8.5px] leading-snug">
                    <span className="font-bold">NOTE :</span> This Consignment covered by this of special lorry receipt from shall be stored at the destination under control of the Transport order and shall be delivered to order of then consignee bank whose name mentioned in the lorry receipt it will under no circumstance be delivered to any one without the written authority from the consignee copy or on a separate letter of Authority.
                  </div>
                </div>

                {/* Row 2: Consignor & Consignee vs. GC No & Route Info */}
                <div className="flex border-b-[2px] border-[#0b2b5a]">
                  {/* Consignor & Consignee Addresses */}
                  <div className="w-[58%] border-r-[2px] border-[#0b2b5a] flex flex-col">
                    <div className="flex-1 border-b border-[#0b2b5a] p-1.5">
                      <div className="text-[9px] font-bold underline">Consignors Name &amp; Address :</div>
                      <div className="mt-1 whitespace-pre-line font-sans text-[10.5px] font-bold uppercase leading-snug tracking-tight">
                        {company.name}
                        {consignorAddress ? `\n${consignorAddress}` : ''}
                      </div>
                    </div>
                    <div className="flex-1 p-1.5">
                      <div className="text-[9px] font-bold underline">Consignee Name &amp; Address :</div>
                      <div className="mt-1 whitespace-pre-line font-sans text-[10.5px] font-bold uppercase leading-snug tracking-tight">
                        {buyer?.name ?? ''}
                        {consigneeAddress ? `\n${consigneeAddress}` : ''}
                      </div>
                    </div>
                  </div>

                  {/* GC No, Date, Truck, Route & Freight Column */}
                  <div className="w-[42%] font-sans text-[10px]">
                    <div className="border-b border-[#0b2b5a] px-2 py-1 flex items-center justify-between">
                      <span className="font-bold font-serif text-[11px]">G.C. No.</span>
                      <span className="text-[18px] font-black text-[#cc1111] tracking-wider leading-none">
                        {gcNo || '────'}
                      </span>
                    </div>
                    <div className="border-b border-[#0b2b5a] px-2 py-0.5 flex justify-between">
                      <span className="font-semibold text-[9.5px]">Invoice No.:</span>
                      <span className="font-bold text-[10.5px]">{dispatch.invoiceNumber ?? '────'}</span>
                    </div>
                    <div className="border-b border-[#0b2b5a] px-2 py-0.5 flex justify-between">
                      <span className="font-semibold text-[9.5px]">DATE:</span>
                      <span className="font-bold text-[10.5px]">{gcDate || '────'}</span>
                    </div>
                    <div className="border-b border-[#0b2b5a] px-2 py-0.5 flex justify-between">
                      <span className="font-semibold text-[9.5px]">TRUCK NO.</span>
                      <span className="font-bold text-[10.5px] uppercase">{truckNo || '────'}</span>
                    </div>
                    <div className="border-b border-[#0b2b5a] px-2 py-0.5 flex justify-between">
                      <span className="font-semibold text-[9.5px]">FROM</span>
                      <span className="font-bold text-[10.5px] uppercase">{fromPlace}</span>
                    </div>
                    <div className="border-b border-[#0b2b5a] px-2 py-0.5 flex justify-between">
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

                {/* Row 3: Goods & Freight Grid Table */}
                <div className="flex flex-1 border-b-[2px] border-[#0b2b5a] text-[9.5px]">
                  {/* Package Column */}
                  <div className="w-[18%] border-r border-[#0b2b5a] flex flex-col">
                    <div className="border-b border-[#0b2b5a] py-1 text-center font-bold font-serif text-[10px]">Package</div>
                    <div className="p-1.5 space-y-1 leading-snug flex-1">
                      <div><span className="font-sans font-bold text-[11px]">{bags || '────'}</span> Bags</div>
                      <div className="text-[9px]">Each Bag</div>
                      <div><span className="font-sans font-bold text-[11px]">{kgPerBag || '────'}</span> Kgs.</div>
                    </div>
                  </div>

                  {/* Descriptions Said to Contain Column */}
                  <div className="w-[30%] border-r border-[#0b2b5a] flex flex-col">
                    <div className="border-b border-[#0b2b5a] py-1 text-center font-bold font-serif text-[10px] leading-tight">
                      Descriptions<br />said to contain
                    </div>
                    <div className="p-1.5 leading-snug flex-1">
                      <div className="line-through text-[#0b2b5a]/60 text-[9px]">FEED</div>
                      <div className="font-sans text-[11px] font-bold text-[#0b2b5a] uppercase">{description}</div>
                    </div>
                  </div>

                  {/* Freight Column */}
                  <div className="w-[18%] border-r border-[#0b2b5a] flex flex-col">
                    <div className="border-b border-[#0b2b5a] py-1 text-center font-bold font-serif text-[10px]">Freight</div>
                    <div className="p-1.5 space-y-1 leading-snug flex-1 text-[9px]">
                      <div>Per Bag</div>
                      <div>Lorry Freight</div>
                      <div>Rs. ________</div>
                    </div>
                  </div>

                  {/* Money Grid (Paid | To Pay) */}
                  <div className="w-[34%] flex">
                    {['Paid', 'To Pay'].map((col) => (
                      <div key={col} className="flex w-1/2 flex-col border-r border-[#0b2b5a] last:border-r-0">
                        <div className="flex border-b border-[#0b2b5a] text-[8.5px] font-bold text-center">
                          <div className="w-2/3 border-r border-[#0b2b5a] py-0.5">Rs.</div>
                          <div className="w-1/3 py-0.5">Ps.</div>
                        </div>
                        <div className="flex flex-1 min-h-[45px]">
                          <div className="w-2/3 border-r border-[#0b2b5a]" />
                          <div className="w-1/3" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Row 4: Freight in Words + Hamali / GC Charges / Total */}
                <div className="flex border-b-[2px] border-[#0b2b5a] text-[9.5px]">
                  {/* Left: Freight in words */}
                  <div className="w-[48%] border-r border-[#0b2b5a] p-1.5 flex flex-col justify-between">
                    <div>
                      <div className="font-semibold text-[9px]">To pay Lorry freight Rupees in words</div>
                      <div className="mt-1 text-[8.5px] tracking-widest text-[#0b2b5a]/50">.........................................................................</div>
                      <div className="mt-1 text-[8.5px] tracking-widest text-[#0b2b5a]/50">.........................................................................</div>
                    </div>
                    <div className="text-[8.5px] italic font-semibold mt-1">Unloading by Party</div>
                  </div>

                  {/* Middle: Charge Headings */}
                  <div className="w-[18%] border-r border-[#0b2b5a] font-serif font-bold text-[9.5px]">
                    <div className="border-b border-[#0b2b5a] px-1.5 py-1">Hamali</div>
                    <div className="border-b border-[#0b2b5a] px-1.5 py-1">GC Charges</div>
                    <div className="px-1.5 py-1 text-[10px] font-black uppercase">TOTAL</div>
                  </div>

                  {/* Right: Paid / To Pay Money Boxes */}
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

                {/* Row 5: Footer Notes & Signature */}
                <div className="p-1.5 flex flex-col justify-between flex-1">
                  <div className="flex items-start justify-between gap-4 text-[8px] leading-tight">
                    <div className="space-y-0.5 flex-1">
                      <div className="text-justify">
                        <span className="font-bold underline">Note :</span> Our leakage and damage we are not responsible. Insurance to be covered by the party. Any claim towards damage/shortage etc., should not settled with Driver at the unloading it self later date no complaint will be entertained by us.
                      </div>
                      <div className="font-bold">
                        <span className="underline">Note :</span> WE ARE NOT COLLECTING ANY GST AMOUNT TO PARTY.
                      </div>
                    </div>
                    <div className="w-[30%] text-right font-bold text-[10.5px] font-serif pt-1">
                      For Surya Road Lines
                    </div>
                  </div>

                  <div className="flex items-center justify-between border-t border-[#0b2b5a]/40 pt-1 mt-2 text-[9px] font-semibold">
                    <div>Driver&apos;s Name : <span className="font-bold uppercase font-sans text-[10px]">{dispatch.driverName ?? ''}</span></div>
                    <div className="pr-4">D.L. No. :</div>
                  </div>
                </div>

              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
