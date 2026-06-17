import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { Purchase, StockIn } from '@/lib/types';
import { calcHamali, calcKataFee, DEFAULT_HAMALI_RATE } from '@/lib/calc';
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

type PurchaseRow = Purchase & {
  stockIn?: StockIn & { purchaseOrder?: { party?: { name: string }; poNumber?: string } };
};
type StockInRow = StockIn & { purchaseOrder?: { party?: { name: string }; poNumber?: string }; purchase?: Purchase | null };

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
  const available = stockIns?.filter((s) => !s.purchase) ?? [];

  const [stockInId, setStockInId] = useState('');
  const [rvpSecondWeight, setRvpSecondWeight] = useState('');
  const [hamaliRate, setHamaliRate] = useState(String(DEFAULT_HAMALI_RATE));

  const selected = available.find((s) => s.id === stockInId);
  const rvpFirst = editing ? (editing.stockIn?.rvpFirstWeightKg ?? 0) : (selected?.rvpFirstWeightKg ?? 0);
  const net = rvpFirst - (Number(rvpSecondWeight) || 0);
  const rate = Number(hamaliRate) || 0;
  const netValid = net > 0 && (Number(rvpSecondWeight) || 0) > 0;
  const hamali = netValid ? calcHamali(net, rate) : 0;
  const kataFeeVal = netValid ? calcKataFee(net) : 0;

  function resetForm() {
    setEditing(null);
    setStockInId('');
    setRvpSecondWeight('');
    setHamaliRate(String(DEFAULT_HAMALI_RATE));
  }

  function openEdit(p: PurchaseRow) {
    setEditing(p);
    setStockInId(p.stockInId);
    setRvpSecondWeight(p.stockIn ? String(p.stockIn.rvpSecondWeightKg) : '');
    setHamaliRate(String(p.hamaliRate));
    setOpen(true);
  }

  const mutation = useMutation({
    mutationFn: () => {
      const url = editing ? `/purchases/${editing.id}` : '/purchases';
      const method = editing ? 'PUT' : 'POST';
      const body = editing
        ? { stockInId: editing.stockInId, rvpSecondWeightKg: Number(rvpSecondWeight), hamaliRate: rate }
        : { stockInId, rvpSecondWeightKg: Number(rvpSecondWeight), hamaliRate: rate };
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
              <TableHead className="text-right">Net (RVP)</TableHead>
              <TableHead className="text-right">Hamali</TableHead>
              <TableHead className="text-right">Kata Fee</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {items?.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">No purchases yet.</TableCell></TableRow>
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
                <span className="font-semibold">{netValid ? rupees(hamali) : '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Kata Fee (weighbridge)</span>
                <span className="font-semibold">{netValid ? rupees(kataFeeVal) : '—'}</span>
              </div>
              <p className="text-xs text-muted-foreground pt-1 border-t mt-1">
                Saves the purchase with the calculated net weight, hamali, and kata fee. Run weight verification afterwards on the Verification page.
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
