import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Scale,
  Printer,
  RotateCcw,
  Save,
  Clock,
  Video,
  Search,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useScale } from '@/lib/scaleContext';
import type { Party, CompanyProfile, WeighbridgeTicket } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { shortDate } from '@/lib/format';
import WeighbridgeSlipModal from '@/components/WeighbridgeSlipModal';

const MATERIALS = [
  'PAPPU',
  'HUSK',
  'TAMARIND SEED',
  'TAMARIND SHELL',
  'TAMARIND WASTE',
  'TPS (BROKENS)',
  'PRE CLEANER DUST',
  'NALLA POKKULU',
  'BLACK SEED',
  'OTHER',
];

interface CctvLiveBoxProps {
  camNumber: 1 | 2;
  cameraIp: string;
  label: string;
  currentTime: string;
  refreshTrigger?: number;
}

function CctvLiveBox({ camNumber, cameraIp, label, currentTime, refreshTrigger }: CctvLiveBoxProps) {
  const [frameUrl, setFrameUrl] = useState<string>(
    `/api/weighbridge/cctv/snapshot?cam=${camNumber}&t=${Date.now()}`
  );
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef<boolean>(true);
  const errCountRef = useRef<number>(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const triggerNextFrame = useCallback((delayMs: number) => {
    if (!mountedRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (mountedRef.current) {
        setFrameUrl(`/api/weighbridge/cctv/snapshot?cam=${camNumber}&t=${Date.now()}`);
      }
    }, delayMs);
  }, [camNumber]);

  // If parent triggers refresh, immediately fetch fresh frame
  useEffect(() => {
    if (refreshTrigger) {
      setFrameUrl(`/api/weighbridge/cctv/snapshot?cam=${camNumber}&t=${Date.now()}`);
    }
  }, [refreshTrigger, camNumber]);

  return (
    <div className="rounded-lg bg-black border border-zinc-800 h-36 relative overflow-hidden flex items-center justify-center group shadow-inner">
      <img
        src={frameUrl}
        alt={`Camera ${camNumber} - ${label}`}
        onLoad={() => {
          errCountRef.current = 0;
          setIsOnline(true);
          triggerNextFrame(350); // Fetch next frame smoothly after 350ms
        }}
        onError={() => {
          errCountRef.current += 1;
          if (errCountRef.current >= 3) {
            setIsOnline(false);
          }
          triggerNextFrame(1200); // Retry smoothly
        }}
        className={cn('w-full h-full object-cover', !isOnline && 'opacity-20')}
      />

      {!isOnline && (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-2 text-center text-zinc-500 font-mono text-[10px] bg-black/80">
          <Video className="h-6 w-6 text-red-500/60 mb-1" />
          <span className="text-zinc-400 font-semibold">{label} ({cameraIp})</span>
          <span className="text-[9px] text-red-400 mt-0.5">Connecting to camera...</span>
        </div>
      )}

      {/* CP PLUS On-Screen Display (OSD) Overlay */}
      <div className="absolute top-1 left-1.5 right-1.5 flex items-center justify-between pointer-events-none">
        <span className="bg-black/60 backdrop-blur-xs text-[9px] font-mono font-bold text-emerald-400 px-1 py-0.5 rounded">
          {label}
        </span>
        <span className="text-[9px] font-mono font-bold text-emerald-300 drop-shadow-[0_1px_2px_rgba(0,0,0,1)]">
          {currentTime}
        </span>
      </div>

      <div className="absolute bottom-1 left-1.5 right-1.5 flex items-center justify-between pointer-events-none">
        <span className="text-[9px] font-mono font-bold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,1)] tracking-wider">
          CP PLUS Cam
        </span>
        <span className="text-[8px] font-mono text-emerald-400/80 bg-black/60 px-1 rounded">
          {cameraIp}
        </span>
      </div>
    </div>
  );
}

