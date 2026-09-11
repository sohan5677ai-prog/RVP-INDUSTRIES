import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Printer, Sliders, FileText, Layers, Eye, EyeOff, Video } from 'lucide-react';
import type { WeighbridgeTicket, CompanyProfile } from '@/lib/types';
import { cn } from '@/lib/utils';

interface WeighbridgeSlipModalProps {
  ticket: WeighbridgeTicket | null;
  companyProfile?: CompanyProfile | null;
  snapshots?: { cam1?: string; cam2?: string } | null;
  onClose: () => void;
}

const STORAGE_CALIBRATION_KEY = 'rvp_kata_printer_calibration_v4';

interface PrinterCalibration {
  offsetXmm: number;
  offsetYmm: number;
  printMode: 'stationery' | 'plain'; // 'stationery' = only 11 values/photos on pre-printed paper; 'plain' = full artwork
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
      printMode: 'stationery', // Default to pre-printed stationery
    };
  });

  const [showCalibrationBar, setShowCalibrationBar] = useState<boolean>(false);
  const [showScreenGuide, setShowScreenGuide] = useState<boolean>(true);

  // Camera images with automatic fallback to cloud/server relay
  const [cam1Url, setCam1Url] = useState<string | null>(null);
  const [cam2Url, setCam2Url] = useState<string | null>(null);
  const [cam1Failed, setCam1Failed] = useState(false);
  const [cam2Failed, setCam2Failed] = useState(false);

  useEffect(() => {
    setCam1Url(snapshots?.cam1 || '/api/weighbridge/cctv/snapshot?cam=1');
    setCam2Url(snapshots?.cam2 || '/api/weighbridge/cctv/snapshot?cam=2');
    setCam1Failed(false);
    setCam2Failed(false);
  }, [snapshots, ticket?.id]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_CALIBRATION_KEY, JSON.stringify(calibration));
    } catch {}
  }, [calibration]);

  if (!ticket) return null;

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

  // Helper to format weight strictly as '<weight>-Kg' matching the physical slip
  const formatWeight = (val: number | null | undefined): string => {
    if (val == null || isNaN(val)) return '-';
    return `${Math.round(val)}-Kg`;
  };

  // Format Material with dot prefix if needed (e.g. '.SEED')
  const formattedMaterial = ticket.material
    ? ticket.material.startsWith('.')
      ? ticket.material.toUpperCase()
      : `.${ticket.material.toUpperCase()}`
    : '-';

  // Format Charges as '₹ 1.00'
  const formattedCharges = `₹ ${Number(ticket.amount || 0).toFixed(2)}`;

  const isStationeryMode = calibration.printMode === 'stationery';

  // Isolated Single-Page Print Handler (Guarantees exactly 1 page in Chrome)
  const handlePrint = () => {
    // 1. Clean up any existing print iframe
    const oldIframe = document.getElementById('rvp-kata-print-frame');
    if (oldIframe) {
      oldIframe.remove();
    }

    // 2. Prepare HTML for printing
    const printDocHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Weighment Slip #${ticket.ticketNo}</title>
  <style>
    @page {
      size: 210mm 150mm;
      margin: 0;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    html, body {
      width: 210mm;
      height: 150mm;
      max-width: 210mm;
      max-height: 150mm;
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: #ffffff;
      color: #000000;
      font-family: Arial, Helvetica, sans-serif;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .sheet {
      position: absolute;
      top: 0;
      left: 0;
      width: 210mm;
      height: 150mm;
      max-width: 210mm;
      max-height: 150mm;
      overflow: hidden;
      transform: translate(${calibration.offsetXmm}mm, ${calibration.offsetYmm}mm);
    }
    .val {
      position: absolute;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      font-family: monospace, 'Courier New', Courier, sans-serif;
      font-weight: 900;
      color: #000000;
      line-height: 1;
      white-space: nowrap;
    }
    .val-sans {
      position: absolute;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      font-family: Arial, Helvetica, sans-serif;
      font-weight: 800;
      color: #000000;
      line-height: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cam-box {
      position: absolute;
      overflow: hidden;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f5f5f5;
    }
    .cam-box img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .cam-stamp {
      position: absolute;
      bottom: 2px;
      left: 4px;
      background: rgba(0,0,0,0.65);
      color: #ffffff;
      font-family: monospace;
      font-size: 8px;
      padding: 1px 4px;
      border-radius: 2px;
    }
  </style>
</head>
<body>
  <div class="sheet">
    ${!isStationeryMode ? `
      <!-- Plain paper duplicate borders and headers -->
      <div style="position: absolute; inset: 3mm; border: 2px solid #dc2626; border-radius: 8px; pointer-events: none;">
        <div style="position: absolute; top: 2mm; left: 0; right: 0; text-align: center;">
          <h1 style="font-size: 23px; font-weight: 900; color: #b91c1c; font-family: serif; text-transform: uppercase;">RVP WEIGH BRIDGE</h1>
          <div style="display: inline-block; background: #facc15; font-size: 9px; font-weight: 900; padding: 1px 10px; border-radius: 10px;">GOVT APPROVED</div>
          <p style="font-size: 9.5px; font-weight: 600; color: #27272a; margin-top: 2px;">3/86, New By-Pass Road, Near Rajuluru, BG Palli, PUNGANUR - 517 247, Chittoor Dist., A.P.</p>
          <p style="font-size: 9.5px; font-weight: 700; color: #18181b;">Ph : 91215 53909, 94909 21002</p>
        </div>
        <div style="position: absolute; top: 36mm; left: 2mm; width: 64mm; height: 8.5mm; border: 2px solid #f59e0b; border-radius: 6px; display: flex; align-items: center;">
          <div style="background: #fde047; color: #7f1d1d; font-size: 10px; font-weight: 900; padding: 0 8px; height: 100%; display: flex; align-items: center; border-right: 1px solid #f59e0b;">S. No.</div>
        </div>
        <div style="position: absolute; top: 36mm; left: 69mm; width: 60mm; height: 8.5mm; border: 2px solid #f59e0b; border-radius: 6px; display: flex; align-items: center;">
          <div style="background: #fde047; color: #7f1d1d; font-size: 10px; font-weight: 900; padding: 0 8px; height: 100%; display: flex; align-items: center; border-right: 1px solid #f59e0b;">DATE</div>
        </div>
        <div style="position: absolute; top: 36mm; left: 132mm; width: 63.5mm; height: 8.5mm; border: 2px solid #f59e0b; border-radius: 6px; display: flex; align-items: center;">
          <div style="background: #fde047; color: #7f1d1d; font-size: 10px; font-weight: 900; padding: 0 8px; height: 100%; display: flex; align-items: center; border-right: 1px solid #f59e0b;">TIME</div>
        </div>
        <div style="position: absolute; top: 46.5mm; left: 2mm; width: 95mm; height: 49mm; border: 2px solid #ef4444; border-radius: 8px;"></div>
        <div style="position: absolute; top: 46.5mm; left: 100.5mm; width: 95mm; height: 49mm; border: 2px solid #ef4444; border-radius: 8px;"></div>
        <div style="position: absolute; top: 97.5mm; left: 2mm; width: 46.5mm; height: 4.5mm; background: #dc2626; color: white; font-size: 8.5px; font-weight: bold; text-align: center; line-height: 4.5mm;">VEHICLE NO.</div>
        <div style="position: absolute; top: 97.5mm; left: 51mm; width: 46.5mm; height: 4.5mm; background: #dc2626; color: white; font-size: 8.5px; font-weight: bold; text-align: center; line-height: 4.5mm;">1ST WEIGHT</div>
        <div style="position: absolute; top: 97.5mm; left: 100mm; width: 46.5mm; height: 4.5mm; background: #dc2626; color: white; font-size: 8.5px; font-weight: bold; text-align: center; line-height: 4.5mm;">2ND WEIGHT</div>
        <div style="position: absolute; top: 97.5mm; left: 149mm; width: 46.5mm; height: 4.5mm; background: #dc2626; color: white; font-size: 8.5px; font-weight: bold; text-align: center; line-height: 4.5mm;">NET WEIGHT</div>
        <div style="position: absolute; top: 102mm; left: 2mm; width: 46.5mm; height: 9.5mm; border: 1px solid #ef4444; border-radius: 0 0 6px 6px;"></div>
        <div style="position: absolute; top: 102mm; left: 51mm; width: 46.5mm; height: 9.5mm; border: 1px solid #ef4444; border-radius: 0 0 6px 6px;"></div>
        <div style="position: absolute; top: 102mm; left: 100mm; width: 46.5mm; height: 9.5mm; border: 1px solid #ef4444; border-radius: 0 0 6px 6px;"></div>
        <div style="position: absolute; top: 102mm; left: 149mm; width: 46.5mm; height: 9.5mm; border: 1px solid #ef4444; border-radius: 0 0 6px 6px;"></div>
        <div style="position: absolute; top: 113.5mm; left: 2mm; width: 46.5mm; height: 4.5mm; background: #dc2626; color: white; font-size: 8.5px; font-weight: bold; text-align: center; line-height: 4.5mm;">PARTY NAME</div>
        <div style="position: absolute; top: 113.5mm; left: 51mm; width: 46.5mm; height: 4.5mm; background: #dc2626; color: white; font-size: 8.5px; font-weight: bold; text-align: center; line-height: 4.5mm;">MATERIAL</div>
        <div style="position: absolute; top: 113.5mm; left: 100mm; width: 46.5mm; height: 4.5mm; background: #dc2626; color: white; font-size: 8.5px; font-weight: bold; text-align: center; line-height: 4.5mm;">CHARGES</div>
        <div style="position: absolute; top: 113.5mm; left: 149mm; width: 46.5mm; height: 4.5mm; background: #dc2626; color: white; font-size: 8.5px; font-weight: bold; text-align: center; line-height: 4.5mm;">SIGNATURE</div>
        <div style="position: absolute; top: 118mm; left: 2mm; width: 46.5mm; height: 9.5mm; border: 1px solid #ef4444; border-radius: 0 0 6px 6px;"></div>
        <div style="position: absolute; top: 118mm; left: 51mm; width: 46.5mm; height: 9.5mm; border: 1px solid #ef4444; border-radius: 0 0 6px 6px;"></div>
        <div style="position: absolute; top: 118mm; left: 100mm; width: 46.5mm; height: 9.5mm; border: 1px solid #ef4444; border-radius: 0 0 6px 6px;"></div>
        <div style="position: absolute; top: 118mm; left: 149mm; width: 46.5mm; height: 9.5mm; border: 1px solid #ef4444; border-radius: 0 0 6px 6px;"></div>
        <div style="position: absolute; top: 130mm; left: 2mm; right: 2mm; display: flex; justify-content: space-between; font-size: 8.5px;">
          <div><span style="background: #b91c1c; color: white; font-weight: 900; padding: 2px 6px; font-size: 10px;">100 TON</span> <span style="font-size: 7.5px; color: #3f3f46; font-weight: 600;">Weigh Bridge Manufactured by : Sri Modern Weigh System. Cell 98430 55760</span></div>
          <div style="font-weight: 900; color: #b91c1c; font-size: 10px;">THANK YOU! VISIT AGAIN!!</div>
        </div>
      </div>
    ` : ''}

    <!-- 1. S. No. -->
    <div class="val" style="top: 36mm; left: 23mm; width: 45mm; height: 8.5mm; font-size: 16px; letter-spacing: 1px;">
      ${ticket.ticketNo}
    </div>

    <!-- 2. DATE -->
    <div class="val" style="top: 36mm; left: 89mm; width: 44mm; height: 8.5mm; font-size: 14px;">
      ${formattedDate}
    </div>

    <!-- 3. TIME -->
    <div class="val" style="top: 36mm; left: 154mm; width: 48mm; height: 8.5mm; font-size: 14px;">
      ${formattedTime}
    </div>

    <!-- 4. CCTV Camera 1 -->
    <div class="cam-box" style="top: 47mm; left: 4mm; width: 96mm; height: 49mm;">
      ${cam1Url && !cam1Failed ? `<img src="${cam1Url}" alt="CAM 1" /><div class="cam-stamp">CP IP Cam 1 · ${formattedDate} ${formattedTime}</div>` : ''}
    </div>

    <!-- 5. CCTV Camera 2 -->
    <div class="cam-box" style="top: 47mm; left: 106mm; width: 96mm; height: 49mm;">
      ${cam2Url && !cam2Failed ? `<img src="${cam2Url}" alt="CAM 2" /><div class="cam-stamp">CP IP Cam 2 · ${formattedDate} ${formattedTime}</div>` : ''}
    </div>

    <!-- 6. Vehicle No. -->
    <div class="val" style="top: 102.5mm; left: 4mm; width: 48mm; height: 9.5mm; font-size: 15px; letter-spacing: 0.5px;">
      ${ticket.vehicleNumber}
    </div>

    <!-- 7. 1st Weight -->
    <div class="val" style="top: 102.5mm; left: 55mm; width: 48mm; height: 9.5mm; font-size: 15px;">
      ${formatWeight(firstWeight)}
    </div>

    <!-- 8. 2nd Weight -->
    <div class="val" style="top: 102.5mm; left: 106mm; width: 48mm; height: 9.5mm; font-size: 15px;">
      ${secondWeight != null ? formatWeight(secondWeight) : (ticket.tripType === 'FIRST' ? '-' : formatWeight(firstWeight))}
    </div>

    <!-- 9. Net Weight -->
    <div class="val" style="top: 102.5mm; left: 157mm; width: 48mm; height: 9.5mm; font-size: 15px;">
      ${netWeight != null ? formatWeight(netWeight) : '-'}
    </div>

    <!-- 10. Party Name -->
    <div class="val-sans" style="top: 118mm; left: 4mm; width: 48mm; height: 9.5mm; font-size: 13px; padding: 0 2px;">
      ${ticket.partyName || '-'}
    </div>

    <!-- 11. Material -->
    <div class="val-sans" style="top: 118mm; left: 55mm; width: 48mm; height: 9.5mm; font-size: 13px; padding: 0 2px;">
      ${formattedMaterial}
    </div>

    <!-- 12. Charges -->
    <div class="val" style="top: 118mm; left: 106mm; width: 48mm; height: 9.5mm; font-size: 14px;">
      ${formattedCharges}
    </div>
  </div>
</body>
</html>`;

    // 3. Create isolated 210mm x 150mm iframe
    const iframe = document.createElement('iframe');
    iframe.id = 'rvp-kata-print-frame';
    iframe.style.position = 'fixed';
    iframe.style.left = '-9999px';
    iframe.style.top = '-9999px';
    iframe.style.width = '210mm';
    iframe.style.height = '150mm';
    iframe.style.border = '0';
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow?.document;
    if (!doc) return;

    doc.open();
    doc.write(printDocHtml);
    doc.close();

    const triggerIframePrint = () => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch (err) {
        console.error('Iframe print error, falling back to window.print', err);
        window.print();
      }
    };

    // Ensure images are fully loaded before firing print preview
    const imgs = doc.images;
    if (!imgs || imgs.length === 0) {
      setTimeout(triggerIframePrint, 150);
    } else {
      let loaded = 0;
      const total = imgs.length;
      const done = () => {
        loaded++;
        if (loaded >= total) {
          setTimeout(triggerIframePrint, 150);
        }
      };
      for (let i = 0; i < total; i++) {
        if (imgs[i].complete) {
          loaded++;
        } else {
          imgs[i].onload = done;
          imgs[i].onerror = done;
        }
      }
      if (loaded >= total) {
        setTimeout(triggerIframePrint, 150);
      }
    }
  };

  // Keyboard shortcut listener for F12 or Ctrl+P while slip modal is active
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey && (e.key === 'p' || e.key === 'P')) || e.key === 'F12') {
        e.preventDefault();
        e.stopPropagation();
        handlePrint();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [ticket, calibration, cam1Url, cam2Url, cam1Failed, cam2Failed, isStationeryMode]);


  return (
    <Dialog open={!!ticket} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="!max-w-[940px] sm:!max-w-[940px] md:!max-w-[940px] w-[98vw] max-h-[96vh] p-0 overflow-hidden print:!m-0 print:!p-0 print:!border-none print:!shadow-none bg-background text-foreground">

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
                Pre-Printed Slip Overlay (Only 11 Dynamic Values & 2 CCTV Snapshots Print)
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
                title="Prints only the 11 dynamic fields & 2 CCTV photos onto your physical pre-printed stationery"
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
                title="Prints full duplicate with RVP logo, orange headers and borders onto blank paper"
              >
                <FileText className="h-3.5 w-3.5 text-emerald-500" />
                Plain Paper
              </button>
            </div>

            {/* Screen Guide Toggle (in pre-printed mode) */}
            {isStationeryMode && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowScreenGuide((g) => !g)}
                className="h-8 gap-1 text-xs"
                title={showScreenGuide ? 'Hide background guide on screen' : 'Show background guide on screen'}
              >
                {showScreenGuide ? <EyeOff className="h-3.5 w-3.5 text-stone-500" /> : <Eye className="h-3.5 w-3.5 text-primary" />}
                <span>{showScreenGuide ? 'Hide Guide' : 'Show Guide'}</span>
              </Button>
            )}

            {/* Calibration Toggle */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCalibrationBar((s) => !s)}
              className={cn('h-8 gap-1.5 text-xs font-medium', showCalibrationBar && 'border-primary text-primary')}
            >
              <Sliders className="h-3.5 w-3.5" />
              Adjust (mm)
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
                  onClick={() => setCalibration((c) => ({ ...c, offsetXmm: c.offsetXmm - 0.5 }))}
                >
                  -
                </Button>
                <span className="font-mono font-bold w-12 text-center">{calibration.offsetXmm} mm</span>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-6 w-6 text-xs"
                  onClick={() => setCalibration((c) => ({ ...c, offsetXmm: c.offsetXmm + 0.5 }))}
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
                  onClick={() => setCalibration((c) => ({ ...c, offsetYmm: c.offsetYmm - 0.5 }))}
                >
                  -
                </Button>
                <span className="font-mono font-bold w-12 text-center">{calibration.offsetYmm} mm</span>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-6 w-6 text-xs"
                  onClick={() => setCalibration((c) => ({ ...c, offsetYmm: c.offsetYmm + 0.5 }))}
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
        <div className="p-3 sm:p-5 overflow-x-auto flex items-center justify-center bg-stone-200/80 dark:bg-stone-900/80 print:p-0 print:bg-transparent">
          {/* Print Stylesheet Injector */}
          <style>{`
            @page {
              size: 210mm 150mm; /* Exactly 21cm breadth x 15cm length */
              margin: 0;
            }
            @media print {
              html, body {
                background: #ffffff !important;
                color: #000000 !important;
                margin: 0 !important;
                padding: 0 !important;
                width: 210mm !important;
                height: 150mm !important;
                max-width: 210mm !important;
                max-height: 150mm !important;
                overflow: hidden !important;
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
              }
              body > * {
                visibility: hidden !important;
              }
              [data-radix-portal] {
                visibility: visible !important;
                position: absolute !important;
                top: 0 !important;
                left: 0 !important;
                width: 210mm !important;
                height: 150mm !important;
                margin: 0 !important;
                padding: 0 !important;
              }
              div[role="dialog"] {
                visibility: visible !important;
                position: absolute !important;
                top: 0 !important;
                left: 0 !important;
                transform: none !important;
                width: 210mm !important;
                height: 150mm !important;
                max-width: 210mm !important;
                max-height: 150mm !important;
                margin: 0 !important;
                padding: 0 !important;
                border: none !important;
                box-shadow: none !important;
                background: #ffffff !important;
                overflow: hidden !important;
              }
              #rvp-kata-print-container,
              #rvp-kata-print-container * {
                visibility: visible !important;
              }
              #rvp-kata-print-container {
                position: absolute !important;
                left: 0 !important;
                top: 0 !important;
                width: 210mm !important;
                height: 150mm !important;
                max-width: 210mm !important;
                max-height: 150mm !important;
                box-shadow: none !important;
                border: none !important;
                margin: 0 !important;
                padding: 0 !important;
                background: #ffffff !important;
                overflow: hidden !important;
                page-break-after: avoid !important;
                page-break-inside: avoid !important;
              }
              /* In pre-printed stationery mode: strip ALL borders, backgrounds, titles and labels */
              ${isStationeryMode ? `
                .rvp-stationery-artwork,
                .rvp-stationery-artwork * {
                  display: none !important;
                  visibility: hidden !important;
                }
                #rvp-kata-print-container {
                  background: transparent !important;
                }
              ` : ''}
            }
          `}</style>

          {/* 
            Exact Stationery Document Sheet (21cm Breadth x 15cm Length / 210mm x 150mm)
            Both the artwork template and the dynamic values share identical millimeter coordinates.
          */}
          <div
            id="rvp-kata-print-container"
            style={{
              width: '210mm',
              height: '150mm',
              minWidth: '210mm',
              minHeight: '150mm',
              transform: `translate(${calibration.offsetXmm}mm, ${calibration.offsetYmm}mm)`,
            }}
            className="relative bg-white text-black font-sans box-border shadow-2xl rounded-sm print:rounded-none select-text overflow-hidden"
          >
            {/* ═════════════════════════════════════════════════════════════════
                LAYER 1: PRE-PRINTED STATIONERY ARTWORK
                Matches user's physical paper: RVP header, Ganesha, 24h dial, 
                yellow S. No./Date/Time tags, 4x2 orange headers, and 100 TON.
                - In 'stationery' mode: HIDDEN during print; shown on-screen as watermark guide.
                - In 'plain' mode: fully printed in sharp color.
               ═════════════════════════════════════════════════════════════════ */}
            <div
              className={cn(
                'rvp-stationery-artwork absolute inset-0 pointer-events-none p-[3mm]',
                isStationeryMode && (!showScreenGuide ? 'hidden' : 'opacity-35 print:hidden')
              )}
            >
              {/* Outer double red border */}
              <div className="w-full h-full border-2 border-red-600 rounded-lg p-[1.5mm] relative">
                
                {/* Header (Top 2mm to 35mm) */}
                <div className="absolute top-[2mm] left-[2mm] right-[2mm] h-[33mm] flex items-center justify-between px-2">
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
                    <h1 className="text-[23px] font-black tracking-tight text-red-700 leading-tight uppercase font-serif">
                      RVP WEIGH BRIDGE
                    </h1>
                    <div className="inline-block bg-yellow-400 text-black px-3 py-0.2 rounded-full text-[9px] font-black uppercase tracking-wider border border-yellow-500 shadow-2xs">
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

                {/* S. No. Box Artwork Outline (Top: 36mm) */}
                <div className="absolute top-[36mm] left-[2mm] w-[64mm] h-[8.5mm] border-2 border-amber-500 rounded-md flex items-center overflow-hidden bg-white">
                  <div className="bg-yellow-300 text-red-900 text-[10px] font-black px-2 h-full flex items-center justify-center uppercase border-r border-amber-400 shrink-0">
                    S. No.
                  </div>
                </div>

                {/* DATE Box Artwork Outline (Top: 36mm) */}
                <div className="absolute top-[36mm] left-[69mm] w-[60mm] h-[8.5mm] border-2 border-amber-500 rounded-md flex items-center overflow-hidden bg-white">
                  <div className="bg-yellow-300 text-red-900 text-[10px] font-black px-2.5 h-full flex items-center justify-center uppercase border-r border-amber-400 shrink-0">
                    DATE
                  </div>
                </div>

                {/* TIME Box Artwork Outline (Top: 36mm) */}
                <div className="absolute top-[36mm] left-[132mm] w-[63.5mm] h-[8.5mm] border-2 border-amber-500 rounded-md flex items-center overflow-hidden bg-white">
                  <div className="bg-yellow-300 text-red-900 text-[10px] font-black px-2.5 h-full flex items-center justify-center uppercase border-r border-amber-400 shrink-0">
                    TIME
                  </div>
                </div>

                {/* Two Photo Frames Artwork Outline (Top: 47mm, Height: 49mm) */}
                <div className="absolute top-[47mm] left-[4mm] w-[96mm] h-[49mm] border-2 border-red-500 rounded-lg overflow-hidden bg-red-50/10" />
                <div className="absolute top-[47mm] left-[106mm] w-[96mm] h-[49mm] border-2 border-red-500 rounded-lg overflow-hidden bg-red-50/10" />

                {/* ROW 1: Orange Headers (Top: 97.5mm) */}
                <div className="absolute top-[97.5mm] left-[4mm] w-[48mm] h-[4.5mm] bg-gradient-to-r from-red-600 to-orange-500 text-white font-bold text-[8.5px] flex items-center justify-center uppercase rounded-t-xs">
                  Vehicle No.
                </div>
                <div className="absolute top-[97.5mm] left-[55mm] w-[48mm] h-[4.5mm] bg-gradient-to-r from-red-600 to-orange-500 text-white font-bold text-[8.5px] flex items-center justify-center uppercase rounded-t-xs">
                  1st Weight
                </div>
                <div className="absolute top-[97.5mm] left-[106mm] w-[48mm] h-[4.5mm] bg-gradient-to-r from-red-600 to-orange-500 text-white font-bold text-[8.5px] flex items-center justify-center uppercase rounded-t-xs">
                  2nd Weight
                </div>
                <div className="absolute top-[97.5mm] left-[157mm] w-[48mm] h-[4.5mm] bg-gradient-to-r from-red-600 to-orange-500 text-white font-bold text-[8.5px] flex items-center justify-center uppercase rounded-t-xs">
                  Net Weight
                </div>

                {/* ROW 1: Cell Outlines (Top: 102mm) */}
                <div className="absolute top-[102mm] left-[4mm] w-[48mm] h-[9.5mm] border border-red-500 rounded-b-md" />
                <div className="absolute top-[102mm] left-[55mm] w-[48mm] h-[9.5mm] border border-red-500 rounded-b-md" />
                <div className="absolute top-[102mm] left-[106mm] w-[48mm] h-[9.5mm] border border-red-500 rounded-b-md" />
                <div className="absolute top-[102mm] left-[157mm] w-[48mm] h-[9.5mm] border border-red-500 rounded-b-md" />

                {/* ROW 2: Orange Headers (Top: 113.5mm) */}
                <div className="absolute top-[113.5mm] left-[4mm] w-[48mm] h-[4.5mm] bg-gradient-to-r from-red-600 to-orange-500 text-white font-bold text-[8.5px] flex items-center justify-center uppercase rounded-t-xs">
                  Party Name
                </div>
                <div className="absolute top-[113.5mm] left-[55mm] w-[48mm] h-[4.5mm] bg-gradient-to-r from-red-600 to-orange-500 text-white font-bold text-[8.5px] flex items-center justify-center uppercase rounded-t-xs">
                  Material
                </div>
                <div className="absolute top-[113.5mm] left-[106mm] w-[48mm] h-[4.5mm] bg-gradient-to-r from-red-600 to-orange-500 text-white font-bold text-[8.5px] flex items-center justify-center uppercase rounded-t-xs">
                  Charges
                </div>
                <div className="absolute top-[113.5mm] left-[157mm] w-[48mm] h-[4.5mm] bg-gradient-to-r from-red-600 to-orange-500 text-white font-bold text-[8.5px] flex items-center justify-center uppercase rounded-t-xs">
                  Signature
                </div>

                {/* ROW 2: Cell Outlines (Top: 118mm) */}
                <div className="absolute top-[118mm] left-[4mm] w-[48mm] h-[9.5mm] border border-red-500 rounded-b-md" />
                <div className="absolute top-[118mm] left-[55mm] w-[48mm] h-[9.5mm] border border-red-500 rounded-b-md" />
                <div className="absolute top-[118mm] left-[106mm] w-[48mm] h-[9.5mm] border border-red-500 rounded-b-md" />
                <div className="absolute top-[118mm] left-[157mm] w-[48mm] h-[9.5mm] border border-red-500 rounded-b-md" />

                {/* Footer Strip (Top: 130mm) */}
                <div className="absolute top-[130mm] left-[2mm] right-[2mm] flex items-center justify-between text-[8.5px]">
                  <div className="flex items-center gap-2">
                    <div className="bg-red-700 text-white font-black px-2 py-0.5 rounded-xs text-[10px] tracking-wider">
                      100 TON
                    </div>
                    <span className="text-[7.5px] text-zinc-700 font-semibold">
                      Weigh Bridge Manufactured by : Sri Modern Weigh System. Cell 98430 55760
                    </span>
                  </div>
                  <div className="font-black text-red-700 tracking-wider text-[10px]">
                    THANK YOU! VISIT AGAIN!!
                  </div>
                </div>

              </div>
            </div>

            {/* ═════════════════════════════════════════════════════════════════
                LAYER 2: THE 11 DYNAMIC FIELDS & 2 CCTV CAMERA SNAPSHOTS
                Placed at the EXACT millimeter coordinates so values sit squarely
                inside the physical boxes on your pre-printed stationery slip!
               ═════════════════════════════════════════════════════════════════ */}
            <div className="absolute inset-0 pointer-events-none">
              
              {/* 1. S. No. (e.g. '2807') */}
              <div className="absolute top-[36mm] left-[23mm] w-[45mm] h-[8.5mm] flex items-center justify-center">
                <span className="font-mono font-black text-base text-black tracking-wider">
                  {ticket.ticketNo}
                </span>
              </div>

              {/* 2. DATE (e.g. '09-09-2026') */}
              <div className="absolute top-[36mm] left-[89mm] w-[44mm] h-[8.5mm] flex items-center justify-center">
                <span className="font-mono font-black text-xs sm:text-sm text-black tracking-wider">
                  {formattedDate}
                </span>
              </div>

              {/* 3. TIME (e.g. '01:26:21 pm') */}
              <div className="absolute top-[36mm] left-[154mm] w-[48mm] h-[8.5mm] flex items-center justify-center">
                <span className="font-mono font-black text-xs sm:text-sm text-black tracking-wider">
                  {formattedTime}
                </span>
              </div>

              {/* 4. CCTV Camera 1 (Left: Truck Entry / Front angle) */}
              <div className="absolute top-[47mm] left-[4mm] w-[96mm] h-[49mm] rounded-lg overflow-hidden flex items-center justify-center bg-stone-100 print:bg-transparent">
                {cam1Url && !cam1Failed ? (
                  <img
                    src={cam1Url}
                    alt="CCTV Cam 1"
                    onError={() => {
                      if (!cam1Url.includes('/api/weighbridge/cctv/snapshot')) {
                        setCam1Url('/api/weighbridge/cctv/snapshot?cam=1');
                      } else {
                        setCam1Failed(true);
                      }
                    }}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center text-stone-400 text-xs font-mono gap-1 print:hidden">
                    <Video className="h-5 w-5 opacity-40" />
                    <span>[CAM 1 ENTRY]</span>
                  </div>
                )}
                {/* CP PLUS OSD Stamp */}
                {!cam1Failed && (
                  <div className="absolute bottom-1 left-1.5 bg-black/60 text-white font-mono text-[8px] px-1 py-0.2 rounded-xs pointer-events-none">
                    CP IP Cam 1 · {formattedDate} {formattedTime}
                  </div>
                )}
              </div>

              {/* 5. CCTV Camera 2 (Right: Truck Platform / Rear angle) */}
              <div className="absolute top-[47mm] left-[106mm] w-[96mm] h-[49mm] rounded-lg overflow-hidden flex items-center justify-center bg-stone-100 print:bg-transparent">
                {cam2Url && !cam2Failed ? (
                  <img
                    src={cam2Url}
                    alt="CCTV Cam 2"
                    onError={() => {
                      if (!cam2Url.includes('/api/weighbridge/cctv/snapshot')) {
                        setCam2Url('/api/weighbridge/cctv/snapshot?cam=2');
                      } else {
                        setCam2Failed(true);
                      }
                    }}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center text-stone-400 text-xs font-mono gap-1 print:hidden">
                    <Video className="h-5 w-5 opacity-40" />
                    <span>[CAM 2 EXIT]</span>
                  </div>
                )}
                {/* CP PLUS OSD Stamp */}
                {!cam2Failed && (
                  <div className="absolute bottom-1 left-1.5 bg-black/60 text-white font-mono text-[8px] px-1 py-0.2 rounded-xs pointer-events-none">
                    CP IP Cam 2 · {formattedDate} {formattedTime}
                  </div>
                )}
              </div>

              {/* ═════════════════════════════════════════════════════════════
                  ROW 1 DATA: Vehicle No. | 1st Weight | 2nd Weight | Net Weight
                  Sits inside the white boxes under Row 1 Orange Headers
                 ═════════════════════════════════════════════════════════════ */}
              
              {/* 6. Vehicle No. (e.g. 'AP39UX9999') */}
              <div className="absolute top-[102.5mm] left-[4mm] w-[48mm] h-[9.5mm] flex items-center justify-center px-1">
                <span className="font-mono font-black text-sm text-black tracking-wider uppercase truncate">
                  {ticket.vehicleNumber}
                </span>
              </div>

              {/* 7. 1st Weight (e.g. '0-Kg') */}
              <div className="absolute top-[102.5mm] left-[55mm] w-[48mm] h-[9.5mm] flex items-center justify-center px-1">
                <span className="font-mono font-black text-sm text-black tracking-wider">
                  {formatWeight(firstWeight)}
                </span>
              </div>

              {/* 8. 2nd Weight (e.g. '-' or '<wt>-Kg') */}
              <div className="absolute top-[102.5mm] left-[106mm] w-[48mm] h-[9.5mm] flex items-center justify-center px-1">
                <span className="font-mono font-black text-sm text-black tracking-wider">
                  {secondWeight != null
                    ? formatWeight(secondWeight)
                    : ticket.tripType === 'FIRST'
                    ? '-'
                    : formatWeight(firstWeight)}
                </span>
              </div>

              {/* 9. Net Weight (e.g. '-') */}
              <div className="absolute top-[102.5mm] left-[157mm] w-[48mm] h-[9.5mm] flex items-center justify-center px-1">
                <span className="font-mono font-black text-sm sm:text-base text-black tracking-wider">
                  {netWeight != null ? formatWeight(netWeight) : '-'}
                </span>
              </div>

              {/* ═════════════════════════════════════════════════════════════
                  ROW 2 DATA: Party Name | Material | Charges | Signature
                  Sits inside the white boxes under Row 2 Orange Headers
                 ═════════════════════════════════════════════════════════════ */}

              {/* 10. Party Name */}
              <div className="absolute top-[118mm] left-[4mm] w-[48mm] h-[9.5mm] flex items-center justify-center px-1">
                <span className="font-sans font-black text-xs text-black tracking-wide uppercase truncate">
                  {ticket.partyName || '-'}
                </span>
              </div>

              {/* 11. Material (e.g. '.PAPPU' or '.SEED') */}
              <div className="absolute top-[118mm] left-[55mm] w-[48mm] h-[9.5mm] flex items-center justify-center px-1">
                <span className="font-sans font-black text-xs text-black tracking-wider uppercase truncate">
                  {formattedMaterial}
                </span>
              </div>

              {/* 12. Charges (e.g. '₹ 100.00') */}
              <div className="absolute top-[118mm] left-[106mm] w-[48mm] h-[9.5mm] flex items-center justify-center px-1">
                <span className="font-mono font-black text-sm text-black tracking-wide">
                  {formattedCharges}
                </span>
              </div>

              {/* Signature is purposefully left BLANK for manual pen signing */}

            </div>
          </div>
        </div>

        {/* Modal Bottom Footer / Hints (Hidden in Print) */}
        <div className="p-3 bg-card/40 border-t border-border flex items-center justify-between text-xs text-muted-foreground print:hidden">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
            <span>
              {isStationeryMode
                ? 'Pre-Printed Stationery Mode Active: Only the 11 dynamic fields & 2 CCTV photos will print.'
                : 'Plain Paper Mode Active: Full certificate with RVP logo, headers and borders will print.'}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-[11px] font-mono">
              Paper: 21cm × 15cm (210×150mm)
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


