import { useState } from 'react';
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
  const [billingWeightKg, setBillingWeightKg] = useState('');
  const [partyKataKg, setPartyKataKg] = useState('');
  
  const [hasGst, setHasGst] = useState(false);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [freight, setFreight] = useState('0');
  const [selfVehicle, setSelfVehicle] = useState(false);
  const [loadingLocation, setLoadingLocation] = useState<'RVP' | 'PGR COLD' | 'Murugan' | 'KNM Multi'>('RVP');

  // Load parties (Suppliers)
  const { data: parties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const suppliers = parties?.filter((p) => p.type === 'SUPPLIER' || p.type === 'BOTH') ?? [];

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
    setBillingWeightKg('');
    setPartyKataKg('');
    setHasGst(false);
    setInvoiceNumber('');
    setFreight('0');
    setSelfVehicle(false);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!partyId) return toast.error('Please select a supplier');

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
    fd.append('rvpFirstWeightKg', rvpFirstWeightKg);
    fd.append('rvpSecondWeightKg', rvpSecondWeightKg || '0');
    fd.append('billingWeightKg', billingWeightKg);
    fd.append('partyKataKg', partyKataKg);
    fd.append('loadingLocation', loadingLocation);
    fd.append('selfVehicle', selfVehicle ? 'true' : 'false');
    if (priceType === 'BASE') {
      fd.append('freightCharge', freight);
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

          <div className="grid grid-cols-2 gap-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="rvpFirst">RVP First Weight (Gross Kg)</Label>
              <Input id="rvpFirst" type="number" value={rvpFirstWeightKg} onChange={(e) => setRvpFirstWeightKg(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rvpSecond">RVP Second Weight (Tare Kg)</Label>
              <Input id="rvpSecond" type="number" value={rvpSecondWeightKg} onChange={(e) => setRvpSecondWeightKg(e.target.value)} placeholder="0 (Optional if direct unload)" />
            </div>
          </div>

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
            <div className="space-y-2">
              <Label htmlFor="freight">Inward Freight (₹) - Base-priced PO</Label>
              <Input id="freight" type="number" step="0.01" value={freight} onChange={(e) => setFreight(e.target.value)} placeholder="0" />
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
