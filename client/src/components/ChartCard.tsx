import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type ChartCardProps = {
  title: string;
  subtitle?: string;
  icon?: React.ComponentType<{ className?: string }>;
  iconClass?: string;
  right?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
};

/** Framed chart container matching the Tamarind & Bone surface language. */
export function ChartCard({ title, subtitle, icon: Icon, iconClass, right, className, bodyClassName, children }: ChartCardProps) {
  return (
    <div className={cn('glass flex flex-col rounded-2xl', className)}>
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          {Icon && (
            <span className={cn('flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary', iconClass)}>
              <Icon className="h-4 w-4" />
            </span>
          )}
          <div className="min-w-0">
            <h3 className="font-display text-[15px] font-semibold tracking-tight text-foreground leading-tight truncate">{title}</h3>
            {subtitle && <p className="text-[11px] text-muted-foreground truncate">{subtitle}</p>}
          </div>
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </div>
      <div className={cn('px-2 pb-3 flex-1', bodyClassName)}>{children}</div>
    </div>
  );
}
