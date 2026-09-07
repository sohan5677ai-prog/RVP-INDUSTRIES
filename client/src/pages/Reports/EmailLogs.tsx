import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Mail,
  CheckCircle2,
  Eye,
  AlertTriangle,
  RotateCw,
  Search,
  FilterX,
  Clock,
  Send,
  CheckCheck,
  AlertOctagon,
  MousePointerClick,
  FileText,
  Truck,
  FileMinus2,
  Building2,
} from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { EmailLog, EmailDocumentType, Party } from '@/lib/types';
import { shortDate } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDebounce } from '@/lib/useDebounce';
import { usePagedRows } from '@/lib/usePagedRows';
import { PaginationBar } from '@/components/ui/pagination-bar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';

const DOC_TYPE_LABELS: Record<EmailDocumentType, { label: string; icon: typeof FileText }> = {
  INVOICE: { label: 'Tax Invoice', icon: FileText },
  EWB: { label: 'E-Way Bill', icon: Truck },
  CREDIT_NOTE: { label: 'Credit Note', icon: FileMinus2 },
  DEBIT_NOTE: { label: 'Debit Note', icon: FileMinus2 },
};

function formatDateTime(isoStr: string) {
  try {
    const d = new Date(isoStr);
    return d.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return shortDate(isoStr);
  }
}

function formatTime(isoStr?: string | null) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '';
  }
}

