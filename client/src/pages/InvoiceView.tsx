import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Printer, Save, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { SaleDispatch, CompanyProfile, ProductTaxInfo } from '@/lib/types';
import {
  InvoiceDocument, InvoiceStyles, DEFAULT_LAYOUT, parseInvoiceLayout, type InvoiceLayout,
} from '@/components/InvoiceDocument';
import { Button } from '@/components/ui/button';

export default function InvoiceView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [showControls, setShowControls] = useState(true);

  const { data: dispatch } = useQuery({ queryKey: ['sale-dispatch', id], queryFn: () => api<SaleDispatch>(`/sale-dispatches/${id}`), enabled: !!id });
  const order = dispatch?.saleOrder;
  const { data: company } = useQuery({ queryKey: ['company'], queryFn: () => api<CompanyProfile>('/settings/company') });
  const { data: taxRows } = useQuery({ queryKey: ['product-tax'], queryFn: () => api<ProductTaxInfo[]>('/settings/product-tax') });

  const [layout, setLayout] = useState<InvoiceLayout>(DEFAULT_LAYOUT);
  useEffect(() => {
    setLayout(parseInvoiceLayout(company?.invoiceLayout));
  }, [company?.invoiceLayout]);

  const saveLayout = useMutation({
    mutationFn: () => api('/settings/invoice-layout', { method: 'PUT', body: { layout } }),
    onSuccess: () => toast.success('Layout saved'),
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  if (!dispatch || !order || !company) return <div className="p-8 text-muted-foreground">Loading invoice…</div>;

  const c = layout.cols;

  return (
    <div className="min-h-screen bg-muted/40 font-sans">
      <InvoiceStyles paperSize={layout.paperSize} />

      {/* Toolbar (not printed) */}
      <div className="inv-no-print sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2 shadow-sm">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}><ArrowLeft className="h-4 w-4" /> Back</Button>
        <Button size="sm" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print / Save PDF</Button>
        <Button size="sm" variant="outline" onClick={() => setShowControls((s) => !s)}><SlidersHorizontal className="h-4 w-4" /> {showControls ? 'Hide' : 'Adjust'} layout</Button>
        <span className="ml-auto text-sm text-muted-foreground">Invoice {dispatch.invoiceNumber ?? '(not raised)'}</span>
      </div>

      {showControls && (
        <div className="inv-no-print border-b bg-background px-4 py-3 text-sm">
          <div className="flex flex-wrap items-end gap-4">
            <Ctl label="Paper">
              <select className="h-8 rounded-md border bg-background px-2" value={layout.paperSize} onChange={(e) => setLayout((l) => ({ ...l, paperSize: e.target.value as InvoiceLayout['paperSize'] }))}>
                <option value="A4">A4</option><option value="A5">A5</option><option value="Letter">Letter</option>
              </select>
            </Ctl>
            <Num label="Margin (mm)" value={layout.marginMm} min={0} max={30} onChange={(v) => setLayout((l) => ({ ...l, marginMm: v }))} />
            <Num label="Font (px)" value={layout.fontPx} min={7} max={18} step={0.5} onChange={(v) => setLayout((l) => ({ ...l, fontPx: v }))} />
            <Num label="Header left %" value={layout.headerLeftPct} min={35} max={75} onChange={(v) => setLayout((l) => ({ ...l, headerLeftPct: v }))} />
            <div className="flex items-end gap-2">
              {(['sl', 'desc', 'hsn', 'qty', 'rate', 'per', 'amt'] as const).map((k) => (
                <Num key={k} label={k} value={c[k]} min={2} max={50} small onChange={(v) => setLayout((l) => ({ ...l, cols: { ...l.cols, [k]: v } }))} />
              ))}
            </div>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setLayout(DEFAULT_LAYOUT)}><RotateCcw className="h-4 w-4" /> Reset</Button>
              <Button size="sm" onClick={() => saveLayout.mutate()} disabled={saveLayout.isPending}><Save className="h-4 w-4" /> Save layout</Button>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Column widths are percentages of the table width. Tweak, then Print / Save PDF.</p>
        </div>
      )}

      {/* The invoice page */}
      <div className="flex justify-center py-6 inv-print-area">
        <InvoiceDocument dispatch={dispatch} order={order} company={company} taxRows={taxRows} layout={layout} />
      </div>
    </div>
  );
}

function Ctl({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">{label}</span>{children}</label>;
}

function Num({ label, value, onChange, min, max, step = 1, small }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; small?: boolean }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input type="number" value={value} min={min} max={max} step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`h-8 rounded-md border bg-background px-2 ${small ? 'w-14' : 'w-24'}`} />
    </label>
  );
}
