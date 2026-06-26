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

interface PriceBandResponse {
  blackPricePerKg: number;
  lorries: number;
  receivedBlackKg: number;
  receivedValue: number;
  remainingBlackKg: number;
  remainingValue: number;
  consumedBlackKg: number;
  lots: { purchaseId: string; date: string; partyName: string; lorryNumber: string; poNumber: string | null; receivedKg: number }[];
}

interface StockByPriceResponse {
  bands: PriceBandResponse[];
  pappuSoldKg: number;
  unsourcedPappuKg: number;
  outTurnPct: number;
}

interface PriceBand {
  blackPricePerKg: number;
  impliedPappuPrice: number; // blackPrice / out-turn
  lorries: number;
  blackSeedKg: number; // REMAINING black seed (after pappu-sale depletion)
  receivedBlackKg: number; // gross received
  consumedBlackKg: number; // sold/depleted
  produciblePappuKg: number; // remaining × out-turn
  value: number; // remaining value
  rows: BlackSeedRow[]; // received lots that make up the band
}

// 1 kg black seed yields 0.6 kg pappu. This is the bridge between a black-seed
// cost band and the pappu price/tonnage a customer asks for.
const PAPPU_OUTTURN = 0.6;

/**
 * Stock by Price — a pappu order planner driven by the black-seed cost basis.
 *
 * The page shows AT-PROCESS black seed grouped by purchase price, with recorded
 * PAPPU sales already depleted from the bands (highest-priced eligible band first,
 * capped at each sale's pappu-rate ceiling). You enter the pappu price + tonnage a
 * customer asks for and it pools every band at or below the break-even ceiling,
 * then reports producible pappu, shortage/excess, seed needed, and margin.
 */
