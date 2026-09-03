import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Calendar,
  Clock,
  Send,
  CheckCircle2,
  RefreshCw,
  Search,
  Building2,
  CalendarClock,
  Save,
  X,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Phone,
  Check,
  SlidersHorizontal,
} from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { DueOnDateInvoice, DuesOnDateResponse } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/PageHeader';
import { toast } from 'sonner';

const DOW_OPTIONS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

function getTodayIstString(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function addDaysToDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

const PRODUCTS: { label: string; value: string }[] = [
  { label: 'All Products', value: 'ALL' },
  { label: 'Pappu', value: 'PAPPU' },
  { label: 'Husk', value: 'HUSK' },
  { label: 'Waste', value: 'WASTE' },
  { label: 'TPS (Brokens)', value: 'TPS' },
  { label: 'Shell', value: 'SHELL' },
  { label: 'Precleaner Dust', value: 'PRECLEANER_DUST' },
  { label: 'Nalla Pokkulu', value: 'NALLA_POKKULU' },
  { label: 'Nalla Chintapandu', value: 'NALLA_CHINTAPANDU' },
];

export default function DuesOnThisDay() {
  const qc = useQueryClient();
  const [selectedDate, setSelectedDate] = useState<string>(getTodayIstString());
  const [searchQuery, setSearchQuery] = useState('');
  const [productFilter, setProductFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'SENT' | 'PENDING'>('ALL');

  // Multi-selection state: Set of dispatch IDs
  const [selectedInvoices, setSelectedInvoices] = useState<Set<string>>(new Set());

  // Individual Send Modal state
  const [sendModalInvoice, setSendModalInvoice] = useState<DueOnDateInvoice | null>(null);
  const [sendModalTarget, setSendModalTarget] = useState<'PARTY' | 'BROKER' | 'BOTH'>('BOTH');

  // Bulk confirmation modal state
  const [showBulkConfirm, setShowBulkConfirm] = useState(false);
  const [bulkTarget, setBulkTarget] = useState<'PARTY' | 'BROKER' | 'BOTH'>('BOTH');

  // Schedule editor expansion
  const [showScheduleEditor, setShowScheduleEditor] = useState(false);
  const [scheduleTime, setScheduleTime] = useState('09:00');
  const [scheduleDays, setScheduleDays] = useState<number[]>([]);
  const [scheduleTarget, setScheduleTarget] = useState<'PARTY' | 'BROKER' | 'BOTH'>('BOTH');

  // Fetch dues data for the selected date
  const { data, isLoading, isRefetching, refetch } = useQuery<DuesOnDateResponse>({
    queryKey: ['dues-on-date', selectedDate],
    queryFn: () => api<DuesOnDateResponse>(`/whatsapp/dues-on-date?date=${selectedDate}`),
  });

  // Populate schedule state when data is loaded
  const initSchedule = () => {
    if (data?.schedule) {
      setScheduleTarget(data.schedule.target || 'BOTH');
      const parts = data.schedule.cron.trim().split(/\s+/);
      if (parts.length === 5) {
        const min = parts[0].padStart(2, '0');
        const hr = parts[1].padStart(2, '0');
        setScheduleTime(`${hr}:${min}`);
        const dow = parts[4];
        if (dow === '*') {
          setScheduleDays([]);
        } else {
          setScheduleDays(dow.split(',').map(Number));
        }
      }
    }
  };

  // Schedule mutation
  const updateScheduleMutation = useMutation({
    mutationFn: (body: { enabled?: boolean; hour?: number; minute?: number; days?: number[]; target?: string }) =>
      api('/whatsapp/dues-on-date/schedule', {
        method: 'PUT',
        body,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dues-on-date'] });
      qc.invalidateQueries({ queryKey: ['company'] });
      toast.success('Schedule configuration saved successfully');
      setShowScheduleEditor(false);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // Single send mutation
  const sendSingleMutation = useMutation({
    mutationFn: ({
      buyerId,
      dispatchIds,
      target,
    }: {
      buyerId: string;
      dispatchIds: string[];
      target: 'PARTY' | 'BROKER' | 'BOTH';
    }) =>
      api<{ ok: boolean; message: string }>('/whatsapp/dues-on-date/send-single', {
        method: 'POST',
        body: { buyerId, dispatchIds, target },
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['dues-on-date'] });
      toast.success(res.message || 'Payment reminder sent');
      setSendModalInvoice(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // Bulk send mutation
  const sendBulkMutation = useMutation({
    mutationFn: ({
      items,
      target,
      date,
    }: {
      items?: Array<{ buyerId: string; dispatchIds: string[] }>;
      target?: 'PARTY' | 'BROKER' | 'BOTH';
      date?: string;
    }) =>
      api<{ ok: boolean; message: string }>('/whatsapp/dues-on-date/send-bulk', {
        method: 'POST',
        body: { items, target, date },
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['dues-on-date'] });
      toast.success(res.message || 'Bulk reminders sent');
      setSelectedInvoices(new Set());
      setShowBulkConfirm(false);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // Filtered invoices
  const filteredInvoices = useMemo(() => {
    if (!data?.invoices) return [];
    return data.invoices.filter((inv) => {
      // Product filter
      if (productFilter !== 'ALL' && inv.product !== productFilter) return false;

      // Status filter
      if (statusFilter === 'SENT' && inv.lastSentStatus !== 'SENT') return false;
      if (statusFilter === 'PENDING' && inv.lastSentStatus === 'SENT') return false;

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const bName = inv.buyerName.toLowerCase();
        const brName = (inv.brokerName || '').toLowerCase();
        const invNo = inv.invoiceNumber.toLowerCase();
        const veh = (inv.vehicleNumber || '').toLowerCase();
        if (!bName.includes(q) && !brName.includes(q) && !invNo.includes(q) && !veh.includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [data?.invoices, productFilter, statusFilter, searchQuery]);

  // Selection handlers
  const allFilteredSelected =
    filteredInvoices.length > 0 && filteredInvoices.every((inv) => selectedInvoices.has(inv.dispatchId));

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedInvoices(new Set());
    } else {
      const next = new Set(selectedInvoices);
      filteredInvoices.forEach((inv) => next.add(inv.dispatchId));
      setSelectedInvoices(next);
    }
  };

  const toggleSelectOne = (dispatchId: string) => {
    const next = new Set(selectedInvoices);
    if (next.has(dispatchId)) next.delete(dispatchId);
    else next.add(dispatchId);
    setSelectedInvoices(next);
  };

  const selectedCount = selectedInvoices.size;
  const selectedTotalAmount = useMemo(() => {
    if (!data?.invoices) return 0;
    return data.invoices
      .filter((inv) => selectedInvoices.has(inv.dispatchId))
      .reduce((s, i) => s + i.outstanding, 0);
  }, [data?.invoices, selectedInvoices]);

  // Prepare grouped items for sending selected
  const handleSendSelected = (target: 'PARTY' | 'BROKER' | 'BOTH') => {
    if (!data?.invoices) return;
    const pickedInvoices = data.invoices.filter((inv) => selectedInvoices.has(inv.dispatchId));
    const byBuyer = new Map<string, { buyerId: string; dispatchIds: string[] }>();
    for (const inv of pickedInvoices) {
      let entry = byBuyer.get(inv.buyerId);
      if (!entry) {
        entry = { buyerId: inv.buyerId, dispatchIds: [] };
        byBuyer.set(inv.buyerId, entry);
      }
      entry.dispatchIds.push(inv.dispatchId);
    }
    const items = [...byBuyer.values()];
    sendBulkMutation.mutate({ items, target });
  };

  const isToday = selectedDate === getTodayIstString();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dues on this Day"
        description="Notify Party (Buyer) and Broker automatically or manually on the exact day payments are due."
        icon={CalendarClock}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 bg-background border rounded-lg px-3 py-1.5 shadow-sm">
              <div className="flex flex-col text-right">
                <span className="text-xs font-semibold">Auto-Reminders</span>
                <span className="text-[10px] text-muted-foreground">
                  {data?.schedule?.enabled ? 'Active' : 'Paused'}
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={data?.schedule?.enabled}
                aria-label="Toggle auto-send daily reminders"
                disabled={updateScheduleMutation.isPending || !data}
                onClick={() =>
                  updateScheduleMutation.mutate({ enabled: !data?.schedule?.enabled })
                }
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  data?.schedule?.enabled ? 'bg-emerald-600' : 'bg-muted-foreground/30'
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                    data?.schedule?.enabled ? 'translate-x-[22px]' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                initSchedule();
                setShowScheduleEditor(!showScheduleEditor);
              }}
              className="gap-1.5"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {showScheduleEditor ? 'Hide Timing' : 'Schedule & Timing'}
            </Button>

            <Button
              size="sm"
              className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={() => {
                setBulkTarget(data?.schedule?.target || 'BOTH');
                setShowBulkConfirm(true);
              }}
              disabled={!data || data.invoices.length === 0 || sendBulkMutation.isPending}
            >
              <Send className="h-3.5 w-3.5" />
              Send All Due on Date
            </Button>
          </div>
        }
      />

      {/* Schedule Summary Banner & Timing Editor */}
      <Card className="border-emerald-500/30 bg-gradient-to-br from-emerald-50/40 to-card dark:from-emerald-950/10">
        <CardContent className="p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs bg-muted/40 p-3 rounded-lg border">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex items-center gap-1.5">
                <Clock className="h-4 w-4 text-emerald-600" />
                <span className="text-muted-foreground">Auto-send schedule:</span>
                <span className="font-semibold text-foreground">
                  {data?.schedule ? data.schedule.schedule : '09:00 IST, every day'}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Building2 className="h-4 w-4 text-indigo-600" />
                <span className="text-muted-foreground">Recipients:</span>
                <Badge variant="secondary" className="font-medium text-[11px]">
                  {data?.schedule?.target === 'BOTH'
                    ? 'Both Party & Broker'
                    : data?.schedule?.target === 'BROKER'
                    ? 'Broker Only'
                    : 'Party Only'}
                </Badge>
              </div>
            </div>

            {data?.schedule?.lastSentAt && (
              <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                Sweep ran today: {new Date(data.schedule.lastSentAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
              </div>
            )}
          </div>

          {/* Collapsible Schedule Timing Editor */}
          {showScheduleEditor && (
            <div className="rounded-lg border bg-card p-4 space-y-4 shadow-sm animate-in fade-in duration-200">
              <div className="flex items-center justify-between border-b pb-2">
                <h4 className="text-sm font-semibold flex items-center gap-2">
                  <Clock className="h-4 w-4 text-emerald-600" />
                  Configure Automated Daily Timing & Recipients
                </h4>
                <Button variant="ghost" size="sm" onClick={() => setShowScheduleEditor(false)} className="h-7 w-7 p-0">
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Time picker */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold text-muted-foreground">Execution Time (IST)</Label>
                  <Input
                    type="time"
                    value={scheduleTime}
                    onChange={(e) => setScheduleTime(e.target.value)}
                    className="w-36 h-9"
                  />
                  <p className="text-[11px] text-muted-foreground">Every day at this hour in IST</p>
                </div>

                {/* Target selector */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold text-muted-foreground">Send Reminder To</Label>
                  <Select value={scheduleTarget} onValueChange={(v) => setScheduleTarget(v as 'PARTY' | 'BROKER' | 'BOTH')}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="BOTH">Both Party & Broker</SelectItem>
                      <SelectItem value="PARTY">Party (Buyer) Only</SelectItem>
                      <SelectItem value="BROKER">Broker Only</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">Approved PAYMENT_REMINDER template</p>
                </div>

                {/* Days of week */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold text-muted-foreground">Active Days</Label>
                  <div className="flex flex-wrap items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setScheduleDays([])}
                      className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                        scheduleDays.length === 0
                          ? 'bg-emerald-600 text-white'
                          : 'bg-muted text-muted-foreground hover:bg-muted-foreground/20'
                      }`}
                    >
                      Every day
                    </button>
                    {DOW_OPTIONS.map((d) => (
                      <button
                        key={d.value}
                        type="button"
                        onClick={() => {
                          setScheduleDays((prev) =>
                            prev.includes(d.value) ? prev.filter((x) => x !== d.value) : [...prev, d.value]
                          );
                        }}
                        className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                          scheduleDays.includes(d.value)
                            ? 'bg-emerald-600 text-white'
                            : 'bg-muted text-muted-foreground hover:bg-muted-foreground/20'
                        }`}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t">
                <Button variant="outline" size="sm" onClick={() => setShowScheduleEditor(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={updateScheduleMutation.isPending}
                  onClick={() => {
                    const [hStr, mStr] = scheduleTime.split(':');
                    const hour = Number(hStr);
                    const minute = Number(mStr);
                    updateScheduleMutation.mutate({
                      hour,
                      minute,
                      days: scheduleDays,
                      target: scheduleTarget,
                    });
                  }}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
                >
                  <Save className="h-3.5 w-3.5" />
                  {updateScheduleMutation.isPending ? 'Saving…' : 'Save Schedule'}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Date Filter & Search Strip */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 bg-card p-3 rounded-lg border shadow-sm">
        {/* Date Selector */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs font-semibold text-muted-foreground">Due Date:</span>
            <Input
              type="date"
              value={selectedDate}
              onChange={(e) => {
                if (e.target.value) setSelectedDate(e.target.value);
              }}
              className="w-38 h-8 text-xs font-medium"
            />
          </div>

          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedDate(addDaysToDateString(selectedDate, -1))}
              className="h-8 px-2 text-xs"
              title="Previous Day"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant={isToday ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => setSelectedDate(getTodayIstString())}
              className="h-8 text-xs font-medium"
            >
              Today
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedDate(addDaysToDateString(selectedDate, 1))}
              className="h-8 px-2 text-xs"
              title="Next Day"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* Filters & Search */}
        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
          <div className="relative flex-1 md:w-56">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-2.5 text-muted-foreground" />
            <Input
              placeholder="Search buyer, broker, inv #..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>

          <Select value={productFilter} onValueChange={setProductFilter}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRODUCTS.map((p) => (
                <SelectItem key={p.value} value={p.value} className="text-xs">
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL" className="text-xs">All Statuses</SelectItem>
              <SelectItem value="PENDING" className="text-xs">Pending Only</SelectItem>
              <SelectItem value="SENT" className="text-xs">Sent Today</SelectItem>
            </SelectContent>
          </Select>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => refetch()}
            disabled={isLoading || isRefetching}
            className="h-8 w-8 p-0"
            title="Refresh"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRefetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* KPI Stat Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Card className="p-3 bg-card/60">
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Total Dues</p>
          <p className="text-lg font-bold text-foreground tabular-nums mt-0.5">
            {isLoading ? '…' : rupees(data?.stats.totalAmount || 0)}
          </p>
        </Card>
        <Card className="p-3 bg-card/60">
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Invoices Due</p>
          <p className="text-lg font-bold text-foreground tabular-nums mt-0.5">
            {isLoading ? '…' : data?.stats.totalInvoices || 0}
          </p>
        </Card>
        <Card className="p-3 bg-card/60">
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Buyers</p>
          <p className="text-lg font-bold text-foreground tabular-nums mt-0.5">
            {isLoading ? '…' : data?.stats.buyersCount || 0}
          </p>
        </Card>
        <Card className="p-3 bg-card/60">
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Brokers</p>
          <p className="text-lg font-bold text-foreground tabular-nums mt-0.5">
            {isLoading ? '…' : data?.stats.brokersCount || 0}
          </p>
        </Card>
        <Card className="p-3 bg-card/60">
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Reminders Sent Today</p>
          <p className="text-lg font-bold text-emerald-600 dark:text-emerald-400 tabular-nums mt-0.5 flex items-center gap-1.5">
            {isLoading ? '…' : `${data?.stats.sentTodayCount || 0} of ${data?.stats.buyersCount || 0}`}
          </p>
        </Card>
      </div>

      {/* Invoices List / Table */}
      <Card>
        <CardHeader className="py-3 px-4 flex flex-row items-center justify-between border-b">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">
              Invoices Due on {shortDate(selectedDate)}
            </h3>
            <Badge variant="secondary" className="text-xs">
              {filteredInvoices.length} {filteredInvoices.length === 1 ? 'bill' : 'bills'}
            </Badge>
          </div>

          {filteredInvoices.length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              <label className="flex items-center gap-1.5 cursor-pointer font-medium select-none">
                <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  onChange={toggleSelectAll}
                  className="w-3.5 h-3.5 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                />
                Select All
              </label>
            </div>
          )}
        </CardHeader>

        <CardContent className="p-0">
          {isLoading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Loading dues data for {selectedDate}…
            </div>
          ) : filteredInvoices.length === 0 ? (
            <div className="py-12 text-center space-y-2">
              <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto opacity-70" />
              <p className="text-sm font-semibold text-foreground">No bills due on this date</p>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                {searchQuery || productFilter !== 'ALL' || statusFilter !== 'ALL'
                  ? 'No invoices match your current filter criteria.'
                  : `There are no outstanding sales invoices with due date ${shortDate(selectedDate)}.`}
              </p>
            </div>
          ) : (
            <div className="divide-y overflow-x-auto">
              {filteredInvoices.map((inv) => {
                const isSelected = selectedInvoices.has(inv.dispatchId);
                const isSentToday = inv.lastSentStatus === 'SENT';

                return (
                  <div
                    key={inv.dispatchId}
                    className={`p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 transition-colors hover:bg-muted/30 ${
                      isSelected ? 'bg-emerald-50/40 dark:bg-emerald-950/20' : ''
                    }`}
                  >
                    {/* Left: Checkbox + Invoice Details */}
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelectOne(inv.dispatchId)}
                        className="w-4 h-4 mt-1 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 shrink-0"
                      />

                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm text-foreground">{inv.buyerName}</span>
                          <Badge variant="outline" className="text-[10px] font-mono">
                            {inv.invoiceNumber}
                          </Badge>
                          <Badge variant="secondary" className="text-[10px]">
                            {inv.product}
                          </Badge>
                          {inv.partiallyPaid && (
                            <Badge variant="warning" className="text-[10px]">
                              Partially Paid
                            </Badge>
                          )}
                        </div>

                        {/* Broker & Vehicle metadata */}
                        <div className="flex flex-wrap items-center gap-y-1 gap-x-3 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Building2 className="h-3 w-3 text-muted-foreground" />
                            {inv.brokerName ? `Broker: ${inv.brokerName}` : 'Direct (No Broker)'}
                          </span>
                          {inv.vehicleNumber && <span>Vehicle: {inv.vehicleNumber}</span>}
                          <span>Term: {inv.dueDays}d credit</span>
                        </div>

                        {/* Contacts line */}
                        <div className="flex flex-wrap items-center gap-x-3 text-[11px] text-muted-foreground">
                          {inv.buyerPhone && (
                            <span className="flex items-center gap-1">
                              <Phone className="h-3 w-3" /> Party: {inv.buyerPhone}
                            </span>
                          )}
                          {inv.brokerPhone && (
                            <span className="flex items-center gap-1">
                              <Phone className="h-3 w-3" /> Broker: {inv.brokerPhone}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Middle: Amount & Due date */}
                    <div className="flex md:flex-col items-baseline md:items-end justify-between md:justify-center gap-1 shrink-0">
                      <div className="text-right">
                        <div className="text-sm font-bold text-foreground tabular-nums">
                          {rupees(inv.outstanding)}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          Billed: {rupees(inv.billAmount)}
                        </div>
                      </div>

                      {/* Status Tag */}
                      <div>
                        {isSentToday ? (
                          <Badge className="text-[10px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 gap-1">
                            <Check className="h-3 w-3" />
                            Sent {inv.lastSentAt ? new Date(inv.lastSentAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : 'Today'}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">
                            Not Sent Today
                          </Badge>
                        )}
                      </div>
                    </div>

                    {/* Right: Actions */}
                    <div className="flex items-center gap-2 shrink-0 pt-2 md:pt-0 border-t md:border-t-0">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setSendModalInvoice(inv);
                          setSendModalTarget(inv.brokerId ? 'BOTH' : 'PARTY');
                        }}
                        disabled={sendSingleMutation.isPending}
                        className="gap-1.5 border-emerald-500/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10"
                      >
                        <Send className="h-3.5 w-3.5" />
                        Send Reminder
                      </Button>

                      <a
                        href={`/party-ledger?partyId=${inv.buyerId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center justify-center p-2 rounded-md border text-muted-foreground hover:text-foreground hover:bg-muted"
                        title="Open Party Ledger"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Floating / Sticky Batch Action Bar */}
      {selectedCount > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-11/12 max-w-2xl bg-card border-2 border-emerald-500/50 shadow-2xl rounded-xl p-3 flex flex-col sm:flex-row items-center justify-between gap-3 animate-in slide-in-from-bottom-5">
          <div className="flex items-center gap-2">
            <Badge className="bg-emerald-600 text-white font-bold">{selectedCount}</Badge>
            <div className="text-xs">
              <span className="font-semibold text-foreground">
                {selectedCount} invoice{selectedCount === 1 ? '' : 's'} selected
              </span>
              <span className="text-muted-foreground ml-1">({rupees(selectedTotalAmount)})</span>
            </div>
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <Select value={bulkTarget} onValueChange={(v) => setBulkTarget(v as any)}>
              <SelectTrigger className="h-8 text-xs w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="BOTH">Send Both</SelectItem>
                <SelectItem value="PARTY">Party Only</SelectItem>
                <SelectItem value="BROKER">Broker Only</SelectItem>
              </SelectContent>
            </Select>

            <Button
              size="sm"
              onClick={() => handleSendSelected(bulkTarget)}
              disabled={sendBulkMutation.isPending}
              className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5 font-semibold"
            >
              <Send className="h-3.5 w-3.5" />
              {sendBulkMutation.isPending ? 'Sending…' : 'Send Selected'}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedInvoices(new Set())}
              className="h-8 w-8 p-0"
              title="Deselect All"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Individual Send Reminder Modal Dialog */}
      {sendModalInvoice && (
        <Dialog open={!!sendModalInvoice} onOpenChange={(open) => !open && setSendModalInvoice(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-emerald-600">
                <Send className="h-5 w-5" />
                Send Payment Reminder
              </DialogTitle>
              <DialogDescription>
                Send the official WhatsApp payment reminder quoting the due bill.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2 text-xs">
              <div className="rounded-lg border bg-muted/40 p-3 space-y-1.5">
                <div className="font-semibold text-sm text-foreground">{sendModalInvoice.buyerName}</div>
                <div className="flex items-baseline justify-between">
                  <span className="text-muted-foreground">Invoice #{sendModalInvoice.invoiceNumber}</span>
                  <span className="font-bold text-sm tabular-nums">{rupees(sendModalInvoice.outstanding)}</span>
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Product: {sendModalInvoice.product} · Due: {shortDate(sendModalInvoice.dueDate)}
                </div>
              </div>

              {/* Target recipient radio / dropdown */}
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-muted-foreground">Send Reminder To</Label>
                <Select value={sendModalTarget} onValueChange={(v) => setSendModalTarget(v as any)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PARTY">Party Only ({sendModalInvoice.buyerName})</SelectItem>
                    {sendModalInvoice.brokerId && (
                      <>
                        <SelectItem value="BROKER">Broker Only ({sendModalInvoice.brokerName})</SelectItem>
                        <SelectItem value="BOTH">Both Party & Broker</SelectItem>
                      </>
                    )}
                  </SelectContent>
                </Select>
              </div>

              {/* Recipient breakdown list */}
              <div className="rounded-lg border p-3 space-y-2 bg-card">
                {(sendModalTarget === 'PARTY' || sendModalTarget === 'BOTH') && (
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold">{sendModalInvoice.buyerName} (Party)</div>
                      <div className="text-muted-foreground">{rupees(sendModalInvoice.outstanding)}</div>
                    </div>
                    <span className="font-mono text-muted-foreground">
                      {sendModalInvoice.buyerPhone || 'No phone'}
                    </span>
                  </div>
                )}
                {(sendModalTarget === 'BROKER' || sendModalTarget === 'BOTH') && sendModalInvoice.brokerName && (
                  <div className="flex items-center justify-between pt-1 border-t">
                    <div>
                      <div className="font-semibold">{sendModalInvoice.brokerName} (Broker)</div>
                      <div className="text-muted-foreground">for {sendModalInvoice.buyerName}</div>
                    </div>
                    <span className="font-mono text-muted-foreground">
                      {sendModalInvoice.brokerPhone || 'No phone'}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setSendModalInvoice(null)}>
                Cancel
              </Button>
              <Button
                onClick={() =>
                  sendSingleMutation.mutate({
                    buyerId: sendModalInvoice.buyerId,
                    dispatchIds: [sendModalInvoice.dispatchId],
                    target: sendModalTarget,
                  })
                }
                disabled={sendSingleMutation.isPending}
                className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
              >
                <Send className="h-3.5 w-3.5" />
                {sendSingleMutation.isPending ? 'Sending…' : 'Send WhatsApp Message'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Bulk Send All Confirmation Modal */}
      {showBulkConfirm && (
        <Dialog open={showBulkConfirm} onOpenChange={setShowBulkConfirm}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-emerald-600">
                <Send className="h-5 w-5" />
                Send All Dues on {shortDate(selectedDate)}
              </DialogTitle>
              <DialogDescription>
                This will send payment reminders to all parties and brokers with invoices due on this date.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2 text-xs">
              <div className="rounded-lg border bg-muted/40 p-3 space-y-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total Invoices Due:</span>
                  <span className="font-semibold">{data?.stats.totalInvoices || 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total Buyers:</span>
                  <span className="font-semibold">{data?.stats.buyersCount || 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total Outstanding:</span>
                  <span className="font-bold text-sm text-foreground">{rupees(data?.stats.totalAmount || 0)}</span>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-muted-foreground">Send To</Label>
                <Select value={bulkTarget} onValueChange={(v) => setBulkTarget(v as any)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="BOTH">Both Party & Broker</SelectItem>
                    <SelectItem value="PARTY">Party Only</SelectItem>
                    <SelectItem value="BROKER">Broker Only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setShowBulkConfirm(false)}>
                Cancel
              </Button>
              <Button
                onClick={() =>
                  sendBulkMutation.mutate({
                    date: selectedDate,
                    target: bulkTarget,
                  })
                }
                disabled={sendBulkMutation.isPending}
                className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5 font-semibold"
              >
                <Send className="h-3.5 w-3.5" />
                {sendBulkMutation.isPending ? 'Sending…' : 'Confirm & Send All'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
