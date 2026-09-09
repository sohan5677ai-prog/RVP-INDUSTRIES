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
  const { isSupported, isConnected, liveWeight, connect, isConnecting } = useScale();

  if (!isSupported) {
    return null; // Don't show button in browsers without Web Serial support
  }

  const handleCapture = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!isConnected) {
      const ok = await connect();
      if (!ok) return;
    }

    if (liveWeight == null) {
      toast.warning('Scale connected, waiting for stable weight reading...');
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
    if (!isConnected) return 'Connect Scale';
    if (liveWeight == null) return 'Scale (0 kg)';
    if (unit === 'tonnes') {
      return `Scale (${(liveWeight / 1000).toFixed(tonnesDecimals)} t)`;
    }
    return `Scale (${liveWeight.toLocaleString('en-IN')} kg)`;
  };

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      onClick={handleCapture}
      disabled={isConnecting}
      title={isConnected ? `Click to insert scale weight (${liveWeight ?? 0} kg)` : 'Click to connect Scale'}
      className={cn(
        'h-8 px-2.5 text-xs font-semibold gap-1.5 transition-all shadow-xs',
        isConnected
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20 hover:border-emerald-500/60'
          : 'border-border text-muted-foreground hover:text-foreground',
        className
      )}
    >
      <Scale className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
      <span>{label || displayText()}</span>
      {isConnected && <Zap className="h-3 w-3 text-amber-500 shrink-0" />}
    </Button>
  );
}
