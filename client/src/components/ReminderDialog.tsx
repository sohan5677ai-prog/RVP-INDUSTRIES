import { ArrowRight, Check } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// The shared shell every login reminder wears, so the three popups look like one
// sequence instead of three unrelated dialogs. Position in the queue is spelled
// out ("2 of 3") and the dismiss button says what comes next, so the user is
// never surprised by another popup appearing behind the one they just closed.

type Tone = 'rose' | 'amber' | 'blue';

const TONE: Record<Tone, { chip: string; ring: string }> = {
  rose: { chip: 'bg-rose-500/12 text-rose-600 dark:text-rose-400', ring: 'ring-rose-500/20' },
  amber: { chip: 'bg-amber-500/12 text-amber-600 dark:text-amber-400', ring: 'ring-amber-500/20' },
  blue: { chip: 'bg-sky-500/12 text-sky-600 dark:text-sky-400', ring: 'ring-sky-500/20' },
};

export default function ReminderDialog({
  open,
  onClose,
  icon: Icon,
  tone,
  title,
  subtitle,
  count,
  step,
  total,
  children,
}: {
  open: boolean;
  onClose: () => void;
  icon: React.ComponentType<{ className?: string }>;
  tone: Tone;
  title: string;
  subtitle: string;
  count: number;
  step: number;
  total: number;
  children: React.ReactNode;
}) {
  const t = TONE[tone];
  const remaining = Math.max(0, total - step);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg gap-0 p-0 overflow-hidden">
        <DialogHeader className="gap-0 border-b border-border/60 px-5 py-4 text-left sm:text-left">
          <div className="flex items-start gap-3 pr-6">
            <span className={cn('mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1', t.chip, t.ring)}>
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="flex items-center gap-2 text-base">
                <span className="truncate">{title}</span>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                  {count}
                </span>
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-xs">{subtitle}</DialogDescription>
            </div>
          </div>

          {total > 1 && (
            <div className="mt-3 flex items-center gap-2">
              <div className="flex flex-1 gap-1">
                {Array.from({ length: total }, (_, i) => (
                  <span
                    key={i}
                    className={cn(
                      'h-1 flex-1 rounded-full transition-colors',
                      i < step - 1 ? 'bg-muted-foreground/30' : i === step - 1 ? 'bg-primary' : 'bg-muted',
                    )}
                  />
                ))}
              </div>
              <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
                {step} of {total}
              </span>
            </div>
          )}
        </DialogHeader>

        <div className="max-h-[58vh] space-y-2.5 overflow-y-auto px-5 py-4">{children}</div>

        <DialogFooter className="border-t border-border/60 bg-muted/30 px-5 py-3 sm:justify-between">
          <p className="hidden text-xs text-muted-foreground sm:block">
            {remaining > 0
              ? `${remaining} more reminder${remaining > 1 ? 's' : ''} after this`
              : 'Last reminder'}
          </p>
          <Button size="sm" variant="outline" onClick={onClose} className="gap-1.5">
            {remaining > 0 ? <>Next <ArrowRight className="h-4 w-4" /></> : <><Check className="h-4 w-4" /> Done</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
