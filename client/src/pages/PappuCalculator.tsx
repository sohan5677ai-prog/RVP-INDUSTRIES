import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Scale, Calculator, ArrowRightLeft, Percent, Truck } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { rupees } from '@/lib/format';
import { api } from '@/lib/api';
import type { FreightRate } from '@/lib/types';

export default function PappuCalculator() {
  const [blackSeedPrice, setBlackSeedPrice] = useState('20');
  const [millingCost, setMillingCost] = useState('2.5');
  const [huskPrice, setHuskPrice] = useState('1.5');
  const [wastePrice, setWastePrice] = useState('1.0');
  const [outTurnPct, setOutTurnPct] = useState('60');
  const [marginPct, setMarginPct] = useState(15);
  const [selectedFreightId, setSelectedFreightId] = useState<string>('__none__');

  const { data: freightRates } = useQuery({
    queryKey: ['freight-rates'],
    queryFn: () => api<FreightRate[]>('/settings/freight-rates'),
  });

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

  // Byproduct yields based on input weight
  const huskWeight = Math.round(inputWeight * 0.25); // 25% yield
  const wasteWeight = Math.round(inputWeight * 0.10); // 10% yield
  const pappuWeight = Math.round(inputWeight * (yieldPctNum / 100)); // outturn yield

  // Byproduct credits
  const huskCredit = huskWeight * huskPriceNum;
  const wasteCredit = wasteWeight * wastePriceNum;
  const totalCredits = huskCredit + wasteCredit;

  // Net cost after byproduct credits (before freight)
  const netCostAfterCredits = Math.max(0, totalGrossCost - totalCredits);

  // Freight on full 1 tonne input
  const freightAmount = freightRatePerTonne * (inputWeight / 1000);

  // Net cost incl. freight — this is the true cost base for pricing
  const netCostWithFreight = netCostAfterCredits + freightAmount;

  // Effective cost per kg (incl. freight)
  const effectiveCostPerKg = pappuWeight > 0 ? netCostWithFreight / pappuWeight : 0;
  const effectiveCostPerTonne = effectiveCostPerKg * 1000;

  // Base sale price per kg at desired margin
  const targetBasePricePerKg = effectiveCostPerKg * (1 + marginPct / 100);
  const baseSaleValue = targetBasePricePerKg * pappuWeight;

  // GST @ 5% on base sale value
  const gstAmount = baseSaleValue * 0.05;

  // Total Invoice Value = base sale + GST
  const totalInvoiceValue = baseSaleValue + gstAmount;

  // Net profit = base sale − (gross cost + freight) + byproduct credits
  const netProfit = baseSaleValue - netCostWithFreight;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">White Pappu Conversion Calculator</h1>
        <p className="text-muted-foreground">Calculate the effective cost and target selling prices for White Pappu based on raw material costs and byproduct credits</p>
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
                      {r.destination} — {rupees(r.ratePerTonne)}/t
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {freightRatePerTonne > 0 && (
                <p className="text-[10px] text-muted-foreground">
                  {rupees(freightRatePerTonne)}/tonne × 1 t (full input) = <span className="font-semibold text-blue-600">{rupees(freightAmount)}</span> added to cost
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
                  <span>Husk Sale (25% yield = 250 kg @ {rupees(huskPriceNum)}/kg)</span>
                  <span className="font-medium text-foreground text-emerald-600 dark:text-emerald-500">-{rupees(huskCredit)}</span>
                </div>
                <div className="flex justify-between items-center text-muted-foreground">
                  <span>Tamarind Waste Sale (10% yield = 100 kg @ {rupees(wastePriceNum)}/kg)</span>
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
                      <span className="text-[10px] bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 font-bold px-1.5 py-0.5 rounded">{rupees(freightRatePerTonne)}/t</span>
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
                <div className="flex justify-between items-center text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    GST
                    <span className="text-[10px] bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400 font-bold px-1.5 py-0.5 rounded">5% IGST</span>
                  </span>
                  <span className="font-semibold text-violet-600 dark:text-violet-400">+{rupees(gstAmount)}</span>
                </div>
                <div className="flex justify-between items-center pt-3 mt-1 border-t-2 border-primary/30 text-base font-extrabold text-primary">
                  <span>Total Invoice Value (incl. GST)</span>
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
