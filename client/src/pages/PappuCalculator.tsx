import { useMemo, useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Scale, Calculator, ArrowRightLeft, Percent, Truck, Package, Factory, Leaf } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { rupees, toTonnes } from '@/lib/format';
import { api } from '@/lib/api';
import { stockSummary } from '@/lib/calc';
import type { FreightRate } from '@/lib/types';

export default function PappuCalculator() {
  const [blackSeedPrice, setBlackSeedPrice] = useState('20');
  const [millingCost, setMillingCost] = useState('1');
  const [huskPrice, setHuskPrice] = useState('1.5');
  const [wastePrice, setWastePrice] = useState('1.0');
  const [outTurnPct, setOutTurnPct] = useState('60');
  const [marginPct, setMarginPct] = useState(15);
  const [selectedFreightId, setSelectedFreightId] = useState<string>('__none__');

  const { data: defaults, isSuccess: defaultsLoaded } = useQuery({
    queryKey: ['calculator-defaults'],
    queryFn: () => api<{ blackSeedPrice: number, millingCost: number, huskPrice: number, wastePrice: number }>('/inventory/calculator-defaults'),
  });

  useEffect(() => {
    if (defaultsLoaded && defaults) {
      setBlackSeedPrice(String(defaults.blackSeedPrice));
      setMillingCost(String(defaults.millingCost));
      setHuskPrice(String(defaults.huskPrice));
      setWastePrice(String(defaults.wastePrice));
    }
  }, [defaultsLoaded, defaults]);

  const { data: freightRates } = useQuery({
    queryKey: ['freight-rates'],
    queryFn: () => api<FreightRate[]>('/settings/freight-rates'),
  });

  const { data: stockData } = useQuery({
    queryKey: ['black-seed-bands'],
    queryFn: () => api<{ bands: { arrivedBlackKg: number, remainingBlackKg: number, pendingBlackKg: number, pendingConsumableBlackKg: number }[] }>('/inventory/by-price'),
  });

  // Husk & Waste projections need the byproduct's own sales, same source the
  // Husk/Waste pages use, so the numbers stay in sync with those pages.
  const { data: byproductData } = useQuery({
    queryKey: ['black-seed-stock'],
    queryFn: () => api<{ huskSoldKg: number, wasteSoldKg: number }>('/inventory/black-seed'),
  });

  // Projection Calculations based on Order Planner logic
  const {
    availablePappuKg,
    committedPappuKg,
    availableHuskKg,
    committedHuskKg,
    availableWasteKg,
    committedWasteKg
  } = useMemo(() => {
    const bands = stockData?.bands ?? [];
    // Pappu mirrors the Order Planner exactly via the shared helper: available =
    // remaining seed × out-turn; committed adds the CONSUMABLE pending seed × out-turn.
    const pappu = stockSummary(bands);
    const availPappu = pappu.availablePappuKg;
    const commPappu = pappu.committedPappuKg;

    // Husk & Waste mirror the Husk/Waste pages: each byproduct's share of gross
    // arrived seed minus its own sales for available, plus its share of pending.
    const totalArrivedBlackKg = bands.reduce((sum, b) => sum + b.arrivedBlackKg, 0);
    const totalPendingBlackKg = bands.reduce((sum, b) => sum + b.pendingBlackKg, 0);
    const availHusk = Math.max(0, 0.25 * totalArrivedBlackKg - (byproductData?.huskSoldKg ?? 0));
    const availWaste = Math.max(0, 0.10 * totalArrivedBlackKg - (byproductData?.wasteSoldKg ?? 0));

    return {
      availablePappuKg: availPappu,
      committedPappuKg: commPappu,
      availableHuskKg: availHusk,
      committedHuskKg: availHusk + (0.25 * totalPendingBlackKg),
      availableWasteKg: availWaste,
      committedWasteKg: availWaste + (0.10 * totalPendingBlackKg)
    };
  }, [stockData, byproductData]);

  const selectedRate = freightRates?.find((r) => r.id === selectedFreightId);
  const freightRatePerTonne = selectedRate ? Number(selectedRate.ratePerTonne) : 0;

  const blackPriceNum = Number(blackSeedPrice) || 0;
  const millingNum = Number(millingCost) || 0;
  const huskPriceNum = Number(huskPrice) || 0;
  const wastePriceNum = Number(wastePrice) || 0;
  const yieldPctNum = Number(outTurnPct) || 60;

  // Let's do calculations based on 1,000 kg (1 Tonne) of raw Black Seed input
  const inputWeight = 1000;
  const rawSeedCost = inputWeight * blackPriceNum;
  const rawMillingCost = inputWeight * millingNum;
  const totalGrossCost = rawSeedCost + rawMillingCost;

  // Byproduct yields depend on the out-turn: whatever isn't pappu is shared by
  // husk / waste / loss in their original 25:10:5 ratio, so the split always sums
  // to 100%. Raise the out-turn → less husk & waste → fewer byproduct credits.
  const pappuFrac = yieldPctNum / 100;
  const nonPappuFrac = Math.max(0, 1 - pappuFrac);
  const HUSK_SHARE = 0.25 / 0.40;  // 62.5% of the non-pappu remainder
  const WASTE_SHARE = 0.10 / 0.40; // 25% of the non-pappu remainder
  const huskWeight = Math.round(inputWeight * nonPappuFrac * HUSK_SHARE);
  const wasteWeight = Math.round(inputWeight * nonPappuFrac * WASTE_SHARE);
  const pappuWeight = Math.round(inputWeight * pappuFrac); // outturn yield
  // Live byproduct percentages for display (they move with the out-turn).
  const huskPct = Math.round(nonPappuFrac * HUSK_SHARE * 100);
  const wastePct = Math.round(nonPappuFrac * WASTE_SHARE * 100);

  // Byproduct credits
  const huskCredit = huskWeight * huskPriceNum;
  const wasteCredit = wasteWeight * wastePriceNum;
  const totalCredits = huskCredit + wasteCredit;

  // Net cost after byproduct credits (before freight)
  const netCostAfterCredits = Math.max(0, totalGrossCost - totalCredits);

  // Freight is borne on the pappu we actually ship out (the sale product), not on
  // the raw black-seed input - so it scales with the out-turn yield (600 kg, 590 kg…),
  // not a flat 1 tonne of seed.
  const freightAmount = freightRatePerTonne * (pappuWeight / 1000);

  // Net cost incl. freight - this is the true cost base for pricing
  const netCostWithFreight = netCostAfterCredits + freightAmount;

  // Effective cost per kg (incl. freight)
  const effectiveCostPerKg = pappuWeight > 0 ? netCostWithFreight / pappuWeight : 0;
  const effectiveCostPerTonne = effectiveCostPerKg * 1000;

  // Base sale price per kg at desired margin
  const targetBasePricePerKg = effectiveCostPerKg * (1 + marginPct / 100);
  const baseSaleValue = targetBasePricePerKg * pappuWeight;

  // Total sale value (GST excluded from this calculator).
  const totalInvoiceValue = baseSaleValue;

  // Net profit = base sale − (gross cost + freight) + byproduct credits
  const netProfit = baseSaleValue - netCostWithFreight;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">White Pappu Conversion Calculator</h1>
        <p className="text-muted-foreground">Calculate the effective cost and target selling prices for White Pappu based on raw material costs and byproduct credits</p>
      </div>

      {/* Live Stock Projections */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="border-sky-200 bg-sky-50 dark:bg-sky-950/20">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-xs font-bold uppercase tracking-wider text-sky-700 dark:text-sky-400">Pappu Stock (MT)</CardTitle>
            <Package className="h-4 w-4 text-sky-600" />
          </CardHeader>
          <CardContent>
            <div className="flex justify-between items-baseline mb-1">
              <span className="text-sm text-sky-700/80 dark:text-sky-400/80">Available</span>
              <span className="font-bold text-sky-700 dark:text-sky-300">{toTonnes(availablePappuKg).toFixed(2)}</span>
            </div>
            <div className="flex justify-between items-baseline">
              <span className="text-sm font-medium text-sky-800 dark:text-sky-400">Committed</span>
              <span className="text-xl font-black text-sky-900 dark:text-sky-100">{toTonnes(committedPappuKg).toFixed(2)}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-amber-200 bg-amber-50 dark:bg-amber-950/20">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-xs font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400">Husk Projections (MT)</CardTitle>
            <Factory className="h-4 w-4 text-amber-600" />
          </CardHeader>
          <CardContent>
            <div className="flex justify-between items-baseline mb-1">
              <span className="text-sm text-amber-700/80 dark:text-amber-400/80">From Available</span>
              <span className="font-bold text-amber-700 dark:text-amber-300">{toTonnes(availableHuskKg).toFixed(2)}</span>
            </div>
            <div className="flex justify-between items-baseline">
              <span className="text-sm font-medium text-amber-800 dark:text-amber-400">From Committed</span>
              <span className="text-xl font-black text-amber-900 dark:text-amber-100">{toTonnes(committedHuskKg).toFixed(2)}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-stone-200 bg-stone-50 dark:bg-stone-900/50">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-xs font-bold uppercase tracking-wider text-stone-700 dark:text-stone-400">T-Waste Projections (MT)</CardTitle>
            <Leaf className="h-4 w-4 text-stone-600" />
          </CardHeader>
          <CardContent>
            <div className="flex justify-between items-baseline mb-1">
              <span className="text-sm text-stone-600 dark:text-stone-400">From Available</span>
              <span className="font-bold text-stone-700 dark:text-stone-300">{toTonnes(availableWasteKg).toFixed(2)}</span>
            </div>
            <div className="flex justify-between items-baseline">
              <span className="text-sm font-medium text-stone-800 dark:text-stone-300">From Committed</span>
              <span className="text-xl font-black text-stone-900 dark:text-stone-100">{toTonnes(committedWasteKg).toFixed(2)}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Costing Inputs */}
        <Card className="lg:col-span-1 border bg-card">
          <CardHeader className="pb-3 border-b flex flex-row items-center gap-2">
            <Calculator className="h-4 w-4 text-primary" />
            <CardTitle className="text-sm font-semibold uppercase tracking-wider">Conversion Inputs</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="blackSeed">Raw Black Seed Cost (₹/kg)</Label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-xs text-muted-foreground font-semibold">₹</span>
                <Input id="blackSeed" type="number" step="0.1" value={blackSeedPrice} onChange={(e) => setBlackSeedPrice(e.target.value)} className="pl-6" />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="milling">Milling / Processing Cost (₹/kg of Black Seed)</Label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-xs text-muted-foreground font-semibold">₹</span>
                <Input id="milling" type="number" step="0.05" value={millingCost} onChange={(e) => setMillingCost(e.target.value)} className="pl-6" />
              </div>
            </div>

            <div className="space-y-1.5 pt-2 border-t">
              <Label htmlFor="husk">Husk Selling Price (₹/kg)</Label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-xs text-muted-foreground font-semibold">₹</span>
                <Input id="husk" type="number" step="0.1" value={huskPrice} onChange={(e) => setHuskPrice(e.target.value)} className="pl-6" />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="waste">Tamarind Waste Price (₹/kg)</Label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-xs text-muted-foreground font-semibold">₹</span>
                <Input id="waste" type="number" step="0.1" value={wastePrice} onChange={(e) => setWastePrice(e.target.value)} className="pl-6" />
              </div>
            </div>

            <div className="space-y-1.5 pt-2 border-t">
              <Label htmlFor="outturn">White Pappu Yield Outturn (%)</Label>
              <div className="relative">
                <span className="absolute right-3 top-2.5 text-xs text-muted-foreground font-semibold">%</span>
                <Input id="outturn" type="number" step="1" value={outTurnPct} onChange={(e) => setOutTurnPct(e.target.value)} className="pr-6" />
              </div>
            </div>

            <div className="space-y-1.5 pt-2 border-t">
              <Label htmlFor="freight-dest" className="flex items-center gap-1.5">
                <Truck className="h-3.5 w-3.5" /> Freight Destination
              </Label>
              <Select value={selectedFreightId} onValueChange={setSelectedFreightId}>
                <SelectTrigger id="freight-dest" className="w-full">
                  <SelectValue placeholder="Select destination" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No freight</SelectItem>
                  {freightRates?.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.destination} - {rupees(r.ratePerTonne)}/t
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {freightRatePerTonne > 0 && (
                <p className="text-[10px] text-muted-foreground">
                  {rupees(freightRatePerTonne)}/tonne × {pappuWeight} kg pappu = <span className="font-semibold text-blue-600">{rupees(freightAmount)}</span> added to cost
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Costing Output Sheets & Margins */}
        <div className="lg:col-span-2 space-y-6">
          {/* Main effective cost card */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="bg-primary/[0.02] border border-primary/20 shadow-sm">
              <CardContent className="pt-5 flex items-start gap-4">
                <div className="rounded-lg bg-primary/10 p-2.5 text-primary">
                  <ArrowRightLeft className="h-5 w-5" />
                </div>
                <div>
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Effective Pappu Cost</span>
                  <div className="text-3xl font-extrabold text-primary tracking-tight mt-1">
                    {rupees(effectiveCostPerKg)} <span className="text-sm font-semibold text-muted-foreground">/ kg</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">Equals {rupees(effectiveCostPerTonne)} per Tonne · incl. freight</p>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-card border shadow-sm">
              <CardContent className="pt-5 flex items-start gap-4">
                <div className="rounded-lg bg-emerald-500/10 p-2.5 text-emerald-600 dark:text-emerald-500">
                  <Percent className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Target Base Price ({marginPct}%)</span>
                  <div className="text-3xl font-extrabold text-emerald-600 dark:text-emerald-500 tracking-tight mt-1">
                    {rupees(targetBasePricePerKg)} <span className="text-sm font-semibold text-muted-foreground">/ kg</span>
                  </div>
                  {/* Interactive Margin Slider */}
                  <div className="mt-3 flex items-center gap-3">
                    <input
                      type="range"
                      min="0"
                      max="30"
                      step="1"
                      value={marginPct}
                      onChange={(e) => setMarginPct(Number(e.target.value))}
                      className="w-full h-1 bg-muted rounded-lg appearance-none cursor-pointer accent-emerald-500"
                    />
                    <span className="text-xs font-bold text-emerald-600 shrink-0">{marginPct}%</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Breakdown Sheet */}
          <Card className="border bg-card">
            <CardHeader className="pb-3 border-b flex flex-row items-center justify-between">
              <span className="font-semibold text-sm">Cost Breakdown Sheet (per Tonne of Raw Black Seed)</span>
              <Scale className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="pt-4 space-y-4">
              <div className="space-y-2 text-sm">
                <div className="flex justify-between items-center text-muted-foreground">
                  <span>Raw Seed Cost (1,000 kg @ {rupees(blackPriceNum)}/kg)</span>
                  <span className="font-medium text-foreground">{rupees(rawSeedCost)}</span>
                </div>
                <div className="flex justify-between items-center text-muted-foreground">
                  <span>Milling / Processing Cost (1,000 kg @ {rupees(millingNum)}/kg)</span>
                  <span className="font-medium text-foreground">{rupees(rawMillingCost)}</span>
                </div>
                <div className="flex justify-between items-center border-t pt-2 font-bold text-foreground">
                  <span>Gross Cost</span>
                  <span>{rupees(totalGrossCost)}</span>
                </div>
              </div>

              {/* Byproduct Credits */}
              <div className="space-y-2 text-sm pt-2 border-t">
                <span className="text-xs font-bold text-primary uppercase tracking-wider">Byproduct Credits (Deducted)</span>
                <div className="flex justify-between items-center text-muted-foreground">
                  <span>Husk Sale ({huskPct}% yield = {huskWeight} kg @ {rupees(huskPriceNum)}/kg)</span>
                  <span className="font-medium text-foreground text-emerald-600 dark:text-emerald-500">-{rupees(huskCredit)}</span>
                </div>
                <div className="flex justify-between items-center text-muted-foreground">
                  <span>Tamarind Waste Sale ({wastePct}% yield = {wasteWeight} kg @ {rupees(wastePriceNum)}/kg)</span>
                  <span className="font-medium text-foreground text-emerald-600 dark:text-emerald-500">-{rupees(wasteCredit)}</span>
                </div>
                <div className="flex justify-between items-center border-t pt-2 font-bold text-emerald-600 dark:text-emerald-500">
                  <span>Total Byproduct Credits</span>
                  <span>-{rupees(totalCredits)}</span>
                </div>
              </div>

              {/* Final Calculations */}
              <div className="space-y-2 text-sm pt-4 border-t-2 border-dashed">
                <div className="flex justify-between items-center text-muted-foreground">
                  <span>Net Cost for Pappu Yield ({pappuWeight} kg)</span>
                  <span className="font-semibold text-foreground">{rupees(netCostAfterCredits)}</span>
                </div>
                {freightAmount > 0 && (
                  <div className="flex justify-between items-center text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <Truck className="h-3 w-3" /> Freight to {selectedRate?.destination}
                      <span className="text-[10px] bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 font-bold px-1.5 py-0.5 rounded">{rupees(freightRatePerTonne)}/t × {pappuWeight} kg</span>
                    </span>
                    <span className="font-semibold text-blue-600 dark:text-blue-400">+{rupees(freightAmount)}</span>
                  </div>
                )}
                {freightAmount > 0 && (
                  <div className="flex justify-between items-center border-t pt-2 font-bold text-foreground">
                    <span>Net Cost incl. Freight ({pappuWeight} kg)</span>
                    <span>{rupees(netCostWithFreight)}</span>
                  </div>
                )}
                <div className="flex justify-between items-center text-muted-foreground">
                  <span>Target Net Profit ({marginPct}%)</span>
                  <span className="font-semibold text-emerald-600 dark:text-emerald-500">+{rupees(netProfit)}</span>
                </div>
                <div className="flex justify-between items-center pt-2 border-t font-bold text-foreground">
                  <span>Base Pappu Sale Value ({pappuWeight} kg @ {rupees(targetBasePricePerKg)}/kg)</span>
                  <span>{rupees(baseSaleValue)}</span>
                </div>
                <div className="flex justify-between items-center pt-3 mt-1 border-t-2 border-primary/30 text-base font-extrabold text-primary">
                  <span>Total Sale Value</span>
                  <span>{rupees(totalInvoiceValue)}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
