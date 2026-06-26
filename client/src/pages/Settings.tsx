import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Truck, Save, Building2, Landmark, FileText, ShieldCheck } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { FreightRate, CompanyProfile, ProductTaxInfo, SaleProduct, ProductionCostComponent } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface RateRow { id?: string; destination: string; ratePerTonne: string }

const PRODUCT_LABELS: Record<SaleProduct, string> = {
  PAPPU: 'Pappu (Tamarind Seed Kernel)',
  HUSK: 'Husk',
  WASTE: 'Tamarind Waste',
  TPS: 'TPS (Brokens)',
  SHELL: 'Tamarind Shell',
};

export default function Settings() {
  const qc = useQueryClient();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Company details, bank, invoice setup and rates used across the app.</p>
      </div>

      <Tabs defaultValue="company" className="space-y-4">
        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="company">Company</TabsTrigger>
          <TabsTrigger value="invoice">Invoice Setup</TabsTrigger>
          <TabsTrigger value="freight">Freight Rates</TabsTrigger>
          <TabsTrigger value="production">Production Cost</TabsTrigger>
          <TabsTrigger value="taxpro">TaxPro GSP</TabsTrigger>
        </TabsList>

        <TabsContent value="company" className="focus-visible:outline-none focus-visible:ring-0">
          <CompanySection qc={qc} />
        </TabsContent>

        <TabsContent value="invoice" className="focus-visible:outline-none focus-visible:ring-0">
          <InvoiceTaxSection qc={qc} />
        </TabsContent>

        <TabsContent value="freight" className="focus-visible:outline-none focus-visible:ring-0">
          <FreightSection qc={qc} />
        </TabsContent>

        <TabsContent value="production" className="focus-visible:outline-none focus-visible:ring-0">
          <ProductionCostSection qc={qc} />
        </TabsContent>

        <TabsContent value="taxpro" className="focus-visible:outline-none focus-visible:ring-0">
          <TaxproGspSection qc={qc} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// --- Production cost components (₹/kg, summed into pappu cost) -------------------

interface CostRow { name: string; ratePerKg: string }

function ProductionCostSection({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { data, isLoading } = useQuery({
    queryKey: ['production-cost'],
    queryFn: () => api<ProductionCostComponent[]>('/settings/production-cost'),
  });

  const [rows, setRows] = useState<CostRow[]>([]);
  useEffect(() => {
    if (data) setRows(data.map((r) => ({ name: r.name, ratePerKg: String(r.ratePerKg) })));
  }, [data]);

  const save = useMutation({
    mutationFn: () => {
      const components = rows
        .filter((r) => r.name.trim())
        .map((r) => ({ name: r.name.trim(), ratePerKg: Number(r.ratePerKg) || 0 }));
      return api<ProductionCostComponent[]>('/settings/production-cost', { method: 'PUT', body: { components } });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['production-cost'] });
      toast.success('Production cost saved');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const setRow = (i: number, patch: Partial<CostRow>) => setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((prev) => [...prev, { name: '', ratePerKg: '0' }]);
  const removeRow = (i: number) => setRows((prev) => prev.filter((_, idx) => idx !== i));

  const total = rows.reduce((s, r) => s + (Number(r.ratePerKg) || 0), 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2">
        <Landmark className="h-5 w-5 text-emerald-500" />
        <CardTitle className="text-base">Production Cost (₹ / kg)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Add cost components (electricity, labour, packing…) each as ₹/kg. Their total is the production cost per kg, added on top of the black-seed cost for pappu — it drives the displayed cost, the 3% sale-margin check, and COGS.
        </p>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-[1fr_180px_40px] gap-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Label>Component</Label>
              <Label>Rate (₹/kg)</Label>
              <span />
            </div>
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_180px_40px] gap-3 items-center">
                <Input value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} placeholder="e.g. Electricity" />
                <Input type="number" step="0.0001" value={r.ratePerKg} onChange={(e) => setRow(i, { ratePerKg: e.target.value })} />
                <Button variant="ghost" size="icon" onClick={() => removeRow(i)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
            {rows.length === 0 && <p className="text-sm text-muted-foreground">No components yet.</p>}

            <div className="flex items-center justify-between border-t pt-2">
              <span className="text-sm font-semibold">Total production cost: ₹{total.toFixed(2)}/kg</span>
            </div>

            <div className="flex items-center justify-between pt-1">
              <Button variant="outline" size="sm" onClick={addRow}>
                <Plus className="h-4 w-4" /> Add component
              </Button>
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                <Save className="h-4 w-4" /> {save.isPending ? 'Saving…' : 'Save production cost'}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// --- Company + bank details -----------------------------------------------------

const emptyCompany: CompanyProfile = {
  id: 'default', name: '', address: '', gstin: '', stateName: '', stateCode: '', contact: '',
  bankAccountName: '', bankName: '', bankAccountNumber: '', bankBranchIfsc: '', invoicePrefix: 'RVP',
  freightRetentionPerTrip: 3000,
  taxproGspId: '', taxproGspSecret: '', taxproGstUser: '', taxproGstPass: '', taxproSandbox: true,
};

function CompanySection({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { data, isLoading } = useQuery({ queryKey: ['company'], queryFn: () => api<CompanyProfile>('/settings/company') });
  const [form, setForm] = useState<CompanyProfile>(emptyCompany);
  useEffect(() => { if (data) setForm({ ...emptyCompany, ...data }); }, [data]);

  const save = useMutation({
    mutationFn: () => api<CompanyProfile>('/settings/company', { method: 'PUT', body: form }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['company'] }); toast.success('Company details saved'); },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const set = (k: keyof CompanyProfile) => (e: { target: { value: string } }) => setForm((p) => ({ ...p, [k]: e.target.value }));
  const field = (label: string, k: keyof CompanyProfile, placeholder = '') => (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <Input value={(form[k] as string) ?? ''} onChange={set(k)} placeholder={placeholder} />
    </div>
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2">
        <Building2 className="h-5 w-5 text-sky-500" />
        <CardTitle className="text-base">Company Details (seller on invoices)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              {field('Business name', 'name', 'RVP INDUSTRIES')}
              {field('Contact', 'contact', '+91-…')}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Address (printed as-is, multi-line)</Label>
              <textarea
                value={form.address ?? ''}
                onChange={set('address')}
                rows={4}
                placeholder={'#3-86 Survey No …\nNew Bypass Road, …\nDistrict, State - PIN'}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Company Vehicles (Exempt from Kata & Hamali)</Label>
              <textarea
                value={form.companyVehicles ?? ''}
                onChange={set('companyVehicles')}
                rows={2}
                placeholder={'AP03XX1234, KA01YY5678'}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <p className="text-[10px] text-muted-foreground">List vehicle numbers (comma or newline separated). They will automatically have ₹0 kata fee and hamali charges.</p>
            </div>
            <div className="space-y-1.5 max-w-xs">
              <Label className="text-xs">Sale freight retention (₹ held per trip)</Label>
              <Input
                type="number"
                step="0.01"
                value={String(form.freightRetentionPerTrip ?? 3000)}
                onChange={(e) => setForm((p) => ({ ...p, freightRetentionPerTrip: e.target.value }))}
                placeholder="3000"
              />
              <p className="text-[10px] text-muted-foreground">Held back from each sale lorry freight until the kata slip arrives, then paid to Surya Roadlines. The rest (less unloading hamali &amp; kata) goes to the lorry owner.</p>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              {field('GSTIN/UIN', 'gstin', '37ABJFR4630H1Z1')}
              {field('State name', 'stateName', 'Andhra Pradesh')}
              {field('State code', 'stateCode', '37')}
            </div>

            <div className="flex items-center gap-2 pt-2 border-t">
              <Landmark className="h-4 w-4 text-emerald-500" />
              <span className="text-sm font-medium">Bank details (invoice footer)</span>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {field("A/c holder's name", 'bankAccountName', 'RVP INDUSTRIES')}
              {field('Bank name', 'bankName', 'UNION BANK OF INDIA')}
              {field('A/c number', 'bankAccountNumber', '668305010000108')}
              {field('Branch & IFS code', 'bankBranchIfsc', 'Punganur & UBIN0566837')}
            </div>

            <div className="flex justify-end">
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                <Save className="h-4 w-4" /> {save.isPending ? 'Saving…' : 'Save company details'}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// --- Invoice numbering prefix + per-product HSN ---------------------------------

function InvoiceTaxSection({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { data: company } = useQuery({ queryKey: ['company'], queryFn: () => api<CompanyProfile>('/settings/company') });
  const { data, isLoading } = useQuery({ queryKey: ['product-tax'], queryFn: () => api<ProductTaxInfo[]>('/settings/product-tax') });

  const [prefix, setPrefix] = useState('RVP');
  const [rows, setRows] = useState<ProductTaxInfo[]>([]);
  useEffect(() => { if (company) setPrefix(company.invoicePrefix || 'RVP'); }, [company]);
  useEffect(() => { if (data) setRows(data); }, [data]);

  const savePrefix = useMutation({
    mutationFn: () => api<CompanyProfile>('/settings/company', { method: 'PUT', body: { ...company, invoicePrefix: prefix.trim() || 'RVP' } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['company'] }); toast.success('Invoice prefix saved'); },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });
  const saveTax = useMutation({
    mutationFn: () => api<ProductTaxInfo[]>('/settings/product-tax', { method: 'PUT', body: { rows: rows.map((r) => ({ product: r.product, hsn: r.hsn, hsnExempt: r.hsnExempt, description: r.description })) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['product-tax'] }); toast.success('HSN / descriptions saved'); },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const setRow = (i: number, patch: Partial<ProductTaxInfo>) => setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2">
        <FileText className="h-5 w-5 text-violet-500" />
        <CardTitle className="text-base">Invoice Setup</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5 max-w-sm">
          <Label className="text-xs">Invoice number prefix</Label>
          <div className="flex gap-2">
            <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="RVP" />
            <Button variant="outline" onClick={() => savePrefix.mutate()} disabled={savePrefix.isPending}>Save</Button>
          </div>
          <p className="text-[11px] text-muted-foreground">Numbers are auto-generated as <span className="font-mono">{(prefix || 'RVP')}/01/2026-27</span> and reset each financial year.</p>
        </div>

        <div className="space-y-3">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">HSN / SAC &amp; description per commodity</Label>
          {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : (
            <>
              <div className="grid grid-cols-[160px_120px_120px_1fr] gap-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <span>Commodity</span><span>HSN (with GST)</span><span>HSN (no GST)</span><span>Invoice description</span>
              </div>
              {rows.map((r, i) => (
                <div key={r.product} className="grid grid-cols-[160px_120px_120px_1fr] gap-3 items-center">
                  <span className="text-sm">{PRODUCT_LABELS[r.product]}</span>
                  <Input value={r.hsn ?? ''} onChange={(e) => setRow(i, { hsn: e.target.value })} placeholder="1207" />
                  <Input value={r.hsnExempt ?? ''} onChange={(e) => setRow(i, { hsnExempt: e.target.value })} placeholder="optional" />
                  <Input value={r.description ?? ''} onChange={(e) => setRow(i, { description: e.target.value })} placeholder="Tamarind Seed Kernel" />
                </div>
              ))}
              <div className="flex justify-end">
                <Button onClick={() => saveTax.mutate()} disabled={saveTax.isPending}>
                  <Save className="h-4 w-4" /> {saveTax.isPending ? 'Saving…' : 'Save HSN / descriptions'}
                </Button>
              </div>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// --- Outward freight rates (unchanged) -----------------------------------------

function FreightSection({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { data, isLoading } = useQuery({
    queryKey: ['freight-rates'],
    queryFn: () => api<FreightRate[]>('/settings/freight-rates'),
  });

  const [rows, setRows] = useState<RateRow[]>([]);
  useEffect(() => {
    if (data) setRows(data.map((r) => ({ id: r.id, destination: r.destination, ratePerTonne: String(r.ratePerTonne) })));
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const rates = rows
        .filter((r) => r.destination.trim())
        .map((r) => ({ destination: r.destination.trim(), ratePerTonne: Number(r.ratePerTonne) || 0 }));
      return api<FreightRate[]>('/settings/freight-rates', { method: 'PUT', body: { rates } });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['freight-rates'] }); toast.success('Freight rates saved'); },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/settings/freight-rates/${id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['freight-rates'] }); toast.success('Destination removed'); },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function setRow(i: number, patch: Partial<RateRow>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() { setRows((prev) => [...prev, { destination: '', ratePerTonne: '0' }]); }
  function removeRow(i: number) {
    const row = rows[i];
    if (row.id) { if (confirm(`Remove ${row.destination}?`)) deleteMutation.mutate(row.id); }
    else { setRows((prev) => prev.filter((_, idx) => idx !== i)); }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2">
        <Truck className="h-5 w-5 text-amber-500" />
        <CardTitle className="text-base">Outward Freight Rates (₹ / tonne)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Per-destination freight we bear when selling at a delivery price. New sales auto-fill freight as rate × weight (still editable per sale).
        </p>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-[1fr_180px_40px] gap-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Label>Destination</Label>
              <Label>Rate (₹/tonne)</Label>
              <span />
            </div>
            {rows.map((r, i) => (
              <div key={r.id ?? `new-${i}`} className="grid grid-cols-[1fr_180px_40px] gap-3 items-center">
                <Input value={r.destination} onChange={(e) => setRow(i, { destination: e.target.value })} placeholder="Destination name" disabled={!!r.id} />
                <Input type="number" step="0.01" value={r.ratePerTonne} onChange={(e) => setRow(i, { ratePerTonne: e.target.value })} />
                <Button variant="ghost" size="icon" onClick={() => removeRow(i)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
            {rows.length === 0 && <p className="text-sm text-muted-foreground">No destinations yet.</p>}

            <div className="flex items-center justify-between pt-2">
              <Button variant="outline" size="sm" onClick={addRow}>
                <Plus className="h-4 w-4" /> Add destination
              </Button>
              <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
                <Save className="h-4 w-4" /> {saveMutation.isPending ? 'Saving…' : 'Save rates'}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TaxproGspSection({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { data, isLoading } = useQuery({ queryKey: ['company'], queryFn: () => api<CompanyProfile>('/settings/company') });
  const [form, setForm] = useState<CompanyProfile>(emptyCompany);
  useEffect(() => { if (data) setForm({ ...emptyCompany, ...data }); }, [data]);

  const save = useMutation({
    mutationFn: () => api<CompanyProfile>('/settings/company', { method: 'PUT', body: form }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['company'] }); toast.success('TaxPro GSP settings saved'); },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const set = (k: keyof CompanyProfile) => (e: { target: { value: string } }) => setForm((p) => ({ ...p, [k]: e.target.value }));
  
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-indigo-500" />
        <CardTitle className="text-base">TaxPro GSP Credentials</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : (
          <>
            <p className="text-sm text-muted-foreground">
              Configure your TaxPro GSP credentials and GST portal credentials for automated E-Invoice (IRN) and E-Way Bill generation.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">TaxPro ASP GSP Client ID</Label>
                <Input value={form.taxproGspId ?? ''} onChange={set('taxproGspId')} placeholder="Enter client_id" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">TaxPro ASP GSP Client Secret</Label>
                <Input type="password" value={form.taxproGspSecret ?? ''} onChange={set('taxproGspSecret')} placeholder="Enter client_secret" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">GST Portal API Username</Label>
                <Input value={form.taxproGstUser ?? ''} onChange={set('taxproGstUser')} placeholder="Enter username created for API on portal" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">GST Portal API Password</Label>
                <Input type="password" value={form.taxproGstPass ?? ''} onChange={set('taxproGstPass')} placeholder="Enter API password" />
              </div>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!form.taxproSandbox}
                  onChange={(e) => setForm((p) => ({ ...p, taxproSandbox: e.target.checked }))}
                  className="rounded border border-input text-indigo-600 focus:ring-indigo-500 h-4 w-4"
                />
                <span className="text-sm font-medium">Sandbox Mode (Simulated responses for testing)</span>
              </label>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              When Sandbox Mode is enabled, the system will bypass the actual GSP APIs and return simulated successful IRNs, E-Way Bills, and QR codes for testing your invoice print layout safely.
            </p>

            <div className="flex justify-end pt-2">
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                <Save className="h-4 w-4" /> {save.isPending ? 'Saving…' : 'Save TaxPro settings'}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

