import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { Party } from '@/lib/types';
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
import { Combobox } from '@/components/ui/combobox';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import type { Commodity, FreightRate } from '@/lib/types';

const PARTY_EXPORT_COLUMNS: ExportColumn<Party>[] = [
  { header: 'Name', value: (p) => p.name },
  { header: 'Nickname', value: (p) => p.nickname ?? '' },
  { header: 'Type', value: (p) => p.type },
  { header: 'Phone 1', value: (p) => p.phone ?? '' },
  { header: 'Phone 2', value: (p) => p.phone2 ?? '' },
  { header: 'Email', value: (p) => p.email ?? '' },
  { header: 'Address', value: (p) => p.address ?? '' },
  { header: 'State', value: (p) => p.state ?? '' },
  { header: 'GSTIN', value: (p) => p.gstin ?? '' },
  { header: 'Bank', value: (p) => p.bankName ?? '' },
  { header: 'Bank A/C', value: (p) => p.bankAccountNumber ?? '' },
  { header: 'IFSC', value: (p) => p.bankIfsc ?? '' },
  { header: 'Commodities', value: (p) => (p.commodities ?? []).join(', ') },
];

// The 5 tamarind by-product commodities are shown as a single grouped toggle
// (see COMMODITIES below) but stored individually so per-product filtering
// elsewhere (e.g. SaleOrders buyer picker) keeps working unchanged.
const TAMARIND_BYPRODUCT_COMMODITIES: Commodity[] = [
  'TAMARIND_SHELL', 'TAMARIND_WASTE', 'PRECLEANER_DUST', 'NALLA_POKKULU', 'NALLA_CHINTAPANDU',
];

const COMMODITIES: { value: string; label: string }[] = [
  { value: 'BLACK_SEED', label: 'Black Seed' },
  { value: 'PAPPU', label: 'Pappu' },
  { value: 'HUSK', label: 'Husk' },
  { value: 'TAMARIND_BYPRODUCTS', label: 'Tamarind By-Products' },
  { value: 'TPS_BROKENS', label: 'TPS (Brokens)' },
];

// Diacritic/case/whitespace-insensitive name key, used for duplicate detection.
function normalizeName(s: string) {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Cheap edit-distance check so "Sohan" vs "Sohan K" (or a typo) can be flagged
// as a likely duplicate without blocking genuinely distinct names.
function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function isSimilarName(a: string, b: string): boolean {
  const an = normalizeName(a);
  const bn = normalizeName(b);
  if (an === bn) return false; // exact match is handled separately
  if (an.startsWith(bn + ' ') || bn.startsWith(an + ' ')) return true;
  return levenshtein(an, bn) <= 2;
}

const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
  'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
  'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi',
  'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry'
].map(s => ({ value: s, label: s }));

const partySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  nickname: z.string().optional(),
  type: z.enum(['SUPPLIER', 'BUYER', 'BOTH', 'HAMALI_TEAM']),
  phone: z.string().optional(),
  phone2: z.string().optional(),
  email: z.string().email('Invalid email address').optional().or(z.literal('')),
  address: z.string().optional(),
  state: z.string().optional(),
  pincode: z.string().optional(),
  gstin: z.string().optional(),
  destination: z.string().optional(),
  locationLink: z.string().optional(),
  bankAccountNumber: z.string().optional(),
  bankIfsc: z.string().optional(),
  bankName: z.string().optional(),
  commodities: z.array(z.string()),
});
type PartyForm = z.infer<typeof partySchema>;

const emptyParty: PartyForm = {
  name: '', nickname: '', type: 'SUPPLIER', phone: '', phone2: '', email: '', address: '', state: '', pincode: '', gstin: '', destination: '',
  locationLink: '', bankAccountNumber: '', bankIfsc: '', bankName: '', commodities: [],
};

