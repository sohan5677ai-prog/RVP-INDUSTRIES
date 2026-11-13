import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Two things here can quietly cost real money, so they are the two things
 * covered: the planning arithmetic that stops the same tonnage being promised
 * twice, and the slot code the transporter replies against.
 */

const slotAggregate = vi.fn();
const slotFindFirst = vi.fn();
const slotCreate = vi.fn();
const orderFindUnique = vi.fn();
const transportFindUnique = vi.fn();

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    dispatchSlot: {
      aggregate: (...a: unknown[]) => slotAggregate(...a),
      findFirst: (...a: unknown[]) => slotFindFirst(...a),
      create: (...a: unknown[]) => slotCreate(...a),
    },
    saleOrder: { findUnique: (...a: unknown[]) => orderFindUnique(...a) },
    transport: { findUnique: (...a: unknown[]) => transportFindUnique(...a) },
  },
}));

const {
  slotCode,
  nextSeqForDate,
  parseSlotDate,
  slotDateKey,
  validateSlot,
  createSlot,
  buildIndentMessage,
} = await import('./dispatchSlot.service.js');

const NOV16 = parseSlotDate('2026-11-16');

/** A 100 t order with nothing shipped and nothing planned, unless overridden. */
function orderWith(opts: { tonnageKg?: number; dispatchedKg?: number; closed?: boolean } = {}) {
  const tonnageKg = opts.tonnageKg ?? 100_000;
  orderFindUnique.mockResolvedValue({
    id: 'order1',
    tonnageKg,
    closedAt: opts.closed ? new Date() : null,
    buyer: { name: 'Vinod Traders' },
    dispatches: opts.dispatchedKg ? [{ weightKg: opts.dispatchedKg }] : [],
  });
}

const input = (over: Partial<Parameters<typeof validateSlot>[0]> = {}) => ({
  saleOrderId: 'order1',
  date: NOV16,
  vehicleClassKg: 30_000,
  plannedKg: 30_000,
  loadingPoint: 'RVP',
  transportId: null,
  notes: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  slotAggregate.mockResolvedValue({ _sum: { plannedKg: 0 } });
  slotFindFirst.mockResolvedValue(null);
  slotCreate.mockImplementation((args: { data: unknown }) => Promise.resolve(args.data));
});

describe('slot codes', () => {
  it('names a slot by its loading day and its place in that day', () => {
    expect(slotCode(NOV16, 1)).toBe('16NOV-01');
    expect(slotCode(NOV16, 12)).toBe('16NOV-12');
    expect(slotCode(parseSlotDate('2027-01-03'), 2)).toBe('03JAN-02');
  });

  it('reads the day in IST, not UTC', () => {
    // 16-Nov 00:00 IST is 15-Nov 18:30 UTC. A naive getDate() would file this
    // lorry under the 15th and send the transporter the wrong date.
    expect(NOV16.toISOString()).toBe('2026-11-15T18:30:00.000Z');
    expect(slotDateKey(NOV16)).toBe('2026-11-16');
    expect(slotCode(NOV16, 1)).toBe('16NOV-01');
  });

  it('rejects anything that is not a plain calendar day', () => {
    expect(() => parseSlotDate('16-11-2026')).toThrow(/Invalid date/);
  });

  it('numbers a day from its highest slot, so a move onto that day cannot collide', async () => {
    // seq is unique per date. A lorry moved onto a day that already has a
    // seq 1 must take the next free number, not carry its old one across.
    slotFindFirst.mockResolvedValue({ seq: 2 });
    await expect(nextSeqForDate(NOV16)).resolves.toBe(3);
    slotFindFirst.mockResolvedValue(null);
    await expect(nextSeqForDate(NOV16)).resolves.toBe(1);
  });

  it('never reuses a number already sent out, even after a cancellation', async () => {
    // Three slots existed and the middle one was cancelled; the next lorry is
    // 04, not 03 - the transporter already has a 16NOV-03 on his phone.
    slotFindFirst.mockResolvedValue({ seq: 3 });
    orderWith();
    const slot = (await createSlot(input())) as { code: string; seq: number };
    expect(slot.seq).toBe(4);
    expect(slot.code).toBe('16NOV-04');
  });
});

