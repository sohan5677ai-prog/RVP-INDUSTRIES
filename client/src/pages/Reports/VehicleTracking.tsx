import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Navigation,
  RefreshCw,
  Search,
  Truck,
  MapPin,
  Gauge,
  Clock,
  CircleDot,
  SatelliteDish,
  AlertTriangle,
  Copy,
  ExternalLink,
  Loader2,
  TimerReset,
  Route as RouteIcon,
  Flag,
  Phone,
} from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { VehicleMap, STATE_COLOURS, type MapState } from '@/components/VehicleMap';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Segmented } from '@/components/ui/segmented';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * Vehicle Tracking - where every lorry is, and what that means for the loads
 * they are carrying.
 *
 * The provider's feed is the transporter's whole fleet, not ours, so the page
 * is built around one distinction: a lorry carrying one of our dispatches has
 * a buyer, a destination, an ETA and a reason to be chased, and the other 120
 * are context. Everything - sort order, the default filter, the colour of the
 * marker - follows from that.
 *
 * The browser never talks to the provider. It reads /api/gps/fleet, which is
 * our own stored positions already joined to the dispatch, so the page costs
 * the provider nothing however many people have it open, and their key never
 * leaves the server.
 */

/* --------------------------------------------------------------- the shapes */

interface DispatchContext {
  dispatchId: string;
  saleOrderId: string;
  invoiceNumber: string | null;
  poNumber: string | null;
  buyer: string;
  broker: string | null;
  product: string;
  destination: string | null;
  weightKg: number;
  dispatchDate: string;
  driverName: string | null;
  driverPhone: string | null;
  transport: string | null;
}

interface Journey {
  destination: string | null;
  totalKm: number | null;
  remainingKm: number | null;
  coveredKm: number | null;
  progressPct: number | null;
  etaAt: string | null;
  /**
   * How the distance was arrived at. PIN_ROUTED is road kilometres measured
   * along the actual route to the buyer's own pin - the only one that is a
   * measurement. PIN_STRAIGHT is the right pin as the crow flies. TOWN_CENTRE
   * is the town, which can be ten km from the gate. Shown on screen, because
   * these are different claims and a number alone hides which one it is.
   */
  source: 'PIN_ROUTED' | 'PIN_STRAIGHT' | 'TOWN_CENTRE' | 'NONE' | string;
  /** Km from the route the lorry was given. Only known on a routed lane. */
  offRouteKm: number | null;
  /** True when that gap is wide enough to mean he has left the route. */
  offRoute: boolean;
}

/** What the distance figure beside a lorry actually rests on. */
const SOURCE_NOTE: Record<string, string> = {
  PIN_ROUTED: 'by road to the buyer’s pin',
  PIN_STRAIGHT: 'straight line to the buyer’s pin',
  TOWN_CENTRE: 'town centre - no pin for this buyer',
  NONE: 'destination not located',
};

interface FleetVehicle {
  vehicleNumber: string;
  vehicleLabel: string;
  latitude: number | null;
  longitude: number | null;
  speedKmph: number | null;
  headingDeg: number | null;
  ignition: boolean | null;
  address: string | null;
  odometerRaw: number | null;
  providerStatus: string | null;
  recordedAt: string | null;
  receivedAt: string | null;
  ageMinutes: number | null;
  state: MapState;
  distanceFromFactoryKm: number | null;
  dispatch: DispatchContext | null;
  journey: Journey | null;
  provider: string;
}

interface FleetResponse {
  generatedAt: string;
  factory: { name: string; latitude: number; longitude: number };
  staleAfterMinutes: number;
  counts: {
    total: number; onDispatch: number; moving: number;
    idling: number; parked: number; offline: number; noSignal: number;
  };
  vehicles: FleetVehicle[];
}

/**
 * A lorry on its way to the gate, as /gps/arrivals returns it.
 *
 * Two kinds share this shape. A PURCHASE lorry is coming to us loaded against
 * a purchase order; a LOADING lorry is an empty one the transporter has sent to
 * collect a sale load, confirmed against a slot on the loading calendar. Both
 * are "a lorry arriving that nobody has told the yard about", which is the
 * question this tab answers.
 *
 * Keyed by booking, not by plate: an arrival exists from the moment the
 * transporter quotes the requirement code back, which is usually a day or two
 * before any position does - and for a transporter outside the tracked account,
 * forever. `tracked` says which of those two this row is, and nothing on screen
 * may present an untracked row's ETA as a measurement.
 */
