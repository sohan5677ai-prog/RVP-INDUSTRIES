import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Eye, EyeOff, FileText, Loader2, Printer, Truck } from 'lucide-react';
import { api } from '@/lib/api';
import type { CompanyProfile, DispatchSlot, Transport } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import {
  buildVehicleIndentHtml,
  openVehicleIndent,
  type VehicleIndentSheet,
} from '@/lib/vehicleIndent';

/**
 * The code sheet: every future loading code a transporter holds, on one
 * document that can be sent to him.
 *
 * The day-indent (dispatchSlot.service.buildIndentMessage) answers "what do you
 * need tomorrow" - one message, one date, pipe-separated because Meta's
 * template will not carry a newline. That is the wrong shape for the question a
 * transport office actually asks mid-week: "which codes are still mine, and
 * where is each one going?" Six indents on a phone cannot be read side by side,
 * so this renders the same slots as a ruled register, grouped by day.
 *
 * It used to leave as a PNG captured off the screen. It now leaves as a PDF,
 * printed from the A4 document in lib/vehicleIndent.ts - the same letterhead,
 * panels and dark-banded table as the Statement of Account, so everything this
 * company issues looks like it came from the same desk. The preview below is
 * that very document in an iframe, not a second drawing of it, so what is on
 * screen is exactly what prints.
 */

/** Already gone, or never going. Neither belongs on a sheet of future work. */
const LIVE = new Set(['PLANNED', 'REQUESTED', 'CONFIRMED']);

