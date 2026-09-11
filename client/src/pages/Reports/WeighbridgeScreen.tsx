import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Scale,
  Printer,
  RotateCcw,
  Clock,
  Video,
  Search,
  Truck,
  FileText,
  Calendar,
  User,
  Package,
  CreditCard,
  Phone,
  Tag,
  CheckCircle2,
  RefreshCw,
  AlertTriangle,
  Pencil,
  Settings,
  ShieldCheck,
  Maximize2,
  Copy,
  Check,
  Download,
} from 'lucide-react';
import { api, getErrorMessage, getScaleApiUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useScale } from '@/lib/scaleContext';
import type { Party, CompanyProfile, WeighbridgeTicket } from '@/lib/types';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
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

const VEHICLE_TYPES = [
  { value: 'LORRY', label: 'Lorry / Truck (10-14 Wheeler)' },
  { value: 'TRAILER', label: 'Heavy Trailer (18-22 Wheeler)' },
  { value: 'TRACTOR', label: 'Tractor / Trolley' },
  { value: 'TIPPER', label: 'Tipper' },
  { value: 'TEMPO', label: 'Tempo / 407 / Pickup' },
  { value: 'AUTO', label: 'Small Commercial (Auto / Ape)' },
  { value: 'TANKER', label: 'Liquid / Oil Tanker' },
  { value: 'OTHER', label: 'Other Vehicle' },
];

export function getCameraSnapshotUrl(camNumber: 1 | 2, ts: number = Date.now(), preferLocal: boolean = true): string {
  if (preferLocal) {
    return `http://127.0.0.1:4000/api/weighbridge/cctv/snapshot?cam=${camNumber}&t=${ts}`;
  }
  return getScaleApiUrl(`/weighbridge/cctv/snapshot?cam=${camNumber}&t=${ts}`);
}

interface CctvLiveBoxProps {
  camNumber: 1 | 2;
  cameraIp: string;
  label: string;
  currentTime: string;
  refreshTrigger?: number;
  onStatusChange?: (online: boolean, isLocal: boolean) => void;
  onExpand?: (camNumber: 1 | 2) => void;
}

function CctvLiveBox({ camNumber, cameraIp, label, currentTime, refreshTrigger, onStatusChange, onExpand }: CctvLiveBoxProps) {
  const [preferLocal, setPreferLocal] = useState<boolean>(true);
  const [frameUrl, setFrameUrl] = useState<string>(() =>
    getCameraSnapshotUrl(camNumber, Date.now(), true)
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
        setFrameUrl(getCameraSnapshotUrl(camNumber, Date.now(), preferLocal));
      }
    }, delayMs);
  }, [camNumber, preferLocal]);

  useEffect(() => {
    if (refreshTrigger) {
      setFrameUrl(getCameraSnapshotUrl(camNumber, Date.now(), preferLocal));
    }
  }, [refreshTrigger, camNumber, preferLocal]);

  return (
    <div 
      onClick={() => onExpand?.(camNumber)}
      title="Click to open Full Live View"
      className="rounded-xl bg-stone-950 border border-border/80 h-40 relative overflow-hidden flex items-center justify-center group shadow-md cursor-pointer hover:border-amber-500/60 transition-all duration-200"
    >
      <img
        src={frameUrl}
        alt={`Camera ${camNumber} - ${label}`}
        onLoad={() => {
          errCountRef.current = 0;
          setIsOnline(true);
          onStatusChange?.(true, preferLocal);
          triggerNextFrame(preferLocal ? 100 : 350); // 100ms ultra-low latency local refresh (~10 FPS)
        }}
        onError={() => {
          errCountRef.current += 1;
          if (preferLocal && errCountRef.current >= 2) {
            // Local bridge not responding, switch to cloud relay
            setPreferLocal(false);
            setFrameUrl(getCameraSnapshotUrl(camNumber, Date.now(), false));
          } else if (errCountRef.current >= 4) {
            setIsOnline(false);
            onStatusChange?.(false, preferLocal);
          }
          triggerNextFrame(1500);
        }}
        className={cn('w-full h-full object-cover transition-opacity duration-300', !isOnline && 'opacity-25')}
      />

      {!isOnline && (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-3 text-center bg-stone-950/85 backdrop-blur-xs text-stone-400">
          <Video className="h-6 w-6 text-rose-500/70 mb-1.5 animate-pulse" />
          <span className="font-semibold text-xs text-stone-200">{label}</span>
          <span className="text-[10px] text-stone-400 font-mono mt-0.5">{cameraIp}</span>
          <span className="text-[10px] text-amber-400 font-mono mt-1">Connecting to camera...</span>
        </div>
      )}

      {/* Elegant OSD Overlay */}
      <div className="absolute top-2 left-2 right-2 flex items-center justify-between pointer-events-none">
        <span className="bg-stone-900/80 backdrop-blur-xs text-[10px] font-mono font-bold text-amber-400 px-2 py-0.5 rounded-md border border-stone-700/60 shadow-xs">
          {label}
        </span>
        <span className="bg-stone-900/80 backdrop-blur-xs text-[10px] font-mono font-medium text-stone-200 px-2 py-0.5 rounded-md border border-stone-700/60 shadow-xs">
          {currentTime}
        </span>
      </div>

      {/* Hover to Expand indicator overlay */}
      <div className="absolute inset-0 bg-stone-950/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1.5 text-white font-medium text-xs backdrop-blur-2xs">
        <Maximize2 className="h-4 w-4 text-amber-400 animate-bounce" />
        <span className="text-stone-100 font-semibold">Click for Full Live View</span>
      </div>

      {/* Source & IP watermark pill */}
      <div className="absolute bottom-2 left-2 pointer-events-none flex items-center gap-1.5">
        <span className="text-[9px] font-mono text-stone-300 bg-stone-900/80 px-1.5 py-0.5 rounded border border-stone-800">
          {cameraIp}
        </span>
        <span className={cn(
          "text-[8px] font-mono px-1 py-0.2 rounded border font-semibold",
          preferLocal ? "bg-emerald-950/80 text-emerald-300 border-emerald-800/60" : "bg-blue-950/80 text-blue-300 border-blue-800/60"
        )}>
          {preferLocal ? "LIVE 25fps" : "CLOUD"}
        </span>
      </div>

      {/* Bottom right expand icon hint */}
      <div className="absolute bottom-2 right-2 pointer-events-none opacity-80 group-hover:opacity-100 transition-opacity">
        <span className="bg-stone-900/80 backdrop-blur-xs text-stone-300 p-1 rounded border border-stone-800 flex items-center justify-center shadow-xs">
          <Maximize2 className="h-3 w-3 text-amber-400" />
        </span>
      </div>
    </div>
  );
}

