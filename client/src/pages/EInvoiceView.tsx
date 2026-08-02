import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer, FileText } from 'lucide-react';
import { api } from '@/lib/api';
import type { SaleDispatch, CompanyProfile, ProductTaxInfo } from '@/lib/types';
import { InvoiceDocument, InvoiceStyles, parseInvoiceLayout } from '@/components/InvoiceDocument';
import { Button } from '@/components/ui/button';

/**
 * The e-Invoice print view. Renders the very same InvoiceDocument as the plain
 * invoice view - the only difference is the entry point - so there is exactly
 * one invoice format in the ERP.
 */
export default function EInvoiceView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: dispatch, isLoading } = useQuery({
    queryKey: ['sale-dispatch', id],
    queryFn: () => api<SaleDispatch>(`/sale-dispatches/${id}`),
    enabled: !!id,
  });

  const order = dispatch?.saleOrder;

  const { data: company } = useQuery({ queryKey: ['company'], queryFn: () => api<CompanyProfile>('/settings/company') });
  const { data: taxRows } = useQuery({ queryKey: ['product-tax'], queryFn: () => api<ProductTaxInfo[]>('/settings/product-tax') });

  if (isLoading || !dispatch || !company || !order || !order.buyer) {
    return <div className="p-8 text-center text-muted-foreground animate-pulse">Loading e-Invoice data…</div>;
  }

  if (!dispatch.irn) {
    return (
      <div className="p-8 text-center">
        <h2 className="text-xl font-bold text-rose-600 mb-2">E-Invoice Not Generated</h2>
        <p className="text-muted-foreground mb-4">Generate the IRN first before printing the e-Invoice.</p>
        <Button onClick={() => navigate(-1)}><ArrowLeft className="mr-2 h-4 w-4" /> Go Back</Button>
      </div>
    );
  }

  const layout = parseInvoiceLayout(company.invoiceLayout);

  return (
    <div className="min-h-screen bg-muted/40 font-sans">
      <InvoiceStyles paperSize={layout.paperSize} />

      {/* Toolbar (not printed) */}
      <div className="inv-no-print sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b bg-background px-4 py-2 shadow-sm">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => navigate(-1)}><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
          <span className="ml-2 flex items-center gap-1 text-sm font-medium text-muted-foreground">
            <FileText className="h-4 w-4" /> e-Invoice Viewer
          </span>
        </div>
        <Button size="sm" onClick={() => window.print()} className="bg-indigo-600 text-white hover:bg-indigo-700">
          <Printer className="h-4 w-4 mr-1" /> Print e-Invoice
        </Button>
      </div>

      <div className="flex justify-center py-6 inv-print-area">
        <InvoiceDocument dispatch={dispatch} order={order} company={company} taxRows={taxRows} layout={layout} />
      </div>
    </div>
  );
}
