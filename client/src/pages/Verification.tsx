import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ReceiptText, BadgeCheck, RotateCcw, ShieldCheck, Scale, Calculator, Clock } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { CompanyProfile, Purchase, WeightVerification } from '@/lib/types';
import { kg, rupees, shortDate } from '@/lib/format';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { usePagedRows } from '@/lib/usePagedRows';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Segmented } from '@/components/ui/segmented';
import { Combobox } from '@/components/ui/combobox';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import {
  crossVerify,
  hamaliSplit,
  isVehicleExempt,
  computeQualityAdjustments,
  QUALITY_ADJUSTMENT_LABELS,
  type QualityAdjustmentMode,
} from '@/lib/calc';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';

type PurchaseRow = Purchase & {
  verification?: WeightVerification | null;
  stockIn?: {
    invoiceNumber?: string;
    lorryNumber?: string | null;
    billingWeightKg?: number;
    partyKataKg?: number;
    selfVehicle?: boolean;
    purchaseOrder?: { poNumber?: string; pricePerKg?: string; hasGst?: boolean; party?: { name: string } };
  };
};

/** One editable row of the Quality Adjustments list (values stay strings while typing). */
type AdjustmentDraft = { mode: QualityAdjustmentMode; label: string; value: string };

const ADJUSTMENT_MODES: QualityAdjustmentMode[] = ['WEIGHT', 'PRICE', 'AMOUNT', 'EXPENSE', 'FREIGHT'];

/** Unit suffix shown against a row's value input. */
function unitOf(mode: QualityAdjustmentMode) {
  return mode === 'WEIGHT' ? '(kg)' : mode === 'PRICE' ? '(₹/kg)' : '(₹)';
}

function getCalculationDetails(p: PurchaseRow) {
  if (!p.stockIn || !p.stockIn.purchaseOrder) return null;
  
  const billingWeightKg = p.verification ? p.verification.billingWeightKg : (p.stockIn.billingWeightKg ?? 0);
  const partyKataKg = p.verification ? p.verification.partyKataKg : (p.stockIn.partyKataKg ?? 0);
  const rvpKataKg = p.verification ? p.verification.rvpKataKg : p.netWeightKg;
  const pricePerKg = p.verification ? Number(p.verification.pricePerKg) : (Number(p.stockIn.purchaseOrder.pricePerKg) || 0);

  const { reference, diff, exempt, finalWeight } = crossVerify(
    billingWeightKg,
    partyKataKg,
    rvpKataKg
  );

  const hasPenalty = finalWeight < reference;
  const displayBaseWeightKg = hasPenalty ? reference : finalWeight;
  const baseCost = displayBaseWeightKg * pricePerKg;
  
  // GST is charged on the invoice billing amount (billing weight x price), not
  // on our recalculated payable - and ONLY when the PO/URP was flagged as a GST
  // invoice (hasGst). No tick = no GST.
  const hasGst = p.stockIn.purchaseOrder.hasGst ?? false;
  const billingAmount = billingWeightKg * pricePerKg;
  const igst = hasGst ? billingAmount * 0.05 : 0;

  const kataDiffDeduction = hasPenalty ? (reference - finalWeight) * pricePerKg : 0;

  // Self-vehicle: recover the lorry's ₹80/t hamali share from the party by
  // deducting it from their net payable (the seed cost is unaffected).
  const selfVehicle = p.stockIn.selfVehicle ?? false;
  const selfVehicleHamali = selfVehicle ? hamaliSplit(Number(p.hamaliCharge ?? 0)).lorry : 0;

  // Self-vehicle: also recover the full weighbridge/kata fee from the party.
  const selfVehicleKata = selfVehicle ? Number(p.kataFee ?? 0) : 0;

  const totalAmount = baseCost - kataDiffDeduction + igst - selfVehicleHamali - selfVehicleKata;

  return {
    billingWeightKg,
    partyKataKg,
    rvpKataKg,
    referenceKg: reference,
    diffKg: diff,
    exempt,
    finalWeightKg: finalWeight,
    displayBaseWeightKg,
    pricePerKg,
    hasGst,
    baseCost,
    billingAmount,
    igst,
    kataDiffDeduction,
    selfVehicle,
    selfVehicleHamali,
    selfVehicleKata,
    totalAmount,
  };
}

