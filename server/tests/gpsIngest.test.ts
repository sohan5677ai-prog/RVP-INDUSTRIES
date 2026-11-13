/**
 * The GPS push parser.
 *
 * Worth testing on its own because the whole point of it is tolerance: the
 * provider's field spelling, number types and date format are not under our
 * control and may change without notice. These cases are the shapes real
 * Indian telematics platforms send.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createMany = vi.fn();
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    vehiclePing: { createMany: (...a: unknown[]) => createMany(...a) },
  },
}));

const {
  parsePingRecord,
  extractRecords,
  normaliseVehicleNumber,
  handleGpsPush,
} = await import('../src/controllers/gps.controller.js');

const now = new Date('2026-11-12T10:00:00+05:30');

function parse(record: unknown) {
  const out = parsePingRecord(record, now);
  if ('error' in out) throw new Error(`unexpected rejection: ${out.error}`);
  return out.ping;
}

describe('vehicle number normalisation', () => {
  it('strips the separators a hand-typed plate picks up', () => {
    expect(normaliseVehicleNumber('KA 36 B 1234')).toBe('KA36B1234');
    expect(normaliseVehicleNumber('ka-36-b-1234')).toBe('KA36B1234');
    expect(normaliseVehicleNumber('GJ18BV6551')).toBe('GJ18BV6551');
  });
});

describe('field aliases', () => {
  it('reads the canonical camelCase shape', () => {
    const p = parse({
      vehicleNumber: 'KA36B1234',
      latitude: 16.2,
      longitude: 77.35,
      speed: 54,
      address: 'NH-150A, Raichur',
    });
    expect(p.vehicleNumber).toBe('KA36B1234');
    expect(p.latitude).toBeCloseTo(16.2);
    expect(p.longitude).toBeCloseTo(77.35);
    expect(p.speedKmph).toBe(54);
    expect(p.address).toBe('NH-150A, Raichur');
  });

  it('reads snake_case with stringified numbers', () => {
    const p = parse({
      vehicle_no: 'ka 36 b 1234',
      lat: '16.2000',
      long: '77.3500',
      speed: '54.0',
      location: 'Raichur Bypass',
    });
    expect(p.vehicleNumber).toBe('KA36B1234');
    expect(p.vehicleLabel).toBe('ka 36 b 1234');
    expect(p.latitude).toBeCloseTo(16.2);
    expect(p.longitude).toBeCloseTo(77.35);
    expect(p.speedKmph).toBe(54);
    expect(p.address).toBe('Raichur Bypass');
  });

  it('reads units glued onto the numbers', () => {
    const p = parse({ VehicleNo: 'KA36B1234', Latitude: '16.2 N', Longitude: '77.35 E', Speed: '54 kmph' });
    expect(p.latitude).toBeCloseTo(16.2);
    expect(p.longitude).toBeCloseTo(77.35);
    expect(p.speedKmph).toBe(54);
  });

  it('reads ignition however it is spelled', () => {
    expect(parse({ vehicleNo: 'X1', lat: 16, lng: 77, ignition: 'ON' }).ignition).toBe(true);
    expect(parse({ vehicleNo: 'X1', lat: 16, lng: 77, acc: 0 }).ignition).toBe(false);
    expect(parse({ vehicleNo: 'X1', lat: 16, lng: 77 }).ignition).toBeUndefined();
  });
});

describe('timestamps', () => {
  it('accepts ISO 8601', () => {
    const p = parse({ vehicleNo: 'X1', lat: 16, lng: 77, timestamp: '2026-11-12T09:30:00+05:30' });
    expect(p.recordedAt.toISOString()).toBe('2026-11-12T04:00:00.000Z');
  });

  it('accepts the DD-MM-YYYY form, read as IST', () => {
    const p = parse({ vehicleNo: 'X1', lat: 16, lng: 77, dateTime: '12-11-2026 09:30:00' });
    expect(p.recordedAt.toISOString()).toBe('2026-11-12T04:00:00.000Z');
  });

  it('accepts epoch seconds and millis', () => {
    expect(parse({ vehicleNo: 'X1', lat: 16, lng: 77, time: 1762922400 }).recordedAt.toISOString())
      .toBe(new Date(1762922400000).toISOString());
    expect(parse({ vehicleNo: 'X1', lat: 16, lng: 77, time: 1762922400000 }).recordedAt.toISOString())
      .toBe(new Date(1762922400000).toISOString());
  });

  it('falls back to arrival time when absent or unparseable', () => {
    expect(parse({ vehicleNo: 'X1', lat: 16, lng: 77 }).recordedAt).toEqual(now);
    expect(parse({ vehicleNo: 'X1', lat: 16, lng: 77, time: 'not a date' }).recordedAt).toEqual(now);
  });

  it('clamps a device clock set far in the future', () => {
    const p = parse({ vehicleNo: 'X1', lat: 16, lng: 77, timestamp: '2030-01-01T00:00:00Z' });
    expect(p.recordedAt).toEqual(now);
  });
});

describe('rejections', () => {
  const reason = (record: unknown) => {
    const out = parsePingRecord(record, now);
    return 'error' in out ? out.error : null;
  };

  it('needs a vehicle number', () => {
    expect(reason({ lat: 16, lng: 77 })).toMatch(/vehicleNumber/);
  });

  it('needs numeric coordinates', () => {
    expect(reason({ vehicleNo: 'X1', lat: 'abcd', lng: 77 })).toMatch(/latitude\/longitude/);
    expect(reason({ vehicleNo: 'X1' })).toMatch(/latitude\/longitude/);
  });

  it('refuses coordinates off the planet', () => {
    expect(reason({ vehicleNo: 'X1', lat: 160, lng: 77 })).toMatch(/out of range/);
  });

  it('refuses the no-fix 0,0 reading', () => {
    expect(reason({ vehicleNo: 'X1', lat: 0, lng: 0 })).toMatch(/no GPS fix/);
  });

  it('refuses a non-object record', () => {
    expect(reason('KA36B1234,16.2,77.35')).toMatch(/not a JSON object/);
  });

  it('drops a negative speed rather than the whole reading', () => {
    expect(parse({ vehicleNo: 'X1', lat: 16, lng: 77, speed: -1 }).speedKmph).toBeUndefined();
  });
});

describe('envelopes', () => {
  it('takes a bare object as one record', () => {
    expect(extractRecords({ vehicleNo: 'X1' })).toHaveLength(1);
  });

  it('takes a bare array', () => {
    expect(extractRecords([{ vehicleNo: 'X1' }, { vehicleNo: 'X2' }])).toHaveLength(2);
  });

  it('unwraps the common wrapper keys', () => {
    expect(extractRecords({ data: [{ vehicleNo: 'X1' }, { vehicleNo: 'X2' }] })).toHaveLength(2);
    expect(extractRecords({ records: [{ vehicleNo: 'X1' }] })).toHaveLength(1);
    expect(extractRecords({ result: { vehicleNo: 'X1' } })).toHaveLength(1);
  });

  it('gives nothing for a non-JSON body', () => {
    expect(extractRecords('hello')).toEqual([]);
  });
});

/* ------------------------------------------------------------ the endpoint */

