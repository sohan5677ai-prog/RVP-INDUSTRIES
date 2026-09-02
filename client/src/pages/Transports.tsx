import { useState, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Truck, Phone, MapPin, Building2, Wallet } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { Transport } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import { rupees } from '@/lib/format';

const TRANSPORT_COLUMNS: ExportColumn<Transport>[] = [
  { header: 'Transport Name', value: (t) => t.name },
  { header: 'Code', value: (t) => t.code ?? '' },
  { header: 'Contact Person', value: (t) => t.contactPerson ?? '' },
  { header: 'Phone', value: (t) => t.phone ?? '' },
  { header: 'City', value: (t) => t.city ?? '' },
  { header: 'State', value: (t) => t.state ?? '' },
  { header: 'GSTIN', value: (t) => t.gstin ?? '' },
  {
    header: 'Default Retention',
    value: (t) => rupees(t.defaultRetention),
    excel: (t) => Number(t.defaultRetention || 0),
    numFmt: '#,##0.00',
    align: 'right',
  },
  { header: 'Dispatches', value: (t) => t._count?.saleDispatches ?? 0 },
  { header: 'Status', value: (t) => (t.active ? 'Active' : 'Inactive') },
];

const transportSchema = z.object({
  name: z.string().min(1, 'Transport name is required').trim(),
  code: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  phone2: z.string().trim().optional(),
  email: z.string().trim().optional(),
  contactPerson: z.string().trim().optional(),
  address: z.string().trim().optional(),
  city: z.string().trim().optional(),
  state: z.string().trim().optional(),
  pincode: z.string().trim().optional(),
  gstin: z.string().trim().optional(),
  defaultRetention: z.string().min(0).default('0'),
  notes: z.string().trim().optional(),
  active: z.boolean().default(true),
});

type TransportForm = z.infer<typeof transportSchema>;

