import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Printer, ArrowLeft, Download } from 'lucide-react';
import { useState } from 'react';
import { api, apiBlob } from '@/lib/api';
import type { Purchase, WeightVerification, StockIn, PurchaseOrder, Party } from '@/lib/types';
import { computeQualityAdjustments, type QualityAdjustmentMode, type QualityAdjustmentRow } from '@/lib/calc';
import { Button } from '@/components/ui/button';
import { shortDate } from '@/lib/format';

type PurchaseDetails = Purchase & {
  verification: WeightVerification;
  stockIn: StockIn & {
    purchaseOrder: PurchaseOrder & {
      party: Party;
    };
  };
};

interface CompanyProfile {
  name: string;
  address?: string | null;
  gstin?: string | null;
  contact?: string | null;
}

/** Free allowance on the kata difference - keep in step with EXEMPT_KG on the server. */
const ALLOWANCE_KG = 80;

/** Short note appended to a deduction row so the party knows what it is. */
const MODE_NOTE: Record<QualityAdjustmentMode, string> = {
  WEIGHT: 'quality weight cut',
  PRICE: 'rate reduction',
  AMOUNT: 'quality discount',
  EXPENSE: 'expenses recovered',
  FREIGHT: 'lorry freight borne by party',
};

const qtyFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const moneyFmt = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const kg = (n: number) => `${qtyFmt.format(Math.round(n * 100) / 100)} kg`;
const money = (n: number) => moneyFmt.format(n);

interface Row {
  label: string;
  note?: string;
  qty?: string;
  rate?: string;
  amount: number;
  negative?: boolean;
  subtotal?: boolean;
}

