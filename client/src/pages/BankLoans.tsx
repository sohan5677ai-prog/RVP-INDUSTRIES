import { Fragment, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, ChevronDown, ChevronRight, Check } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { LoansResponse, BankLoan } from '@/lib/types';
import { loanInterest, daysBetween } from '@/lib/calc';
import { rupees, shortDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';

const today = () => new Date().toISOString().slice(0, 10);

// Rates are entered and shown MONTHLY on this page (e.g. 0.8% / month), but the
// interest engine and the DB store an ANNUAL rate (value × rate/100 × days/365,
// shared with stock-cost capitalisation). Convert at the UI boundary only.
const MONTHS_PER_YEAR = 12;
const round2 = (n: number) => Math.round(n * 100) / 100;
const toMonthly = (annualPct: number) => round2(annualPct / MONTHS_PER_YEAR);
const toAnnual = (monthlyPct: number) => round2(monthlyPct * MONTHS_PER_YEAR);

export default function BankLoansPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['loans'],
    queryFn: () => api<LoansResponse>('/loans'),
  });
  const loans = data?.loans ?? [];
  const summary = data?.summary;

  const loanColumns: ExportColumn<BankLoan>[] = [
    { header: 'Date', value: (l) => shortDate(l.drawdownDate) },
    { header: 'Person / Name / Bank', value: (l) => l.personName ?? l.name ?? l.bankName ?? '' },
    { header: 'Loan Ref', value: (l) => l.loanRef ?? '' },
    { header: 'Location', value: (l) => l.location ?? '' },
    { header: 'Principal', value: (l) => rupees(l.principal), excel: (l) => Number(l.principal), numFmt: '#,##0.00', align: 'right' },
    { header: 'Rate (%/mo)', value: (l) => toMonthly(Number(l.interestRatePct)), numFmt: '#,##0.000', align: 'right' },
    { header: 'Repaid', value: (l) => rupees(l.repaidAmount), excel: (l) => Number(l.repaidAmount), numFmt: '#,##0.00', align: 'right' },
    { header: 'Outstanding', value: (l) => rupees(l.outstanding), excel: (l) => Number(l.outstanding), numFmt: '#,##0.00', align: 'right' },
    { header: 'Accrued Interest', value: (l) => rupees(l.accruedInterestToDate), excel: (l) => Number(l.accruedInterestToDate), numFmt: '#,##0.00', align: 'right' },
    { header: 'Status', value: (l) => l.status },
  ];

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setExpanded((p) => ({ ...p, [id]: !p[id] }));

  // --- Editable global interest rate -----------------------------------------
  const [rateInput, setRateInput] = useState<string>('');
  const rateValue = rateInput !== '' ? rateInput : (summary ? String(toMonthly(summary.rate)) : '');
  const rateMutation = useMutation({
    mutationFn: (loanInterestRatePct: number) =>
      api('/loans/settings', { method: 'PUT', body: { loanInterestRatePct } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loans'] });
      qc.invalidateQueries({ queryKey: ['loan-settings'] });
      setRateInput('');
      toast.success('Interest rate updated');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // --- Add loan --------------------------------------------------------------
  const [loanOpen, setLoanOpen] = useState(false);
  const [name, setName] = useState('');
  const [personName, setPersonName] = useState('');
  const [principal, setPrincipal] = useState('');
  const [drawdownDate, setDrawdownDate] = useState(today());
  const [bankName, setBankName] = useState('');
  const [loanRef, setLoanRef] = useState('');
  const [location, setLocation] = useState<string>('');
  const [interestRatePct, setInterestRatePct] = useState('');

  function resetLoanForm() {
    setName('');
    setPersonName('');
    setPrincipal('');
    setDrawdownDate(today());
    setBankName('');
    setLoanRef('');
    setLocation('');
    setInterestRatePct('');
  }

  const loanMutation = useMutation({
    mutationFn: () =>
      api<BankLoan>('/loans', {
        method: 'POST',
        body: {
          name: name || null,
          personName: personName || null,
          principal: Number(principal),
          drawdownDate,
          bankName: bankName || null,
          loanRef: loanRef || null,
          location: location || null,
          interestRatePct: interestRatePct !== '' ? toAnnual(Number(interestRatePct)) : undefined,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loans'] });
      toast.success('Loan recorded');
      setLoanOpen(false);
      resetLoanForm();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteLoanMutation = useMutation({
    mutationFn: (id: string) => api(`/loans/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loans'] });
      toast.success('Loan deleted');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // --- Add repayment ---------------------------------------------------------
  const [repayLoan, setRepayLoan] = useState<BankLoan | null>(null);
  const [repayAmount, setRepayAmount] = useState('');
  const [repayDate, setRepayDate] = useState(today());
  const [repayRef, setRepayRef] = useState('');

  const repayMutation = useMutation({
    mutationFn: () =>
      api(`/loans/${repayLoan!.id}/repayments`, {
        method: 'POST',
        body: { amount: Number(repayAmount), date: repayDate, reference: repayRef || null },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loans'] });
      toast.success('Repayment recorded');
      setRepayLoan(null);
      setRepayAmount('');
      setRepayDate(today());
      setRepayRef('');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteRepayMutation = useMutation({
    mutationFn: (id: string) => api(`/loan-repayments/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loans'] });
      toast.success('Repayment reversed');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // Preview accrued interest in the Add Loan dialog. The rate field is MONTHLY;
  // fall back to the global default (stored annual) shown as monthly. The engine
  // needs the annual rate, so convert back up for the calculation.
  const effectiveMonthlyRate =
    interestRatePct !== '' ? Number(interestRatePct) : summary ? toMonthly(summary.rate) : 0;
  const previewInterest =
    principal && summary
      ? loanInterest(Number(principal), toAnnual(effectiveMonthlyRate), daysBetween(new Date(drawdownDate), new Date()))
      : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Bank Loans</h1>
          <p className="text-muted-foreground">
            Working-capital loans taken against stored stock. Interest accrues on the outstanding
            balance and is capitalised into black seed when it moves from storage to the process.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ExportButtons filename="Bank_Loans" title="Bank Loans" subtitle={`${loans.length} loan(s)`} columns={loanColumns} rows={loans} />
          <Button onClick={() => { resetLoanForm(); setLoanOpen(true); }}>
            <Plus className="h-4 w-4" /> Add Loan
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm text-muted-foreground">Total Outstanding</div>
          <div className="text-xl font-bold">{rupees(summary?.totalOutstanding ?? 0)}</div>
          <div className="text-xs text-muted-foreground">principal owed to bank</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm text-muted-foreground">Accrued Interest (to date)</div>
          <div className="text-xl font-bold">{rupees(summary?.totalAccruedInterest ?? 0)}</div>
          <div className="text-xs text-muted-foreground">on open loans</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm text-muted-foreground">Interest Capitalised</div>
          <div className="text-xl font-bold">{rupees(summary?.interestCapitalised ?? 0)}</div>
          <div className="text-xs text-muted-foreground">into transferred stock</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm text-muted-foreground">Monthly Interest Rate</div>
          <div className="flex items-center gap-1 pt-1">
            <Input
              type="number"
              step="0.001"
              value={rateValue}
              onChange={(e) => setRateInput(e.target.value)}
              className="h-8 w-20"
            />
            <span className="text-sm font-medium">% / mo</span>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              disabled={rateInput === '' || rateMutation.isPending}
              onClick={() => rateMutation.mutate(toAnnual(Number(rateInput)))}
              title="Save rate"
            >
              <Check className="h-4 w-4" />
            </Button>
          </div>
          <div className="text-xs text-muted-foreground">editable</div>
        </div>
      </div>

      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Date</TableHead>
              <TableHead>Person / Name / Bank</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-right">Principal</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead className="text-right">Repaid</TableHead>
              <TableHead className="text-right">Outstanding</TableHead>
              <TableHead className="text-right">Accrued Interest</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={11} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {!isLoading && loans.length === 0 && (
              <TableRow><TableCell colSpan={11} className="text-center text-muted-foreground">No loans yet.</TableCell></TableRow>
            )}
            {loans.map((loan) => (
              <Fragment key={loan.id}>
                <TableRow>
                  <TableCell>
                    <button onClick={() => toggle(loan.id)} className="text-muted-foreground">
                      {expanded[loan.id] ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                  </TableCell>
                  <TableCell>{shortDate(loan.drawdownDate)}</TableCell>
                  <TableCell>
                    <div className="font-medium text-foreground">{loan.personName ?? loan.name ?? loan.bankName ?? '-'}</div>
                    <div className="text-xs text-muted-foreground">
                      {loan.personName && loan.name ? `${loan.name} ` : ''}
                      {loan.bankName ? `(${loan.bankName})` : ''}
                      {loan.loanRef ? <span className="font-mono"> · {loan.loanRef}</span> : ''}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">{loan.location ?? '-'}</span>
                  </TableCell>
                  <TableCell className="text-right">{rupees(loan.principal)}</TableCell>
                  <TableCell className="text-right">{toMonthly(Number(loan.interestRatePct))}% /mo</TableCell>
                  <TableCell className="text-right">{rupees(loan.repaidAmount)}</TableCell>
                  <TableCell className="text-right font-semibold">{rupees(loan.outstanding)}</TableCell>
                  <TableCell className="text-right">{rupees(loan.accruedInterestToDate)}</TableCell>
                  <TableCell>
                    <span className={loan.status === 'OPEN' ? 'text-emerald-600 font-medium' : 'text-muted-foreground'}>
                      {loan.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {loan.status === 'OPEN' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => { setRepayLoan(loan); setRepayAmount(''); setRepayDate(today()); setRepayRef(''); }}
                        >
                          Repay
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          if (confirm('Delete this loan? Only allowed when it has no repayments.')) {
                            deleteLoanMutation.mutate(loan.id);
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
                {expanded[loan.id] && (
                  <TableRow>
                    <TableCell />
                    <TableCell colSpan={10} className="bg-muted/30">
                      {loan.repayments.length === 0 ? (
                        <div className="text-sm text-muted-foreground py-1">No repayments yet.</div>
                      ) : (
                        <div className="space-y-1 py-1">
                          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Repayments</div>
                          {loan.repayments.map((r) => (
                            <div key={r.id} className="flex items-center justify-between text-sm">
                              <span>{shortDate(r.date)}{r.reference ? ` · ${r.reference}` : ''}</span>
                              <span className="flex items-center gap-2">
                                <span className="font-medium">{rupees(r.amount)}</span>
                                <button
                                  onClick={() => {
                                    if (confirm('Reverse this repayment?')) deleteRepayMutation.mutate(r.id);
                                  }}
                                  className="text-destructive"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Add loan dialog */}
      <Dialog open={loanOpen} onOpenChange={setLoanOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Add Loan (Drawdown)</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="principal">Principal (₹)</Label>
                <Input id="principal" type="number" value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="1500000" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ddate">Drawdown date</Label>
                <Input id="ddate" type="date" value={drawdownDate} onChange={(e) => setDrawdownDate(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="pname">Person Name</Label>
                <Input id="pname" value={personName} onChange={(e) => setPersonName(e.target.value)} placeholder="e.g. John Doe" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lname">Loan Name</Label>
                <Input id="lname" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. HDFC Agri" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="bank">Bank name</Label>
                <Input id="bank" value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="e.g. SBI" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="rate">Interest rate (% / month)</Label>
                <Input
                  id="rate"
                  type="number"
                  step="0.001"
                  value={interestRatePct}
                  onChange={(e) => setInterestRatePct(e.target.value)}
                  placeholder={summary ? String(toMonthly(summary.rate)) : '0.8'}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="ref">Loan / account ref</Label>
                <Input id="ref" value={loanRef} onChange={(e) => setLoanRef(e.target.value)} placeholder="optional" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="location">Storage Location</Label>
                <Select value={location} onValueChange={setLocation}>
                  <SelectTrigger id="location">
                    <SelectValue placeholder="Select location" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="RVP">RVP</SelectItem>
                    <SelectItem value="PGR COLD">Rampalli</SelectItem>
                    <SelectItem value="Murugan">Murugan</SelectItem>
                    <SelectItem value="KNM Multi">Multi</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="rounded-lg border bg-muted/40 p-4 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Interest rate</span>
                <span className="font-medium">{effectiveMonthlyRate}% / month</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Accrued interest if held to today</span>
                <span className="font-medium">{principal ? rupees(previewInterest) : '-'}</span>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => loanMutation.mutate()} disabled={!principal || Number(principal) <= 0 || loanMutation.isPending}>
                {loanMutation.isPending ? 'Saving…' : 'Save loan'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add repayment dialog */}
      <Dialog open={!!repayLoan} onOpenChange={(o) => !o && setRepayLoan(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Record Repayment</DialogTitle></DialogHeader>
          {repayLoan && (
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground">
                Outstanding on this loan: <span className="font-semibold text-foreground">{rupees(repayLoan.outstanding)}</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="ramount">Amount (₹)</Label>
                  <Input id="ramount" type="number" value={repayAmount} onChange={(e) => setRepayAmount(e.target.value)} placeholder="500000" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rdate">Date</Label>
                  <Input id="rdate" type="date" value={repayDate} onChange={(e) => setRepayDate(e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="rref">Reference</Label>
                <Input id="rref" value={repayRef} onChange={(e) => setRepayRef(e.target.value)} placeholder="optional" />
              </div>
              <DialogFooter>
                <Button
                  onClick={() => repayMutation.mutate()}
                  disabled={!repayAmount || Number(repayAmount) <= 0 || repayMutation.isPending}
                >
                  {repayMutation.isPending ? 'Saving…' : 'Save repayment'}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
