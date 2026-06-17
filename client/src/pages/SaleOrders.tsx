import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Scale } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { Party, Broker, SaleOrder, SaleStatus } from '@/lib/types';
import { calcTotal } from '@/lib/calc';
import { kg, rupees, shortDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';

const statusVariant: Record<SaleStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  PENDING: 'secondary',
  DISPATCHED: 'default',
  COMPLETED: 'outline',
  CANCELLED: 'destructive',
};

const NO_BROKER = '__none__';

const saleSchema = z.object({
  saleDate: z.string().min(1, 'Date is required'),
  buyerId: z.string().min(1, 'Buyer is required'),
  brokerId: z.string().optional(),
  tonnes: z.string().min(1, 'Tonnage is required').refine((v) => Number(v) > 0, 'Must be positive'),
  ratePerKg: z.string().min(1, 'Rate is required').refine((v) => Number(v) > 0, 'Must be positive'),
});
type SaleForm = z.infer<typeof saleSchema>;

export default function SaleOrders() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SaleOrder | null>(null);

  const [recordWeightOpen, setRecordWeightOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<SaleOrder | null>(null);
  const [buyerWeightText, setBuyerWeightText] = useState('');

  const { data: orders, isLoading } = useQuery({
    queryKey: ['sale-orders'],
    queryFn: () => api<SaleOrder[]>('/sale-orders'),
  });
  const { data: parties } = useQuery({ queryKey: ['parties'], queryFn: () => api<Party[]>('/parties') });
  const { data: brokers } = useQuery({ queryKey: ['brokers'], queryFn: () => api<Broker[]>('/brokers') });

  const form = useForm<SaleForm>({
    resolver: zodResolver(saleSchema),
    defaultValues: { saleDate: new Date().toISOString().slice(0, 10), buyerId: '', brokerId: NO_BROKER, tonnes: '', ratePerKg: '' },
  });

  const tonnes = Number(form.watch('tonnes')) || 0;
  const rate = Number(form.watch('ratePerKg')) || 0;
  const estimate = tonnes > 0 && rate > 0 ? calcTotal(tonnes * 1000, rate) : 0;

  function openCreate() {
    setEditing(null);
    form.reset({
      saleDate: new Date().toISOString().slice(0, 10),
      buyerId: '',
      brokerId: NO_BROKER,
      tonnes: '',
      ratePerKg: '',
    });
    setOpen(true);
  }

  function openEdit(o: SaleOrder) {
    setEditing(o);
    form.reset({
      saleDate: o.saleDate.slice(0, 10),
      buyerId: o.buyerId,
      brokerId: o.brokerId || NO_BROKER,
      tonnes: String(o.tonnageKg / 1000),
      ratePerKg: String(o.ratePerKg),
    });
    setOpen(true);
  }

  const createMutation = useMutation({
    mutationFn: (v: SaleForm) => {
      const url = editing ? `/sale-orders/${editing.id}` : '/sale-orders';
      const method = editing ? 'PUT' : 'POST';
      return api<SaleOrder>(url, {
        method,
        body: {
          saleDate: v.saleDate,
          buyerId: v.buyerId,
          brokerId: v.brokerId === NO_BROKER ? null : v.brokerId,
          tonnageKg: Math.round(Number(v.tonnes) * 1000),
          ratePerKg: Number(v.ratePerKg),
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      toast.success(editing ? 'Sale order updated' : 'Sale order created');
      setOpen(false);
      form.reset();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/sale-orders/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      toast.success('Sale order deleted');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const recordWeightMutation = useMutation({
    mutationFn: ({ dispatchId, buyerWeightKg }: { dispatchId: string; buyerWeightKg: number }) => {
      return api(`/sale-dispatch/${dispatchId}/buyer-weight`, {
        method: 'POST',
        body: { buyerWeightKg },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      toast.success('Buyer weight recorded and Credit Note generated.');
      setRecordWeightOpen(false);
      setSelectedOrder(null);
      setBuyerWeightText('');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function openRecordWeight(o: SaleOrder) {
    setSelectedOrder(o);
    setBuyerWeightText(o.dispatch?.buyerWeightKg ? String(o.dispatch.buyerWeightKg) : '');
    setRecordWeightOpen(true);
  }

  const dispatchWeightKg = selectedOrder?.dispatch?.dispatchWeightKg ?? 0;
  const ratePerKg = Number(selectedOrder?.ratePerKg ?? 0);
  const buyerWeightKg = Number(buyerWeightText) || 0;
  const shortageKg = buyerWeightKg > 0 && buyerWeightKg < dispatchWeightKg ? dispatchWeightKg - buyerWeightKg : 0;
  const computedCreditNote = shortageKg * ratePerKg;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Sale Orders</h1>
          <p className="text-muted-foreground">Pappu sales to buyers</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" /> New Sale
        </Button>
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Buyer</TableHead>
              <TableHead>Broker</TableHead>
              <TableHead className="text-right">Tonnage</TableHead>
              <TableHead className="text-right">Rate/kg</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Dispatch</TableHead>
              <TableHead className="text-right">Dispute / Credit Note</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {orders?.length === 0 && (
              <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground">No sale orders.</TableCell></TableRow>
            )}
            {orders?.map((o) => (
              <TableRow key={o.id}>
                <TableCell>{shortDate(o.saleDate)}</TableCell>
                <TableCell className="font-medium">{o.buyer?.name ?? '—'}</TableCell>
                <TableCell>{o.broker?.name ?? '—'}</TableCell>
                <TableCell className="text-right">{kg(o.tonnageKg)}</TableCell>
                <TableCell className="text-right">{rupees(o.ratePerKg)}</TableCell>
                <TableCell><Badge variant={statusVariant[o.status]}>{o.status}</Badge></TableCell>
                <TableCell className="text-right">
                  {o.dispatch ? (
                    <a href={o.dispatch.invoiceFileUrl} target="_blank" rel="noreferrer" className="text-primary underline text-sm">
                      Invoice
                    </a>
                  ) : (
                    <Button asChild size="sm" variant="outline">
                      <Link to={`/sale-dispatch/${o.id}`}>Dispatch →</Link>
                    </Button>
                  )}
                </TableCell>
                <TableCell className="text-right text-sm">
                  {o.dispatch ? (
                    o.dispatch.buyerWeightKg !== null && o.dispatch.buyerWeightKg !== undefined ? (
                      <div className="flex flex-col items-end gap-1">
                        {o.dispatch.buyerWeightKg < o.dispatch.dispatchWeightKg ? (
                          <div className="text-right">
                            <div className="font-semibold text-destructive">
                              Shortage: {kg(o.dispatch.dispatchWeightKg - o.dispatch.buyerWeightKg)}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              CN: {rupees(Number(o.dispatch.creditNoteAmount || 0))}
                            </div>
                          </div>
                        ) : (
                          <span className="text-emerald-600 font-medium">Matched ({kg(o.dispatch.buyerWeightKg)})</span>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs font-normal text-primary hover:underline"
                          onClick={() => openRecordWeight(o)}
                        >
                          Edit Weight
                        </Button>
                      </div>
                    ) : (
                      o.status === 'DISPATCHED' ? (
                        <Button size="sm" variant="outline" className="h-8 px-2 text-xs" onClick={() => openRecordWeight(o)}>
                          Record Buyer Wt
                        </Button>
                      ) : (
                        '—'
                      )
                    )
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {o.status === 'PENDING' && (
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(o)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          if (confirm('Delete this sale order?')) {
                            deleteMutation.mutate(o.id);
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing ? 'Edit Sale Order' : 'New Sale Order'}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit((v) => createMutation.mutate(v))} className="space-y-4">
              <FormField control={form.control} name="saleDate" render={({ field }) => (
                <FormItem>
                  <FormLabel>Sale date <span className="text-destructive">*</span></FormLabel>
                  <FormControl><Input type="date" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="buyerId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Buyer <span className="text-destructive">*</span></FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Select buyer" /></SelectTrigger></FormControl>
                    <SelectContent>
                      {parties?.filter((p) => p.type !== 'SUPPLIER').map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="brokerId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Broker (optional)</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue placeholder="No broker" /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value={NO_BROKER}>No broker</SelectItem>
                      {brokers?.map((b) => (
                        <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="tonnes" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tonnage (tonnes) <span className="text-destructive">*</span></FormLabel>
                    <FormControl><Input type="number" step="0.001" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="ratePerKg" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Rate per kg (₹) <span className="text-destructive">*</span></FormLabel>
                    <FormControl><Input type="number" step="0.01" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <div className="rounded-lg border bg-muted/40 p-3 text-sm flex justify-between">
                <span className="text-muted-foreground">Estimated order value</span>
                <span className="font-semibold">{estimate > 0 ? rupees(estimate) : '—'}</span>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={createMutation.isPending}>
                  {createMutation.isPending ? 'Saving…' : (editing ? 'Save Changes' : 'Create sale')}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={recordWeightOpen} onOpenChange={setRecordWeightOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Scale className="h-5 w-5 text-primary" />
              Record Buyer Weight
            </DialogTitle>
          </DialogHeader>
          {selectedOrder && (
            <div className="space-y-4 py-4 text-sm">
              <div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/30 p-3">
                <div>
                  <div className="text-xs text-muted-foreground">Buyer</div>
                  <div className="font-semibold">{selectedOrder.buyer?.name}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Rate</div>
                  <div className="font-semibold">{rupees(Number(selectedOrder.ratePerKg))} / kg</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Dispatch Weight</div>
                  <div className="font-semibold">{kg(selectedOrder.dispatch?.dispatchWeightKg ?? 0)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Dispatch Date</div>
                  <div className="font-semibold">
                    {selectedOrder.dispatch?.dispatchDate ? shortDate(selectedOrder.dispatch.dispatchDate) : '—'}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Buyer Received Weight (kg) <span className="text-destructive">*</span>
                </label>
                <Input
                  type="number"
                  placeholder="Enter weight in kg"
                  value={buyerWeightText}
                  onChange={(e) => setBuyerWeightText(e.target.value)}
                />
              </div>

              {buyerWeightKg > 0 && (
                <div className="rounded-lg border p-3 space-y-2 bg-muted/10">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Discrepancy:</span>
                    <span className={`font-semibold ${shortageKg > 0 ? 'text-destructive' : 'text-emerald-600'}`}>
                      {shortageKg > 0 ? `Shortage of ${kg(shortageKg)}` : 'No Shortage / Match'}
                    </span>
                  </div>
                  {shortageKg > 0 && (
                    <>
                      <div className="flex justify-between text-xs text-muted-foreground border-t pt-2">
                        <span>Shortage Billing:</span>
                        <span>{kg(shortageKg)} × {rupees(ratePerKg)}/kg</span>
                      </div>
                      <div className="flex justify-between font-semibold text-destructive pt-1">
                        <span>Credit Note Amount:</span>
                        <span>{rupees(computedCreditNote)}</span>
                      </div>
                    </>
                  )}
                </div>
              )}

              <DialogFooter>
                <Button
                  className="w-full"
                  onClick={() => {
                    if (!buyerWeightText || Number(buyerWeightText) <= 0) {
                      toast.error('Please enter a valid received weight');
                      return;
                    }
                    recordWeightMutation.mutate({
                      dispatchId: selectedOrder.dispatch!.id,
                      buyerWeightKg: Number(buyerWeightText),
                    });
                  }}
                  disabled={recordWeightMutation.isPending}
                >
                  {recordWeightMutation.isPending ? 'Saving…' : 'Save Weight & Update Order'}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
