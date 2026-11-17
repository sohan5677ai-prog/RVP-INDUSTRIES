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

/**
 * The sheet's own palette.
 *
 * Fixed light colours, never the app's theme tokens: this is a picture that
 * leaves the building, and a planner working in dark mode must not send a
 * black card with grey text that a lorry driver cannot read in daylight. The
 * navy and the clay accent are the ERP's own, so a sheet on WhatsApp is
 * recognisably the same company as the screen it came from.
 */
const SHEET_W = 760;
const NAVY = '#0F2742';
const NAVY_LABEL = '#8CA6C4';
const NAVY_SOFT_TEXT = '#B6C7DA';
const ACCENT = '#C2410C';
const PAPER = '#FFFFFF';
const ZEBRA = '#FCFCFD';
const TINT = '#F7F8FA';
const BAND = '#EEF2F7';
const LINE = '#E4E7EC';
const LINE_STRONG = '#CDD3DB';
const HAIRLINE = '#F1F2F5';
const INK = '#111827';
const INK_SOFT = '#374151';
const MUTED = '#6B7280';
const MUTED_SOFT = '#9CA3AF';
const GREEN = '#15803D';
const MONO = "'Consolas', 'Menlo', 'DejaVu Sans Mono', monospace";

/**
 * The letterhead mark. A short first word is the house name itself ("RVP
 * Industries" is RVP, and that is what the transport office calls us);
 * anything longer falls back to initials.
 */
