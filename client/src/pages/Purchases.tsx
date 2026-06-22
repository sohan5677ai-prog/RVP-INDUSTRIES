import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { Purchase, StockIn, BunkerPlace } from '@/lib/types';
import { calcHamali, calcKataFee, calcBags, calcBagCutting, BAG_RATE, DEFAULT_HAMALI_RATE, isVehicleExempt } from '@/lib/calc';
import { kg, rupees, shortDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import type { CompanyProfile } from '@/lib/types';

type PurchaseRow = Purchase & {
  stockIn?: StockIn & { purchaseOrder?: { party?: { name: string }; poNumber?: string; pricePerKg?: string; priceType?: 'BASE' | 'DELIVERY' } };
};
type StockInRow = StockIn & { purchaseOrder?: { party?: { name: string }; poNumber?: string; priceType?: 'BASE' | 'DELIVERY' }; purchase?: Purchase | null };

export default function Purchases() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PurchaseRow | null>(null);

  const { data: items, isLoading } = useQuery({
    queryKey: ['purchases'],
    queryFn: () => api<PurchaseRow[]>('/purchases'),
  });

  const { data: stockIns } = useQuery({
    queryKey: ['stock-in'],
    queryFn: () => api<StockInRow[]>('/stock-in'),
  });
  
  const { data: companyProfile } = useQuery({
    queryKey: ['company'],
    queryFn: () => api<CompanyProfile>('/settings/company'),
  });
  
  const available = stockIns?.filter((s) => !s.purchase) ?? [];

  const [stockInId, setStockInId] = useState('');
  const [rvpSecondWeight, setRvpSecondWeight] = useState('');
  const [hamaliRate, setHamaliRate] = useState(String(DEFAULT_HAMALI_RATE));
  const [bunkerPlace, setBunkerPlace] = useState<BunkerPlace | ''>('');

  const selected = available.find((s) => s.id === stockInId);
  const rvpFirst = editing ? (editing.stockIn?.rvpFirstWeightKg ?? 0) : (selected?.rvpFirstWeightKg ?? 0);
  const lorryNumber = editing ? editing.stockIn?.lorryNumber : selected?.lorryNumber;
  const isCompanyVehicle = isVehicleExempt(lorryNumber, companyProfile?.companyVehicles);

  const net = rvpFirst - (Number(rvpSecondWeight) || 0);
  const rate = Number(hamaliRate) || 0;
  const netValid = net > 0 && (Number(rvpSecondWeight) || 0) > 0;
  const hamali = netValid ? calcHamali(net, rate, isCompanyVehicle) : 0;
  const kataFeeVal = netValid ? calcKataFee(net, isCompanyVehicle) : 0;
  // Bag-cutting only applies when the seed lands directly at the process bunker.
  const location = editing ? editing.stockIn?.loadingLocation : selected?.loadingLocation;
  const isAtProcess = location === 'At process';
  const bags = netValid ? calcBags(net) : 0;
  const bagCutting = netValid && isAtProcess && bunkerPlace ? calcBagCutting(net, bunkerPlace) : 0;
  // Inward freight is captured at Stock In (BASE-priced POs only); shown here
  // read-only, sourced from the stock-in record.
  const priceType = editing ? editing.stockIn?.purchaseOrder?.priceType : selected?.purchaseOrder?.priceType;
  const isBase = priceType === 'BASE';
  const freightVal = isBase ? Number((editing ? editing.stockIn?.freightCharge : selected?.freightCharge) ?? 0) : 0;

  function resetForm() {
    setEditing(null);
    setStockInId('');
    setRvpSecondWeight('');
    setHamaliRate(String(DEFAULT_HAMALI_RATE));
    setBunkerPlace('');
  }

  function openEdit(p: PurchaseRow) {
    setEditing(p);
    setStockInId(p.stockInId);
    setRvpSecondWeight(p.stockIn ? String(p.stockIn.rvpSecondWeightKg) : '');
    setHamaliRate(String(p.hamaliRate));
    setBunkerPlace((p.bunkerPlace as BunkerPlace) ?? '');
    setOpen(true);
  }

  const mutation = useMutation({
    mutationFn: () => {
      const url = editing ? `/purchases/${editing.id}` : '/purchases';
      const method = editing ? 'PUT' : 'POST';
      const place = isAtProcess && bunkerPlace ? bunkerPlace : null;
      const body = editing
        ? { stockInId: editing.stockInId, rvpSecondWeightKg: Number(rvpSecondWeight), hamaliRate: rate, bunkerPlace: place }
        : { stockInId, rvpSecondWeightKg: Number(rvpSecondWeight), hamaliRate: rate, bunkerPlace: place };
      return api<PurchaseRow>(url, { method, body });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchases'] });
      qc.invalidateQueries({ queryKey: ['stock-in'] });
      toast.success(editing ? 'Purchase updated' : 'Purchase recorded');
      setOpen(false);
      resetForm();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/purchases/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchases'] });
      qc.invalidateQueries({ queryKey: ['stock-in'] });
      toast.success('Purchase record deleted');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Purchase</h1>
          <p className="text-muted-foreground">
            Record purchases from stock-ins and set the hamali rate. Weight verification is done on the Verification page.
          </p>
        </div>
        <Button onClick={() => { resetForm(); setOpen(true); }} disabled={!available.length}>
          <Plus className="h-4 w-4" /> Record Purchase
        </Button>
      </div>

      {available.length === 0 && (
        <p className="text-sm text-muted-foreground">No stock-ins awaiting purchase completion.</p>
      )}

      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Party</TableHead>
              <TableHead>Invoice No</TableHead>
              <TableHead className="text-right">Price/kg</TableHead>
              <TableHead className="text-right">Net (RVP)</TableHead>
              <TableHead className="text-right">Hamali</TableHead>
              <TableHead className="text-right">Kata Fee</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {items?.length === 0 && (
              <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">No purchases yet.</TableCell></TableRow>
            )}
            {items?.map((p) => (
              <TableRow key={p.id}>
                 <TableCell>{shortDate(p.createdAt)}</TableCell>
                <TableCell className="font-medium">
                  {p.stockIn?.purchaseOrder?.party?.name ?? '—'}
                  {p.stockIn?.purchaseOrder?.poNumber && (
                    <span className="ml-2 text-xs text-muted-foreground font-mono">({p.stockIn.purchaseOrder.poNumber})</span>
                  )}
                </TableCell>
                <TableCell className="font-semibold">{p.stockIn?.invoiceNumber ?? '—'}</TableCell>
                <TableCell className="text-right">
                  {p.stockIn?.purchaseOrder?.pricePerKg ? rupees(p.stockIn.purchaseOrder.pricePerKg) : '—'}
                  {p.stockIn?.purchaseOrder?.priceType && (
                    <span className="block text-[10px] text-muted-foreground">{p.stockIn.purchaseOrder.priceType === 'BASE' ? 'Base' : 'Delivery'}</span>
                  )}
                </TableCell>
                <TableCell className="text-right">{kg(p.netWeightKg)}</TableCell>
                <TableCell className="text-right">{rupees(p.hamaliCharge)}</TableCell>
                <TableCell className="text-right">{rupees(p.kataFee)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" onClick={() => openEdit(p)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (confirm('Delete this purchase record? This will release the Stock-In for re-purchase.')) {
                          deleteMutation.mutate(p.id);
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{editing ? 'Edit Purchase' : 'Record Purchase'}</DialogTitle></DialogHeader>
          <div className="space-y-4">
             {editing ? (
              <div className="space-y-2">
                <Label>Stock-in</Label>
                <Input
                  disabled
                  value={`${editing.stockIn?.purchaseOrder?.poNumber} · ${editing.stockIn?.purchaseOrder?.party?.name} — Inv ${editing.stockIn?.invoiceNumber}`}
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label>Stock-in (awaiting purchase record)</Label>
                <Select value={stockInId} onValueChange={setStockInId}>
                   <SelectTrigger><SelectValue placeholder="Select a stock-in" /></SelectTrigger>
                  <SelectContent>
                    {available.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.purchaseOrder?.poNumber} · {s.purchaseOrder?.party?.name} — Inv {s.invoiceNumber} (Lorry {s.lorryNumber}) · First Weight {kg(s.rvpFirstWeightKg)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="rvpSecond">RVP second weight / tare (kg)</Label>
              <Input id="rvpSecond" type="number" value={rvpSecondWeight} onChange={(e) => setRvpSecondWeight(e.target.value)} placeholder="e.g. 9500" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rate">Hamali rate (₹/tonne)</Label>
              <Input id="rate" type="number" step="0.01" value={hamaliRate} onChange={(e) => setHamaliRate(e.target.value)} />
            </div>

            {isAtProcess ? (
              <div className="space-y-2">
                <Label>Bunker place (bag-cutting)</Label>
                <Select value={bunkerPlace} onValueChange={(v: any) => setBunkerPlace(v)}>
                  <SelectTrigger><SelectValue placeholder="Select place A or B" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A">Place A — ₹{BAG_RATE.A}/bag</SelectItem>
                    <SelectItem value="B">Place B — ₹{BAG_RATE.B}/bag</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : location ? (
              <p className="text-xs text-muted-foreground">
                Stock is at <span className="font-medium">{location}</span> — bag-cutting is charged later, on the Stock Transfer to the process.
              </p>
            ) : null}

            {isBase && (
              <p className="text-xs text-muted-foreground">
                Inward freight {freightVal > 0 ? <span className="font-medium">{rupees(freightVal)}</span> : 'is'} captured at Stock In (base-priced PO){freightVal > 0 ? '' : ' — none entered'}; it's capitalised into the seed and tracked in the Purchase Freight ledger.
              </p>
            )}

             <div className="rounded-lg border bg-muted/40 p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">RVP First Weight (gross)</span>
                <span className="font-medium">{rvpFirst > 0 ? kg(rvpFirst) : '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">RVP Second Weight (tare)</span>
                <span className="font-medium">{Number(rvpSecondWeight) > 0 ? kg(Number(rvpSecondWeight)) : '—'}</span>
              </div>
              <div className="flex justify-between border-t pt-2">
                <span className="text-muted-foreground font-semibold">RVP Net Weight</span>
                <span className={`font-bold ${netValid ? 'text-primary' : 'text-destructive'}`}>{netValid ? kg(net) : '—'}</span>
              </div>
              <div className="flex justify-between border-t pt-2">
                <span className="text-muted-foreground">Hamali = rounded(net/1000) × rate</span>
                <span className="font-semibold text-right">
                  {isCompanyVehicle ? (
                    <span className="text-emerald-600 dark:text-emerald-400 text-xs">Exempted<br />{rupees(0)}</span>
                  ) : (
                    netValid ? rupees(hamali) : '—'
                  )}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Kata Fee (weighbridge)</span>
                <span className="font-semibold text-right">
                  {isCompanyVehicle ? (
                    <span className="text-emerald-600 dark:text-emerald-400 text-xs">Exempted<br />{rupees(0)}</span>
                  ) : (
                    netValid ? rupees(kataFeeVal) : '—'
                  )}
                </span>
              </div>
              {isAtProcess && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    Bag-cutting {bunkerPlace ? `(${bags} bags @ ₹${BAG_RATE[bunkerPlace]})` : '(select place)'}
                  </span>
                  <span className="font-semibold">{bagCutting > 0 ? rupees(bagCutting) : '—'}</span>
                </div>
              )}
              {isBase && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Inward freight (base price)</span>
                  <span className="font-semibold">{freightVal > 0 ? rupees(freightVal) : '—'}</span>
                </div>
              )}
              <p className="text-xs text-muted-foreground pt-1 border-t mt-1">
                Saves the purchase with net weight, hamali, kata fee{isBase ? ', and inward freight' : ''}. Run weight verification afterwards on the Verification page.
              </p>
            </div>

            <DialogFooter>
              <Button onClick={() => mutation.mutate()} disabled={(!editing && !stockInId) || !netValid || mutation.isPending}>
                {mutation.isPending ? 'Saving…' : 'Save purchase'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
