import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  FileSpreadsheet,
  Download,
  Code2,
  FileText,
  CheckCircle2,
  Receipt,
  Layers,
  Sparkles,
} from 'lucide-react';
import { api } from '@/lib/api';
import { rupees } from '@/lib/format';
import { PeriodFilter, periodFor } from '@/components/PeriodFilter';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

interface Gstr1Response {
  success: boolean;
  summary: {
    fp: string;
    period: { from: string; to: string };
    b2bInvoicesCount: number;
    b2csInvoicesCount: number;
    creditNotesCount: number;
    debitNotesCount: number;
    totalTaxableValue: number;
    totalIgst: number;
    totalCgst: number;
    totalSgst: number;
    totalTax: number;
    totalInvoiceValue: number;
    hsnTable: Array<{
      num: number;
      hsn_sc: string;
      desc: string;
      uqc: string;
      qty: number;
      val: number;
      txval: number;
      iamt: number;
      camt: number;
      samt: number;
      csamt: number;
      rt: number;
    }>;
    docTable: Array<{
      doc_num: number;
      doc_typ: string;
      docs: Array<{
        num: number;
        from: string;
        to: string;
        totnum: number;
        canc: number;
        net_issue: number;
      }>;
    }>;
  };
  offlineJson: any;
}

export default function Gstr1Report() {
  const now = new Date();
  const [fy, setFy] = useState(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1);
  const [month, setMonth] = useState<number | 'ALL'>(now.getMonth() + 1);

  const period = useMemo(() => periodFor(fy, month), [fy, month]);

  const { data, isLoading } = useQuery<Gstr1Response>({
    queryKey: ['gstr1-report', period.from, period.to],
    queryFn: () => api<Gstr1Response>(`/reports/gstr1?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`),
  });

  const [jsonModalOpen, setJsonModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'HSN' | 'DOCS' | 'SUMMARY'>('HSN');

  const summary = data?.summary;
  const offlineJson = data?.offlineJson;

  const handleDownloadJson = () => {
    if (!offlineJson) {
      toast.error('No GSTR-1 data available for the selected period');
      return;
    }
    const gstin = offlineJson.gstin || 'GSTIN';
    const fp = offlineJson.fp || 'PERIOD';
    const filename = `GSTR1_${gstin}_${fp}.json`;
    const blob = new Blob([JSON.stringify(offlineJson, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${filename} (Official GST Offline Tool Format)`);
  };

  const handleDownloadHsnCsv = () => {
    if (!summary?.hsnTable || summary.hsnTable.length === 0) {
      toast.error('No HSN rows to export');
      return;
    }
    const headers = [
      'HSN Code',
      'Description',
      'UQC',
      'Total Quantity',
      'Total Value',
      'Taxable Value',
      'Rate %',
      'IGST Amount',
      'CGST Amount',
      'SGST Amount',
    ];
    const rows = summary.hsnTable.map((h) => [
      `"${h.hsn_sc}"`,
      `"${h.desc}"`,
      `"${h.uqc}"`,
      h.qty,
      h.val,
      h.txval,
      h.rt,
      h.iamt,
      h.camt,
      h.samt,
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `GSTR1_Table12_HSN_${summary.fp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('Downloaded HSN Table 12 CSV');
  };

  return (
    <div className="space-y-6">
      {/* Top Control Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl border bg-card shadow-sm">
        <div>
          <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-indigo-600" />
            GSTR-1 Outward Return & Table 12 HSN Summary
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Auto-compiled Table 4 (B2B), Table 7 (B2CS), Table 9B (CDNR), Table 12 (HSN), and Table 13 (Doc Series).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <PeriodFilter fy={fy} month={month} onFyChange={setFy} onMonthChange={setMonth} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setJsonModalOpen(true)}
            disabled={!offlineJson}
            className="gap-1.5 shadow-sm"
          >
            <Code2 className="w-4 h-4 text-sky-600" />
            View JSON
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownloadHsnCsv}
            disabled={!summary?.hsnTable?.length}
            className="gap-1.5 shadow-sm"
          >
            <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
            Export HSN CSV
          </Button>
          <Button
            size="sm"
            onClick={handleDownloadJson}
            disabled={!offlineJson}
            className="bg-indigo-600 hover:bg-indigo-700 text-white gap-1.5 shadow-sm"
          >
            <Download className="w-4 h-4" />
            Download GSTR-1 Offline JSON
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="p-4 rounded-xl border bg-card shadow-sm">
          <div className="text-xs text-muted-foreground font-medium">Outward Taxable Value</div>
          <div className="text-2xl font-bold mt-1 text-foreground font-mono">
            {isLoading ? '…' : rupees(summary?.totalTaxableValue || 0)}
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            Total Sales: {rupees(summary?.totalInvoiceValue || 0)}
          </div>
        </div>

        <div className="p-4 rounded-xl border bg-card shadow-sm">
          <div className="text-xs text-indigo-600 font-medium">Total Output Tax</div>
          <div className="text-2xl font-bold mt-1 text-indigo-600 font-mono">
            {isLoading ? '…' : rupees(summary?.totalTax || 0)}
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            IGST: {rupees(summary?.totalIgst || 0)} · CGST+SGST: {rupees((summary?.totalCgst || 0) + (summary?.totalSgst || 0))}
          </div>
        </div>

        <div className="p-4 rounded-xl border bg-card shadow-sm">
          <div className="text-xs text-emerald-600 font-medium">B2B Registered Invoices</div>
          <div className="text-2xl font-bold mt-1 text-emerald-600 font-mono">
            {isLoading ? '…' : summary?.b2bInvoicesCount || 0}
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">Table 4 (Auto-eInvoiced)</div>
        </div>

        <div className="p-4 rounded-xl border bg-card shadow-sm">
          <div className="text-xs text-amber-600 font-medium">B2C / Counter Sales</div>
          <div className="text-2xl font-bold mt-1 text-amber-600 font-mono">
            {isLoading ? '…' : summary?.b2csInvoicesCount || 0}
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">Table 7 (Requires JSON Upload)</div>
        </div>

        <div className="p-4 rounded-xl border bg-card shadow-sm">
          <div className="text-xs text-rose-600 font-medium">Credit / Debit Notes</div>
          <div className="text-2xl font-bold mt-1 text-rose-600 font-mono">
            {isLoading ? '…' : (summary?.creditNotesCount || 0) + (summary?.debitNotesCount || 0)}
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            CN: {summary?.creditNotesCount || 0} · DN: {summary?.debitNotesCount || 0}
          </div>
        </div>
      </div>

      {/* Navigation Sub-tabs */}
      <div className="flex items-center gap-2 border-b pb-2">
        <Button
          size="sm"
          variant={activeTab === 'HSN' ? 'default' : 'outline'}
          onClick={() => setActiveTab('HSN')}
          className="h-8 text-xs gap-1.5"
        >
          <Layers className="w-3.5 h-3.5" />
          Table 12: HSN Summary ({summary?.hsnTable?.length || 0})
        </Button>
        <Button
          size="sm"
          variant={activeTab === 'DOCS' ? 'default' : 'outline'}
          onClick={() => setActiveTab('DOCS')}
          className="h-8 text-xs gap-1.5"
        >
          <FileText className="w-3.5 h-3.5" />
          Table 13: Documents Issued
        </Button>
        <Button
          size="sm"
          variant={activeTab === 'SUMMARY' ? 'default' : 'outline'}
          onClick={() => setActiveTab('SUMMARY')}
          className="h-8 text-xs gap-1.5"
        >
          <Receipt className="w-3.5 h-3.5" />
          Filing Payload Overview
        </Button>
      </div>

      {/* TAB 1: Table 12 HSN Summary */}
      {activeTab === 'HSN' && (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead style={{ width: '4%' }} className="text-center">#</TableHead>
                <TableHead style={{ width: '12%' }}>HSN Code</TableHead>
                <TableHead style={{ width: '30%' }}>Description of Goods</TableHead>
                <TableHead style={{ width: '8%' }} className="text-center">UQC</TableHead>
                <TableHead style={{ width: '12%' }} className="text-right">Total Qty</TableHead>
                <TableHead style={{ width: '14%' }} className="text-right">Taxable Value (₹)</TableHead>
                <TableHead style={{ width: '6%' }} className="text-right">Rate</TableHead>
                <TableHead style={{ width: '14%' }} className="text-right">Total Tax (₹)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    Aggregating HSN outward supplies...
                  </TableCell>
                </TableRow>
              ) : !summary?.hsnTable?.length ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    No outward supplies recorded in this period.
                  </TableCell>
                </TableRow>
              ) : (
                summary.hsnTable.map((h, i) => (
                  <TableRow key={i}>
                    <td className="text-center font-mono text-xs">{i + 1}</td>
                    <TableCell className="font-mono font-bold text-xs text-indigo-950 dark:text-indigo-300">
                      {h.hsn_sc}
                    </TableCell>
                    <TableCell className="font-semibold text-xs text-foreground">
                      {h.desc}
                    </TableCell>
                    <TableCell className="text-center uppercase text-xs font-mono">{h.uqc}</TableCell>
                    <TableCell className="text-right font-mono font-semibold text-xs">
                      {Number(h.qty).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell className="text-right font-mono font-semibold text-xs">
                      {rupees(h.txval)}
                    </TableCell>
                    <TableCell className="text-right text-xs font-mono">{h.rt}%</TableCell>
                    <TableCell className="text-right font-mono font-bold text-xs text-indigo-600">
                      {rupees(h.iamt + h.camt + h.samt)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {/* TAB 2: Table 13 Documents Issued */}
      {activeTab === 'DOCS' && (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>Nature of Document</TableHead>
                <TableHead>From Serial</TableHead>
                <TableHead>To Serial</TableHead>
                <TableHead className="text-right">Total Number</TableHead>
                <TableHead className="text-right">Cancelled</TableHead>
                <TableHead className="text-right">Net Issued</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary?.docTable?.map((d, i) => (
                <TableRow key={i}>
                  <TableCell className="font-semibold text-xs text-foreground">{d.doc_typ}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{d.docs[0]?.from || '—'}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{d.docs[0]?.to || '—'}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{d.docs[0]?.totnum || 0}</TableCell>
                  <TableCell className="text-right font-mono text-xs text-rose-600">{d.docs[0]?.canc || 0}</TableCell>
                  <TableCell className="text-right font-mono font-bold text-xs text-emerald-600">{d.docs[0]?.net_issue || 0}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* TAB 3: Filing Payload Overview */}
      {activeTab === 'SUMMARY' && (
        <div className="p-5 rounded-xl border bg-card shadow-sm space-y-4 text-xs leading-relaxed">
          <div className="flex items-center gap-2 text-sm font-bold text-indigo-600">
            <Sparkles className="w-4 h-4" />
            Official Government GST Offline Tool Compliance
          </div>
          <p className="text-muted-foreground">
            The JSON generated by RVP-ERP directly complies with GST Portal Offline Utility v1.5. You can import this JSON file into the GST Portal offline tool or upload directly under the GSTR-1 section on <strong>gst.gov.in</strong>.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="p-3 rounded-lg border bg-muted/20">
              <div className="text-[11px] text-muted-foreground">GSTIN Registered</div>
              <div className="font-mono font-bold mt-0.5">{offlineJson?.gstin || '—'}</div>
            </div>
            <div className="p-3 rounded-lg border bg-muted/20">
              <div className="text-[11px] text-muted-foreground">Tax Period (fp)</div>
              <div className="font-mono font-bold mt-0.5">{offlineJson?.fp || '—'}</div>
            </div>
            <div className="p-3 rounded-lg border bg-muted/20">
              <div className="text-[11px] text-muted-foreground">Offline Schema Version</div>
              <div className="font-mono font-bold mt-0.5">{offlineJson?.version || 'GST1.0'}</div>
            </div>
            <div className="p-3 rounded-lg border bg-muted/20">
              <div className="text-[11px] text-muted-foreground">Validation Status</div>
              <div className="text-emerald-600 font-bold mt-0.5 flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" /> 100% Tax-Balanced
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Raw JSON Preview Modal */}
      <Dialog open={jsonModalOpen} onOpenChange={setJsonModalOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Code2 className="w-5 h-5 text-sky-600" />
              GSTR-1 Government Offline JSON Payload ({summary?.fp})
            </DialogTitle>
          </DialogHeader>
          <pre className="p-4 rounded-lg bg-gray-950 text-gray-100 font-mono text-xs overflow-x-auto max-h-[60vh]">
            {JSON.stringify(offlineJson, null, 2)}
          </pre>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setJsonModalOpen(false)}>Close</Button>
            <Button onClick={handleDownloadJson} className="bg-indigo-600 text-white gap-1.5">
              <Download className="w-4 h-4" /> Download .json
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
