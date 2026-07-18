import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Combobox } from '@/components/ui/combobox';
import type { Party } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UrpStockInDialog({ open, onOpenChange }: Props) {
  const qc = useQueryClient();

  // Form State
  const [partyId, setPartyId] = useState('');
  const [arrivalDate, setArrivalDate] = useState(new Date().toISOString().slice(0, 10));
  const [lorryNumber, setLorryNumber] = useState('');
  const [pricePerKg, setPricePerKg] = useState('');
  const [priceType, setPriceType] = useState<'BASE' | 'DELIVERY'>('DELIVERY');
  
  const [rvpFirstWeightKg, setRvpFirstWeightKg] = useState('');
  const [rvpSecondWeightKg, setRvpSecondWeightKg] = useState('');
  // Direct net-weight mode: for spot purchases with no separate tare weighment,
  // the operator ticks this and enters the RVP net directly. It still auto-records
  // the purchase and routes the arrival to Verification.
  const [useNetWeight, setUseNetWeight] = useState(false);
  const [rvpNetWeightKg, setRvpNetWeightKg] = useState('');
  const [billingWeightKg, setBillingWeightKg] = useState('');
  const [partyKataKg, setPartyKataKg] = useState('');
  // When the RVP net, billing weight and party kata are all identical (common for
  // spot buys), the operator enters the net once and it fills all three.
  const [sameWeight, setSameWeight] = useState(false);
  
  const [hasGst, setHasGst] = useState(false);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [freight, setFreight] = useState('0');
  // Shared lorry: the inward freight covers several parties' stock, so it is spread
  // over the whole vehicle's tonnage (not just this party's net weight).
  const [sharedVehicle, setSharedVehicle] = useState(false);
  const [freightTonnageKg, setFreightTonnageKg] = useState('');
  const [selfVehicle, setSelfVehicle] = useState(false);
  const [loadingLocation, setLoadingLocation] = useState<'RVP' | 'PGR COLD' | 'Murugan' | 'KNM Multi'>('RVP');

  // Load parties (Suppliers)
  const { data: parties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const suppliers = useMemo(() => parties?.filter((p) => p.type === 'SUPPLIER' || p.type === 'BOTH') ?? [], [parties]);

  const mutation = useMutation({
    // Route through the api() helper so the auth token is attached (the raw
    // fetch here sent no Authorization header → 401). multipart keeps the
    // FormData body for the future invoice-file upload.
    mutationFn: (data: FormData) => api('/stock-in/urp', { method: 'POST', multipart: true, body: data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stock-in'] });
      qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      toast.success('Direct purchase (URP) recorded successfully!');
      onOpenChange(false);
      resetForm();
    },
    onError: (err) => {
      toast.error(getErrorMessage(err));
    },
  });

  function resetForm() {
    setPartyId('');
    setLorryNumber('');
    setPricePerKg('');
    setRvpFirstWeightKg('');
    setRvpSecondWeightKg('');
    setUseNetWeight(false);
    setRvpNetWeightKg('');
    setBillingWeightKg('');
    setPartyKataKg('');
    setSameWeight(false);
    setHasGst(false);
    setInvoiceNumber('');
    setFreight('0');
    setSharedVehicle(false);
    setFreightTonnageKg('');
    setSelfVehicle(false);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!partyId) return toast.error('Please select a supplier');
    if (useNetWeight && (Number(rvpNetWeightKg) || 0) <= 0) {
      return toast.error('Enter the RVP net weight');
    }

    // "All three same" (direct-net only): the RVP net doubles as billing + party kata.
    const allSame = useNetWeight && sameWeight;
    const effectiveBilling = allSame ? rvpNetWeightKg : billingWeightKg;
    const effectivePartyKata = allSame ? rvpNetWeightKg : partyKataKg;

    const fd = new FormData();
    fd.append('partyId', partyId);
    fd.append('pricePerKg', pricePerKg);
    fd.append('priceType', priceType);
    fd.append('arrivalDate', arrivalDate);
    fd.append('lorryNumber', lorryNumber);
    if (hasGst) {
      fd.append('hasGst', 'true');
      if (invoiceNumber) {
        fd.append('invoiceNumber', invoiceNumber);
      }
    }
    if (useNetWeight) {
      // Direct net entry: store the net as the first weight (no tare) and flag the
      // explicit net so the server records it as-is and skips first − second.
      fd.append('rvpNetWeightKg', rvpNetWeightKg);
      fd.append('rvpFirstWeightKg', rvpNetWeightKg);
      fd.append('rvpSecondWeightKg', '0');
    } else {
      fd.append('rvpFirstWeightKg', rvpFirstWeightKg);
      fd.append('rvpSecondWeightKg', rvpSecondWeightKg || '0');
    }
    fd.append('billingWeightKg', effectiveBilling);
    fd.append('partyKataKg', effectivePartyKata);
    fd.append('loadingLocation', loadingLocation);
    fd.append('selfVehicle', selfVehicle ? 'true' : 'false');
    if (priceType === 'BASE') {
      fd.append('freightCharge', freight);
      // Shared lorry: spread the freight over the whole vehicle's tonnage. Left blank
      // (or unshared) → server falls back to this party's net weight as the basis.
      if (sharedVehicle && Number(freightTonnageKg) > 0) {
        fd.append('freightTonnageKg', freightTonnageKg);
      }
    }

    mutation.mutate(fd);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Direct Inward (URP / Spot Purchase)</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Supplier (Party)</Label>
              <Combobox
                options={suppliers.map((p) => ({ value: p.id, label: p.name }))}
                value={partyId}
                onChange={setPartyId}
                placeholder="Select supplier"
                searchPlaceholder="Search supplier…"
                emptyText="No suppliers found."
                className="w-full"
                ariaLabel="Supplier"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="arrivalDate">Arrival Date</Label>
              <Input id="arrivalDate" type="date" value={arrivalDate} onChange={(e) => setArrivalDate(e.target.value)} required />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 border-b pb-4">
            <div className="space-y-2">
              <Label htmlFor="lorry">Lorry Number</Label>
              <Input id="lorry" value={lorryNumber} onChange={(e) => setLorryNumber(e.target.value)} placeholder="AP02AB1234" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="price">Price (₹ / Kg)</Label>
              <Input id="price" type="number" step="0.01" value={pricePerKg} onChange={(e) => setPricePerKg(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label>Price Type</Label>
              <Select value={priceType} onValueChange={(v: 'BASE' | 'DELIVERY') => setPriceType(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="DELIVERY">Delivery</SelectItem>
                  <SelectItem value="BASE">Base</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center space-x-2 pt-2">
            <input
              type="checkbox"
              id="useNetWeight"
              checked={useNetWeight}
              onChange={(e) => setUseNetWeight(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
            />
            <Label htmlFor="useNetWeight" className="cursor-pointer">
              Enter RVP Net Weight directly <span className="text-xs font-normal text-muted-foreground">(spot purchase — no 2nd weighment)</span>
            </Label>
          </div>

          {useNetWeight ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="rvpNet">RVP Net Weight (Kg)</Label>
                  <Input id="rvpNet" type="number" value={rvpNetWeightKg} onChange={(e) => setRvpNetWeightKg(e.target.value)} required placeholder="e.g. 24500" />
                </div>
              </div>
              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="sameWeight"
                  checked={sameWeight}
                  onChange={(e) => setSameWeight(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
                <Label htmlFor="sameWeight" className="cursor-pointer">
                  Billing &amp; Party Kata same as RVP Net <span className="text-xs font-normal text-muted-foreground">(fills all three with the net)</span>
                </Label>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="rvpFirst">RVP First Weight (Gross Kg)</Label>
                <Input id="rvpFirst" type="number" value={rvpFirstWeightKg} onChange={(e) => setRvpFirstWeightKg(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="rvpSecond">RVP Second Weight (Tare Kg)</Label>
                <Input id="rvpSecond" type="number" value={rvpSecondWeightKg} onChange={(e) => setRvpSecondWeightKg(e.target.value)} placeholder="0 (Optional if direct unload)" />
              </div>
            </div>
          )}

          {useNetWeight && sameWeight ? (
            <p className="text-xs text-muted-foreground">
              Billing weight and party kata will both be set to the RVP net ({rvpNetWeightKg || '—'} kg).
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="billing">Billing Weight (Kg)</Label>
                <Input id="billing" type="number" value={billingWeightKg} onChange={(e) => setBillingWeightKg(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="partyKata">Party Kata (Kg)</Label>
                <Input id="partyKata" type="number" value={partyKataKg} onChange={(e) => setPartyKataKg(e.target.value)} required />
              </div>
            </div>
          )}

          <div className="flex items-center space-x-2 pt-2 pb-2">
            <input 
              type="checkbox" 
              id="hasGst" 
              checked={hasGst} 
              onChange={(e) => setHasGst(e.target.checked)} 
              className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
            />
            <Label htmlFor="hasGst" className="cursor-pointer">Has GST Invoice?</Label>
          </div>

          <div className="flex items-center space-x-2 pb-2">
            <input
              type="checkbox"
              id="selfVehicle"
              checked={selfVehicle}
              onChange={(e) => setSelfVehicle(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
            />
            <Label htmlFor="selfVehicle" className="cursor-pointer">
              Self vehicle? <span className="text-xs font-normal text-muted-foreground">(deducts ₹80/t lorry hamali from payable)</span>
            </Label>
          </div>

          {hasGst && (
            <div className="space-y-2 pb-2">
              <Label htmlFor="invoiceNum">GST Invoice Number</Label>
              <Input id="invoiceNum" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="INV-001" required={hasGst} />
            </div>
          )}

          {priceType === 'BASE' && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="space-y-2">
                <Label htmlFor="freight">Inward Freight (₹) - Base-priced PO</Label>
                <Input id="freight" type="number" step="0.01" value={freight} onChange={(e) => setFreight(e.target.value)} placeholder="0" />
              </div>

              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="sharedVehicle"
                  checked={sharedVehicle}
                  onChange={(e) => setSharedVehicle(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
                <Label htmlFor="sharedVehicle" className="cursor-pointer">
                  Shared vehicle? <span className="text-xs font-normal text-muted-foreground">(freight covers other parties too — spread over total lorry tonnage)</span>
                </Label>
              </div>

              {sharedVehicle && (
                <div className="space-y-2">
                  <Label htmlFor="freightTonnage">Total Vehicle Tonnage (Kg)</Label>
                  <Input
                    id="freightTonnage"
                    type="number"
                    value={freightTonnageKg}
                    onChange={(e) => setFreightTonnageKg(e.target.value)}
                    placeholder="e.g. 30000 (whole lorry load)"
                  />
                </div>
              )}

              {(() => {
                const base = Number(pricePerKg) || 0;
                const frt = Number(freight) || 0;
                const net = useNetWeight
                  ? Number(rvpNetWeightKg) || 0
                  : (Number(rvpFirstWeightKg) || 0) - (Number(rvpSecondWeightKg) || 0);
                const basis = sharedVehicle && Number(freightTonnageKg) > 0 ? Number(freightTonnageKg) : net;
                if (base <= 0 || frt <= 0 || basis <= 0) return null;
                const perKg = frt / basis;
                const delivery = base + perKg;
                return (
                  <p className="text-xs text-muted-foreground">
                    Delivery price = ₹{base.toFixed(2)} + (₹{frt.toLocaleString('en-IN')} ÷ {basis.toLocaleString('en-IN')} kg)
                    {' = '}<span className="font-semibold text-foreground">₹{delivery.toFixed(2)}/kg</span>
                    {' '}(+₹{perKg.toFixed(2)} freight/kg)
                  </p>
                );
              })()}
            </div>
          )}

          <div className="space-y-2 pb-4">
            <Label>Loading Location</Label>
            <Select value={loadingLocation} onValueChange={(v: any) => setLoadingLocation(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="RVP">RVP</SelectItem>
                <SelectItem value="PGR COLD">PGR Cold</SelectItem>
                <SelectItem value="Murugan">Murugan</SelectItem>
                <SelectItem value="KNM Multi">KNM Multi</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : 'Record Direct Inward'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
