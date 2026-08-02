import type { LucideIcon } from 'lucide-react';
import { TableCell, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * The expanded-row look first built on the Pappu sales page: instead of squeezing
 * child records into the parent table's columns, the open row hands its full
 * width to a panel of self-contained cards. Shared here so Purchase Orders and
 * Stock In read the same way.
 */
export function ExpandPanel({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="p-0">
        <div className="border-t border-border/60 bg-muted/25 px-5 py-4">{children}</div>
      </TableCell>
    </TableRow>
  );
}

/** Small uppercase caption above the card stack, e.g. "Lorries · 3". */
export function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

/** Vertical stack the cards sit in. */
export function PanelStack({ children }: { children: React.ReactNode }) {
  return <div className="space-y-2.5">{children}</div>;
}

/**
 * One child record. `identity` carries the name/badges/meta, `figures` the
 * right-aligned numbers, `actions` the buttons - all three wrap gracefully.
 */
export function PanelCard({
  icon: Icon,
  identity,
  figures,
  actions,
}: {
  icon: LucideIcon;
  identity: React.ReactNode;
  figures?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="glass rounded-xl p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0">{identity}</div>
        </div>
        {figures && <div className="flex items-center gap-5">{figures}</div>}
        {actions && <div className="flex flex-wrap items-center justify-end gap-1.5">{actions}</div>}
      </div>
    </div>
  );
}

/** Title line inside a card: mono identifier plus badges. */
export function PanelTitle({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

/** Muted meta line under the title; separate items with <PanelDot />. */
export function PanelMeta({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

export function PanelDot() {
  return <span className="opacity-40">·</span>;
}

/** A labelled number in the card's figures block. */
export function Figure({ label, value, valueClass }: { label: string; value: React.ReactNode; valueClass?: string }) {
  return (
    <div className="text-right">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 font-mono text-sm font-semibold tabular-nums', valueClass)}>{value}</div>
    </div>
  );
}

/** Empty state used when an expanded row has no children yet. */
export function PanelEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
