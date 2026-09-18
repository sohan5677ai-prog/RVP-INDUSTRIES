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
  Download,
  Cloud,
  CloudOff,
  IndianRupee,
  Cable,
  Trash2,
  Banknote,
  MessageCircle,
  BadgeCheck,
  Warehouse,
  ArrowRight,
} from 'lucide-react';
import { api, getErrorMessage, getScaleApiUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useScale } from '@/lib/scaleContext';
import type { Party, CompanyProfile, WeighbridgeTicket } from '@/lib/types';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
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
import { calcKataFee, isVehicleExempt } from '@/lib/calc';
import WeighbridgeSlipModal, { triggerDirectPrint, formatTicketNo } from '@/components/WeighbridgeSlipModal';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import './WeighbridgeScreen.css';

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

const STORAGE_LOCATIONS = [
  { value: 'PGR COLD', label: 'PGR COLD (Rampalli)' },
  { value: 'Murugan', label: 'Murugan' },
  { value: 'KNM Multi', label: 'KNM Multi' },
];

function transferDirectionForMaterial(material: string): 'STORAGE_TO_RVP' | 'RVP_TO_STORAGE' {
  return material.trim().toUpperCase() === 'BLACK SEED' ? 'STORAGE_TO_RVP' : 'RVP_TO_STORAGE';
}

function ticketTransferRoute(ticket: WeighbridgeTicket): string {
  if (!ticket.isStorageTransfer || !ticket.storageLocation) return '';
  return ticket.transferDirection === 'STORAGE_TO_RVP'
    ? `${ticket.storageLocation} → RVP`
    : `RVP → ${ticket.storageLocation}`;
}

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

const TRIP_TYPE_OPTIONS = [
  { value: 'FIRST', label: '1st Weight (Gross / Inward)' },
  { value: 'SECOND', label: '2nd Weight (Tare / Net Final)' },
  { value: 'SINGLE', label: 'Single Direct Weight' },
];

const LOAD_TYPE_OPTIONS = [
  { value: 'LOAD', label: 'LOAD (Loaded Consignment)' },
  { value: 'EMPTY', label: 'EMPTY (Empty Tare Truck)' },
];

const BILL_TYPE_OPTIONS = [
  { value: 'CASH', label: 'Cash' },
  { value: 'CREDIT', label: 'Credit / Due' },
  { value: 'FREE', label: 'No Charge' },
];

type EditTicketDraft = {
  id: string;
  vehicleNumber: string;
  vehicleType: string;
  tripType: string;
  partyName: string;
  partyMobile: string;
  material: string;
  loadType: string;
  billType: string;
  firstWeightKg: string;
  secondWeightKg: string;
  remarks: string;
};

const TICKET_EXPORT_COLUMNS: ExportColumn<WeighbridgeTicket>[] = [
  { header: 'Ticket No', value: (t) => formatTicketNo(t.ticketNo), numFmt: '@', align: 'right' },
  { header: 'Date', value: (t) => shortDate(t.createdAt) },
  { header: 'Time', value: (t) => new Date(t.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) },
  { header: 'Vehicle No', value: (t) => t.vehicleNumber },
  { header: 'Party / Route', value: (t) => ticketTransferRoute(t) || t.partyName || '' },
  { header: 'Movement', value: (t) => t.isStorageTransfer ? 'STORAGE TRANSFER' : 'PARTY WEIGHMENT' },
  { header: 'Storage', value: (t) => t.storageLocation ?? '' },
  { header: 'Material', value: (t) => t.material ?? '' },
  { header: 'First Weight (kg)', value: (t) => t.firstWeightKg ?? '', excel: (t) => t.firstWeightKg, numFmt: '#,##0', align: 'right' },
  { header: 'Second Weight (kg)', value: (t) => t.secondWeightKg ?? '', excel: (t) => t.secondWeightKg, numFmt: '#,##0', align: 'right' },
  { header: 'Net Weight (kg)', value: (t) => t.netWeightKg ?? '', excel: (t) => t.netWeightKg, numFmt: '#,##0', align: 'right' },
  { header: 'Charge', value: (t) => Number(t.amount || 0), numFmt: '#,##0.00', align: 'right' },
  { header: 'Status', value: (t) => t.status },
  { header: 'Operator', value: (t) => t.operatorName ?? '' },
  { header: 'Remarks', value: (t) => t.remarks ?? '' },
];

export function getCameraSnapshotUrl(camNumber: 1 | 2, ts: number = Date.now()): string {
  // Always route through the cloud server so the Kata is accessible from anywhere
  return getScaleApiUrl(`/weighbridge/cctv/snapshot?cam=${camNumber}&t=${ts}`);
}

export async function captureCamSnapshotBase64(camNumber: 1 | 2): Promise<string | null> {
  const url = getCameraSnapshotUrl(camNumber, Date.now());
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (resp.ok) {
      const blob = await resp.blob();
      if (blob && blob.size > 500) {
        return await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
    }
  } catch {}
  return null;
}

interface CctvLiveBoxProps {
  camNumber: 1 | 2;
  cameraIp: string;
  label: string;
  currentTime: string;
  refreshTrigger?: number;
  onStatusChange?: (online: boolean, isLocal: boolean) => void;
  onExpand?: (camNumber: 1 | 2) => void;
  relayStatus?: CctvCameraStatus;
}

interface CctvCameraStatus {
  cam: number;
  online: boolean;
  source: 'CLOUD_RELAY' | 'SERVER_LAN' | 'OFFLINE';
  relayOnline: boolean;
  lastSeen: number | null;
  ageMs: number | null;
  sizeBytes: number;
}

interface CctvStatusResponse {
  checkedAt: number;
  cam1: CctvCameraStatus;
  cam2: CctvCameraStatus;
}

