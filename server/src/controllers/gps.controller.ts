import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { HttpError } from '../lib/httpError.js';
import { FACTORY, resolvePlace, kmBetween, ROAD_FACTOR, AVG_LORRY_KMPH } from '../lib/gpsPlaces.js';

/**
 * GPS position ingestion.
 *
 * The provider (Locanix) pushes to us: their platform POSTs a reading - or a
 * batch of readings - to `POST /api/webhooks/gps` as the devices report. We
 * hold no credentials of theirs and run no polling job.
 *
 * Two things shape this file, and both come from how these integrations
 * actually behave rather than from how they are specified:
 *
 * 1. **Field names are not negotiable in practice.** Every Indian telematics
 *    vendor has its own spelling of "vehicle number" and half of them send
 *    numbers as strings. So the parser accepts a list of aliases per field and
 *    coerces types, instead of a strict schema that would 400 the whole batch
 *    over `vehicle_no` vs `vehicleNo`. The provider can start sending
 *    immediately, and nothing has to be deployed to match their spelling.
 * 2. **Retries are the normal case, not the exception.** A push that times out
 *    after it was written gets re-sent. Ingestion is therefore idempotent:
 *    (provider, vehicleNumber, recordedAt) is unique and inserts skip
 *    duplicates, so replaying a batch stores nothing twice.
 */

/** Hard cap on one batch, so a runaway caller cannot buffer unbounded rows. */
const MAX_RECORDS_PER_PUSH = 500;

/* ------------------------------------------------------------------- auth */

/**
 * Shared-secret auth for the public push endpoint.
 *
 * Checked here rather than as route middleware so that the endpoint can answer
 * a provider's URL-validation probe (GET) without a token while still refusing
 * unauthenticated writes.
 *
 * The token is accepted from four places because the caller is someone else's
 * server and we do not control what it can send: most platforms can set a
 * header, some can only append a query parameter. Headers are what the
 * integration note asks for - a token in the URL ends up in access logs at
 * both ends.
 */
function assertPushAuthorised(req: Request): void {
  const expected = process.env.GPS_PUSH_TOKEN;
  if (!expected) {
    // Fail closed. An unset token must not mean "accept anything": this
    // endpoint writes to the database from the open internet.
    throw new HttpError(503, 'GPS push is not configured on this server');
  }

  const header = req.headers.authorization;
  const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  const candidates = [
    bearer,
    req.headers['x-api-key'],
    req.headers['x-gps-token'],
    (req.query.token as string | undefined),
  ];

  const ok = candidates.some((value) => {
    if (typeof value !== 'string' || value.length === 0) return false;
    const a = Buffer.from(value);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  });

  if (!ok) throw new HttpError(401, 'Invalid or missing GPS push token');
}

/* ------------------------------------------------------------- normalising */

/** First alias present on the object, whatever its case. */
function pick(record: Record<string, unknown>, aliases: readonly string[]): unknown {
  const lowered = new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) lowered.set(key.toLowerCase().replace(/[_\s-]/g, ''), value);
  for (const alias of aliases) {
    const value = lowered.get(alias.toLowerCase().replace(/[_\s-]/g, ''));
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    // Tolerate "23.456 N", "45.2 kmph" and comma decimal separators.
    const cleaned = value.trim().replace(',', '.').replace(/[^\d.+-]/g, '');
    if (!cleaned) return undefined;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['1', 'on', 'true', 'yes', 'y'].includes(v)) return true;
    if (['0', 'off', 'false', 'no', 'n'].includes(v)) return false;
  }
  return undefined;
}

/**
 * Plate as a join key: upper case, separators stripped. SaleDispatch holds
 * hand-typed plates ("KA 36 B 1234", "ka36b1234"), so comparing anything less
 * normalised would miss the match that makes a ping useful.
 */
