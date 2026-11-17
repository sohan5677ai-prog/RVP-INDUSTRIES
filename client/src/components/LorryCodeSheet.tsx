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
 * The document's own ink and paper.
 *
 * Fixed light colours, never the app's theme tokens: this is a picture that
 * leaves the building, and a planner working in dark mode must not send a
 * black card with grey text that a lorry driver cannot read in daylight.
 *
 * There is no brand colour here on purpose. An indent is a printed office
 * document - ruled, black on white, signed at the foot - and colour on it
 * reads as decoration rather than authority.
 */
const SHEET_W = 760;
const PAPER = '#FFFFFF';
const HEAD_FILL = '#F2F1EE';
const RULE = '#D9D6D0';
const RULE_DARK = '#1A1A1A';
const INK = '#141414';
const SUB = '#6B6660';
const SERIF_FONT = "Georgia, 'Times New Roman', 'Nimbus Roman', serif";
const BODY_FONT = "Arial, 'Helvetica Neue', Helvetica, system-ui, sans-serif";
const MONO = "'Consolas', 'Menlo', 'DejaVu Sans Mono', monospace";

/** `17-11-2026` → `RVP/LC/171126`. Identifies the sheet, nothing accounting. */
function sheetRef(companyName: string, issued: Date): string {
  const words = companyName.trim().split(/\s+/).filter(Boolean);
  const mark = (words[0]?.length ?? 0) <= 4 ? (words[0] ?? 'RVP') : words.map((w) => w[0]).join('').slice(0, 3);
  const dd = String(issued.getDate()).padStart(2, '0');
  const mm = String(issued.getMonth() + 1).padStart(2, '0');
  const yy = String(issued.getFullYear()).slice(2);
  return `${mark.toUpperCase()}/LC/${dd}${mm}${yy}`;
}

/** The running number down the left of the register, across every day. */
function rowNumber(byDay: Array<[string, unknown[]]>, dayIndex: number, rowIndex: number): number {
  let n = rowIndex + 1;
  for (let d = 0; d < dayIndex; d += 1) n += byDay[d][1].length;
  return n;
}

