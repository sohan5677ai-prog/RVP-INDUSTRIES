import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import { usePagedRows } from '@/lib/usePagedRows';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import type { Purchase, SaleOrder, HamaliRate, StockTransfer, ShellTransfer, HuskTransfer, ManualHamaliCost, ManualHamaliType, HamaliVerification, CompanyProfile, Payment, Party } from '@/lib/types';
import { kg, rupees, shortDate } from '@/lib/format';
import { hamaliSplit, pappuLoadingHamali, calcHamali, customLoadingHamali, isVehicleExempt } from '@/lib/calc';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { Loader2, Coins, TrendingUp, Truck, Plus, Trash2, ShieldCheck, Lock, CheckCircle2, ReceiptText, Users, Phone, Landmark } from 'lucide-react';

// Manual hamali charge categories the crew is paid for but that can't be derived
// from purchases/sales. Per-bag types compute amount = bags × rate; flat types
// take a direct amount. Default per-bag rates match the mill's standard charges.
const MANUAL_TYPES: { value: ManualHamaliType; label: string; perBag: boolean; defaultRate?: number }[] = [
  { value: 'BAG_CUTTING_NORMAL', label: 'Bag Cutting (Place A)', perBag: true, defaultRate: 3 },
  { value: 'BAG_CUTTING_DISTANCE', label: 'Bag Cutting (Place B)', perBag: true, defaultRate: 6 },
  { value: 'PAPPU_NET', label: 'Pappu Net', perBag: true, defaultRate: 6 },
  { value: 'HUSK_PACKING', label: 'Husk Packing', perBag: true },
  { value: 'TPS_BROKENS_PACKING', label: 'TPS Brokens Packing', perBag: true },
  { value: 'TAMARIND_BYPRODUCTS_PACKING', label: 'Tamarind Byproducts Packing', perBag: true },
  { value: 'DIESEL', label: 'Diesel Cost', perBag: false },
  { value: 'MISC', label: 'Miscellaneous', perBag: false },
  { value: 'PAID', label: 'Paid to Hamali', perBag: false },
];
const manualTypeMeta = (t: ManualHamaliType) => MANUAL_TYPES.find((m) => m.value === t)!;

type PurchaseRow = Purchase & {
  stockIn?: {
    arrivalDate: string;
    invoiceNumber: string;
    lorryNumber: string;
    billingWeightKg: number;
    partyKataKg: number;
    purchaseOrder: {
      poNumber: string;
      pricePerKg: string;
      partyId: string;
      party: {
        name: string;
      };
    };
  };
};

// A unified hamali entry - from a purchase (inward unloading) or from the
// loading hamali deducted out of a sale's outward lorry freight. Both post to
// GL 20200 (crew) and 40030 (company margin → P/L).
interface HamaliEntry {
  id: string;
  date: string;
  source: 'PURCHASE' | 'SALE' | 'TRANSFER';
  label?: string;
  partyId: string | null;
  partyName: string;
  lorryNumber: string | null;
  reference: string;
  netWeightKg: number;
  fullCharge: number;
  ourShare: number;
  lorryShare: number;
  crew: number;
  pl: number;
}

// A squared-off period surfaced in the Payables tab: its window, snapshot amount
// due, how much has been settled, and the derived settlement status.
interface PayableRow {
  v: HamaliVerification;
  from: string; // yyyy-mm-dd (inclusive)
  to: string;   // yyyy-mm-dd (inclusive)
  days: number;
  payable: number;
  paid: number;
  outstanding: number;
  status: 'PAID' | 'PARTIAL' | 'UNPAID';
}

