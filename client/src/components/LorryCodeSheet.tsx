import { Fragment, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { toPng } from 'html-to-image';
import { Download, Copy, Loader2, Share2, Truck } from 'lucide-react';
import { api } from '@/lib/api';
import type { CompanyProfile, DispatchSlot, Transport } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';

/**
 * The code sheet: every future loading code a transporter holds, on one card
 * that can be sent to him as a picture.
 *
 * The day-indent (dispatchSlot.service.buildIndentMessage) answers "what do you
 * need tomorrow" - one message, one date, pipe-separated because Meta's
 * template will not carry a newline. That is the wrong shape for the question a
 * transport office actually asks mid-week: "which codes are still mine, and
 * where is each one going?" Six indents on a phone cannot be read side by side,
 * so this renders the same slots as a table, grouped by day, and hands it over
 * as a PNG - a format WhatsApp carries intact and the office can pin in the
 * group.
 *
 * The buyer is deliberately absent, exactly as in the indent: the transporter
 * needs the code, the day, the size and the two places; who bought the goods is
 * ours, and on a shared WhatsApp number it would be a leak rather than a
 * courtesy. The loading point IS here, unlike the indent, which dropped it for
 * line length on a phone - a table has a column to spare, and a fleet split
 * between RVP and KNM is otherwise a phone call per lorry.
 */

/** Already gone, or never going. Neither belongs on a sheet of future work. */
const LIVE = new Set(['PLANNED', 'REQUESTED', 'CONFIRMED']);

/** How far ahead "all upcoming" looks. Nothing is planned beyond a season. */
const HORIZON_DAYS = 60;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `35 Tons` - the size as the transport office says it out loud. */
const tonsLabel = (kg: number) => {
  const t = kg / 1000;
  return `${Number.isInteger(t) ? t : Number(t.toFixed(2))} Tons`;
};

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

/** `Mon 17 Nov`, read off the slot's own `YYYY-MM-DD` with no timezone trip. */
function dayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return `${DOW[new Date(y, m - 1, d).getDay()]} ${String(d).padStart(2, '0')} ${MONTHS[m - 1]}`;
}

