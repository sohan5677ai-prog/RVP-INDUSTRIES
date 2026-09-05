import { useState, useMemo, useEffect, Fragment } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import type { Purchase, SaleOrder, Payment, CompanyProfile, SaleStatus, HuskTransfer, ShellTransfer, StockTransfer, LorryConfirmation } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { calcHamali, calcKataFee, companyVehicleNumbers, findCompanyVehicle, normalizeLorryNumber, pappuLoadingHamali, qualityAdjustmentFreight } from '@/lib/calc';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, ArrowDownToLine, ArrowUpFromLine, Truck, ArrowLeftRight, MessageCircle, ChevronRight, IndianRupee, SlidersHorizontal, Plus, Trash2, RotateCcw } from 'lucide-react';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { SearchInput } from '@/components/ui/search-input';
import { usePagedRows } from '@/lib/usePagedRows';
import { ExportButtons } from '@/components/ExportButtons';
import { PageHeader } from '@/components/PageHeader';
import { ExpandPanel, PanelLabel, PanelStack, PanelCard, PanelTitle, Figure, PanelEmpty } from '@/components/ExpandPanel';
import { cn } from '@/lib/utils';
import type { ExportColumn } from '@/lib/export';
import SuryaRoadTransport from '@/pages/SuryaRoadTransport';
import LorryConfirmations from '@/pages/LorryConfirmations';
import { WhatsAppIcon } from '@/components/icons/WhatsAppIcon';
import { LorryPaymentShareDialog } from '@/components/LorryPaymentShareDialog';
import type { LorryPaymentData } from '@/lib/lorryPaymentTemplate';

type PurchaseRow = Purchase & {
  stockIn?: {
    arrivalDate?: string;
    lorryNumber?: string | null;
    invoiceNumber?: string | null;
    loadingLocation?: string | null;
    freightTonnageKg?: number | null;
    purchaseOrder?: { party?: { name?: string | null } | null } | null;
  };
};

/**
 * Inward freight owed on a purchase: the freight fixed at recording (BASE-priced
 * POs) plus any FREIGHT quality adjustment taken off the party's bill at
 * approval - that one is recovered from the supplier but still owed to the lorry.
 */
function inwardFreightOf(p: PurchaseRow): number {
  const rawFreight = Number(p.freightCharge ?? 0);
  const basis = Number((p as any).freightTonnageKg ?? p.stockIn?.freightTonnageKg ?? 0);
  const net = Number(p.netWeightKg ?? 0);
  const baseFreight = basis > 0 && net > 0 ? (rawFreight * net) / basis : rawFreight;
  return baseFreight + qualityAdjustmentFreight(p.verification?.qualityAdjustments);
}

type PaymentStatus = 'Paid' | 'Partial' | 'Pending';

export interface FreightCostItem {
  label: string;
  amount: number;
}

export interface TripCostRecord {
  id: string; // dispatch or purchase id
  sourced: 'Purchase' | 'Sale' | 'Transfer';
  lorry: string;
  invoice: string | null;
  date: string;
  party: string | null;
  destination: string | null;
  weightKg?: number;
  freight: number;
  defaultHamali: number;
  customHamali: number | null;
  defaultKata: number;
  customKata: number | null;
  defaultTransport: number;
  customRetention: number | null;
  additions: FreightCostItem[];
  deductions: FreightCostItem[];
  totalAdditions: number;
  totalOtherDeductions: number;
  net: number;
}

interface FreightRow {
  id: string;
  date: string;
  lorry: string | null;
  invoice: string | null;
  freight: number;
  hamali: number;
  defaultHamali?: number;
  customHamali?: number | null;
  kata: number;
  defaultKata?: number;
  customKata?: number | null;
  transport: number;
  defaultTransport?: number;
  customRetention?: number | null;
  additions: FreightCostItem[];
  deductions: FreightCostItem[];
  totalAdditions: number;
  totalOtherDeductions: number;
  net: number;
  deliveryStatus: string;
  sourced: 'Purchase' | 'Sale' | 'Transfer';
  destination: string | null;
  party: string | null;
  driverPhone?: string | null;
  driverName?: string | null;
  kind?: 'Husk' | 'Seed' | 'Dust';
  weightKg?: number;
  rawDispatchId?: string;
  rawPurchaseId?: string;
  rawItems?: TripCostRecord[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function combineSharedLorryRows(rows: FreightRow[]): FreightRow[] {
  const groups = new Map<string, FreightRow[]>();
  for (const r of rows) {
    if (!r.lorry) {
      const key = `nolorry-${r.id}`;
      groups.set(key, [r]);
      continue;
    }
    const dateKey = r.date ? r.date.slice(0, 10) : '';
    const key = `${r.lorry.toUpperCase()}_${dateKey}`;
    const list = groups.get(key) || [];
    list.push(r);
    groups.set(key, list);
  }

  const result: FreightRow[] = [];
  for (const list of groups.values()) {
    if (list.length === 1) {
      result.push(list[0]);
      continue;
    }
    const invoices = Array.from(new Set(list.map((x) => x.invoice).filter(Boolean))).join(', ');
    const parties = Array.from(new Set(list.map((x) => x.party).filter(Boolean))).join(', ');
    const destinations = Array.from(new Set(list.map((x) => x.destination).filter(Boolean))).join(', ');
    const sourcedSet = new Set(list.map((x) => x.sourced));
    const sourced = (sourcedSet.size === 1 ? list[0].sourced : 'Purchase / Sale') as FreightRow['sourced'];
    const kind = Array.from(new Set(list.map((x) => x.kind).filter(Boolean))).join(', ') as any;

    const totalFreight = round2(list.reduce((s, x) => s + x.freight, 0));
    const totalHamali = round2(list.reduce((s, x) => s + x.hamali, 0));
    const totalKata = round2(list.reduce((s, x) => s + x.kata, 0));
    const totalTransport = round2(list.reduce((s, x) => s + x.transport, 0));
    const allAdditions = list.flatMap((x) => x.additions);
    const allDeductions = list.flatMap((x) => x.deductions);
    const totalAdditions = round2(list.reduce((s, x) => s + (x.totalAdditions || 0), 0));
    const totalOtherDeductions = round2(list.reduce((s, x) => s + (x.totalOtherDeductions || 0), 0));
    const totalNet = round2(list.reduce((s, x) => s + x.net, 0));
    const totalWeight = list.reduce((s, x) => s + (x.weightKg ?? 0), 0);

    const isReceived = list.some((x) => x.deliveryStatus === 'RECEIVED' || x.deliveryStatus === 'DELIVERED');

    const rawItems: TripCostRecord[] = list.map((x) => ({
      id: x.rawDispatchId || x.rawPurchaseId || x.id,
      sourced: x.sourced,
      lorry: x.lorry || '',
      invoice: x.invoice,
      date: x.date,
      party: x.party,
      destination: x.destination,
      weightKg: x.weightKg,
      freight: x.freight,
      defaultHamali: x.defaultHamali ?? x.hamali,
      customHamali: x.customHamali ?? null,
      defaultKata: x.defaultKata ?? x.kata,
      customKata: x.customKata ?? null,
      defaultTransport: x.defaultTransport ?? x.transport,
      customRetention: x.customRetention ?? null,
      additions: x.additions,
      deductions: x.deductions,
      totalAdditions: x.totalAdditions,
      totalOtherDeductions: x.totalOtherDeductions,
      net: x.net,
    }));

    result.push({
      id: `comb-${list[0].lorry}-${list[0].date.slice(0, 10)}`,
      date: list[0].date,
      lorry: list[0].lorry,
      invoice: invoices || null,
      freight: totalFreight,
      hamali: totalHamali,
      kata: totalKata,
      transport: totalTransport,
      additions: allAdditions,
      deductions: allDeductions,
      totalAdditions,
      totalOtherDeductions,
      net: totalNet,
      deliveryStatus: isReceived ? 'RECEIVED' : list[0].deliveryStatus,
      sourced,
      destination: destinations || null,
      party: parties || null,
      driverPhone: list.find((x) => x.driverPhone)?.driverPhone ?? null,
      driverName: list.find((x) => x.driverName)?.driverName ?? null,
      kind: kind || undefined,
      weightKg: totalWeight || undefined,
      rawItems,
    });
  }

  return result;
}

const deliveryVariant: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  PENDING: 'secondary',
  DISPATCHED: 'default',
  REACHED: 'outline',
  DELIVERED: 'destructive',
  RECEIVED: 'destructive',
};

function titleCase(s: string) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

type PayFilterValue = 'all' | 'unpaid' | 'paid';

/** Narrow rows to a paid/unpaid subset using the shared per-lorry status. */
function filterByPayment(
  rows: FreightRow[],
  filter: PayFilterValue,
  statusFor: (row: FreightRow) => PaymentStatus,
): FreightRow[] {
  if (filter === 'all') return rows;
  return rows.filter((r) => {
    const paid = statusFor(r) === 'Paid';
    return filter === 'paid' ? paid : !paid; // "unpaid" = Pending or Partial
  });
}

/** Small segmented All / Unpaid / Paid toggle shown above each freight table. */
function PayFilter({ value, onChange }: { value: PayFilterValue; onChange: (v: PayFilterValue) => void }) {
  const opts: { key: PayFilterValue; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'unpaid', label: 'Unpaid' },
    { key: 'paid', label: 'Paid' },
  ];
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5">
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            value === o.key
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const PRESET_ADDITIONS = [
  'Halting Charges',
  'Detention Fee',
  'Multi-point Drop',
  'Driver Incentive',
  'Extra Loading',
  'Extra Freight Adjustment',
];

const PRESET_DEDUCTIONS = [
  'Diesel Advance',
  'Driver Expense / Advance',
  'TDS / Tax',
  'Toll / RTO Charges',
  'Shortage / Weight Penalty',
  'Unloading Fee',
  'Damages / Claim',
  'Brokerage Deduction',
];

function AdjustFreightCostsDialog({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: FreightRow | null;
}) {
  const qc = useQueryClient();

  const trips: TripCostRecord[] = useMemo(() => {
    if (!target) return [];
    if (target.rawItems && target.rawItems.length > 0) {
      return target.rawItems;
    }
    return [
      {
        id: target.rawDispatchId || target.rawPurchaseId || target.id,
        sourced: target.sourced,
        lorry: target.lorry || '',
        invoice: target.invoice,
        date: target.date,
        party: target.party,
        destination: target.destination,
        weightKg: target.weightKg,
        freight: target.freight,
        defaultHamali: target.defaultHamali ?? target.hamali,
        customHamali: target.customHamali ?? null,
        defaultKata: target.defaultKata ?? target.kata,
        customKata: target.customKata ?? null,
        defaultTransport: target.defaultTransport ?? target.transport,
        customRetention: target.customRetention ?? null,
        additions: target.additions || [],
        deductions: target.deductions || [],
        totalAdditions: target.totalAdditions || 0,
        totalOtherDeductions: target.totalOtherDeductions || 0,
        net: target.net,
      },
    ];
  }, [target]);

  const [activeTripIdx, setActiveTripIdx] = useState(0);
  const activeTrip = trips[activeTripIdx] || trips[0];

  const [freightCharge, setFreightCharge] = useState('');
  const [customHamali, setCustomHamali] = useState('');
  const [useCustomHamali, setUseCustomHamali] = useState(false);
  const [customKata, setCustomKata] = useState('');
  const [useCustomKata, setUseCustomKata] = useState(false);
  const [customRetention, setCustomRetention] = useState('');
  const [useCustomRetention, setUseCustomRetention] = useState(false);
  const [additions, setAdditions] = useState<{ id: string; label: string; amount: string }[]>([]);
  const [deductions, setDeductions] = useState<{ id: string; label: string; amount: string }[]>([]);

  useEffect(() => {
    if (!activeTrip || !open) return;
    setFreightCharge(String(activeTrip.freight || 0));
    setUseCustomHamali(activeTrip.customHamali != null);
    setCustomHamali(activeTrip.customHamali != null ? String(activeTrip.customHamali) : '');
    setUseCustomKata(activeTrip.customKata != null);
    setCustomKata(activeTrip.customKata != null ? String(activeTrip.customKata) : '');
    setUseCustomRetention(activeTrip.customRetention != null);
    setCustomRetention(activeTrip.customRetention != null ? String(activeTrip.customRetention) : '');
    setAdditions((activeTrip.additions || []).map((a, i) => ({ id: `add-${i}-${Date.now()}`, label: a.label, amount: String(a.amount) })));
    setDeductions((activeTrip.deductions || []).map((d, i) => ({ id: `ded-${i}-${Date.now()}`, label: d.label, amount: String(d.amount) })));
  }, [activeTrip, open]);

  useEffect(() => {
    setActiveTripIdx(0);
  }, [target]);

  const calcGross = Number(freightCharge) || 0;
  const calcHamaliVal = useCustomHamali ? (customHamali.trim() !== '' ? Number(customHamali) || 0 : 0) : (activeTrip?.defaultHamali || 0);
  const calcKataVal = useCustomKata ? (customKata.trim() !== '' ? Number(customKata) || 0 : 0) : (activeTrip?.defaultKata || 0);
  const calcRetentionVal = useCustomRetention ? (customRetention.trim() !== '' ? Number(customRetention) || 0 : 0) : (activeTrip?.defaultTransport || 0);
  const calcAdditionsTotal = additions.reduce((s, a) => s + (Number(a.amount) || 0), 0);
  const calcDeductionsTotal = deductions.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const calcStandardDeductions = calcHamaliVal + calcKataVal + calcRetentionVal;
  const calcNet = round2(calcGross + calcAdditionsTotal - (calcStandardDeductions + calcDeductionsTotal));

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!activeTrip) throw new Error('No trip selected');
      const payload = {
        freightCharge: calcGross,
        customHamali: useCustomHamali ? (customHamali.trim() !== '' ? Number(customHamali) : null) : null,
        customKata: useCustomKata ? (customKata.trim() !== '' ? Number(customKata) : null) : null,
        customRetention: useCustomRetention ? (customRetention.trim() !== '' ? Number(customRetention) : null) : null,
        freightAdditions: additions.filter((a) => a.label.trim() && Number(a.amount) > 0).map((a) => ({ label: a.label.trim(), amount: Number(a.amount) })),
        freightDeductions: deductions.filter((d) => d.label.trim() && Number(d.amount) > 0).map((d) => ({ label: d.label.trim(), amount: Number(d.amount) })),
      };

