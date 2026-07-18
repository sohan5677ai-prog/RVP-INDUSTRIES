import React, { Fragment, useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, FileText, Pencil, Trash2, Sparkles, Loader2, UploadCloud, ChevronDown, ChevronRight, Truck, PackageCheck, Clock } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { PurchaseOrder, StockIn as StockInType } from '@/lib/types';
import { kg, rupees, shortDate } from '@/lib/format';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { usePagedRows } from '@/lib/usePagedRows';
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
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';

type StockInRow = StockInType;
type DocKind = 'invoice';

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

const STOCKIN_EXPORT_COLUMNS: ExportColumn<StockInRow>[] = [
  { header: 'PO Number', value: (s) => s.purchaseOrder?.poNumber ?? '' },
  { header: 'Arrival Date', value: (s) => (s.arrivalDate ? shortDate(s.arrivalDate) : shortDate(s.createdAt)) },
  { header: 'Party', value: (s) => s.purchaseOrder?.party?.name ?? '' },
  { header: 'Invoice No', value: (s) => s.invoiceNumber ?? '' },
  { header: 'Lorry', value: (s) => s.lorryNumber ?? '' },
  { header: 'Location', value: (s) => locationLabel(s.loadingLocation ?? '') },
  { header: 'RVP First Wt (kg)', value: (s) => s.rvpFirstWeightKg ?? 0, numFmt: '#,##0', align: 'right' },
  { header: 'Billing (kg)', value: (s) => s.billingWeightKg ?? 0, numFmt: '#,##0', align: 'right' },
  { header: 'Party Kata (kg)', value: (s) => s.partyKataKg ?? 0, numFmt: '#,##0', align: 'right' },
  { header: 'Price/kg', value: (s) => (s.purchaseOrder?.pricePerKg ? rupees(s.purchaseOrder.pricePerKg) : ''), excel: (s) => (s.purchaseOrder?.pricePerKg ? Number(s.purchaseOrder.pricePerKg) : null), numFmt: '#,##0.00', align: 'right' },
  { header: 'Purchased', value: (s) => (s.purchase ? 'Yes' : 'Awaiting') },
];

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


