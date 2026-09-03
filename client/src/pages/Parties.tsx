import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Users, MapPin, CheckCircle2 } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { api, getErrorMessage } from '@/lib/api';
import type { Party, PartyAddress } from '@/lib/types';
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
  FormDescription,
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
import { rupees } from '@/lib/format';
import type { Commodity, FreightRate, WaLanguage, WishCategory } from '@/lib/types';
import { WA_LANGUAGE_LABELS, WISH_CATEGORY_LABELS } from '@/lib/types';

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
  { header: 'Opening Bal', value: (p) => Number(p.openingBalance || 0) > 0 ? `${p.openingBalance} ${p.openingBalanceType ?? (p.type === 'BUYER' ? 'DR' : 'CR')}`.trim() : '-' },
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
  city: z.string().optional(),
  state: z.string().optional(),
  pincode: z.string().optional(),
  gstin: z.string().optional(),
  destination: z.string().optional(),
  locationLink: z.string().optional(),
  lorryReceiptEnabled: z.boolean(),
  waLanguage: z.enum(['EN', 'TE', 'TA', 'KN', 'HI']),
  religion: z.enum(['HINDU', 'MUSLIM', 'CHRISTIAN', 'OTHER', 'NONE']),
  openingBalance: z.coerce.number().min(0).optional(),
  openingBalanceType: z.enum(['DR', 'CR']).optional(),
  bankAccountNumber: z.string().optional(),
  bankIfsc: z.string().optional(),
  bankName: z.string().optional(),
  commodities: z.array(z.string()),
});
type PartyForm = z.infer<typeof partySchema>;

