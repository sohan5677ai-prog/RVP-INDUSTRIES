import { Fragment, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, ChevronRight, IndianRupee, MessageCircle } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { PrivateLoansResponse, PrivateLoan, WaLanguage, InterestPeriod } from '@/lib/types';
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
import { ExpandPanel, PanelLabel, PanelStack, PanelCard, PanelTitle, PanelMeta, Figure, PanelEmpty } from '@/components/ExpandPanel';
import { cn } from '@/lib/utils';
import type { ExportColumn } from '@/lib/export';

const today = () => new Date().toISOString().slice(0, 10);

// Only the languages the statement template is actually drafted in - see
// docs/whatsapp-private-loan-statement-template.md. Other WaLanguage values
// exist elsewhere in the ERP (Party/Broker) but have no copy here yet.
const STATEMENT_LANGUAGES: { value: WaLanguage; label: string }[] = [
  { value: 'EN', label: 'English' },
  { value: 'TE', label: 'తెలుగు (Telugu)' },
  { value: 'HI', label: 'हिंदी (Hindi)' },
];

// The interest engine and the DB always store an ANNUAL rate (value × rate/100
// × days/365). interestPeriod just picks which unit the rate is entered/shown
// in - convert at the UI boundary only, same pattern as Storage Loans.
const MONTHS_PER_YEAR = 12;
const round2 = (n: number) => Math.round(n * 100) / 100;
const toMonthly = (annualPct: number) => round2(annualPct / MONTHS_PER_YEAR);
const toAnnual = (monthlyPct: number) => round2(monthlyPct * MONTHS_PER_YEAR);