export default function Parties() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Party | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [commodityFilter, setCommodityFilter] = useState('ALL');
  const [stateFilter, setStateFilter] = useState('ALL');

  const { data: parties, isLoading } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  // Delivery destinations come from the Settings → Freight Rates rows, so adding a
  // destination there makes it selectable here (and vice-versa - single source of truth).
  const { data: freightRates } = useQuery({
    queryKey: ['freight-rates'],
    queryFn: () => api<FreightRate[]>('/settings/freight-rates'),
  });
  const destinationOptions = (freightRates ?? []).map((r) => ({
    value: r.destination,
    label: r.destination,
    hint: `₹${Number(r.ratePerTonne).toLocaleString('en-IN')}/t`,
  }));

  const uniqueStates = Array.from(new Set(parties?.map(p => p.state).filter(Boolean))).sort() as string[];

  const filteredParties = parties?.filter(p => {
    const q = searchQuery.toLowerCase();
    const matchesSearch = !q || (
      (p.name?.toLowerCase() || '').includes(q) ||
      (p.phone?.toLowerCase() || '').includes(q) ||
      (p.phone2?.toLowerCase() || '').includes(q) ||
      (p.gstin?.toLowerCase() || '').includes(q) ||
      (p.bankAccountNumber?.toLowerCase() || '').includes(q)
    );

    const matchesType =
      typeFilter === 'ALL' ||
      p.type === typeFilter ||
      // "Both" parties surface under the Buyer and Supplier filters, but not Hamali Team.
      (p.type === 'BOTH' && (typeFilter === 'BUYER' || typeFilter === 'SUPPLIER'));
    const matchesCommodity =
      commodityFilter === 'ALL' ||
      (commodityFilter === 'TAMARIND_BYPRODUCTS'
        ? TAMARIND_BYPRODUCT_COMMODITIES.some((c) => p.commodities?.includes(c))
        : p.commodities?.includes(commodityFilter as Commodity));
    const matchesState = stateFilter === 'ALL' || p.state === stateFilter;

    return matchesSearch && matchesType && matchesCommodity && matchesState;
  });

  const form = useForm<PartyForm>({
    resolver: zodResolver(partySchema),
    defaultValues: emptyParty,
  });

  function openCreate() {
    setEditing(null);
    form.reset(emptyParty);
    setOpen(true);
  }

  function openEdit(p: Party) {
    setEditing(p);
    form.reset({
      name: p.name,
      nickname: p.nickname ?? '',
      type: p.type,
      phone: p.phone ?? '',
      phone2: p.phone2 ?? '',
      email: p.email ?? '',
      address: p.address ?? '',
      state: p.state ?? '',
      pincode: p.pincode ?? '',
      gstin: p.gstin ?? '',
      destination: p.destination ?? '',
      locationLink: p.locationLink ?? '',
      bankAccountNumber: p.bankAccountNumber ?? '',
      bankIfsc: p.bankIfsc ?? '',
      bankName: p.bankName ?? '',
      commodities: p.commodities ?? [],
    });
    setOpen(true);
  }

  const saveMutation = useMutation({
    mutationFn: (values: PartyForm) =>
      editing
        ? api<Party>(`/parties/${editing.id}`, { method: 'PUT', body: values })
        : api<Party>('/parties', { method: 'POST', body: values }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['parties'] });
      toast.success(editing ? 'Party updated' : 'Party created');
      setOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function handleSave(values: PartyForm) {
    const enteredName = normalizeName(values.name);
    const others = (parties ?? []).filter((p) => p.id !== editing?.id);

    const exactMatch = others.find((p) => normalizeName(p.name) === enteredName);
    if (exactMatch) {
      form.setError('name', {
        type: 'manual',
        message: `A party named "${exactMatch.name}" already exists.`,
      });
      return;
    }

    const similarMatch = others.find((p) => isSimilarName(p.name, values.name));
    if (similarMatch) {
      const proceed = confirm(
        `A similarly named party already exists: "${similarMatch.name}".\n\nContinue creating "${values.name}" anyway?`
      );
      if (!proceed) return;
    }

    saveMutation.mutate(values);
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/parties/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['parties'] });
      toast.success('Party deleted');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // The Hamali crew ("Bikash and Team") is a labour counterparty, not a trading
  // party — it only needs name, phone and bank details, so the trade-specific
  // fields (nickname, commodities, GST, address, destination) are hidden for it.
  const isHamaliTeam = form.watch('type') === 'HAMALI_TEAM';

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Parties</h1>
            <p className="text-muted-foreground">Suppliers and buyers</p>
          </div>
          <div className="flex items-center gap-2">
            <ExportButtons
              filename="Parties"
              title="Parties (Suppliers & Buyers)"
              subtitle={`${filteredParties?.length ?? 0} party(s)`}
              columns={PARTY_EXPORT_COLUMNS}
              rows={filteredParties ?? []}
            />
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4 mr-2" /> New Party
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Input 
            placeholder="Search Name, GSTIN, Bank A/C..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger>
              <SelectValue placeholder="All Types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Types</SelectItem>
              <SelectItem value="BUYER">Buyer</SelectItem>
              <SelectItem value="SUPPLIER">Supplier</SelectItem>
              <SelectItem value="HAMALI_TEAM">Hamali Team</SelectItem>
            </SelectContent>
          </Select>
          <Select value={commodityFilter} onValueChange={setCommodityFilter}>
            <SelectTrigger>
              <SelectValue placeholder="All Commodities" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Commodities</SelectItem>
              {COMMODITIES.map(c => (
                <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={stateFilter} onValueChange={setStateFilter}>
            <SelectTrigger>
              <SelectValue placeholder="All States" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All States</SelectItem>
              {uniqueStates.map(s => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Nickname</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>State</TableHead>
              <TableHead>GSTIN</TableHead>
              <TableHead>Bank Details</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            )}
            {filteredParties?.length === 0 && !isLoading && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground">
                  No parties found.
                </TableCell>
              </TableRow>
            )}
            {filteredParties?.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.name}</TableCell>
                <TableCell className="font-mono text-xs">{p.nickname ?? '-'}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{p.type === 'HAMALI_TEAM' ? 'Hamali Team' : p.type}</Badge>
                </TableCell>
                <TableCell className="text-xs">
                  <div>{p.phone ?? '-'}</div>
                  {p.phone2 && <div className="text-muted-foreground">{p.phone2}</div>}
                </TableCell>
                <TableCell>{p.address ?? '-'}</TableCell>
                <TableCell>{p.state ?? '-'}</TableCell>
                <TableCell className="font-mono text-xs">{p.gstin ?? '-'}</TableCell>
                <TableCell>
                  {p.bankName || p.bankAccountNumber || p.bankIfsc ? (
                    <div className="text-xs">
                      <div className="font-medium">{p.bankName ?? '-'}</div>
                      <div className="text-muted-foreground font-mono">{p.bankAccountNumber ?? '-'} · {p.bankIfsc ?? '-'}</div>
                    </div>
                  ) : '-'}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" onClick={() => openEdit(p)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (confirm(`Delete ${p.name}?`)) deleteMutation.mutate(p.id);
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
        <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Party' : 'New Party'}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(handleSave)}
              className="space-y-4"
            >
              <div className="grid grid-cols-2 gap-4">
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
                {!isHamaliTeam && (
                  <FormField
                    control={form.control}
                    name="nickname"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Nickname</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g. DCS" {...field} />
                        </FormControl>
                        <p className="text-xs text-muted-foreground">Used as the PO number prefix (Nickname/01/26-27)</p>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
              </div>
              <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="SUPPLIER">Supplier</SelectItem>
                        <SelectItem value="BUYER">Buyer</SelectItem>
                        <SelectItem value="BOTH">Both</SelectItem>
                        <SelectItem value="HAMALI_TEAM">Hamali Team</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {!isHamaliTeam && (
              <FormField
                control={form.control}
                name="commodities"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Commodities</FormLabel>
                    <div className="flex flex-wrap gap-2">
                      {COMMODITIES.map((c) => {
                        const groupValues: string[] = c.value === 'TAMARIND_BYPRODUCTS'
                          ? TAMARIND_BYPRODUCT_COMMODITIES
                          : [c.value];
                        const active = groupValues.some((v) => field.value?.includes(v));
                        return (
                          <button
                            key={c.value}
                            type="button"
                            onClick={() => {
                              const next = active
                                ? (field.value ?? []).filter((v: string) => !groupValues.includes(v))
                                : Array.from(new Set([...(field.value ?? []), ...groupValues]));
                              field.onChange(next);
                            }}
                            className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                              active
                                ? 'bg-primary text-primary-foreground border-primary'
                                : 'bg-transparent text-muted-foreground hover:bg-muted'
                            }`}
                          >
                            {c.label}
                          </button>
                        );
                      })}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
              )}
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone Number 1</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. 9876543210" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="phone2"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone Number 2</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. 9876543211" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              {!isHamaliTeam && (
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input type="email" placeholder="e.g. party@example.com" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              )}
              {!isHamaliTeam && (
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="address"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Address</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="state"
                  render={({ field }) => (
                    <FormItem className="flex flex-col justify-end">
                      <FormLabel className="mb-1">State</FormLabel>
                      <Combobox
                        options={INDIAN_STATES}
                        value={field.value ?? ''}
                        onChange={field.onChange}
                        placeholder="Select state..."
                        searchPlaceholder="Search states..."
                      />
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              )}
              {!isHamaliTeam && (
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="pincode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Pincode</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. 517247" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="gstin"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>GSTIN</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. 37ABCDE1234F1Z5" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {form.watch('type') !== 'SUPPLIER' && (
                  <FormField
                    control={form.control}
                    name="destination"
                    render={({ field }) => {
                      // Keep an already-saved destination selectable even if it's no
                      // longer in the freight-rate list.
                      const opts = field.value && !destinationOptions.some((o) => o.value === field.value)
                        ? [{ value: field.value, label: field.value }, ...destinationOptions]
                        : destinationOptions;
                      return (
                        <FormItem className="flex flex-col justify-end">
                          <FormLabel className="mb-1">Delivery destination</FormLabel>
                          <Combobox
                            options={opts}
                            value={field.value ?? ''}
                            onChange={field.onChange}
                            placeholder="Select destination…"
                            searchPlaceholder="Search destinations…"
                            emptyText="No destinations - add them in Settings → Freight Rates."
                          />
                          <FormMessage />
                        </FormItem>
                      );
                    }}
                  />
                )}
              </div>
              )}
              {!isHamaliTeam && (
              <FormField
                control={form.control}
                name="locationLink"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Google Maps Location Link</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. https://maps.app.goo.gl/..." {...field} />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">Sent to the lorry driver on dispatch via WhatsApp</p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              )}

              <div className="space-y-3 rounded-lg border p-3 bg-muted/20">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Bank Account Details</p>
                <FormField
                  control={form.control}
                  name="bankName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Bank Name</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. State Bank of India" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="bankAccountNumber"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Account Number</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="bankIfsc"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>IFSC Code</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g. SBIN0001234" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>
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
