import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Printer, Sliders, FileText, Layers } from 'lucide-react';
import type { WeighbridgeTicket, CompanyProfile } from '@/lib/types';
import { cn } from '@/lib/utils';

interface WeighbridgeSlipModalProps {
  ticket: WeighbridgeTicket | null;
  companyProfile?: CompanyProfile | null;
  snapshots?: { cam1?: string; cam2?: string } | null;
  onClose: () => void;
}

const STORAGE_CALIBRATION_KEY = 'rvp_kata_printer_calibration_v1';

interface PrinterCalibration {
  offsetXmm: number;
  offsetYmm: number;
  printMode: 'stationery' | 'plain'; // 'stationery' = only values/photos on pre-printed paper; 'plain' = full artwork
}

export default function WeighbridgeSlipModal({
  ticket,
  companyProfile: _companyProfile,
  snapshots,
  onClose,
}: WeighbridgeSlipModalProps) {
  const [calibration, setCalibration] = useState<PrinterCalibration>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_CALIBRATION_KEY);
      if (saved) return JSON.parse(saved);
    } catch {}
    return {
      offsetXmm: 0,
      offsetYmm: 0,
      printMode: 'stationery',
    };
  });

  const [showCalibrationBar, setShowCalibrationBar] = useState<boolean>(false);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_CALIBRATION_KEY, JSON.stringify(calibration));
    } catch {}
  }, [calibration]);

  if (!ticket) return null;

  const handlePrint = () => {
    window.print();
  };

  // Extract / calculate weights
  const firstWeight = ticket.firstWeightKg ?? null;
  const secondWeight = ticket.secondWeightKg ?? null;

  let grossWeight: number | null = null;
  let tareWeight: number | null = null;
  let netWeight = ticket.netWeightKg ?? null;

  if (firstWeight != null && secondWeight != null) {
    grossWeight = Math.max(firstWeight, secondWeight);
    tareWeight = Math.min(firstWeight, secondWeight);
    netWeight = grossWeight - tareWeight;
  } else if (firstWeight != null && netWeight == null) {
    if (ticket.tripType === 'SINGLE') {
      grossWeight = firstWeight;
      netWeight = firstWeight;
    } else if (ticket.loadType === 'LOAD') {
      grossWeight = firstWeight;
    } else {
      tareWeight = firstWeight;
    }
  }

  // Format Date (DD-MM-YYYY)
  const ticketDateObj = new Date(ticket.createdAt);
  const day = String(ticketDateObj.getDate()).padStart(2, '0');
  const month = String(ticketDateObj.getMonth() + 1).padStart(2, '0');
  const year = ticketDateObj.getFullYear();
  const formattedDate = `${day}-${month}-${year}`;

  // Format Time (hh:mm:ss AM/PM)
  const formattedTime = ticketDateObj.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });

  const isStationeryMode = calibration.printMode === 'stationery';

  return (
    <Dialog open={!!ticket} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-4xl p-0 overflow-hidden print:m-0 print:p-0 print:border-none print:shadow-none bg-background text-foreground">
        {/* Top Modal Controls Header (Hidden in Print) */}
        <div className="p-4 border-b border-border bg-card/60 flex flex-wrap items-center justify-between gap-3 print:hidden">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center font-bold">
              #{ticket.ticketNo}
            </div>
            <div>
              <DialogTitle className="text-sm font-bold text-foreground">
                Weighment Slip #{ticket.ticketNo} ({ticket.vehicleNumber})
              </DialogTitle>
              <p className="text-[11px] text-muted-foreground">
                Official Kata Weighment Certificate & Camera Verification
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Print Mode Selector */}
            <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5 text-xs font-medium">
              <button
                type="button"
                onClick={() => setCalibration((c) => ({ ...c, printMode: 'stationery' }))}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-all',
                  isStationeryMode
                    ? 'bg-background text-primary font-semibold shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                title="Prints only dynamic values & CCTV photos on your physical pre-printed stationery"
              >
                <Layers className="h-3.5 w-3.5 text-amber-500" />
                Pre-Printed Slip
              </button>
              <button
                type="button"
                onClick={() => setCalibration((c) => ({ ...c, printMode: 'plain' }))}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-all',
                  !isStationeryMode
                    ? 'bg-background text-primary font-semibold shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                title="Prints full duplicate with RVP logo, orange borders and text onto blank paper"
              >
                <FileText className="h-3.5 w-3.5 text-emerald-500" />
                Plain Paper
              </button>
            </div>

            {/* Calibration Toggle */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCalibrationBar((s) => !s)}
              className={cn('h-8 gap-1.5 text-xs font-medium', showCalibrationBar && 'border-primary text-primary')}
            >
              <Sliders className="h-3.5 w-3.5" />
              Adjust Alignment
            </Button>

            {/* Main Print Button */}
            <Button
              size="sm"
              onClick={handlePrint}
              className="h-8 gap-1.5 font-semibold bg-primary hover:bg-primary/90 text-primary-foreground shadow-xs"
            >
              <Printer className="h-3.5 w-3.5" />
              Print Slip (F12)
            </Button>
          </div>
        </div>

        {/* Alignment Nudge Toolbar (Hidden in Print) */}
        {showCalibrationBar && (
          <div className="px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 flex flex-wrap items-center justify-between text-xs gap-3 print:hidden">
            <div className="flex items-center gap-1 text-amber-800 dark:text-amber-300 font-medium">
              <Sliders className="h-3.5 w-3.5" />
              <span>Printer Alignment Fine-Tuning:</span>
              <span className="text-[11px] text-muted-foreground font-normal">
                (Nudge data if your printer feeder has a 1–2mm shift)
              </span>
            </div>

            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground font-mono">X (H):</span>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-6 w-6 text-xs"
                  onClick={() => setCalibration((c) => ({ ...c, offsetXmm: c.offsetXmm - 1 }))}
                >
                  -
                </Button>
                <span className="font-mono font-bold w-10 text-center">{calibration.offsetXmm} mm</span>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-6 w-6 text-xs"
                  onClick={() => setCalibration((c) => ({ ...c, offsetXmm: c.offsetXmm + 1 }))}
                >
                  +
                </Button>
              </div>

              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground font-mono">Y (V):</span>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-6 w-6 text-xs"
                  onClick={() => setCalibration((c) => ({ ...c, offsetYmm: c.offsetYmm - 1 }))}
                >
                  -
                </Button>
                <span className="font-mono font-bold w-10 text-center">{calibration.offsetYmm} mm</span>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-6 w-6 text-xs"
                  onClick={() => setCalibration((c) => ({ ...c, offsetYmm: c.offsetYmm + 1 }))}
                >
                  +
                </Button>
              </div>

              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => setCalibration((c) => ({ ...c, offsetXmm: 0, offsetYmm: 0 }))}
              >
                Reset (0,0)
              </Button>
            </div>
          </div>
        )}

        {/* Modal Body / Print Preview Container */}
        <div className="p-4 sm:p-6 overflow-auto bg-stone-200/60 dark:bg-stone-950/60 flex items-center justify-center print:p-0 print:bg-transparent">
          {/* Print Stylesheet Injector */}
          <style>{`
            @page {
              size: 210mm 148mm; /* A5 Landscape / Indian Weighbridge Stationery */
              margin: 0;
            }
            @media print {
              body {
                background: #ffffff !important;
                color: #000000 !important;
                margin: 0 !important;
                padding: 0 !important;
              }
              body * {
                visibility: hidden;
              }
              #rvp-kata-print-container,
              #rvp-kata-print-container * {
                visibility: visible;
              }
              #rvp-kata-print-container {
                position: absolute !important;
                left: 0 !important;
                top: 0 !important;
                width: 210mm !important;
                height: 148mm !important;
                box-shadow: none !important;
                border: none !important;
                margin: 0 !important;
                background: #ffffff !important;
              }
              /* Hide static pre-printed artwork if printing on stationery */
              ${isStationeryMode ? `
                .rvp-stationery-artwork {
                  display: none !important;
                  visibility: hidden !important;
                }
              ` : ''}
            }
          `}</style>

          {/* 
            Exact Stationery Document Sheet
            Standard Landscape dimensions: 210mm x 148mm (A5 Landscape)
          */}
          <div
            id="rvp-kata-print-container"
            style={{
              width: '210mm',
              height: '148mm',
              transform: `translate(${calibration.offsetXmm}mm, ${calibration.offsetYmm}mm)`,
            }}
            className="relative bg-white text-black font-sans box-border shadow-xl rounded-sm print:rounded-none select-text overflow-hidden"
          >
            {/* ═════════════════════════════════════════════════════════════════
                LAYER 1: PRE-PRINTED STATIONERY ARTWORK 
                (Orange frames, Ganesha, RVP header, Address, 100 TON, labels)
                - In 'plain' mode: fully opaque and printed.
                - In 'stationery' mode: printed as HIDDEN, shown on-screen with 20% opacity as watermark guide.
               ═════════════════════════════════════════════════════════════════ */}
            <div
              className={cn(
                'rvp-stationery-artwork absolute inset-0 pointer-events-none p-3',
                isStationeryMode && 'opacity-25 print:hidden'
              )}
            >
              {/* Outer decorative double red/orange border */}
              <div className="w-full h-full border-2 border-red-600 rounded-lg p-1 relative flex flex-col justify-between">
                
                {/* Header Row */}
                <div className="flex items-center justify-between px-2 pt-0.5">
                  {/* Ganesha Sacred Motif */}
                  <div className="w-16 h-16 shrink-0 flex items-center justify-center">
                    <svg viewBox="0 0 100 100" className="w-14 h-14 text-red-600 fill-current">
                      <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" strokeWidth="3" />
                      <circle cx="50" cy="50" r="41" fill="none" stroke="#eab308" strokeWidth="1.5" />
                      <path d="M50 20 C42 20 38 28 38 35 C38 45 44 48 44 58 C44 65 48 70 52 70 C56 70 58 65 58 60 C58 52 64 45 64 35 C64 28 58 20 50 20 Z" />
                      <circle cx="43" cy="33" r="2.5" fill="#eab308" />
                      <circle cx="57" cy="33" r="2.5" fill="#eab308" />
                      <path d="M50 24 L50 34 M46 27 L54 27" stroke="#eab308" strokeWidth="1.5" />
                    </svg>
                  </div>

                  {/* Center Title & Government Approved */}
                  <div className="text-center flex-1 px-2">
                    <h1 className="text-[21px] font-black tracking-tight text-red-700 leading-tight uppercase font-serif">
                      RVP WEIGH BRIDGE
                    </h1>
                    <div className="inline-block bg-yellow-400 text-black px-2.5 py-0.2 rounded-full text-[9px] font-black uppercase tracking-wider border border-yellow-500 shadow-2xs">
                      GOVT APPROVED
                    </div>
                    <p className="text-[9.5px] font-semibold text-zinc-800 leading-snug mt-0.5">
                      3/86, New By-Pass Road, Near Rajuluru, BG Palli, PUNGANUR - 517 247, Chittoor Dist., A.P.
                    </p>
                    <p className="text-[9.5px] font-bold text-zinc-900 tracking-wide">
                      Ph : 91215 53909, 94909 21002
                    </p>
                  </div>

                  {/* 24 Hrs Service Badge */}
                  <div className="w-16 shrink-0 flex flex-col items-center justify-center">
                    <div className="w-13 h-13 rounded-full border-2 border-zinc-900 flex flex-col items-center justify-center p-0.5 bg-zinc-50">
                      <span className="text-[13px] font-black leading-none">24</span>
                      <span className="text-[8px] font-bold uppercase tracking-tight">Hrs</span>
                      <span className="text-[6.5px] font-bold bg-zinc-900 text-white px-1 rounded-xs uppercase mt-0.5">SERVICE</span>
                    </div>
                  </div>
                </div>

                {/* Metadata 3-Boxes Ribbon Outline */}
                <div className="grid grid-cols-12 gap-2 px-1 mt-1">
                  <div className="col-span-3 border border-red-500 rounded-md h-9 overflow-hidden flex flex-col">
                    <div className="bg-yellow-400/90 text-red-900 text-[8.5px] font-black text-center py-0.5 uppercase border-b border-red-400">
                      S. No.
                    </div>
                  </div>
                  <div className="col-span-5 border border-red-500 rounded-md h-9 overflow-hidden flex flex-col">
                    <div className="bg-yellow-400/90 text-red-900 text-[8.5px] font-black text-center py-0.5 uppercase border-b border-red-400">
                      DATE
                    </div>
                  </div>
                  <div className="col-span-4 border border-red-500 rounded-md h-9 overflow-hidden flex flex-col">
                    <div className="bg-yellow-400/90 text-red-900 text-[8.5px] font-black text-center py-0.5 uppercase border-b border-red-400">
                      TIME
                    </div>
                  </div>
                </div>

                {/* Two Photo Frames Outline */}
                <div className="grid grid-cols-2 gap-2 px-1 mt-1 h-[47mm]">
                  <div className="border-2 border-red-500 rounded-lg overflow-hidden flex items-center justify-center bg-red-50/20" />
                  <div className="border-2 border-red-500 rounded-lg overflow-hidden flex items-center justify-center bg-red-50/20" />
                </div>

                {/* Data Grid Outline with Orange Header Bars */}
                <div className="grid grid-cols-12 gap-2 px-1 mt-1 text-[9px]">
                  {/* Column 1: Vehicle & Party */}
                  <div className="col-span-5 space-y-1">
                    <div className="border border-red-500 rounded-md overflow-hidden">
                      <div className="bg-gradient-to-r from-red-600 to-orange-500 text-white font-bold text-[8px] px-2 py-0.5 uppercase text-center">
                        Vehicle No.
                      </div>
                      <div className="h-6" />
                    </div>
                    <div className="border border-red-500 rounded-md overflow-hidden">
                      <div className="bg-gradient-to-r from-red-600 to-orange-500 text-white font-bold text-[8px] px-2 py-0.5 uppercase text-center">
                        Party Name
                      </div>
                      <div className="h-6" />
                    </div>
                    <div className="border border-red-500 rounded-md overflow-hidden">
                      <div className="bg-gradient-to-r from-red-600 to-orange-500 text-white font-bold text-[8px] px-2 py-0.5 uppercase text-center">
                        Material
                      </div>
                      <div className="h-6" />
                    </div>
                  </div>

                  {/* Column 2: Weights Breakdown */}
                  <div className="col-span-4 space-y-1">
                    <div className="border border-red-500 rounded-md overflow-hidden">
                      <div className="bg-gradient-to-r from-red-600 to-orange-500 text-white font-bold text-[8px] px-2 py-0.5 uppercase text-center">
                        1st Weight
                      </div>
                      <div className="h-6" />
                    </div>
                    <div className="border border-red-500 rounded-md overflow-hidden">
                      <div className="bg-gradient-to-r from-red-600 to-orange-500 text-white font-bold text-[8px] px-2 py-0.5 uppercase text-center">
                        2nd Weight
                      </div>
                      <div className="h-6" />
                    </div>
                    <div className="border border-red-500 rounded-md overflow-hidden">
                      <div className="bg-gradient-to-r from-red-600 to-orange-500 text-white font-bold text-[8px] px-2 py-0.5 uppercase text-center">
                        Charges
                      </div>
                      <div className="h-6" />
                    </div>
                  </div>

                  {/* Column 3: Net Weight & Signature */}
                  <div className="col-span-3 space-y-1">
                    <div className="border border-red-500 rounded-md overflow-hidden">
                      <div className="bg-gradient-to-r from-red-600 to-orange-500 text-white font-bold text-[8px] px-2 py-0.5 uppercase text-center">
                        Net Weight
                      </div>
                      <div className="h-6" />
                    </div>
                    <div className="border border-red-500 rounded-md overflow-hidden">
                      <div className="bg-gradient-to-r from-red-600 to-orange-500 text-white font-bold text-[8px] px-2 py-0.5 uppercase text-center">
                        Signature
                      </div>
                      <div className="h-14" />
                    </div>
                  </div>
                </div>

                {/* Footer Strip */}
                <div className="flex items-center justify-between px-2 pt-0.5 text-[8.5px]">
                  <div className="flex items-center gap-2">
                    <div className="bg-red-700 text-white font-black px-2 py-0.5 rounded-xs text-[10px] tracking-wider">
                      100 TON
                    </div>
                    <span className="text-[7.5px] text-zinc-700 font-semibold">
                      Weigh Bridge Manufactured by : Sri Modern Weigh System. Cell 98430 55760
                    </span>
                  </div>
                  <div className="font-black text-red-700 tracking-wider text-[10px]">
                    THANK YOU! VISIT AGAIN!
                  </div>
                </div>

              </div>
            </div>

            {/* ═════════════════════════════════════════════════════════════════
                LAYER 2: DYNAMIC VALUES & CCTV CAMERA PHOTOS
                - Positioned with absolute millimeter coordinates to align 
                  directly into the physical pre-printed boxes.
                - Printed in sharp black text & crisp uncompressed photos!
               ═════════════════════════════════════════════════════════════════ */}
            <div className="absolute inset-0 p-3 pointer-events-none">
              {/* Metadata Row Values */}
              <div className="absolute top-[28mm] left-[6mm] w-[45mm] h-[8mm] flex items-center justify-center">
                <span className="font-mono font-black text-sm text-black tracking-wider">
                  {ticket.ticketNo}
                </span>
              </div>

              <div className="absolute top-[28mm] left-[54mm] w-[80mm] h-[8mm] flex items-center justify-center">
                <span className="font-mono font-black text-xs text-black tracking-wider">
                  {formattedDate}
                </span>
              </div>

              <div className="absolute top-[28mm] left-[138mm] w-[65mm] h-[8mm] flex items-center justify-center">
                <span className="font-mono font-black text-xs text-black tracking-wider">
                  {formattedTime}
                </span>
              </div>

              {/* Photos Zone */}
              <div className="absolute top-[37.5mm] left-[6mm] w-[96mm] h-[46mm] rounded-lg overflow-hidden bg-black flex items-center justify-center">
                {snapshots?.cam1 ? (
                  <img
                    src={snapshots.cam1}
                    alt="Cam 1 Entry"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="text-[10px] text-zinc-400 font-mono text-center">
                    [CP PLUS CAM 1 - ENTRY]
                  </div>
                )}
                {/* OSD Stamp inside camera photo matching CP PLUS photo */}
                <div className="absolute bottom-1 left-1.5 bg-black/60 text-white font-mono text-[8px] px-1 py-0.2 rounded-xs pointer-events-none">
                  CP IP Cam 1 · {formattedDate} {formattedTime}
                </div>
              </div>

              <div className="absolute top-[37.5mm] left-[106mm] w-[96mm] h-[46mm] rounded-lg overflow-hidden bg-black flex items-center justify-center">
                {snapshots?.cam2 ? (
                  <img
                    src={snapshots.cam2}
                    alt="Cam 2 Exit"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="text-[10px] text-zinc-400 font-mono text-center">
                    [CP PLUS CAM 2 - EXIT]
                  </div>
                )}
                {/* OSD Stamp inside camera photo matching CP PLUS photo */}
                <div className="absolute bottom-1 left-1.5 bg-black/60 text-white font-mono text-[8px] px-1 py-0.2 rounded-xs pointer-events-none">
                  CP IP Cam 2 · {formattedDate} {formattedTime}
                </div>
              </div>

              {/* Column 1 Data: Vehicle No, Party Name, Material */}
              <div className="absolute top-[88.5mm] left-[6mm] w-[77mm] h-[10mm] flex items-center justify-center px-2">
                <span className="font-mono font-black text-base text-black tracking-widest uppercase truncate">
                  {ticket.vehicleNumber}
                </span>
              </div>

              <div className="absolute top-[101.5mm] left-[6mm] w-[77mm] h-[10mm] flex items-center justify-center px-2">
                <span className="font-sans font-black text-xs text-black tracking-wide uppercase truncate">
                  {ticket.partyName || '-'}
                </span>
              </div>

              <div className="absolute top-[114.5mm] left-[6mm] w-[77mm] h-[10mm] flex items-center justify-center px-2">
                <span className="font-sans font-black text-xs text-black tracking-wider uppercase truncate">
                  {ticket.material || '-'}
                </span>
              </div>

              {/* Column 2 Data: 1st Weight, 2nd Weight, Charges */}
              <div className="absolute top-[88.5mm] left-[87mm] w-[63mm] h-[10mm] flex items-center justify-center px-2">
                <span className="font-mono font-black text-sm text-black tracking-wider">
                  {firstWeight != null ? `${firstWeight.toLocaleString('en-IN')} Kg` : '-'}
                </span>
              </div>

              <div className="absolute top-[101.5mm] left-[87mm] w-[63mm] h-[10mm] flex items-center justify-center px-2">
                <span className="font-mono font-black text-sm text-black tracking-wider">
                  {secondWeight != null ? `${secondWeight.toLocaleString('en-IN')} Kg` : (ticket.tripType === 'FIRST' ? '-' : `${firstWeight?.toLocaleString('en-IN') || 0} Kg`)}
                </span>
              </div>

              <div className="absolute top-[114.5mm] left-[87mm] w-[63mm] h-[10mm] flex items-center justify-center px-2">
                <span className="font-mono font-black text-sm text-black tracking-wide">
                  ₹ {Number(ticket.amount || 0).toFixed(2)}
                </span>
              </div>

              {/* Column 3 Data: Net Weight & Signature */}
              <div className="absolute top-[88.5mm] left-[153mm] w-[50mm] h-[10mm] flex items-center justify-center px-1">
                <span className="font-mono font-black text-base text-black tracking-tight">
                  {netWeight != null ? `${netWeight.toLocaleString('en-IN')} Kg` : '-'}
                </span>
              </div>

              <div className="absolute top-[102mm] left-[153mm] w-[50mm] h-[22mm] flex items-end justify-center pb-1">
                <span className="text-[9px] font-mono text-zinc-400">
                  {ticket.operatorName || 'OPERATOR'}
                </span>
              </div>

            </div>
          </div>
        </div>

        {/* Modal Bottom Footer / Hints (Hidden in Print) */}
        <div className="p-3 bg-card/40 border-t border-border flex items-center justify-between text-xs text-muted-foreground print:hidden">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
            <span>
              {isStationeryMode
                ? 'Printing in Stationery Overlay Mode (Only photos & text will print on your pre-printed stationery)'
                : 'Printing Full Duplicate (Complete slip with logo, address & orange borders will print on plain paper)'}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-[11px] font-mono">
              Paper: A5 Landscape (210×148mm)
            </span>
            <Button variant="ghost" size="sm" onClick={onClose} className="h-7 text-xs">
              Done
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
