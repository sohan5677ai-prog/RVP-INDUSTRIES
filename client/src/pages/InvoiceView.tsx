import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Printer, Save, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { SaleDispatch, CompanyProfile, ProductTaxInfo } from '@/lib/types';
import { inr, rupeesInWords } from '@/lib/invoiceWords';
import { Button } from '@/components/ui/button';

const GST_RATE = 0.05;

const PAPER_W: Record<string, number> = { A4: 210, A5: 148, Letter: 216 };

interface InvoiceLayout {
  paperSize: 'A4' | 'A5' | 'Letter';
  marginMm: number;
  fontPx: number;
  headerLeftPct: number;
  cols: { sl: number; desc: number; hsn: number; qty: number; rate: number; per: number; amt: number };
}

const DEFAULT_LAYOUT: InvoiceLayout = {
  paperSize: 'A4',
  marginMm: 8,
  fontPx: 11,
  headerLeftPct: 56,
  cols: { sl: 5, desc: 33, hsn: 11, qty: 15, rate: 12, per: 7, amt: 17 },
};

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }).replace(/ /g, '-');
}

const PRODUCT_FALLBACK: Record<string, string> = {
  PAPPU: 'Tamarind Seed Kernel', HUSK: 'Tamarind Husk', WASTE: 'Tamarind Waste', TPS: 'Tamarind Seed Brokens', SHELL: 'Tamarind Shell',
};

