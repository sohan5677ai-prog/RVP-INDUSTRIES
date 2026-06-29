import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Loader2, Search, Tag, Factory, Wheat, Calculator,
  ArrowUpRight, ArrowDownRight, AlertTriangle, CheckCircle2,
  ChevronRight, ChevronDown, Scale, ShoppingCart,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { FreightRate } from '@/lib/types';
import { kg, rupees, shortDate, toTonnes } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface BlackSeedRow {
  purchaseId: string;
  date: string;
  partyName: string;
  poNumber: string | null;
  lorryNumber: string;
  rvpNetWeightKg: number; // received kg for this lot
}

type LotKind = 'ARRIVED' | 'PENDING' | 'SHORTFALL';

interface LotResponse {
  purchaseId: string;
  date: string;
  partyName: string;
  lorryNumber: string;
  poNumber: string | null;
  kind: LotKind;
  orderedKg: number;
  receivedKg: number; // seed left in lot after sales draw-down
  soldKg: number; // seed consumed from this lot by sales
}

interface PriceBandResponse {
  blackPricePerKg: number;
  lorries: number;
  arrivedBlackKg: number; // gross arrived (at process)
  allocatedPappuKg: number; // consumable pappu this band supplied to sales (the debit)
  remainingBlackKg: number; // arrived seed left after sales draw-down (≥ 0)
  remainingValue: number;
  pendingBlackKg: number; // still-coming (open PO) seed left after draw-down
  pendingValue: number;
  shortfallBlackKg: number; // seed an arrived PO failed to deliver
  shortfallPappuKg: number; // consumable deficit beyond buffer (the NEGATIVE balance)
  lots: LotResponse[];
}

interface StockByPriceResponse {
  bands: PriceBandResponse[];
  totalAllocatedPappuKg: number;
  totalDeficitPappuKg: number;
  outTurnPct: number;
  consumablePct: number;
}

interface PriceBand {
  blackPricePerKg: number;
  impliedPappuPrice: number; // blackPrice / (out-turn × consumable) = cost per sellable kg
  lorries: number;
  arrivedRemainingKg: number; // arrived seed left after sales draw-down
  arrivedGrossKg: number; // gross arrived
  allocatedPappuKg: number; // consumable pappu committed to sale orders (the debit)
  pendingBlackKg: number; // still-coming seed left after draw-down
  shortfallBlackKg: number; // seed an arrived PO failed to deliver
  availablePappuKg: number; // CONSUMABLE pappu on arrived seed
  committedPappuKg: number; // available + consumable pappu on pending seed
  bufferBlackKg: number; // 20% seed reserve
  bufferPappuKg: number; // 20% reserve produced from arrived seed (never sold)
  shortfallPappuKg: number; // consumable deficit from arrival shortfalls (negative)
  value: number; // net remaining (arrived) value
  pendingValue: number; // value of pending PO seed
  rows: BlackSeedRow[]; // arrived lots that make up the band
  lots: LotResponse[]; // all lots incl. pending + shortfall, for the expansion panel
}

// 1 kg black seed yields 0.6 kg pappu (out-turn). Of that milled pappu, only 80%
// is consumable/sellable; the remaining 20% is a buffer reserve (waste + safety
// stock). seed → consumable pappu therefore runs at 0.6 × 0.8 = 0.48.
const PAPPU_OUTTURN = 0.6;
const PAPPU_CONSUMABLE = 0.8;
const SEED_TO_CONSUMABLE = PAPPU_OUTTURN * PAPPU_CONSUMABLE;

/**
 * Stock by Price — a pappu order planner driven by the black-seed cost basis.
 *
 * Each price band is an account: black seed is a credit (arrived lorries + still-
 * coming PENDING PO tonnage) and committed pappu sales are a debit. Sales draw seed
 * down most-expensive-band first, taking arrived seed then pending seed. All pappu
 * figures are CONSUMABLE (sellable): seed × 0.6 out-turn × 0.8 buffer; the 20% buffer
 * is produced but never sold. A band goes NEGATIVE when an already-arrived PO came up
 * short of its order by more than the buffer can absorb (an arrival shortfall). Enter
 * the pappu price + tonnage a customer asks for and it pools every band at or below
 * the break-even ceiling, then reports producible pappu, shortage/excess, and margin.
 */
