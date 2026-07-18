import { Fragment, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, ChevronDown, ChevronRight, Ban, ClipboardList, Clock, Truck, Scale, Table2 } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { Party, PurchaseOrder, POStatus } from '@/lib/types';
import { BulkImportDialog } from '@/components/BulkImportDialog';
import { formatPoGroupLabel, kg, rupees, shortDate, toTonnes } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { Segmented } from '@/components/ui/segmented';
import { SearchInput } from '@/components/ui/search-input';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { usePagedRows } from '@/lib/usePagedRows';
import { Combobox } from '@/components/ui/combobox';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
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
  plannedLocation: z.enum(['RVP', 'STOCK']),
  excludeGst: z.boolean(),
  tonnes: z.string().min(1, 'Tonnage is required').refine((v) => Number(v) > 0, 'Tonnage must be positive'),
  lorries: z.string().optional(),
});
type POForm = z.infer<typeof poSchema>;

const PO_EXPORT_COLUMNS: ExportColumn<PurchaseOrder>[] = [
  { header: 'Date', value: (p) => shortDate(p.poDate) },
  { header: 'PO Number', value: (p) => p.poNumber },
  { header: 'Party', value: (p) => p.party?.name ?? '' },
  { header: 'Price/kg', value: (p) => rupees(p.pricePerKg), excel: (p) => Number(p.pricePerKg), numFmt: '#,##0.00', align: 'right' },
  { header: 'Price Type', value: (p) => (p.priceType === 'BASE' ? 'Base' : 'Delivery') },
  { header: 'Planned', value: (p) => (p.plannedLocation === 'STOCK' ? 'Stock' : 'RVP') },
  { header: 'Tonnage (t)', value: (p) => toTonnes(p.tonnageKg).toFixed(2), excel: (p) => toTonnes(p.tonnageKg), numFmt: '#,##0.00', align: 'right' },
  { header: 'Arrived', value: (p) => (p.stockIns?.length ? 'Arrived' : 'Awaiting') },
  { header: 'Status', value: (p) => p.status },
];

