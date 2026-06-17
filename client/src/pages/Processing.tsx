import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { Processing as ProcessingType, Purchase, StockIn } from '@/lib/types';
import { kg, rupees, shortDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

type PurchaseRow = Purchase & {
  stockIn?: StockIn & {
    purchaseOrder?: {
      party?: {
        name: string;
      };
      poNumber?: string;
    };
  };
};

export default function Processing() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProcessingType | null>(null);
  const [processDate, setProcessDate] = useState(new Date().toISOString().slice(0, 10));
  const [blackWeightKg, setBlackWeightKg] = useState('');
  const [outTurnPct, setOutTurnPct] = useState('60');
  const [purchaseId, setPurchaseId] = useState('');
  
  // States for overhead costs and source silo
  const [overheadElectricity, setOverheadElectricity] = useState('0');
  const [overheadWages, setOverheadWages] = useState('0');
  const [overheadMaintenance, setOverheadMaintenance] = useState('0');
  const [loadingLocation, setLoadingLocation] = useState<'At process' | 'Rampalli' | 'Murgan' | 'Multi'>('At process');

  const { data: items, isLoading } = useQuery({
    queryKey: ['processing'],
    queryFn: () => api<ProcessingType[]>('/processing'),
  });

  const { data: purchases } = useQuery({
    queryKey: ['purchases'],
    queryFn: () => api<PurchaseRow[]>('/purchases'),
  });

  const availablePurchases = purchases?.filter((p) => {
    const isLinkedToAnother = items?.some((it) => it.purchaseId === p.id && it.id !== editing?.id);
    return !isLinkedToAnother;
  }) ?? [];

  function resetForm() {
    setEditing(null);
    setProcessDate(new Date().toISOString().slice(0, 10));
    setBlackWeightKg('');
    setOutTurnPct('60');
    setPurchaseId('');
    setOverheadElectricity('0');
    setOverheadWages('0');
    setOverheadMaintenance('0');
    setLoadingLocation('At process');
  }

  function openEdit(it: ProcessingType) {
    setEditing(it);
    setProcessDate(it.processDate.slice(0, 10));
    setBlackWeightKg(String(it.blackWeightKg));
    setOutTurnPct(String(it.outTurnPct));
    setPurchaseId(it.purchaseId ?? '');
    setOverheadElectricity(it.overheadElectricity ? String(it.overheadElectricity) : '0');
    setOverheadWages(it.overheadWages ? String(it.overheadWages) : '0');
    setOverheadMaintenance(it.overheadMaintenance ? String(it.overheadMaintenance) : '0');
    setLoadingLocation((it.loadingLocation as any) || 'At process');
    setOpen(true);
  }

  const mutation = useMutation({
    mutationFn: () => {
      const url = editing ? `/processing/${editing.id}` : '/processing';
      const method = editing ? 'PUT' : 'POST';
      return api(url, {
        method,
        body: {
          processDate,
          blackWeightKg: Number(blackWeightKg),
          outTurnPct: Number(outTurnPct),
          purchaseId: (purchaseId && purchaseId !== 'NONE') ? purchaseId : null,
          overheadElectricity: Number(overheadElectricity) || 0,
          overheadWages: Number(overheadWages) || 0,
          overheadMaintenance: Number(overheadMaintenance) || 0,
          loadingLocation: purchaseId ? undefined : loadingLocation,
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['processing'] });
      qc.invalidateQueries({ queryKey: ['purchases'] });
      toast.success(editing ? 'Processing run updated' : 'Processing run recorded');
      setOpen(false);
      resetForm();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/processing/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['processing'] });
      toast.success('Processing run deleted');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!blackWeightKg || Number(blackWeightKg) <= 0) return toast.error('Enter a valid black weight');
    mutation.mutate();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Processing</h1>
          <p className="text-muted-foreground">
            Record black seed mill processing runs into pooled white pappu seed
          </p>
        </div>
        <Button onClick={() => { resetForm(); setOpen(true); }}>
          <Plus className="h-4 w-4" /> Record Processing
        </Button>
      </div>

      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Source Purchase / Lorry</TableHead>
              <TableHead className="text-right">Black (kg)</TableHead>
              <TableHead className="text-right">Out-turn</TableHead>
              <TableHead className="text-right">Pappu (kg)</TableHead>
              <TableHead>Pricing</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {items?.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">No processing entries yet. Record a processing run to start.</TableCell></TableRow>
            )}
            {items?.map((it) => (
              <TableRow key={it.id}>
                <TableCell>{shortDate(it.processDate)}</TableCell>
                <TableCell>
                  {it.purchase ? (
                    <div>
                      <span className="font-semibold text-sm">
                        {it.purchase.stockIn?.purchaseOrder?.party?.name ?? '—'}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground font-mono">
                        ({it.purchase.stockIn?.purchaseOrder?.poNumber})
                      </span>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Inv {it.purchase.stockIn?.invoiceNumber} · Lorry {it.purchase.stockIn?.lorryNumber} · Wt: {kg(it.purchase.netWeightKg)}
                      </div>
                    </div>
                  ) : (
                    <span className="text-muted-foreground text-xs italic">Standalone Pool ({it.loadingLocation})</span>
                  )}
                  {it.yieldAnomaly && (
                    <Badge variant="destructive" className="ml-2 animate-pulse" title={it.yieldAnomalyReason || ''}>Anomaly</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right font-medium">{kg(it.blackWeightKg)}</TableCell>
                <TableCell className="text-right">{Number(it.outTurnPct)}%</TableCell>
                <TableCell className="text-right font-semibold">
                  <div>{kg(it.pappuWeightKg)}</div>
                  <div className="text-[10px] text-muted-foreground font-normal mt-0.5">
                    Husk: {kg(it.huskWeightKg)} · Waste: {kg(it.wasteWeightKg)}
                  </div>
                </TableCell>
                <TableCell>
                  {it.pappuPrice ? (
                    <Badge variant="outline">{rupees(it.pappuPrice.pricePerKg)}/kg</Badge>
                  ) : (
                    <Badge variant="secondary">Unpriced</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" onClick={() => openEdit(it)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (confirm('Delete this processing run? This will also remove any pappu pricing recorded for it.')) {
                          deleteMutation.mutate(it.id);
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{editing ? 'Edit Processing Run' : 'Record Processing Run'}</DialogTitle></DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label>Source Purchase (Lorry / Party)</Label>
              <Select
                value={purchaseId || 'NONE'}
                onValueChange={(v) => {
                  setPurchaseId(v === 'NONE' ? '' : v);
                  const p = availablePurchases.find((pur) => pur.id === v);
                  if (p) {
                    setBlackWeightKg(String(p.netWeightKg));
                  }
                }}
              >
                <SelectTrigger className="bg-card">
                  <SelectValue placeholder="Select a purchase (or leave empty for standalone run)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">Standalone Pool (No Lorry Link)</SelectItem>
                  {availablePurchases.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.stockIn?.purchaseOrder?.party?.name} ({p.stockIn?.purchaseOrder?.poNumber}) — Inv {p.stockIn?.invoiceNumber} · Lorry {p.stockIn?.lorryNumber} ({kg(p.netWeightKg)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!purchaseId && (
              <div className="space-y-2">
                <Label>Source Silo Location</Label>
                <Select value={loadingLocation} onValueChange={(v: any) => setLoadingLocation(v)}>
                  <SelectTrigger className="bg-card">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="At process">At process</SelectItem>
                    <SelectItem value="Rampalli">Rampalli</SelectItem>
                    <SelectItem value="Murgan">Murgan</SelectItem>
                    <SelectItem value="Multi">Multi</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="processDate">Processing Date</Label>
              <Input id="processDate" type="date" value={processDate} onChange={(e) => setProcessDate(e.target.value)} required />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="blackWeight">Black weight (kg)</Label>
                <Input id="blackWeight" type="number" value={blackWeightKg} onChange={(e) => setBlackWeightKg(e.target.value)} placeholder="e.g. 10000" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="outTurn">Out-turn yield (%)</Label>
                <Input id="outTurn" type="number" step="0.1" value={outTurnPct} onChange={(e) => setOutTurnPct(e.target.value)} placeholder="60" required />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-2 border-t">
              <div className="space-y-2">
                <Label htmlFor="elec">Electricity (₹)</Label>
                <Input id="elec" type="number" value={overheadElectricity} onChange={(e) => setOverheadElectricity(e.target.value)} placeholder="0" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wages">Wages (₹)</Label>
                <Input id="wages" type="number" value={overheadWages} onChange={(e) => setOverheadWages(e.target.value)} placeholder="0" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="maint">Maint. (₹)</Label>
                <Input id="maint" type="number" value={overheadMaintenance} onChange={(e) => setOverheadMaintenance(e.target.value)} placeholder="0" />
              </div>
            </div>
            {blackWeightKg && (
              <div className="rounded-lg border bg-muted/30 p-3 space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground font-medium">White Pappu Output ({(Number(outTurnPct) || 60)}%)</span>
                  <span className="font-bold text-primary">{kg(Math.round(Number(blackWeightKg) * ((Number(outTurnPct) || 60) / 100)))}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground font-medium">Husk Output (25%)</span>
                  <span className="font-bold">{kg(Math.round(Number(blackWeightKg) * 0.25))}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground font-medium">Tamarind Waste (10%)</span>
                  <span className="font-bold">{kg(Math.round(Number(blackWeightKg) * 0.10))}</span>
                </div>
                <div className="flex justify-between border-t pt-2 mt-1 text-destructive">
                  <span className="font-medium">Lost Waste (5%)</span>
                  <span className="font-bold">{kg(Math.round(Number(blackWeightKg) * 0.05))}</span>
                </div>
              </div>
            )}
            <DialogFooter>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? 'Saving…' : (editing ? 'Save Changes' : 'Save Processing')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
