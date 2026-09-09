import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  FileText,
  Truck,
  Printer,
  Search,
  Mail,
  RefreshCw,
  AlertTriangle,
  Clock,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  ArrowDownLeft,
  Building2,
  Info,
} from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { shortDate, rupees } from '@/lib/format';
import { dispatchTotal } from '@/lib/saleStatus';
import { useDebounce } from '@/lib/useDebounce';
import { usePagedRows } from '@/lib/usePagedRows';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { PageHeader } from '@/components/PageHeader';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import type { SaleDispatch, EmailLog, CompanyProfile } from '@/lib/types';

interface TaxproReportData {
  sales: SaleDispatch[];
  purchases: any[];
}

interface InwardEwbItem {
  ewbNo: number | string;
  ewbDate: string;
  genGstin?: string;
  docNo: string;
  docDate: string;
  fromGstin?: string;
  fromTrdName?: string;
  toGstin?: string;
  totalValue: number;
  validUpto: string;
  status: string;
  rejectStatus?: string;
}

const DOC_TYPE_LABEL: Record<EmailLog['documentType'], string> = {
  INVOICE: 'Tax Invoice',
  EWB: 'E-Way Bill',
  CREDIT_NOTE: 'Credit Note',
  DEBIT_NOTE: 'Debit Note',
};

function getYesterdayDdMmYyyy() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

