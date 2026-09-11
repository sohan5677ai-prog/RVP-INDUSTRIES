import type { MouseEvent } from 'react';
import { Scale, Zap } from 'lucide-react';
import { useScale } from '@/lib/scaleContext';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface ScaleCaptureButtonProps {
  /** Callback fired when scale weight is captured. Provides the number and formatted string. */
  onCapture: (weightValue: number, formattedText: string) => void;
  /** Whether the field expects 'kg' or 'tonnes'. Default is 'kg'. */
  unit?: 'kg' | 'tonnes';
  /** Number of decimal places when converting to tonnes (default: 3). */
  tonnesDecimals?: number;
  /** Optional custom button text */
  label?: string;
  /** CSS class overrides */
  className?: string;
  /** Small button variant */
  size?: 'sm' | 'default' | 'icon';
}

export default function ScaleCaptureButton({
  onCapture,
  unit = 'kg',
  tonnesDecimals = 3,
  label,
  className,
  size = 'sm',
}: ScaleCaptureButtonProps) {
  const { isSupported, isConnected, isScaleOnline, liveWeight, connect, isConnecting } = useScale();

  if (!isSupported && !isScaleOnline) {
    return null; // Don't show button only if browser lacks Web Serial AND scale is offline
  }

  const handleCapture = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!isScaleOnline && !isConnected) {
      if (isSupported) {
        const ok = await connect();
        if (!ok) return;
      } else {
        toast.error('Weighbridge scale is currently offline on the network.');
        return;
      }
    }

    if (liveWeight == null || liveWeight <= 0) {
      toast.warning('Scale online, waiting for vehicle weight on platform...');
      return;
    }

    if (unit === 'tonnes') {
      const tonnes = Number((liveWeight / 1000).toFixed(tonnesDecimals));
      const formatted = String(tonnes);
      onCapture(tonnes, formatted);
      toast.success(`Captured ${tonnes} t (${liveWeight.toLocaleString('en-IN')} kg) from scale`);
    } else {
      const formatted = String(liveWeight);
      onCapture(liveWeight, formatted);
      toast.success(`Captured ${liveWeight.toLocaleString('en-IN')} kg from scale`);
    }
  };

  const displayText = () => {
    if (!isScaleOnline && !isConnected) return 'Scale (Offline)';
    if (liveWeight == null || liveWeight === 0) return 'Scale (0 kg)';
    if (unit === 'tonnes') {
      return `Scale (${(liveWeight / 1000).toFixed(tonnesDecimals)} t)`;
    }
    return `Scale (${liveWeight.toLocaleString('en-IN')} kg)`;
  };

  const isLive = isScaleOnline || isConnected;

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      onClick={handleCapture}
      disabled={isConnecting}
      title={isLive ? `Click to insert scale weight (${liveWeight ?? 0} kg)` : 'Click to connect Scale'}
      className={cn(
        'h-8 px-2.5 text-xs font-semibold gap-1.5 transition-all shadow-xs',
        isLive
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20 hover:border-emerald-500/60'
          : 'border-border text-muted-foreground hover:text-foreground',
        className
      )}
    >
      <Scale className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
      <span>{label || displayText()}</span>
      {isLive && <Zap className="h-3 w-3 text-amber-500 shrink-0" />}
    </Button>
  );
}
