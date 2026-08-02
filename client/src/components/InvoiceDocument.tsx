import { useMemo } from 'react';
import type { SaleDispatch, SaleOrder, CompanyProfile, ProductTaxInfo } from '@/lib/types';
import { inr, rupeesInWords } from '@/lib/invoiceWords';
import AuthorisedSignature from '@/components/AuthorisedSignature';

const GST_RATE = 0.05;

export const PAPER_W: Record<string, number> = { A4: 210, A5: 148, Letter: 216 };

/** Bumped whenever DEFAULT_LAYOUT changes shape enough that a stale saved layout would look wrong. */
const LAYOUT_VERSION = 2;

export interface InvoiceLayout {
  v: number;
  paperSize: 'A4' | 'A5' | 'Letter';
  marginMm: number;
  fontPx: number;
  headerLeftPct: number;
  /** Side of the square e-invoice QR, in mm. */
  qrMm: number;
  cols: { sl: number; desc: number; hsn: number; qty: number; rate: number; per: number; amt: number };
}

export const DEFAULT_LAYOUT: InvoiceLayout = {
  v: LAYOUT_VERSION,
  paperSize: 'A4',
  marginMm: 15,
  fontPx: 12,
  headerLeftPct: 51,
  qrMm: 38,
  cols: { sl: 4, desc: 47, hsn: 9, qty: 11, rate: 6, per: 5, amt: 18 },
};

/** Merge the saved company layout JSON over the defaults, tolerating junk and stale versions. */
export function parseInvoiceLayout(saved: string | null | undefined): InvoiceLayout {
  if (!saved) return DEFAULT_LAYOUT;
  try {
    const parsed = JSON.parse(saved);
    if (parsed?.v !== LAYOUT_VERSION) return DEFAULT_LAYOUT;
    return { ...DEFAULT_LAYOUT, ...parsed, v: LAYOUT_VERSION, cols: { ...DEFAULT_LAYOUT.cols, ...parsed.cols } };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** Stylesheet the printed page needs - mounted once by whoever renders the doc. */
export function InvoiceStyles({ paperSize }: { paperSize: InvoiceLayout['paperSize'] }) {
  return (
    <style>{`
      @page { size: ${paperSize}; margin: 0; }
      @media print {
        body { background: #fff; }
        .inv-no-print { display: none !important; }
        .inv-page { box-shadow: none !important; margin: 0 !important; }
      }
      .inv-page { font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff; line-height: 1.28; }
      /* Auto layout on purpose: the colgroup percentages below are honoured
         while the content fits, and a column that needs more (a long invoice
         number, a 7-digit taxable value) grows instead of spilling over its
         neighbour. Never set table-layout:fixed here - fixed columns cannot
         grow, and values like RVP/105/26-27 have no space to wrap at. */
      .inv-page table { border-collapse: collapse; width: 100%; border: 1px solid #000; }
      /* Only where an exact split matters and the content is prose that wraps. */
      .inv-page .fixedcols { table-layout: fixed; }
      /* Backstop: an unbroken token longer than any sane column still wraps
         rather than overlapping. */
      .inv-page td, .inv-page th { border: 1px solid #000; vertical-align: top; padding: 3px 6px; overflow-wrap: break-word; }
      .inv-page th { font-weight: bold; }
      .inv-page .lbl { line-height: 1.28; }
      .inv-page .val { font-weight: bold; }
      .inv-page .cap { font-size: 0.9em; }
      .inv-page .sec { margin-top: -1px; }
      .inv-page .tight { font-size: 0.92em; }
      /* Every cell in the HSN summary is a short token - keep them on one line
         so the columns size to them (explicit <br> still breaks where wanted). */
      .inv-page .tight td, .inv-page .tight th { padding: 1px 6px; white-space: nowrap; }
      .inv-page .nob { border: 0 !important; }
      /* Item + tax + filler rows are one open block: the column rules run
         through them, but no horizontal rules divide them. */
      .inv-page .noh td { border-top: 0 !important; border-bottom: 0 !important; }
      .inv-page .center { text-align: center; }
      .inv-page .right { text-align: right; }
      /* Values that must never break mid-token (invoice numbers, EWB numbers,
         amounts). nowrap raises the column's min-content width, which is what
         makes auto layout widen the column to fit instead of overflowing it. */
      .inv-page .nw { white-space: nowrap; }
    `}</style>
  );
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '';
  const dateObj = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(dateObj.getTime())) return '';
  return dateObj.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }).replace(/ /g, '-');
}

