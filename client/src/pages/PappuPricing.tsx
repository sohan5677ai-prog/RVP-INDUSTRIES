import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { Processing as ProcessingType, PappuPrice } from '@/lib/types';
import { calcTotal } from '@/lib/calc';
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
import { Badge } from '@/components/ui/badge';

type ProcessingRow = ProcessingType & { pappuPrice?: PappuPrice | null };

export default function PappuPricing() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [batch, setBatch] = useState<ProcessingRow | null>(null);
  const [price, setPrice] = useState('');

  const { data: items, isLoading } = useQuery({
    queryKey: ['processing'],
    queryFn: () => api<ProcessingRow[]>('/processing'),
  });

  const priceNum = Number(price) || 0;
  const estValue = batch && priceNum > 0 ? calcTotal(batch.pappuWeightKg, priceNum) : 0;

  const [isEditingPrice, setIsEditingPrice] = useState(false);

  const mutation = useMutation({
    mutationFn: () => {
      const url = isEditingPrice ? `/pappu-prices/${batch?.pappuPrice?.id}` : '/pappu-prices';
      const method = isEditingPrice ? 'PUT' : 'POST';
      const body = isEditingPrice ? { pricePerKg: priceNum } : { processingId: batch!.id, pricePerKg: priceNum };
      return api<PappuPrice>(url, { method, body });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['processing'] });
      toast.success(isEditingPrice ? 'Pappu price updated' : 'Pappu price set');
      setOpen(false);
      setBatch(null);
      setPrice('');
      setIsEditingPrice(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deletePriceMutation = useMutation({
    mutationFn: (id: string) => api(`/pappu-prices/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['processing'] });
      toast.success('Pappu price deleted');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function openFor(b: ProcessingRow) {
    setBatch(b);
    setPrice('');
    setIsEditingPrice(false);
    setOpen(true);
  }

  function openEdit(b: ProcessingRow) {
    setBatch(b);
    setPrice(b.pappuPrice ? String(b.pappuPrice.pricePerKg) : '');
    setIsEditingPrice(true);
    setOpen(true);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Pappu Pricing</h1>
        <p className="text-muted-foreground">Set selling price per processed batch</p>
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Processed</TableHead>
              <TableHead className="text-right">Pappu (kg)</TableHead>
              <TableHead className="text-right">Price/kg</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {items?.length === 0 && (
              <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">No processed batches yet.</TableCell></TableRow>
            )}
            {items?.map((it) => (
              <TableRow key={it.id}>
                <TableCell>{shortDate(it.processDate)}</TableCell>
                <TableCell className="text-right font-medium">{kg(it.pappuWeightKg)}</TableCell>
                <TableCell className="text-right">
                  {it.pappuPrice ? (
                    <Badge variant="outline">{rupees(it.pappuPrice.pricePerKg)}</Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {it.pappuPrice ? (
                    <div className="flex justify-end gap-1.5 items-center">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(it)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => { if (confirm('Delete this price?')) deletePriceMutation.mutate(it.pappuPrice!.id); }}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => openFor(it)}>Set price</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{isEditingPrice ? 'Edit Pappu Price' : 'Set Pappu Price'}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            {batch && (
              <p className="text-sm text-muted-foreground">
                Batch: Processed {shortDate(batch.processDate)} · {kg(batch.pappuWeightKg)} pappu
              </p>
            )}
            <div className="space-y-2">
              <Label htmlFor="price">Price per kg (₹)</Label>
              <Input id="price" type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
            <div className="rounded-lg border bg-muted/40 p-4 text-sm flex justify-between">
              <span className="text-muted-foreground">Estimated batch value</span>
              <span className="font-semibold">{estValue > 0 ? rupees(estValue) : '—'}</span>
            </div>
            <DialogFooter>
              <Button onClick={() => mutation.mutate()} disabled={priceNum <= 0 || mutation.isPending}>
                {mutation.isPending ? 'Saving…' : 'Save price'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
