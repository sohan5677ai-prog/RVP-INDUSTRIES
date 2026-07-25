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
  fontPx: 12,
  headerLeftPct: 56,
  cols: { sl: 5, desc: 33, hsn: 11, qty: 15, rate: 12, per: 7, amt: 17 },
};

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '';
  const dateObj = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(dateObj.getTime())) return '';
  return dateObj.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }).replace(/ /g, '-');
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
  const gstFraction = order?.gstExempt ? 0 : (tax?.gstRate != null ? Number(tax.gstRate) : GST_RATE * 100) / 100;
  const amounts = useMemo(() => {
    if (!dispatch || !order) return { base: 0, gst: 0, total: 0 };
    const base = (dispatch.weightKg ?? 0) * (Number(order.ratePerKg) || 0);
    const gst = Math.round(base * gstFraction * 100) / 100;
    return { base, gst, total: base + gst };
  }, [dispatch, order, gstFraction]);

  if (!dispatch || !order || !company) return <div className="p-8 text-muted-foreground">Loading invoice…</div>;

  const paperW = PAPER_W[layout.paperSize] ?? 210;
  const gstPct = Math.round(gstFraction * 100);
  const buyerGstin = order.buyer?.gstin ?? null;
  const buyerStateCode = buyerGstin && /^\d{2}/.test(buyerGstin) ? buyerGstin.slice(0, 2) : null;
  const buyerPan = buyerGstin && buyerGstin.length >= 12 ? buyerGstin.slice(2, 12) : null;
  const description = tax?.description || PRODUCT_FALLBACK[order.product] || order.product;
  const hsn = tax?.hsn || '';
  const qtyStr = `${(dispatch.weightKg ?? 0).toLocaleString('en-IN')} Kgs`;
  const c = layout.cols;

  const sellerStateCode = company.gstin?.slice(0, 2) || '';
  const isSameState = sellerStateCode === buyerStateCode && sellerStateCode !== '';

  return (
    <div className="min-h-screen bg-muted/40 font-sans">
      <style>{`
        @page { size: ${layout.paperSize}; margin: 0; }
        @media print {
          body { background: #fff; }
          .inv-no-print { display: none !important; }
          .inv-page { box-shadow: none !important; margin: 0 !important; }
        }
        .inv-page { font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff; line-height: 1.3; }
        .inv-page table { border-collapse: collapse; width: 100%; border: 1px solid #000; }
        .inv-page td, .inv-page th { border: 1px solid #000; vertical-align: top; padding: 4px 6px; }
        .inv-page .lbl { font-size: 0.85em; color: #333; line-height: 1.25; }
        .inv-page .val { font-weight: bold; color: #000; line-height: 1.25; }
        .inv-page .sec { margin-top: -1px; }
        .inv-page .nob { border: 0 !important; }
        .inv-page .center { text-align: center; }
        .inv-page .right { text-align: right; }
      `}</style>

      {/* Toolbar (not printed) */}
      <div className="inv-no-print sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2 shadow-sm">
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
          {/* Title & IRN / e-Invoice header block */}
          {dispatch.irn ? (
            <div className="relative mb-3 pb-2 border-b border-black">
              <div className="center font-extrabold text-2xl tracking-wide">Tax Invoice</div>
              <div className="absolute right-0 top-0 text-sm font-sans font-medium">e-Invoice</div>
              
              <div className="flex justify-between items-start mt-2">
                <div className="text-[0.88em] space-y-1">
                  <div className="flex"><span className="font-bold w-16 shrink-0">IRN</span><span className="font-mono font-bold break-all">: {dispatch.irn}</span></div>
                  <div className="flex"><span className="font-bold w-16 shrink-0">Ack No.</span><span className="font-bold">: {dispatch.irnAckNo || '-'}</span></div>
                  <div className="flex"><span className="font-bold w-16 shrink-0">Ack Date</span><span className="font-bold">: {dispatch.irnAckDate ? fmtDate(new Date(dispatch.irnAckDate)) : '-'}</span></div>
                </div>

                {dispatch.irnSignedQr && (
                  <div className="w-24 h-24 border border-black p-1 flex items-center justify-center shrink-0">
                    <img 
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(dispatch.irnSignedQr)}`} 
                      alt="e-Invoice QR Code"
                      className="w-full h-full object-contain"
                    />
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="center font-extrabold text-2xl mb-3 tracking-wide">Tax Invoice</div>
          )}

          {/* Header: seller/buyer + meta grid */}
          <table className="sec">
            <colgroup>
              <col style={{ width: `${layout.headerLeftPct}%` }} />
              <col style={{ width: `${(100 - layout.headerLeftPct) / 3}%` }} />
              <col style={{ width: `${(100 - layout.headerLeftPct) / 3}%` }} />
              <col style={{ width: `${(100 - layout.headerLeftPct) / 3}%` }} />
            </colgroup>
            <tbody>
              <tr>
                <td rowSpan={8} style={{ padding: 0 }}>
                  <div style={{ padding: '6px 8px', borderBottom: '1px solid #000' }}>
                    <div style={{ fontWeight: 'bold', fontSize: '1.2em', letterSpacing: '0.02em' }}>{company.name}</div>
                    {company.address && <div className="lbl" style={{ whiteSpace: 'pre-line', marginTop: '2px' }}>{company.address}</div>}
                    {company.gstin && <div className="lbl" style={{ marginTop: '2px' }}>GSTIN/UIN: <span className="val">{company.gstin}</span></div>}
                    {company.stateName && <div className="lbl">State Name : {company.stateName}{company.stateCode ? `, Code : ${company.stateCode}` : ''}</div>}
                    {company.contact && <div className="lbl">Contact : {company.contact}</div>}
                  </div>
                  <div style={{ padding: '6px 8px' }}>
                    <div className="lbl" style={{ color: '#555' }}>Buyer (Bill to)</div>
                    <div style={{ fontWeight: 'bold', fontSize: '1.1em', marginTop: '2px' }}>{order.buyer?.name}</div>
                    {order.buyer?.address && <div className="lbl" style={{ whiteSpace: 'pre-line', marginTop: '2px' }}>{order.buyer.address}</div>}
                    {buyerGstin && <div className="lbl" style={{ marginTop: '2px' }}>GSTIN/UIN : <span className="val">{buyerGstin}</span></div>}
                    {buyerPan && <div className="lbl">PAN/IT No : <span className="val">{buyerPan}</span></div>}
                    {order.buyer?.state && <div className="lbl">State Name : {order.buyer.state}{buyerStateCode ? `, Code : ${buyerStateCode}` : ''}</div>}
                    {order.buyer?.state && <div className="lbl">Place of Supply : {order.buyer.state}</div>}
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
              <tr><MetaCell colSpan={2} label="Dispatched through" value="Road" /><MetaCell label="Destination" value={order.destination || order.buyer?.state || ''} /></tr>
              <tr><MetaCell colSpan={2} label="Bill of Lading/LR-RR No." value="" /><MetaCell label="Motor Vehicle No." value={dispatch.vehicleNumber ?? ''} isBold /></tr>
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
              <tr style={{ fontWeight: 'bold', backgroundColor: '#f8f9fa' }} className="center">
                <th>Sl<br />No.</th><th>Description of Goods</th><th>HSN/SAC</th><th>Quantity</th><th>Rate</th><th>per</th><th>Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="center val">1</td>
                <td className="val">{description}</td>
                <td className="center">{hsn}</td>
                <td className="right val">{qtyStr}</td>
                <td className="right">{Number(order.ratePerKg).toFixed(2)}</td>
                <td className="center">Kgs</td>
                <td className="right val">{inr(amounts.base)}</td>
              </tr>

              {!order.gstExempt && (
                isSameState ? (
                  <>
                    <tr>
                      <td className="nob" />
                      <td className="nob right val" style={{ fontStyle: 'italic' }}>CGST {(gstPct / 2).toFixed(1)}%</td>
                      <td className="nob" />
                      <td className="nob" />
                      <td className="nob center">{(gstPct / 2).toFixed(1)} %</td>
                      <td className="nob" />
                      <td className="nob right val">{inr(amounts.gst / 2)}</td>
                    </tr>
                    <tr>
                      <td className="nob" />
                      <td className="nob right val" style={{ fontStyle: 'italic' }}>SGST {(gstPct / 2).toFixed(1)}%</td>
                      <td className="nob" />
                      <td className="nob" />
                      <td className="nob center">{(gstPct / 2).toFixed(1)} %</td>
                      <td className="nob" />
                      <td className="nob right val">{inr(amounts.gst / 2)}</td>
                    </tr>
                  </>
                ) : (
                  <tr>
                    <td className="nob" />
                    <td className="nob right val" style={{ fontStyle: 'italic' }}>IGST {gstPct}%</td>
                    <td className="nob" />
                    <td className="nob" />
                    <td className="nob center">{gstPct} %</td>
                    <td className="nob" />
                    <td className="nob right val">{inr(amounts.gst)}</td>
                  </tr>
                )
              )}

              <tr style={{ height: '44px' }}>
                <td className="nob" /><td className="nob" /><td className="nob" /><td className="nob" /><td className="nob" /><td className="nob" /><td className="nob" />
              </tr>

              <tr style={{ fontWeight: 'bold', backgroundColor: '#fafafa' }}>
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
                <td className="lbl" style={{ padding: '6px 8px' }}>
                  <div style={{ color: '#555', fontSize: '0.85em' }}>Amount Chargeable (in words)</div>
                  <div className="val" style={{ marginTop: 2, fontSize: '1.05em' }}>{rupeesInWords(amounts.total)}</div>
                </td>
                <td className="right lbl val" style={{ width: '20%', padding: '6px 8px' }}>E. &amp; O.E</td>
              </tr>
            </tbody>
          </table>

          {/* HSN / tax summary */}
          <table className="sec">
            <thead className="center" style={{ fontWeight: 'bold', backgroundColor: '#f8f9fa' }}>
              <tr>
                <th rowSpan={2}>HSN/SAC</th>
                <th rowSpan={2}>Taxable Value</th>
                {isSameState ? (
                  <>
                    <th colSpan={2}>Central Tax</th>
                    <th colSpan={2}>State Tax</th>
                  </>
                ) : (
                  <th colSpan={2}>IGST</th>
                )}
                <th rowSpan={2}>Total Tax Amount</th>
              </tr>
              <tr>
                {isSameState ? (
                  <><th>Rate</th><th>Amount</th><th>Rate</th><th>Amount</th></>
                ) : (
                  <><th>Rate</th><th>Amount</th></>
                )}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="center">{hsn}</td>
                <td className="right">{inr(amounts.base)}</td>
                {isSameState ? (
                  <>
                    <td className="center">{(gstPct / 2).toFixed(1)}%</td>
                    <td className="right">{inr(amounts.gst / 2)}</td>
                    <td className="center">{(gstPct / 2).toFixed(1)}%</td>
                    <td className="right">{inr(amounts.gst / 2)}</td>
                  </>
                ) : (
                  <>
                    <td className="center">{gstPct}%</td>
                    <td className="right">{inr(amounts.gst)}</td>
                  </>
                )}
                <td className="right">{inr(amounts.gst)}</td>
              </tr>
              <tr style={{ fontWeight: 'bold', backgroundColor: '#fafafa' }}>
                <td className="right">Total</td>
                <td className="right">{inr(amounts.base)}</td>
                {isSameState ? (
                  <>
                    <td />
                    <td className="right">{inr(amounts.gst / 2)}</td>
                    <td />
                    <td className="right">{inr(amounts.gst / 2)}</td>
                  </>
                ) : (
                  <>
                    <td />
                    <td className="right">{inr(amounts.gst)}</td>
                  </>
                )}
                <td className="right">{inr(amounts.gst)}</td>
              </tr>
            </tbody>
          </table>

          {/* Tax amount in words */}
          <table className="sec">
            <tbody>
              <tr>
                <td className="lbl" style={{ padding: '6px 8px' }}>
                  Tax Amount (in words) : <span className="val">{rupeesInWords(amounts.gst)}</span>
                </td>
              </tr>
            </tbody>
          </table>

          {/* Declaration + bank */}
          <table className="sec">
            <colgroup><col style={{ width: '55%' }} /><col style={{ width: '45%' }} /></colgroup>
            <tbody>
              <tr>
                <td className="lbl" style={{ padding: '6px 8px' }}>
                  <div style={{ fontWeight: 'bold' }}>Declaration</div>
                  <div style={{ marginTop: 2, lineHeight: 1.25 }}>We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.</div>
                  <div style={{ fontWeight: 'bold', marginTop: 6 }}>Terms &amp; Conditions</div>
                  <div style={{ color: '#555' }}>E. &amp; O.E.</div>
                  <div>1. Goods once sold will not be taken back.</div>
                  <div>2. Interest @ 18% p.a. will be charged if the payment is not made within the stipulated time.</div>
                  {company.stateName && <div>3. Subject to '{company.stateName}' Jurisdiction only.</div>}
                </td>
                <td className="lbl" style={{ padding: '6px 8px' }}>
                  <div style={{ fontWeight: 'bold', marginBottom: 4 }}>Company's Bank Details</div>
                  <BankRow k="A/c Holder's Name" v={company.bankAccountName || company.name} />
                  <BankRow k="Bank Name" v={company.bankName} />
                  <BankRow k="A/c No." v={company.bankAccountNumber} />
                  <BankRow k="Branch & IFS Code" v={company.bankBranchIfsc} />
                  <div className="right" style={{ fontWeight: 'bold', marginTop: 14 }}>for {company.name}</div>
                  <div className="right" style={{ marginTop: 32 }}>Authorised Signatory</div>
                </td>
              </tr>
            </tbody>
          </table>

          <div className="center lbl" style={{ marginTop: 6, color: '#555' }}>This is a Computer Generated Invoice</div>
        </div>
      </div>
    </div>
  );
}

function MetaCell({ label, value, colSpan, isBold }: { label: string; value: string; colSpan?: number; isBold?: boolean }) {
  return (
    <td colSpan={colSpan} style={{ minHeight: 28, padding: '4px 6px' }}>
      <div className="lbl" style={{ fontSize: '0.82em', color: '#555' }}>{label}</div>
      <div className={isBold ? "val" : ""} style={{ minHeight: '1.1em', fontSize: '0.95em' }}>{value}</div>
    </td>
  );
}

function BankRow({ k, v }: { k: string; v: string | null | undefined }) {
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 2 }}>
      <span style={{ minWidth: '42%', color: '#333' }}>{k} :</span>
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
