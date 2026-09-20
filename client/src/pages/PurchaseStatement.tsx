import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Printer, ArrowLeft, Download, Languages, Scale, Eye } from 'lucide-react';
import { useState } from 'react';
import { api, apiBlob } from '@/lib/api';
import type { Purchase, WeightVerification, StockIn, PurchaseOrder, Party, CompanyProfile } from '@/lib/types';
import { computeQualityAdjustments, type QualityAdjustmentMode, type QualityAdjustmentRow } from '@/lib/calc';
import { Button } from '@/components/ui/button';
import { shortDate } from '@/lib/format';
import AuthorisedSignature from '@/components/AuthorisedSignature';
import WeighbridgeSlipModal from '@/components/WeighbridgeSlipModal';
import { SUPPORTED_LANGUAGES, TRANSLATIONS, type StatementLanguage } from '@/lib/i18n/purchaseStatement';

type PurchaseDetails = Purchase & {
  verification: WeightVerification;
  stockIn: StockIn & {
    purchaseOrder: PurchaseOrder & {
      party: Party;
    };
  };
};

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
  const [lang, setLang] = useState<StatementLanguage>('en');
  const [showKataSlip, setShowKataSlip] = useState(false);

  const t = TRANSLATIONS[lang];

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
      const blob = await apiBlob(`/verifications/${verificationId}/statement.pdf?lang=${lang}`);
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
  const kataTicket = stockIn.weighbridgeTicket;

  // --- Bill arithmetic (mirrors createVerification on the server) ------------
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
  // Tax basis: the rate the party billed (their base price when it differs from
  // the PO's delivery price), else the price we pay. Mirrors the server helper.
  const gstRatePerKg = Number(v.billingRatePerKg ?? 0) || price;
  const gstAmount = hasGst ? Math.round(v.billingWeightKg * gstRatePerKg * 0.05 * 100) / 100 : 0;
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
      note: stockIn.selfVehicle ? t.partyVehicleNote : undefined,
      qty: kg(billedKg),
      rate: money(price),
      amount: grossSeed,
    },
  ];

  if (kataDeductKg > 0) {
    rows.push({
      label: t.lessKataDiff,
      note: t.kataDiffNote(kg(v.diffKg), kg(v.referenceKg), ALLOWANCE_KG),
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
      label: t.lessQualityCut(r.label),
      note: r.label.toLowerCase() === note ? undefined : note,
      qty: r.mode === 'WEIGHT' ? kg(r.value) : undefined,
      rate: r.mode === 'WEIGHT' ? money(price) : r.mode === 'PRICE' ? `${money(r.value)}/kg` : undefined,
      amount,
      negative: true,
    });
  }

  if (deductionsTotal > 0 && (hasAdditions || hasRecoveries)) {
    rows.push({ label: t.netSeedValue, amount: netSeedValue, subtotal: true });
  }

  if (gstAmount > 0) {
    rows.push({
      label: t.addIgst,
      note: t.igstNote(kg(v.billingWeightKg), money(gstRatePerKg)),
      amount: gstAmount,
    });
  }

  for (const a of billAddables) {
    rows.push({ label: `Add : ${a.label}`, amount: Number(a.amount) });
  }

  if (selfVehicleHamali > 0) {
    rows.push({
      label: t.lessHamali,
      note: t.hamaliNote,
      amount: selfVehicleHamali,
      negative: true,
    });
  }
  if (selfVehicleKata > 0) {
    rows.push({
      label: t.lessKataCharges,
      note: t.kataChargesNote,
      amount: selfVehicleKata,
      negative: true,
    });
  }

  const kataNote =
    v.finalWeightKg >= v.referenceKg && v.diffKg === 0
      ? t.kataBothAgree
      : v.finalWeightKg > v.referenceKg
        ? t.kataRvpHeavier(kg(v.rvpKataKg))
        : v.exempt
          ? t.kataWithinAllowance(kg(v.diffKg), ALLOWANCE_KG)
          : t.kataExceedsAllowance(kg(v.diffKg), ALLOWANCE_KG, kg(kataDeductKg));

  const weightCells: [string, string][] = [
    [t.invoiceWeight, kg(v.billingWeightKg)],
    [t.partyKata, kg(v.partyKataKg)],
    [t.rvpKata, kg(v.rvpKataKg)],
    [t.difference, kg(v.diffKg)],
    [t.payableWeight, kg(v.finalWeightKg)],
  ];

  const metaPairs: [string, string][] = [
    [t.invoiceNo, stockIn.invoiceNumber || '-'],
    [t.vehicle, `${stockIn.lorryNumber}${stockIn.selfVehicle ? `  ${t.partyVehicleNote}` : ''}`],
    [t.purchaseOrder, stockIn.purchaseOrder.poNumber || '-'],
  ];

  return (
    <div className="space-y-6 max-w-4xl mx-auto p-4 md:p-6 print:max-w-none print:p-0 print:m-0 print:space-y-0">
      {/* Action Bar (hidden when printing) */}
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Button asChild variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground">
          <Link to="/purchases">
            <ArrowLeft className="h-4 w-4" /> Back to Purchases
          </Link>
        </Button>

        {/* Multi-Language Selector */}
        <div className="flex items-center gap-1 bg-neutral-100/90 p-1 rounded-lg border border-neutral-200/80 shadow-xs">
          <Languages className="h-4 w-4 ml-1.5 mr-0.5 text-neutral-500" />
          {SUPPORTED_LANGUAGES.map((l) => (
            <button
              key={l.code}
              onClick={() => setLang(l.code)}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all cursor-pointer ${
                lang === l.code
                  ? 'bg-neutral-900 text-white shadow-sm font-semibold'
                  : 'text-neutral-600 hover:text-neutral-900 hover:bg-white/80'
              }`}
            >
              <span className="mr-1">{l.flag}</span>
              {l.nativeName}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {kataTicket && (
            <Button
              variant="outline"
              className="gap-1.5 border-emerald-600/30 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
              onClick={() => setShowKataSlip(true)}
            >
              <Scale className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              Kata Slip #{kataTicket.ticketNo}
            </Button>
          )}
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
      <div className={`bg-white text-neutral-900 border border-neutral-200 rounded-lg shadow-lg overflow-hidden p-6 md:p-8 font-sans print:shadow-none print:border-none print:p-0 print:rounded-none lang-${lang} ${lang !== 'en' ? 'lang-indic' : ''}`}>


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
            <h3 className={`text-base font-bold tracking-wide ${lang !== 'en' ? 'text-lg text-neutral-950 font-extrabold' : ''}`}>{t.purchaseStatement}</h3>
            <p className="text-[11px] text-neutral-600">{t.dated} {shortDate(purchase.purchaseDate ?? stockIn.arrivalDate)}</p>
            <p className={`text-[10px] text-neutral-600 ${lang !== 'en' ? 'text-[11px] font-semibold text-neutral-800' : ''}`}>{t.unloadedAndVerified}</p>
          </div>
        </div>

        {/* Party + document meta */}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-[1.25fr_1fr] border border-neutral-300 rounded-sm">
          <div className="p-3 border-b md:border-b-0 md:border-r border-neutral-300">
            <p className={`text-[9px] uppercase tracking-widest text-neutral-500 ${lang !== 'en' ? 'text-[10.5px] font-bold text-neutral-700' : ''}`}>{t.statementFor}</p>
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
                <span className={`w-32 shrink-0 text-neutral-500 ${lang !== 'en' ? 'font-semibold text-neutral-700 text-[11.5px]' : ''}`}>{label}</span>
                <span className="font-semibold text-neutral-900">{value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Weighments */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-5 border border-neutral-300 rounded-sm bg-neutral-50 divide-x divide-neutral-200">
          {weightCells.map(([label, value], i) => (
            <div key={label} className="p-2 text-center">
              <p className={`text-[8px] uppercase tracking-widest text-neutral-500 ${lang !== 'en' ? 'text-[10px] font-bold text-neutral-700 tracking-normal' : ''}`}>{label}</p>
              <p className={`mt-0.5 font-bold ${i === weightCells.length - 1 ? 'text-sm text-neutral-950 font-extrabold' : 'text-[13px]'}`}>{value}</p>
            </div>
          ))}
        </div>
        <p className={`mt-1.5 text-[10px] text-neutral-600 ${lang !== 'en' ? 'text-[11.5px] font-bold text-neutral-900 leading-snug' : ''}`}>{kataNote}</p>

        {/* Particulars */}
        <table className="mt-3 w-full border-collapse text-[12px]">
          <thead>
            <tr className="bg-neutral-900 text-white text-[9px] uppercase tracking-widest">
              <th className={`p-2 text-left font-semibold ${lang !== 'en' ? 'text-[11px] font-bold tracking-normal' : ''}`}>{t.particulars}</th>
              <th className={`p-2 text-right font-semibold w-28 ${lang !== 'en' ? 'text-[11px] font-bold tracking-normal' : ''}`}>{t.quantity}</th>
              <th className={`p-2 text-right font-semibold w-28 ${lang !== 'en' ? 'text-[11px] font-bold tracking-normal' : ''}`}>{t.ratePerKg}</th>
              <th className={`p-2 text-right font-semibold w-32 ${lang !== 'en' ? 'text-[11px] font-bold tracking-normal' : ''}`}>{t.amountInr}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={`${r.label}-${i}`}
                className={`border-b border-neutral-200 align-top ${r.subtotal ? 'bg-neutral-100 font-semibold' : ''}`}
              >
                <td className={`p-2 ${/^(Less|Add|கழிக்க|சேர்க்க|தீసివేయండి|కలపండి|കുറയ്ക്കുക|കൂട്ടുക|ಕಳೆಯಿರಿ|ಸೇರಿಸಿ)/.test(r.label) ? 'pl-5' : ''} ${lang !== 'en' ? 'font-bold text-neutral-950 text-[13px]' : ''}`}>
                  {r.label}
                  {r.note && <span className={`block text-[9.5px] text-neutral-500 ${lang !== 'en' ? 'text-[11px] font-semibold text-neutral-600' : ''}`}>{r.note}</span>}
                </td>
                <td className="p-2 text-right tabular-nums">{r.qty ?? ''}</td>
                <td className="p-2 text-right tabular-nums">{r.rate ?? ''}</td>
                <td className={`p-2 text-right tabular-nums ${r.negative ? 'text-red-700 font-semibold' : ''}`}>
                  {r.negative ? `(${money(r.amount)})` : money(r.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Net payable */}
        <div className="mt-0 flex items-center justify-between bg-neutral-900 text-white px-3 py-2.5">
          <span className={`text-[12px] font-bold uppercase tracking-widest ${lang !== 'en' ? 'text-[13.5px] font-extrabold tracking-normal' : ''}`}>{t.netBalancePayable}</span>
          <span className="text-lg font-bold tabular-nums">{money(netPayable)}</span>
        </div>

        {/* Footer */}
        <div className="mt-10 flex items-start justify-between gap-6 border-t border-dotted border-neutral-300 pt-3">
          <p className={`max-w-[55%] text-[9.5px] text-neutral-500 ${lang !== 'en' ? 'text-[11px] font-semibold text-neutral-700 leading-snug' : ''}`}>
            {t.computerGeneratedNote}
          </p>
          <AuthorisedSignature
            companyName={t.forCompany(company?.name ?? 'RVP Industries')}
            caption={t.authorisedSignatory}
            captionRule
            className="text-[11px]"
          />
        </div>
      </div>

      {/* Attached Kata slip preview card */}
      {kataTicket && (
        <div className="mt-6 rounded-xl border border-emerald-200 bg-gradient-to-b from-emerald-50/70 to-white p-5 shadow-sm dark:border-emerald-900/60 dark:from-emerald-950/20 dark:to-neutral-900 print:hidden">
          <div className="flex flex-wrap items-center justify-between gap-4 pb-3 border-b border-emerald-100 dark:border-emerald-900/40">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-600 text-white shadow-xs">
                <Scale className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-neutral-900 dark:text-neutral-100">
                    Official Weighbridge Certificate Attached (#{kataTicket.ticketNo})
                  </h3>
                  <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-300">
                    Rendered on Page 2 of PDF
                  </span>
                </div>
                <p className="text-xs text-neutral-600 dark:text-neutral-400">
                  Dual CCTV snapshots, gross/tare weighments, and RVP security seal are permanently bound to this purchase statement.
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowKataSlip(true)}
              className="gap-1.5 border-emerald-600/40 text-emerald-800 hover:bg-emerald-100/50 dark:border-emerald-700 dark:text-emerald-300 font-semibold"
            >
              <Eye className="h-4 w-4" /> Preview / Print Slip
            </Button>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 text-xs">
            <div className="rounded-md border border-neutral-200/80 bg-white/80 p-2.5 dark:border-neutral-800 dark:bg-neutral-900/50">
              <span className="text-[10px] uppercase font-bold tracking-wider text-neutral-500">Gross (1st Weight)</span>
              <p className="mt-0.5 text-sm font-bold text-neutral-900 dark:text-neutral-100">{kg(kataTicket.firstWeightKg ?? 0)}</p>
            </div>
            <div className="rounded-md border border-neutral-200/80 bg-white/80 p-2.5 dark:border-neutral-800 dark:bg-neutral-900/50">
              <span className="text-[10px] uppercase font-bold tracking-wider text-neutral-500">Tare (2nd Weight)</span>
              <p className="mt-0.5 text-sm font-bold text-neutral-900 dark:text-neutral-100">
                {kataTicket.secondWeightKg ? kg(kataTicket.secondWeightKg) : '—'}
              </p>
            </div>
            <div className="rounded-md border border-neutral-200/80 bg-white/80 p-2.5 dark:border-neutral-800 dark:bg-neutral-900/50">
              <span className="text-[10px] uppercase font-bold tracking-wider text-neutral-500">Net Kata Weight</span>
              <p className="mt-0.5 text-sm font-bold text-emerald-700 dark:text-emerald-400">
                {kataTicket.netWeightKg ? kg(kataTicket.netWeightKg) : '—'}
              </p>
            </div>
            <div className="rounded-md border border-neutral-200/80 bg-white/80 p-2.5 dark:border-neutral-800 dark:bg-neutral-900/50">
              <span className="text-[10px] uppercase font-bold tracking-wider text-neutral-500">Vehicle / Lorry</span>
              <p className="mt-0.5 text-sm font-bold font-mono text-neutral-900 dark:text-neutral-100">
                {kataTicket.vehicleNumber || stockIn.lorryNumber || '—'}
              </p>
            </div>
          </div>
        </div>
      )}

      {showKataSlip && kataTicket && (
        <WeighbridgeSlipModal
          ticket={kataTicket}
          companyProfile={company}
          onClose={() => setShowKataSlip(false)}
        />
      )}


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