export default function WeighbridgeScreen() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { isConnected, liveWeight, isStable, connect } = useScale();

  // Live running clock
  const [currentTime, setCurrentTime] = useState<string>('');
  const [currentDate, setCurrentDate] = useState<string>('');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setCurrentTime(now.toLocaleTimeString('en-US', { hour12: true }));
      const dd = String(now.getDate()).padStart(2, '0');
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const yyyy = now.getFullYear();
      setCurrentDate(`${dd}-${mm}-${yyyy}`);
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
  }, []);

  // Queries
  const { data: nextNumberData } = useQuery<{ nextTicketNo: number }>({
    queryKey: ['weighbridge-next-number'],
    queryFn: () => api('/weighbridge/next-number'),
    staleTime: 5000,
  });

  const { data: tickets = [], isLoading: ticketsLoading } = useQuery<WeighbridgeTicket[]>({
    queryKey: ['weighbridge-tickets'],
    queryFn: () => api('/weighbridge/tickets?limit=50'),
    refetchInterval: 10000,
  });

  const { data: pendingTrucks = [] } = useQuery<WeighbridgeTicket[]>({
    queryKey: ['weighbridge-pending'],
    queryFn: () => api('/weighbridge/pending'),
    refetchInterval: 5000,
  });

  const { data: parties = [] } = useQuery<Party[]>({
    queryKey: ['parties'],
    queryFn: () => api('/parties'),
  });

  const { data: companyProfile } = useQuery<CompanyProfile>({
    queryKey: ['company-profile'],
    queryFn: () => api('/settings/profile'),
  });

  // Form State
  const [ticketNo, setTicketNo] = useState<string>('');
  const [vehicleNumber, setVehicleNumber] = useState<string>('');
  const [vehicleType, setVehicleType] = useState<string>('LORRY');
  const [tripType, setTripType] = useState<string>('SECOND'); // FIRST, SECOND, SINGLE
  const [selectedPartyName, setSelectedPartyName] = useState<string>('');
  const [mobileNumber, setMobileNumber] = useState<string>('');
  const [material, setMaterial] = useState<string>('PAPPU');
  const [loadType, setLoadType] = useState<string>('LOAD'); // LOAD, EMPTY
  const [billType, setBillType] = useState<string>('CASH'); // CASH, CREDIT
  const [kataFeeAmount, setKataFeeAmount] = useState<string>('100');
  const [remarks, setRemarks] = useState<string>('');

  // Weights
  const [firstWeight, setFirstWeight] = useState<string>('');
  const [manualCurrentWeight, setManualCurrentWeight] = useState<string>('');
  const [lockCurrentToScale, setLockCurrentToScale] = useState<boolean>(true);

  // Selected existing ticket for completing 2nd weight
  const [activePendingTicketId, setActivePendingTicketId] = useState<string | null>(null);

  // Slip Printing
  const [printSlipTicket, setPrintSlipTicket] = useState<WeighbridgeTicket | null>(null);

  // CP PLUS Network CCTV Camera State (192.168.1.101 & 192.168.1.102)
  const [cameraRefreshKey, setCameraRefreshKey] = useState<number>(Date.now());
  const [snapshots, setSnapshots] = useState<{ cam1?: string; cam2?: string }>({});

  // Capture snapshots from both cameras (calls backend snapshot endpoints)
  const captureCurrentSnapshots = useCallback(async () => {
    const ts = Date.now();
    const snap1 = `/api/weighbridge/cctv/snapshot?cam=1&t=${ts}`;
    const snap2 = `/api/weighbridge/cctv/snapshot?cam=2&t=${ts}`;
    const result = { cam1: snap1, cam2: snap2 };
    setSnapshots(result);
    return result;
  }, []);

  const reloadCameras = useCallback(() => {
    setCameraRefreshKey(Date.now());
    toast.success('Refreshing CP PLUS camera feeds...');
  }, []);

  // Search in ticket history
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Auto-fill ticket number when next number loads
  useEffect(() => {
    if (nextNumberData?.nextTicketNo && !ticketNo && !activePendingTicketId) {
      setTicketNo(String(nextNumberData.nextTicketNo));
    }
  }, [nextNumberData, ticketNo, activePendingTicketId]);

  // Current weight resolution: uses live COM4 reading if locked & connected, else manual input
  const resolvedCurrentWeight = useMemo(() => {
    if (lockCurrentToScale && isConnected && liveWeight != null) {
      return liveWeight;
    }
    const parsed = parseInt(manualCurrentWeight, 10);
    return isNaN(parsed) ? (liveWeight ?? 0) : parsed;
  }, [lockCurrentToScale, isConnected, liveWeight, manualCurrentWeight]);

  // Nett Weight Calculation: |Current - First|
  const calculatedNettWeight = useMemo(() => {
    const first = parseInt(firstWeight, 10);
    if (isNaN(first)) return null;
    return Math.abs(resolvedCurrentWeight - first);
  }, [firstWeight, resolvedCurrentWeight]);

  // Load a pending ticket into the form for 2nd weight
  const selectPendingTruck = useCallback((t: WeighbridgeTicket) => {
    setActivePendingTicketId(t.id);
    setTicketNo(String(t.ticketNo));
    setVehicleNumber(t.vehicleNumber);
    setVehicleType(t.vehicleType);
    setTripType('SECOND');
    setSelectedPartyName(t.partyName || '');
    setMobileNumber(t.partyMobile || '');
    setMaterial(t.material || 'PAPPU');
    setLoadType(t.loadType === 'EMPTY' ? 'LOAD' : 'EMPTY'); // Toggle to opposite
    setFirstWeight(String(t.firstWeightKg ?? ''));
    setKataFeeAmount(String(t.amount || 100));
    setLockCurrentToScale(true);
    toast.info(`Loaded Ticket #${t.ticketNo} (${t.vehicleNumber}) - Ready for Second Weight`);
  }, []);

  // Reset form
  const clearForm = useCallback(() => {
    setActivePendingTicketId(null);
    setTicketNo(nextNumberData?.nextTicketNo ? String(nextNumberData.nextTicketNo) : '');
    setVehicleNumber('');
    setVehicleType('LORRY');
    setTripType('SECOND');
    setSelectedPartyName('');
    setMobileNumber('');
    setMaterial('PAPPU');
    setLoadType('LOAD');
    setBillType('CASH');
    setKataFeeAmount('100');
    setFirstWeight('');
    setManualCurrentWeight('');
    setLockCurrentToScale(true);
    setRemarks('');
  }, [nextNumberData]);

  // Create or Update Ticket Mutation
  const saveTicketMutation = useMutation({
    mutationFn: async () => {
      if (!vehicleNumber.trim()) {
        throw new Error('Please enter vehicle number');
      }

      await captureCurrentSnapshots();

      if (activePendingTicketId) {
        // Complete second weight
        return api(`/weighbridge/tickets/${activePendingTicketId}/second-weight`, {
          method: 'POST',
          body: {
            secondWeightKg: resolvedCurrentWeight,
            loadType,
            remarks,
          },
        });
      } else {
        // Create new ticket
        return api<WeighbridgeTicket>('/weighbridge/tickets', {
          method: 'POST',
          body: {
            vehicleNumber: vehicleNumber.trim().toUpperCase(),
            vehicleType,
            tripType,
            partyName: selectedPartyName || null,
            partyMobile: mobileNumber || null,
            material,
            loadType,
            billType,
            amount: Number(kataFeeAmount) || 100,
            firstWeightKg: tripType === 'FIRST' ? resolvedCurrentWeight : (parseInt(firstWeight, 10) || null),
            secondWeightKg: tripType === 'SECOND' ? resolvedCurrentWeight : null,
            remarks: remarks || null,
          },
        });
      }
    },
    onSuccess: (saved: any) => {
      toast.success(`Ticket #${saved.ticketNo} saved successfully!`);
      qc.invalidateQueries({ queryKey: ['weighbridge-tickets'] });
      qc.invalidateQueries({ queryKey: ['weighbridge-pending'] });
      qc.invalidateQueries({ queryKey: ['weighbridge-next-number'] });

      // Open printable slip
      setPrintSlipTicket(saved);
      clearForm();
    },
    onError: (err: any) => {
      toast.error(getErrorMessage(err));
    },
  });

  // Keyboard shortcut F12 to save ticket
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F12') {
        e.preventDefault();
        saveTicketMutation.mutate();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveTicketMutation]);

  // Filtered tickets
  const filteredTickets = useMemo(() => {
    if (!searchQuery.trim()) return tickets;
    const q = searchQuery.toLowerCase().trim();
    return tickets.filter(
      (t) =>
        t.vehicleNumber.toLowerCase().includes(q) ||
        String(t.ticketNo).includes(q) ||
        (t.partyName && t.partyName.toLowerCase().includes(q)) ||
        (t.material && t.material.toLowerCase().includes(q))
    );
  }, [tickets, searchQuery]);

  return (
    <div className="space-y-6 select-none font-sans">
      {/* ── Main Weighbridge Station Console ── */}
      <div className="rounded-xl border border-zinc-700/60 bg-zinc-900 text-zinc-100 shadow-2xl overflow-hidden">
        {/* Top Header Bar (Legacy Terminal Style) */}
        <div className="bg-zinc-950 px-5 py-2.5 border-b border-zinc-800 flex flex-wrap items-center justify-between gap-4 text-xs font-mono">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <span className="text-zinc-500 uppercase">Login User:</span>
              <span className="font-bold text-emerald-400">{user?.name || 'ADMIN'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-zinc-500 uppercase">Date:</span>
              <span className="font-bold text-zinc-200">{currentDate}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-zinc-500 uppercase">Time:</span>
              <span className="font-bold text-red-400 tracking-wider bg-red-950/40 px-2 py-0.5 rounded border border-red-800/40">
                {currentTime}
              </span>
            </div>
          </div>

          {/* Scale Connection Badge */}
          <div className="flex items-center gap-3">
            {isConnected ? (
              <div className="flex items-center gap-2 bg-emerald-950/60 text-emerald-400 px-3 py-1 rounded-full border border-emerald-800/50 text-[11px] font-semibold">
                <Wifi className="h-3 w-3" />
                <span>COM4 (2400 baud) · LIVE</span>
              </div>
            ) : (
              <Button
                size="xs"
                variant="outline"
                onClick={() => connect()}
                className="bg-zinc-800 text-zinc-300 border-zinc-700 hover:bg-zinc-700 text-xs h-7 gap-1.5"
              >
                <WifiOff className="h-3 w-3 text-amber-400" />
                Connect COM4
              </Button>
            )}
          </div>
        </div>

        {/* ── Main Station Body ── */}
        <div className="p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 bg-gradient-to-b from-zinc-900 to-zinc-950">
          {/* Left Column: Transaction Entry (7 Cols) */}
          <div className="lg:col-span-7 space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
              <div className="flex items-center gap-2">
                <Scale className="h-4 w-4 text-emerald-400" />
                <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-200">
                  Transaction Entry Screen
                </h3>
              </div>
              {activePendingTicketId && (
                <Badge variant="outline" className="bg-amber-500/10 text-amber-400 border-amber-500/30 text-xs font-mono">
                  Completing Second Weight for Ticket #{ticketNo}
                </Badge>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Ticket No */}
              <div className="space-y-1">
                <Label className="text-xs font-mono text-zinc-400">Ticket No</Label>
                <Input
                  value={ticketNo}
                  onChange={(e) => setTicketNo(e.target.value)}
                  className="bg-zinc-950 border-zinc-700 font-mono font-bold text-red-400 h-9"
                  placeholder="2807"
                />
              </div>

              {/* Vehicle No */}
              <div className="space-y-1">
                <Label className="text-xs font-mono text-zinc-400 flex items-center justify-between">
                  <span>Vehicle No *</span>
                  <span className="text-[10px] text-zinc-500 uppercase">e.g. GJ36T8660</span>
                </Label>
                <Input
                  value={vehicleNumber}
                  onChange={(e) => setVehicleNumber(e.target.value.toUpperCase())}
                  className="bg-zinc-950 border-zinc-700 font-mono font-bold text-zinc-100 uppercase h-9 tracking-wider"
                  placeholder="GJ36T8660"
                  required
                />
              </div>

              {/* Vehicle Type */}
              <div className="space-y-1">
                <Label className="text-xs font-mono text-zinc-400">Vehicle Type</Label>
                <Select value={vehicleType} onValueChange={setVehicleType}>
                  <SelectTrigger className="bg-zinc-950 border-zinc-700 text-zinc-100 h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-zinc-900 border-zinc-700 text-zinc-100">
                    <SelectItem value="LORRY">LORRY</SelectItem>
                    <SelectItem value="TRACTOR">TRACTOR</SelectItem>
                    <SelectItem value="AUTO">AUTO / PICKUP</SelectItem>
                    <SelectItem value="TANKER">TANKER</SelectItem>
                    <SelectItem value="OTHER">OTHER</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Trip Type */}
              <div className="space-y-1">
                <Label className="text-xs font-mono text-zinc-400">Trip Type</Label>
                <Select value={tripType} onValueChange={setTripType} disabled={!!activePendingTicketId}>
                  <SelectTrigger className="bg-zinc-950 border-zinc-700 text-zinc-100 h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-zinc-900 border-zinc-700 text-zinc-100">
                    <SelectItem value="SECOND">Second Weight (Gross - Tare = Net)</SelectItem>
                    <SelectItem value="FIRST">First Weight (Inward / Empty Tare)</SelectItem>
                    <SelectItem value="SINGLE">Single Weighment (No Net)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Customer / Party Name */}
              <div className="space-y-1 md:col-span-2">
                <Label className="text-xs font-mono text-zinc-400">Cust. Name (Party)</Label>
                <Input
                  list="weighbridge-parties"
                  value={selectedPartyName}
                  onChange={(e) => setSelectedPartyName(e.target.value)}
                  className="bg-zinc-950 border-zinc-700 text-zinc-100 h-9 uppercase font-mono"
                  placeholder="COLOURTEX INDUSTRIES"
                />
                <datalist id="weighbridge-parties">
                  {parties.map((p) => (
                    <option key={p.id} value={p.name} />
                  ))}
                </datalist>
              </div>

              {/* Mobile Number */}
              <div className="space-y-1">
                <Label className="text-xs font-mono text-zinc-400">Mobile No</Label>
                <Input
                  value={mobileNumber}
                  onChange={(e) => setMobileNumber(e.target.value)}
                  className="bg-zinc-950 border-zinc-700 text-zinc-100 h-9 font-mono"
                  placeholder="9876543210"
                />
              </div>

              {/* Material */}
              <div className="space-y-1">
                <Label className="text-xs font-mono text-zinc-400">Material</Label>
                <Input
                  list="weighbridge-materials"
                  value={material}
                  onChange={(e) => setMaterial(e.target.value.toUpperCase())}
                  className="bg-zinc-950 border-zinc-700 text-zinc-100 h-9 font-mono uppercase"
                  placeholder="PAPPU"
                />
                <datalist id="weighbridge-materials">
                  {MATERIALS.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>

              {/* Load Type */}
              <div className="space-y-1">
                <Label className="text-xs font-mono text-zinc-400">Load Type</Label>
                <Select value={loadType} onValueChange={setLoadType}>
                  <SelectTrigger className="bg-zinc-950 border-zinc-700 text-zinc-100 h-9 font-mono">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-zinc-900 border-zinc-700 text-zinc-100">
                    <SelectItem value="LOAD">LOAD (Loaded Consignment)</SelectItem>
                    <SelectItem value="EMPTY">EMPTY (Tare Vehicle)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Bill Type */}
              <div className="space-y-1">
                <Label className="text-xs font-mono text-zinc-400">Bill Type</Label>
                <Select value={billType} onValueChange={setBillType}>
                  <SelectTrigger className="bg-zinc-950 border-zinc-700 text-zinc-100 h-9 font-mono">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-zinc-900 border-zinc-700 text-zinc-100">
                    <SelectItem value="CASH">Cash</SelectItem>
                    <SelectItem value="CREDIT">Credit</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Amount (Kata Fee) */}
              <div className="space-y-1">
                <Label className="text-xs font-mono text-zinc-400">Amount (Fee ₹)</Label>
                <Input
                  type="number"
                  value={kataFeeAmount}
                  onChange={(e) => setKataFeeAmount(e.target.value)}
                  className="bg-zinc-950 border-zinc-700 font-mono font-bold text-emerald-400 h-9"
                  placeholder="100"
                />
              </div>

              {/* Remarks */}
              <div className="space-y-1">
                <Label className="text-xs font-mono text-zinc-400">Remarks</Label>
                <Input
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  className="bg-zinc-950 border-zinc-700 text-zinc-100 h-9 font-mono"
                  placeholder="Optional notes"
                />
              </div>
            </div>
          </div>

          {/* Right Column: Giant Digital Readout & Weights (5 Cols) */}
          <div className="lg:col-span-5 flex flex-col justify-between space-y-4">
            {/* ── Giant 7-Segment Digital Readout (Direct Photo Replica) ── */}
            <div className="rounded-xl bg-black border-2 border-zinc-800 p-5 shadow-[inset_0_0_20px_rgba(0,0,0,0.9)] relative overflow-hidden">
              <div className="flex items-center justify-between text-[11px] font-mono text-zinc-500 mb-1">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                  SCALE INDICATOR (COM4)
                </span>
                <span className={cn('font-bold uppercase tracking-wider', isStable ? 'text-emerald-400' : 'text-amber-400')}>
                  {isStable ? 'STABLE' : 'MOTION'}
                </span>
              </div>

              {/* Giant Red Digits */}
              <div className="text-right py-3 select-none">
                <span className="font-mono text-6xl md:text-7xl font-extrabold tracking-widest text-red-500 drop-shadow-[0_0_15px_rgba(239,68,68,0.7)]">
                  {resolvedCurrentWeight.toLocaleString('en-IN')}
                </span>
                <span className="text-lg font-bold text-red-600/80 ml-2 font-mono">KG</span>
              </div>

              {/* Lock / Live Sync Controls */}
              <div className="mt-2 pt-2 border-t border-zinc-900 flex items-center justify-between text-xs font-mono">
                <button
                  type="button"
                  onClick={() => setLockCurrentToScale((prev) => !prev)}
                  className={cn(
                    'flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border transition-colors',
                    lockCurrentToScale
                      ? 'bg-emerald-950/60 border-emerald-700/60 text-emerald-400'
                      : 'bg-zinc-800 border-zinc-700 text-zinc-400'
                  )}
                >
                  <Zap className="h-3 w-3" />
                  {lockCurrentToScale ? 'Live Sync Active' : 'Manual Override'}
                </button>
                <span className="text-zinc-500 text-[10px]">
                  {lockCurrentToScale ? 'Updating automatically' : 'Fixed weight'}
                </span>
              </div>
            </div>

            {/* ── Two CCTV / Platform Viewboxes (Matching Photo) ── */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400">
                <span className="flex items-center gap-1.5 font-semibold text-zinc-300">
                  <Video className="h-3.5 w-3.5 text-red-500" />
                  CP PLUS CCTV LIVE (192.168.1.101 / 102)
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-emerald-400 flex items-center gap-1 font-semibold">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    Live Network Feed
                  </span>
                  <button
                    type="button"
                    onClick={reloadCameras}
                    title="Reconnect feeds"
                    className="text-[10px] text-zinc-400 hover:text-zinc-200 underline flex items-center gap-1"
                  >
                    <RotateCcw className="h-2.5 w-2.5" />
                    Refresh
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <CctvLiveBox
                  camNumber={1}
                  cameraIp="192.168.1.101"
                  label="CAM 1: ENTRY"
                  currentTime={currentTime}
                  refreshTrigger={cameraRefreshKey}
                />
                <CctvLiveBox
                  camNumber={2}
                  cameraIp="192.168.1.102"
                  label="CAM 2: EXIT"
                  currentTime={currentTime}
                  refreshTrigger={cameraRefreshKey}
                />
              </div>
            </div>

            {/* ── Weight Calculations Matrix ── */}
            <div className="rounded-lg bg-zinc-950 border border-zinc-800 p-4 font-mono space-y-2.5">
              {/* First Weigh */}
              <div className="flex items-center justify-between text-xs">
                <span className="text-red-400 font-bold uppercase tracking-wider">First Weigh:</span>
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    value={firstWeight}
                    onChange={(e) => setFirstWeight(e.target.value)}
                    placeholder="0"
                    className="w-28 h-7 text-right bg-black border-zinc-700 text-red-400 font-mono font-bold text-sm px-2"
                  />
                  <span className="text-[10px] text-zinc-500">KG</span>
                </div>
              </div>

              {/* Current (Second Weigh) */}
              <div className="flex items-center justify-between text-xs">
                <span className="text-emerald-400 font-bold uppercase tracking-wider">Current:</span>
                <div className="flex items-center gap-1.5">
                  {lockCurrentToScale ? (
                    <span className="w-28 text-right font-mono font-bold text-emerald-400 text-sm py-0.5 px-2 bg-black rounded border border-zinc-700">
                      {resolvedCurrentWeight.toLocaleString('en-IN')}
                    </span>
                  ) : (
                    <Input
                      type="number"
                      value={manualCurrentWeight}
                      onChange={(e) => setManualCurrentWeight(e.target.value)}
                      placeholder="0"
                      className="w-28 h-7 text-right bg-black border-zinc-700 text-emerald-400 font-mono font-bold text-sm px-2"
                    />
                  )}
                  <span className="text-[10px] text-zinc-500">KG</span>
                </div>
              </div>

              {/* Nett Weight */}
              <div className="pt-2 border-t border-zinc-800 flex items-center justify-between">
                <span className="text-cyan-400 font-extrabold uppercase tracking-wider text-sm">
                  Nett Weight:
                </span>
                <div className="flex items-baseline gap-1.5">
                  <span className="font-mono font-black text-xl text-cyan-400 tracking-wider">
                    {calculatedNettWeight != null ? calculatedNettWeight.toLocaleString('en-IN') : '0'}
                  </span>
                  <span className="text-xs font-bold text-cyan-500">KG</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Bottom Action Toolbar (Photo Replica Buttons) ── */}
        <div className="bg-zinc-950 px-6 py-3 border-t border-zinc-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {/* Save (F12) */}
            <Button
              size="sm"
              onClick={() => saveTicketMutation.mutate()}
              disabled={saveTicketMutation.isPending}
              className="h-9 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-mono font-bold text-xs gap-1.5 shadow-md shadow-emerald-950"
            >
              <Save className="h-4 w-4" />
              <span>Save (F12)</span>
            </Button>

            {/* Clear / New */}
            <Button
              size="sm"
              variant="outline"
              onClick={clearForm}
              className="h-9 px-4 bg-zinc-800 border-zinc-700 text-zinc-200 hover:bg-zinc-700 font-mono text-xs gap-1.5"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Clear</span>
            </Button>

            {/* Re-Print Last Ticket */}
            {tickets.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPrintSlipTicket(tickets[0])}
                className="h-9 px-4 bg-zinc-800 border-zinc-700 text-zinc-200 hover:bg-zinc-700 font-mono text-xs gap-1.5"
              >
                <Printer className="h-3.5 w-3.5" />
                <span>Re-Print #{tickets[0].ticketNo}</span>
              </Button>
            )}
          </div>

          {/* Pending trucks counter / quick pill */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-zinc-400">
              Pending Second Weight: <strong className="text-amber-400">{pendingTrucks.length}</strong> trucks inside
            </span>
          </div>
        </div>
      </div>

      {/* ── Pending Trucks Section (Awaiting Second Weight) ── */}
      {pendingTrucks.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-semibold text-xs uppercase tracking-wider">
              <Clock className="h-4 w-4" />
              <span>Trucks Awaiting Second Weight ({pendingTrucks.length})</span>
            </div>
            <span className="text-[11px] text-muted-foreground">Click any truck to load & complete weighment</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5">
            {pendingTrucks.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => selectPendingTruck(t)}
                className={cn(
                  'p-3 rounded-lg border text-left transition-all hover:scale-[1.01]',
                  activePendingTicketId === t.id
                    ? 'border-amber-500 bg-amber-500/20 shadow-md ring-1 ring-amber-400'
                    : 'border-border bg-card hover:bg-accent'
                )}
              >
                <div className="flex justify-between items-start">
                  <span className="font-mono font-bold text-sm text-foreground">{t.vehicleNumber}</span>
                  <span className="text-[10px] font-mono font-semibold text-muted-foreground">#{t.ticketNo}</span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground truncate">{t.partyName || t.material || 'Lorry'}</div>
                <div className="mt-1 flex justify-between items-center text-[11px] font-mono">
                  <span className="text-amber-600 dark:text-amber-400 font-semibold">
                    1st: {t.firstWeightKg?.toLocaleString('en-IN')} kg
                  </span>
                  <span className="text-muted-foreground/60">{new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Weighbridge Tickets Log & Report Table ── */}
      <div className="rounded-xl border border-border bg-card shadow-sm p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Weighbridge Daily Register</h3>
            <p className="text-xs text-muted-foreground">All first and second weighments recorded at RVP weighbridge</p>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-2.5 text-muted-foreground" />
              <Input
                placeholder="Search ticket or vehicle..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-8 text-xs w-56 bg-background"
              />
            </div>
          </div>
        </div>

        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 text-[11px] uppercase font-mono">
                <TableHead className="w-16">Ticket</TableHead>
                <TableHead>Date & Time</TableHead>
                <TableHead>Vehicle No</TableHead>
                <TableHead>Party / Customer</TableHead>
                <TableHead>Material</TableHead>
                <TableHead className="text-right">1st Wt (kg)</TableHead>
                <TableHead className="text-right">2nd Wt (kg)</TableHead>
                <TableHead className="text-right font-bold">Nett (kg)</TableHead>
                <TableHead className="text-right">Fee (₹)</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="text-xs font-mono">
              {ticketsLoading ? (
                <TableRow>
                  <TableCell colSpan={11} className="text-center py-8 text-muted-foreground">
                    Loading weighbridge tickets...
                  </TableCell>
                </TableRow>
              ) : filteredTickets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} className="text-center py-8 text-muted-foreground">
                    No weighbridge tickets recorded yet.
                  </TableCell>
                </TableRow>
              ) : (
                filteredTickets.map((t) => (
                  <TableRow key={t.id} className="hover:bg-muted/30">
                    <TableCell className="font-bold text-foreground">#{t.ticketNo}</TableCell>
                    <TableCell className="text-muted-foreground text-[11px]">
                      {shortDate(t.createdAt)} {new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </TableCell>
                    <TableCell className="font-bold text-foreground tracking-wide">{t.vehicleNumber}</TableCell>
                    <TableCell className="max-w-[150px] truncate">{t.partyName || '-'}</TableCell>
                    <TableCell>{t.material || '-'}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {t.firstWeightKg != null ? t.firstWeightKg.toLocaleString('en-IN') : '-'}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {t.secondWeightKg != null ? t.secondWeightKg.toLocaleString('en-IN') : '-'}
                    </TableCell>
                    <TableCell className="text-right font-bold text-emerald-600 dark:text-emerald-400">
                      {t.netWeightKg != null ? t.netWeightKg.toLocaleString('en-IN') : '-'}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">₹{Number(t.amount || 0).toFixed(0)}</TableCell>
                    <TableCell>
                      {t.status === 'COMPLETED' ? (
                        <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 text-[10px]">
                          Completed
                        </Badge>
                      ) : t.status === 'PENDING_SECOND' ? (
                        <Badge variant="outline" className="bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20 text-[10px]">
                          1st Wt Done
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-destructive text-[10px]">
                          Cancelled
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setPrintSlipTicket(t)}
                        title="Print Kata Slip"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                      >
                        <Printer className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* ── Printable Slip Modal ── */}
      <WeighbridgeSlipModal
        ticket={printSlipTicket}
        companyProfile={companyProfile}
        snapshots={snapshots}
        onClose={() => setPrintSlipTicket(null)}
      />
    </div>
  );
}
