/**
 * Maker-checker: segregation of duties and approval limits (Phase 2).
 *
 * The rules under test are the ones the framework exists for. A creator being
 * able to approve their own work, or a limit that can be stepped around, makes
 * the whole thing decorative.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const pendingFindUnique = vi.fn();
const pendingUpdateMany = vi.fn();
const pendingUpdate = vi.fn();
const pendingFindUniqueOrThrow = vi.fn();
const pendingCreate = vi.fn();
const limitFindUnique = vi.fn();
const rolePermissionFindMany = vi.fn();

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    pendingChange: {
      findUnique: (...a: unknown[]) => pendingFindUnique(...a),
      findUniqueOrThrow: (...a: unknown[]) => pendingFindUniqueOrThrow(...a),
      updateMany: (...a: unknown[]) => pendingUpdateMany(...a),
      update: (...a: unknown[]) => pendingUpdate(...a),
      create: (...a: unknown[]) => pendingCreate(...a),
      findMany: vi.fn(),
    },
    approvalLimit: { findUnique: (...a: unknown[]) => limitFindUnique(...a) },
    rolePermission: { findMany: (...a: unknown[]) => rolePermissionFindMany(...a) },
  },
}));

const svc = await import('../src/services/makerChecker.service.js');
const { invalidatePermissionCache } = await import('../src/services/permission.service.js');

const MAKER = { userId: 'maker-1', name: 'Maker', role: 'ADMIN' as const };
const CHECKER = { userId: 'checker-1', name: 'Checker', role: 'ADMIN' as const };
const PLAIN_USER = { userId: 'user-1', name: 'Staff', role: 'USER' as const };

function pending(over: Record<string, unknown> = {}) {
  return {
    id: 'pc1',
    subject: 'party.bank',
    subjectId: 'party-1',
    action: 'UPDATE',
    proposed: { accountNumber: '999' },
    previous: { accountNumber: '111' },
    summary: 'Change bank account',
    approvePermission: 'master.party.bank.edit',
    amount: null,
    status: 'PENDING',
    requestedById: MAKER.userId,
    ...over,
  };
}

beforeEach(() => {
  svc.clearAppliers();
  pendingFindUnique.mockReset();
  pendingUpdate.mockReset().mockResolvedValue({});
  pendingUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  pendingFindUniqueOrThrow.mockReset().mockResolvedValue(pending({ status: 'REJECTED' }));
  pendingCreate.mockReset().mockImplementation((args: any) => Promise.resolve(args.data));
  limitFindUnique.mockReset().mockResolvedValue(null);
  rolePermissionFindMany.mockReset().mockResolvedValue([]);
  invalidatePermissionCache();
});

afterEach(() => vi.clearAllMocks());

describe('segregation of duties', () => {
  it('refuses to let the requester approve their own change', async () => {
    pendingFindUnique.mockResolvedValue(pending());
    await expect(svc.approveChange('pc1', MAKER)).rejects.toThrow(/someone else has to approve/i);
    expect(pendingUpdateMany).not.toHaveBeenCalled();
  });

  it('refuses even when the requester is a DEVELOPER', async () => {
    // The rule must not have a way around it for the most privileged account:
    // that is the account an attacker wants in the first place.
    pendingFindUnique.mockResolvedValue(pending({ requestedById: 'dev-1' }));
    await expect(
      svc.approveChange('pc1', { userId: 'dev-1', role: 'DEVELOPER' })
    ).rejects.toThrow(/someone else has to approve/i);
  });

  it('refuses to let the requester reject their own change either', async () => {
    pendingFindUnique.mockResolvedValue(pending());
    await expect(svc.rejectChange('pc1', MAKER, 'changed my mind')).rejects.toThrow(
      /someone else has to approve/i
    );
  });

  it('lets a different person with the permission approve', async () => {
    pendingFindUnique.mockResolvedValue(pending());
    const applier = vi.fn().mockResolvedValue(undefined);
    svc.registerApplier('party.bank', applier);
    await svc.approveChange('pc1', CHECKER);
    expect(applier).toHaveBeenCalledOnce();
  });
});

describe('permission to decide', () => {
  it('refuses someone without the permission the request names', async () => {
    // USER holds no master.party.bank.edit by default.
    pendingFindUnique.mockResolvedValue(pending());
    await expect(svc.approveChange('pc1', PLAIN_USER)).rejects.toThrow(/do not have permission/i);
  });

  it('uses the permission recorded on the request, not today\'s map', async () => {
    // A request raised when approving needed X must still need X, even if the
    // route map has since been changed.
    pendingFindUnique.mockResolvedValue(pending({ approvePermission: 'system.manage' }));
    await expect(svc.approveChange('pc1', PLAIN_USER)).rejects.toThrow(/do not have permission/i);
  });
});

describe('approval limits', () => {
  beforeEach(() => {
    svc.registerApplier('party.bank', vi.fn().mockResolvedValue(undefined));
    svc.registerApplier('payment', vi.fn().mockResolvedValue(undefined));
  });

  it('allows an amount at or under the limit', async () => {
    limitFindUnique.mockResolvedValue({ maxAmount: 50000 });
    pendingFindUnique.mockResolvedValue(pending({ subject: 'payment', amount: 50000 }));
    svc.registerApplier('payment', vi.fn().mockResolvedValue(undefined));
    await expect(svc.approveChange('pc1', CHECKER)).resolves.toBeDefined();
  });

  it('refuses an amount above the limit', async () => {
    limitFindUnique.mockResolvedValue({ maxAmount: 50000 });
    pendingFindUnique.mockResolvedValue(pending({ subject: 'payment', amount: 50001 }));
    await expect(svc.approveChange('pc1', CHECKER)).rejects.toThrow(/above what your role may approve/i);
  });

  it('treats no configured limit as unlimited', async () => {
    limitFindUnique.mockResolvedValue(null);
    pendingFindUnique.mockResolvedValue(pending({ subject: 'payment', amount: 10_000_000 }));
    await expect(svc.approveChange('pc1', CHECKER)).resolves.toBeDefined();
  });

  it('does not assume unlimited when the limit lookup fails', async () => {
    // Failing to read a ceiling must never raise it.
    limitFindUnique.mockRejectedValue(new Error('database unreachable'));
    pendingFindUnique.mockResolvedValue(pending({ subject: 'payment', amount: 1 }));
    await expect(svc.approveChange('pc1', CHECKER)).rejects.toThrow(/above what your role may approve/i);
  });
});

describe('applying', () => {
  it('marks the change APPLIED when the applier succeeds', async () => {
    pendingFindUnique.mockResolvedValue(pending());
    svc.registerApplier('party.bank', vi.fn().mockResolvedValue(undefined));
    await svc.approveChange('pc1', CHECKER);
    const statuses = pendingUpdate.mock.calls.map((c) => c[0].data.status);
    expect(statuses).toContain('APPLIED');
  });

  it('marks it FAILED, not APPLIED, when the applier throws', async () => {
    pendingFindUnique.mockResolvedValue(pending());
    svc.registerApplier('party.bank', vi.fn().mockRejectedValue(new Error('constraint violated')));
    await expect(svc.approveChange('pc1', CHECKER)).rejects.toThrow(/could not be applied/i);
    const last = pendingUpdate.mock.calls.at(-1)?.[0].data;
    expect(last.status).toBe('FAILED');
    expect(last.error).toContain('constraint violated');
  });

  it('fails loudly for a subject with no applier registered', async () => {
    pendingFindUnique.mockResolvedValue(pending({ subject: 'not.wired.up' }));
    await expect(svc.approveChange('pc1', CHECKER)).rejects.toThrow(/cannot be applied yet/i);
    expect(pendingUpdate.mock.calls.at(-1)?.[0].data.status).toBe('FAILED');
  });
});

describe('races and repeats', () => {
  it('refuses a change that is no longer pending', async () => {
    pendingFindUnique.mockResolvedValue(pending({ status: 'APPLIED' }));
    await expect(svc.approveChange('pc1', CHECKER)).rejects.toThrow(/already been decided/i);
  });

  it('refuses when the conditional claim loses the race', async () => {
    // Two approvers clicking at once: only the one whose updateMany matched a
    // PENDING row proceeds, so the applier cannot run twice.
    pendingFindUnique.mockResolvedValue(pending());
    pendingUpdateMany.mockResolvedValue({ count: 0 });
    const applier = vi.fn();
    svc.registerApplier('party.bank', applier);
    await expect(svc.approveChange('pc1', CHECKER)).rejects.toThrow(/already been decided/i);
    expect(applier).not.toHaveBeenCalled();
  });
});

describe('rejecting', () => {
  it('requires a reason', async () => {
    pendingFindUnique.mockResolvedValue(pending());
    await expect(svc.rejectChange('pc1', CHECKER, '  ')).rejects.toThrow(/give a reason/i);
    await expect(svc.rejectChange('pc1', CHECKER, 'no')).rejects.toThrow(/give a reason/i);
  });

  it('records the reason and the decider', async () => {
    pendingFindUnique.mockResolvedValue(pending());
    await svc.rejectChange('pc1', CHECKER, 'Account does not match the letterhead');
    const data = pendingUpdateMany.mock.calls[0][0].data;
    expect(data.status).toBe('REJECTED');
    expect(data.decidedById).toBe(CHECKER.userId);
    expect(data.decisionReason).toBe('Account does not match the letterhead');
  });
});

describe('requesting', () => {
  it('refuses a request naming a permission that does not exist', async () => {
    await expect(
      svc.requestChange({
        subject: 'party.bank',
        action: 'UPDATE',
        proposed: {},
        summary: 'x',
        approvePermission: 'not.a.permission' as never,
        requestedById: MAKER.userId,
      })
    ).rejects.toThrow(/unknown approval permission/i);
  });
});
