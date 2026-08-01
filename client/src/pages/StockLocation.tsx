import { Fragment, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Search, Loader2, Warehouse, TrendingUp, IndianRupee, Package, Landmark,
  ChevronRight, ChevronDown, Tag,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { StockTransfer, LoansResponse } from '@/lib/types';
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

// ─── Order Planner (/inventory/by-price) response ──────────────────────────
// RVP is not re-depleted on this page: the planner's own post-allocation bands
// and lots are adopted verbatim, so the two pages agree band-for-band and
// lot-for-lot, not just on the grand total.
interface PlannerLot {
  purchaseId: string;
  date: string;
  partyName: string;
  lorryNumber: string;
  poNumber: string | null;
  kind: 'ARRIVED' | 'PENDING' | 'SHORTFALL';
  receivedKg: number; // seed LEFT in this lot after the planner's sales draw-down
  soldKg: number;     // seed this lot has already given up to sales
}

interface PlannerBand {
  blackPricePerKg: number;
  lorries: number;
  arrivedBlackKg: number;   // gross arrived at RVP, before draw-down
  arrivedValue: number;     // gross arrived value (excl. GST)
  remainingBlackKg: number; // arrived seed left after the date-aware allocation
  remainingValue: number;
  lots: PlannerLot[];
}

interface StockByPriceResponse {
  bands: PlannerBand[];
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
 * can re-credit the drawn seed at a transfer's destination.
 *
 * This is the storage-location draw-down only (transfers OUT). It mirrors the
 * server stock engine's storage pick - `sort((z.price - a.price) || (a.date -
 * z.date))` in computeUnifiedStockEngine - so a location's remaining kg ties
 * out with the engine's. RVP is NOT depleted here; see step 3 below.
 */
function depletePriceBands(
  bands: PriceBand[],
  consumeKg: number
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

  // The Order Planner is the source of truth for RVP. Its bands already carry the
  // date-aware allocation (a sale can only draw from lots that had arrived by its
  // sale date), so we adopt its post-draw-down bands and lots as-is rather than
  // re-deriving them here - that is what makes RVP tie out band-for-band, not
  // just on the total.
  const { data: plannerData, isLoading: loadingPlanner } = useQuery({
    queryKey: ['stock-by-price'],
    queryFn: () => api<StockByPriceResponse>('/inventory/by-price'),
  });

  // Build per-location price bands. Storage locations are depleted here by the
  // transfers that move seed out of them; RVP is taken wholesale from the Order
  // Planner (step 3), which owns the pappu draw-down.
  const locationData = useMemo(() => {
    // The /inventory/black-seed endpoint adds synthetic "transferred-in" rows at
    // RVP. RVP now comes from the planner instead, and storage bands must show
    // only what physically arrived there, so those rows are excluded here.
    const allRows = (data?.rows ?? []).filter((r) => !r.isTransferredIn);
    const allTransfers = transfers ?? [];

    // Step 1: Group storage-location purchase rows into price-wise bands. RVP is
    // built in step 3 from the planner, so it starts empty.
    const locBands: Record<string, PriceBand[]> = {};
    for (const loc of locations) {
      if (loc === 'RVP') { locBands[loc] = []; continue; }
      const locRows = allRows.filter((r) => (r.location || 'RVP') === loc);
      locBands[loc] = buildPriceBands(locRows);
    }

    // Step 2: Deplete storage locations top-to-bottom (highest price first) by
    // transfers OUT, oldest transfer first. Seed moving to RVP is NOT re-credited
    // here - the planner already carries it (re-banded at its landed transfer
    // cost), and crediting it again would double-count. Storage→storage moves are
    // still re-credited, since nothing else accounts for them.
    const sortedTransfers = [...allTransfers].sort(
      (a, b) => a.transferDate.localeCompare(b.transferDate)
    );

    for (const t of sortedTransfers) {
      const fromBands = locBands[t.fromLocation];
      if (!fromBands || t.weightKg <= 0) continue;

      // Capitalised transfer costs that travel with the seed: hamali + transport +
      // bank-loan carrying interest. Identical to the server's addedCostPerKg, so
      // transferred seed lands in the SAME price band on both sides.
      const addedCostPerKg =
        (Number(t.loadingHamali) + Number(t.unloadingHamali) +
         Number(t.transportCharge) + Number(t.interestCharge)) / t.weightKg;

      const breakdown = depletePriceBands(fromBands, t.weightKg);
      if (breakdown.size === 0 || t.toLocation === 'RVP') continue;

      if (!locBands[t.toLocation]) locBands[t.toLocation] = [];
      const destBands = locBands[t.toLocation];
      const lotDate = t.transferDate.slice(0, 10);

      for (const [, portion] of breakdown) {
        // Re-band at the LANDED price (source price + transfer cost per kg), the
        // same key the server's stock engine uses for transferred-in seed.
        const sourcePrice = portion.kg > 0 ? portion.value / portion.kg : 0;
        const price = Math.round((sourcePrice + addedCostPerKg) * 100) / 100;
        const priceKey = price.toFixed(2);
        const landedValue = Math.round((portion.value + portion.kg * addedCostPerKg) * 100) / 100;

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
          lot.remainingValue += landedValue;
        } else {
          band.lots.push({
            purchaseId: `transfer-${t.id}-${priceKey}`,
            date: lotDate,
            partyName: `Transferred from ${t.fromLocation}`,
            lorryNumber: '-',
            poNumber: null,
            receivedKg: portion.kg,
            remainingKg: portion.kg,
            remainingValue: landedValue,
            transferredKg: 0,
            isTransferredIn: true,
            fromLocation: t.fromLocation,
          });
        }
        band.receivedKg += portion.kg;
        band.receivedValue += landedValue;
        band.remainingKg += portion.kg;
        band.remainingValue += landedValue;
        band.lots.sort((a, z) => a.date.localeCompare(z.date));
      }
      destBands.sort((a, z) => z.price - a.price);
    }

    // Step 3: RVP is the Order Planner's bands, adopted verbatim. The planner
    // allocates sales date-aware (a sale only draws from lots that had arrived by
    // its sale date, backlogging what it can't cover), which no lump-sum
    // depletion here can reproduce - re-deriving it was exactly why the totals
    // agreed but the leftover bands did not. Its ARRIVED lots already carry
    // post-draw-down `receivedKg` (remaining) and `soldKg` (consumed); transfers
    // into RVP are in there too, banded at their landed transfer cost.
    const rvpBands: PriceBand[] = [];
    for (const b of plannerData?.bands ?? []) {
      const arrivedLots = (b.lots ?? []).filter((l) => l.kind === 'ARRIVED');
      if (arrivedLots.length === 0) continue;

      const price = b.blackPricePerKg;
      const lots: PriceBandLot[] = arrivedLots.map((l) => ({
        purchaseId: l.purchaseId,
        date: (l.date ?? '').slice(0, 10),
        partyName: l.partyName,
        lorryNumber: l.lorryNumber,
        poNumber: l.poNumber,
        receivedKg: l.receivedKg + l.soldKg, // gross, before the planner's draw-down
        remainingKg: l.receivedKg,
        remainingValue: Math.round(l.receivedKg * price * 100) / 100,
        transferredKg: l.soldKg,
        // The engine keys a transferred lot as `<purchaseId>-transfer-<transferId>`.
        isTransferredIn: l.purchaseId.includes('-transfer-'),
      }));
      lots.sort((a, z) => a.date.localeCompare(z.date));

      // Band totals come from the planner's own figures (not re-summed from the
      // lots), so RVP's Stock on Hand and valuation equal the Order Planner's
      // Black Seed Remaining to the rupee.
      rvpBands.push({
        price,
        lorries: b.lorries,
        receivedKg: b.arrivedBlackKg,
        receivedValue: b.arrivedValue,
        remainingKg: b.remainingBlackKg,
        remainingValue: b.remainingValue,
        lots,
      });
    }
    locBands['RVP'] = rvpBands.sort((a, z) => z.price - a.price);

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
            Location-wise black-seed stock grouped into price bands. RVP is the Order Planner's own post-allocation
            bands, so the two pages agree band-for-band. Storage locations deplete by transfers out
            <span className="font-medium"> top to bottom</span> - highest-priced seed first, oldest lot first within a
            band - and transferred seed is re-banded at its landed cost (seed + hamali, transport and carrying
            interest). Valuation excludes GST.
          </p>
        </div>
        <ExportButtons
          filename={`Stock_By_Location_${String(selectedLoc).replace(/\s+/g, '_')}`}
          title={`Stock by Location - ${selectedLoc}`}
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
            {selectedLoc === 'RVP'
              ? 'Drawn down by the Order Planner’s date-aware sale allocation'
              : 'Highest-priced seed depleted first by transfers out'}
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
                                    <TableHead className="h-8 py-1 text-xs text-right">
                                      {selectedLoc === 'RVP' ? 'Seed Consumed'
                                        : selectedLoc === 'All' ? 'Seed Depleted'
                                        : 'Transferred Seed'}
                                    </TableHead>
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
