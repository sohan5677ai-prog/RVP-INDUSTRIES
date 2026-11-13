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
  buildIndentVariables,
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
  const slot = (
    code: string,
    classKg: number,
    dest: string,
    over: { product?: string; loadingPoint?: string; lorry?: string } = {}
  ) =>
    ({
      code,
      vehicleClassKg: classKg,
      plannedKg: classKg,
      loadingPoint: over.loadingPoint ?? 'RVP',
      lorryNumber: over.lorry ?? null,
      saleOrder: { destination: dest, product: over.product ?? 'PAPPU', buyer: { city: null } },
    }) as never;

  const vars = (slots: never[], revision = false) =>
    buildIndentVariables({ transportName: 'Surya Road Lines', date: NOV16, slots, revision });

  it('puts the whole fleet on ONE line - Meta drops a variable with a newline in it', () => {
    const v = vars([slot('16NOV-01', 30_000, 'Surat'), slot('16NOV-02', 25_000, 'Barshi')]);
    expect(v.vehiclesLine).not.toContain('\n');
    expect(v.vehiclesLine).toBe(
      '16NOV-01 30t Pappu RVP to Surat | 16NOV-02 25t Pappu RVP to Barshi'
    );
  });

  it('carries the loading point per lorry, so a mixed day cannot send one to the wrong gate', () => {
    const v = vars([
      slot('16NOV-01', 30_000, 'Surat'),
      slot('16NOV-02', 25_000, 'Barshi', { loadingPoint: 'KNM', product: 'HUSK' }),
    ]);
    expect(v.vehiclesLine).toBe(
      '16NOV-01 30t Pappu RVP to Surat | 16NOV-02 25t Husk KNM to Barshi'
    );
  });

  it('never names the buyer', () => {
    // The one rule that is not cosmetic: the number this goes out on is shared,
    // and who bought the goods is no part of arranging a lorry.
    const v = vars([slot('16NOV-01', 30_000, 'Surat')]);
    const msg = buildIndentMessage({
      transportName: 'Surya Road Lines',
      date: NOV16,
      slots: [slot('16NOV-01', 30_000, 'Surat')],
      revision: false,
    });
    expect(v.vehiclesLine).not.toMatch(/Vinod|Traders|buyer/i);
    expect(msg).not.toMatch(/Vinod|Traders|buyer/i);
  });

  it('dates the day the way the template sample does, and flags a re-send', () => {
    expect(vars([slot('16NOV-01', 30_000, 'Surat')]).dateLabel).toBe('16-Nov-2026 (Mon)');
    expect(vars([slot('16NOV-01', 30_000, 'Surat')], true).dateLabel).toBe('16-Nov-2026 (Mon) (REVISED)');
  });

  it('shows a lorry already confirmed, so a revision reads as a change not a repeat', () => {
    const v = vars([slot('16NOV-01', 30_000, 'Surat', { lorry: 'AP39T8217' })], true);
    expect(v.vehiclesLine).toBe('16NOV-01 30t Pappu RVP to Surat [AP39T8217]');
  });

  it('renders the same three variables as the approved template body', () => {
    const msg = buildIndentMessage({
      transportName: 'Surya Road Lines',
      date: NOV16,
      slots: [slot('16NOV-01', 30_000, 'Surat'), slot('16NOV-02', 32_500, 'Barshi')],
      revision: false,
    });
    expect(msg).toBe(
      [
        'Dear Surya Road Lines,',
        'Please arrange the following vehicles.',
        '',
        'Loading date: *16-Nov-2026 (Mon)*',
        '',
        'Vehicles: 16NOV-01 30t Pappu RVP to Surat | 16NOV-02 32.5t Pappu RVP to Barshi',
        '',
        'Kindly reply with the lorry number, driver name and driver mobile against each code.',
      ].join('\n')
    );
  });
});
