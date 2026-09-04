import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { Broker } from '@/lib/types';
import { Button } from '@/components/ui/button';
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
import { WA_LANGUAGE_LABELS, WISH_CATEGORY_LABELS } from '@/lib/types';
import type { WaLanguage, WishCategory } from '@/lib/types';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';

const BROKER_COLUMNS: ExportColumn<Broker>[] = [
  { header: 'Name', value: (b) => b.name },
  { header: 'Phone', value: (b) => b.phone ?? '' },
  {
    header: 'Community',
    value: (b) => (b.religion ? WISH_CATEGORY_LABELS[b.religion] : 'Not tagged'),
  },
  { header: 'Brokerage / Order', value: (b) => b.brokerageAmount, excel: (b) => Number(b.brokerageAmount), numFmt: '#,##0.00', align: 'right' },
];

const brokerSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z.string().optional(),
  religion: z.enum(['HINDU', 'MUSLIM', 'CHRISTIAN', 'OTHER', 'NONE']),
  waLanguage: z.enum(['EN', 'TE', 'TA', 'KN', 'HI']),
  brokerageAmount: z.string().min(1, 'Required').refine((v) => Number(v) >= 0, 'Must be 0 or more'),
});
type BrokerForm = z.infer<typeof brokerSchema>;

export default function Brokers() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Broker | null>(null);

  const { data: brokers, isLoading } = useQuery({
    queryKey: ['brokers'],
    queryFn: () => api<Broker[]>('/brokers'),
  });

  const form = useForm<BrokerForm>({
    resolver: zodResolver(brokerSchema),
    defaultValues: { name: '', phone: '', religion: 'NONE', waLanguage: 'EN', brokerageAmount: '2000' },
  });

  function openCreate() {
    setEditing(null);
    form.reset({ name: '', phone: '', religion: 'NONE', waLanguage: 'EN', brokerageAmount: '2000' });
    setOpen(true);
  }

  function openEdit(b: Broker) {
    setEditing(b);
    form.reset({
      name: b.name,
      phone: b.phone ?? '',
      religion: b.religion ?? 'NONE',
      waLanguage: b.waLanguage ?? 'EN',
      brokerageAmount: String(Number(b.brokerageAmount)),
    });
    setOpen(true);
  }

  const saveMutation = useMutation({
    mutationFn: (values: BrokerForm) => {
      const payload = {
        ...values,
        religion: values.religion === 'NONE' ? null : values.religion,
        brokerageAmount: Number(values.brokerageAmount),
      };
      return editing
        ? api<Broker>(`/brokers/${editing.id}`, { method: 'PUT', body: payload })
        : api<Broker>('/brokers', { method: 'POST', body: payload });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['brokers'] });
      qc.invalidateQueries({ queryKey: ['wishes-recipients'] });
      toast.success(editing ? 'Broker updated' : 'Broker created');
      setOpen(false);
      form.reset();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/brokers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['brokers'] });
      qc.invalidateQueries({ queryKey: ['wishes-recipients'] });
      toast.success('Broker deleted');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Brokers</h1>
          <p className="text-muted-foreground">Sale-order middlemen</p>
        </div>
        <div className="flex items-center gap-2">
          <ExportButtons
            filename="Brokers"
            title="Brokers"
            subtitle={`${brokers?.length ?? 0} broker(s)`}
            columns={BROKER_COLUMNS}
            rows={brokers ?? []}
          />
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" /> New Broker
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Community</TableHead>
              <TableHead className="text-right">Brokerage / Order</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            )}
            {brokers?.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  No brokers yet.
                </TableCell>
              </TableRow>
            )}
            {brokers?.map((b) => (
              <TableRow key={b.id}>
                <TableCell className="font-medium">{b.name}</TableCell>
                <TableCell>{b.phone ?? '-'}</TableCell>
                <TableCell>
                  {b.religion ? (
                    <Badge variant="soft">{WISH_CATEGORY_LABELS[b.religion]}</Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">
                      Not tagged
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">₹{Number(b.brokerageAmount).toLocaleString('en-IN')}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" onClick={() => openEdit(b)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (confirm(`Delete broker ${b.name}?`)) deleteMutation.mutate(b.id);
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Broker' : 'New Broker'}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit((v) => saveMutation.mutate(v))}
              className="space-y-4"
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input {...field} />
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
                    <FormLabel>Phone</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="religion"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Community (for Wishes)</FormLabel>
                    <Select
                      value={field.value || 'NONE'}
                      onValueChange={(v) => field.onChange(v as WishCategory | 'NONE')}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select community" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="NONE">Not tagged (Everyone only)</SelectItem>
                        <SelectItem value="HINDU">Hindu</SelectItem>
                        <SelectItem value="MUSLIM">Muslim</SelectItem>
                        <SelectItem value="CHRISTIAN">Christian</SelectItem>
                        <SelectItem value="OTHER">Other</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="brokerageAmount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Brokerage per order (₹)</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" min="0" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {/* Payment reminders copied to a broker go out in the broker's own
                  language, not the buyer's. */}
              <FormField
                control={form.control}
                name="waLanguage"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>WhatsApp language</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(Object.keys(WA_LANGUAGE_LABELS) as WaLanguage[]).map((code) => (
                          <SelectItem key={code} value={code}>
                            {WA_LANGUAGE_LABELS[code]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="submit" disabled={saveMutation.isPending}>
                  {saveMutation.isPending ? 'Saving…' : 'Save'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