export default function StockByPrice() {
  const [pappuPriceInput, setPappuPriceInput] = useState('');
  const [tonnageInput, setTonnageInput] = useState('');
  const [freightId, setFreightId] = useState('__none__');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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

  // Map the server's pre-computed bands (already depleted by pappu sales).
  const bands = useMemo<PriceBand[]>(() => {
    return (data?.bands ?? []).map((b) => ({
      blackPricePerKg: b.blackPricePerKg,
      impliedPappuPrice: b.blackPricePerKg / PAPPU_OUTTURN,
      lorries: b.lorries,
      blackSeedKg: b.remainingBlackKg,
      receivedBlackKg: b.receivedBlackKg,
      consumedBlackKg: b.consumedBlackKg,
      produciblePappuKg: b.remainingBlackKg * PAPPU_OUTTURN,
      value: b.remainingValue,
      rows: b.lots
        .map((l) => ({
          purchaseId: l.purchaseId,
          date: l.date,
          partyName: l.partyName,
          poNumber: l.poNumber,
          lorryNumber: l.lorryNumber,
          rvpNetWeightKg: l.receivedKg,
        }))
        .sort((a, z) => a.date.localeCompare(z.date)),
    }));
  }, [data]);

  const pappuSoldKg = data?.pappuSoldKg ?? 0;
  const unsourcedPappuKg = data?.unsourcedPappuKg ?? 0;

  // ─── Order planner maths ───────────────────────────────────────────────────
  const basePappuPrice = parseFloat(pappuPriceInput);
  const tonnage = parseFloat(tonnageInput);
  const hasPrice = Number.isFinite(basePappuPrice) && basePappuPrice > 0;
  const hasTonnage = Number.isFinite(tonnage) && tonnage > 0;
  // Freight (₹/kg) is a delivery cost subtracted from the asked pappu price to
  // get the net realisation → effective price the planner works on.
  const pappuPrice = Math.max(0, (hasPrice ? basePappuPrice : 0) - freightPerKg);

  const plan = useMemo(() => {
    if (!hasPrice || bands.length === 0) return null;
    // The asked pappu price sets the highest black-seed cost we can pay and still
    // break even: ceiling = pappuPrice × out-turn. EVERY band at or below this
    // ceiling is eligible to fulfil the order — cheaper seed works too — so we
    // pool them all rather than picking a single band.
    const ceilingBlackPrice = pappuPrice * PAPPU_OUTTURN;
    const eligible = bands.filter((b) => b.blackPricePerKg <= ceilingBlackPrice + 1e-6);
    const availableBlackKg = eligible.reduce((s, b) => s + b.blackSeedKg, 0);
    const producible = eligible.reduce((s, b) => s + b.produciblePappuKg, 0);
    const eligibleValue = eligible.reduce((s, b) => s + b.value, 0);
    const wacBlack = availableBlackKg > 0 ? eligibleValue / availableBlackKg : 0; // weighted-avg seed cost
    const wacPappuCost = wacBlack / PAPPU_OUTTURN; // weighted-avg pappu cost across eligible stock
    const askedPappuKg = hasTonnage ? tonnage * 1000 : 0;
    const blackRequiredKg = askedPappuKg / PAPPU_OUTTURN;
    const diff = producible - askedPappuKg; // + excess, − shortage
    // Extra black seed to source if the eligible stock can't cover the order.
    const seedShortfallKg = Math.max(0, blackRequiredKg - availableBlackKg);
    const fulfillmentPct = askedPappuKg > 0 ? Math.min(100, (producible / askedPappuKg) * 100) : 100;
    const marginPerKg = pappuPrice - wacPappuCost; // pappu sell − weighted-avg pappu cost
    return {
      ceilingBlackPrice, eligibleCount: eligible.length, availableBlackKg,
      producible, wacBlack, wacPappuCost, askedPappuKg, blackRequiredKg,
      seedShortfallKg, diff, fulfillmentPct, marginPerKg,
    };
  }, [bands, pappuPrice, tonnage, hasPrice, hasTonnage]);

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  // At-process totals (remaining = received − consumed by pappu sales).
  const totalBlackKg = bands.reduce((s, b) => s + b.blackSeedKg, 0);
  const totalReceivedKg = bands.reduce((s, b) => s + b.receivedBlackKg, 0);
  const totalProduciblePappuKg = bands.reduce((s, b) => s + b.produciblePappuKg, 0);

  const q = search.trim().toLowerCase();
  const visible = bands.filter((b) => {
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
        <h1 className="text-2xl font-bold">Stock by Price · Pappu Order Planner</h1>
        <p className="text-muted-foreground">
          Enter the pappu price and tonnage a customer asks for. The planner pools every black-seed cost band at or below the
          break-even ceiling (pappu price × {PAPPU_OUTTURN} out-turn), looks at all <span className="font-medium">committed stock</span>,
          and shows how much pappu that stock can produce, the shortage or excess, and your margin on the weighted-average cost.
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
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
            <div className="space-y-1">
              <Label htmlFor="pappu-price" className="text-xs text-muted-foreground">Pappu price asked (₹/kg)</Label>
              <Input
                id="pappu-price"
                type="number"
                min="0"
                step="0.5"
                value={pappuPriceInput}
                onChange={(e) => setPappuPriceInput(e.target.value)}
                placeholder="e.g. 42"
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
          </div>

          {hasPrice && freightPerKg > 0 && (
            <p className="text-xs text-muted-foreground">
              Pappu ₹{basePappuPrice.toFixed(2)} − freight {rupees(freightPerKg)}/kg ({rupees(selectedFreight!.ratePerTonne)}/t to {selectedFreight!.destination}) ={' '}
              <span className="font-semibold text-foreground">{rupees(pappuPrice)}/kg net</span>
            </p>
          )}

          {!hasPrice && (
            <p className="text-sm text-muted-foreground">Enter a pappu price to find the matching stock band.</p>
          )}

          {hasPrice && !plan && (
            <p className="text-sm text-muted-foreground">No black-seed stock at process to plan against.</p>
          )}

          {plan && (
            <div className="space-y-4">
              {/* Mapping line */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                <span>Pappu ₹{pappuPrice.toFixed(2)}/kg{freightPerKg > 0 ? ' (net of freight)' : ''}</span>
                <ArrowDownRight className="h-4 w-4" />
                <span>fulfilled from all seed at ≤</span>
                <Badge variant="outline" className="bg-primary/5 text-primary border-primary/20 font-bold">
                  {rupees(plan.ceilingBlackPrice)}/kg
                </Badge>
                <span>
                  · {plan.eligibleCount} band{plan.eligibleCount === 1 ? '' : 's'}
                  {plan.availableBlackKg > 0 && <> · avg cost {rupees(plan.wacPappuCost)}/kg pappu</>}
                </span>
              </div>

              {/* Result tiles */}
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <div className="rounded-lg border p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    <Wheat className="h-3 w-3" /> Committed Pappu
                  </div>
                  <div className="text-xl font-bold text-sky-600 mt-1">{toTonnes(plan.producible).toFixed(2)} MT</div>
                  <div className="text-[10px] text-muted-foreground">from {toTonnes(plan.availableBlackKg).toFixed(2)} MT seed · {plan.eligibleCount} band{plan.eligibleCount === 1 ? '' : 's'} ≤ {rupees(plan.ceilingBlackPrice)}</div>
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
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Price Bands</CardTitle>
            <Tag className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{bands.length}</div>
            <p className="text-[10px] text-muted-foreground mt-1">Distinct black-seed ₹/kg levels</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Black Seed Remaining</CardTitle>
            <Factory className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-600">{toTonnes(totalBlackKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">of {toTonnes(totalReceivedKg).toFixed(2)} MT committed</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Committed Pappu</CardTitle>
            <Wheat className="h-4 w-4 text-sky-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-sky-600">{toTonnes(totalProduciblePappuKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">From remaining seed @ {PAPPU_OUTTURN * 100}% out-turn</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pappu Sold</CardTitle>
            <ShoppingCart className="h-4 w-4 text-rose-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-rose-600">{toTonnes(pappuSoldKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">
              Depleted top-to-bottom by price
              {unsourcedPappuKg > 0 && <span className="block text-amber-600">⚠ {toTonnes(unsourcedPappuKg).toFixed(2)} MT over price-eligible stock</span>}
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
      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10"></TableHead>
              <TableHead>Black Seed Price</TableHead>
              <TableHead>Implied Pappu Price</TableHead>
              <TableHead className="text-right">Lorries</TableHead>
              <TableHead className="text-right">Remaining Seed (MT)</TableHead>
              <TableHead className="text-right">Sold (MT)</TableHead>
              <TableHead className="text-right">Committed Pappu (MT)</TableHead>
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
              const isEligible = plan && b.blackPricePerKg <= plan.ceilingBlackPrice + 1e-6;
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
                    <TableCell className="text-right font-semibold">
                      {toTonnes(b.blackSeedKg).toFixed(2)} MT
                      {b.consumedBlackKg > 0 && (
                        <span className="block text-[10px] text-muted-foreground font-normal">of {toTonnes(b.receivedBlackKg).toFixed(2)} received</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-medium text-rose-600">
                      {b.consumedBlackKg > 0 ? `${toTonnes(b.consumedBlackKg).toFixed(2)} MT` : '—'}
                    </TableCell>
                    <TableCell className="text-right font-semibold text-sky-600">{toTonnes(b.produciblePappuKg).toFixed(2)} MT</TableCell>
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
                            <span className="text-xs text-muted-foreground font-semibold">{b.lorries} lorry(s)</span>
                          </div>
                          <div className="overflow-x-auto">
                            <Table>
                              <TableHeader className="bg-muted/40">
                                <TableRow className="hover:bg-transparent">
                                  <TableHead className="h-8 py-1 text-xs">Date</TableHead>
                                  <TableHead className="h-8 py-1 text-xs">Party</TableHead>
                                  <TableHead className="h-8 py-1 text-xs">Lorry</TableHead>
                                  <TableHead className="h-8 py-1 text-xs">PO</TableHead>
                                  <TableHead className="h-8 py-1 text-xs text-right">Committed Seed</TableHead>
                                  <TableHead className="h-8 py-1 text-xs text-right">Committed Pappu</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {b.rows.map((r) => (
                                  <TableRow key={r.purchaseId} className="hover:bg-muted/20">
                                    <TableCell className="py-2 text-xs">{shortDate(r.date)}</TableCell>
                                    <TableCell className="py-2 text-xs font-medium text-foreground">{r.partyName}</TableCell>
                                    <TableCell className="py-2 text-xs font-mono">{r.lorryNumber || '—'}</TableCell>
                                    <TableCell className="py-2 text-xs font-mono">{r.poNumber || '—'}</TableCell>
                                    <TableCell className="py-2 text-xs text-right font-semibold">{kg(r.rvpNetWeightKg)}</TableCell>
                                    <TableCell className="py-2 text-xs text-right font-semibold text-sky-600">{kg(Math.round(r.rvpNetWeightKg * PAPPU_OUTTURN))}</TableCell>
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
  );
}