export default function StockByPrice() {
  const [pappuPriceInput, setPappuPriceInput] = useState('');
  const [tonnageInput, setTonnageInput] = useState('');
  const [freightId, setFreightId] = useState('__none__');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [plannerBasis, setPlannerBasis] = useState<'COMMITTED' | 'AVAILABLE'>('COMMITTED');

  const { data, isLoading } = useQuery({
    queryKey: ['stock-by-price'],
    queryFn: () => api<StockByPriceResponse>('/inventory/by-price'),
  });

  const { data: freightRates } = useQuery({
    queryKey: ['freight-rates'],
    queryFn: () => api<FreightRate[]>('/settings/freight-rates'),
  });
  const selectedFreight = freightRates?.find((r) => r.id === freightId);
  const freightPerKg = selectedFreight ? Number(selectedFreight.ratePerTonne) / 1000 : 0;

  // Map the server's bands. Pappu figures are CONSUMABLE (sellable) pappu.
  const bands = useMemo<PriceBand[]>(() => {
    return (data?.bands ?? []).map((b) => {
      // Available = consumable pappu on arrived seed left after sales (no buffer).
      // Committed = available + consumable pappu on still-coming (pending) seed (has 20% buffer).
      const availablePappuKg = b.remainingBlackKg * PAPPU_OUTTURN;
      const committedPappuKg = availablePappuKg + (b.pendingBlackKg * SEED_TO_CONSUMABLE);
      
      // Buffer is 20% of the GROSS black seed, but ONLY for pending / un-arrived orders.
      const rawBufferBlackKg = (b.lots || []).reduce((sum, l) => {
        if (l.kind === 'ARRIVED' || l.kind === 'SHORTFALL') return sum;
        return sum + (l.receivedKg * (1 - PAPPU_CONSUMABLE));
      }, 0);
      
      // We square off shortfalls against the band's unsold arrived seed AND pending buffer.
      // Unsold arrived seed (b.remainingBlackKg) and pending buffer are 'extra' stock
      // that can absorb a shortfall without affecting committed orders.
      let availableCoverageKg = b.remainingBlackKg + rawBufferBlackKg;
      
      const adjustedLots: LotResponse[] = [];
      let finalShortfallBlackKg = 0;
      let finalShortfallPappuKg = 0;
      let remainingBufferBlackKg = rawBufferBlackKg;

      for (const lot of (b.lots || [])) {
        if (lot.kind === 'SHORTFALL') {
          if (availableCoverageKg >= lot.receivedKg) {
            // Fully squared off by coverage, so it disappears!
            availableCoverageKg -= lot.receivedKg;
            // Deduct from buffer first for display purposes, though coverage includes arrived
            remainingBufferBlackKg = Math.max(0, remainingBufferBlackKg - lot.receivedKg);
            continue;
          } else {
            // Partially squared off
            const remainingShortfall = lot.receivedKg - availableCoverageKg;
            
            // Adjust coverage and buffer down to 0
            remainingBufferBlackKg = Math.max(0, remainingBufferBlackKg - availableCoverageKg);
            availableCoverageKg = 0;
            
            // Recalculate pappu deficit for the remaining shortfall
            const gapPappu = remainingShortfall * PAPPU_OUTTURN;
            const lotBuffer = lot.orderedKg * PAPPU_OUTTURN * (1 - PAPPU_CONSUMABLE);
            const deficit = Math.max(0, gapPappu - lotBuffer);
            
            finalShortfallBlackKg += remainingShortfall;
            finalShortfallPappuKg += deficit;
            
            adjustedLots.push({ ...lot, receivedKg: remainingShortfall });
          }
        } else {
          adjustedLots.push(lot);
        }
      }

      const bufferPappuKg = remainingBufferBlackKg * PAPPU_OUTTURN;

      return {
        blackPricePerKg: b.blackPricePerKg,
        impliedPappuPrice: b.blackPricePerKg / PAPPU_OUTTURN,
        lorries: b.lorries,
        arrivedRemainingKg: b.remainingBlackKg,
        arrivedGrossKg: b.arrivedBlackKg,
        allocatedPappuKg: b.allocatedPappuKg,
        pendingBlackKg: b.pendingBlackKg,
        shortfallBlackKg: finalShortfallBlackKg,
        availablePappuKg,
        committedPappuKg,
        bufferBlackKg: remainingBufferBlackKg,
        bufferPappuKg,
        shortfallPappuKg: finalShortfallPappuKg,
        value: b.remainingValue,
        pendingValue: b.pendingValue,
        lots: adjustedLots,
        rows: adjustedLots
          .filter((l) => l.kind === 'ARRIVED')
          .map((l) => ({
            purchaseId: l.purchaseId,
            date: l.date,
            partyName: l.partyName,
            poNumber: l.poNumber,
            lorryNumber: l.lorryNumber,
            rvpNetWeightKg: l.receivedKg,
          }))
          .sort((a, z) => a.date.localeCompare(z.date)),
      };
    });
  }, [data]);

  const totalAllocatedPappuKg = data?.totalAllocatedPappuKg ?? 0;
  const totalDeficitPappuKg = data?.totalDeficitPappuKg ?? 0;

  // ─── Order planner maths ───────────────────────────────────────────────────
  const basePappuPrice = parseFloat(pappuPriceInput);
  const tonnage = parseFloat(tonnageInput);
  const hasPrice = Number.isFinite(basePappuPrice) && basePappuPrice > 0;
  const hasTonnage = Number.isFinite(tonnage) && tonnage > 0;
  // Freight (₹/kg) is a delivery cost subtracted from the asked pappu price to
  // get the net realisation → effective price the planner works on.
  const pappuPrice = Math.max(0, (hasPrice ? basePappuPrice : 0) - freightPerKg);

  const plan = useMemo(() => {
    if ((!hasPrice && !hasTonnage) || bands.length === 0) return null;
    
    // Break-even seed price = sell price × seed→pappu yield (0.6).
    const ceilingBlackPrice = hasPrice ? pappuPrice * PAPPU_OUTTURN : Infinity;
    
    const eligible = hasPrice
      ? bands.filter((b) => b.blackPricePerKg <= ceilingBlackPrice + 1e-6)
      : bands;

    // COMMITTED pools arrived + pending seed; AVAILABLE pools arrived only.
    const useCommitted = plannerBasis === 'COMMITTED';
    const availableBlackKg = eligible.reduce((s, b) => s + b.arrivedRemainingKg + (useCommitted ? b.pendingBlackKg : 0), 0);
    const poolPappu = eligible.reduce((s, b) => s + (useCommitted ? b.committedPappuKg : b.availablePappuKg), 0);
    const poolPending = eligible.reduce((s, b) => s + (b.pendingBlackKg * SEED_TO_CONSUMABLE), 0);
    const eligibleValue = eligible.reduce((s, b) => s + b.value + (useCommitted ? b.pendingValue : 0), 0);
    const wacBlack = availableBlackKg > 0 ? eligibleValue / availableBlackKg : 0; // weighted-avg seed cost
    const wacPappuCost = wacBlack / PAPPU_OUTTURN; // weighted-avg cost per sellable kg
    const askedPappuKg = hasTonnage ? tonnage * 1000 : 0;
    // How much black seed is needed for the asked tonnage if bought fresh?
    const blackRequiredKg = askedPappuKg / SEED_TO_CONSUMABLE;
    const diff = poolPappu - askedPappuKg; // + excess, − shortage
    // Extra black seed to source if the eligible stock can't cover the order.
    // Shortage is covered by NEW seed, which yields 0.48 (because it's pending).
    const seedShortfallKg = diff < 0 ? (-diff) / SEED_TO_CONSUMABLE : 0;
    const fulfillmentPct = askedPappuKg > 0 ? Math.min(100, (poolPappu / askedPappuKg) * 100) : 100;
    const marginPerKg = hasPrice ? pappuPrice - wacPappuCost : 0; // pappu sell − weighted-avg pappu cost
    
    return {
      ceilingBlackPrice, eligibleCount: eligible.length, availableBlackKg,
      poolPappu, poolPending, wacBlack, wacPappuCost, askedPappuKg, blackRequiredKg,
      seedShortfallKg, diff, fulfillmentPct, marginPerKg,
      isAllStock: !hasPrice
    };
  }, [bands, pappuPrice, tonnage, hasPrice, hasTonnage, plannerBasis]);

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  // At-process totals (net remaining = arrived seed − committed orders).
  const totalBlackKg = bands.reduce((s, b) => s + b.arrivedRemainingKg, 0);
  const totalPendingBlackKg = bands.reduce((s, b) => s + b.pendingBlackKg, 0);
  const committedBlackSeedKg = totalBlackKg + (totalPendingBlackKg * PAPPU_CONSUMABLE);
  const totalReceivedKg = bands.reduce((s, b) => s + b.arrivedGrossKg, 0);
  const totalAvailablePappuKg = bands.reduce((s, b) => s + b.availablePappuKg, 0);
  const totalCommittedPappuKg = bands.reduce((s, b) => s + b.committedPappuKg, 0);
  // Valuation counts bands with positive net stock + pending stock
  const totalValue = bands.reduce((s, b) => s + Math.max(0, b.value) + Math.max(0, b.pendingValue), 0);
  const totalPositiveBlackKg = bands.reduce((s, b) => s + Math.max(0, b.arrivedRemainingKg) + Math.max(0, b.pendingBlackKg), 0);
  const overallWacBlack = totalPositiveBlackKg > 0 ? totalValue / totalPositiveBlackKg : 0;
  const overallWacPappu = overallWacBlack / PAPPU_OUTTURN;
  const totalBufferBlackKg = bands.reduce((s, b) => s + b.bufferBlackKg, 0);
  const totalBufferPappuKg = bands.reduce((s, b) => s + b.bufferPappuKg, 0);
  const totalShortfallPappuKg = bands.reduce((s, b) => s + b.shortfallPappuKg, 0);

  const q = search.trim().toLowerCase();
  const visible = bands.filter((b) => {
    // 2. Text Search
    if (!q) return true;
    if (rupees(b.blackPricePerKg).toLowerCase().includes(q)) return true;
    if (b.blackPricePerKg.toFixed(2).includes(q)) return true;
    if (rupees(b.impliedPappuPrice).toLowerCase().includes(q)) return true;
    return b.rows.some(
      (r) =>
        r.partyName.toLowerCase().includes(q) ||
        r.lorryNumber.toLowerCase().includes(q) ||
        (r.poNumber ?? '').toLowerCase().includes(q)
    );
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const shortage = plan && plan.diff < 0 ? -plan.diff : 0;
  const excess = plan && plan.diff > 0 ? plan.diff : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Order Planner</h1>
        <p className="text-muted-foreground">
          Enter the pappu price and tonnage a customer asks for. All pappu figures are <span className="font-medium">consumable</span> (sellable)
          tonnage: (seed - {((1 - PAPPU_CONSUMABLE) * 100).toFixed(0)}% buffer) × {PAPPU_OUTTURN} out-turn = {SEED_TO_CONSUMABLE.toFixed(2)} kg consumable per kg seed.
          The planner pools every black-seed cost band at or below the break-even ceiling (pappu price × {PAPPU_OUTTURN.toFixed(2)}). Plan against{' '}
          <span className="font-medium">Available</span> pappu (arrived seed only) or <span className="font-medium">Committed</span> (arrived + pending PO seed),
          and see the shortage or excess and your margin on the weighted-average cost.
        </p>
      </div>

      {/* ─── Order Planner ─────────────────────────────────────────────────── */}
      <Card className="border-l-4 border-l-primary shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Calculator className="h-4 w-4 text-primary" /> Order Planner
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 max-w-4xl">
            <div className="space-y-1">
              <Label htmlFor="pappu-price" className="text-xs text-muted-foreground">Pappu price asked (₹/kg)</Label>
              <Input
                id="pappu-price"
                type="number"
                min="0"
                step="0.5"
                value={pappuPriceInput}
                onChange={(e) => setPappuPriceInput(e.target.value)}
                placeholder="e.g. 42 (optional)"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tonnage" className="text-xs text-muted-foreground">Tonnage asked (MT)</Label>
              <Input
                id="tonnage"
                type="number"
                min="0"
                step="0.5"
                value={tonnageInput}
                onChange={(e) => setTonnageInput(e.target.value)}
                placeholder="e.g. 30"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="freight" className="text-xs text-muted-foreground">Freight</Label>
              <Select value={freightId} onValueChange={setFreightId}>
                <SelectTrigger id="freight">
                  <SelectValue placeholder="No freight" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No freight</SelectItem>
                  {freightRates?.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.destination} — {rupees(r.ratePerTonne)}/t
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="planner-basis" className="text-xs text-muted-foreground">Plan Against</Label>
              <Select value={plannerBasis} onValueChange={(val: any) => setPlannerBasis(val)}>
                <SelectTrigger id="planner-basis">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="COMMITTED">Committed Pappu</SelectItem>
                  <SelectItem value="AVAILABLE">Available Pappu</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {hasPrice && freightPerKg > 0 && (
            <p className="text-xs text-muted-foreground">
              Pappu ₹{basePappuPrice.toFixed(2)} − freight {rupees(freightPerKg)}/kg ({rupees(selectedFreight!.ratePerTonne)}/t to {selectedFreight!.destination}) ={' '}
              <span className="font-semibold text-foreground">{rupees(pappuPrice)}/kg net</span>
            </p>
          )}

          {!hasPrice && !hasTonnage && (
            <p className="text-sm text-muted-foreground">Enter a pappu price or tonnage to plan an order.</p>
          )}

          {(hasPrice || hasTonnage) && !plan && (
            <p className="text-sm text-muted-foreground">No black-seed stock at process to plan against.</p>
          )}

          {plan && (
            <div className="space-y-4">
              {/* Mapping line */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                {plan.isAllStock ? (
                  <span>Planning against <span className="font-bold text-foreground">ALL</span> available stock (no price limit)</span>
                ) : (
                  <>
                    <span>Pappu ₹{pappuPrice.toFixed(2)}/kg{freightPerKg > 0 ? ' (net of freight)' : ''}</span>
                    <ArrowDownRight className="h-4 w-4" />
                    <span>fulfilled from all seed at ≤</span>
                    <Badge variant="outline" className="bg-primary/5 text-primary border-primary/20 font-bold">
                      {rupees(plan.ceilingBlackPrice)}/kg
                    </Badge>
                  </>
                )}
                <span>
                  · {plan.eligibleCount} band{plan.eligibleCount === 1 ? '' : 's'}
                  {plan.availableBlackKg > 0 && <> · avg cost {rupees(plan.wacPappuCost)}/kg pappu</>}
                </span>
              </div>

              {/* Result tiles */}
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <div className="rounded-lg border p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    <Wheat className="h-3 w-3" /> {plannerBasis === 'COMMITTED' ? 'Committed Pappu' : 'Available Pappu'}
                  </div>
                  <div className="text-xl font-bold text-sky-600 mt-1">{toTonnes(plan.poolPappu).toFixed(2)} MT</div>
                  <div className="text-[10px] text-muted-foreground">from {toTonnes(plan.availableBlackKg).toFixed(2)} MT seed · {plan.eligibleCount} band{plan.eligibleCount === 1 ? '' : 's'} {plan.isAllStock ? '' : `≤ ${rupees(plan.ceilingBlackPrice)}`}</div>
                  {plannerBasis === 'COMMITTED' && plan.poolPending > 0 && (
                    <div className="text-[9px] text-sky-600/70 mt-1 font-medium">
                      includes {toTonnes(plan.poolPending).toFixed(2)} MT from pending POs in these {plan.eligibleCount} bands
                    </div>
                  )}
                </div>

                <div className="rounded-lg border p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    <Scale className="h-3 w-3" /> Asked
                  </div>
                  <div className="text-xl font-bold mt-1">{hasTonnage ? `${tonnage.toFixed(2)} MT` : '—'}</div>
                  <div className="text-[10px] text-muted-foreground">{hasTonnage ? `needs ${toTonnes(plan.blackRequiredKg).toFixed(2)} MT seed` : 'enter tonnage'}</div>
                </div>

                {/* Shortage / Excess — the headline */}
                {hasTonnage ? (
                  shortage > 0 ? (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-rose-600 flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" /> Shortage
                      </div>
                      <div className="text-xl font-bold text-rose-600 mt-1">{toTonnes(shortage).toFixed(2)} MT</div>
                      <div className="text-[10px] text-rose-600/80">short of the {tonnage.toFixed(2)} MT order</div>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600 flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3" /> Excess
                      </div>
                      <div className="text-xl font-bold text-emerald-600 mt-1">{toTonnes(excess).toFixed(2)} MT</div>
                      <div className="text-[10px] text-emerald-600/80">spare pappu after the order</div>
                    </div>
                  )
                ) : (
                  <div className="rounded-lg border p-3">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Shortage / Excess</div>
                    <div className="text-xl font-bold mt-1 text-muted-foreground">—</div>
                    <div className="text-[10px] text-muted-foreground">enter tonnage</div>
                  </div>
                )}

                {/* Black seed needed to cover a shortage */}
                <div className={`rounded-lg border p-3 ${hasTonnage && shortage > 0 ? 'border-rose-200 bg-rose-50' : ''}`}>
                  <div className={`text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 ${hasTonnage && shortage > 0 ? 'text-rose-600' : 'text-muted-foreground'}`}>
                    <Factory className="h-3 w-3" /> Seed Needed
                  </div>
                  <div className={`text-xl font-bold mt-1 ${hasTonnage && shortage > 0 ? 'text-rose-600' : 'text-muted-foreground'}`}>
                    {hasTonnage ? (shortage > 0 ? `${toTonnes(plan.seedShortfallKg).toFixed(2)} MT` : '0.00 MT') : '—'}
                  </div>
                  <div className={`text-[10px] ${hasTonnage && shortage > 0 ? 'text-rose-600/80' : 'text-muted-foreground'}`}>
                    {hasTonnage ? (shortage > 0 ? 'extra black seed to source' : 'order fully covered') : 'enter tonnage'}
                  </div>
                </div>

                {/* Margin */}
                <div className="rounded-lg border p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    {plan.marginPerKg >= 0 ? <ArrowUpRight className="h-3 w-3 text-emerald-500" /> : <ArrowDownRight className="h-3 w-3 text-rose-500" />} Margin
                  </div>
                  <div className={`text-xl font-bold mt-1 ${plan.availableBlackKg === 0 ? 'text-muted-foreground' : plan.marginPerKg >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {plan.availableBlackKg === 0 ? '—' : `${plan.marginPerKg >= 0 ? '+' : ''}${rupees(plan.marginPerKg)}/kg`}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {plan.availableBlackKg > 0 ? `sell − avg cost ${rupees(plan.wacPappuCost)}/kg` : 'no eligible stock'}
                  </div>
                </div>
              </div>

              {/* Fulfillment + cumulative hint */}
              {hasTonnage && (
                <div className="space-y-2 max-w-xl">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Fulfilment from eligible stock</span>
                    <span className="font-semibold">{plan.fulfillmentPct.toFixed(0)}%</span>
                  </div>
                  <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
                    <div
                      className={`h-full ${shortage > 0 ? 'bg-rose-500' : 'bg-emerald-500'}`}
                      style={{ width: `${plan.fulfillmentPct}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* At-process summary */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Weighted Avg</CardTitle>
            <Tag className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{rupees(overallWacBlack)}/kg</div>
            <p className="text-[10px] text-muted-foreground mt-1">Implies {rupees(overallWacPappu)}/kg pappu cost</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Black Seed Remaining</CardTitle>
            <Factory className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${totalBlackKg < 0 ? 'text-rose-600' : 'text-amber-600'}`}>{toTonnes(totalBlackKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">net of commitments · {toTonnes(totalReceivedKg).toFixed(2)} MT arrived</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Available Pappu</CardTitle>
            <Wheat className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${totalAvailablePappuKg < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{toTonnes(totalAvailablePappuKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">
              Net from arrived seed − allocated orders · +{toTonnes(totalBufferPappuKg).toFixed(2)} MT pappu buffer
              {totalShortfallPappuKg > 0 && <span className="block text-rose-600 font-medium">⚠ {toTonnes(totalShortfallPappuKg).toFixed(2)} MT shortfall deficit</span>}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Committed Black Seed</CardTitle>
            <Factory className="h-4 w-4 text-indigo-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-indigo-600">{toTonnes(committedBlackSeedKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">Remaining + pending (w/ 20% buffer deducted)</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Committed Pappu</CardTitle>
            <Wheat className="h-4 w-4 text-sky-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-sky-600">{toTonnes(totalCommittedPappuKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">Available + pending PO pappu</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Committed Orders</CardTitle>
            <Factory className="h-4 w-4 text-rose-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-rose-600">{toTonnes(totalAllocatedPappuKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">
              Pappu promised to sale orders
              {totalDeficitPappuKg > 0 && <span className="block text-rose-600 font-medium">⚠ {toTonnes(totalDeficitPappuKg).toFixed(2)} MT deficit (over-committed)</span>}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Filter */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1 flex-1 min-w-52">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search price, party, lorry or PO…"
              className="pl-8"
            />
          </div>
        </div>
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline pb-2.5"
          >
            Clear
          </button>
        )}
      </div>

      {/* Price-band table */}
      <div className="rounded-lg border bg-card overflow-auto max-h-[70vh]">
        <Table>
          <TableHeader className="sticky top-0 z-10">
            <TableRow className="bg-card border-b">
              <TableHead className="w-10"></TableHead>
              <TableHead>Black Seed Price</TableHead>
              <TableHead>Implied Pappu Price</TableHead>
              <TableHead className="text-right">Lorries</TableHead>
              <TableHead className="text-right">Black Seed Remaining</TableHead>
              <TableHead className="text-right">Committed (MT)</TableHead>
              <TableHead className="text-right">Available Pappu (MT)</TableHead>
              <TableHead className="text-right">Valuation</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                  {bands.length === 0
                    ? 'No black seed ordered yet. Create Purchase Orders to add stock.'
                    : 'No price bands match the filter.'}
                </TableCell>
              </TableRow>
            )}
            {visible.map((b) => {
              const key = b.blackPricePerKg.toFixed(2);
              const isOpen = expanded.has(key);
              const isEligible = plan && !plan.isAllStock ? b.blackPricePerKg <= plan.ceilingBlackPrice + 1e-6 : false;
              return (
                <Fragment key={key}>
                  <TableRow
                    className={`hover:bg-muted/50 cursor-pointer font-medium ${isEligible ? 'bg-primary/5' : ''}`}
                    onClick={() => toggle(key)}
                  >
                    <TableCell className="p-3 text-center">
                      {isOpen ? <ChevronDown className="h-4 w-4 mx-auto text-muted-foreground" /> : <ChevronRight className="h-4 w-4 mx-auto text-muted-foreground" />}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="bg-primary/5 text-primary border-primary/20 text-xs font-extrabold px-2 py-0.5">
                        {rupees(b.blackPricePerKg)}/kg
                      </Badge>
                      {isEligible && <Badge className="ml-2 text-[10px]">Eligible</Badge>}
                    </TableCell>
                    <TableCell className="font-semibold text-foreground">{rupees(b.impliedPappuPrice)}/kg</TableCell>
                    <TableCell className="text-right font-medium">{b.lorries}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-col items-end gap-1">
                        <span className={`text-sm font-bold ${b.arrivedRemainingKg < 0 ? 'text-rose-600' : 'text-foreground'}`}>
                          {toTonnes(b.arrivedRemainingKg).toFixed(2)} MT
                        </span>
                        {b.arrivedRemainingKg < 0 && (
                          <Badge variant="outline" className="text-[9px] h-4 px-1.5 bg-rose-50 text-rose-600 border-rose-200 font-medium rounded-sm shadow-none">
                            deficit
                          </Badge>
                        )}
                        {b.shortfallBlackKg > 0 && (
                          <Badge variant="outline" className="text-[9px] h-4 px-1.5 bg-rose-50 text-rose-600 border-rose-200 font-medium rounded-sm shadow-none">
                            − {toTonnes(b.shortfallBlackKg).toFixed(2)} MT short
                          </Badge>
                        )}
                        {b.pendingBlackKg > 0 && (
                          <Badge variant="outline" className="text-[9px] h-4 px-1.5 bg-amber-50 text-amber-700 border-amber-200 font-medium rounded-sm shadow-none">
                            + {toTonnes(b.pendingBlackKg).toFixed(2)} MT pending POs
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-medium text-rose-600">
                      {b.allocatedPappuKg > 0 ? `${toTonnes(b.allocatedPappuKg).toFixed(2)} MT` : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-col items-end gap-1">
                        <span className={`text-sm font-bold ${b.availablePappuKg < 0 ? 'text-rose-600' : 'text-sky-600'}`}>
                          {toTonnes(b.availablePappuKg).toFixed(2)} MT
                        </span>
                        {b.shortfallPappuKg > 0 && (
                          <Badge variant="outline" className="text-[9px] h-4 px-1.5 bg-rose-50 text-rose-600 border-rose-200 font-medium rounded-sm shadow-none">
                            − {toTonnes(b.shortfallPappuKg).toFixed(2)} MT deficit
                          </Badge>
                        )}
                        {plannerBasis === 'COMMITTED' && b.pendingBlackKg > 0 && (
                          <Badge variant="outline" className="text-[9px] h-4 px-1.5 bg-amber-50 text-amber-700 border-amber-200 font-medium rounded-sm shadow-none">
                            + {toTonnes(b.committedPappuKg - b.availablePappuKg).toFixed(2)} MT pending
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-semibold text-emerald-600">{rupees(b.value)}</TableCell>
                  </TableRow>

                  {isOpen && (
                    <TableRow className="bg-muted/10 hover:bg-muted/10">
                      <TableCell colSpan={8} className="p-4 pl-12">
                        <div className="rounded-lg border bg-card p-4 shadow-sm">
                          <div className="flex items-center justify-between border-b pb-2 mb-2">
                            <span className="font-bold text-xs text-muted-foreground uppercase tracking-wider">
                              Lots at {rupees(b.blackPricePerKg)}/kg
                            </span>
                            <span className="text-xs text-muted-foreground font-semibold">
                              {b.lorries} lorry(s)
                              {plannerBasis === 'COMMITTED' && b.pendingBlackKg > 0 && <span className="text-amber-600"> · {toTonnes(b.pendingBlackKg).toFixed(2)} MT pending</span>}
                              {b.shortfallBlackKg > 0 && <span className="text-rose-600"> · {toTonnes(b.shortfallBlackKg).toFixed(2)} MT short</span>}
                            </span>
                          </div>
                          <div className="overflow-x-auto">
                            <Table>
                              <TableHeader className="bg-muted/40">
                                <TableRow className="hover:bg-transparent">
                                  <TableHead className="h-8 py-1 text-xs">Date</TableHead>
                                  <TableHead className="h-8 py-1 text-xs">Party</TableHead>
                                  <TableHead className="h-8 py-1 text-xs">Lorry</TableHead>
                                  <TableHead className="h-8 py-1 text-xs">PO</TableHead>
                                  <TableHead className="h-8 py-1 text-xs">Type</TableHead>
                                  <TableHead className="h-8 py-1 text-xs text-right">Remaining Seed</TableHead>
                                  <TableHead className="h-8 py-1 text-xs text-right">Gross Sold</TableHead>
                                  <TableHead className="h-8 py-1 text-xs text-right">Remaining Pappu</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {b.lots
                                  .filter((l) => plannerBasis === 'COMMITTED' || l.kind !== 'PENDING')
                                  .map((l) => {
                                  const isArrived = l.kind === 'ARRIVED';
                                  const isShortfall = l.kind === 'SHORTFALL';
                                  const consumable = Math.round(l.receivedKg * (isArrived ? PAPPU_OUTTURN : SEED_TO_CONSUMABLE));
                                  // The DB stores receivedKg and soldKg as Gross Seed.
                                  // Buffer is calculated only on the remaining seed (receivedKg).
                                  const bufferBlack = (isArrived || isShortfall) ? 0 : Math.round(l.receivedKg * (1 - PAPPU_CONSUMABLE));
                                  const bufferPappu = (isArrived || isShortfall) ? 0 : Math.round(l.receivedKg * PAPPU_OUTTURN * (1 - PAPPU_CONSUMABLE));
                                  
                                  // For arrived, no buffer is deducted. For pending, 20% is deducted.
                                  // For shortfall, we just show the raw gross gap.
                                  const netRemainingSeed = isShortfall ? l.receivedKg : Math.round(l.receivedKg * (isArrived ? 1 : PAPPU_CONSUMABLE));
                                  const netSoldSeed = l.soldKg; // We now show Gross Sold for all to avoid confusion
                                  // Per-lot shortfall deficit
                                  const gapPappu = l.receivedKg * PAPPU_OUTTURN;
                                  const lotBuffer = l.orderedKg * PAPPU_OUTTURN * (1 - PAPPU_CONSUMABLE);
                                  const deficit = Math.round(Math.max(0, gapPappu - lotBuffer));
                                  return (
                                    <TableRow key={l.purchaseId} className="hover:bg-muted/20">
                                      <TableCell className="py-2 text-xs">{shortDate(l.date)}</TableCell>
                                      <TableCell className="py-2 text-xs font-medium text-foreground">{l.partyName}</TableCell>
                                      <TableCell className="py-2 text-xs font-mono">{l.lorryNumber || '—'}</TableCell>
                                      <TableCell className="py-2 text-xs font-mono">{l.poNumber || '—'}</TableCell>
                                      <TableCell className="py-2 text-xs">
                                        {l.kind === 'ARRIVED' && <Badge variant="outline" className="text-[10px] border-emerald-200 text-emerald-700 bg-emerald-50">Arrived</Badge>}
                                        {l.kind === 'PENDING' && <Badge variant="outline" className="text-[10px] border-amber-200 text-amber-700 bg-amber-50">Pending</Badge>}
                                        {l.kind === 'SHORTFALL' && <Badge variant="outline" className="text-[10px] border-rose-200 text-rose-700 bg-rose-50">Short</Badge>}
                                      </TableCell>
                                      <TableCell className="py-2 text-xs text-right font-semibold">
                                        {l.kind === 'SHORTFALL' ? (
                                          <span className="text-rose-600">−{kg(l.receivedKg)}</span>
                                        ) : (
                                          kg(netRemainingSeed)
                                        )}
                                        {l.kind === 'SHORTFALL' ? (
                                          <span className="block text-[10px] text-muted-foreground font-normal">of {kg(l.orderedKg)} ordered</span>
                                        ) : l.kind === 'PENDING' && bufferBlack > 0 ? (
                                          <span className="block text-[10px] text-muted-foreground font-normal">+{kg(bufferBlack)} seed buffer</span>
                                        ) : null}
                                      </TableCell>
                                      <TableCell className="py-2 text-xs text-right text-muted-foreground">
                                        {l.soldKg > 0 ? kg(netSoldSeed) : '—'}
                                      </TableCell>
                                      <TableCell className="py-2 text-xs text-right font-semibold">
                                        {l.kind === 'SHORTFALL' ? (
                                          <span className="text-rose-600">−{kg(gapPappu)}</span>
                                        ) : (
                                          <>
                                            <span className={l.kind === 'PENDING' ? 'text-amber-600' : 'text-sky-600'}>{kg(consumable)}</span>
                                            {l.kind === 'PENDING' && bufferPappu > 0 && (
                                              <span className="block text-[10px] text-muted-foreground font-normal">+{kg(bufferPappu)} pappu buffer</span>
                                            )}
                                          </>
                                        )}
                                      </TableCell>
                                    </TableRow>
                                  );
                                })}
                              </TableBody>
                            </Table>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
