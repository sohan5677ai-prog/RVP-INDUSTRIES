import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sparkles, Image as ImageIcon, Send, RefreshCw, Users, Plus, Trash2, Tags, History, Truck } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { Party, KnmDriver, WishRecipient, WishBroadcast, WishCategory } from '@/lib/types';
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

const CATEGORY_OPTIONS: { label: string; value: CategoryFilter }[] = [
  { label: 'Everyone', value: 'ALL' },
  { label: 'Hindu', value: 'HINDU' },
  { label: 'Muslim', value: 'MUSLIM' },
  { label: 'Christian', value: 'CHRISTIAN' },
  { label: 'Other', value: 'OTHER' },
];

export default function Wishes() {
  return (
    <div className="space-y-4">
      <WishComposer />
      <WishHistorySection />
      <DriverDirectorySection />
      <PartyReligionTaggingSection />
    </div>
  );
}

// --- Compose + send -----------------------------------------------------------

function WishComposer() {
  const qc = useQueryClient();
  const [occasion, setOccasion] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('ALL');
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
      return api<{ count: number; recipients: WishRecipient[] }>(`/wishes/recipients?${params.toString()}`);
    },
  });

  const genText = useMutation({
    mutationFn: () => api<{ message: string }>('/wishes/generate/text', { method: 'POST', body: { occasion, category: wireCategory } }),
    onSuccess: (d) => setMessageText(d.message),
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });
  const genImage = useMutation({
    mutationFn: () => api<{ imageUrl: string }>('/wishes/generate/image', { method: 'POST', body: { occasion, category: wireCategory } }),
    onSuccess: (d) => setImageUrl(d.imageUrl),
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function handleGenerate() {
    if (!occasion.trim()) { toast.error('Enter an occasion first'); return; }
    genText.mutate();
    genImage.mutate();
  }

  const send = useMutation({
    mutationFn: () =>
      api<WishBroadcast>('/wishes/send', {
        method: 'POST',
        body: { occasion, category: wireCategory, includeParties, includeDrivers, includeOwners, messageText, imageUrl },
      }),
    onSuccess: (b) => {
      qc.invalidateQueries({ queryKey: ['wishes-history'] });
      toast.success(`Sent ${b.sentCount}/${b.recipientCount} - ${b.failedCount} failed, ${b.skippedCount} skipped`);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const count = recipientData?.count ?? 0;
  const categoryLabel = wireCategory ? WISH_CATEGORY_LABELS[wireCategory] : 'Everyone';
  const canSend = occasion.trim() && messageText.trim() && count > 0 && !send.isPending;

  function handleSend() {
    if (!confirm(`Send this "${occasion}" wish to ${count} recipient${count === 1 ? '' : 's'} (${categoryLabel})? This goes out immediately and cannot be recalled.`)) return;
    send.mutate();
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2">
        <Sparkles className="h-5 w-5 text-pink-500" />
        <CardTitle className="text-base">Send Wishes</CardTitle>
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
              <Segmented options={CATEGORY_OPTIONS} value={category} onValueChange={setCategory} size="sm" />
            </div>
            <p className="text-[11px] text-muted-foreground">
              "Everyone" reaches every recipient regardless of tag. A religion filters to only parties/drivers tagged with that community.
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Recipient groups</Label>
          <div className="flex flex-wrap gap-2">
            <GroupToggle label="Parties" active={includeParties} onClick={() => setIncludeParties((v) => !v)} />
            <GroupToggle label="KNM Drivers" active={includeDrivers} onClick={() => setIncludeDrivers((v) => !v)} />
            <GroupToggle label="Owners" active={includeOwners} onClick={() => setIncludeOwners((v) => !v)} />
          </div>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Users className="h-3.5 w-3.5" /> {count} recipient{count === 1 ? '' : 's'} match this selection.
          </p>
        </div>

        <div className="flex justify-end">
          <Button variant="outline" onClick={handleGenerate} disabled={!occasion.trim() || genText.isPending || genImage.isPending}>
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
            <p className="text-[11px] text-muted-foreground">Sent as "Dear &lt;name&gt;, {'{message}'} — Warm regards, RVP Industries".</p>
          </div>
          <div className="space-y-1.5">
            <Label>Image</Label>
            <div className="flex aspect-square items-center justify-center overflow-hidden rounded-md border border-dashed border-input bg-muted/30">
              {imageUrl ? (
                <img src={imageUrl} alt="Generated wish graphic" className="h-full w-full object-cover" />
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
              <RefreshCw className="h-3.5 w-3.5" /> {genImage.isPending ? 'Generating…' : imageUrl ? 'Regenerate image' : 'Generate image'}
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          Sending needs an approved WhatsApp template (rvp_wishes). Until Meta approves it, sends will log as "skipped" - see docs/whatsapp-wishes-template.md.
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

function GroupToggle({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
        active ? 'border-primary bg-primary/10 text-primary' : 'border-input text-muted-foreground hover:bg-accent'
      }`}
    >
      {label}
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
                  <TableCell>{b.category ? WISH_CATEGORY_LABELS[b.category] : 'Everyone'}</TableCell>
                  <TableCell>{b.recipientCount}</TableCell>
                  <TableCell>
                    <span className="text-green-600">{b.sentCount}</span> / <span className="text-destructive">{b.failedCount}</span> / <span className="text-muted-foreground">{b.skippedCount}</span>
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

// --- KNM Driver directory --------------------------------------------------------

interface DriverRow {
  id?: string;
  name: string;
  phone: string;
  religion: WishCategory | 'NONE';
  active: boolean;
}

const blankDriverRow: DriverRow = { name: '', phone: '', religion: 'NONE', active: true };

function DriverDirectorySection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['knm-drivers'],
    queryFn: () => api<KnmDriver[]>('/wishes/drivers'),
  });

  const [rows, setRows] = useState<DriverRow[]>([]);
  const [newRow, setNewRow] = useState<DriverRow>(blankDriverRow);
  useEffect(() => {
    if (data) setRows(data.map((d) => ({ id: d.id, name: d.name, phone: d.phone, religion: d.religion ?? 'NONE', active: d.active })));
  }, [data]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['knm-drivers'] });

  const create = useMutation({
    mutationFn: (row: DriverRow) =>
      api<KnmDriver>('/wishes/drivers', { method: 'POST', body: { name: row.name.trim(), phone: row.phone.trim(), religion: row.religion === 'NONE' ? null : row.religion } }),
    onSuccess: () => { invalidate(); setNewRow(blankDriverRow); toast.success('Driver added'); },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });
  const update = useMutation({
    mutationFn: (row: DriverRow) =>
      api<KnmDriver>(`/wishes/drivers/${row.id}`, {
        method: 'PUT',
        body: { name: row.name.trim(), phone: row.phone.trim(), religion: row.religion === 'NONE' ? null : row.religion, active: row.active },
      }),
    onSuccess: () => { invalidate(); toast.success('Driver saved'); },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/wishes/drivers/${id}`, { method: 'DELETE' }),
    onSuccess: () => { invalidate(); toast.success('Driver removed'); },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const setRow = (i: number, patch: Partial<DriverRow>) => setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2">
        <Truck className="h-5 w-5 text-blue-500" />
        <CardTitle className="text-base">KNM Driver Directory</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Maintained here so Wishes has a reliable driver contact list - dispatches elsewhere in the app still use free-text driver name/phone.
        </p>

        <div className="grid grid-cols-[1fr_1fr_160px_80px] items-end gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Name</Label>
            <Input value={newRow.name} onChange={(e) => setNewRow((p) => ({ ...p, name: e.target.value }))} placeholder="Driver name" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Phone</Label>
            <Input value={newRow.phone} onChange={(e) => setNewRow((p) => ({ ...p, phone: e.target.value }))} placeholder="9876543210" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Community</Label>
            <ReligionSelect value={newRow.religion} onChange={(v) => setNewRow((p) => ({ ...p, religion: v }))} />
          </div>
          <Button
            size="sm"
            disabled={!newRow.name.trim() || !newRow.phone.trim() || create.isPending}
            onClick={() => create.mutate(newRow)}
          >
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No drivers yet - add one above.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Community</TableHead>
                <TableHead>Active</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={r.id}>
                  <TableCell><Input value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} /></TableCell>
                  <TableCell><Input value={r.phone} onChange={(e) => setRow(i, { phone: e.target.value })} /></TableCell>
                  <TableCell><ReligionSelect value={r.religion} onChange={(v) => setRow(i, { religion: v })} /></TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => setRow(i, { active: !r.active })}
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.active ? 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400' : 'bg-muted text-muted-foreground'}`}
                    >
                      {r.active ? 'Active' : 'Inactive'}
                    </button>
                  </TableCell>
                  <TableCell className="flex items-center gap-1">
                    <Button size="icon" variant="ghost" onClick={() => update.mutate(r)} disabled={update.isPending} title="Save">
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => { if (r.id && confirm(`Remove driver ${r.name}?`)) remove.mutate(r.id); }}
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function ReligionSelect({ value, onChange }: { value: WishCategory | 'NONE'; onChange: (v: WishCategory | 'NONE') => void }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as WishCategory | 'NONE')}>
      <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="NONE">Not tagged</SelectItem>
        {(Object.keys(WISH_CATEGORY_LABELS) as WishCategory[]).map((c) => (
          <SelectItem key={c} value={c}>{WISH_CATEGORY_LABELS[c]}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// --- Party religion bulk tagging --------------------------------------------------

function PartyReligionTaggingSection() {
  const qc = useQueryClient();
  const { data: parties, isLoading } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const [search, setSearch] = useState('');
  const [untaggedOnly, setUntaggedOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagAs, setTagAs] = useState<WishCategory | 'NONE'>('NONE');

  const filtered = (parties ?? []).filter((p) => {
    if (untaggedOnly && p.religion) return false;
    if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows } = usePagedRows(filtered, 25);

  const bulkTag = useMutation({
    mutationFn: () =>
      api<{ updated: number }>('/wishes/parties/bulk-religion', {
        method: 'POST',
        body: { partyIds: Array.from(selected), religion: tagAs === 'NONE' ? null : tagAs },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['parties'] });
      setSelected(new Set());
      toast.success(`Tagged ${r.updated} part${r.updated === 1 ? 'y' : 'ies'}`);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
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
        <CardTitle className="text-base">Tag Parties by Community</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Only used to target religion-specific wishes. Untagged parties are still included in "Everyone" sends.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <SearchInput value={search} onValueChange={setSearch} placeholder="Search parties…" containerClassName="w-64" />
          <button
            type="button"
            onClick={() => setUntaggedOnly((v) => !v)}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${untaggedOnly ? 'border-primary bg-primary/10 text-primary' : 'border-input text-muted-foreground hover:bg-accent'}`}
          >
            Untagged only
          </button>

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
          <p className="text-sm text-muted-foreground">No parties match.</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-input"
                      checked={(pageRows ?? []).length > 0 && (pageRows ?? []).every((p) => selected.has(p.id))}
                      onChange={toggleAllVisible}
                    />
                  </TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Community</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(pageRows ?? []).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-input"
                        checked={selected.has(p.id)}
                        onChange={() => toggle(p.id)}
                      />
                    </TableCell>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="text-muted-foreground">{p.phone ?? '-'}</TableCell>
                    <TableCell>
                      {p.religion ? <Badge variant="soft">{WISH_CATEGORY_LABELS[p.religion]}</Badge> : <Badge variant="outline">Not tagged</Badge>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
