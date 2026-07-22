import { Fragment, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Search, Loader2, Warehouse, TrendingUp, IndianRupee, Package, Landmark,
  ChevronRight, ChevronDown, Tag,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { StockTransfer, LoansResponse } from '@/lib/types';
import { stockSummary, type ByPriceBandLike } from '@/lib/calc';
import { kg, rupees, shortDate, toTonnes } from '@/lib/format';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';

type LocationType = 'RVP' | 'PGR COLD' | 'Murugan' | 'KNM Multi';

// Same shape the /inventory/black-seed endpoint returns (per-purchase row).
interface BlackSeedRow {
  purchaseId: string;
  date: string;       // arrival date ISO
  partyName: string;
  poNumber: string | null;
  lorryNumber: string;
  rvpNetWeightKg: number;
  pricePerKg: number;
  value: number;
  valueExclGstAndHamali: number;
  location: string;   // loading location
  isTransferredIn?: boolean; // backend-synthesized row for a FIFO-picked transfer-in; excluded here, see below
}

interface BlackSeedStockResponse {
  rows: BlackSeedRow[];
  pappuSoldKg: number;
  pappuCommittedKg: number;
  totalMilledKg: number;
  poTonnageKg: number;
}

interface StockByPriceResponse {
  bands: ByPriceBandLike[];
}

// Standard milling out-turn: 60% of raw black seed yields pappu.
const PAPPU_OUTTURN = 0.6;

const locations: LocationType[] = ['RVP', 'PGR COLD', 'Murugan', 'KNM Multi'];

// A single lot inside a price band - one purchase (lorry) or one transfer-in batch.
interface PriceBandLot {
  purchaseId: string;
  date: string;         // YYYY-MM-DD
  partyName: string;
  lorryNumber: string;
  poNumber: string | null;
  receivedKg: number;
  remainingKg: number;
  remainingValue: number;
  transferredKg: number; // depleted so far (by transfers out / pappu draw-down)
  isTransferredIn?: boolean;
  fromLocation?: string;
}

// A black-seed cost band (₹/kg) at a location, made up of its lots.
interface PriceBand {
  price: number;
  lorries: number;
  receivedKg: number;
  receivedValue: number;
  remainingKg: number;
  remainingValue: number;
  lots: PriceBandLot[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Group purchase rows into price bands, sorted highest-price-first. */
function buildPriceBands(rows: BlackSeedRow[]): PriceBand[] {
  const map = new Map<string, PriceBand>();
  for (const r of rows) {
    const price = Math.round(r.pricePerKg * 100) / 100;
    const key = price.toFixed(2);
    let b = map.get(key);
    if (!b) {
      b = { price, lorries: 0, receivedKg: 0, receivedValue: 0, remainingKg: 0, remainingValue: 0, lots: [] };
      map.set(key, b);
    }
    b.lorries += 1;
    b.receivedKg += r.rvpNetWeightKg;
    b.receivedValue += r.valueExclGstAndHamali;
    b.lots.push({
      purchaseId: r.purchaseId,
      date: r.date.slice(0, 10),
      partyName: r.partyName,
      lorryNumber: r.lorryNumber,
      poNumber: r.poNumber,
      receivedKg: r.rvpNetWeightKg,
      remainingKg: r.rvpNetWeightKg,
      remainingValue: r.valueExclGstAndHamali,
      transferredKg: 0,
    });
  }
  const bands = [...map.values()];
  for (const b of bands) {
    b.remainingKg = b.receivedKg;
    b.remainingValue = b.receivedValue;
    b.lots.sort((a, z) => a.date.localeCompare(z.date));
  }
  // Highest price first - this is the order stock gets depleted in.
  return bands.sort((a, z) => z.price - a.price);
}

/**
 * Deplete `consumeKg` from price bands top-to-bottom (highest price first);
 * within a band, oldest lot first. Mutates lots/bands in place and returns a
 * per-price breakdown of exactly what was taken (kg + its value), so callers
 * can re-credit the same price band at a transfer's destination.
 *
 * When `skipTransferredIn` is set, freshly transferred-in lots are left
 * untouched - a transfer brings NEW stock on hand and must not be retroactively
 * consumed by pappu already milled from seed that was at the process earlier
 * (otherwise the expensive transferred seed gets eaten first and the location's
 * remaining valuation drops by the price gap - a phantom transfer "deficit").
 */
function depletePriceBands(
  bands: PriceBand[],
  consumeKg: number,
  skipTransferredIn = false
): Map<string, { kg: number; value: number }> {
  const breakdown = new Map<string, { kg: number; value: number }>();
  let remaining = consumeKg;
  for (const band of bands) {
    if (remaining <= 0) break;
    let takenKg = 0;
    let takenValue = 0;
    for (const lot of band.lots) {
      if (remaining <= 0) break;
      if (lot.remainingKg <= 0) continue;
      if (skipTransferredIn && lot.isTransferredIn) continue;
      const take = Math.min(remaining, lot.remainingKg);
      const takeValue = lot.remainingKg > 0
        ? Math.round(lot.remainingValue * (take / lot.remainingKg) * 100) / 100
        : 0;
      lot.remainingKg -= take;
      lot.remainingValue = Math.max(0, lot.remainingValue - takeValue);
      lot.transferredKg += take;
      if (lot.remainingKg <= 0) {
        lot.remainingKg = 0;
        lot.remainingValue = 0;
      }
      takenKg += take;
      takenValue += takeValue;
      remaining -= take;
    }
    if (takenKg > 0) {
      breakdown.set(band.price.toFixed(2), { kg: takenKg, value: takenValue });
    }
    band.remainingKg = band.lots.reduce((s, l) => s + l.remainingKg, 0);
    band.remainingValue = band.lots.reduce((s, l) => s + l.remainingValue, 0);
  }
  return breakdown;
}

/** Merge several locations' price bands into one combined set of bands (for "All"). */
function mergeBands(bandsArrays: PriceBand[][]): PriceBand[] {
  const map = new Map<string, PriceBand>();
  for (const bands of bandsArrays) {
    for (const b of bands) {
      const key = b.price.toFixed(2);
      let m = map.get(key);
      if (!m) {
        m = { price: b.price, lorries: 0, receivedKg: 0, receivedValue: 0, remainingKg: 0, remainingValue: 0, lots: [] };
        map.set(key, m);
      }
      m.lorries += b.lorries;
      m.receivedKg += b.receivedKg;
      m.receivedValue += b.receivedValue;
      m.remainingKg += b.remainingKg;
      m.remainingValue += b.remainingValue;
      m.lots = m.lots.concat(b.lots);
    }
  }
  for (const m of map.values()) m.lots.sort((a, z) => a.date.localeCompare(z.date));
  return [...map.values()].sort((a, z) => z.price - a.price);
}

// ─── Component ─────────────────────────────────────────────────────────────

export default function StockLocation() {
  const [searchParams, setSearchParams] = useSearchParams();
  const paramLoc = searchParams.get('loc');
  const selectedLoc = (paramLoc && locations.includes(paramLoc as LocationType)) ? paramLoc as LocationType : 'All';
  const setSelectedLoc = (loc: 'All' | LocationType) => {
    if (loc === 'All') setSearchParams({});
    else setSearchParams({ loc });
  };
  const [searchQuery, setSearchQuery] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data, isLoading: loadingSeed } = useQuery({
    queryKey: ['black-seed-stock'],
    queryFn: () => api<BlackSeedStockResponse>('/inventory/black-seed'),
  });

  const { data: transfers, isLoading: loadingTransfers } = useQuery({
    queryKey: ['stock-transfers'],
    queryFn: () => api<StockTransfer[]>('/stock-transfers'),
  });

  const { data: loanData, isLoading: loadingLoans } = useQuery({
    queryKey: ['loans'],
    queryFn: () => api<LoansResponse>('/loans'),
  });

  // The Order Planner is the source of truth for how much ARRIVED seed has been
  // drawn down at the process. We deplete RVP by exactly that figure so this
  // page's RVP "Stock on Hand" matches the Order Planner's Black Seed Remaining.
  const { data: plannerData, isLoading: loadingPlanner } = useQuery({
    queryKey: ['stock-by-price'],
    queryFn: () => api<StockByPriceResponse>('/inventory/by-price'),
  });

  // Build per-location price bands, then deplete them highest-price-first as
  // stock moves out (transfers) or is consumed at the process (pappu sold).
  const locationData = useMemo(() => {
    // The /inventory/black-seed endpoint adds synthetic "transferred-in" rows at
    // RVP, picked FIFO-by-arrival-date (see server's getBlackSeedStock). We
    // recompute every transfer ourselves below using price-band depletion
    // (highest price first), so those FIFO-picked rows must be excluded here -
    // otherwise transferred stock gets double-counted and mixed with FIFO picks.
    const allRows = (data?.rows ?? []).filter((r) => !r.isTransferredIn);
    const allTransfers = transfers ?? [];
    // Seed at the process is drawn down by exactly the ARRIVED seed the Order
    // Planner consumed for committed sales (arrived gross − arrived remaining).
    // Using the Order Planner's own figure - rather than committedPappu/0.6 -
    // keeps RVP "Stock on Hand" in lock-step with the Order Planner even when
    // some orders are backed by still-coming (pending PO) seed.
    const planSummary = stockSummary(plannerData?.bands);
    const seedConsumedByPappuKg = Math.max(0, planSummary.arrivedBlackKg - planSummary.remainingBlackKg);

    // Step 1: Group purchase rows by location, then build price-wise bands.
    const locBands: Record<string, PriceBand[]> = {};
    for (const loc of locations) {
      const locRows = allRows.filter((r) => (r.location || 'RVP') === loc);
      locBands[loc] = buildPriceBands(locRows);
    }

    // Step 2: Deplete storage locations top-to-bottom (highest price first) by
    // transfers OUT, oldest transfer first, and re-credit the same price band
    // at the destination location.
    const sortedTransfers = [...allTransfers].sort(
      (a, b) => a.transferDate.localeCompare(b.transferDate)
    );

    for (const t of sortedTransfers) {
      const fromBands = locBands[t.fromLocation];
      if (!fromBands || t.weightKg <= 0) continue;

      // Value arriving at the destination = the seed drawn from storage PLUS all
      // capitalised transfer costs (hamali + transport + bank-loan carrying
      // interest) that travel with it - exactly what the server persists as
      // movedValue, so this page ties out with the server's computeBlackSeedRows.
      const totalTransferValue = Number(t.movedValue);
      const breakdown = depletePriceBands(fromBands, t.weightKg);
      if (breakdown.size === 0) continue;

      if (!locBands[t.toLocation]) locBands[t.toLocation] = [];
      const destBands = locBands[t.toLocation];
      const lotDate = t.transferDate.slice(0, 10);

      for (const [priceKey, portion] of breakdown) {
        const price = parseFloat(priceKey);
        const shareValue = t.weightKg > 0
          ? Math.round(totalTransferValue * (portion.kg / t.weightKg) * 100) / 100
          : portion.value;

        let band = destBands.find((b) => b.price.toFixed(2) === priceKey);
        if (!band) {
          band = { price, lorries: 0, receivedKg: 0, receivedValue: 0, remainingKg: 0, remainingValue: 0, lots: [] };
          destBands.push(band);
        }

        let lot = band.lots.find(
          (l) => l.isTransferredIn && l.date === lotDate && l.fromLocation === t.fromLocation
        );
        if (lot) {
          lot.receivedKg += portion.kg;
          lot.remainingKg += portion.kg;
          lot.remainingValue += shareValue;
        } else {
          band.lots.push({
            purchaseId: `transfer-${t.id}-${priceKey}`,
            date: lotDate,
            partyName: `Transferred from ${t.fromLocation}`,
            lorryNumber: '-',
            poNumber: null,
            receivedKg: portion.kg,
            remainingKg: portion.kg,
            remainingValue: shareValue,
            transferredKg: 0,
            isTransferredIn: true,
            fromLocation: t.fromLocation,
          });
        }
        band.receivedKg += portion.kg;
        band.receivedValue += shareValue;
        band.remainingKg += portion.kg;
        band.remainingValue += shareValue;
        band.lots.sort((a, z) => a.date.localeCompare(z.date));
      }
      destBands.sort((a, z) => z.price - a.price);
    }

    // Step 3: Deplete "RVP" top-to-bottom (highest price first) by seed consumed
    // for pappu sold. Two passes so a transfer stays value-neutral: pass 1 draws
    // only the seed already at the process (skips transferred-in lots); pass 2
    // draws the remainder from transferred-in seed ONLY if the process seed ran
    // out. Otherwise freshly transferred (often pricier) seed would be milled
    // first, dropping RVP's remaining value by the price gap - the ₹-deficit.
    const rvpBands = locBands['RVP'] ?? [];
    const pappuKg = Math.round(seedConsumedByPappuKg);
    const firstPass = depletePriceBands(rvpBands, pappuKg, true);
    let consumed = 0;
    for (const p of firstPass.values()) consumed += p.kg;
    const remainder = pappuKg - consumed;
    if (remainder > 0) depletePriceBands(rvpBands, remainder);

    return locBands;
  }, [data, transfers, plannerData]);

  // Bands for the current selection ("All" merges every location by price).
  const getBands = (loc: 'All' | LocationType): PriceBand[] => {
    if (loc === 'All') return mergeBands(locations.map((l) => locationData[l] ?? []));
    return locationData[loc] ?? [];
  };

  // Compute metrics for a single location or all.
  const getMetrics = (loc: 'All' | LocationType) => {
    const bands = getBands(loc);

    const totalRemWeightKg = bands.reduce((s, b) => s + b.remainingKg, 0);
    const totalRemValue = bands.reduce((s, b) => s + b.remainingValue, 0);
    const totalRecvWeightKg = bands.reduce((s, b) => s + b.receivedKg, 0);
    const totalRecvValue = bands.reduce((s, b) => s + b.receivedValue, 0);

    let totalOutstandingLoan = 0;
    if (loanData?.loans) {
      for (const loan of loanData.loans) {
        if (loan.status === 'OPEN' && loan.location) {
          if (loc === 'All' || loan.location === loc) {
            totalOutstandingLoan += loan.outstanding;
          }
        }
      }
    }

    const overallAvg = totalRemWeightKg > 0 ? totalRemValue / totalRemWeightKg : 0;
    const pappuToConvertKg = totalRemWeightKg * PAPPU_OUTTURN;
    return { totalRemWeightKg, totalRemValue, totalRecvWeightKg, totalRecvValue, overallAvg, pappuToConvertKg, bands, totalOutstandingLoan };
  };

  const metrics = getMetrics(selectedLoc);

  // Filter bands/lots for the detail table.
  const q = searchQuery.trim().toLowerCase();
  const visibleBands = useMemo(() => {
    const hasFilter = !!q || !!fromDate || !!toDate;
    if (!hasFilter) return metrics.bands;
    return metrics.bands
      .map((b) => {
        const priceMatches = !q || rupees(b.price).toLowerCase().includes(q) || b.price.toFixed(2).includes(q);
        const lots = b.lots.filter((l) => {
          if (fromDate && l.date < fromDate) return false;
          if (toDate && l.date > toDate) return false;
          if (!q || priceMatches) return true;
          return (
            l.partyName.toLowerCase().includes(q) ||
            l.lorryNumber.toLowerCase().includes(q) ||
            (l.poNumber ?? '').toLowerCase().includes(q)
          );
        });
        return { ...b, lots };
      })
      .filter((b) => b.lots.length > 0);
  }, [metrics.bands, q, fromDate, toDate]);

  const isLoading = loadingSeed || loadingTransfers || loadingLoans || loadingPlanner;

  const exportColumns: ExportColumn<typeof visibleBands[number]>[] = [
    { header: 'Black Seed Price', value: (b) => rupees(b.price), excel: (b) => b.price, numFmt: '#,##0.00', align: 'right' },
    { header: 'Lorries', value: (b) => b.lorries || '', align: 'right' },
    { header: 'Received MT', value: (b) => toTonnes(b.receivedKg).toFixed(2), excel: (b) => toTonnes(b.receivedKg), numFmt: '#,##0.00', align: 'right' },
    { header: 'Remaining MT', value: (b) => toTonnes(b.remainingKg).toFixed(2), excel: (b) => toTonnes(b.remainingKg), numFmt: '#,##0.00', align: 'right' },
    { header: 'Remaining Valuation', value: (b) => rupees(b.remainingValue), excel: (b) => b.remainingValue, numFmt: '#,##0.00', align: 'right' },
  ];

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Stock by Location</h1>
          <p className="text-muted-foreground">
            Location-wise black-seed stock grouped into price bands, same as the Order Planner. Transfers out of
            storage and pappu sold at the process deplete stock <span className="font-medium">top to bottom</span> -
            highest-priced seed first, oldest lot first within a band - so the weighted-average price reflects the
            pooled stock still on hand at each location. Valuation excludes GST.
          </p>
        </div>
        <ExportButtons
          filename={`Stock_By_Location_${String(selectedLoc).replace(/\s+/g, '_')}`}
          title={`Stock by Location — ${selectedLoc}`}
          subtitle={`${visibleBands.length} band(s)`}
          columns={exportColumns}
          rows={visibleBands}
        />
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Stock on Hand</CardTitle>
            <Warehouse className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{toTonnes(metrics.totalRemWeightKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">
              After depletion · {selectedLoc === 'All' ? 'All locations' : selectedLoc}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Stock Valuation</CardTitle>
            <IndianRupee className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-600">{rupees(metrics.totalRemValue)}</div>
            <p className="text-[10px] text-muted-foreground mt-1">
              Seed cost + freight (if BASE price, excl. GST)
              {metrics.totalRecvValue !== metrics.totalRemValue && (
                <span className="block">of {rupees(metrics.totalRecvValue)} total received</span>
              )}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Weighted Avg Price</CardTitle>
            <TrendingUp className="h-4 w-4 text-rose-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-rose-600">{rupees(metrics.overallAvg)}/kg</div>
            <p className="text-[10px] text-muted-foreground mt-1">Across remaining stock</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pappu to be Converted</CardTitle>
            <Package className="h-4 w-4 text-sky-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-sky-600">{toTonnes(metrics.pappuToConvertKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">60% out-turn of stock on hand</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Outstanding Loans</CardTitle>
            <Landmark className="h-4 w-4 text-violet-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-violet-600">{rupees(metrics.totalOutstandingLoan)}</div>
            <p className="text-[10px] text-muted-foreground mt-1">Principal owed to bank against stock</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="location" className="text-xs text-muted-foreground">Location</Label>
          <Select value={selectedLoc} onValueChange={(v) => setSelectedLoc(v as 'All' | LocationType)}>
            <SelectTrigger id="location" className="w-56 bg-card">
              <SelectValue placeholder="Select location" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">All locations</SelectItem>
              {locations.map((loc) => (
                <SelectItem key={loc} value={loc}>{loc}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 flex-1 min-w-52">
          <Label htmlFor="search" className="text-xs text-muted-foreground">Search price, party, lorry or PO</Label>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              id="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="e.g. 42.50, party name, lorry, PO…"
              className="pl-8"
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="from-date" className="text-xs text-muted-foreground">From</Label>
          <Input id="from-date" type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="to-date" className="text-xs text-muted-foreground">To</Label>
          <Input id="to-date" type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} className="w-40" />
        </div>
        {(searchQuery || fromDate || toDate) && (
          <button
            type="button"
            onClick={() => { setSearchQuery(''); setFromDate(''); setToDate(''); }}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline pb-2.5"
          >
            Clear
          </button>
        )}
      </div>

      {/* Per-location breakdown tiles - always visible, regardless of the selected location below */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {locations.map((loc) => {
          const m = getMetrics(loc);
          return (
            <button
              key={loc}
              type="button"
              onClick={() => setSelectedLoc(loc)}
              className={`rounded-lg border bg-card p-3 text-left hover:border-primary/50 transition-colors ${selectedLoc === loc ? 'border-primary/50 ring-1 ring-primary/30' : ''}`}
            >
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{loc}</div>
              <div className="text-lg font-bold text-primary mt-1">{toTonnes(m.totalRemWeightKg).toFixed(2)} MT</div>
              <div className="text-xs text-emerald-600 font-medium">{rupees(m.totalRemValue)} stock</div>
              <div className="text-xs text-violet-600 font-medium">{rupees(m.totalOutstandingLoan)} loan</div>
              <div className="text-xs text-muted-foreground">
                {rupees(m.overallAvg)}/kg avg
              </div>
            </button>
          );
        })}
      </div>

      {/* Price-band ledger */}
      <div className="rounded-lg border bg-card">
        <div className="px-5 py-4 border-b bg-muted/10">
          <span className="font-semibold text-sm">
            Price Band Ledger: <span className="text-primary font-bold">{selectedLoc === 'All' ? 'All locations' : selectedLoc}</span>
          </span>
          <p className="text-xs text-muted-foreground mt-0.5">
            Highest-priced seed depleted first by transfers out and pappu sold
          </p>
        </div>
        <div className="[&_div[data-slot=table-container]]:overflow-auto [&_div[data-slot=table-container]]:max-h-[70vh]">
          <Table>
            <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card [&_th]:shadow-[0_1px_0_0] [&_th]:shadow-border">
              <TableRow>
                <TableHead className="w-10"></TableHead>
                <TableHead>Black Seed Price</TableHead>
                <TableHead className="text-right">Lorries</TableHead>
                <TableHead className="text-right">Received MT</TableHead>
                <TableHead className="text-right">Remaining MT</TableHead>
                <TableHead className="text-right">Remaining Valuation</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleBands.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    {metrics.bands.length === 0
                      ? 'No black seed in stock at this location.'
                      : 'No price bands match the filter.'}
                  </TableCell>
                </TableRow>
              )}
              {visibleBands.map((b) => {
                const key = `${selectedLoc}-${b.price.toFixed(2)}`;
                const isOpen = expanded.has(key);
                const depleted = b.remainingKg === 0;
                return (
                  <Fragment key={key}>
                    <TableRow
                      className={`hover:bg-muted/50 cursor-pointer font-medium ${depleted ? 'opacity-50' : ''}`}
                      onClick={() => toggle(key)}
                    >
                      <TableCell className="p-3 text-center">
                        {isOpen ? <ChevronDown className="h-4 w-4 mx-auto text-muted-foreground" /> : <ChevronRight className="h-4 w-4 mx-auto text-muted-foreground" />}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="bg-primary/5 text-primary border-primary/20 text-xs font-extrabold px-2 py-0.5">
                          {rupees(b.price)}/kg
                        </Badge>
                        {depleted && <Badge variant="outline" className="ml-2 text-[10px]">Sold through</Badge>}
                      </TableCell>
                      <TableCell className="text-right font-medium">{b.lorries || '-'}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {toTonnes(b.receivedKg).toFixed(2)} MT
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        {toTonnes(b.remainingKg).toFixed(2)} MT
                        {b.remainingKg !== b.receivedKg && (
                          <span className="block text-[10px] text-muted-foreground font-normal">of {toTonnes(b.receivedKg).toFixed(2)} received</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-semibold text-emerald-600">
                        {rupees(b.remainingValue)}
                        {b.remainingValue !== b.receivedValue && b.receivedValue > 0 && (
                          <span className="block text-[10px] text-muted-foreground font-normal">of {rupees(b.receivedValue)} received</span>
                        )}
                      </TableCell>
                    </TableRow>

                    {isOpen && (
                      <TableRow className="bg-muted/10 hover:bg-muted/10">
                        <TableCell colSpan={6} className="p-4 pl-12">
                          <div className="rounded-lg border bg-card p-4 shadow-sm">
                            <div className="flex items-center justify-between border-b pb-2 mb-2">
                              <span className="font-bold text-xs text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                                <Tag className="h-3 w-3" /> Lots at {rupees(b.price)}/kg
                              </span>
                              <span className="text-xs text-muted-foreground font-semibold">
                                {b.lots.length} lot{b.lots.length === 1 ? '' : 's'}
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
                                    <TableHead className="h-8 py-1 text-xs text-right">Remaining Seed</TableHead>
                                    <TableHead className="h-8 py-1 text-xs text-right">Transferred Seed</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {b.lots.map((l) => (
                                    <TableRow key={l.purchaseId} className="hover:bg-muted/20">
                                      <TableCell className="py-2 text-xs">
                                        {shortDate(l.date)}
                                        {l.isTransferredIn && (
                                          <Badge variant="outline" className="ml-2 text-[10px] text-blue-600">In</Badge>
                                        )}
                                      </TableCell>
                                      <TableCell className="py-2 text-xs font-medium text-foreground">{l.partyName}</TableCell>
                                      <TableCell className="py-2 text-xs font-mono">{l.lorryNumber || '-'}</TableCell>
                                      <TableCell className="py-2 text-xs font-mono">{l.poNumber || '-'}</TableCell>
                                      <TableCell className="py-2 text-xs text-right font-semibold">
                                        {kg(l.remainingKg)}
                                        {l.remainingKg !== l.receivedKg && (
                                          <span className="block text-[10px] text-muted-foreground font-normal">of {kg(l.receivedKg)} received</span>
                                        )}
                                      </TableCell>
                                      <TableCell className="py-2 text-xs text-right text-muted-foreground">
                                        {l.transferredKg > 0 ? kg(l.transferredKg) : '-'}
                                      </TableCell>
                                    </TableRow>
                                  ))}
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
    </div>
  );
}
