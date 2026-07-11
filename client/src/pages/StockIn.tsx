import { Fragment, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, FileText, Pencil, Trash2, Sparkles, Loader2, UploadCloud, ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, Truck, PackageCheck, Clock } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { PurchaseOrder, StockIn as StockInType } from '@/lib/types';
import { kg, rupees, shortDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Segmented } from '@/components/ui/segmented';
import { Combobox } from '@/components/ui/combobox';
import { UrpStockInDialog } from '@/components/UrpStockInDialog';

type StockInRow = StockInType;
type DocKind = 'invoice' | 'partyKata' | 'rvpWeight';

/**
 * Display labels for loading locations. The stored values stay the same (so
 * existing records keep working); only the text shown to the user changes.
 */
const LOCATION_LABELS: Record<string, string> = {
  'RVP': 'RVP',
  Rampalli: 'PGR Cold',
  Multi: 'KNM Multi',
};
const locationLabel = (v: string) => LOCATION_LABELS[v] ?? v;

interface Extracted {
  invoiceNumber?: string;
  lorryNumber?: string;
  arrivalDate?: string;
  billingWeightKg?: number;
  partyKataKg?: number;
  rvpFirstWeightKg?: number;
  partyName?: string;
  pricePerKg?: number;
  matchedPartyName?: string;
}

