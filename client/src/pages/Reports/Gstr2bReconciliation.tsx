import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FileCheck2,
  Upload,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  MessageCircle,
  Download,
  Calendar,
  FileSpreadsheet,
  Coins,
  ShieldCheck,
  ShieldAlert,
  Loader2,
} from 'lucide-react';
import { api } from '@/lib/api';
import { rupees, shortDate } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';

interface ReconciliationRow {
  id: string;
  status: 'MATCHED' | 'MISSING_IN_2B' | 'MISSING_IN_BOOKS' | 'MISMATCH_VALUE' | 'MISMATCH_TAX';
  statusLabel: string;
  supplierGstin: string;
  supplierName: string;
  supplierPhone?: string | null;
  docType: string;
  invoiceNumber: string;
  invoiceDate: string;
  booksTaxable?: number | null;
  booksItc?: number | null;
  booksTotal?: number | null;
  stockInId?: string | null;
  portalTaxable?: number | null;
  portalItc?: number | null;
  portalTotal?: number | null;
  diffTaxable?: number | null;
  diffItc?: number | null;
  itcAvailable?: boolean;
  filingDate?: string | null;
  sourceSection?: string | null;
}

interface ReconciliationSummary {
  period: string;
  financialYear: string;
  totalGstr2bItc: number;
  totalGstr2bTaxable: number;
  totalBooksItc: number;
  totalBooksTaxable: number;
  matchedItc: number;
  matchedTaxable: number;
  missingIn2bItc: number;
  missingIn2bTaxable: number;
  missingInBooksItc: number;
  missingInBooksTaxable: number;
  discrepancyItc: number;
  discrepancyCount: number;
  counts: {
    matched: number;
    missingIn2b: number;
    missingInBooks: number;
    mismatch: number;
    total: number;
  };
  rows: ReconciliationRow[];
}

const Num = ({ v, bold, tone }: { v?: number | null; bold?: boolean; tone?: 'green' | 'red' | 'amber' | 'blue' }) => {
  if (v == null || Math.abs(v) < 0.005) return <span className="text-muted-foreground font-mono">–</span>;
  const color =
    tone === 'green'
      ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
      : tone === 'red'
      ? 'text-rose-600 dark:text-rose-400 font-semibold'
      : tone === 'amber'
      ? 'text-amber-600 dark:text-amber-400 font-semibold'
      : tone === 'blue'
      ? 'text-blue-600 dark:text-blue-400 font-semibold'
      : '';
  return <span className={`font-mono tabular-nums ${bold ? 'font-semibold' : ''} ${color}`}>{rupees(v)}</span>;
};

