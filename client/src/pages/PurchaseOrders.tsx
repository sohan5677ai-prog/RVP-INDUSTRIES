import { Fragment, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, ChevronDown, ChevronRight, Ban, ClipboardList, Clock, Truck, Scale } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { Party, PurchaseOrder, POStatus } from '@/lib/types';
import { kg, rupees, shortDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { Segmented } from '@/components/ui/segmented';
import { SearchInput } from '@/components/ui/search-input';
import { DatePicker } from '@/components/ui/date-picker';
import { Combobox } from '@/components/ui/combobox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';

const statusVariant: Record<POStatus, 'soft' | 'success' | 'warning' | 'outline' | 'destructive'> = {
  PENDING: 'warning',
  ARRIVED: 'soft',
  COMPLETED: 'success',
  CANCELLED: 'destructive',
};

const STATUSES: POStatus[] = ['PENDING', 'ARRIVED', 'CANCELLED'];

const poSchema = z.object({
  poDate: z.string().min(1, 'Date is required'),
  partyId: z.string().min(1, 'Party is required'),
  pricePerKg: z.string().min(1, 'Price is required').refine((v) => Number(v) > 0, 'Price must be positive'),
  priceType: z.enum(['BASE', 'DELIVERY']),
  tonnes: z.string().min(1, 'Tonnage is required').refine((v) => Number(v) > 0, 'Tonnage must be positive'),
  lorries: z.string().optional(),
});
type POForm = z.infer<typeof poSchema>;

export default function PurchaseOrders() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PurchaseOrder | null>(null);
  const [filter, setFilter] = useState<POStatus | 'ALL'>('ALL');
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data: orders, isLoading } = useQuery({
    queryKey: ['purchase-orders', filter],
    queryFn: () =>
      api<PurchaseOrder[]>(
        `/purchase-orders${filter === 'ALL' ? '' : `?status=${filter}`}`
      ),
  });

  function toggleGroup(groupId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  // One order is split into one PO per lorry; regroup them by their shared
  // poGroupId so each order shows as a single expandable row.
  const groups = useMemo(() => {
    const map = new Map<string, { groupId: string; pos: PurchaseOrder[] }>();
    for (const po of orders ?? []) {
      const key = po.poGroupId ?? po.id;
      if (!map.has(key)) map.set(key, { groupId: key, pos: [] });
      map.get(key)!.pos.push(po);
    }
    return [...map.values()];
  }, [orders]);

  const { data: parties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const form = useForm<POForm>({
    resolver: zodResolver(poSchema),
    defaultValues: { poDate: new Date().toISOString().slice(0, 10), partyId: '', pricePerKg: '', priceType: 'DELIVERY', tonnes: '', lorries: '' },
  });

  function openCreate() {
    setEditing(null);
    form.reset({ poDate: new Date().toISOString().slice(0, 10), partyId: '', pricePerKg: '', priceType: 'DELIVERY', tonnes: '', lorries: '' });
    setOpen(true);
  }

  function openEdit(po: PurchaseOrder) {
    setEditing(po);
    form.reset({
      poDate: po.poDate.slice(0, 10),
      partyId: po.partyId,
      pricePerKg: String(po.pricePerKg),
      priceType: po.priceType ?? 'DELIVERY',
      tonnes: String(po.tonnageKg / 1000),
      lorries: po.lorryCount ? String(po.lorryCount) : '',
    });
    setOpen(true);
  }

  const saveMutation = useMutation({
    mutationFn: (v: POForm) =>
      editing
        ? api<PurchaseOrder>(`/purchase-orders/${editing.id}`, {
            method: 'PUT',
            body: {
              poDate: v.poDate,
              partyId: v.partyId,
              pricePerKg: Number(v.pricePerKg),
              priceType: v.priceType,
              tonnageKg: Math.round(Number(v.tonnes) * 1000),
              lorryCount: v.lorries ? Math.round(Number(v.lorries)) : null,
            },
          })
        : api<PurchaseOrder>('/purchase-orders', {
            method: 'POST',
            body: {
              poDate: v.poDate,
              partyId: v.partyId,
              pricePerKg: Number(v.pricePerKg),
              priceType: v.priceType,
              tonnageKg: Math.round(Number(v.tonnes) * 1000),
              lorryCount: v.lorries ? Math.round(Number(v.lorries)) : null,
            },
          }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      toast.success(editing ? 'Purchase order updated' : 'Purchase order created');
      setOpen(false);
      form.reset();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      api(`/purchase-orders/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      toast.success('Purchase order deleted');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const voidMutation = useMutation({
    mutationFn: (id: string) =>
      api(`/purchase-orders/${id}/void`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      toast.success('Purchase order voided (Cancelled)');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const allPos = orders ?? [];
  const lorriesTotal = allPos.length;
  const lorriesArrived = allPos.reduce((s, p) => s + (p.stockIns?.length ? 1 : 0), 0);
  const pendingCount = allPos.filter((p) => p.status === 'PENDING').length;
  const totalTonnageAll = allPos.reduce((s, p) => s + p.tonnageKg, 0);

  const filterOptions: { label: string; value: POStatus | 'ALL' }[] = (['ALL', ...STATUSES] as const).map((s) => ({
    label: s === 'ALL' ? 'All' : s[0] + s.slice(1).toLowerCase(),
    value: s,
  }));

  // Search filters the grouped orders by party name or PO number.
  const shown = q.trim()
    ? groups.filter(({ pos }) => {
        const hay = `${pos[0].party?.name ?? ''} ${pos.map((p) => p.poNumber).join(' ')}`.toLowerCase();
        return hay.includes(q.trim().toLowerCase());
      })
    : groups;

  return (
    <div className="space-y-8">
      <PageHeader
        icon={ClipboardList}
        title="Purchase Orders"
        description="Approximate orders raised to suppliers, split one PO per lorry."
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" /> New PO
          </Button>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 stagger">
        <StatCard label="Orders" value={groups.length} icon={ClipboardList} tone="taupe" hint={`${lorriesTotal} lorries`} />
        <StatCard label="Pending" value={pendingCount} icon={Clock} tone="amber" hint="awaiting arrival" />
        <StatCard label="Arrived" value={lorriesArrived} icon={Truck} tone="forest" hint={`of ${lorriesTotal} lorries`} />
        <StatCard label="Total tonnage" value={kg(totalTonnageAll)} icon={Scale} tone="clay" hint="ordered" />
      </div>

      <div className="glass rounded-2xl overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-border/70">
          <SearchInput value={q} onValueChange={setQ} placeholder="Search party or PO number…" containerClassName="w-full sm:w-72" />
          <Segmented options={filterOptions} value={filter} onValueChange={setFilter} />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>PO Number</TableHead>
              <TableHead>Party</TableHead>
              <TableHead className="text-right">Price/kg</TableHead>
              <TableHead className="text-right">Lorries</TableHead>
              <TableHead className="text-right">Tonnage</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {!isLoading && shown.length === 0 && (
              <TableRow><TableCell colSpan={8} className="h-28 text-center text-muted-foreground">{q ? 'No orders match your search.' : 'No purchase orders.'}</TableCell></TableRow>
            )}
            {shown.map(({ groupId, pos }) => {
              const ordered = [...pos].sort((a, b) => (a.poNumber || '').localeCompare(b.poNumber || ''));
              const isOpen = expanded.has(groupId);
              const party = ordered[0].party?.name ?? '—';
              const totalTonnage = ordered.reduce((sum, p) => sum + p.tonnageKg, 0);
              const arrived = ordered.reduce((sum, p) => sum + (p.stockIns?.length ?? 0), 0);
              const statuses = [...new Set(ordered.map((p) => p.status))];
              const combinedStatus = statuses.length === 1 ? statuses[0] : null;
              const first = ordered[0].poNumber;
              const last = ordered[ordered.length - 1].poNumber;
              const label = ordered.length > 1 ? `${first} – ${last}` : first;

              return (
                <Fragment key={groupId}>
                  {/* Order summary row — click to expand its per-lorry POs */}
                  <TableRow className="cursor-pointer bg-muted/30 hover:bg-muted/50 font-medium" onClick={() => toggleGroup(groupId)}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                        {shortDate(ordered[0].poDate)}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono font-semibold">{label}</TableCell>
                    <TableCell className="font-semibold">{party}</TableCell>
                    <TableCell className="text-right">
                      {rupees(ordered[0].pricePerKg)}
                      <span className="block text-[10px] font-normal text-muted-foreground">{ordered[0].priceType === 'BASE' ? 'Base price' : 'Delivery price'}</span>
                    </TableCell>
                    <TableCell className="text-right font-medium">{arrived} / {ordered.length}</TableCell>
                    <TableCell className="text-right">{kg(totalTonnage)}</TableCell>
                    <TableCell>
                      {combinedStatus
                        ? <Badge variant={statusVariant[combinedStatus]}>{combinedStatus}</Badge>
                        : <Badge variant="outline">MIXED</Badge>}
                    </TableCell>
                    <TableCell />
                  </TableRow>

                  {/* Individual per-lorry POs */}
                  {isOpen && ordered.map((po) => (
                    <TableRow key={po.id} className="bg-background">
                      <TableCell className="pl-10 text-muted-foreground">{shortDate(po.poDate)}</TableCell>
                      <TableCell className="font-mono font-semibold">{po.poNumber}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">Lorry</TableCell>
                      <TableCell className="text-right">{rupees(po.pricePerKg)}</TableCell>
                      <TableCell className="text-right text-xs">
                        {po.stockIns?.length ? <span className="text-green-600">Arrived</span> : <span className="text-muted-foreground">Awaiting</span>}
                      </TableCell>
                      <TableCell className="text-right">{kg(po.tonnageKg)}</TableCell>
                      <TableCell><Badge variant={statusVariant[po.status]}>{po.status}</Badge></TableCell>
                      <TableCell className="text-right">
                        {po.status === 'PENDING' && (
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); openEdit(po); }}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Void (cancel) this PO"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm('Void this purchase order? It will be marked as Cancelled.')) voidMutation.mutate(po.id);
                              }}
                            >
                              <Ban className="h-4 w-4 text-amber-600" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm('Delete this purchase order?')) deleteMutation.mutate(po.id);
                              }}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? `Edit Purchase Order (${editing.poNumber})` : 'New Purchase Order'}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit((v) => saveMutation.mutate(v))} className="space-y-4">
              <FormField
                control={form.control}
                name="poDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>PO Date <span className="text-destructive">*</span></FormLabel>
                    <FormControl>
                      <DatePicker
                        value={field.value ? new Date(field.value + 'T00:00:00') : undefined}
                        onChange={(d) =>
                          field.onChange(
                            d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : ''
                          )
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="partyId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Party (supplier) <span className="text-destructive">*</span></FormLabel>
                    <FormControl>
                      <Combobox
                        options={(parties ?? []).filter((p) => p.type !== 'BUYER').map((p) => ({ value: p.id, label: p.name }))}
                        value={field.value}
                        onChange={field.onChange}
                        placeholder="Select party"
                        searchPlaceholder="Search supplier…"
                        className="w-full"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="pricePerKg"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Price per kg (₹) <span className="text-destructive">*</span></FormLabel>
                      <FormControl><Input type="number" step="0.01" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="priceType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Price basis <span className="text-destructive">*</span></FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger><SelectValue placeholder="Select basis" /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="DELIVERY">Delivery (at our location)</SelectItem>
                          <SelectItem value="BASE">Base (at supplier)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="lorries"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Lorries (Qty)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step="1"
                          placeholder="e.g. 2"
                          {...field}
                          onChange={(e) => {
                            const l = e.target.value;
                            field.onChange(l);
                            if (l && !isNaN(Number(l))) {
                              form.setValue('tonnes', String(Number(l) * 25));
                            } else {
                              form.setValue('tonnes', '');
                            }
                          }}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="tonnes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tonnage (tonnes) <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step="0.001"
                          placeholder="e.g. 50"
                          {...field}
                          onChange={(e) => {
                            const t = e.target.value;
                            field.onChange(t);
                            if (t && !isNaN(Number(t))) {
                              form.setValue('lorries', String(Math.round((Number(t) / 25) * 100) / 100));
                            } else {
                              form.setValue('lorries', '');
                            }
                          }}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <DialogFooter>
                <Button type="submit" disabled={saveMutation.isPending}>
                  {saveMutation.isPending ? 'Saving…' : (editing ? 'Save Changes' : 'Create PO')}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