/** Loose name key for matching: lowercase, alphanumerics only. */
function nameKey(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Normalise a vehicle plate: uppercase, alphanumerics only. */
function plateKey(s: string) {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Whether two vehicle numbers can be the same lorry, tolerating a partly-read
 * plate (e.g. a half-printed "TN28BA49" vs the full "TN28BA4946"). They're
 * compatible when equal or when the shorter is a leading part of the longer.
 */
function platesCompatible(a: string, b: string) {
  const x = plateKey(a);
  const y = plateKey(b);
  if (!x || !y) return true; // nothing to compare against yet
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // Require a reasonable overlap so unrelated short reads don't match by accident.
  return short.length >= 5 && long.startsWith(short);
}

/** A single drag-and-drop document zone that runs AI extraction on drop/select. */
function DropZone({
  title, hint, accept, busy, onPick,
}: {
  title: string;
  hint: string;
  accept: string;
  busy: boolean;
  onPick: (f: File) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function pick(f: File | null) {
    if (!f) return;
    setName(f.name);
    onPick(f);
  }

  return (
    <div className="space-y-1.5">
      <Label>{title}</Label>
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); pick(e.dataTransfer.files?.[0] ?? null); }}
        className={`flex min-h-[92px] cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-3 text-center transition-colors ${
          dragOver ? 'border-primary bg-primary/5' : 'border-input hover:border-primary/50'
        }`}
      >
        {busy ? (
          <>
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <p className="text-xs text-muted-foreground">Reading with AI…</p>
          </>
        ) : name ? (
          <>
            <FileText className="h-5 w-5 text-primary" />
            <p className="max-w-[140px] truncate text-xs font-medium">{name}</p>
            <p className="text-[10px] text-muted-foreground">Click to replace</p>
          </>
        ) : (
          <>
            <UploadCloud className="h-5 w-5 text-muted-foreground" />
            <p className="text-xs font-medium">{hint}</p>
            <p className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <Sparkles className="h-2.5 w-2.5" /> AI auto-fill
            </p>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => pick(e.target.files?.[0] ?? null)}
      />
    </div>
  );
}

export default function StockIn() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [urpOpen, setUrpOpen] = useState(false);
  const [editing, setEditing] = useState<StockInRow | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'AWAITING' | 'PURCHASED'>('ALL');
  const [partyFilter, setPartyFilter] = useState('ALL');

  const { data: items, isLoading } = useQuery({
    queryKey: ['stock-in'],
    queryFn: () => api<StockInRow[]>('/stock-in'),
  });

  function toggleGroup(poId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(poId)) next.delete(poId);
      else next.add(poId);
      return next;
    });
  }

  // Party options for the filter combo, derived from the arrivals themselves.
  const partyOptions = useMemo(() => {
    const names = [...new Set((items ?? [])
      .map((s) => s.purchaseOrder?.party?.name)
      .filter((n): n is string => !!n))].sort();
    return [{ value: 'ALL', label: 'All parties' }, ...names.map((n) => ({ value: n, label: n }))];
  }, [items]);

  // Arrivals shown in the table, filtered by the status tabs and party combo, then
  // grouped under their logical order (per-lorry POs share a poGroupId) so each
  // order is one summary row that expands to its lorry invoices/weights. Stat
  // cards stay on the full data set; only the table is filtered.
  const visibleGroups = useMemo(() => {
    const map = new Map<string, { groupId: string; po: StockInRow['purchaseOrder']; rows: StockInRow[] }>();
    for (const s of items ?? []) {
      if (partyFilter !== 'ALL' && (s.purchaseOrder?.party?.name ?? '') !== partyFilter) continue;
      if (statusFilter === 'PURCHASED' && !s.purchase) continue;
      if (statusFilter === 'AWAITING' && s.purchase) continue;
      const key = s.purchaseOrder?.poGroupId ?? s.purchaseOrderId;
      if (!map.has(key)) map.set(key, { groupId: key, po: s.purchaseOrder, rows: [] });
      map.get(key)!.rows.push(s);
    }
    return [...map.values()];
  }, [items, partyFilter, statusFilter]);

  const filtersActive = statusFilter !== 'ALL' || partyFilter !== 'ALL';

  // Pending POs are the ones awaiting a stock-in.
  const { data: pendingPOs } = useQuery({
    queryKey: ['purchase-orders', 'PENDING'],
    queryFn: () => api<PurchaseOrder[]>('/purchase-orders?status=PENDING'),
  });

  const [poId, setPoId] = useState('');
  const [arrivalDate, setArrivalDate] = useState(new Date().toISOString().slice(0, 10));
  const [lorryNumber, setLorryNumber] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [rvpFirstWeightKg, setRvpFirstWeightKg] = useState('');
  const [billingWeightKg, setBillingWeightKg] = useState('');
  const [partyKataKg, setPartyKataKg] = useState('');
  const [loadingLocation, setLoadingLocation] = useState<'RVP' | 'PGR COLD' | 'Murugan' | 'KNM Multi'>('RVP');
  const [freight, setFreight] = useState('0');
  const [selfVehicle, setSelfVehicle] = useState(false);
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [extractingKind, setExtractingKind] = useState<DocKind | null>(null);
  // Vehicle (lorry) number read from each document, used to confirm the three
  // documents belong to the same lorry.
  const [docLorries, setDocLorries] = useState<Partial<Record<DocKind, string>>>({});

  /**
   * Find the pending PO an invoice belongs to, by supplier name (required) and
   * price (used to disambiguate when one party has several pending POs).
   */
  function matchPendingPo(
    matchedPartyName: string | undefined,
    partyName: string | undefined,
    pricePerKg?: number,
  ): { status: 'matched'; po: PurchaseOrder } | { status: 'ambiguous' | 'none' } {
    const pos = pendingPOs ?? [];
    if (pos.length === 0) return { status: 'none' };

    // Prefer Gemini's canonical match against our supplier list; fall back to a
    // loose comparison on the raw supplier name read off the invoice.
    const exactKey = matchedPartyName ? nameKey(matchedPartyName) : '';
    const looseKey = partyName ? nameKey(partyName) : '';

    let byName: PurchaseOrder[] = [];
    if (exactKey) byName = pos.filter((po) => nameKey(po.party?.name ?? '') === exactKey);
    if (byName.length === 0 && looseKey) {
      byName = pos.filter((po) => {
        const pk = nameKey(po.party?.name ?? '');
        return pk !== '' && (pk === looseKey || pk.includes(looseKey) || looseKey.includes(pk));
      });
    }

    if (byName.length === 0) return { status: 'none' };
    if (byName.length === 1) return { status: 'matched', po: byName[0] };

    // Several POs for this party. If they all carry the same price (e.g. per-lorry
    // POs of one order), any will do - take the first. Otherwise use the invoice
    // price to pick the closest.
    const prices = new Set(byName.map((po) => Number(po.pricePerKg)));
    if (prices.size === 1) return { status: 'matched', po: byName[0] };

    if (pricePerKg && pricePerKg > 0) {
      const sorted = [...byName].sort(
        (a, b) =>
          Math.abs(Number(a.pricePerKg) - pricePerKg) - Math.abs(Number(b.pricePerKg) - pricePerKg),
      );
      const best = sorted[0];
      const tolerance = Math.max(1, pricePerKg * 0.02); // ₹1 or 2% of rate
      if (Math.abs(Number(best.pricePerKg) - pricePerKg) <= tolerance) {
        return { status: 'matched', po: best };
      }
    }
    return { status: 'ambiguous' };
  }

  /** Read a dropped document with Gemini (scoped to its kind) and pre-fill. */
  async function extractDoc(file: File, kind: DocKind) {
    setExtractingKind(kind);
    try {
      const fd = new FormData();
      fd.append('invoice', file); // the extract endpoint reads the file field as "invoice"
      fd.append('kind', kind);
      const data = await api<Extracted>('/stock-in/extract', { method: 'POST', body: fd, multipart: true });

      const filled: string[] = [];
      if (data.invoiceNumber) { setInvoiceNumber(data.invoiceNumber); filled.push('invoice no'); }
      if (data.lorryNumber) {
        setLorryNumber(data.lorryNumber);
        const ln = data.lorryNumber.toUpperCase().replace(/\s+/g, '');
        setDocLorries((prev) => ({ ...prev, [kind]: ln }));
        filled.push('lorry no');
      }
      if (data.arrivalDate) { setArrivalDate(data.arrivalDate); filled.push('date'); }
      if (data.billingWeightKg) { setBillingWeightKg(String(data.billingWeightKg)); filled.push('billing weight'); }
      if (data.partyKataKg) { setPartyKataKg(String(data.partyKataKg)); filled.push('party kata'); }
      if (data.rvpFirstWeightKg) { setRvpFirstWeightKg(String(data.rvpFirstWeightKg)); filled.push('RVP first weight'); }

      // From the invoice, best-effort auto-match a pending PO by supplier - but
      // only as a convenience when the user hasn't already picked one. The PO
      // dropdown is the source of truth, so we never override a manual choice
      // and never warn on a miss (the user just picks it themselves).
      if (kind === 'invoice' && !poId && (data.matchedPartyName || data.partyName)) {
        const match = matchPendingPo(data.matchedPartyName, data.partyName, data.pricePerKg);
        if (match.status === 'matched') {
          setPoId(match.po.id);
          filled.push(`PO ${match.po.poNumber} (${match.po.party?.name})`);
        }
      }

      if (filled.length) toast.success(`AI filled: ${filled.join(', ')}. Please verify.`);
      else toast.message('Could not read this document. Enter the values manually.');
    } catch (e) {
      toast.error(getErrorMessage(e as Error));
    } finally {
      setExtractingKind(null);
    }
  }

  // Inward freight is only collected for BASE-priced POs (DELIVERY includes it).
  // On edit the PO is no longer pending, so fall back to the stock-in's own PO.
  const selectedPo = pendingPOs?.find((p) => p.id === poId);
  const priceType = editing?.purchaseOrder?.priceType ?? selectedPo?.priceType;
  const isBase = priceType === 'BASE';

  function resetForm() {
    setPoId('');
    setArrivalDate(new Date().toISOString().slice(0, 10));
    setLorryNumber('');
    setInvoiceNumber('');
    setRvpFirstWeightKg('');
    setBillingWeightKg('');
    setPartyKataKg('');
    setLoadingLocation('RVP');
    setFreight('0');
    setSelfVehicle(false);
    setInvoiceFile(null);
    setDocLorries({});
  }

  function openCreate() {
    setEditing(null);
    resetForm();
    setOpen(true);
  }

  function openEdit(s: StockInRow) {
    setEditing(s);
    setPoId(s.purchaseOrderId);
    setArrivalDate(s.arrivalDate.slice(0, 10));
    setLorryNumber(s.lorryNumber);
    setInvoiceNumber(s.invoiceNumber);
    setRvpFirstWeightKg(String(s.rvpFirstWeightKg));
    setBillingWeightKg(String(s.billingWeightKg));
    setPartyKataKg(String(s.partyKataKg));
    setLoadingLocation(s.loadingLocation ?? 'RVP');
    setFreight(String(s.freightCharge ?? 0));
    setSelfVehicle(s.selfVehicle ?? false);
    setInvoiceFile(null);
    setOpen(true);
  }

  const mutation = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append('purchaseOrderId', poId);
      fd.append('arrivalDate', arrivalDate);
      fd.append('lorryNumber', lorryNumber);
      fd.append('invoiceNumber', invoiceNumber);
      fd.append('rvpFirstWeightKg', rvpFirstWeightKg);
      fd.append('rvpSecondWeightKg', '0');
      fd.append('billingWeightKg', billingWeightKg);
      fd.append('partyKataKg', partyKataKg);
      fd.append('loadingLocation', loadingLocation);
      fd.append('freightCharge', isBase ? (freight || '0') : '0');
      fd.append('selfVehicle', selfVehicle ? 'true' : 'false');
      if (invoiceFile) fd.append('invoice', invoiceFile);

      const url = editing ? `/stock-in/${editing.id}` : '/stock-in';
      const method = editing ? 'PUT' : 'POST';
      return api(url, { method, body: fd, multipart: true });
    },
    onSuccess: () => {
      // Editing a purchased stock-in rolls back its purchase chain, so refresh
      // everything downstream too.
      ['stock-in', 'purchase-orders', 'purchases', 'verifications'].forEach(
        (k) => qc.invalidateQueries({ queryKey: [k] }),
      );
      toast.success(editing ? 'Stock-in updated' : 'Stock-in recorded');
      setOpen(false);
      resetForm();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/stock-in/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      ['stock-in', 'purchase-orders', 'purchases', 'verifications'].forEach(
        (k) => qc.invalidateQueries({ queryKey: [k] }),
      );
      toast.success('Stock-in deleted');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!poId) return toast.error('Select a purchase order');
    // REMOVED FOR TESTING: if (!invoiceFile && !editing) return toast.error('Attach the lorry invoice');
    if ((Number(rvpFirstWeightKg) || 0) <= 0) return toast.error('RVP first weight must be positive');
    mutation.mutate();
  }

  // Cross-check the lorry/vehicle number read from each uploaded document.
  const docLabel: Record<DocKind, string> = { partyKata: 'Party Kata', invoice: 'Invoice', rvpWeight: 'RVP Weight' };
  const detectedLorries = (Object.entries(docLorries) as [DocKind, string][]).filter(([, v]) => !!v);
  const detectedPlates = detectedLorries.map(([, v]) => v);
  // Use the most complete (longest) read as the reference; a partly-printed plate
  // on one document should still count as a match against the fuller one.
  const referencePlate = detectedPlates.reduce((a, b) => (b.length > a.length ? b : a), detectedPlates[0] ?? '');
  const vehicleMatched = detectedPlates.every((p) => platesCompatible(p, referencePlate));

  const allRows = items ?? [];
  const purchasedRows = allRows.filter((r) => r.purchase).length;

  return (
    <div className="space-y-8">
      <PageHeader
        icon={Truck}
        title="Stock In"
        description="RVP Kata weights and lorry invoice details captured on arrival, grouped per order."
        actions={
          <div className="flex gap-2">
            <Button onClick={() => setUrpOpen(true)} variant="secondary" className="gap-2">
              <Plus className="h-4 w-4" />
              Direct Inward (URP)
            </Button>
            <Button onClick={openCreate} className="gap-2">
              <Plus className="h-4 w-4" />
              Record Inward Lorry
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatCard label="Kata Entry" value={allRows.length} icon={Truck} tone="taupe" hint="arrivals unloaded" />
        <StatCard label="Inward" value={purchasedRows} icon={PackageCheck} tone="forest" hint={`of ${allRows.length} lorries`} />
        <StatCard label="Pending POs" value={pendingPOs?.length ?? 0} icon={Clock} tone="rose" hint="waiting arrival" />
      </div>

      {pendingPOs?.length === 0 && !editing && (
        <p className="-mt-4 text-sm text-muted-foreground">No pending purchase orders awaiting arrival.</p>
      )}

      <div className="glass rounded-2xl overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-border/70">
          <h2 className="text-sm font-semibold text-foreground">Arrivals</h2>
          <div className="flex flex-wrap items-center gap-2.5">
            <Segmented
              options={[
                { label: 'All', value: 'ALL' },
                { label: 'Awaiting', value: 'AWAITING' },
                { label: 'Purchased', value: 'PURCHASED' },
              ]}
              value={statusFilter}
              onValueChange={setStatusFilter}
              size="sm"
            />
            <Combobox
              options={partyOptions}
              value={partyFilter}
              onChange={setPartyFilter}
              placeholder="All parties"
              searchPlaceholder="Search party…"
              ariaLabel="Filter by party"
              className="w-52"
            />
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>PO / Arrival</TableHead>
              <TableHead>Party</TableHead>
              <TableHead>Invoice No</TableHead>
              <TableHead>Lorry</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-right">RVP First Wt</TableHead>
              <TableHead className="text-right">Billing</TableHead>
              <TableHead className="text-right">Party kata</TableHead>
              <TableHead className="text-right">Price/kg</TableHead>
              <TableHead>Invoice</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={11} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {!isLoading && visibleGroups.length === 0 && (
              <TableRow><TableCell colSpan={11} className="text-center text-muted-foreground">{filtersActive ? 'No arrivals match the filters.' : 'No stock-ins yet.'}</TableCell></TableRow>
            )}
            {visibleGroups.map(({ groupId, po, rows }) => {
              const isOpen = expanded.has(groupId);
              const totalRvp = rows.reduce((sum, r) => sum + r.rvpFirstWeightKg, 0);
              const totalBilling = rows.reduce((sum, r) => sum + r.billingWeightKg, 0);
              const totalParty = rows.reduce((sum, r) => sum + r.partyKataKg, 0);
              const purchasedCount = rows.filter((r) => r.purchase).length;
              const locations = [...new Set(rows.map((r) => r.loadingLocation))];
              const latestArrival = rows.reduce((d, r) => (r.arrivalDate > d ? r.arrivalDate : d), rows[0].arrivalDate);
              // PO-number range across the lorries in this order (e.g. DCS-001 – DCS-003)
              const poNums = rows.map((r) => r.purchaseOrder?.poNumber).filter(Boolean).sort() as string[];
              const poLabel = poNums.length === 0 ? '-' : poNums.length === 1 ? poNums[0] : `${poNums[0]} – ${poNums[poNums.length - 1]}`;

              return (
                <Fragment key={groupId}>
                  {/* Order summary row - click to expand the lorries underneath */}
                  <TableRow
                    className="cursor-pointer bg-muted/30 hover:bg-muted/50 font-medium"
                    onClick={() => toggleGroup(groupId)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {isOpen ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        )}
                        <div>
                          <span className="font-mono font-semibold">{poLabel}</span>
                          <span className="block text-[11px] font-normal text-muted-foreground">
                            latest {shortDate(latestArrival)}
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="font-semibold">{po?.party?.name ?? '-'}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{rows.length} {rows.length === 1 ? 'lorry' : 'lorries'}</Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-muted-foreground">{purchasedCount}/{rows.length} purchased</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {locations.map((l) => (
                          <Badge key={l} variant="outline" className="text-[10px]">{locationLabel(l)}</Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-semibold">{kg(totalRvp)}</TableCell>
                    <TableCell className="text-right">{kg(totalBilling)}</TableCell>
                    <TableCell className="text-right">{kg(totalParty)}</TableCell>
                    <TableCell className="text-right">
                      {po?.pricePerKg ? rupees(po.pricePerKg) : '-'}
                      {po?.priceType && <span className="block text-[10px] font-normal text-muted-foreground">{po.priceType === 'BASE' ? 'Base' : 'Delivery'}</span>}
                    </TableCell>
                    <TableCell />
                    <TableCell />
                  </TableRow>

                  {/* Individual lorry invoices for this PO */}
                  {isOpen && rows.map((s) => (
                    <TableRow key={s.id} className="bg-background">
                      <TableCell className="pl-10 text-muted-foreground">{shortDate(s.arrivalDate)}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{s.purchaseOrder?.poNumber ?? '-'}</TableCell>
                      <TableCell className="font-semibold">{s.invoiceNumber}</TableCell>
                      <TableCell>{s.lorryNumber}</TableCell>
                      <TableCell><Badge variant="outline">{locationLabel(s.loadingLocation)}</Badge></TableCell>
                      <TableCell className="text-right font-semibold">{kg(s.rvpFirstWeightKg)}</TableCell>
                      <TableCell className="text-right">{kg(s.billingWeightKg)}</TableCell>
                      <TableCell className="text-right">{kg(s.partyKataKg)}</TableCell>
                      <TableCell className="text-right">{s.purchaseOrder?.pricePerKg ? rupees(s.purchaseOrder.pricePerKg) : '-'}</TableCell>
                      <TableCell>
                        {s.invoiceFileUrl ? (
                          <a href={s.invoiceFileUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline text-sm">
                            <FileText className="h-3 w-3" /> View
                          </a>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            title={s.purchase ? 'Edit - this will roll back the recorded purchase' : 'Edit stock-in'}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (s.purchase && !confirm('This lorry has already been purchased' + (s.purchase.verification ? ' and verified' : '') + '. Editing will roll back the purchase (reverting inventory & ledger) and you\'ll need to re-record it. Continue?')) return;
                              openEdit(s);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title={s.purchase ? 'Delete - this will also roll back the recorded purchase' : 'Delete stock-in'}
                            onClick={(e) => {
                              e.stopPropagation();
                              const msg = s.purchase
                                ? 'This lorry has already been purchased' + (s.purchase.verification ? ' and verified' : '') + '. Deleting will also roll back the purchase (reverting inventory & ledger). Delete anyway?'
                                : 'Delete this stock-in record?';
                              if (confirm(msg)) deleteMutation.mutate(s.id);
                            }}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
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
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>{editing ? 'Edit Stock In' : 'Record Stock In'}</DialogTitle></DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label>Purchase order</Label>
              {editing ? (
                <>
                  <Input
                    disabled
                    value={`${editing.purchaseOrder?.poNumber ?? '-'} · ${editing.purchaseOrder?.party?.name ?? ''}${editing.purchaseOrder?.pricePerKg ? ` - ${rupees(editing.purchaseOrder.pricePerKg)}/kg` : ''}`}
                  />
                  {editing.purchase && (
                    <p className="text-[11px] text-amber-600">
                      Saving will roll back the recorded purchase{editing.purchase.verification ? ' & verification' : ''}; re-record it on the Purchases page afterward.
                    </p>
                  )}
                </>
              ) : (
                <Select value={poId} onValueChange={setPoId}>
                  <SelectTrigger><SelectValue placeholder="Select a pending PO" /></SelectTrigger>
                  <SelectContent>
                    {pendingPOs?.map((po) => (
                      <SelectItem key={po.id} value={po.id}>
                        {po.poNumber} · {po.party?.name} - {shortDate(po.poDate)} - {rupees(po.pricePerKg)}/kg
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* AI document drop zones */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <DropZone
                title="Party kata slip"
                hint="Drop party weighbridge slip"
                accept="application/pdf,image/*"
                busy={extractingKind === 'partyKata'}
                onPick={(f) => extractDoc(f, 'partyKata')}
              />
              <DropZone
                title="Invoice (saved)"
                hint="Drop lorry invoice"
                accept="application/pdf,image/*"
                busy={extractingKind === 'invoice'}
                onPick={(f) => { setInvoiceFile(f); extractDoc(f, 'invoice'); }}
              />
              <DropZone
                title="RVP first weight"
                hint="Drop RVP weighbridge slip"
                accept="application/pdf,image/*"
                busy={extractingKind === 'rvpWeight'}
                onPick={(f) => extractDoc(f, 'rvpWeight')}
              />
            </div>
            {invoiceFile && (
              <p className="text-xs text-muted-foreground">Invoice file to save: <span className="font-medium">{invoiceFile.name}</span></p>
            )}

            {detectedLorries.length > 0 && (
              <div className={`rounded-lg border p-3 text-xs ${vehicleMatched ? 'border-emerald-500/30 bg-emerald-50/40 dark:bg-emerald-950/10' : 'border-red-500/40 bg-red-50/40 dark:bg-red-950/10'}`}>
                <div className={`flex items-center gap-1.5 font-semibold ${vehicleMatched ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                  {vehicleMatched ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                  {vehicleMatched ? `Vehicle matched: ${referencePlate}` : 'Vehicle number mismatch across documents'}
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {(['partyKata', 'invoice', 'rvpWeight'] as DocKind[]).map((k) => (
                    <div key={k} className="flex flex-col">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{docLabel[k]}</span>
                      <span className={`font-mono font-medium ${docLorries[k] && !platesCompatible(docLorries[k]!, referencePlate) ? 'text-red-600' : ''}`}>{docLorries[k] ?? '-'}</span>
                    </div>
                  ))}
                </div>
                {!vehicleMatched && (
                  <p className="mt-1.5 text-[11px] text-red-600">These documents may belong to different lorries. Verify before saving.</p>
                )}
              </div>
            )}

             <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="arrivalDate">Arrival date</Label>
                <Input id="arrivalDate" type="date" value={arrivalDate} onChange={(e) => setArrivalDate(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lorry">Lorry number</Label>
                <Input id="lorry" value={lorryNumber} onChange={(e) => setLorryNumber(e.target.value)} placeholder="AP02AB1234" required />
              </div>
              <div className="space-y-2">
                <Label>Loading Location</Label>
                <Select value={loadingLocation} onValueChange={(v: any) => setLoadingLocation(v)}>
                  <SelectTrigger className="bg-card">
                    <SelectValue placeholder="Select location" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="RVP">RVP</SelectItem>
                    <SelectItem value="PGR COLD">PGR Cold</SelectItem>
                    <SelectItem value="Murugan">Murugan</SelectItem>
                    <SelectItem value="KNM Multi">KNM Multi</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="invoiceNum">Invoice number</Label>
                <Input id="invoiceNum" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="69" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="party">Party kata (kg)</Label>
                <Input id="party" type="number" value={partyKataKg} onChange={(e) => setPartyKataKg(e.target.value)} required />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="rvpFirst">RVP first weight (kg)</Label>
                <Input id="rvpFirst" type="number" value={rvpFirstWeightKg} onChange={(e) => setRvpFirstWeightKg(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="billing">Billing weight (kg)</Label>
                <Input id="billing" type="number" value={billingWeightKg} onChange={(e) => setBillingWeightKg(e.target.value)} required />
              </div>
            </div>

            <label className="flex items-start gap-2.5 rounded-lg border bg-muted/30 px-4 py-3 cursor-pointer hover:border-primary/50 transition-colors">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-input text-primary focus:ring-primary"
                checked={selfVehicle}
                onChange={(e) => setSelfVehicle(e.target.checked)}
              />
              <span className="text-sm">
                <span className="font-medium text-foreground">Self vehicle (party's own lorry)</span>
                <span className="block text-[11px] text-muted-foreground">
                  Deducts the ₹80/tonne lorry hamali from the party's net payable at verification.
                </span>
              </span>
            </label>

            {isBase && (
              <div className="space-y-2">
                <Label htmlFor="freight">Inward freight (₹) - base-priced PO</Label>
                <Input id="freight" type="number" step="0.01" value={freight} onChange={(e) => setFreight(e.target.value)} placeholder="freight to bring stock to our location" />
                <p className="text-[11px] text-muted-foreground">Captured here at arrival; carried into the purchase and posted to the purchase-freight ledger. DELIVERY-priced POs already include freight.</p>
              </div>
            )}

            <div className="rounded-lg border bg-muted/40 px-4 py-2 text-sm flex justify-between">
              <span className="text-muted-foreground">RVP First Weight (gross)</span>
              <span className={`font-semibold ${Number(rvpFirstWeightKg) > 0 ? '' : 'text-destructive'}`}>{Number(rvpFirstWeightKg) > 0 ? kg(Number(rvpFirstWeightKg)) : '-'}</span>
            </div>

            <DialogFooter>
              <Button type="submit" disabled={mutation.isPending || extractingKind !== null}>
                {mutation.isPending ? 'Saving…' : 'Save stock-in'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      
      <UrpStockInDialog open={urpOpen} onOpenChange={setUrpOpen} />
    </div>
  );
}
