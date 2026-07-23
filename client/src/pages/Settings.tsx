import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Truck, Save, Building2, Landmark, FileText, ShieldCheck, MessageCircle } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { FreightRate, CompanyProfile, ProductTaxInfo, SaleProduct, ProductionCostComponent, HamaliRate } from '@/lib/types';
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
  PRECLEANER_DUST: 'Pre Cleaner Dust',
  NALLA_POKKULU: 'Nalla Pokkulu',
  NALLA_CHINTAPANDU: 'Nalla Chintapandu',
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
          <TabsTrigger value="hamali">Hamali Rates</TabsTrigger>
          <TabsTrigger value="production">Production Cost</TabsTrigger>
          <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
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

        <TabsContent value="hamali" className="focus-visible:outline-none focus-visible:ring-0">
          <HamaliRatesSection qc={qc} />
        </TabsContent>

        <TabsContent value="production" className="focus-visible:outline-none focus-visible:ring-0">
          <ProductionCostSection qc={qc} />
        </TabsContent>

        <TabsContent value="whatsapp" className="focus-visible:outline-none focus-visible:ring-0">
          <WhatsAppSection qc={qc} />
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
          Add cost components (electricity, labour, packing…) each as ₹/kg. Their total is the production cost per kg, added on top of the black-seed cost for pappu - it drives the displayed cost, the 3% sale-margin check, and COGS.
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
  ownerWhatsappNumber: '',
  alertRecipients: '',
  whatsappTestMode: true,
  whatsappTestNumber: '',
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
            <div className="grid gap-4 md:grid-cols-2">
              {field('Owner WhatsApp number (internal alerts)', 'ownerWhatsappNumber', '9876543210')}
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
              <div className="flex items-center justify-between">
                <Label className="text-xs">KNM Vehicles (Exempt from Kata & Hamali lorry-share)</Label>
                <Button 
                  type="button" 
                  variant="outline" 
                  size="sm" 
                  className="h-6 px-2 text-xs" 
                  onClick={() => {
                    const current = (form.companyVehicles || '').split(/[\n,]+/).map(v => v.trim()).filter(v => v);
                    setForm(p => ({ ...p, companyVehicles: [...current, ''].join('\n') }));
                  }}
                >
                  <Plus className="mr-1 h-3 w-3" /> Add Vehicle
                </Button>
              </div>
              <div className="space-y-2">
                {((form.companyVehicles || '').split('\n')).map((v, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <Input
                      value={v}
                      onChange={(e) => {
                        const current = (form.companyVehicles || '').split('\n');
                        current[idx] = e.target.value;
                        setForm(p => ({ ...p, companyVehicles: current.join('\n') }));
                      }}
                      placeholder="e.g. AP03XX1234"
                      className="h-8 text-sm uppercase"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive"
                      onClick={() => {
                        const current = (form.companyVehicles || '').split('\n');
                        current.splice(idx, 1);
                        setForm(p => ({ ...p, companyVehicles: current.join('\n') }));
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground">List vehicle numbers. These will automatically have ₹0 kata fee and ₹0 lorry-share hamali (100% borne by company).</p>
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
            <div className="grid gap-4 md:grid-cols-4">
              {field('GSTIN/UIN', 'gstin', '37ABJFR4630H1Z1')}
              {field('State name', 'stateName', 'Andhra Pradesh')}
              {field('State code', 'stateCode', '37')}
              {field('Pincode', 'pincode', '517247')}
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
    mutationFn: () => api<ProductTaxInfo[]>('/settings/product-tax', { method: 'PUT', body: { rows: rows.map((r) => ({ product: r.product, hsn: r.hsn, hsnExempt: r.hsnExempt, description: r.description, gstRate: r.gstRate })) } }),
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
              <div className="grid grid-cols-[150px_110px_110px_90px_1fr] gap-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <span>Commodity</span><span>HSN (with GST)</span><span>HSN (no GST)</span><span>GST %</span><span>Invoice description</span>
              </div>
              {rows.map((r, i) => (
                <div key={r.product} className="grid grid-cols-[150px_110px_110px_90px_1fr] gap-3 items-center">
                  <span className="text-sm">{PRODUCT_LABELS[r.product]}</span>
                  <Input value={r.hsn ?? ''} onChange={(e) => setRow(i, { hsn: e.target.value })} placeholder="1207" />
                  <Input value={r.hsnExempt ?? ''} onChange={(e) => setRow(i, { hsnExempt: e.target.value })} placeholder="optional" />
                  <Input type="number" step="0.01" min="0" max="100" value={r.gstRate ?? ''} onChange={(e) => setRow(i, { gstRate: e.target.value })} placeholder="5" />
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

// --- Per-operation hamali rates (₹/tonne, drive the live costing) ---------------

interface HamaliRow {
  key: string;
  label: string;
  ratePerTonne: string; // Total
  lorryPerTonne: string; // collected from the driver
  marginPerTonne: string; // company P/L benefit
  isCustom: boolean;
}

// Company-borne share is what's left of the total after the driver's collected share.
const companyShare = (r: HamaliRow) => Math.max(0, (Number(r.ratePerTonne) || 0) - (Number(r.lorryPerTonne) || 0));

function HamaliRatesSection({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { data, isLoading } = useQuery({
    queryKey: ['hamali-rates'],
    queryFn: () => api<HamaliRate[]>('/settings/hamali-rates'),
  });

  const [rows, setRows] = useState<HamaliRow[]>([]);
  useEffect(() => {
    if (data)
      setRows(
        data.map((r) => ({
          key: r.key,
          label: r.label,
          ratePerTonne: String(r.ratePerTonne),
          lorryPerTonne: String(r.lorryPerTonne ?? 0),
          marginPerTonne: String(r.marginPerTonne ?? 0),
          isCustom: !!r.isCustom,
        }))
      );
  }, [data]);

  const save = useMutation({
    mutationFn: () => {
      const rates = rows.map((r) => ({
        key: r.key,
        label: r.label.trim(),
        ratePerTonne: Number(r.ratePerTonne) || 0,
        lorryPerTonne: Number(r.lorryPerTonne) || 0,
        marginPerTonne: Number(r.marginPerTonne) || 0,
        isCustom: r.isCustom,
      }));
      return api<HamaliRate[]>('/settings/hamali-rates', { method: 'PUT', body: { rates } });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['hamali-rates'] }); toast.success('Hamali rates saved'); },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const setRow = (i: number, patch: Partial<HamaliRow>) => setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addCost = () =>
    setRows((prev) => [
      ...prev,
      { key: `CUSTOM_${Date.now()}`, label: '', ratePerTonne: '0', lorryPerTonne: '0', marginPerTonne: '0', isCustom: true },
    ]);
  const removeRow = (i: number) => setRows((prev) => prev.filter((_, idx) => idx !== i));

  const hasUnnamed = rows.some((r) => r.isCustom && !r.label.trim());

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2">
        <Truck className="h-5 w-5 text-orange-500" />
        <CardTitle className="text-base">Hamali Rates (₹ / tonne)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Labour (hamali) rates per operation. <strong>Total</strong> is the full charge; <strong>Lorry Share</strong> is
          collected from the driver (deducted off freight); <strong>Company Share</strong> = Total − Lorry is what we bear;
          <strong> Company P/L</strong> is our benefit when we collect more from the driver than we pay the crew. Editing a
          rate changes the charge on new transactions immediately. Any custom cost you add here is charged on every Pappu
          sale dispatch.
        </p>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-[1fr_repeat(4,110px)_32px] gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Label>Operation</Label>
              <Label className="text-right">Lorry Share</Label>
              <Label className="text-right">Company Share</Label>
              <Label className="text-right">Company P/L</Label>
              <Label className="text-right">Total</Label>
              <span />
            </div>
            {rows.map((r, i) => (
              <div key={r.key} className="grid grid-cols-[1fr_repeat(4,110px)_32px] gap-2 items-center">
                {r.isCustom ? (
                  <Input
                    placeholder="Cost name (e.g. Pappu Loading)"
                    value={r.label}
                    onChange={(e) => setRow(i, { label: e.target.value })}
                  />
                ) : (
                  <span className="text-sm">{r.label}</span>
                )}
                <Input type="number" step="0.01" className="text-right" value={r.lorryPerTonne} onChange={(e) => setRow(i, { lorryPerTonne: e.target.value })} />
                <Input type="number" className="text-right bg-muted/50" value={companyShare(r).toFixed(2)} readOnly tabIndex={-1} />
                <Input type="number" step="0.01" className="text-right" value={r.marginPerTonne} onChange={(e) => setRow(i, { marginPerTonne: e.target.value })} />
                <Input type="number" step="0.01" className="text-right" value={r.ratePerTonne} onChange={(e) => setRow(i, { ratePerTonne: e.target.value })} />
                {r.isCustom ? (
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => removeRow(i)} title="Remove cost">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                ) : (
                  <span />
                )}
              </div>
            ))}

            <div className="flex items-center justify-between pt-2">
              <Button variant="outline" size="sm" onClick={addCost}>
                <Plus className="h-4 w-4" /> Add cost
              </Button>
              <Button onClick={() => save.mutate()} disabled={save.isPending || hasUnnamed}>
                <Save className="h-4 w-4" /> {save.isPending ? 'Saving…' : 'Save hamali rates'}
              </Button>
            </div>
            {hasUnnamed && <p className="text-xs text-destructive">Give every custom cost a name before saving.</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// --- WhatsApp test-mode toggle --------------------------------------------------

type AlertMember = { name: string; phone: string };

function parseAlertMembers(raw?: string | null): AlertMember[] {
  try {
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) return arr.map((m) => ({ name: m?.name ?? '', phone: m?.phone ?? '' }));
  } catch { /* malformed — treat as empty */ }
  return [];
}

function WhatsAppSection({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { data, isLoading } = useQuery({ queryKey: ['company'], queryFn: () => api<CompanyProfile>('/settings/company') });
  const [form, setForm] = useState<CompanyProfile>(emptyCompany);
  // 3 fixed rows so the inputs stay put while typing; empties are dropped on save.
  const [members, setMembers] = useState<AlertMember[]>([{ name: '', phone: '' }, { name: '', phone: '' }, { name: '', phone: '' }]);
  useEffect(() => {
    if (!data) return;
    setForm({ ...emptyCompany, ...data });
    const parsed = parseAlertMembers(data.alertRecipients);
    setMembers([0, 1, 2].map((i) => parsed[i] ?? { name: '', phone: '' }));
  }, [data]);

  const save = useMutation({
    mutationFn: () => {
      const cleaned = members.filter((m) => m.name.trim() || m.phone.trim());
      const alertRecipients = cleaned.length ? JSON.stringify(cleaned) : '';
      return api<CompanyProfile>('/settings/company', { method: 'PUT', body: { ...form, alertRecipients } });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['company'] }); toast.success('WhatsApp settings saved'); },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const setMember = (i: number, key: keyof AlertMember, value: string) =>
    setMembers((prev) => prev.map((m, j) => (j === i ? { ...m, [key]: value } : m)));

  const testMode = form.whatsappTestMode ?? true;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2">
        <MessageCircle className="h-5 w-5 text-green-500" />
        <CardTitle className="text-base">WhatsApp Messaging</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : (
          <>
            <div className={`flex items-center justify-between rounded-lg border p-4 ${testMode ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/30' : 'border-green-300 bg-green-50 dark:bg-green-950/30'}`}>
              <div className="space-y-0.5">
                <div className="text-sm font-semibold">Test mode</div>
                <p className="text-xs text-muted-foreground max-w-md">
                  {testMode
                    ? 'ON — every WhatsApp message is sent ONLY to the test number below. Real parties are never messaged.'
                    : 'OFF — messages are sent to the actual parties (using the phone number in their Parties record).'}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={testMode}
                onClick={() => setForm((p) => ({ ...p, whatsappTestMode: !testMode }))}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${testMode ? 'bg-amber-500' : 'bg-green-600'}`}
              >
                <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${testMode ? 'translate-x-0.5' : 'translate-x-[22px]'}`} />
              </button>
            </div>

            <div className="space-y-1.5 max-w-xs">
              <Label className="text-xs">Test number (test mode target)</Label>
              <Input
                value={form.whatsappTestNumber ?? ''}
                onChange={(e) => setForm((p) => ({ ...p, whatsappTestNumber: e.target.value }))}
                placeholder="918019965187"
                disabled={!testMode}
              />
              <p className="text-[11px] text-muted-foreground">
                10-digit Indian mobile (or 91XXXXXXXXXX). Used only while test mode is ON; falls back to the owner WhatsApp number if left blank.
              </p>
            </div>

            <div className="space-y-2 rounded-lg border p-4">
              <div className="space-y-0.5">
                <div className="text-sm font-semibold">Dispatch &amp; alert recipients</div>
                <p className="text-xs text-muted-foreground max-w-md">
                  Up to 3 members who receive internal WhatsApp alerts — dispatch reminders, the weekly summary and the daily dues digest.
                </p>
              </div>
              <div className="space-y-2">
                {members.map((m, i) => (
                  <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Input
                      value={m.name}
                      onChange={(e) => setMember(i, 'name', e.target.value)}
                      placeholder={`Member ${i + 1} name`}
                    />
                    <Input
                      value={m.phone}
                      onChange={(e) => setMember(i, 'phone', e.target.value)}
                      placeholder="9876543210"
                    />
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                10-digit Indian mobile (or 91XXXXXXXXXX) per member. Leave a row blank to skip it. While test mode is ON these also reroute to the test number.
              </p>
            </div>

            {!testMode && (
              <p className="rounded-md bg-green-50 dark:bg-green-950/30 px-3 py-2 text-xs text-green-800 dark:text-green-300">
                ⚠️ Live mode: real parties will receive WhatsApp messages. Make sure their phone numbers in Parties are correct.
              </p>
            )}

            <div className="flex justify-end">
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                <Save className="h-4 w-4" /> {save.isPending ? 'Saving…' : 'Save WhatsApp settings'}
              </Button>
            </div>
          </>
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
              Enter your TaxPro ASP registration details and your e-invoice API user for automated E-Invoice (IRN) and E-Way Bill generation. All four fields are required.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">ASP ID (aspid)</Label>
                <Input value={form.taxproGspId ?? ''} onChange={set('taxproGspId')} placeholder="e.g. 1806883726" />
                <p className="text-[11px] text-muted-foreground">From your TaxPro ASP registration (crm.gstefiling.co.in).</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">ASP Password</Label>
                <Input type="password" value={form.taxproGspSecret ?? ''} onChange={set('taxproGspSecret')} placeholder="ASP registration password" />
                <p className="text-[11px] text-muted-foreground">The password you set for that ASP registration.</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">E-Invoice Username</Label>
                <Input value={form.taxproGstUser ?? ''} onChange={set('taxproGstUser')} placeholder="e.g. API_rvpindustries10" />
                <p className="text-[11px] text-muted-foreground">API user created on the e-invoice portal for your GSTIN.</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">E-Invoice Password</Label>
                <Input type="password" value={form.taxproGstPass ?? ''} onChange={set('taxproGstPass')} placeholder="E-invoice API user password" />
                <p className="text-[11px] text-muted-foreground">Password for the e-invoice API user above.</p>
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
                <span className="text-sm font-medium">Sandbox Mode (Test environment)</span>
              </label>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              When Sandbox Mode is enabled, calls go to the TaxPro sandbox (test) environment — no real e-invoice is created. Turn it off for production (which requires purchased API credits). If any of the four credentials above are missing, the system safely returns simulated (mock) IRNs and E-Way Bills for UI testing.
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

