import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ReceiptText, BadgeCheck, RotateCcw, ShieldCheck, Scale, Calculator, Clock, IndianRupee } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { Purchase, WeightVerification } from '@/lib/types';
import { kg, rupees, shortDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { crossVerify } from '@/lib/calc';
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
    billingWeightKg?: number;
    partyKataKg?: number;
    purchaseOrder?: { poNumber?: string; pricePerKg?: string; party?: { name: string } };
  };
};

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
  // on our recalculated payable.
  const billingAmount = billingWeightKg * pricePerKg;
  const igst = billingAmount * 0.05;
  
  const kataDiffDeduction = hasPenalty ? (reference - finalWeight) * pricePerKg : 0;
  const totalAmount = baseCost - kataDiffDeduction + igst;

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
    baseCost,
    billingAmount,
    igst,
    kataDiffDeduction,
    totalAmount,
  };
}

export default function Verification() {
  const qc = useQueryClient();
  const [selectedPurchase, setSelectedPurchase] = useState<PurchaseRow | null>(null);
  const [open, setOpen] = useState(false);
  const [forceExempt, setForceExempt] = useState(false);

  // States for discount
  const [discountType, setDiscountType] = useState<'WEIGHT' | 'PRICE' | 'AMOUNT' | ''>('');
  const [discountValue, setDiscountValue] = useState('');

  const { data: purchases, isLoading } = useQuery({
    queryKey: ['purchases'],
    queryFn: () => api<PurchaseRow[]>('/purchases'),
  });

  const verifyMutation = useMutation({
    mutationFn: (args: { purchaseId: string; discountType?: string | null; discountValue?: number; forceExempt: boolean }) =>
      api('/verifications', { method: 'POST', body: args }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchases'] });
      qc.invalidateQueries({ queryKey: ['verifications'] });
      qc.invalidateQueries({ queryKey: ['processing'] });
      toast.success('Approved — balance payable calculated and black seed added to stock');
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
      qc.invalidateQueries({ queryKey: ['processing'] });
      toast.success('Verification removed — you can re-verify');
      setOpen(false);
      setSelectedPurchase(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function openVerify(p: PurchaseRow) {
    setSelectedPurchase(p);
    if (p.verification) {
      setDiscountType(p.discountType || '');
      setDiscountValue(p.discountValue ? String(p.discountValue) : '');
    } else {
      setDiscountType('');
      setDiscountValue('');
    }
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

  const discountValNum = Number(discountValue) || 0;
  let livePayableWeight = liveCalcFinalWeight;
  let livePayablePrice = calc?.pricePerKg ?? 0;
  let liveDiscountAmount = 0;

  if (calc) {
    if (discountType === 'WEIGHT') {
      livePayableWeight = Math.max(0, liveCalcFinalWeight - discountValNum);
      liveDiscountAmount = discountValNum * calc.pricePerKg;
    } else if (discountType === 'PRICE') {
      livePayablePrice = Math.max(0, calc.pricePerKg - discountValNum);
      liveDiscountAmount = liveCalcFinalWeight * discountValNum;
    } else if (discountType === 'AMOUNT') {
      liveDiscountAmount = discountValNum;
    }
  }

  const liveBasePayable = livePayableWeight * livePayablePrice;
  const liveNetBase = discountType === 'AMOUNT' ? Math.max(0, liveBasePayable - discountValNum) : liveBasePayable;
  // GST is on the invoice billing amount, independent of weight/quality discounts.
  const liveBillingAmount = (calc?.billingWeightKg ?? 0) * (calc?.pricePerKg ?? 0);
  const liveIgst = Math.round(liveBillingAmount * 0.05 * 100) / 100;
  const liveTotalAmount = liveNetBase + liveIgst;

  const allPurchases = purchases ?? [];
  const verifiedCount = allPurchases.filter((p) => p.verification).length;
  const pendingCount = allPurchases.length - verifiedCount;
  const totalPayable = allPurchases.reduce((s, p) => s + (p.verification ? Number(p.verification.totalAmount) : 0), 0);

  return (
    <div className="space-y-8">
      <PageHeader
        icon={BadgeCheck}
        title="Weight Verification"
        description="Cross-verify billing vs party-kata vs RVP-kata and compute the supplier's balance payable."
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 stagger">
        <StatCard label="To verify" value={pendingCount} icon={Clock} tone="amber" hint="awaiting approval" />
        <StatCard label="Approved" value={verifiedCount} icon={BadgeCheck} tone="forest" hint="verified purchases" />
        <StatCard label="Total" value={allPurchases.length} icon={Scale} tone="taupe" hint="purchases" />
        <StatCard label="Net payable" value={rupees(totalPayable)} icon={IndianRupee} tone="gold" hint="approved balances" />
      </div>

      <div className="glass rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/70">
          <h2 className="text-sm font-semibold text-foreground">Purchases to verify</h2>
          {pendingCount > 0 && <Badge variant="warning">{pendingCount} pending</Badge>}
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
            {purchases?.length === 0 && (
              <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">No purchases to verify yet.</TableCell></TableRow>
            )}
            {purchases?.map((p) => {
              const v = p.verification;
              return (
                <TableRow key={p.id}>
                  <TableCell>{shortDate(p.createdAt)}</TableCell>
                  <TableCell className="font-medium">
                    {p.stockIn?.purchaseOrder?.party?.name ?? '—'}
                    {p.stockIn?.purchaseOrder?.poNumber && (
                      <span className="ml-2 text-xs text-muted-foreground font-mono">({p.stockIn.purchaseOrder.poNumber})</span>
                    )}
                  </TableCell>
                  <TableCell className="font-semibold">{p.stockIn?.invoiceNumber ?? '—'}</TableCell>
                  <TableCell className="text-right">{kg(p.netWeightKg)}</TableCell>
                  <TableCell className="text-right">{p.stockIn?.purchaseOrder?.pricePerKg ? `${rupees(p.stockIn.purchaseOrder.pricePerKg)}/kg` : '—'}</TableCell>
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
                    {v ? rupees(v.totalAmount) : '—'}
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
      </div>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" />
        Hamali (unloading) is borne by the transporter and is not deducted from the supplier's balance.
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
                  <p className="text-xs text-muted-foreground">{shortDate(selectedPurchase.createdAt)}</p>
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
                  <h3 className="text-sm font-semibold flex items-center gap-1.5"><ReceiptText className="h-4 w-4 text-muted-foreground" /> Quality Adjustments</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold text-muted-foreground uppercase">Discount Mode</label>
                      <select
                        value={discountType}
                        onChange={(e: any) => {
                          setDiscountType(e.target.value);
                          setDiscountValue('');
                        }}
                        className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <option value="">No Discount</option>
                        <option value="WEIGHT">Weight Deduct (kg)</option>
                        <option value="PRICE">Price Deduct (₹/kg)</option>
                        <option value="AMOUNT">Flat Amount (₹)</option>
                      </select>
                    </div>
                    {discountType !== '' && (
                      <div className="space-y-1">
                        <label className="text-[10px] font-semibold text-muted-foreground uppercase">
                          Val {discountType === 'WEIGHT' ? '(kg)' : discountType === 'PRICE' ? '(₹/kg)' : '(₹)'}
                        </label>
                        <input
                          type="number"
                          step="any"
                          value={discountValue}
                          onChange={(e) => setDiscountValue(e.target.value)}
                          className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          placeholder="0.00"
                        />
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border p-3 bg-muted/10 space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Quality Discount Applied:</span>
                    <span className="font-semibold text-foreground">
                      {selectedPurchase.discountType
                        ? `${selectedPurchase.discountType === 'WEIGHT' ? 'Weight Deduct' : selectedPurchase.discountType === 'PRICE' ? 'Price Deduct' : 'Flat Deduct'} (-${selectedPurchase.discountValue})`
                        : 'None'}
                    </span>
                  </div>
                </div>
              )}

              {/* Payout Breakdown */}
              <div className="space-y-1.5 border-t pt-3">
                <h3 className="text-sm font-semibold">Payment Details</h3>
                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Base cost ({kg(liveExempt ? calc.referenceKg : calc.displayBaseWeightKg)} @ {rupees(calc.pricePerKg)}/kg)</span>
                    <span>{rupees(liveExempt ? (calc.referenceKg * calc.pricePerKg) : calc.baseCost)}</span>
                  </div>
                  {(calc.referenceKg - liveCalcFinalWeight) > 0 && (
                    <div className="flex justify-between text-destructive font-medium">
                      <span>Kata discrepancy deduction ({kg(calc.referenceKg - liveCalcFinalWeight)} penalty)</span>
                      <span>-{rupees((calc.referenceKg - liveCalcFinalWeight) * calc.pricePerKg)}</span>
                    </div>
                  )}
                  {liveDiscountAmount > 0 && (
                    <div className="flex justify-between text-amber-600 font-semibold">
                      <span>Quality Discount ({discountType === 'WEIGHT' ? 'Weight Deduct' : discountType === 'PRICE' ? 'Price Deduct' : 'Flat Deduct'})</span>
                      <span>-{rupees(liveDiscountAmount)}</span>
                    </div>
                  )}
                  <div className="flex justify-between border-t pt-1 font-semibold text-foreground">
                    <span className="text-muted-foreground font-normal">Net Base Cost (payable)</span>
                    <span>{rupees(liveNetBase)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">IGST (5% on invoice billing {rupees(liveBillingAmount)})</span>
                    <span>{rupees(liveIgst)}</span>
                  </div>
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
                        discountType: discountType || null,
                        discountValue: Number(discountValue) || 0,
                        forceExempt: forceExempt,
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
