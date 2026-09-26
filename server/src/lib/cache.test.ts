import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearCache, withCache } from './cache.js';

afterEach(() => { clearCache(); vi.useRealTimers(); });

describe('report cache', () => {
  it('shares concurrent work and starts TTL when computation completes', async () => {
    vi.useFakeTimers();
    let finish!: (value: number) => void;
    const compute = vi.fn(() => new Promise<number>(resolve => { finish = resolve; }));
    const first = withCache('stock', 1, compute);
    const second = withCache('stock', 1, compute);
    await Promise.resolve();
    vi.advanceTimersByTime(2000);
    finish(42);
    expect(await Promise.all([first, second])).toEqual([42, 42]);
    expect(await withCache('stock', 1, compute)).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1001);
    expect(await withCache('stock', 1, async () => 43)).toBe(43);
  });

  it.each([true, false])('does not restore invalidated work (keyed=%s)', async (keyed) => {
    let finish!: (value: string) => void;
    const old = withCache('stock', 60, () => new Promise<string>(resolve => { finish = resolve; }));
    await Promise.resolve();
    clearCache(keyed ? 'stock' : undefined);
    expect(await withCache('stock', 60, async () => 'new')).toBe('new');
    finish('old');
    expect(await old).toBe('old');
    expect(await withCache('stock', 60, async () => 'unexpected')).toBe('new');
  });

  it('allows retries after a failed computation', async () => {
    await expect(withCache('stock', 60, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(await withCache('stock', 60, async () => 1)).toBe(1);
  });
});