export default function EmailLogs() {
  const qc = useQueryClient();

  // Filters state
  const [search, setSearch] = useState('');
  const [selectedPartyId, setSelectedPartyId] = useState<string>('all');
  const [selectedDocType, setSelectedDocType] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const debouncedSearch = useDebounce(search, 300);

  // Fetch parties for the filter dropdown
  const { data: parties } = useQuery({
    queryKey: ['parties-compact'],
    queryFn: () => api<Party[]>('/parties'),
    staleTime: 5 * 60 * 1000,
  });

  // Query params for email logs
  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
    if (selectedPartyId !== 'all') params.set('partyId', selectedPartyId);
    if (selectedDocType !== 'all') params.set('documentType', selectedDocType);
    if (selectedStatus !== 'all') params.set('status', selectedStatus);
    if (fromDate) params.set('fromDate', fromDate);
    if (toDate) params.set('toDate', toDate);
    return params.toString();
  }, [debouncedSearch, selectedPartyId, selectedDocType, selectedStatus, fromDate, toDate]);

  // Fetch filtered email logs
  const { data: emailLogs, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['email-logs', queryParams],
    queryFn: () => api<EmailLog[]>(`/email-logs?${queryParams}`),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows: visibleLogs } = usePagedRows(emailLogs ?? [], 25);

  // Resend mutation
  const resendMutation = useMutation({
    mutationFn: (id: string) => api(`/email-logs/${id}/resend`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Email resent successfully');
      qc.invalidateQueries({ queryKey: ['email-logs'] });
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // Compute Metrics from all currently loaded logs
  const metrics = useMemo(() => {
    if (!emailLogs) return { total: 0, delivered: 0, opened: 0, failed: 0 };
    const total = emailLogs.length;
    const delivered = emailLogs.filter((l) => ['DELIVERED', 'OPENED', 'CLICKED'].includes(l.status)).length;
    const opened = emailLogs.filter((l) => ['OPENED', 'CLICKED'].includes(l.status)).length;
    const failed = emailLogs.filter((l) => ['FAILED', 'BOUNCED', 'COMPLAINED'].includes(l.status)).length;
    return { total, delivered, opened, failed };
  }, [emailLogs]);

  const hasActiveFilters =
    search.trim() !== '' ||
    selectedPartyId !== 'all' ||
    selectedDocType !== 'all' ||
    selectedStatus !== 'all' ||
    fromDate !== '' ||
    toDate !== '';

  const handleResetFilters = () => {
    setSearch('');
    setSelectedPartyId('all');
    setSelectedDocType('all');
    setSelectedStatus('all');
    setFromDate('');
    setToDate('');
  };

  const renderStatusBadge = (log: EmailLog) => {
    switch (log.status) {
      case 'OPENED':
        return (
          <div className="flex flex-col items-start gap-1">
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
              <Eye className="w-3 h-3 text-purple-600 dark:text-purple-400" /> Opened
            </span>
            {log.openedAt && (
              <span className="text-[11px] text-muted-foreground">
                at {formatTime(log.openedAt)}
              </span>
            )}
          </div>
        );
      case 'CLICKED':
        return (
          <div className="flex flex-col items-start gap-1">
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
              <MousePointerClick className="w-3 h-3 text-indigo-600 dark:text-indigo-400" /> Clicked
            </span>
            {log.clickedAt && (
              <span className="text-[11px] text-muted-foreground">
                at {formatTime(log.clickedAt)}
              </span>
            )}
          </div>
        );
      case 'DELIVERED':
        return (
          <div className="flex flex-col items-start gap-1">
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
              <CheckCheck className="w-3 h-3 text-emerald-600 dark:text-emerald-400" /> Delivered
            </span>
            {log.deliveredAt && (
              <span className="text-[11px] text-muted-foreground">
                at {formatTime(log.deliveredAt)}
              </span>
            )}
          </div>
        );
      case 'SENT':
        return (
          <div className="flex flex-col items-start gap-1">
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
              <Send className="w-3 h-3 text-blue-600 dark:text-blue-400" /> Sent
            </span>
            <span className="text-[11px] text-muted-foreground">In transit</span>
          </div>
        );
      case 'BOUNCED':
        return (
          <div className="flex flex-col items-start gap-1">
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
              <AlertOctagon className="w-3 h-3 text-amber-600 dark:text-amber-400" /> Bounced
            </span>
            {log.errorMessage && (
              <span className="text-[10px] text-destructive max-w-[200px] truncate" title={log.errorMessage}>
                {log.errorMessage}
              </span>
            )}
          </div>
        );
      case 'FAILED':
      case 'COMPLAINED':
      default:
        return (
          <div className="flex flex-col items-start gap-1">
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300 border border-red-200 dark:border-red-800">
              <AlertTriangle className="w-3 h-3 text-red-600 dark:text-red-400" /> {log.status}
            </span>
            {log.errorMessage && (
              <span className="text-[10px] text-destructive max-w-[200px] truncate" title={log.errorMessage}>
                {log.errorMessage}
              </span>
            )}
          </div>
        );
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <PageHeader
        title="Email Logs & Delivery Tracking"
        description="Monitor real-time delivery status, open tracking, and dispatch history for all emailed documents."
        icon={Mail}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="gap-1.5 shadow-sm"
          >
            <RotateCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        }
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="shadow-sm border border-border/80">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Total Sent</p>
              <h3 className="text-2xl font-bold mt-1 text-foreground">{metrics.total}</h3>
            </div>
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
              <Mail className="w-5 h-5" />
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm border border-border/80">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Delivered</p>
              <div className="flex items-baseline gap-2 mt-1">
                <h3 className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{metrics.delivered}</h3>
                {metrics.total > 0 && (
                  <span className="text-xs font-medium text-muted-foreground">
                    ({Math.round((metrics.delivered / metrics.total) * 100)}%)
                  </span>
                )}
              </div>
            </div>
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="w-5 h-5" />
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm border border-border/80">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Opened</p>
              <div className="flex items-baseline gap-2 mt-1">
                <h3 className="text-2xl font-bold text-purple-600 dark:text-purple-400">{metrics.opened}</h3>
                {metrics.delivered > 0 && (
                  <span className="text-xs font-medium text-muted-foreground">
                    ({Math.round((metrics.opened / metrics.delivered) * 100)}% of del.)
                  </span>
                )}
              </div>
            </div>
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center text-purple-600 dark:text-purple-400">
              <Eye className="w-5 h-5" />
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm border border-border/80">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Failed / Bounced</p>
              <h3 className="text-2xl font-bold mt-1 text-red-600 dark:text-red-400">{metrics.failed}</h3>
            </div>
            <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center text-red-600 dark:text-red-400">
              <AlertTriangle className="w-5 h-5" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filter Bar */}
      <div className="bg-card rounded-xl border border-border/80 p-4 shadow-sm space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
          {/* Search Box */}
          <div className="lg:col-span-2 relative">
            <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search reference #, recipient, subject..."
              className="pl-9 h-9"
            />
          </div>

          {/* Party Dropdown */}
          <div>
            <Select value={selectedPartyId} onValueChange={setSelectedPartyId}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="All Parties" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Parties</SelectItem>
                {parties?.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Document Type Dropdown */}
          <div>
            <Select value={selectedDocType} onValueChange={setSelectedDocType}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="All Documents" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Documents</SelectItem>
                <SelectItem value="INVOICE">Tax Invoice</SelectItem>
                <SelectItem value="EWB">E-Way Bill</SelectItem>
                <SelectItem value="CREDIT_NOTE">Credit Note</SelectItem>
                <SelectItem value="DEBIT_NOTE">Debit Note</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Status Dropdown */}
          <div>
            <Select value={selectedStatus} onValueChange={setSelectedStatus}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="SENT">Sent</SelectItem>
                <SelectItem value="DELIVERED">Delivered</SelectItem>
                <SelectItem value="OPENED">Opened</SelectItem>
                <SelectItem value="CLICKED">Clicked</SelectItem>
                <SelectItem value="BOUNCED">Bounced</SelectItem>
                <SelectItem value="FAILED">Failed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Date Pickers / Clear */}
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="h-9 text-xs"
              title="From date"
            />
            <span className="text-muted-foreground text-xs">to</span>
            <Input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="h-9 text-xs"
              title="To date"
            />
          </div>
        </div>

        {hasActiveFilters && (
          <div className="flex justify-end pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleResetFilters}
              className="text-xs text-muted-foreground hover:text-foreground h-7 gap-1"
            >
              <FilterX className="w-3.5 h-3.5" /> Clear Filters
            </Button>
          </div>
        )}
      </div>

      {/* Logs Table */}
      <div className="rounded-xl border border-border/80 bg-card shadow-sm overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="w-[180px]">Date & Time</TableHead>
              <TableHead className="min-w-[200px]">Party / Recipient</TableHead>
              <TableHead className="w-[180px]">Document</TableHead>
              <TableHead className="min-w-[240px]">Subject</TableHead>
              <TableHead className="w-[150px]">Delivery Status</TableHead>
              <TableHead className="w-[110px] text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                  <div className="flex items-center justify-center gap-2">
                    <RotateCw className="w-4 h-4 animate-spin" /> Loading email logs...
                  </div>
                </TableCell>
              </TableRow>
            ) : !emailLogs || emailLogs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                  <Mail className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p className="font-medium">No email logs found</p>
                  <p className="text-xs mt-1">
                    {hasActiveFilters ? 'Try adjusting or clearing your filters.' : 'Emails sent from invoices or notes will appear here.'}
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              visibleLogs.map((log) => {
                const docConfig = DOC_TYPE_LABELS[log.documentType] || { label: log.documentType, icon: FileText };
                const DocIcon = docConfig.icon;

                return (
                  <TableRow key={log.id} className="hover:bg-muted/30 transition-colors">
                    {/* Timestamp */}
                    <TableCell className="align-top py-3">
                      <div className="flex items-center gap-1.5 text-xs text-foreground font-medium">
                        <Clock className="w-3.5 h-3.5 text-muted-foreground" />
                        {formatDateTime(log.sentAt)}
                      </div>
                    </TableCell>

                    {/* Party & Recipient */}
                    <TableCell className="align-top py-3">
                      <div className="flex items-start gap-1.5">
                        <Building2 className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                        <div>
                          <div className="font-semibold text-sm text-foreground">
                            {log.party?.name ?? 'Unknown Party'}
                          </div>
                          <div className="text-xs text-muted-foreground font-mono mt-0.5">
                            {log.recipientEmail}
                          </div>
                        </div>
                      </div>
                    </TableCell>

                    {/* Document */}
                    <TableCell className="align-top py-3">
                      <div className="space-y-1">
                        <Badge variant="outline" className="text-xs font-normal gap-1 inline-flex py-0.5">
                          <DocIcon className="w-3 h-3 text-muted-foreground" />
                          {docConfig.label}
                        </Badge>
                        <div className="text-xs font-mono font-medium text-foreground">
                          {log.referenceLabel}
                        </div>
                      </div>
                    </TableCell>

                    {/* Subject */}
                    <TableCell className="align-top py-3">
                      <div className="text-xs text-foreground line-clamp-2" title={log.subject}>
                        {log.subject}
                      </div>
                    </TableCell>

                    {/* Status */}
                    <TableCell className="align-top py-3">
                      {renderStatusBadge(log)}
                    </TableCell>

                    {/* Resend Action */}
                    <TableCell className="align-top py-3 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={resendMutation.isPending}
                        onClick={() => resendMutation.mutate(log.id)}
                        className="h-8 text-xs gap-1.5 shadow-sm hover:bg-primary hover:text-primary-foreground transition-all"
                      >
                        <Send className="w-3 h-3" /> Resend
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
        <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
      </div>
    </div>
  );
}
