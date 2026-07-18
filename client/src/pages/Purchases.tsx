import { useMemo, useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Scale, PackageCheck, Coins, Weight } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { Purchase, StockIn } from '@/lib/types';
import { calcHamali, calcKataFee, DEFAULT_HAMALI_RATE, isVehicleExempt } from '@/lib/calc';
import { kg, rupees, shortDate, toTonnes } from '@/lib/format';
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
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Segmented } from '@/components/ui/segmented';
import { Combobox } from '@/components/ui/combobox';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import type { CompanyProfile } from '@/lib/types';

type PurchaseRow = Purchase & {
  stockIn?: StockIn & { purchaseOrder?: { party?: { name: string }; poNumber?: string; pricePerKg?: string; priceType?: 'BASE' | 'DELIVERY' } };
};

const PURCHASE_EXPORT_COLUMNS: ExportColumn<PurchaseRow>[] = [
  { header: 'Date', value: (p) => shortDate(p.purchaseDate ?? p.createdAt) },
  { header: 'Party', value: (p) => p.stockIn?.purchaseOrder?.party?.name ?? '' },
  { header: 'PO No', value: (p) => p.stockIn?.purchaseOrder?.poNumber ?? '' },
  { header: 'Invoice No', value: (p) => p.stockIn?.invoiceNumber ?? '' },
  { header: 'Price/kg', value: (p) => (p.stockIn?.purchaseOrder?.pricePerKg ? rupees(p.stockIn.purchaseOrder.pricePerKg) : ''), excel: (p) => (p.stockIn?.purchaseOrder?.pricePerKg ? Number(p.stockIn.purchaseOrder.pricePerKg) : null), numFmt: '#,##0.00', align: 'right' },
  { header: 'Price Type', value: (p) => (p.stockIn?.purchaseOrder?.priceType === 'BASE' ? 'Base' : p.stockIn?.purchaseOrder?.priceType === 'DELIVERY' ? 'Delivery' : '') },
  { header: 'Net (RVP) kg', value: (p) => Number(p.netWeightKg || 0), numFmt: '#,##0', align: 'right' },
  { header: 'Hamali', value: (p) => rupees(p.hamaliCharge), excel: (p) => Number(p.hamaliCharge), numFmt: '#,##0.00', align: 'right' },
  { header: 'Kata Fee', value: (p) => rupees(p.kataFee), excel: (p) => Number(p.kataFee), numFmt: '#,##0.00', align: 'right' },
];
type StockInRow = StockIn & { purchaseOrder?: { party?: { name: string }; poNumber?: string; priceType?: 'BASE' | 'DELIVERY' }; purchase?: Purchase | null };