export default function Gstr2bReconciliation() {
  const queryClient = useQueryClient();

  // Period state: default to previous month MMYYYY
  const defaultPeriod = useMemo(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const y = d.getFullYear();
    return `${m}${y}`;
  }, []);

  const [period, setPeriod] = useState<string>(defaultPeriod);
  const [activeTab, setActiveTab] = useState<string>('all');
  const [search, setSearch] = useState<string>('');

  // Modals
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [uploadPeriod, setUploadPeriod] = useState(defaultPeriod);
  const [uploadError, setUploadError] = useState('');

  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncPeriod, setSyncPeriod] = useState(defaultPeriod);
  const [syncMode, setSyncMode] = useState<'sandbox' | 'live'>('sandbox');
  const [syncMsg, setSyncMsg] = useState('');

  // Data Queries
  const { data, isLoading, refetch } = useQuery<ReconciliationSummary>({
    queryKey: ['gstr2b-reconciliation', period],
    queryFn: () => api<ReconciliationSummary>(`/gstr2b/reconciliation?period=${period}`),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // JSON Upload Mutation
  const uploadMutation = useMutation({
    mutationFn: async (payload: { jsonData: any; period: string }) => {
      return api<{ success: boolean; totalInvoices: number; message: string }>('/gstr2b/upload-json', {
        method: 'POST',
        body: payload,
      });
    },
    onSuccess: (res) => {
      setShowUploadModal(false);
      setJsonText('');
      setUploadError('');
      queryClient.invalidateQueries({ queryKey: ['gstr2b-reconciliation'] });
      queryClient.invalidateQueries({ queryKey: ['gstr2b-periods'] });
      alert(res.message || 'GSTR-2B JSON imported successfully!');
    },
    onError: (err: any) => {
      setUploadError(err.message || 'Failed to upload GSTR-2B JSON');
    },
  });

  // TaxPro Sync Mutation
  const syncMutation = useMutation({
    mutationFn: async ({ p, m }: { p: string; m: 'sandbox' | 'live' }) => {
      return api<{ success: boolean; totalInvoices: number; message: string }>('/gstr2b/sync', {
        method: 'POST',
        body: { period: p, mode: m },
      });
    },
    onSuccess: (res) => {
      setShowSyncModal(false);
      setSyncMsg('');
      queryClient.invalidateQueries({ queryKey: ['gstr2b-reconciliation'] });
      queryClient.invalidateQueries({ queryKey: ['gstr2b-periods'] });
      alert(res.message || 'Synced GSTR-2B via TaxPro successfully!');
    },
    onError: (err: any) => {
      const msg = err.message || 'TaxPro sync failed';
      if (/internal server error/i.test(msg)) {
        setSyncMsg('The government NIC gateway is currently busy or taking a moment to respond. Please click "Sync GSTR-2B" again.');
      } else {
        setSyncMsg(msg);
      }
    },
  });

  // Handle JSON File Drag or Selection
  const handleFileDrop = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        setJsonText(text);
        const parsed = JSON.parse(text);
        const fp = parsed?.data?.fp || parsed?.fp;
        if (fp && String(fp).length === 6) {
          setUploadPeriod(String(fp));
        }
      } catch {
        setUploadError('Selected file is not valid JSON');
      }
    };
    reader.readAsText(file);
  };

  // WhatsApp Legal Reminder
  const openWhatsApp = (row: ReconciliationRow) => {
    const cleanPhone = (row.supplierPhone || '').replace(/\D/g, '');
    const phone = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;

    const invDate = new Date(row.invoiceDate).toLocaleDateString('en-GB');
    const taxAmt = row.booksItc ? rupees(row.booksItc) : 'GST Amount';
    const totalAmt = row.booksTotal ? rupees(row.booksTotal) : '';

    const text =
      `Dear ${row.supplierName || 'Valued Supplier'},\n\n` +
      `Greetings from RVP Industries Private Limited.\n\n` +
      `During our monthly GST Input Tax Credit (ITC) reconciliation under CGST Rule 36(4), we observed that your invoice has *NOT appeared in our GSTR-2B*:\n\n` +
      `📄 *Invoice No:* ${row.invoiceNumber}\n` +
      `📅 *Date:* ${invDate}\n` +
      (totalAmt ? `💰 *Total Amount:* ${totalAmt}\n` : '') +
      `🏛️ *GST Paid by RVP:* ${taxAmt}\n` +
      `🏢 *Your GSTIN:* ${row.supplierGstin}\n\n` +
      `As per statutory compliance, we cannot claim ITC unless this invoice is filed in your GSTR-1. ` +
      `Kindly file/amend your GSTR-1 at the earliest to ensure timely settlement of pending accounts.\n\n` +
      `Thank you,\n*Accounts Dept - RVP Industries*`;

    const url = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}` : `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  };

  // Filter rows
  const filteredRows = useMemo(() => {
    if (!data?.rows) return [];
    let list = data.rows;

    if (activeTab === 'matched') list = list.filter((r) => r.status === 'MATCHED');
    else if (activeTab === 'missing_2b') list = list.filter((r) => r.status === 'MISSING_IN_2B');
    else if (activeTab === 'missing_books') list = list.filter((r) => r.status === 'MISSING_IN_BOOKS');
    else if (activeTab === 'mismatch') list = list.filter((r) => r.status === 'MISMATCH_VALUE' || r.status === 'MISMATCH_TAX');

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (r) =>
          r.invoiceNumber.toLowerCase().includes(q) ||
          r.supplierName.toLowerCase().includes(q) ||
          r.supplierGstin.toLowerCase().includes(q),
      );
    }
    return list;
  }, [data?.rows, activeTab, search]);

  // Export CSV
  const exportCsv = () => {
    if (!filteredRows.length) return;
    const headers = [
      'Status',
      'Supplier Name',
      'Supplier GSTIN',
      'Invoice Number',
      'Invoice Date',
      'Books Taxable',
      'Books ITC',
      'Books Total',
      'Portal Taxable',
      'Portal ITC',
      'Portal Total',
      'Taxable Diff',
      'ITC Diff',
    ];

    const csvLines = [
      headers.join(','),
      ...filteredRows.map((r) =>
        [
          `"${r.statusLabel}"`,
          `"${r.supplierName}"`,
          `"${r.supplierGstin}"`,
          `"${r.invoiceNumber}"`,
          `"${shortDate(r.invoiceDate)}"`,
          r.booksTaxable ?? '',
          r.booksItc ?? '',
          r.booksTotal ?? '',
          r.portalTaxable ?? '',
          r.portalItc ?? '',
          r.portalTotal ?? '',
          r.diffTaxable ?? '',
          r.diffItc ?? '',
        ].join(','),
      ),
    ];

    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `GSTR-2B_Reconciliation_${period}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={FileCheck2}
        title="GSTR-2B Purchase ITC Reconciliation"
        description="Automated reconciliation of ERP purchase bills against the official government GSTR-2B statement under CGST Rule 36(4)."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* Period selector */}
            <div className="flex items-center gap-2 bg-background border rounded-md px-3 py-1.5 shadow-sm">
              <Calendar className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground font-medium">Period:</span>
              <Input
                value={period}
                onChange={(e) => setPeriod(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="MMYYYY (e.g. 082026)"
                className="w-24 h-7 text-xs font-mono font-bold border-none p-0 focus-visible:ring-0"
              />
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => refetch()}>
                <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>

            <Button size="sm" onClick={() => setShowUploadModal(true)} className="gap-1.5 shadow-sm bg-emerald-600 hover:bg-emerald-700 text-white font-medium">
              <Upload className="w-4 h-4" />
              <span>Import GSTR-2B JSON (Free / 0 Credits)</span>
            </Button>

            <Button size="sm" variant="outline" onClick={() => setShowSyncModal(true)} className="gap-1.5 shadow-sm text-xs text-muted-foreground hover:text-foreground">
              <RefreshCw className="w-3.5 h-3.5 text-sky-600" />
              <span>Sync via TaxPro</span>
            </Button>

            <Button size="sm" variant="outline" onClick={exportCsv} disabled={!filteredRows.length} className="gap-1.5 shadow-sm">
              <Download className="w-4 h-4 text-amber-600" />
              <span>Export Audit</span>
            </Button>
          </div>
        }
      />

      {/* KPI Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard
          label="GSTR-2B Portal ITC"
          value={rupees(data?.totalGstr2bItc ?? 0)}
          icon={ShieldCheck}
          tone="forest"
          hint={`Portal Taxable: ${rupees(data?.totalGstr2bTaxable ?? 0)}`}
        />
        <StatCard
          label="ERP Books ITC Claimed"
          value={rupees(data?.totalBooksItc ?? 0)}
          icon={Coins}
          tone="taupe"
          hint={`Books Taxable: ${rupees(data?.totalBooksTaxable ?? 0)}`}
        />
        <StatCard
          label="100% Safe ITC"
          value={rupees(data?.matchedItc ?? 0)}
          icon={CheckCircle2}
          tone="forest"
          hint={`${data?.counts.matched ?? 0} invoices matched`}
        />
        <StatCard
          label="At-Risk ITC (Missing in 2B)"
          value={rupees(data?.missingIn2bItc ?? 0)}
          icon={ShieldAlert}
          tone="rose"
          hint={`${data?.counts.missingIn2b ?? 0} suppliers non-filing`}
        />
        <StatCard
          label="Unclaimed (Missing in Books)"
          value={rupees(data?.missingInBooksItc ?? 0)}
          icon={HelpCircle}
          tone="amber"
          hint={`${data?.counts.missingInBooks ?? 0} discovered bills`}
        />
      </div>

      {/* Main Table Card */}
      <Card className="p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-auto">
            <TabsList className="grid grid-cols-5 text-xs h-9">
              <TabsTrigger value="all" className="px-3">
                All ({data?.counts.total ?? 0})
              </TabsTrigger>
              <TabsTrigger value="matched" className="px-3 text-emerald-700 dark:text-emerald-400 font-medium">
                Matched ({data?.counts.matched ?? 0})
              </TabsTrigger>
              <TabsTrigger value="missing_2b" className="px-3 text-rose-700 dark:text-rose-400 font-medium">
                Missing in 2B ({data?.counts.missingIn2b ?? 0})
              </TabsTrigger>
              <TabsTrigger value="missing_books" className="px-3 text-amber-700 dark:text-amber-400 font-medium">
                Missing in Books ({data?.counts.missingInBooks ?? 0})
              </TabsTrigger>
              <TabsTrigger value="mismatch" className="px-3 text-blue-700 dark:text-blue-400 font-medium">
                Discrepancies ({data?.counts.mismatch ?? 0})
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <Input
            placeholder="Search invoice, supplier or GSTIN…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs h-9 text-xs"
          />
        </div>

        {isLoading ? (
          <div className="py-16 text-center text-muted-foreground">Computing GSTR-2B purchase reconciliation…</div>
        ) : filteredRows.length === 0 ? (
          <div className="py-16 text-center text-muted-foreground">
            No reconciliation records found for period <span className="font-mono font-semibold">{period}</span>.
            <div className="mt-2 text-xs">
              Upload the official GSTR-2B JSON file from the GST portal or click "Sync via TaxPro" to import return data.
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto border rounded-md">
            <Table className="text-xs">
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="w-[120px]">Status</TableHead>
                  <TableHead>Supplier & GSTIN</TableHead>
                  <TableHead>Invoice & Date</TableHead>
                  <TableHead className="text-right">Books Taxable</TableHead>
                  <TableHead className="text-right">Books ITC</TableHead>
                  <TableHead className="text-right">Portal Taxable</TableHead>
                  <TableHead className="text-right">Portal ITC</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                  <TableHead className="text-center w-[100px]">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((row) => {
                  const isMatched = row.status === 'MATCHED';
                  const isMissing2b = row.status === 'MISSING_IN_2B';
                  const isMissingBooks = row.status === 'MISSING_IN_BOOKS';

                  return (
                    <TableRow key={row.id} className="hover:bg-muted/30">
                      <TableCell>
                        {isMatched ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 px-2 py-0.5 rounded-full">
                            <CheckCircle2 className="w-3 h-3" /> Matched
                          </span>
                        ) : isMissing2b ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 px-2 py-0.5 rounded-full">
                            <AlertTriangle className="w-3 h-3" /> Missing in 2B
                          </span>
                        ) : isMissingBooks ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 px-2 py-0.5 rounded-full">
                            <HelpCircle className="w-3 h-3" /> Not in Books
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 px-2 py-0.5 rounded-full">
                            <AlertTriangle className="w-3 h-3" /> Mismatch
                          </span>
                        )}
                      </TableCell>

                      <TableCell>
                        <div className="font-semibold text-foreground">{row.supplierName}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">{row.supplierGstin}</div>
                      </TableCell>

                      <TableCell>
                        <div className="font-mono font-medium">{row.invoiceNumber}</div>
                        <div className="text-[10px] text-muted-foreground">{shortDate(row.invoiceDate)}</div>
                      </TableCell>

                      <TableCell className="text-right">
                        <Num v={row.booksTaxable} />
                      </TableCell>

                      <TableCell className="text-right">
                        <Num v={row.booksItc} bold tone="green" />
                      </TableCell>

                      <TableCell className="text-right">
                        <Num v={row.portalTaxable} />
                      </TableCell>

                      <TableCell className="text-right">
                        <Num v={row.portalItc} bold tone="green" />
                      </TableCell>

                      <TableCell className="text-right">
                        {row.diffItc != null && Math.abs(row.diffItc) > 0.01 ? (
                          <span className="font-mono text-xs font-semibold text-rose-600 dark:text-rose-400">
                            {row.diffItc > 0 ? `+${rupees(row.diffItc)}` : rupees(row.diffItc)}
                          </span>
                        ) : (
                          <span className="font-mono text-muted-foreground">–</span>
                        )}
                      </TableCell>

                      <TableCell className="text-center">
                        {isMissing2b ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[10px] gap-1 px-2 border-rose-300 text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                            onClick={() => openWhatsApp(row)}
                            title="Send legal WhatsApp notice to supplier to file GSTR-1"
                          >
                            <MessageCircle className="w-3 h-3 text-emerald-600" />
                            <span>Notify</span>
                          </Button>
                        ) : isMissingBooks ? (
                          <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium">Claimable</span>
                        ) : (
                          <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">Safe</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {/* Upload JSON Modal */}
      <Dialog open={showUploadModal} onOpenChange={setShowUploadModal}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="w-5 h-5 text-emerald-600" />
              <span>Import Official GSTR-2B JSON</span>
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <p className="text-xs text-muted-foreground">
              Download the official monthly GSTR-2B <span className="font-mono font-semibold">.json</span> file from the GST portal
              (<span className="underline">gst.gov.in</span> $\rightarrow$ Returns Dashboard $\rightarrow$ GSTR-2B) and upload it here.
              <strong className="block text-emerald-600 mt-1 font-semibold">100% Free - Consumes 0 API Credits.</strong>
            </p>

            <div className="space-y-1">
              <Label className="text-xs">Select Return Period (MMYYYY)</Label>
              <Input
                value={uploadPeriod}
                onChange={(e) => setUploadPeriod(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="e.g. 082026"
                className="font-mono text-sm"
              />
            </div>

            <div className="border-2 border-dashed rounded-lg p-4 text-center space-y-2 hover:bg-muted/40 cursor-pointer">
              <FileSpreadsheet className="w-8 h-8 mx-auto text-muted-foreground" />
              <div className="text-xs font-medium">Click to select GSTR-2B .json file</div>
              <input type="file" accept=".json" onChange={handleFileDrop} className="text-xs mx-auto" />
            </div>

            {jsonText && (
              <div className="text-xs text-emerald-600 font-medium">
                ✓ Loaded JSON content ({Math.round(jsonText.length / 1024)} KB)
              </div>
            )}

            {uploadError && <div className="text-xs text-rose-600 bg-rose-50 p-2 rounded">{uploadError}</div>}
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowUploadModal(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!jsonText || uploadMutation.isPending}
              onClick={() => uploadMutation.mutate({ jsonData: jsonText, period: uploadPeriod })}
            >
              {uploadMutation.isPending ? 'Importing…' : 'Reconcile Now'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* TaxPro Sync Modal */}
      <Dialog open={showSyncModal} onOpenChange={setShowSyncModal}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="w-5 h-5 text-sky-600" />
              <span>Sync GSTR-2B via TaxPro GSP</span>
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Mode selection with credit badges */}
            <div className="space-y-2">
              <Label className="text-xs font-medium">Sync Ingestion Mode</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setSyncMode('sandbox')}
                  className={`p-3 rounded-lg border text-left transition-all ${
                    syncMode === 'sandbox'
                      ? 'border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/30 ring-1 ring-emerald-500'
                      : 'border-slate-200 dark:border-slate-800 hover:bg-muted/50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-xs text-foreground">Safe Test Mode</span>
                    <Badge className="bg-emerald-600 text-white text-[10px] px-1.5 py-0">0 Credits</Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1 leading-snug">
                    Simulates GSTR-2B ingestion with zero TaxPro API credits consumed.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setSyncMode('live')}
                  className={`p-3 rounded-lg border text-left transition-all ${
                    syncMode === 'live'
                      ? 'border-sky-500 bg-sky-50/50 dark:bg-sky-950/30 ring-1 ring-sky-500'
                      : 'border-slate-200 dark:border-slate-800 hover:bg-muted/50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-xs text-foreground">Live NIC Inward</span>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-sky-400 text-sky-600">Max 1-2 calls</Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1 leading-snug">
                    Strict Credit Shield: Queries only active arrival dates recorded in ERP.
                  </p>
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Target Return Period (MMYYYY)</Label>
              <Input
                value={syncPeriod}
                onChange={(e) => setSyncPeriod(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="e.g. 082026"
                className="font-mono text-sm"
              />
              <div className="bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/60 p-2.5 rounded-md text-[11px] text-emerald-800 dark:text-emerald-300 mt-2 leading-relaxed">
                <span className="font-semibold">💡 Recommended 0-Credit Alternative:</span> Download your official GSTR-2B JSON directly from <code className="bg-emerald-100 dark:bg-emerald-900/50 px-1 py-0.5 rounded font-mono">gst.gov.in</code> (Returns Dashboard &gt; GSTR-2B &gt; Download JSON) and click <strong>&quot;Import GSTR-2B JSON&quot;</strong>. It costs <strong>0 credits</strong> and includes 100% of all invoices, credit notes, and amendments.
              </div>
            </div>

            {syncMutation.isPending && (
              <div className="py-3 px-4 rounded-lg bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800 flex items-center gap-3 text-xs text-sky-800 dark:text-sky-300">
                <Loader2 className="w-4 h-4 animate-spin shrink-0 text-sky-600" />
                <div className="space-y-0.5">
                  <div className="font-semibold">
                    {syncMode === 'sandbox' ? 'Loading Safe Simulation Data...' : 'Querying Government Registry (Credit Shield Active)...'}
                  </div>
                  <div className="text-[11px] text-sky-700 dark:text-sky-400">
                    {syncMode === 'sandbox' ? '0 credits consumed' : `Checking verified inward consignments for ${syncPeriod}`}
                  </div>
                </div>
              </div>
            )}

            {syncMsg && (
              <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 p-2.5 rounded-md leading-relaxed">
                {syncMsg}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowSyncModal(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={syncMutation.isPending || syncPeriod.length !== 6}
              onClick={() => syncMutation.mutate({ p: syncPeriod, m: syncMode })}
            >
              {syncMutation.isPending ? 'Syncing…' : syncMode === 'sandbox' ? 'Sync Free (0 Credits)' : 'Sync Live (Low Credits)'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
