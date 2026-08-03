import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Printer, FileText, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import type { SaleDispatch, CompanyProfile } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { productDescription } from '@/lib/productNames';

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

/** Pappu ships in 50 kg bags, so the packing follows from the lorry's weight. */
const DEFAULT_KG_PER_BAG = 50;

/** Bag count for a load: 30 t at 50 kg = 600 bags, 25 t = 500, 35 t = 700. */
function bagsFor(weightKg: number, kgPerBag: number): string {
  if (!weightKg || !kgPerBag) return '';
  return String(Math.round(weightKg / kgPerBag));
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
    // Packing defaults to the dispatched weight in 50 kg bags; a receipt that was
    // saved with its own counts keeps them.
    const perBag = dispatch.lrKgPerBag ?? DEFAULT_KG_PER_BAG;
    setKgPerBag(String(perBag));
    setBags(dispatch.lrBags != null ? String(dispatch.lrBags) : bagsFor(dispatch.weightKg, perBag));
  }, [dispatch]);

  /** Re-derive the bag count when the bag size is changed by hand. */
  function onKgPerBagChange(value: string) {
    setKgPerBag(value);
    const perBag = Number(value);
    if (dispatch && perBag > 0) setBags(bagsFor(dispatch.weightKg, perBag));
  }

  /**
   * A shipment takes the next number in the GC book the first time its receipt
   * is opened, so the printed copy never goes out blank. Server-side it is
   * idempotent; the ref stops React's double-invoked effects (StrictMode) from
   * firing two requests before the first one lands.
   */
  const assignRequested = useRef(false);
  const assignGc = useMutation({
    mutationFn: () => api<SaleDispatch>(`/sale-dispatches/${id}/lorry-receipt/assign`, { method: 'POST' }),
    onSuccess: (updated) => {
      qc.setQueryData(['sale-dispatch', id], updated);
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  useEffect(() => {
    // Buyers who ship without a GC note never take a number off the book.
    if (!dispatch || !dispatch.saleOrder?.buyer?.lorryReceiptEnabled) return;
    if (dispatch.lrNumber || assignRequested.current) return;
    assignRequested.current = true;
    assignGc.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const deleteGc = useMutation({
    mutationFn: () => api(`/sale-dispatches/${id}/lorry-receipt`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sale-dispatch', id] });
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      toast.success('Lorry receipt deleted');
      navigate(-1);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  if (isLoading || !dispatch || !company) {
    return <div className="p-8 text-center text-muted-foreground animate-pulse">Loading lorry receipt…</div>;
  }

  const order = dispatch.saleOrder;
  const buyer = order?.buyer;

  // Reached by a stale link or a typed URL after the buyer was switched off: no
  // receipt exists and none should be raised, so say so instead of printing one.
  if (!buyer?.lorryReceiptEnabled && !dispatch.lrNumber) {
    return (
      <div className="mx-auto max-w-md p-8 text-center space-y-3">
        <FileText className="mx-auto h-8 w-8 text-muted-foreground" />
        <h1 className="text-lg font-semibold">No lorry receipt for this shipment</h1>
        <p className="text-sm text-muted-foreground">
          Lorry receipts are switched off for {buyer?.name ?? 'this buyer'}. Turn on "Lorry receipt (GC)" on their
          party record in Parties to issue one.
        </p>
        <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
      </div>
    );
  }

  const description = productDescription(order?.product);
  const fromPlace = (company.dispatchFromPlace || company.stateName || 'PUNGANUR').toUpperCase();
  const toPlace = (order?.destination || buyer?.city || buyer?.state || '').toUpperCase();
  const truckNo = dispatch.vehicleNumber ?? '';
  const gcDate = dmy(lrDate || dispatch.invoiceDate || dispatch.dispatchDate);

  const consignorAddress = company.address ?? '';
  const consigneeAddress = [buyer?.address, [buyer?.city, buyer?.state, buyer?.pincode].filter(Boolean).join(', ')]
    .filter(Boolean)
    .join('\n');

  return (
    <div className="min-h-screen bg-neutral-200 flex flex-col font-sans">
      <style dangerouslySetInnerHTML={{ __html: `
        /* The sheet sets its own type. The app's UI faces (Hanken Grotesk /
           Fraunces) read as a web page; the GC book is set in plain office
           serif for the printed matter and a grotesque for the filled-in
           values, so the two are told apart at a glance on the paper. */
        .lr-sheet { font-family: "Times New Roman", Times, Georgia, serif; }
        .lr-sheet .lr-fill { font-family: Arial, "Helvetica Neue", Helvetica, sans-serif; }
        /* Masthead logotype: heavy condensed serif, as printed on the book. */
        .lr-sheet .lr-logotype {
          font-family: "Times New Roman", Times, serif;
          font-weight: 700;
          letter-spacing: -0.01em;
          font-stretch: condensed;
        }
        .lr-emblem { image-rendering: -webkit-optimize-contrast; }

        /* Freight-paid marks. The tick sits beside the printed "Paid" heading;
           the stamp is the rubber-stamp impression struck across the Paid
           amount box, drawn in CSS so it stays crisp at print resolution. */
        .lr-sheet .lr-tick { color: #cc1111; font-weight: 900; }
        .lr-sheet .lr-paid-stamp {
          font-family: Arial, "Helvetica Neue", Helvetica, sans-serif;
          font-weight: 900;
          font-size: 15px;
          line-height: 1;
          letter-spacing: 0.14em;
          color: #cc1111;
          border: 2px solid #cc1111;
          border-radius: 3px;
          padding: 3px 8px 3px 10px;
          /* Second, offset rule = the stamp's outer frame. */
          box-shadow: 0 0 0 1.5px #fff, 0 0 0 3.5px #cc1111;
          transform: rotate(-12deg);
          opacity: 0.85;
        }

        @media print {
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; background: #fff !important; }
          .lr-no-print { display: none !important; }
          .lr-print-area { margin: 0 !important; padding: 0 !important; box-shadow: none !important; ring: 0 !important; width: 100% !important; max-width: none !important; background: #fff !important; }
          /* Paper tint is a screen affordance - real paper is already paper.
             The Om roundel is knocked out of solid ink, so it keeps its fill. */
          .lr-sheet, .lr-sheet *:not(.lr-ink-fill) { background-color: transparent !important; }
          /* The printed side margin is set here, not by the sheet's own padding
             - the rule above strips that. Keep it in step with the sheet's
             px-[14mm] so screen and paper show the same inset. */
          @page { size: A4 portrait; margin: 9mm 14mm; }
        }
      `}} />

      {/* Toolbar (Screen only) */}
      <div className="lr-no-print sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b bg-background px-4 py-2 shadow-sm">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
          <span className="ml-2 flex items-center gap-1 text-sm font-semibold text-[#1a4a99]">
            <FileText className="h-4 w-4" /> Surya Road Lines - Lorry Receipt (GC)
          </span>
        </div>
        <div className="flex items-center gap-2">
          {dispatch.lrNumber && (
            <Button
              size="sm"
              variant="destructive"
              disabled={deleteGc.isPending}
              onClick={() => {
                if (window.confirm(`Are you sure you want to delete GC Note #${dispatch.lrNumber}?`)) {
                  deleteGc.mutate();
                }
              }}
            >
              <Trash2 className="h-4 w-4 mr-1" /> Delete GC Note
            </Button>
          )}
          <Button size="sm" className="bg-[#1a4a99] hover:bg-[#153c80] text-white" onClick={() => window.print()}>
            <Printer className="h-4 w-4 mr-1" /> Print Lorry Receipt
          </Button>
        </div>
      </div>

      {/* Form Bar */}
      <div className="lr-no-print grid grid-cols-2 gap-3 border-b bg-background px-4 py-3 sm:grid-cols-5 sm:items-end">
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-[#1a4a99]">G.C. No. (auto)</Label>
          <Input value={gcNo} onChange={(e) => setGcNo(e.target.value)} placeholder={assignGc.isPending ? 'Assigning…' : 'e.g. 55'} className="h-8 border-[#1a4a99]/30 focus:border-[#1a4a99]" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-[#1a4a99]">GC Date</Label>
          <Input type="date" value={lrDate} onChange={(e) => setLrDate(e.target.value)} className="h-8 border-[#1a4a99]/30 focus:border-[#1a4a99]" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-[#1a4a99]">Bags (auto)</Label>
          <Input type="number" min="0" value={bags} onChange={(e) => setBags(e.target.value)} placeholder="e.g. 600" className="h-8 border-[#1a4a99]/30 focus:border-[#1a4a99]" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-[#1a4a99]">Each Bag (Kgs)</Label>
          <Input type="number" min="0" value={kgPerBag} onChange={(e) => onKgPerBagChange(e.target.value)} placeholder="e.g. 50" className="h-8 border-[#1a4a99]/30 focus:border-[#1a4a99]" />
        </div>
        <Button size="sm" variant="outline" className="h-8 border-[#1a4a99] text-[#1a4a99] hover:bg-[#1a4a99]/5" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save Details'}
        </Button>
      </div>

      {/* Main Print Container - Portrait A4 Sheet Format */}
      <div className="flex justify-center bg-neutral-200 py-6 lr-print-area">
        <div className="lr-sheet lr-print-area relative w-[210mm] min-h-[285mm] bg-white px-[14mm] py-[9mm] text-[#1a4a99] shadow-md ring-1 ring-neutral-300 text-[11px] leading-tight">
          
          {/* Outer Deep Navy Blue Border */}
          <div className="border-[2.5px] border-[#1a4a99] flex flex-col h-full bg-white">

            {/* ── MASTHEAD HEADER (Full Width Top) ────────────────────────── */}
            <div className="border-b-[2.5px] border-[#1a4a99] p-2 flex items-center justify-between gap-2">
              {/* Top Left: Ganesha. Transparent PNG, so the paper shows through
                  and the line art takes the sheet's navy ink. */}
              <div className="w-[75px] flex justify-center items-center">
                <img src="/ganesha.png" alt="" aria-hidden className="h-[78px] w-[62px] object-contain lr-emblem" />
              </div>

              {/* Center Masthead Text */}
              <div className="flex-1 text-center space-y-0.5">
                {/* The three devotional marks stamped above the logotype on the
                    book: Om, a Ganesha roundel, and a saffron swastika. */}
                <div className="flex items-end justify-center gap-2 pb-0.5">
                  <span className="lr-ink-fill inline-flex h-[15px] w-[15px] items-center justify-center rounded-full bg-[#1a4a99] text-[10px] leading-none text-white">
                    ॐ
                  </span>
                  <span className="inline-flex h-[16px] w-[16px] items-center justify-center overflow-hidden rounded-full border border-[#1a4a99]">
                    <img src="/ganesha.png" alt="" aria-hidden className="h-[13px] w-[10px] object-contain lr-emblem" />
                  </span>
                  <span className="text-[13px] leading-none text-[#b7410e]">卐</span>
                </div>

                <div className="flex items-center justify-center gap-1.5">
                  <span className="lr-logotype inline-flex h-[19px] w-[36px] items-center justify-center rounded-[50%] border-[1.5px] border-[#1a4a99] text-[11px] tracking-wide">
                    SRL
                  </span>
                  <span className="text-[10px] font-semibold">Subject to Punganur Jurisdiction</span>
                </div>

                <div className="lr-logotype text-[32px] leading-none text-[#1a4a99] uppercase pt-0.5">
                  {SRL.name}
                </div>

                <div className="border border-[#1a4a99] rounded-[9px] px-3 py-[1px] text-[10px] font-bold inline-block">
                  {SRL.tagline}
                </div>

                <div className="text-[10px] font-bold leading-tight pt-0.5">
                  {SRL.address}
                </div>

                <div className="text-[9.5px] font-bold leading-tight">
                  {SRL.phones}
                </div>
              </div>

              {/* Top Right: Balaji, same treatment as the Ganesha. */}
              <div className="w-[75px] flex justify-center items-center">
                <img src="/balaji.png" alt="" aria-hidden className="h-[70px] w-[70px] object-contain lr-emblem" />
              </div>
            </div>

            {/* ── 3-COLUMN MIDDLE SECTION ───────────────────────────────── */}
            <div className="flex border-b-[2.5px] border-[#1a4a99] text-[8.5px] leading-tight">
              {/* Col 1: Registrations & Caution */}
              <div className="w-[30%] border-r-[2px] border-[#1a4a99] p-1.5 space-y-1">
                <div className="lr-fill text-[8px] font-semibold space-y-0.5">
                  <div>PAN CARD : <span className="font-bold">{SRL.pan}</span></div>
                  <div>LABOUR Reg. No. : <span className="font-bold">{SRL.labourReg}</span></div>
                  <div>msme UDAYAM Reg. No.: <span className="font-bold">{SRL.udyam}</span></div>
                </div>

                <div className="border border-[#1a4a99] p-1 mt-1">
                  <div className="font-bold text-center uppercase tracking-wider text-[8.5px] mb-0.5">Caution</div>
                  <div>This Consignment will not detained</div>
                  <div>Re routed or booked without consignee</div>
                  <div>Banks written promission will be</div>
                  <div>delivered at the destinaltion</div>
                </div>
              </div>

              {/* Col 2: Consignor Risk & Insurance */}
              <div className="w-[32%] border-r-[2px] border-[#1a4a99] p-1.5 flex flex-col justify-between">
                <div>
                  <div className="text-center font-bold text-[9px] leading-snug">
                    CONSIGNOR&apos;S COPY<br />
                    AT OWNERS RISK<br />
                    INSURANCE
                  </div>
                  <div className="mt-1 border-t border-[#1a4a99]/40 pt-1 text-justify text-[8px]">
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
                <div className="border-t border-[#1a4a99] pt-1 flex items-center justify-between mt-1">
                  <span className="font-bold text-[11px]">G.C. No.</span>
                  <span className="text-[20px] font-black text-[#cc1111] tracking-wider leading-none">
                    {gcNo || '────'}
                  </span>
                </div>
              </div>
            </div>

            {/* ── ADDRESSES & ROUTE SECTION ─────────────────────────────── */}
            <div className="flex border-b-[2.5px] border-[#1a4a99]">
              {/* Left: Consignor & Consignee */}
              <div className="w-[62%] border-r-[2px] border-[#1a4a99] flex flex-col">
                <div className="flex-1 border-b border-[#1a4a99] p-1.5 min-h-[72px]">
                  <div className="text-[9px] font-bold underline">Consignors Name &amp; Address :</div>
                  <div className="mt-1 whitespace-pre-line lr-fill text-[10.5px] font-bold uppercase leading-snug tracking-tight">
                    {company.name}
                    {consignorAddress ? `\n${consignorAddress}` : ''}
                  </div>
                </div>
                <div className="flex-1 p-1.5 min-h-[72px]">
                  <div className="text-[9px] font-bold underline">Consignee Name &amp; Address :</div>
                  <div className="mt-1 whitespace-pre-line lr-fill text-[10.5px] font-bold uppercase leading-snug tracking-tight">
                    {buyer?.name ?? ''}
                    {consigneeAddress ? `\n${consigneeAddress}` : ''}
                  </div>
                </div>
              </div>

              {/* Right: Invoice No, Date, Truck, From, To, Freight */}
              <div className="w-[38%] text-[10px] flex flex-col justify-between">
                <div className="border-b border-[#1a4a99] px-2 py-1 flex justify-between">
                  <span className="font-semibold text-[9.5px]">Invoice No.:</span>
                  <span className="lr-fill font-bold text-[10.5px]">{dispatch.invoiceNumber ?? '────'}</span>
                </div>
                <div className="border-b border-[#1a4a99] px-2 py-1 flex justify-between">
                  <span className="font-semibold text-[9.5px]">DATE:</span>
                  <span className="lr-fill font-bold text-[10.5px]">{gcDate || '────'}</span>
                </div>
                <div className="border-b border-[#1a4a99] px-2 py-1 flex justify-between">
                  <span className="font-semibold text-[9.5px]">TRUCK NO.</span>
                  <span className="lr-fill font-bold text-[10.5px] uppercase">{truckNo || '────'}</span>
                </div>
                <div className="border-b border-[#1a4a99] px-2 py-1 flex justify-between">
                  <span className="font-semibold text-[9.5px]">FROM</span>
                  <span className="lr-fill font-bold text-[10.5px] uppercase">{fromPlace}</span>
                </div>
                <div className="border-b border-[#1a4a99] px-2 py-1 flex justify-between">
                  <span className="font-semibold text-[9.5px]">TO</span>
                  <span className="lr-fill font-bold text-[10.5px] uppercase">{toPlace}</span>
                </div>
                <div className="border-b border-[#1a4a99] py-0.5 text-center text-[10px] font-black uppercase tracking-widest">
                  FREIGHT
                </div>
                {/* Freight terms: RVP prepays the lorry, so the consignment always
                    travels freight-paid - the "Paid" side is ticked on the book. */}
                <div className="flex text-[9px] font-bold text-center">
                  <div className="w-1/2 border-r border-[#1a4a99] py-0.5">
                    Paid <span className="lr-tick text-[11px] leading-none">✓</span>
                  </div>
                  <div className="w-1/2 py-0.5">To Pay</div>
                </div>
              </div>
            </div>

            {/* ── GOODS TABLE GRID ──────────────────────────────────────── */}
            <div className="flex border-b-[2.5px] border-[#1a4a99] text-[9.5px] min-h-[120px]">
              <div className="w-[18%] border-r border-[#1a4a99] flex flex-col">
                <div className="border-b border-[#1a4a99] py-1 text-center font-bold text-[10px]">Package</div>
                <div className="p-1.5 space-y-1 leading-snug flex-1">
                  <div><span className="lr-fill font-bold text-[11px]">{bags || '────'}</span> Bags</div>
                  <div className="text-[9px]">Each Bag</div>
                  <div><span className="lr-fill font-bold text-[11px]">{kgPerBag || '────'}</span> Kgs.</div>
                </div>
              </div>

              <div className="w-[30%] border-r border-[#1a4a99] flex flex-col">
                <div className="border-b border-[#1a4a99] py-1 text-center font-bold text-[10px] leading-tight">
                  Descriptions<br />said to contain
                </div>
                <div className="p-1.5 leading-snug flex-1">
                  <div className="lr-fill text-[11px] font-bold text-[#1a4a99] uppercase">{description}</div>
                </div>
              </div>

              <div className="w-[18%] border-r border-[#1a4a99] flex flex-col">
                <div className="border-b border-[#1a4a99] py-1 text-center font-bold text-[10px]">Freight</div>
                <div className="p-1.5 space-y-1 leading-snug flex-1 text-[9px]">
                  <div>Per Bag</div>
                  <div>Lorry Freight</div>
                  <div>Rs. ________</div>
                </div>
              </div>

              <div className="w-[34%] flex">
                {['Paid', 'To Pay'].map((col) => (
                  <div key={col} className="flex w-1/2 flex-col border-r border-[#1a4a99] last:border-r-0">
                    <div className="flex border-b border-[#1a4a99] text-[8.5px] font-bold text-center">
                      <div className="w-2/3 border-r border-[#1a4a99] py-0.5">Rs.</div>
                      <div className="w-1/3 py-0.5">Ps.</div>
                    </div>
                    {/* The PAID stamp lands across the freight amount box on the
                        Paid side, where the transporter writes it by hand. */}
                    <div className="relative flex flex-1">
                      <div className="w-2/3 border-r border-[#1a4a99]" />
                      <div className="w-1/3" />
                      {col === 'Paid' && (
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                          <span className="lr-paid-stamp">PAID</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── RUPEES IN WORDS & CHARGES SUMMARY ─────────────────────── */}
            <div className="flex border-b-[2.5px] border-[#1a4a99] text-[9.5px]">
              <div className="w-[48%] border-r border-[#1a4a99] p-1.5 flex flex-col justify-between">
                <div>
                  <div className="font-semibold text-[9px]">To pay Lorry freight Rupees in words</div>
                  <div className="mt-1 text-[8.5px] tracking-widest text-[#1a4a99]/50">.........................................................................</div>
                  <div className="mt-1 text-[8.5px] tracking-widest text-[#1a4a99]/50">.........................................................................</div>
                </div>
                <div className="text-[8.5px] italic font-semibold mt-1">Unloading by Party</div>
              </div>

              <div className="w-[18%] border-r border-[#1a4a99] font-bold text-[9.5px]">
                <div className="border-b border-[#1a4a99] px-1.5 py-1">Hamali</div>
                <div className="border-b border-[#1a4a99] px-1.5 py-1">GC Charges</div>
                <div className="px-1.5 py-1 text-[10px] font-black uppercase">TOTAL</div>
              </div>

              <div className="w-[34%] flex">
                {['Paid', 'To Pay'].map((col) => (
                  <div key={col} className="flex w-1/2 flex-col border-r border-[#1a4a99] last:border-r-0">
                    {[0, 1, 2].map((row) => (
                      <div key={row} className={`flex flex-1 ${row < 2 ? 'border-b border-[#1a4a99]' : ''}`}>
                        <div className="w-2/3 border-r border-[#1a4a99] py-1" />
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
                {/* No stamp/signature image here - unlike the tax invoice, this
                    document carries no company seal; it is signed by hand (or a
                    lorry-receipt-specific mark can be dropped in here later). */}
                <div className="w-[30%] pt-1 text-[11px]">
                  <div className="text-right font-bold">For Surya Road Lines</div>
                  <div className="mt-6 border-t border-[#1a4a99]/60" />
                  <div className="text-right text-[9px] mt-0.5">Authorised Signatory</div>
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-[#1a4a99]/40 pt-1 mt-3 text-[9.5px] font-semibold">
                <div>Driver&apos;s Name : <span className="font-bold uppercase lr-fill text-[10.5px]">{dispatch.driverName ?? ''}</span></div>
                <div className="pr-4">D.L. No. :</div>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