function monogram(companyName: string): string {
  const words = companyName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'RVP';
  if (words[0].length <= 4) return words[0].toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

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
            companyContact={companyQ.data?.contact || null}
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
 * The sheet itself is drawn in the fixed palette above, never the app's theme
 * tokens - see the note there.
 */
function TransporterSheet(props: {
  name: string;
  slots: DispatchSlot[];
  companyName: string;
  companyPlace: string | null;
  companyContact: string | null;
  rangeLabel: string;
  assigned: boolean;
}) {
  const { name, slots, companyName, companyPlace, companyContact, rangeLabel, assigned } = props;
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
            width: SHEET_W,
            background: PAPER,
            color: INK,
            fontFamily: "'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
            border: `1px solid ${LINE}`,
            borderRadius: 16,
            overflow: 'hidden',
          }}
        >
          {/* Letterhead. The mill's name carries the sheet, so it is read
              first; the monogram gives the picture a mark the transport office
              can pick out of a crowded WhatsApp group. */}
          <div style={{ padding: '22px 26px 20px', background: NAVY, color: '#ffffff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
                <div
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: 11,
                    background: 'rgba(255,255,255,0.10)',
                    border: '1px solid rgba(255,255,255,0.20)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 14,
                    fontWeight: 700,
                    letterSpacing: '0.04em',
                  }}
                >
                  {monogram(companyName)}
                </div>
                <div>
                  <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.01em' }}>{companyName}</div>
                  <div style={{ fontSize: 11.5, color: NAVY_SOFT_TEXT, marginTop: 3 }}>
                    {[companyPlace, companyContact].filter(Boolean).join('  ·  ') || 'Loading codes'}
                  </div>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 9.5, letterSpacing: '0.18em', color: NAVY_LABEL, fontWeight: 700 }}>
                  LOADING CODE SHEET
                </div>
                <div
                  style={{
                    display: 'inline-block',
                    marginTop: 7,
                    padding: '4px 11px',
                    borderRadius: 999,
                    background: 'rgba(255,255,255,0.12)',
                    border: '1px solid rgba(255,255,255,0.18)',
                    fontSize: 12.5,
                    fontWeight: 600,
                  }}
                >
                  {rangeLabel}
                </div>
              </div>
            </div>
          </div>
          <div style={{ height: 3, background: ACCENT }} />

          {/* Who it is for, and the three figures he checks before reading a
              single row: how many lorries, how much tonnage, how many still
              owe us a number. */}
          <div
            style={{
              padding: '16px 26px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 20,
              borderBottom: `1px solid ${LINE}`,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 9.5, letterSpacing: '0.16em', color: MUTED, fontWeight: 700 }}>PREPARED FOR</div>
              <div style={{ fontSize: 17, fontWeight: 700, marginTop: 4, letterSpacing: '-0.01em' }}>{name}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
              <Stat label="Lorries" value={String(slots.length)} />
              <Stat label="Tonnage" value={tonnage(totalKg)} divider />
              <Stat label="Awaiting no." value={String(pending)} divider tone={pending > 0 ? ACCENT : GREEN} />
            </div>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: TINT, color: MUTED }}>
                <Th style={{ width: 128, paddingLeft: 26 }}>Code</Th>
                <Th style={{ width: 92 }}>Size</Th>
                <Th>Delivery to</Th>
                <Th style={{ width: 84 }}>Load at</Th>
                <Th style={{ width: 138, paddingRight: 26 }}>Lorry no.</Th>
              </tr>
            </thead>
            <tbody>
              {byDay.map(([key, daySlots]) => (
                <Fragment key={key}>
                  <tr>
                    <td colSpan={5} style={{ padding: 0, borderTop: `1px solid ${LINE}`, borderBottom: `1px solid ${LINE}` }}>
                      {/* The day band is the sheet's spine: a transport office
                          reads it as "what am I sending on Thursday", so the
                          date is given room and the day's own load sits against
                          it. */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 12,
                          padding: '8px 26px',
                          background: BAND,
                          borderLeft: `3px solid ${NAVY}`,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 11.5,
                            fontWeight: 700,
                            letterSpacing: '0.08em',
                            textTransform: 'uppercase',
                            color: NAVY,
                          }}
                        >
                          {dayLabel(key)}
                        </span>
                        <span style={{ fontSize: 11, color: MUTED, fontWeight: 600 }}>
                          {daySlots.length} {daySlots.length === 1 ? 'lorry' : 'lorries'} ·{' '}
                          {tonnage(daySlots.reduce((sum, x) => sum + x.vehicleClassKg, 0))}
                        </span>
                      </div>
                    </td>
                  </tr>
                  {daySlots.map((s, i) => (
                    <tr
                      key={s.id}
                      style={{ background: i % 2 === 1 ? ZEBRA : PAPER, borderBottom: `1px solid ${HAIRLINE}` }}
                    >
                      <Td style={{ paddingLeft: 26 }}>
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '4px 9px',
                            borderRadius: 7,
                            background: NAVY,
                            color: '#ffffff',
                            fontFamily: MONO,
                            fontSize: 11.5,
                            fontWeight: 700,
                            letterSpacing: '0.04em',
                          }}
                        >
                          {s.code}
                        </span>
                      </Td>
                      <Td style={{ fontWeight: 700 }}>{tonsLabel(s.vehicleClassKg)}</Td>
                      <Td style={{ fontWeight: 600 }}>{s.saleOrder.destination || '-'}</Td>
                      <Td>
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '2px 8px',
                            borderRadius: 999,
                            border: `1px solid ${LINE}`,
                            background: TINT,
                            fontSize: 10.5,
                            fontWeight: 700,
                            letterSpacing: '0.04em',
                            color: INK_SOFT,
                          }}
                        >
                          {s.loadingPoint}
                        </span>
                      </Td>
                      <Td style={{ paddingRight: 26 }}>
                        {s.lorryNumber ? (
                          <span style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 700, color: GREEN }}>
                            {s.lorryNumber}
                          </span>
                        ) : (
                          <span
                            style={{
                              display: 'inline-block',
                              padding: '2px 9px',
                              borderRadius: 999,
                              border: `1px dashed ${LINE_STRONG}`,
                              fontSize: 10.5,
                              fontWeight: 600,
                              color: MUTED,
                            }}
                          >
                            awaiting
                          </span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>

          {/* The one thing he is being asked to do, said once and plainly. */}
          <div style={{ padding: '16px 26px 18px', background: TINT, borderTop: `1px solid ${LINE}` }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
              <div style={{ width: 3, borderRadius: 2, background: ACCENT, flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: INK, lineHeight: 1.45 }}>
                  Kindly reply with the lorry number, driver name and driver mobile against each code.
                </div>
                <div style={{ fontSize: 11, color: MUTED, marginTop: 4, lineHeight: 1.5 }}>
                  A code never changes - always quote the code, not the date.
                </div>
              </div>
            </div>
            <div
              style={{
                marginTop: 12,
                paddingTop: 10,
                borderTop: `1px solid ${LINE}`,
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 10,
                color: MUTED_SOFT,
                letterSpacing: '0.04em',
              }}
            >
              <span>{companyName.toUpperCase()}</span>
              <span>
                Issued {new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One figure in the sheet's summary strip. */
function Stat(props: { label: string; value: string; divider?: boolean; tone?: string }) {
  return (
    <div style={{ padding: '0 16px', textAlign: 'right', borderLeft: props.divider ? `1px solid ${LINE}` : undefined }}>
      <div style={{ fontSize: 17, fontWeight: 700, color: props.tone ?? INK, letterSpacing: '-0.01em' }}>
        {props.value}
      </div>
      <div style={{ fontSize: 9.5, letterSpacing: '0.12em', color: MUTED, fontWeight: 700, marginTop: 3 }}>
        {props.label.toUpperCase()}
      </div>
    </div>
  );
}

function Th(props: { children: ReactNode; style?: CSSProperties }) {
  return (
    <th
      style={{
        textAlign: 'left',
        padding: '10px 10px',
        fontSize: 9.5,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        fontWeight: 700,
        borderBottom: `1px solid ${LINE}`,
        ...props.style,
      }}
    >
      {props.children}
    </th>
  );
}

function Td(props: { children: ReactNode; style?: CSSProperties }) {
  return <td style={{ padding: '10px 10px', verticalAlign: 'middle', ...props.style }}>{props.children}</td>;
}