export default function PrivateLoansPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['private-loans'],
    queryFn: () => api<PrivateLoansResponse>('/private-loans'),
  });
  const loans = data?.loans ?? [];
  const summary = data?.summary;

  const loanColumns: ExportColumn<PrivateLoan>[] = [
    { header: 'Date', value: (l) => shortDate(l.startDate) },
    { header: 'Borrower', value: (l) => l.borrowerName },
    { header: 'Phone', value: (l) => l.phone ?? '' },
    { header: 'Principal', value: (l) => rupees(l.principal), excel: (l) => Number(l.principal), numFmt: '#,##0.00', align: 'right' },
    {
      header: 'Rate',
      value: (l) => (l.interestPeriod === 'MONTHLY' ? `${toMonthly(Number(l.interestRatePct))}%/mo` : `${Number(l.interestRatePct)}%/yr`),
      align: 'right',
    },
    { header: 'Repaid', value: (l) => rupees(l.repaidAmount), excel: (l) => Number(l.repaidAmount), numFmt: '#,##0.00', align: 'right' },
    { header: 'Outstanding', value: (l) => rupees(l.outstanding), excel: (l) => Number(l.outstanding), numFmt: '#,##0.00', align: 'right' },
    { header: 'Accrued Interest', value: (l) => rupees(l.accruedInterestToDate), excel: (l) => Number(l.accruedInterestToDate), numFmt: '#,##0.00', align: 'right' },
    { header: 'Status', value: (l) => l.status },
  ];

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setExpanded((p) => ({ ...p, [id]: !p[id] }));

  // --- Add loan ----------------------------------------------------------
  const [loanOpen, setLoanOpen] = useState(false);
  const [borrowerName, setBorrowerName] = useState('');
  const [phone, setPhone] = useState('');
  const [phone2, setPhone2] = useState('');
  const [principal, setPrincipal] = useState('');
  const [startDate, setStartDate] = useState(today());
  const [interestRatePct, setInterestRatePct] = useState('');
  const [interestPeriod, setInterestPeriod] = useState<InterestPeriod>('ANNUAL');
  const [notes, setNotes] = useState('');
  const [waLanguage, setWaLanguage] = useState<WaLanguage>('EN');

  function resetLoanForm() {
    setBorrowerName('');
    setPhone('');
    setPhone2('');
    setPrincipal('');
    setStartDate(today());
    setInterestRatePct('');
    setInterestPeriod('ANNUAL');
    setNotes('');
    setWaLanguage('EN');
  }

  const loanMutation = useMutation({
    mutationFn: () =>
      api<PrivateLoan>('/private-loans', {
        method: 'POST',
        body: {
          borrowerName,
          phone: phone || null,
          phone2: phone2 || null,
          principal: Number(principal),
          startDate,
          // Rate is entered in whichever period the user picked; the server
          // always stores/computes on an ANNUAL basis, so convert here.
          interestRatePct: interestPeriod === 'MONTHLY' ? toAnnual(Number(interestRatePct)) : Number(interestRatePct),
          interestPeriod,
          notes: notes || null,
          waLanguage,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['private-loans'] });
      toast.success('Loan recorded');
      setLoanOpen(false);
      resetLoanForm();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteLoanMutation = useMutation({
    mutationFn: (id: string) => api(`/private-loans/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['private-loans'] });
      toast.success('Loan deleted');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // --- Send WhatsApp statement --------------------------------------------
  const sendStatementMutation = useMutation({
    mutationFn: (id: string) => api(`/private-loans/${id}/send-statement`, { method: 'POST' }),
    onSuccess: () => toast.success('Statement sent on WhatsApp'),
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // --- Add repayment -------------------------------------------------------
  const [repayLoan, setRepayLoan] = useState<PrivateLoan | null>(null);
  const [repayAmount, setRepayAmount] = useState('');
  const [repayInterest, setRepayInterest] = useState('');
  const [repayDate, setRepayDate] = useState(today());
  const [repayRef, setRepayRef] = useState('');
  const [repayClose, setRepayClose] = useState(false);

  // Open the repayment dialog, prefilling the interest portion with the loan's
  // accrued interest to date (editable to whatever was actually collected).
  function openRepay(loan: PrivateLoan) {
    setRepayLoan(loan);
    setRepayAmount('');
    setRepayInterest(loan.accruedInterestToDate ? String(loan.accruedInterestToDate) : '');
    setRepayDate(today());
    setRepayRef('');
    setRepayClose(false);
  }

  const repayResidue = repayLoan
    ? Math.round((Number(repayLoan.outstanding) - (Number(repayAmount) || 0)) * 100) / 100
    : 0;
  const repayClearsLoan = !!repayAmount && repayResidue <= 0.01;
  const repayWillClose = repayClearsLoan || repayClose;

  const repayMutation = useMutation({
    mutationFn: () =>
      api(`/private-loans/${repayLoan!.id}/repayments`, {
        method: 'POST',
        body: {
          amount: Number(repayAmount),
          interest: repayInterest !== '' ? Number(repayInterest) : 0,
          date: repayDate,
          reference: repayRef || null,
          closeLoan: repayWillClose,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['private-loans'] });
      toast.success(repayWillClose ? 'Repayment recorded · loan closed' : 'Repayment recorded');
      setRepayLoan(null);
      setRepayAmount('');
      setRepayInterest('');
      setRepayDate(today());
      setRepayRef('');
      setRepayClose(false);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteRepayMutation = useMutation({
    mutationFn: (id: string) => api(`/private-loan-repayments/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['private-loans'] });
      toast.success('Repayment reversed');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // Preview accrued interest in the Add Loan dialog. The engine always wants
  // an annual rate, so convert up when the user entered a monthly one.
  const effectiveAnnualRate =
    interestRatePct !== '' ? (interestPeriod === 'MONTHLY' ? toAnnual(Number(interestRatePct)) : Number(interestRatePct)) : 0;
  const previewInterest =
    principal && interestRatePct
      ? loanInterest(Number(principal), effectiveAnnualRate, daysBetween(new Date(startDate), new Date()))
      : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Private Loans</h1>
          <p className="text-muted-foreground">
            Loans given out to others. Interest accrues daily on the outstanding balance at the
            rate set per loan; send the borrower a WhatsApp statement of what they owe any time.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ExportButtons filename="Private_Loans" title="Private Loans" subtitle={`${loans.length} loan(s)`} columns={loanColumns} rows={loans} />
          <Button onClick={() => { resetLoanForm(); setLoanOpen(true); }}>
            <Plus className="h-4 w-4" /> Add Loan
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm text-muted-foreground">Total Outstanding</div>
          <div className="text-xl font-bold">{rupees(summary?.totalOutstanding ?? 0)}</div>
          <div className="text-xs text-muted-foreground">principal owed to us</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm text-muted-foreground">Accrued Interest (to date)</div>
          <div className="text-xl font-bold">{rupees(summary?.totalAccruedInterest ?? 0)}</div>
          <div className="text-xs text-muted-foreground">on open loans, not yet collected</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm text-muted-foreground">Interest Received</div>
          <div className="text-xl font-bold">{rupees(summary?.totalInterestReceived ?? 0)}</div>
          <div className="text-xs text-muted-foreground">all-time, booked to Interest Income</div>
        </div>
      </div>

      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Date</TableHead>
              <TableHead>Borrower</TableHead>
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
              <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {!isLoading && loans.length === 0 && (
              <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground">No loans yet.</TableCell></TableRow>
            )}
            {loans.map((loan) => (
              <Fragment key={loan.id}>
                <TableRow
                  className={cn('cursor-pointer transition-colors', expanded[loan.id] ? 'bg-accent/40' : 'hover:bg-accent/30')}
                  onClick={() => toggle(loan.id)}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => toggle(loan.id)} className="text-muted-foreground">
                      <ChevronRight className={cn('h-4 w-4 transition-transform duration-200', expanded[loan.id] && 'rotate-90 text-primary')} />
                    </button>
                  </TableCell>
                  <TableCell>{shortDate(loan.startDate)}</TableCell>
                  <TableCell>
                    <div className="font-medium text-foreground">{loan.borrowerName}</div>
                    {loan.phone && (
                      <div className="text-xs text-muted-foreground">
                        {loan.phone}
                        {loan.waLanguage !== 'EN' && ` · ${loan.waLanguage}`}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{rupees(loan.principal)}</TableCell>
                  <TableCell className="text-right">
                    {loan.interestPeriod === 'MONTHLY'
                      ? `${toMonthly(Number(loan.interestRatePct))}% /mo`
                      : `${Number(loan.interestRatePct)}% /yr`}
                  </TableCell>
                  <TableCell className="text-right">{rupees(loan.repaidAmount)}</TableCell>
                  <TableCell className="text-right font-semibold">{rupees(loan.outstanding)}</TableCell>
                  <TableCell className="text-right">{rupees(loan.accruedInterestToDate)}</TableCell>
                  <TableCell>
                    <span className={loan.status === 'OPEN' ? 'text-emerald-600 font-medium' : 'text-muted-foreground'}>
                      {loan.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={(!loan.phone && !loan.phone2) || sendStatementMutation.isPending}
                        title={!loan.phone && !loan.phone2 ? 'No phone number on file for this loan' : 'Send outstanding-loan statement on WhatsApp'}
                        onClick={() => sendStatementMutation.mutate(loan.id)}
                      >
                        <MessageCircle className="h-4 w-4" />
                      </Button>
                      {loan.status === 'OPEN' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openRepay(loan)}
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
                  <ExpandPanel colSpan={10}>
                    {loan.notes && (
                      <div className="mb-2 text-sm text-muted-foreground">{loan.notes}</div>
                    )}
                    <PanelLabel>Repayments · {loan.repayments.length}</PanelLabel>
                    {loan.repayments.length === 0 ? (
                      <PanelEmpty>No repayments yet.</PanelEmpty>
                    ) : (
                      <PanelStack>
                        {loan.repayments.map((r) => (
                          <PanelCard
                            key={r.id}
                            icon={IndianRupee}
                            identity={
                              <>
                                <PanelTitle>
                                  <span className="font-mono text-sm font-semibold">{shortDate(r.date)}</span>
                                </PanelTitle>
                                {r.reference && <PanelMeta><span>{r.reference}</span></PanelMeta>}
                              </>
                            }
                            figures={
                              <>
                                <Figure label="Principal" value={rupees(r.amount)} />
                                {Number(r.interest) > 0 && <Figure label="Interest" value={rupees(r.interest)} valueClass="text-muted-foreground" />}
                              </>
                            }
                            actions={
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                                onClick={() => {
                                  if (confirm('Reverse this repayment?')) deleteRepayMutation.mutate(r.id);
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" /> Reverse
                              </Button>
                            }
                          />
                        ))}
                      </PanelStack>
                    )}
                  </ExpandPanel>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Add loan dialog */}
      <Dialog open={loanOpen} onOpenChange={setLoanOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Add Private Loan</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="borrower">Borrower name</Label>
                <Input id="borrower" value={borrowerName} onChange={(e) => setBorrowerName(e.target.value)} placeholder="e.g. Ramesh" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sdate">Start date</Label>
                <Input id="sdate" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="phone">Phone</Label>
                <Input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="10-digit mobile" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone2">Phone (alt)</Label>
                <Input id="phone2" value={phone2} onChange={(e) => setPhone2(e.target.value)} placeholder="optional" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="walang">WhatsApp statement language</Label>
              <Select value={waLanguage} onValueChange={(v) => setWaLanguage(v as WaLanguage)}>
                <SelectTrigger id="walang">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATEMENT_LANGUAGES.map((l) => (
                    <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="principal">Principal (₹)</Label>
                <Input id="principal" type="number" value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="100000" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="rate">Interest rate</Label>
                <div className="flex gap-2">
                  <Input
                    id="rate"
                    type="number"
                    step="0.001"
                    value={interestRatePct}
                    onChange={(e) => setInterestRatePct(e.target.value)}
                    placeholder={interestPeriod === 'MONTHLY' ? '1' : '12'}
                    className="flex-1"
                  />
                  <Select value={interestPeriod} onValueChange={(v) => setInterestPeriod(v as InterestPeriod)}>
                    <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ANNUAL">% p.a.</SelectItem>
                      <SelectItem value="MONTHLY">% p.m.</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
            </div>
            <div className="rounded-lg border bg-muted/40 p-4 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Accrued interest if held to today</span>
                <span className="font-medium">{principal && interestRatePct ? rupees(previewInterest) : '-'}</span>
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() => loanMutation.mutate()}
                disabled={!borrowerName || !principal || Number(principal) <= 0 || interestRatePct === '' || loanMutation.isPending}
              >
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
                  <div className="flex items-center justify-between">
                    <Label htmlFor="ramount">Principal (₹)</Label>
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() => setRepayAmount(String(repayLoan.outstanding))}
                    >
                      Full
                    </button>
                  </div>
                  <Input id="ramount" type="number" value={repayAmount} onChange={(e) => setRepayAmount(e.target.value)} placeholder="50000" />
                  <p className="text-xs text-muted-foreground">reduces the outstanding loan</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rinterest">Interest (₹) received</Label>
                  <Input id="rinterest" type="number" value={repayInterest} onChange={(e) => setRepayInterest(e.target.value)} placeholder="0" />
                  <p className="text-xs text-muted-foreground">
                    accrued to date: {rupees(repayLoan.accruedInterestToDate)}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="rdate">Date</Label>
                  <Input id="rdate" type="date" value={repayDate} onChange={(e) => setRepayDate(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rref">Reference</Label>
                  <Input id="rref" value={repayRef} onChange={(e) => setRepayRef(e.target.value)} placeholder="optional" />
                </div>
              </div>
              <div className="rounded-lg border bg-muted/40 p-3 flex justify-between text-sm">
                <span className="text-muted-foreground">Total cash in</span>
                <span className="font-semibold">
                  {rupees((Number(repayAmount) || 0) + (Number(repayInterest) || 0))}
                </span>
              </div>

              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-primary"
                  checked={repayWillClose}
                  disabled={repayClearsLoan}
                  onChange={(e) => setRepayClose(e.target.checked)}
                />
                <span className="text-sm">
                  <span className="font-medium">Close this loan</span>
                  <span className="block text-xs text-muted-foreground">
                    {repayClearsLoan
                      ? 'this repayment clears the outstanding, so the loan closes automatically'
                      : repayResidue > 0.01
                        ? `marks the loan CLOSED and stops interest accruing — ${rupees(repayResidue)} principal will stay showing against it`
                        : 'marks the loan CLOSED and stops interest accruing'}
                  </span>
                </span>
              </label>

              <DialogFooter>
                <Button
                  onClick={() => repayMutation.mutate()}
                  disabled={!repayAmount || Number(repayAmount) <= 0 || repayMutation.isPending}
                >
                  {repayMutation.isPending
                    ? 'Saving…'
                    : repayWillClose
                      ? 'Save & close loan'
                      : 'Save repayment'}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
