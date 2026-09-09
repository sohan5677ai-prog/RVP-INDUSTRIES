import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Plus,
  Truck,
  FileText,
  Trash2,
  Ban,
  CheckCircle2,
  Sparkles,
  Loader2,
  Compass,
  Printer,
  Clock,
} from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { renderEwbCountdown } from '@/pages/Reports/IrnEwbReport';
import { usePagedRows } from '@/lib/usePagedRows';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { rupees, shortDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export interface DeliveryChallanItem {
  productName: string;
  hsnCode: string;
  quantity: number;
  unit: string;
  taxableAmount: number;
  gstRate: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
}

export interface DeliveryChallan {
  id: string;
  challanNumber: string;
  challanSeq: number;
  challanFy: string;
  challanDate: string;
  challanType: string;
  subType: string;
  fromName: string;
  fromGstin?: string | null;
  fromAddress: string;
  fromPlace: string;
  fromPincode: number;
  fromStateCode: number;
  toName: string;
  toGstin?: string | null;
  toAddress: string;
  toPlace: string;
  toPincode: number;
  toStateCode: number;
  items: DeliveryChallanItem[];
  totalValue: number;
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  transporterId?: string | null;
  transporterName?: string | null;
  vehicleNumber?: string | null;
  transMode: string;
  vehicleType: string;
  distanceKm: number;
  ewbNumber?: string | null;
  ewbDate?: string | null;
  ewbValidUpto?: string | null;
  ewbStatus?: string | null;
  ewbCancelledDate?: string | null;
  remarks?: string | null;
  status: string;
  createdAt: string;
}

const CHALLAN_TYPES = [
  { value: 'JOB_WORK', label: 'Job Work Movement' },
  { value: 'GODOWN_TRANSFER', label: 'Internal Godown Transfer' },
  { value: 'SUPPLY_ON_APPROVAL', label: 'Supply on Approval' },
  { value: 'FOR_EXHIBITION', label: 'Exhibition / Demonstration' },
  { value: 'OTHERS', label: 'Others (Non-Sale Movement)' },
];

export default function DeliveryChallans() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [createOpen, setCreateOpen] = useState(false);
  const [ewbModalChallan, setEwbModalChallan] = useState<DeliveryChallan | null>(null);
  const [cancelModalChallan, setCancelModalChallan] = useState<DeliveryChallan | null>(null);
  const [fetchingDistance, setFetchingDistance] = useState(false);

  // EWB Generation Form State
  const [ewbVehicle, setEwbVehicle] = useState('');
  const [ewbDistance, setEwbDistance] = useState<number>(0);
  const [ewbTransporterId, setEwbTransporterId] = useState('');
  const [ewbTransporterName, setEwbTransporterName] = useState('');
  const [ewbTransMode, setEwbTransMode] = useState('1');

  // Cancel EWB Form State
  const [cancelReason, setCancelReason] = useState('1');
  const [cancelRemarks, setCancelRemarks] = useState('Cancelled from ERP');

  // New Challan Form State
  const [newDate, setNewDate] = useState(new Date().toISOString().slice(0, 10));
  const [newType, setNewType] = useState('JOB_WORK');
  const [toName, setToName] = useState('');
  const [toGstin, setToGstin] = useState('');
  const [toAddress, setToAddress] = useState('');
  const [toPlace, setToPlace] = useState('');
  const [toPincode, setToPincode] = useState('');
  const [toStateCode, setToStateCode] = useState('37');
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [distanceKm, setDistanceKm] = useState<number>(0);
  const [remarks, setRemarks] = useState('');

  // Items Builder
  const [items, setItems] = useState<DeliveryChallanItem[]>([
    {
      productName: 'Tamarind Shell / Husk (Internal Movement)',
      hsnCode: '120799',
      quantity: 10000,
      unit: 'KGS',
      taxableAmount: 50000,
      gstRate: 5,
      cgstAmount: 1250,
      sgstAmount: 1250,
      igstAmount: 0,
    },
  ]);

  const { data: challans = [], isLoading } = useQuery({
    queryKey: ['delivery-challans'],
    queryFn: () => api<DeliveryChallan[]>('/delivery-challans'),
  });

  const { totalCount, activeCount, totalVal, ewbCount } = useMemo(() => {
    let active = 0;
    let val = 0;
    let ewb = 0;
    for (const c of challans) {
      if (c.status === 'ACTIVE') active++;
      val += Number(c.totalValue || 0);
      if (c.ewbNumber && c.ewbStatus !== 'CANCELLED') ewb++;
    }
    return {
      totalCount: challans.length,
      activeCount: active,
      totalVal: val,
      ewbCount: ewb,
    };
  }, [challans]);

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows = [] } = usePagedRows(challans, 25);

  const createMutation = useMutation({
    mutationFn: (data: any) => api('/delivery-challans', { method: 'POST', body: data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['delivery-challans'] });
      toast.success('Delivery Challan created successfully');
      setCreateOpen(false);
    },
    onError: (err) => toast.error(getErrorMessage(err) || 'Failed to create Delivery Challan'),
  });

  const ewbMutation = useMutation({
    mutationFn: ({ id, details }: { id: string; details: any }) =>
      api(`/delivery-challans/${id}/ewb`, { method: 'POST', body: details }),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['delivery-challans'] });
      toast.success(res.message || 'E-Way Bill generated successfully');
      setEwbModalChallan(null);
    },
    onError: (err) => toast.error(getErrorMessage(err) || 'Failed to generate E-Way Bill'),
  });

  const cancelEwbMutation = useMutation({
    mutationFn: ({ id, reason, rem }: { id: string; reason: string; rem: string }) =>
      api(`/delivery-challans/${id}/ewb/cancel`, { method: 'POST', body: { cancelReason: reason, cancelRemarks: rem } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['delivery-challans'] });
      toast.success('E-Way Bill cancelled successfully');
      setCancelModalChallan(null);
    },
    onError: (err) => toast.error(getErrorMessage(err) || 'Failed to cancel E-Way Bill'),
  });

  // Extend Validity State & Mutation
  const [extendModalChallan, setExtendModalChallan] = useState<DeliveryChallan | null>(null);
  const [extVehicleNo, setExtVehicleNo] = useState('');
  const [extFromPlace, setExtFromPlace] = useState('');
  const [extFromPincode, setExtFromPincode] = useState(517247);
  const [extFromState, setExtFromState] = useState(37);
  const [extDistance, setExtDistance] = useState(50);
  const [extReason, setExtReason] = useState('1');
  const [extRemarks, setExtRemarks] = useState('Transit delay extension');

  const extendEwbMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) =>
      api(`/delivery-challans/${id}/ewb/extend-validity`, { method: 'POST', body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['delivery-challans'] });
      toast.success('Delivery Challan E-Way Bill validity extended successfully');
      setExtendModalChallan(null);
    },
    onError: (err) => toast.error(getErrorMessage(err) || 'Failed to extend E-Way Bill validity'),
  });

  const handleAutoDistance = async (fromPin: number | string, tPin: number | string) => {
    if (!fromPin || !tPin) return;
    setFetchingDistance(true);
    try {
      const res = await api<any>(`/taxpro/distance?fromPin=${fromPin}&toPin=${tPin}`);
      if (res?.distance && res.distance > 0) {
        setDistanceKm(res.distance);
        setEwbDistance(res.distance);
        toast.success(`Official distance resolved: ${res.distance} km`);
      } else {
        toast.info('Could not auto-resolve distance. Please enter approx distance in km.');
      }
    } catch {
      toast.info('Distance auto-lookup unavailable. Please enter approx distance.');
    } finally {
      setFetchingDistance(false);
    }
  };

  const handleOpenEwbModal = (c: DeliveryChallan) => {
    setEwbModalChallan(c);
    setEwbVehicle(c.vehicleNumber || '');
    setEwbDistance(c.distanceKm || 0);
    setEwbTransporterId(c.transporterId || '');
    setEwbTransporterName(c.transporterName || '');
    setEwbTransMode(c.transMode || '1');

    if (!c.distanceKm && c.fromPincode && c.toPincode) {
      void handleAutoDistance(c.fromPincode, c.toPincode);
    }
  };

  const handleAddItem = () => {
    setItems((prev) => [
      ...prev,
      {
        productName: 'Raw Material / Seed Movement',
        hsnCode: '120799',
        quantity: 1000,
        unit: 'KGS',
        taxableAmount: 10000,
        gstRate: 5,
        cgstAmount: 250,
        sgstAmount: 250,
        igstAmount: 0,
      },
    ]);
  };

  const handleUpdateItem = (index: number, patch: Partial<DeliveryChallanItem>) => {
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== index) return it;
        const next = { ...it, ...patch };
        const rate = Number(next.gstRate) || 0;
        const taxable = Number(next.taxableAmount) || 0;
        const gstHalf = Math.round((taxable * (rate / 2)) / 100);
        next.cgstAmount = gstHalf;
        next.sgstAmount = gstHalf;
        next.igstAmount = 0;
        return next;
      })
    );
  };

  const handleRemoveItem = (index: number) => {
    if (items.length <= 1) return;
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSaveChallan = () => {
    if (!toName.trim()) {
      toast.error('Recipient name is required');
      return;
    }
    if (!toAddress.trim() || !toPlace.trim() || !toPincode.trim()) {
      toast.error('Recipient address, place, and 6-digit pincode are required');
      return;
    }

    createMutation.mutate({
      challanDate: newDate,
      challanType: newType,
      subType: newType,
      toName,
      toGstin: toGstin.trim() || 'URP',
      toAddress,
      toPlace,
      toPincode: parseInt(toPincode, 10),
      toStateCode: parseInt(toStateCode, 10) || 37,
      items,
      vehicleNumber,
      distanceKm,
      remarks,
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Delivery Challans"
        description="Internal stock transfers, job work, and non-sale consignments with official E-Way Bills"
        icon={Truck}
        actions={
          <Button onClick={() => setCreateOpen(true)} className="gap-1.5 shadow-sm">
            <Plus className="h-4 w-4" />
            New Delivery Challan
          </Button>
        }
      />

      {/* Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard label="Total Challans" value={totalCount} icon={FileText} tone="taupe" />
        <StatCard label="Active Movements" value={activeCount} icon={Truck} tone="forest" />
        <StatCard label="Total Value Moved" value={rupees(totalVal)} icon={CheckCircle2} tone="gold" />
        <StatCard label="Active E-Way Bills" value={ewbCount} icon={Sparkles} tone="amber" />
      </div>

      {/* Challans Table */}
      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Challan No.</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Movement Type</TableHead>
              <TableHead>Recipient / Destination</TableHead>
              <TableHead className="text-right">Total Value</TableHead>
              <TableHead>Vehicle / Distance</TableHead>
              <TableHead>E-Way Bill</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                  Loading delivery challans…
                </TableCell>
              </TableRow>
            )}
            {!isLoading && challans.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                  No delivery challans generated yet. Click "New Delivery Challan" to create one.
                </TableCell>
              </TableRow>
            )}
            {pageRows.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-mono text-sm font-semibold">{c.challanNumber}</TableCell>
                <TableCell className="text-xs">{shortDate(c.challanDate)}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs font-normal">
                    {CHALLAN_TYPES.find((t) => t.value === c.challanType)?.label || c.challanType}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-xs">
                  <div className="font-medium text-xs">{c.toName}</div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {c.toPlace}, {c.toPincode} {c.toGstin && `(${c.toGstin})`}
                  </div>
                </TableCell>
                <TableCell className="text-right font-semibold text-xs">{rupees(c.totalValue)}</TableCell>
                <TableCell className="text-xs">
                  <div>{c.vehicleNumber || '—'}</div>
                  <div className="text-[11px] text-muted-foreground">{c.distanceKm ? `${c.distanceKm} km` : '—'}</div>
                </TableCell>
                <TableCell>
                  {c.ewbNumber ? (
                    <div className="flex flex-col gap-0.5">
                      <Badge
                        variant={c.ewbStatus === 'CANCELLED' ? 'destructive' : 'default'}
                        className={`text-[10px] py-0 px-1 font-mono w-fit ${
                          c.ewbStatus === 'GENERATED' ? 'bg-emerald-600 text-white' : ''
                        }`}
                      >
                        EWB: {c.ewbNumber}
                      </Badge>
                      {renderEwbCountdown(c.ewbValidUpto, c.ewbStatus === 'CANCELLED')}
                    </div>
                  ) : (
                    <Badge variant="secondary" className="text-[10px] py-0 font-normal">
                      No EWB
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={c.status === 'CANCELLED' ? 'destructive' : 'secondary'} className="text-[11px]">
                    {c.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1"
                      onClick={() => navigate(`/delivery-challans/${c.id}/print`)}
                      title="Print Official Delivery Challan (Rule 55)"
                    >
                      <Printer className="h-3 w-3" />
                      Print
                    </Button>
                    {!c.ewbNumber && c.status !== 'CANCELLED' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1 text-primary hover:bg-primary/5"
                        onClick={() => handleOpenEwbModal(c)}
                      >
                        <Sparkles className="h-3 w-3 text-primary" />
                        Gen EWB
                      </Button>
                    )}
                    {c.ewbNumber && c.ewbStatus === 'GENERATED' && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1 border-amber-300 text-amber-700 hover:bg-amber-50"
                          onClick={() => {
                            setExtendModalChallan(c);
                            setExtVehicleNo(c.vehicleNumber || '');
                            setExtFromPlace(c.fromPlace || 'Punganur');
                            setExtFromPincode(c.fromPincode || 517247);
                            setExtFromState(c.fromStateCode || 37);
                            setExtDistance(c.distanceKm || 50);
                          }}
                          title="Extend Validity (Transit Delay)"
                        >
                          <Clock className="h-3 w-3" />
                          Extend
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => setCancelModalChallan(c)}
                          title="Cancel E-Way Bill"
                        >
                          <Ban className="h-3.5 w-3.5" />
                          Cancel
                        </Button>
                      </>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <PaginationBar
        page={page}
        setPage={setPage}
        pageSize={pageSize}
        setPageSize={setPageSize}
        totalPages={totalPages}
        total={total}
      />

      {/* Dialog: Create New Delivery Challan */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Delivery Challan</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Challan Date</Label>
                <Input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
              </div>
              <div>
                <Label>Movement Purpose / Type</Label>
                <Select value={newType} onValueChange={setNewType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CHALLAN_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Recipient Details */}
            <div className="rounded-lg border p-3 bg-muted/20 space-y-3">
              <div className="font-semibold text-xs text-muted-foreground uppercase tracking-wider">
                Recipient / Delivery Point
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Recipient Party / Godown Name</Label>
                  <Input
                    placeholder="e.g. Shakthi Storage / Job Work Unit"
                    value={toName}
                    onChange={(e) => setToName(e.target.value)}
                  />
                </div>
                <div>
                  <Label>Recipient GSTIN (or URP)</Label>
                  <Input
                    placeholder="e.g. 37ABCDE1234F1Z5 or URP"
                    value={toGstin}
                    onChange={(e) => setToGstin(e.target.value.toUpperCase())}
                  />
                </div>
              </div>
              <div>
                <Label>Delivery Address</Label>
                <Input
                  placeholder="Plot/Street address"
                  value={toAddress}
                  onChange={(e) => setToAddress(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label>Town / City</Label>
                  <Input placeholder="e.g. Punganur, Surat" value={toPlace} onChange={(e) => setToPlace(e.target.value)} />
                </div>
                <div>
                  <Label>Pincode</Label>
                  <Input
                    placeholder="e.g. 517247"
                    value={toPincode}
                    onChange={(e) => setToPincode(e.target.value)}
                  />
                </div>
                <div>
                  <Label>State Code (AP=37, KA=29, GJ=24)</Label>
                  <Input
                    type="number"
                    value={toStateCode}
                    onChange={(e) => setToStateCode(e.target.value)}
                  />
                </div>
              </div>
            </div>

            {/* Item Details */}
            <div className="rounded-lg border p-3 bg-muted/20 space-y-3">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-xs text-muted-foreground uppercase tracking-wider">
                  Goods / Items Consigned
                </div>
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={handleAddItem}>
                  <Plus className="h-3.5 w-3.5" />
                  Add Item
                </Button>
              </div>
              {items.map((it, idx) => (
                <div key={idx} className="grid grid-cols-6 gap-2 items-end border-b pb-2">
                  <div className="col-span-2">
                    <Label className="text-[11px]">Product Description</Label>
                    <Input
                      className="h-8 text-xs"
                      value={it.productName}
                      onChange={(e) => handleUpdateItem(idx, { productName: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="text-[11px]">HSN Code</Label>
                    <Input
                      className="h-8 text-xs"
                      value={it.hsnCode}
                      onChange={(e) => handleUpdateItem(idx, { hsnCode: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="text-[11px]">Quantity (KGS)</Label>
                    <Input
                      type="number"
                      className="h-8 text-xs"
                      value={it.quantity}
                      onChange={(e) => handleUpdateItem(idx, { quantity: Number(e.target.value) })}
                    />
                  </div>
                  <div>
                    <Label className="text-[11px]">Taxable (₹)</Label>
                    <Input
                      type="number"
                      className="h-8 text-xs"
                      value={it.taxableAmount}
                      onChange={(e) => handleUpdateItem(idx, { taxableAmount: Number(e.target.value) })}
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex-1">
                      <Label className="text-[11px]">GST %</Label>
                      <Input
                        type="number"
                        className="h-8 text-xs"
                        value={it.gstRate}
                        onChange={(e) => handleUpdateItem(idx, { gstRate: Number(e.target.value) })}
                      />
                    </div>
                    {items.length > 1 && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-destructive"
                        onClick={() => handleRemoveItem(idx)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Transport & Distance */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Vehicle Number</Label>
                <Input
                  placeholder="e.g. AP03TC1234"
                  value={vehicleNumber}
                  onChange={(e) => setVehicleNumber(e.target.value.toUpperCase())}
                />
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <Label>Approx Distance (KM)</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-5 text-[11px] gap-1 text-primary p-0"
                    disabled={fetchingDistance || !toPincode}
                    onClick={() => handleAutoDistance(517247, toPincode)}
                  >
                    {fetchingDistance ? <Loader2 className="h-3 w-3 animate-spin" /> : <Compass className="h-3 w-3" />}
                    Official PIN-to-PIN Distance
                  </Button>
                </div>
                <Input
                  type="number"
                  placeholder="e.g. 120"
                  value={distanceKm || ''}
                  onChange={(e) => setDistanceKm(Number(e.target.value))}
                />
              </div>
            </div>

            <div>
              <Label>Remarks</Label>
              <Input
                placeholder="Internal stock transfer for grading/processing"
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveChallan} disabled={createMutation.isPending}>
              {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Save Delivery Challan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: Generate E-Way Bill */}
      <Dialog open={Boolean(ewbModalChallan)} onOpenChange={(o) => !o && setEwbModalChallan(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Generate Delivery Challan E-Way Bill</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="p-3 bg-muted/40 rounded-lg text-xs space-y-1">
              <div>
                Challan:{' '}
                <span className="font-semibold text-foreground">{ewbModalChallan?.challanNumber}</span>
              </div>
              <div>
                Recipient:{' '}
                <span className="font-semibold text-foreground">
                  {ewbModalChallan?.toName} ({ewbModalChallan?.toPlace})
                </span>
              </div>
              <div>
                Value:{' '}
                <span className="font-semibold text-foreground">{rupees(ewbModalChallan?.totalValue || 0)}</span>
              </div>
            </div>

            <div>
              <Label>Vehicle Number (Road Transport)</Label>
              <Input
                placeholder="e.g. AP03TC1234"
                className="uppercase font-mono"
                value={ewbVehicle}
                onChange={(e) => setEwbVehicle(e.target.value.toUpperCase())}
              />
            </div>

            <div>
              <div className="flex items-center justify-between">
                <Label>Distance (KM)</Label>
                {ewbModalChallan && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-5 text-[11px] gap-1 text-primary p-0"
                    disabled={fetchingDistance}
                    onClick={() => handleAutoDistance(ewbModalChallan.fromPincode, ewbModalChallan.toPincode)}
                  >
                    {fetchingDistance ? <Loader2 className="h-3 w-3 animate-spin" /> : <Compass className="h-3 w-3" />}
                    Official PIN Distance
                  </Button>
                )}
              </div>
              <Input
                type="number"
                value={ewbDistance || ''}
                onChange={(e) => setEwbDistance(Number(e.target.value))}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Transporter GSTIN (Optional)</Label>
                <Input
                  placeholder="15-digit GSTIN"
                  value={ewbTransporterId}
                  onChange={(e) => setEwbTransporterId(e.target.value.toUpperCase())}
                />
              </div>
              <div>
                <Label>Transporter Name (Optional)</Label>
                <Input
                  placeholder="Transport Company"
                  value={ewbTransporterName}
                  onChange={(e) => setEwbTransporterName(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEwbModalChallan(null)}>
              Cancel
            </Button>
            <Button
              disabled={ewbMutation.isPending || !ewbVehicle}
              onClick={() => {
                if (ewbModalChallan) {
                  ewbMutation.mutate({
                    id: ewbModalChallan.id,
                    details: {
                      vehicleNumber: ewbVehicle,
                      transDistance: ewbDistance,
                      transporterId: ewbTransporterId || undefined,
                      transporterName: ewbTransporterName || undefined,
                      transMode: ewbTransMode,
                    },
                  });
                }
              }}
            >
              {ewbMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Generate Official EWB
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: Cancel E-Way Bill */}
      <Dialog open={Boolean(cancelModalChallan)} onOpenChange={(o) => !o && setCancelModalChallan(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel Delivery Challan E-Way Bill</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="p-3 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/40 rounded-lg text-xs space-y-1">
              <div className="font-semibold text-rose-800 dark:text-rose-300">
                Cancel E-Way Bill {cancelModalChallan?.ewbNumber}
              </div>
              <div className="text-rose-700 dark:text-rose-400">
                E-Way Bills can be cancelled within 24 hours of generation on the government portal.
              </div>
            </div>

            <div>
              <Label>Cancellation Reason</Label>
              <Select value={cancelReason} onValueChange={setCancelReason}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 - Duplicate E-Way Bill</SelectItem>
                  <SelectItem value="2">2 - Movement Cancelled</SelectItem>
                  <SelectItem value="3">3 - Data Entry Mistake</SelectItem>
                  <SelectItem value="4">4 - Others</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Remarks</Label>
              <Input value={cancelRemarks} onChange={(e) => setCancelRemarks(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelModalChallan(null)}>
              Back
            </Button>
            <Button
              variant="destructive"
              disabled={cancelEwbMutation.isPending}
              onClick={() => {
                if (cancelModalChallan) {
                  cancelEwbMutation.mutate({
                    id: cancelModalChallan.id,
                    reason: cancelReason,
                    rem: cancelRemarks,
                  });
                }
              }}
            >
              {cancelEwbMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Confirm Cancellation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Extend Validity Modal */}
      <Dialog open={!!extendModalChallan} onOpenChange={(open) => !open && setExtendModalChallan(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock className="w-5 h-5 text-amber-600" />
              Extend E-Way Bill Validity
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="bg-muted/40 p-3 rounded-lg text-xs space-y-1">
              <div><span className="font-semibold">Challan:</span> {extendModalChallan?.challanNumber}</div>
              <div><span className="font-semibold">Active EWB:</span> {extendModalChallan?.ewbNumber}</div>
              {extendModalChallan?.ewbValidUpto && (
                <div><span className="font-semibold">Current Expiry:</span> {shortDate(extendModalChallan.ewbValidUpto)}</div>
              )}
            </div>

            <div className="space-y-2">
              <Label>Vehicle Number</Label>
              <Input
                value={extVehicleNo}
                onChange={(e) => setExtVehicleNo(e.target.value.toUpperCase())}
                placeholder="e.g. AP04TT1234"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Current Location / Place</Label>
                <Input
                  value={extFromPlace}
                  onChange={(e) => setExtFromPlace(e.target.value)}
                  placeholder="Transit place"
                />
              </div>
              <div className="space-y-2">
                <Label>Current Pincode</Label>
                <Input
                  type="number"
                  value={extFromPincode}
                  onChange={(e) => setExtFromPincode(Number(e.target.value))}
                  placeholder="517247"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Remaining Distance to Destination (KM)</Label>
              <Input
                type="number"
                value={extDistance}
                onChange={(e) => setExtDistance(Number(e.target.value))}
                placeholder="Remaining km"
              />
              <span className="text-[11px] text-muted-foreground">Each 200 km extends validity by 1 additional day.</span>
            </div>

            <div className="space-y-2">
              <Label>Reason for Extension</Label>
              <Select value={extReason} onValueChange={setExtReason}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 - Natural Calamity</SelectItem>
                  <SelectItem value="2">2 - Law and Order Situation</SelectItem>
                  <SelectItem value="4">4 - Transshipment Delay</SelectItem>
                  <SelectItem value="5">5 - Accident</SelectItem>
                  <SelectItem value="99">99 - Other Transit Delay / Traffic</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Remarks</Label>
              <Input
                value={extRemarks}
                onChange={(e) => setExtRemarks(e.target.value)}
                placeholder="Brief reason for transit delay"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExtendModalChallan(null)}>
              Cancel
            </Button>
            <Button
              className="bg-amber-600 hover:bg-amber-700 text-white gap-1.5"
              disabled={extendEwbMutation.isPending}
              onClick={() => {
                if (extendModalChallan) {
                  extendEwbMutation.mutate({
                    id: extendModalChallan.id,
                    body: {
                      vehicleNo: extVehicleNo,
                      fromPlace: extFromPlace,
                      fromPincode: extFromPincode,
                      fromState: extFromState,
                      remainingDistance: extDistance,
                      extnRsnCode: extReason,
                      extnRemarks: extRemarks,
                    },
                  });
                }
              }}
            >
              {extendEwbMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Extend Validity
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