export default function PurchaseOrders() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [editing, setEditing] = useState<PurchaseOrder | null>(null);
  const [filter, setFilter] = useState<POStatus | 'ALL'>('ALL');
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data: orders, isLoading } = useQuery({
    queryKey: ['purchase-orders', filter],
    queryFn: () =>
      api<PurchaseOrder[]>(
        `/purchase-orders?all=true${filter === 'ALL' ? '' : `&status=${filter}`}`
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

  const supplierOptions = useMemo(
    () => (parties ?? []).filter((p) => p.type !== 'BUYER' && p.commodities?.includes('BLACK_SEED')).map((p) => ({ value: p.id, label: p.name })),
    [parties]
  );

  const form = useForm<POForm>({
    resolver: zodResolver(poSchema),
    defaultValues: { poDate: new Date().toISOString().slice(0, 10), partyId: '', pricePerKg: '', priceType: 'DELIVERY', plannedLocation: 'RVP', excludeGst: false, tonnes: '', lorries: ''},
  });

  function openCreate() {
    setEditing(null);
    form.reset({ poDate: new Date().toISOString().slice(0, 10), partyId: '', pricePerKg: '', priceType: 'DELIVERY', plannedLocation: 'RVP', excludeGst: false, tonnes: '', lorries: ''});
    setOpen(true);
  }

  function openEdit(po: PurchaseOrder) {
    setEditing(po);
    form.reset({
      poDate: po.poDate.slice(0, 10),
      partyId: po.partyId,
      pricePerKg: String(po.pricePerKg),
      priceType: po.priceType ?? 'DELIVERY',
      plannedLocation: po.plannedLocation ?? 'RVP',
      excludeGst: po.hasGst === false,
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
              plannedLocation: v.plannedLocation,
              hasGst: !v.excludeGst,
              tonnageKg: Math.round(Number(v.tonnes) * 1000),
              lorryCount: v.lorries ? Math.max(1, Math.round(Number(v.lorries))) : null,
            },
          })
        : api<PurchaseOrder>('/purchase-orders', {
            method: 'POST',
            body: {
              poDate: v.poDate,
              partyId: v.partyId,
              pricePerKg: Number(v.pricePerKg),
              priceType: v.priceType,
              plannedLocation: v.plannedLocation,
              hasGst: !v.excludeGst,
              tonnageKg: Math.round(Number(v.tonnes) * 1000),
              lorryCount: v.lorries ? Math.max(1, Math.round(Number(v.lorries))) : null,
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
  const shown = useMemo(() => q.trim()
    ? groups.filter(({ pos }) => {
        const hay = `${pos[0].party?.name ?? ''} ${pos.map((p) => p.poNumber).join(' ')}`.toLowerCase();
        return hay.includes(q.trim().toLowerCase());
      })
    : groups, [groups, q]);

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows } = usePagedRows(shown, 50);

  return (
    <div className="space-y-8">
      <PageHeader
        icon={ClipboardList}
        title="Purchase Orders"
        description="Approximate orders raised to suppliers, split one PO per lorry."
        actions={
          <div className="flex gap-2">
            <ExportButtons
              filename="Purchase_Orders"
              title="Purchase Orders"
              subtitle={`${shown.reduce((n, g) => n + g.pos.length, 0)} PO(s)`}
              columns={PO_EXPORT_COLUMNS}
              rows={shown.flatMap((g) => g.pos)}
            />
            <Button variant="outline" onClick={() => setBulkOpen(true)}>
              <Table2 className="h-4 w-4" /> Bulk Entry
            </Button>
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" /> New PO
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 stagger">
        <StatCard label="Pending" value={pendingCount} icon={Clock} tone="amber" hint="awaiting arrival" />
        <StatCard label="Arrived" value={lorriesArrived} icon={Truck} tone="forest" hint={`of ${lorriesTotal} lorries`} />
        <StatCard label="Total tonnage" value={`${toTonnes(totalTonnageAll).toFixed(2)} MT`} icon={Scale} tone="clay" hint="ordered" />
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
            {(pageRows ?? []).map(({ groupId, pos }) => {
              const ordered = [...pos].sort((a, b) => (a.poNumber || '').localeCompare(b.poNumber || ''));
              const isOpen = expanded.has(groupId);
              const party = ordered[0].party?.name ?? '-';
              const totalTonnage = ordered.reduce((sum, p) => sum + p.tonnageKg, 0);
              const arrived = ordered.reduce((sum, p) => sum + (p.stockIns?.length ?? 0), 0);
              const statuses = [...new Set(ordered.map((p) => p.status))];
              const combinedStatus = statuses.length === 1 ? statuses[0] : null;
              const label = formatPoGroupLabel(ordered);

              return (
                <Fragment key={groupId}>
                  {/* Order summary row - click to expand its per-lorry POs */}
                  <TableRow className={`cursor-pointer font-medium transition-colors ${isOpen ? 'bg-secondary hover:bg-secondary border-b-0' : 'bg-muted/30 hover:bg-muted/50'}`} onClick={() => toggleGroup(groupId)}>
                    <TableCell className={isOpen ? 'shadow-[inset_3px_0_0_0_var(--primary)]' : undefined}>
                      <div className="flex items-center gap-2">
                        {isOpen
                          ? <ChevronDown className="h-4 w-4 text-primary" />
                          : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                        {shortDate(ordered[0].poDate)}
                      </div>
                    </TableCell>
                    <TableCell className="font-semibold tracking-tight tabular-nums">{label}</TableCell>
                    <TableCell className="font-semibold">
                      <div className="flex items-center gap-2">
                        {party}
                        {ordered[0].plannedLocation === 'STOCK' && (
                          <Badge variant="outline" className="text-[10px] font-normal" title="Held out of the Order Planner until stocked in">Stock</Badge>
                        )}
                      </div>
                    </TableCell>
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
                  {isOpen && ordered.map((po, idx) => (
                    <TableRow key={po.id} className={`bg-accent/60 hover:bg-accent ${idx === ordered.length - 1 ? 'border-b-2 border-border' : 'border-b border-border/60'}`}>
                      <TableCell className="pl-12 text-sm text-muted-foreground shadow-[inset_3px_0_0_0_var(--primary)]">{shortDate(po.poDate)}</TableCell>
                      <TableCell className="font-semibold tracking-tight tabular-nums">{po.poNumber}</TableCell>
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
        <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
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
                      <Input type="date" {...field} />
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
                        options={supplierOptions}
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

              <FormField
                control={form.control}
                name="plannedLocation"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Estimated location <span className="text-destructive">*</span></FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select destination" /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="RVP">RVP (direct to process)</SelectItem>
                        <SelectItem value="STOCK">Stock (cold storage first)</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-[0.8rem] text-muted-foreground">
                      Stock-bound orders stay out of the Order Planner until their lorry is actually stocked in.
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="excludeGst"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4">
                    <FormControl>
                      <input 
                        type="checkbox" 
                        checked={field.value} 
                        onChange={field.onChange} 
                        className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary mt-0.5"
                      />
                    </FormControl>
                    <div className="space-y-1 leading-none">
                      <FormLabel>Exclude GST</FormLabel>
                      <p className="text-[0.8rem] text-muted-foreground">
                        Select this if the supplier does NOT provide a GST invoice. (GST is included by default)
                      </p>
                    </div>
                  </FormItem>
                )}
              />

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
                          onChange={(e) => field.onChange(e.target.value)}
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

      <BulkImportDialog
        type="po"
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        onSuccess={() => qc.invalidateQueries({ queryKey: ['purchase-orders'] })}
      />
    </div>
  );
}
