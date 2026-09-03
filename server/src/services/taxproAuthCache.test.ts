import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

/**
 * The AuthToken is cached because TaxPro's own API log showed one AUTH row next
 * to every INVOICE row - we were re-authenticating on every operation (and every
 * retry) for a token NIC keeps alive ~6h.
 *
 * Caching is only safe if a stale token self-heals, so these cover both halves:
 * the token is reused while valid, and a NIC 1005 ("Invalid Token") quietly
 * re-auths and retries instead of failing the dispatch. A real business error
 * must do neither, or a bad payload would silently cost two API calls and hide
 * its own cause.
 */

vi.mock('../lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../controllers/settings.controller.js', () => ({ getCompanyProfileRow: vi.fn() }));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { TaxproService } = await import('./taxpro.service.js');

// withAuth/request/authCache are private to the service; the cache is exactly
// what is under test here, so reach past the visibility rather than widen it.
const svc = TaxproService as unknown as {
  authCache: Map<string, { token: string; expiresAt: number }>;
  authCacheKey(config: unknown, gstin: string): string;
  withAuth<T>(config: unknown, gstin: string, fn: (token: string) => Promise<T>): Promise<T>;
  request(isSandbox: boolean, path: string, init: RequestInit): Promise<any>;
};

const CONFIG = {
  taxproGspId: 'aspid',
  taxproGspSecret: 'asp-password',
  taxproGstUser: 'API_user',
  taxproGstPass: 'einv-password',
  taxproSandbox: false,
  gstin: '37ABJFR4630H1Z1',
};
const GSTIN = CONFIG.gstin;

let auths = 0;
let invoices = 0;
/** Body the FIRST invoice call answers with; later calls always succeed. */
let firstInvoiceBody: unknown = null;
/** IST timestamp, no offset - exactly how NIC returns TokenExpiry. */
let tokenExpiry = '2099-01-01 23:00:00';

const realFetch = globalThis.fetch;

beforeEach(() => {
  auths = 0;
  invoices = 0;
  firstInvoiceBody = null;
  tokenExpiry = '2099-01-01 23:00:00';
  svc.authCache.clear();

  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('/auth')) {
      auths++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ Status: 1, Data: { AuthToken: `tok-${auths}`, TokenExpiry: tokenExpiry } }),
      };
    }
    invoices++;
    const body = firstInvoiceBody && invoices === 1 ? firstInvoiceBody : { Status: '1', Data: { Irn: 'ok' } };
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
});

afterAll(() => { globalThis.fetch = realFetch; });

/** One authenticated operation, returning the token it was actually given. */
function callInvoice(config: unknown = CONFIG) {
  return svc.withAuth(config, GSTIN, (token) =>
    svc
      .request(false, '/eicore/dec/v1.03/Invoice', { method: 'POST', headers: { AuthToken: token } })
      .then((res) => ({ ...res, tokenUsed: token })));
}