function StockInFormDialog({
  open,
  onOpenChange,
  editing,
  pendingPOs,
  onSuccess
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: StockInRow | null;
  pendingPOs: PurchaseOrder[] | undefined;
  onSuccess: () => void;
}) {
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

  const [sharedFreight, setSharedFreight] = useState(false);
  const [totalLorryFreight, setTotalLorryFreight] = useState('');
  const [totalLorryWeight, setTotalLorryWeight] = useState('');

  useEffect(() => {
    if (open) {
      if (editing) {
        setPoId(editing.purchaseOrderId);
        setArrivalDate(editing.arrivalDate.slice(0, 10));
        setLorryNumber(editing.lorryNumber);
        setInvoiceNumber(editing.invoiceNumber);
        setRvpFirstWeightKg(String(editing.rvpFirstWeightKg));
        setBillingWeightKg(String(editing.billingWeightKg));
        setPartyKataKg(String(editing.partyKataKg));
        setLoadingLocation((editing.loadingLocation as any) ?? 'RVP');
        setFreight(String(editing.freightCharge ?? 0));
        setSelfVehicle(editing.selfVehicle ?? false);
        setInvoiceFile(null);
        setSharedFreight(false);
        setTotalLorryFreight('');
        setTotalLorryWeight('');
      } else {
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
        setSharedFreight(false);
        setTotalLorryFreight('');
        setTotalLorryWeight('');
      }
    }
  }, [open, editing]);

  const poOptions = useMemo(() => {
    return (pendingPOs ?? []).map((po) => ({
      value: po.id,
      label: `${po.poNumber} · ${po.party?.name} - ${shortDate(po.poDate)} - ${rupees(po.pricePerKg)}/kg`,
    }));
  }, [pendingPOs]);

  const computedProratedFreight = useMemo(() => {
    if (!sharedFreight || !totalLorryFreight || !totalLorryWeight || !rvpFirstWeightKg) return '0';
    const tf = Number(totalLorryFreight);
    const tw = Number(totalLorryWeight);
    const rvw = Number(rvpFirstWeightKg);
    if (tw <= 0) return '0';
    return (Math.round((tf * (rvw / tw)) * 100) / 100).toFixed(2);
  }, [sharedFreight, totalLorryFreight, totalLorryWeight, rvpFirstWeightKg]);

  function matchPendingPo(
    matchedPartyName: string | undefined,
    partyName: string | undefined,
    pricePerKg?: number,
  ): { status: 'matched'; po: PurchaseOrder } | { status: 'ambiguous' | 'none' } {
    const pos = pendingPOs ?? [];
    if (pos.length === 0) return { status: 'none' };

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

    const prices = new Set(byName.map((po) => Number(po.pricePerKg)));
    if (prices.size === 1) return { status: 'matched', po: byName[0] };

    if (pricePerKg && pricePerKg > 0) {
      const sorted = [...byName].sort(
        (a, b) =>
          Math.abs(Number(a.pricePerKg) - pricePerKg) - Math.abs(Number(b.pricePerKg) - pricePerKg),
      );
      const best = sorted[0];
      const tolerance = Math.max(1, pricePerKg * 0.02);
      if (Math.abs(Number(best.pricePerKg) - pricePerKg) <= tolerance) {
        return { status: 'matched', po: best };
      }
    }
    return { status: 'ambiguous' };
  }

  async function extractDoc(file: File, kind: DocKind) {
    setExtractingKind(kind);
    try {
      const fd = new FormData();
      fd.append('invoice', file);
      fd.append('kind', kind);
      const data = await api<Extracted>('/stock-in/extract', { method: 'POST', body: fd, multipart: true });

      const filled: string[] = [];
      if (data.invoiceNumber) { setInvoiceNumber(data.invoiceNumber); filled.push('invoice no'); }
      if (data.lorryNumber) {
        setLorryNumber(data.lorryNumber);
        filled.push('lorry no');
      }
      if (data.arrivalDate) { setArrivalDate(data.arrivalDate); filled.push('date'); }
      if (data.billingWeightKg) { setBillingWeightKg(String(data.billingWeightKg)); filled.push('billing weight'); }
      if (data.partyKataKg) { setPartyKataKg(String(data.partyKataKg)); filled.push('party kata'); }
      if (data.rvpFirstWeightKg) { setRvpFirstWeightKg(String(data.rvpFirstWeightKg)); filled.push('RVP first weight'); }

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

  const selectedPo = pendingPOs?.find((p) => p.id === poId);
  const priceType = editing?.purchaseOrder?.priceType ?? selectedPo?.priceType;
  const isBase = priceType === 'BASE';

  // Earliest arrival the picker/guard will accept: the PO's own date. A same-day
  // arrival is fine, but an arrival before the order was placed is not.
  const poDateMin = (editing?.purchaseOrder?.poDate ?? selectedPo?.poDate)?.slice(0, 10);

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
      const finalFreight = isBase ? (sharedFreight ? computedProratedFreight : (freight || '0')) : '0';
      fd.append('freightCharge', finalFreight);
      fd.append('selfVehicle', selfVehicle ? 'true' : 'false');
      if (invoiceFile) fd.append('invoice', invoiceFile);

      const url = editing ? `/stock-in/${editing.id}` : '/stock-in';
      const method = editing ? 'PUT' : 'POST';
      return api(url, { method, body: fd, multipart: true });
    },
    onSuccess: () => {
      onSuccess();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!poId) return toast.error('Select a purchase order');
    if (poDateMin && arrivalDate < poDateMin) {
      return toast.error('Arrival date cannot be before the purchase order date');
    }
    if ((Number(rvpFirstWeightKg) || 0) <= 0) return toast.error('RVP first weight must be positive');
    mutation.mutate();
  }

  return (
<Dialog open={open} onOpenChange={onOpenChange}>
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
                <Combobox
                  options={poOptions}
                  value={poId}
                  onChange={setPoId}
                  placeholder="Select a pending PO"
                  searchPlaceholder="Search POs..."
                  className="w-full"
                />
              )}
            </div>

            {/* AI document drop zone */}
            <DropZone
              title="Invoice (saved)"
              hint="Drop lorry invoice"
              accept="application/pdf,image/*"
              busy={extractingKind === 'invoice'}
              onPick={(f) => { setInvoiceFile(f); extractDoc(f, 'invoice'); }}
            />
            {invoiceFile && (
              <p className="text-xs text-muted-foreground">Invoice file to save: <span className="font-medium">{invoiceFile.name}</span></p>
            )}

             <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="arrivalDate">Arrival date</Label>
                <Input id="arrivalDate" type="date" value={arrivalDate} min={poDateMin} onChange={(e) => setArrivalDate(e.target.value)} required />
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
  );
}