const PRODUCT_FALLBACK: Record<string, string> = {
  PAPPU: 'Tamarind Seed Kernel', HUSK: 'Tamarind Husk', WASTE: 'Tamarind Waste', TPS: 'Tamarind Seed Brokens', SHELL: 'Tamarind Shell',
};

interface Props {
  dispatch: SaleDispatch;
  order: SaleOrder;
  company: CompanyProfile;
  taxRows?: ProductTaxInfo[];
  layout: InvoiceLayout;
  /** Draft mode: the number isn't assigned yet, so watermark it and show the number that WILL be used. */
  preview?: boolean;
  previewNumber?: string | null;
  previewDate?: string | null;
}

/**
 * The printable tax-invoice page itself. Shared by the post-raise invoice view
 * and the pre-raise preview, so what the user checks is exactly what prints.
 */
export function InvoiceDocument({ dispatch, order, company, taxRows, layout, preview, previewNumber, previewDate }: Props) {
  const tax = taxRows?.find((t) => t.product === order.product);
  const gstFraction = order.gstExempt ? 0 : (tax?.gstRate != null ? Number(tax.gstRate) : GST_RATE * 100) / 100;
  const amounts = useMemo(() => {
    const base = (dispatch.weightKg ?? 0) * (Number(order.ratePerKg) || 0);
    const gst = Math.round(base * gstFraction * 100) / 100;
    return { base, gst, total: base + gst };
  }, [dispatch, order, gstFraction]);

  const paperW = PAPER_W[layout.paperSize] ?? 210;
  const gstPct = Math.round(gstFraction * 100);
  const buyerGstin = order.buyer?.gstin ?? null;
  const buyerStateCode = buyerGstin && /^\d{2}/.test(buyerGstin) ? buyerGstin.slice(0, 2) : null;
  const buyerPan = buyerGstin && buyerGstin.length >= 12 ? buyerGstin.slice(2, 12) : null;
  const description = tax?.description || PRODUCT_FALLBACK[order.product] || order.product;
  const hsn = tax?.hsn || '';
  const qtyStr = `${(dispatch.weightKg ?? 0).toLocaleString('en-IN')} Kgs`;
  const c = layout.cols;
  const metaCol = (100 - layout.headerLeftPct) / 4;

  const sellerStateCode = company.gstin?.slice(0, 2) || '';
  const isSameState = sellerStateCode === buyerStateCode && sellerStateCode !== '';

  const shownNumber = preview ? (previewNumber ?? '') : (dispatch.invoiceNumber ?? '');
  const shownDate = preview
    ? fmtDate(previewDate ?? new Date())
    : (dispatch.invoiceDate ? fmtDate(new Date(dispatch.invoiceDate)) : '');

  return (
    <div
      className="inv-page shadow-lg"
      style={{ width: `${paperW}mm`, padding: `${layout.marginMm}mm`, fontSize: `${layout.fontPx}px`, position: 'relative' }}
    >
      {preview && (
        <div
          aria-hidden
          style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none', zIndex: 1,
          }}
        >
          <span style={{ transform: 'rotate(-28deg)', fontSize: '80px', fontWeight: 800, color: 'rgba(180,83,9,0.10)', letterSpacing: '0.15em' }}>
            PREVIEW
          </span>
        </div>
      )}

      {/* Title & IRN / e-Invoice header block */}
      {dispatch.irn ? (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6mm', marginBottom: '5mm' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="center" style={{ fontWeight: 'bold', fontSize: '1.85em', letterSpacing: '0.01em' }}>Tax Invoice</div>
            <div style={{ marginTop: '9mm' }}>
              <IrnRow k="IRN" v={dispatch.irn} />
              <IrnRow k="Ack No." v={dispatch.irnAckNo || '-'} />
              <IrnRow k="Ack Date" v={dispatch.irnAckDate ? fmtDate(new Date(dispatch.irnAckDate)) : '-'} />
            </div>
          </div>

          <div style={{ width: `${layout.qrMm}mm`, flexShrink: 0, textAlign: 'center' }}>
            <div style={{ fontWeight: 'bold', marginBottom: '2mm' }}>e-Invoice</div>
            {dispatch.irnSignedQr && (
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=500x500&margin=0&data=${encodeURIComponent(dispatch.irnSignedQr)}`}
                alt="e-Invoice QR Code"
                style={{ width: `${layout.qrMm}mm`, height: `${layout.qrMm}mm`, display: 'block' }}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="center" style={{ fontWeight: 'bold', fontSize: '1.85em', marginBottom: '5mm', letterSpacing: '0.01em' }}>Tax Invoice</div>
      )}

      {/* Header: seller/buyer + meta grid */}
      <table className="sec">
        <colgroup>
          <col style={{ width: `${layout.headerLeftPct}%` }} />
          <col style={{ width: `${metaCol}%` }} />
          <col style={{ width: `${metaCol}%` }} />
          <col style={{ width: `${metaCol}%` }} />
          <col style={{ width: `${metaCol}%` }} />
        </colgroup>
        <tbody>
          <tr>
            <td rowSpan={8} style={{ padding: 0 }}>
              <div style={{ padding: '5px 8px', borderBottom: '1px solid #000' }}>
                <div style={{ fontWeight: 'bold', fontSize: '1.15em', letterSpacing: '0.02em' }}>{company.name}</div>
                {company.address && <div className="lbl" style={{ whiteSpace: 'pre-line', marginTop: '2px' }}>{company.address}</div>}
                {company.gstin && <div className="lbl" style={{ marginTop: '2px' }}>GSTIN/UIN: <span className="val">{company.gstin}</span></div>}
                {company.stateName && <div className="lbl">State Name : {company.stateName}{company.stateCode ? `, Code : ${company.stateCode}` : ''}</div>}
                {company.contact && <div className="lbl">Contact : {company.contact}</div>}
              </div>
              <div style={{ padding: '5px 8px' }}>
                <div className="lbl">Buyer (Bill to)</div>
                <div style={{ fontWeight: 'bold', fontSize: '1.15em', marginTop: '2px' }}>{order.buyer?.name}</div>
                {order.buyer?.address && <div className="lbl" style={{ whiteSpace: 'pre-line', marginTop: '2px' }}>{order.buyer.address}</div>}
                {buyerGstin && <KeyedLine k="GSTIN/UIN" v={buyerGstin} style={{ marginTop: '2px' }} />}
                {buyerPan && <KeyedLine k="PAN/IT No" v={buyerPan} />}
                {order.buyer?.state && <KeyedLine k="State Name" v={`${order.buyer.state}${buyerStateCode ? `, Code : ${buyerStateCode}` : ''}`} plain />}
                {order.buyer?.state && <KeyedLine k="Place of Supply" v={order.buyer.state} plain />}
              </div>
            </td>
            <MetaCell label="Invoice No." value={shownNumber} isBold />
            <MetaCell label="e-Way Bill No." value={dispatch.ewbNumber ?? ''} isBold />
            <MetaCell colSpan={2} label="Dated" value={shownDate} isBold />
          </tr>
          <tr><MetaCell colSpan={2} label="Delivery Note" value="" /><MetaCell colSpan={2} label="Mode/Terms of Payment" value="" /></tr>
          <tr><MetaCell colSpan={2} label="Reference No. & Date." value="" /><MetaCell colSpan={2} label="Other References" value="" /></tr>
          <tr><MetaCell colSpan={2} label="Buyer's Order No." value="" /><MetaCell colSpan={2} label="Dated" value="" /></tr>
          <tr><MetaCell colSpan={2} label="Dispatch Doc No." value="" /><MetaCell colSpan={2} label="Delivery Note Date" value="" /></tr>
          <tr><MetaCell colSpan={2} label="Dispatched through" value="Road" isBold /><MetaCell colSpan={2} label="Destination" value={order.destination || order.buyer?.state || ''} isBold /></tr>
          <tr><MetaCell colSpan={2} label="Bill of Lading/LR-RR No." value="" /><MetaCell colSpan={2} label="Motor Vehicle No." value={dispatch.vehicleNumber ?? ''} isBold /></tr>
          <tr><MetaCell colSpan={4} label="Terms of Delivery" value="" /></tr>
        </tbody>
      </table>

      {/* Goods table */}
      <table className="sec">
        <colgroup>
          <col style={{ width: `${c.sl}%` }} /><col style={{ width: `${c.desc}%` }} /><col style={{ width: `${c.hsn}%` }} />
          <col style={{ width: `${c.qty}%` }} /><col style={{ width: `${c.rate}%` }} /><col style={{ width: `${c.per}%` }} /><col style={{ width: `${c.amt}%` }} />
        </colgroup>
        <thead>
          <tr className="center">
            <th className="nw" style={{ textAlign: 'left' }}>Sl<br />No.</th><th>Description of Goods</th><th className="nw">HSN/SAC</th><th className="nw">Quantity</th><th className="nw">Rate</th><th className="nw">per</th><th className="nw">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr className="noh">
            <td className="center val">1</td>
            <td className="val">{description}</td>
            <td className="nw">{hsn}</td>
            <td className="right val nw">{qtyStr}</td>
            <td className="right nw">{Number(order.ratePerKg).toFixed(2)}</td>
            <td className="nw">Kgs</td>
            <td className="right val nw">{inr(amounts.base)}</td>
          </tr>

          {!order.gstExempt && (
            isSameState ? (
              <>
                <TaxLine label={`CGST ${(gstPct / 2).toFixed(1)}%`} rate={(gstPct / 2).toFixed(1)} amount={amounts.gst / 2} />
                <TaxLine label={`SGST ${(gstPct / 2).toFixed(1)}%`} rate={(gstPct / 2).toFixed(1)} amount={amounts.gst / 2} />
              </>
            ) : (
              <TaxLine label={`IGST ${gstPct}%`} rate={String(gstPct)} amount={amounts.gst} />
            )
          )}

          <tr className="noh" style={{ height: '10px' }}>
            <td /><td /><td /><td /><td /><td /><td />
          </tr>

          <tr className="val">
            <td className="right" colSpan={2}>Total</td>
            <td />
            <td className="right nw">{qtyStr}</td>
            <td /><td />
            <td className="right nw">&#8377; {inr(amounts.total)}</td>
          </tr>
        </tbody>
      </table>

      {/* Amount in words */}
      <table className="sec">
        <tbody>
          <tr>
            <td style={{ padding: '4px 8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '6mm' }}>
                <span className="cap">Amount Chargeable (in words)</span>
                <span className="cap" style={{ fontStyle: 'italic' }}>E. &amp; O.E</span>
              </div>
              <div className="val">{rupeesInWords(amounts.total)}</div>
            </td>
          </tr>
        </tbody>
      </table>

      {/* HSN / tax summary */}
      <table className="sec tight">
        <colgroup>
          {isSameState ? (
            <>
              <col style={{ width: '41%' }} /><col style={{ width: '11%' }} />
              <col style={{ width: '6%' }} /><col style={{ width: '12%' }} />
              <col style={{ width: '6%' }} /><col style={{ width: '12%' }} />
              <col style={{ width: '12%' }} />
            </>
          ) : (
            <>
              <col style={{ width: '59%' }} /><col style={{ width: '11%' }} />
              <col style={{ width: '6%' }} /><col style={{ width: '12%' }} />
              <col style={{ width: '12%' }} />
            </>
          )}
        </colgroup>
        <thead className="center">
          <tr>
            <th rowSpan={2}>HSN/SAC</th>
            <th rowSpan={2}>Taxable<br />Value</th>
            {isSameState ? (
              <>
                <th colSpan={2}>Central Tax</th>
                <th colSpan={2}>State Tax</th>
              </>
            ) : (
              <th colSpan={2}>IGST</th>
            )}
            <th rowSpan={2}>Total<br />Tax Amount</th>
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
            <td>{hsn}</td>
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
          <tr className="val">
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
            <td className="lbl" style={{ padding: '4px 8px' }}>
              Tax Amount (in words) : <span className="val">{rupeesInWords(amounts.gst)}</span>
            </td>
          </tr>
        </tbody>
      </table>

      {/* Declaration + bank */}
      <table className="sec fixedcols">
        <colgroup><col style={{ width: '50%' }} /><col style={{ width: '50%' }} /></colgroup>
        <tbody>
          <tr>
            <td className="lbl" style={{ padding: '4px 8px' }}>
              <div style={{ textDecoration: 'underline' }}>Declaration</div>
              <div style={{ marginTop: 2 }}>We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.</div>
              <div style={{ fontWeight: 'bold', marginTop: 6 }}>Terms &amp; Conditions</div>
              <div>E. &amp; O.E.</div>
              <div>1. Goods once sold will not be taken back.</div>
              <div>2. Interest @ 18% p.a. will be charged</div>
              <div>if the payment is not made with in the stipulated time.</div>
              {company.stateName && <div>3. Subject to '{company.stateName}' Jurisdiction only.</div>}
            </td>
            <td className="lbl" style={{ padding: 0 }}>
              <div style={{ padding: '4px 8px' }}>
                <div style={{ fontWeight: 'bold', marginBottom: 3 }}>Company's Bank Details</div>
                <BankRow k="A/c Holder's Name" v={company.bankAccountName || company.name} />
                <BankRow k="Bank Name" v={company.bankName} />
                <BankRow k="A/c No." v={company.bankAccountNumber} />
                <BankRow k="Branch & IFS Code" v={company.bankBranchIfsc} />
              </div>
              <div style={{ borderTop: '1px solid #000', padding: '4px 8px' }}>
                <AuthorisedSignature companyName={company.name} signHeight={32} stampSize={60} />
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <div className="center lbl" style={{ marginTop: 6 }}>This is a Computer Generated Invoice</div>
    </div>
  );
}

/** One "IRN : value" line in the e-invoice header, with the colons aligned. */
function IrnRow({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', marginBottom: '1.5mm' }}>
      <span style={{ width: '17mm', flexShrink: 0 }}>{k}</span>
      <span style={{ flexShrink: 0, paddingRight: '2mm' }}>:</span>
      <span className="val" style={{ wordBreak: 'break-all', minWidth: 0 }}>{v}</span>
    </div>
  );
}

/** Buyer-block line with the label and value colons lined up, Tally style. */
function KeyedLine({ k, v, plain, style }: { k: string; v: string; plain?: boolean; style?: React.CSSProperties }) {
  return (
    <div className="lbl" style={{ display: 'flex', ...style }}>
      <span style={{ width: '30mm', flexShrink: 0 }}>{k}</span>
      <span style={{ flexShrink: 0, paddingRight: '2mm' }}>:</span>
      <span className={plain ? undefined : 'val'} style={{ minWidth: 0 }}>{v}</span>
    </div>
  );
}

function TaxLine({ label, rate, amount }: { label: string; rate: string; amount: number }) {
  return (
    <tr className="noh">
      <td />
      <td className="right val" style={{ fontStyle: 'italic' }}>{label}</td>
      <td />
      <td />
      <td className="right">{rate}</td>
      <td>%</td>
      <td className="right val">{inr(amount)}</td>
    </tr>
  );
}

function MetaCell({ label, value, colSpan, isBold }: { label: string; value: string; colSpan?: number; isBold?: boolean }) {
  return (
    <td colSpan={colSpan} style={{ padding: '3px 6px' }}>
      <div className="cap nw">{label}</div>
      <div className={`nw ${isBold ? 'val' : ''}`} style={{ minHeight: '1.2em' }}>{value}</div>
    </td>
  );
}

function BankRow({ k, v }: { k: string; v: string | null | undefined }) {
  return (
    <div style={{ display: 'flex', marginBottom: 2 }}>
      <span style={{ width: '34mm', flexShrink: 0 }}>{k}</span>
      <span style={{ flexShrink: 0, paddingRight: '2mm' }}>:</span>
      <span className="val" style={{ minWidth: 0 }}>{v || ''}</span>
    </div>
  );
}