/** `Punganur, Chittoor, Andhra Pradesh - 517247` - the letterhead's second line. */
function addressLine(c?: CompanyProfile): string | null {
  if (!c) return null;
  const parts = [c.address, c.dispatchFromPlace, c.stateName, c.pincode].map((x) => x?.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const tail = c.pincode?.trim();
  const head = parts.filter((x) => x !== tail).join(', ');
  return tail ? `${head} - ${tail}` : head;
}

/** `Tel: 9440416639  ·  GSTIN: 37ABCDE1234F1Z5` - the line under the address. */
function contactLine(c?: CompanyProfile): string | null {
  if (!c) return null;
  const bits: string[] = [];
  if (c.contact?.trim()) bits.push(`Tel: ${c.contact.trim()}`);
  if (c.gstin?.trim()) bits.push(`GSTIN: ${c.gstin.trim()}`);
  return bits.length > 0 ? bits.join('   \u00b7   ') : null;
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
            companyAddress={addressLine(companyQ.data)}
            companyContact={contactLine(companyQ.data)}
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
  companyAddress: string | null;
  companyContact: string | null;
  rangeLabel: string;
  assigned: boolean;
}) {
  const { name, slots, companyName, companyAddress, companyContact, rangeLabel, assigned } = props;
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
  const fileName = `${slug(name)}-vehicle-indent.png`;

  const issued = new Date();
  const issueDate = issued.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const refNo = sheetRef(companyName, issued);
  const addressLineText = companyAddress;
  const contactLineText = companyContact;

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

      {/* The document itself. A fixed width, so the capture is the same
          whatever screen it was taken on. */}
      <div className="overflow-x-auto">
        <div
          ref={sheetRef}
          style={{
            width: SHEET_W,
            background: PAPER,
            color: INK,
            fontFamily: BODY_FONT,
            border: `1px solid ${RULE_DARK}`,
          }}
        >
          {/* Letterhead. Name, address, GSTIN, closed by a double rule - the
              head of every printed thing an Indian mill issues. */}
          <div style={{ padding: '22px 30px 16px', textAlign: 'center', borderBottom: `3px double ${RULE_DARK}` }}>
            <div
              style={{
                fontFamily: SERIF_FONT,
                fontSize: 27,
                fontWeight: 700,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                lineHeight: 1.1,
              }}
            >
              {companyName}
            </div>
            {addressLineText && (
              <div style={{ fontSize: 11, color: SUB, marginTop: 7, letterSpacing: '0.02em' }}>{addressLineText}</div>
            )}
            {contactLineText && (
              <div style={{ fontSize: 10.5, color: SUB, marginTop: 3, letterSpacing: '0.02em' }}>{contactLineText}</div>
            )}
          </div>

          {/* The document's name. Centred, spaced, on a tinted band - a reader
              should know what he is holding before he reads a single row. */}
          <div
            style={{
              padding: '8px 0 9px',
              textAlign: 'center',
              background: HEAD_FILL,
              borderBottom: `1px solid ${RULE}`,
            }}
          >
            <span style={{ fontFamily: SERIF_FONT, fontSize: 13, fontWeight: 700, letterSpacing: '0.34em' }}>
              VEHICLE INDENT
            </span>
          </div>

          {/* Who it is addressed to, and the three facts that identify this
              particular sheet. */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 24,
              padding: '14px 30px',
              borderBottom: `1px solid ${RULE_DARK}`,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 9.5, letterSpacing: '0.18em', color: SUB, fontWeight: 700 }}>TO</div>
              <div style={{ fontFamily: SERIF_FONT, fontSize: 16, fontWeight: 700, marginTop: 5 }}>M/s. {name}</div>
            </div>
            <table style={{ borderCollapse: 'collapse', fontSize: 11.5, flexShrink: 0 }}>
              <tbody>
                <MetaRow label="Sheet ref." value={refNo} mono />
                <MetaRow label="Date" value={issueDate} />
                <MetaRow label="Period" value={rangeLabel} />
              </tbody>
            </table>
          </div>

          {/* The register. Ruled on every side, the loading date carried once
              down the left in a merged cell, exactly as a loading programme is
              written out by hand. */}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: HEAD_FILL }}>
                <Th style={{ width: 34, textAlign: 'center' }}>#</Th>
                <Th style={{ width: 96 }}>Loading date</Th>
                <Th style={{ width: 104 }}>Code</Th>
                <Th style={{ width: 78 }}>Size</Th>
                <Th>Delivery to</Th>
                <Th style={{ width: 66, textAlign: 'center' }}>Load at</Th>
                <Th style={{ width: 142 }}>Vehicle no.</Th>
              </tr>
            </thead>
            <tbody>
              {byDay.map(([key, daySlots], dayIndex) =>
                daySlots.map((s, i) => (
                  <tr key={s.id}>
                    <Td style={{ textAlign: 'center', color: SUB }}>{rowNumber(byDay, dayIndex, i)}</Td>
                    {i === 0 && (
                      <Td
                        rowSpan={daySlots.length}
                        style={{ verticalAlign: 'top', fontWeight: 700, whiteSpace: 'nowrap' }}
                      >
                        {dayLabel(key)}
                        <div style={{ fontSize: 10, fontWeight: 400, color: SUB, marginTop: 3 }}>
                          {daySlots.length} {daySlots.length === 1 ? 'lorry' : 'lorries'}
                        </div>
                      </Td>
                    )}
                    <Td style={{ fontFamily: MONO, fontWeight: 700, letterSpacing: '0.03em' }}>{s.code}</Td>
                    <Td style={{ fontWeight: 700 }}>{tonsLabel(s.vehicleClassKg)}</Td>
                    <Td>{s.saleOrder.destination || '-'}</Td>
                    <Td style={{ textAlign: 'center' }}>{s.loadingPoint}</Td>
                    <Td style={{ fontFamily: MONO, fontWeight: 700 }}>
                      {s.lorryNumber ?? (
                        // Left blank on purpose: this is the line the transport
                        // office fills in and sends back.
                        <span style={{ display: 'block', borderBottom: `1px dotted ${RULE_DARK}`, height: 11 }} />
                      )}
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr style={{ background: HEAD_FILL }}>
                <Td colSpan={3} style={{ borderTop: `1px solid ${RULE_DARK}`, fontWeight: 700 }}>
                  Total
                </Td>
                <Td style={{ borderTop: `1px solid ${RULE_DARK}`, fontWeight: 700 }}>{tonsLabel(totalKg)}</Td>
                <Td colSpan={2} style={{ borderTop: `1px solid ${RULE_DARK}`, fontWeight: 700 }}>
                  {slots.length} {slots.length === 1 ? 'vehicle' : 'vehicles'}
                </Td>
                <Td style={{ borderTop: `1px solid ${RULE_DARK}`, color: SUB, fontSize: 11 }}>
                  {pending > 0 ? `${pending} awaited` : 'all confirmed'}
                </Td>
              </tr>
            </tfoot>
          </table>

          {/* What he is asked to do, and who asked - the close of a letter. */}
          <div style={{ display: 'flex', alignItems: 'stretch', borderTop: `1px solid ${RULE_DARK}` }}>
            <div style={{ flex: 1, padding: '13px 20px 16px 30px', borderRight: `1px solid ${RULE}` }}>
              <div style={{ fontSize: 9.5, letterSpacing: '0.18em', color: SUB, fontWeight: 700 }}>PLEASE NOTE</div>
              <div style={{ fontSize: 11.5, lineHeight: 1.75, marginTop: 6 }}>
                1. Kindly confirm the vehicle number, driver name and driver mobile against each code.
                <br />
                2. A code never changes - always quote the code, not the date.
              </div>
            </div>
            <div style={{ width: 238, padding: '13px 30px 16px 20px', textAlign: 'right' }}>
              <div style={{ fontSize: 11.5 }}>
                For <span style={{ fontWeight: 700 }}>{companyName}</span>
              </div>
              <div style={{ height: 44 }} />
              <div
                style={{
                  borderTop: `1px solid ${RULE_DARK}`,
                  paddingTop: 5,
                  fontSize: 10.5,
                  color: SUB,
                  letterSpacing: '0.04em',
                }}
              >
                Authorised Signatory
              </div>
            </div>
          </div>

          <div
            style={{
              padding: '7px 30px 8px',
              borderTop: `1px solid ${RULE}`,
              background: HEAD_FILL,
              fontSize: 9.5,
              color: SUB,
              letterSpacing: '0.04em',
              textAlign: 'center',
            }}
          >
            Issued electronically from the {companyName} ERP · {refNo}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One `label  value` line in the document's reference block. */
function MetaRow(props: { label: string; value: string; mono?: boolean }) {
  return (
    <tr>
      <td style={{ padding: '2px 10px 2px 0', color: SUB, whiteSpace: 'nowrap' }}>{props.label}</td>
      <td
        style={{
          padding: '2px 0',
          fontWeight: 700,
          whiteSpace: 'nowrap',
          fontFamily: props.mono ? MONO : undefined,
        }}
      >
        {props.value}
      </td>
    </tr>
  );
}

function Th(props: { children: ReactNode; style?: CSSProperties }) {
  return (
    <th
      style={{
        textAlign: 'left',
        padding: '7px 9px',
        fontSize: 9.5,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        fontWeight: 700,
        color: INK,
        border: `1px solid ${RULE}`,
        borderTop: `1px solid ${RULE_DARK}`,
        borderBottom: `1px solid ${RULE_DARK}`,
        ...props.style,
      }}
    >
      {props.children}
    </th>
  );
}

function Td(props: { children: ReactNode; style?: CSSProperties; rowSpan?: number; colSpan?: number }) {
  return (
    <td
      rowSpan={props.rowSpan}
      colSpan={props.colSpan}
      style={{ padding: '8px 9px', verticalAlign: 'middle', border: `1px solid ${RULE}`, ...props.style }}
    >
      {props.children}
    </td>
  );
}
