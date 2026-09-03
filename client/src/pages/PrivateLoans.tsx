import { Fragment, useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, ChevronRight, IndianRupee, Pencil, CalendarClock, Save, X, Loader2 } from 'lucide-react';
import { WhatsAppIcon } from '@/components/icons/WhatsAppIcon';
import { api, getErrorMessage } from '@/lib/api';
import type { PrivateLoansResponse, PrivateLoan, PrivateLoanReminderSchedule, WaLanguage, InterestPeriod } from '@/lib/types';
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

const SCHEDULE_DOW_OPTIONS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

const STOP_CONDITION_LABEL: Record<PrivateLoanReminderSchedule['stopCondition'], string> = {
  UNTIL_PAID: 'Until loan is fully repaid / closed',
  UNTIL_DATE: 'Until a specific date',
  AFTER_COUNT: 'After a fixed number of reminders',
  MANUAL: 'Until manually turned off',
};

const STOPPED_REASON_LABEL: Record<NonNullable<PrivateLoanReminderSchedule['stoppedReason']>, string> = {
  PAID: 'Auto-stopped: loan was fully repaid / closed',
  DATE_REACHED: 'Auto-stopped: end date reached',
  COUNT_REACHED: 'Auto-stopped: target reminder count reached',
};

function describeLoanSchedule(schedule: PrivateLoanReminderSchedule): string {
  const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')} IST`;
  if (schedule.frequency === 'DAILY') return `${time}, daily`;
  if (schedule.frequency === 'WEEKLY') {
    const days = schedule.daysOfWeek.map((d) => SCHEDULE_DOW_OPTIONS.find((o) => o.value === d)?.label).filter(Boolean).join(', ');
    return `${time}, every ${days || 'week'}`;
  }
  if (schedule.frequency === 'INTERVAL') {
    return `${time}, every ${schedule.intervalDays ?? 1} day(s)`;
  }
  return time;
}

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

  // --- WhatsApp Reminder Schedule dialog -----------------------------------
  const [scheduleLoan, setScheduleLoan] = useState<PrivateLoan | null>(null);

  // --- Add / Edit loan ---------------------------------------------------
  const [loanOpen, setLoanOpen] = useState(false);
  const [editingLoan, setEditingLoan] = useState<PrivateLoan | null>(null);
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
    setEditingLoan(null);
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

  function openEdit(loan: PrivateLoan) {
    setEditingLoan(loan);
    setBorrowerName(loan.borrowerName);
    setPhone(loan.phone ?? '');
    setPhone2(loan.phone2 ?? '');
    setPrincipal(String(loan.principal));
    setStartDate(new Date(loan.startDate).toISOString().slice(0, 10));
    setInterestRatePct(
      loan.interestPeriod === 'MONTHLY'
        ? String(toMonthly(Number(loan.interestRatePct)))
        : String(loan.interestRatePct)
    );
    setInterestPeriod(loan.interestPeriod ?? 'ANNUAL');
    setNotes(loan.notes ?? '');
    setWaLanguage(loan.waLanguage ?? 'EN');
    setLoanOpen(true);
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

  const updateLoanMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) =>
      api<PrivateLoan>(`/private-loans/${id}`, {
        method: 'PUT',
        body,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['private-loans'] });
      toast.success('Loan updated');
      setLoanOpen(false);
      resetLoanForm();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function handleSaveLoan() {
    const payload = {
      borrowerName,
      phone: phone || null,
      phone2: phone2 || null,
      principal: Number(principal),
      startDate,
      interestRatePct: interestPeriod === 'MONTHLY' ? toAnnual(Number(interestRatePct)) : Number(interestRatePct),
      interestPeriod,
      notes: notes || null,
      waLanguage,
    };
    if (editingLoan) {
      updateLoanMutation.mutate({ id: editingLoan.id, body: payload });
    } else {
      loanMutation.mutate();
    }
  }

  const isSavingLoan = loanMutation.isPending || updateLoanMutation.isPending;

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
                        className="text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
                      >
                        <WhatsAppIcon className="h-4 w-4 fill-emerald-600" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!loan.phone && !loan.phone2}
                        title={
                          !loan.phone && !loan.phone2
                            ? 'No phone number on file for this loan'
                            : loan.reminderSchedule?.enabled
                              ? `WhatsApp schedule active (${describeLoanSchedule(loan.reminderSchedule)})`
                              : 'Set WhatsApp reminder schedule'
                        }
                        onClick={() => setScheduleLoan(loan)}
                        className={cn(
                          'gap-1 relative',
                          loan.reminderSchedule?.enabled
                            ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400 bg-emerald-50/50 dark:bg-emerald-950/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/40'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        <CalendarClock className="h-4 w-4 text-emerald-600" />
                        {loan.reminderSchedule?.enabled && (
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        title="Edit loan"
                        onClick={() => openEdit(loan)}
                      >
                        <Pencil className="h-4 w-4" />
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
                        title="Delete loan"
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
                    {loan.reminderSchedule && (
                      <div className="mb-3 rounded-lg border bg-card/60 p-3 text-xs space-y-1">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5 font-semibold text-emerald-700 dark:text-emerald-400">
                            <CalendarClock className="h-4 w-4" />
                            <span>WhatsApp Schedule</span>
                            <span
                              className={cn(
                                'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                                loan.reminderSchedule.enabled
                                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                                  : 'bg-muted text-muted-foreground'
                              )}
                            >
                              {loan.reminderSchedule.enabled ? 'Active' : 'Disabled'}
                            </span>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 text-xs text-primary hover:text-primary/80"
                            onClick={() => setScheduleLoan(loan)}
                          >
                            Configure
                          </Button>
                        </div>
                        <div className="text-muted-foreground">
                          Schedule:{' '}
                          <span className="font-medium text-foreground">
                            {describeLoanSchedule(loan.reminderSchedule)}
                          </span>
                        </div>
                        {loan.reminderSchedule.lastSentAt && (
                          <div className="text-muted-foreground">
                            Last sent:{' '}
                            <span className="font-medium text-foreground">
                              {new Date(loan.reminderSchedule.lastSentAt).toLocaleString('en-IN', {
                                dateStyle: 'medium',
                                timeStyle: 'short',
                              })}
                            </span>{' '}
                            (Sent {loan.reminderSchedule.sendsCount} time
                            {loan.reminderSchedule.sendsCount === 1 ? '' : 's'})
                          </div>
                        )}
                        {loan.reminderSchedule.stoppedReason && (
                          <div className="text-amber-700 dark:text-amber-400 font-medium pt-0.5">
                            {STOPPED_REASON_LABEL[loan.reminderSchedule.stoppedReason]}
                          </div>
                        )}
                      </div>
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

      {/* Add / Edit loan dialog */}
      <Dialog open={loanOpen} onOpenChange={(o) => { setLoanOpen(o); if (!o) resetLoanForm(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{editingLoan ? 'Edit Private Loan' : 'Add Private Loan'}</DialogTitle></DialogHeader>
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
                onClick={handleSaveLoan}
                disabled={!borrowerName || !principal || Number(principal) <= 0 || interestRatePct === '' || isSavingLoan}
              >
                {isSavingLoan ? 'Saving…' : editingLoan ? 'Update loan' : 'Save loan'}
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

      {/* WhatsApp schedule dialog */}
      <PrivateLoanScheduleDialog
        open={!!scheduleLoan}
        onOpenChange={(o) => !o && setScheduleLoan(null)}
        loan={scheduleLoan}
      />
    </div>
  );
}

/* =================================================== WhatsApp Schedule Dialog */

function PrivateLoanScheduleDialog({
  open,
  onOpenChange,
  loan,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loan: PrivateLoan | null;
}) {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(true);
  const [time, setTime] = useState('10:00');
  const [frequency, setFrequency] = useState<PrivateLoanReminderSchedule['frequency']>('DAILY');
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([1]);
  const [intervalDays, setIntervalDays] = useState(3);
  const [stopCondition, setStopCondition] = useState<PrivateLoanReminderSchedule['stopCondition']>('UNTIL_PAID');
  const [endDate, setEndDate] = useState('');
  const [maxSends, setMaxSends] = useState(5);

  const schedule = loan?.reminderSchedule ?? null;

  useEffect(() => {
    if (!open || !loan) return;
    if (loan.reminderSchedule) {
      const s = loan.reminderSchedule;
      setEnabled(s.enabled);
      setTime(`${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`);
      setFrequency(s.frequency);
      setDaysOfWeek(s.daysOfWeek.length > 0 ? s.daysOfWeek : [1]);
      setIntervalDays(s.intervalDays ?? 3);
      setStopCondition(s.stopCondition);
      setEndDate(s.endDate ? s.endDate.slice(0, 10) : '');
      setMaxSends(s.maxSends ?? 5);
    } else {
      setEnabled(true);
      setTime('10:00');
      setFrequency('DAILY');
      setDaysOfWeek([1]);
      setIntervalDays(3);
      setStopCondition('UNTIL_PAID');
      setEndDate('');
      setMaxSends(5);
    }
  }, [open, loan]);

  const toggleDay = (d: number) =>
    setDaysOfWeek((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));

  const valid =
    (frequency !== 'WEEKLY' || daysOfWeek.length > 0) &&
    (frequency !== 'INTERVAL' || (intervalDays >= 1 && intervalDays <= 365)) &&
    (stopCondition !== 'UNTIL_DATE' || !!endDate) &&
    (stopCondition !== 'AFTER_COUNT' || maxSends >= 1);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!loan) throw new Error('No loan selected');
      const [hStr, mStr] = time.split(':');
      return api<PrivateLoanReminderSchedule>(`/private-loans/${loan.id}/reminder-schedule`, {
        method: 'PUT',
        body: {
          enabled,
          hour: Number(hStr),
          minute: Number(mStr),
          frequency,
          daysOfWeek: frequency === 'WEEKLY' ? daysOfWeek : [],
          intervalDays: frequency === 'INTERVAL' ? intervalDays : undefined,
          stopCondition,
          endDate: stopCondition === 'UNTIL_DATE' ? endDate : undefined,
          maxSends: stopCondition === 'AFTER_COUNT' ? maxSends : undefined,
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['private-loans'] });
      toast.success('WhatsApp reminder schedule saved');
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!loan) throw new Error('No loan selected');
      return api(`/private-loans/${loan.id}/reminder-schedule`, { method: 'DELETE' });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['private-loans'] });
      toast.success('WhatsApp reminder schedule removed');
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const busy = saveMutation.isPending || deleteMutation.isPending;

  if (!loan) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-emerald-600">
            <CalendarClock className="h-5 w-5" />
            WhatsApp Schedule · {loan.borrowerName}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
            <div className="flex justify-between text-sm">
              <span className="font-semibold">{loan.borrowerName}</span>
              <span className="text-muted-foreground">{loan.phone || loan.phone2 || 'No phone'}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Automatically sends the WhatsApp loan statement (principal, accrued interest to date, and total payable) to the borrower on this schedule.
            </p>
          </div>

          {schedule && (schedule.lastSentAt || schedule.stoppedReason) && (
            <div className="rounded-lg border bg-card p-3 space-y-1 text-xs">
              {schedule.lastSentAt && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Last sent</span>
                  <span className="font-medium">
                    {new Date(schedule.lastSentAt).toLocaleString('en-IN', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Reminders sent</span>
                <span className="font-medium">{schedule.sendsCount}</span>
              </div>
              {schedule.stoppedReason && (
                <p className="text-amber-700 dark:text-amber-400 pt-1 font-medium">
                  {STOPPED_REASON_LABEL[schedule.stoppedReason]}
                </p>
              )}
            </div>
          )}

          {/* enabled toggle */}
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">Schedule active</Label>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled((v) => !v)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                enabled ? 'bg-green-600' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                  enabled ? 'translate-x-[22px]' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {/* time */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground">Time (IST)</Label>
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-32" />
          </div>

          {/* frequency */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground">Frequency</Label>
            <Select value={frequency} onValueChange={(v) => setFrequency(v as PrivateLoanReminderSchedule['frequency'])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="DAILY">Every day</SelectItem>
                <SelectItem value="WEEKLY">On specific days of the week</SelectItem>
                <SelectItem value="INTERVAL">Every N days</SelectItem>
              </SelectContent>
            </Select>

            {frequency === 'WEEKLY' && (
              <div className="flex flex-wrap gap-1 pt-1">
                {SCHEDULE_DOW_OPTIONS.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    onClick={() => toggleDay(d.value)}
                    className={`rounded px-2 py-1 text-xs font-medium ${
                      daysOfWeek.includes(d.value)
                        ? 'bg-green-600 text-white'
                        : 'bg-muted text-muted-foreground hover:bg-muted-foreground/20'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            )}
            {frequency === 'WEEKLY' && daysOfWeek.length === 0 && (
              <p className="text-xs text-rose-600 dark:text-rose-400">Pick at least one day.</p>
            )}

            {frequency === 'INTERVAL' && (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-xs text-muted-foreground">Every</span>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={intervalDays}
                  onChange={(e) => setIntervalDays(Number(e.target.value))}
                  className="h-8 w-20"
                />
                <span className="text-xs text-muted-foreground">day(s)</span>
              </div>
            )}
          </div>

          {/* stop condition */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground">Stop condition</Label>
            <Select
              value={stopCondition}
              onValueChange={(v) => setStopCondition(v as PrivateLoanReminderSchedule['stopCondition'])}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(STOP_CONDITION_LABEL) as PrivateLoanReminderSchedule['stopCondition'][]).map((k) => (
                  <SelectItem key={k} value={k}>{STOP_CONDITION_LABEL[k]}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {stopCondition === 'UNTIL_DATE' && (
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-40" />
            )}
            {stopCondition === 'AFTER_COUNT' && (
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  value={maxSends}
                  onChange={(e) => setMaxSends(Number(e.target.value))}
                  className="h-8 w-20"
                />
                <span className="text-xs text-muted-foreground">statement(s), then stop</span>
              </div>
            )}
            {stopCondition === 'MANUAL' && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                This will keep sending indefinitely, even after the loan is repaid, until you switch it off.
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={busy || !valid}
              className="flex-1 gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
            >
              {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save Schedule
            </Button>
            {schedule && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (confirm(`Remove the WhatsApp reminder schedule for ${loan.borrowerName}?`)) {
                    deleteMutation.mutate();
                  }
                }}
                className="gap-1.5 border-rose-500/40 text-rose-700 dark:text-rose-400 hover:bg-rose-500/10"
              >
                {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4 text-destructive" />}
              </Button>
            )}
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)} className="gap-1.5">
              <X className="h-4 w-4" /> Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