export default function Transports() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Transport | null>(null);
  const [search, setSearch] = useState('');

  const { data: transports, isLoading } = useQuery({
    queryKey: ['transports'],
    queryFn: () => api<Transport[]>('/transports'),
  });

  const form = useForm<TransportForm>({
    resolver: zodResolver(transportSchema) as any,
    defaultValues: {
      name: '',
      code: '',
      phone: '',
      phone2: '',
      email: '',
      contactPerson: '',
      address: '',
      city: '',
      state: '',
      pincode: '',
      gstin: '',
      defaultRetention: '0',
      notes: '',
      active: true,
    },
  });

  function openCreate() {
    setEditing(null);
    form.reset({
      name: '',
      code: '',
      phone: '',
      phone2: '',
      email: '',
      contactPerson: '',
      address: '',
      city: '',
      state: '',
      pincode: '',
      gstin: '',
      defaultRetention: '0',
      notes: '',
      active: true,
    });
    setOpen(true);
  }

  function openEdit(t: Transport) {
    setEditing(t);
    form.reset({
      name: t.name,
      code: t.code ?? '',
      phone: t.phone ?? '',
      phone2: t.phone2 ?? '',
      email: t.email ?? '',
      contactPerson: t.contactPerson ?? '',
      address: t.address ?? '',
      city: t.city ?? '',
      state: t.state ?? '',
      pincode: t.pincode ?? '',
      gstin: t.gstin ?? '',
      defaultRetention: String(Number(t.defaultRetention || 0)),
      notes: t.notes ?? '',
      active: t.active,
    });
    setOpen(true);
  }

  const saveMutation = useMutation({
    mutationFn: (values: TransportForm) => {
      const payload = {
        ...values,
        defaultRetention: Number(values.defaultRetention) || 0,
      };
      return editing
        ? api<Transport>(`/transports/${editing.id}`, { method: 'PUT', body: payload })
        : api<Transport>('/transports', { method: 'POST', body: payload });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transports'] });
      toast.success(editing ? 'Transport updated successfully' : 'Transport created successfully');
      setOpen(false);
      form.reset();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/transports/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transports'] });
      toast.success('Transport deleted');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const filteredTransports = useMemo(() => {
    if (!transports) return [];
    if (!search.trim()) return transports;
    const q = search.toLowerCase().trim();
    return transports.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.code && t.code.toLowerCase().includes(q)) ||
        (t.phone && t.phone.toLowerCase().includes(q)) ||
        (t.city && t.city.toLowerCase().includes(q)) ||
        (t.gstin && t.gstin.toLowerCase().includes(q)) ||
        (t.contactPerson && t.contactPerson.toLowerCase().includes(q))
    );
  }, [transports, search]);

  const totalTransports = transports?.length ?? 0;
  const activeTransports = transports?.filter((t) => t.active).length ?? 0;
  const totalDispatches =
    transports?.reduce((sum, t) => sum + (t._count?.saleDispatches ?? 0), 0) ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Truck}
        title="Transports"
        description="Manage transport agencies, default trip retention rates, and contact details."
        actions={
          <div className="flex items-center gap-2">
            <ExportButtons
              filename="Transports_Master"
              title="Transports Master Data"
              subtitle={`${filteredTransports.length} transport(s)`}
              columns={TRANSPORT_COLUMNS}
              rows={filteredTransports}
            />
            <Button onClick={openCreate} className="gap-2">
              <Plus className="h-4 w-4" /> Add Transport
            </Button>
          </div>
        }
      />

      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Total Transports" value={totalTransports} icon={Building2} tone="amber" />
        <StatCard label="Active Transports" value={activeTransports} icon={Truck} tone="forest" />
        <StatCard label="Total Dispatches" value={totalDispatches} icon={Wallet} tone="gold" />
      </div>

      {/* Search Bar */}
      <div className="flex items-center justify-between gap-4">
        <div className="max-w-sm flex-1">
          <Input
            placeholder="Search by name, code, phone, city, GSTIN..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Transports Table */}
      <div className="rounded-lg border bg-card overflow-x-auto shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Transport Name</TableHead>
              <TableHead>Contact & Phone</TableHead>
              <TableHead>City / State</TableHead>
              <TableHead>GSTIN / Transporter ID</TableHead>
              <TableHead className="text-right">Default Retention</TableHead>
              <TableHead className="text-center">Dispatches</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                  Loading transports...
                </TableCell>
              </TableRow>
            ) : filteredTransports.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                  No transports found. Click &quot;Add Transport&quot; to create one.
                </TableCell>
              </TableRow>
            ) : (
              filteredTransports.map((t) => (
                <TableRow key={t.id} className="hover:bg-muted/50">
                  <TableCell>
                    <div className="font-semibold text-foreground flex items-center gap-2">
                      {t.name}
                      {t.code && (
                        <Badge variant="outline" className="text-[10px] font-mono px-1.5 py-0">
                          {t.code}
                        </Badge>
                      )}
                    </div>
                    {t.notes && <p className="text-xs text-muted-foreground truncate max-w-xs">{t.notes}</p>}
                  </TableCell>
                  <TableCell>
                    {t.contactPerson && <div className="text-xs font-medium">{t.contactPerson}</div>}
                    {t.phone ? (
                      <div className="text-xs text-muted-foreground flex items-center gap-1 font-mono">
                        <Phone className="h-3 w-3" /> {t.phone}
                        {t.phone2 && <span>, {t.phone2}</span>}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {t.city || t.state ? (
                      <div className="text-xs text-muted-foreground flex items-center gap-1">
                        <MapPin className="h-3 w-3 shrink-0" />
                        {[t.city, t.state].filter(Boolean).join(', ')}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {t.gstin || '-'}
                  </TableCell>
                  <TableCell className="text-right font-medium font-mono">
                    {rupees(t.defaultRetention)}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant="secondary" className="font-mono text-xs">
                      {t._count?.saleDispatches ?? 0}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={t.active ? 'default' : 'secondary'}>
                      {t.active ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEdit(t)}
                        title="Edit transport"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Are you sure you want to delete ${t.name}?`
                            )
                          ) {
                            deleteMutation.mutate(t.id);
                          }
                        }}
                        title="Delete transport"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Add / Edit Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Transport' : 'Add Transport'}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit((v) => saveMutation.mutate(v))} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem className="col-span-2">
                      <FormLabel>Transport Agency Name *</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="e.g. Surya Road Lines, VRL Logistics" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="code"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Short Code / Alias</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="e.g. SURYA, KNM, VRL" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="defaultRetention"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Default Retention (₹)</FormLabel>
                      <FormControl>
                        <Input {...field} type="number" step="1" placeholder="e.g. 3000" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="contactPerson"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Contact Person</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="e.g. Jagan" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone Number</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="e.g. 9440216173" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="phone2"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Secondary Phone</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="Optional" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email Address</FormLabel>
                      <FormControl>
                        <Input {...field} type="email" placeholder="Optional" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="gstin"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>GSTIN / Transporter ID</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="e.g. 37AACBS0915N1ZP" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-3 gap-3">
                <FormField
                  control={form.control}
                  name="city"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>City</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="e.g. Punganur" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="state"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>State</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="e.g. Andhra Pradesh" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="pincode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Pincode</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="e.g. 517247" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="address"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Full Address</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="Premises / Street address" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes / Remarks</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="Optional notes" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex items-center gap-2 pt-2">
                <input
                  type="checkbox"
                  id="active-toggle"
                  checked={form.watch('active')}
                  onChange={(e) => form.setValue('active', e.target.checked)}
                  className="rounded border-border text-primary focus:ring-primary h-4 w-4"
                />
                <Label htmlFor="active-toggle" className="text-sm font-medium cursor-pointer">
                  Active (available in dispatch dropdowns and reports)
                </Label>
              </div>

              <DialogFooter className="pt-4">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={saveMutation.isPending}>
                  {saveMutation.isPending ? 'Saving...' : editing ? 'Save Changes' : 'Create Transport'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
