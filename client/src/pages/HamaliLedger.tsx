import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import { usePagedRows } from '@/lib/usePagedRows';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import type { Purchase, SaleOrder, HamaliRate, StockTransfer, ShellTransfer, HuskTransfer, ManualHamaliCost, ManualHamaliType, HamaliVerification, CompanyProfile, Payment, Party } from '@/lib/types';
import { kg, rupees, shortDate, toYMD } from '@/lib/format';
import { hamaliSplit, pappuLoadingHamali, calcHamali, customLoadingHamali, isVehicleExempt } from '@/lib/calc';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { Loader2, Coins, TrendingUp, Truck, Plus, Trash2, ShieldCheck, Lock, CheckCircle2, ReceiptText, Users, Phone, Landmark, Calculator, RotateCcw } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger, PopoverClose } from '@/components/ui/popover';

function getRoundOptions(amount: number): { label: string; value: number }[] {
  if (!amount || isNaN(amount)) return [];
  const rawOpts: { label: string; value: number }[] = [
    { label: 'Nearest 10', value: Math.round(amount / 10) * 10 },
    { label: 'Nearest 50', value: Math.round(amount / 50) * 50 },
    { label: 'Nearest 100', value: Math.round(amount / 100) * 100 },
    { label: 'Nearest 1,000', value: Math.round(amount / 1000) * 1000 },
    { label: 'Round Down 100', value: Math.floor(amount / 100) * 100 },
    { label: 'Round Up 100', value: Math.ceil(amount / 100) * 100 },
    { label: 'Round Down 1,000', value: Math.floor(amount / 1000) * 1000 },
    { label: 'Round Up 1,000', value: Math.ceil(amount / 1000) * 1000 },
    { label: 'Exact Integer', value: Math.round(amount) },
  ];

  const seen = new Set<number>();
  const unique: { label: string; value: number }[] = [];
  for (const opt of rawOpts) {
    if (opt.value > 0 && !seen.has(opt.value)) {
      seen.add(opt.value);
      unique.push(opt);
    }
  }
  return unique.sort((a, b) => b.value - a.value);
}

// Manual hamali charge categories the crew is paid for but that can't be derived
// from purchases/sales. Per-bag types compute amount = bags × rate; flat types
// take a direct amount. Default per-bag rates match the mill's standard charges.
const MANUAL_TYPES: { value: ManualHamaliType; label: string; perBag: boolean; defaultRate?: number }[] = [
  { value: 'BAG_CUTTING_NORMAL', label: 'Bag Cutting (Place A)', perBag: true, defaultRate: 3 },
  { value: 'BAG_CUTTING_DISTANCE', label: 'Bag Cutting (Place B)', perBag: true, defaultRate: 6 },
  { value: 'PAPPU_NET', label: 'Pappu Net', perBag: true, defaultRate: 3 },
  { value: 'TPS_BROKENS_PACKING', label: 'TPS Brokens Packing', perBag: true },
  { value: 'TAMARIND_BYPRODUCTS_PACKING', label: 'Tamarind Byproducts Packing', perBag: true },
  { value: 'TARBAL_FEE', label: 'Tarbal Fee', perBag: false },
  { value: 'MISC', label: 'Hamali Miscellaneous', perBag: false },
  { value: 'PAID', label: 'Paid to Hamali', perBag: false },
  { value: 'ADVANCE', label: 'Advance Given', perBag: false },
];
const manualTypeMeta = (t: ManualHamaliType) => MANUAL_TYPES.find((m) => m.value === t)!;
const isManualDeduction = (t: ManualHamaliType) => t === 'PAID' || t === 'ADVANCE';

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

// A single row of the combined "Hamali Disbursements & Charges" table - either a
// derived HamaliEntry (purchase/sale/transfer) or a manually recorded charge,
// normalized to one shape so both kinds can share one sorted, paginated table.
interface UnifiedRow {
  id: string;
  kind: 'ENTRY' | 'MANUAL';
  date: string;
  typeLabel: string;
  badgeVariant: 'default' | 'secondary' | 'outline';
  party: string;
  lorryOrBags: string;
  referenceOrNote: string;
  netWeightKg: number | null;
  fullCharge: number | null;
  ourShare: number | null;
  lorryShare: number | null;
  amount: number;
  isPaidOut: boolean;
  pl: number | null;
  entry?: HamaliEntry;
  manual?: ManualHamaliCost;
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