const emptyParty: PartyForm = {
  name: '', nickname: '', type: 'SUPPLIER', phone: '', phone2: '', email: '', address: '', city: '', state: '', pincode: '', gstin: '', destination: '',
  locationLink: '', lorryReceiptEnabled: false, waLanguage: 'EN', religion: 'NONE', openingBalance: 0, openingBalanceType: 'CR', bankAccountNumber: '', bankIfsc: '', bankName: '', commodities: [],
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
    resolver: zodResolver(partySchema) as any,
    defaultValues: emptyParty,
  });

  const [addresses, setAddresses] = useState<PartyAddress[]>([]);
  const [hasMultipleAddresses, setHasMultipleAddresses] = useState(false);

  function addAddress() {
    setAddresses((prev) => [
      ...prev,
      {
        label: prev.length === 0 ? 'Registered Office' : `Branch / Plant ${prev.length + 1}`,
        address: '',
        city: '',
        state: '',
        pincode: '',
        gstin: '',
        destination: '',
        phone: '',
        phone2: '',
        locationLink: '',
        isDefault: prev.length === 0,
      },
    ]);
  }

  function updateAddress(index: number, patch: Partial<PartyAddress>) {
    setAddresses((prev) => prev.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  }

  function removeAddress(index: number) {
    setAddresses((prev) => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length > 0 && !next.some((a) => a.isDefault)) {
        next[0].isDefault = true;
      }
      return next;
    });
  }

  function setDefaultAddress(index: number) {
    setAddresses((prev) => prev.map((a, i) => ({ ...a, isDefault: i === index })));
  }

  function openCreate() {
    setEditing(null);
    form.reset(emptyParty);
    setHasMultipleAddresses(false);
    setAddresses([
      {
        label: 'Registered Office',
        address: '',
        city: '',
        state: '',
        pincode: '',
        gstin: '',
        destination: '',
        phone: '',
        phone2: '',
        locationLink: '',
        isDefault: true,
      },
    ]);
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
      city: p.city ?? '',
      state: p.state ?? '',
      pincode: p.pincode ?? '',
      gstin: p.gstin ?? '',
      destination: p.destination ?? '',
      locationLink: p.locationLink ?? '',
      lorryReceiptEnabled: p.lorryReceiptEnabled ?? false,
      waLanguage: p.waLanguage ?? 'EN',
      religion: p.religion ?? 'NONE',
      openingBalance: p.openingBalance != null ? Number(p.openingBalance) : 0,
      openingBalanceType: p.openingBalanceType ?? (p.type === 'BUYER' ? 'DR' : 'CR'),
      bankAccountNumber: p.bankAccountNumber ?? '',
      bankIfsc: p.bankIfsc ?? '',
      bankName: p.bankName ?? '',
      commodities: p.commodities ?? [],
    });
    const isMulti = Boolean(p.addresses && p.addresses.length > 1);
    setHasMultipleAddresses(isMulti);
    if (p.addresses && p.addresses.length > 0) {
      setAddresses(
        p.addresses.map((a) => ({
          ...a,
          destination: a.destination ?? p.destination ?? '',
          phone: a.phone ?? '',
          phone2: a.phone2 ?? '',
          locationLink: a.locationLink ?? '',
        }))
      );
    } else {
      setAddresses([
        {
          label: 'Registered Office',
          address: p.address ?? '',
          city: p.city ?? '',
          state: p.state ?? '',
          pincode: p.pincode ?? '',
          gstin: p.gstin ?? '',
          destination: p.destination ?? '',
          phone: p.phone ?? '',
          phone2: p.phone2 ?? '',
          locationLink: p.locationLink ?? '',
          isDefault: true,
        },
      ]);
    }
    setOpen(true);
  }

  const saveMutation = useMutation({
    mutationFn: (values: PartyForm) => {
      // 'NONE' is a Select-only sentinel (Radix Select can't hold an empty-string
      // item value) standing in for "not tagged" - the API wants null.
      let validAddresses: PartyAddress[] = [];
      let finalAddress = values.address || '';
      let finalCity = values.city || '';
      let finalState = values.state || '';
      let finalPincode = values.pincode || '';
      let finalGstin = values.gstin || '';
      let finalDestination = values.destination || '';
      let finalLocationLink = values.locationLink || '';

      if (hasMultipleAddresses) {
        validAddresses = addresses
          .filter((a) => a.address.trim() || a.city?.trim() || a.label.trim() || a.phone?.trim() || a.state?.trim() || a.gstin?.trim() || a.destination?.trim() || a.locationLink?.trim())
          .map((a) => ({
            ...a,
            label: a.label.trim() || 'Address',
            address: a.address.trim(),
            city: a.city?.trim() || null,
            state: a.state?.trim() || null,
            pincode: a.pincode?.trim() || null,
            gstin: a.gstin?.trim() || null,
            destination: a.destination?.trim() || null,
            phone: a.phone?.trim() || null,
            phone2: a.phone2?.trim() || null,
            locationLink: a.locationLink?.trim() || null,
          }));
        const defaultAddr = validAddresses.find((a) => a.isDefault) || validAddresses[0];
        if (defaultAddr) {
          finalAddress = defaultAddr.address;
          finalCity = defaultAddr.city || '';
          finalState = defaultAddr.state || '';
          finalPincode = defaultAddr.pincode || '';
          finalGstin = defaultAddr.gstin || finalGstin;
          finalDestination = defaultAddr.destination || finalDestination;
          finalLocationLink = defaultAddr.locationLink || finalLocationLink;
        }
      } else {
        const addrText = values.address?.trim() || '';
        const hasAnyAddrData = Boolean(addrText || values.city?.trim() || values.state?.trim() || values.pincode?.trim() || values.gstin?.trim() || values.destination?.trim() || values.locationLink?.trim());
        validAddresses = hasAnyAddrData
          ? [
              {
                label: 'Registered Office',
                address: addrText,
                city: values.city?.trim() || null,
                state: values.state?.trim() || null,
                pincode: values.pincode?.trim() || null,
                gstin: values.gstin?.trim() || null,
                destination: values.destination?.trim() || null,
                phone: values.phone?.trim() || null,
                phone2: values.phone2?.trim() || null,
                locationLink: values.locationLink?.trim() || null,
                isDefault: true,
              },
            ]
          : [];
      }

      const body = {
        ...values,
        nickname: values.type === 'BUYER' || values.type === 'HAMALI_TEAM' ? null : (values.nickname?.trim() || null),
        bankName: values.type === 'BUYER' ? null : (values.bankName?.trim() || null),
        bankAccountNumber: values.type === 'BUYER' ? null : (values.bankAccountNumber?.trim() || null),
        bankIfsc: values.type === 'BUYER' ? null : (values.bankIfsc?.trim() || null),
        phone: values.phone?.trim() || null,
        phone2: values.phone2?.trim() || null,
        email: values.email?.trim() || null,
        address: finalAddress || null,
        city: finalCity || null,
        state: finalState || null,
        pincode: finalPincode || null,
        gstin: finalGstin || null,
        destination: finalDestination || null,
        locationLink: finalLocationLink || null,
        addresses: validAddresses,
        religion: values.religion === 'NONE' ? null : values.religion,
        openingBalance: values.openingBalance ?? 0,
        openingBalanceType: values.openingBalanceType ?? (values.type === 'BUYER' ? 'DR' : 'CR'),
      };
      return editing
        ? api<Party>(`/parties/${editing.id}`, { method: 'PUT', body })
        : api<Party>('/parties', { method: 'POST', body });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['parties'] });
      toast.success(editing ? 'Party updated' : 'Party created');
      setOpen(false);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
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
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // The Hamali crew ("Bikash and Team") is a labour counterparty, not a trading
  // party - it only needs name, phone and bank details, so the trade-specific
  // fields (nickname, commodities, GST, address, destination) are hidden for it.
  const partyType = form.watch('type');
  const isHamaliTeam = partyType === 'HAMALI_TEAM';
  const isBuyer = partyType === 'BUYER';
  const isSupplier = partyType === 'SUPPLIER';
  const isBoth = partyType === 'BOTH';
  const showNickname = isSupplier || isBoth;
  const showBankDetails = partyType !== 'BUYER';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Parties"
        description="Suppliers and buyers"
        icon={Users}
        actions={
          <>
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
          </>
        }
      />

      <div className="flex flex-col gap-4">
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
              <SelectItem value="BOTH">Both</SelectItem>
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
              <TableHead>Opening Bal</TableHead>
              <TableHead>Bank Details</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            )}
            {filteredParties?.length === 0 && !isLoading && (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-muted-foreground">
                  No parties found.
                </TableCell>
              </TableRow>
            )}
            {filteredParties?.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.name}</TableCell>
                <TableCell className="font-sans font-medium text-xs text-foreground/80">{p.nickname ?? '-'}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{p.type === 'HAMALI_TEAM' ? 'Hamali Team' : p.type}</Badge>
                </TableCell>
                <TableCell className="text-xs">
                  <div>{p.phone ?? '-'}</div>
                  {p.phone2 && <div className="text-muted-foreground">{p.phone2}</div>}
                </TableCell>
                <TableCell className="max-w-[200px]">
                  <div className="text-xs truncate" title={p.address ?? ''}>
                    {p.address ?? '-'}
                  </div>
                  {p.addresses && p.addresses.length > 1 && (
                    <div className="mt-0.5">
                      <Badge variant="outline" className="text-[10px] py-0 px-1 font-normal text-muted-foreground">
                        {p.addresses.length} addresses
                      </Badge>
                    </div>
                  )}
                </TableCell>
                <TableCell>{p.state ?? '-'}</TableCell>
                <TableCell className="font-sans text-xs font-medium tracking-wide">{p.gstin ?? '-'}</TableCell>
                <TableCell className="text-xs">
                  {Number(p.openingBalance || 0) > 0 ? (
                    <span className="font-medium tabular-nums">
                      {rupees(Number(p.openingBalance))}{' '}
                      <span className={`text-[10px] font-semibold ${p.openingBalanceType === 'DR' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                        {p.openingBalanceType ?? (p.type === 'BUYER' ? 'DR' : 'CR')}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell>
                  {p.bankName || p.bankAccountNumber || p.bankIfsc ? (
                    <div className="text-xs">
                      <div className="font-medium">{p.bankName ?? '-'}</div>
                      <div className="text-muted-foreground font-sans tabular-nums">{p.bankAccountNumber ?? '-'} · {p.bankIfsc ?? '-'}</div>
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
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Party' : 'New Party'}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(handleSave)}
              className="space-y-4"
            >
              <div className={showNickname ? "grid grid-cols-2 gap-4" : "space-y-4"}>
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
                {showNickname && (
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
                      <p className="text-[11px] text-muted-foreground">
                        {isBuyer
                          ? 'For E-Way Bill & E-Invoice WhatsApp bundle'
                          : isSupplier
                          ? 'WhatsApp updates (PO, Stock-in, Payments, Statements)'
                          : isBoth
                          ? 'WhatsApp updates & E-Way Bill bundle'
                          : 'WhatsApp updates & statement notifications'}
                      </p>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="phone2"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {isBuyer || isBoth ? 'Phone Number 2 (Driver Contact)' : 'Phone Number 2'}
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. 9876543211" {...field} />
                      </FormControl>
                      <p className="text-[11px] text-muted-foreground">
                        {isBuyer
                          ? 'Point of contact for drivers (sent to driver)'
                          : isSupplier
                          ? 'Secondary number (WhatsApp updates sent to both numbers)'
                          : isBoth
                          ? 'Point of contact for drivers & secondary WhatsApp number'
                          : 'Secondary contact number'}
                      </p>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {/* Sits with the phone numbers because it governs what lands on
                    them: PO, stock-in, verification, payment and reminder
                    messages all go out in this language. */}
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
                {/* Used only by Settings -> Wishes to target religion-specific
                    occasions (Diwali, Eid, Christmas...) - nowhere else reads this. */}
                <FormField
                  control={form.control}
                  name="religion"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Community (for Wishes)</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="NONE">Not tagged</SelectItem>
                          {(Object.keys(WISH_CATEGORY_LABELS) as WishCategory[]).map((code) => (
                            <SelectItem key={code} value={code}>
                              {WISH_CATEGORY_LABELS[code]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
                <div className="flex flex-row items-center justify-between gap-4 rounded-lg border p-3 bg-muted/20">
                  <div className="space-y-0.5">
                    <div className="text-sm font-medium flex items-center gap-1.5">
                      <MapPin className="h-4 w-4 text-primary" />
                      <span>Multiple Addresses</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {hasMultipleAddresses
                        ? 'ON - Manage multiple branch offices, factories, or delivery locations.'
                        : 'OFF - Single standard address for this party.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={hasMultipleAddresses}
                    aria-label="Multiple Addresses"
                    onClick={() => {
                      const next = !hasMultipleAddresses;
                      setHasMultipleAddresses(next);
                      if (next) {
                        if (addresses.length <= 1) {
                          setAddresses([
                            {
                              label: 'Registered Office',
                              address: form.getValues('address') || addresses[0]?.address || '',
                              city: form.getValues('city') || addresses[0]?.city || '',
                              state: form.getValues('state') || addresses[0]?.state || '',
                              pincode: form.getValues('pincode') || addresses[0]?.pincode || '',
                              gstin: form.getValues('gstin') || addresses[0]?.gstin || '',
                              destination: form.getValues('destination') || addresses[0]?.destination || '',
                              isDefault: true,
                            },
                          ]);
                        }
                      } else {
                        const def = addresses.find((a) => a.isDefault) || addresses[0];
                        if (def) {
                          form.setValue('address', def.address);
                          form.setValue('city', def.city ?? '');
                          form.setValue('state', def.state ?? '');
                          form.setValue('pincode', def.pincode ?? '');
                          if (def.gstin) form.setValue('gstin', def.gstin);
                          if (def.destination) form.setValue('destination', def.destination);
                        }
                      }
                    }}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${hasMultipleAddresses ? 'bg-primary' : 'bg-muted-foreground/30'}`}
                  >
                    <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${hasMultipleAddresses ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
                  </button>
                </div>
              )}

              {!isHamaliTeam && !hasMultipleAddresses && (
                <div className="space-y-4">
                  <FormField
                    control={form.control}
                    name="address"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Address</FormLabel>
                        <FormControl>
                          <Input placeholder="Street address, premises, area..." {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="city"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>City / Town</FormLabel>
                          <FormControl>
                            <Input placeholder="e.g. Surat, Perundurai" {...field} />
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
                            placeholder="Select state…"
                            searchPlaceholder="Search states…"
                          />
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="pincode"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Pincode</FormLabel>
                          <FormControl>
                            <Input placeholder="e.g. 638052" {...field} />
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
                          <FormLabel>Primary GSTIN</FormLabel>
                          <FormControl>
                            <Input placeholder="e.g. 37ABCDE1234F1Z5" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  {form.watch('type') !== 'SUPPLIER' && (
                    <FormField
                      control={form.control}
                      name="destination"
                      render={({ field }) => {
                        const opts = field.value && !destinationOptions.some((o) => o.value === field.value)
                          ? [{ value: field.value, label: field.value }, ...destinationOptions]
                          : destinationOptions;
                        return (
                          <FormItem className="flex flex-col justify-end">
                            <FormLabel className="mb-1">Default Delivery destination</FormLabel>
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

              {!isHamaliTeam && hasMultipleAddresses && (
                <div className="space-y-4">
                  <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-1.5 font-medium text-sm">
                          <MapPin className="h-4 w-4 text-primary" />
                          <span>Addresses &amp; Delivery Locations</span>
                          <Badge variant="secondary" className="text-xs font-normal">
                            {addresses.length} {addresses.length === 1 ? 'address' : 'addresses'}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Add multiple branch offices, factories, or delivery godowns for this party.
                        </p>
                      </div>
                      <Button type="button" variant="outline" size="sm" onClick={addAddress}>
                        <Plus className="h-3.5 w-3.5 mr-1" /> Add Address
                      </Button>
                    </div>

                    <div className="space-y-3 max-h-[360px] overflow-y-auto pr-1">
                      {addresses.map((addr, idx) => (
                        <div
                          key={idx}
                          className={`relative rounded-md border p-3.5 transition-all ${
                            addr.isDefault
                              ? 'border-primary/50 bg-primary/5 shadow-xs'
                              : 'border-border bg-card'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2 mb-3">
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <Input
                                value={addr.label}
                                onChange={(e) => updateAddress(idx, { label: e.target.value })}
                                placeholder="e.g. Registered Office, Plant 2, Surat Godown"
                                className="h-8 font-medium text-xs max-w-[260px] bg-background"
                              />
                              {addr.isDefault ? (
                                <Badge variant="default" className="text-[10px] py-0.5 px-2 flex items-center gap-1 shrink-0">
                                  <CheckCircle2 className="h-3 w-3" /> Default Address
                                </Badge>
                              ) : (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setDefaultAddress(idx)}
                                  className="h-6 text-[11px] text-muted-foreground hover:text-foreground px-2 shrink-0"
                                >
                                  Set as Default
                                </Button>
                              )}
                            </div>
                            {addresses.length > 1 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => removeAddress(idx)}
                                className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>

                          <div className="space-y-3">
                            <div>
                              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
                                Address / Premises / Area
                              </label>
                              <Input
                                value={addr.address}
                                onChange={(e) => updateAddress(idx, { address: e.target.value })}
                                placeholder="Street address, building, industrial area..."
                                className="h-8 text-xs bg-background"
                              />
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <div>
                                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
                                  City / Town
                                </label>
                                <Input
                                  value={addr.city ?? ''}
                                  onChange={(e) => updateAddress(idx, { city: e.target.value })}
                                  placeholder="e.g. Surat, Perundurai"
                                  className="h-8 text-xs bg-background"
                                />
                              </div>
                              <div>
                                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
                                  State
                                </label>
                                <Combobox
                                  options={INDIAN_STATES}
                                  value={addr.state ?? ''}
                                  onChange={(v) => updateAddress(idx, { state: v })}
                                  placeholder="Select State..."
                                  searchPlaceholder="Search state..."
                                  className="h-8 text-xs w-full min-w-0"
                                />
                              </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <div>
                                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
                                  Pincode
                                </label>
                                <Input
                                  value={addr.pincode ?? ''}
                                  onChange={(e) => updateAddress(idx, { pincode: e.target.value })}
                                  placeholder="e.g. 638052"
                                  className="h-8 text-xs bg-background"
                                />
                              </div>
                              <div>
                                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
                                  Branch GSTIN (Optional)
                                </label>
                                <Input
                                  value={addr.gstin ?? ''}
                                  onChange={(e) => updateAddress(idx, { gstin: e.target.value.toUpperCase() })}
                                  placeholder="e.g. 33AAFCK3..."
                                  className="h-8 text-xs font-mono bg-background uppercase"
                                />
                              </div>
                            </div>

                            <div>
                              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
                                Delivery Destination (Freight Calculation)
                              </label>
                              <Combobox
                                options={destinationOptions}
                                value={addr.destination ?? ''}
                                onChange={(v) => updateAddress(idx, { destination: v })}
                                placeholder="Select destination for freight rate…"
                                searchPlaceholder="Search destination…"
                                emptyText="No destinations - add them in Settings → Freight Rates."
                                className="h-8 text-xs w-full min-w-0"
                              />
                              <p className="text-[10px] text-muted-foreground mt-1">
                                Used to calculate automatic freight rates for orders delivered to this address.
                              </p>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <div>
                                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
                                  {isBuyer ? 'Branch Phone 1 (WhatsApp Bundle)' : 'Branch Phone 1'}
                                </label>
                                <Input
                                  value={addr.phone ?? ''}
                                  onChange={(e) => updateAddress(idx, { phone: e.target.value })}
                                  placeholder="e.g. 98765 43210"
                                  className="h-8 text-xs bg-background"
                                />
                              </div>
                              <div>
                                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
                                  {isBuyer || isBoth ? 'Branch Phone 2 (Driver Contact)' : 'Branch Phone 2'}
                                </label>
                                <Input
                                  value={addr.phone2 ?? ''}
                                  onChange={(e) => updateAddress(idx, { phone2: e.target.value })}
                                  placeholder="e.g. 98765 43211"
                                  className="h-8 text-xs bg-background"
                                />
                              </div>
                            </div>

                            <div>
                              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
                                Google Maps Location Link
                              </label>
                              <Input
                                value={addr.locationLink ?? ''}
                                onChange={(e) => updateAddress(idx, { locationLink: e.target.value })}
                                placeholder="e.g. https://maps.app.goo.gl/... or GPS / Plus Code"
                                className="h-8 text-xs bg-background"
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="gstin"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Primary GSTIN (Optional)</FormLabel>
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
                          const opts = field.value && !destinationOptions.some((o) => o.value === field.value)
                            ? [{ value: field.value, label: field.value }, ...destinationOptions]
                            : destinationOptions;
                          return (
                            <FormItem className="flex flex-col justify-end">
                              <FormLabel className="mb-1">Default Delivery destination</FormLabel>
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
                </div>
              )}
              {/* Buyers only. Most shipments travel without the transporter's GC
                  note, so the receipt is offered on a dispatch only for the
                  buyers switched on here. */}
              {!isHamaliTeam && form.watch('type') !== 'SUPPLIER' && (
                <FormField
                  control={form.control}
                  name="lorryReceiptEnabled"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center justify-between gap-4 rounded-lg border p-3">
                      <div className="space-y-0.5">
                        <FormLabel className="text-sm">Lorry receipt (GC)</FormLabel>
                        <p className="text-xs text-muted-foreground">
                          {field.value
                            ? 'ON - a Surya Road Lines lorry receipt can be printed for dispatches to this buyer.'
                            : 'OFF - dispatches to this buyer ship without a lorry receipt.'}
                        </p>
                      </div>
                      <FormControl>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={field.value}
                          aria-label="Lorry receipt (GC)"
                          onClick={() => field.onChange(!field.value)}
                          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${field.value ? 'bg-primary' : 'bg-muted-foreground/30'}`}
                        >
                          <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${field.value ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
                        </button>
                      </FormControl>
                    </FormItem>
                  )}
                />
              )}
              {!isHamaliTeam && !hasMultipleAddresses && (
              <FormField
                control={form.control}
                name="locationLink"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Google Maps Location Link</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. https://maps.app.goo.gl/... or 21.132722, 72.833611" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              )}

              {!isHamaliTeam && (
                <div className="space-y-3 rounded-lg border p-3 bg-muted/20">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Opening Balance (Unpaid Previous Balance)</p>
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="openingBalance"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Opening Amount (₹)</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              step="any"
                              placeholder="0"
                              {...field}
                              onChange={(e) => field.onChange(e.target.value === '' ? '' : Number(e.target.value))}
                            />
                          </FormControl>
                          <FormDescription>Unpaid legacy balance brought forward</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="openingBalanceType"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Balance Type</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value ?? (form.watch('type') === 'BUYER' ? 'DR' : 'CR')}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="CR">CR – Payable (We owe them)</SelectItem>
                              <SelectItem value="DR">DR – Receivable (They owe us)</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormDescription>
                            {form.watch('type') === 'BUYER' ? 'Normally DR (Receivable) for buyers' : 'Normally CR (Payable) for suppliers'}
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </div>
              )}

              {showBankDetails && (
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
              )}
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
