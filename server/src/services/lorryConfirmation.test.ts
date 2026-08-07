import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The register's whole value at dispatch time rests on one lorry number matching
 * another, written by two different people. These cover that matching and the
 * status transitions either side of it.
 */

const findFirst = vi.fn();
const update = vi.fn();
const updateMany = vi.fn();

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    transportConfirmation: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      update: (...a: unknown[]) => update(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
    },
  },
}));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  normalizeLorryNumber,
  findWaitingConfirmation,
  markConfirmationUsed,
  releaseConfirmationForDispatch,
} = await import('./lorryConfirmation.service.js');

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue(null);
});

describe('normalizeLorryNumber', () => {
  it('reduces every spelling of a lorry number to one form', () => {
    for (const raw of ['AP39T8217', 'ap 39 t 8217', 'AP-39-T-8217', ' Ap39t8217 ']) {
      expect(normalizeLorryNumber(raw)).toBe('AP39T8217');
    }
  });

  it('rejects blanks and stray fragments that would match everything', () => {
    expect(normalizeLorryNumber(null)).toBeNull();
    expect(normalizeLorryNumber('')).toBeNull();
    expect(normalizeLorryNumber('   ')).toBeNull();
    expect(normalizeLorryNumber('AP3')).toBeNull(); // too short to be a lorry
  });
});

describe('findWaitingConfirmation', () => {
  it('looks up the normalised number among waiting rows only', async () => {
    await findWaitingConfirmation('tn 86 a 6588');
    const where = findFirst.mock.calls[0][0].where;
    expect(where.lorryNumber).toBe('TN86A6588');
    expect(where.status.in).toEqual(['WAITING', 'DRAFT']);
  });

  it('takes the newest booking - the same lorry runs the route again', async () => {
    await findWaitingConfirmation('AP39T8217');
    expect(findFirst.mock.calls[0][0].orderBy).toEqual([{ messageDate: 'desc' }, { createdAt: 'desc' }]);
  });

  it('does not query on an unusable number', async () => {
    expect(await findWaitingConfirmation('')).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe('markConfirmationUsed', () => {
  it('flips the matched booking to USED and points it at the dispatch', async () => {
    findFirst.mockResolvedValue({ id: 'tc1', lorryNumber: 'AP39T8217' });
    expect(await markConfirmationUsed('AP 39 T 8217', 'disp1')).toBe('tc1');
    expect(update.mock.calls[0][0]).toMatchObject({
      where: { id: 'tc1' },
      data: { status: 'USED', saleDispatchId: 'disp1' },
    });
  });

  it('is a no-op for a lorry the transporter never messaged about', async () => {
    expect(await markConfirmationUsed('KA01AB1234', 'disp2')).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('swallows a database failure - the dispatch is already written', async () => {
    findFirst.mockRejectedValue(new Error('connection lost'));
    await expect(markConfirmationUsed('AP39T8217', 'disp3')).resolves.toBeNull();
  });
});

describe('releaseConfirmationForDispatch', () => {
  it('puts an undone dispatch\'s booking back on the waiting list', async () => {
    await releaseConfirmationForDispatch('disp1');
    expect(updateMany.mock.calls[0][0]).toMatchObject({
      where: { saleDispatchId: 'disp1', status: { in: ['CONFIRMED', 'USED'] } },
      data: { status: 'WAITING', saleDispatchId: null },
    });
  });
});
