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
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import type {
  Party,
  Broker,
  Transport,
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
  const [activeTab, setActiveTab] = useState<'parties' | 'brokers' | 'transports'>('parties');
  const [targetMode, setTargetMode] = useState<'GROUPS' | 'SELECTED_PARTIES'>('GROUPS');
  const [selectedPartyIds, setSelectedPartyIds] = useState<string[]>([]);
  const composerSectionRef = useRef<HTMLDivElement>(null);
  const directorySectionRef = useRef<HTMLDivElement>(null);

  function handleFilterMissingPhones(target: 'parties' | 'brokers' | 'transports' = 'parties') {
    setActiveTab(target);
    setPhoneFilter('MISSING');
    directorySectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function handleWishSelectedParties(partyIds: string[]) {
    setSelectedPartyIds(partyIds);
    setTargetMode('SELECTED_PARTIES');
    composerSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast.info(`Loaded ${partyIds.length} part${partyIds.length === 1 ? 'y' : 'ies'} into composer`);
  }

  return (
    <div className="space-y-4">
      <div ref={composerSectionRef}>
        <WishComposer
          targetMode={targetMode}
          onTargetModeChange={setTargetMode}
          selectedPartyIds={selectedPartyIds}
          onSelectedPartyIdsChange={setSelectedPartyIds}
          onFilterMissingPhones={handleFilterMissingPhones}
        />
      </div>
      <WishHistorySection />
      <div ref={directorySectionRef} id="directory-tagging-section">
        <DirectoryTaggingSection
          activeTab={activeTab}
          onTabChange={setActiveTab}
          phoneFilter={phoneFilter}
          onPhoneFilterChange={setPhoneFilter}
          onWishSelectedParties={handleWishSelectedParties}
        />
      </div>
    </div>
  );
}

// --- Compose + send -----------------------------------------------------------

function WishComposer({
  targetMode,
  onTargetModeChange,
  selectedPartyIds,
  onSelectedPartyIdsChange,
  onFilterMissingPhones,
}: {
  targetMode: 'GROUPS' | 'SELECTED_PARTIES';
  onTargetModeChange: (m: 'GROUPS' | 'SELECTED_PARTIES') => void;
  selectedPartyIds: string[];
  onSelectedPartyIdsChange: (ids: string[]) => void;
  onFilterMissingPhones: (target: 'parties' | 'brokers' | 'transports') => void;
}) {
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const [occasion, setOccasion] = useState(() => searchParams.get('occasion') || '');
  const [category, setCategory] = useState<CategoryFilter>(() => {
    const cat = searchParams.get('category') as CategoryFilter | null;
    return cat && ['ALL', 'HINDU', 'MUSLIM', 'CHRISTIAN', 'OTHER'].includes(cat) ? cat : 'ALL';
  });

  const [pickerOpen, setPickerOpen] = useState(false);

  // Fetch all parties for party selection / chips
  const { data: allParties = [] } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const selectedPartyObjects = useMemo(() => {
    const map = new Map(allParties.map((p) => [p.id, p]));
    return selectedPartyIds.map((id) => map.get(id)).filter((p): p is Party => Boolean(p));
  }, [allParties, selectedPartyIds]);

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
  const [includeBrokers, setIncludeBrokers] = useState(true);
  const [includeTransports, setIncludeTransports] = useState(true);
  const [includeDrivers, setIncludeDrivers] = useState(true);
  const [includeOwners, setIncludeOwners] = useState(true);
  const [messageText, setMessageText] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  const wireCategory = category === 'ALL' ? null : category;
  const isSelectedPartiesMode = targetMode === 'SELECTED_PARTIES';

  const { data: recipientData } = useQuery({
    queryKey: [
      'wishes-recipients',
      targetMode,
      targetMode === 'GROUPS' ? wireCategory : null,
      isSelectedPartiesMode ? true : includeParties,
      isSelectedPartiesMode ? false : includeBrokers,
      isSelectedPartiesMode ? false : includeTransports,
      isSelectedPartiesMode ? false : includeDrivers,
      includeOwners,
      isSelectedPartiesMode ? selectedPartyIds.slice().sort().join(',') : '',
    ],
    queryFn: () => {
      const params = new URLSearchParams({
        includeParties: String(isSelectedPartiesMode ? true : includeParties),
        includeBrokers: String(isSelectedPartiesMode ? false : includeBrokers),
        includeTransports: String(isSelectedPartiesMode ? false : includeTransports),
        includeDrivers: String(isSelectedPartiesMode ? false : includeDrivers),
        includeOwners: String(includeOwners),
      });
      if (targetMode === 'GROUPS' && wireCategory) {
        params.set('category', wireCategory);
      }
      if (isSelectedPartiesMode && selectedPartyIds.length > 0) {
        params.set('partyIds', selectedPartyIds.join(','));
      }
      return api<WishRecipientPreview>(`/wishes/recipients?${params.toString()}`);
    },
    enabled: targetMode === 'GROUPS' || selectedPartyIds.length > 0,
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
          category: targetMode === 'GROUPS' ? wireCategory : null,
          includeParties: isSelectedPartiesMode ? true : includeParties,
          includeBrokers: isSelectedPartiesMode ? false : includeBrokers,
          includeTransports: isSelectedPartiesMode ? false : includeTransports,
          includeDrivers: isSelectedPartiesMode ? false : includeDrivers,
          includeOwners,
          partyIds: isSelectedPartiesMode ? selectedPartyIds : undefined,
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
    const targetDesc = isSelectedPartiesMode
      ? `${selectedPartyIds.length} selected part${selectedPartyIds.length === 1 ? 'y' : 'ies'}${includeOwners ? ' + owners' : ''}`
      : `${count} recipient${count === 1 ? '' : 's'} (${categoryLabel})`;

    if (
      !confirm(
        `Send this "${occasion}" wish to ${targetDesc}? This goes out immediately and cannot be recalled.`
      )
    )
      return;
    send.mutate();
  }

  return (
    <>
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
              <div className="flex items-center justify-between">
                <Label>Target Mode</Label>
                <div className="flex items-center rounded-lg border border-input p-0.5 bg-muted/30">
                  <button
                    type="button"
                    onClick={() => onTargetModeChange('GROUPS')}
                    className={cn(
                      'px-2.5 py-1 text-xs font-medium rounded-md transition-colors',
                      targetMode === 'GROUPS'
                        ? 'bg-background shadow-xs text-foreground font-semibold'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    👥 Groups Broadcast
                  </button>
                  <button
                    type="button"
                    onClick={() => onTargetModeChange('SELECTED_PARTIES')}
                    className={cn(
                      'px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5',
                      targetMode === 'SELECTED_PARTIES'
                        ? 'bg-background shadow-xs text-pink-600 dark:text-pink-400 font-semibold'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    🎯 Selected Parties
                    {selectedPartyIds.length > 0 && (
                      <span className="rounded-full bg-pink-100 dark:bg-pink-950 text-pink-700 dark:text-pink-300 px-1.5 py-0.2 text-[10px] font-bold">
                        {selectedPartyIds.length}
                      </span>
                    )}
                  </button>
                </div>
              </div>

              {targetMode === 'GROUPS' ? (
                <div>
                  <Segmented
                    options={CATEGORY_OPTIONS}
                    value={category}
                    onValueChange={setCategory}
                    size="sm"
                  />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    "Everyone" reaches every recipient regardless of tag. A religion filters to only
                    parties/brokers/transports/drivers tagged with that community.
                  </p>
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  Send festival greetings directly to specific chosen parties.
                </p>
              )}
            </div>
          </div>

          {/* Recipient Selection Section */}
          {targetMode === 'GROUPS' ? (
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
                  label="Brokers"
                  active={includeBrokers}
                  onClick={() => setIncludeBrokers((v) => !v)}
                  badge={
                    breakdown ? `${breakdown.brokersWithPhone}/${breakdown.brokersTotal}` : undefined
                  }
                />
                <GroupToggle
                  label="Transports"
                  active={includeTransports}
                  onClick={() => setIncludeTransports((v) => !v)}
                  badge={
                    breakdown
                      ? `${breakdown.transportsWithPhone}/${breakdown.transportsTotal}`
                      : undefined
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
                    ({breakdown.partiesWithPhone} parties with phone + {breakdown.brokersWithPhone} brokers + {breakdown.transportsWithPhone} transports + {breakdown.driversCount} drivers
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
                    onClick={() => onFilterMissingPhones('parties')}
                    className="font-medium underline hover:text-amber-950 dark:hover:text-amber-100 cursor-pointer"
                  >
                    View &amp; add phone numbers ({breakdown.partiesMissingPhone}) ↓
                  </button>
                </div>
              )}

              {includeBrokers && breakdown && breakdown.brokersMissingPhone > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50/80 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    <span>
                      <strong>{breakdown.brokersMissingPhone} of {breakdown.brokersTotal} brokers</strong> are missing a phone number and won't receive WhatsApp wishes.
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onFilterMissingPhones('brokers')}
                    className="font-medium underline hover:text-amber-950 dark:hover:text-amber-100 cursor-pointer"
                  >
                    View &amp; add phone numbers ({breakdown.brokersMissingPhone}) ↓
                  </button>
                </div>
              )}

              {includeTransports && breakdown && breakdown.transportsMissingPhone > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50/80 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    <span>
                      <strong>{breakdown.transportsMissingPhone} of {breakdown.transportsTotal} transports</strong> are missing a phone number and won't receive WhatsApp wishes.
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onFilterMissingPhones('transports')}
                    className="font-medium underline hover:text-amber-950 dark:hover:text-amber-100 cursor-pointer"
                  >
                    View &amp; add phone numbers ({breakdown.transportsMissingPhone}) ↓
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setPickerOpen(true)}
                    className="h-8 border-primary/40 hover:border-primary text-xs"
                  >
                    <Users className="h-3.5 w-3.5 mr-1.5 text-primary" />
                    {selectedPartyIds.length === 0
                      ? 'Select Parties…'
                      : `Choose Parties (${selectedPartyIds.length} selected)`}
                  </Button>
                  {selectedPartyIds.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 text-xs text-muted-foreground hover:text-destructive"
                      onClick={() => onSelectedPartyIdsChange([])}
                    >
                      Clear selection
                    </Button>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <GroupToggle
                    label="Owners Copy"
                    active={includeOwners}
                    onClick={() => setIncludeOwners((v) => !v)}
                    badge={breakdown ? `${breakdown.ownersCount}` : undefined}
                  />
                </div>
              </div>

              {/* Selected party chips preview */}
              {selectedPartyObjects.length > 0 ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto p-2 rounded-md bg-background border border-border/40">
                    {selectedPartyObjects.slice(0, 20).map((p) => {
                      const hasPhone = Boolean(p.phone?.trim() || p.phone2?.trim());
                      return (
                        <span
                          key={p.id}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium border',
                            hasPhone
                              ? 'bg-pink-50 dark:bg-pink-950/40 border-pink-200 dark:border-pink-900 text-pink-900 dark:text-pink-200'
                              : 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900 text-amber-900 dark:text-amber-200'
                          )}
                        >
                          <span className="truncate max-w-[160px]">{p.name}</span>
                          {!hasPhone && <PhoneOff className="h-3 w-3 text-amber-600 dark:text-amber-400" />}
                          <button
                            type="button"
                            onClick={() =>
                              onSelectedPartyIdsChange(selectedPartyIds.filter((id) => id !== p.id))
                            }
                            className="hover:text-destructive rounded-full ml-0.5"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      );
                    })}
                    {selectedPartyObjects.length > 20 && (
                      <button
                        type="button"
                        onClick={() => setPickerOpen(true)}
                        className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground font-medium hover:bg-muted/80"
                      >
                        +{selectedPartyObjects.length - 20} more…
                      </button>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Users className="h-3.5 w-3.5 text-primary" />
                    <span className="font-medium text-foreground">
                      {count} recipient{count === 1 ? '' : 's'} will receive this wish
                    </span>
                    {breakdown && (
                      <span className="text-muted-foreground">
                        ({breakdown.partiesWithPhone} selected parties with phone
                        {includeOwners ? ` + ${breakdown.ownersCount} owners` : ''})
                      </span>
                    )}
                  </div>

                  {breakdown && breakdown.partiesMissingPhone > 0 && (
                    <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50/80 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
                      <AlertCircle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                      <span>
                        <strong>{breakdown.partiesMissingPhone} of {selectedPartyObjects.length} selected parties</strong> do not have a phone number and will be skipped.
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-md border border-dashed border-border/80 p-4 text-center text-xs text-muted-foreground bg-background/50">
                  No parties selected yet. Click{' '}
                  <button
                    type="button"
                    onClick={() => setPickerOpen(true)}
                    className="font-semibold text-primary underline underline-offset-2 hover:opacity-80"
                  >
                    Select Parties…
                  </button>{' '}
                  to pick who should receive this wish, or check parties in the directory table below.
                </div>
              )}
            </div>
          )}

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

      <PartyPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        parties={allParties}
        selectedPartyIds={selectedPartyIds}
        onSelectedPartyIdsChange={onSelectedPartyIdsChange}
      />
    </>
  );
}

function PartyPickerDialog({
  open,
  onOpenChange,
  parties,
  selectedPartyIds,
  onSelectedPartyIdsChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parties: Party[];
  selectedPartyIds: string[];
  onSelectedPartyIdsChange: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState('');
  const [communityFilter, setCommunityFilter] = useState<CategoryFilter>('ALL');
  const [phoneOnlyFilter, setPhoneOnlyFilter] = useState(false);

  const selectedSet = useMemo(() => new Set(selectedPartyIds), [selectedPartyIds]);

  const filteredParties = useMemo(() => {
    return parties.filter((p) => {
      if (communityFilter !== 'ALL' && p.religion !== communityFilter) return false;
      const hasPhone = Boolean(p.phone?.trim() || p.phone2?.trim());
      if (phoneOnlyFilter && !hasPhone) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const matchName = p.name.toLowerCase().includes(q);
        const matchNickname = p.nickname?.toLowerCase().includes(q);
        const matchPhone = (p.phone ?? '').includes(q) || (p.phone2 ?? '').includes(q);
        if (!matchName && !matchNickname && !matchPhone) return false;
      }
      return true;
    });
  }, [parties, communityFilter, phoneOnlyFilter, search]);

  function handleToggle(id: string) {
    if (selectedSet.has(id)) {
      onSelectedPartyIdsChange(selectedPartyIds.filter((x) => x !== id));
    } else {
      onSelectedPartyIdsChange([...selectedPartyIds, id]);
    }
  }

  function handleSelectAllFiltered() {
    const next = new Set(selectedPartyIds);
    filteredParties.forEach((p) => next.add(p.id));
    onSelectedPartyIdsChange(Array.from(next));
  }

  function handleSelectAllWithPhone() {
    const next = new Set(selectedPartyIds);
    parties
      .filter((p) => Boolean(p.phone?.trim() || p.phone2?.trim()))
      .forEach((p) => next.add(p.id));
    onSelectedPartyIdsChange(Array.from(next));
  }

  function handleClearAll() {
    onSelectedPartyIdsChange([]);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border/40">
          <div className="flex items-center justify-between pr-6">
            <div>
              <DialogTitle className="text-base flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" /> Select Specific Parties
              </DialogTitle>
              <DialogDescription className="text-xs mt-0.5">
                Choose which parties should receive this festival wish.
              </DialogDescription>
            </div>
            <Badge variant="secondary" className="text-xs">
              {selectedPartyIds.length} Selected
            </Badge>
          </div>
        </DialogHeader>

        {/* Filter Bar */}
        <div className="px-5 py-3 border-b border-border/40 bg-muted/20 space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              value={search}
              onValueChange={setSearch}
              placeholder="Search party by name, nickname or phone…"
              containerClassName="flex-1 min-w-[200px]"
            />
            <Select
              value={communityFilter}
              onValueChange={(v) => setCommunityFilter(v as CategoryFilter)}
            >
              <SelectTrigger className="h-9 w-[130px] text-xs">
                <SelectValue placeholder="Community" />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map((c) => (
                  <SelectItem key={c.value} value={c.value} className="text-xs">
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs px-2.5"
                onClick={handleSelectAllFiltered}
              >
                Select {filteredParties.length} Shown
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs px-2.5"
                onClick={handleSelectAllWithPhone}
              >
                Select All with Phone
              </Button>
            </div>
            {selectedPartyIds.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground hover:text-destructive px-2"
                onClick={handleClearAll}
              >
                Clear all ({selectedPartyIds.length})
              </Button>
            )}
          </div>
        </div>

        {/* Party List */}
        <div className="flex-1 overflow-y-auto divide-y divide-border/30 max-h-[360px]">
          {filteredParties.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No parties match the search / filter.
            </div>
          ) : (
            filteredParties.map((p) => {
              const isSelected = selectedSet.has(p.id);
              const phone = p.phone?.trim() || p.phone2?.trim();
              return (
                <label
                  key={p.id}
                  className={cn(
                    'flex items-center justify-between px-5 py-2.5 hover:bg-muted/40 cursor-pointer transition-colors text-sm select-none',
                    isSelected && 'bg-primary/5'
                  )}
                >
                  <div className="flex items-center gap-3 min-w-0 pr-3">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => handleToggle(p.id)}
                      className="h-4 w-4 rounded border-input text-primary focus:ring-primary/30 shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="font-medium text-foreground truncate flex items-center gap-1.5">
                        <span>{p.name}</span>
                        {p.nickname && (
                          <span className="text-xs text-muted-foreground font-normal">
                            ({p.nickname})
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                        {phone ? (
                          <span className="font-mono">{phone}</span>
                        ) : (
                          <span className="text-amber-600 dark:text-amber-400 font-medium">
                            No phone (will be skipped)
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {p.religion ? (
                      <Badge variant="outline" className="text-[10px]">
                        {WISH_CATEGORY_LABELS[p.religion]}
                      </Badge>
                    ) : null}
                    <Badge variant="secondary" className="text-[10px]">
                      {p.type}
                    </Badge>
                  </div>
                </label>
              );
            })
          )}
        </div>

        {/* Footer */}
        <DialogFooter className="px-5 py-3 border-t border-border/40 bg-muted/20 sm:justify-between items-center">
          <span className="text-xs text-muted-foreground">
            {selectedPartyIds.length} of {parties.length} parties selected
          </span>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

// --- Directory & Community Tagging (Parties, Brokers & Transports) ----------------------------

function DirectoryTaggingSection({
  activeTab,
  onTabChange,
  phoneFilter,
  onPhoneFilterChange,
  onWishSelectedParties,
}: {
  activeTab: 'parties' | 'brokers' | 'transports';
  onTabChange: (tab: 'parties' | 'brokers' | 'transports') => void;
  phoneFilter: PhoneFilter;
  onPhoneFilterChange: (f: PhoneFilter) => void;
  onWishSelectedParties?: (partyIds: string[]) => void;
}) {
  const { data: parties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });
  const { data: brokers } = useQuery({
    queryKey: ['brokers'],
    queryFn: () => api<Broker[]>('/brokers'),
  });
  const { data: transports } = useQuery({
    queryKey: ['transports'],
    queryFn: () => api<Transport[]>('/transports'),
  });

  const partiesTotal = parties?.length ?? 0;
  const brokersTotal = brokers?.length ?? 0;
  const transportsTotal = transports?.length ?? 0;

  return (
    <Card>
      <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-border/40">
        <div className="flex items-center gap-2">
          <Tags className="h-5 w-5 text-purple-500" />
          <div>
            <CardTitle className="text-base">Directory &amp; Community Tagging</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Phone numbers are required for WhatsApp wishes. Community tags filter recipients for festival wishes.
            </p>
          </div>
        </div>
        <Tabs
          value={activeTab}
          onValueChange={(v) => onTabChange(v as 'parties' | 'brokers' | 'transports')}
        >
          <TabsList className="h-8">
            <TabsTrigger value="parties" className="text-xs px-3">
              Parties ({partiesTotal})
            </TabsTrigger>
            <TabsTrigger value="brokers" className="text-xs px-3">
              Brokers ({brokersTotal})
            </TabsTrigger>
            <TabsTrigger value="transports" className="text-xs px-3">
              Transports ({transportsTotal})
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {activeTab === 'parties' && (
          <PartyReligionTaggingTab
            parties={parties ?? []}
            phoneFilter={phoneFilter}
            onPhoneFilterChange={onPhoneFilterChange}
            onWishSelectedParties={onWishSelectedParties}
          />
        )}
        {activeTab === 'brokers' && (
          <BrokerReligionTaggingTab
            brokers={brokers ?? []}
            phoneFilter={phoneFilter}
            onPhoneFilterChange={onPhoneFilterChange}
          />
        )}
        {activeTab === 'transports' && (
          <TransportReligionTaggingTab
            transports={transports ?? []}
            phoneFilter={phoneFilter}
            onPhoneFilterChange={onPhoneFilterChange}
          />
        )}
      </CardContent>
    </Card>
  );
}

function PartyReligionTaggingTab({
  parties,
  phoneFilter,
  onPhoneFilterChange,
  onWishSelectedParties,
}: {
  parties: Party[];
  phoneFilter: PhoneFilter;
  onPhoneFilterChange: (f: PhoneFilter) => void;
  onWishSelectedParties?: (partyIds: string[]) => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagAs, setTagAs] = useState<WishCategory | 'NONE'>('NONE');

  // Inline editing of party phone
  const [editingPartyId, setEditingPartyId] = useState<string | null>(null);
  const [editingPhoneVal, setEditingPhoneVal] = useState('');

  const totalCount = parties.length;
  const missingPhoneCount =
    parties.filter((p) => !p.phone?.trim() && !p.phone2?.trim()).length;
  const hasPhoneCount =
    parties.filter((p) => Boolean(p.phone?.trim() || p.phone2?.trim())).length;
  const untaggedCount = parties.filter((p) => !p.religion).length;

  const filtered = parties.filter((p) => {
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
    <div className="space-y-4">
      {/* Filter pills */}
      <div className="flex flex-wrap items-center gap-2 border-b pb-3">
        <FilterPill
          label={`All Parties (${totalCount})`}
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
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{selected.size} selected</span>
            {onWishSelectedParties && (
              <Button
                size="sm"
                className="h-8 bg-pink-600 hover:bg-pink-700 text-white text-xs gap-1.5 shadow-xs"
                onClick={() => onWishSelectedParties(Array.from(selected))}
              >
                <Sparkles className="h-3.5 w-3.5" /> Wish Selected ({selected.size})
              </Button>
            )}
            <ReligionSelect value={tagAs} onChange={setTagAs} />
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => bulkTag.mutate()}
              disabled={bulkTag.isPending}
            >
              Tag selected
            </Button>
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
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
                      <Select
                        value={p.religion || 'NONE'}
                        onValueChange={(val) => {
                          api<{ updated: number }>('/wishes/parties/bulk-religion', {
                            method: 'POST',
                            body: { partyIds: [p.id], religion: val === 'NONE' ? null : (val as WishCategory) },
                          }).then(() => {
                            qc.invalidateQueries({ queryKey: ['parties'] });
                            qc.invalidateQueries({ queryKey: ['wishes-recipients'] });
                            toast.success(`Updated community for ${p.name}`);
                          }).catch((e: Error) => toast.error(getErrorMessage(e)));
                        }}
                      >
                        <SelectTrigger className="h-7 w-[125px] text-xs">
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
    </div>
  );
}

function BrokerReligionTaggingTab({
  brokers,
  phoneFilter,
  onPhoneFilterChange,
}: {
  brokers: Broker[];
  phoneFilter: PhoneFilter;
  onPhoneFilterChange: (f: PhoneFilter) => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagAs, setTagAs] = useState<WishCategory | 'NONE'>('NONE');

  // Inline editing of broker phone
  const [editingBrokerId, setEditingBrokerId] = useState<string | null>(null);
  const [editingPhoneVal, setEditingPhoneVal] = useState('');

  const totalCount = brokers.length;
  const missingPhoneCount = brokers.filter((b) => !b.phone?.trim()).length;
  const hasPhoneCount = brokers.filter((b) => Boolean(b.phone?.trim())).length;
  const untaggedCount = brokers.filter((b) => !b.religion).length;

  const filtered = brokers.filter((b) => {
    const hasPhone = Boolean(b.phone?.trim());
    if (phoneFilter === 'MISSING' && hasPhone) return false;
    if (phoneFilter === 'HAS_PHONE' && !hasPhone) return false;
    if (phoneFilter === 'UNTAGGED' && b.religion) return false;

    if (search) {
      const q = search.toLowerCase();
      const matchName = b.name.toLowerCase().includes(q);
      const matchPhone = (b.phone ?? '').includes(q);
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
      api<{ updated: number }>('/wishes/brokers/bulk-religion', {
        method: 'POST',
        body: { brokerIds: Array.from(selected), religion: tagAs === 'NONE' ? null : tagAs },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['brokers'] });
      qc.invalidateQueries({ queryKey: ['wishes-recipients'] });
      setSelected(new Set());
      toast.success(`Tagged ${r.updated} broker${r.updated === 1 ? '' : 's'}`);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const updatePhoneMutation = useMutation({
    mutationFn: ({ id, phone }: { id: string; phone: string }) =>
      api<Broker>(`/wishes/brokers/${id}/phone`, {
        method: 'PATCH',
        body: { phone },
      }),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ['brokers'] });
      qc.invalidateQueries({ queryKey: ['wishes-recipients'] });
      setEditingBrokerId(null);
      toast.success(`Phone saved for ${updated.name}`);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function startEditPhone(b: Broker) {
    setEditingBrokerId(b.id);
    setEditingPhoneVal(b.phone ?? '');
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
      const visibleIds = (pageRows ?? []).map((b) => b.id);
      const allSelected = visibleIds.every((id) => prev.has(id));
      const next = new Set(prev);
      for (const id of visibleIds) allSelected ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      {/* Filter pills */}
      <div className="flex flex-wrap items-center gap-2 border-b pb-3">
        <FilterPill
          label={`All Brokers (${totalCount})`}
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
          placeholder="Search broker name or phone…"
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

      {filtered.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No brokers match the selected filter.
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
                      (pageRows ?? []).every((b) => selected.has(b.id))
                    }
                    onChange={toggleAllVisible}
                  />
                </TableHead>
                <TableHead>Broker Name</TableHead>
                <TableHead className="w-[280px]">WhatsApp Phone</TableHead>
                <TableHead>Community</TableHead>
                <TableHead className="text-right">Brokerage / Order</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(pageRows ?? []).map((b) => {
                const hasPhone = Boolean(b.phone?.trim());
                const isEditing = editingBrokerId === b.id;

                return (
                  <TableRow key={b.id}>
                    <TableCell>
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-input"
                        checked={selected.has(b.id)}
                        onChange={() => toggle(b.id)}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      <div>{b.name}</div>
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
                              if (e.key === 'Enter') handleSavePhone(b.id);
                              if (e.key === 'Escape') setEditingBrokerId(null);
                            }}
                          />
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-green-600 hover:text-green-700"
                            onClick={() => handleSavePhone(b.id)}
                            disabled={updatePhoneMutation.isPending}
                            title="Save phone"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            onClick={() => setEditingBrokerId(null)}
                            title="Cancel"
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : hasPhone ? (
                        <div className="flex items-center gap-2 group">
                          <div className="text-xs font-mono">{b.phone || '-'}</div>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                            onClick={() => startEditPhone(b)}
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
                            onClick={() => startEditPhone(b)}
                          >
                            <Plus className="mr-0.5 h-3 w-3" /> Add phone
                          </Button>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Select
                        value={b.religion || 'NONE'}
                        onValueChange={(val) => {
                          api<{ updated: number }>('/wishes/brokers/bulk-religion', {
                            method: 'POST',
                            body: { brokerIds: [b.id], religion: val === 'NONE' ? null : (val as WishCategory) },
                          })
                            .then(() => {
                              qc.invalidateQueries({ queryKey: ['brokers'] });
                              qc.invalidateQueries({ queryKey: ['wishes-recipients'] });
                              toast.success(`Updated community for ${b.name}`);
                            })
                            .catch((e: Error) => toast.error(getErrorMessage(e)));
                        }}
                      >
                        <SelectTrigger className="h-7 w-[125px] text-xs">
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
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      ₹{Number(b.brokerageAmount).toLocaleString('en-IN')}
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
    </div>
  );
}

function TransportReligionTaggingTab({
  transports,
  phoneFilter,
  onPhoneFilterChange,
}: {
  transports: Transport[];
  phoneFilter: PhoneFilter;
  onPhoneFilterChange: (f: PhoneFilter) => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagAs, setTagAs] = useState<WishCategory | 'NONE'>('NONE');

  // Inline editing of transport phone
  const [editingTransportId, setEditingTransportId] = useState<string | null>(null);
  const [editingPhoneVal, setEditingPhoneVal] = useState('');

  const totalCount = transports.length;
  const missingPhoneCount = transports.filter((t) => !t.phone?.trim() && !t.phone2?.trim()).length;
  const hasPhoneCount = transports.filter((t) => Boolean(t.phone?.trim() || t.phone2?.trim())).length;
  const untaggedCount = transports.filter((t) => !t.religion).length;

  const filtered = transports.filter((t) => {
    const hasPhone = Boolean(t.phone?.trim() || t.phone2?.trim());
    if (phoneFilter === 'MISSING' && hasPhone) return false;
    if (phoneFilter === 'HAS_PHONE' && !hasPhone) return false;
    if (phoneFilter === 'UNTAGGED' && t.religion) return false;

    if (search) {
      const q = search.toLowerCase();
      const matchName = t.name.toLowerCase().includes(q);
      const matchCode = (t.code ?? '').toLowerCase().includes(q);
      const matchContact = (t.contactPerson ?? '').toLowerCase().includes(q);
      const matchPhone = (t.phone ?? '').includes(q) || (t.phone2 ?? '').includes(q);
      const matchCity = (t.city ?? '').toLowerCase().includes(q);
      if (!matchName && !matchCode && !matchContact && !matchPhone && !matchCity) return false;
    }
    return true;
  });

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows } = usePagedRows(
    filtered,
    25
  );

  const bulkTag = useMutation({
    mutationFn: () =>
      api<{ updated: number }>('/wishes/transports/bulk-religion', {
        method: 'POST',
        body: { transportIds: Array.from(selected), religion: tagAs === 'NONE' ? null : tagAs },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['transports'] });
      qc.invalidateQueries({ queryKey: ['wishes-recipients'] });
      setSelected(new Set());
      toast.success(`Tagged ${r.updated} transport${r.updated === 1 ? '' : 's'}`);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const updatePhoneMutation = useMutation({
    mutationFn: ({ id, phone }: { id: string; phone: string }) =>
      api<Transport>(`/wishes/transports/${id}/phone`, {
        method: 'PATCH',
        body: { phone },
      }),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ['transports'] });
      qc.invalidateQueries({ queryKey: ['wishes-recipients'] });
      setEditingTransportId(null);
      toast.success(`Phone saved for ${updated.name}`);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function startEditPhone(t: Transport) {
    setEditingTransportId(t.id);
    setEditingPhoneVal(t.phone ?? '');
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
      const visibleIds = (pageRows ?? []).map((t) => t.id);
      const allSelected = visibleIds.every((id) => prev.has(id));
      const next = new Set(prev);
      for (const id of visibleIds) allSelected ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      {/* Filter pills */}
      <div className="flex flex-wrap items-center gap-2 border-b pb-3">
        <FilterPill
          label={`All Transports (${totalCount})`}
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
          placeholder="Search transport name, contact, phone…"
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

      {filtered.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No transports match the selected filter.
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
                      (pageRows ?? []).every((t) => selected.has(t.id))
                    }
                    onChange={toggleAllVisible}
                  />
                </TableHead>
                <TableHead>Transport Name</TableHead>
                <TableHead>Contact Person</TableHead>
                <TableHead>WhatsApp Phone</TableHead>
                <TableHead>Community</TableHead>
                <TableHead>City / State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(pageRows ?? []).map((t) => {
                const isEditingPhone = editingTransportId === t.id;
                const hasPhone = Boolean(t.phone?.trim() || t.phone2?.trim());
                return (
                  <TableRow key={t.id}>
                    <TableCell>
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-input"
                        checked={selected.has(t.id)}
                        onChange={() => toggle(t.id)}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {t.name}
                        {t.code && (
                          <Badge variant="outline" className="text-[10px] font-mono px-1 py-0">
                            {t.code}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {t.contactPerson || '-'}
                    </TableCell>
                    <TableCell>
                      {isEditingPhone ? (
                        <div className="flex items-center gap-1">
                          <Input
                            value={editingPhoneVal}
                            onChange={(e) => setEditingPhoneVal(e.target.value)}
                            placeholder="10-digit mobile"
                            inputMode="tel"
                            className="h-7 w-36 text-xs"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSavePhone(t.id);
                              if (e.key === 'Escape') setEditingTransportId(null);
                            }}
                          />
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-green-600 hover:text-green-700"
                            onClick={() => handleSavePhone(t.id)}
                            disabled={updatePhoneMutation.isPending}
                            title="Save phone"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            onClick={() => setEditingTransportId(null)}
                            title="Cancel"
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : hasPhone ? (
                        <div className="flex items-center gap-2 group">
                          <div className="text-xs font-mono">
                            {t.phone || t.phone2 || '-'}
                            {t.phone && t.phone2 && (
                              <span className="text-muted-foreground">, {t.phone2}</span>
                            )}
                          </div>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                            onClick={() => startEditPhone(t)}
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
                            onClick={() => startEditPhone(t)}
                          >
                            <Plus className="mr-0.5 h-3 w-3" /> Add phone
                          </Button>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Select
                        value={t.religion || 'NONE'}
                        onValueChange={(val) => {
                          api<{ updated: number }>('/wishes/transports/bulk-religion', {
                            method: 'POST',
                            body: { transportIds: [t.id], religion: val === 'NONE' ? null : (val as WishCategory) },
                          })
                            .then(() => {
                              qc.invalidateQueries({ queryKey: ['transports'] });
                              qc.invalidateQueries({ queryKey: ['wishes-recipients'] });
                              toast.success(`Updated community for ${t.name}`);
                            })
                            .catch((e: Error) => toast.error(getErrorMessage(e)));
                        }}
                      >
                        <SelectTrigger className="h-7 w-[125px] text-xs">
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
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {[t.city, t.state].filter(Boolean).join(', ') || '-'}
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
    </div>
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