      if (activeTrip.sourced === 'Sale') {
        return api(`/sale-dispatches/${activeTrip.id}/freight-costs`, { method: 'PATCH', body: payload });
      } else if (activeTrip.sourced === 'Purchase') {
        return api(`/purchases/${activeTrip.id}/freight-costs`, { method: 'PATCH', body: payload });
      }
      throw new Error('Cost adjustment only supported for Sale dispatches and Purchases.');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      qc.invalidateQueries({ queryKey: ['purchases'] });
      qc.invalidateQueries({ queryKey: ['pappu-margins'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('Freight costs and deductions updated');
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  if (!target || !activeTrip) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SlidersHorizontal className="h-5 w-5 text-primary" />
            <span>Adjust Freight Costs &amp; Deductions</span>
          </DialogTitle>
        </DialogHeader>

        {trips.length > 1 && (
          <div className="space-y-1.5 border-b pb-3">
            <Label className="text-xs text-muted-foreground">Select Trip / Invoice for {target.lorry}</Label>
            <div className="flex flex-wrap gap-2">
              {trips.map((t, idx) => (
                <Button
                  key={t.id}
                  size="sm"
                  type="button"
                  variant={activeTripIdx === idx ? 'default' : 'outline'}
                  onClick={() => setActiveTripIdx(idx)}
                  className="h-8 text-xs font-medium"
                >
                  {t.invoice || `Trip #${idx + 1}`} ({rupees(t.freight)})
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Trip Banner */}
        <div className="rounded-lg bg-muted/40 p-3 text-xs grid grid-cols-2 sm:grid-cols-4 gap-2 border">
          <div><span className="text-muted-foreground">Lorry No:</span> <strong className="block text-foreground">{activeTrip.lorry || '-'}</strong></div>
          <div><span className="text-muted-foreground">Date:</span> <strong className="block text-foreground">{shortDate(activeTrip.date)}</strong></div>
          <div><span className="text-muted-foreground">Invoice:</span> <strong className="block text-foreground">{activeTrip.invoice || '-'}</strong></div>
          <div><span className="text-muted-foreground">Party:</span> <strong className="block text-foreground truncate">{activeTrip.party || '-'}</strong></div>
          {activeTrip.weightKg != null && (
            <div><span className="text-muted-foreground">Weight:</span> <strong className="block text-foreground">{(activeTrip.weightKg / 1000).toFixed(2)} t</strong></div>
          )}
          {activeTrip.destination && (
            <div className="col-span-2"><span className="text-muted-foreground">Destination:</span> <strong className="block text-foreground truncate">{activeTrip.destination}</strong></div>
          )}
        </div>

        <div className="space-y-5 py-2">
          {/* Gross Freight */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="freight-gross" className="text-sm font-semibold">
                Gross {activeTrip.sourced === 'Purchase' ? 'Inward' : 'Outward'} Freight (₹)
              </Label>
              <span className="text-xs text-muted-foreground">Agreed trip freight before deductions</span>
            </div>
            <div className="relative">
              <span className="absolute left-3 top-2.5 text-muted-foreground font-semibold">₹</span>
              <Input
                id="freight-gross"
                type="number"
                step="0.01"
                value={freightCharge}
                onChange={(e) => setFreightCharge(e.target.value)}
                placeholder="e.g. 56000"
                className="pl-7 font-mono font-medium"
              />
            </div>
          </div>

          {/* Standard Trip Deductions */}
          <div className="space-y-3 rounded-lg border p-3.5 bg-card/60">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <span>Standard Trip Deductions</span>
              </div>
              <span className="text-xs text-muted-foreground">Default calculated amounts can be customized</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* Hamali */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium">Hamali</Label>
                  {useCustomHamali && (
                    <button
                      type="button"
                      onClick={() => { setUseCustomHamali(false); setCustomHamali(''); }}
                      className="text-[10px] text-primary hover:underline flex items-center gap-0.5"
                    >
                      <RotateCcw className="h-2.5 w-2.5" /> Reset ({rupees(activeTrip.defaultHamali)})
                    </button>
                  )}
                </div>
                <div className="relative">
                  <span className="absolute left-2.5 top-2 text-xs text-muted-foreground">₹</span>
                  <Input
                    type="number"
                    step="0.01"
                    value={useCustomHamali ? customHamali : activeTrip.defaultHamali}
                    onChange={(e) => {
                      setUseCustomHamali(true);
                      setCustomHamali(e.target.value);
                    }}
                    placeholder={String(activeTrip.defaultHamali)}
                    className={cn('h-8 pl-6 text-xs font-mono', useCustomHamali ? 'border-primary font-bold' : 'text-muted-foreground')}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground block">
                  {useCustomHamali ? 'Custom overridden' : `Default: ${rupees(activeTrip.defaultHamali)}`}
                </span>
              </div>

              {/* Kata Fee */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium">Kata Fee</Label>
                  {useCustomKata && (
                    <button
                      type="button"
                      onClick={() => { setUseCustomKata(false); setCustomKata(''); }}
                      className="text-[10px] text-primary hover:underline flex items-center gap-0.5"
                    >
                      <RotateCcw className="h-2.5 w-2.5" /> Reset ({rupees(activeTrip.defaultKata)})
                    </button>
                  )}
                </div>
                <div className="relative">
                  <span className="absolute left-2.5 top-2 text-xs text-muted-foreground">₹</span>
                  <Input
                    type="number"
                    step="0.01"
                    value={useCustomKata ? customKata : activeTrip.defaultKata}
                    onChange={(e) => {
                      setUseCustomKata(true);
                      setCustomKata(e.target.value);
                    }}
                    placeholder={String(activeTrip.defaultKata)}
                    className={cn('h-8 pl-6 text-xs font-mono', useCustomKata ? 'border-primary font-bold' : 'text-muted-foreground')}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground block">
                  {useCustomKata ? 'Custom overridden' : `Default: ${rupees(activeTrip.defaultKata)}`}
                </span>
              </div>

              {/* Transport Retention */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium">Transport Retention</Label>
                  {useCustomRetention && (
                    <button
                      type="button"
                      onClick={() => { setUseCustomRetention(false); setCustomRetention(''); }}
                      className="text-[10px] text-primary hover:underline flex items-center gap-0.5"
                    >
                      <RotateCcw className="h-2.5 w-2.5" /> Reset ({rupees(activeTrip.defaultTransport)})
                    </button>
                  )}
                </div>
                <div className="relative">
                  <span className="absolute left-2.5 top-2 text-xs text-muted-foreground">₹</span>
                  <Input
                    type="number"
                    step="0.01"
                    value={useCustomRetention ? customRetention : activeTrip.defaultTransport}
                    onChange={(e) => {
                      setUseCustomRetention(true);
                      setCustomRetention(e.target.value);
                    }}
                    placeholder={String(activeTrip.defaultTransport)}
                    className={cn('h-8 pl-6 text-xs font-mono', useCustomRetention ? 'border-primary font-bold' : 'text-muted-foreground')}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground block">
                  {useCustomRetention ? 'Custom overridden' : `Default: ${rupees(activeTrip.defaultTransport)}`}
                </span>
              </div>
            </div>
          </div>

          {/* Extra Costs & Additions (+) */}
          <div className="space-y-3 rounded-lg border p-3.5 bg-emerald-50/30 dark:bg-emerald-950/10 border-emerald-200/50 dark:border-emerald-900/50">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                <span>Extra Costs &amp; Additions (+)</span>
              </div>
              <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                Total: +{rupees(calcAdditionsTotal)}
              </span>
            </div>

            {/* Presets */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground mr-1">Quick Add:</span>
              {PRESET_ADDITIONS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setAdditions((prev) => [...prev, { id: `add-${Date.now()}-${Math.random()}`, label: preset, amount: '' }])}
                  className="rounded-full bg-background border px-2.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:border-emerald-500 transition-colors"
                >
                  + {preset}
                </button>
              ))}
            </div>

            {additions.length === 0 ? (
              <div className="text-xs text-muted-foreground py-2 italic text-center">No extra costs added.</div>
            ) : (
              <div className="space-y-2">
                {additions.map((item, idx) => (
                  <div key={item.id} className="flex items-center gap-2">
                    <Input
                      placeholder="e.g. Halting Charges, Multi-point delivery"
                      value={item.label}
                      onChange={(e) => {
                        const next = [...additions];
                        next[idx].label = e.target.value;
                        setAdditions(next);
                      }}
                      className="h-8 text-xs flex-1 bg-background"
                    />
                    <div className="relative w-32 shrink-0">
                      <span className="absolute left-2.5 top-2 text-xs text-muted-foreground">₹</span>
                      <Input
                        type="number"
                        step="0.01"
                        placeholder="Amount"
                        value={item.amount}
                        onChange={(e) => {
                          const next = [...additions];
                          next[idx].amount = e.target.value;
                          setAdditions(next);
                        }}
                        className="h-8 pl-6 text-xs font-mono bg-background text-right"
                      />
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      onClick={() => setAdditions(additions.filter((_, i) => i !== idx))}
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => setAdditions((prev) => [...prev, { id: `add-${Date.now()}`, label: '', amount: '' }])}
              className="h-7 text-xs gap-1 border-dashed"
            >
              <Plus className="h-3 w-3" /> Add Extra Cost
            </Button>
          </div>

          {/* Other Deductions & Expenses (−) */}
          <div className="space-y-3 rounded-lg border p-3.5 bg-amber-50/30 dark:bg-amber-950/10 border-amber-200/50 dark:border-amber-900/50">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                <Trash2 className="h-3.5 w-3.5" />
                <span>Other Deductions &amp; Expenses (−)</span>
              </div>
              <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                Total: −{rupees(calcDeductionsTotal)}
              </span>
            </div>

            {/* Presets */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground mr-1">Quick Add:</span>
              {PRESET_DEDUCTIONS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setDeductions((prev) => [...prev, { id: `ded-${Date.now()}-${Math.random()}`, label: preset, amount: '' }])}
                  className="rounded-full bg-background border px-2.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:border-amber-500 transition-colors"
                >
                  + {preset}
                </button>
              ))}
            </div>

            {deductions.length === 0 ? (
              <div className="text-xs text-muted-foreground py-2 italic text-center">No other expense deductions added.</div>
            ) : (
              <div className="space-y-2">
                {deductions.map((item, idx) => (
                  <div key={item.id} className="flex items-center gap-2">
                    <Input
                      placeholder="e.g. Diesel Advance, Driver Expense, TDS"
                      value={item.label}
                      onChange={(e) => {
                        const next = [...deductions];
                        next[idx].label = e.target.value;
                        setDeductions(next);
                      }}
                      className="h-8 text-xs flex-1 bg-background"
                    />
                    <div className="relative w-32 shrink-0">
                      <span className="absolute left-2.5 top-2 text-xs text-muted-foreground">₹</span>
                      <Input
                        type="number"
                        step="0.01"
                        placeholder="Amount"
                        value={item.amount}
                        onChange={(e) => {
                          const next = [...deductions];
                          next[idx].amount = e.target.value;
                          setDeductions(next);
                        }}
                        className="h-8 pl-6 text-xs font-mono bg-background text-right"
                      />
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      onClick={() => setDeductions(deductions.filter((_, i) => i !== idx))}
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => setDeductions((prev) => [...prev, { id: `ded-${Date.now()}`, label: '', amount: '' }])}
              className="h-7 text-xs gap-1 border-dashed"
            >
              <Plus className="h-3 w-3" /> Add Deduction / Expense
            </Button>
          </div>

          {/* Live Calculation Summary */}
          <div className="rounded-lg border bg-muted/50 p-4 space-y-2 text-xs">
            <div className="font-semibold text-foreground border-b pb-1.5 flex items-center justify-between">
              <span>Freight Calculation Breakdown</span>
              <span className="font-mono text-sm font-bold text-primary">{rupees(calcNet)}</span>
            </div>
            <div className="space-y-1 text-muted-foreground">
              <div className="flex justify-between">
                <span>Gross Freight</span>
                <span className="font-mono text-foreground font-medium">{rupees(calcGross)}</span>
              </div>
              <div className="flex justify-between text-amber-600 dark:text-amber-400">
                <span>Standard Deductions (Hamali {rupees(calcHamaliVal)} + Kata {rupees(calcKataVal)} + Transport {rupees(calcRetentionVal)})</span>
                <span className="font-mono">−{rupees(calcStandardDeductions)}</span>
              </div>
              {calcAdditionsTotal > 0 && (
                <div className="flex justify-between text-emerald-600 dark:text-emerald-400 font-medium">
                  <span>Extra Costs &amp; Additions ({additions.filter((a) => Number(a.amount) > 0).length} item{additions.filter((a) => Number(a.amount) > 0).length > 1 ? 's' : ''})</span>
                  <span className="font-mono">+{rupees(calcAdditionsTotal)}</span>
                </div>
              )}
              {calcDeductionsTotal > 0 && (
                <div className="flex justify-between text-amber-600 dark:text-amber-400 font-medium">
                  <span>Other Deductions &amp; Expenses ({deductions.filter((d) => Number(d.amount) > 0).length} item{deductions.filter((d) => Number(d.amount) > 0).length > 1 ? 's' : ''})</span>
                  <span className="font-mono">−{rupees(calcDeductionsTotal)}</span>
                </div>
              )}
              <div className="flex justify-between border-t pt-2 font-bold text-foreground text-sm">
                <span>Net Lorry Freight Payable</span>
                <span className="font-mono text-primary">{rupees(calcNet)}</span>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? 'Saving…' : 'Save Freight Costs'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FreightTable({
  freightLabel,
  exportName,
  rows,
  paymentStatusFor,
  dueFor,
  onPay,
  onAdjust,
  onShareReceipt,
  hideDeductions = false,
  paymentsByLorry,
}: {
  freightLabel: string;
  exportName: string;
  rows: FreightRow[];
  paymentStatusFor: (row: FreightRow) => PaymentStatus;
  dueFor: (row: FreightRow) => number;
  onPay: (row: FreightRow, due: number) => void;
  onAdjust: (row: FreightRow) => void;
  onShareReceipt?: (row: FreightRow) => void;
  hideDeductions?: boolean;
  paymentsByLorry: Map<string, { date: string, amount: number, reference: string | null }[]>;
}) {
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [payFilter, setPayFilter] = useState<PayFilterValue>('all');
  const [search, setSearch] = useState('');

  const filteredRows = useMemo(() => {
    const payFiltered = filterByPayment(rows, payFilter, paymentStatusFor);
    const q = search.trim().toLowerCase();
    if (!q) return payFiltered;
    const qNorm = q.replace(/[^a-z0-9]/g, '');
    return payFiltered.filter((r) => {
      const matchLorry = (r.lorry ?? '').toLowerCase().includes(q) || (qNorm !== '' && (r.lorry ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(qNorm));
      const matchInvoice = (r.invoice ?? '').toLowerCase().includes(q) || (qNorm !== '' && (r.invoice ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(qNorm));
      const matchParty = (r.party ?? '').toLowerCase().includes(q);
      const matchDest = (r.destination ?? '').toLowerCase().includes(q);
      const matchStatus = r.deliveryStatus.toLowerCase().includes(q);
      const matchPayment = paymentStatusFor(r).toLowerCase().includes(q);
      const matchSourced = r.sourced.toLowerCase().includes(q);
      return matchLorry || matchInvoice || matchParty || matchDest || matchStatus || matchPayment || matchSourced;
    });
  }, [rows, payFilter, paymentStatusFor, search]);

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows } = usePagedRows(filteredRows, 50);

  const t = {
    freight: filteredRows.reduce((s, r) => s + r.freight, 0),
    hamali: filteredRows.reduce((s, r) => s + r.hamali, 0),
    kata: filteredRows.reduce((s, r) => s + r.kata, 0),
    transport: filteredRows.reduce((s, r) => s + r.transport, 0),
    otherDeductions: filteredRows.reduce((s, r) => s + (r.totalOtherDeductions || 0), 0),
    additions: filteredRows.reduce((s, r) => s + (r.totalAdditions || 0), 0),
    net: filteredRows.reduce((s, r) => s + r.net, 0),
    due: filteredRows.reduce((s, r) => s + dueFor(r), 0),
  };

  const hasAnyCustomCosts = useMemo(() => {
    return rows.some((r) => (r.totalOtherDeductions > 0) || (r.totalAdditions > 0));
  }, [rows]);

  const exportColumns: ExportColumn<FreightRow>[] = [
    { header: 'Date', value: (r) => shortDate(r.date) },
    { header: 'Lorry No', value: (r) => r.lorry ?? '' },
    { header: 'Invoice No', value: (r) => r.invoice ?? '' },
    ...(hideDeductions ? [
      { header: 'Sourced', value: (r: FreightRow) => r.sourced },
      { header: 'Destination', value: (r: FreightRow) => r.destination ?? '' },
      { header: 'Party', value: (r: FreightRow) => r.party ?? '' },
    ] : []),
    { header: freightLabel, value: (r) => rupees(r.freight), excel: (r) => r.freight, numFmt: '#,##0.00', align: 'right' },
    ...(hideDeductions ? [] : [
      { header: 'Hamali', value: (r: FreightRow) => (r.hamali ? rupees(r.hamali) : ''), excel: (r: FreightRow) => r.hamali || null, numFmt: '#,##0.00', align: 'right' as const },
      { header: 'Kata', value: (r: FreightRow) => (r.kata ? rupees(r.kata) : ''), excel: (r: FreightRow) => r.kata || null, numFmt: '#,##0.00', align: 'right' as const },
      { header: 'Transport', value: (r: FreightRow) => (r.transport ? rupees(r.transport) : ''), excel: (r: FreightRow) => r.transport || null, numFmt: '#,##0.00', align: 'right' as const },
      { header: 'Other Deductions', value: (r: FreightRow) => (r.totalOtherDeductions ? rupees(r.totalOtherDeductions) : ''), excel: (r: FreightRow) => r.totalOtherDeductions || null, numFmt: '#,##0.00', align: 'right' as const },
      { header: 'Extra Costs', value: (r: FreightRow) => (r.totalAdditions ? rupees(r.totalAdditions) : ''), excel: (r: FreightRow) => r.totalAdditions || null, numFmt: '#,##0.00', align: 'right' as const },
    ]),
    { header: 'Net Freight', value: (r) => rupees(r.net), excel: (r) => r.net, numFmt: '#,##0.00', align: 'right' },
    { header: 'Due', value: (r) => rupees(dueFor(r)), excel: (r) => dueFor(r), numFmt: '#,##0.00', align: 'right' },
    { header: 'Delivery Status', value: (r) => titleCase(r.deliveryStatus) },
    { header: 'Payment Status', value: (r) => paymentStatusFor(r) },
  ];

  const colSpanCount = hideDeductions ? 10 : (hasAnyCustomCosts ? 14 : 12);

  return (
    <div className="rounded-lg border bg-card overflow-x-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 border-b">
        <div className="flex flex-wrap items-center gap-3">
          <PayFilter value={payFilter} onChange={setPayFilter} />
          <SearchInput
            value={search}
            onValueChange={setSearch}
            placeholder="Search lorry no, invoice, party, destination…"
            containerClassName="w-full sm:w-72"
            className="h-8 text-xs"
          />
        </div>
        <ExportButtons filename={exportName} title={`${freightLabel} Dues`} subtitle={`${filteredRows.length} record(s)`} columns={exportColumns} rows={filteredRows} />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Lorry No</TableHead>
            <TableHead>Invoice No</TableHead>
            {hideDeductions && <TableHead>Sourced</TableHead>}
            {hideDeductions && <TableHead>Destination</TableHead>}
            {hideDeductions && <TableHead>Party</TableHead>}
            <TableHead className="text-right">{freightLabel}</TableHead>
            {!hideDeductions && <TableHead className="text-right">Hamali</TableHead>}
            {!hideDeductions && <TableHead className="text-right">Kata</TableHead>}
            {!hideDeductions && <TableHead className="text-right">Transport</TableHead>}
            {!hideDeductions && hasAnyCustomCosts && <TableHead className="text-right">Other Ded.</TableHead>}
            {!hideDeductions && hasAnyCustomCosts && <TableHead className="text-right">Extra Costs</TableHead>}
            <TableHead className="text-right">Net Freight</TableHead>
            <TableHead className="text-right">Due</TableHead>
            <TableHead>Delivery Status</TableHead>
            <TableHead>Payment Status</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredRows.length === 0 && (
            <TableRow><TableCell colSpan={colSpanCount} className="text-center text-muted-foreground py-8">No records.</TableCell></TableRow>
          )}
          {(pageRows ?? []).map((r) => {
            const pay = paymentStatusFor(r);
            const due = dueFor(r);
            const isExpanded = expandedRow === r.lorry;
            const canAdjust = r.sourced === 'Sale' || r.sourced === 'Purchase' || (r.rawItems && r.rawItems.length > 0);

            return (
              <Fragment key={r.id}>
                <TableRow
                  className={cn('transition-colors', r.lorry ? cn('cursor-pointer', isExpanded ? 'bg-accent/40' : 'hover:bg-accent/30') : 'hover:bg-muted/50')}
                  onClick={() => r.lorry && setExpandedRow(isExpanded ? null : r.lorry)}
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {r.lorry && <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200', isExpanded && 'rotate-90 text-primary')} />}
                      {shortDate(r.date)}
                    </div>
                  </TableCell>
                  <TableCell className="font-sans text-xs font-medium text-foreground/80">{r.lorry ?? '-'}</TableCell>
                  <TableCell className="font-sans text-xs font-medium text-muted-foreground">{r.invoice ?? '-'}</TableCell>
                  {hideDeductions && <TableCell>{r.sourced}</TableCell>}
                  {hideDeductions && <TableCell>{r.destination ?? '-'}</TableCell>}
                  {hideDeductions && <TableCell>{r.party ?? '-'}</TableCell>}
                  <TableCell className="text-right font-medium">{rupees(r.freight)}</TableCell>
                  {!hideDeductions && (
                    <TableCell className="text-right text-amber-600 dark:text-amber-400">
                      {r.hamali ? (
                        <span>
                          −{rupees(r.hamali)}
                          {r.customHamali != null && <span className="text-[10px] text-primary ml-1" title="Custom Hamali override">*</span>}
                        </span>
                      ) : '-'}
                    </TableCell>
                  )}
                  {!hideDeductions && (
                    <TableCell className="text-right text-amber-600 dark:text-amber-400">
                      {r.kata ? (
                        <span>
                          −{rupees(r.kata)}
                          {r.customKata != null && <span className="text-[10px] text-primary ml-1" title="Custom Kata override">*</span>}
                        </span>
                      ) : '-'}
                    </TableCell>
                  )}
                  {!hideDeductions && (
                    <TableCell className="text-right text-amber-600 dark:text-amber-400">
                      {r.transport ? (
                        <span>
                          −{rupees(r.transport)}
                          {r.customRetention != null && <span className="text-[10px] text-primary ml-1" title="Custom Retention override">*</span>}
                        </span>
                      ) : '-'}
                    </TableCell>
                  )}
                  {!hideDeductions && hasAnyCustomCosts && (
                    <TableCell className="text-right text-amber-600 dark:text-amber-400 font-medium">
                      {r.totalOtherDeductions > 0 ? (
                        <span title={r.deductions.map(d => `${d.label}: ₹${d.amount}`).join(', ')}>
                          −{rupees(r.totalOtherDeductions)}
                        </span>
                      ) : '-'}
                    </TableCell>
                  )}
                  {!hideDeductions && hasAnyCustomCosts && (
                    <TableCell className="text-right text-emerald-600 dark:text-emerald-400 font-medium">
                      {r.totalAdditions > 0 ? (
                        <span title={r.additions.map(a => `${a.label}: ₹${a.amount}`).join(', ')}>
                          +{rupees(r.totalAdditions)}
                        </span>
                      ) : '-'}
                    </TableCell>
                  )}
                  <TableCell className="text-right font-medium">{rupees(r.net)}</TableCell>
                  <TableCell className={cn('text-right font-mono tabular-nums', due === 0 ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-rose-600 dark:text-rose-400 font-bold')}>
                    {rupees(due)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={deliveryVariant[r.deliveryStatus] ?? 'secondary'}>{titleCase(r.deliveryStatus)}</Badge>
                  </TableCell>
                  <TableCell>
                    <span
                      className={`text-xs font-semibold ${
                        pay === 'Paid'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : pay === 'Partial'
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-rose-600 dark:text-rose-400'
                      }`}
                    >
                      {pay}
                    </span>
                  </TableCell>
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="inline-flex items-center justify-end gap-1.5">
                      {r.lorry && onShareReceipt && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs gap-1 text-emerald-600 dark:text-emerald-400 border-emerald-600/30 hover:bg-emerald-50 dark:hover:bg-emerald-950/50"
                          onClick={() => onShareReceipt(r)}
                          title="Share Lorry Payment Receipt via WhatsApp (English / Telugu / Hindi / Tamil)"
                        >
                          <WhatsAppIcon className="h-3 w-3 fill-emerald-600 dark:fill-emerald-400" />
                          <span className="hidden sm:inline">Receipt</span>
                        </Button>
                      )}
                      {canAdjust && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs gap-1"
                          onClick={() => onAdjust(r)}
                          title="Adjust Freight Costs &amp; Deductions"
                        >
                          <SlidersHorizontal className="h-3 w-3" />
                          <span className="hidden sm:inline">Costs</span>
                        </Button>
                      )}
                      {r.lorry && pay !== 'Paid' ? (
                        <Button size="sm" variant="default" className="h-7 px-2.5 text-xs" onClick={() => onPay(r, due)}>
                          Pay
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
                {isExpanded && r.lorry && (() => {
                  const history = paymentsByLorry.get(r.lorry!) ?? [];
                  return (
                    <ExpandPanel colSpan={colSpanCount}>
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {/* Freight Cost & Deductions Breakdown */}
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <PanelLabel>Freight Cost &amp; Deduction Breakdown</PanelLabel>
                            <div className="flex items-center gap-1.5">
                              {onShareReceipt && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 px-2 text-[11px] gap-1 text-emerald-600 dark:text-emerald-400 border-emerald-600/30 hover:bg-emerald-50 dark:hover:bg-emerald-950/50"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onShareReceipt(r);
                                  }}
                                  title="Share Lorry Payment Receipt (EN/TE/HI/TA)"
                                >
                                  <WhatsAppIcon className="h-2.5 w-2.5 fill-emerald-600 dark:fill-emerald-400" /> Receipt
                                </Button>
                              )}
                              {canAdjust && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 px-2 text-[11px] gap-1"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onAdjust(r);
                                  }}
                                >
                                  <SlidersHorizontal className="h-3 w-3" /> Adjust Costs
                                </Button>
                              )}
                            </div>
                          </div>
                          <div className="rounded-lg border bg-card p-3 space-y-2 text-xs">
                            <div className="grid grid-cols-2 gap-2 pb-2 border-b">
                              <div>
                                <span className="text-muted-foreground block text-[11px]">Gross Freight:</span>
                                <strong className="font-mono text-foreground font-semibold">{rupees(r.freight)}</strong>
                              </div>
                              <div>
                                <span className="text-muted-foreground block text-[11px]">Net Payable:</span>
                                <strong className="font-mono text-primary font-bold">{rupees(r.net)}</strong>
                              </div>
                            </div>

                            <div className="space-y-1 text-muted-foreground">
                              <div className="flex justify-between">
                                <span>Hamali Deducted:</span>
                                <span className="font-mono text-amber-600 dark:text-amber-400">
                                  {r.hamali ? `−${rupees(r.hamali)}` : '₹0.00'}
                                  {r.customHamali != null && <Badge variant="outline" className="ml-1 text-[9px] py-0 h-4">custom</Badge>}
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span>Kata Fee Deducted:</span>
                                <span className="font-mono text-amber-600 dark:text-amber-400">
                                  {r.kata ? `−${rupees(r.kata)}` : '₹0.00'}
                                  {r.customKata != null && <Badge variant="outline" className="ml-1 text-[9px] py-0 h-4">custom</Badge>}
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span>Transport Retention:</span>
                                <span className="font-mono text-amber-600 dark:text-amber-400">
                                  {r.transport ? `−${rupees(r.transport)}` : '₹0.00'}
                                  {r.customRetention != null && <Badge variant="outline" className="ml-1 text-[9px] py-0 h-4">custom</Badge>}
                                </span>
                              </div>

                              {r.additions && r.additions.length > 0 && (
                                <div className="pt-1.5 border-t space-y-1">
                                  <span className="font-medium text-emerald-700 dark:text-emerald-400 block text-[11px]">
                                    Extra Costs &amp; Additions (+):
                                  </span>
                                  {r.additions.map((a, idx) => (
                                    <div key={idx} className="flex justify-between pl-2 text-emerald-600 dark:text-emerald-400 font-medium">
                                      <span>• {a.label}</span>
                                      <span className="font-mono">+{rupees(Number(a.amount) || 0)}</span>
                                    </div>
                                  ))}
                                </div>
                              )}

                              {r.deductions && r.deductions.length > 0 && (
                                <div className="pt-1.5 border-t space-y-1">
                                  <span className="font-medium text-amber-700 dark:text-amber-400 block text-[11px]">
                                    Other Deductions &amp; Expenses (−):
                                  </span>
                                  {r.deductions.map((d, idx) => (
                                    <div key={idx} className="flex justify-between pl-2 text-amber-600 dark:text-amber-400 font-medium">
                                      <span>• {d.label}</span>
                                      <span className="font-mono">−{rupees(Number(d.amount) || 0)}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Payment History */}
                        <div className="space-y-2">
                          <PanelLabel>Payment History for {r.lorry} · {history.length}</PanelLabel>
                          {history.length === 0 ? (
                            <PanelEmpty>No payments recorded.</PanelEmpty>
                          ) : (
                            <PanelStack>
                              {history.map((pay, i) => (
                                <PanelCard
                                  key={i}
                                  icon={IndianRupee}
                                  identity={
                                    <PanelTitle>
                                      <span className="font-mono text-sm font-semibold">{shortDate(pay.date)}</span>
                                      {pay.reference && <span className="text-xs text-muted-foreground">{pay.reference}</span>}
                                    </PanelTitle>
                                  }
                                  figures={<Figure label="Amount" value={rupees(pay.amount)} valueClass="text-emerald-600 dark:text-emerald-400" />}
                                />
                              ))}
                            </PanelStack>
                          )}
                        </div>
                      </div>
                    </ExpandPanel>
                  );
                })()}
              </Fragment>
            );
          })}
        </TableBody>
        {filteredRows.length > 0 && (
          <tfoot>
            <TableRow className="border-t-2 font-bold bg-muted/30">
              <TableCell colSpan={hideDeductions ? 6 : 3}>Total</TableCell>
              <TableCell className="text-right">{rupees(t.freight)}</TableCell>
              {!hideDeductions && <TableCell className="text-right text-amber-600 dark:text-amber-400">−{rupees(t.hamali)}</TableCell>}
              {!hideDeductions && <TableCell className="text-right text-amber-600 dark:text-amber-400">−{rupees(t.kata)}</TableCell>}
              {!hideDeductions && <TableCell className="text-right text-amber-600 dark:text-amber-400">−{rupees(t.transport)}</TableCell>}
              {!hideDeductions && hasAnyCustomCosts && <TableCell className="text-right text-amber-600 dark:text-amber-400">−{rupees(t.otherDeductions)}</TableCell>}
              {!hideDeductions && hasAnyCustomCosts && <TableCell className="text-right text-emerald-600 dark:text-emerald-400">+{rupees(t.additions)}</TableCell>}
              <TableCell className="text-right">{rupees(t.net)}</TableCell>
              <TableCell className="text-right font-bold">{rupees(t.due)}</TableCell>
              <TableCell colSpan={3} />
            </TableRow>
          </tfoot>
        )}
      </Table>
      <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
    </div>
  );
}

const kindVariant: Record<string, 'default' | 'secondary' | 'outline'> = {
  Husk: 'secondary',
  Seed: 'default',
  Dust: 'outline',
};

/**
 * Transfer transport payable to KNM Transport (husk / seed / pre-cleaner dust).
 * Billed to KNM Transport per trip / weight and settled per lorry.
 */
function TransfersTable({
  rows,
  paymentStatusFor,
  dueFor,
  onPay,
  onShareReceipt,
  paymentsByLorry,
}: {
  rows: FreightRow[];
  paymentStatusFor: (row: FreightRow) => PaymentStatus;
  dueFor: (row: FreightRow) => number;
  onPay: (row: FreightRow, due: number) => void;
  onShareReceipt?: (row: FreightRow) => void;
  paymentsByLorry: Map<string, { date: string; amount: number; reference: string | null }[]>;
}) {
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [payFilter, setPayFilter] = useState<PayFilterValue>('all');
  const [search, setSearch] = useState('');

  const filteredRows = useMemo(() => {
    const payFiltered = filterByPayment(rows, payFilter, paymentStatusFor);
    const q = search.trim().toLowerCase();
    if (!q) return payFiltered;
    const qNorm = q.replace(/[^a-z0-9]/g, '');
    return payFiltered.filter((r) => {
      const matchLorry = (r.lorry ?? '').toLowerCase().includes(q) || (qNorm !== '' && (r.lorry ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(qNorm));
      const matchDest = (r.destination ?? '').toLowerCase().includes(q);
      const matchKind = (r.kind ?? '').toLowerCase().includes(q);
      const matchParty = (r.party ?? '').toLowerCase().includes(q);
      const matchPayment = paymentStatusFor(r).toLowerCase().includes(q);
      return matchLorry || matchDest || matchKind || matchParty || matchPayment;
    });
  }, [rows, payFilter, paymentStatusFor, search]);

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows } = usePagedRows(filteredRows, 50);
  const totalTransport = filteredRows.reduce((s, r) => s + r.net, 0);
  const totalDue = filteredRows.reduce((s, r) => s + dueFor(r), 0);

  const exportColumns: ExportColumn<FreightRow>[] = [
    { header: 'Date', value: (r) => shortDate(r.date) },
    { header: 'Type', value: (r) => r.kind ?? '' },
    { header: 'Route', value: (r) => r.destination ?? '' },
    { header: 'Lorry No', value: (r) => r.lorry ?? '' },
    { header: 'Weight (kg)', value: (r) => r.weightKg ?? 0, numFmt: '#,##0', align: 'right' },
    { header: 'Transport', value: (r) => rupees(r.net), excel: (r) => r.net, numFmt: '#,##0.00', align: 'right' },
    { header: 'Due', value: (r) => rupees(dueFor(r)), excel: (r) => dueFor(r), numFmt: '#,##0.00', align: 'right' },
    { header: 'Payment Status', value: (r) => paymentStatusFor(r) },
  ];

  return (
    <div className="rounded-lg border bg-card overflow-x-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 border-b">
        <div className="flex flex-wrap items-center gap-3">
          <PayFilter value={payFilter} onChange={setPayFilter} />
          <SearchInput
            value={search}
            onValueChange={setSearch}
            placeholder="Search lorry no, route, type…"
            containerClassName="w-full sm:w-72"
            className="h-8 text-xs"
          />
        </div>
        <ExportButtons filename="Freight_Dues_KNM_Transfers" title="KNM Transfer Transport" subtitle={`${filteredRows.length} transfer(s)`} columns={exportColumns} rows={filteredRows} />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Route</TableHead>
            <TableHead>Lorry No</TableHead>
            <TableHead className="text-right">Weight</TableHead>
            <TableHead className="text-right">Transport</TableHead>
            <TableHead className="text-right">Due</TableHead>
            <TableHead>Payment Status</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredRows.length === 0 && (
            <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">No transfers.</TableCell></TableRow>
          )}
          {(pageRows ?? []).map((r) => {
            const pay = paymentStatusFor(r);
            const due = dueFor(r);
            const isExpanded = expandedRow === r.lorry;
            return (
              <Fragment key={r.id}>
                <TableRow
                  className={cn('transition-colors', r.lorry ? cn('cursor-pointer', isExpanded ? 'bg-accent/40' : 'hover:bg-accent/30') : 'hover:bg-muted/50')}
                  onClick={() => r.lorry && setExpandedRow(isExpanded ? null : r.lorry)}
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {r.lorry && <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200', isExpanded && 'rotate-90 text-primary')} />}
                      {shortDate(r.date)}
                    </div>
                  </TableCell>
                  <TableCell><Badge variant={kindVariant[r.kind ?? ''] ?? 'secondary'}>{r.kind}</Badge></TableCell>
                  <TableCell className="text-sm">{r.destination ?? '-'}</TableCell>
                  <TableCell className="font-sans text-xs font-medium text-foreground/80">{r.lorry ?? '-'}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{r.weightKg != null ? `${(r.weightKg / 1000).toFixed(2)} t` : '-'}</TableCell>
                  <TableCell className="text-right font-medium">{rupees(r.net)}</TableCell>
                  <TableCell className={cn('text-right font-mono tabular-nums', due === 0 ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-rose-600 dark:text-rose-400 font-bold')}>
                    {rupees(due)}
                  </TableCell>
                  <TableCell>
                    {r.lorry ? (
                      <span
                        className={`text-xs font-semibold ${
                          pay === 'Paid'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : pay === 'Partial'
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-rose-600 dark:text-rose-400'
                        }`}
                      >
                        {pay}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">No lorry</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="inline-flex items-center justify-end gap-1.5">
                      {r.lorry && onShareReceipt && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs gap-1 text-emerald-600 dark:text-emerald-400 border-emerald-600/30 hover:bg-emerald-50 dark:hover:bg-emerald-950/50"
                          onClick={() => onShareReceipt(r)}
                          title="Share Lorry Payment Receipt via WhatsApp"
                        >
                          <WhatsAppIcon className="h-3 w-3 fill-emerald-600 dark:fill-emerald-400" />
                          <span className="hidden sm:inline">Receipt</span>
                        </Button>
                      )}
                      {r.lorry && pay !== 'Paid' ? (
                        <Button size="sm" variant="outline" onClick={() => onPay(r, due)}>
                          Pay
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
                {isExpanded && r.lorry && (() => {
                  const history = paymentsByLorry.get(r.lorry!) ?? [];
                  return (
                    <ExpandPanel colSpan={9}>
                      <PanelLabel>Payment History for {r.lorry} · {history.length}</PanelLabel>
                      {history.length === 0 ? (
                        <PanelEmpty>No payments recorded.</PanelEmpty>
                      ) : (
                        <PanelStack>
                          {history.map((pay, i) => (
                            <PanelCard
                              key={i}
                              icon={IndianRupee}
                              identity={
                                <PanelTitle>
                                  <span className="font-mono text-sm font-semibold">{shortDate(pay.date)}</span>
                                  {pay.reference && <span className="text-xs text-muted-foreground">{pay.reference}</span>}
                                </PanelTitle>
                              }
                              figures={<Figure label="Amount" value={rupees(pay.amount)} valueClass="text-emerald-600 dark:text-emerald-400" />}
                            />
                          ))}
                        </PanelStack>
                      )}
                    </ExpandPanel>
                  );
                })()}
              </Fragment>
            );
          })}
        </TableBody>
        {filteredRows.length > 0 && (
          <tfoot>
            <TableRow className="border-t-2 font-bold bg-muted/30">
              <TableCell colSpan={5}>Total</TableCell>
              <TableCell className="text-right">{rupees(totalTransport)}</TableCell>
              <TableCell className="text-right font-bold">{rupees(totalDue)}</TableCell>
              <TableCell colSpan={2} />
            </TableRow>
          </tfoot>
        )}
      </Table>
      <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
    </div>
  );
}

interface PayTarget {
  id: string;
  lorry: string;
  due: number;
  sourced: FreightRow['sourced'];
  kind?: 'Husk' | 'Seed' | 'Dust';
  date: string;
  destination?: string | null;
}

export default function FreightDuesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const initialMainTab = tabParam === 'transport' || tabParam === 'lorries' ? tabParam : 'dues';
  const [mainTab, setMainTab] = useState(initialMainTab);
  const qc = useQueryClient();
  const [tab, setTab] = useState('outward');

  // Pay dialog state
  const [payTarget, setPayTarget] = useState<PayTarget | null>(null);
  const [payType, setPayType] = useState<'TRANSPORTER_INWARD' | 'TRANSPORTER_OUTWARD'>('TRANSPORTER_OUTWARD');
  const [payDate, setPayDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [payAmount, setPayAmount] = useState('');
  const [payReference, setPayReference] = useState('');
  const [payDriverPhone, setPayDriverPhone] = useState('');
  const [payDriverName, setPayDriverName] = useState('');

  // Cost Adjust dialog state
  const [adjustTarget, setAdjustTarget] = useState<FreightRow | null>(null);

  const { data: purchases, isLoading: loadingPurchases } = useQuery({
    queryKey: ['purchases'],
    queryFn: () => api<PurchaseRow[]>('/purchases?all=true'),
  });
  const { data: saleOrders, isLoading: loadingSales } = useQuery({
    // Full history - /sale-orders is capped at the latest 100 by default, which
    // would drop older dispatches (and their outward freight) out of the dues run.
    queryKey: ['sale-orders', { all: true }],
    queryFn: () => api<SaleOrder[]>('/sale-orders?all=true'),
  });
  const { data: payments, isLoading: loadingPayments } = useQuery({
    // Full history - dues are matched against every payment, not just latest 100.
    queryKey: ['payments', { all: true }],
    queryFn: () => api<Payment[]>('/payments?all=true'),
  });
  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: () => api<CompanyProfile>('/settings/company'),
  });
  // Transfer transport (husk / seed / pre-cleaner dust) is billed to KNM Transport
  // and settles from the same per-lorry pool as the usual KNM freight.
  const { data: huskTransfers } = useQuery({
    queryKey: ['husk-transfers'],
    queryFn: () => api<HuskTransfer[]>('/husk-transfers'),
  });
  const { data: shellTransfers } = useQuery({
    queryKey: ['shell-transfers'],
    queryFn: () => api<ShellTransfer[]>('/shell-transfers'),
  });
  const { data: stockTransfers } = useQuery({
    queryKey: ['stock-transfers'],
    queryFn: () => api<StockTransfer[]>('/stock-transfers'),
  });
  // Lorries booked over WhatsApp and not yet dispatched - badged on the tab so a
  // new booking is visible without opening it. Shares its key with the register,
  // so both read one cached response.
  const { data: waitingBookings } = useQuery({
    queryKey: ['lorry-confirmations', 'WAITING'],
    queryFn: () => api<LorryConfirmation[]>('/whatsapp/transport-confirmations?status=WAITING'),
    refetchInterval: 60_000,
  });
  const waitingLorries = waitingBookings?.length ?? 0;

  const isLoading = loadingPurchases || loadingSales || loadingPayments;

  // The full freight allocation (outward/inward/KNM split + per-lorry FIFO
  // payment matching) is heavy and depends only on the fetched data. Memoize it
  // so the payment dialog's keystrokes don't recompute the whole thing per
  // render. retention/knmList live inside so the memo stays referentially stable.
  const { outwardRows, inwardRows, knmRows, transferRows, rowStatus, rowDue, paymentsByLorry } = useMemo(() => {
  const retention = Number(company?.freightRetentionPerTrip ?? 3000);
  const knmList = companyVehicleNumbers(company?.companyVehicles);

  // Outward freight (sales). Hamali deducted off the lorry's freight = the lorry
  // share of the loading hamali (pappu ₹80/t, else flat ₹160/t); Transport = the
  // ₹3,000 retention held for Surya Road Transport. Net = lorry owner's payable.
  const allOutwardRows: FreightRow[] = (saleOrders ?? [])
    .flatMap((o) => (o.dispatches ?? []).map((d) => ({ o, d })))
    .filter(({ d }) => Number(d.freightCharge) > 0)
    .map(({ o, d }) => {
      const freight = Number(d.freightCharge);
      const provider = (d as any).transportProvider ?? (d.vehicleNumber && knmList.includes(d.vehicleNumber.trim().toLowerCase()) ? 'KNM' : 'SURYA');
      const isKnm = provider === 'KNM' || (d.vehicleNumber ? knmList.includes(d.vehicleNumber.trim().toLowerCase()) : false);
      const defaultHamali = isKnm ? 0 : (o.product === 'PAPPU' ? pappuLoadingHamali(d.weightKg).lorry : calcHamali(d.weightKg));
      const customHamali = (d as any).customHamali != null ? Number((d as any).customHamali) : null;
      const hamali = customHamali != null ? customHamali : defaultHamali;

      const defaultKata = isKnm ? 0 : calcKataFee(d.weightKg);
      const customKata = (d as any).customKata != null ? Number((d as any).customKata) : null;
      const kata = customKata != null ? customKata : defaultKata;

      const defaultTransport = (provider === 'SURYA' ? retention : 0);
      const customRetention = (d as any).customRetention != null ? Number((d as any).customRetention) : null;
      const transport = customRetention != null ? customRetention : defaultTransport;

      const additions: FreightCostItem[] = Array.isArray((d as any).freightAdditions) ? (d as any).freightAdditions : [];
      const deductions: FreightCostItem[] = Array.isArray((d as any).freightDeductions) ? (d as any).freightDeductions : [];
      const totalAdditions = round2(additions.reduce((s, a) => s + (Number(a.amount) || 0), 0));
      const totalOtherDeductions = round2(deductions.reduce((s, a) => s + (Number(a.amount) || 0), 0));
      const net = round2(freight + totalAdditions - (hamali + kata + transport + totalOtherDeductions));

      return {
        id: d.id,
        date: d.dispatchDate,
        lorry: d.vehicleNumber?.trim().toUpperCase() ?? null,
        invoice: d.invoiceNumber ?? null,
        freight,
        hamali,
        defaultHamali,
        customHamali,
        kata,
        defaultKata,
        customKata,
        transport,
        defaultTransport,
        customRetention,
        additions,
        deductions,
        totalAdditions,
        totalOtherDeductions,
        net,
        deliveryStatus: d.status as SaleStatus,
        sourced: 'Sale',
        destination: o.destination ?? null,
        party: o.buyer?.name ?? null,
        driverPhone: d.driverPhone || (d.transport?.phone ?? null),
        driverName: d.driverName || (d.transport?.contactPerson ?? null),
        weightKg: d.weightKg,
        rawDispatchId: d.id,
      };
    });

  // Inward freight (purchases). Hamali & kata are the recorded purchase charges;
  // no Surya transport retention applies inward.
  const allInwardRows: FreightRow[] = (purchases ?? [])
    .filter((p) => inwardFreightOf(p) > 0)
    .map((p) => {
      const freight = round2(inwardFreightOf(p));
      const lorry = p.stockIn?.lorryNumber;
      const isKnm = lorry ? knmList.includes(lorry.trim().toLowerCase()) : false;
      const cv = findCompanyVehicle(lorry, company?.companyVehicles);
      
      const defaultHamali = isKnm ? 0 : Number(p.hamaliCharge ?? 0);
      const customHamali = (p as any).customHamali != null ? Number((p as any).customHamali) : null;
      const hamali = customHamali != null ? customHamali : defaultHamali;

      const defaultKata = isKnm ? 0 : Number(p.kataFee ?? 0);
      const customKata = (p as any).customKata != null ? Number((p as any).customKata) : null;
      const kata = customKata != null ? customKata : defaultKata;

      const defaultTransport = 0;
      const customRetention = (p as any).customRetention != null ? Number((p as any).customRetention) : null;
      const transport = customRetention != null ? customRetention : defaultTransport;

      const additions: FreightCostItem[] = Array.isArray((p as any).freightAdditions) ? (p as any).freightAdditions : [];
      const deductions: FreightCostItem[] = Array.isArray((p as any).freightDeductions) ? (p as any).freightDeductions : [];
      const totalAdditions = round2(additions.reduce((s, a) => s + (Number(a.amount) || 0), 0));
      const totalOtherDeductions = round2(deductions.reduce((s, a) => s + (Number(a.amount) || 0), 0));
      const net = round2(freight + totalAdditions - (hamali + kata + transport + totalOtherDeductions));

      return {
        id: p.id,
        date: p.stockIn?.arrivalDate ?? p.createdAt,
        lorry: lorry?.trim().toUpperCase() ?? null,
        invoice: p.stockIn?.invoiceNumber ?? null,
        freight,
        hamali,
        defaultHamali,
        customHamali,
        kata,
        defaultKata,
        customKata,
        transport,
        defaultTransport,
        customRetention,
        additions,
        deductions,
        totalAdditions,
        totalOtherDeductions,
        net,
        deliveryStatus: 'RECEIVED',
        sourced: 'Purchase',
        destination: p.stockIn?.loadingLocation ?? null,
        party: p.stockIn?.purchaseOrder?.party?.name ?? null,
        driverPhone: cv?.driverPhone || null,
        driverName: cv?.driverName || null,
        weightKg: p.netWeightKg,
        rawPurchaseId: p.id,
      };
    });

  const knmRows = combineSharedLorryRows([
    ...allOutwardRows.filter(r => r.lorry && knmList.includes(r.lorry.toLowerCase())),
    ...allInwardRows.filter(r => r.lorry && knmList.includes(r.lorry.toLowerCase())),
  ]).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const outwardRows = combineSharedLorryRows(allOutwardRows.filter(r => !r.lorry || !knmList.includes(r.lorry.toLowerCase())));
  const inwardRows = combineSharedLorryRows(allInwardRows.filter(r => !r.lorry || !knmList.includes(r.lorry.toLowerCase())));

  // Transfer transport rows (husk / seed / pre-cleaner dust). The whole transport
  // charge is the net payable to KNM Transport - no hamali/kata/retention deducted.
  const mkTransferRow = (
    prefix: string,
    kind: 'Husk' | 'Seed' | 'Dust',
    t: { id: string; transferDate: string; lorryNumber: string | null; transportCharge: string | number; fromLocation: string; toLocation: string; weightKg: number },
  ): FreightRow => {
    const freight = round2(Number(t.transportCharge));
    const cv = findCompanyVehicle(t.lorryNumber, company?.companyVehicles);
    return {
      id: `${prefix}-${t.id}`,
      date: t.transferDate,
      lorry: t.lorryNumber?.trim().toUpperCase() ?? null,
      invoice: null,
      freight,
      hamali: 0,
      kata: 0,
      transport: 0,
      additions: [],
      deductions: [],
      totalAdditions: 0,
      totalOtherDeductions: 0,
      net: freight,
      deliveryStatus: 'RECEIVED',
      sourced: 'Transfer',
      destination: `${t.fromLocation} → ${t.toLocation}`,
      party: 'KNM Transport',
      driverPhone: cv?.driverPhone || null,
      driverName: cv?.driverName || null,
      kind,
      weightKg: t.weightKg,
    };
  };
  const transferRows: FreightRow[] = [
    ...(huskTransfers ?? []).map((t) => mkTransferRow('husk', 'Husk', t)),
    ...(stockTransfers ?? []).map((t) => mkTransferRow('seed', 'Seed', t)),
    ...(shellTransfers ?? []).map((t) => mkTransferRow('dust', 'Dust', t)),
  ]
    .filter((r) => r.freight > 0)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Payment matching:
  // 1. Direct row payments (tagged with [rowId] in description or reference)
  // 2. Floating payments per lorry, separated into Usual Freight vs Transfer pools
  const rowStatus = new Map<string, PaymentStatus>();
  const rowDue = new Map<string, number>();
  const paymentsByLorry = new Map<string, { date: string, amount: number, reference: string | null }[]>();

  const directPaidByRow = new Map<string, number>();
  const floatingUsualByLorry = new Map<string, number>();
  const floatingTransferByLorry = new Map<string, number>();

  payments?.forEach((p) => {
    if ((p.type === 'TRANSPORTER' || p.type === 'TRANSPORTER_INWARD' || p.type === 'TRANSPORTER_OUTWARD') && p.lorryNumber) {
      const k = p.lorryNumber.trim().toUpperCase();
      const amt = Number(p.amount);
      
      const list = paymentsByLorry.get(k) || [];
      list.push({ date: p.date, amount: amt, reference: p.reference ?? null });
      paymentsByLorry.set(k, list);

      // Check if description contains direct row tag: e.g. [seed-cmt1gecun0007dq2dkq6urkth]
      const match = p.description?.match(/\[([a-zA-Z0-9_-]+)\]/);
      const rowId = match ? match[1] : null;

      if (rowId) {
        directPaidByRow.set(rowId, (directPaidByRow.get(rowId) ?? 0) + amt);
      } else if (p.description?.toLowerCase().includes('transfer')) {
        floatingTransferByLorry.set(k, (floatingTransferByLorry.get(k) ?? 0) + amt);
      } else {
        floatingUsualByLorry.set(k, (floatingUsualByLorry.get(k) ?? 0) + amt);
      }
    }
  });

  function allocatePool(rows: FreightRow[], floatingByLorry: Map<string, number>) {
    const remainingDueMap = new Map<string, number>();
    for (const r of rows) {
      const direct = directPaidByRow.get(r.id) ?? 0;
      const rem = round2(Math.max(0, r.net - direct));
      remainingDueMap.set(r.id, rem);
    }

    const rowsByLorry = new Map<string, FreightRow[]>();
    for (const r of rows) {
      if (r.lorry) {
        const list = rowsByLorry.get(r.lorry) || [];
        list.push(r);
        rowsByLorry.set(r.lorry, list);
      }
    }

    for (const [lorry, lorryRows] of rowsByLorry.entries()) {
      lorryRows.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      let remainingPaid = floatingByLorry.get(lorry) ?? 0;

      for (const r of lorryRows) {
        const remAfterDirect = remainingDueMap.get(r.id) ?? r.net;
        const direct = directPaidByRow.get(r.id) ?? 0;

        if (remAfterDirect <= 0) {
          rowStatus.set(r.id, 'Paid');
          rowDue.set(r.id, 0);
        } else if (remainingPaid <= 0) {
          if (direct > 0) {
            rowStatus.set(r.id, 'Partial');
            rowDue.set(r.id, remAfterDirect);
          } else {
            rowStatus.set(r.id, 'Pending');
            rowDue.set(r.id, r.net);
          }
        } else if (remainingPaid + 0.01 >= remAfterDirect) {
          rowStatus.set(r.id, 'Paid');
          rowDue.set(r.id, 0);
          remainingPaid -= remAfterDirect;
        } else {
          rowStatus.set(r.id, 'Partial');
          rowDue.set(r.id, round2(remAfterDirect - remainingPaid));
          remainingPaid = 0;
        }
      }
    }
  }

  // Allocate Usual Freight Pool (Outward, Inward, KNM Usual)
  allocatePool([...inwardRows, ...outwardRows, ...knmRows], floatingUsualByLorry);

  // Allocate Transfer Pool (Husk, Seed, Dust Transfers)
  allocatePool(transferRows, floatingTransferByLorry);

  return { outwardRows, inwardRows, knmRows, transferRows, rowStatus, rowDue, paymentsByLorry };
  }, [saleOrders, purchases, payments, company, huskTransfers, shellTransfers, stockTransfers]);

  const [shareTarget, setShareTarget] = useState<LorryPaymentData | null>(null);

  function paymentStatusFor(r: FreightRow): PaymentStatus {
    return r.lorry ? (rowStatus.get(r.id) ?? 'Pending') : 'Pending';
  }
  function dueFor(r: FreightRow): number {
    return r.lorry ? (rowDue.get(r.id) ?? r.net) : 0;
  }

  const buildLorryPaymentData = (row: FreightRow, paidNow?: number, payRef?: string, payDt?: string): LorryPaymentData => {
    const history = paymentsByLorry.get(row.lorry || '') || [];
    const prevPaid = history.reduce((s, p) => s + p.amount, 0);
    const paid = paidNow != null ? paidNow : (prevPaid > 0 ? prevPaid : row.net - dueFor(row));
    const remainingDue = Math.max(0, row.net - (prevPaid + (paidNow != null ? paidNow : 0)));

    let driverPhone = row.driverPhone || null;
    let driverName = row.driverName || null;
    if (!driverPhone && row.lorry) {
      const cv = findCompanyVehicle(row.lorry, company?.companyVehicles);
      if (cv?.driverPhone) {
        driverPhone = cv.driverPhone;
        driverName = cv.driverName || driverName;
      } else {
        const booking = (waitingBookings ?? []).find(
          (b) => normalizeLorryNumber(b.lorryNumber) === normalizeLorryNumber(row.lorry)
        );
        if (booking?.driverPhone) {
          driverPhone = booking.driverPhone;
          driverName = booking.driverName || driverName;
        }
      }
    }

    return {
      date: payDt || row.date,
      lorryNumber: row.lorry || '-',
      driverPhone,
      driverName,
      ownerPhone: company?.ownerWhatsappNumber || null,
      destination: row.destination,
      grossFreight: row.freight,
      kata: row.kata,
      hamali: row.hamali,
      otherDeductions: Math.max(0, (row.transport || 0) + (row.totalOtherDeductions || 0) - (row.totalAdditions || 0)),
      netPayable: row.net,
      amountPaid: paid,
      reference: payRef || (history.length ? history[history.length - 1].reference : null) || 'Cash / Bank',
      balance: paidNow != null ? remainingDue : dueFor(row),
      deductions: row.deductions,
      additions: row.additions,
    };
  };

  const handleShareReceipt = (row: FreightRow) => {
    setShareTarget(buildLorryPaymentData(row));
  };

  const payMutation = useMutation({
    mutationFn: () => {
      if (!payTarget) throw new Error('No trip selected for payment');
      const desc = payTarget.sourced === 'Transfer'
        ? `Transfer transport (${payTarget.kind || 'Internal'}) - Lorry ${payTarget.lorry}`
        : `Freight payment - Lorry ${payTarget.lorry}`;

      return api<Payment>('/payments', {
        method: 'POST',
        body: {
          date: payDate,
          amount: Number(payAmount) || 0,
          type: payType,
          lorryNumber: payTarget.lorry,
          driverPhone: payDriverPhone.trim() || undefined,
          driverName: payDriverName.trim() || undefined,
          purchaseId: payTarget.sourced === 'Purchase' && !payTarget.id.startsWith('comb-') ? payTarget.id : undefined,
          tripId: !payTarget.id.startsWith('comb-') ? payTarget.id : undefined,
          reference: payReference || null,
          description: desc,
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      toast.success('Freight payment recorded');
      if (payTarget && payTarget.lorry) {
        const all = [...outwardRows, ...inwardRows, ...knmRows, ...transferRows];
        const match = all.find((r) => r.id === payTarget.id) || all.find((r) => r.lorry === payTarget.lorry);
        if (match) {
          const shareData = buildLorryPaymentData(match, Number(payAmount) || 0, payReference, payDate);
          if (payDriverPhone.trim()) shareData.driverPhone = payDriverPhone.trim();
          if (payDriverName.trim()) shareData.driverName = payDriverName.trim();
          setShareTarget(shareData);
        }
      }
      setPayTarget(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function openPay(row: FreightRow, due: number) {
    if (!row.lorry) return;
    setPayTarget({
      id: row.id,
      lorry: row.lorry,
      due,
      sourced: row.sourced,
      kind: row.kind,
      date: row.date,
      destination: row.destination,
    });
    const paymentData = buildLorryPaymentData(row, due);
    setPayDriverPhone(paymentData.driverPhone || '');
    setPayDriverName(paymentData.driverName || '');
    setPayType(row.sourced === 'Purchase' ? 'TRANSPORTER_INWARD' : 'TRANSPORTER_OUTWARD');
    setPayDate(row.date ? row.date.slice(0, 10) : new Date().toISOString().slice(0, 10));
    setPayAmount(due > 0 ? String(due) : '');
    setPayReference('');
  }

  const outwardNet = outwardRows.reduce((s, r) => s + r.net, 0);
  const outwardDue = outwardRows.reduce((s, r) => s + dueFor(r), 0);

  const inwardNet = inwardRows.reduce((s, r) => s + r.net, 0);
  const inwardDue = inwardRows.reduce((s, r) => s + dueFor(r), 0);

  const knmUsualNet = knmRows.reduce((s, r) => s + r.net, 0);
  const knmUsualDue = knmRows.reduce((s, r) => s + dueFor(r), 0);

  const transfersNet = transferRows.reduce((s, r) => s + r.net, 0);
  const transfersDue = transferRows.reduce((s, r) => s + dueFor(r), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Freight Dues"
        description="Transporter freight dues, net payable & transport retention report."
        icon={Truck}
      />

      <Tabs
        value={mainTab}
        onValueChange={(v) => {
          setMainTab(v);
          setSearchParams(v === 'dues' ? {} : { tab: v });
        }}
        className="space-y-6"
      >
        <TabsList className="bg-card border shadow-sm">
          <TabsTrigger value="dues" className="gap-2 text-sm font-semibold">
            <Truck className="h-4 w-4" /> Freight Dues
          </TabsTrigger>
          <TabsTrigger value="transport" className="gap-2 text-sm font-semibold">
            <Truck className="h-4 w-4" /> Transport Report
          </TabsTrigger>
          <TabsTrigger value="lorries" className="gap-2 text-sm font-semibold">
            <MessageCircle className="h-4 w-4" /> Lorry Confirmations
            {waitingLorries > 0 && (
              <Badge variant="secondary" className="ml-0.5 h-5 px-1.5 text-[10px]">{waitingLorries}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="dues" className="space-y-6">
          {isLoading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : (
            <Tabs value={tab} onValueChange={setTab} className="space-y-4">
              <TabsList>
                <TabsTrigger value="outward" className="gap-1.5">
                  <ArrowUpFromLine className="h-4 w-4" /> Outward (Sales)
                </TabsTrigger>
                <TabsTrigger value="inward" className="gap-1.5">
                  <ArrowDownToLine className="h-4 w-4" /> Inward (Purchases)
                </TabsTrigger>
                <TabsTrigger value="knm" className="gap-1.5">
                  <Truck className="h-4 w-4" /> KNM Freight
                </TabsTrigger>
              </TabsList>

              <TabsContent value="outward" className="space-y-4">
                <Card className="bg-card/50 border shadow-sm max-w-xs">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Outward Net Freight</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-xl font-bold">{rupees(outwardDue)}</div>
                    <div className="text-xs text-muted-foreground mt-1">Total: {rupees(outwardNet)}</div>
                  </CardContent>
                </Card>
                <FreightTable freightLabel="Outward Freight" exportName="Freight_Dues_Outward" rows={outwardRows} paymentStatusFor={paymentStatusFor} dueFor={dueFor} onPay={openPay} onAdjust={setAdjustTarget} onShareReceipt={handleShareReceipt} paymentsByLorry={paymentsByLorry} />
              </TabsContent>

              <TabsContent value="inward" className="space-y-4">
                <Card className="bg-card/50 border shadow-sm max-w-xs">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Inward Net Freight</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-xl font-bold">{rupees(inwardDue)}</div>
                    <div className="text-xs text-muted-foreground mt-1">Total: {rupees(inwardNet)}</div>
                  </CardContent>
                </Card>
                <FreightTable freightLabel="Inward Freight" exportName="Freight_Dues_Inward" rows={inwardRows} paymentStatusFor={paymentStatusFor} dueFor={dueFor} onPay={openPay} onAdjust={setAdjustTarget} onShareReceipt={handleShareReceipt} paymentsByLorry={paymentsByLorry} />
              </TabsContent>

              <TabsContent value="knm" className="space-y-6">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
                  <Card className="bg-card/50 border shadow-sm">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Usual Freight Due</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-xl font-bold">{rupees(knmUsualDue)}</div>
                      <div className="text-xs text-muted-foreground mt-1">Total: {rupees(knmUsualNet)}</div>
                    </CardContent>
                  </Card>
                  <Card className="bg-card/50 border shadow-sm">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Transfers Payable</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-xl font-bold">{rupees(transfersDue)}</div>
                      <div className="text-xs text-muted-foreground mt-1">Total: {rupees(transfersNet)}</div>
                    </CardContent>
                  </Card>
                  <Card className="bg-card/50 border shadow-sm">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">KNM Total Payable</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-xl font-bold">{rupees(knmUsualDue + transfersDue)}</div>
                      <div className="text-xs text-muted-foreground mt-1">Total: {rupees(knmUsualNet + transfersNet)}</div>
                    </CardContent>
                  </Card>
                </div>

                <Tabs defaultValue="usual" className="space-y-4">
                  <TabsList>
                    <TabsTrigger value="usual" className="gap-1.5">
                      <Truck className="h-4 w-4" /> Usual Freights
                    </TabsTrigger>
                    <TabsTrigger value="transfers" className="gap-1.5">
                      <ArrowLeftRight className="h-4 w-4" /> Transfers
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="usual">
                    <FreightTable freightLabel="KNM Freight" exportName="Freight_Dues_KNM" rows={knmRows} paymentStatusFor={paymentStatusFor} dueFor={dueFor} onPay={openPay} onAdjust={setAdjustTarget} onShareReceipt={handleShareReceipt} hideDeductions={true} paymentsByLorry={paymentsByLorry} />
                  </TabsContent>

                  <TabsContent value="transfers" className="space-y-2">
                    <p className="text-xs text-muted-foreground">Husk, seed &amp; pre-cleaner dust transport billed to KNM Transport.</p>
                    <TransfersTable rows={transferRows} paymentStatusFor={paymentStatusFor} dueFor={dueFor} onPay={openPay} onShareReceipt={handleShareReceipt} paymentsByLorry={paymentsByLorry} />
                  </TabsContent>
                </Tabs>
              </TabsContent>
            </Tabs>
          )}
        </TabsContent>

        <TabsContent value="transport">
          <SuryaRoadTransport embedded />
        </TabsContent>

        <TabsContent value="lorries">
          <LorryConfirmations />
        </TabsContent>
      </Tabs>

      {/* Adjust Freight Costs & Deductions Dialog */}
      <AdjustFreightCostsDialog
        open={adjustTarget !== null}
        onOpenChange={(o) => { if (!o) setAdjustTarget(null); }}
        target={adjustTarget}
      />

      {/* Pay Dialog */}
      <Dialog open={payTarget !== null} onOpenChange={(o) => { if (!o) setPayTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Pay {payTarget?.sourced === 'Transfer' ? `${payTarget.kind || ''} Transfer` : 'Freight'} - Lorry {payTarget?.lorry}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {payTarget && (
              <div className="rounded-md bg-muted/50 p-3 text-xs space-y-1 text-muted-foreground">
                <div className="flex justify-between">
                  <span>Date: <strong className="text-foreground">{shortDate(payTarget.date)}</strong></span>
                  <span>Type: <strong className="text-foreground">{payTarget.sourced === 'Transfer' ? `${payTarget.kind} Transfer` : payTarget.sourced}</strong></span>
                </div>
                {payTarget.destination && (
                  <div>Route: <strong className="text-foreground">{payTarget.destination}</strong></div>
                )}
                <div className="flex justify-between font-medium">
                  <span>Due Amount:</span>
                  <span className="text-rose-600 dark:text-rose-400 font-bold">{rupees(payTarget.due)}</span>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="pay-date">Payment Date</Label>
                <Input id="pay-date" type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pay-amount">Amount (₹)</Label>
                <Input id="pay-amount" type="number" step="0.01" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="e.g. 50000" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="pay-driver-phone">Driver Phone (WhatsApp notification)</Label>
              <Input
                id="pay-driver-phone"
                value={payDriverPhone}
                onChange={(e) => setPayDriverPhone(e.target.value)}
                placeholder="e.g. 9876543210 (auto-detected if available)"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pay-ref">Reference (Cheque / UTR / Cash)</Label>
              <Input id="pay-ref" value={payReference} onChange={(e) => setPayReference(e.target.value)} placeholder="Optional" />
            </div>
            <DialogFooter>
              <Button onClick={() => payMutation.mutate()} disabled={!(Number(payAmount) > 0) || payMutation.isPending}>
                {payMutation.isPending ? 'Saving…' : 'Record Payment'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Lorry Freight Payment Receipt WhatsApp Dialog */}
      <LorryPaymentShareDialog
        open={shareTarget !== null}
        onOpenChange={(o) => { if (!o) setShareTarget(null); }}
        data={shareTarget}
        initialPhone={shareTarget?.driverPhone}
      />
    </div>
  );
}
