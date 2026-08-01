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
/* Surya Road Lines' own printed stationery. These are the transporter's fixed
/* details, not ours — they belong to the form, not to Settings.               */
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

/** What the pre-printed "said to contain" line should read for each commodity. */
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

/** The book writes dates as 30/5/26 — day/month/2-digit year, no padding. */
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

/* ── Emblems printed across the top of the book ──────────────────────────── */

/** Seated Ganesha line-art, top-left of the form. */
function Ganesha({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 118" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {/* crown */}
      <circle cx="50" cy="6" r="2.6" fill="currentColor" stroke="none" />
      <path d="M50 9 L44 21 M50 9 L56 21" />
      <path d="M37 24 Q50 13 63 24" />
      {/* ears */}
      <path d="M34 31 Q20 28 18 42 Q17 56 33 51" />
      <path d="M66 31 Q80 28 82 42 Q83 56 67 51" />
      {/* head */}
      <path d="M34 30 Q50 21 66 30 Q69 44 62 52 Q50 60 38 52 Q31 44 34 30 Z" />
      {/* eyes + tilak */}
      <circle cx="43" cy="37" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="57" cy="37" r="1.5" fill="currentColor" stroke="none" />
      <path d="M50 26 L50 32" />
      {/* tusks */}
      <path d="M42 47 L37 55" />
      <path d="M58 47 L63 55" />
      {/* trunk */}
      <path d="M50 45 Q53 59 45 65 Q36 71 38 79 Q40 86 48 84" />
      {/* body + belly */}
      <path d="M33 60 Q29 82 33 97" />
      <path d="M67 60 Q71 82 67 97" />
      <path d="M38 82 Q50 74 62 82 Q62 93 50 95 Q38 93 38 82 Z" />
      {/* arms */}
      <path d="M34 63 Q21 70 23 84" />
      <path d="M66 63 Q79 70 77 84" />
      {/* seated base / lotus */}
      <path d="M26 97 Q50 110 74 97" />
      <path d="M22 101 Q50 116 78 101" />
    </svg>
  );
}

/** Deity in a temple arch, top-right of the form. */
function DeityArch({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 80 118" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {/* arch */}
      <path d="M40 4 Q8 26 8 114 L72 114 Q72 26 40 4 Z" />
      <path d="M40 12 Q15 31 15 108 L65 108 Q65 31 40 12" />
      {/* crown */}
      <path d="M31 40 Q40 26 49 40 Z" />
      {/* face + namam */}
      <path d="M31 42 Q40 36 49 42 Q51 56 40 62 Q29 56 31 42 Z" />
      <path d="M37 45 L35 57 M43 45 L45 57 M40 47 L40 57" />
      {/* arms + body */}
      <path d="M31 64 Q24 72 26 92" />
      <path d="M49 64 Q56 72 54 92" />
      <path d="M32 63 Q40 60 48 63 Q52 82 50 100 L30 100 Q28 82 32 63 Z" />
      {/* lamps either side */}
      <path d="M18 100 L18 92 M62 100 L62 92" />
    </svg>
  );
}