  const [roundedValues, setRoundedValues] = useState<Record<string, number>>(() => {
    try {
      const saved = localStorage.getItem('hamali_rounded_values');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const { data: purchases, isLoading: loadingPurchases } = useQuery({
    queryKey: ['purchases', 'hamali'],
    queryFn: () => api<PurchaseRow[]>('/purchases?view=hamali'),
  });

  const { data: saleOrders, isLoading: loadingSales } = useQuery({
    // Full history - /sale-orders is capped at the latest 100 by default, which
    // would drop older dispatches (and their loading hamali) off this ledger.
    queryKey: ['sale-orders', { all: true }],
    queryFn: () => api<SaleOrder[]>('/sale-orders?all=true'),
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

  // Crew-settlement payments (type HAMALI) - drive the Payables status and the
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
  const [squareStartDate, setSquareStartDate] = useState('');
  const [squareDate, setSquareDate] = useState('');
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

  // Recorded-charges table filter: searchable type picker + free-text note search
  const [chargeFilter, setChargeFilter] = useState<string>('ALL');
  const [chargeSearch, setChargeSearch] = useState('');

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
      toast.success('Squared off - data cross-verified with crew');
      setSquareStartDate('');
      setSquareDate('');
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

  const allHamaliEntries = useMemo(
    () => [...purchaseEntries, ...saleEntries, ...transferEntries],
    [purchaseEntries, saleEntries, transferEntries]
  );

  const chargeTypeOptions = useMemo<ComboOption[]>(() => {
    const options: ComboOption[] = [{ value: 'ALL', label: 'All charge types' }];
    const seen = new Set<string>(['ALL']);

    // Standard derived operations
    const standardDerived: { value: string; label: string; hint: string }[] = [
      { value: 'Black Seed Unloading', label: 'Black Seed Unloading', hint: 'Purchase' },
      { value: 'Pappu Loading', label: 'Pappu Loading', hint: 'Sale' },
      { value: 'Pappu Roasting', label: 'Pappu Roasting', hint: 'Sale' },
      { value: 'Husk Loading', label: 'Husk Loading', hint: 'Sale' },
      { value: 'TPS Loading', label: 'TPS Loading', hint: 'Sale' },
      { value: 'Waste Loading', label: 'Waste Loading', hint: 'Sale' },
      { value: 'Stock Transfer', label: 'Stock Transfer', hint: 'Transfer' },
      { value: 'Shell Transfer', label: 'Shell Transfer', hint: 'Transfer' },
      { value: 'Husk Transfer', label: 'Husk Transfer', hint: 'Transfer' },
    ];

    for (const item of standardDerived) {
      if (!seen.has(item.value)) {
        seen.add(item.value);
        options.push(item);
      }
    }

    // Dynamic custom rates from settings
    if (hamaliRates) {
      for (const r of hamaliRates) {
        if (r.isCustom && r.label) {
          const customLabel = `Pappu ${r.label}`;
          if (!seen.has(customLabel)) {
            seen.add(customLabel);
            options.push({ value: customLabel, label: customLabel, hint: 'Sale (Custom)' });
          }
        }
      }
    }

    // Any other dynamic labels in derived entries
    for (const e of allHamaliEntries) {
      const label = e.label || (e.source === 'SALE' ? 'Sale Loading' : e.source === 'TRANSFER' ? 'Transfer' : 'Purchase');
      if (label && !seen.has(label)) {
        seen.add(label);
        const hint = e.source === 'PURCHASE' ? 'Purchase' : e.source === 'SALE' ? 'Sale' : 'Transfer';
        options.push({ value: label, label, hint });
      }
    }

    // Manual charge categories
    for (const m of MANUAL_TYPES) {
      if (!seen.has(m.label)) {
        seen.add(m.label);
        const hint = isManualDeduction(m.value) ? 'Payout' : 'Manual';
        options.push({ value: m.label, label: m.label, hint });
      }
    }

    return options;
  }, [allHamaliEntries, hamaliRates]);

  const dayOf = (d: string) => toYMD(d);

  const q = search.trim().toLowerCase();
  const chargeNote = chargeSearch.trim().toLowerCase();

  const filtered = useMemo(() => {
    return allHamaliEntries
      .filter((e) => {
        // Purchases are supplier-side hamali, sale loading is buyer-side.
        if (partyType === 'SUPPLIER' && e.source !== 'PURCHASE') return false;
        if (partyType === 'BUYER' && e.source !== 'SALE') return false;
        if (q && !e.partyName.toLowerCase().includes(q)) return false;

        const entryLabel = e.label || (e.source === 'SALE' ? 'Sale Loading' : e.source === 'TRANSFER' ? 'Transfer' : 'Purchase');
        if (chargeFilter !== 'ALL' && entryLabel !== chargeFilter) return false;

        if (chargeNote && !(`${e.reference} ${entryLabel} ${e.partyName}`.toLowerCase().includes(chargeNote))) return false;
        const d = dayOf(e.date);
        if (startDate && d < startDate) return false;
        if (endDate && d > endDate) return false;
        return true;
      })
      .sort((a, b) => {
        const dayB = dayOf(b.date);
        const dayA = dayOf(a.date);
        if (dayB !== dayA) return dayB.localeCompare(dayA);
        return new Date(b.date).getTime() - new Date(a.date).getTime();
      });
  }, [allHamaliEntries, partyType, q, chargeFilter, chargeNote, startDate, endDate]);

  // Metrics
  const totalPl = filtered.reduce((acc, e) => acc + e.pl, 0);
  const totalTons = filtered.reduce((acc, e) => acc + e.netWeightKg, 0) / 1000;

  // Manual costs - charges accrue what we owe the crew; PAID entries settle it.
  const manualSorted = useMemo(
    () =>
      [...(manualCosts ?? [])].sort((a, b) => {
        const dayB = dayOf(b.date);
        const dayA = dayOf(a.date);
        if (dayB !== dayA) return dayB.localeCompare(dayA);
        return new Date(b.date).getTime() - new Date(a.date).getTime();
      }),
    [manualCosts]
  );

  // Rows shown in the Recorded Charges table + their own header totals honor the
  // type/search filter, party filters, and date range filters.
  const manualFiltered = useMemo(() => {
    // If party filter is active (BUYER / SUPPLIER) or party search is typed,
    // manual charges (mill crew charges without a party) should not appear
    if (partyType !== 'ALL' || q !== '') return [];

    const needle = chargeSearch.trim().toLowerCase();
    return manualSorted.filter((c) => {
      const meta = manualTypeMeta(c.type);
      const manualLabel = meta?.label;
      if (chargeFilter !== 'ALL' && manualLabel !== chargeFilter && c.type !== chargeFilter) return false;
      if (needle && !(`${c.note ?? ''} ${manualLabel ?? ''}`.toLowerCase().includes(needle))) return false;
      const d = dayOf(c.date);
      if (startDate && d < startDate) return false;
      if (endDate && d > endDate) return false;
      return true;
    });
  }, [manualSorted, chargeFilter, chargeSearch, partyType, q, startDate, endDate]);

  // Combined "Hamali Disbursements & Charges" table - derived entries and
  // manually recorded charges merged into one list, sorted by date, so the
  // page shows a single section instead of two separate tables.
  const unifiedRows: UnifiedRow[] = useMemo(() => {
    const entryRows: UnifiedRow[] = filtered.map((e) => ({
      id: e.id,
      kind: 'ENTRY' as const,
      date: e.date,
      typeLabel: e.label || (e.source === 'SALE' ? 'Sale Loading' : e.source === 'TRANSFER' ? 'Transfer' : 'Purchase'),
      badgeVariant: (e.source === 'SALE' ? 'default' : e.source === 'TRANSFER' ? 'secondary' : 'outline') as UnifiedRow['badgeVariant'],
      party: e.partyName,
      lorryOrBags: e.lorryNumber ?? '-',
      referenceOrNote: e.reference,
      netWeightKg: e.netWeightKg,
      fullCharge: e.fullCharge,
      ourShare: e.ourShare,
      lorryShare: e.lorryShare,
      amount: roundedValues[e.id] !== undefined ? roundedValues[e.id] : e.crew,
      isPaidOut: false,
      pl: e.pl,
      entry: e,
    }));
    const manualRows: UnifiedRow[] = manualFiltered.map((c) => ({
      id: `MANUAL-${c.id}`,
      kind: 'MANUAL' as const,
      date: c.date,
      typeLabel: manualTypeMeta(c.type).label,
      badgeVariant: (isManualDeduction(c.type) ? 'default' : 'outline') as UnifiedRow['badgeVariant'],
      party: '-',
      lorryOrBags: c.bags != null ? String(c.bags) : '-',
      referenceOrNote: c.note ?? '-',
      netWeightKg: null,
      fullCharge: null,
      ourShare: null,
      lorryShare: null,
      amount: Number(c.amount),
      isPaidOut: isManualDeduction(c.type),
      pl: null,
      manual: c,
    }));
    return [...entryRows, ...manualRows].sort((a, b) => {
      const dayB = dayOf(b.date);
      const dayA = dayOf(a.date);
      if (dayB !== dayA) return dayB.localeCompare(dayA);
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });
  }, [filtered, manualFiltered, roundedValues]);

  const tableCharged = useMemo(() => {
    return unifiedRows
      .filter((r) => !r.isPaidOut)
      .reduce((s, r) => s + (view === 'company' && r.fullCharge != null ? r.fullCharge : r.amount), 0);
  }, [unifiedRows, view]);

  const tablePaid = useMemo(() => {
    return unifiedRows
      .filter((r) => r.isPaidOut)
      .reduce((s, r) => s + r.amount, 0);
  }, [unifiedRows]);

  const tableOutstanding = tableCharged - tablePaid;
  const chargeFilterActive = chargeFilter !== 'ALL' || chargeSearch.trim() !== '';

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows: visible = [] } = usePagedRows(unifiedRows, 50);

  // --- Reconciliation checkpoints (Hamali view) ---
  // Rows dated on/before the latest checkpoint are cross-verified and locked; the
  // window since is the current, still-to-verify period. Crew total = derived crew
  // shares + manual charges − paid, matching what the crew is actually owed.
  const verifSorted = [...(verifications ?? [])].sort((a, b) => new Date(b.asOfDate).getTime() - new Date(a.asOfDate).getTime());
  const verifiedThroughDay = verifSorted[0] ? dayOf(verifSorted[0].asOfDate) : null;
  const isVerified = (dateIso: string) => verifiedThroughDay != null && dayOf(dateIso) <= verifiedThroughDay;

  const addDay = (day: string) => {
    const d = new Date(day + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    return toYMD(d.toISOString());
  };
  const daysInclusive = (from: string, to: string) =>
    Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000) + 1);

  // Earliest dated crew due (for the first period's "from", when nothing precedes it).
  const allDatedCrew = [...allHamaliEntries.map((e) => dayOf(e.date)), ...manualSorted.map((c) => dayOf(c.date))];
  const earliestCrewDay = allDatedCrew.length ? allDatedCrew.reduce((m, d) => (d < m ? d : m)) : null;

  // The period start for a NEW square-off = day after the last checkpoint, else
  // the earliest crew due (so the first period spans from the very beginning).
  const nextPeriodStart = verifiedThroughDay ? addDay(verifiedThroughDay) : earliestCrewDay;

  const currentSquareStart = squareStartDate || startDate || nextPeriodStart || '';
  const currentSquareEnd = squareDate || endDate || dayOf(new Date().toISOString());

  // Amount pending verification for the picked square-off date window: crew dues in the
  // window (after the last checkpoint, on/after currentSquareStart, on/before currentSquareEnd).
  const inSquareWindow = (dateIso: string) => {
    const d = dayOf(dateIso);
    if (verifiedThroughDay != null && d <= verifiedThroughDay) return false;
    if (currentSquareStart && d < currentSquareStart) return false;
    return d <= currentSquareEnd;
  };
  const pendingCrewFromEntries = allHamaliEntries
    .filter((e) => inSquareWindow(e.date))
    .reduce((s, e) => s + (roundedValues[e.id] !== undefined ? roundedValues[e.id] : e.crew), 0);
  const pendingCrewFromManual = manualSorted
    .filter((c) => inSquareWindow(c.date))
    .reduce((s, c) => s + (isManualDeduction(c.type) ? -Number(c.amount) : Number(c.amount)), 0);
  const pendingCrewTotal = Math.round((pendingCrewFromEntries + pendingCrewFromManual) * 100) / 100;
  const squareValid =
    (verifiedThroughDay == null || currentSquareEnd > verifiedThroughDay) &&
    (!currentSquareStart || currentSquareEnd >= currentSquareStart) &&
    pendingCrewTotal > 0;

  // Crew payable across the currently filtered rows (Hamali view metric).
  const includeManualInTile = partyType === 'ALL' && q === '';
  const manualNetInWindow = manualFiltered
    .reduce((s, c) => s + (isManualDeduction(c.type) ? -Number(c.amount) : Number(c.amount)), 0);
  const totalCrew = filtered.reduce((acc, e) => acc + (roundedValues[e.id] !== undefined ? roundedValues[e.id] : e.crew), 0) + manualNetInWindow;

  // Total Hamali Charge (Company tile) - purchases/sale loading plus the
  // Recorded Charges (bag cutting, pappu net, packing, tarbal, misc) that the
  // crew is also paid for. PAID / ADVANCE entries settle or reduce a charge rather than being one,
  // so they're excluded here (unlike totalCrew, which nets them off dues).
  const manualChargedInWindow = manualFiltered
    .filter((c) => !isManualDeduction(c.type))
    .reduce((s, c) => s + Number(c.amount), 0);
  const totalHamali = filtered.reduce((acc, e) => acc + e.fullCharge, 0) + manualChargedInWindow;

  // ── Payables tab: one row per squared-off period ──────────────────────────
  // Crew-settlement payments (HAMALI) grouped by the period they settle.
  const hamaliPayments = (payments ?? []).filter((p) => p.type === 'HAMALI');
  const paidByVerification = new Map<string, number>();
  for (const p of hamaliPayments) {
    if (!p.hamaliVerificationId) continue;
    paidByVerification.set(p.hamaliVerificationId, (paidByVerification.get(p.hamaliVerificationId) ?? 0) + Number(p.amount));
  }
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

  // ── Crew ledger (Ledger tab) - a party-ledger-style account statement for the
  // hamali crew. Credits are the SQUARED-OFF periods (one line per checkpoint, with
  // its date range) - NOT the individual loading/unloading rows. Debits are the
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

  const unifiedExportColumns: ExportColumn<UnifiedRow>[] = [
    { header: 'Date', value: (r) => shortDate(r.date) },
    { header: 'Type', value: (r) => r.typeLabel },
    { header: 'Party', value: (r) => r.party },
    { header: 'Lorry No / Bags', value: (r) => r.lorryOrBags },
    { header: 'Reference / Note', value: (r) => r.referenceOrNote },
    { header: 'Net Weight (kg)', value: (r) => r.netWeightKg ?? '', numFmt: '#,##0', align: 'right' },
    { header: 'Full Charge', value: (r) => (r.fullCharge != null ? rupees(r.fullCharge) : ''), excel: (r) => r.fullCharge ?? null, numFmt: '#,##0.00', align: 'right' },
    ...(view === 'company' ? [
      { header: 'Our Share', value: (r: UnifiedRow) => (r.ourShare != null ? rupees(r.ourShare) : ''), excel: (r: UnifiedRow) => r.ourShare ?? null, numFmt: '#,##0.00', align: 'right' as const },
      { header: 'Lorry Share', value: (r: UnifiedRow) => (r.lorryShare != null ? rupees(r.lorryShare) : ''), excel: (r: UnifiedRow) => r.lorryShare ?? null, numFmt: '#,##0.00', align: 'right' as const },
    ] : []),
    { header: 'Crew / Amount', value: (r) => `${r.isPaidOut ? '−' : ''}${rupees(r.amount)}`, excel: (r) => (r.isPaidOut ? -r.amount : r.amount), numFmt: '#,##0.00', align: 'right' },
    ...(view === 'company'
      ? [{ header: 'Company P/L', value: (r: UnifiedRow) => (r.pl != null ? rupees(r.pl) : ''), excel: (r: UnifiedRow) => r.pl ?? null, numFmt: '#,##0.00', align: 'right' as const }]
      : [{ header: 'Status', value: (r: UnifiedRow) => (isVerified(r.date) ? 'Verified' : 'Current') }]),
  ];

  // Crew dues accrued since the last checkpoint (through today) - the standing
  // "not yet verified" figure, independent of the square-off date picker.
  const todayDay = new Date().toISOString().slice(0, 10);
  const sinceCheckpoint = (dateIso: string) => {
    const d = dayOf(dateIso);
    if (verifiedThroughDay != null && d <= verifiedThroughDay) return false;
    return d <= todayDay;
  };
  const currentPeriodCrew =
    Math.round(
      (allHamaliEntries
        .filter((e) => sinceCheckpoint(e.date))
        .reduce((s, e) => s + (roundedValues[e.id] !== undefined ? roundedValues[e.id] : e.crew), 0) +
        manualSorted
          .filter((c) => sinceCheckpoint(c.date))
          .reduce((s, c) => s + (isManualDeduction(c.type) ? -Number(c.amount) : Number(c.amount)), 0)) *
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
                ? 'Squared-off crew dues - pay each verified period and track what is settled'
                : view === 'ledger'
                  ? 'Account statement for the hamali crew - squared-off dues vs settlements'
                  : 'Crew-facing view - what the hamali crew is owed, cross-verified and squared off periodically'}
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
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Full charge across purchases &amp; sale loading{includeManualInTile ? ', incl. recorded charges' : ''}
                  </p>
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
                  <Label htmlFor="square-start-date" className="text-xs font-semibold">Period from</Label>
                  <Input
                    id="square-start-date"
                    type="date"
                    value={currentSquareStart}
                    min={verifiedThroughDay ? addDay(verifiedThroughDay) : undefined}
                    onChange={(e) => setSquareStartDate(e.target.value)}
                    className="bg-card"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="square-date" className="text-xs font-semibold">Checked &amp; verified through</Label>
                  <Input
                    id="square-date"
                    type="date"
                    value={currentSquareEnd}
                    min={currentSquareStart || (verifiedThroughDay ? addDay(verifiedThroughDay) : undefined)}
                    onChange={(e) => setSquareDate(e.target.value)}
                    className="bg-card"
                  />
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
                  onClick={() => createVerification.mutate({ asOfDate: currentSquareEnd, periodStart: currentSquareStart || null, crewTotal: pendingCrewTotal, note: squareNote || null })}
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
                          {v.note && <span className="text-muted-foreground truncate max-w-xs">- {v.note}</span>}
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
                <span className="font-semibold text-sm">Crew Payables - Squared-off Periods</span>
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

          {/* Ledger tab - party-ledger-style account statement for the crew */}
          {view === 'ledger' && (
            <div className="space-y-6">
              {/* Profile header (name / contact / bank) - mirrors the Party Ledger */}
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
                        <TableHead className="text-right border-l border-border/60 bg-secondary">Debit</TableHead>
                        <TableHead className="text-right bg-secondary">Credit</TableHead>
                        <TableHead className="text-right border-l border-border/60 bg-secondary">Balance</TableHead>
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

          {/* Hamali Disbursements & Charges - combined into one table so derived
              entries (purchase/sale/transfer) and manually recorded charges
              (bag cutting, pappu net, misc, paid) live in a single section. */}
          {(view === 'company' || view === 'hamali') && (
          <div className="rounded-lg border bg-card overflow-x-auto">
            <div className="px-5 py-4 border-b flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-sm">Hamali Disbursements &amp; Charges</span>
                <Combobox
                  className="h-9 w-60"
                  ariaLabel="Filter by charge type"
                  placeholder="All charge types"
                  searchPlaceholder="Search charge type…"
                  value={chargeFilter}
                  onChange={(v) => setChargeFilter(v)}
                  options={chargeTypeOptions}
                />
                <Input
                  className="h-9 w-44"
                  placeholder="Search note…"
                  value={chargeSearch}
                  onChange={(e) => setChargeSearch(e.target.value)}
                />
                {chargeFilterActive && (
                  <Button variant="ghost" size="sm" className="h-9" onClick={() => { setChargeFilter('ALL'); setChargeSearch(''); }}>Clear</Button>
                )}
              </div>
              <div className="flex items-center gap-4">
                <div className="flex gap-4 text-xs">
                  <span className="text-muted-foreground">Charged: <b className="text-primary">{rupees(tableCharged)}</b></span>
                  <span className="text-muted-foreground">Paid: <b className="text-emerald-600 dark:text-emerald-400">{rupees(tablePaid)}</b></span>
                  <span className="text-muted-foreground">Outstanding: <b className={tableOutstanding > 0 ? 'text-rose-600 dark:text-rose-400' : ''}>{rupees(tableOutstanding)}</b></span>
                </div>
                <ExportButtons
                  filename={`Hamali_Report_${view === 'company' ? 'Company' : 'Crew'}`}
                  title={`Hamali Report (${view === 'company' ? 'Company' : 'Crew'})`}
                  subtitle={`${unifiedRows.length} entry(s)`}
                  columns={unifiedExportColumns}
                  rows={unifiedRows}
                />
              </div>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Party</TableHead>
                  <TableHead>Lorry No / Bags</TableHead>
                  <TableHead>Reference / Note</TableHead>
                  <TableHead className="text-right">Net Weight (kg)</TableHead>
                  <TableHead className="text-right">Full Charge</TableHead>
                  {view === 'company' && <TableHead className="text-right">Our Share</TableHead>}
                  {view === 'company' && <TableHead className="text-right">Lorry Share</TableHead>}
                  <TableHead className="text-right">Crew / Amount</TableHead>
                  {view === 'hamali' && <TableHead className="text-right min-w-[210px]">Rounded Off</TableHead>}
                  {view === 'company' && <TableHead className="text-right">Company P/L</TableHead>}
                  {view === 'hamali' && <TableHead>Status</TableHead>}
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {unifiedRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={13} className="text-center text-muted-foreground py-8">
                      No hamali transactions or charges match selected filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  visible.map((r) => (
                    <TableRow key={r.id} className={view === 'hamali' && isVerified(r.date) ? 'bg-muted/20' : undefined}>
                      <TableCell>{shortDate(r.date)}</TableCell>
                      <TableCell>
                        <Badge variant={r.badgeVariant} className="text-[10px]">{r.typeLabel}</Badge>
                      </TableCell>
                      <TableCell className="font-semibold">{r.party}</TableCell>
                      <TableCell>{r.lorryOrBags}</TableCell>
                      <TableCell className="text-xs">{r.referenceOrNote}</TableCell>
                      <TableCell className="text-right font-medium">{r.netWeightKg != null ? kg(r.netWeightKg) : '-'}</TableCell>
                      <TableCell className="text-right font-bold text-primary">{r.fullCharge != null ? rupees(r.fullCharge) : '-'}</TableCell>
                      {view === 'company' && <TableCell className="text-right font-semibold text-amber-600">{r.ourShare != null ? rupees(r.ourShare) : '-'}</TableCell>}
                      {view === 'company' && <TableCell className="text-right text-muted-foreground">{r.lorryShare != null ? rupees(r.lorryShare) : '-'}</TableCell>}
                      <TableCell className={`text-right font-bold ${r.isPaidOut ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>
                        {r.isPaidOut ? '−' : ''}{rupees(r.amount)}
                      </TableCell>
                      {view === 'hamali' && (
                        <TableCell className="text-right">
                          {r.kind === 'ENTRY' && r.entry ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <Input
                                type="number"
                                step="1"
                                className="w-28 h-8 text-right font-semibold text-xs bg-card"
                                placeholder={rupees(r.entry.crew)}
                                value={roundedValues[r.entry.id] !== undefined ? roundedValues[r.entry.id] : ''}
                                onChange={(evt) => {
                                  const valStr = evt.target.value;
                                  const entryId = r.entry!.id;
                                  setRoundedValues((prev) => {
                                    const next = { ...prev };
                                    if (valStr === '') {
                                      delete next[entryId];
                                    } else {
                                      next[entryId] = Number(valStr);
                                    }
                                    localStorage.setItem('hamali_rounded_values', JSON.stringify(next));
                                    return next;
                                  });
                                }}
                              />
                              <Popover>
                                <PopoverTrigger asChild>
                                  <Button variant="outline" size="sm" className="h-8 px-2 text-xs gap-1 shrink-0">
                                    <Calculator className="h-3.5 w-3.5 text-primary" />
                                    Round Off
                                  </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-64 p-3" align="end">
                                  <div className="text-xs font-semibold mb-2 text-muted-foreground flex items-center justify-between border-b pb-1.5">
                                    <span>Round Off Options</span>
                                    <span className="font-mono text-[11px] text-primary">{rupees(r.entry.crew)}</span>
                                  </div>
                                  <div className="space-y-1">
                                    {getRoundOptions(r.entry.crew).map((opt) => (
                                      <PopoverClose asChild key={opt.label}>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="w-full justify-between h-8 text-xs font-normal hover:bg-primary/10"
                                          onClick={() => {
                                            const entryId = r.entry!.id;
                                            setRoundedValues((prev) => {
                                              const next = { ...prev, [entryId]: opt.value };
                                              localStorage.setItem('hamali_rounded_values', JSON.stringify(next));
                                              return next;
                                            });
                                          }}
                                        >
                                          <span className="font-semibold text-primary">{rupees(opt.value)}</span>
                                          <span className="text-[10px] text-muted-foreground">{opt.label}</span>
                                        </Button>
                                      </PopoverClose>
                                    ))}
                                    {roundedValues[r.entry.id] !== undefined && (
                                      <PopoverClose asChild>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="w-full justify-center h-7 text-[11px] text-destructive hover:text-destructive hover:bg-destructive/10 border-t mt-1 pt-1"
                                          onClick={() => {
                                            const entryId = r.entry!.id;
                                            setRoundedValues((prev) => {
                                              const next = { ...prev };
                                              delete next[entryId];
                                              localStorage.setItem('hamali_rounded_values', JSON.stringify(next));
                                              return next;
                                            });
                                          }}
                                        >
                                          <RotateCcw className="h-3 w-3 mr-1" /> Reset to Original ({rupees(r.entry.crew)})
                                        </Button>
                                      </PopoverClose>
                                    )}
                                  </div>
                                </PopoverContent>
                              </Popover>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                      )}
                      {view === 'company' && <TableCell className="text-right font-semibold text-emerald-600 dark:text-emerald-400">{r.pl != null ? rupees(r.pl) : '-'}</TableCell>}
                      {view === 'hamali' && (
                        <TableCell>
                          {isVerified(r.date) ? (
                            <Badge variant="secondary" className="text-[10px] gap-1"><Lock className="h-3 w-3" /> Verified</Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px]">Current</Badge>
                          )}
                        </TableCell>
                      )}
                      <TableCell className="text-right">
                        {r.kind === 'MANUAL' && r.manual && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => { if (confirm('Remove this charge and reverse its ledger posting?')) deleteManual.mutate(r.manual!.id); }}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
          </div>
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