function CctvLiveBox({ camNumber, cameraIp, label, currentTime, refreshTrigger, onStatusChange, onExpand, relayStatus }: CctvLiveBoxProps) {
  const [frameUrl, setFrameUrl] = useState<string>(() =>
    getCameraSnapshotUrl(camNumber, Date.now())
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
        setFrameUrl(getCameraSnapshotUrl(camNumber, Date.now()));
      }
    }, delayMs);
  }, [camNumber]);

  useEffect(() => {
    if (refreshTrigger) {
      setFrameUrl(getCameraSnapshotUrl(camNumber, Date.now()));
    }
  }, [refreshTrigger, camNumber]);

  return (
    <div 
      onClick={() => onExpand?.(camNumber)}
      title="Click to open Full Live View"
      className="kata-camera-frame relative flex h-48 cursor-pointer items-center justify-center overflow-hidden rounded-xl bg-stone-950 group"
    >
      <img
        src={frameUrl}
        alt={`Camera ${camNumber} - ${label}`}
        onLoad={() => {
          errCountRef.current = 0;
          setIsOnline(true);
          onStatusChange?.(true, false);
          triggerNextFrame(850);
        }}
        onError={() => {
          errCountRef.current += 1;
          if (errCountRef.current >= 8) {
            setIsOnline(false);
            onStatusChange?.(false, false);
          }
          triggerNextFrame(1200);
        }}
        className={cn('w-full h-full object-cover transition-opacity duration-300', !isOnline && 'opacity-40')}
      />

      {!isOnline && (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-3 text-center bg-stone-950/80 backdrop-blur-xs text-stone-400">
          <Video className="h-6 w-6 text-rose-500/70 mb-1.5 animate-pulse" />
          <span className="font-semibold text-xs text-stone-200">{label}</span>
          <span className="text-[10px] text-stone-400 font-mono mt-0.5">{cameraIp}</span>
          <span className="text-[10px] text-amber-400 font-mono mt-1">
            {relayStatus?.lastSeen == null ? 'Cabin relay has not sent a frame' : 'Reconnecting to camera relay...'}
          </span>
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
          relayStatus?.online ? "bg-blue-950/80 text-blue-300 border-blue-800/60" : "bg-rose-950/80 text-rose-300 border-rose-800/60"
        )}>
          {relayStatus?.online
            ? `CLOUD · ${Math.max(0, Math.round((relayStatus.ageMs || 0) / 1000))}s`
            : 'CLOUD OFFLINE'}
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
  const [frameUrl, setFrameUrl] = useState<string>('');
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
    if (!mountedRef.current || !camNumber) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (mountedRef.current && camNumber) {
        setFrameUrl(getCameraSnapshotUrl(camNumber, Date.now()));
      }
    }, delayMs);
  }, [camNumber]);

  // Whenever camNumber changes, load frame immediately
  useEffect(() => {
    if (camNumber) {
      errCountRef.current = 0;
      setIsOnline(true);
      setFrameUrl(getCameraSnapshotUrl(camNumber, Date.now()));
    }
  }, [camNumber]);

  if (!camNumber) return null;

  const cameraIp = camNumber === 1 ? '192.168.1.101' : '192.168.1.102';
  const label = camNumber === 1 ? 'CAM 1: ENTRY' : 'CAM 2: EXIT';
  const handleDownloadSnapshot = () => {
    const a = document.createElement('a');
    a.href = frameUrl || getCameraSnapshotUrl(camNumber, Date.now());
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
                  Real-time cloud-relayed CCTV camera feed
                </DialogDescription>
              </div>
            </div>

            {/* Quick Cam 1 / Cam 2 switcher buttons */}
            <div className="flex items-center bg-stone-950 border border-stone-800 rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => onSelectCam(1)}
                className={cn(
                  "px-3 py-1 text-xs font-semibold rounded-md transition-all cursor-pointer",
                  camNumber === 1 
                    ? "bg-amber-500 text-stone-950 shadow-xs" 
                    : "text-stone-400 hover:text-stone-200"
                )}
              >
                CAM 1: ENTRY
              </button>
              <button
                type="button"
                onClick={() => onSelectCam(2)}
                className={cn(
                  "px-3 py-1 text-xs font-semibold rounded-md transition-all cursor-pointer",
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
          {frameUrl ? (
            <img
              key={`${camNumber}-cloud`}
              src={frameUrl}
              alt={label}
              onLoad={() => {
                errCountRef.current = 0;
                setIsOnline(true);
                triggerNextFrame(850);
              }}
              onError={() => {
                errCountRef.current += 1;
                if (errCountRef.current >= 8) {
                  setIsOnline(false);
                }
                triggerNextFrame(1200);
              }}
              className={cn("w-full h-full object-contain transition-opacity duration-200", !isOnline && "opacity-40")}
            />
          ) : (
            <div className="flex flex-col items-center justify-center text-stone-400 gap-2">
              <RefreshCw className="h-6 w-6 animate-spin text-amber-400" />
              <span className="text-xs font-mono">Loading stream...</span>
            </div>
          )}

          {!isOnline && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-4 text-center bg-stone-950/85 backdrop-blur-xs text-stone-400">
              <Video className="h-8 w-8 text-rose-500/70 mb-2 animate-pulse" />
              <span className="font-semibold text-sm text-stone-200">{label}</span>
              <span className="text-xs text-stone-400 font-mono mt-0.5">{cameraIp}</span>
              <span className="text-xs text-amber-400 font-mono mt-1.5">Connecting to camera feed...</span>
            </div>
          )}

          {/* OSD Top Bar */}
          <div className="absolute top-3 left-3 right-3 flex items-center justify-between pointer-events-none">
            <div className="flex items-center gap-2 bg-stone-950/80 backdrop-blur-md px-2.5 py-1 rounded-md border border-stone-700/60 shadow-md">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-bold font-mono text-emerald-400 uppercase tracking-wider">LIVE FEED</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border font-semibold text-blue-300 bg-blue-950/60 border-blue-700/40">
                CLOUD RELAY
              </span>
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


export default function WeighbridgeScreen({ cabinMode = false }: { cabinMode?: boolean }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const scale = useScale();

  // Active view tab: entry -> pending second weight -> payment verification -> register
  const [activeTab, setActiveTab] = useState<'entry' | 'pending' | 'payment' | 'history'>('entry');

  // Form states
  const [vehicleNumber, setVehicleNumber] = useState<string>('');
  const [vehicleType, setVehicleType] = useState<string>('LORRY');
  const [tripType, setTripType] = useState<'FIRST' | 'SECOND' | 'SINGLE'>('FIRST');
  const [partyName, setPartyName] = useState<string>('');
  const [isStorageTransfer, setIsStorageTransfer] = useState<boolean>(false);
  const [storageLocation, setStorageLocation] = useState<string>('');
  const [material, setMaterial] = useState<string>('PAPPU');
  const [loadType, setLoadType] = useState<'LOAD' | 'EMPTY'>('LOAD');
  const [billType, setBillType] = useState<'CASH' | 'CREDIT' | 'FREE'>('CASH');
  const [charges, setCharges] = useState<string>('0');
  const [driverMobile, setDriverMobile] = useState<string>('');
  const [remarks, setRemarks] = useState<string>('');

  // Weight tracking states
  const [firstWeight, setFirstWeight] = useState<number | null>(null);
  const [manualWeightInput, setManualWeightInput] = useState<string>('');
  const [isManualOverride, setIsManualOverride] = useState<boolean>(false);
  const [pendingTicketId, setPendingTicketId] = useState<string | null>(null);

  const manualInputRef = useRef<HTMLInputElement>(null);

  // Manual toggle for NO DLC state, initialized from localStorage so it persists across page refreshes
  const [manualNoDls, setManualNoDls] = useState<boolean>(() => {
    try {
      return localStorage.getItem('rvp_kata_manual_no_dlc') === '1';
    } catch {
      return false;
    }
  });

  const toggleNoDlc = useCallback(() => {
    setManualNoDls((prev) => {
      const next = !prev;
      try {
        if (next) {
          localStorage.setItem('rvp_kata_manual_no_dlc', '1');
          toast.warning('⚠️ Scale set to NO DLC (Load Cell Lost)');
        } else {
          localStorage.removeItem('rvp_kata_manual_no_dlc');
          toast.success('Scale returned to standard mode');
        }
      } catch {}
      return next;
    });
  }, []);

  const rawUpper = (scale.rawText || '').toUpperCase();
  const errUpper = (scale.error || '').toUpperCase();
  const detectedNoDlc = Boolean(
    errUpper.includes('DLC') ||
      rawUpper.includes('DLC') ||
      errUpper.includes('DLS') ||
      rawUpper.includes('DLS') ||
      errUpper.includes('NO DL') ||
      rawUpper.includes('NO DL') ||
      errUpper.includes('NODL') ||
      rawUpper.includes('NODL') ||
      rawUpper.includes('?') ||
      errUpper.includes('ERR') ||
      rawUpper.includes('ERR') ||
      errUpper.includes('OPEN') ||
      rawUpper.includes('OPEN') ||
      errUpper.includes('FAIL') ||
      rawUpper.includes('FAIL')
  );
  const isNoDls = manualNoDls || detectedNoDlc;

  const noDlcLabel =
    (errUpper.includes('DLS') || rawUpper.includes('DLS')) &&
    !errUpper.includes('DLC') &&
    !rawUpper.includes('DLC')
      ? 'NO DLS'
      : 'NO DLC';

  // Cameras & Snapshot triggers
  const [camRefreshTrigger, setCamRefreshTrigger] = useState<number>(0);
  const [activeSnapshots, setActiveSnapshots] = useState<{ cam1?: string; cam2?: string } | null>(null);
  const [showCamSettings, setShowCamSettings] = useState<boolean>(false);
  const [expandedCam, setExpandedCam] = useState<1 | 2 | null>(null);

  // Active Slip Modal
  const [slipModalTicket, setSlipModalTicket] = useState<WeighbridgeTicket | null>(null);

  // Search & Filter in History tab
  const [historySearch, setHistorySearch] = useState<string>('');
  const [editingTicket, setEditingTicket] = useState<EditTicketDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WeighbridgeTicket | null>(null);
  const [paymentTarget, setPaymentTarget] = useState<WeighbridgeTicket | null>(null);
  const [paymentReference, setPaymentReference] = useState<string>('CASH');

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
    queryFn: async () => {
      try {
        return await api<{ nextTicketNo: number }>('/weighbridge/next-number');
      } catch {
        return await api<{ nextTicketNo: number }>('/weighbridge/tickets/next-number');
      }
    },
    refetchInterval: 15000,
  });

  const nextTicketNo = ticketNumData?.nextTicketNo ?? 1;

  // Fetch pending trucks (awaiting second weight)
  const { data: rawPendingTickets = [], refetch: refetchPending } = useQuery<WeighbridgeTicket[]>({
    queryKey: ['weighbridge-pending'],
    queryFn: async () => {
      try {
        return await api<WeighbridgeTicket[]>('/weighbridge/pending');
      } catch {
        return await api<WeighbridgeTicket[]>('/weighbridge/tickets/pending');
      }
    },
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

  // Resilient pending tickets list: combines direct pending query with
  // any tickets in allTickets that have PENDING_SECOND status
  const pendingTickets = useMemo(() => {
    if (rawPendingTickets && rawPendingTickets.length > 0) {
      return rawPendingTickets;
    }
    return allTickets.filter((t) => t.status === 'PENDING_SECOND');
  }, [rawPendingTickets, allTickets]);

  const completedTickets = useMemo(
    () => allTickets.filter((ticket) => ticket.status === 'COMPLETED'),
    [allTickets],
  );
  const pendingPaymentCount = useMemo(
    () => completedTickets.filter((ticket) => Number(ticket.amount || 0) > 0 && !ticket.paidAt).length,
    [completedTickets],
  );

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

  const vehicleOptions = useMemo(() => {
    const latest = new Map<string, WeighbridgeTicket>();
    for (const ticket of allTickets) {
      const value = ticket.vehicleNumber.trim().toUpperCase();
      if (value && !latest.has(value)) latest.set(value, ticket);
    }
    return Array.from(latest.values()).map((ticket) => ({
      value: ticket.vehicleNumber.trim().toUpperCase(),
      label: ticket.vehicleNumber.trim().toUpperCase(),
      hint: ticketTransferRoute(ticket) || ticket.partyName || ticket.material || undefined,
    }));
  }, [allTickets]);

  const partyOptions = useMemo(() => {
    const names = new Map<string, string>();
    for (const party of parties) names.set(party.name.trim().toUpperCase(), party.name.trim());
    for (const ticket of allTickets) {
      if (ticket.partyName?.trim()) names.set(ticket.partyName.trim().toUpperCase(), ticket.partyName.trim());
    }
    return Array.from(names.values())
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ value: name, label: name }));
  }, [parties, allTickets]);

  const selectVehicle = useCallback((value: string) => {
    const clean = value.toUpperCase();
    setVehicleNumber(clean);
    const previous = allTickets.find((ticket) => ticket.vehicleNumber.trim().toUpperCase() === clean);
    if (!previous) return;
    setVehicleType(previous.vehicleType || 'LORRY');
    setPartyName(previous.partyName || '');
    setIsStorageTransfer(Boolean(previous.isStorageTransfer));
    setStorageLocation(previous.storageLocation || '');
    setMaterial(previous.material || 'PAPPU');
    setBillType((previous.billType as 'CASH' | 'CREDIT' | 'FREE') || 'CASH');
    setDriverMobile(previous.partyMobile || '');
    setRemarks(previous.remarks || '');
  }, [allTickets]);

  const selectParty = useCallback((value: string) => {
    setPartyName(value);
    const previous = allTickets.find(
      (ticket) => ticket.partyName?.trim().toUpperCase() === value.trim().toUpperCase(),
    );
    if (!previous) return;
    setVehicleNumber(previous.vehicleNumber || '');
    setVehicleType(previous.vehicleType || 'LORRY');
    setMaterial(previous.material || 'PAPPU');
    setBillType((previous.billType as 'CASH' | 'CREDIT' | 'FREE') || 'CASH');
    setDriverMobile(previous.partyMobile || '');
  }, [allTickets]);

  const { data: cctvStatus, refetch: refetchCctvStatus } = useQuery<CctvStatusResponse>({
    queryKey: ['weighbridge-cctv-status'],
    queryFn: async () => {
      const response = await fetch(getScaleApiUrl('/weighbridge/cctv/status'), {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('CCTV relay status unavailable');
      return response.json();
    },
    refetchInterval: 5000,
    retry: false,
  });

  // Cabin print agent status
  const { data: printAgentStatus } = useQuery<{
    agentOnline: boolean;
    pendingCount: number;
    printerName?: string | null;
    printerReady?: boolean | null;
    printerError?: string | null;
  }>({
    queryKey: ['weighbridge-print-agent-status'],
    queryFn: () => api('/weighbridge/print-queue/status'),
    refetchInterval: 10000,
    retry: false,
  });

  const locallySavedTicketTimestamps = useRef<Map<string, number>>(new Map());

  // Cabin Browser Auto-Print Listener:
  // When running in Kata Cabin (/kata-cabin), automatically poll pending print jobs
  // from the cloud and print them directly through the browser!
  useEffect(() => {
    if (!cabinMode) return;

    let isPrinting = false;
    const interval = setInterval(async () => {
      if (isPrinting) return;
      try {
        const pendingJobs = await api<
          Array<{
            id: string;
            ticketId: string;
            ticketNo: number;
            requestedBy?: string;
            ticket?: WeighbridgeTicket;
          }>
        >('/weighbridge/print-queue/pending');

        if (pendingJobs && pendingJobs.length > 0) {
          isPrinting = true;
          for (const job of pendingJobs) {
            if (job.ticket) {
              const savedLocallyAt = locallySavedTicketTimestamps.current.get(job.ticket.id);
              // Only skip duplicate AUTO-prints if THIS cabin PC was the one that saved it within the last 15s
              const isDuplicateAutoPrint =
                job.requestedBy === 'AUTO' &&
                Boolean(savedLocallyAt && Date.now() - savedLocallyAt < 15000);

              if (!isDuplicateAutoPrint) {
                toast.info(`🖨️ Cabin Printer: Printing Ticket #${formatTicketNo(job.ticketNo)}...`);
                await triggerDirectPrint(job.ticket);
              } else {
                console.log(`[Cabin] Skipped duplicate auto-print for Ticket #${formatTicketNo(job.ticketNo)} (already printed on save)`);
              }

              // Mark completed in cloud queue
              await api(`/weighbridge/print-queue/${job.id}/complete`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'COMPLETED' }),
              });
              queryClient.invalidateQueries({ queryKey: ['weighbridge-print-agent-status'] });
              queryClient.invalidateQueries({ queryKey: ['weighbridge-tickets'] });
              await new Promise((r) => setTimeout(r, 1500));
            }
          }
        }
      } catch {
        // Ignore network interruptions
      } finally {
        isPrinting = false;
      }
    }, 3500);

    return () => clearInterval(interval);
  }, [cabinMode, queryClient]);

  const bothCamerasOnline = Boolean(cctvStatus?.cam1.online && cctvStatus?.cam2.online);

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

  const storageTransferDirection = transferDirectionForMaterial(material);

  const calculatedKataFee = useMemo(() => {
    if (billType === 'FREE' || calculatedNetWeight == null || calculatedNetWeight <= 0) return 0;
    return calcKataFee(
      calculatedNetWeight,
      isVehicleExempt(vehicleNumber, companyProfile?.companyVehicles),
    );
  }, [billType, calculatedNetWeight, vehicleNumber, companyProfile?.companyVehicles]);

  useEffect(() => {
    setCharges(String(calculatedKataFee));
  }, [calculatedKataFee]);

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
    setIsStorageTransfer(false);
    setStorageLocation('');
    setMaterial('PAPPU');
    setLoadType('LOAD');
    setBillType('CASH');
    setCharges('0');
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
    setIsStorageTransfer(Boolean(ticket.isStorageTransfer));
    setStorageLocation(ticket.storageLocation || '');
    setMaterial(ticket.material || 'PAPPU');
    setLoadType(ticket.loadType === 'LOAD' ? 'EMPTY' : 'LOAD');
    setFirstWeight(ticket.firstWeightKg);
    setBillType((ticket.billType as 'CASH' | 'CREDIT' | 'FREE') || 'CASH');
    setDriverMobile(ticket.partyMobile || '');
    setCharges('0');
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
      if (isStorageTransfer && !storageLocation) {
        throw new Error('Select the storage location for this transfer');
      }
      if (currentLiveWeight <= 0) {
        throw new Error('Weight must be greater than 0 kg');
      }

      // Capture live snapshots at the exact moment of kata (weighment)
      const [snap1Base64, snap2Base64] = await Promise.all([
        captureCamSnapshotBase64(1),
        captureCamSnapshotBase64(2),
      ]);
      if (!snap1Base64 || !snap2Base64) {
        toast.warning('One or more browser snapshots were unavailable. The server will use the freshest cabin relay frame.');
      }
      const localSnap1 = snap1Base64 || `https://rvp-server.onrender.com/api/weighbridge/cctv/snapshot?cam=1&t=${Date.now()}`;
      const localSnap2 = snap2Base64 || `https://rvp-server.onrender.com/api/weighbridge/cctv/snapshot?cam=2&t=${Date.now()}`;
      const snapObj = { cam1: localSnap1, cam2: localSnap2 };
      setActiveSnapshots(snapObj);

      const activePendingId =
        pendingTicketId ||
        (tripType === 'SECOND'
          ? pendingTickets.find(
              (p) => p.vehicleNumber.toUpperCase() === vehicleNumber.trim().toUpperCase()
            )?.id
          : null);

      if (tripType === 'SECOND' && activePendingId) {
        // Complete second weighment
        const res = await api<WeighbridgeTicket>(`/weighbridge/tickets/${activePendingId}/second-weight`, {
          method: 'PATCH',
          body: JSON.stringify({
            secondWeightKg: currentLiveWeight,
            secondWeight: currentLiveWeight,
            partyName: isStorageTransfer ? undefined : (partyName.trim() || undefined),
            partyMobile: driverMobile.trim() || undefined,
            material: material || undefined,
            isStorageTransfer,
            storageLocation: isStorageTransfer ? storageLocation : undefined,
            billType,
            loadType,
            remarks: remarks.trim() || undefined,
            snapCam1: snap1Base64,
            snapCam2: snap2Base64,
          }),
        });
        return {
          ticket: res,
          snapshots: {
            cam1: res.secondCam1PhotoUrl || res.cam1PhotoUrl || snap1Base64 || localSnap1,
            cam2: res.secondCam2PhotoUrl || res.cam2PhotoUrl || snap2Base64 || localSnap2,
          },
        };
      } else {
        // Create initial ticket (First weight or Single weight)
        const res = await api<WeighbridgeTicket>('/weighbridge/tickets', {
          method: 'POST',
          body: JSON.stringify({
            vehicleNumber: vehicleNumber.trim().toUpperCase(),
            vehicleType,
            tripType,
            partyName: isStorageTransfer ? '' : partyName.trim(),
            material,
            isStorageTransfer,
            storageLocation: isStorageTransfer ? storageLocation : undefined,
            loadType,
            billType,
            firstWeightKg: tripType === 'SECOND' ? (firstWeight ?? currentLiveWeight) : currentLiveWeight,
            secondWeightKg: tripType === 'SECOND' ? currentLiveWeight : undefined,
            secondWeight: tripType === 'SECOND' ? currentLiveWeight : undefined,
            partyMobile: driverMobile.trim(),
            remarks: remarks.trim(),
            operatorName: user?.name || 'OPERATOR',
            snapCam1: snap1Base64,
            snapCam2: snap2Base64,
          }),
        });
        return {
          ticket: res,
          snapshots: {
            cam1: res.cam1PhotoUrl || snap1Base64 || localSnap1,
            cam2: res.cam2PhotoUrl || snap2Base64 || localSnap2,
          },
        };
      }
    },
    onSuccess: ({ ticket, snapshots }) => {
      toast.success(`Ticket #${formatTicketNo(ticket.ticketNo)} saved successfully!`);
      queryClient.invalidateQueries({ queryKey: ['weighbridge-next-ticket'] });
      queryClient.invalidateQueries({ queryKey: ['weighbridge-pending'] });
      queryClient.invalidateQueries({ queryKey: ['weighbridge-tickets'] });
      queryClient.invalidateQueries({ queryKey: ['weighbridge-print-agent-status'] });

      locallySavedTicketTimestamps.current.set(ticket.id, Date.now());

      if (cabinMode) {
        // Dedicated Kata Cabin PC: trigger immediate direct print to the cabin printer!
        toast.info(`🖨️ Printing Ticket #${formatTicketNo(ticket.ticketNo)}...`, { duration: 3000 });
        triggerDirectPrint(ticket, undefined, snapshots).catch(() => {});
      } else {
        // Non-cabin office/laptop PC: do NOT popup browser print dialog!
        // The ticket is automatically queued in the cloud for the Kata Cabin Printer.
        toast.success(`🖨️ Ticket #${formatTicketNo(ticket.ticketNo)} queued for Kata Cabin Printer.`);
        setSlipModalTicket(ticket);
        if (snapshots) {
          setActiveSnapshots(snapshots);
        }
      }

      if (ticket.status === 'COMPLETED') {
        setActiveTab('payment');
        toast.info(Number(ticket.amount || 0) > 0
          ? `Payment of ₹${Number(ticket.amount).toLocaleString('en-IN')} is awaiting verification.`
          : 'KNM/free vehicle: no Kata charge. Release the signed slip from Payment Verification.');
      }

      // Reset form
      handleResetForm();
    },
    onError: (err) => {
      toast.error(getErrorMessage(err));
    },
  });

  const reminderMutation = useMutation({
    mutationFn: (ticket: WeighbridgeTicket) => api<{ sent: number; attempted: number }>(`/weighbridge/tickets/${ticket.id}/remind-second-weight`, { method: 'POST' }),
    onSuccess: (result) => {
      toast.success(`Second-weight reminder sent to ${result.sent} of ${result.attempted} recipient(s).`);
      queryClient.invalidateQueries({ queryKey: ['weighbridge-pending'] });
      queryClient.invalidateQueries({ queryKey: ['weighbridge-tickets'] });
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const paymentMutation = useMutation({
    mutationFn: (ticket: WeighbridgeTicket) => api<{ ticket: WeighbridgeTicket; whatsapp: { ok: boolean; skipped?: boolean; error?: string } }>(`/weighbridge/tickets/${ticket.id}/verify-payment`, {
      method: 'POST',
      body: JSON.stringify({ amount: Number(ticket.amount || 0), reference: paymentReference.trim() || (Number(ticket.amount || 0) > 0 ? 'CASH' : 'FREE') }),
    }),
    onSuccess: ({ ticket, whatsapp }) => {
      toast.success(Number(ticket.amount || 0) > 0 ? `Payment verified for Ticket #${formatTicketNo(ticket.ticketNo)}.` : `Free KNM ticket #${formatTicketNo(ticket.ticketNo)} released.`);
      if (whatsapp.ok) toast.success('Signed Kata slip sent to the driver on WhatsApp.');
      else toast.warning(whatsapp.error || 'Payment saved, but the WhatsApp slip could not be sent.');
      setPaymentTarget(null);
      setPaymentReference('CASH');
      queryClient.invalidateQueries({ queryKey: ['weighbridge-tickets'] });
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const startEditingTicket = useCallback((ticket: WeighbridgeTicket) => {
    setEditingTicket({
      id: ticket.id,
      vehicleNumber: ticket.vehicleNumber,
      vehicleType: ticket.vehicleType || 'LORRY',
      tripType: ticket.tripType || 'FIRST',
      partyName: ticket.partyName || '',
      partyMobile: ticket.partyMobile || '',
      material: ticket.material || 'PAPPU',
      loadType: ticket.loadType || 'LOAD',
      billType: ticket.billType || 'CASH',
      firstWeightKg: ticket.firstWeightKg != null ? String(ticket.firstWeightKg) : '',
      secondWeightKg: ticket.secondWeightKg != null ? String(ticket.secondWeightKg) : '',
      remarks: ticket.remarks || '',
    });
  }, []);

  const editMutation = useMutation({
    mutationFn: async (draft: EditTicketDraft) => api<WeighbridgeTicket>(`/weighbridge/tickets/${draft.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        vehicleNumber: draft.vehicleNumber,
        vehicleType: draft.vehicleType,
        tripType: draft.tripType,
        partyName: draft.partyName,
        partyMobile: draft.partyMobile,
        material: draft.material,
        loadType: draft.loadType,
        billType: draft.billType,
        firstWeightKg: draft.firstWeightKg || null,
        secondWeightKg: draft.secondWeightKg || null,
        remarks: draft.remarks,
      }),
    }),
    onSuccess: (ticket) => {
      toast.success(`Ticket #${formatTicketNo(ticket.ticketNo)} updated. Net weight and fee recalculated.`);
      setEditingTicket(null);
      queryClient.invalidateQueries({ queryKey: ['weighbridge-pending'] });
      queryClient.invalidateQueries({ queryKey: ['weighbridge-tickets'] });
      setSlipModalTicket((current) => current?.id === ticket.id ? ticket : current);
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api<void>(`/weighbridge/tickets/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      const ticketNo = deleteTarget?.ticketNo;
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: ['weighbridge-pending'] });
      queryClient.invalidateQueries({ queryKey: ['weighbridge-tickets'] });
      queryClient.invalidateQueries({ queryKey: ['weighbridge-next-ticket'] });
      toast.success(ticketNo ? `Ticket #${formatTicketNo(ticketNo)} deleted.` : 'Ticket deleted.');
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const exportTickets = useCallback(() => api<WeighbridgeTicket[]>(
    `/weighbridge/tickets?all=true${historySearch ? `&search=${encodeURIComponent(historySearch)}` : ''}`,
  ), [historySearch]);

  const editPreview = useMemo(() => {
    if (!editingTicket) return { net: null as number | null, fee: 0 };
    const first = Number(editingTicket.firstWeightKg);
    const second = Number(editingTicket.secondWeightKg);
    let net: number | null = null;
    if (first > 0 && second > 0) net = Math.abs(first - second);
    else if (editingTicket.tripType === 'SINGLE' && first > 0) net = first;
    const fee = net && editingTicket.billType !== 'FREE'
      ? calcKataFee(net, isVehicleExempt(editingTicket.vehicleNumber, companyProfile?.companyVehicles))
      : 0;
    return { net, fee };
  }, [editingTicket, companyProfile?.companyVehicles]);

  // Global Keyboard Shortcuts (F12 = Save, F4 = Pending, F8 = Override, Esc = Clear)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F12') {
        if (slipModalTicket) return; // Prevent duplicate submit when viewing slip
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
    <div className={cn('kata-page space-y-5 pb-12', cabinMode && 'min-h-screen px-4 py-5 sm:px-6 lg:px-8')}>
      {/* Editorial Page Header matching ERP */}
      <PageHeader
        icon={Scale}
        title="Weighbridge (Kata)"
        description={cabinMode ? 'Dedicated cabin console · live scale, dual camera verification, and ticket printing.' : 'Electronic weighbridge recording, digital LED indicator stream, and CP PLUS dual CCTV camera verification.'}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* Universal Scale Network Hub Status Badge */}
            <div className="flex items-center gap-2">
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

              {/* Cabin Printer Status Badge */}
              <div
                className={cn(
                  'flex items-center gap-2 h-9 px-3 rounded-lg border text-xs font-mono font-medium shadow-sm',
                  (printAgentStatus?.pendingCount ?? 0) === 0
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                    : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                )}
                title="Cabin printer status · Browser direct printing enabled"
              >
                <Printer className="h-3.5 w-3.5" />
                <span>
                  {(printAgentStatus?.pendingCount ?? 0) > 0
                    ? `Cabin Printer: Printing queued (${printAgentStatus?.pendingCount})`
                    : 'Canon LBP2900: Ready'}
                </span>
              </div>
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

      {activeTab === 'entry' && (
        <section className="kata-operations-strip" aria-label="Live weighbridge status">
          <div className="kata-ops-brand">
            <span className="kata-eyebrow">Active weighment</span>
            <strong>Ticket #{formatTicketNo(nextTicketNo)}</strong>
          </div>
          <div className="kata-ops-cell">
            <Calendar className="h-4 w-4" />
            <span>{dateString}</span>
            <b>{clockString}</b>
          </div>
          <div className="kata-ops-cell">
            <Scale className="h-4 w-4" />
            <span>Scale link</span>
            <b className={scale.isScaleOnline ? 'text-emerald-700' : 'text-amber-700'}>
              {scale.isScaleOnline ? 'Online' : 'Manual fallback'}
            </b>
          </div>
          <button
            type="button"
            className="kata-ops-cell kata-relay-button"
            onClick={() => refetchCctvStatus()}
            title="Refresh cabin camera relay status"
          >
            {bothCamerasOnline ? <Cloud className="h-4 w-4" /> : <CloudOff className="h-4 w-4" />}
            <span>Remote cameras</span>
            <b className={bothCamerasOnline ? 'text-emerald-700' : 'text-rose-700'}>
              {bothCamerasOnline ? 'Relay healthy' : 'Relay attention'}
            </b>
          </button>
        </section>
      )}

      {/* KPI cards belong in the ERP report; the cabin stays focused on the active truck. */}
      {!cabinMode && <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
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
      </div>}

      {/* Navigation Tabs */}
      <div className="kata-tabs flex items-center gap-1 border-b border-border pb-1">
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
          onClick={() => setActiveTab('payment')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition-all',
            activeTab === 'payment'
              ? 'bg-primary/10 text-primary border border-primary/20 shadow-xs'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Banknote className="h-4 w-4" />
          <span>Payment Verification</span>
          {pendingPaymentCount > 0 && (
            <span className="px-1.5 py-0.2 text-[10px] font-bold rounded-full bg-rose-500/15 text-rose-700 dark:text-rose-400">
              {pendingPaymentCount}
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
        <div className="kata-entry-grid grid grid-cols-1 gap-5 lg:grid-cols-12">
          {/* Main Transaction Entry Form */}
          <Card className="kata-form-card lg:col-span-5 overflow-hidden border-border">
            <CardHeader className="kata-card-heading pb-4 border-b border-border/60">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-mono font-bold text-sm">
                    #{formatTicketNo(nextTicketNo)}
                  </div>
                  <div>
                    <CardTitle className="text-base font-bold text-foreground">
                      Transaction Entry Screen
                    </CardTitle>
                    <CardDescription className="text-xs">
                      {pendingTicketId
                        ? `Completing Second Weight for Ticket #${formatTicketNo(nextTicketNo)}`
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
                  <Combobox
                    options={vehicleOptions}
                    value={vehicleNumber}
                    onChange={selectVehicle}
                    placeholder="ENTER VEHICLE NUMBER"
                    searchPlaceholder="Search or enter vehicle number…"
                    emptyText="No saved vehicle found."
                    allowCustomValue
                    customValueLabel="Use vehicle"
                    ariaLabel="Vehicle number"
                    className="font-mono text-base font-bold tracking-wider uppercase h-11 bg-background"
                  />
                </div>

                {/* Vehicle Type */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Vehicle Type
                  </Label>
                  <Combobox options={VEHICLE_TYPES} value={vehicleType} onChange={setVehicleType}
                    placeholder="Select vehicle type" searchPlaceholder="Search vehicle type…" ariaLabel="Vehicle type" className="bg-background" />
                </div>

                {/* Trip Type */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Trip Type
                  </Label>
                  <Combobox
                    options={TRIP_TYPE_OPTIONS}
                    value={tripType}
                    onChange={(val) => {
                      setTripType(val as 'FIRST' | 'SECOND' | 'SINGLE');
                      if (val === 'FIRST') setFirstWeight(null);
                    }}
                    placeholder="Select trip type" searchPlaceholder="Search trip type…" ariaLabel="Trip type" className="bg-background font-medium"
                  />
                </div>

                {/* Internal transfer mode */}
                <label className={cn(
                  'sm:col-span-2 flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors',
                  isStorageTransfer
                    ? 'border-amber-500/50 bg-amber-500/10'
                    : 'border-border bg-muted/25 hover:bg-muted/45',
                )}>
                  <input
                    type="checkbox"
                    checked={isStorageTransfer}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setIsStorageTransfer(checked);
                      if (checked) setPartyName('');
                      else setStorageLocation('');
                    }}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-amber-600"
                    aria-label="Internal storage transfer"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-foreground">
                      <Warehouse className="h-4 w-4 text-amber-600" />
                      Internal Storage Transfer
                    </span>
                    <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
                      Use for black seed coming to RVP or husk and tamarind by-products going to storage.
                    </span>
                  </span>
                </label>

                {isStorageTransfer ? (
                  <div className="space-y-2 sm:col-span-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3.5">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center justify-between">
                      <span className="flex items-center gap-1.5">
                        <Warehouse className="h-3.5 w-3.5 text-amber-600" />
                        Storage Location *
                      </span>
                      <span className="text-[10px] font-normal text-amber-700 dark:text-amber-300">Party name not required</span>
                    </Label>
                    <Combobox
                      options={STORAGE_LOCATIONS}
                      value={storageLocation}
                      onChange={setStorageLocation}
                      placeholder="Select storage"
                      searchPlaceholder="Search storage…"
                      ariaLabel="Storage location"
                      className="bg-background font-medium"
                    />
                    <div className="flex items-center gap-2 rounded-lg bg-background/80 px-3 py-2 text-xs font-semibold text-foreground ring-1 ring-border/60">
                      <span>{storageTransferDirection === 'STORAGE_TO_RVP' ? storageLocation || 'Storage' : 'RVP'}</span>
                      <ArrowRight className="h-3.5 w-3.5 text-amber-600" />
                      <span>{storageTransferDirection === 'STORAGE_TO_RVP' ? 'RVP' : storageLocation || 'Storage'}</span>
                      <Badge variant="outline" className="ml-auto border-amber-500/40 text-[9px] text-amber-700 dark:text-amber-300">
                        {material === 'BLACK SEED' ? 'INWARD' : 'OUTWARD'}
                      </Badge>
                    </div>
                  </div>
                ) : (
                  /* Party Name (with autocomplete) */
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center justify-between">
                      <span className="flex items-center gap-1.5">
                        <User className="h-3.5 w-3.5 text-primary" />
                        Customer / Party Name
                      </span>
                      <span className="text-[10px] font-normal text-muted-foreground">Supplier or Buyer name</span>
                    </Label>
                    <Combobox options={partyOptions} value={partyName} onChange={selectParty}
                      placeholder="Select customer or party" searchPlaceholder="Search or enter party name…"
                      emptyText="No saved party found." allowCustomValue customValueLabel="Use party"
                      ariaLabel="Customer or party name" className="bg-background uppercase" />
                  </div>
                )}

                {/* Material Selection */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Package className="h-3.5 w-3.5 text-primary" />
                    Material / Commodity
                  </Label>
                  <Combobox options={MATERIALS.map((m) => ({ value: m, label: m }))} value={material} onChange={setMaterial}
                    placeholder="Select material" searchPlaceholder="Search material…" ariaLabel="Material" className="bg-background font-medium" />
                </div>

                {/* Load Type */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Load Condition
                  </Label>
                  <Combobox options={LOAD_TYPE_OPTIONS} value={loadType} onChange={(v) => setLoadType(v as 'LOAD' | 'EMPTY')}
                    placeholder="Select condition" searchPlaceholder="Search load condition…" ariaLabel="Load condition" className="bg-background font-medium" />
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
                    readOnly
                    aria-readonly="true"
                    className="h-10 bg-muted/50 font-mono font-bold"
                  />
                  <p className="text-[10px] text-muted-foreground">Auto-calculated from final net weight after both weights are saved.</p>
                </div>

                {/* Payment mode */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <CreditCard className="h-3.5 w-3.5 text-primary" />
                    Payment Type
                  </Label>
                  <Combobox options={BILL_TYPE_OPTIONS} value={billType} onChange={(v) => setBillType(v as 'CASH' | 'CREDIT' | 'FREE')}
                    placeholder="Select payment type" searchPlaceholder="Search payment type…" ariaLabel="Payment type" className="bg-background font-medium" />
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

              <div className="kata-payment-display">
                <div className="kata-payment-icon">
                  <IndianRupee className="h-5 w-5" />
                </div>
                <div>
                  <span className="kata-eyebrow">Payment display</span>
                  <p>{calculatedNetWeight == null
                    ? 'Charge after second weight'
                    : billType === 'FREE'
                      ? 'Complimentary weighment'
                      : billType === 'CREDIT'
                        ? 'Post to customer credit'
                        : 'Collect at counter'}</p>
                </div>
                <div className="kata-payment-amount">
                  <span>{billType}</span>
                  <strong>{calculatedNetWeight == null ? 'Pending' : `₹${Number(charges || 0).toLocaleString('en-IN')}`}</strong>
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
                  disabled={saveMutation.isPending || currentLiveWeight <= 0 || !vehicleNumber.trim() || (isStorageTransfer && !storageLocation)}
                  className="h-11 px-6 font-bold gap-2 text-sm bg-primary hover:bg-primary/90 text-primary-foreground shadow-md transition-transform active:scale-98"
                >
                  <Printer className="h-4 w-4" />
                  <span>Save Ticket & Print (F12)</span>
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Instrument console: live weight and dual cameras */}
          <div className="lg:col-span-7 space-y-5">
            {/* 1. Digital Scale Instrument Panel */}
            <div className="kata-scale-panel relative overflow-hidden rounded-2xl border border-stone-800 text-stone-100 p-5">
              {/* Radial ambient glow */}
              <div className="absolute -top-12 -right-12 w-36 h-36 bg-amber-500/10 rounded-full blur-2xl pointer-events-none" />

              {/* Hardware Fault / NO DLC Alert Banner */}
              {isNoDls && (
                <div className="mb-3.5 p-3.5 rounded-xl bg-red-500/15 border border-red-500/50 text-red-200 text-xs flex items-start justify-between gap-3 shadow-lg shadow-red-950/40">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="h-5 w-5 text-red-400 shrink-0 mt-0.5 animate-bounce" />
                    <div>
                      <div className="font-bold text-red-100 text-sm">Scale Hardware Alert: "{noDlcLabel}" (Load Cell Signal Lost)</div>
                      <p className="text-xs text-red-300/90 mt-1 leading-relaxed">
                        The physical scale indicator is showing {noDlcLabel}. You can click <strong>Override (F8)</strong> or click the box below to manually type the weight from the physical display.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {!isManualOverride && (
                      <Button
                        size="sm"
                        onClick={() => {
                          setIsManualOverride(true);
                          setTimeout(() => manualInputRef.current?.focus(), 60);
                        }}
                        className="bg-red-600 hover:bg-red-500 text-white text-xs font-bold font-mono h-7 px-2.5 gap-1 shadow-xs"
                      >
                        <Pencil className="h-3 w-3" />
                        Override (F8)
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={toggleNoDlc}
                      className="text-red-300 hover:text-white hover:bg-red-500/20 text-xs font-mono h-7 px-2 border border-red-500/40"
                    >
                      Clear {noDlcLabel}
                    </Button>
                  </div>
                </div>
              )}

              {/* DLC Cooldown Warning Banner — shows for 30s after DLC fault clears */}
              {!isNoDls && scale.recentFault && (
                <div className="mb-3.5 p-3 rounded-xl bg-amber-500/15 border border-amber-500/50 text-amber-200 text-xs flex items-start gap-2.5 shadow-lg shadow-amber-950/30 animate-pulse">
                  <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-bold text-amber-100 text-sm">⚠️ Recent DLC Fault Detected</div>
                    <p className="text-xs text-amber-300/90 mt-1 leading-relaxed">
                      A load cell signal loss was detected {scale.lastFaultTime ? `${Math.round((Date.now() - scale.lastFaultTime) / 1000)}s ago` : 'recently'}.
                      The scale has recovered, but the current reading <strong>may be unreliable</strong>.
                      Wait for the indicator to stabilize or verify against the physical display.
                    </p>
                  </div>
                </div>
              )}

              {/* Top readout status row */}
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3 text-xs font-mono">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className={cn(
                      'animate-ping absolute inline-flex h-full w-full rounded-full opacity-75',
                      isNoDls ? 'bg-red-400' : scale.recentFault ? 'bg-amber-400' : isManualOverride ? 'bg-amber-400' : scale.isStable ? 'bg-emerald-400' : 'bg-amber-400'
                    )} />
                    <span className={cn(
                      'relative inline-flex rounded-full h-2.5 w-2.5',
                      isNoDls ? 'bg-red-500' : scale.recentFault ? 'bg-amber-500' : isManualOverride ? 'bg-amber-500' : scale.isStable ? 'bg-emerald-500' : 'bg-amber-500'
                    )} />
                  </span>
                  <span className="font-bold tracking-wider text-stone-300">
                    {isNoDls
                      ? `${noDlcLabel} (FAULT)`
                      : scale.recentFault
                      ? `⚠️ RECENTLY FAULTED (${scale.lastFaultTime ? `${Math.round((Date.now() - scale.lastFaultTime) / 1000)}s ago` : 'recovering'})`
                      : isManualOverride
                      ? 'MANUAL OVERRIDE'
                      : scale.isScaleOnline
                        ? `SCALE INDICATOR (${scale.serverPort || 'COM4'}${scale.connectionMode === 'LOCAL_USB' ? ' · USB' : ''})`
                        : `SCALE INDICATOR (${scale.serverPort || 'COM4'} OFFLINE)`}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 flex-wrap">
                  {/* Connect USB button if Web Serial is supported and not connected locally */}
                  {!scale.isLocalConnected && scale.isSupported && (
                    <Button
                      size="sm"
                      onClick={async () => {
                        try {
                          const ok = await scale.connect();
                          if (ok) toast.success('Scale connected to COM4!');
                        } catch (err: any) {
                          toast.error(err?.message || 'Failed to connect scale USB');
                        }
                      }}
                      className="h-7 px-2 text-[11px] font-mono font-bold bg-amber-500 hover:bg-amber-400 text-stone-950 flex items-center gap-1 shadow-xs animate-pulse"
                      title="Click to connect browser directly to COM4 USB cable"
                    >
                      <Cable className="h-3 w-3" />
                      Connect USB
                    </Button>
                  )}

                  {/* NO DLC Toggle button */}
                  <Button
                    size="sm"
                    onClick={toggleNoDlc}
                    className={cn(
                      "h-7 px-2.5 text-[11px] font-mono font-bold gap-1.5 border transition-all shadow-xs",
                      isNoDls
                        ? "bg-red-600 hover:bg-red-500 text-white border-red-400 animate-pulse shadow-red-500/40"
                        : "text-red-400 hover:text-red-200 bg-red-950/40 hover:bg-red-900/60 border-red-800/80"
                    )}
                    title={isNoDls ? "Click to turn off NO DLC status" : "Click to activate NO DLC display"}
                  >
                    <AlertTriangle className="h-3 w-3" />
                    {isNoDls ? `${noDlcLabel} ACTIVE` : noDlcLabel}
                  </Button>

                  {isManualOverride ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setIsManualOverride(false);
                        setManualWeightInput('');
                      }}
                      className="h-7 px-2 text-[11px] font-mono text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 gap-1"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Resume COM4
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
                      className="h-7 px-2 text-[11px] font-mono text-stone-400 hover:text-stone-200 bg-stone-800/80 border border-stone-700/60 gap-1"
                      title="Manually override weight displayed in this box (F8)"
                    >
                      <Pencil className="h-3 w-3" />
                      Override (F8)
                    </Button>
                  )}

                  {!isManualOverride && (
                    <span className={cn(
                      'px-2 py-1 rounded text-[10px] font-bold tracking-wider',
                      isNoDls
                        ? 'bg-red-500/20 text-red-400 border border-red-500/30 font-black'
                        : scale.recentFault
                          ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse'
                          : !scale.isScaleOnline
                            ? 'bg-stone-800 text-stone-400 border border-stone-700'
                            : scale.isStable
                              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                              : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                    )}>
                      {isNoDls
                        ? noDlcLabel
                        : scale.recentFault
                          ? '⚠️ RECOVERING'
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
                  className="py-6 text-center select-none cursor-pointer group bg-red-950/25 rounded-2xl border-2 border-red-500/50 hover:border-red-400 transition-all p-4 my-2 shadow-inner"
                  onClick={() => {
                    setIsManualOverride(true);
                    setTimeout(() => manualInputRef.current?.focus(), 60);
                  }}
                  title="Click to type weight manually (F8)"
                >
                  <div className="flex items-center justify-center gap-3">
                    <AlertTriangle className="h-10 w-10 text-red-500 animate-bounce" />
                    <span className="font-mono font-black text-6xl md:text-7xl text-red-500 tracking-tight drop-shadow-[0_0_30px_rgba(239,68,68,0.7)] animate-pulse">
                      {noDlcLabel}
                    </span>
                    <AlertTriangle className="h-10 w-10 text-red-500 animate-bounce" />
                  </div>
                  <div className="text-red-400 font-mono text-xs mt-3 font-bold flex flex-wrap items-center justify-center gap-2">
                    <span className="bg-red-500/20 px-2.5 py-0.5 rounded-full border border-red-500/40">
                      Digital Load Cell Signal Lost ({noDlcLabel})
                    </span>
                    <span>·</span>
                    <span className="underline underline-offset-4 text-amber-300 hover:text-amber-200">
                      Click here to enter weight manually (F8)
                    </span>
                  </div>
                </div>
              ) : isManualOverride ? (
                <div className="py-2 text-center select-none">
                  {isNoDls && (
                    <div className="flex items-center justify-center gap-1.5 mb-1 text-[11px] font-mono font-bold text-red-400">
                      <AlertTriangle className="h-3 w-3" />
                      <span>{noDlcLabel} ACTIVE · Enter weight manually from physical scale below</span>
                    </div>
                  )}
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
                    ✏️ Manual Override Active (Press F8 or click 'Resume COM4' to exit)
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
                    <span className={cn(
                      'kata-weight-digits font-mono font-black tracking-tight transition-transform group-hover:scale-102',
                      currentLiveWeight < 0 ? 'text-red-400 drop-shadow-[0_0_20px_rgba(239,68,68,0.5)]' : 'text-amber-400'
                    )}>
                      {currentLiveWeight < 0 ? `−${Math.abs(currentLiveWeight).toLocaleString('en-IN')}` : currentLiveWeight.toLocaleString('en-IN')}
                    </span>
                    <span className="font-mono font-bold text-xl text-stone-400">
                      KG
                    </span>
                  </div>

                  {/* Sub-readout in metric tonnes */}
                  <div className={cn(
                    'font-mono text-xs mt-1 flex items-center justify-center gap-2',
                    currentLiveWeight < 0 ? 'text-red-400' : 'text-stone-400'
                  )}>
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
            <Card className="kata-camera-card overflow-hidden border-border">
              <CardHeader className="kata-card-heading pb-3 border-b border-border/60">
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
                      {bothCamerasOnline ? 'Relay healthy' : 'Relay attention'}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        setCamRefreshTrigger(Date.now());
                        refetchCctvStatus();
                      }}
                      title="Manual Camera Refresh"
                    >
                      <RefreshCw className="h-3 w-3" />
                    </Button>
                    {!cabinMode && <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowCamSettings(true)}
                      title="CCTV & RTSP Camera Configuration"
                    >
                      <Settings className="h-3 w-3" />
                    </Button>}
                  </div>
                </div>
              </CardHeader>

              <CardContent className="pt-4 space-y-3">
                {!bothCamerasOnline && (
                  <div className="kata-relay-warning">
                    <CloudOff className="h-4 w-4 shrink-0" />
                    <div>
                      <strong>Remote snapshot relay needs attention</strong>
                      <p>
                        {cctvStatus?.cam1.lastSeen == null && cctvStatus?.cam2.lastSeen == null
                          ? 'The cloud server has not received a camera frame. Start the cabin bridge and verify its relay key.'
                          : 'The latest frame is stale. Tickets can still be saved, but a current CCTV image cannot be guaranteed.'}
                      </p>
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <CctvLiveBox
                    camNumber={1}
                    cameraIp="192.168.1.101"
                    label="CAM 1: ENTRY"
                    currentTime={clockString}
                    refreshTrigger={camRefreshTrigger}
                    onExpand={(cam) => setExpandedCam(cam)}
                    relayStatus={cctvStatus?.cam1}
                  />
                  <CctvLiveBox
                    camNumber={2}
                    cameraIp="192.168.1.102"
                    label="CAM 2: EXIT"
                    currentTime={clockString}
                    refreshTrigger={camRefreshTrigger}
                    onExpand={(cam) => setExpandedCam(cam)}
                    relayStatus={cctvStatus?.cam2}
                  />
                </div>
                <p className="text-[11px] text-muted-foreground text-center font-mono">
                  Click either camera for full view · Every saved ticket uses the freshest relay frame and records its capture time
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
                        #{formatTicketNo(t.ticketNo)}
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
                        {ticketTransferRoute(t) || t.partyName || '-'}
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
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => reminderMutation.mutate(t)}
                            disabled={reminderMutation.isPending}
                            className="h-8 gap-1 text-xs font-semibold text-emerald-700"
                            title="WhatsApp the driver and Hamali Team"
                          >
                            <MessageCircle className="h-3.5 w-3.5" />
                            Remind Driver + Hamali
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => handleSelectPendingTruck(t)}
                            className="h-8 gap-1 text-xs font-semibold"
                          >
                            <Scale className="h-3.5 w-3.5" />
                            Complete 2nd Weight
                          </Button>
                        </div>
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
          TAB 3: PAYMENT VERIFICATION
         ───────────────────────────────────────────────────────────── */}
      {activeTab === 'payment' && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="border-amber-500/20 bg-amber-500/5"><CardContent className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Awaiting collection</p>
              <p className="mt-1 font-mono text-2xl font-black">₹{completedTickets.filter((t) => Number(t.amount || 0) > 0 && !t.paidAt).reduce((sum, t) => sum + Number(t.amount || 0), 0).toLocaleString('en-IN')}</p>
              <p className="text-xs text-muted-foreground">{pendingPaymentCount} ticket(s) pending</p>
            </CardContent></Card>
            <Card className="border-emerald-500/20 bg-emerald-500/5"><CardContent className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Collected today</p>
              <p className="mt-1 font-mono text-2xl font-black text-emerald-700">₹{completedTickets.filter((t) => t.paidAt && new Date(t.paidAt).toDateString() === new Date().toDateString()).reduce((sum, t) => sum + Number(t.paidAmount || 0), 0).toLocaleString('en-IN')}</p>
              <p className="text-xs text-muted-foreground">Verified counter receipts</p>
            </CardContent></Card>
            <Card className="border-sky-500/20 bg-sky-500/5"><CardContent className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Free / KNM vehicles</p>
              <p className="mt-1 font-mono text-2xl font-black text-sky-700">{completedTickets.filter((t) => Number(t.amount || 0) === 0).length}</p>
              <p className="text-xs text-muted-foreground">₹0 Kata charge</p>
            </CardContent></Card>
          </div>

          <Card className="border-border shadow-sm">
            <CardHeader className="border-b border-border/60">
              <CardTitle className="text-base font-bold">Payment Verification &amp; Signed Slip Delivery</CardTitle>
              <CardDescription className="text-xs">Verify the counter amount after second weight. Once verified, the signed Kata certificate is sent to the driver on WhatsApp.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Ticket</TableHead><TableHead>Vehicle</TableHead><TableHead>Driver mobile</TableHead><TableHead className="text-right">Net weight</TableHead><TableHead className="text-right">Kata charge</TableHead><TableHead>Payment</TableHead><TableHead>WhatsApp slip</TableHead><TableHead className="text-right">Action</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {completedTickets.map((ticket) => {
                    const free = Number(ticket.amount || 0) === 0;
                    const verified = Boolean(ticket.paidAt);
                    return <TableRow key={ticket.id}>
                      <TableCell className="font-mono font-bold text-primary">#{formatTicketNo(ticket.ticketNo)}</TableCell>
                      <TableCell className="font-mono font-bold">{ticket.vehicleNumber}{free && <Badge variant="outline" className="ml-2 border-sky-500/30 text-sky-700">KNM / FREE</Badge>}</TableCell>
                      <TableCell className="font-mono text-xs">{ticket.partyMobile || <span className="text-rose-600">Missing</span>}</TableCell>
                      <TableCell className="text-right font-mono">{Number(ticket.netWeightKg || 0).toLocaleString('en-IN')} kg</TableCell>
                      <TableCell className="text-right font-mono font-bold">₹{Number(ticket.amount || 0).toLocaleString('en-IN')}</TableCell>
                      <TableCell>{verified ? <Badge className="bg-emerald-600"><BadgeCheck className="mr-1 h-3 w-3" />{free ? 'FREE VERIFIED' : 'PAID'}</Badge> : <Badge variant="secondary">{free ? 'NO PAYMENT' : ticket.billType === 'CREDIT' ? 'CREDIT' : 'PENDING'}</Badge>}</TableCell>
                      <TableCell>{ticket.slipWhatsappSentAt ? <span className="text-xs font-semibold text-emerald-700">Sent {new Date(ticket.slipWhatsappSentAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span> : <span className="text-xs text-muted-foreground">Not sent</span>}</TableCell>
                      <TableCell className="text-right">
                        {verified ? <Button variant="ghost" size="sm" onClick={() => setSlipModalTicket(ticket)} className="h-8 gap-1 text-xs"><Printer className="h-3.5 w-3.5" />View slip</Button> : <Button size="sm" onClick={() => { setPaymentTarget(ticket); setPaymentReference(free ? 'FREE' : 'CASH'); }} className="h-8 gap-1 text-xs"><Banknote className="h-3.5 w-3.5" />{free ? 'Release Free Slip' : `Pay ₹${Number(ticket.amount || 0).toLocaleString('en-IN')}`}</Button>}
                      </TableCell>
                    </TableRow>;
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          TAB 4: TICKET REGISTER & HISTORY
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
                <ExportButtons
                  filename="weighbridge-ticket-register"
                  title="Weighbridge Ticket Register"
                  subtitle={historySearch ? `Search: ${historySearch}` : 'All tickets'}
                  columns={TICKET_EXPORT_COLUMNS}
                  rows={exportTickets}
                  showPrint={false}
                  size="sm"
                />
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
                  <TableHead className="text-right">Charge</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allTickets.map((t) => (
                  <TableRow key={t.id} className="hover:bg-muted/30">
                    <TableCell className="font-mono font-bold text-primary">
                      #{formatTicketNo(t.ticketNo)}
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
                      {ticketTransferRoute(t) || t.partyName || '-'}
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
                    <TableCell className="text-right font-mono font-bold text-xs">
                      ₹{Number(t.amount || 0).toLocaleString('en-IN')}
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
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => startEditingTicket(t)}
                          className="h-7 px-2 text-xs gap-1" title="Edit saved ticket">
                          <Pencil className="h-3.5 w-3.5 text-amber-600" />
                          Edit
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(t)}
                          className="h-7 px-2 text-xs gap-1 text-destructive hover:text-destructive" title="Delete ticket">
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setSlipModalTicket(t);
                            // Resolve stored URLs to absolute cloud URLs for reliable reprint
                            const resolvePrintUrl = (url?: string | null) => {
                              if (!url) return undefined;
                              if (url.startsWith('data:') || url.startsWith('http://') || url.startsWith('https://')) return url;
                              if (url.startsWith('/api/')) return `https://rvp-server.onrender.com${url}`;
                              return url;
                            };
                            setActiveSnapshots({
                              cam1: resolvePrintUrl(t.secondCam1PhotoUrl || t.cam1PhotoUrl),
                              cam2: resolvePrintUrl(t.secondCam2PhotoUrl || t.cam2PhotoUrl),
                            });
                          }}
                          className="h-7 px-2 text-xs gap-1"
                          title="Print Weighment Certificate Slip"
                        >
                          <Printer className="h-3.5 w-3.5 text-primary" />
                          Slip
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={editingTicket !== null} onOpenChange={(open) => !open && setEditingTicket(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit saved Kata ticket</DialogTitle>
            <DialogDescription>
              Correct either weight or any ticket detail. Net weight and the Kata charge are recalculated automatically.
            </DialogDescription>
          </DialogHeader>
          {editingTicket && (
            <div className="space-y-5 pt-2">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Vehicle number</Label>
                  <Combobox options={vehicleOptions} value={editingTicket.vehicleNumber}
                    onChange={(value) => setEditingTicket((d) => d ? { ...d, vehicleNumber: value.toUpperCase() } : d)}
                    searchPlaceholder="Search or enter vehicle…" allowCustomValue customValueLabel="Use vehicle" />
                </div>
                <div className="space-y-1.5">
                  <Label>Party name</Label>
                  <Combobox options={partyOptions} value={editingTicket.partyName}
                    onChange={(value) => setEditingTicket((d) => d ? { ...d, partyName: value } : d)}
                    searchPlaceholder="Search or enter party…" allowCustomValue customValueLabel="Use party" />
                </div>
                <div className="space-y-1.5">
                  <Label>First weight (kg)</Label>
                  <Input type="number" min="1" value={editingTicket.firstWeightKg}
                    onChange={(e) => setEditingTicket((d) => d ? { ...d, firstWeightKg: e.target.value } : d)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Second weight (kg)</Label>
                  <Input type="number" min="1" value={editingTicket.secondWeightKg}
                    onChange={(e) => setEditingTicket((d) => d ? { ...d, secondWeightKg: e.target.value } : d)}
                    placeholder="Awaiting second weight" />
                </div>
                <div className="space-y-1.5">
                  <Label>Vehicle type</Label>
                  <Combobox options={VEHICLE_TYPES} value={editingTicket.vehicleType}
                    onChange={(value) => setEditingTicket((d) => d ? { ...d, vehicleType: value } : d)} searchPlaceholder="Search vehicle type…" />
                </div>
                <div className="space-y-1.5">
                  <Label>Trip type</Label>
                  <Combobox options={TRIP_TYPE_OPTIONS} value={editingTicket.tripType}
                    onChange={(value) => setEditingTicket((d) => d ? { ...d, tripType: value } : d)} searchPlaceholder="Search trip type…" />
                </div>
                <div className="space-y-1.5">
                  <Label>Material</Label>
                  <Combobox options={MATERIALS.map((m) => ({ value: m, label: m }))} value={editingTicket.material}
                    onChange={(value) => setEditingTicket((d) => d ? { ...d, material: value } : d)} searchPlaceholder="Search material…" />
                </div>
                <div className="space-y-1.5">
                  <Label>Load condition</Label>
                  <Combobox options={LOAD_TYPE_OPTIONS} value={editingTicket.loadType}
                    onChange={(value) => setEditingTicket((d) => d ? { ...d, loadType: value } : d)} searchPlaceholder="Search load condition…" />
                </div>
                <div className="space-y-1.5">
                  <Label>Payment type</Label>
                  <Combobox options={BILL_TYPE_OPTIONS} value={editingTicket.billType}
                    onChange={(value) => setEditingTicket((d) => d ? { ...d, billType: value } : d)} searchPlaceholder="Search payment type…" />
                </div>
                <div className="space-y-1.5">
                  <Label>Driver mobile</Label>
                  <Input value={editingTicket.partyMobile} maxLength={10}
                    onChange={(e) => setEditingTicket((d) => d ? { ...d, partyMobile: e.target.value } : d)} />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Remarks</Label>
                  <Input value={editingTicket.remarks}
                    onChange={(e) => setEditingTicket((d) => d ? { ...d, remarks: e.target.value } : d)} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Recalculated net weight</p>
                  <p className="mt-1 font-mono text-xl font-black">{editPreview.net == null ? 'Pending' : `${editPreview.net.toLocaleString('en-IN')} kg`}</p>
                </div>
                <div className="text-right">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Collect at counter</p>
                  <p className="mt-1 font-mono text-xl font-black text-primary">₹{editPreview.fee.toLocaleString('en-IN')}</p>
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setEditingTicket(null)}>Cancel</Button>
                <Button onClick={() => editMutation.mutate(editingTicket)} disabled={editMutation.isPending || !editingTicket.vehicleNumber.trim() || !editingTicket.firstWeightKg}>
                  {editMutation.isPending ? 'Saving…' : 'Save corrections'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Kata ticket #{formatTicketNo(deleteTarget?.ticketNo)}?</DialogTitle>
            <DialogDescription>
              This permanently removes the ticket from the register. It will no longer be available for Stock In, Stock In Detail, or Dispatch auto-fill.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">Vehicle</span><span className="font-mono font-semibold">{deleteTarget?.vehicleNumber}</span></div>
            <div className="mt-1 flex justify-between gap-3"><span className="text-muted-foreground">Party / Route</span><span className="text-right font-medium">{deleteTarget ? (ticketTransferRoute(deleteTarget) || deleteTarget.partyName || '-') : '-'}</span></div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleteMutation.isPending}>Cancel</Button>
            <Button variant="destructive" onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)} disabled={deleteMutation.isPending}>
              <Trash2 className="h-4 w-4" /> {deleteMutation.isPending ? 'Deleting…' : 'Delete ticket'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={paymentTarget !== null} onOpenChange={(open) => !open && setPaymentTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {Number(paymentTarget?.amount || 0) === 0
                ? `Release Free Slip #${formatTicketNo(paymentTarget?.ticketNo)}`
                : `Verify Payment #${formatTicketNo(paymentTarget?.ticketNo)}`}
            </DialogTitle>
            <DialogDescription>
              Confirm weighment fee receipt and send the signed Kata slip to the driver via WhatsApp.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2 text-sm">
            <div className="flex justify-between rounded-lg border bg-muted/40 p-3">
              <span className="text-muted-foreground">Vehicle</span>
              <span className="font-mono font-bold">{paymentTarget?.vehicleNumber}</span>
            </div>
            <div className="flex justify-between rounded-lg border bg-muted/40 p-3">
              <span className="text-muted-foreground">Kata Charge</span>
              <span className="font-mono font-bold text-base text-primary">
                ₹{Number(paymentTarget?.amount || 0).toLocaleString('en-IN')}
              </span>
            </div>
            {Number(paymentTarget?.amount || 0) > 0 && (
              <div className="space-y-1.5">
                <Label>Payment Mode / Reference</Label>
                <Input
                  value={paymentReference}
                  onChange={(e) => setPaymentReference(e.target.value)}
                  placeholder="CASH / UPI / UTR"
                />
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPaymentTarget(null)} disabled={paymentMutation.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => paymentTarget && paymentMutation.mutate(paymentTarget)}
              disabled={paymentMutation.isPending}
            >
              <Banknote className="h-4 w-4 mr-1" />
              {paymentMutation.isPending ? 'Verifying…' : 'Confirm & Release'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Official Printable Weighbridge Slip Modal */}
      <WeighbridgeSlipModal
        ticket={slipModalTicket}
        companyProfile={companyProfile}
        snapshots={activeSnapshots}
        cabinMode={cabinMode}
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
            <div className={cn(
              'p-3 rounded-lg border text-xs flex items-start gap-2.5',
              bothCamerasOnline
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-800 dark:text-emerald-300'
                : 'bg-rose-500/10 border-rose-500/30 text-rose-800 dark:text-rose-300'
            )}>
              {bothCamerasOnline
                ? <ShieldCheck className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
                : <CloudOff className="h-4 w-4 text-rose-500 shrink-0 mt-0.5" />}
              <div>
                <span className="font-bold">{bothCamerasOnline ? 'CCTV cloud relay active:' : 'CCTV cloud relay offline:'}</span>{' '}
                {bothCamerasOnline
                  ? 'Both cabin cameras are sending fresh frames to the ERP cloud, so remote ticket snapshots are available.'
                  : 'The cloud is not receiving fresh frames from both cameras. Check the cabin bridge status before relying on remote snapshots.'}
              </div>
            </div>

            <div className="space-y-3">
              {/* Cam 1 */}
              <div className="p-3 rounded-lg border border-border bg-card/60 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs flex items-center gap-2">
                    <span className={cn('h-2 w-2 rounded-full', cctvStatus?.cam1.online ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500')} />
                    CAM 1: ENTRY (192.168.1.101)
                  </span>
                  <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/30">
                    {cctvStatus?.cam1.online ? 'Cloud relay online' : 'Offline'}
                  </Badge>
                </div>
                <div className="space-y-1">
                  <div className="text-[11px] font-mono text-muted-foreground">RTSP Substream (Live Preview):</div>
                  <div className="p-1.5 rounded bg-muted/70 text-[10px] font-mono select-all break-all">
                    Configured locally in the signed Kata Cabin bridge
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-[11px] font-mono text-muted-foreground">RTSP Mainstream (HD Ticket Photo):</div>
                  <div className="p-1.5 rounded bg-muted/70 text-[10px] font-mono select-all break-all">
                    Access is restricted to the cabin LAN
                  </div>
                </div>
              </div>

              {/* Cam 2 */}
              <div className="p-3 rounded-lg border border-border bg-card/60 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs flex items-center gap-2">
                    <span className={cn('h-2 w-2 rounded-full', cctvStatus?.cam2.online ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500')} />
                    CAM 2: EXIT (192.168.1.102)
                  </span>
                  <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/30">
                    {cctvStatus?.cam2.online ? 'Cloud relay online' : 'Offline'}
                  </Badge>
                </div>
                <div className="space-y-1">
                  <div className="text-[11px] font-mono text-muted-foreground">RTSP Substream (Live Preview):</div>
                  <div className="p-1.5 rounded bg-muted/70 text-[10px] font-mono select-all break-all">
                    Configured locally in the signed Kata Cabin bridge
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-[11px] font-mono text-muted-foreground">RTSP Mainstream (HD Ticket Photo):</div>
                  <div className="p-1.5 rounded bg-muted/70 text-[10px] font-mono select-all break-all">
                    Access is restricted to the cabin LAN
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