function shortDate(key: string): string {
  const [, m, d] = key.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]}`;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'transporter';

/**
 * Capture a sheet as a PNG.
 *
 * Fonts are not embedded, for the reason SupportButton gives at length:
 * html-to-image re-fetches any cross-origin stylesheet whose rules it cannot
 * read, which is slow and throws console errors. The sheet names its own font
 * stack inline instead, so what the browser shows is what lands in the picture.
 */
async function capture(node: HTMLElement): Promise<string | null> {
  return Promise.race([
    toPng(node, { pixelRatio: 2, backgroundColor: '#ffffff', cacheBust: true, skipFonts: true }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
  ]);
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  return (await fetch(dataUrl)).blob();
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

    const map = new Map<string, { id: string | null; name: string; slots: DispatchSlot[] }>();
    for (const s of live) {
      const key = s.transportId ?? '';
      const existing = map.get(key);
      if (existing) {
        existing.slots.push(s);
        continue;
      }
      map.set(key, {
        id: s.transportId,
        name:
          s.transport?.name ??
          transports.find((x) => x.id === s.transportId)?.name ??
          'No transporter yet',
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
        <p className="text-xs text-muted-foreground">
          One card per transporter - every code he holds, with where it goes. Send him the picture.
        </p>
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

      <div className="space-y-6">
        {groups.map((g) => (
          <TransporterSheet
            key={g.id ?? 'unassigned'}
            name={g.name}
            slots={g.slots}
            companyName={companyQ.data?.tradeName || companyQ.data?.name || 'RVP Industries'}
            companyPlace={companyQ.data?.dispatchFromPlace || companyQ.data?.stateName || null}
            rangeLabel={rangeLabel}
            assigned={Boolean(g.id)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One transporter's card, and the three ways it leaves the browser.
 *
 * The sheet is styled in fixed light colours rather than the app's tokens: it
 * is a picture that leaves the building, and a planner working in dark mode
 * must not send a black card with grey text that a phone cannot read in
 * daylight.
 */
function TransporterSheet(props: {
  name: string;
  slots: DispatchSlot[];
  companyName: string;
  companyPlace: string | null;
  rangeLabel: string;
  assigned: boolean;
}) {
  const { name, slots, companyName, companyPlace, rangeLabel, assigned } = props;
  const sheetRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<null | 'download' | 'copy' | 'share'>(null);

  const byDay = useMemo(() => {
    const map = new Map<string, DispatchSlot[]>();
    for (const s of slots) {
      const list = map.get(s.dateKey) ?? [];
      list.push(s);
      map.set(s.dateKey, list);
    }
    return [...map.entries()];
  }, [slots]);

  // The sizes he has to arrange, not the tonnage we will put in them: a part
  // load is our arithmetic, and a 40 t lorry is still a 40 t lorry to him.
  const totalKg = slots.reduce((sum, s) => sum + s.vehicleClassKg, 0);
  const pending = slots.filter((s) => !s.lorryNumber).length;
  const fileName = `${slug(name)}-loading-codes.png`;

  async function withCapture(kind: 'download' | 'copy' | 'share', run: (dataUrl: string) => Promise<void>) {
    if (!sheetRef.current || busy) return;
    setBusy(kind);
    try {
      const dataUrl = await capture(sheetRef.current);
      if (!dataUrl) {
        toast.error('The picture took too long to draw - please try again');
        return;
      }
      await run(dataUrl);
    } catch (err) {
      console.error('[code-sheet] capture failed', err);
      toast.error('Could not make the picture');
    } finally {
      setBusy(null);
    }
  }

  const saveFile = (dataUrl: string) => {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = fileName;
    a.click();
  };

  const download = () =>
    withCapture('download', async (dataUrl) => {
      saveFile(dataUrl);
      toast.success(`Saved ${fileName}`);
    });

  const copy = () =>
    withCapture('copy', async (dataUrl) => {
      // Clipboard images need a real Blob and a secure context; an http:// origin
      // or an older browser simply refuses, so say so rather than leaving the
      // user wondering why nothing pasted.
      if (!navigator.clipboard || typeof window.ClipboardItem === 'undefined') {
        toast.error('This browser will not copy images - use Download instead');
        return;
      }
      const blob = await dataUrlToBlob(dataUrl);
      await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
      toast.success('Copied - paste it straight into WhatsApp');
    });

  const share = () =>
    withCapture('share', async (dataUrl) => {
      const blob = await dataUrlToBlob(dataUrl);
      const file = new File([blob], fileName, { type: 'image/png' });
      // On a phone this opens WhatsApp with the picture attached; on a desktop
      // browser without file sharing it falls back to a download.
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: `Loading codes - ${name}` });
        return;
      }
      saveFile(dataUrl);
      toast.success(`Saved ${fileName} - attach it in WhatsApp`);
    });

  return (
    <div className="glass rounded-2xl p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{name}</p>
          <p className="text-xs text-muted-foreground">
            {slots.length} {slots.length === 1 ? 'lorry' : 'lorries'} · {tonnage(totalKg)}
            {pending > 0 && ` · ${pending} awaiting a number`}
          </p>
        </div>
        {assigned ? (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={copy} disabled={busy !== null}>
              {busy === 'copy' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />}
              <span className="ml-1.5">Copy image</span>
            </Button>
            <Button variant="outline" size="sm" onClick={share} disabled={busy !== null}>
              {busy === 'share' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Share2 className="h-3.5 w-3.5" />}
              <span className="ml-1.5">Share</span>
            </Button>
            <Button size="sm" onClick={download} disabled={busy !== null}>
              {busy === 'download' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              <span className="ml-1.5">Download</span>
            </Button>
          </div>
        ) : (
          <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
            Put a transporter against these before any sheet goes out
          </p>
        )}
      </div>

      {/* The picture itself. A fixed width, so the capture is the same whatever
          screen it was taken on. */}
      <div className="overflow-x-auto">
        <div
          ref={sheetRef}
          style={{
            width: 720,
            background: '#ffffff',
            color: '#1c1917',
            fontFamily: "'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
            border: '1px solid #e7e5e4',
            borderRadius: 14,
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: '18px 22px', background: '#1e293b', color: '#ffffff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{companyName}</div>
                {companyPlace && <div style={{ fontSize: 11, color: '#cbd5e1', marginTop: 2 }}>{companyPlace}</div>}
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, letterSpacing: '0.14em', color: '#94a3b8', fontWeight: 700 }}>
                  LOADING CODES
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, marginTop: 3 }}>{rangeLabel}</div>
              </div>
            </div>
          </div>

          <div
            style={{
              padding: '12px 22px',
              background: '#f8fafc',
              borderBottom: '1px solid #e7e5e4',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 16,
            }}
          >
            <div>
              <div style={{ fontSize: 10, letterSpacing: '0.12em', color: '#78716c', fontWeight: 700 }}>
                TRANSPORTER
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>{name}</div>
            </div>
            <div style={{ textAlign: 'right', fontSize: 12, color: '#57534e' }}>
              <div style={{ fontWeight: 700, color: '#1c1917' }}>
                {slots.length} {slots.length === 1 ? 'lorry' : 'lorries'}
              </div>
              <div>{tonnage(totalKg)} in all</div>
            </div>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: '#78716c' }}>
                <Th style={{ width: 120, paddingLeft: 22 }}>Code</Th>
                <Th style={{ width: 96 }}>Size</Th>
                <Th>Delivery to</Th>
                <Th style={{ width: 74 }}>Load at</Th>
                <Th style={{ width: 130, paddingRight: 22 }}>Lorry no.</Th>
              </tr>
            </thead>
            <tbody>
              {byDay.map(([key, daySlots]) => (
                <Fragment key={key}>
                  <tr>
                    <td
                      colSpan={5}
                      style={{
                        background: '#f1f5f9',
                        padding: '6px 22px',
                        fontSize: 10.5,
                        fontWeight: 700,
                        letterSpacing: '0.1em',
                        textTransform: 'uppercase',
                        color: '#334155',
                        borderTop: '1px solid #e2e8f0',
                        borderBottom: '1px solid #e2e8f0',
                      }}
                    >
                      {dayLabel(key)} · {daySlots.length} {daySlots.length === 1 ? 'lorry' : 'lorries'}
                    </td>
                  </tr>
                  {daySlots.map((s) => (
                    <tr key={s.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <Td
                        style={{
                          paddingLeft: 22,
                          fontWeight: 700,
                          fontFamily: "'Consolas', 'Menlo', monospace",
                        }}
                      >
                        {s.code}
                      </Td>
                      <Td style={{ fontWeight: 600 }}>{tonsLabel(s.vehicleClassKg)}</Td>
                      <Td>{s.saleOrder.destination || '-'}</Td>
                      <Td style={{ color: '#57534e' }}>{s.loadingPoint}</Td>
                      <Td
                        style={{
                          paddingRight: 22,
                          fontFamily: "'Consolas', 'Menlo', monospace",
                          fontWeight: s.lorryNumber ? 700 : 400,
                          color: s.lorryNumber ? '#15803d' : '#a8a29e',
                        }}
                      >
                        {s.lorryNumber ?? 'awaiting'}
                      </Td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>

          <div
            style={{
              padding: '12px 22px 16px',
              background: '#f8fafc',
              borderTop: '1px solid #e7e5e4',
              fontSize: 11.5,
              color: '#57534e',
              lineHeight: 1.5,
            }}
          >
            Kindly reply with the lorry number, driver name and driver mobile against each code.
            <div style={{ marginTop: 4, color: '#a8a29e' }}>
              Sent{' '}
              {new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} · A code
              never changes - always quote the code, not the date.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Th(props: { children: ReactNode; style?: CSSProperties }) {
  return (
    <th
      style={{
        textAlign: 'left',
        padding: '9px 10px',
        fontSize: 10,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        fontWeight: 700,
        borderBottom: '1px solid #e7e5e4',
        ...props.style,
      }}
    >
      {props.children}
    </th>
  );
}

function Td(props: { children: ReactNode; style?: CSSProperties }) {
  return <td style={{ padding: '8px 10px', verticalAlign: 'middle', ...props.style }}>{props.children}</td>;
}