interface InboundArrival {
  id: string;
  kind: 'PURCHASE' | 'LOADING';
  bookingId: string | null;
  slotId: string | null;
  requirementCode: string | null;
  lorryNumber: string | null;
  driverName: string | null;
  driverPhone: string | null;
  fromPlace: string | null;
  fromPhone: string;
  bookedAt: string;
  briefSentAt: string | null;
  purchaseOrderId: string | null;
  poNumber: string | null;
  /** The supplier on a purchase arrival, the buyer on a loading one. */
  counterparty: string;
  transportName: string | null;
  /** Where a LOADING lorry goes once loaded. Null on a purchase arrival. */
  destination: string | null;
  load: string;
  tonnageKg: number | null;
  tracked: boolean;
  /** On the feed, but the last fix is too old to be read as a position. */
  positionIsStale: boolean;
  /** Due today or overdue, with nothing live to say where it is. */
  awaitingAtMill: boolean;
  dueAt: string | null;
  latitude: number | null;
  longitude: number | null;
  speedKmph: number | null;
  headingDeg: number | null;
  address: string | null;
  recordedAt: string | null;
  ageMinutes: number | null;
  state: MapState;
  distanceKm: number | null;
  etaAt: string | null;
  etaIsEstimate: boolean;
  phase: 'BOOKED' | 'EN_ROUTE' | 'APPROACHING' | 'AT_GATE';
  ringsFired: number[];
}

interface ArrivalsResponse {
  generatedAt: string;
  factory: { name: string; latitude: number; longitude: number };
  rings: { approachKm: number; gateKm: number; alertsEnabled: boolean };
  counts: {
    total: number; atGate: number; approaching: number;
    enRoute: number; booked: number; untracked: number;
    purchase: number; loading: number;
  };
  arrivals: InboundArrival[];
}

interface TrailPoint {
  latitude: number;
  longitude: number;
  speedKmph: number | null;
  headingDeg: number | null;
  ignition: boolean | null;
  providerStatus: string | null;
  address: string | null;
  recordedAt: string;
}

interface VehicleDetail {
  vehicleNumber: string;
  window: { from: string; to: string };
  latest: (TrailPoint & { ageMinutes: number | null; state: MapState; odometerRaw: number | null; distanceFromFactoryKm: number }) | null;
  dispatch: DispatchContext | null;
  journey: Journey | null;
  stats: {
    points: number; distanceKm: number; movingMinutes: number; standingMinutes: number;
    maxSpeedKmph: number; avgMovingKmph: number; stopCount: number;
  };
  stops: { from: string; to: string; minutes: number; latitude: number; longitude: number }[];
  trail: TrailPoint[];
}

interface GpsStatus {
  provider: string;
  configured: boolean;
  enabled: boolean;
  pollSeconds: number;
  lastPoll: { ok: boolean; at: string; fetched: number; stored: number; onDispatch: number; error?: string } | null;
  rowsLast24h: number;
  historySince: string | null;
}

/* ------------------------------------------------------------- the wording */

const STATE_LABEL: Record<MapState, string> = {
  MOVING: 'Moving',
  IDLING: 'Idling',
  PARKED: 'Parked',
  OFFLINE: 'Out of contact',
  NO_SIGNAL: 'Never reported',
};

const PHASE_LABEL: Record<InboundArrival['phase'], string> = {
  AT_GATE: 'At the gate',
  APPROACHING: 'Approaching',
  EN_ROUTE: 'On the road',
  BOOKED: 'Booked',
};

/**
 * Phase colours, deliberately not the vehicle-state colours.
 *
 * A row here answers "how soon", not "is the engine running": an arriving lorry
 * parked two km away still needs the kata ready, and one moving at 70 km/h four
 * hundred km out does not. Reusing STATE_COLOURS would say the opposite.
 */
const PHASE_TONE: Record<InboundArrival['phase'], string> = {
  AT_GATE: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  APPROACHING: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  EN_ROUTE: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  BOOKED: 'bg-muted text-muted-foreground',
};

/** "2 min ago", "3 h ago" - an age, not a timestamp, because age is the question. */
function ago(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return 'never';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Minutes as "4h 20m" - the form a transporter argues in. */
function duration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function clockIst(iso: string | null | undefined): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    hour12: true, timeZone: 'Asia/Kolkata',
  });
}

function timeIst(iso: string | null | undefined): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
  });
}

function tonnes(kg: number): string {
  return `${(kg / 1000).toFixed(2)} t`;
}

function StateDot({ state, className }: { state: MapState; className?: string }) {
  return (
    <span
      className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-full', className)}
      style={{ backgroundColor: STATE_COLOURS[state] }}
      aria-hidden="true"
    />
  );
}

function StateBadge({ state }: { state: MapState }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ backgroundColor: `${STATE_COLOURS[state]}1f`, color: STATE_COLOURS[state] }}
    >
      <StateDot state={state} />
      {STATE_LABEL[state]}
    </span>
  );
}

/* -------------------------------------------------------------- the list row */

