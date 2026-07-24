import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileText, Truck, Printer, Search, Mail } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { shortDate } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { SaleDispatch, EmailLog } from '@/lib/types';

interface TaxproReportData {
  sales: SaleDispatch[];
  purchases: any[];
}

const DOC_TYPE_LABEL: Record<EmailLog['documentType'], string> = {
  INVOICE: 'Tax Invoice',
  EWB: 'E-Way Bill',
  CREDIT_NOTE: 'Credit Note',
  DEBIT_NOTE: 'Debit Note',
};

export default function IrnEwbReport() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');

  const { data, isLoading } = useQuery<TaxproReportData>({
    queryKey: ['taxpro-report'],
    queryFn: () => api<TaxproReportData>('/taxpro/list'),
  });

  const { data: emailLogs, isLoading: loadingLogs } = useQuery({
    queryKey: ['email-logs'],
    queryFn: () => api<EmailLog[]>('/email-logs'),
  });

  const resendMutation = useMutation({
    mutationFn: (id: string) => api(`/email-logs/${id}/resend`, { method: 'POST' }),
    onSuccess: () => { toast.success('Email resent'); qc.invalidateQueries({ queryKey: ['email-logs'] }); },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const sales = data?.sales || [];
  
  // Filter logic
  const filteredSales = sales.filter(s => {
    const term = searchQuery.toLowerCase();
    const party = s.saleOrder?.buyer?.name?.toLowerCase() || '';
    const inv = s.invoiceNumber?.toLowerCase() || '';
    const irn = s.irn?.toLowerCase() || '';
    const ewb = s.ewbNumber?.toLowerCase() || '';
    return party.includes(term) || inv.includes(term) || irn.includes(term) || ewb.includes(term);
  });

  const irnSales = filteredSales.filter(s => s.irn);
  const ewbSales = filteredSales.filter(s => s.ewbNumber);

  const sendInvoiceEmailMutation = useMutation({
    mutationFn: (id: string) => api(`/sale-dispatches/${id}/einvoice/email`, { method: 'POST' }),
    onSuccess: () => { toast.success('Invoice emailed to buyer'); qc.invalidateQueries({ queryKey: ['email-logs'] }); },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const sendEwbEmailMutation = useMutation({
    mutationFn: (id: string) => api(`/sale-dispatches/${id}/ewaybill/email`, { method: 'POST' }),
    onSuccess: () => { toast.success('E-Way Bill emailed to buyer'); qc.invalidateQueries({ queryKey: ['email-logs'] }); },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // Open the full official-format print pages (rendered from the signed IRN /
  // EWB data), not a stripped-down popup.
  const handlePrint = (dispatch: SaleDispatch, type: 'IRN' | 'EWB') => {
    navigate(type === 'IRN'
      ? `/sale-dispatches/${dispatch.id}/einvoice-print`
      : `/sale-dispatches/${dispatch.id}/ewaybill`);
  };

  return (
    <div className="space-y-6">
      <PageHeader 
        title="IRN & EWB Reports" 
        description="Manage and print generated E-Invoices and E-Way Bills" 
        icon={FileText} 
      />

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

      <Tabs defaultValue="einvoice" className="space-y-6">
        <TabsList className="bg-card border shadow-sm">
          <TabsTrigger value="einvoice" className="gap-2">
            <FileText className="h-4 w-4" /> E-Invoices (IRN)
          </TabsTrigger>
          <TabsTrigger value="ewaybill" className="gap-2">
            <Truck className="h-4 w-4" /> E-Way Bills (EWB)
          </TabsTrigger>
          <TabsTrigger value="emaillog" className="gap-2">
            <Mail className="h-4 w-4" /> Email Log
          </TabsTrigger>
        </TabsList>

        <TabsContent value="einvoice" className="space-y-4">
          <Tabs defaultValue="sales" className="w-full">
            <TabsList className="mb-4">
              <TabsTrigger value="sales">Sales</TabsTrigger>
              <TabsTrigger value="purchases">Purchases</TabsTrigger>
            </TabsList>
            
            <TabsContent value="sales">
              <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead>Invoice</TableHead>
                      <TableHead>Party</TableHead>
                      <TableHead>IRN Details</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading ? (
                      <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
                    ) : irnSales.length === 0 ? (
                      <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No E-Invoices found</TableCell></TableRow>
                    ) : (
                      irnSales.map(s => (
                        <TableRow key={s.id}>
                          <TableCell>
                            <div className="font-medium">{s.invoiceNumber || 'N/A'}</div>
                            <div className="text-xs text-muted-foreground">{s.invoiceDate ? shortDate(s.invoiceDate) : ''}</div>
                          </TableCell>
                          <TableCell className="font-medium">{s.saleOrder?.buyer?.name}</TableCell>
                          <TableCell>
                            <div className="text-xs font-mono text-muted-foreground truncate max-w-[200px]" title={s.irn || ''}>{s.irn}</div>
                            <div className="text-[10px] text-muted-foreground">Ack: {s.irnAckNo}</div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={s.irnStatus === 'CANCELLED' ? 'destructive' : 'success'}>
                              {s.irnStatus}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right space-x-1.5">
                            <Button size="sm" variant="outline" onClick={() => handlePrint(s, 'IRN')}>
                              <Printer className="h-3.5 w-3.5 mr-1.5" /> Print
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              title={s.saleOrder?.buyer?.email ? undefined : 'Add an email in Parties first'}
                              disabled={!s.saleOrder?.buyer?.email || sendInvoiceEmailMutation.isPending}
                              onClick={() => sendInvoiceEmailMutation.mutate(s.id)}
                            >
                              <Mail className="h-3.5 w-3.5 mr-1.5" /> Send
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
            
            <TabsContent value="purchases">
              <div className="rounded-xl border border-dashed border-border py-12 text-center text-muted-foreground bg-card shadow-sm">
                E-Invoice tracking for Purchases is not configured in the database yet.
              </div>
            </TabsContent>
          </Tabs>
        </TabsContent>

        <TabsContent value="ewaybill" className="space-y-4">
          <Tabs defaultValue="sales" className="w-full">
            <TabsList className="mb-4">
              <TabsTrigger value="sales">Sales</TabsTrigger>
              <TabsTrigger value="purchases">Purchases</TabsTrigger>
            </TabsList>
            
            <TabsContent value="sales">
              <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead>Invoice</TableHead>
                      <TableHead>Party</TableHead>
                      <TableHead>EWB Details</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading ? (
                      <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
                    ) : ewbSales.length === 0 ? (
                      <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No E-Way Bills found</TableCell></TableRow>
                    ) : (
                      ewbSales.map(s => (
                        <TableRow key={s.id}>
                          <TableCell>
                            <div className="font-medium">{s.invoiceNumber || 'N/A'}</div>
                            <div className="text-xs text-muted-foreground">{s.invoiceDate ? shortDate(s.invoiceDate) : ''}</div>
                          </TableCell>
                          <TableCell className="font-medium">{s.saleOrder?.buyer?.name}</TableCell>
                          <TableCell>
                            <div className="font-mono text-sm">{s.ewbNumber}</div>
                            <div className="text-[10px] text-muted-foreground">Valid: {s.ewbValidUpto ? shortDate(s.ewbValidUpto) : 'N/A'}</div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={s.ewbStatus === 'CANCELLED' ? 'destructive' : 'success'}>
                              {s.ewbStatus}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right space-x-1.5">
                            <Button size="sm" variant="outline" onClick={() => handlePrint(s, 'EWB')}>
                              <Printer className="h-3.5 w-3.5 mr-1.5" /> Print
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              title={s.saleOrder?.buyer?.email ? undefined : 'Add an email in Parties first'}
                              disabled={!s.saleOrder?.buyer?.email || sendEwbEmailMutation.isPending}
                              onClick={() => sendEwbEmailMutation.mutate(s.id)}
                            >
                              <Mail className="h-3.5 w-3.5 mr-1.5" /> Send
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
            
            <TabsContent value="purchases">
              <div className="rounded-xl border border-dashed border-border py-12 text-center text-muted-foreground bg-card shadow-sm">
                E-Way Bill tracking for Purchases is not configured in the database yet.
              </div>
            </TabsContent>
          </Tabs>
        </TabsContent>

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
                        <Badge variant={log.status === 'FAILED' ? 'destructive' : 'success'}>{log.status}</Badge>
                        {log.status === 'FAILED' && log.errorMessage && (
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
        </TabsContent>
      </Tabs>
    </div>
  );
}
