import { useEffect, useState, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Sparkles,
  Image as ImageIcon,
  Send,
  RefreshCw,
  Users,
  Plus,
  Tags,
  History,
  AlertCircle,
  Phone,
  PhoneOff,
  Pencil,
  Check,
  X,
} from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { FESTIVALS, type FestivalItem } from '@/lib/festivals';
import type {
  Party,
  WishRecipientPreview,
  WishBroadcast,
  WishCategory,
} from '@/lib/types';
import { WISH_CATEGORY_LABELS } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Segmented } from '@/components/ui/segmented';
import { SearchInput } from '@/components/ui/search-input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { usePagedRows } from '@/lib/usePagedRows';
import { PaginationBar } from '@/components/ui/pagination-bar';

type CategoryFilter = WishCategory | 'ALL';
type PhoneFilter = 'ALL' | 'MISSING' | 'HAS_PHONE' | 'UNTAGGED';

const CATEGORY_OPTIONS: { label: string; value: CategoryFilter }[] = [
  { label: 'Everyone', value: 'ALL' },
  { label: 'Hindu', value: 'HINDU' },
  { label: 'Muslim', value: 'MUSLIM' },
  { label: 'Christian', value: 'CHRISTIAN' },
  { label: 'Other', value: 'OTHER' },
];

export default function Wishes() {
  const [phoneFilter, setPhoneFilter] = useState<PhoneFilter>('ALL');
  const partySectionRef = useRef<HTMLDivElement>(null);

  function handleFilterMissingPhones() {
    setPhoneFilter('MISSING');
    partySectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="space-y-4">
      <WishComposer onFilterMissingPhones={handleFilterMissingPhones} />
      <WishHistorySection />
      <div ref={partySectionRef} id="party-tagging-section">
        <PartyReligionTaggingSection
          phoneFilter={phoneFilter}
          onPhoneFilterChange={setPhoneFilter}
        />
      </div>
    </div>
  );
}

// --- Compose + send -----------------------------------------------------------