export default function Verification() {
  const qc = useQueryClient();
  const [selectedPurchase, setSelectedPurchase] = useState<PurchaseRow | null>(null);
  const [open, setOpen] = useState(false);
  const [forceExempt, setForceExempt] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'PENDING' | 'APPROVED'>('ALL');
  const [partyFilter, setPartyFilter] = useState('ALL');

  // Quality adjustments: any number of deduction rows off the party's payable
  // (weight/price/flat quality cuts, recovered expenses, lorry freight).
  const [adjustments, setAdjustments] = useState<AdjustmentDraft[]>([]);

  // Bill addables: extra costs added on top of the seed value (loading,
  // brokerage, misc). Each row is a label + rupee amount.
  const [addables, setAddables] = useState<{ label: string; amount: string }[]>([]);

  const { data: purchases, isLoading } = useQuery({
    queryKey: ['purchases'],
    queryFn: () => api<PurchaseRow[]>('/purchases?all=true'),
  });
  // Company vehicle list - decides whether a FREIGHT row lands on the KNM
  // Freight tab or the Inward (Purchases) tab of Freight Dues.
  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: () => api<CompanyProfile>('/settings/company'),
  });

  const verifyMutation = useMutation({
    mutationFn: (args: {
      purchaseId: string;
      forceExempt: boolean;
      billAddables?: { label: string; amount: number }[];
      qualityAdjustments?: { mode: QualityAdjustmentMode; label: string; value: number }[];
    }) => api('/verifications', { method: 'POST', body: args }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchases'] });
      qc.invalidateQueries({ queryKey: ['verifications'] });
      toast.success('Approved - balance payable calculated and black seed added to stock');
      setOpen(false);
      setSelectedPurchase(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const unverifyMutation = useMutation({
    mutationFn: (verificationId: string) =>
      api(`/verifications/${verificationId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchases'] });
      qc.invalidateQueries({ queryKey: ['verifications'] });
      toast.success('Verification removed - you can re-verify');
      setOpen(false);
      setSelectedPurchase(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function openVerify(p: PurchaseRow) {
    setSelectedPurchase(p);
    // A verified purchase renders its stored rows read-only, so the draft list
    // only ever matters for one awaiting approval.
    setAdjustments([]);
    setAddables([]);
    setForceExempt(false);
    setOpen(true);
  }

  const calc = selectedPurchase ? getCalculationDetails(selectedPurchase) : null;

  // Live calculation overrides for the verification modal
  let liveExempt = calc?.exempt ?? true;
  let liveCalcFinalWeight = calc?.finalWeightKg ?? 0;
  if (calc && forceExempt && !calc.exempt) {
    liveExempt = true;
    liveCalcFinalWeight = calc.referenceKg;
  }

  // Quality adjustments, live. An unverified purchase reads the draft rows; a
  // verified one replays what was stored so the breakdown is identical.
  const isVerified = !!selectedPurchase?.verification;
  const qa = computeQualityAdjustments(
    isVerified
      ? (selectedPurchase?.verification?.qualityAdjustments ?? []).map((r) => ({
          mode: r.mode,
          label: r.label,
          value: Number(r.value) || 0,
        }))
      : adjustments.map((a) => ({ mode: a.mode, label: a.label, value: Number(a.value) || 0 })),
    liveCalcFinalWeight,
    calc?.pricePerKg ?? 0,
  );

  const liveNetBase = qa.netBaseCost;
  // GST is on the invoice billing amount, independent of weight/quality discounts,
  // and only applies when the PO/URP was flagged as a GST invoice.
  const liveHasGst = calc?.hasGst ?? false;
  const liveBillingAmount = (calc?.billingWeightKg ?? 0) * (calc?.pricePerKg ?? 0);
  const liveIgst = liveHasGst ? Math.round(liveBillingAmount * 0.05 * 100) / 100 : 0;
  const liveSelfVehicleHamali = calc?.selfVehicleHamali ?? 0;
  const liveSelfVehicleKata = calc?.selfVehicleKata ?? 0;

  // Bill addables total from the input rows (unverified) or the stored record
  // (verified). Adds to the net payable.
  const liveAddables = selectedPurchase?.verification
    ? (selectedPurchase.verification.billAddables ?? []).map((a) => ({ label: a.label, amount: a.amount }))
    : addables
        .map((a) => ({ label: a.label.trim(), amount: Number(a.amount) || 0 }))
        .filter((a) => a.label && a.amount > 0);
  const liveAddablesTotal = liveAddables.reduce((sum, a) => sum + a.amount, 0);

  const liveTotalAmount = liveNetBase + liveIgst + liveAddablesTotal - liveSelfVehicleHamali - liveSelfVehicleKata;

  // A FREIGHT row settles against the lorry rather than the party, so it shows
  // up on Freight Dues - the KNM Freight tab for a company vehicle, the Inward
  // (Purchases) tab for any other lorry.
  const isKnmLorry = isVehicleExempt(selectedPurchase?.stockIn?.lorryNumber, company?.companyVehicles);
  const freightDestination = isKnmLorry ? 'KNM Freight' : 'Inward (Purchases)';

  const allPurchases = purchases ?? [];
  const verifiedCount = useMemo(() => allPurchases.filter((p) => p.verification).length, [allPurchases]);
  const pendingCount = allPurchases.length - verifiedCount;

  // Party options for the filter combo, derived from the purchases list.
  const partyOptions = useMemo(() => {
    const names = [...new Set(allPurchases
      .map((p) => p.stockIn?.purchaseOrder?.party?.name)
      .filter((n): n is string => !!n))].sort();
    return [{ value: 'ALL', label: 'All parties' }, ...names.map((n) => ({ value: n, label: n }))];
  }, [allPurchases]);

  // Rows shown after the status tabs and party combo. Stat cards use the full set.
  const filtered = useMemo(() => allPurchases.filter((p) => {
    if (partyFilter !== 'ALL' && (p.stockIn?.purchaseOrder?.party?.name ?? '') !== partyFilter) return false;
    if (statusFilter === 'PENDING' && p.verification) return false;
    if (statusFilter === 'APPROVED' && !p.verification) return false;
    return true;
  }), [allPurchases, partyFilter, statusFilter]);
  const filtersActive = statusFilter !== 'ALL' || partyFilter !== 'ALL';
  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows } = usePagedRows(filtered, 50);

  const exportColumns: ExportColumn<PurchaseRow>[] = [
    { header: 'Date', value: (p) => shortDate(p.purchaseDate ?? p.createdAt) },
    { header: 'Party', value: (p) => p.stockIn?.purchaseOrder?.party?.name ?? '' },
    { header: 'PO No', value: (p) => p.stockIn?.purchaseOrder?.poNumber ?? '' },
    { header: 'Invoice No', value: (p) => p.stockIn?.invoiceNumber ?? '' },
    { header: 'RVP Net Weight (kg)', value: (p) => p.netWeightKg, numFmt: '#,##0', align: 'right' },
    { header: 'Price/kg', value: (p) => (p.stockIn?.purchaseOrder?.pricePerKg ? rupees(p.stockIn.purchaseOrder.pricePerKg) : ''), excel: (p) => (p.stockIn?.purchaseOrder?.pricePerKg ? Number(p.stockIn.purchaseOrder.pricePerKg) : null), numFmt: '#,##0.00', align: 'right' },
    { header: 'Status', value: (p) => (p.verification ? (p.verification.exempt ? 'Exempt' : 'Deducted') : 'Pending Approval') },
    { header: 'Net Payable', value: (p) => (p.verification ? rupees(p.verification.totalAmount) : ''), excel: (p) => (p.verification ? Number(p.verification.totalAmount) : null), numFmt: '#,##0.00', align: 'right' },
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        icon={BadgeCheck}
        title="Verification"
        description="Cross-verify billing vs party-kata vs RVP-kata and compute the supplier's balance payable."
        actions={
          <ExportButtons
            filename="Verification"
            title="Purchase Verification"
            subtitle={`${filtered.length} purchase(s)`}
            columns={exportColumns}
            rows={filtered}
          />
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 stagger">
        <StatCard label="Pending Approval" value={pendingCount} icon={Clock} tone="amber" hint="awaiting approval" />
        <StatCard label="Approved" value={verifiedCount} icon={BadgeCheck} tone="forest" hint="verified purchases" />
        <StatCard label="Total" value={allPurchases.length} icon={Scale} tone="taupe" hint="purchases" />
      </div>

      <div className="glass rounded-2xl overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-border/70">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">Purchases to verify</h2>
            {pendingCount > 0 && <Badge variant="warning">{pendingCount} pending</Badge>}
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <Segmented
              options={[
                { label: 'All', value: 'ALL' },
                { label: 'Pending', value: 'PENDING' },
                { label: 'Approved', value: 'APPROVED' },
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
        <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Party</TableHead>
              <TableHead>Invoice No</TableHead>
              <TableHead className="text-right">RVP Net Weight</TableHead>
              <TableHead className="text-right">Price/kg</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Net Payable</TableHead>
              <TableHead className="w-36 text-center">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">{filtersActive ? 'No purchases match the filters.' : 'No purchases to verify yet.'}</TableCell></TableRow>
            )}
            {(pageRows ?? []).map((p) => {
              const v = p.verification;
              return (
                <TableRow key={p.id}>
                  <TableCell>{shortDate(p.purchaseDate ?? p.createdAt)}</TableCell>
                  <TableCell className="font-medium">
                    {p.stockIn?.purchaseOrder?.party?.name ?? '-'}
                    {p.stockIn?.purchaseOrder?.poNumber && (
                      <span className="ml-2 text-xs text-muted-foreground tracking-tight tabular-nums">({p.stockIn.purchaseOrder.poNumber})</span>
                    )}
                  </TableCell>
                  <TableCell className="font-semibold">{p.stockIn?.invoiceNumber ?? '-'}</TableCell>
                  <TableCell className="text-right">{kg(p.netWeightKg)}</TableCell>
                  <TableCell className="text-right">{p.stockIn?.purchaseOrder?.pricePerKg ? `${rupees(p.stockIn.purchaseOrder.pricePerKg)}/kg` : '-'}</TableCell>
                  <TableCell>
                    {v ? (
                      <Badge variant={v.exempt ? 'success' : 'warning'}>
                        {v.exempt ? 'Exempt' : 'Deducted'}
                      </Badge>
                    ) : (
                      <Badge variant="outline">Pending Approval</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-semibold text-primary">
                    {v ? rupees(v.totalAmount) : '-'}
                  </TableCell>
                  <TableCell className="text-center">
                    <Button
                      size="sm"
                      variant={v ? 'outline' : 'default'}
                      onClick={() => openVerify(p)}
                      className="gap-1"
                    >
                      {v ? 'View Details' : 'Verify & Approve'}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        </div>
        <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
      </div>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" />
        Hamali (unloading) is borne by the transporter and is not deducted from the supplier's balance - except for a self vehicle, where the ₹80/tonne lorry share and the full weighbridge (kata) fee are deducted from the party's payable.
      </p>

      {/* Verification Preview Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl max-h-[90vh] flex flex-col p-0">
          <DialogHeader className="px-6 pt-6 shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Scale className="h-5 w-5 text-primary" />
              Weight Calculation & Approval
            </DialogTitle>
            <DialogDescription>
              Verify weighbridge readings and calculate final supplier payout balance.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto px-6 py-2">
            {selectedPurchase && calc && (
              <div className="space-y-4">
              {/* Party Info */}
              <div className="flex justify-between items-center bg-muted/40 p-3 rounded-lg border text-sm">
                <div>
                  <p className="font-semibold">{selectedPurchase.stockIn?.purchaseOrder?.party?.name}</p>
                  <p className="text-xs text-muted-foreground">Invoice No: <span className="font-medium text-foreground">{selectedPurchase.stockIn?.invoiceNumber}</span></p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">{shortDate(selectedPurchase.purchaseDate ?? selectedPurchase.createdAt)}</p>
                  <Badge variant={selectedPurchase.verification ? 'default' : 'outline'}>
                    {selectedPurchase.verification ? 'Verified' : 'Awaiting Approval'}
                  </Badge>
                </div>
              </div>

              {/* Weighings Section */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold flex items-center gap-1.5"><Calculator className="h-4 w-4 text-muted-foreground" /> Weight Reconciliation</h3>
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-md border p-2 text-center bg-card">
                    <p className="text-[10px] text-muted-foreground uppercase font-medium">Billing (Inv)</p>
                    <p className="text-sm font-semibold mt-0.5">{kg(calc.billingWeightKg)}</p>
                  </div>
                  <div className="rounded-md border p-2 text-center bg-card">
                    <p className="text-[10px] text-muted-foreground uppercase font-medium">Party Kata</p>
                    <p className="text-sm font-semibold mt-0.5">{kg(calc.partyKataKg)}</p>
                  </div>
                  <div className="rounded-md border p-2 text-center bg-muted/30">
                    <p className="text-[10px] text-muted-foreground uppercase font-medium">RVP Net Kata</p>
                    <p className="text-sm font-semibold mt-0.5 text-primary">{kg(calc.rvpKataKg)}</p>
                  </div>
                </div>
              </div>

              {/* Logic Explanation Box */}
              <div className="rounded-lg border p-3.5 space-y-3 bg-muted/30 text-xs">
                {/* Step 1: Reference */}
                <div className="flex justify-between items-start gap-4 border-b pb-2">
                  <div>
                    <span className="font-semibold text-foreground">Step 1: Determine Reference Weight</span>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {calc.billingWeightKg === calc.partyKataKg
                        ? 'Party Kata matches Invoice Billing weight.'
                        : 'Party Kata differs from Invoice Billing weight. Using Party Kata.'}
                    </p>
                  </div>
                  <span className="font-semibold text-foreground">{kg(calc.referenceKg)}</span>
                </div>

                {/* Step 2: Discrepancy & Allowance */}
                <div className="flex justify-between items-start gap-4 border-b pb-2">
                  <div>
                    <span className="font-semibold text-foreground">Step 2: Compare with RVP Weight</span>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      Difference is {kg(calc.diffKg)}. Allowed exemption limit is {kg(80)}.
                    </p>
                  </div>
                  <div className="text-right">
                    <span className={`font-semibold ${liveExempt ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}>
                      {liveExempt ? 'Exempt' : 'Deduction applies'}
                    </span>
                  </div>
                </div>

                {/* Step 3: Final Payable Weight */}
                <div className="flex justify-between items-center font-medium">
                  <span>Payable Weight (Final Weight)</span>
                  <span className="font-bold text-foreground text-sm">{kg(liveCalcFinalWeight)}</span>
                </div>
                
                {!selectedPurchase.verification && !calc.exempt && (
                  <div className="pt-2 border-t flex items-center justify-between">
                    <label className="flex items-center gap-2 text-xs font-medium cursor-pointer text-foreground hover:text-primary transition-colors">
                      <input 
                        type="checkbox" 
                        className="rounded border-input text-primary focus:ring-primary h-4 w-4"
                        checked={forceExempt}
                        onChange={(e) => setForceExempt(e.target.checked)}
                      />
                      Force Exempt (Override deduction)
                    </label>
                  </div>
                )}
              </div>

              {/* Adjustments & Overheads Input Section */}
              {!selectedPurchase.verification ? (
                <div className="space-y-3 border-t pt-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold flex items-center gap-1.5"><ReceiptText className="h-4 w-4 text-muted-foreground" /> Quality Adjustments</h3>
                    <button
                      type="button"
                      onClick={() => setAdjustments((rows) => [...rows, { mode: 'WEIGHT', label: '', value: '' }])}
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      + Add deduction
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground -mt-1">
                    Deductions off the party's payable. Add as many as you need - the same mode can repeat.
                  </p>
                  {adjustments.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground italic">No deductions added.</p>
                  ) : (
                    <div className="space-y-2">
                      {adjustments.map((row, i) => (
                        <div key={i} className="space-y-1">
                          <div className="flex items-center gap-2">
                            <select
                              value={row.mode}
                              onChange={(e) =>
                                setAdjustments((rows) =>
                                  rows.map((r, j) =>
                                    j === i ? { ...r, mode: e.target.value as QualityAdjustmentMode, value: '' } : r,
                                  ),
                                )
                              }
                              className="w-40 shrink-0 h-9 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            >
                              {ADJUSTMENT_MODES.map((m) => (
                                <option key={m} value={m}>
                                  {QUALITY_ADJUSTMENT_LABELS[m]} {unitOf(m)}
                                </option>
                              ))}
                            </select>
                            <input
                              type="number"
                              step="any"
                              value={row.value}
                              onChange={(e) =>
                                setAdjustments((rows) => rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
                              }
                              className="w-24 shrink-0 h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              placeholder={row.mode === 'WEIGHT' ? 'kg' : '0.00'}
                            />
                            <input
                              type="text"
                              value={row.label}
                              onChange={(e) =>
                                setAdjustments((rows) => rows.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))
                              }
                              className="flex-1 min-w-0 h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              placeholder={
                                row.mode === 'EXPENSE' ? 'Note (e.g. Unloading)'
                                : row.mode === 'FREIGHT' ? 'Note (e.g. Lorry freight)'
                                : 'Note (optional)'
                              }
                            />
                            <button
                              type="button"
                              onClick={() => setAdjustments((rows) => rows.filter((_, j) => j !== i))}
                              className="h-9 w-9 shrink-0 rounded-md border border-input text-muted-foreground hover:text-destructive hover:border-destructive/50 transition-colors"
                              aria-label="Remove deduction"
                            >
                              ×
                            </button>
                          </div>
                          {row.mode === 'FREIGHT' && (
                            <p className="text-[11px] text-muted-foreground pl-1">
                              Recovered from the party and owed to the lorry instead - lands on Freight Dues →{' '}
                              <span className="font-medium text-foreground">{freightDestination}</span>
                              {selectedPurchase.stockIn?.lorryNumber ? ` (${selectedPurchase.stockIn.lorryNumber})` : ''}.
                            </p>
                          )}
                          {row.mode === 'EXPENSE' && (
                            <p className="text-[11px] text-muted-foreground pl-1">
                              Cost the party bears - lowers their payable and the seed's landed cost.
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Bill Addables: extra costs added to the payable */}
                  <div className="space-y-2 pt-1">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold flex items-center gap-1.5 text-foreground">
                        <ReceiptText className="h-3.5 w-3.5 text-muted-foreground" /> Bill Addables
                      </h4>
                      <button
                        type="button"
                        onClick={() => setAddables((rows) => [...rows, { label: '', amount: '' }])}
                        className="text-xs font-medium text-primary hover:underline"
                      >
                        + Add cost
                      </button>
                    </div>
                    <p className="text-[11px] text-muted-foreground -mt-1">Extra costs (loading, brokerage, misc) added on top of the seed value.</p>
                    {addables.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground italic">No extra costs added.</p>
                    ) : (
                      <div className="space-y-2">
                        {addables.map((row, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <input
                              type="text"
                              value={row.label}
                              onChange={(e) => setAddables((rows) => rows.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))}
                              className="flex-1 h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              placeholder="Cost name (e.g. Loading)"
                            />
                            <input
                              type="number"
                              step="any"
                              value={row.amount}
                              onChange={(e) => setAddables((rows) => rows.map((r, j) => (j === i ? { ...r, amount: e.target.value } : r)))}
                              className="w-28 h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              placeholder="₹ amount"
                            />
                            <button
                              type="button"
                              onClick={() => setAddables((rows) => rows.filter((_, j) => j !== i))}
                              className="h-9 w-9 shrink-0 rounded-md border border-input text-muted-foreground hover:text-destructive hover:border-destructive/50 transition-colors"
                              aria-label="Remove cost"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border p-3 bg-muted/10 space-y-1.5 text-xs">
                  <p className="font-semibold text-foreground">Quality Adjustments Applied</p>
                  {qa.rows.length === 0 ? (
                    <p className="text-muted-foreground">
                      {selectedPurchase.discountType
                        ? `${QUALITY_ADJUSTMENT_LABELS[selectedPurchase.discountType]} (-${selectedPurchase.discountValue})`
                        : 'None'}
                    </p>
                  ) : (
                    qa.rows.map((r, i) => (
                      <div key={i} className="flex justify-between gap-4">
                        <span className="text-muted-foreground">
                          {r.label}
                          <span className="ml-1 text-[10px] uppercase tracking-wide">
                            ({QUALITY_ADJUSTMENT_LABELS[r.mode]} {r.value}
                            {r.mode === 'WEIGHT' ? ' kg' : r.mode === 'PRICE' ? ' ₹/kg' : ''})
                          </span>
                        </span>
                        <span className="font-semibold text-foreground shrink-0">-{rupees(r.amount)}</span>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* Payout Breakdown */}
              <div className="space-y-1.5 border-t pt-3">
                <h3 className="text-sm font-semibold">Payment Details</h3>
                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Base cost ({kg(calc.displayBaseWeightKg)} @ {rupees(calc.pricePerKg)}/kg)</span>
                    <span>{rupees(calc.baseCost)}</span>
                  </div>
                  {(calc.referenceKg - liveCalcFinalWeight) > 0 && (
                    <div className="flex justify-between text-destructive font-medium">
                      <span>Kata discrepancy deduction ({kg(calc.referenceKg - liveCalcFinalWeight)} penalty)</span>
                      <span>-{rupees((calc.referenceKg - liveCalcFinalWeight) * calc.pricePerKg)}</span>
                    </div>
                  )}
                  {qa.rows.map((r, i) => (
                    <div key={i} className="flex justify-between gap-4 text-amber-600 font-semibold">
                      <span>
                        {r.label}
                        <span className="ml-1 font-normal text-[11px] text-muted-foreground">
                          {r.mode === 'WEIGHT' ? `${kg(r.value)} @ ${rupees(calc.pricePerKg)}/kg`
                            : r.mode === 'PRICE' ? `${rupees(r.value)}/kg on ${kg(qa.payableWeightKg)}`
                            : QUALITY_ADJUSTMENT_LABELS[r.mode]}
                          {r.mode === 'FREIGHT' ? ` → ${freightDestination}` : ''}
                        </span>
                      </span>
                      <span className="shrink-0">-{rupees(r.amount)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between border-t pt-1 font-semibold text-foreground">
                    <span className="text-muted-foreground font-normal">Net Base Cost (payable)</span>
                    <span>{rupees(liveNetBase)}</span>
                  </div>
                  {liveHasGst && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">IGST (5% on invoice billing {rupees(liveBillingAmount)})</span>
                      <span>{rupees(liveIgst)}</span>
                    </div>
                  )}
                  {liveAddables.map((a, i) => (
                    <div key={i} className="flex justify-between text-foreground">
                      <span className="text-muted-foreground">{a.label}</span>
                      <span>+{rupees(a.amount)}</span>
                    </div>
                  ))}
                  {liveSelfVehicleHamali > 0 && (
                    <div className="flex justify-between text-destructive font-medium">
                      <span>Self-vehicle hamali (₹80/t on party's own lorry)</span>
                      <span>-{rupees(liveSelfVehicleHamali)}</span>
                    </div>
                  )}
                  {liveSelfVehicleKata > 0 && (
                    <div className="flex justify-between text-destructive font-medium">
                      <span>Self-vehicle kata (weighbridge fee on party's own lorry)</span>
                      <span>-{rupees(liveSelfVehicleKata)}</span>
                    </div>
                  )}
                  <div className="flex justify-between border-t pt-2 mt-2 text-sm">
                    <span className="font-bold">Net Balance Payable</span>
                    <span className="font-bold text-primary text-base">{rupees(liveTotalAmount)}</span>
                  </div>
                </div>
              </div>
              </div>
            )}
          </div>

          <DialogFooter className="px-6 pb-6 pt-2 shrink-0 border-t">
            {selectedPurchase && (
              <>
                {selectedPurchase.verification ? (
                  <div className="flex w-full justify-between items-center gap-2">
                    <Button asChild variant="outline" size="sm" className="gap-1.5">
                      <Link to={`/purchases/${selectedPurchase.id}/statement`}>
                        <ReceiptText className="h-4 w-4" /> Print Statement
                      </Link>
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        if (confirm('Remove this verification so it can be recalculated?')) {
                          unverifyMutation.mutate(selectedPurchase.verification!.id);
                        }
                      }}
                      disabled={unverifyMutation.isPending}
                    >
                      <RotateCcw className="h-4 w-4 mr-1.5" /> Remove Approval
                    </Button>
                  </div>
                ) : (
                  <div className="flex w-full justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                      Close
                    </Button>
                    <Button
                      size="sm"
                      className="gap-1.5 bg-primary"
                      onClick={() => verifyMutation.mutate({
                        purchaseId: selectedPurchase.id,
                        forceExempt: forceExempt,
                        billAddables: addables
                          .map((a) => ({ label: a.label.trim(), amount: Number(a.amount) || 0 }))
                          .filter((a) => a.label && a.amount > 0),
                        qualityAdjustments: adjustments
                          .map((a) => ({ mode: a.mode, label: a.label.trim(), value: Number(a.value) || 0 }))
                          .filter((a) => a.value > 0),
                      })}
                      disabled={verifyMutation.isPending}
                    >
                      <BadgeCheck className="h-4 w-4" /> Approve & Save
                    </Button>
                  </div>
                )}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