/** Minimal Express stand-ins: enough to see the status and the JSON body. */
function fakeReq(body: unknown, headers: Record<string, string> = {}, query: Record<string, string> = {}) {
  return { body, headers, query } as never;
}
function fakeRes() {
  const state = { status: 200, body: undefined as unknown };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      return res;
    },
  };
  return { res: res as never, state };
}

describe('POST /api/webhooks/gps', () => {
  const reading = {
    vehicleNumber: 'GJ18BV6551',
    latitude: 16.2041,
    longitude: 77.3556,
    speed: 54.2,
    address: 'NH-150A, Raichur',
    timestamp: '2026-11-12T09:30:00+05:30',
  };

  beforeEach(() => {
    createMany.mockReset();
    process.env.GPS_PUSH_TOKEN = 'test-token-0123456789';
  });
  afterEach(() => {
    delete process.env.GPS_PUSH_TOKEN;
  });

  it('fails closed when no token is configured', async () => {
    delete process.env.GPS_PUSH_TOKEN;
    const { res } = fakeRes();
    await expect(handleGpsPush(fakeReq(reading, { 'x-api-key': 'anything' }), res))
      .rejects.toMatchObject({ status: 503 });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('rejects a missing or wrong token', async () => {
    const { res } = fakeRes();
    await expect(handleGpsPush(fakeReq(reading), res)).rejects.toMatchObject({ status: 401 });
    await expect(handleGpsPush(fakeReq(reading, { 'x-api-key': 'wrong' }), res))
      .rejects.toMatchObject({ status: 401 });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('accepts the token as X-API-Key, Bearer or ?token', async () => {
    createMany.mockResolvedValue({ count: 1 });
    for (const req of [
      fakeReq(reading, { 'x-api-key': 'test-token-0123456789' }),
      fakeReq(reading, { authorization: 'Bearer test-token-0123456789' }),
      fakeReq(reading, {}, { token: 'test-token-0123456789' }),
    ]) {
      const { res, state } = fakeRes();
      await handleGpsPush(req, res);
      expect(state.status).toBe(200);
    }
    expect(createMany).toHaveBeenCalledTimes(3);
  });

  it('stores a batch and reports the counts', async () => {
    createMany.mockResolvedValue({ count: 2 });
    const { res, state } = fakeRes();
    await handleGpsPush(
      fakeReq({ data: [reading, { ...reading, vehicle_no: 'KA36B1234' }] }, { 'x-api-key': 'test-token-0123456789' }),
      res
    );
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ received: 2, accepted: 2, stored: 2, duplicates: 0, rejected: [] });
    const rows = (createMany.mock.calls[0][0] as { data: { vehicleNumber: string }[] }).data;
    expect(rows.map((r) => r.vehicleNumber)).toEqual(['GJ18BV6551', 'GJ18BV6551']);
  });

  it('reports re-sent readings as duplicates, not failures', async () => {
    createMany.mockResolvedValue({ count: 0 });
    const { res, state } = fakeRes();
    await handleGpsPush(fakeReq([reading], { 'x-api-key': 'test-token-0123456789' }), res);
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ accepted: 1, stored: 0, duplicates: 1 });
  });

  it('keeps the good readings in a part-bad batch', async () => {
    createMany.mockResolvedValue({ count: 1 });
    const { res, state } = fakeRes();
    await handleGpsPush(
      fakeReq([reading, { vehicleNo: 'X1', lat: 0, lng: 0 }], { 'x-api-key': 'test-token-0123456789' }),
      res
    );
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ received: 2, accepted: 1, stored: 1 });
    expect((state.body as { rejected: unknown[] }).rejected).toHaveLength(1);
  });

  it('400s a batch in which nothing is usable, and writes nothing', async () => {
    const { res, state } = fakeRes();
    await handleGpsPush(fakeReq([{ lat: 16, lng: 77 }], { 'x-api-key': 'test-token-0123456789' }), res);
    expect(state.status).toBe(400);
    expect(state.body).toMatchObject({ received: 1, accepted: 0, stored: 0 });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('413s a batch over the cap', async () => {
    const { res } = fakeRes();
    const big = Array.from({ length: 501 }, () => reading);
    await expect(handleGpsPush(fakeReq(big, { 'x-api-key': 'test-token-0123456789' }), res))
      .rejects.toMatchObject({ status: 413 });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('400s an empty body', async () => {
    const { res } = fakeRes();
    await expect(handleGpsPush(fakeReq('hello', { 'x-api-key': 'test-token-0123456789' }), res))
      .rejects.toMatchObject({ status: 400 });
  });
});
