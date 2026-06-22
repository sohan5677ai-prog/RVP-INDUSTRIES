import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// --- Mock Gemini so the PO parser test runs without network/API key ---
const mockGenerate = vi.hoisted(() => vi.fn());
vi.mock('@google/genai', () => ({
  // A real class so `new GoogleGenAI()` reliably exposes `.models` under `new`.
  GoogleGenAI: class {
    models = { generateContent: mockGenerate };
  },
  Type: { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER' },
}));

import { apiGet, apiPost, apiPostMultipart, ErpApiError, type ErpUser } from './erpClient';
import { tonnesToKg, kgToTonnes } from './parse';
import { verifyToken } from '../lib/jwt';
import { extractPurchaseOrderText, extractSaleOrderText } from '../lib/gemini';

const USER: ErpUser = { userId: 'user_123', role: 'ADMIN' };

function fakeResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe('parse helpers', () => {
  it('converts tonnes <-> kg', () => {
    expect(tonnesToKg(50)).toBe(50000);
    expect(tonnesToKg(12.5)).toBe(12500);
    expect(kgToTonnes(50000)).toBe('50');
  });
});

describe('erpClient', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('apiPost attaches a Bearer token that decodes to the acting ERP user', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(201, { id: 'po1', poNumber: 'DCS-001' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiPost('/purchase-orders', { partyId: 'p1' }, USER);
    expect(res).toEqual({ id: 'po1', poNumber: 'DCS-001' });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/purchase-orders$/);
    expect(opts.method).toBe('POST');
    const auth = opts.headers.Authorization as string;
    expect(auth.startsWith('Bearer ')).toBe(true);
    const decoded = verifyToken(auth.slice('Bearer '.length));
    expect(decoded.userId).toBe(USER.userId);
    expect(decoded.role).toBe(USER.role);
    expect(JSON.parse(opts.body)).toEqual({ partyId: 'p1' });
  });

  it('apiGet sends the auth header and returns parsed JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, [{ id: 'p1' }]));
    vi.stubGlobal('fetch', fetchMock);
    const res = await apiGet('/parties', USER);
    expect(res).toEqual([{ id: 'p1' }]);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toMatch(/^Bearer /);
  });

  it('apiPostMultipart builds a FormData with fields and the file', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(201, { id: 's1' }));
    vi.stubGlobal('fetch', fetchMock);

    await apiPostMultipart(
      '/stock-in',
      { purchaseOrderId: 'po1', billingWeightKg: 10000, skip: undefined },
      [{ field: 'invoice', buffer: Buffer.from('hello'), filename: 'inv.jpg', mimetype: 'image/jpeg' }],
      USER
    );

    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('purchaseOrderId')).toBe('po1');
    expect(body.get('billingWeightKg')).toBe('10000');
    expect(body.has('skip')).toBe(false); // undefined fields are dropped
    const file = body.get('invoice') as File;
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe('inv.jpg');
  });

  it('throws ErpApiError with the status and server message on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(409, { message: 'Purchase already recorded' })));
    await expect(apiPost('/purchases', {}, USER)).rejects.toMatchObject({
      name: 'ErpApiError',
      status: 409,
      message: 'Purchase already recorded',
    });
  });
});

describe('extractPurchaseOrderText', () => {
  beforeAll(() => {
    process.env.GEMINI_API_KEY = 'test-key';
  });
  beforeEach(() => mockGenerate.mockReset());

  it('normalises fields and rejects a non-exact party match', async () => {
    mockGenerate.mockResolvedValue({
      text: JSON.stringify({
        poDate: '2026-06-22',
        partyName: 'DCS',
        matchedPartyName: 'd.c.s. traders', // not exactly a candidate -> dropped
        tonnageTonnes: 50,
        pricePerKg: 25.5,
        priceType: 'base', // lower-case -> upper-cased
      }),
    });
    const r = await extractPurchaseOrderText('22 Jun, DCS, 50t, 25.5/kg', ['DCS Traders']);
    expect(r.tonnageTonnes).toBe(50);
    expect(r.pricePerKg).toBe(25.5);
    expect(r.priceType).toBe('BASE');
    expect(r.matchedPartyName).toBeUndefined();
  });

  it('returns the canonical supplier name on an exact (case-insensitive) match', async () => {
    mockGenerate.mockResolvedValue({
      text: JSON.stringify({ matchedPartyName: 'dcs traders', tonnageTonnes: 10, pricePerKg: 20 }),
    });
    const r = await extractPurchaseOrderText('order', ['DCS Traders']);
    expect(r.matchedPartyName).toBe('DCS Traders');
  });

  it('drops non-positive weights/prices', async () => {
    mockGenerate.mockResolvedValue({ text: JSON.stringify({ tonnageTonnes: 0, pricePerKg: -5 }) });
    const r = await extractPurchaseOrderText('garbled', []);
    expect(r.tonnageTonnes).toBeUndefined();
    expect(r.pricePerKg).toBeUndefined();
  });
});

describe('extractSaleOrderText', () => {
  beforeAll(() => {
    process.env.GEMINI_API_KEY = 'test-key';
  });
  beforeEach(() => mockGenerate.mockReset());

  it('canonicalises buyer + broker matches and a valid product', async () => {
    mockGenerate.mockResolvedValue({
      text: JSON.stringify({
        matchedBuyerName: 'krishna exports',
        matchedBrokerName: 'ramesh commission agent',
        tonnageTonnes: 20,
        pricePerKg: 95,
        product: 'pappu',
      }),
    });
    const r = await extractSaleOrderText('Krishna, broker Ramesh, 20t pappu, 95', ['Krishna Exports'], ['Ramesh Commission Agent']);
    expect(r.matchedBuyerName).toBe('Krishna Exports');
    expect(r.matchedBrokerName).toBe('Ramesh Commission Agent');
    expect(r.product).toBe('PAPPU');
    expect(r.tonnageTonnes).toBe(20);
  });

  it('drops an invalid product and a non-matching buyer', async () => {
    mockGenerate.mockResolvedValue({
      text: JSON.stringify({ matchedBuyerName: 'unknown co', product: 'GOLD', pricePerKg: 50, tonnageTonnes: 5 }),
    });
    const r = await extractSaleOrderText('x', ['Krishna Exports'], []);
    expect(r.matchedBuyerName).toBeUndefined();
    expect(r.product).toBeUndefined();
    expect(r.pricePerKg).toBe(50);
  });
});