export function normaliseVehicleNumber(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Timestamp of the fix. Accepts ISO 8601, epoch seconds/millis, and the
 * `DD-MM-YYYY HH:mm:ss` form that Indian trackers commonly send (which
 * `new Date()` reads as an invalid date, so it is parsed explicitly and
 * treated as IST, the only timezone these devices report in).
 */
function toTimestamp(value: unknown): Date | undefined {
  if (value === undefined) return undefined;

  if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) {
    const n = Number(value);
    // 10-digit values are epoch seconds, 13-digit are millis.
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  const text = String(value).trim();
  const dmy = text.match(/^(\d{2})[-/](\d{2})[-/](\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (dmy) {
    const [, dd, mm, yyyy, hh, mi, ss] = dmy;
    // IST is UTC+5:30 and has no DST, so the offset is a constant.
    const d = new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss ?? '00'}+05:30`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export interface ParsedPing {
  vehicleNumber: string;
  vehicleLabel: string;
  latitude: number;
  longitude: number;
  speedKmph?: number;
  address?: string;
  ignition?: boolean;
  recordedAt: Date;
  raw: Record<string, unknown>;
}

const VEHICLE_ALIASES = [
  'vehicleNumber', 'vehicleNo', 'vehicle', 'vehicleRegNo', 'registrationNumber',
  'regNo', 'vehicleRegistrationNumber', 'truckNo', 'lorryNo', 'plateNumber', 'imei',
] as const;
const LAT_ALIASES = ['latitude', 'lat'] as const;
const LNG_ALIASES = ['longitude', 'lng', 'lon', 'long'] as const;
const SPEED_ALIASES = ['speed', 'speedKmph', 'speedKmh', 'currentSpeed'] as const;
const ADDRESS_ALIASES = ['address', 'location', 'nearestLocation', 'landmark', 'place', 'area'] as const;
const IGNITION_ALIASES = ['ignition', 'ignitionStatus', 'acc', 'accStatus'] as const;
const TIME_ALIASES = [
  'timestamp', 'recordedAt', 'pingedAt', 'deviceTime', 'gpsTime', 'dateTime',
  'datetime', 'time', 'lastUpdate', 'lastUpdated', 'fixTime',
] as const;

/**
 * One raw record -> one ping, or a reason it cannot be stored.
 *
 * Only four things are actually required: a plate, a latitude, a longitude,
 * and coordinates that are on Earth. Speed, address and ignition are optional
 * because a device without a lock still reports, and a half-filled reading
 * placed on the dispatch board beats a rejected one.
 */
export function parsePingRecord(record: unknown, now: Date): { ping: ParsedPing } | { error: string } {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { error: 'not a JSON object' };
  }
  const row = record as Record<string, unknown>;

  const rawVehicle = pick(row, VEHICLE_ALIASES);
  if (typeof rawVehicle !== 'string' && typeof rawVehicle !== 'number') {
    return { error: 'vehicleNumber is missing' };
  }
  const vehicleLabel = String(rawVehicle).trim();
  const vehicleNumber = normaliseVehicleNumber(vehicleLabel);
  if (!vehicleNumber) return { error: 'vehicleNumber is empty' };

  const latitude = toNumber(pick(row, LAT_ALIASES));
  const longitude = toNumber(pick(row, LNG_ALIASES));
  if (latitude === undefined || longitude === undefined) {
    return { error: 'latitude/longitude missing or not numeric' };
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return { error: 'latitude/longitude out of range' };
  }
  // 0,0 is the Gulf of Guinea: every tracker reports it when it has no fix.
  if (latitude === 0 && longitude === 0) return { error: 'no GPS fix (0,0)' };

  const timestamp = toTimestamp(pick(row, TIME_ALIASES));
  // A clock far in the future is a device/timezone fault; clamp rather than
  // reject, so one bad device cannot blank its own trail.
  const recordedAt = timestamp && timestamp.getTime() <= now.getTime() + 60 * 60 * 1000 ? timestamp : now;

  const address = pick(row, ADDRESS_ALIASES);
  const speed = toNumber(pick(row, SPEED_ALIASES));

  return {
    ping: {
      vehicleNumber,
      vehicleLabel,
      latitude,
      longitude,
      speedKmph: speed !== undefined && speed >= 0 ? speed : undefined,
      address: typeof address === 'string' ? address.trim().slice(0, 500) : undefined,
      ignition: toBoolean(pick(row, IGNITION_ALIASES)),
      recordedAt,
      raw: row,
    },
  };
}

/** Pull the records out of whichever envelope the provider wraps them in. */
export function extractRecords(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (typeof body === 'object' && body !== null) {
    const envelope = body as Record<string, unknown>;
    for (const key of ['data', 'records', 'positions', 'items', 'result', 'results', 'payload']) {
      const value = envelope[key];
      if (Array.isArray(value)) return value;
      if (typeof value === 'object' && value !== null) return [value];
    }
    return [body];
  }
  return [];
}

/* ---------------------------------------------------------------- handlers */

/**
 * `GET /api/webhooks/gps` - answers the provider's URL-validation probe.
 * Deliberately unauthenticated and says nothing about the ERP: it exists so
 * their panel accepts the URL when it pings it before saving.
 */
export async function verifyGpsWebhook(_req: Request, res: Response) {
  res.json({ ok: true, service: 'rvp-erp-gps-ingest', accepts: 'POST' });
}

/** `POST /api/webhooks/gps` - the provider's push endpoint. */
export async function handleGpsPush(req: Request, res: Response) {
  assertPushAuthorised(req);

  const records = extractRecords(req.body);
  if (records.length === 0) {
    throw new HttpError(400, 'No position records found in the request body');
  }
  if (records.length > MAX_RECORDS_PER_PUSH) {
    throw new HttpError(413, `Too many records in one push (max ${MAX_RECORDS_PER_PUSH})`);
  }

  const provider = (typeof req.query.provider === 'string' ? req.query.provider : 'LOCANIX').toUpperCase().slice(0, 32);
  const now = new Date();
  const pings: ParsedPing[] = [];
  const rejected: { index: number; reason: string }[] = [];

  records.forEach((record, index) => {
    const parsed = parsePingRecord(record, now);
    if ('error' in parsed) rejected.push({ index, reason: parsed.error });
    else pings.push(parsed.ping);
  });

  let stored = 0;
  if (pings.length > 0) {
    // skipDuplicates against the (provider, vehicleNumber, recordedAt) unique
    // key is what makes a replayed batch a no-op.
    const result = await prisma.vehiclePing.createMany({
      data: pings.map((p) => ({
        provider,
        vehicleNumber: p.vehicleNumber,
        vehicleLabel: p.vehicleLabel,
        latitude: p.latitude,
        longitude: p.longitude,
        speedKmph: p.speedKmph,
        address: p.address,
        ignition: p.ignition,
        recordedAt: p.recordedAt,
        raw: p.raw as object,
      })),
      skipDuplicates: true,
    });
    stored = result.count;
  }

  if (pings.length === 0) {
    // Nothing usable: a 400 so the provider's own logs show the integration is
    // not working, with the per-record reasons they need to fix it.
    logger.warn(`GPS push rejected every record (${provider})`, { rejected });
    return res.status(400).json({ received: records.length, accepted: 0, stored: 0, rejected });
  }

  logger.info(`GPS push: ${stored}/${records.length} stored (${provider})`);
  res.json({
    received: records.length,
    accepted: pings.length,
    stored,
    duplicates: pings.length - stored,
    rejected,
  });
}

/* ------------------------------------------------------- reads for the ERP */

/**
 * `GET /api/gps/vehicles` - the latest reading per vehicle.
 *
 * `?active=true` narrows it to lorries on a dispatch still in DISPATCHED
 * status, which is what the dispatch board wants: a vehicle that delivered
 * last week is not interesting and its pings would crowd the list.
 */
export async function listVehiclePositions(req: Request, res: Response) {
  const activeOnly = req.query.active === 'true';

  let allowed: Set<string> | undefined;
  if (activeOnly) {
    const dispatches = await prisma.saleDispatch.findMany({
      where: { status: 'DISPATCHED', vehicleNumber: { not: null } },
      select: { vehicleNumber: true },
    });
    allowed = new Set(
      dispatches
        .map((d) => normaliseVehicleNumber(d.vehicleNumber ?? ''))
        .filter(Boolean)
    );
    if (allowed.size === 0) return res.json([]);
  }

  // Latest row per vehicle. Distinct-on over the (vehicleNumber, recordedAt)
  // index does this in one query; fetching all pings and reducing in JS would
  // grow with the history, not the fleet.
  const latest = await prisma.vehiclePing.findMany({
    where: allowed ? { vehicleNumber: { in: [...allowed] } } : undefined,
    distinct: ['vehicleNumber'],
    orderBy: [{ vehicleNumber: 'asc' }, { recordedAt: 'desc' }],
    select: {
      vehicleNumber: true,
      vehicleLabel: true,
      latitude: true,
      longitude: true,
      speedKmph: true,
      address: true,
      ignition: true,
      recordedAt: true,
      receivedAt: true,
      provider: true,
    },
  });

  res.json(latest);
}

/**
 * `GET /api/gps/vehicles/:vehicleNumber` - last position plus the recent
 * trail, for the map panel. `from`/`to` (ISO) bound the trail; `limit` caps it.
 */
export async function getVehicleTrail(req: Request, res: Response) {
  const vehicleNumber = normaliseVehicleNumber(String(req.params.vehicleNumber ?? ''));
  if (!vehicleNumber) throw new HttpError(400, 'A vehicle number is required');

  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  const from = req.query.from ? new Date(String(req.query.from)) : undefined;
  const to = req.query.to ? new Date(String(req.query.to)) : undefined;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
    throw new HttpError(400, 'from/to must be ISO timestamps');
  }

  const trail = await prisma.vehiclePing.findMany({
    where: {
      vehicleNumber,
      ...(from || to ? { recordedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
    orderBy: { recordedAt: 'desc' },
    take: limit,
    select: {
      latitude: true,
      longitude: true,
      speedKmph: true,
      address: true,
      ignition: true,
      recordedAt: true,
      provider: true,
    },
  });

  res.json({ vehicleNumber, latest: trail[0] ?? null, trail: trail.slice().reverse() });
}

/* ------------------------------------------------- the dispatch board reads */

/**
 * The reads behind the Vehicle Tracking page.
 *
 * Everything the browser sees comes from our own VehiclePing rows, never from
 * the provider - that keeps their key server-side and means the page costs
 * nothing at their end however many people have it open.
 */

/**
 * A reading is "live" within this many minutes of the device clock. Past it the
 * lorry is shown as out of contact rather than parked where it last reported,
 * which is the distinction that matters when someone is chasing a delivery.
 */
const STALE_AFTER_MINUTES = 45;

export type TrackedState = 'MOVING' | 'IDLING' | 'PARKED' | 'OFFLINE' | 'NO_SIGNAL';

/**
 * One word for what a lorry is doing.
 *
 * The provider's own status is preferred - their device knows the ignition
 * history and how long since it last reported - but it is overridden to
 * OFFLINE once the fix is older than STALE_AFTER_MINUTES, because a stale
 * "Moving" on a dispatch board is worse than no status at all.
 */
export function deriveState(
  providerStatus: string | null | undefined,
  speedKmph: number | null | undefined,
  ageMinutes: number
): TrackedState {
  if (ageMinutes > STALE_AFTER_MINUTES) return 'OFFLINE';
  const s = (providerStatus ?? '').toUpperCase();
  if (s.startsWith('MOV')) return 'MOVING';
  if (s.startsWith('IDL')) return 'IDLING';
  if (s.startsWith('PARK') || s.startsWith('STOP')) return 'PARKED';
  if (s.startsWith('OFF')) return 'OFFLINE';
  if ((speedKmph ?? 0) > 3) return 'MOVING';
  return 'PARKED';
}

export interface DispatchContext {
  dispatchId: string;
  saleOrderId: string;
  /** Our invoice for this shipment, once it has been raised. */
  invoiceNumber: string | null;
  /** The buyer's own PO reference, which is what they quote on the phone. */
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

/**
 * How far back a DISPATCHED row is still believed to be a lorry on the road.
 *
 * Shipments are closed by marking them delivered, and in practice some are
 * never closed - there are rows six weeks old still sitting in DISPATCHED.
 * Without this window every one of those plates would sit permanently at the
 * top of the board as "never reported", which is exactly the alarm that stops
 * being read. Fourteen days is well past the longest run RVP does.
 */
export const ACTIVE_DISPATCH_DAYS = 14;

/**
 * Dispatches still in DISPATCHED, keyed by normalised plate.
 *
 * A plate can in principle carry two open dispatches (a part load, or a stale
 * row nobody closed); the most recent one wins, because that is the trip the
 * lorry is actually on.
 */
export async function activeDispatchesByPlate(): Promise<Map<string, DispatchContext>> {
  const since = new Date(Date.now() - ACTIVE_DISPATCH_DAYS * 24 * 3_600_000);
  const rows = await prisma.saleDispatch.findMany({
    where: { status: 'DISPATCHED', vehicleNumber: { not: null }, dispatchDate: { gte: since } },
    orderBy: { dispatchDate: 'asc' },
    select: {
      id: true,
      vehicleNumber: true,
      weightKg: true,
      dispatchDate: true,
      invoiceNumber: true,
      driverName: true,
      driverPhone: true,
      transportProvider: true,
      transport: { select: { name: true } },
      saleOrder: {
        select: {
          id: true,
          poNumber: true,
          product: true,
          destination: true,
          buyer: { select: { name: true } },
          broker: { select: { name: true } },
        },
      },
    },
  });

  const byPlate = new Map<string, DispatchContext>();
  for (const row of rows) {
    const plate = normaliseVehicleNumber(row.vehicleNumber ?? '');
    if (!plate) continue;
    byPlate.set(plate, {
      dispatchId: row.id,
      saleOrderId: row.saleOrder.id,
      invoiceNumber: row.invoiceNumber ?? null,
      poNumber: row.saleOrder.poNumber ?? null,
      buyer: row.saleOrder.buyer?.name ?? '-',
      broker: row.saleOrder.broker?.name ?? null,
      product: String(row.saleOrder.product),
      destination: row.saleOrder.destination ?? null,
      weightKg: row.weightKg,
      dispatchDate: row.dispatchDate.toISOString(),
      driverName: row.driverName ?? null,
      driverPhone: row.driverPhone ?? null,
      transport: row.transport?.name ?? row.transportProvider ?? null,
    });
  }
  return byPlate;
}

/** Journey figures for a lorry that is on one of our dispatches. */
function journeyOf(latitude: number, longitude: number, dispatch: DispatchContext | undefined) {
  if (!dispatch) return null;
  const destination = resolvePlace(dispatch.destination);
  if (!destination) {
    return { destination: null, totalKm: null, remainingKm: null, coveredKm: null, progressPct: null, etaAt: null };
  }

  const totalKm = kmBetween(FACTORY.latitude, FACTORY.longitude, destination.latitude, destination.longitude) * ROAD_FACTOR;
  const remainingKm = kmBetween(latitude, longitude, destination.latitude, destination.longitude) * ROAD_FACTOR;
  const coveredKm = Math.max(0, totalKm - remainingKm);
  const progressPct = totalKm > 0 ? Math.max(0, Math.min(100, (coveredKm / totalKm) * 100)) : null;

  // ETA off the long-run average, not the instantaneous speed: a lorry doing
  // 70 km/h on a bypass is not going to average that, and a lorry stopped for
  // chai is not going to take forever.
  const etaAt = remainingKm > 1
    ? new Date(Date.now() + (remainingKm / AVG_LORRY_KMPH) * 3_600_000).toISOString()
    : null;

  return {
    destination: destination.name,
    totalKm: Math.round(totalKm),
    remainingKm: Math.round(remainingKm),
    coveredKm: Math.round(coveredKm),
    progressPct: progressPct === null ? null : Math.round(progressPct),
    etaAt,
  };
}

export interface FleetVehicle {
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
  state: TrackedState;
  distanceFromFactoryKm: number | null;
  dispatch: DispatchContext | null;
  journey: ReturnType<typeof journeyOf>;
  provider: string;
}

/**
 * `GET /api/gps/fleet` - everything the live board needs in one call.
 *
 * One row per vehicle we hold a position for, each already carrying its
 * dispatch, its state and its journey figures. Doing the joins and the
 * arithmetic here rather than in the browser keeps the page a renderer, and
 * means the numbers in a WhatsApp message and the numbers on screen are
 * computed in exactly one place.
 *
 * `?scope=dispatch` narrows to lorries carrying one of our consignments. The
 * default is the whole feed, because a lorry the transporter has not yet put
 * on a dispatch is precisely the one the office is looking for when they want
 * to know which vehicle is free.
 */
export async function getFleetBoard(req: Request, res: Response) {
  const dispatchOnly = req.query.scope === 'dispatch';
  const dispatches = await activeDispatchesByPlate();

  const latest = await prisma.vehiclePing.findMany({
    where: dispatchOnly ? { vehicleNumber: { in: [...dispatches.keys()] } } : undefined,
    distinct: ['vehicleNumber'],
    orderBy: [{ vehicleNumber: 'asc' }, { recordedAt: 'desc' }],
    select: {
      vehicleNumber: true, vehicleLabel: true, latitude: true, longitude: true,
      speedKmph: true, address: true, ignition: true, headingDeg: true,
      providerStatus: true, odometerRaw: true, recordedAt: true, receivedAt: true,
      provider: true,
    },
  });

  const now = Date.now();
  const seen = new Set<string>();

  const vehicles: FleetVehicle[] = latest.map((p) => {
    seen.add(p.vehicleNumber);
    const ageMinutes = Math.max(0, Math.round((now - p.recordedAt.getTime()) / 60_000));
    const dispatch = dispatches.get(p.vehicleNumber);
    return {
      vehicleNumber: p.vehicleNumber,
      vehicleLabel: p.vehicleLabel ?? p.vehicleNumber,
      latitude: p.latitude,
      longitude: p.longitude,
      speedKmph: p.speedKmph,
      headingDeg: p.headingDeg,
      ignition: p.ignition,
      address: p.address,
      odometerRaw: p.odometerRaw,
      providerStatus: p.providerStatus,
      recordedAt: p.recordedAt.toISOString(),
      receivedAt: p.receivedAt.toISOString(),
      ageMinutes,
      state: deriveState(p.providerStatus, p.speedKmph, ageMinutes),
      distanceFromFactoryKm: Math.round(kmBetween(FACTORY.latitude, FACTORY.longitude, p.latitude, p.longitude)),
      dispatch: dispatch ?? null,
      journey: journeyOf(p.latitude, p.longitude, dispatch),
      provider: p.provider,
    };
  });

  // A lorry that is on a dispatch but has never pinged is the most important
  // row on the board, not an absence: it means the plate is mistyped, or the
  // device is off, or the transporter put a different lorry on the load.
  for (const [plate, dispatch] of dispatches) {
    if (seen.has(plate)) continue;
    vehicles.push({
      vehicleNumber: plate,
      vehicleLabel: plate,
      latitude: null,
      longitude: null,
      speedKmph: null,
      headingDeg: null,
      ignition: null,
      address: null,
      odometerRaw: null,
      providerStatus: null,
      recordedAt: null,
      receivedAt: null,
      ageMinutes: null,
      state: 'NO_SIGNAL',
      distanceFromFactoryKm: null,
      dispatch,
      journey: null,
      provider: 'LOCANIX',
    });
  }

  res.json({
    generatedAt: new Date().toISOString(),
    factory: FACTORY,
    staleAfterMinutes: STALE_AFTER_MINUTES,
    counts: {
      total: vehicles.length,
      onDispatch: vehicles.filter((v) => v.dispatch).length,
      moving: vehicles.filter((v) => v.state === 'MOVING').length,
      idling: vehicles.filter((v) => v.state === 'IDLING').length,
      parked: vehicles.filter((v) => v.state === 'PARKED').length,
      offline: vehicles.filter((v) => v.state === 'OFFLINE').length,
      noSignal: vehicles.filter((v) => v.state === 'NO_SIGNAL').length,
    },
    vehicles,
  });
}

/** A halt long enough to be worth explaining to a buyer or a transporter. */
const STOP_MIN_MINUTES = 20;
/** Below this the lorry is standing, whatever the device calls it. */
const MOVING_KMPH = 5;
/** A gap longer than this is the device being off, not a leg of the journey. */
const TRAIL_GAP_LIMIT_MINUTES = 30;

/**
 * `GET /api/gps/vehicles/:vehicleNumber/detail` - one lorry, in full.
 *
 * The trail plus the figures that get argued about: distance actually covered
 * (summed along the trail, not taken off the device odometer, whose units are
 * not consistent across this feed), driving time, standing time, and every
 * halt over twenty minutes with where and how long. That list is the answer
 * to "why is it late", and it is the evidence in a detention claim.
 */
export async function getVehicleDetail(req: Request, res: Response) {
  const vehicleNumber = normaliseVehicleNumber(String(req.params.vehicleNumber ?? ''));
  if (!vehicleNumber) throw new HttpError(400, 'A vehicle number is required');

  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 14);
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - hours * 3_600_000);
  const to = req.query.to ? new Date(String(req.query.to)) : undefined;
  if (Number.isNaN(from.getTime()) || (to && Number.isNaN(to.getTime()))) {
    throw new HttpError(400, 'from/to must be ISO timestamps');
  }

  const [trailDesc, dispatches] = await Promise.all([
    prisma.vehiclePing.findMany({
      where: { vehicleNumber, recordedAt: { gte: from, ...(to ? { lte: to } : {}) } },
      orderBy: { recordedAt: 'desc' },
      take: 2000,
      select: {
        latitude: true, longitude: true, speedKmph: true, address: true, ignition: true,
        headingDeg: true, providerStatus: true, odometerRaw: true, recordedAt: true,
      },
    }),
    activeDispatchesByPlate(),
  ]);

  // Oldest first: the order the map draws it and the arithmetic below walks it.
  const points = trailDesc.slice().reverse();

  const trail = points.map((p) => ({
    latitude: p.latitude,
    longitude: p.longitude,
    speedKmph: p.speedKmph,
    headingDeg: p.headingDeg,
    ignition: p.ignition,
    providerStatus: p.providerStatus,
    address: p.address,
    recordedAt: p.recordedAt.toISOString(),
  }));

  // The most recent fix overall, which may be older than the window asked for.
  const newest = trailDesc[0] ?? await prisma.vehiclePing.findFirst({
    where: { vehicleNumber },
    orderBy: { recordedAt: 'desc' },
    select: {
      latitude: true, longitude: true, speedKmph: true, address: true, ignition: true,
      headingDeg: true, providerStatus: true, odometerRaw: true, recordedAt: true,
    },
  });

  let distanceKm = 0;
  let movingMinutes = 0;
  let standingMinutes = 0;
  let maxSpeedKmph = 0;
  const stops: { from: string; to: string; minutes: number; latitude: number; longitude: number }[] = [];
  let standingSince: { at: Date; latitude: number; longitude: number } | null = null;

  points.forEach((point, index) => {
    maxSpeedKmph = Math.max(maxSpeedKmph, point.speedKmph ?? 0);

    const previous = index > 0 ? points[index - 1] : null;
    if (previous) {
      const gapMinutes = (point.recordedAt.getTime() - previous.recordedAt.getTime()) / 60_000;
      // A gap of hours is the device being off, not a lorry teleporting, so
      // neither its distance nor its time belongs in the trip totals.
      if (gapMinutes <= TRAIL_GAP_LIMIT_MINUTES) {
        distanceKm += kmBetween(previous.latitude, previous.longitude, point.latitude, point.longitude);
        if ((point.speedKmph ?? 0) >= MOVING_KMPH) movingMinutes += gapMinutes;
        else standingMinutes += gapMinutes;
      }
    }

    const standing = (point.speedKmph ?? 0) < MOVING_KMPH;
    if (standing && !standingSince) {
      standingSince = { at: point.recordedAt, latitude: point.latitude, longitude: point.longitude };
    } else if (!standing && standingSince) {
      const started = standingSince;
      const minutes = (point.recordedAt.getTime() - started.at.getTime()) / 60_000;
      if (minutes >= STOP_MIN_MINUTES) {
        stops.push({
          from: started.at.toISOString(),
          to: point.recordedAt.toISOString(),
          minutes: Math.round(minutes),
          latitude: started.latitude,
          longitude: started.longitude,
        });
      }
      standingSince = null;
    }
  });

  // A halt still in progress counts, and is usually the one being asked about.
  if (standingSince && points.length > 0) {
    const open = standingSince as { at: Date; latitude: number; longitude: number };
    const last = points[points.length - 1];
    const minutes = (last.recordedAt.getTime() - open.at.getTime()) / 60_000;
    if (minutes >= STOP_MIN_MINUTES) {
      stops.push({
        from: open.at.toISOString(),
        to: last.recordedAt.toISOString(),
        minutes: Math.round(minutes),
        latitude: open.latitude,
        longitude: open.longitude,
      });
    }
  }

  const dispatch = dispatches.get(vehicleNumber);
  const ageMinutes = newest ? Math.max(0, Math.round((Date.now() - newest.recordedAt.getTime()) / 60_000)) : null;

  res.json({
    vehicleNumber,
    window: { from: from.toISOString(), to: (to ?? new Date()).toISOString() },
    latest: newest
      ? {
          latitude: newest.latitude,
          longitude: newest.longitude,
          speedKmph: newest.speedKmph,
          headingDeg: newest.headingDeg,
          ignition: newest.ignition,
          providerStatus: newest.providerStatus,
          odometerRaw: newest.odometerRaw,
          address: newest.address,
          recordedAt: newest.recordedAt.toISOString(),
          ageMinutes,
          state: deriveState(newest.providerStatus, newest.speedKmph, ageMinutes ?? 0),
          distanceFromFactoryKm: Math.round(kmBetween(FACTORY.latitude, FACTORY.longitude, newest.latitude, newest.longitude)),
        }
      : null,
    dispatch: dispatch ?? null,
    journey: newest ? journeyOf(newest.latitude, newest.longitude, dispatch) : null,
    stats: {
      points: trail.length,
      distanceKm: Math.round(distanceKm * 10) / 10,
      movingMinutes: Math.round(movingMinutes),
      standingMinutes: Math.round(standingMinutes),
      maxSpeedKmph: Math.round(maxSpeedKmph),
      avgMovingKmph: movingMinutes > 0 ? Math.round(distanceKm / (movingMinutes / 60)) : 0,
      stopCount: stops.length,
    },
    stops: stops.reverse(),
    trail,
  });
}

/**
 * `GET /api/gps/status` - is the integration actually working?
 *
 * On screen as the page's own health line. Without it, a provider key that has
 * expired looks exactly like a fleet that happens to be parked.
 */
export async function getGpsStatus(_req: Request, res: Response) {
  // Imported at call time: locanix.service imports the parser from this file,
  // and a static import both ways is a cycle nobody wants to debug at boot.
  const { getLocanixStatus } = await import('../services/locanix.service.js');
  const since = new Date(Date.now() - 24 * 3_600_000);
  const [rowsLast24h, oldest] = await Promise.all([
    prisma.vehiclePing.count({ where: { receivedAt: { gte: since } } }),
    prisma.vehiclePing.findFirst({ orderBy: { recordedAt: 'asc' }, select: { recordedAt: true } }),
  ]);
  res.json({
    ...getLocanixStatus(),
    rowsLast24h,
    historySince: oldest?.recordedAt.toISOString() ?? null,
  });
}

/**
 * `POST /api/gps/poll` - pull from the provider right now.
 *
 * The page's refresh button. `force` bypasses our own stand-down after a rate
 * limit but not theirs, so an impatient second click simply comes back with
 * their refusal in `error` rather than appearing to do nothing.
 */
export async function triggerGpsPoll(_req: Request, res: Response) {
  const { pollLocanix } = await import('../services/locanix.service.js');
  const result = await pollLocanix({ force: true });
  res.json(result);
}
