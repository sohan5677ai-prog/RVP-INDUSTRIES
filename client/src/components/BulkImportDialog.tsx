import { useRef, useState } from 'react';
import { Upload, FileSpreadsheet, Camera, ClipboardPaste, Plus, Trash2, Check, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';

type Mode = 'text' | 'file' | 'image';

interface Party {
  id: string;
  name: string;
  type: string;
}

interface BulkRow {
  id: string;
  date: string;
  partyName: string;
  partyId: string;
  tonnes: string;
  price: string;
  priceType: 'BASE' | 'DELIVERY';
  product: string;
  lorryNo: string;
  invoiceNo: string;
  gstExempt: boolean;
  status: 'pending' | 'success' | 'error';
  errorMsg: string;
}

interface Props {
  type: 'po' | 'sale' | 'cold-storage';
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess: () => void;
}

type Step = 'input' | 'preview' | 'submitting';

const PRODUCTS = ['PAPPU', 'HUSK', 'WASTE', 'TPS', 'SHELL'];

function emptyRow(): BulkRow {
  return {
    id: crypto.randomUUID(),
    date: new Date().toISOString().slice(0, 10),
    partyName: '',
    partyId: '',
    tonnes: '',
    price: '',
    priceType: 'DELIVERY',
    product: 'PAPPU',
    lorryNo: '',
    invoiceNo: '',
    gstExempt: false,
    status: 'pending',
    errorMsg: '',
  };
}

export function BulkImportDialog({ type, open, onOpenChange, onSuccess }: Props) {
  const [step, setStep] = useState<Step>('input');
  const [mode, setMode] = useState<Mode>('text');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<BulkRow[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);

  function reset() {
    setStep('input');
    setMode('text');
    setText('');
    setFile(null);
    setRows([]);
    setParseError('');
    setParsing(false);
  }

  function handleClose(v: boolean) {
    if (!v) reset();
    onOpenChange(v);
  }

  function filterParties(list: Party[]) {
    if (type === 'po' || type === 'cold-storage') return list.filter((p) => p.type === 'SUPPLIER' || p.type === 'BOTH');
    return list.filter((p) => p.type === 'BUYER' || p.type === 'BOTH');
  }

  async function handleParse() {
    setParsing(true);
    setParseError('');
    try {
      const fd = new FormData();
      // cold-storage shares the same field schema as PO (date/party/lorry/tonnes/price)
      fd.append('type', type === 'cold-storage' ? 'po' : type);
      if (mode === 'text') {
        if (!text.trim()) { setParseError('Paste some text first'); setParsing(false); return; }
        fd.append('text', text);
      } else {
        if (!file) { setParseError('Select a file first'); setParsing(false); return; }
        fd.append('file', file);
      }

      const data = await api<{ rows: any[]; parties: Party[] }>('/bulk-import/parse', { method: 'POST', multipart: true, body: fd });
      const partyList: Party[] = data.parties ?? [];
      setParties(partyList);

      const mapped: BulkRow[] = data.rows.map((r: any) => ({
        id: crypto.randomUUID(),
        date: r.date ?? new Date().toISOString().slice(0, 10),
        partyName: r.partyName ?? '',
        partyId: r.matchedPartyId ?? '',
        tonnes: r.tonnes != null ? String(r.tonnes) : '',
        price: r.price != null ? String(r.price) : '',
        priceType: r.priceType ?? 'DELIVERY',
        product: r.product ?? 'PAPPU',
        lorryNo: r.lorryNo ?? '',
        invoiceNo: r.invoiceNo ?? '',
        gstExempt: r.gstExempt ?? false,
        status: 'pending',
        errorMsg: '',
      }));

      if (mapped.length === 0) {
        setParseError('No rows found. Check your input and try again.');
        return;
      }
      setRows(mapped);
      setStep('preview');
    } catch (err: any) {
      setParseError(err?.message ?? 'Parse failed');
    } finally {
      setParsing(false);
    }
  }

  function updateRow(id: string, patch: Partial<BulkRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function deleteRow(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  async function handleSubmit() {
    setStep('submitting');
    const filtered = filterParties(parties);
    const updated = [...rows];

    if (type === 'cold-storage') {
      // Validate party matching first
      for (let i = 0; i < updated.length; i++) {
        const row = updated[i];
        const partyId = row.partyId ||
          filtered.find((p) => p.name.toLowerCase() === row.partyName.toLowerCase())?.id;
        updated[i] = { ...row, partyId: partyId ?? row.partyId };
      }
      setRows([...updated]);

      const unmatched = updated.filter((r) => !r.partyId);
      if (unmatched.length > 0) {
        const first = unmatched[0];
        updated[rows.indexOf(first)] = { ...first, status: 'error', errorMsg: 'Party not matched - select one' };
        setRows([...updated]);
        return;
      }

      try {
        const batchRows = updated.map((r) => ({
          date: r.date,
          partyId: r.partyId,
          lorryNo: r.lorryNo,
          tonnes: parseFloat(r.tonnes),
          pricePerKg: parseFloat(r.price),
        }));

        const result = await api<{ results: Array<{ success: boolean; poNumber?: string; error?: string }> }>(
          '/stock-in/cold-storage-batch',
          { method: 'POST', body: JSON.stringify({ rows: batchRows }) }
        );

        for (let i = 0; i < updated.length; i++) {
          const r = result.results[i];
          updated[i] = r?.success
            ? { ...updated[i], status: 'success' }
            : { ...updated[i], status: 'error', errorMsg: r?.error ?? 'Failed' };
        }
      } catch (err: any) {
        for (let i = 0; i < updated.length; i++) {
          updated[i] = { ...updated[i], status: 'error', errorMsg: err?.message ?? 'Batch failed' };
        }
      }
      setRows([...updated]);
      const successes = updated.filter((r) => r.status === 'success').length;
      if (successes > 0) onSuccess();
      return;
    }

    for (let i = 0; i < updated.length; i++) {
      const row = updated[i];
      // Update status to show in-progress visually
      updated[i] = { ...row, status: 'pending', errorMsg: '' };
      setRows([...updated]);

      try {
        const partyId = row.partyId ||
          filtered.find((p) => p.name.toLowerCase() === row.partyName.toLowerCase())?.id;
        if (!partyId) throw new Error('Party not matched - select one in the preview table');

        if (type === 'po') {
          await api('/purchase-orders', {
            method: 'POST',
            body: JSON.stringify({
              poDate: row.date,
              partyId,
              pricePerKg: parseFloat(row.price),
              priceType: row.priceType,
              tonnageKg: Math.round(parseFloat(row.tonnes) * 1000),
              lorryCount: 1,
            }),
          });
        } else {
          await api('/sale-orders', {
            method: 'POST',
            body: JSON.stringify({
              saleDate: row.date,
              buyerId: partyId,
              product: row.product,
              tonnageKg: Math.round(parseFloat(row.tonnes) * 1000),
              ratePerKg: parseFloat(row.price),
              marginOverride: false,
              brokerageRatePerKg: 0,
              gstExempt: row.gstExempt,
            }),
          });
        }
        updated[i] = { ...updated[i], status: 'success' };
      } catch (err: any) {
        updated[i] = { ...updated[i], status: 'error', errorMsg: err?.message ?? 'Failed' };
      }
      setRows([...updated]);
    }

    const successes = updated.filter((r) => r.status === 'success').length;
    if (successes > 0) onSuccess();
  }

  const isSubmitting = step === 'submitting';
  const done = isSubmitting && rows.every((r) => r.status !== 'pending');
  const successCount = rows.filter((r) => r.status === 'success').length;
  const errorCount = rows.filter((r) => r.status === 'error').length;
  const filteredParties = filterParties(parties);

  // Column header text
  const partyLabel = type === 'sale' ? 'Buyer' : 'Supplier';

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-5xl flex flex-col max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>
            {type === 'po' ? 'Bulk Purchase Orders' : type === 'cold-storage' ? 'KNM Cold Storage Import' : 'Bulk Sale Orders'}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto">

          {/* ── STEP 1: Input ─────────────────────────────────────────── */}
          {step === 'input' && (
            <div className="space-y-4 p-1">
              {/* Mode tabs */}
              <div className="flex rounded-lg border border-slate-200 divide-x divide-slate-200 overflow-hidden">
                {(['text', 'file', 'image'] as Mode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => { setMode(m); setFile(null); }}
                    className={cn(
                      'flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium transition-colors',
                      mode === m
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-600 hover:bg-slate-50'
                    )}
                  >
                    {m === 'text' && <><ClipboardPaste className="h-4 w-4" /> Paste Text</>}
                    {m === 'file' && <><FileSpreadsheet className="h-4 w-4" /> Excel / CSV</>}
                    {m === 'image' && <><Camera className="h-4 w-4" /> Photo / Image</>}
                  </button>
                ))}
              </div>

              {/* Content area */}
              {mode === 'text' && (
                <div className="space-y-2">
                  <p className="text-xs text-slate-500">
                    Copy rows from Excel and paste below. Columns:{' '}
                    {type === 'po'
                      ? 'Date | Supplier | Lorries | Tonnes | Price (₹/kg) | Price Type (BASE/DELIVERY)'
                      : type === 'cold-storage'
                      ? 'Stocking Date | Party | Lorry No | Chamber | Invoice | No of tons | Price | Amount'
                      : 'Date | Buyer | Invoice | Lorries | Tonnes | Price (₹/kg) | Product'}
                  </p>
                  <textarea
                    className="w-full h-56 rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                    placeholder={
                      type === 'po'
                        ? '01-04-2026\tABC Traders\tTN28BF1234\t25\t42.5\tDELIVERY\n02-04-2026\tXYZ Agro\t\t30\t41.0\tBASE'
                        : '06-04-2026\tChhaya Industries\tRVP/01/26-27\tTN28BF7423\t25\t50.00\tPAPPU'
                    }
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                </div>
              )}

              {mode === 'file' && (
                <div
                  className="flex flex-col items-center justify-center h-40 rounded-lg border-2 border-dashed border-slate-300 cursor-pointer hover:border-blue-400 transition-colors"
                  onClick={() => fileRef.current?.click()}
                >
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                  <Upload className="h-8 w-8 text-slate-400 mb-2" />
                  {file ? (
                    <span className="text-sm text-blue-600 font-medium">{file.name}</span>
                  ) : (
                    <span className="text-sm text-slate-500">Click to select .xlsx or .csv</span>
                  )}
                </div>
              )}

              {mode === 'image' && (
                <div
                  className="flex flex-col items-center justify-center h-40 rounded-lg border-2 border-dashed border-slate-300 cursor-pointer hover:border-blue-400 transition-colors"
                  onClick={() => imageRef.current?.click()}
                >
                  <input
                    ref={imageRef}
                    type="file"
                    accept="image/*,.pdf"
                    className="hidden"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                  <Camera className="h-8 w-8 text-slate-400 mb-2" />
                  {file ? (
                    <span className="text-sm text-blue-600 font-medium">{file.name}</span>
                  ) : (
                    <span className="text-sm text-slate-500">Click to upload a photo or PDF of the table</span>
                  )}
                </div>
              )}

              {parseError && (
                <p className="text-sm text-red-600">{parseError}</p>
              )}
            </div>
          )}

          {/* ── STEP 2: Preview ───────────────────────────────────────── */}
          {step === 'preview' && (
            <div className="space-y-3">
              <p className="text-sm text-slate-600">
                Review and edit the extracted rows before importing. <span className="text-amber-600 font-medium">Amber party names</span> need to be matched.
              </p>
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-2 py-2 text-left font-medium w-32">Date</th>
                      <th className="px-2 py-2 text-left font-medium min-w-[160px]">{partyLabel}</th>
                      {type === 'cold-storage' && <th className="px-2 py-2 text-left font-medium w-32">Lorry No</th>}
                      <th className="px-2 py-2 text-right font-medium w-24">Tonnes</th>
                      <th className="px-2 py-2 text-right font-medium w-24">₹/kg</th>
                      {type === 'po' && <th className="px-2 py-2 text-left font-medium w-28">Price Type</th>}
                      {type === 'sale' && <th className="px-2 py-2 text-left font-medium w-24">Product</th>}
                      {type === 'sale' && <th className="px-2 py-2 text-left font-medium w-28">Invoice</th>}
                      {type === 'sale' && (
                        <th className="px-2 py-2 text-center font-medium w-20" title="Bill without GST">
                          <label className="flex items-center justify-center gap-1 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={rows.length > 0 && rows.every((r) => r.gstExempt)}
                              onChange={(e) => setRows((prev) => prev.map((r) => ({ ...r, gstExempt: e.target.checked })))}
                            />
                            Excl. GST
                          </label>
                        </th>
                      )}
                      <th className="px-2 py-2 w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((row) => {
                      const matched = !!row.partyId;
                      return (
                        <tr key={row.id} className="hover:bg-slate-50">
                          <td className="px-2 py-1">
                            <input
                              type="date"
                              className="w-full rounded border border-transparent hover:border-slate-200 focus:border-blue-400 focus:outline-none px-1 py-0.5 text-sm"
                              value={row.date}
                              onChange={(e) => updateRow(row.id, { date: e.target.value })}
                            />
                          </td>
                          <td className="px-2 py-1">
                            <select
                              className={cn(
                                'w-full rounded border px-1 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white',
                                matched ? 'border-emerald-300 text-emerald-700' : 'border-amber-300 text-amber-700'
                              )}
                              value={row.partyId}
                              onChange={(e) => updateRow(row.id, { partyId: e.target.value })}
                            >
                              <option value="">{row.partyName || '- select -'}</option>
                              {filteredParties.map((p) => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                              ))}
                            </select>
                          </td>
                          {type === 'cold-storage' && (
                            <td className="px-2 py-1">
                              <input
                                className="w-full rounded border border-transparent hover:border-slate-200 focus:border-blue-400 focus:outline-none px-1 py-0.5 text-sm font-mono"
                                value={row.lorryNo}
                                placeholder="AP39UX9105"
                                onChange={(e) => updateRow(row.id, { lorryNo: e.target.value })}
                              />
                            </td>
                          )}
                          <td className="px-2 py-1">
                            <input
                              type="number"
                              step="0.001"
                              className="w-full rounded border border-transparent hover:border-slate-200 focus:border-blue-400 focus:outline-none px-1 py-0.5 text-sm text-right"
                              value={row.tonnes}
                              onChange={(e) => updateRow(row.id, { tonnes: e.target.value })}
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input
                              type="number"
                              step="0.01"
                              className="w-full rounded border border-transparent hover:border-slate-200 focus:border-blue-400 focus:outline-none px-1 py-0.5 text-sm text-right"
                              value={row.price}
                              onChange={(e) => updateRow(row.id, { price: e.target.value })}
                            />
                          </td>
                          {type === 'po' && (
                            <td className="px-2 py-1">
                              <select
                                className="w-full rounded border border-slate-200 px-1 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
                                value={row.priceType}
                                onChange={(e) => updateRow(row.id, { priceType: e.target.value as 'BASE' | 'DELIVERY' })}
                              >
                                <option value="DELIVERY">DELIVERY</option>
                                <option value="BASE">BASE</option>
                              </select>
                            </td>
                          )}
                          {type === 'sale' && (
                            <td className="px-2 py-1">
                              <select
                                className="w-full rounded border border-slate-200 px-1 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
                                value={row.product}
                                onChange={(e) => updateRow(row.id, { product: e.target.value })}
                              >
                                {PRODUCTS.map((p) => <option key={p}>{p}</option>)}
                              </select>
                            </td>
                          )}
                          {type === 'sale' && (
                            <td className="px-2 py-1">
                              <input
                                className="w-full rounded border border-transparent hover:border-slate-200 focus:border-blue-400 focus:outline-none px-1 py-0.5 text-sm"
                                value={row.invoiceNo}
                                placeholder="RVP/01/26-27"
                                onChange={(e) => updateRow(row.id, { invoiceNo: e.target.value })}
                              />
                            </td>
                          )}
                          {type === 'sale' && (
                            <td className="px-2 py-1 text-center">
                              <input
                                type="checkbox"
                                checked={row.gstExempt}
                                onChange={(e) => updateRow(row.id, { gstExempt: e.target.checked })}
                              />
                            </td>
                          )}
                          <td className="px-2 py-1">
                            <button
                              onClick={() => deleteRow(row.id)}
                              className="text-slate-400 hover:text-red-500 transition-colors"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <button
                onClick={() => setRows((prev) => [...prev, emptyRow()])}
                className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
              >
                <Plus className="h-4 w-4" /> Add row
              </button>
            </div>
          )}

          {/* ── STEP 3: Submitting ────────────────────────────────────── */}
          {step === 'submitting' && (
            <div className="space-y-3">
              {done && (
                <div className={cn(
                  'rounded-lg px-4 py-3 text-sm font-medium',
                  errorCount === 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                )}>
                  {successCount} imported successfully
                  {errorCount > 0 && `, ${errorCount} failed`}
                </div>
              )}
              <div className="space-y-1 max-h-80 overflow-y-auto">
                {rows.map((row, i) => {
                  const party = filteredParties.find((p) => p.id === row.partyId);
                  return (
                    <div key={row.id} className="flex items-center gap-3 text-sm py-1">
                      <span className="w-6 text-right text-slate-400 shrink-0">{i + 1}.</span>
                      <span className="flex-1 truncate">
                        {row.date} · {party?.name ?? row.partyName} · {row.tonnes}t @ ₹{row.price}
                      </span>
                      {row.status === 'pending' && <Loader2 className="h-4 w-4 animate-spin text-blue-500 shrink-0" />}
                      {row.status === 'success' && <Check className="h-4 w-4 text-emerald-500 shrink-0" />}
                      {row.status === 'error' && (
                        <span className="flex items-center gap-1 text-red-600 shrink-0">
                          <X className="h-4 w-4" />
                          <span className="text-xs truncate max-w-[200px]">{row.errorMsg}</span>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

        </div>

        {/* ── Footer buttons ─────────────────────────────────────────── */}
        <DialogFooter className="pt-2 border-t border-slate-100">
          {step === 'input' && (
            <>
              <Button variant="outline" onClick={() => handleClose(false)}>Cancel</Button>
              <Button onClick={handleParse} disabled={parsing}>
                {parsing ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Parsing…</> : 'Parse →'}
              </Button>
            </>
          )}
          {step === 'preview' && (
            <>
              <Button variant="outline" onClick={() => setStep('input')}>← Back</Button>
              <Button
                onClick={handleSubmit}
                disabled={rows.length === 0 || rows.every((r) => !r.partyId)}
              >
                Import {rows.length} row{rows.length !== 1 ? 's' : ''} →
              </Button>
            </>
          )}
          {step === 'submitting' && done && (
            <Button onClick={() => handleClose(false)}>
              {errorCount === 0 ? 'Done' : 'Close'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