describe('TaxPro AuthToken cache', () => {
  it('authenticates once for a run of operations', async () => {
    const results = [await callInvoice(), await callInvoice(), await callInvoice()];

    expect(auths).toBe(1);
    expect(invoices).toBe(3);
    expect(results.map((r) => r.tokenUsed)).toEqual(['tok-1', 'tok-1', 'tok-1']);
  });

  it("reads NIC's un-offsetted TokenExpiry as IST, not UTC", async () => {
    // Render runs in UTC. Read naively, an IST expiry looks 5.5h older than it
    // is - which near the edge would re-auth on every call and defeat the cache.
    tokenExpiry = '2099-01-01 23:00:00';
    await callInvoice();

    const cached = svc.authCache.get(svc.authCacheKey(CONFIG, GSTIN));
    expect(cached).toBeDefined();
    expect(cached!.expiresAt).toBeGreaterThan(Date.now());
    expect(cached!.expiresAt).toBe(Date.parse('2099-01-01T23:00:00+05:30') - 5 * 60_000);
  });

  it('falls back to a 5h TTL when TokenExpiry is missing or unusable', async () => {
    tokenExpiry = '';
    await callInvoice();

    const cached = svc.authCache.get(svc.authCacheKey(CONFIG, GSTIN))!;
    const hoursOut = (cached.expiresAt - Date.now()) / 3_600_000;
    expect(hoursOut).toBeGreaterThan(4.9);
    expect(hoursOut).toBeLessThan(5.1); // safely inside NIC's ~6h life
  });

  it('re-auths and retries once when NIC rejects the token (1005)', async () => {
    firstInvoiceBody = { Status: '0', ErrorDetails: [{ ErrorCode: '1005', ErrorMessage: 'Invalid Token' }] };

    const result = await callInvoice();

    expect(result.Status).toBe('1');       // caller never sees the stale token
    expect(auths).toBe(2);
    expect(invoices).toBe(2);
    expect(result.tokenUsed).toBe('tok-2'); // retried with the fresh one
  });

  it('surfaces a real business error without re-auth or retry', async () => {
    // 2311 = "6 digits HSN code is mandatory" - a payload fault. Retrying it just
    // burns calls and buries the reason the dispatch failed.
    firstInvoiceBody = { Status: '0', ErrorDetails: [{ ErrorCode: '2311', ErrorMessage: '6 digits HSN code is mandatory' }] };

    await expect(callInvoice()).rejects.toThrow(/2311/);
    expect(auths).toBe(1);
    expect(invoices).toBe(1);
  });

  it('does not reuse a token across changed credentials or environments', async () => {
    await callInvoice();
    expect(auths).toBe(1);

    await callInvoice({ ...CONFIG, taxproGstPass: 'rotated-password' });
    expect(auths).toBe(2);

    await callInvoice({ ...CONFIG, taxproGstUser: 'OTHER_user' });
    expect(auths).toBe(3);

    await callInvoice({ ...CONFIG, taxproSandbox: true });
    expect(auths).toBe(4);

    // ...but the original identity is still cached and reused.
    await callInvoice();
    expect(auths).toBe(4);
  });

  it('retries E-Way Bill generation with Distance: 0 when NIC rejects with distance error', async () => {
    const { getCompanyProfileRow } = await import('../controllers/settings.controller.js');
    const { prisma } = await import('../lib/prisma.js');

    (getCompanyProfileRow as any).mockResolvedValue(CONFIG);
    (prisma as any).saleDispatch = {
      findUnique: vi.fn().mockResolvedValue({
        id: 'disp-1',
        irn: 'test-irn',
        vehicleNumber: 'MH18BH5986',
      }),
    };

    let ewbCalls = 0;
    let distancePassedInCalls: number[] = [];

    globalThis.fetch = (async (url: string, init: any) => {
      if (String(url).includes('/auth')) {
        auths++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ Status: 1, Data: { AuthToken: `tok-${auths}`, TokenExpiry: tokenExpiry } }),
        };
      }
      if (String(url).includes('/ewaybill')) {
        ewbCalls++;
        const parsedBody = JSON.parse(init.body);
        distancePassedInCalls.push(parsedBody.Distance);

        if (ewbCalls === 1) {
          // First call rejects with NIC distance range error
          return {
            ok: true,
            status: 200,
            json: async () => ({
              Status: '0',
              ErrorDetails: [{ ErrorCode: '238', ErrorMessage: 'Distance between these two pincodes is not in range' }],
            }),
          };
        }

        // Second call with Distance: 0 succeeds
        return {
          ok: true,
          status: 200,
          json: async () => ({
            Status: '1',
            Data: {
              EwbNo: 112233445566,
              EwbDt: '2026-09-03 11:30:00',
              EwbValidTill: '2026-09-08 23:59:00',
              Distance: 820,
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ Status: '1' }) };
    }) as unknown as typeof fetch;

    const res = await TaxproService.generateEWayBill('disp-1', {
      transDistance: 893,
      transMode: '1',
      vehicleNumber: 'MH18BH5986',
      vehicleType: 'R',
    });

    expect(ewbCalls).toBe(2);
    expect(distancePassedInCalls).toEqual([893, 0]);
    expect(res.success).toBe(true);
    expect(res.ewbNumber).toBe('112233445566');
    expect(res.distance).toBe(820);
  });
});
