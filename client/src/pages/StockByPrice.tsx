import { Fragment, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Loader2, Search, Tag, Factory, Wheat, Calculator,
  ArrowUpRight, ArrowDownRight, AlertTriangle, CheckCircle2,
  ChevronRight, ChevronDown, Scale, Truck, Target, TrendingUp, TrendingDown,
  Leaf,
} from 'lucide-react';
import { api } from '@/lib/api';
import { stockSummary } from '@/lib/calc';
import type { FreightRate } from '@/lib/types';
import { kg, rupees, shortDate, toTonnes } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { usePagedRows } from '@/lib/usePagedRows';
import { ExportButtons } from '@/components/ExportButtons';
import { PageHeader } from '@/components/PageHeader';
import { ExpandPanel, PanelLabel, PanelStack, PanelCard, PanelTitle, PanelMeta, PanelDot, Figure } from '@/components/ExpandPanel';
import { cn } from '@/lib/utils';
import type { ExportColumn } from '@/lib/export';

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
  // Which sale orders drew this lot's seed (date-aware allocation), for traceability.
  consumedBy?: { saleDate: string; buyer: string; seedKg: number }[];
}

interface PriceBandResponse {
  blackPricePerKg: number;
  lorries: number;
  arrivedBlackKg: number; // gross arrived (at RVP)
  allocatedPappuKg: number; // consumable pappu this band supplied to sales (the debit)
  remainingBlackKg: number; // arrived seed left after sales draw-down (≥ 0)
  remainingValue: number;
  pendingBlackKg: number; // still-coming (open PO) seed left after draw-down
  pendingConsumableBlackKg: number; // the consumable portion of the still-coming seed
  pendingBufferBlackKg: number; // the buffer portion of the still-coming seed
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
  pendingConsumableBlackKg: number; // the consumable portion of the still-coming seed
  pendingBufferBlackKg: number; // the buffer portion of the still-coming seed
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
 * Stock by Price - a pappu order planner driven by the black-seed cost basis.
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
  const [processingChargeInput, setProcessingChargeInput] = useState('');
  const [huskPriceInput, setHuskPriceInput] = useState('');
  const [showProcessingSection, setShowProcessingSection] = useState(true);

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

  const freightOptions = useMemo<ComboOption[]>(() => {
    const list: ComboOption[] = [{ value: '__none__', label: 'No freight' }];
    if (freightRates) {
      for (const r of freightRates) {
        list.push({
          value: r.id,
          label: `${r.destination} - ${rupees(r.ratePerTonne)}/t`,
          hint: `${rupees(Number(r.ratePerTonne) / 1000)}/kg`,
        });
      }
    }
    return list;
  }, [freightRates]);

  // Processing & husk defaults - same endpoint PappuCalculator uses
  const { data: calcDefaults, isSuccess: calcDefaultsLoaded } = useQuery({
    queryKey: ['calculator-defaults'],
    queryFn: () => api<{ blackSeedPrice: number; millingCost: number; huskPrice: number; wastePrice: number }>('/inventory/calculator-defaults'),
  });

  useEffect(() => {
    if (calcDefaultsLoaded && calcDefaults) {
      setProcessingChargeInput(String(calcDefaults.millingCost));
      setHuskPriceInput(String(calcDefaults.huskPrice));
    }
  }, [calcDefaultsLoaded, calcDefaults]);

  const processingChargePerKg = Number(processingChargeInput) || 0;
  const huskPricePerKg = Number(huskPriceInput) || 0;
  const HUSK_YIELD = 0.25; // 25% of black seed becomes husk