const StockInGroupRow = React.memo(({
  groupId, po, rows, isOpen, toggleGroup, openEdit, deleteMutationMutate
}: any) => {
  const totalRvp = rows.reduce((sum: number, r: any) => sum + r.rvpFirstWeightKg, 0);
  const totalBilling = rows.reduce((sum: number, r: any) => sum + r.billingWeightKg, 0);
  const totalParty = rows.reduce((sum: number, r: any) => sum + r.partyKataKg, 0);
  const purchasedCount = rows.filter((r: any) => r.purchase).length;
  const locations = [...new Set(rows.map((r: any) => r.loadingLocation))];
  const latestArrival = rows.reduce((d: any, r: any) => (r.arrivalDate > d ? r.arrivalDate : d), rows[0].arrivalDate);
  const poNums = rows.map((r: any) => r.purchaseOrder?.poNumber).filter(Boolean).sort() as string[];
  const poLabel = poNums.length === 0 ? '-' : poNums.length === 1 ? poNums[0] : `${poNums[0]} – ${poNums[poNums.length - 1]}`;

  return (
    <Fragment>
      <TableRow
        className={`cursor-pointer font-medium transition-colors ${isOpen ? 'bg-secondary hover:bg-secondary border-b-0' : 'bg-muted/30 hover:bg-muted/50'}`}
        onClick={() => toggleGroup(groupId)}
      >
        <TableCell className={isOpen ? 'shadow-[inset_3px_0_0_0_var(--primary)]' : undefined}>
          <div className="flex items-center gap-2">
            {isOpen ? (
              <ChevronDown className="h-4 w-4 text-primary" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <div>
              <span className="font-semibold tracking-tight tabular-nums">{poLabel}</span>
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
            {locations.map((l: any) => (
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
      {isOpen && rows.map((s: any, idx: number) => (
        <TableRow key={s.id} className={`bg-accent/60 hover:bg-accent ${idx === rows.length - 1 ? 'border-b-2 border-border' : 'border-b border-border/60'}`}>
          <TableCell className="pl-12 text-sm text-muted-foreground shadow-[inset_3px_0_0_0_var(--primary)]">{shortDate(s.arrivalDate)}</TableCell>
          <TableCell className="text-xs text-muted-foreground tracking-tight tabular-nums">{s.purchaseOrder?.poNumber ?? '-'}</TableCell>
          <TableCell className="font-semibold tracking-tight tabular-nums">{s.invoiceNumber}</TableCell>
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
                onClick={(e: any) => {
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
                onClick={(e: any) => {
                  e.stopPropagation();
                  const msg = s.purchase
                    ? 'This lorry has already been purchased' + (s.purchase.verification ? ' and verified' : '') + '. Deleting will also roll back the purchase (reverting inventory & ledger). Delete anyway?'
                    : 'Delete this stock-in record?';
                  if (confirm(msg)) deleteMutationMutate(s.id);
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
});

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

  const toggleGroup = useCallback((poId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(poId)) next.delete(poId);
      else next.add(poId);
      return next;
    });
  }, []);

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

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows } = usePagedRows(visibleGroups, 50);

  // Pending POs are the ones awaiting a stock-in.
  const { data: pendingPOs } = useQuery({
    queryKey: ['purchase-orders', 'PENDING'],
    queryFn: () => api<PurchaseOrder[]>('/purchase-orders?status=PENDING&all=true'),
  });

  const openCreate = useCallback(() => {
    setEditing(null);
    setOpen(true);
  }, []);

  const openEdit = useCallback((s: StockInRow) => {
    setEditing(s);
    setOpen(true);
  }, []);

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
            <ExportButtons
              filename="Stock_In"
              title="Stock In (Arrivals)"
              subtitle={`${visibleGroups.reduce((n, g) => n + g.rows.length, 0)} arrival(s)`}
              columns={STOCKIN_EXPORT_COLUMNS}
              rows={visibleGroups.flatMap((g) => g.rows)}
            />
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
            {(pageRows ?? []).map(({ groupId, po, rows }) => (
              <StockInGroupRow
                key={groupId}
                groupId={groupId}
                po={po}
                rows={rows}
                isOpen={expanded.has(groupId)}
                toggleGroup={toggleGroup}
                openEdit={openEdit}
                deleteMutationMutate={deleteMutation.mutate}
              />
            ))}
          </TableBody>
        </Table>
        <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
      </div>

      
      {open && <StockInFormDialog 
        open={open} 
        onOpenChange={setOpen} 
        editing={editing} 
        pendingPOs={pendingPOs}
        onSuccess={() => {
          ['stock-in', 'purchase-orders', 'purchases', 'verifications'].forEach(
            (k) => qc.invalidateQueries({ queryKey: [k] }),
          );
          toast.success(editing ? 'Stock-in updated' : 'Stock-in recorded');
          setOpen(false);
          setEditing(null);
        }}
      />}

      
      {urpOpen && <UrpStockInDialog open={urpOpen} onOpenChange={setUrpOpen} />}
    </div>
  );
}