export default function PurchaseStatement() {
  const { purchaseId } = useParams<{ purchaseId: string }>();
  const [downloading, setDownloading] = useState(false);

  const { data: purchase, isLoading, error } = useQuery({
    queryKey: ['purchases', purchaseId],
    queryFn: () => api<PurchaseDetails>(`/purchases/${purchaseId}`),
    enabled: !!purchaseId,
  });

  const { data: company } = useQuery({
    queryKey: ['settings', 'company'],
    queryFn: () => api<CompanyProfile>('/settings/company'),
    staleTime: 5 * 60 * 1000,
  });

  async function downloadPdf(verificationId: string, partyName: string, invoiceNumber: string) {
    setDownloading(true);
    try {
      const blob = await apiBlob(`/verifications/${verificationId}/statement.pdf`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Purchase-Statement-${`${partyName}-${invoiceNumber}`.replace(/[^\w]+/g, '-')}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        Loading purchase statement…
      </div>
    );
  }

  if (error || !purchase || !purchase.verification) {
    return (
      <div className="space-y-4 p-6 text-center">
        <p className="text-destructive font-semibold">Error loading purchase statement.</p>
        <Button asChild variant="outline">
          <Link to="/purchases">Back to Purchases</Link>
        </Button>
      </div>
    );
  }

  const { verification: v, stockIn } = purchase;
  const party = stockIn.purchaseOrder.party;
  const hasGst = stockIn.purchaseOrder.hasGst ?? false;
  const price = Number(v.pricePerKg);

  // --- Bill arithmetic (mirrors createVerification on the server) ------------
  // The kata difference is already folded into the verified payable weight, so
  // bill the reference weight and show the cut as its own line. When RVP weighed
  // HEAVIER than the reference there is no cut - we pay on the RVP net.
  const billedKg = Math.max(v.referenceKg, v.finalWeightKg);
  const kataDeductKg = Math.max(0, v.referenceKg - v.finalWeightKg);
  const grossSeed = billedKg * price;
  const kataDeductAmount = kataDeductKg * price;

  // Pre-feature verifications only carry the legacy single discount pair.
  let qaRows: QualityAdjustmentRow[] = v.qualityAdjustments ?? [];
  if (!qaRows.length && purchase.discountType && Number(purchase.discountValue) > 0) {
    qaRows = computeQualityAdjustments(
      [{ mode: purchase.discountType as QualityAdjustmentMode, value: Number(purchase.discountValue) }],
      v.finalWeightKg,
      price,
    ).rows;
  }

  const billAddables = (v.billAddables ?? []).filter((a) => a && a.label && Number(a.amount) > 0);
  const gstAmount = hasGst ? Math.round(v.billingWeightKg * price * 0.05 * 100) / 100 : 0;
  const selfVehicleHamali = Number(v.selfVehicleHamali ?? 0);
  const selfVehicleKata = Number(v.selfVehicleKata ?? 0);
  const netPayable = Number(v.totalAmount);

  const deductionsTotal = kataDeductAmount + qaRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const netSeedValue = grossSeed - deductionsTotal;
  const hasAdditions = gstAmount > 0 || billAddables.length > 0;
  const hasRecoveries = selfVehicleHamali > 0 || selfVehicleKata > 0;

  const rows: Row[] = [
    {
      label: 'Tamarind seed (black seed)',
      note: stockIn.selfVehicle ? "Delivered in party's own vehicle" : undefined,
      qty: kg(billedKg),
      rate: money(price),
      amount: grossSeed,
    },
  ];

  if (kataDeductKg > 0) {
    rows.push({
      label: 'Less : Kata difference',
      note: `${kg(v.diffKg)} short against ${kg(v.referenceKg)} reference, ${ALLOWANCE_KG} kg allowed free`,
      qty: kg(kataDeductKg),
      rate: money(price),
      amount: kataDeductAmount,
      negative: true,
    });
  }

  for (const r of qaRows) {
    const amount = Number(r.amount) || 0;
    if (!amount) continue;
    const note = MODE_NOTE[r.mode];
    rows.push({
      label: `Less : ${r.label}`,
      note: r.label.toLowerCase() === note ? undefined : note,
      qty: r.mode === 'WEIGHT' ? kg(r.value) : undefined,
      rate: r.mode === 'WEIGHT' ? money(price) : r.mode === 'PRICE' ? `${money(r.value)}/kg` : undefined,
      amount,
      negative: true,
    });
  }

  if (deductionsTotal > 0 && (hasAdditions || hasRecoveries)) {
    rows.push({ label: 'Net seed value', amount: netSeedValue, subtotal: true });
  }

  if (gstAmount > 0) {
    rows.push({
      label: 'Add : IGST @ 5%',
      note: `on invoice value ${kg(v.billingWeightKg)} × ${money(price)}`,
      amount: gstAmount,
    });
  }

  for (const a of billAddables) {
    rows.push({ label: `Add : ${a.label}`, amount: Number(a.amount) });
  }

  if (selfVehicleHamali > 0) {
    rows.push({
      label: 'Less : Hamali (unloading)',
      note: "lorry's share recovered - party's own vehicle",
      amount: selfVehicleHamali,
      negative: true,
    });
  }
  if (selfVehicleKata > 0) {
    rows.push({
      label: 'Less : Kata charges (weighbridge)',
      note: "recovered - party's own vehicle",
      amount: selfVehicleKata,
      negative: true,
    });
  }

  const kataNote =
    v.finalWeightKg >= v.referenceKg && v.diffKg === 0
      ? 'Both weighbridges agree - payable at the full reference weight.'
      : v.finalWeightKg > v.referenceKg
        ? `RVP weighbridge read heavier than the party kata - paid on our higher net of ${kg(v.rvpKataKg)}.`
        : v.exempt
          ? `Difference of ${kg(v.diffKg)} is within the ${ALLOWANCE_KG} kg free allowance - no weight deduction.`
          : `Difference of ${kg(v.diffKg)} exceeds the ${ALLOWANCE_KG} kg free allowance - ${kg(kataDeductKg)} deducted below.`;

  const weightCells: [string, string][] = [
    ['Invoice Weight', kg(v.billingWeightKg)],
    ['Party Kata', kg(v.partyKataKg)],
    ['RVP Kata', kg(v.rvpKataKg)],
    ['Difference', kg(v.diffKg)],
    ['Payable Weight', kg(v.finalWeightKg)],
  ];

  const metaPairs: [string, string][] = [
    ['Invoice No.', stockIn.invoiceNumber || '-'],
    ['Vehicle', `${stockIn.lorryNumber}${stockIn.selfVehicle ? '  (party vehicle)' : ''}`],
    ['Purchase Order', stockIn.purchaseOrder.poNumber || '-'],
  ];

  return (
    <div className="space-y-6 max-w-4xl mx-auto p-4 md:p-6 print:max-w-none print:p-0 print:m-0 print:space-y-0">
      {/* Action Bar (hidden when printing) */}
      <div className="flex items-center justify-between print:hidden">
        <Button asChild variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground">
          <Link to="/purchases">
            <ArrowLeft className="h-4 w-4" /> Back to Purchases
          </Link>
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="gap-1.5"
            disabled={downloading}
            onClick={() => downloadPdf(v.id, party.name, stockIn.invoiceNumber)}
          >
            <Download className="h-4 w-4" /> {downloading ? 'Preparing…' : 'Download PDF'}
          </Button>
          <Button onClick={() => window.print()} className="gap-1.5 shadow-sm hover:scale-[1.02] transition-transform duration-200">
            <Printer className="h-4 w-4" /> Print Statement
          </Button>
        </div>
      </div>

      {/* Statement sheet - mirrors the PDF sent to the party on WhatsApp */}
      <div className="bg-white text-neutral-900 border border-neutral-200 rounded-lg shadow-lg overflow-hidden p-6 md:p-8 font-sans print:shadow-none print:border-none print:p-0 print:rounded-none">

        {/* Letterhead */}
        <div className="flex items-start justify-between gap-6 border-b border-neutral-400 pb-3">
          <div className="min-w-0">
            <h2 className="text-lg font-bold uppercase tracking-wide">{company?.name ?? 'RVP Industries'}</h2>
            {company?.address && (
              <p className="mt-0.5 text-[10px] leading-snug text-neutral-500">{company.address.replace(/\n/g, ', ')}</p>
            )}
            <p className="text-[10px] text-neutral-500">
              {[company?.gstin && `GSTIN: ${company.gstin}`, company?.contact && `Ph: ${company.contact}`]
                .filter(Boolean)
                .join('    ')}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <h3 className="text-base font-bold tracking-wide">PURCHASE STATEMENT</h3>
            <p className="text-[11px] text-neutral-500">Dated {shortDate(purchase.purchaseDate ?? stockIn.arrivalDate)}</p>
            <p className="text-[10px] text-neutral-500">Unloaded &amp; weight-verified</p>
          </div>
        </div>

        {/* Party + document meta */}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-[1.25fr_1fr] border border-neutral-300 rounded-sm">
          <div className="p-3 border-b md:border-b-0 md:border-r border-neutral-300">
            <p className="text-[9px] uppercase tracking-widest text-neutral-500">Statement for</p>
            <p className="mt-1 text-base font-bold">{party.name}</p>
            {[party.address, party.city, party.state].filter(Boolean).length > 0 && (
              <p className="text-[10px] text-neutral-500">
                {[party.address, party.city, party.state].filter(Boolean).join(', ')}
              </p>
            )}
            <p className="text-[10px] text-neutral-500">
              {[party.gstin && `GSTIN: ${party.gstin}`, party.phone && `Ph: ${party.phone}`].filter(Boolean).join('    ')}
            </p>
          </div>
          <div className="p-3 space-y-1.5">
            {metaPairs.map(([label, value]) => (
              <div key={label} className="flex items-baseline gap-2 text-[11px]">
                <span className="w-24 shrink-0 text-neutral-500">{label}</span>
                <span className="font-semibold">{value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Weighments */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-5 border border-neutral-300 rounded-sm bg-neutral-50 divide-x divide-neutral-200">
          {weightCells.map(([label, value], i) => (
            <div key={label} className="p-2 text-center">
              <p className="text-[8px] uppercase tracking-widest text-neutral-500">{label}</p>
              <p className={`mt-0.5 font-bold ${i === weightCells.length - 1 ? 'text-sm' : 'text-[13px]'}`}>{value}</p>
            </div>
          ))}
        </div>
        <p className="mt-1.5 text-[10px] text-neutral-500">{kataNote}</p>

        {/* Particulars */}
        <table className="mt-3 w-full border-collapse text-[12px]">
          <thead>
            <tr className="bg-neutral-900 text-white text-[9px] uppercase tracking-widest">
              <th className="p-2 text-left font-semibold">Particulars</th>
              <th className="p-2 text-right font-semibold w-24">Quantity</th>
              <th className="p-2 text-right font-semibold w-24">Rate / kg</th>
              <th className="p-2 text-right font-semibold w-28">Amount (INR)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={`${r.label}-${i}`}
                className={`border-b border-neutral-200 align-top ${r.subtotal ? 'bg-neutral-100 font-semibold' : ''}`}
              >
                <td className={`p-2 ${/^(Less|Add) :/.test(r.label) ? 'pl-5' : ''}`}>
                  {r.label}
                  {r.note && <span className="block text-[9.5px] text-neutral-500">{r.note}</span>}
                </td>
                <td className="p-2 text-right tabular-nums">{r.qty ?? ''}</td>
                <td className="p-2 text-right tabular-nums">{r.rate ?? ''}</td>
                <td className={`p-2 text-right tabular-nums ${r.negative ? 'text-red-700' : ''}`}>
                  {r.negative ? `(${money(r.amount)})` : money(r.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Net payable */}
        <div className="mt-0 flex items-center justify-between bg-neutral-900 text-white px-3 py-2.5">
          <span className="text-[12px] font-bold uppercase tracking-widest">Net Balance Payable</span>
          <span className="text-lg font-bold tabular-nums">{money(netPayable)}</span>
        </div>

        {/* Footer */}
        <div className="mt-10 flex items-start justify-between gap-6 border-t border-dotted border-neutral-300 pt-3">
          <p className="max-w-[55%] text-[9.5px] text-neutral-500">
            Computer-generated statement - no signature required. Please report any discrepancy within 7 days of receipt.
          </p>
          <div className="text-right">
            <p className="text-[11px] font-semibold">For {company?.name ?? 'RVP Industries'}</p>
            <p className="mt-10 border-t border-neutral-300 pt-1 text-[10px] text-neutral-500">Authorised Signatory</p>
          </div>
        </div>
      </div>

      {/* Embedded CSS for Print Layout */}
      <style>{`
        @media print {
          aside, header, nav, .print\\:hidden, [aria-label="Close sidebar"], [aria-label="Open sidebar"] {
            display: none !important;
          }
          html, body, #root, main {
            background-color: white !important;
            color: black !important;
            padding: 0 !important;
            margin: 0 !important;
            height: auto !important;
            overflow: visible !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          main > div {
            max-width: 100% !important;
            padding: 0 !important;
            margin: 0 !important;
          }
          @page {
            size: A4 portrait;
            margin: 10mm 12mm;
          }
        }
      `}</style>
    </div>
  );
}