function VehicleRow({
  vehicle, selected, onClick,
}: { vehicle: FleetVehicle; selected: boolean; onClick: () => void }) {
  const d = vehicle.dispatch;
  const j = vehicle.journey;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full rounded-xl border p-3 text-left transition-colors duration-200',
        selected
          ? 'border-primary/50 bg-primary/[0.07]'
          : 'border-border/60 bg-card/40 hover:border-primary/30 hover:bg-accent/40'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <StateDot state={vehicle.state} />
          <span className="truncate font-mono text-sm font-semibold tracking-tight">{vehicle.vehicleLabel}</span>
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {vehicle.state === 'MOVING' && vehicle.speedKmph != null
            ? `${Math.round(vehicle.speedKmph)} km/h`
            : ago(vehicle.ageMinutes)}
        </span>
      </div>

      {d ? (
        <div className="mt-1.5 min-w-0">
          <div className="truncate text-xs font-medium text-foreground">
            {d.buyer}
            {d.destination && <span className="text-muted-foreground"> &middot; {d.destination}</span>}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {d.product} &middot; {tonnes(d.weightKg)}
            {j?.remainingKm != null && <> &middot; {j.remainingKm} km to go</>}
          </div>
          {/* Where the distance came from. A routed figure needs no caption -
              it is the one people should expect - but a straight line or a town
              centre has to say so, or the board quietly overstates what it
              knows. */}
          {j?.remainingKm != null && j.source !== 'PIN_ROUTED' && (
            <div className="mt-0.5 truncate text-[10px] text-muted-foreground/80">
              {SOURCE_NOTE[j.source] ?? j.source}
            </div>
          )}
          {/* The signal straight-line distance could never give: he is not on
              the road he was given. */}
          {j?.offRoute && (
            <div className="mt-1 inline-flex items-center gap-1 rounded-md bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
              <AlertTriangle className="h-3 w-3" />
              {j.offRouteKm} km off route
            </div>
          )}
          {j?.progressPct != null && (
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${j.progressPct}%` }}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="mt-1.5 truncate text-[11px] text-muted-foreground">
          {vehicle.state === 'NO_SIGNAL'
            ? 'On a dispatch but never reported'
            : `No consignment · ${vehicle.distanceFromFactoryKm ?? '-'} km from the factory`}
        </div>
      )}
    </button>
  );
}

/* ----------------------------------------------------- the arriving-lorry row */

/**
 * One arriving purchase lorry.
 *
 * Reads top-down the way the yard asks about it: how far out, then whose load
 * it is, then the driver's number - which is the first thing anyone reaches for
 * when a lorry is late or lost on the approach road.
 */
function ArrivalRow({
  arrival, rings, selected, onClick,
}: {
  arrival: InboundArrival;
  rings: ArrivalsResponse['rings'];
  selected: boolean;
  onClick: () => void;
}) {
  const a = arrival;
  return (
    <div
      className={cn(
        'w-full rounded-xl border p-3 text-left transition-colors duration-200',
        selected
          ? 'border-primary/50 bg-primary/[0.07]'
          : 'border-border/60 bg-card/40 hover:border-primary/30'
      )}
    >
      <button type="button" onClick={onClick} className="block w-full text-left">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <Truck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-sm font-semibold tracking-tight">
              {a.lorryNumber ?? 'No lorry number'}
            </span>
          </span>
          <span
            className={cn(
              'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
              PHASE_TONE[a.phase]
            )}
          >
            {a.distanceKm !== null ? `${a.distanceKm} km` : PHASE_LABEL[a.phase]}
          </span>
        </div>

        <div className="mt-1.5 min-w-0">
          <div className="truncate text-xs font-medium text-foreground">
            {a.counterparty}
            {/* Where he came from on a purchase lorry; where he is taking it on
                a loading one. Only one of the two is ever set. */}
            {a.fromPlace && <span className="text-muted-foreground"> &middot; {a.fromPlace}</span>}
            {a.destination && <span className="text-muted-foreground"> &middot; to {a.destination}</span>}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {/* An empty lorry is labelled as one. The load is what it has come
                for, not what it is carrying, and a yard reading "Pappu 35 MT"
                on an inbound row would go looking for a load that is not
                there. */}
            {a.kind === 'LOADING' ? `Empty - for ${a.load}` : a.load}
            {a.requirementCode && <> &middot; <span className="font-mono">{a.requirementCode}</span></>}
            {a.transportName && <> &middot; {a.transportName}</>}
          </div>

          {/* Progress is measured inward, so the bar fills as the lorry gets
              closer - and only for a tracked lorry, because there is nothing to
              measure otherwise. Scaled to the approach ring rather than the
              whole run: the last ten km is the part anyone is watching. */}
          {a.distanceKm !== null && (
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'h-full rounded-full transition-[width] duration-500',
                  a.phase === 'AT_GATE' ? 'bg-rose-500' : a.phase === 'APPROACHING' ? 'bg-amber-500' : 'bg-emerald-500'
                )}
                style={{
                  width: `${Math.max(
                    4,
                    Math.min(100, 100 - (a.distanceKm / Math.max(rings.approachKm, 1)) * 100)
                  )}%`,
                }}
              />
            </div>
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {a.etaAt && (
              <span className="inline-flex items-center gap-1">
                <TimerReset className="h-3 w-3" />
                {timeIst(a.etaAt)}
                {/* An estimate off the booking is labelled as one. A board that
                    presents a guess as a measurement is how a yard learns to
                    stop believing the board. */}
                {a.etaIsEstimate && <span className="opacity-70">(est.)</span>}
              </span>
            )}
            {a.positionIsStale ? (
              // On the feed but long silent. Said plainly, because the board
              // used to draw this lorry a confident distance away off a fix
              // weeks old - on a day it was standing in the yard.
              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3" /> Last seen {ago(a.ageMinutes)}
              </span>
            ) : a.tracked ? (
              <span className="inline-flex items-center gap-1">
                <SatelliteDish className="h-3 w-3" /> {ago(a.ageMinutes)}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3" /> Not on the GPS feed
              </span>
            )}
            {a.awaitingAtMill && (
              <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
                <Flag className="h-3 w-3" /> Due at the mill
              </span>
            )}
            {a.ringsFired.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <Flag className="h-3 w-3" /> told at {a.ringsFired.join(', ')} km
              </span>
            )}
          </div>
        </div>
      </button>

      {a.driverPhone && (
        <div className="mt-2 flex items-center gap-2 border-t border-border/50 pt-2">
          <a
            href={`tel:${a.driverPhone}`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent/60 px-2 py-1 font-mono text-[11px] font-medium hover:bg-accent"
          >
            <Phone className="h-3 w-3" /> {a.driverPhone}
          </a>
          {a.driverName && <span className="truncate text-[11px] text-muted-foreground">{a.driverName}</span>}
          {a.briefSentAt && (
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">briefed</span>
          )}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- the detail */

function DetailStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-base font-medium tabular-nums text-foreground">{value}</div>
      {hint && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

const WINDOWS = [
  { label: '6 h', value: '6' },
  { label: '24 h', value: '24' },
  { label: '3 d', value: '72' },
  { label: '7 d', value: '168' },
];

function VehicleDetailDialog({
  vehicleNumber, factory, open, onOpenChange,
}: {
  vehicleNumber: string | null;
  factory: FleetResponse['factory'] | undefined;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [hours, setHours] = useState('24');

  const { data, isLoading, isError, error } = useQuery<VehicleDetail>({
    queryKey: ['gps-detail', vehicleNumber, hours],
    queryFn: () => api(`/gps/vehicles/${encodeURIComponent(vehicleNumber ?? '')}/detail?hours=${hours}`),
    enabled: open && Boolean(vehicleNumber),
    refetchInterval: open ? 120_000 : false,
  });

  const latest = data?.latest ?? null;
  const d = data?.dispatch ?? null;
  const j = data?.journey ?? null;

  // "RVP Industries, Punganur" -> "Punganur": the progress bar has room for a
  // place, not for the company name we already know we are looking at. Taken
  // from the server's own factory record so the two can never disagree.
  const factoryName = factory?.name.split(',').pop()?.trim() ?? 'Factory';

  const mapVehicles = useMemo(() => {
    if (!latest || !data) return [];
    return [{
      vehicleNumber: data.vehicleNumber,
      vehicleLabel: data.vehicleNumber,
      latitude: latest.latitude,
      longitude: latest.longitude,
      headingDeg: latest.headingDeg,
      speedKmph: latest.speedKmph,
      state: latest.state,
      subtitle: d ? `${d.buyer} - ${d.destination ?? ''}` : null,
    }];
  }, [latest, data, d]);

  const landmarks = useMemo(() => {
    const out: { name: string; latitude: number; longitude: number; kind: 'factory' | 'destination' }[] = [];
    if (factory) out.push({ ...factory, kind: 'factory' });
    return out;
  }, [factory]);

  /**
   * The "where is my lorry" answer, as a line that can go straight into
   * WhatsApp. It is the message the office types by hand several times a day,
   * and typing it by hand is how the wrong ETA reaches a buyer.
   */
  function copyUpdate() {
    if (!data || !latest) return;
    const bits = [
      `Vehicle ${data.vehicleNumber}`,
      d ? `carrying ${tonnes(d.weightKg)} ${d.product} for ${d.buyer}` : null,
      latest.state === 'MOVING' && latest.speedKmph != null
        ? `is moving at ${Math.round(latest.speedKmph)} km/h`
        : `is ${STATE_LABEL[latest.state].toLowerCase()}`,
      j?.remainingKm != null && j.destination ? `${j.remainingKm} km from ${j.destination}` : null,
      j?.etaAt ? `expected ${clockIst(j.etaAt)}` : null,
      `(position as of ${clockIst(latest.recordedAt)} IST)`,
    ].filter(Boolean);
    const text = `${bits.join(', ')}.`;
    navigator.clipboard.writeText(text).then(
      () => toast.success('Status copied - paste it into WhatsApp'),
      () => toast.error('Could not copy to the clipboard')
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-3">
            <span className="font-mono tracking-tight">{vehicleNumber}</span>
            {latest && <StateBadge state={latest.state} />}
            {d && (
              <Badge variant="soft" className="gap-1">
                <Truck className="h-3 w-3" /> On dispatch
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {isLoading && (
          <div className="flex h-64 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading the trail&hellip;
          </div>
        )}

        {isError && (
          <div className="flex h-32 items-center justify-center text-sm text-destructive">
            {getErrorMessage(error)}
          </div>
        )}

        {data && !isLoading && (
          <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
            {/* ------------------------------------------------ map + trail */}
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Segmented options={WINDOWS} value={hours} onValueChange={setHours} size="sm" />
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={copyUpdate} disabled={!latest}>
                    <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy status
                  </Button>
                  {latest && (
                    <Button variant="outline" size="sm" asChild>
                      <a
                        href={`https://www.google.com/maps?q=${latest.latitude},${latest.longitude}`}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Maps
                      </a>
                    </Button>
                  )}
                </div>
              </div>

              <VehicleMap
                vehicles={mapVehicles}
                trail={data.trail}
                landmarks={landmarks}
                selected={data.vehicleNumber}
                fitKey={`${data.vehicleNumber}-${hours}-${data.trail.length}`}
                className="h-[360px] w-full overflow-hidden rounded-xl border border-border/60"
              />

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <DetailStat label="Distance" value={`${data.stats.distanceKm} km`} hint="along the trail" />
                <DetailStat label="Driving" value={duration(data.stats.movingMinutes)} hint={`avg ${data.stats.avgMovingKmph} km/h`} />
                <DetailStat label="Standing" value={duration(data.stats.standingMinutes)} hint={`${data.stats.stopCount} halts`} />
                <DetailStat label="Top speed" value={`${data.stats.maxSpeedKmph} km/h`} hint={`${data.stats.points} fixes`} />
              </div>
            </div>

            {/* ------------------------------------------------ the context */}
            <div className="space-y-3">
              {latest && (
                <div className="rounded-xl border border-border/60 bg-card/40 p-3.5">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    <SatelliteDish className="h-3.5 w-3.5" /> Last fix
                  </div>
                  <div className="mt-2 grid gap-1.5 text-sm">
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground">Reported</span>
                      <span className="font-mono tabular-nums">{clockIst(latest.recordedAt)} ({ago(latest.ageMinutes)})</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground">Speed</span>
                      <span className="font-mono tabular-nums">{latest.speedKmph != null ? `${Math.round(latest.speedKmph)} km/h` : '-'}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground">Ignition</span>
                      <span className="font-mono">{latest.ignition === null ? '-' : latest.ignition ? 'On' : 'Off'}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground">From the factory</span>
                      <span className="font-mono tabular-nums">{latest.distanceFromFactoryKm} km</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground">Coordinates</span>
                      <span className="font-mono text-xs tabular-nums">
                        {latest.latitude.toFixed(4)}, {latest.longitude.toFixed(4)}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {d && (
                <div className="rounded-xl border border-primary/25 bg-primary/[0.05] p-3.5">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-primary">
                    <RouteIcon className="h-3.5 w-3.5" /> This consignment
                  </div>
                  <div className="mt-2 grid gap-1.5 text-sm">
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground">Buyer</span>
                      <span className="truncate font-medium">{d.buyer}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground">Load</span>
                      <span className="font-mono tabular-nums">{tonnes(d.weightKg)} {d.product}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground">Dispatched</span>
                      <span className="font-mono tabular-nums">{clockIst(d.dispatchDate)}</span>
                    </div>
                    {d.invoiceNumber && (
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">Invoice</span>
                        <span className="font-mono">{d.invoiceNumber}</span>
                      </div>
                    )}
                    {d.transport && (
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">Transport</span>
                        <span className="truncate">{d.transport}</span>
                      </div>
                    )}
                    {d.driverName && (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">Driver</span>
                        <span className="truncate">
                          {d.driverName}
                          {d.driverPhone && (
                            <a className="ml-2 inline-flex items-center gap-1 text-primary hover:underline" href={`tel:${d.driverPhone}`}>
                              <Phone className="h-3 w-3" /> {d.driverPhone}
                            </a>
                          )}
                        </span>
                      </div>
                    )}
                  </div>

                  {j?.progressPct != null && (
                    <div className="mt-3">
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>{factoryName}</span>
                        <span>{j.destination}</span>
                      </div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${j.progressPct}%` }} />
                      </div>
                      <div className="mt-1.5 flex items-center justify-between text-[11px]">
                        <span className="font-mono tabular-nums text-muted-foreground">
                          {j.coveredKm} / {j.totalKm} km
                        </span>
                        {j.etaAt && (
                          <span className="inline-flex items-center gap-1 font-medium text-primary">
                            <Flag className="h-3 w-3" /> ETA {clockIst(j.etaAt)}
                          </span>
                        )}
                      </div>
                      <p className="mt-1.5 text-[10.5px] leading-snug text-muted-foreground">
                        Straight-line distance &times; 1.25 at 40 km/h average. A planning figure, not a routed ETA.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {data.stops.length > 0 && (
                <div className="rounded-xl border border-border/60 bg-card/40 p-3.5">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    <TimerReset className="h-3.5 w-3.5" /> Halts over 20 minutes
                  </div>
                  <div className="mt-2 max-h-52 space-y-1.5 overflow-y-auto pr-1">
                    {data.stops.map((s) => (
                      <div key={s.from} className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-2.5 py-1.5 text-xs">
                        <span className="font-mono tabular-nums text-muted-foreground">
                          {timeIst(s.from)} &ndash; {timeIst(s.to)}
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="font-mono font-semibold tabular-nums">{duration(s.minutes)}</span>
                          <a
                            className="text-primary hover:underline"
                            href={`https://www.google.com/maps?q=${s.latitude},${s.longitude}`}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            <MapPin className="h-3.5 w-3.5" />
                          </a>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {data.trail.length === 0 && (
                <div className="rounded-xl border border-dashed border-border/70 p-4 text-center text-sm text-muted-foreground">
                  No positions in this window. The trail only exists from the moment the ERP started polling &mdash; the
                  provider has no history endpoint.
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ the page */

type Filter = 'DISPATCH' | 'INBOUND' | 'ALL' | MapState;

export default function VehicleTracking() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('DISPATCH');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const fleet = useQuery<FleetResponse>({
    queryKey: ['gps-fleet'],
    queryFn: () => api('/gps/fleet'),
    // Match the server's poll interval: asking more often than the provider is
    // pulled just re-reads the same row, and this response is the whole feed -
    // every refetch is ~70 KB out of Render and 145 rows out of Supabase, for
    // as long as anyone leaves the page open.
    refetchInterval: 120_000,
  });

  /**
   * Arriving purchase lorries. Always fetched, not only on its own tab, so the
   * count on the segmented control is live - a lorry two km out is news whether
   * or not someone happens to be looking at that tab. Cheap enough to do that
   * with: a handful of bookings, not the 145-vehicle feed.
   *
   * Polled twice as often as the fleet board for the same reason: the last ten
   * km of an approach is where two minutes matters.
   */
  const arrivalsQuery = useQuery<ArrivalsResponse>({
    queryKey: ['gps-arrivals'],
    queryFn: () => api('/gps/arrivals'),
    refetchInterval: 60_000,
  });

  const status = useQuery<GpsStatus>({
    queryKey: ['gps-status'],
    queryFn: () => api('/gps/status'),
    refetchInterval: 120_000,
  });

  const refresh = useMutation({
    mutationFn: () => api<{ ok: boolean; stored: number; fetched: number; error?: string }>('/gps/poll', { method: 'POST' }),
    onSuccess: (result) => {
      if (result.ok) toast.success(`${result.fetched} vehicles read, ${result.stored} new positions stored`);
      else toast.error(result.error ?? 'The provider did not return positions');
      queryClient.invalidateQueries({ queryKey: ['gps-fleet'] });
      queryClient.invalidateQueries({ queryKey: ['gps-status'] });
      queryClient.invalidateQueries({ queryKey: ['gps-arrivals'] });
      if (selected) queryClient.invalidateQueries({ queryKey: ['gps-detail', selected] });
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const vehicles = fleet.data?.vehicles ?? [];
  const counts = fleet.data?.counts;
  const arrivals = arrivalsQuery.data?.arrivals ?? [];
  const arrivalCounts = arrivalsQuery.data?.counts;
  const rings = arrivalsQuery.data?.rings ?? { approachKm: 10, gateKm: 3, alertsEnabled: true };
  const inbound = filter === 'INBOUND';

  /** Arrivals matching the search box, which searches supplier and code too. */
  const shownArrivals = useMemo(() => {
    const needle = search.trim().toUpperCase();
    const plate = needle.replace(/[^A-Z0-9]/g, '');
    if (!needle) return arrivals;
    return arrivals.filter(
      (a) =>
        (plate && (a.lorryNumber ?? '').includes(plate)) ||
        (a.counterparty ?? '').toUpperCase().includes(needle) ||
        (a.requirementCode ?? '').toUpperCase().includes(needle) ||
        (a.fromPlace ?? '').toUpperCase().includes(needle)
    );
  }, [arrivals, search]);

  /**
   * On-dispatch lorries we can actually draw.
   *
   * Not the same as `counts.onDispatch`: a shipment whose plate has never
   * reported still counts as on dispatch, and on a fleet where none of our
   * lorries carries a tracked device - which is the case today - defaulting to
   * that filter would open the page on an empty map and a list of red rows.
   */
  const plottedOnDispatch = useMemo(
    () => vehicles.filter((v) => v.dispatch && v.latitude !== null).length,
    [vehicles]
  );

  // So: open on our consignments when there is something to see there, and on
  // the whole fleet when there is not. One rule, and it stops applying by
  // itself the day the lorries we hire are on a tracked device.
  const [filterTouched, setFilterTouched] = useState(false);
  useEffect(() => {
    if (filterTouched || !fleet.data) return;
    if (plottedOnDispatch === 0 && filter === 'DISPATCH') setFilter('ALL');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plottedOnDispatch, fleet.data, filterTouched]);

  const shown = useMemo(() => {
    const needle = search.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const rows = vehicles.filter((v) => {
      if (filter === 'DISPATCH' && !v.dispatch) return false;
      if (filter !== 'ALL' && filter !== 'DISPATCH' && v.state !== filter) return false;
      if (!needle) return true;
      return (
        v.vehicleNumber.includes(needle) ||
        (v.dispatch?.buyer ?? '').toUpperCase().includes(search.trim().toUpperCase()) ||
        (v.dispatch?.destination ?? '').toUpperCase().includes(search.trim().toUpperCase())
      );
    });

    // Our consignments first, then whatever is actually moving, then by how
    // fresh the fix is: the order someone scanning the board wants.
    const rank: Record<MapState, number> = { NO_SIGNAL: 0, MOVING: 1, IDLING: 2, PARKED: 3, OFFLINE: 4 };
    return rows.slice().sort((a, b) => {
      if (Boolean(a.dispatch) !== Boolean(b.dispatch)) return a.dispatch ? -1 : 1;
      if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
      return (a.ageMinutes ?? 1e9) - (b.ageMinutes ?? 1e9);
    });
  }, [vehicles, filter, search]);

  const mapVehicles = useMemo(
    () => {
      // On the inbound tab the map shows what is coming here, not the fleet.
      // Untracked arrivals have no position and are simply absent from it - the
      // list is where they are accounted for.
      if (inbound) {
        return shownArrivals
          // A stale fix is left off too. A row can say "last seen 15 d ago"
          // and be read correctly; a pin on a map cannot - it asserts the
          // lorry is there now.
          .filter((a) => a.latitude !== null && a.longitude !== null && !a.positionIsStale)
          .map((a) => ({
            vehicleNumber: a.lorryNumber ?? a.id,
            vehicleLabel: a.lorryNumber ?? 'Booked',
            latitude: a.latitude,
            longitude: a.longitude,
            headingDeg: a.headingDeg,
            speedKmph: a.speedKmph,
            state: a.state,
            subtitle: `${a.counterparty}${a.distanceKm !== null ? ` - ${a.distanceKm} km out` : ''}`,
          }));
      }
      return shown.map((v) => ({
        vehicleNumber: v.vehicleNumber,
        vehicleLabel: v.vehicleLabel,
        latitude: v.latitude,
        longitude: v.longitude,
        headingDeg: v.headingDeg,
        speedKmph: v.speedKmph,
        state: v.state,
        subtitle: v.dispatch ? `${v.dispatch.buyer}${v.dispatch.destination ? ` - ${v.dispatch.destination}` : ''}` : null,
      }));
    },
    [shown, shownArrivals, inbound]
  );

  const landmarks = useMemo(
    () => (fleet.data ? [{ ...fleet.data.factory, kind: 'factory' as const }] : []),
    [fleet.data]
  );

  const lastPoll = status.data?.lastPoll;
  const integrationDown = status.data && (!status.data.configured || (lastPoll && !lastPoll.ok));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Vehicle Tracking"
        icon={Navigation}
        description="Live lorry positions from the transporter's GPS, joined to the dispatch each one is carrying. Positions are stored here every minute, so the trail survives even when the provider forgets."
        actions={
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {lastPoll?.ok ? `Synced ${clockIst(lastPoll.at)}` : 'Not synced'}
            </span>
            <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', refresh.isPending && 'animate-spin')} />
              Refresh now
            </Button>
          </div>
        }
      />

      {integrationDown && (
        <div className="flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/[0.07] p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div>
            <p className="font-medium">
              {status.data?.configured ? 'The last pull from the GPS provider failed.' : 'No GPS provider key is set on this server.'}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {status.data?.configured
                ? lastPoll?.error
                : 'Set LOCANIX_API_KEY on the server and the board fills itself within a minute.'}
            </p>
          </div>
        </div>
      )}

      {inbound && !rings.alertsEnabled && (
        <div className="flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/[0.07] p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div>
            <p className="font-medium">Approach alerts are switched off.</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              This board still tracks every arriving lorry, but nobody is messaged when one crosses{' '}
              {rings.approachKm} km. Switch them back on in Settings &rarr; WhatsApp.
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <StatCard
          label="Arriving"
          value={arrivalCounts?.total ?? '-'}
          icon={Flag}
          tone="clay"
          hint={
            arrivalCounts && (arrivalCounts.atGate || arrivalCounts.approaching)
              ? `${arrivalCounts.atGate} at the gate, ${arrivalCounts.approaching} within ${rings.approachKm} km`
              : 'booked purchase lorries on their way'
          }
        />
        <StatCard label="On dispatch" value={counts?.onDispatch ?? '-'} icon={Truck} tone="forest" hint="carrying one of our loads" />
        <StatCard label="Moving" value={counts?.moving ?? '-'} icon={Gauge} tone="amber" hint="reporting speed right now" />
        <StatCard label="Idling / parked" value={counts ? counts.idling + counts.parked : '-'} icon={CircleDot} tone="gold" hint="engine on or standing" />
        <StatCard label="Out of contact" value={counts ? counts.offline + counts.noSignal : '-'} icon={AlertTriangle} tone="rose" hint={`no fix in ${fleet.data?.staleAfterMinutes ?? 45} min`} />
        <StatCard label="Fleet seen" value={counts?.total ?? '-'} icon={SatelliteDish} tone="taupe" hint={`${status.data?.rowsLast24h ?? 0} fixes stored today`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[400px_1fr]">
        {/* ------------------------------------------------------- the list */}
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={inbound ? 'Lorry, party or requirement code' : 'Lorry number, buyer or destination'}
              className="pl-9"
            />
          </div>

          <Segmented
            size="sm"
            className="w-full flex-wrap"
            value={filter}
            onValueChange={(v) => {
              setFilterTouched(true);
              setFilter(v as Filter);
            }}
            options={[
              { label: 'Upcoming', value: 'INBOUND', count: arrivalCounts?.total },
              { label: 'On dispatch', value: 'DISPATCH', count: counts?.onDispatch },
              { label: 'All', value: 'ALL', count: counts?.total },
              { label: 'Moving', value: 'MOVING', count: counts?.moving },
              { label: 'Parked', value: 'PARKED', count: counts?.parked },
              { label: 'Offline', value: 'OFFLINE', count: counts?.offline },
            ]}
          />

          <div className="max-h-[calc(100vh-24rem)] space-y-2 overflow-y-auto pr-1 lg:max-h-[640px]">
            {inbound ? (
              <>
                {arrivalsQuery.isLoading && (
                  <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Reading bookings&hellip;
                  </div>
                )}

                {!arrivalsQuery.isLoading && shownArrivals.length === 0 && (
                  <div className="rounded-xl border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
                    {arrivals.length === 0
                      ? 'No lorry is on its way in. A row appears here as soon as a transporter quotes a requirement code back on WhatsApp - a purchase lorry against its order, or an empty one against its loading slot.'
                      : 'No arriving lorry matches this search.'}
                  </div>
                )}

                {shownArrivals.map((a) => (
                  <ArrivalRow
                    key={a.id}
                    arrival={a}
                    rings={rings}
                    selected={Boolean(a.lorryNumber) && a.lorryNumber === selected}
                    onClick={() => {
                      // Only a tracked lorry has a trail to open. For the rest
                      // the row itself is all there is to show, and a dialog
                      // saying "no positions" would be a dead end.
                      if (!a.tracked || !a.lorryNumber) return;
                      setSelected(a.lorryNumber);
                      setDetailOpen(true);
                    }}
                  />
                ))}
              </>
            ) : (
              <>
                {fleet.isLoading && (
                  <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Reading positions&hellip;
                  </div>
                )}

                {!fleet.isLoading && shown.length === 0 && (
                  <div className="rounded-xl border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
                    {vehicles.length === 0
                      ? 'No positions stored yet. The first pull lands within a minute of the server starting.'
                      : 'No lorry matches this filter.'}
                  </div>
                )}

                {shown.map((v) => (
                  <VehicleRow
                    key={v.vehicleNumber}
                    vehicle={v}
                    selected={v.vehicleNumber === selected}
                    onClick={() => {
                      setSelected(v.vehicleNumber);
                      setDetailOpen(true);
                    }}
                  />
                ))}
              </>
            )}
          </div>
        </div>

        {/* -------------------------------------------------------- the map */}
        <div className="space-y-2">
          <VehicleMap
            vehicles={mapVehicles}
            landmarks={landmarks}
            selected={selected}
            onSelect={(plate) => {
              setSelected(plate);
              setDetailOpen(true);
            }}
            fitKey={`${filter}-${mapVehicles.length}`}
            className="h-[560px] w-full overflow-hidden rounded-2xl border border-border/60 lg:h-[704px]"
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-muted-foreground">
            {(['MOVING', 'IDLING', 'PARKED', 'OFFLINE', 'NO_SIGNAL'] as MapState[]).map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5">
                <StateDot state={s} /> {STATE_LABEL[s]}
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3 w-3" /> Refreshes every minute
            </span>
          </div>
        </div>
      </div>

      <VehicleDetailDialog
        vehicleNumber={selected}
        factory={fleet.data?.factory}
        open={detailOpen}
        onOpenChange={(v) => {
          setDetailOpen(v);
          if (!v) setSelected(null);
        }}
      />
    </div>
  );
}
