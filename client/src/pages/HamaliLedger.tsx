import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import type { Purchase, SaleOrder, HamaliRate, StockTransfer, ShellTransfer, ManualHamaliCost, ManualHamaliType, HamaliVerification, CompanyProfile } from '@/lib/types';
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
import { Loader2, Coins, TrendingUp, Truck, Plus, Trash2, ShieldCheck, Lock, CheckCircle2 } from 'lucide-react';

// Manual hamali charge categories the crew is paid for but that can't be derived
// from purchases/sales. Per-bag types compute amount = bags × rate; flat types
// take a direct amount. Default per-bag rates match the mill's standard charges.
const MANUAL_TYPES: { value: ManualHamaliType; label: string; perBag: boolean; defaultRate?: number }[] = [
  { value: 'BAG_CUTTING_NORMAL', label: 'Bag Cutting (Place A)', perBag: true, defaultRate: 3 },
  { value: 'BAG_CUTTING_DISTANCE', label: 'Bag Cutting (Place B)', perBag: true, defaultRate: 6 },
  { value: 'PAPPU_NET', label: 'Pappu Net', perBag: true, defaultRate: 6 },
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

export default function HamaliLedger() {
  const [view, setView] = useState<'company' | 'hamali'>('company');
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

  // Square-off (reconciliation checkpoint) state
  const [squareDate, setSquareDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [squareNote, setSquareNote] = useState('');

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
    mutationFn: (body: { asOfDate: string; crewTotal: number; note: string | null }) =>
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

  const manualValid = mMeta.perBag ? Number(mBags) > 0 && Number(mRate) > 0 : Number(mAmount) > 0;

  const isLoading = loadingPurchases || loadingSales || loadingStockTransfers || loadingShellTransfers || loadingHuskTransfers;

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

  // Crew payable across the currently filtered rows (Hamali view metric).
  const totalCrew = filtered.reduce((acc, e) => acc + e.crew, 0);

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
            ]}
          />
          <Button onClick={() => { resetRecord(); setRecordOpen(true); }}>
            <Plus className="h-4 w-4" /> Record
          </Button>
        </div>
      </div>

      {/* Filters Bar */}
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

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <div className="grid gap-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                  <p className="text-[10px] text-muted-foreground mt-1">Crew share across the filtered rows</p>
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
          </div>

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
                  onClick={() => createVerification.mutate({ asOfDate: squareDate, crewTotal: pendingCrewTotal, note: squareNote || null })}
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

          {/* Ledger Table */}
          <div className="rounded-lg border bg-card overflow-x-auto">
            <div className="px-5 py-4 border-b font-semibold text-sm">Hamali Disbursements</div>
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
                  filtered.map((e) => (
                    <TableRow key={e.id} className={view === 'hamali' && isVerified(e.date) ? 'bg-muted/20' : undefined}>
                      <TableCell>{shortDate(e.date)}</TableCell>
                      <TableCell>
                        <Badge variant={e.source === 'SALE' ? 'default' : e.source === 'TRANSFER' ? 'secondary' : 'outline'} className="text-[10px]">
                          {e.label || (e.source === 'SALE' ? 'Sale Loading' : e.source === 'TRANSFER' ? 'Transfer' : 'Purchase')}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-semibold">{e.partyName}</TableCell>
                      <TableCell>{e.lorryNumber ?? '-'}</TableCell>
                      <TableCell className="font-mono text-xs">{e.reference}</TableCell>
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
    </div>
  );
}