describe('planning arithmetic', () => {
  it('will not plan more than the lorry holds', async () => {
    orderWith();
    await expect(validateSlot(input({ plannedKg: 32_000 }))).rejects.toThrow(/will not fit a 30 t lorry/);
  });

  it('will not promise tonnage the order no longer has', async () => {
    // 100 t sold, 40 t already shipped, 30 t planned on another day: 30 t left.
    orderWith({ dispatchedKg: 40_000 });
    slotAggregate.mockResolvedValue({ _sum: { plannedKg: 30_000 } });
    await expect(validateSlot(input({ vehicleClassKg: 35_000, plannedKg: 35_000 }))).rejects.toThrow(
      /Only 30 t of the order for Vinod Traders is still unplanned/
    );
    await expect(validateSlot(input({ plannedKg: 30_000 }))).resolves.toBeUndefined();
  });

  it('counts a loaded slot once, not twice', async () => {
    // The aggregate must exclude LOADED, whose tonnage is already inside
    // dispatchedKg. Were it counted in both, this order would look 60 t
    // over-planned and the last lorry would be refused.
    orderWith({ dispatchedKg: 30_000 });
    await validateSlot(input());
    const where = slotAggregate.mock.calls[0][0].where;
    expect(where.status.in).toEqual(['PLANNED', 'REQUESTED', 'CONFIRMED']);
  });

  it('ignores the slot being edited when re-checking its own order', async () => {
    orderWith();
    await validateSlot(input({ plannedKg: 25_000 }), 'slot1');
    expect(slotAggregate.mock.calls[0][0].where.id).toEqual({ not: 'slot1' });
  });

  it('refuses a closed order', async () => {
    orderWith({ closed: true });
    await expect(validateSlot(input())).rejects.toThrow(/closed/);
  });

  it('refuses an unknown loading point', async () => {
    orderWith();
    await expect(validateSlot(input({ loadingPoint: 'SURAT' }))).rejects.toThrow(/Unknown loading point/);
  });
});

describe('the day indent', () => {
  const slot = (code: string, classKg: number, dest: string, lorry?: string) =>
    ({
      code,
      vehicleClassKg: classKg,
      plannedKg: classKg,
      loadingPoint: 'RVP',
      lorryNumber: lorry ?? null,
      saleOrder: { destination: dest, buyer: { city: null } },
    }) as never;

  it('lists a day\'s lorries by code, with the total', () => {
    const msg = buildIndentMessage({
      companyName: 'RVP INDUSTRIES',
      transportName: 'Surya Road Lines',
      date: NOV16,
      slots: [slot('16NOV-01', 30_000, 'Surat'), slot('16NOV-02', 25_000, 'Barshi')],
      revision: false,
    });
    expect(msg).toContain('16-NOV (Mon)');
    expect(msg).toContain('16NOV-01 - 30 t to Surat');
    expect(msg).toContain('16NOV-02 - 25 t to Barshi');
    expect(msg).toContain('Total: 2 lorries · 55 t');
    expect(msg).not.toContain('REVISED');
  });

  it('marks a re-send as revised and shows what is already confirmed', () => {
    const msg = buildIndentMessage({
      companyName: 'RVP INDUSTRIES',
      transportName: 'Surya Road Lines',
      date: NOV16,
      slots: [slot('16NOV-01', 30_000, 'Surat', 'AP39T8217')],
      revision: true,
    });
    expect(msg).toContain('(REVISED)');
    expect(msg).toContain('[AP39T8217]');
    expect(msg).toContain('Total: 1 lorry · 30 t');
  });

  it('splits the list by loading point when a day loads at both', () => {
    const knm = { ...(slot('16NOV-02', 25_000, 'Barshi') as object), loadingPoint: 'KNM' } as never;
    const msg = buildIndentMessage({
      companyName: 'RVP INDUSTRIES',
      transportName: 'Surya Road Lines',
      date: NOV16,
      slots: [slot('16NOV-01', 30_000, 'Surat'), knm],
      revision: false,
    });
    expect(msg).toContain('Loading at RVP:');
    expect(msg).toContain('Loading at KNM:');
  });
});