export default function IrnEwbReport() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  // Filter & Search
  const [searchQuery, setSearchQuery] = useState('');

  // Company profile for live mode / sandbox indicator
  const { data: company } = useQuery<CompanyProfile>({
    queryKey: ['company'],
    queryFn: () => api<CompanyProfile>('/settings/company'),
  });

  // Main Report Query
  const { data, isLoading } = useQuery<TaxproReportData>({
    queryKey: ['taxpro-report'],
    queryFn: () => api<TaxproReportData>('/taxpro/list'),
  });

  const { data: emailLogs, isLoading: loadingLogs } = useQuery({
    queryKey: ['email-logs'],
    queryFn: () => api<EmailLog[]>('/email-logs'),
  });

  // Inward E-Way Bills (Purchases) State & Query - Default to yesterday because NIC blocks today's inward query (NIC 366)
  const [inwardDate, setInwardDate] = useState(getYesterdayDdMmYyyy());
  const {
    data: inwardData,
    isLoading: loadingInward,
    refetch: refetchInward,
  } = useQuery<{ success: boolean; data: any }>({
    queryKey: ['inward-ewb', inwardDate],
    queryFn: () => api<{ success: boolean; data: any }>(`/taxpro/inward-ewb?date=${encodeURIComponent(inwardDate)}`),
    enabled: false,
  });

  // Transporter Lookup State
  const [transporterGstin, setTransporterGstin] = useState('');
  const [transporterResult, setTransporterResult] = useState<any>(null);
  const [loadingTransporter, setLoadingTransporter] = useState(false);

  // Modals State
  const [liveInfo, setLiveInfo] = useState<{ title: string; data: any } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<{ dispatch: SaleDispatch; type: 'einvoice' | 'ewaybill' } | null>(null);
  const [cancelReason, setCancelReason] = useState('1');
  const [cancelRemarks, setCancelRemarks] = useState('');
  const [cancelCascade, setCancelCascade] = useState(true);

  const [updateVehTarget, setUpdateVehTarget] = useState<SaleDispatch | null>(null);
  const [newVehicleNo, setNewVehicleNo] = useState('');
  const [vehFromPlace, setVehFromPlace] = useState('');
  const [vehFromState, setVehFromState] = useState<number>(37);
  const [vehReasonCode, setVehReasonCode] = useState('1');
  const [vehReasonRem, setVehReasonRem] = useState('');

  const [extendValTarget, setExtendValTarget] = useState<SaleDispatch | null>(null);
  const [extRemainingDist, setExtRemainingDist] = useState<number>(100);
  const [extFromPlace, setExtFromPlace] = useState('');
  const [extFromPincode, setExtFromPincode] = useState<number>(516001);
  const [extRsnCode, setExtRsnCode] = useState<number>(4);
  const [extRemarks, setExtRemarks] = useState('');

  const [rejectEwbNo, setRejectEwbNo] = useState<string | number | null>(null);

  // Email Resend
  const resendMutation = useMutation({
    mutationFn: (id: string) => api(`/email-logs/${id}/resend`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Email resent');
      qc.invalidateQueries({ queryKey: ['email-logs'] });
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const sendInvoiceEmailMutation = useMutation({
    mutationFn: (id: string) => api(`/sale-dispatches/${id}/einvoice/email`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Document bundle emailed to buyer (CC broker, BCC company)');
      qc.invalidateQueries({ queryKey: ['email-logs'] });
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const sendEwbEmailMutation = useMutation({
    mutationFn: (id: string) => api(`/sale-dispatches/${id}/ewaybill/email`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Document bundle emailed to buyer (CC broker, BCC company)');
      qc.invalidateQueries({ queryKey: ['email-logs'] });
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // Cancel Mutations
  const cancelIrnMutation = useMutation({
    mutationFn: () =>
      api(`/sale-dispatches/${cancelTarget!.dispatch.id}/einvoice/cancel`, {
        method: 'POST',
        body: { cancelReason, cancelRemarks: cancelRemarks.trim() || 'Cancelled per order revision', forceCascade: cancelCascade },
      }),
    onSuccess: () => {
      toast.success('E-Invoice (IRN) cancelled successfully');
      qc.invalidateQueries({ queryKey: ['taxpro-report'] });
      setCancelTarget(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const cancelEwbMutation = useMutation({
    mutationFn: () =>
      api(`/sale-dispatches/${cancelTarget!.dispatch.id}/ewaybill/cancel`, {
        method: 'POST',
        body: { cancelReason, cancelRemarks: cancelRemarks.trim() || 'Cancelled per transport change' },
      }),
    onSuccess: () => {
      toast.success('E-Way Bill cancelled successfully');
      qc.invalidateQueries({ queryKey: ['taxpro-report'] });
      setCancelTarget(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // Vehicle Update Mutation
  const updateVehMutation = useMutation({
    mutationFn: () =>
      api(`/sale-dispatches/${updateVehTarget!.id}/ewaybill/update-vehicle`, {
        method: 'POST',
        body: {
          vehicleNo: newVehicleNo.trim().toUpperCase(),
          fromPlace: vehFromPlace.trim(),
          fromState: vehFromState,
          reasonCode: vehReasonCode,
          reasonRemark: vehReasonRem.trim() || 'Vehicle updated in transit',
        },
      }),
    onSuccess: () => {
      toast.success('Vehicle number updated on government portal');
      qc.invalidateQueries({ queryKey: ['taxpro-report'] });
      setUpdateVehTarget(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // Extend Validity Mutation
  const extendValMutation = useMutation({
    mutationFn: () =>
      api(`/sale-dispatches/${extendValTarget!.id}/ewaybill/extend-validity`, {
        method: 'POST',
        body: {
          vehicleNo: extendValTarget!.vehicleNumber || 'AP04TT1234',
          fromPlace: extFromPlace.trim(),
          fromPincode: extFromPincode,
          remainingDistance: extRemainingDist,
          extnReasonCode: extRsnCode,
          extnRemarks: extRemarks.trim() || 'Transit delay extension',
        },
      }),
    onSuccess: () => {
      toast.success('E-Way Bill validity extended on government portal');
      qc.invalidateQueries({ queryKey: ['taxpro-report'] });
      setExtendValTarget(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // Reject Inward EWB Mutation
  const rejectEwbMutation = useMutation({
    mutationFn: (ewbNo: string | number) =>
      api('/taxpro/reject-ewb', {
        method: 'POST',
        body: { ewbNo },
      }),
    onSuccess: () => {
      toast.success('Inward E-Way Bill rejected on portal');
      setRejectEwbNo(null);
      refetchInward();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // Live Sync Handlers
  async function handleLiveSync(d: SaleDispatch, type: 'IRN' | 'EWB') {
    try {
      const endpoint = type === 'IRN'
        ? `/sale-dispatches/${d.id}/einvoice/live-status`
        : `/sale-dispatches/${d.id}/ewaybill/live-status`;
      const res = await api<{ success: boolean; data: any }>(endpoint);
      setLiveInfo({
        title: `Live Portal Status - ${type} (${type === 'IRN' ? (d.invoiceNumber || 'Invoice') : (d.ewbNumber || 'EWB')})`,
        data: res.data,
      });
      qc.invalidateQueries({ queryKey: ['taxpro-report'] });
    } catch (e: any) {
      toast.error(getErrorMessage(e));
    }
  }

  // Consolidated E-Way Bill (CEWB) State & Mutation
  const [cewbModalOpen, setCewbModalOpen] = useState(false);
  const [cewbVehicle, setCewbVehicle] = useState('');
  const [cewbFromPlace, setCewbFromPlace] = useState('Punganur');
  const [cewbFromState, setCewbFromState] = useState(37);
  const [cewbEwbInput, setCewbEwbInput] = useState('');
  const [selectedEwbsForCewb, setSelectedEwbsForCewb] = useState<string[]>([]);

  const { data: cewbList = [], isLoading: loadingCewb } = useQuery<any[]>({
    queryKey: ['consolidated-ewb'],
    queryFn: () => api('/taxpro/consolidated-ewb'),
  });

  const cewbMutation = useMutation({
    mutationFn: (body: any) => api('/taxpro/consolidated-ewb', { method: 'POST', body }),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['consolidated-ewb'] });
      toast.success(res.message || 'Consolidated E-Way Bill generated');
      setCewbModalOpen(false);
      setSelectedEwbsForCewb([]);
      setCewbEwbInput('');
      setCewbVehicle('');
    },
    onError: (err) => toast.error(getErrorMessage(err, 'Failed to generate Consolidated EWB')),
  });

  // Transporter Lookup Handler
  async function handleTransporterLookup() {
    if (!transporterGstin.trim()) return;
    setLoadingTransporter(true);
    setTransporterResult(null);
    try {
      const res = await api<{ success: boolean; data: any }>(`/taxpro/transporter/${encodeURIComponent(transporterGstin.trim())}`);
      setTransporterResult(res.data);
      toast.success('Transporter details retrieved');
    } catch (e: any) {
      toast.error(getErrorMessage(e));
    } finally {
      setLoadingTransporter(false);
    }
  }

  const handlePrint = (dispatch: SaleDispatch, type: 'IRN' | 'EWB') => {
    navigate(type === 'IRN'
      ? `/sale-dispatches/${dispatch.id}/einvoice-print`
      : `/sale-dispatches/${dispatch.id}/ewaybill`);
  };

  const openCancel = (dispatch: SaleDispatch, type: 'einvoice' | 'ewaybill') => {
    setCancelTarget({ dispatch, type });
    setCancelReason('1');
    setCancelRemarks('');
    setCancelCascade(true);
  };

  const openUpdateVeh = (dispatch: SaleDispatch) => {
    setUpdateVehTarget(dispatch);
    setNewVehicleNo(dispatch.vehicleNumber || '');
    setVehFromPlace('Yerraguntla');
    setVehFromState(37);
    setVehReasonCode('1');
    setVehReasonRem('');
  };

  const openExtendVal = (dispatch: SaleDispatch) => {
    setExtendValTarget(dispatch);
    setExtRemainingDist(100);
    setExtFromPlace('Kadapa');
    setExtFromPincode(516001);
    setExtRsnCode(4);
    setExtRemarks('');
  };

  const debouncedSearch = useDebounce(searchQuery, 200);

  const sales = data?.sales || [];
  const { irnSales, ewbSales } = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    const filtered = sales.filter((s) => {
      if (!term) return true;
      const party = s.saleOrder?.buyer?.name?.toLowerCase() || '';
      const inv = s.invoiceNumber?.toLowerCase() || '';
      const irn = s.irn?.toLowerCase() || '';
      const ewb = s.ewbNumber?.toLowerCase() || '';
      return party.includes(term) || inv.includes(term) || irn.includes(term) || ewb.includes(term);
    });
    return {
      irnSales: filtered.filter((s) => s.irn),
      ewbSales: filtered.filter((s) => s.ewbNumber),
    };
  }, [sales, debouncedSearch]);

  const { page: irnPage, setPage: setIrnPage, pageSize: irnPageSize, setPageSize: setIrnPageSize, totalPages: irnTotalPages, total: irnTotal, pageRows: visibleIrnSales } = usePagedRows(irnSales, 25);
  const { page: ewbPage, setPage: setEwbPage, pageSize: ewbPageSize, setPageSize: setEwbPageSize, totalPages: ewbTotalPages, total: ewbTotal, pageRows: visibleEwbSales } = usePagedRows(ewbSales, 25);

  // Inward E-Way Bills list parsing
  const rawInwardList = inwardData?.data?.custom_fields?.ewbList || inwardData?.data?.ewbList || inwardData?.data;
  const inwardList: InwardEwbItem[] = Array.isArray(rawInwardList) ? rawInwardList : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="IRN & E-Way Bill Compliance Hub"
        description="Comprehensive portal for Government E-Invoices, Active E-Way Bills, Inward Purchase EWBs, and Transporter Verification"
        icon={FileText}
      />

      {/* Top summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-card p-4 rounded-xl border border-border shadow-sm">
          <div className="text-xs text-muted-foreground font-medium">Total Generated IRNs</div>
          <div className="text-2xl font-bold mt-1 text-indigo-600">{irnSales.length}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            Active: {irnSales.filter((s) => s.irnStatus !== 'CANCELLED').length} · Cancelled: {irnSales.filter((s) => s.irnStatus === 'CANCELLED').length}
          </div>
        </div>
        <div className="bg-card p-4 rounded-xl border border-border shadow-sm">
          <div className="text-xs text-muted-foreground font-medium">Active E-Way Bills</div>
          <div className="text-2xl font-bold mt-1 text-emerald-600">
            {ewbSales.filter((s) => s.ewbStatus !== 'CANCELLED').length}
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            Total Filed: {ewbSales.length}
          </div>
        </div>
        <div className="bg-card p-4 rounded-xl border border-border shadow-sm">
          <div className="text-xs text-muted-foreground font-medium">Cancelled E-Way Bills</div>
          <div className="text-2xl font-bold mt-1 text-rose-600">
            {ewbSales.filter((s) => s.ewbStatus === 'CANCELLED').length}
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">All portal cancellations</div>
        </div>
        <div className="bg-card p-4 rounded-xl border border-border shadow-sm">
          <div className="text-xs text-muted-foreground font-medium">Compliance Environment</div>
          <div className="text-xl font-bold mt-1 text-sky-600 flex items-center gap-1.5">
            <ShieldCheck className="h-5 w-5 text-sky-500 shrink-0" />
            {company?.taxproSandbox ? 'Sandbox (Test)' : 'Production Live'}
          </div>
          <div className="text-[11px] mt-1 font-medium">
            {company?.taxproSandbox ? (
              <span className="text-amber-600 dark:text-amber-400">⚠️ Test Mode Active (No live filings)</span>
            ) : (
              <span className="text-emerald-600 dark:text-emerald-400">● Live NIC Portal ({company?.gstin || 'No GSTIN'})</span>
            )}
          </div>
        </div>
      </div>

      {/* Global search */}
      <div className="flex items-center gap-4 bg-card p-4 rounded-xl border border-border shadow-sm">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by party, invoice no, IRN, or EWB..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <Tabs defaultValue="irn" className="space-y-4">
        <TabsList className="bg-muted p-1 rounded-xl">
          <TabsTrigger value="irn" className="rounded-lg gap-2">
            <FileText className="h-4 w-4" /> Sales E-Invoices ({irnSales.length})
          </TabsTrigger>
          <TabsTrigger value="ewb" className="rounded-lg gap-2">
            <Truck className="h-4 w-4" /> Sales E-Way Bills ({ewbSales.length})
          </TabsTrigger>
          <TabsTrigger value="inward" className="rounded-lg gap-2">
            <ArrowDownLeft className="h-4 w-4" /> Inward Purchase EWBs
          </TabsTrigger>
          <TabsTrigger value="transporter" className="rounded-lg gap-2">
            <Building2 className="h-4 w-4" /> Transporter Lookup
          </TabsTrigger>
          <TabsTrigger value="emaillog" className="rounded-lg gap-2">
            <Mail className="h-4 w-4" /> Email Logs
          </TabsTrigger>
          <TabsTrigger value="cewb" className="rounded-lg gap-2">
            <Truck className="h-4 w-4" /> Consolidated EWBs ({cewbList.length})
          </TabsTrigger>
        </TabsList>

        {/* ── TAB 1: Sales E-Invoices (IRN) ─────────────────────────────────── */}
        <TabsContent value="irn" className="space-y-4">
          <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead>Party / Buyer</TableHead>
                  <TableHead>Invoice & Date</TableHead>
                  <TableHead>IRN & Ack Details</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>E-Way Bill</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Loading E-Invoices...</TableCell></TableRow>
                ) : visibleIrnSales.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No E-Invoices found</TableCell></TableRow>
                ) : (
                  visibleIrnSales.map((s) => {
                    const isCancelled = s.irnStatus === 'CANCELLED';
                    const elapsedHours = s.irnAckDate ? (Date.now() - new Date(s.irnAckDate).getTime()) / (1000 * 60 * 60) : 0;
                    const canCancel = !isCancelled && elapsedHours <= 24;
                    const totalVal = dispatchTotal(s, Number(s.saleOrder?.ratePerKg || 0));

                    return (
                      <TableRow key={s.id} className={isCancelled ? 'opacity-60 bg-muted/20' : ''}>
                        <TableCell>
                          <div className="font-semibold text-foreground">{s.saleOrder?.buyer?.name ?? '-'}</div>
                          <div className="text-xs text-muted-foreground font-mono">{s.saleOrder?.buyer?.gstin ?? 'Unregistered'}</div>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">{s.invoiceNumber ?? '-'}</div>
                          <div className="text-xs text-muted-foreground">{s.invoiceDate ? shortDate(s.invoiceDate) : '-'}</div>
                        </TableCell>
                        <TableCell className="max-w-[200px]">
                          <div className="font-mono text-xs truncate" title={s.irn || ''}>{s.irn}</div>
                          <div className="text-[11px] text-muted-foreground">Ack: {s.irnAckNo ?? '-'} ({s.irnAckDate ? shortDate(s.irnAckDate) : '-'})</div>
                        </TableCell>
                        <TableCell className="font-semibold font-mono">
                          {rupees(totalVal)}
                        </TableCell>
                        <TableCell>
                          {s.ewbNumber ? (
                            <div className="text-xs font-mono font-medium text-emerald-700 dark:text-emerald-400">
                              #{s.ewbNumber}
                              {s.ewbStatus === 'CANCELLED' && <span className="ml-1 text-[10px] text-rose-500">(Cancelled)</span>}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={isCancelled ? 'destructive' : 'default'}>
                            {s.irnStatus ?? 'ACT'}
                          </Badge>
                          {isCancelled && s.irnCancelledDate && (
                            <div className="text-[10px] text-rose-600 mt-0.5">{shortDate(s.irnCancelledDate)}</div>
                          )}
                        </TableCell>
                        <TableCell className="text-right space-x-1.5 whitespace-nowrap">
                          <Button size="sm" variant="outline" onClick={() => handlePrint(s, 'IRN')} title="View & Print Official E-Invoice">
                            <Printer className="h-3.5 w-3.5 mr-1" /> View / Print
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => handleLiveSync(s, 'IRN')} title="Sync Live Status from Government Portal">
                            <RefreshCw className="h-3.5 w-3.5 text-sky-600" />
                          </Button>
                          {canCancel && (
                            <Button size="sm" variant="outline" className="border-rose-200 text-rose-700 hover:bg-rose-50" onClick={() => openCancel(s, 'einvoice')}>
                              Cancel IRN
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            title={s.saleOrder?.buyer?.email ? 'Email document bundle (Invoice + EWB + LR) to buyer (CC broker, BCC company)' : 'No buyer email'}
                            disabled={!s.saleOrder?.buyer?.email || sendInvoiceEmailMutation.isPending}
                            onClick={() => sendInvoiceEmailMutation.mutate(s.id)}
                          >
                            <Mail className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
            <PaginationBar page={irnPage} setPage={setIrnPage} pageSize={irnPageSize} setPageSize={setIrnPageSize} totalPages={irnTotalPages} total={irnTotal} />
          </div>
        </TabsContent>

        {/* ── TAB 2: Sales E-Way Bills ──────────────────────────────────────── */}
        <TabsContent value="ewb" className="space-y-4">
          <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead>Party / Buyer</TableHead>
                  <TableHead>Invoice No</TableHead>
                  <TableHead>E-Way Bill Details</TableHead>
                  <TableHead>Lorry / Vehicle</TableHead>
                  <TableHead>Validity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Loading E-Way Bills...</TableCell></TableRow>
                ) : visibleEwbSales.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No E-Way Bills found</TableCell></TableRow>
                ) : (
                  visibleEwbSales.map((s) => {
                    const isCancelled = s.ewbStatus === 'CANCELLED';
                    const elapsedHours = s.ewbDate ? (Date.now() - new Date(s.ewbDate).getTime()) / (1000 * 60 * 60) : 0;
                    const canCancel = !isCancelled && elapsedHours <= 24;

                    return (
                      <TableRow key={s.id} className={isCancelled ? 'opacity-60 bg-muted/20' : ''}>
                        <TableCell>
                          <div className="font-semibold text-foreground">{s.saleOrder?.buyer?.name ?? '-'}</div>
                          <div className="text-xs text-muted-foreground font-mono">{s.saleOrder?.buyer?.gstin ?? 'Unregistered'}</div>
                        </TableCell>
                        <TableCell className="font-medium">
                          {s.invoiceNumber ?? '-'}
                        </TableCell>
                        <TableCell>
                          <div className="font-mono font-semibold text-xs text-emerald-700 dark:text-emerald-400">#{s.ewbNumber}</div>
                          <div className="text-[11px] text-muted-foreground">{s.ewbDate ? shortDate(s.ewbDate) : '-'}</div>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium font-mono text-xs">{s.vehicleNumber ?? '-'}</div>
                          <div className="text-[11px] text-muted-foreground truncate max-w-[120px]">{s.transport?.name || s.transportProvider || '-'}</div>
                        </TableCell>
                        <TableCell>
                          <div className="text-xs font-mono">{s.ewbValidUpto ? shortDate(s.ewbValidUpto) : '-'}</div>
                          {s.ewbValidUpto && new Date(s.ewbValidUpto) < new Date() && !isCancelled && (
                            <span className="text-[10px] text-amber-600 font-semibold">Expired</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={isCancelled ? 'destructive' : 'default'}>
                            {s.ewbStatus ?? 'GEN'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right space-x-1.5 whitespace-nowrap">
                          <Button size="sm" variant="outline" onClick={() => handlePrint(s, 'EWB')} title="View Official Government E-Way Bill">
                            <Printer className="h-3.5 w-3.5 mr-1" /> View / Print
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => handleLiveSync(s, 'EWB')} title="Sync Live Status from Government Portal">
                            <RefreshCw className="h-3.5 w-3.5 text-emerald-600" />
                          </Button>
                          {!isCancelled && (
                            <>
                              <Button size="sm" variant="outline" className="border-sky-200 text-sky-700 hover:bg-sky-50" onClick={() => openUpdateVeh(s)} title="Update vehicle on NIC (Part-B / VEHEWB)">
                                <Truck className="h-3.5 w-3.5 mr-1" /> Update Lorry
                              </Button>
                              <Button size="sm" variant="outline" className="border-amber-200 text-amber-700 hover:bg-amber-50" onClick={() => openExtendVal(s)} title="Extend validity due to transit delay (EXTENDVALIDITY)">
                                <Clock className="h-3.5 w-3.5 mr-1" /> Extend
                              </Button>
                            </>
                          )}
                          {canCancel && (
                            <Button size="sm" variant="outline" className="border-rose-200 text-rose-700 hover:bg-rose-50" onClick={() => openCancel(s, 'ewaybill')}>
                              Cancel
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            title={s.saleOrder?.buyer?.email ? 'Email document bundle (Invoice + EWB + LR) to buyer (CC broker, BCC company)' : 'No buyer email'}
                            disabled={!s.saleOrder?.buyer?.email || sendEwbEmailMutation.isPending}
                            onClick={() => sendEwbEmailMutation.mutate(s.id)}
                          >
                            <Mail className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
            <PaginationBar page={ewbPage} setPage={setEwbPage} pageSize={ewbPageSize} setPageSize={setEwbPageSize} totalPages={ewbTotalPages} total={ewbTotal} />
          </div>
        </TabsContent>

        {/* ── TAB 3: Inward Purchase E-Way Bills ─────────────────────────────── */}
        <TabsContent value="inward" className="space-y-4">
          <div className="bg-card p-4 rounded-xl border border-border shadow-sm flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="space-y-0.5">
                <Label className="text-xs font-semibold">Select Date (DD/MM/YYYY)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    className="w-36 h-9 font-mono text-sm"
                    value={inwardDate}
                    onChange={(e) => setInwardDate(e.target.value)}
                    placeholder="DD/MM/YYYY"
                  />
                  <Button size="sm" onClick={() => refetchInward()} disabled={loadingInward}>
                    {loadingInward ? <RefreshCw className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Search className="h-3.5 w-3.5 mr-1.5" />}
                    Fetch Supplier EWBs
                  </Button>
                </div>
              </div>
            </div>
            <div className="text-xs text-muted-foreground max-w-md space-y-1">
              <p>Fetches all E-Way Bills generated by outside suppliers/consignors with our GSTIN as consignee. You can reject incorrect bills within 72 hours.</p>
              <p className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">
                ℹ️ Note: NIC policy permits querying <strong>yesterday or earlier dates</strong> only. Today&apos;s generated bills cannot be fetched (NIC Error 366).
              </p>
            </div>
          </div>

          <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead>E-Way Bill No & Date</TableHead>
                  <TableHead>Supplier GSTIN & Name</TableHead>
                  <TableHead>Doc No & Date</TableHead>
                  <TableHead>Total Value</TableHead>
                  <TableHead>Valid Upto</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingInward ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Querying Government Portal...</TableCell></TableRow>
                ) : inwardList.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No inward E-Way Bills found for {inwardDate}. Click &quot;Fetch Supplier EWBs&quot; to load.</TableCell></TableRow>
                ) : (
                  inwardList.map((item, idx) => (
                    <TableRow key={idx}>
                      <TableCell>
                        <div className="font-mono font-semibold text-xs text-indigo-700 dark:text-indigo-400">#{item.ewbNo}</div>
                        <div className="text-[11px] text-muted-foreground">{item.ewbDate}</div>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium text-foreground">{item.fromTrdName || item.genGstin || '-'}</div>
                        <div className="font-mono text-xs text-muted-foreground">{item.fromGstin || item.genGstin}</div>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{item.docNo}</div>
                        <div className="text-xs text-muted-foreground">{item.docDate}</div>
                      </TableCell>
                      <TableCell className="font-mono font-semibold">
                        {rupees(item.totalValue || 0)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {item.validUpto}
                      </TableCell>
                      <TableCell>
                        <Badge variant={item.rejectStatus === 'Y' ? 'destructive' : 'default'}>
                          {item.rejectStatus === 'Y' ? 'REJECTED' : (item.status || 'ACT')}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {item.rejectStatus !== 'Y' && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-rose-200 text-rose-700 hover:bg-rose-50"
                            onClick={() => setRejectEwbNo(item.ewbNo)}
                            title="Reject this E-Way Bill on Government Portal if goods/amounts are invalid"
                          >
                            <XCircle className="h-3.5 w-3.5 mr-1" /> Reject EWB
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {/* ── TAB 4: Transporter Verification ───────────────────────────────── */}
        <TabsContent value="transporter" className="space-y-4">
          <div className="bg-card p-5 rounded-xl border border-border shadow-sm max-w-xl space-y-4">
            <div>
              <h3 className="text-base font-semibold">Transporter Verification & Lookup</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Verify any transporter ID (TRANSIN or 15-digit GSTIN) directly with the national GST/E-Way Bill portal.
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Note: Non-existent, test, or unenrolled GSTINs will return NIC Error 328 (&quot;Could not retrieve transporter details&quot;).
              </p>
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="Enter Transporter GSTIN / TRANSIN (e.g. 37AAAAA0000A1Z5)"
                value={transporterGstin}
                onChange={(e) => setTransporterGstin(e.target.value.toUpperCase())}
                className="font-mono"
              />
              <Button onClick={handleTransporterLookup} disabled={loadingTransporter || !transporterGstin.trim()}>
                {loadingTransporter ? <RefreshCw className="h-4 w-4 animate-spin mr-1.5" /> : <ShieldCheck className="h-4 w-4 mr-1.5" />}
                Verify
              </Button>
            </div>

            {transporterResult && (
              <div className="rounded-xl border bg-muted/30 p-4 space-y-3 mt-4">
                <div className="flex items-center justify-between border-b pb-2">
                  <span className="text-xs font-semibold uppercase text-muted-foreground">Verification Result</span>
                  <Badge variant="success" className="gap-1">
                    <CheckCircle2 className="h-3 w-3" /> Valid Transporter
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <span className="text-muted-foreground">TRANSIN / GSTIN:</span>
                    <div className="font-mono font-bold text-foreground mt-0.5">{transporterResult.transId || transporterGstin}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Transporter Name:</span>
                    <div className="font-semibold text-foreground mt-0.5">{transporterResult.transName || '-'}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Status:</span>
                    <div className="font-medium text-foreground mt-0.5">{transporterResult.status || 'Active'}</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </TabsContent>

        {/* ── TAB 5: Email Logs ─────────────────────────────────────────────── */}
        <TabsContent value="emaillog" className="space-y-4">
          <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead>Party</TableHead>
                  <TableHead>Document</TableHead>
                  <TableHead>Sent At</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingLogs ? (
                  <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
                ) : !emailLogs || emailLogs.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No emails sent yet</TableCell></TableRow>
                ) : (
                  emailLogs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="font-medium">{log.party?.name ?? '-'}</TableCell>
                      <TableCell>
                        <div className="text-sm">{DOC_TYPE_LABEL[log.documentType]}</div>
                        <div className="text-xs font-mono text-muted-foreground">{log.referenceLabel}</div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{shortDate(log.sentAt)}</div>
                        <div className="text-xs text-muted-foreground">{log.recipientEmail}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={['FAILED', 'BOUNCED', 'COMPLAINED'].includes(log.status) ? 'destructive' : 'success'}>{log.status}</Badge>
                        {['FAILED', 'BOUNCED'].includes(log.status) && log.errorMessage && (
                          <div className="mt-1 max-w-[220px] truncate text-[10px] text-destructive" title={log.errorMessage}>{log.errorMessage}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" disabled={resendMutation.isPending} onClick={() => resendMutation.mutate(log.id)}>
                          <Mail className="h-3.5 w-3.5 mr-1.5" /> Resend
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        {/* ── TAB 6: Consolidated E-Way Bills (CEWB) ─────────────────────────── */}
        <TabsContent value="cewb" className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold">Consolidated E-Way Bills (CEWB)</h3>
              <p className="text-xs text-muted-foreground">
                Bundle multiple consignments and active E-Way Bills onto a single carrier vehicle for transit compliance.
              </p>
            </div>
            <Button onClick={() => setCewbModalOpen(true)} className="gap-2">
              <Truck className="h-4 w-4" /> Generate Consolidated EWB
            </Button>
          </div>

          <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead>CEWB No.</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Vehicle No.</TableHead>
                  <TableHead>From Location</TableHead>
                  <TableHead>Bundled EWBs</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingCewb ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                      Loading Consolidated E-Way Bills...
                    </TableCell>
                  </TableRow>
                ) : cewbList.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                      No Consolidated E-Way Bills generated yet. Click "Generate Consolidated EWB" to bundle active bills.
                    </TableCell>
                  </TableRow>
                ) : (
                  cewbList.map((c: any) => {
                    const ewbs: string[] = Array.isArray(c.ewbNumbers) ? c.ewbNumbers : [];
                    return (
                      <TableRow key={c.id}>
                        <TableCell className="font-mono font-semibold text-xs text-primary">{c.cEwbNumber}</TableCell>
                        <TableCell className="text-xs">{shortDate(c.cEwbDate)}</TableCell>
                        <TableCell className="font-mono font-medium text-xs uppercase">{c.vehicleNumber}</TableCell>
                        <TableCell className="text-xs">{c.fromPlace} (State {c.fromState})</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {ewbs.map((no) => (
                              <Badge key={no} variant="outline" className="font-mono text-[10px]">
                                {no}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="default" className="bg-emerald-600 text-white text-[10px]">
                            {c.status || 'ACTIVE'}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>

      {/* ── Generate Consolidated EWB Dialog ─────────────────────────────────── */}
      <Dialog open={cewbModalOpen} onOpenChange={setCewbModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Generate Consolidated E-Way Bill (CEWB)</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="text-xs text-muted-foreground">
              NIC form EWB-02: Consolidates multiple individual E-Way Bills for transport in one vehicle.
            </div>

            <div>
              <Label>Vehicle Number *</Label>
              <Input
                placeholder="e.g. AP03TC1234"
                className="uppercase font-mono"
                value={cewbVehicle}
                onChange={(e) => setCewbVehicle(e.target.value.toUpperCase())}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>From Place *</Label>
                <Input
                  value={cewbFromPlace}
                  onChange={(e) => setCewbFromPlace(e.target.value)}
                  placeholder="e.g. Punganur"
                />
              </div>
              <div>
                <Label>From State Code *</Label>
                <Input
                  type="number"
                  value={cewbFromState}
                  onChange={(e) => setCewbFromState(Number(e.target.value))}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Select Active E-Way Bills to Bundle</Label>
              <div className="max-h-36 overflow-y-auto border rounded-lg p-2 space-y-1 bg-muted/20">
                {ewbSales.filter((s) => s.ewbNumber && s.ewbStatus !== 'CANCELLED').length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">No active dispatches with EWBs found.</p>
                ) : (
                  ewbSales
                    .filter((s) => s.ewbNumber && s.ewbStatus !== 'CANCELLED')
                    .map((s) => {
                      const no = String(s.ewbNumber);
                      const checked = selectedEwbsForCewb.includes(no);
                      return (
                        <label
                          key={s.id}
                          className="flex items-center gap-2 text-xs p-1 rounded hover:bg-muted cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setSelectedEwbsForCewb((prev) =>
                                checked ? prev.filter((x) => x !== no) : [...prev, no]
                              );
                            }}
                          />
                          <span className="font-mono font-medium">{no}</span>
                          <span className="text-muted-foreground text-[11px] truncate">
                            ({s.saleOrder?.buyer?.name || 'Buyer'} - {s.invoiceNumber || 'Inv'})
                          </span>
                        </label>
                      );
                    })
                )}
              </div>
            </div>

            <div>
              <Label>Or Enter EWB Numbers Manually (Comma separated)</Label>
              <Input
                placeholder="e.g. 211234567890, 211234567891"
                value={cewbEwbInput}
                onChange={(e) => setCewbEwbInput(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCewbModalOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                cewbMutation.isPending ||
                !cewbVehicle.trim() ||
                (selectedEwbsForCewb.length === 0 && !cewbEwbInput.trim())
              }
              onClick={() => {
                const manual = cewbEwbInput
                  .split(/[, \n]+/)
                  .map((x) => x.trim())
                  .filter((x) => /^\d{12}$/.test(x));
                const allEwbs = Array.from(new Set([...selectedEwbsForCewb, ...manual]));
                if (allEwbs.length === 0) {
                  toast.error('Please select or enter at least one valid 12-digit E-Way Bill');
                  return;
                }
                cewbMutation.mutate({
                  vehicleNo: cewbVehicle.trim(),
                  fromPlace: cewbFromPlace.trim(),
                  fromState: cewbFromState,
                  ewbNumbers: allEwbs,
                });
              }}
            >
              {cewbMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Bundle & Generate CEWB
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Live Info Modal ─────────────────────────────────────────────────── */}
      <Dialog open={!!liveInfo} onOpenChange={(v) => !v && setLiveInfo(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-sky-600" /> {liveInfo?.title}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Live verification data returned from Government NIC System:</p>
            <div className="rounded-xl border bg-muted/40 p-3 max-h-72 overflow-y-auto font-mono text-xs">
              <pre className="whitespace-pre-wrap break-all">{JSON.stringify(liveInfo?.data, null, 2)}</pre>
            </div>
            <DialogFooter>
              <Button onClick={() => setLiveInfo(null)}>Close</Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Cancel Dialog (Shared for IRN & EWB with 24h timer & cascade) ────── */}
      <Dialog open={!!cancelTarget} onOpenChange={(v) => !v && setCancelTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel {cancelTarget?.type === 'einvoice' ? 'E-Invoice (IRN)' : 'E-Way Bill'}</DialogTitle>
          </DialogHeader>
          {cancelTarget && (() => {
            const d = cancelTarget.dispatch;
            const isIrn = cancelTarget.type === 'einvoice';
            const dateRef = isIrn ? d.irnAckDate : d.ewbDate;
            const elapsedHours = dateRef ? (Date.now() - new Date(dateRef).getTime()) / (1000 * 60 * 60) : 0;
            const remainingHours = Math.max(0, 24 - elapsedHours);
            const isLapsed = elapsedHours > 24;
            const hasActiveLinkedEwb = Boolean(isIrn && d.ewbNumber && d.ewbStatus !== 'CANCELLED');

            return (
              <div className="space-y-4">
                {isLapsed ? (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300 space-y-1.5">
                    <div className="font-semibold flex items-center gap-1.5 text-sm">
                      <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0" /> Government 24-Hour Cutoff Passed
                    </div>
                    <p>
                      NIC rejects cancellations after 24 hours (Error 2150). You must issue a Credit Note to cancel this invoice and adjust tax liability legally.
                    </p>
                  </div>
                ) : (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300 flex items-center gap-2">
                    <Clock className="h-4 w-4 text-amber-600 shrink-0" />
                    <span>
                      <strong>{remainingHours.toFixed(1)} hours</strong> left to cancel on the government portal before the 24-hour cutoff.
                    </span>
                  </div>
                )}

                {hasActiveLinkedEwb && !isLapsed && (
                  <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300 space-y-2">
                    <div className="font-semibold flex items-center gap-1.5">
                      <Info className="h-4 w-4 text-sky-600 shrink-0" /> Active E-Way Bill Attached (#{d.ewbNumber})
                    </div>
                    <p>
                      NIC strictly forbids cancelling an IRN while its linked E-Way Bill is active. The E-Way Bill must be cancelled first.
                    </p>
                    <label className="flex items-center gap-2 font-medium cursor-pointer pt-1">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded accent-primary"
                        checked={cancelCascade}
                        onChange={(e) => setCancelCascade(e.target.checked)}
                      />
                      <span>Auto-cancel E-Way Bill #{d.ewbNumber} first, then cancel IRN</span>
                    </label>
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label className="text-xs">Reason Code *</Label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                  >
                    {isIrn ? (
                      <>
                        <option value="1">1 - Duplicate</option>
                        <option value="2">2 - Data Entry Mistake</option>
                        <option value="3">3 - Order Cancelled</option>
                        <option value="4">4 - Others</option>
                      </>
                    ) : (
                      <>
                        <option value="1">1 - Duplicate</option>
                        <option value="2">2 - Order Cancelled</option>
                        <option value="3">3 - Mistake in EWB</option>
                        <option value="4">4 - Others</option>
                      </>
                    )}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Cancellation Remarks *</Label>
                  <Input
                    value={cancelRemarks}
                    onChange={(e) => setCancelRemarks(e.target.value)}
                    placeholder="Enter reason for portal audit log..."
                  />
                </div>

                <DialogFooter className="pt-2">
                  <Button variant="outline" onClick={() => setCancelTarget(null)}>Close</Button>
                  {isLapsed ? (
                    <Button
                      variant="default"
                      onClick={() => {
                        setCancelTarget(null);
                        navigate('/credit-debit-notes');
                      }}
                    >
                      Open Credit Notes
                    </Button>
                  ) : (
                    <Button
                      variant="destructive"
                      onClick={() => (isIrn ? cancelIrnMutation.mutate() : cancelEwbMutation.mutate())}
                      disabled={
                        cancelIrnMutation.isPending ||
                        cancelEwbMutation.isPending ||
                        (hasActiveLinkedEwb && !cancelCascade)
                      }
                    >
                      {cancelIrnMutation.isPending || cancelEwbMutation.isPending
                        ? 'Cancelling on Portal...'
                        : hasActiveLinkedEwb && cancelCascade
                          ? 'Cancel Both (EWB + IRN)'
                          : `Confirm ${isIrn ? 'IRN' : 'EWB'} Cancellation`}
                    </Button>
                  )}
                </DialogFooter>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* ── Update Vehicle Dialog (VEHEWB / Part-B) ─────────────────────────── */}
      <Dialog open={!!updateVehTarget} onOpenChange={(v) => !v && setUpdateVehTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Update Lorry / Vehicle (Part-B)</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Update the lorry number on active E-Way Bill <strong>#{updateVehTarget?.ewbNumber}</strong> on the government portal without cancelling the bill.
            </p>
            <div className="space-y-1.5">
              <Label className="text-xs">New Vehicle Number *</Label>
              <Input
                value={newVehicleNo}
                onChange={(e) => setNewVehicleNo(e.target.value.toUpperCase())}
                placeholder="e.g. AP04TT1234"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">From Place *</Label>
                <Input value={vehFromPlace} onChange={(e) => setVehFromPlace(e.target.value)} placeholder="Town name" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">From State Code *</Label>
                <Input type="number" value={vehFromState} onChange={(e) => setVehFromState(Number(e.target.value))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Reason for Vehicle Change</Label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={vehReasonCode}
                onChange={(e) => setVehReasonCode(e.target.value)}
              >
                <option value="1">1 - Due to Breakdown</option>
                <option value="2">2 - Due to Transshipment</option>
                <option value="3">3 - Others</option>
                <option value="4">4 - First Time Part-B</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Reason Remarks</Label>
              <Input
                value={vehReasonRem}
                onChange={(e) => setVehReasonRem(e.target.value)}
                placeholder="e.g. Lorry punctured / engine problem"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setUpdateVehTarget(null)}>Cancel</Button>
              <Button
                className="bg-sky-600 hover:bg-sky-700 text-white"
                onClick={() => updateVehMutation.mutate()}
                disabled={updateVehMutation.isPending || !newVehicleNo.trim() || !vehFromPlace.trim()}
              >
                {updateVehMutation.isPending ? 'Updating on NIC...' : 'Update Lorry on NIC'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Extend Validity Dialog (EXTENDVALIDITY) ─────────────────────────── */}
      <Dialog open={!!extendValTarget} onOpenChange={(v) => !v && setExtendValTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Extend E-Way Bill Validity</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Extend validity for E-Way Bill <strong>#{extendValTarget?.ewbNumber}</strong> due to road delay, mechanical trouble, or weather.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Current Vehicle No</Label>
                <Input value={extendValTarget?.vehicleNumber || ''} disabled className="bg-muted/50" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Remaining Distance (KM) *</Label>
                <Input
                  type="number"
                  min="1"
                  max="4000"
                  value={extRemainingDist}
                  onChange={(e) => setExtRemainingDist(Number(e.target.value))}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5 col-span-2">
                <Label className="text-xs">Current Location (Town) *</Label>
                <Input value={extFromPlace} onChange={(e) => setExtFromPlace(e.target.value)} placeholder="Town name" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">PIN Code *</Label>
                <Input type="number" value={extFromPincode} onChange={(e) => setExtFromPincode(Number(e.target.value))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Extension Reason</Label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={extRsnCode}
                onChange={(e) => setExtRsnCode(Number(e.target.value))}
              >
                <option value={1}>1 - Natural Calamity / Weather</option>
                <option value={2}>2 - Law and Order / Strike</option>
                <option value={3}>3 - Transshipment Delay</option>
                <option value={4}>4 - Accident / Mechanical Trouble</option>
                <option value={5}>5 - Others</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Extension Remarks</Label>
              <Input
                value={extRemarks}
                onChange={(e) => setExtRemarks(e.target.value)}
                placeholder="e.g. Highway traffic jam / tyre replacement"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setExtendValTarget(null)}>Cancel</Button>
              <Button
                className="bg-amber-600 hover:bg-amber-700 text-white"
                onClick={() => extendValMutation.mutate()}
                disabled={extendValMutation.isPending || !(extRemainingDist > 0) || !extFromPlace.trim()}
              >
                {extendValMutation.isPending ? 'Extending on NIC...' : 'Extend Validity on NIC'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Reject Inward E-Way Bill Dialog ─────────────────────────────────── */}
      <Dialog open={!!rejectEwbNo} onOpenChange={(v) => !v && setRejectEwbNo(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reject Inward E-Way Bill</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Are you sure you want to reject Supplier E-Way Bill <strong>#{rejectEwbNo}</strong>?
            </p>
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
              Rejecting an E-Way Bill formally informs the GST portal and the supplier that these goods were not ordered or received by your firm. Rejection must occur within 72 hours of generation.
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRejectEwbNo(null)}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={() => rejectEwbMutation.mutate(rejectEwbNo!)}
                disabled={rejectEwbMutation.isPending}
              >
                {rejectEwbMutation.isPending ? 'Rejecting on Portal...' : 'Confirm Rejection on NIC'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