export default function HamaliLedger() {
  const [view, setView] = useState<'company' | 'hamali' | 'payables' | 'ledger'>('company');
  const [partyType, setPartyType] = useState<'ALL' | 'BUYER' | 'SUPPLIER'>('ALL');
  const [search, setSearch] = useState<string>('');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');

  const { data: purchases, isLoading: loadingPurchases } = useQuery({
    queryKey: ['purchases', 'hamali'],
    queryFn: () => api<PurchaseRow[]>('/purchases?view=hamali'),
  });

  const { data: saleOrders, isLoading: loadingSales } = useQuery({
    queryKey: ['sale-orders'],
    queryFn: () => api<SaleOrder[]>('/sale-orders'),
  });

  const { data: hamaliRates } = useQuery({
    queryKey: ['hamali-rates'],
    queryFn: () => api<HamaliRate[]>('/settings/hamali-rates'),
  });

  const { data: companyProfile } = useQuery({
    queryKey: ['company'],
    queryFn: () => api<CompanyProfile>('/settings/company'),
  });

  const { data: stockTransfers, isLoading: loadingStockTransfers } = useQuery({
    queryKey: ['stock-transfers'],
    queryFn: () => api<StockTransfer[]>('/stock-transfers'),
  });

  const { data: shellTransfers, isLoading: loadingShellTransfers } = useQuery({
    queryKey: ['shell-transfers'],
    queryFn: () => api<ShellTransfer[]>('/shell-transfers'),
  });

  const { data: huskTransfers, isLoading: loadingHuskTransfers } = useQuery({
    queryKey: ['husk-transfers'],
    queryFn: () => api<HuskTransfer[]>('/husk-transfers'),
  });

  const qc = useQueryClient();
  const { data: manualCosts } = useQuery({
    queryKey: ['manual-hamali-costs'],
    queryFn: () => api<ManualHamaliCost[]>('/manual-hamali-costs'),
  });

  const { data: verifications } = useQuery({
    queryKey: ['hamali-verifications'],
    queryFn: () => api<HamaliVerification[]>('/hamali-verifications'),
  });

  // Crew-settlement payments (type HAMALI) — drive the Payables status and the
  // debit side of the crew ledger. Fetch the full history (?all=true) so older
  // settlements aren't dropped by the server's default 100-row cap.
  const { data: payments } = useQuery({
    queryKey: ['payments', { all: true }],
    queryFn: () => api<Payment[]>('/payments?all=true'),
  });

  // The single "Bikash and Team" hamali party crew payments are booked against
  // (find-or-created server-side on first read).
  const { data: teamParty } = useQuery({
    queryKey: ['hamali-team-party'],
    queryFn: () => api<Party>('/hamali-verifications/team-party'),
  });

  // Square-off (reconciliation checkpoint) state
  const [squareDate, setSquareDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [squareNote, setSquareNote] = useState('');

  // Payables tab: pay-out dialog + crew-ledger dialog state
  const [payOpen, setPayOpen] = useState(false);
  const [payVerif, setPayVerif] = useState<PayableRow | null>(null);
  const [payDate, setPayDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [payAmount, setPayAmount] = useState('');
  const [payRef, setPayRef] = useState('');

  // Record-charge dialog state
  const [recordOpen, setRecordOpen] = useState(false);
  const [mDate, setMDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [mType, setMType] = useState<ManualHamaliType>('BAG_CUTTING_NORMAL');
  const [mBags, setMBags] = useState('');
  const [mRate, setMRate] = useState('3');
  const [mAmount, setMAmount] = useState('');
  const [mNote, setMNote] = useState('');

  const mMeta = manualTypeMeta(mType);
  const mComputed = mMeta.perBag ? (Number(mBags) || 0) * (Number(mRate) || 0) : Number(mAmount) || 0;

  function resetRecord() {
    setMDate(new Date().toISOString().slice(0, 10));
    setMType('BAG_CUTTING_NORMAL');
    setMBags('');
    setMRate('3');
    setMAmount('');
    setMNote('');
  }

  function onTypeChange(t: ManualHamaliType) {
    setMType(t);
    const meta = manualTypeMeta(t);
    if (meta.perBag) setMRate(String(meta.defaultRate ?? ''));
  }

  const createManual = useMutation({
    mutationFn: () =>
      api<ManualHamaliCost>('/manual-hamali-costs', {
        method: 'POST',
        body: mMeta.perBag
          ? { date: mDate, type: mType, bags: Number(mBags), ratePerBag: Number(mRate), note: mNote || null }
          : { date: mDate, type: mType, amount: Number(mAmount), note: mNote || null },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['manual-hamali-costs'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      toast.success('Charge recorded');
      setRecordOpen(false);
      resetRecord();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteManual = useMutation({
    mutationFn: (id: string) => api(`/manual-hamali-costs/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['manual-hamali-costs'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      toast.success('Charge removed');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const createVerification = useMutation({
    mutationFn: (body: { asOfDate: string; periodStart: string | null; crewTotal: number; note: string | null }) =>
      api<HamaliVerification>('/hamali-verifications', { method: 'POST', body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hamali-verifications'] });
      toast.success('Squared off — data cross-verified with crew');
      setSquareNote('');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteVerification = useMutation({
    mutationFn: (id: string) => api(`/hamali-verifications/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hamali-verifications'] });
      toast.success('Checkpoint removed');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // Record a crew-settlement payment against a squared-off period. Books
  // Dr Hamali payable (20200) / Cr Bank, and shows up on the Payments page.
  const payCrew = useMutation({
    mutationFn: () =>
      api<Payment>('/payments', {
        method: 'POST',
        body: {
          date: payDate,
          amount: Number(payAmount),
          type: 'HAMALI',
          partyId: teamParty?.id ?? null,
          hamaliVerificationId: payVerif?.v.id ?? null,
          reference: payRef || null,
          description: payVerif
            ? `Hamali crew settlement ${shortDate(payVerif.from)} – ${shortDate(payVerif.to)}`
            : 'Hamali crew settlement',
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['hamali-verifications'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      toast.success('Crew payment recorded');
      setPayOpen(false);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const manualValid = mMeta.perBag ? Number(mBags) > 0 && Number(mRate) > 0 : Number(mAmount) > 0;

  const isLoading = loadingPurchases || loadingSales || loadingStockTransfers || loadingShellTransfers || loadingHuskTransfers;

  // The three hamali entry arrays below are derived purely from fetched data and
  // are the heavy part of this page (saleEntries does a double flatMap + per-row
  // rate lookups). Memoize them so typing in the search box or the manual-hamali
  // record dialog doesn't rebuild every entry on each keystroke.
  const { purchaseEntries, saleEntries, transferEntries } = useMemo(() => {
  // Purchase (inward) hamali - funding split inventory/lorry, usage crew/margin.
  const purchaseEntries: HamaliEntry[] = (purchases ?? []).map((p) => {
    // Company (KNM) transport vehicles have no external lorry to recover from, so
    // the company bears the whole charge: lorry share = 0, our share = full charge.
    // Mirror the GL posting (LedgerService.postPurchaseVerification), which already
    // splits with this flag.
    const isCompanyVehicle = isVehicleExempt(p.stockIn?.lorryNumber, companyProfile?.companyVehicles);
    const s = hamaliSplit(Number(p.hamaliCharge), isCompanyVehicle);
    return {
      id: `PUR-${p.id}`,
      date: p.stockIn?.arrivalDate ?? p.createdAt,
      source: 'PURCHASE',
      label: 'Black Seed Unloading',
      partyId: p.stockIn?.purchaseOrder?.partyId ?? null,
      partyName: p.stockIn?.purchaseOrder?.party?.name ?? '-',
      lorryNumber: p.stockIn?.lorryNumber ?? null,
      reference: `Inv ${p.stockIn?.invoiceNumber ?? '-'}`,
      netWeightKg: p.netWeightKg,
      fullCharge: s.total,
      ourShare: s.inventory,
      lorryShare: s.lorry,
      crew: s.crew,
      pl: s.margin,
    };
  });

  // Sale (outward) loading hamali (rates from Settings → Hamali Rates):
  //   - Pappu: split our share / lorry share, crew / P/L margin.
  //   - Husk / Waste: 100% company-borne - shown even with no freight (lifted ex-works).
  //   - TPS / others: flat, fully off the lorry's freight.
  const saleEntries: HamaliEntry[] = (saleOrders ?? [])
    .flatMap((o) => (o.dispatches ?? []).map((d) => ({ o, d })))
    .flatMap(({ o, d }) => {
      const base = {
        date: d.dispatchDate,
        partyId: o.buyerId,
        partyName: o.buyer?.name ?? '-',
        lorryNumber: d.vehicleNumber ?? null,
        reference: d.invoiceNumber ?? '-',
        netWeightKg: d.weightKg,
      };
      
      const entries: HamaliEntry[] = [];

      if (o.product === 'PAPPU') {
        const r = hamaliRates?.find((x) => x.key === 'PAPPU_LOADING') || { ratePerTonne: 200, lorryPerTonne: 80, marginPerTonne: 10 };
        const lh = pappuLoadingHamali(d.weightKg, false, Number(r.ratePerTonne), Number(r.lorryPerTonne), Number(r.marginPerTonne));
        
        entries.push({ ...base, id: `SALE-${d.id}-LOAD`, source: 'SALE' as const, label: 'Pappu Loading', fullCharge: lh.total, ourShare: lh.company, lorryShare: lh.lorry, crew: lh.crew, pl: lh.margin });
        
        // Custom costs (e.g. Roasting)
        for (const c of hamaliRates?.filter(x => x.isCustom) || []) {
           const ch = customLoadingHamali(d.weightKg, Number(c.ratePerTonne), Number(c.lorryPerTonne), Number(c.marginPerTonne));
           entries.push({ ...base, id: `SALE-${d.id}-${c.key}`, source: 'SALE' as const, label: `Pappu ${c.label}`, fullCharge: ch.total, ourShare: ch.company, lorryShare: ch.lorry, crew: ch.crew, pl: ch.margin });
        }
      } else if (o.product === 'HUSK' || o.product === 'WASTE') {
        const key = o.product === 'HUSK' ? 'HUSK_LOADING' : 'WASTE_LOADING';
        const fallback = o.product === 'HUSK' ? 333 : 150;
        const r = hamaliRates?.find((x) => x.key === key) || { ratePerTonne: fallback, lorryPerTonne: 0, marginPerTonne: 0 };
        const lh = customLoadingHamali(d.weightKg, Number(r.ratePerTonne), Number(r.lorryPerTonne), Number(r.marginPerTonne));
        const label = `${o.product === 'HUSK' ? 'Husk' : 'Waste'} Loading`;
        entries.push({ ...base, id: `SALE-${d.id}-LOAD`, source: 'SALE' as const, label, fullCharge: lh.total, ourShare: lh.company, lorryShare: lh.lorry, crew: lh.crew, pl: lh.margin });
      } else if (o.product === 'TPS') {
        const r = hamaliRates?.find((x) => x.key === 'TPS_LOADING') || { ratePerTonne: 160, lorryPerTonne: 160, marginPerTonne: 0 };
        const lh = customLoadingHamali(d.weightKg, Number(r.ratePerTonne), Number(r.lorryPerTonne), Number(r.marginPerTonne));
        entries.push({ ...base, id: `SALE-${d.id}-LOAD`, source: 'SALE' as const, label: 'TPS Loading', fullCharge: lh.total, ourShare: lh.company, lorryShare: lh.lorry, crew: lh.crew, pl: lh.margin });
      } else {
        const full = calcHamali(d.weightKg);
        entries.push({ ...base, id: `SALE-${d.id}-LOAD`, source: 'SALE' as const, label: `${o.product} Loading`, fullCharge: full, ourShare: 0, lorryShare: full, crew: full, pl: 0 });
      }
      
      return entries;
    });

  const transferEntries: HamaliEntry[] = [
    ...(stockTransfers ?? []).map((t) => {
      const fullCharge = Number(t.loadingHamali) + Number(t.unloadingHamali);
      const pl = Number(t.hamaliMargin || 0);
      return {
        id: `TX-STOCK-${t.id}`,
        date: t.transferDate || t.createdAt,
        source: 'TRANSFER' as const,
        label: 'Stock Transfer',
        partyId: null,
        partyName: 'Internal (Storage → Process)',
        lorryNumber: t.lorryNumber ?? null,
        reference: `${t.fromLocation} → ${t.toLocation}`,
        netWeightKg: t.weightKg,
        fullCharge,
        ourShare: fullCharge,
        lorryShare: 0,
        crew: fullCharge - pl,
        pl,
      };
    }),
    ...(shellTransfers ?? []).map((t) => {
      const fullCharge = Number(t.hamaliCharge);
      return {
        id: `TX-SHELL-${t.id}`,
        date: t.transferDate || t.createdAt,
        source: 'TRANSFER' as const,
        label: 'Shell Transfer',
        partyId: null,
        partyName: 'Internal (Process → Rampalli)',
        lorryNumber: t.lorryNumber ?? null,
        reference: `${t.fromLocation} → ${t.toLocation}`,
        netWeightKg: t.weightKg,
        fullCharge,
        ourShare: fullCharge,
        lorryShare: 0,
        crew: fullCharge,
        pl: 0,
      };
    }),
    ...(huskTransfers ?? []).map((t) => {
      const fullCharge = Number(t.hamaliCharge);
      return {
        id: `TX-HUSK-${t.id}`,
        date: t.transferDate || t.createdAt,
        source: 'TRANSFER' as const,
        label: 'Husk Transfer',
        partyId: null,
        partyName: 'Internal (Factory → Storage)',
        lorryNumber: t.lorryNumber ?? null,
        reference: `${t.fromLocation} → ${t.toLocation}`,
        netWeightKg: t.weightKg,
        fullCharge,
        ourShare: fullCharge,
        lorryShare: 0,
        crew: fullCharge,
        pl: 0,
      };
    }),
  ];

  return { purchaseEntries, saleEntries, transferEntries };
  }, [purchases, saleOrders, hamaliRates, companyProfile, stockTransfers, shellTransfers, huskTransfers]);

  const q = search.trim().toLowerCase();
  const filtered = [...purchaseEntries, ...saleEntries, ...transferEntries]
    .filter((e) => {
      // Purchases are supplier-side hamali, sale loading is buyer-side.
      if (partyType === 'SUPPLIER' && e.source !== 'PURCHASE') return false;
      if (partyType === 'BUYER' && e.source !== 'SALE') return false;
      if (q && !e.partyName.toLowerCase().includes(q)) return false;
      const d = new Date(e.date).toISOString().slice(0, 10);
      if (startDate && d < startDate) return false;
      if (endDate && d > endDate) return false;
      return true;
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows: visible = [] } = usePagedRows(filtered, 50);

  // Metrics
  const totalHamali = filtered.reduce((acc, e) => acc + e.fullCharge, 0);
  const totalPl = filtered.reduce((acc, e) => acc + e.pl, 0);
  const totalTons = filtered.reduce((acc, e) => acc + e.netWeightKg, 0) / 1000;

  // Manual costs - charges accrue what we owe the crew; PAID entries settle it.
  const manualSorted = [...(manualCosts ?? [])].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const manualCharged = manualSorted.filter((c) => c.type !== 'PAID').reduce((s, c) => s + Number(c.amount), 0);
  const manualPaid = manualSorted.filter((c) => c.type === 'PAID').reduce((s, c) => s + Number(c.amount), 0);
  const manualOutstanding = manualCharged - manualPaid;

  // --- Reconciliation checkpoints (Hamali view) ---
  // Rows dated on/before the latest checkpoint are cross-verified and locked; the
  // window since is the current, still-to-verify period. Crew total = derived crew
  // shares + manual charges − paid, matching what the crew is actually owed.
  const dayOf = (d: string) => new Date(d).toISOString().slice(0, 10);
  const verifSorted = [...(verifications ?? [])].sort((a, b) => new Date(b.asOfDate).getTime() - new Date(a.asOfDate).getTime());
  const verifiedThroughDay = verifSorted[0] ? dayOf(verifSorted[0].asOfDate) : null;
  const isVerified = (dateIso: string) => verifiedThroughDay != null && dayOf(dateIso) <= verifiedThroughDay;

  const allHamaliEntries = [...purchaseEntries, ...saleEntries, ...transferEntries];
  // Amount pending verification for the picked square-off date: crew dues in the
  // window (after the last checkpoint, on/before the square-off date).
  const inSquareWindow = (dateIso: string) => {
    const d = dayOf(dateIso);
    if (verifiedThroughDay != null && d <= verifiedThroughDay) return false;
    return d <= squareDate;
  };
  const pendingCrewFromEntries = allHamaliEntries.filter((e) => inSquareWindow(e.date)).reduce((s, e) => s + e.crew, 0);
  const pendingCrewFromManual = manualSorted
    .filter((c) => inSquareWindow(c.date))
    .reduce((s, c) => s + (c.type === 'PAID' ? -Number(c.amount) : Number(c.amount)), 0);
  const pendingCrewTotal = Math.round((pendingCrewFromEntries + pendingCrewFromManual) * 100) / 100;
  const squareValid = (verifiedThroughDay == null || squareDate > verifiedThroughDay) && pendingCrewTotal > 0;

  // Crew payable across the currently filtered rows (Hamali view metric). This
  // now also folds in the Recorded Charges (bag cutting, pappu net, diesel, misc)
  // net of amounts already paid to the crew — so the tile reflects the FULL crew
  // dues, not just the derived purchase/sale/transfer shares. Manual charges carry
  // no party, so they're only added when no party filter/search is narrowing the
  // view (otherwise the derived-only figure stays consistent with the filter).
  const inDateWindow = (dateIso: string) => {
    const d = dayOf(dateIso);
    if (startDate && d < startDate) return false;
    if (endDate && d > endDate) return false;
    return true;
  };
  const includeManualInTile = partyType === 'ALL' && q === '';
  const manualNetInWindow = includeManualInTile
    ? manualSorted
        .filter((c) => inDateWindow(c.date))
        .reduce((s, c) => s + (c.type === 'PAID' ? -Number(c.amount) : Number(c.amount)), 0)
    : 0;
  const totalCrew = filtered.reduce((acc, e) => acc + e.crew, 0) + manualNetInWindow;

  // ── Payables tab: one row per squared-off period ──────────────────────────
  // Crew-settlement payments (HAMALI) grouped by the period they settle.
  const hamaliPayments = (payments ?? []).filter((p) => p.type === 'HAMALI');
  const paidByVerification = new Map<string, number>();
  for (const p of hamaliPayments) {
    if (!p.hamaliVerificationId) continue;
    paidByVerification.set(p.hamaliVerificationId, (paidByVerification.get(p.hamaliVerificationId) ?? 0) + Number(p.amount));
  }
  const addDay = (day: string) => {
    const d = new Date(day + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  };
  const daysInclusive = (from: string, to: string) =>
    Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000) + 1);
  // Earliest dated crew due (for the first period's "from", when nothing precedes it).
  const allDatedCrew = [...allHamaliEntries.map((e) => dayOf(e.date)), ...manualSorted.map((c) => dayOf(c.date))];
  const earliestCrewDay = allDatedCrew.length ? allDatedCrew.reduce((m, d) => (d < m ? d : m)) : null;
  const verifAsc = [...(verifications ?? [])].sort((a, b) => new Date(a.asOfDate).getTime() - new Date(b.asOfDate).getTime());
  const payableRows: PayableRow[] = verifAsc
    .map((v, i) => {
      const to = dayOf(v.asOfDate);
      const from = v.periodStart
        ? dayOf(v.periodStart)
        : i > 0
          ? addDay(dayOf(verifAsc[i - 1].asOfDate))
          : earliestCrewDay ?? to;
      const payable = Number(v.crewTotal);
      const paid = paidByVerification.get(v.id) ?? 0;
      const status: PayableRow['status'] = paid >= payable - 0.5 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID';
      return { v, from, to, days: daysInclusive(from, to), payable, paid, outstanding: Math.max(0, payable - paid), status };
    })
    .reverse(); // most-recent period first
  const payablesTotal = payableRows.reduce((s, r) => s + r.payable, 0);
  const payablesPaid = payableRows.reduce((s, r) => s + r.paid, 0);
  const payablesOutstanding = payableRows.reduce((s, r) => s + r.outstanding, 0);

  // The period start for a NEW square-off = day after the last checkpoint, else
  // the earliest crew due (so the first period spans from the very beginning).
  const nextPeriodStart = verifiedThroughDay ? addDay(verifiedThroughDay) : earliestCrewDay;

  // ── Crew ledger (Ledger tab) — a party-ledger-style account statement for the
  // hamali crew. Credits are the SQUARED-OFF periods (one line per checkpoint, with
  // its date range) — NOT the individual loading/unloading rows. Debits are the
  // settlement payments. Running balance is what we still owe the crew (CR).
  interface LedgerLine { id: string; date: string; particulars: string; period: string | null; debit: number; credit: number; }
  const ledgerLines: (LedgerLine & { balance: number })[] = (() => {
    const lines: LedgerLine[] = [];
    // One credit per squared-off period, dated at the period-end (asOfDate).
    for (const r of payableRows) {
      lines.push({
        id: `V-${r.v.id}`,
        date: r.to,
        particulars: 'Crew dues squared off',
        period: `${shortDate(r.from)} – ${shortDate(r.to)}`,
        debit: 0,
        credit: r.payable,
      });
    }
    // One debit per crew-settlement payment.
    for (const p of hamaliPayments) {
      lines.push({
        id: `PY-${p.id}`,
        date: dayOf(p.date),
        particulars: `Payment to crew${p.reference ? ` · ${p.reference}` : ''}`,
        period: null,
        debit: Number(p.amount),
        credit: 0,
      });
    }
    lines.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime() || a.id.localeCompare(b.id));
    let running = 0;
    return lines.map((l) => { running += l.credit - l.debit; return { ...l, balance: Math.round(running * 100) / 100 }; });
  })();
  const ledgerCredit = ledgerLines.reduce((s, l) => s + l.credit, 0);
  const ledgerDebit = ledgerLines.reduce((s, l) => s + l.debit, 0);
  const ledgerBalance = Math.round((ledgerCredit - ledgerDebit) * 100) / 100;
  const ledgerOpening = ledgerLines.length ? ledgerLines[0].balance - ledgerLines[0].credit + ledgerLines[0].debit : 0;

  function openPay(row: PayableRow) {
    setPayVerif(row);
    setPayDate(new Date().toISOString().slice(0, 10));
    setPayAmount(String(Math.max(0, Math.round(row.outstanding))));
    setPayRef('');
    setPayOpen(true);
  }

  const hamaliExportColumns: ExportColumn<HamaliEntry>[] = [
    { header: 'Date', value: (e) => shortDate(e.date) },
    { header: 'Source', value: (e) => e.label || (e.source === 'SALE' ? 'Sale Loading' : e.source === 'TRANSFER' ? 'Transfer' : 'Purchase') },
    { header: 'Party', value: (e) => e.partyName },
    { header: 'Lorry No', value: (e) => e.lorryNumber ?? '' },
    { header: 'Reference', value: (e) => e.reference },
    { header: 'Net Weight (kg)', value: (e) => e.netWeightKg, numFmt: '#,##0', align: 'right' },
    { header: 'Full Charge', value: (e) => rupees(e.fullCharge), excel: (e) => e.fullCharge, numFmt: '#,##0.00', align: 'right' },
    ...(view === 'company' ? [
      { header: 'Our Share', value: (e: HamaliEntry) => rupees(e.ourShare), excel: (e: HamaliEntry) => e.ourShare, numFmt: '#,##0.00', align: 'right' as const },
      { header: 'Lorry Share', value: (e: HamaliEntry) => rupees(e.lorryShare), excel: (e: HamaliEntry) => e.lorryShare, numFmt: '#,##0.00', align: 'right' as const },
    ] : []),
    { header: 'Crew Paid', value: (e) => rupees(e.crew), excel: (e) => e.crew, numFmt: '#,##0.00', align: 'right' },
    ...(view === 'company'
      ? [{ header: 'Company P/L', value: (e: HamaliEntry) => rupees(e.pl), excel: (e: HamaliEntry) => e.pl, numFmt: '#,##0.00', align: 'right' as const }]
      : [{ header: 'Status', value: (e: HamaliEntry) => (isVerified(e.date) ? 'Verified' : 'Current') }]),
  ];

  // Crew dues accrued since the last checkpoint (through today) — the standing
  // "not yet verified" figure, independent of the square-off date picker.
  const todayDay = new Date().toISOString().slice(0, 10);
  const sinceCheckpoint = (dateIso: string) => {
    const d = dayOf(dateIso);
    if (verifiedThroughDay != null && d <= verifiedThroughDay) return false;
    return d <= todayDay;
  };
  const currentPeriodCrew =
    Math.round(
      (allHamaliEntries.filter((e) => sinceCheckpoint(e.date)).reduce((s, e) => s + e.crew, 0) +
        manualSorted
          .filter((c) => sinceCheckpoint(c.date))
          .reduce((s, c) => s + (c.type === 'PAID' ? -Number(c.amount) : Number(c.amount)), 0)) *
        100,
    ) / 100;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Hamali Report</h1>
          <p className="text-muted-foreground">
            {view === 'company'
              ? 'Unloading & loading labor charges from purchases and outward sale freight'
              : view === 'payables'
                ? 'Squared-off crew dues — pay each verified period and track what is settled'
                : view === 'ledger'
                  ? 'Account statement for the hamali crew — squared-off dues vs settlements'
                  : 'Crew-facing view — what the hamali crew is owed, cross-verified and squared off periodically'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Segmented
            value={view}
            onValueChange={(v) => setView(v)}
            options={[
              { label: 'Company', value: 'company' },
              { label: 'Hamali', value: 'hamali' },
              { label: 'Payables', value: 'payables' },
              { label: 'Ledger', value: 'ledger' },
            ]}
          />
          {(view === 'company' || view === 'hamali') && (
            <Button onClick={() => { resetRecord(); setRecordOpen(true); }}>
              <Plus className="h-4 w-4" /> Record
            </Button>
          )}
        </div>
      </div>

      {/* Filters Bar (only for the transaction-level Company / Hamali views) */}
      {(view === 'company' || view === 'hamali') && (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 bg-muted/40 p-4 rounded-lg border">
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold">Filter by Party Type</Label>
          <Select value={partyType} onValueChange={(v) => setPartyType(v as typeof partyType)}>
            <SelectTrigger className="bg-card">
              <SelectValue placeholder="All Parties" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Parties</SelectItem>
              <SelectItem value="BUYER">Buyers</SelectItem>
              <SelectItem value="SUPPLIER">Suppliers</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="search" className="text-xs font-semibold">Search Party</Label>
          <Input id="search" type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search party name…" className="bg-card" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="start" className="text-xs font-semibold">From Date</Label>
          <Input id="start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="bg-card" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="end" className="text-xs font-semibold">To Date</Label>
          <Input id="end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="bg-card" />
        </div>
      </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <div className="grid gap-6">
          {/* Summary Cards (the Ledger view has its own profile header instead) */}
          {view !== 'ledger' && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {view === 'payables' ? (
              <>
                <Card className="bg-card border shadow-sm">
                  <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Squared-off</CardTitle>
                    <Coins className="h-4 w-4 text-primary" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold text-primary">{rupees(payablesTotal)}</div>
                    <p className="text-[10px] text-muted-foreground mt-1">Crew dues across {payableRows.length} verified period(s)</p>
                  </CardContent>
                </Card>
                <Card className="bg-card border shadow-sm">
                  <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Paid to Crew</CardTitle>
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{rupees(payablesPaid)}</div>
                    <p className="text-[10px] text-muted-foreground mt-1">Settled via crew payments</p>
                  </CardContent>
                </Card>
                <Card className="bg-card border shadow-sm">
                  <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Outstanding</CardTitle>
                    <ShieldCheck className="h-4 w-4 text-amber-500" />
                  </CardHeader>
                  <CardContent>
                    <div className={`text-2xl font-bold ${payablesOutstanding > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{rupees(payablesOutstanding)}</div>
                    <p className="text-[10px] text-muted-foreground mt-1">Squared-off but not yet fully paid</p>
                  </CardContent>
                </Card>
              </>
            ) : (
            <>
            {view === 'company' ? (
              <Card className="bg-card border shadow-sm">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Hamali Charge</CardTitle>
                  <Coins className="h-4 w-4 text-primary" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-primary">{rupees(totalHamali)}</div>
                  <p className="text-[10px] text-muted-foreground mt-1">Full charge across purchases &amp; sale loading</p>
                </CardContent>
              </Card>
            ) : (
              <Card className="bg-card border shadow-sm">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Crew Payable (shown)</CardTitle>
                  <Coins className="h-4 w-4 text-primary" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-primary">{rupees(totalCrew)}</div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Crew share across the shown rows{includeManualInTile ? ', incl. recorded charges' : ''}
                  </p>
                </CardContent>
              </Card>
            )}
            {view === 'company' ? (
              <Card className="bg-card border shadow-sm">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Company P/L (Hamali Margin)</CardTitle>
                  <TrendingUp className="h-4 w-4 text-emerald-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{rupees(totalPl)}</div>
                  <p className="text-[10px] text-muted-foreground mt-1">Margin retained from hamali → P/L</p>
                </CardContent>
              </Card>
            ) : (
              <Card className="bg-card border shadow-sm">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pending Verification</CardTitle>
                  <ShieldCheck className="h-4 w-4 text-amber-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">{rupees(currentPeriodCrew)}</div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Crew dues since {verifiedThroughDay ? shortDate(verifiedThroughDay) : 'the start'} → not yet squared off
                  </p>
                </CardContent>
              </Card>
            )}
            <Card className="bg-card border shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Weight Handled</CardTitle>
                <Truck className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{(totalTons).toFixed(2)} tonnes</div>
                <p className="text-[10px] text-muted-foreground mt-1">Equal to {kg(totalTons * 1000)} net weight</p>
              </CardContent>
            </Card>
            </>
            )}
          </div>
          )}

          {/* Square-off / reconciliation checkpoint (Hamali view only) */}
          {view === 'hamali' && (
            <div className="rounded-lg border bg-card">
              <div className="px-5 py-4 border-b flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                  <span className="font-semibold text-sm">Cross-verify with crew</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {verifiedThroughDay
                    ? <>Verified through <b className="text-emerald-600 dark:text-emerald-400">{shortDate(verifiedThroughDay)}</b></>
                    : 'Nothing verified yet'}
                </div>
              </div>
              <div className="p-5 flex flex-wrap items-end gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="square-date" className="text-xs font-semibold">Checked &amp; verified through</Label>
                  <Input id="square-date" type="date" value={squareDate} min={verifiedThroughDay ?? undefined} onChange={(e) => setSquareDate(e.target.value)} className="bg-card" />
                </div>
                <div className="space-y-1.5 flex-1 min-w-[180px]">
                  <Label htmlFor="square-note" className="text-xs font-semibold">Note (optional)</Label>
                  <Input id="square-note" value={squareNote} onChange={(e) => setSquareNote(e.target.value)} placeholder="e.g. verified with Ramesh, week 27" className="bg-card" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Crew dues in this window</Label>
                  <div className="h-9 flex items-center font-bold text-primary">{rupees(pendingCrewTotal)}</div>
                </div>
                <Button
                  onClick={() => createVerification.mutate({ asOfDate: squareDate, periodStart: nextPeriodStart, crewTotal: pendingCrewTotal, note: squareNote || null })}
                  disabled={!squareValid || createVerification.isPending}
                >
                  <CheckCircle2 className="h-4 w-4" /> {createVerification.isPending ? 'Squaring off…' : 'Square off'}
                </Button>
              </div>
              {verifSorted.length > 0 && (
                <div className="border-t px-5 py-3">
                  <div className="text-xs font-semibold text-muted-foreground mb-2">Verification history</div>
                  <div className="space-y-1.5">
                    {verifSorted.map((v) => (
                      <div key={v.id} className="flex items-center justify-between gap-3 text-sm">
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                          <span>Verified through <b>{shortDate(v.asOfDate)}</b></span>
                          <span className="text-muted-foreground">· {rupees(Number(v.crewTotal))}</span>
                          {v.note && <span className="text-muted-foreground truncate max-w-xs">— {v.note}</span>}
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => { if (confirm('Remove this checkpoint and reopen the period?')) deleteVerification.mutate(v.id); }}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Payables tab: squared-off periods to settle + crew ledger */}
          {view === 'payables' && (
            <div className="rounded-lg border bg-card overflow-x-auto">
              <div className="px-5 py-4 border-b">
                <span className="font-semibold text-sm">Crew Payables — Squared-off Periods</span>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {teamParty ? <>Settled against <b>{teamParty.name}</b></> : 'Loading crew party…'}
                </p>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Period (From – To)</TableHead>
                    <TableHead>Squared-off</TableHead>
                    <TableHead className="text-right">Days</TableHead>
                    <TableHead className="text-right">Total Payable</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payableRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                        No squared-off periods yet. Square off a window in the <b>Hamali</b> tab to create one.
                      </TableCell>
                    </TableRow>
                  ) : (
                    payableRows.map((r) => (
                      <TableRow key={r.v.id}>
                        <TableCell className="font-medium">{shortDate(r.from)} – {shortDate(r.to)}</TableCell>
                        <TableCell className="text-muted-foreground">{shortDate(r.v.createdAt)}</TableCell>
                        <TableCell className="text-right">{r.days}</TableCell>
                        <TableCell className="text-right font-bold text-primary">{rupees(r.payable)}</TableCell>
                        <TableCell className="text-right text-emerald-600 dark:text-emerald-400">{rupees(r.paid)}</TableCell>
                        <TableCell>
                          {r.status === 'PAID' ? (
                            <Badge className="text-[10px] gap-1 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"><CheckCircle2 className="h-3 w-3" /> Paid</Badge>
                          ) : r.status === 'PARTIAL' ? (
                            <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-600 dark:text-amber-400">Partial</Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px] border-rose-500/40 text-rose-600 dark:text-rose-400">Unpaid</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={r.status === 'PAID' || !teamParty}
                              onClick={() => openPay(r)}
                            >
                              <Coins className="h-3.5 w-3.5" /> Pay
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Undo this checkpoint (reopens the period)"
                              onClick={() => { if (confirm('Remove this checkpoint and reopen the period? Any recorded payments stay on the Payments page but unlink from this period.')) deleteVerification.mutate(r.v.id); }}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Ledger tab — party-ledger-style account statement for the crew */}
          {view === 'ledger' && (
            <div className="space-y-6">
              {/* Profile header (name / contact / bank) — mirrors the Party Ledger */}
              <div className="rounded-xl border bg-gradient-to-br from-primary/5 via-card to-card overflow-hidden">
                <div className="p-6 flex flex-col lg:flex-row lg:items-start gap-6">
                  <div className="flex items-start gap-4 flex-1">
                    <div className="h-14 w-14 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                      <Users className="h-7 w-7" />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h2 className="text-2xl font-bold tracking-tight">{teamParty?.name ?? 'Hamali Team'}</h2>
                        <Badge variant="outline" className="font-medium">Hamali Team</Badge>
                      </div>
                      <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm text-muted-foreground">
                        {teamParty?.phone && <span className="inline-flex items-center gap-1.5"><Phone className="h-3.5 w-3.5" /> {teamParty.phone}</span>}
                        {!teamParty?.phone && <span className="italic">Add phone & bank details in Parties</span>}
                      </div>
                    </div>
                  </div>
                  <div className="lg:w-80 shrink-0 rounded-lg border bg-background/60 p-4 space-y-2.5">
                    <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      <Landmark className="h-3.5 w-3.5" /> Bank Details
                    </div>
                    {teamParty?.bankAccountNumber || teamParty?.bankName || teamParty?.bankIfsc ? (
                      <div className="space-y-1.5 text-sm">
                        {teamParty?.bankName && <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground text-xs">Bank</span><span>{teamParty.bankName}</span></div>}
                        {teamParty?.bankAccountNumber && <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground text-xs">A/C No</span><span className="font-mono">{teamParty.bankAccountNumber}</span></div>}
                        {teamParty?.bankIfsc && <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground text-xs">IFSC</span><span className="font-mono">{teamParty.bankIfsc}</span></div>}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">No bank details on file.</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Account statement */}
              <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
                <div className="px-5 py-4 border-b bg-gradient-to-r from-primary/[0.07] via-card to-card flex items-end justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-2">
                    <ReceiptText className="h-4 w-4 text-primary" />
                    <span className="font-semibold tracking-tight">Account Statement</span>
                  </div>
                  <div className="text-right">
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Balance Owed</div>
                    <div className={`text-lg font-bold tabular-nums ${ledgerBalance === 0 ? '' : ledgerBalance > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                      {ledgerBalance === 0 ? 'Settled' : <>{rupees(Math.abs(ledgerBalance))} <span className="text-xs font-semibold">{ledgerBalance >= 0 ? 'CR' : 'DR'}</span></>}
                    </div>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="w-28">Date</TableHead>
                        <TableHead className="min-w-[240px]">Particulars</TableHead>
                        <TableHead className="text-right border-l border-border/60 bg-muted/60">Debit</TableHead>
                        <TableHead className="text-right bg-muted/60">Credit</TableHead>
                        <TableHead className="text-right border-l border-border/60 bg-muted/60">Balance</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {ledgerLines.length === 0 ? (
                        <TableRow><TableCell colSpan={5} className="h-28 text-center text-muted-foreground">No squared-off periods yet. Square off a window in the Hamali tab.</TableCell></TableRow>
                      ) : (
                        <>
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{shortDate(ledgerLines[0].date)}</TableCell>
                            <TableCell className="text-xs font-medium text-muted-foreground italic" colSpan={2}>Opening Balance</TableCell>
                            <TableCell className="bg-muted/20" />
                            <TableCell className="text-right border-l border-border/60 bg-muted/20 tabular-nums text-muted-foreground">
                              {ledgerOpening === 0 ? '0.00' : `${rupees(Math.abs(ledgerOpening))} ${ledgerOpening >= 0 ? 'CR' : 'DR'}`}
                            </TableCell>
                          </TableRow>
                          {ledgerLines.map((l, i) => (
                            <TableRow key={l.id} className={i % 2 === 1 ? 'bg-muted/[0.18]' : undefined}>
                              <TableCell className="align-top text-sm whitespace-nowrap text-muted-foreground">{shortDate(l.date)}</TableCell>
                              <TableCell className="align-top">
                                <div className="text-[13px] text-foreground/90 leading-snug">{l.particulars}</div>
                                {l.period && <div className="text-[11px] text-muted-foreground mt-0.5">Period: {l.period}</div>}
                              </TableCell>
                              <TableCell className="align-top text-right tabular-nums border-l border-border/60">{l.debit > 0 ? <span className="font-semibold">{rupees(l.debit)}</span> : <span className="text-muted-foreground/50">-</span>}</TableCell>
                              <TableCell className="align-top text-right tabular-nums">{l.credit > 0 ? <span className="font-semibold">{rupees(l.credit)}</span> : <span className="text-muted-foreground/50">-</span>}</TableCell>
                              <TableCell className="align-top text-right tabular-nums border-l border-border/60 font-medium">
                                {rupees(Math.abs(l.balance))} <span className="text-[9px] font-bold">{l.balance >= 0 ? 'CR' : 'DR'}</span>
                              </TableCell>
                            </TableRow>
                          ))}
                          <TableRow className="bg-primary/[0.06] hover:bg-primary/[0.06] border-t-2 border-border">
                            <TableCell className="text-xs text-muted-foreground whitespace-nowrap font-medium">{shortDate(ledgerLines[ledgerLines.length - 1].date)}</TableCell>
                            <TableCell className="text-sm font-semibold" colSpan={2}>Closing Balance</TableCell>
                            <TableCell className="text-right border-l border-border/60 font-semibold tabular-nums">{ledgerDebit > 0 ? rupees(ledgerDebit) : ''}</TableCell>
                            <TableCell className="text-right font-semibold tabular-nums">{ledgerCredit > 0 ? rupees(ledgerCredit) : ''}</TableCell>
                            <TableCell className="text-right border-l border-border/60 font-bold tabular-nums">
                              {rupees(Math.abs(ledgerBalance))} <span className="text-[9px] font-bold">{ledgerBalance >= 0 ? 'CR' : 'DR'}</span>
                            </TableCell>
                          </TableRow>
                        </>
                      )}
                    </TableBody>
                  </Table>
                </div>
                {ledgerLines.length > 0 && (
                  <div className="grid grid-cols-3 divide-x divide-border border-t bg-muted/20 text-center">
                    <div className="px-5 py-3.5">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Total Debit (Paid)</div>
                      <div className="text-base font-bold tabular-nums mt-0.5">{rupees(ledgerDebit)}</div>
                    </div>
                    <div className="px-5 py-3.5">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Total Credit (Dues)</div>
                      <div className="text-base font-bold tabular-nums mt-0.5">{rupees(ledgerCredit)}</div>
                    </div>
                    <div className="px-5 py-3.5">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Balance Owed</div>
                      <div className={`text-base font-bold tabular-nums mt-0.5 ${ledgerBalance > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                        {ledgerBalance === 0 ? 'Settled' : `${rupees(Math.abs(ledgerBalance))} ${ledgerBalance >= 0 ? 'CR' : 'DR'}`}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Ledger Table */}
          {(view === 'company' || view === 'hamali') && (
          <>
          <div className="rounded-lg border bg-card overflow-x-auto">
            <div className="px-5 py-4 border-b font-semibold text-sm flex items-center justify-between gap-3">
              <span>Hamali Disbursements</span>
              <ExportButtons
                filename={`Hamali_Report_${view === 'company' ? 'Company' : 'Crew'}`}
                title={`Hamali Report (${view === 'company' ? 'Company' : 'Crew'})`}
                subtitle={`${filtered.length} entry(s)`}
                columns={hamaliExportColumns}
                rows={filtered}
              />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Party</TableHead>
                  <TableHead>Lorry No</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Net Weight (kg)</TableHead>
                  <TableHead className="text-right">Full Charge</TableHead>
                  {view === 'company' && <TableHead className="text-right">Our Share</TableHead>}
                  {view === 'company' && <TableHead className="text-right">Lorry Share</TableHead>}
                  <TableHead className="text-right">Crew Paid</TableHead>
                  {view === 'company' && <TableHead className="text-right">Company P/L</TableHead>}
                  {view === 'hamali' && <TableHead>Status</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                      No hamali transactions match selected filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  visible.map((e) => (
                    <TableRow key={e.id} className={view === 'hamali' && isVerified(e.date) ? 'bg-muted/20' : undefined}>
                      <TableCell>{shortDate(e.date)}</TableCell>
                      <TableCell>
                        <Badge variant={e.source === 'SALE' ? 'default' : e.source === 'TRANSFER' ? 'secondary' : 'outline'} className="text-[10px]">
                          {e.label || (e.source === 'SALE' ? 'Sale Loading' : e.source === 'TRANSFER' ? 'Transfer' : 'Purchase')}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-semibold">{e.partyName}</TableCell>
                      <TableCell>{e.lorryNumber ?? '-'}</TableCell>
                      <TableCell className="text-xs">{e.reference}</TableCell>
                      <TableCell className="text-right font-medium">{kg(e.netWeightKg)}</TableCell>
                      <TableCell className="text-right font-bold text-primary">{rupees(e.fullCharge)}</TableCell>
                      {view === 'company' && <TableCell className="text-right font-semibold text-amber-600">{rupees(e.ourShare)}</TableCell>}
                      {view === 'company' && <TableCell className="text-right text-muted-foreground">{rupees(e.lorryShare)}</TableCell>}
                      <TableCell className="text-right">{rupees(e.crew)}</TableCell>
                      {view === 'company' && <TableCell className="text-right font-semibold text-emerald-600 dark:text-emerald-400">{rupees(e.pl)}</TableCell>}
                      {view === 'hamali' && (
                        <TableCell>
                          {isVerified(e.date) ? (
                            <Badge variant="secondary" className="text-[10px] gap-1"><Lock className="h-3 w-3" /> Verified</Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px]">Current</Badge>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
          </div>

          {/* Manually-recorded charges (bag cutting, pappu net, diesel, misc, paid) */}
          <div className="rounded-lg border bg-card overflow-x-auto">
            <div className="px-5 py-4 border-b flex flex-wrap items-center justify-between gap-3">
              <span className="font-semibold text-sm">Recorded Charges</span>
              <div className="flex gap-4 text-xs">
                <span className="text-muted-foreground">Charged: <b className="text-primary">{rupees(manualCharged)}</b></span>
                <span className="text-muted-foreground">Paid: <b className="text-emerald-600 dark:text-emerald-400">{rupees(manualPaid)}</b></span>
                <span className="text-muted-foreground">Outstanding: <b className={manualOutstanding > 0 ? 'text-rose-600 dark:text-rose-400' : ''}>{rupees(manualOutstanding)}</b></span>
              </div>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Charge</TableHead>
                  <TableHead className="text-right">Bags</TableHead>
                  <TableHead className="text-right">Rate/Bag</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {manualSorted.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                      No charges recorded. Use “Record” to add bag cutting, pappu net, diesel, or paid amounts.
                    </TableCell>
                  </TableRow>
                ) : (
                  manualSorted.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>{shortDate(c.date)}</TableCell>
                      <TableCell>
                        <Badge variant={c.type === 'PAID' ? 'default' : 'outline'} className="text-[10px]">
                          {manualTypeMeta(c.type).label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{c.bags ?? '-'}</TableCell>
                      <TableCell className="text-right">{c.ratePerBag != null ? rupees(Number(c.ratePerBag)) : '-'}</TableCell>
                      <TableCell className="text-muted-foreground max-w-xs truncate">{c.note ?? '-'}</TableCell>
                      <TableCell className={`text-right font-bold ${c.type === 'PAID' ? 'text-emerald-600 dark:text-emerald-400' : 'text-primary'}`}>
                        {c.type === 'PAID' ? '−' : ''}{rupees(Number(c.amount))}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => { if (confirm('Remove this charge and reverse its ledger posting?')) deleteManual.mutate(c.id); }}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          </>
          )}
        </div>
      )}

      <Dialog open={recordOpen} onOpenChange={setRecordOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record Hamali Charge</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="m-date">Date</Label>
                <Input id="m-date" type="date" value={mDate} onChange={(e) => setMDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Charge Type</Label>
                <Select value={mType} onValueChange={(v) => onTypeChange(v as ManualHamaliType)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MANUAL_TYPES.map((m) => (
                      <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {mMeta.perBag ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="m-bags">No. of Bags</Label>
                  <Input id="m-bags" type="number" min="0" value={mBags} onChange={(e) => setMBags(e.target.value)} placeholder="e.g. 200" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="m-rate">Rate / Bag (₹)</Label>
                  <Input id="m-rate" type="number" step="0.01" value={mRate} onChange={(e) => setMRate(e.target.value)} />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="m-amount">Amount (₹)</Label>
                <Input id="m-amount" type="number" step="0.01" value={mAmount} onChange={(e) => setMAmount(e.target.value)} placeholder="e.g. 1500" />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="m-note">Note</Label>
              <Input id="m-note" value={mNote} onChange={(e) => setMNote(e.target.value)} placeholder="Optional (place, vehicle, remark…)" />
            </div>

            <div className="rounded-md bg-muted/50 px-3 py-2 text-sm flex items-center justify-between">
              <span className="text-muted-foreground">Total</span>
              <span className="font-bold text-primary">{rupees(mComputed)}</span>
            </div>

            <DialogFooter>
              <Button onClick={() => createManual.mutate()} disabled={!manualValid || createManual.isPending}>
                {createManual.isPending ? 'Saving…' : 'Record Charge'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Pay crew for a squared-off period */}
      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Pay Hamali Crew</DialogTitle>
          </DialogHeader>
          {payVerif && (
            <div className="space-y-4">
              <div className="rounded-md bg-muted/50 px-3 py-2 text-sm space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Period</span>
                  <span className="font-medium">{shortDate(payVerif.from)} – {shortDate(payVerif.to)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Payable</span>
                  <span className="font-medium">{rupees(payVerif.payable)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Already paid</span>
                  <span className="font-medium text-emerald-600 dark:text-emerald-400">{rupees(payVerif.paid)}</span>
                </div>
                <div className="flex items-center justify-between border-t pt-1">
                  <span className="text-muted-foreground">Outstanding</span>
                  <span className="font-bold text-primary">{rupees(payVerif.outstanding)}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="pay-date">Payment Date</Label>
                  <Input id="pay-date" type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pay-amount">Amount (₹)</Label>
                  <Input id="pay-amount" type="number" step="1" min="0" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="pay-ref">Reference (UTR / Cheque / Cash)</Label>
                <Input id="pay-ref" value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="Optional" />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Records a payment to <b>{teamParty?.name ?? 'the hamali crew'}</b> and posts Dr crew payable / Cr bank. It appears on the Payments page.
              </p>

              <DialogFooter>
                <Button
                  onClick={() => payCrew.mutate()}
                  disabled={!teamParty || !(Number(payAmount) > 0) || payCrew.isPending}
                >
                  {payCrew.isPending ? 'Recording…' : `Pay ${rupees(Number(payAmount) || 0)}`}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