/** How far ahead "all upcoming" looks. Nothing is planned beyond a season. */
const HORIZON_DAYS = 60;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const tonnage = (kg: number) => {
  const t = kg / 1000;
  return Number.isInteger(t) ? `${t} t` : `${t.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} t`;
};

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function shortDate(key: string): string {
  const [, m, d] = key.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]}`;
}

type RangeMode = 'week' | 'upcoming';

export function LorryCodeSheet(props: { transports: Transport[]; weekFrom: string; weekTo: string }) {
  const { transports, weekFrom, weekTo } = props;
  const [range, setRange] = useState<RangeMode>('upcoming');

  const today = ymd(new Date());
  const from = range === 'week' ? weekFrom : today;
  const to = range === 'week' ? weekTo : ymd(addDays(new Date(), HORIZON_DAYS));

  // Same key shape as the calendar's own range query, so a week the calendar
  // has already fetched costs nothing to show here.
  const slotsQ = useQuery({
    queryKey: ['dispatch-slots', from, to],
    queryFn: () => api<DispatchSlot[]>(`/dispatch-slots?from=${from}&to=${to}`),
    staleTime: 30_000,
  });
  const companyQ = useQuery({
    queryKey: ['company'],
    queryFn: () => api<CompanyProfile>('/settings/company'),
    staleTime: 300_000,
  });

  /**
   * One group per transporter, biggest fleet first - the house transporter
   * carries most of the week and should not be scrolled to. Lorries with nobody
   * against them get a group of their own: that is the thing the planner has to
   * fix before any sheet goes out, so it is shown rather than hidden.
   */
  const groups = useMemo(() => {
    const live = (slotsQ.data ?? [])
      .filter((s) => LIVE.has(s.status))
      .sort((a, b) => (a.dateKey === b.dateKey ? a.seq - b.seq : a.dateKey < b.dateKey ? -1 : 1));

    const map = new Map<
      string,
      { id: string | null; name: string; phone: string | null; phone2: string | null; slots: DispatchSlot[] }
    >();
    for (const s of live) {
      const key = s.transportId ?? '';
      const existing = map.get(key);
      if (existing) {
        existing.slots.push(s);
        continue;
      }
      const master = transports.find((x) => x.id === s.transportId);
      map.set(key, {
        id: s.transportId,
        name: s.transport?.name ?? master?.name ?? 'No transporter yet',
        phone: s.transport?.phone ?? master?.phone ?? null,
        phone2: s.transport?.phone2 ?? master?.phone2 ?? null,
        slots: [s],
      });
    }
    return [...map.values()].sort((a, b) => {
      if (Boolean(a.id) !== Boolean(b.id)) return a.id ? -1 : 1; // unassigned last
      return b.slots.length - a.slots.length;
    });
  }, [slotsQ.data, transports]);

  const rangeLabel =
    range === 'week' ? `${shortDate(weekFrom)} - ${shortDate(weekTo)}` : `${shortDate(from)} onwards`;

  const assigned = groups.filter((g) => g.id);

  const sheetFor = (g: (typeof groups)[number]): VehicleIndentSheet => ({
    transporter: { name: g.name, phone: g.phone, phone2: g.phone2 },
    slots: g.slots,
    rangeLabel,
  });

  function printAll() {
    try {
      openVehicleIndent({ company: companyQ.data, sheets: assigned.map(sheetFor) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open the indent');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented<RangeMode>
          value={range}
          onValueChange={setRange}
          options={[
            { label: 'All upcoming', value: 'upcoming' },
            { label: 'This week', value: 'week' },
          ]}
        />
        <div className="flex items-center gap-3">
          <p className="hidden text-xs text-muted-foreground sm:block">
            One A4 indent per transporter - print or save as PDF, then send it.
          </p>
          {assigned.length > 1 && (
            <Button variant="outline" size="sm" onClick={printAll}>
              <Printer className="h-3.5 w-3.5" />
              <span className="ml-1.5">Print all ({assigned.length})</span>
            </Button>
          )}
        </div>
      </div>

      {slotsQ.isLoading && (
        <div className="glass flex items-center gap-2 rounded-2xl p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading the plan...
        </div>
      )}

      {!slotsQ.isLoading && groups.length === 0 && (
        <div className="glass rounded-2xl p-10 text-center">
          <Truck className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            No lorries planned {range === 'week' ? 'this week' : 'from today onwards'}. Plan a few on the calendar
            and their codes appear here.
          </p>
        </div>
      )}

      <div className="space-y-4">
        {groups.map((g) => (
          <TransporterIndent
            key={g.id ?? 'unassigned'}
            sheet={sheetFor(g)}
            company={companyQ.data}
            assigned={Boolean(g.id)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One transporter's indent: a short summary line, and the document itself in a
 * preview that is the same HTML the printer gets.
 *
 * The preview is collapsed by default. A planner with six transporters on
 * screen does not want six A4 iframes laid out and painted before he has asked
 * to look at one of them.
 */
function TransporterIndent(props: {
  sheet: VehicleIndentSheet;
  company: CompanyProfile | null | undefined;
  assigned: boolean;
}) {
  const { sheet, company, assigned } = props;
  const [open, setOpen] = useState(false);

  const totalKg = sheet.slots.reduce((sum, s) => sum + s.vehicleClassKg, 0);
  const pending = sheet.slots.filter((s) => !s.lorryNumber).length;
  const days = new Set(sheet.slots.map((s) => s.dateKey)).size;

  function print() {
    try {
      openVehicleIndent({ company, sheets: [sheet] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open the indent');
    }
  }

  return (
    <div className="glass rounded-2xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{sheet.transporter.name}</p>
          <p className="text-xs text-muted-foreground">
            {sheet.slots.length} {sheet.slots.length === 1 ? 'vehicle' : 'vehicles'} · {tonnage(totalKg)} ·{' '}
            {days} {days === 1 ? 'loading day' : 'loading days'}
            {pending > 0 && ` · ${pending} awaiting a number`}
          </p>
        </div>
        {assigned ? (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
              {open ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              <span className="ml-1.5">{open ? 'Hide' : 'Preview'}</span>
            </Button>
            <Button size="sm" onClick={print}>
              <FileText className="h-3.5 w-3.5" />
              <span className="ml-1.5">Download PDF</span>
            </Button>
          </div>
        ) : (
          <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
            Put a transporter against these before any indent goes out
          </p>
        )}
      </div>

      {open && <IndentPreview html={buildVehicleIndentHtml({ company, sheets: [sheet], print: false })} />}
    </div>
  );
}

/**
 * The document itself, in an iframe.
 *
 * An A4 page is 794 CSS px wide, which no side panel can hold, so the frame is
 * drawn at its true width and scaled down to whatever the card allows - the
 * page keeps its proportions, and the preview cannot drift from the print the
 * way a hand-built React copy of it would.
 */
function IndentPreview(props: { html: string }) {
  const { html } = props;
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState(1123); // A4 at 96dpi, until the real one is known

  const PAGE_W = 794;

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const fit = () => setScale(Math.min(1, box.clientWidth / PAGE_W));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  // The page is as tall as its content, which the component cannot know until
  // the frame has laid it out.
  const onLoad = () => {
    const doc = frameRef.current?.contentDocument;
    if (doc) setHeight(Math.max(doc.body.scrollHeight, 1123));
  };

  return (
    <div ref={boxRef} className="mt-4 overflow-hidden rounded-xl border border-border/60 bg-muted/30">
      <div style={{ height: height * scale }}>
        <iframe
          ref={frameRef}
          title="Vehicle indent preview"
          srcDoc={html}
          onLoad={onLoad}
          scrolling="no"
          style={{
            width: PAGE_W,
            height,
            border: 0,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            display: 'block',
          }}
        />
      </div>
    </div>
  );
}