interface CctvFullViewDialogProps {
  camNumber: 1 | 2 | null;
  onClose: () => void;
  onSelectCam: (camNumber: 1 | 2) => void;
  currentTime: string;
}

function CctvFullViewDialog({ camNumber, onClose, onSelectCam, currentTime }: CctvFullViewDialogProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [streamError, setStreamError] = useState(false);
  const [streamKey, setStreamKey] = useState(() => Date.now());

  if (!camNumber) return null;

  const cameraIp = camNumber === 1 ? '192.168.1.101' : '192.168.1.102';
  const label = camNumber === 1 ? 'CAM 1: ENTRY' : 'CAM 2: EXIT';
  const rtspSub = `rtsp://admin:admin%40123@${cameraIp}:554/cam/realmonitor?channel=1&subtype=1`;
  const rtspMain = `rtsp://admin:admin%40123@${cameraIp}:554/cam/realmonitor?channel=1&subtype=0`;

  // Native live MJPEG stream on local port 4000, fallback to rapid snapshot polling
  const liveStreamUrl = !streamError 
    ? `http://127.0.0.1:4000/api/weighbridge/cctv/stream?cam=${camNumber}&k=${streamKey}`
    : getCameraSnapshotUrl(camNumber, streamKey, true);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    toast.success('RTSP stream link copied to clipboard');
    setTimeout(() => setCopiedKey(null), 2500);
  };

  const handleDownloadSnapshot = () => {
    const a = document.createElement('a');
    a.href = getCameraSnapshotUrl(camNumber, Date.now(), true);
    a.download = `WEIGHBRIDGE_${label.replace(/[^A-Za-z0-9]/g, '_')}_${Date.now()}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast.success(`Downloaded ${label} snapshot`);
  };

  return (
    <Dialog open={camNumber !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl p-0 overflow-hidden bg-stone-950 border-stone-800 text-stone-100 shadow-2xl">
        <DialogHeader className="p-4 pb-3 border-b border-stone-800/80 bg-stone-900/60">
          <div className="flex flex-wrap items-center justify-between gap-3 pr-6">
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
                <Video className="h-4 w-4" />
              </div>
              <div>
                <DialogTitle className="text-base font-bold text-stone-100 flex items-center gap-2">
                  <span>{label}</span>
                  <span className="text-xs font-normal font-mono text-stone-400">({cameraIp})</span>
                </DialogTitle>
                <DialogDescription className="text-xs text-stone-400">
                  Real-time ultra-low latency RTSP camera feed
                </DialogDescription>
              </div>
            </div>

            {/* Quick Cam 1 / Cam 2 switcher buttons */}
            <div className="flex items-center bg-stone-950 border border-stone-800 rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => {
                  setStreamError(false);
                  setStreamKey(Date.now());
                  onSelectCam(1);
                }}
                className={cn(
                  "px-3 py-1 text-xs font-semibold rounded-md transition-all",
                  camNumber === 1 
                    ? "bg-amber-500 text-stone-950 shadow-xs" 
                    : "text-stone-400 hover:text-stone-200"
                )}
              >
                CAM 1: ENTRY
              </button>
              <button
                type="button"
                onClick={() => {
                  setStreamError(false);
                  setStreamKey(Date.now());
                  onSelectCam(2);
                }}
                className={cn(
                  "px-3 py-1 text-xs font-semibold rounded-md transition-all",
                  camNumber === 2 
                    ? "bg-amber-500 text-stone-950 shadow-xs" 
                    : "text-stone-400 hover:text-stone-200"
                )}
              >
                CAM 2: EXIT
              </button>
            </div>
          </div>
        </DialogHeader>

        {/* Video Canvas Container */}
        <div className="relative aspect-video max-h-[68vh] w-full bg-black flex items-center justify-center overflow-hidden select-none">
          <img
            key={`${camNumber}-${streamKey}`}
            src={liveStreamUrl}
            alt={label}
            onError={() => {
              if (!streamError) {
                setStreamError(true);
                setStreamKey(Date.now());
              }
            }}
            className="w-full h-full object-contain"
          />

          {/* OSD Top Bar */}
          <div className="absolute top-3 left-3 right-3 flex items-center justify-between pointer-events-none">
            <div className="flex items-center gap-2 bg-stone-950/80 backdrop-blur-md px-2.5 py-1 rounded-md border border-stone-700/60 shadow-md">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-bold font-mono text-emerald-400 uppercase tracking-wider">LIVE FEED</span>
              <span className="text-[11px] text-stone-400 font-mono">| 25 FPS</span>
              <span className="text-[10px] text-amber-300 font-mono bg-amber-950/60 px-1 py-0.5 rounded border border-amber-700/40">&lt;50ms LATENCY</span>
            </div>

            <div className="bg-stone-950/80 backdrop-blur-md px-2.5 py-1 rounded-md border border-stone-700/60 text-xs font-mono font-medium text-stone-200 shadow-md">
              {currentTime}
            </div>
          </div>

          {/* OSD Bottom Bar */}
          <div className="absolute bottom-3 left-3 pointer-events-none flex items-center gap-2">
            <div className="bg-stone-950/85 backdrop-blur-md px-2.5 py-1 rounded-md border border-stone-700/60 text-[11px] font-mono text-stone-300 shadow-md">
              CP PLUS HD IP CAMERA • {cameraIp}:554
            </div>
          </div>
        </div>

        {/* Action Toolbar */}
        <div className="p-3 bg-stone-900/90 border-t border-stone-800 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => copyToClipboard(rtspSub, 'sub')}
              className="bg-stone-800 border-stone-700 text-stone-200 hover:bg-stone-700 hover:text-white text-xs h-8 gap-1.5"
            >
              {copiedKey === 'sub' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              <span>Copy RTSP Live Link</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => copyToClipboard(rtspMain, 'main')}
              className="bg-stone-800 border-stone-700 text-stone-200 hover:bg-stone-700 hover:text-white text-xs h-8 gap-1.5"
            >
              {copiedKey === 'main' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              <span>Copy HD Mainstream Link</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={handleDownloadSnapshot}
              className="bg-stone-800 border-stone-700 text-stone-200 hover:bg-stone-700 hover:text-white text-xs h-8 gap-1.5"
            >
              <Download className="h-3.5 w-3.5 text-amber-400" />
              <span>Save HD Snapshot</span>
            </Button>
          </div>

          <Button
            size="sm"
            onClick={onClose}
            className="bg-amber-500 hover:bg-amber-600 text-stone-950 font-semibold text-xs h-8 px-4"
          >
            Close Full View
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}


export default function WeighbridgeScreen() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const scale = useScale();

  // Active view tab: 'entry' | 'pending' | 'history'
  const [activeTab, setActiveTab] = useState<'entry' | 'pending' | 'history'>('entry');

  // Form states
  const [vehicleNumber, setVehicleNumber] = useState<string>('');
  const [vehicleType, setVehicleType] = useState<string>('LORRY');
  const [tripType, setTripType] = useState<'FIRST' | 'SECOND' | 'SINGLE'>('FIRST');
  const [partyName, setPartyName] = useState<string>('');
  const [material, setMaterial] = useState<string>('PAPPU');
  const [loadType, setLoadType] = useState<'LOAD' | 'EMPTY'>('LOAD');
  const [billType, setBillType] = useState<'CASH' | 'CREDIT' | 'FREE'>('CASH');
  const [charges, setCharges] = useState<string>('100');
  const [driverMobile, setDriverMobile] = useState<string>('');
  const [remarks, setRemarks] = useState<string>('');

  // Weight tracking states
  const [firstWeight, setFirstWeight] = useState<number | null>(null);
  const [manualWeightInput, setManualWeightInput] = useState<string>('');
  const [isManualOverride, setIsManualOverride] = useState<boolean>(false);
  const [pendingTicketId, setPendingTicketId] = useState<string | null>(null);

  const manualInputRef = useRef<HTMLInputElement>(null);
  const isNoDls = Boolean(
    scale.error?.toUpperCase().includes('DLS') ||
    scale.rawText?.toUpperCase().includes('DLS')
  );

  // Cameras & Snapshot triggers
  const [camRefreshTrigger, setCamRefreshTrigger] = useState<number>(0);
  const [activeSnapshots, setActiveSnapshots] = useState<{ cam1?: string; cam2?: string } | null>(null);
  const [showCamSettings, setShowCamSettings] = useState<boolean>(false);
  const [expandedCam, setExpandedCam] = useState<1 | 2 | null>(null);

  // Active Slip Modal
  const [slipModalTicket, setSlipModalTicket] = useState<WeighbridgeTicket | null>(null);

  // Search & Filter in History tab
  const [historySearch, setHistorySearch] = useState<string>('');

  // Clock
  const [clockString, setClockString] = useState<string>('');
  const [dateString, setDateString] = useState<string>('');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setClockString(
        now.toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: true,
        })
      );
      const day = String(now.getDate()).padStart(2, '0');
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const year = now.getFullYear();
      setDateString(`${day}-${month}-${year}`);
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // Fetch next ticket number
  const { data: ticketNumData } = useQuery({
    queryKey: ['weighbridge-next-ticket'],
    queryFn: () => api<{ nextTicketNo: number }>('/weighbridge/tickets/next-number'),
    refetchInterval: 15000,
  });

  const nextTicketNo = ticketNumData?.nextTicketNo ?? 2808;

  // Fetch pending trucks (awaiting second weight)
  const { data: pendingTickets = [], refetch: refetchPending } = useQuery<WeighbridgeTicket[]>({
    queryKey: ['weighbridge-pending'],
    queryFn: () => api<WeighbridgeTicket[]>('/weighbridge/tickets/pending'),
    refetchInterval: 10000,
  });

  // Fetch all tickets for history
  const { data: allTickets = [], refetch: refetchHistory } = useQuery<WeighbridgeTicket[]>({
    queryKey: ['weighbridge-tickets', historySearch],
    queryFn: () =>
      api<WeighbridgeTicket[]>(
        `/weighbridge/tickets?limit=100${historySearch ? `&search=${encodeURIComponent(historySearch)}` : ''}`
      ),
  });

  // Fetch ERP parties for auto-complete suggestions
  const { data: parties = [] } = useQuery<Party[]>({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  // Fetch Company Profile for Print Header
  const { data: companyProfile } = useQuery<CompanyProfile>({
    queryKey: ['company-profile'],
    queryFn: () => api<CompanyProfile>('/company-profile'),
  });

  // Current weight from scale or manual input
  const currentLiveWeight = useMemo(() => {
    if (isManualOverride) {
      const parsed = parseFloat(manualWeightInput);
      return isNaN(parsed) ? 0 : parsed;
    }
    return scale.liveWeight ?? 0;
  }, [isManualOverride, manualWeightInput, scale.liveWeight]);

  // Net weight calculation
  const calculatedNetWeight = useMemo(() => {
    if (tripType === 'SECOND' && firstWeight != null) {
      return Math.abs(currentLiveWeight - firstWeight);
    }
    if (tripType === 'SINGLE') {
      return currentLiveWeight;
    }
    return null;
  }, [tripType, firstWeight, currentLiveWeight]);

  // Daily statistics for KPI cards
  const stats = useMemo(() => {
    const today = new Date().toDateString();
    const todayTickets = allTickets.filter((t) => new Date(t.createdAt).toDateString() === today);
    const totalTodayKg = todayTickets.reduce((sum, t) => sum + (t.netWeightKg || t.firstWeightKg || 0), 0);
    const totalTodayFees = todayTickets.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    return {
      todayCount: todayTickets.length,
      todayTonnes: (totalTodayKg / 1000).toFixed(2),
      pendingCount: pendingTickets.length,
      todayFees: totalTodayFees,
    };
  }, [allTickets, pendingTickets]);

  // Reset form
  const handleResetForm = useCallback(() => {
    setVehicleNumber('');
    setVehicleType('LORRY');
    setTripType('FIRST');
    setPartyName('');
    setMaterial('PAPPU');
    setLoadType('LOAD');
    setBillType('CASH');
    setCharges('100');
    setDriverMobile('');
    setRemarks('');
    setFirstWeight(null);
    setManualWeightInput('');
    setPendingTicketId(null);
    setActiveSnapshots(null);
  }, []);

  // Pick pending truck for 2nd weight
  const handleSelectPendingTruck = useCallback((ticket: WeighbridgeTicket) => {
    setPendingTicketId(ticket.id);
    setVehicleNumber(ticket.vehicleNumber);
    setVehicleType(ticket.vehicleType || 'LORRY');
    setTripType('SECOND');
    setPartyName(ticket.partyName || '');
    setMaterial(ticket.material || 'PAPPU');
    setLoadType(ticket.loadType === 'LOAD' ? 'EMPTY' : 'LOAD');
    setFirstWeight(ticket.firstWeightKg);
    setCharges(ticket.amount != null ? String(ticket.amount) : '100');
    setRemarks(ticket.remarks || '');
    setActiveTab('entry');
    toast.info(`Loaded truck ${ticket.vehicleNumber} (First Weight: ${ticket.firstWeightKg} Kg)`);
  }, []);

  // Save ticket mutation
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!vehicleNumber.trim()) {
        throw new Error('Vehicle number is mandatory');
      }
      if (currentLiveWeight <= 0) {
        throw new Error('Weight must be greater than 0 kg');
      }

      // Freeze snapshots
      const ts = Date.now();
      const snap1 = getCameraSnapshotUrl(1, ts, true);
      const snap2 = getCameraSnapshotUrl(2, ts, true);
      const snapObj = { cam1: snap1, cam2: snap2 };
      setActiveSnapshots(snapObj);

      if (tripType === 'SECOND' && pendingTicketId) {
        // Complete second weighment
        const res = await api<WeighbridgeTicket>(`/weighbridge/tickets/${pendingTicketId}/second-weight`, {
          method: 'PATCH',
          body: JSON.stringify({
            secondWeight: currentLiveWeight,
            loadType,
            remarks,
          }),
        });
        return { ticket: res, snapshots: snapObj };
      } else {
        // Create initial ticket (First weight or Single weight)
        const res = await api<WeighbridgeTicket>('/weighbridge/tickets', {
          method: 'POST',
          body: JSON.stringify({
            vehicleNumber: vehicleNumber.trim().toUpperCase(),
            vehicleType,
            tripType,
            partyName: partyName.trim(),
            material,
            loadType,
            billType,
            amount: parseFloat(charges) || 0,
            firstWeightKg: currentLiveWeight,
            driverMobile: driverMobile.trim(),
            remarks: remarks.trim(),
            operatorName: user?.name || 'OPERATOR',
          }),
        });
        return { ticket: res, snapshots: snapObj };
      }
    },
    onSuccess: ({ ticket, snapshots }) => {
      toast.success(`Ticket #${ticket.ticketNo} saved successfully!`);
      queryClient.invalidateQueries({ queryKey: ['weighbridge-next-ticket'] });
      queryClient.invalidateQueries({ queryKey: ['weighbridge-pending'] });
      queryClient.invalidateQueries({ queryKey: ['weighbridge-tickets'] });

      // Open print slip modal automatically
      setSlipModalTicket(ticket);
      setActiveSnapshots(snapshots);

      // Reset form if completed
      if (tripType !== 'FIRST') {
        handleResetForm();
      } else {
        // Prepare next ticket
        handleResetForm();
      }
    },
    onError: (err) => {
      toast.error(getErrorMessage(err));
    },
  });

  // Global Keyboard Shortcuts (F12 = Save, F4 = Pending, F8 = Override, Esc = Clear)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F12') {
        e.preventDefault();
        saveMutation.mutate();
      } else if (e.key === 'F4') {
        e.preventDefault();
        setActiveTab((prev) => (prev === 'pending' ? 'entry' : 'pending'));
      } else if (e.key === 'F8') {
        e.preventDefault();
        setIsManualOverride((prev) => {
          const next = !prev;
          if (next) {
            setManualWeightInput(String(scale.liveWeight || ''));
            setTimeout(() => manualInputRef.current?.focus(), 60);
          }
          return next;
        });
      } else if (e.key === 'Escape') {
        if (!slipModalTicket) {
          handleResetForm();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveMutation, slipModalTicket, handleResetForm, scale.liveWeight]);

  return (
    <div className="space-y-6 pb-12">
      {/* Editorial Page Header matching ERP */}
      <PageHeader
        icon={Scale}
        title="Weighbridge (Kata)"
        description="Electronic weighbridge recording, digital LED indicator stream, and CP PLUS dual CCTV camera verification."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* Universal Scale Network Hub Status Badge */}
            <div className="flex items-center">
              {scale.isScaleOnline ? (
                <div
                  className="flex items-center gap-2 h-9 px-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-xs font-mono font-medium shadow-sm"
                  title="Live Scale Stream active and broadcasted universally across network"
                >
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                  </span>
                  <span>
                    Scale Hub: Online ({scale.serverPort || 'COM4'}{scale.connectionMode === 'LOCAL_USB' ? ' · USB' : ' · NET'})
                  </span>
                </div>
              ) : (
                <div
                  className="flex items-center gap-2 h-9 px-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 text-xs font-mono font-medium shadow-sm"
                  title="Scale not detected on USB or network"
                >
                  <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
                  <span>Scale Hub: Offline ({scale.serverPort || 'COM4'} not detected)</span>
                </div>
              )}
            </div>

            {/* Pending Trucks Counter Button */}
            <Button
              variant={activeTab === 'pending' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setActiveTab('pending')}
              className="h-9 gap-2 font-medium"
            >
              <Truck className="h-4 w-4" />
              <span>Pending Trucks</span>
              {pendingTickets.length > 0 && (
                <span className="ml-1 px-1.5 py-0.2 text-[10px] font-bold rounded-full bg-amber-500 text-stone-950">
                  {pendingTickets.length}
                </span>
              )}
            </Button>
          </div>
        }
      />

      {/* KPI Stat Cards matching RVP ERP */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Today's Tickets"
          value={stats.todayCount}
          icon={FileText}
          tone="amber"
          hint="Total tickets generated today"
        />
        <StatCard
          label="Today's Weighment"
          value={`${stats.todayTonnes} MT`}
          icon={Scale}
          tone="forest"
          hint="Net cargo weighed today"
        />
        <StatCard
          label="Pending 2nd Weigh"
          value={stats.pendingCount}
          icon={Truck}
          tone="clay"
          hint="Trucks awaiting gross/tare"
        />
        <StatCard
          label="Kata Fees Collected"
          value={`₹ ${stats.todayFees.toLocaleString('en-IN')}`}
          icon={CreditCard}
          tone="gold"
          hint="Today's weighment charges"
        />
      </div>

      {/* Navigation Tabs */}
      <div className="flex items-center gap-1 border-b border-border pb-1">
        <button
          type="button"
          onClick={() => setActiveTab('entry')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition-all',
            activeTab === 'entry'
              ? 'bg-primary/10 text-primary border border-primary/20 shadow-xs'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Scale className="h-4 w-4" />
          <span>Weighment Entry Screen (F2)</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('pending')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition-all',
            activeTab === 'pending'
              ? 'bg-primary/10 text-primary border border-primary/20 shadow-xs'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Truck className="h-4 w-4" />
          <span>Pending 2nd Weight Trucks (F4)</span>
          {pendingTickets.length > 0 && (
            <span className="px-1.5 py-0.2 text-[10px] font-bold rounded-full bg-amber-500/20 text-amber-700 dark:text-amber-400">
              {pendingTickets.length}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('history')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition-all',
            activeTab === 'history'
              ? 'bg-primary/10 text-primary border border-primary/20 shadow-xs'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Clock className="h-4 w-4" />
          <span>Ticket Register & Reprint</span>
        </button>
      </div>

      {/* ─────────────────────────────────────────────────────────────
          TAB 1: WEIGHMENT TRANSACTION ENTRY SCREEN
         ───────────────────────────────────────────────────────────── */}
      {activeTab === 'entry' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Main Transaction Entry Form (Left 7 Cols) */}
          <Card className="lg:col-span-7 border-border shadow-sm">
            <CardHeader className="pb-4 border-b border-border/60">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-mono font-bold text-sm">
                    #{nextTicketNo}
                  </div>
                  <div>
                    <CardTitle className="text-base font-bold text-foreground">
                      Transaction Entry Screen
                    </CardTitle>
                    <CardDescription className="text-xs">
                      {pendingTicketId
                        ? `Completing Second Weight for Ticket #${nextTicketNo}`
                        : 'Capture vehicle weight, customer, and cargo details'}
                    </CardDescription>
                  </div>
                </div>

                <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground bg-muted/40 px-2.5 py-1 rounded-lg border border-border/50">
                  <Calendar className="h-3.5 w-3.5 text-primary" />
                  <span>{dateString}</span>
                  <span className="text-border">|</span>
                  <Clock className="h-3.5 w-3.5 text-primary" />
                  <span className="font-semibold text-foreground">{clockString}</span>
                </div>
              </div>
            </CardHeader>

            <CardContent className="pt-5 space-y-5">
              {/* Form Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Vehicle Number */}
                <div className="space-y-1.5 sm:col-span-2">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <Truck className="h-3.5 w-3.5 text-primary" />
                      Vehicle Number *
                    </span>
                    <span className="text-[10px] font-normal text-muted-foreground">e.g. KA01AS1009 / AP39V1234</span>
                  </Label>
                  <Input
                    value={vehicleNumber}
                    onChange={(e) => setVehicleNumber(e.target.value.toUpperCase())}
                    placeholder="ENTER VEHICLE NUMBER"
                    className="font-mono text-base font-bold tracking-wider uppercase h-11 bg-background"
                    autoFocus
                  />
                </div>

                {/* Vehicle Type */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Vehicle Type
                  </Label>
                  <Select value={vehicleType} onValueChange={setVehicleType}>
                    <SelectTrigger className="h-10 bg-background">
                      <SelectValue placeholder="Select vehicle type" />
                    </SelectTrigger>
                    <SelectContent>
                      {VEHICLE_TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Trip Type */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Trip Type
                  </Label>
                  <Select
                    value={tripType}
                    onValueChange={(val: any) => {
                      setTripType(val);
                      if (val === 'FIRST') setFirstWeight(null);
                    }}
                  >
                    <SelectTrigger className="h-10 bg-background font-medium">
                      <SelectValue placeholder="Select trip type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="FIRST">1st Weight (Gross / Inward)</SelectItem>
                      <SelectItem value="SECOND">2nd Weight (Tare / Net Final)</SelectItem>
                      <SelectItem value="SINGLE">Single Direct Weight</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Party Name (with autocomplete datalist) */}
                <div className="space-y-1.5 sm:col-span-2">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <User className="h-3.5 w-3.5 text-primary" />
                      Customer / Party Name
                    </span>
                    <span className="text-[10px] font-normal text-muted-foreground">Supplier or Buyer name</span>
                  </Label>
                  <div className="relative">
                    <Input
                      list="party-suggestions"
                      value={partyName}
                      onChange={(e) => setPartyName(e.target.value)}
                      placeholder="Type customer or supplier name (e.g. SOHAM AGRO)"
                      className="h-10 bg-background uppercase"
                    />
                    <datalist id="party-suggestions">
                      {parties.map((p) => (
                        <option key={p.id} value={p.name} />
                      ))}
                    </datalist>
                  </div>
                </div>

                {/* Material Selection */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Package className="h-3.5 w-3.5 text-primary" />
                    Material / Commodity
                  </Label>
                  <Select value={material} onValueChange={setMaterial}>
                    <SelectTrigger className="h-10 bg-background font-medium">
                      <SelectValue placeholder="Select material" />
                    </SelectTrigger>
                    <SelectContent>
                      {MATERIALS.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Load Type */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Load Condition
                  </Label>
                  <Select value={loadType} onValueChange={(v: any) => setLoadType(v)}>
                    <SelectTrigger className="h-10 bg-background font-medium">
                      <SelectValue placeholder="Select condition" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="LOAD">LOAD (Loaded Consignment)</SelectItem>
                      <SelectItem value="EMPTY">EMPTY (Empty Tare Truck)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Kata Fee (Charges) */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Tag className="h-3.5 w-3.5 text-primary" />
                    Weighment Fee (₹)
                  </Label>
                  <Input
                    type="number"
                    value={charges}
                    onChange={(e) => setCharges(e.target.value)}
                    placeholder="100"
                    className="h-10 bg-background font-mono font-bold"
                  />
                </div>

                {/* Driver Mobile */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Phone className="h-3.5 w-3.5 text-primary" />
                    Driver Mobile No
                  </Label>
                  <Input
                    type="tel"
                    value={driverMobile}
                    onChange={(e) => setDriverMobile(e.target.value)}
                    placeholder="10-digit mobile number"
                    className="h-10 bg-background font-mono"
                    maxLength={10}
                  />
                </div>

                {/* Remarks */}
                <div className="space-y-1.5 sm:col-span-2">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Remarks (Optional)
                  </Label>
                  <Input
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    placeholder="e.g. Delivery directly to Warehouse #2"
                    className="h-10 bg-background"
                  />
                </div>
              </div>

              {/* Action Buttons Bar */}
              <div className="pt-4 border-t border-border flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleResetForm}
                    className="gap-1.5 text-xs h-10"
                  >
                    <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
                    Clear (Esc)
                  </Button>

                  {pendingTickets.length > 0 && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setActiveTab('pending')}
                      className="gap-1.5 text-xs h-10"
                    >
                      <Truck className="h-3.5 w-3.5" />
                      Pick Pending ({pendingTickets.length})
                    </Button>
                  )}
                </div>

                <Button
                  type="button"
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending || currentLiveWeight <= 0 || !vehicleNumber.trim()}
                  className="h-11 px-6 font-bold gap-2 text-sm bg-primary hover:bg-primary/90 text-primary-foreground shadow-md transition-transform active:scale-98"
                >
                  <Printer className="h-4 w-4" />
                  <span>Save Ticket & Print (F12)</span>
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Right Column (5 Cols): Scale Readout & CP PLUS Live Cameras */}
          <div className="lg:col-span-5 space-y-6">
            {/* 1. Digital Scale Instrument Panel */}
            <div className="relative rounded-2xl bg-gradient-to-b from-stone-900 to-stone-950 border border-stone-800 text-stone-100 p-5 shadow-lg overflow-hidden">
              {/* Radial ambient glow */}
              <div className="absolute -top-12 -right-12 w-36 h-36 bg-amber-500/10 rounded-full blur-2xl pointer-events-none" />

              {/* Hardware Fault / NO DLS Alert Banner */}
              {isNoDls && !isManualOverride && (
                <div className="mb-3.5 p-3 rounded-xl bg-red-500/15 border border-red-500/40 text-red-200 text-xs flex items-start justify-between gap-3 animate-pulse">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-bold text-red-200">Scale Hardware Alert: "NO DLS" (Load Cell Signal Lost)</div>
                      <p className="text-[11px] text-red-300/85 mt-0.5 leading-relaxed">
                        Power fluctuated or load cells are initializing. In your old software it showed 0; here you can manually type the weight from the physical display.
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => {
                      setIsManualOverride(true);
                      setTimeout(() => manualInputRef.current?.focus(), 60);
                    }}
                    className="h-7 text-xs bg-red-600 hover:bg-red-700 text-white shrink-0 gap-1.5 font-bold shadow-xs"
                  >
                    <Pencil className="h-3 w-3" />
                    Override (F8)
                  </Button>
                </div>
              )}

              {/* Top readout status row */}
              <div className="flex items-center justify-between mb-3 text-xs font-mono">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className={cn(
                      'animate-ping absolute inline-flex h-full w-full rounded-full opacity-75',
                      isManualOverride ? 'bg-amber-400' : scale.isStable ? 'bg-emerald-400' : 'bg-amber-400'
                    )} />
                    <span className={cn(
                      'relative inline-flex rounded-full h-2.5 w-2.5',
                      isManualOverride ? 'bg-amber-500' : scale.isStable ? 'bg-emerald-500' : 'bg-amber-500'
                    )} />
                  </span>
                  <span className="font-bold tracking-wider text-stone-300">
                    {isManualOverride
                      ? 'MANUAL OVERRIDE'
                      : scale.isScaleOnline
                        ? `SCALE INDICATOR (${scale.serverPort || 'COM4'}${scale.connectionMode === 'LOCAL_USB' ? ' · USB' : ''})`
                        : `SCALE INDICATOR (${scale.serverPort || 'COM4'} OFFLINE)`}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {isManualOverride ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setIsManualOverride(false);
                        setManualWeightInput('');
                      }}
                      className="h-6 px-2 text-[10px] font-mono text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 gap-1"
                    >
                      <RotateCcw className="h-2.5 w-2.5" />
                      Resume COM4 Sync
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setIsManualOverride(true);
                        setManualWeightInput(String(currentLiveWeight || ''));
                        setTimeout(() => manualInputRef.current?.focus(), 60);
                      }}
                      className="h-6 px-2 text-[10px] font-mono text-stone-400 hover:text-stone-200 bg-stone-800/80 border border-stone-700/60 gap-1"
                      title="Manually override weight displayed in this box (F8)"
                    >
                      <Pencil className="h-2.5 w-2.5" />
                      Override (F8)
                    </Button>
                  )}

                  {!isManualOverride && (
                    <span className={cn(
                      'px-2 py-0.5 rounded text-[10px] font-bold tracking-wider',
                      isNoDls
                        ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                        : !scale.isScaleOnline
                          ? 'bg-stone-800 text-stone-400 border border-stone-700'
                          : scale.isStable
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                    )}>
                      {isNoDls
                        ? 'NO DLS'
                        : !scale.isScaleOnline
                          ? 'OFFLINE'
                          : scale.isStable
                            ? 'STABLE'
                            : 'IN MOTION'}
                    </span>
                  )}
                </div>
              </div>

              {/* Large Digital Weight Display */}
              {isNoDls && !isManualOverride ? (
                <div
                  className="py-3 text-center select-none cursor-pointer group"
                  onClick={() => {
                    setIsManualOverride(true);
                    setTimeout(() => manualInputRef.current?.focus(), 60);
                  }}
                  title="Click to type weight manually (F8)"
                >
                  <span className="font-mono font-black text-5xl text-red-500 tracking-tight drop-shadow-[0_0_20px_rgba(239,68,68,0.4)]">
                    NO DLS
                  </span>
                  <div className="text-red-400/90 font-mono text-xs mt-1.5">
                    Load Cell Signal Lost · Click here to type weight manually (F8)
                  </div>
                </div>
              ) : isManualOverride ? (
                <div className="py-2 text-center select-none">
                  <div className="flex items-baseline justify-center gap-2">
                    <input
                      ref={manualInputRef}
                      type="number"
                      value={manualWeightInput}
                      onChange={(e) => setManualWeightInput(e.target.value)}
                      placeholder="0"
                      className="w-56 font-mono font-black text-5xl text-center text-amber-400 bg-stone-900 border-2 border-amber-500 rounded-xl px-2 py-1 outline-none shadow-inner drop-shadow-[0_0_15px_rgba(251,191,36,0.3)]"
                      autoFocus
                    />
                    <span className="font-mono font-bold text-xl text-stone-400">KG</span>
                  </div>
                  <div className="text-amber-400/90 font-mono text-xs mt-1">
                    ✏️ Manual Override Active (Press F8 or click 'Resume COM4 Sync' to exit)
                  </div>
                </div>
              ) : (
                <div
                  className="py-2 text-center select-none group cursor-pointer"
                  onClick={() => {
                    setIsManualOverride(true);
                    setManualWeightInput(String(currentLiveWeight || ''));
                    setTimeout(() => manualInputRef.current?.focus(), 60);
                  }}
                  title="Click to manually override weight displayed in this box (F8)"
                >
                  <div className="flex items-baseline justify-center gap-2">
                    <span className="font-mono font-black text-6xl text-amber-400 tracking-tight drop-shadow-[0_0_20px_rgba(251,191,36,0.3)] transition-transform group-hover:scale-102">
                      {currentLiveWeight.toLocaleString('en-IN')}
                    </span>
                    <span className="font-mono font-bold text-xl text-stone-400">
                      KG
                    </span>
                  </div>

                  {/* Sub-readout in metric tonnes */}
                  <div className="text-stone-400 font-mono text-xs mt-1 flex items-center justify-center gap-2">
                    <span>≈ {(currentLiveWeight / 1000).toFixed(3)} Metric Tonnes (MT)</span>
                    <span className="text-stone-500 text-[10px]">· Click to override (F8)</span>
                  </div>

                  {!scale.isScaleOnline && (
                    <div className="text-amber-400/90 font-mono text-[11px] mt-1.5 flex items-center justify-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                      <span>USB-RS232 Cable not detected on {scale.serverPort || 'COM4'} · Click here or press F8 to enter manually</span>
                    </div>
                  )}
                </div>
              )}

              {/* 3 Weight Breakdown Pills */}
              <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-stone-800 text-center text-xs font-mono">
                <div className="bg-stone-900/80 p-2 rounded-lg border border-stone-800">
                  <span className="block text-[10px] text-stone-400 font-sans">1st Weight</span>
                  <span className="font-bold text-stone-200">
                    {firstWeight != null ? `${firstWeight} Kg` : '-'}
                  </span>
                </div>
                <div className="bg-stone-900/80 p-2 rounded-lg border border-stone-800">
                  <span className="block text-[10px] text-stone-400 font-sans">2nd Weight</span>
                  <span className="font-bold text-stone-200">
                    {tripType === 'SECOND' ? `${currentLiveWeight} Kg` : '-'}
                  </span>
                </div>
                <div className="bg-stone-900/80 p-2 rounded-lg border border-stone-800">
                  <span className="block text-[10px] text-amber-400 font-sans font-semibold">Net Weight</span>
                  <span className="font-bold text-amber-400">
                    {calculatedNetWeight != null ? `${calculatedNetWeight} Kg` : '-'}
                  </span>
                </div>
              </div>
            </div>

            {/* 2. CP PLUS Live Dual CCTV Cameras */}
            <Card className="border-border shadow-sm">
              <CardHeader className="pb-3 border-b border-border/60">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Video className="h-4 w-4 text-primary" />
                    <CardTitle className="text-sm font-bold text-foreground">
                      CP PLUS Live Dual Cameras
                    </CardTitle>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      Live Feed
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-foreground"
                      onClick={() => setCamRefreshTrigger(Date.now())}
                      title="Manual Camera Refresh"
                    >
                      <RefreshCw className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowCamSettings(true)}
                      title="CCTV & RTSP Camera Configuration"
                    >
                      <Settings className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="pt-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <CctvLiveBox
                    camNumber={1}
                    cameraIp="192.168.1.101"
                    label="CAM 1: ENTRY"
                    currentTime={clockString}
                    refreshTrigger={camRefreshTrigger}
                    onExpand={(cam) => setExpandedCam(cam)}
                  />
                  <CctvLiveBox
                    camNumber={2}
                    cameraIp="192.168.1.102"
                    label="CAM 2: EXIT"
                    currentTime={clockString}
                    refreshTrigger={camRefreshTrigger}
                    onExpand={(cam) => setExpandedCam(cam)}
                  />
                </div>
                <p className="text-[11px] text-muted-foreground text-center font-mono">
                  Click either camera for Full View • Photos are automatically stamped on Save (F12)
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          TAB 2: PENDING TRUCKS (Awaiting Second Weight)
         ───────────────────────────────────────────────────────────── */}
      {activeTab === 'pending' && (
        <Card className="border-border shadow-sm">
          <CardHeader className="border-b border-border/60">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle className="text-base font-bold text-foreground">
                  Pending Trucks Awaiting Second Weighment
                </CardTitle>
                <CardDescription className="text-xs">
                  Trucks that completed initial weighment (Gross or Tare) and are currently in the yard.
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetchPending()}
                className="h-8 gap-1.5 text-xs"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh List
              </Button>
            </div>
          </CardHeader>

          <CardContent className="p-0">
            {pendingTickets.length === 0 ? (
              <div className="p-12 text-center">
                <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto mb-2" />
                <h3 className="font-semibold text-sm text-foreground">All Trucks Cleared</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  No trucks are currently awaiting second weighment in the yard.
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">Ticket #</TableHead>
                    <TableHead>Time</TableHead>
                    <TableHead>Vehicle No</TableHead>
                    <TableHead>Customer / Party</TableHead>
                    <TableHead>Material</TableHead>
                    <TableHead>Condition</TableHead>
                    <TableHead className="text-right">1st Weight</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pendingTickets.map((t) => (
                    <TableRow key={t.id} className="hover:bg-muted/30">
                      <TableCell className="font-mono font-bold text-primary">
                        #{t.ticketNo}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(t.createdAt).toLocaleTimeString('en-IN', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </TableCell>
                      <TableCell className="font-mono font-bold text-foreground">
                        {t.vehicleNumber}
                      </TableCell>
                      <TableCell className="font-medium text-xs">
                        {t.partyName || '-'}
                      </TableCell>
                      <TableCell className="text-xs">
                        <Badge variant="outline" className="font-normal text-[10px]">
                          {t.material || 'OTHER'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        <Badge
                          variant={t.loadType === 'LOAD' ? 'default' : 'secondary'}
                          className="text-[10px]"
                        >
                          {t.loadType}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono font-bold text-xs">
                        {t.firstWeightKg != null ? `${t.firstWeightKg.toLocaleString('en-IN')} Kg` : '-'}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          onClick={() => handleSelectPendingTruck(t)}
                          className="h-8 gap-1 text-xs font-semibold"
                        >
                          <Scale className="h-3.5 w-3.5" />
                          Complete 2nd Weight
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {/* ─────────────────────────────────────────────────────────────
          TAB 3: TICKET REGISTER & HISTORY
         ───────────────────────────────────────────────────────────── */}
      {activeTab === 'history' && (
        <Card className="border-border shadow-sm">
          <CardHeader className="border-b border-border/60">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle className="text-base font-bold text-foreground">
                  Weighbridge Ticket Register
                </CardTitle>
                <CardDescription className="text-xs">
                  Search past tickets, view camera snapshots, and reprint weighment certificates.
                </CardDescription>
              </div>

              <div className="flex items-center gap-2">
                <div className="relative w-64">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={historySearch}
                    onChange={(e) => setHistorySearch(e.target.value)}
                    placeholder="Search vehicle, ticket, party..."
                    className="h-9 pl-9 text-xs bg-background"
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refetchHistory()}
                  className="h-9 gap-1 text-xs"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Refresh
                </Button>
              </div>
            </div>
          </CardHeader>

          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Ticket #</TableHead>
                  <TableHead>Date & Time</TableHead>
                  <TableHead>Vehicle No</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Material</TableHead>
                  <TableHead className="text-right">1st (Kg)</TableHead>
                  <TableHead className="text-right">2nd (Kg)</TableHead>
                  <TableHead className="text-right">Net Weight</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allTickets.map((t) => (
                  <TableRow key={t.id} className="hover:bg-muted/30">
                    <TableCell className="font-mono font-bold text-primary">
                      #{t.ticketNo}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {shortDate(t.createdAt)}{' '}
                      <span className="text-[10px]">
                        {new Date(t.createdAt).toLocaleTimeString('en-IN', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono font-bold text-foreground">
                      {t.vehicleNumber}
                    </TableCell>
                    <TableCell className="font-medium text-xs truncate max-w-[140px]">
                      {t.partyName || '-'}
                    </TableCell>
                    <TableCell className="text-xs">
                      <Badge variant="outline" className="text-[10px] font-normal">
                        {t.material || 'OTHER'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {t.firstWeightKg?.toLocaleString('en-IN') || '-'}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {t.secondWeightKg?.toLocaleString('en-IN') || '-'}
                    </TableCell>
                    <TableCell className="text-right font-mono font-bold text-xs text-emerald-600 dark:text-emerald-400">
                      {t.netWeightKg != null
                        ? `${t.netWeightKg.toLocaleString('en-IN')} Kg`
                        : `${t.firstWeightKg?.toLocaleString('en-IN') || 0} Kg`}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={t.status === 'COMPLETED' ? 'default' : 'secondary'}
                        className="text-[10px]"
                      >
                        {t.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSlipModalTicket(t);
                          setActiveSnapshots({
                            cam1: getCameraSnapshotUrl(1, Date.now(), true),
                            cam2: getCameraSnapshotUrl(2, Date.now(), true),
                          });
                        }}
                        className="h-7 px-2 text-xs gap-1"
                        title="Print Weighment Certificate Slip"
                      >
                        <Printer className="h-3.5 w-3.5 text-primary" />
                        Slip
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Official Printable Weighbridge Slip Modal */}
      <WeighbridgeSlipModal
        ticket={slipModalTicket}
        companyProfile={companyProfile}
        snapshots={activeSnapshots}
        onClose={() => setSlipModalTicket(null)}
      />

      {/* Full Live View Camera Dialog */}
      <CctvFullViewDialog
        camNumber={expandedCam}
        onClose={() => setExpandedCam(null)}
        onSelectCam={(num) => setExpandedCam(num)}
        currentTime={clockString}
      />

      {/* CCTV & RTSP Network Status & Configuration Dialog */}
      <Dialog open={showCamSettings} onOpenChange={setShowCamSettings}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <Video className="h-5 w-5 text-primary" />
              <DialogTitle>CP PLUS Dual Camera & RTSP Network Status</DialogTitle>
            </div>
            <DialogDescription>
              Configured for Kata Cabin weighbridge operations. Streams high-res video via RTSP over local Ethernet.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 pt-2">
            <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-800 dark:text-emerald-300 flex items-start gap-2.5">
              <ShieldCheck className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold">CCTV Background Bridge Active:</span> Local frames from 192.168.1.101 & 192.168.1.102 are captured via low-latency RTSP FFmpeg pipes at 25 FPS and continuously relayed to this PC & universal cloud server.
              </div>
            </div>

            <div className="space-y-3">
              {/* Cam 1 */}
              <div className="p-3 rounded-lg border border-border bg-card/60 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                    CAM 1: ENTRY (192.168.1.101)
                  </span>
                  <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/30">
                    Online • 25 FPS
                  </Badge>
                </div>
                <div className="space-y-1">
                  <div className="text-[11px] font-mono text-muted-foreground">RTSP Substream (Live Preview):</div>
                  <div className="p-1.5 rounded bg-muted/70 text-[10px] font-mono select-all break-all">
                    rtsp://admin:admin%40123@192.168.1.101:554/cam/realmonitor?channel=1&subtype=1
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-[11px] font-mono text-muted-foreground">RTSP Mainstream (HD Ticket Photo):</div>
                  <div className="p-1.5 rounded bg-muted/70 text-[10px] font-mono select-all break-all">
                    rtsp://admin:admin%40123@192.168.1.101:554/cam/realmonitor?channel=1&subtype=0
                  </div>
                </div>
              </div>

              {/* Cam 2 */}
              <div className="p-3 rounded-lg border border-border bg-card/60 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                    CAM 2: EXIT (192.168.1.102)
                  </span>
                  <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/30">
                    Online • 25 FPS
                  </Badge>
                </div>
                <div className="space-y-1">
                  <div className="text-[11px] font-mono text-muted-foreground">RTSP Substream (Live Preview):</div>
                  <div className="p-1.5 rounded bg-muted/70 text-[10px] font-mono select-all break-all">
                    rtsp://admin:admin%40123@192.168.1.102:554/cam/realmonitor?channel=1&subtype=1
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-[11px] font-mono text-muted-foreground">RTSP Mainstream (HD Ticket Photo):</div>
                  <div className="p-1.5 rounded bg-muted/70 text-[10px] font-mono select-all break-all">
                    rtsp://admin:admin%40123@192.168.1.102:554/cam/realmonitor?channel=1&subtype=0
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <span className="text-[11px] text-muted-foreground">
                Auto-starts on Kata Cabin startup via Windows service.
              </span>
              <Button
                size="sm"
                onClick={() => {
                  setCamRefreshTrigger(Date.now());
                  toast.success('Triggered camera snapshot refresh');
                }}
                className="gap-1 text-xs"
              >
                <RefreshCw className="h-3 w-3" />
                Test & Refresh
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