  // Map the server's bands. Pappu figures are CONSUMABLE (sellable) pappu.
  const bands = useMemo<PriceBand[]>(() => {
    return (data?.bands ?? []).map((b) => {
      // Available = consumable pappu on arrived seed left after sales (no buffer).
      // Committed = available + consumable pappu on still-coming (pending) seed (has 20% buffer).
      // Available and Committed are calculated at the bottom using the updated buffer logic.
      
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

        const availablePappuKg = b.remainingBlackKg * PAPPU_OUTTURN;
        // Pending buffer is completely separated; we only count the consumable portion
        const committedPappuKg = availablePappuKg + b.pendingConsumableBlackKg * PAPPU_OUTTURN;
        const bufferPappuKg = remainingBufferBlackKg * PAPPU_OUTTURN;
        const bufferBlackKg = remainingBufferBlackKg + b.pendingBufferBlackKg;

        return {
          blackPricePerKg: b.blackPricePerKg,
          impliedPappuPrice: b.blackPricePerKg / PAPPU_OUTTURN,
          lorries: b.lorries,
          arrivedRemainingKg: b.remainingBlackKg,
          arrivedGrossKg: b.arrivedBlackKg,
          allocatedPappuKg: b.allocatedPappuKg,
          pendingBlackKg: b.pendingBlackKg,
          pendingConsumableBlackKg: b.pendingConsumableBlackKg,
          pendingBufferBlackKg: b.pendingBufferBlackKg,
          shortfallBlackKg: finalShortfallBlackKg,
          availablePappuKg,
          committedPappuKg,
          bufferBlackKg,
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
    // All bands participate — the sale engine draws top (dearest) to bottom
    // regardless of price, so the planner must match that behaviour.
    // ceilingBlackPrice is kept as a display-only reference for the "Eligible" badge.
    const ceilingBlackPrice = hasPrice ? pappuPrice * PAPPU_OUTTURN : Infinity;
    const eligible = bands;

    // Two distinct bases - both now use the unified allocation's remaining values:
    //  • AVAILABLE - arrived seed only (what can be milled and shipped today).
    //  • COMMITTED - arrived + pending seed (includes still-coming PO seed).
    // The unified allocation already drew sales expensive-first across both arrived
    // and pending, so remaining values correctly reflect what's left.
    const useCommitted = plannerBasis === 'COMMITTED';
    const availableBlackKg = eligible.reduce((s, b) => s + (useCommitted
      ? b.arrivedRemainingKg + b.pendingBlackKg // Gross weight because b.pendingValue is gross value
      : b.arrivedRemainingKg), 0);
    const poolPappu = eligible.reduce((s, b) => s + (useCommitted
      ? b.committedPappuKg
      : b.availablePappuKg), 0);
    const poolPendingPappu = eligible.reduce((s, b) => s + (b.pendingConsumableBlackKg * PAPPU_OUTTURN), 0);
    const eligibleValue = eligible.reduce((s, b) => s + (useCommitted
      ? b.value + b.pendingValue
      : b.value), 0);
    const wacBlack = availableBlackKg > 0 ? eligibleValue / availableBlackKg : 0; // pool weighted-avg seed cost (valuation only)
    const wacPappuCost = wacBlack / PAPPU_OUTTURN; // pool weighted-avg cost per sellable kg (valuation only)
    const askedPappuKg = hasTonnage ? tonnage * 1000 : 0;

    // Margin is costed DEAREST-FIRST, exactly like a real sale and the per-order P/L
    // page (computePappuOrderMargins): a sale eats the most-expensive eligible seed
    // first, so the margin reflects the TRUE realisation - NOT the optimistic blended
    // pool average, which mixes in cheaper seed the depletion wouldn't leave for this
    // order. With no tonnage entered we draw the whole eligible pool (= the blend).
    const seedNeededKg = hasTonnage ? askedPappuKg / PAPPU_OUTTURN : Infinity;
    let seedLeftToDraw = seedNeededKg;
    let drawnBlackKg = 0;
    let drawnBlackCost = 0;
    for (const b of [...eligible].sort((a, z) => z.blackPricePerKg - a.blackPricePerKg)) {
      if (seedLeftToDraw <= 1e-6) break;
      const bandSeedKg = Math.max(0, useCommitted ? b.arrivedRemainingKg + b.pendingBlackKg : b.arrivedRemainingKg);
      if (bandSeedKg <= 0) continue;
      const take = Math.min(seedLeftToDraw, bandSeedKg);
      drawnBlackKg += take;
      drawnBlackCost += take * b.blackPricePerKg;
      seedLeftToDraw -= take;
    }
    const realizedWacBlack = drawnBlackKg > 0 ? drawnBlackCost / drawnBlackKg : wacBlack;
    const realizedPappuCost = realizedWacBlack / PAPPU_OUTTURN; // dearest-first cost per sellable kg

    // How much black seed is needed for the asked tonnage if bought fresh?
    const blackRequiredKg = askedPappuKg / SEED_TO_CONSUMABLE;
    const diff = poolPappu - askedPappuKg; // + excess, − shortage
    // Extra black seed to source if the eligible stock can't cover the order.
    // Shortage is covered by NEW seed, which yields 0.48 (because it's pending).
    const seedShortfallKg = diff < 0 ? (-diff) / SEED_TO_CONSUMABLE : 0;
    const fulfillmentPct = askedPappuKg > 0 ? Math.min(100, (poolPappu / askedPappuKg) * 100) : 100;
    const marginPerKg = hasPrice ? pappuPrice - realizedPappuCost : 0; // pappu sell − dearest-first pappu cost

    // ─── Minimum Profitable Quantity (Break-Even Tonnage) ───────────────────
    // When selling dearest-first at pappuPrice, earlier kg incur loss if the dearest band
    // implied cost > pappuPrice. We determine the exact seed & pappu volume required to reach break-even (profit >= 0).
    type MinProfitStatus = 'ANY_QUANTITY' | 'ACHIEVABLE' | 'NOT_ACHIEVABLE' | 'NO_PRICE';
    let minProfitStatus: MinProfitStatus = 'NO_PRICE';
    let minProfitablePappuKg: number | null = null;
    let minProfitableSeedKg: number | null = null;

    if (hasPrice && pappuPrice > 0) {
      const sortedEligible = [...eligible]
        .map((b) => ({
          blackPricePerKg: b.blackPricePerKg,
          seedKg: Math.max(0, useCommitted ? b.arrivedRemainingKg + b.pendingBlackKg : b.arrivedRemainingKg),
          impliedPappuCost: b.blackPricePerKg / PAPPU_OUTTURN,
        }))
        .filter((b) => b.seedKg > 0)
        .sort((a, z) => z.blackPricePerKg - a.blackPricePerKg);

      if (sortedEligible.length === 0) {
        minProfitStatus = 'NOT_ACHIEVABLE';
      } else if (sortedEligible[0].impliedPappuCost <= pappuPrice) {
        // Even the highest-cost band in stock is profitable at this net selling price!
        minProfitStatus = 'ANY_QUANTITY';
        minProfitablePappuKg = 0;
        minProfitableSeedKg = 0;
      } else {
        // Dearest band is loss-making. Accumulate through bands to find break-even point.
        let accumSeed = 0;
        let accumCost = 0;
        let foundBreakEven = false;

        for (const band of sortedEligible) {
          const marginalSeedProfit = (pappuPrice * PAPPU_OUTTURN) - band.blackPricePerKg;

          if (marginalSeedProfit > 0) {
            // Prior accumulated loss before drawing into this profitable band:
            const prevLoss = accumCost - (accumSeed * PAPPU_OUTTURN * pappuPrice);

            if (prevLoss <= 1e-6) {
              // Already broke even
              minProfitableSeedKg = accumSeed;
              minProfitablePappuKg = accumSeed * PAPPU_OUTTURN;
              foundBreakEven = true;
              break;
            }

            // Seed needed from current band to offset accumulated loss:
            const neededSeedFromBand = prevLoss / marginalSeedProfit;

            if (neededSeedFromBand <= band.seedKg + 1e-6) {
              minProfitableSeedKg = accumSeed + Math.min(neededSeedFromBand, band.seedKg);
              minProfitablePappuKg = minProfitableSeedKg * PAPPU_OUTTURN;
              foundBreakEven = true;
              break;
            }
          }

          // Accumulate band
          accumSeed += band.seedKg;
          accumCost += band.seedKg * band.blackPricePerKg;
        }

        if (foundBreakEven) {
          minProfitStatus = 'ACHIEVABLE';
        } else {
          // Even drawing 100% of the pool does not reach break-even
          minProfitStatus = 'NOT_ACHIEVABLE';
        }
      }
    }

    const orderTotalProfit = hasTonnage && hasPrice ? askedPappuKg * marginPerKg : null;

    return {
      ceilingBlackPrice, eligibleCount: eligible.length, availableBlackKg,
      poolPappu, poolPendingPappu, wacBlack, wacPappuCost, realizedWacBlack, realizedPappuCost,
      askedPappuKg, blackRequiredKg, seedShortfallKg, diff, fulfillmentPct, marginPerKg,
      minProfitStatus, minProfitablePappuKg, minProfitableSeedKg, orderTotalProfit,
    };
  }, [bands, pappuPrice, tonnage, hasPrice, hasTonnage, plannerBasis]);

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  // At-process totals come from the shared stockSummary() roll-up over the same
  // /inventory/by-price bands the RVP Black Seed Stock page reads, so Arrived /
  // Remaining / Committed / Available Pappu agree to the kg on both pages.
  // Remaining is ARRIVED-only: seed a sale drew from a still-coming PENDING PO
  // is debited off the pending pool instead, never off physical stock at the mill.
  const summary = stockSummary(data?.bands ?? []);
  const totalBlackKg = summary.remainingBlackKg;
  const totalReceivedKg = summary.arrivedBlackKg;
  const totalPendingConsumableBlackKg = summary.pendingConsumableBlackKg;
  const committedBlackKg = summary.committedBlackKg;
      // Valuation counts bands with positive net stock + pending stock
  const totalValue = bands.reduce((s, b) => s + Math.max(0, b.value) + Math.max(0, b.pendingValue), 0);
  const totalPositiveBlackKg = bands.reduce((s, b) => s + Math.max(0, b.arrivedRemainingKg) + Math.max(0, b.pendingBlackKg), 0);
  const overallWacBlack = totalPositiveBlackKg > 0 ? totalValue / totalPositiveBlackKg : 0;
  const overallWacPappu = overallWacBlack / PAPPU_OUTTURN;

  // All bands always participate, so the pool WAC matches the overall WAC.
  const displayedWacBlack = overallWacBlack;
  const displayedWacPappu = overallWacPappu;
  // Adjusted implied pappu cost factoring processing charge + husk recovery
  const adjustedWacPappu = (overallWacBlack + processingChargePerKg - (HUSK_YIELD * huskPricePerKg)) / PAPPU_OUTTURN;

  // ─── Processing & Husk Recovery breakdown (for tonnage-based calculator) ───
  const processingBreakdown = useMemo(() => {
    if (!hasTonnage) return null;
    const pappuKg = tonnage * 1000;
    const seedKg = pappuKg / PAPPU_OUTTURN;
    const huskKg = seedKg * HUSK_YIELD;
    const huskValue = huskKg * huskPricePerKg;
    const processingCost = seedKg * processingChargePerKg;
    // Use the plan's realized WAC (dearest-first) if available, else overall WAC
    const seedCostPerKg = plan?.realizedWacBlack ?? overallWacBlack;
    const seedCost = seedKg * seedCostPerKg;
    const grossCost = seedCost + processingCost;
    const netCost = Math.max(0, grossCost - huskValue);
    const effectivePappuPerKg = pappuKg > 0 ? netCost / pappuKg : 0;
    return {
      pappuKg, seedKg, huskKg, huskValue,
      processingCost, seedCostPerKg, seedCost,
      grossCost, netCost, effectivePappuPerKg,
    };
  }, [tonnage, hasTonnage, processingChargePerKg, huskPricePerKg, plan, overallWacBlack]);

      
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
  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows: pagedBands = [] } = usePagedRows(visible, 50);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const shortage = plan && plan.diff < 0 ? -plan.diff : 0;
  const excess = plan && plan.diff > 0 ? plan.diff : 0;

  const priceBandColumns: ExportColumn<PriceBand>[] = [
    { header: 'Black Seed Price', value: (b) => rupees(b.blackPricePerKg), excel: (b) => b.blackPricePerKg, numFmt: '#,##0.00', align: 'right' },
    { header: 'Implied Pappu Price', value: (b) => rupees(b.impliedPappuPrice), excel: (b) => b.impliedPappuPrice, numFmt: '#,##0.00', align: 'right' },
    { header: 'Lorries', value: (b) => b.lorries, align: 'right' },
    { header: 'Black Seed Remaining (MT)', value: (b) => toTonnes(b.arrivedRemainingKg).toFixed(2), excel: (b) => toTonnes(b.arrivedRemainingKg), numFmt: '#,##0.00', align: 'right' },
    { header: 'Pending POs (MT)', value: (b) => toTonnes(b.pendingBlackKg).toFixed(2), excel: (b) => toTonnes(b.pendingBlackKg), numFmt: '#,##0.00', align: 'right' },
    { header: 'Committed (MT)', value: (b) => toTonnes(b.allocatedPappuKg).toFixed(2), excel: (b) => toTonnes(b.allocatedPappuKg), numFmt: '#,##0.00', align: 'right' },
    { header: 'Available Pappu (MT)', value: (b) => toTonnes(b.availablePappuKg).toFixed(2), excel: (b) => toTonnes(b.availablePappuKg), numFmt: '#,##0.00', align: 'right' },
    { header: 'Valuation', value: (b) => rupees(b.value), excel: (b) => b.value, numFmt: '#,##0.00', align: 'right' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Order Planner"
        description="Inventory cost basis, price bands and lorry allocations"
        icon={Tag}
        actions={
          <ExportButtons
            filename="Stock_By_Price"
            title="Stock by Price (Order Planner)"
            subtitle={`${visible.length} band(s)`}
            columns={priceBandColumns}
            rows={visible}
          />
        }
      />

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
              <Label className="text-xs text-muted-foreground">Freight</Label>
              <Combobox
                options={freightOptions}
                value={freightId}
                onChange={setFreightId}
                placeholder="No freight"
                searchPlaceholder="Search destination or rate…"
                emptyText="No freight destination found."
              />
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
            <p className="text-sm text-muted-foreground">No black-seed stock at RVP to plan against.</p>
          )}

          {plan && (
            <div className="space-y-4">
              {/* Mapping line */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                {hasPrice ? (
                  <>
                    <span>Pappu ₹{pappuPrice.toFixed(2)}/kg{freightPerKg > 0 ? ' (net of freight)' : ''}</span>
                    <ArrowDownRight className="h-4 w-4" />
                    <span>drawing from <span className="font-bold text-foreground">ALL</span> stock, dearest first</span>
                  </>
                ) : (
                  <span>Planning against <span className="font-bold text-foreground">ALL</span> available stock (no price limit)</span>
                )}
                <span>
                  · {plan.eligibleCount} band{plan.eligibleCount === 1 ? '' : 's'}
                  {plan.availableBlackKg > 0 && <> · cost {rupees(plan.realizedPappuCost)}/kg pappu (dearest seed first)</>}
                </span>
              </div>

              {/* Result tiles */}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                <div className="rounded-lg border p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1" title={plannerBasis === 'COMMITTED' ? 'Committed Pappu = sellable pappu from arrived seed + still-coming (pending PO) seed, after existing sale commitments' : 'Available Pappu = sellable pappu from arrived seed only (what can be milled & shipped today)'}>
                    <Wheat className="h-3 w-3" /> {plannerBasis === 'COMMITTED' ? 'Committed Pappu' : 'Available Pappu'}
                  </div>
                  <div className="text-xl font-bold text-sky-600 mt-1">{toTonnes(plan.poolPappu).toFixed(2)} MT</div>
                  <div
                    className="text-[10px] text-muted-foreground"
                    title={plannerBasis === 'COMMITTED'
                      ? 'Arrived + pending seed left in the eligible bands after existing commitments are drawn off the dearest seed first (price-order). This can differ from the physical Black Seed Remaining, which is arrived-first.'
                      : 'Physical arrived seed left after commitments (arrived-first) - the same Black Seed Remaining shown below. Available Pappu = this seed × 0.6.'}
                  >
                    from {toTonnes(plan.availableBlackKg).toFixed(2)} MT total seed {plannerBasis === 'COMMITTED' ? '(dearest sold first)' : '(physical remaining)'} · {plan.eligibleCount} band{plan.eligibleCount === 1 ? '' : 's'}
                  </div>
                  {plannerBasis === 'COMMITTED' && plan.poolPendingPappu > 0 && (
                    <span className="text-muted-foreground block text-xs mt-1">
                      includes {toTonnes(plan.poolPendingPappu).toFixed(2)} MT of pappu from pending POs in these {plan.eligibleCount} bands
                    </span>
                  )}
                </div>

                <div className="rounded-lg border p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1" title="The tonnage (in Metric Tonnes) the customer is asking for">
                    <Scale className="h-3 w-3" /> Asked
                  </div>
                  <div className="text-xl font-bold mt-1">{hasTonnage ? `${tonnage.toFixed(2)} MT` : '-'}</div>
                  <div className="text-[10px] text-muted-foreground">{hasTonnage ? `needs ${toTonnes(plan.blackRequiredKg).toFixed(2)} MT seed` : 'enter tonnage'}</div>
                </div>

                {/* Min Qty to Profit / Break-Even Tonnage */}
                <div className={cn(
                  "rounded-lg border p-3 transition-colors",
                  hasPrice && plan.minProfitStatus === 'ACHIEVABLE' && hasTonnage && plan.askedPappuKg >= (plan.minProfitablePappuKg ?? 0) && "border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/20",
                  hasPrice && plan.minProfitStatus === 'ACHIEVABLE' && hasTonnage && plan.askedPappuKg < (plan.minProfitablePappuKg ?? 0) && "border-amber-200 bg-amber-50/50 dark:bg-amber-950/20",
                  hasPrice && plan.minProfitStatus === 'NOT_ACHIEVABLE' && "border-rose-200 bg-rose-50/50 dark:bg-rose-950/20"
                )}>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1" title="Minimum sellable pappu quantity (in MT) needed to break even or make profit after covering dearest stock costs">
                    <Target className="h-3 w-3 text-primary" /> Min Qty to Profit
                  </div>
                  <div className={cn(
                    "text-xl font-bold mt-1",
                    !hasPrice && "text-muted-foreground",
                    hasPrice && plan.minProfitStatus === 'ANY_QUANTITY' && "text-emerald-600",
                    hasPrice && plan.minProfitStatus === 'ACHIEVABLE' && (hasTonnage && plan.askedPappuKg >= (plan.minProfitablePappuKg ?? 0) ? "text-emerald-600" : "text-amber-600"),
                    hasPrice && plan.minProfitStatus === 'NOT_ACHIEVABLE' && "text-rose-600 text-lg"
                  )}>
                    {!hasPrice ? (
                      '-'
                    ) : plan.minProfitStatus === 'ANY_QUANTITY' ? (
                      '0.00 MT'
                    ) : plan.minProfitStatus === 'ACHIEVABLE' && plan.minProfitablePappuKg !== null ? (
                      `${toTonnes(plan.minProfitablePappuKg).toFixed(2)} MT`
                    ) : (
                      'Not Viable'
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {!hasPrice ? (
                      'enter pappu price'
                    ) : plan.minProfitStatus === 'ANY_QUANTITY' ? (
                      'profitable from 1st kg (all bands viable)'
                    ) : plan.minProfitStatus === 'ACHIEVABLE' && plan.minProfitableSeedKg !== null ? (
                      `break-even · needs ${toTonnes(plan.minProfitableSeedKg).toFixed(2)} MT seed`
                    ) : (
                      'pool avg cost > sell price'
                    )}
                  </div>
                </div>

                {/* Shortage / Excess - the headline */}
                {hasTonnage ? (
                  shortage > 0 ? (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-rose-600 flex items-center gap-1" title="Shortage = how much pappu you're short of to fulfil the asked order from eligible stock">
                        <AlertTriangle className="h-3 w-3" /> Shortage
                      </div>
                      <div className="text-xl font-bold text-rose-600 mt-1">{toTonnes(shortage).toFixed(2)} MT</div>
                      <div className="text-[10px] text-rose-600/80">short of the {tonnage.toFixed(2)} MT order</div>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600 flex items-center gap-1" title="Excess = spare pappu remaining after fulfilling the order">
                        <CheckCircle2 className="h-3 w-3" /> Excess
                      </div>
                      <div className="text-xl font-bold text-emerald-600 mt-1">{toTonnes(excess).toFixed(2)} MT</div>
                      <div className="text-[10px] text-emerald-600/80">spare pappu after the order</div>
                    </div>
                  )
                ) : (
                  <div className="rounded-lg border p-3">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Shortage / Excess</div>
                    <div className="text-xl font-bold mt-1 text-muted-foreground">-</div>
                    <div className="text-[10px] text-muted-foreground">enter tonnage</div>
                  </div>
                )}

                {/* Black seed needed to cover a shortage */}
                <div className={`rounded-lg border p-3 ${hasTonnage && shortage > 0 ? 'border-rose-200 bg-rose-50' : ''}`}>
                  <div className={`text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 ${hasTonnage && shortage > 0 ? 'text-rose-600' : 'text-muted-foreground'}`} title="Extra black seed (in MT) you'd need to buy from outside if your current eligible stock can't cover the order">
                    <Factory className="h-3 w-3" /> Seed Needed
                  </div>
                  <div className={`text-xl font-bold mt-1 ${hasTonnage && shortage > 0 ? 'text-rose-600' : 'text-muted-foreground'}`}>
                    {hasTonnage ? (shortage > 0 ? `${toTonnes(plan.seedShortfallKg).toFixed(2)} MT` : '0.00 MT') : '-'}
                  </div>
                  <div className={`text-[10px] ${hasTonnage && shortage > 0 ? 'text-rose-600/80' : 'text-muted-foreground'}`}>
                    {hasTonnage ? (shortage > 0 ? 'extra black seed to source' : 'order fully covered') : 'enter tonnage'}
                  </div>
                </div>

                {/* Margin */}
                <div className="rounded-lg border p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1" title="Margin per kg = Pappu sell price − pappu cost (costed dearest seed first). Positive = profit, Negative = loss">
                    {plan.marginPerKg >= 0 ? <ArrowUpRight className="h-3 w-3 text-emerald-500" /> : <ArrowDownRight className="h-3 w-3 text-rose-500" />} Margin
                  </div>
                  <div className={`text-xl font-bold mt-1 ${plan.availableBlackKg === 0 ? 'text-muted-foreground' : plan.marginPerKg >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {plan.availableBlackKg === 0 ? '-' : `${plan.marginPerKg >= 0 ? '+' : ''}${rupees(plan.marginPerKg)}/kg`}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {plan.availableBlackKg > 0 ? (
                      hasTonnage && plan.orderTotalProfit !== null ? (
                        <span className={cn("font-medium", plan.orderTotalProfit >= 0 ? "text-emerald-600" : "text-rose-600")}>
                          {plan.orderTotalProfit >= 0 ? '+' : ''}{rupees(plan.orderTotalProfit)} total {plan.orderTotalProfit >= 0 ? 'profit' : 'loss'}
                        </span>
                      ) : (
                        `sell − cost ${rupees(plan.realizedPappuCost)}/kg (dearest first)`
                      )
                    ) : (
                      'no eligible stock'
                    )}
                  </div>
                </div>
              </div>

              {/* Profitability insight banner */}
              {hasPrice && (
                <div className={cn(
                  "rounded-lg border p-3 text-xs flex items-start gap-2.5 shadow-xs",
                  plan.minProfitStatus === 'ANY_QUANTITY' && "border-emerald-200 bg-emerald-50/80 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200 dark:border-emerald-800",
                  plan.minProfitStatus === 'ACHIEVABLE' && (!hasTonnage || plan.askedPappuKg >= (plan.minProfitablePappuKg ?? 0)) && "border-emerald-200 bg-emerald-50/80 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200 dark:border-emerald-800",
                  plan.minProfitStatus === 'ACHIEVABLE' && hasTonnage && plan.askedPappuKg < (plan.minProfitablePappuKg ?? 0) && "border-amber-200 bg-amber-50/80 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200 dark:border-amber-800",
                  plan.minProfitStatus === 'NOT_ACHIEVABLE' && "border-rose-200 bg-rose-50/80 text-rose-900 dark:bg-rose-950/30 dark:text-rose-200 dark:border-rose-800"
                )}>
                  {plan.minProfitStatus === 'ANY_QUANTITY' ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-semibold">Fully Profitable at Any Quantity:</span> At {rupees(pappuPrice)}/kg net realization, every black seed band in stock is priced below your sell ceiling.
                        {hasTonnage && ` Your order of ${tonnage.toFixed(2)} MT yields a net profit of ${rupees(plan.orderTotalProfit ?? 0)} (+${rupees(plan.marginPerKg)}/kg).`}
                      </div>
                    </>
                  ) : plan.minProfitStatus === 'ACHIEVABLE' ? (
                    hasTonnage ? (
                      plan.askedPappuKg >= (plan.minProfitablePappuKg ?? 0) ? (
                        <>
                          <TrendingUp className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                          <div>
                            <span className="font-semibold">Order Exceeds Profitable Threshold:</span> Minimum quantity to break even is <span className="font-bold">{toTonnes(plan.minProfitablePappuKg ?? 0).toFixed(2)} MT</span>. Your order of <span className="font-bold">{tonnage.toFixed(2)} MT</span> blends sufficient lower-cost seed to achieve a net profit of <span className="font-bold text-emerald-700 dark:text-emerald-300">+{rupees(plan.orderTotalProfit ?? 0)}</span> (+{rupees(plan.marginPerKg)}/kg).
                          </div>
                        </>
                      ) : (
                        <>
                          <TrendingDown className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                          <div>
                            <span className="font-semibold">Below Minimum Profitable Quantity:</span> Drawing dearest seed first means an order of only <span className="font-bold">{tonnage.toFixed(2)} MT</span> incurs a loss of <span className="font-bold text-rose-600">{rupees(Math.abs(plan.orderTotalProfit ?? 0))}</span> ({rupees(plan.marginPerKg)}/kg). Sell at least <span className="font-bold text-amber-950 dark:text-amber-100">{toTonnes(plan.minProfitablePappuKg ?? 0).toFixed(2)} MT</span> (+{toTonnes((plan.minProfitablePappuKg ?? 0) - plan.askedPappuKg).toFixed(2)} MT more) to reach break-even / profit.
                          </div>
                        </>
                      )
                    ) : (
                      <>
                        <Target className="h-4 w-4 text-sky-600 shrink-0 mt-0.5" />
                        <div>
                          <span className="font-semibold">Minimum Quantity for Profit:</span> Because dearest seed is consumed first, you must sell at least <span className="font-bold text-sky-800 dark:text-sky-300">{toTonnes(plan.minProfitablePappuKg ?? 0).toFixed(2)} MT</span> of pappu ({toTonnes(plan.minProfitableSeedKg ?? 0).toFixed(2)} MT black seed) at {rupees(pappuPrice)}/kg net to absorb high-cost bands and achieve a profitable order.
                        </div>
                      </>
                    )
                  ) : (
                    <>
                      <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-semibold">Unprofitable Price:</span> The overall weighted average cost of the stock pool ({rupees(plan.realizedPappuCost)}/kg) exceeds the net selling price ({rupees(pappuPrice)}/kg). This order cannot make a profit with existing stock at this price point.
                      </div>
                    </>
                  )}
                </div>
              )}

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

              {/* ─── Processing & Husk Recovery ──────────────────────────── */}
              {hasTonnage && (
                <div className="rounded-lg border bg-amber-50/30 dark:bg-amber-950/10 border-amber-200/50">
                  <button
                    type="button"
                    className="w-full flex items-center justify-between px-4 py-3 text-left"
                    onClick={() => setShowProcessingSection((v) => !v)}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
                      <Leaf className="h-4 w-4 text-amber-600" />
                      Processing &amp; Husk Recovery
                    </span>
                    <ChevronDown className={cn('h-4 w-4 text-amber-600 transition-transform duration-200', !showProcessingSection && '-rotate-90')} />
                  </button>

                  {showProcessingSection && (
                    <div className="px-4 pb-4 space-y-4">
                      {/* Editable inputs */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-2xl">
                        <div className="space-y-1">
                          <Label className="text-[10px] text-muted-foreground">Processing Charge (₹/kg seed)</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.5"
                            value={processingChargeInput}
                            onChange={(e) => setProcessingChargeInput(e.target.value)}
                            placeholder="e.g. 3"
                            className="h-8 text-sm"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-[10px] text-muted-foreground">Husk Price (₹/kg)</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.5"
                            value={huskPriceInput}
                            onChange={(e) => setHuskPriceInput(e.target.value)}
                            placeholder="e.g. 1.5"
                            className="h-8 text-sm"
                          />
                        </div>
                      </div>

                      {processingBreakdown && (
                        <>
                          {/* Metric tiles */}
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            <div className="rounded-lg border bg-white dark:bg-card p-3">
                              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                                <Factory className="h-3 w-3" /> Seed Required
                              </div>
                              <div className="text-lg font-bold mt-1">{toTonnes(processingBreakdown.seedKg).toFixed(2)} MT</div>
                              <div className="text-[10px] text-muted-foreground">for {tonnage.toFixed(2)} MT pappu @ 60% yield</div>
                            </div>
                            <div className="rounded-lg border bg-white dark:bg-card p-3">
                              <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400 flex items-center gap-1">
                                <Leaf className="h-3 w-3" /> Husk Output
                              </div>
                              <div className="text-lg font-bold text-amber-700 dark:text-amber-300 mt-1">{toTonnes(processingBreakdown.huskKg).toFixed(2)} MT</div>
                              <div className="text-[10px] text-muted-foreground">@ 25% of seed</div>
                            </div>
                            <div className="rounded-lg border bg-white dark:bg-card p-3">
                              <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
                                <ArrowDownRight className="h-3 w-3" /> Husk Value
                              </div>
                              <div className="text-lg font-bold text-emerald-600 mt-1">{rupees(processingBreakdown.huskValue)}</div>
                              <div className="text-[10px] text-muted-foreground">@ {rupees(huskPricePerKg)}/kg recovery</div>
                            </div>
                            <div className="rounded-lg border bg-white dark:bg-card p-3">
                              <div className="text-[10px] font-semibold uppercase tracking-wider text-rose-700 dark:text-rose-400 flex items-center gap-1">
                                <ArrowUpRight className="h-3 w-3" /> Processing Cost
                              </div>
                              <div className="text-lg font-bold text-rose-600 mt-1">{rupees(processingBreakdown.processingCost)}</div>
                              <div className="text-[10px] text-muted-foreground">@ {rupees(processingChargePerKg)}/kg seed</div>
                            </div>
                          </div>

                          {/* Cost breakdown sheet */}
                          <div className="rounded-lg border bg-white dark:bg-card overflow-hidden">
                            <div className="px-4 py-2 border-b bg-muted/30">
                              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                Net Cost Breakdown — {tonnage.toFixed(2)} MT pappu
                              </span>
                            </div>
                            <div className="px-4 py-3 space-y-2 text-sm">
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">
                                  Seed Cost ({toTonnes(processingBreakdown.seedKg).toFixed(2)} MT @ {rupees(processingBreakdown.seedCostPerKg)}/kg)
                                </span>
                                <span className="font-semibold tabular-nums">{rupees(processingBreakdown.seedCost)}</span>
                              </div>
                              <div className="flex justify-between text-rose-600">
                                <span>
                                  + Processing ({toTonnes(processingBreakdown.seedKg).toFixed(2)} MT @ {rupees(processingChargePerKg)}/kg)
                                </span>
                                <span className="font-semibold tabular-nums">+ {rupees(processingBreakdown.processingCost)}</span>
                              </div>
                              <div className="flex justify-between text-emerald-600">
                                <span>
                                  − Husk Recovery ({toTonnes(processingBreakdown.huskKg).toFixed(2)} MT @ {rupees(huskPricePerKg)}/kg)
                                </span>
                                <span className="font-semibold tabular-nums">− {rupees(processingBreakdown.huskValue)}</span>
                              </div>
                              <div className="border-t pt-2 mt-2 flex justify-between font-bold">
                                <span>Net Cost</span>
                                <span className="tabular-nums">{rupees(processingBreakdown.netCost)}</span>
                              </div>
                              <div className="flex justify-between text-primary font-bold text-base pt-1">
                                <span>Effective Pappu Cost</span>
                                <span className="tabular-nums">{rupees(processingBreakdown.effectivePappuPerKg)}/kg</span>
                              </div>
                              {hasPrice && (
                                <div className={cn(
                                  'flex justify-between font-semibold pt-1',
                                  basePappuPrice >= processingBreakdown.effectivePappuPerKg ? 'text-emerald-600' : 'text-rose-600'
                                )}>
                                  <span>Margin (sell {rupees(basePappuPrice)}/kg − cost {rupees(processingBreakdown.effectivePappuPerKg)}/kg)</span>
                                  <span className="tabular-nums">
                                    {basePappuPrice >= processingBreakdown.effectivePappuPerKg ? '+' : ''}
                                    {rupees(basePappuPrice - processingBreakdown.effectivePappuPerKg)}/kg
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* At-process summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground" title="Weighted Average Cost - the blended average purchase price of black seed across all (or eligible) price bands">Weighted Avg</CardTitle>
            <Tag className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{rupees(displayedWacBlack)}/kg</div>
            <p className="text-[10px] text-muted-foreground mt-1">
              Implies {rupees(displayedWacPappu)}/kg pappu cost
            </p>
            {(processingChargePerKg > 0 || huskPricePerKg > 0) && (
              <p className="text-[10px] text-amber-700 dark:text-amber-400 font-medium mt-0.5" title="Pappu cost adjusted for processing charge and husk recovery: (seed WAC + processing − husk credit) ÷ 0.60">
                {rupees(adjustedWacPappu)}/kg with processing &amp; husk
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground" title="Physical black seed on hand from arrived lorries, after deducting seed consumed by sale order commitments">Black Seed Remaining</CardTitle>
            <Factory className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${totalBlackKg < 0 ? 'text-rose-600' : 'text-amber-600'}`}>{toTonnes(totalBlackKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">physical (arrived-first), net of commitments · {toTonnes(totalReceivedKg).toFixed(2)} MT arrived</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground" title="Total black seed you can count on = seed remaining on hand + consumable portion of pending (still-coming) PO seed">Committed Black Seed</CardTitle>
            <Factory className="h-4 w-4 text-orange-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-600">{toTonnes(committedBlackKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">{toTonnes(totalBlackKg).toFixed(2)} MT on-hand + {toTonnes(totalPendingConsumableBlackKg).toFixed(2)} MT pending PO</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground" title="Pappu (in MT) already promised/allocated to sale orders - this is how much pappu has been committed to buyers">Committed Orders</CardTitle>
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
      <div className="rounded-lg border bg-card [&_div[data-slot=table-container]]:overflow-auto [&_div[data-slot=table-container]]:max-h-[70vh]">
        <Table>
          <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card [&_th]:shadow-[0_1px_0_0] [&_th]:shadow-border">
            <TableRow>
              <TableHead className="w-10"></TableHead>
              <TableHead title="Purchase price per kg of black seed for this band">Black Seed Price</TableHead>
              <TableHead title="Cost per kg of pappu implied by the seed price (= seed price ÷ 0.6 out-turn)">Implied Pappu Price</TableHead>
              <TableHead className="text-right" title="Number of truck loads at this price band">Lorries</TableHead>
              <TableHead className="text-right" title="Physical black seed on hand (arrived) after deducting seed consumed by sale orders. MT = Metric Tonnes (1 MT = 1,000 kg)">Black Seed Remaining</TableHead>
              <TableHead className="text-right" title="Pappu (in Metric Tonnes) already promised/allocated to sale orders from this price band">Committed (MT)</TableHead>
              <TableHead className="text-right" title="Sellable pappu remaining from arrived seed after commitments. MT = Metric Tonnes. Seed × 0.6 out-turn = pappu">Available Pappu (MT)</TableHead>
              <TableHead className="text-right" title="Rupee value of remaining seed at its purchase price">Valuation</TableHead>
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
            {pagedBands.map((b) => {
              const key = b.blackPricePerKg.toFixed(2);
              const isOpen = expanded.has(key);
              const isEligible = plan && hasPrice;
              const isBandProfitable = hasPrice && b.impliedPappuPrice <= pappuPrice;
              return (
                <Fragment key={key}>
                  <TableRow
                    className={cn('cursor-pointer font-medium transition-colors', isEligible && 'bg-primary/5', isOpen ? 'bg-accent/40' : 'hover:bg-accent/30')}
                    onClick={() => toggle(key)}
                  >
                    <TableCell className="p-3 text-center">
                      <ChevronRight className={cn('h-4 w-4 mx-auto text-muted-foreground transition-transform duration-200', isOpen && 'rotate-90 text-primary')} />
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="bg-primary/5 text-primary border-primary/20 text-xs font-extrabold px-2 py-0.5">
                        {rupees(b.blackPricePerKg)}/kg
                      </Badge>
                      {hasPrice && (
                        isBandProfitable ? (
                          <Badge variant="outline" className="ml-2 text-[9px] h-4 px-1.5 bg-emerald-50 text-emerald-700 border-emerald-200 font-medium rounded-sm shadow-none" title={`Band cost ${rupees(b.impliedPappuPrice)}/kg vs net sell price ${rupees(pappuPrice)}/kg`}>
                            +₹{(pappuPrice - b.impliedPappuPrice).toFixed(2)}/kg
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="ml-2 text-[9px] h-4 px-1.5 bg-rose-50 text-rose-700 border-rose-200 font-medium rounded-sm shadow-none" title={`Band cost ${rupees(b.impliedPappuPrice)}/kg vs net sell price ${rupees(pappuPrice)}/kg`}>
                            −₹{(b.impliedPappuPrice - pappuPrice).toFixed(2)}/kg
                          </Badge>
                        )
                      )}
                    </TableCell>
                    <TableCell className="font-semibold text-foreground">
                      <div>{rupees(b.impliedPappuPrice)}/kg</div>
                      {(processingChargePerKg > 0 || huskPricePerKg > 0) && (
                        <div className="text-[10px] font-medium text-amber-700 dark:text-amber-400" title="Adjusted: (seed + processing − husk credit) ÷ 0.60">
                          {rupees((b.blackPricePerKg + processingChargePerKg - (HUSK_YIELD * huskPricePerKg)) / PAPPU_OUTTURN)}/kg adj.
                        </div>
                      )}
                    </TableCell>
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
                      {b.allocatedPappuKg > 0 ? `${toTonnes(b.allocatedPappuKg).toFixed(2)} MT` : '-'}
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
                    <ExpandPanel colSpan={8}>
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <PanelLabel>
                          <span className="normal-case tracking-normal">Lots at {rupees(b.blackPricePerKg)}/kg</span>
                        </PanelLabel>
                        <span className="text-xs font-semibold text-muted-foreground">
                          {b.lorries} lorry(s)
                          {b.pendingBlackKg > 0 && <span className="text-amber-600"> · {toTonnes(b.pendingBlackKg).toFixed(2)} MT pending</span>}
                          {b.shortfallBlackKg > 0 && <span className="text-rose-600"> · {toTonnes(b.shortfallBlackKg).toFixed(2)} MT short</span>}
                        </span>
                      </div>
                      <PanelStack>
                        {b.lots.map((l) => {
                          const isArrived = l.kind === 'ARRIVED';
                          const isShortfall = l.kind === 'SHORTFALL';

                          // For PENDING lots, the buffer is fixed based on the original ordered/gross amount,
                          // so that it doesn't disappear when consumable seed is drawn down.
                          const originalGross = isArrived ? l.receivedKg : l.receivedKg + l.soldKg;
                          const bufferBlack = (isArrived || isShortfall) ? 0 : Math.round(originalGross * (1 - PAPPU_CONSUMABLE));

                          // Consumable remaining is simply whatever is left minus the buffer
                          const remainingConsumableBlack = (isArrived || isShortfall) ? l.receivedKg : Math.max(0, l.receivedKg - bufferBlack);
                          const consumable = Math.round(remainingConsumableBlack * PAPPU_OUTTURN);
                          const bufferPappu = (isArrived || isShortfall) ? 0 : Math.round(bufferBlack * PAPPU_OUTTURN);

                          // For arrived, no buffer is deducted. For pending, 20% is deducted.
                          // For shortfall, we just show the raw gross gap.
                          const netRemainingSeed = isShortfall ? l.receivedKg : Math.round(remainingConsumableBlack);
                          const netSoldSeed = l.soldKg; // We now show Gross Sold for all to avoid confusion
                          // Per-lot shortfall deficit
                          const gapPappu = l.receivedKg * PAPPU_OUTTURN;
                          return (
                            <PanelCard
                              key={l.purchaseId}
                              icon={Truck}
                              identity={
                                <>
                                  <PanelTitle>
                                    <span className="font-medium text-foreground">{l.partyName}</span>
                                    {l.kind === 'ARRIVED' && <Badge variant="success">Arrived</Badge>}
                                    {l.kind === 'PENDING' && <Badge variant="warning">Pending</Badge>}
                                    {l.kind === 'SHORTFALL' && <Badge variant="destructive">Short</Badge>}
                                  </PanelTitle>
                                  <PanelMeta>
                                    <span>{shortDate(l.date)}</span><PanelDot />
                                    <span>{l.lorryNumber || 'no lorry'}</span><PanelDot />
                                    <span className="tabular-nums">{l.poNumber || '-'}</span>
                                  </PanelMeta>
                                </>
                              }
                              figures={
                                <>
                                  <Figure
                                    label="Remaining seed"
                                    value={
                                      <>
                                        {l.kind === 'SHORTFALL' ? <span className="text-rose-600">−{kg(l.receivedKg)}</span> : kg(netRemainingSeed)}
                                        {l.kind === 'SHORTFALL' ? (
                                          <span className="block text-[9px] font-normal normal-case text-muted-foreground">of {kg(l.orderedKg)} ordered</span>
                                        ) : l.kind === 'PENDING' && bufferBlack > 0 ? (
                                          <span className="block text-[9px] font-normal normal-case text-muted-foreground">+{kg(bufferBlack)} seed buffer</span>
                                        ) : null}
                                      </>
                                    }
                                  />
                                  <Figure
                                    label="Gross sold"
                                    valueClass="text-muted-foreground"
                                    value={
                                      <>
                                        {l.soldKg > 0 ? kg(netSoldSeed) : '-'}
                                        {l.kind === 'PENDING' && l.soldKg > 0 && (
                                          <span className="block text-[9px] font-normal normal-case text-amber-600">
                                            −{kg(Math.round(l.soldKg * SEED_TO_CONSUMABLE))} pappu consumed
                                          </span>
                                        )}
                                        {(isArrived || l.kind === 'PENDING') && l.consumedBy && l.consumedBy.length > 0 && (
                                           <div className="mt-1.5 flex flex-col gap-1 text-left">
                                             {l.consumedBy.slice(0, 6).map((c, i) => (
                                               <div
                                                 key={i}
                                                 className="inline-flex items-center gap-1.5 rounded-lg border border-sky-200/70 bg-sky-50/80 px-2 py-1 text-[10px] font-medium text-sky-950 shadow-xs dark:border-sky-900/50 dark:bg-sky-950/50 dark:text-sky-200"
                                               >
                                                 <span className="font-mono font-bold text-sky-700 dark:text-sky-400">{kg(c.seedKg)}</span>
                                                 <span className="text-sky-400 dark:text-sky-600">→</span>
                                                 <span className="font-semibold text-foreground">{c.buyer}</span>
                                                 <span className="text-[9px] text-muted-foreground">· {shortDate(c.saleDate)}</span>
                                               </div>
                                             ))}
                                             {l.consumedBy.length > 6 && (
                                               <span className="inline-flex items-center self-start rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                                 +{l.consumedBy.length - 6} more order(s)
                                               </span>
                                             )}
                                           </div>
                                        )}
                                      </>
                                    }
                                  />
                                  <Figure
                                    label="Remaining pappu"
                                    value={
                                      l.kind === 'SHORTFALL' ? (
                                        <span className="text-rose-600">−{kg(gapPappu)}</span>
                                      ) : (
                                        <>
                                          <span className={l.kind === 'PENDING' ? 'text-amber-600' : 'text-sky-600'}>{kg(consumable)}</span>
                                          {l.kind === 'PENDING' && bufferPappu > 0 && (
                                            <span className="block text-[9px] font-normal normal-case text-muted-foreground">+{kg(bufferPappu)} pappu buffer</span>
                                          )}
                                        </>
                                      )
                                    }
                                  />
                                </>
                              }
                            />
                          );
                        })}
                      </PanelStack>
                    </ExpandPanel>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
        <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
      </div>
    </div>
  );
}