function PurchaseFormDialog({
  open,
  onOpenChange,
  editing,
  available,
  companyProfile,
  onSuccess
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: PurchaseRow | null;
  available: StockInRow[];
  companyProfile: CompanyProfile | undefined;
  onSuccess: () => void;
}) {
  const [stockInId, setStockInId] = useState('');
  const [rvpSecondWeight, setRvpSecondWeight] = useState('');
  const [hamaliRate, setHamaliRate] = useState(String(DEFAULT_HAMALI_RATE));
  const [purchaseDate, setPurchaseDate] = useState(new Date().toISOString().slice(0, 10));

  useEffect(() => {
    if (open) {
      if (editing) {
        setStockInId(editing.stockInId);
        setRvpSecondWeight(editing.stockIn ? String(editing.stockIn.rvpSecondWeightKg) : '');
        setHamaliRate(String(editing.hamaliRate));
        setPurchaseDate((editing.purchaseDate ?? editing.createdAt).slice(0, 10));
      } else {
        setStockInId('');
        setRvpSecondWeight('');
        setHamaliRate(String(DEFAULT_HAMALI_RATE));
        setPurchaseDate(new Date().toISOString().slice(0, 10));
      }
    }
  }, [open, editing]);

  const selected = available.find((s) => s.id === stockInId);
  const rvpFirst = editing ? (editing.stockIn?.rvpFirstWeightKg ?? 0) : (selected?.rvpFirstWeightKg ?? 0);
  const lorryNumber = editing ? editing.stockIn?.lorryNumber : selected?.lorryNumber;
  const isCompanyVehicle = isVehicleExempt(lorryNumber, companyProfile?.companyVehicles);

  const isDirectNet = (editing ? editing.stockIn?.directNet : selected?.directNet) ?? false;
  const net = isDirectNet ? rvpFirst : rvpFirst - (Number(rvpSecondWeight) || 0);
  const rate = Number(hamaliRate) || 0;
  const netValid = isDirectNet ? net > 0 : (net > 0 && (Number(rvpSecondWeight) || 0) > 0);
  const hamali = netValid ? calcHamali(net, rate, isCompanyVehicle) : 0;
  const kataFeeVal = netValid ? calcKataFee(net, isCompanyVehicle) : 0;

  const priceType = editing ? editing.stockIn?.purchaseOrder?.priceType : selected?.purchaseOrder?.priceType;
  const isBase = priceType === 'BASE';
  const freightVal = isBase ? Number((editing ? editing.stockIn?.freightCharge : selected?.freightCharge) ?? 0) : 0;

  const mutation = useMutation({
    mutationFn: () => {
      const url = editing ? `/purchases/${editing.id}` : '/purchases';
      const method = editing ? 'PUT' : 'POST';
      const body = editing
        ? { stockInId: editing.stockInId, rvpSecondWeightKg: Number(rvpSecondWeight), hamaliRate: rate, purchaseDate }
        : { stockInId, rvpSecondWeightKg: Number(rvpSecondWeight), hamaliRate: rate, purchaseDate };
      return api<PurchaseRow>(url, { method, body });
    },
    onSuccess: () => {
      onSuccess();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md flex flex-col max-h-[90vh]">
        <DialogHeader><DialogTitle>{editing ? 'Edit Purchase' : 'Record Purchase'}</DialogTitle></DialogHeader>
        <div className="space-y-4 overflow-y-auto flex-1 min-h-0 pr-1">
            {editing ? (
            <div className="space-y-2">
              <Label>Stock-in</Label>
              <Input
                disabled
                value={`${editing.stockIn?.purchaseOrder?.poNumber} · ${editing.stockIn?.purchaseOrder?.party?.name} - Inv ${editing.stockIn?.invoiceNumber}`}
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label>Stock-in (awaiting purchase record)</Label>
              <Select value={stockInId} onValueChange={setStockInId}>
                  <SelectTrigger className="w-full min-w-0 overflow-hidden [&>span]:truncate [&>span]:block [&>span]:flex-1"><SelectValue placeholder="Select a stock-in" /></SelectTrigger>
                <SelectContent className="max-w-[90vw] sm:max-w-md">
                  {available.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.purchaseOrder?.poNumber} · {s.purchaseOrder?.party?.name} - Inv {s.invoiceNumber} (Lorry {s.lorryNumber}) · First Weight {kg(s.rvpFirstWeightKg)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          
          <div className="space-y-2">
            <Label htmlFor="purchaseDate">Purchase date</Label>
            <Input id="purchaseDate" type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} required />
          </div>

          {!isDirectNet && (
            <div className="space-y-2">
              <Label htmlFor="rvpSecond">RVP second weight / tare (kg)</Label>
              <Input id="rvpSecond" type="number" value={rvpSecondWeight} onChange={(e) => setRvpSecondWeight(e.target.value)} placeholder="e.g. 9500" required />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="rate">Hamali rate (₹/tonne)</Label>
            <Input id="rate" type="number" step="0.01" value={hamaliRate} onChange={(e) => setHamaliRate(e.target.value)} />
          </div>

          {isBase && (
            <p className="text-xs text-muted-foreground">
              Inward freight {freightVal > 0 ? <span className="font-medium">{rupees(freightVal)}</span> : 'is'} captured at Stock In (base-priced PO){freightVal > 0 ? '' : ' - none entered'}; it's capitalised into the seed and tracked in the Purchase Freight ledger.
            </p>
          )}

            <div className="rounded-lg border bg-muted/40 p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">RVP First Weight (gross)</span>
              <span className="font-medium">{rvpFirst > 0 ? kg(rvpFirst) : '-'}</span>
            </div>
            {!isDirectNet && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">RVP Second Weight (tare)</span>
                <span className="font-medium">{Number(rvpSecondWeight) > 0 ? kg(Number(rvpSecondWeight)) : '-'}</span>
              </div>
            )}
            <div className="flex justify-between border-t pt-2">
              <span className="text-muted-foreground font-semibold">RVP Net Weight</span>
              <span className={`font-bold ${netValid ? 'text-primary' : 'text-destructive'}`}>{netValid ? kg(net) : '-'}</span>
            </div>
            <div className="flex justify-between border-t pt-2">
              <span className="text-muted-foreground">Hamali = rounded(net/1000) × rate</span>
              <span className="font-semibold text-right">
                {isCompanyVehicle ? (
                  <span className="text-emerald-600 dark:text-emerald-400 text-xs">Exempted<br />{rupees(0)}</span>
                ) : (
                  netValid ? rupees(hamali) : '-'
                )}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Kata Fee (weighbridge)</span>
              <span className="font-semibold text-right">
                {isCompanyVehicle ? (
                  <span className="text-emerald-600 dark:text-emerald-400 text-xs">Exempted<br />{rupees(0)}</span>
                ) : (
                  netValid ? rupees(kataFeeVal) : '-'
                )}
              </span>
            </div>

            {isBase && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Inward freight (base price)</span>
                <span className="font-semibold">{freightVal > 0 ? rupees(freightVal) : '-'}</span>
              </div>
            )}
            <p className="text-xs text-muted-foreground pt-1 border-t mt-1">
              Saves the purchase with net weight, hamali, kata fee{isBase ? ', and inward freight' : ''}. Run weight verification afterwards on the Verification page.
            </p>
          </div>

          <DialogFooter>
            <Button onClick={() => mutation.mutate()} disabled={(!editing && !stockInId) || !netValid || mutation.isPending}>
              {mutation.isPending ? 'Saving…' : 'Save purchase'}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function Purchases() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PurchaseRow | null>(null);
  const [priceFilter, setPriceFilter] = useState<'ALL' | 'BASE' | 'DELIVERY'>('ALL');
  const [partyFilter, setPartyFilter] = useState('ALL');

  const { data: items, isLoading } = useQuery({
    queryKey: ['purchases'],
    queryFn: () => api<PurchaseRow[]>('/purchases?all=true'),
  });

  const { data: stockIns } = useQuery({
    queryKey: ['stock-in'],
    queryFn: () => api<StockInRow[]>('/stock-in'),
  });
  
  const { data: companyProfile } = useQuery({
    queryKey: ['company'],
    queryFn: () => api<CompanyProfile>('/settings/company'),
  });
  
  const available = useMemo(() => stockIns?.filter((s) => !s.purchase) ?? [], [stockIns]);

  const resetForm = useCallback(() => {
    setEditing(null);
  }, []);

  const openEdit = useCallback((p: PurchaseRow) => {
    setEditing(p);
    setOpen(true);
  }, []);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/purchases/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchases'] });
      qc.invalidateQueries({ queryKey: ['stock-in'] });
      toast.success('Purchase record deleted');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const { totalNet, totalHamali, totalKata } = useMemo(() => ({
    totalNet: items?.reduce((s, p) => s + Number(p.netWeightKg || 0), 0) ?? 0,
    totalHamali: items?.reduce((s, p) => s + Number(p.hamaliCharge || 0), 0) ?? 0,
    totalKata: items?.reduce((s, p) => s + Number(p.kataFee || 0), 0) ?? 0,
  }), [items]);

  // Party options for the filter combo, derived from the purchase records.
  const partyOptions = useMemo(() => {
    const names = [...new Set((items ?? [])
      .map((p) => p.stockIn?.purchaseOrder?.party?.name)
      .filter((n): n is string => !!n))].sort();
    return [{ value: 'ALL', label: 'All parties' }, ...names.map((n) => ({ value: n, label: n }))];
  }, [items]);

  // Rows shown after the price-type tabs and party combo. Stat cards use the full set.
  const filtered = useMemo(() => (items ?? []).filter((p) => {
    if (partyFilter !== 'ALL' && (p.stockIn?.purchaseOrder?.party?.name ?? '') !== partyFilter) return false;
    if (priceFilter !== 'ALL' && (p.stockIn?.purchaseOrder?.priceType ?? '') !== priceFilter) return false;
    return true;
  }), [items, partyFilter, priceFilter]);
  const filtersActive = priceFilter !== 'ALL' || partyFilter !== 'ALL';

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows } = usePagedRows(filtered, 50);

  return (
    <div className="space-y-8">
      <PageHeader
        icon={Scale}
        title="Stock in Detail"
        description="Record purchases from stock-ins and set the hamali rate. Weight verification is done on the Verification page."
        actions={
          <>
            <ExportButtons
              filename="Purchases"
              title="Purchase Records"
              subtitle={`${filtered.length} record(s)`}
              columns={PURCHASE_EXPORT_COLUMNS}
              rows={filtered}
            />
            <Button onClick={() => { resetForm(); setOpen(true); }} disabled={!available.length}>
              <Plus className="h-4 w-4" /> Record Purchase
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 stagger">
        <StatCard label="Unloaded" value={items?.length ?? 0} icon={PackageCheck} tone="taupe" hint="purchase records" />
        <StatCard label="Waiting" value={available.length} icon={Scale} tone="amber" hint="stock-ins to record" />
        <StatCard label="Net weight" value={`${toTonnes(totalNet).toFixed(2)} MT`} icon={Weight} tone="forest" hint="across purchases" />
        <StatCard label="Hamali" value={rupees(totalHamali)} icon={Coins} tone="clay" hint="total hamali" />
        <StatCard label="Kata" value={rupees(totalKata)} icon={Coins} tone="clay" hint="total kata fee" />
      </div>

      {useMemo(() => (
      <div className="glass rounded-2xl overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-border/70">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">Purchase records</h2>
            {available.length > 0 && (
              <Badge variant="warning">{available.length} awaiting</Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <Segmented
              options={[
                { label: 'All', value: 'ALL' },
                { label: 'Base', value: 'BASE' },
                { label: 'Delivery', value: 'DELIVERY' },
              ]}
              value={priceFilter}
              onValueChange={setPriceFilter}
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
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Party</TableHead>
                <TableHead>Invoice No</TableHead>
                <TableHead className="text-right">Price/kg</TableHead>
                <TableHead className="text-right">Net (RVP)</TableHead>
                <TableHead className="text-right">Hamali</TableHead>
                <TableHead className="text-right">Kata Fee</TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={8} className="h-24 text-center text-muted-foreground">Loading…</TableCell></TableRow>
              )}
              {!isLoading && filtered.length === 0 && (
                <TableRow><TableCell colSpan={8} className="h-28 text-center text-muted-foreground">{filtersActive ? 'No purchases match the filters.' : 'No purchases yet.'}</TableCell></TableRow>
              )}
              {(pageRows ?? []).map((p) => (
                <TableRow key={p.id} className="group">
                  <TableCell className="text-muted-foreground">{shortDate(p.purchaseDate ?? p.createdAt)}</TableCell>
                  <TableCell className="font-medium text-foreground">
                    {p.stockIn?.purchaseOrder?.party?.name ?? '-'}
                    {p.stockIn?.purchaseOrder?.poNumber && (
                      <span className="ml-2 text-xs text-muted-foreground tracking-tight tabular-nums">({p.stockIn.purchaseOrder.poNumber})</span>
                    )}
                  </TableCell>
                  <TableCell><span className="text-xs font-semibold tracking-tight tabular-nums">{p.stockIn?.invoiceNumber ?? '-'}</span></TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.stockIn?.purchaseOrder?.pricePerKg ? rupees(p.stockIn.purchaseOrder.pricePerKg) : '-'}
                    {p.stockIn?.purchaseOrder?.priceType && (
                      <span className="block text-[10px] text-muted-foreground">{p.stockIn.purchaseOrder.priceType === 'BASE' ? 'Base' : 'Delivery'}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{kg(p.netWeightKg)}</TableCell>
                  <TableCell className="text-right tabular-nums">{rupees(p.hamaliCharge)}</TableCell>
                  <TableCell className="text-right tabular-nums">{rupees(p.kataFee)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                      <Button variant="ghost" size="icon-sm" onClick={() => openEdit(p)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => {
                          if (confirm('Delete this purchase record? This will release the Stock-In for re-purchase.')) {
                            deleteMutation.mutate(p.id);
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
      </div>
      ), [pageRows, isLoading, filtersActive, deleteMutation.mutate, openEdit, partyOptions, priceFilter, partyFilter, available.length, page, setPage, pageSize, setPageSize, totalPages, total])}

      {open && <PurchaseFormDialog 
        open={open} 
        onOpenChange={setOpen} 
        editing={editing} 
        available={available}
        companyProfile={companyProfile}
        onSuccess={() => {
          qc.invalidateQueries({ queryKey: ['purchases'] });
          qc.invalidateQueries({ queryKey: ['stock-in'] });
          toast.success(editing ? 'Purchase updated' : 'Purchase recorded');
          setOpen(false);
          setEditing(null);
        }}
      />}
    </div>
  );
}