function WishComposer({ onFilterMissingPhones }: { onFilterMissingPhones: () => void }) {
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const [occasion, setOccasion] = useState(() => searchParams.get('occasion') || '');
  const [category, setCategory] = useState<CategoryFilter>(() => {
    const cat = searchParams.get('category') as CategoryFilter | null;
    return cat && ['ALL', 'HINDU', 'MUSLIM', 'CHRISTIAN', 'OTHER'].includes(cat) ? cat : 'ALL';
  });

  useEffect(() => {
    const occ = searchParams.get('occasion');
    const cat = searchParams.get('category') as CategoryFilter | null;
    if (occ) setOccasion(occ);
    if (cat && ['ALL', 'HINDU', 'MUSLIM', 'CHRISTIAN', 'OTHER'].includes(cat)) {
      setCategory(cat);
    }
  }, [searchParams]);

  const uniqueFestivals = useMemo<FestivalItem[]>(() => {
    const map = new Map<string, FestivalItem>();
    FESTIVALS.forEach((f: FestivalItem) => {
      if (!map.has(f.name)) map.set(f.name, f);
    });
    return Array.from(map.values());
  }, []);

  function handleSelectPreset(festName: string) {
    const found = uniqueFestivals.find((f: FestivalItem) => f.name === festName);
    if (found) {
      setOccasion(found.name);
      setCategory(found.category);
      toast.info(`Selected preset: ${found.name}`);
    }
  }

  const [includeParties, setIncludeParties] = useState(true);
  const [includeDrivers, setIncludeDrivers] = useState(true);
  const [includeOwners, setIncludeOwners] = useState(true);
  const [messageText, setMessageText] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  const wireCategory = category === 'ALL' ? null : category;

  const { data: recipientData } = useQuery({
    queryKey: ['wishes-recipients', wireCategory, includeParties, includeDrivers, includeOwners],
    queryFn: () => {
      const params = new URLSearchParams({
        includeParties: String(includeParties),
        includeDrivers: String(includeDrivers),
        includeOwners: String(includeOwners),
      });
      if (wireCategory) params.set('category', wireCategory);
      return api<WishRecipientPreview>(`/wishes/recipients?${params.toString()}`);
    },
  });

  const genText = useMutation({
    mutationFn: () =>
      api<{ message: string }>('/wishes/generate/text', {
        method: 'POST',
        body: { occasion, category: wireCategory },
      }),
    onSuccess: (d) => setMessageText(d.message),
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });
  const genImage = useMutation({
    mutationFn: () =>
      api<{ imageUrl: string }>('/wishes/generate/image', {
        method: 'POST',
        body: { occasion, category: wireCategory },
      }),
    onSuccess: (d) => setImageUrl(d.imageUrl),
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function handleGenerate() {
    if (!occasion.trim()) {
      toast.error('Enter an occasion first');
      return;
    }
    genText.mutate();
    genImage.mutate();
  }

  const send = useMutation({
    mutationFn: () =>
      api<WishBroadcast>('/wishes/send', {
        method: 'POST',
        body: {
          occasion,
          category: wireCategory,
          includeParties,
          includeDrivers,
          includeOwners,
          messageText,
          imageUrl,
        },
      }),
    onSuccess: (b) => {
      qc.invalidateQueries({ queryKey: ['wishes-history'] });
      toast.success(
        `Sent ${b.sentCount}/${b.recipientCount} - ${b.failedCount} failed, ${b.skippedCount} skipped`
      );
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const count = recipientData?.count ?? 0;
  const breakdown = recipientData?.breakdown;
  const categoryLabel = wireCategory ? WISH_CATEGORY_LABELS[wireCategory] : 'Everyone';
  const canSend = occasion.trim() && messageText.trim() && count > 0 && !send.isPending;

  function handleSend() {
    if (
      !confirm(
        `Send this "${occasion}" wish to ${count} recipient${
          count === 1 ? '' : 's'
        } (${categoryLabel})? This goes out immediately and cannot be recalled.`
      )
    )
      return;
    send.mutate();
  }

  return (
    <Card>
      <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-border/40">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-pink-500" />
          <CardTitle className="text-base">Send Wishes</CardTitle>
        </div>
        <div className="flex items-center gap-2">
          <Select onValueChange={handleSelectPreset}>
            <SelectTrigger className="h-8 w-[220px] text-xs">
              <SelectValue placeholder="🎉 Quick festival preset…" />
            </SelectTrigger>
            <SelectContent className="max-h-[300px]">
              {uniqueFestivals.map((f: FestivalItem) => (
                <SelectItem key={f.name} value={f.name} className="text-xs">
                  {f.name} ({f.category === 'ALL' ? 'Everyone' : WISH_CATEGORY_LABELS[f.category]})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Occasion</Label>
            <Input
              value={occasion}
              onChange={(e) => setOccasion(e.target.value)}
              placeholder="e.g. Diwali, Independence Day, Eid, Christmas"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Audience</Label>
            <div>
              <Segmented
                options={CATEGORY_OPTIONS}
                value={category}
                onValueChange={setCategory}
                size="sm"
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              "Everyone" reaches every recipient regardless of tag. A religion filters to only
              parties/drivers tagged with that community.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <Label>Recipient groups</Label>
          <div className="flex flex-wrap items-center gap-2">
            <GroupToggle
              label="Parties"
              active={includeParties}
              onClick={() => setIncludeParties((v) => !v)}
              badge={
                breakdown ? `${breakdown.partiesWithPhone}/${breakdown.partiesTotal}` : undefined
              }
            />
            <GroupToggle
              label="KNM Drivers"
              active={includeDrivers}
              onClick={() => setIncludeDrivers((v) => !v)}
              badge={breakdown ? `${breakdown.driversCount}` : undefined}
            />
            <GroupToggle
              label="Owners"
              active={includeOwners}
              onClick={() => setIncludeOwners((v) => !v)}
              badge={breakdown ? `${breakdown.ownersCount}` : undefined}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Users className="h-3.5 w-3.5 text-primary" />
            <span className="font-medium text-foreground">
              {count} recipient{count === 1 ? '' : 's'} match this selection
            </span>
            {breakdown && (
              <span className="text-muted-foreground">
                ({breakdown.partiesWithPhone} parties with phone + {breakdown.driversCount} drivers
                + {breakdown.ownersCount} owners)
              </span>
            )}
          </div>

          {includeParties && breakdown && breakdown.partiesMissingPhone > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50/80 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <span>
                  <strong>{breakdown.partiesMissingPhone} of {breakdown.partiesTotal} parties</strong> are missing a phone number and won't receive WhatsApp wishes.
                </span>
              </div>
              <button
                type="button"
                onClick={onFilterMissingPhones}
                className="font-medium underline hover:text-amber-950 dark:hover:text-amber-100 cursor-pointer"
              >
                View &amp; add phone numbers ({breakdown.partiesMissingPhone}) ↓
              </button>
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <Button
            variant="outline"
            onClick={handleGenerate}
            disabled={!occasion.trim() || genText.isPending || genImage.isPending}
          >
            <Sparkles className="h-4 w-4" />
            {genText.isPending || genImage.isPending ? 'Generating…' : 'Generate message + image'}
          </Button>
        </div>

        <div className="grid gap-4 sm:grid-cols-[1fr_220px]">
          <div className="space-y-1.5">
            <Label>Message</Label>
            <textarea
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              placeholder="Generate or write the wish message here…"
              rows={5}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
            />
            <p className="text-[11px] text-muted-foreground">
              Sent as "🎉 Dear &lt;name&gt; ," + message body + "Warm regards, RVP INDUSTRIES PUNGANUR".
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Image</Label>
            <div className="flex aspect-square items-center justify-center overflow-hidden rounded-md border border-dashed border-input bg-muted/30">
              {imageUrl ? (
                <img
                  src={imageUrl}
                  alt="Generated wish graphic"
                  className="h-full w-full object-cover"
                />
              ) : (
                <ImageIcon className="h-8 w-8 text-muted-foreground" />
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => genImage.mutate()}
              disabled={!occasion.trim() || genImage.isPending}
            >
              <RefreshCw className="h-3.5 w-3.5" />{' '}
              {genImage.isPending
                ? 'Generating…'
                : imageUrl
                ? 'Regenerate image'
                : 'Generate image'}
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
          <span>
            Approved WhatsApp template:{' '}
            <span className="font-semibold font-mono">rvp_rema</span> (ID:{' '}
            <span className="font-mono">31089</span>) • Marketing (EN)
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200">
            ✓ Active
          </span>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSend} disabled={!canSend}>
            <Send className="h-4 w-4" /> {send.isPending ? 'Sending…' : `Send Now (${count})`}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function GroupToggle({
  label,
  active,
  onClick,
  badge,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-input text-muted-foreground hover:bg-accent'
      }`}
    >
      <span>{label}</span>
      {badge && (
        <span
          className={`rounded-full px-1.5 py-0.2 text-[10px] font-semibold ${
            active ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
          }`}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

// --- History -------------------------------------------------------------------

function WishHistorySection() {
  const { data, isLoading } = useQuery({
    queryKey: ['wishes-history'],
    queryFn: () => api<WishBroadcast[]>('/wishes/history'),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2">
        <History className="h-5 w-5 text-slate-500" />
        <CardTitle className="text-base">Wishes History</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !data?.length ? (
          <p className="text-sm text-muted-foreground">No wishes sent yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Occasion</TableHead>
                <TableHead>Audience</TableHead>
                <TableHead>Recipients</TableHead>
                <TableHead>Sent / Failed / Skipped</TableHead>
                <TableHead>By</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="font-medium">{b.occasion}</TableCell>
                  <TableCell>
                    {b.category ? WISH_CATEGORY_LABELS[b.category] : 'Everyone'}
                  </TableCell>
                  <TableCell>{b.recipientCount}</TableCell>
                  <TableCell>
                    <span className="text-green-600">{b.sentCount}</span> /{' '}
                    <span className="text-destructive">{b.failedCount}</span> /{' '}
                    <span className="text-muted-foreground">{b.skippedCount}</span>
                  </TableCell>
                  <TableCell>{b.sentByName ?? '-'}</TableCell>
                  <TableCell>{new Date(b.createdAt).toLocaleString('en-IN')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}



function ReligionSelect({
  value,
  onChange,
}: {
  value: WishCategory | 'NONE';
  onChange: (v: WishCategory | 'NONE') => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as WishCategory | 'NONE')}>
      <SelectTrigger size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="NONE">Not tagged</SelectItem>
        {(Object.keys(WISH_CATEGORY_LABELS) as WishCategory[]).map((c) => (
          <SelectItem key={c} value={c}>
            {WISH_CATEGORY_LABELS[c]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// --- Party religion bulk tagging & phone management -------------------------------

function PartyReligionTaggingSection({
  phoneFilter,
  onPhoneFilterChange,
}: {
  phoneFilter: PhoneFilter;
  onPhoneFilterChange: (f: PhoneFilter) => void;
}) {
  const qc = useQueryClient();
  const { data: parties, isLoading } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagAs, setTagAs] = useState<WishCategory | 'NONE'>('NONE');

  // Inline editing of party phone
  const [editingPartyId, setEditingPartyId] = useState<string | null>(null);
  const [editingPhoneVal, setEditingPhoneVal] = useState('');

  const totalCount = parties?.length ?? 0;
  const missingPhoneCount =
    parties?.filter((p) => !p.phone?.trim() && !p.phone2?.trim()).length ?? 0;
  const hasPhoneCount =
    parties?.filter((p) => Boolean(p.phone?.trim() || p.phone2?.trim())).length ?? 0;
  const untaggedCount = parties?.filter((p) => !p.religion).length ?? 0;

  const filtered = (parties ?? []).filter((p) => {
    const hasPhone = Boolean(p.phone?.trim() || p.phone2?.trim());
    if (phoneFilter === 'MISSING' && hasPhone) return false;
    if (phoneFilter === 'HAS_PHONE' && !hasPhone) return false;
    if (phoneFilter === 'UNTAGGED' && p.religion) return false;

    if (search) {
      const q = search.toLowerCase();
      const matchName = p.name.toLowerCase().includes(q);
      const matchPhone = (p.phone ?? '').includes(q) || (p.phone2 ?? '').includes(q);
      if (!matchName && !matchPhone) return false;
    }
    return true;
  });

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows } = usePagedRows(
    filtered,
    25
  );

  const bulkTag = useMutation({
    mutationFn: () =>
      api<{ updated: number }>('/wishes/parties/bulk-religion', {
        method: 'POST',
        body: { partyIds: Array.from(selected), religion: tagAs === 'NONE' ? null : tagAs },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['parties'] });
      qc.invalidateQueries({ queryKey: ['wishes-recipients'] });
      setSelected(new Set());
      toast.success(`Tagged ${r.updated} part${r.updated === 1 ? 'y' : 'ies'}`);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const updatePhoneMutation = useMutation({
    mutationFn: ({ id, phone }: { id: string; phone: string }) =>
      api<Party>(`/wishes/parties/${id}/phone`, {
        method: 'PATCH',
        body: { phone },
      }),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ['parties'] });
      qc.invalidateQueries({ queryKey: ['wishes-recipients'] });
      setEditingPartyId(null);
      toast.success(`Phone saved for ${updated.name}`);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function startEditPhone(p: Party) {
    setEditingPartyId(p.id);
    setEditingPhoneVal(p.phone ?? '');
  }

  function handleSavePhone(id: string) {
    updatePhoneMutation.mutate({ id, phone: editingPhoneVal.trim() });
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const visibleIds = (pageRows ?? []).map((p) => p.id);
      const allSelected = visibleIds.every((id) => prev.has(id));
      const next = new Set(prev);
      for (const id of visibleIds) allSelected ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2">
        <Tags className="h-5 w-5 text-purple-500" />
        <div>
          <CardTitle className="text-base">Party Directory &amp; Community Tagging</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            {totalCount} total parties. Phone numbers are required to send WhatsApp wishes. Community tags filter recipients for festival wishes.
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filter pills */}
        <div className="flex flex-wrap items-center gap-2 border-b pb-3">
          <FilterPill
            label={`All (${totalCount})`}
            active={phoneFilter === 'ALL'}
            onClick={() => onPhoneFilterChange('ALL')}
          />
          <FilterPill
            label={`Missing Phone (${missingPhoneCount})`}
            active={phoneFilter === 'MISSING'}
            onClick={() => onPhoneFilterChange('MISSING')}
            warning={missingPhoneCount > 0}
            icon={PhoneOff}
          />
          <FilterPill
            label={`Has Phone (${hasPhoneCount})`}
            active={phoneFilter === 'HAS_PHONE'}
            onClick={() => onPhoneFilterChange('HAS_PHONE')}
            icon={Phone}
          />
          <FilterPill
            label={`Untagged Community (${untaggedCount})`}
            active={phoneFilter === 'UNTAGGED'}
            onClick={() => onPhoneFilterChange('UNTAGGED')}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <SearchInput
            value={search}
            onValueChange={setSearch}
            placeholder="Search party name or phone…"
            containerClassName="w-64"
          />

          {selected.size > 0 && (
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{selected.size} selected</span>
              <ReligionSelect value={tagAs} onChange={setTagAs} />
              <Button size="sm" onClick={() => bulkTag.mutate()} disabled={bulkTag.isPending}>
                Tag selected
              </Button>
            </div>
          )}
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No parties match the selected filter.
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-input"
                      checked={
                        (pageRows ?? []).length > 0 &&
                        (pageRows ?? []).every((p) => selected.has(p.id))
                      }
                      onChange={toggleAllVisible}
                    />
                  </TableHead>
                  <TableHead>Party Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="w-[280px]">WhatsApp Phone</TableHead>
                  <TableHead>Community</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(pageRows ?? []).map((p) => {
                  const hasPhone = Boolean(p.phone?.trim() || p.phone2?.trim());
                  const isEditing = editingPartyId === p.id;

                  return (
                    <TableRow key={p.id}>
                      <TableCell>
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-input"
                          checked={selected.has(p.id)}
                          onChange={() => toggle(p.id)}
                        />
                      </TableCell>
                      <TableCell className="font-medium">
                        <div>{p.name}</div>
                        {p.nickname && (
                          <div className="text-[11px] text-muted-foreground">{p.nickname}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px] font-normal">
                          {p.type}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {isEditing ? (
                          <div className="flex items-center gap-1.5">
                            <Input
                              value={editingPhoneVal}
                              onChange={(e) => setEditingPhoneVal(e.target.value)}
                              placeholder="10-digit mobile"
                              inputMode="tel"
                              className="h-7 w-36 text-xs"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSavePhone(p.id);
                                if (e.key === 'Escape') setEditingPartyId(null);
                              }}
                            />
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-green-600 hover:text-green-700"
                              onClick={() => handleSavePhone(p.id)}
                              disabled={updatePhoneMutation.isPending}
                              title="Save phone"
                            >
                              <Check className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-muted-foreground hover:text-foreground"
                              onClick={() => setEditingPartyId(null)}
                              title="Cancel"
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : hasPhone ? (
                          <div className="flex items-center gap-2 group">
                            <div className="text-xs">
                              <span className="font-mono">{p.phone || '-'}</span>
                              {p.phone2 && (
                                <span className="ml-1 text-muted-foreground font-mono text-[11px]">
                                  ({p.phone2})
                                </span>
                              )}
                            </div>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                              onClick={() => startEditPhone(p)}
                              title="Edit phone number"
                            >
                              <Pencil className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <Badge
                              variant="outline"
                              className="border-amber-300 bg-amber-50 text-amber-800 text-[11px] font-normal dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300"
                            >
                              No phone
                            </Badge>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-[11px] font-medium"
                              onClick={() => startEditPhone(p)}
                            >
                              <Plus className="mr-0.5 h-3 w-3" /> Add phone
                            </Button>
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        {p.religion ? (
                          <Badge variant="soft">{WISH_CATEGORY_LABELS[p.religion]}</Badge>
                        ) : (
                          <Badge variant="outline">Not tagged</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <PaginationBar
              page={page}
              setPage={setPage}
              pageSize={pageSize}
              setPageSize={setPageSize}
              totalPages={totalPages}
              total={total}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function FilterPill({
  label,
  active,
  onClick,
  warning,
  icon: Icon,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  warning?: boolean;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : warning
          ? 'border-amber-300 bg-amber-50/80 text-amber-900 hover:bg-amber-100/80 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200'
          : 'border-input text-muted-foreground hover:bg-accent hover:text-foreground'
      }`}
    >
      {Icon && <Icon className="h-3 w-3" />}
      <span>{label}</span>
    </button>
  );
}