export default function InvoiceView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [showControls, setShowControls] = useState(true);

  const { data: dispatch } = useQuery({ queryKey: ['sale-dispatch', id], queryFn: () => api<SaleDispatch>(`/sale-dispatches/${id}`), enabled: !!id });
  const order = dispatch?.saleOrder;
  const { data: company } = useQuery({ queryKey: ['company'], queryFn: () => api<CompanyProfile>('/settings/company') });
  const { data: taxRows } = useQuery({ queryKey: ['product-tax'], queryFn: () => api<ProductTaxInfo[]>('/settings/product-tax') });

  const [layout, setLayout] = useState<InvoiceLayout>(DEFAULT_LAYOUT);
  useEffect(() => {
    if (company?.invoiceLayout) {
      try { setLayout({ ...DEFAULT_LAYOUT, ...JSON.parse(company.invoiceLayout), cols: { ...DEFAULT_LAYOUT.cols, ...JSON.parse(company.invoiceLayout).cols } }); }
      catch { /* ignore malformed */ }
    }
  }, [company?.invoiceLayout]);

  const saveLayout = useMutation({
    mutationFn: () => api('/settings/invoice-layout', { method: 'PUT', body: { layout } }),
    onSuccess: () => toast.success('Layout saved'),
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const tax = taxRows?.find((t) => t.product === order?.product);
  const gstFraction = (tax?.gstRate != null ? Number(tax.gstRate) : GST_RATE * 100) / 100;
  const amounts = useMemo(() => {
    if (!dispatch || !order) return { base: 0, gst: 0, total: 0 };
    const base = dispatch.weightKg * Number(order.ratePerKg);
    const gst = Math.round(base * gstFraction * 100) / 100;
    return { base, gst, total: base + gst };
  }, [dispatch, order, gstFraction]);

  if (!dispatch || !order || !company) return <div className="p-8 text-muted-foreground">Loading invoice…</div>;

  const paperW = PAPER_W[layout.paperSize] ?? 210;
  const gstPct = Math.round(gstFraction * 100);
  const buyerGstin = order.buyer?.gstin ?? null;
  const buyerStateCode = buyerGstin && /^\d{2}/.test(buyerGstin) ? buyerGstin.slice(0, 2) : null;
  const description = tax?.description || PRODUCT_FALLBACK[order.product] || order.product;
  const hsn = tax?.hsn || '';
  const qtyStr = `${dispatch.weightKg.toLocaleString('en-IN')} Kgs`;
  const c = layout.cols;

  return (
    <div className="min-h-screen bg-muted/40">
      <style>{`
        @page { size: ${layout.paperSize}; margin: 0; }
        @media print {
          body { background: #fff; }
          .inv-no-print { display: none !important; }
          .inv-page { box-shadow: none !important; margin: 0 !important; }
        }
        .inv-page { font-family: 'Times New Roman', Times, serif; color: #000; background: #fff; }
        .inv-page table { border-collapse: collapse; width: 100%; }
        .inv-page td, .inv-page th { border: 1px solid #000; vertical-align: top; padding: 2px 4px; }
        .inv-page .lbl { font-size: 0.82em; line-height: 1.15; }
        .inv-page .val { font-weight: bold; line-height: 1.2; }
        .inv-page .sec { margin-top: -1px; }
        .inv-page .nob { border: 0 !important; }
        .inv-page .center { text-align: center; }
        .inv-page .right { text-align: right; }
      `}</style>

      {/* Toolbar (not printed) */}
      <div className="inv-no-print sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}><ArrowLeft className="h-4 w-4" /> Back</Button>
        <Button size="sm" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print / Save PDF</Button>
        <Button size="sm" variant="outline" onClick={() => setShowControls((s) => !s)}><SlidersHorizontal className="h-4 w-4" /> {showControls ? 'Hide' : 'Adjust'} layout</Button>
        <span className="ml-auto text-sm text-muted-foreground">Invoice {dispatch.invoiceNumber ?? '(not raised)'}</span>
      </div>

      {showControls && (
        <div className="inv-no-print border-b bg-background px-4 py-3 text-sm">
          <div className="flex flex-wrap items-end gap-4">
            <Ctl label="Paper">
              <select className="h-8 rounded-md border bg-background px-2" value={layout.paperSize} onChange={(e) => setLayout((l) => ({ ...l, paperSize: e.target.value as InvoiceLayout['paperSize'] }))}>
                <option value="A4">A4</option><option value="A5">A5</option><option value="Letter">Letter</option>
              </select>
            </Ctl>
            <Num label="Margin (mm)" value={layout.marginMm} min={0} max={30} onChange={(v) => setLayout((l) => ({ ...l, marginMm: v }))} />
            <Num label="Font (px)" value={layout.fontPx} min={7} max={18} step={0.5} onChange={(v) => setLayout((l) => ({ ...l, fontPx: v }))} />
            <Num label="Header left %" value={layout.headerLeftPct} min={35} max={75} onChange={(v) => setLayout((l) => ({ ...l, headerLeftPct: v }))} />
            <div className="flex items-end gap-2">
              {(['sl', 'desc', 'hsn', 'qty', 'rate', 'per', 'amt'] as const).map((k) => (
                <Num key={k} label={k} value={c[k]} min={2} max={50} small onChange={(v) => setLayout((l) => ({ ...l, cols: { ...l.cols, [k]: v } }))} />
              ))}
            </div>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setLayout(DEFAULT_LAYOUT)}><RotateCcw className="h-4 w-4" /> Reset</Button>
              <Button size="sm" onClick={() => saveLayout.mutate()} disabled={saveLayout.isPending}><Save className="h-4 w-4" /> Save layout</Button>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Column widths are percentages of the table width. Tweak, then Print / Save PDF.</p>
        </div>
      )}

      {/* The invoice page */}
      <div className="flex justify-center py-6 inv-print-area">
        <div
          className="inv-page shadow-lg"
          style={{ width: `${paperW}mm`, padding: `${layout.marginMm}mm`, fontSize: `${layout.fontPx}px` }}
        >
          <div className="center font-bold text-2xl mb-1">Tax Invoice</div>

          {dispatch.irn && (
            <div className="flex gap-3 border border-black px-2 py-1 mb-1.5 text-[0.85em] items-center">
              <div className="flex-1">
                <div><span className="font-bold">IRN:</span> <span className="font-mono break-all text-[1.05em]">{dispatch.irn}</span></div>
                <div className="flex gap-8 mt-1">
                  <div><span className="font-bold">Ack No:</span> {dispatch.irnAckNo}</div>
                  <div><span className="font-bold">Ack Date:</span> {dispatch.irnAckDate ? fmtDate(new Date(dispatch.irnAckDate)) : ''}</div>
                </div>
              </div>
              {dispatch.irnSignedQr && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', borderLeft: '1px solid #ddd', paddingLeft: 8 }}>
                  <img 
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=70x70&data=${encodeURIComponent(dispatch.irnSignedQr)}`} 
                    alt="E-Invoice QR Code"
                    style={{ width: 64, height: 64 }}
                  />
                </div>
              )}
            </div>
          )}

          {/* Header: seller/buyer + meta grid */}
          <table>
            <colgroup>
              <col style={{ width: `${layout.headerLeftPct}%` }} />
              <col style={{ width: `${(100 - layout.headerLeftPct) / 3}%` }} />
              <col style={{ width: `${(100 - layout.headerLeftPct) / 3}%` }} />
              <col style={{ width: `${(100 - layout.headerLeftPct) / 3}%` }} />
            </colgroup>
            <tbody>
              <tr>
                <td rowSpan={8} style={{ padding: 0 }}>
                  <div style={{ padding: '4px 6px', borderBottom: '1px solid #000' }}>
                    <div style={{ fontWeight: 'bold', fontSize: '1.15em' }}>{company.name}</div>
                    {company.address && <div className="lbl" style={{ whiteSpace: 'pre-line' }}>{company.address}</div>}
                    {company.gstin && <div className="lbl">GSTIN/UIN: {company.gstin}</div>}
                    {company.stateName && <div className="lbl">State Name : {company.stateName}{company.stateCode ? `, Code : ${company.stateCode}` : ''}</div>}
                    {company.contact && <div className="lbl">Contact : {company.contact}</div>}
                  </div>
                  <div style={{ padding: '4px 6px' }}>
                    <div className="lbl">Buyer (Bill to)</div>
                    <div style={{ fontWeight: 'bold', fontSize: '1.05em' }}>{order.buyer?.name}</div>
                    {order.buyer?.address && <div className="lbl" style={{ whiteSpace: 'pre-line' }}>{order.buyer.address}</div>}
                    {buyerGstin && <div className="lbl">GSTIN/UIN : {buyerGstin}</div>}
                    {order.buyer?.state && <div className="lbl">State Name : {order.buyer.state}{buyerStateCode ? `, Code : ${buyerStateCode}` : ''}</div>}
                    {order.buyer?.state && <div className="lbl">Place of Supply : {order.buyer.state}</div>}
                  </div>
                </td>
                <MetaCell label="Invoice No." value={dispatch.invoiceNumber ?? ''} />
                <MetaCell label="e-Way Bill No." value={dispatch.ewbNumber ?? ''} />
                <MetaCell label="Dated" value={dispatch.invoiceDate ? fmtDate(new Date(dispatch.invoiceDate)) : ''} />
              </tr>
              <tr><MetaCell colSpan={2} label="Delivery Note" value="" /><MetaCell label="Mode/Terms of Payment" value="" /></tr>
              <tr><MetaCell colSpan={2} label="Reference No. & Date." value="" /><MetaCell label="Other References" value="" /></tr>
              <tr><MetaCell colSpan={2} label="Buyer's Order No." value="" /><MetaCell label="Dated" value="" /></tr>
              <tr><MetaCell colSpan={2} label="Dispatch Doc No." value="" /><MetaCell label="Delivery Note Date" value="" /></tr>
              <tr><MetaCell colSpan={2} label="Dispatched through" value="Road" /><MetaCell label="Destination" value={order.destination ?? ''} /></tr>
              <tr><MetaCell colSpan={2} label="Bill of Lading/LR-RR No." value="" /><MetaCell label="Motor Vehicle No." value={dispatch.vehicleNumber ?? ''} /></tr>
              <tr><MetaCell colSpan={3} label="Terms of Delivery" value="" /></tr>
            </tbody>
          </table>

          {/* Goods table */}
          <table className="sec">
            <colgroup>
              <col style={{ width: `${c.sl}%` }} /><col style={{ width: `${c.desc}%` }} /><col style={{ width: `${c.hsn}%` }} />
              <col style={{ width: `${c.qty}%` }} /><col style={{ width: `${c.rate}%` }} /><col style={{ width: `${c.per}%` }} /><col style={{ width: `${c.amt}%` }} />
            </colgroup>
            <thead>
              <tr style={{ fontWeight: 'bold' }} className="center">
                <th>Sl<br />No.</th><th>Description of Goods</th><th>HSN/SAC</th><th>Quantity</th><th>Rate</th><th>per</th><th>Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="center">1</td>
                <td className="val">{description}</td>
                <td className="center">{hsn}</td>
                <td className="right val">{qtyStr}</td>
                <td className="right">{Number(order.ratePerKg).toFixed(2)}</td>
                <td className="center">Kgs</td>
                <td className="right val">{inr(amounts.base)}</td>
              </tr>
              <tr>
                <td className="nob" />
                <td className="nob right val" style={{ fontStyle: 'italic' }}>IGST {gstPct}%</td>
                <td className="nob" />
                <td className="nob" />
                <td className="nob right">{gstPct} %</td>
                <td className="nob" />
                <td className="nob right">{inr(amounts.gst)}</td>
              </tr>
              <tr>
                <td className="nob" style={{ height: '36px' }} /><td className="nob" /><td className="nob" /><td className="nob" /><td className="nob" /><td className="nob" /><td className="nob" />
              </tr>
              <tr style={{ fontWeight: 'bold' }}>
                <td className="right" colSpan={3}>Total</td>
                <td className="right">{qtyStr}</td>
                <td /><td />
                <td className="right">&#8377; {inr(amounts.total)}</td>
              </tr>
            </tbody>
          </table>

          {/* Amount in words */}
          <table className="sec">
            <tbody>
              <tr>
                <td className="lbl">Amount Chargeable (in words)<div className="val" style={{ marginTop: 2 }}>{rupeesInWords(amounts.total)}</div></td>
                <td className="right lbl" style={{ width: '20%' }}>E. &amp; O.E</td>
              </tr>
            </tbody>
          </table>

          {/* HSN / tax summary */}
          <table className="sec">
            <thead className="center" style={{ fontWeight: 'bold' }}>
              <tr>
                <th rowSpan={2}>HSN/SAC</th><th rowSpan={2}>Taxable Value</th><th colSpan={2}>IGST</th><th rowSpan={2}>Total Tax Amount</th>
              </tr>
              <tr><th>Rate</th><th>Amount</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>{hsn}</td>
                <td className="right">{inr(amounts.base)}</td>
                <td className="center">{gstPct}%</td>
                <td className="right">{inr(amounts.gst)}</td>
                <td className="right">{inr(amounts.gst)}</td>
              </tr>
              <tr style={{ fontWeight: 'bold' }}>
                <td className="right">Total</td>
                <td className="right">{inr(amounts.base)}</td>
                <td />
                <td className="right">{inr(amounts.gst)}</td>
                <td className="right">{inr(amounts.gst)}</td>
              </tr>
            </tbody>
          </table>

          {/* Tax amount in words */}
          <table className="sec">
            <tbody>
              <tr><td className="lbl">Tax Amount (in words) : <span className="val">{rupeesInWords(amounts.gst)}</span></td></tr>
            </tbody>
          </table>

          {/* Declaration + bank */}
          <table className="sec">
            <colgroup><col style={{ width: '55%' }} /><col style={{ width: '45%' }} /></colgroup>
            <tbody>
              <tr>
                <td className="lbl">
                  <div>Declaration</div>
                  <div>We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.</div>
                  <div style={{ fontWeight: 'bold', marginTop: 4 }}>Terms &amp; Conditions</div>
                  <div>1. Goods once sold will not be taken back.</div>
                  <div>2. Interest @ 18% p.a. will be charged if the payment is not made within the stipulated time.</div>
                  {company.stateName && <div>3. Subject to '{company.stateName}' Jurisdiction only.</div>}
                </td>
                <td className="lbl">
                  <div style={{ fontWeight: 'bold' }}>Company's Bank Details</div>
                  <BankRow k="A/c Holder's Name" v={company.bankAccountName || company.name} />
                  <BankRow k="Bank Name" v={company.bankName} />
                  <BankRow k="A/c No." v={company.bankAccountNumber} />
                  <BankRow k="Branch & IFS Code" v={company.bankBranchIfsc} />
                  <div className="right" style={{ fontWeight: 'bold', marginTop: 10 }}>for {company.name}</div>
                  <div className="right" style={{ marginTop: 28 }}>Authorised Signatory</div>
                </td>
              </tr>
            </tbody>
          </table>

          <div className="center lbl" style={{ marginTop: 4 }}>This is a Computer Generated Invoice</div>
        </div>
      </div>
    </div>
  );
}

function MetaCell({ label, value, colSpan }: { label: string; value: string; colSpan?: number }) {
  return (
    <td colSpan={colSpan} style={{ minHeight: 26 }}>
      <div className="lbl">{label}</div>
      <div className="val" style={{ minHeight: '1em' }}>{value}</div>
    </td>
  );
}

function BankRow({ k, v }: { k: string; v: string | null | undefined }) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      <span style={{ minWidth: '42%' }}>{k} :</span>
      <span className="val">{v || ''}</span>
    </div>
  );
}

function Ctl({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">{label}</span>{children}</label>;
}

function Num({ label, value, onChange, min, max, step = 1, small }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; small?: boolean }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input type="number" value={value} min={min} max={max} step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`h-8 rounded-md border bg-background px-2 ${small ? 'w-14' : 'w-24'}`} />
    </label>
  );
}