/** The small blue devotional roundels stamped along the top of the book. */
function Roundel({ glyph }: { glyph: string }) {
  return (
    <span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 border-current text-[12px] leading-none">
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

  // GC book details. The number is only on the transporter's paper book, so it
  // has to be typed once here; everything else pre-fills off the dispatch.
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
  // "From" is the town the lorry leaves (Settings → Invoice Setup), "To" is the
  // order's delivery destination, falling back to the buyer's town/state.
  const fromPlace = (company.dispatchFromPlace || company.stateName || '').toUpperCase();
  const toPlace = (order?.destination || buyer?.city || buyer?.state || '').toUpperCase();
  const truckNo = dispatch.vehicleNumber ?? '';
  const gcDate = dmy(lrDate || dispatch.invoiceDate || dispatch.dispatchDate);

  const consignorAddress = company.address ?? '';
  const consigneeAddress = [buyer?.address, [buyer?.city, buyer?.state, buyer?.pincode].filter(Boolean).join(', ')]
    .filter(Boolean)
    .join('\n');

  return (
    <div className="min-h-screen bg-neutral-100 flex flex-col font-sans">
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; background-color: white !important; }
          .lr-no-print { display: none !important; }
          .lr-print-area { margin: 0; padding: 0; box-shadow: none !important; width: 100% !important; max-width: none !important; }
          @page { size: A4 portrait; margin: 8mm; }
        }
      `}} />

      {/* Toolbar (not printed) */}
      <div className="lr-no-print sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b bg-background px-4 py-2 shadow-sm">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
          <span className="ml-2 flex items-center gap-1 text-sm font-medium text-muted-foreground">
            <FileText className="h-4 w-4" /> Surya Road Lines — Lorry Receipt (GC)
          </span>
        </div>
        <Button size="sm" onClick={() => window.print()}>
          <Printer className="h-4 w-4 mr-1" /> Print
        </Button>
      </div>

      {/* The handful of fields the book carries but the ERP cannot know. */}
      <div className="lr-no-print grid grid-cols-2 gap-3 border-b bg-background px-4 py-3 sm:grid-cols-5 sm:items-end">
        <div className="space-y-1.5">
          <Label className="text-xs">G.C. No.</Label>
          <Input value={gcNo} onChange={(e) => setGcNo(e.target.value)} placeholder="from the GC book" className="h-8" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">GC Date</Label>
          <Input type="date" value={lrDate} onChange={(e) => setLrDate(e.target.value)} className="h-8" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Bags</Label>
          <Input type="number" min="0" value={bags} onChange={(e) => setBags(e.target.value)} placeholder="e.g. 600" className="h-8" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Each Bag (Kgs)</Label>
          <Input type="number" min="0" value={kgPerBag} onChange={(e) => setKgPerBag(e.target.value)} placeholder="e.g. 50" className="h-8" />
        </div>
        <Button size="sm" variant="outline" className="h-8" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save details'}
        </Button>
      </div>

      <div className="flex justify-center bg-neutral-100 py-8 lr-print-area">
        <div className="lr-print-area relative w-[210mm] bg-white p-[8mm] font-serif text-[11px] leading-tight text-black shadow-sm ring-1 ring-neutral-300">
          <div className="border-2 border-black">

            {/* ── Masthead ──────────────────────────────────────────────── */}
            <div className="flex items-stretch gap-2 px-2 pt-1.5">
              <Ganesha className="h-[74px] w-[62px] shrink-0 text-black" />
              <div className="flex-1 text-center">
                <div className="flex items-center justify-center gap-2 text-[#1d3f8f]">
                  <Roundel glyph="ॐ" />
                  <Roundel glyph="श्री" />
                  <Roundel glyph="ॐ" />
                </div>
                <div className="mt-0.5 flex items-center justify-center gap-2">
                  <span className="inline-flex h-[18px] w-[26px] items-center justify-center rounded-full border border-black text-[9px] font-bold tracking-tight">
                    SRL
                  </span>
                  <span className="text-[10px] italic">Subject to Punganur Jurisdiction</span>
                </div>
                <div className="font-sans text-[26px] font-extrabold leading-none tracking-tight">{SRL.name}</div>
                <div className="mx-auto mt-0.5 inline-block border border-black px-2 py-[1px] text-[10.5px] font-semibold">
                  {SRL.tagline}
                </div>
                <div className="mt-0.5 text-[10.5px] font-semibold">{SRL.address}</div>
              </div>
              <DeityArch className="h-[74px] w-[52px] shrink-0 text-black" />
            </div>
            <div className="border-b-2 border-black px-2 pb-1 text-center text-[11.5px] font-bold">{SRL.phones}</div>

            {/* ── Registrations / consignor's copy / carrier note ───────── */}
            <div className="flex border-b-2 border-black text-[8.5px] leading-[1.25]">
              <div className="w-[36%] border-r-2 border-black p-1">
                <div>PAN CARD : {SRL.pan}</div>
                <div>LABOUR Reg. No. : {SRL.labourReg}</div>
                <div>msme UDAYAM Reg. No.: {SRL.udyam}</div>
                <div className="mt-1.5 font-bold">Caution</div>
                <div>This Consignment will not detained</div>
                <div>Re routed or booked without consignee</div>
                <div>Banks written promission will be</div>
                <div>delivered at the destinaltion</div>
              </div>
              <div className="w-[30%] border-r-2 border-black p-1">
                <div className="text-center font-bold leading-[1.3]">
                  CONSIGNOR&apos;S COPY<br />
                  AT OWNERS RISK<br />
                  INSURANCE
                </div>
                <div className="mt-1 border-t border-black pt-1 text-justify">
                  The Customer has stated that the has not insurance the consignment or he has insured the consignment.
                </div>
                <div className="mt-1">Company:.........................</div>
                <div>Policy No.:......................</div>
                <div>Amount:..........................</div>
                <div>Risk:............................</div>
              </div>
              <div className="w-[34%] p-1 text-justify">
                <span className="font-bold">NOTE :</span> This Consignment covered by this of special lorry receipt from shall be
                stored at the destination under control of the Transport order and shall be delivered to order of then consignee
                bank whose name mentioned in the lorry receipt it will under no circumstance be delivered to any one without the
                written authority from the consignee copy or on a separate letter of Authority.
              </div>
            </div>

            {/* ── Consignor / consignee vs. GC + invoice + route ────────── */}
            <div className="flex border-b-2 border-black">
              <div className="w-[62%] border-r-2 border-black">
                <div className="min-h-[74px] border-b border-black p-1">
                  <div className="text-[9.5px]">Consignors Name &amp; Address :</div>
                  <div className="mt-0.5 whitespace-pre-line pl-1 font-sans text-[11px] font-semibold uppercase leading-snug">
                    {company.name}
                    {consignorAddress ? `\n${consignorAddress}` : ''}
                  </div>
                </div>
                <div className="min-h-[74px] p-1">
                  <div className="text-[9.5px]">Consignee Name &amp; Address :</div>
                  <div className="mt-0.5 whitespace-pre-line pl-1 font-sans text-[11px] font-semibold uppercase leading-snug">
                    {buyer?.name ?? ''}
                    {consigneeAddress ? `\n${consigneeAddress}` : ''}
                  </div>
                </div>
              </div>
              <div className="w-[38%] text-[10px]">
                <div className="border-b border-black px-1 py-[3px]">
                  G.C. No. <span className="ml-1 font-sans text-[13px] font-bold text-[#c0392b]">{gcNo}</span>
                </div>
                <div className="border-b border-black px-1 py-[3px]">
                  Invoice No.: <span className="font-sans font-semibold">{dispatch.invoiceNumber ?? ''}</span>
                </div>
                <div className="border-b border-black px-1 py-[3px]">
                  DATE: <span className="font-sans font-semibold">{gcDate}</span>
                </div>
                <div className="border-b border-black px-1 py-[3px]">
                  TRUCK NO. <span className="font-sans font-semibold">{truckNo}</span>
                </div>
                <div className="border-b border-black px-1 py-[3px]">
                  FROM <span className="font-sans font-semibold">{fromPlace}</span>
                </div>
                <div className="border-b border-black px-1 py-[3px]">
                  TO <span className="font-sans font-semibold">{toPlace}</span>
                </div>
                <div className="border-b border-black py-[2px] text-center text-[11px] font-bold">FREIGHT</div>
                <div className="flex text-[9.5px] font-semibold">
                  <div className="w-1/2 border-r border-black text-center">Paid</div>
                  <div className="w-1/2 text-center">To Pay</div>
                </div>
              </div>
            </div>

            {/* ── Goods / freight grid ──────────────────────────────────── */}
            <div className="flex border-b-2 border-black text-[10px]">
              <div className="w-[17%] border-r border-black">
                <div className="border-b border-black py-[2px] text-center font-bold">Package</div>
                <div className="space-y-1 p-1 leading-snug">
                  <div><span className="font-sans font-semibold">{bags || '------------'}</span> Bags</div>
                  <div>Each Bag</div>
                  <div><span className="font-sans font-semibold">{kgPerBag || '------------'}</span> Kgs.</div>
                </div>
              </div>
              <div className="w-[27%] border-r border-black">
                <div className="border-b border-black py-[2px] text-center font-bold leading-tight">Descriptions<br />said to contain</div>
                <div className="p-1 leading-snug">
                  <div className="line-through">FEED</div>
                  <div className="font-sans text-[11px] font-semibold">{description}</div>
                </div>
              </div>
              <div className="w-[18%] border-r border-black">
                <div className="border-b border-black py-[2px] text-center font-bold">Freight</div>
                <div className="space-y-1 p-1 leading-snug">
                  <div>Per Bag</div>
                  <div>Lorry Freight</div>
                  <div>Rs. ________</div>
                </div>
              </div>
              {/* Paid / To Pay money columns, split Rs | Ps like the book */}
              <div className="flex w-[38%]">
                {['Paid', 'To Pay'].map((col) => (
                  <div key={col} className="flex w-1/2 flex-col border-r border-black last:border-r-0">
                    <div className="flex border-b border-black">
                      <div className="w-2/3 border-r border-black py-[2px] text-center text-[9px]">Rs.</div>
                      <div className="w-1/3 py-[2px] text-center text-[9px]">Ps.</div>
                    </div>
                    <div className="flex flex-1">
                      <div className="w-2/3 border-r border-black" />
                      <div className="w-1/3" />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Amount in words + Hamali / GC / Total ─────────────────── */}
            <div className="flex border-b-2 border-black text-[10px]">
              <div className="w-[44%] border-r border-black p-1">
                <div>To pay Lorry freight Rupees in words</div>
                <div className="mt-2 text-[9px]">.................................................</div>
                <div className="mt-1.5 text-[9px]">.................................................</div>
                <div className="mt-1.5 text-[9px]">.................................................</div>
                <div className="mt-1 text-[8.5px] italic">Unloading by Party</div>
              </div>
              <div className="w-[18%] border-r border-black">
                <div className="border-b border-black px-1 py-[5px]">Hamali</div>
                <div className="border-b border-black px-1 py-[5px]">GC Charges</div>
                <div className="px-1 py-[5px] font-bold">TOTAL</div>
              </div>
              <div className="flex w-[38%]">
                {['Paid', 'To Pay'].map((col) => (
                  <div key={col} className="flex w-1/2 flex-col border-r border-black last:border-r-0">
                    {[0, 1, 2].map((row) => (
                      <div key={row} className={`flex flex-1 ${row < 2 ? 'border-b border-black' : ''}`}>
                        <div className="w-2/3 border-r border-black py-[5px]" />
                        <div className="w-1/3 py-[5px]" />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            {/* ── Footer notes + signature ─────────────────────────────── */}
            <div className="flex items-end gap-2 p-1.5">
              <div className="flex-1 text-[8.5px] leading-[1.3]">
                <div className="text-justify">
                  <span className="font-bold underline">Note :</span> Our leakage and damage we are not responsible. Insurance to be
                  covered by the party. Any claim towards damage/shortage etc., should not settled with Driver at the unloading it
                  self later date no complaint will be entertained by us.
                </div>
                <div className="mt-0.5 font-bold">
                  <span className="underline">Note :</span> WE ARE NOT COLLECTING ANY GST AMOUNT TO PARTY.
                </div>
              </div>
              <div className="w-[34%] pb-1 text-right text-[10px] font-semibold">For Surya Road Lines</div>
            </div>
            <div className="flex justify-between border-t border-black px-1.5 py-1 text-[9.5px]">
              <span>Driver&apos;s Name : {dispatch.driverName ?? ''}</span>
              <span className="pr-2">D.L. No. :</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
