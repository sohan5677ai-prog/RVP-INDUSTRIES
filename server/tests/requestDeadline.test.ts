import { afterEach, describe, expect, it, vi } from 'vitest';
import { withRequestDeadline } from '../../client/src/lib/requestDeadline';

afterEach(() => vi.useRealTimers());
const stalled = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

describe('request deadline', () => {
  it('aborts stalled reads with a retry message', async () => {
    vi.useFakeTimers();
    const work = withRequestDeadline(undefined, 1000, stalled);
    const check = expect(work).rejects.toThrow('Please try again');
    await vi.advanceTimersByTimeAsync(1000);
    await check;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('warns that a timed-out write may have committed', async () => {
    vi.useFakeTimers();
    const work = withRequestDeadline(undefined, 1000, stalled, true);
    const check = expect(work).rejects.toThrow('may have been saved');
    await vi.advanceTimersByTimeAsync(1000);
    await check;
  });
  it('preserves caller cancellation and cleans up the timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const work = withRequestDeadline(controller.signal, 1000, stalled);
    const reason = new Error('navigation');
    controller.abort(reason);
    await expect(work).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cleans up on success and handles pre-aborted requests', async () => {
    vi.useFakeTimers();
    expect(await withRequestDeadline(undefined, 1000, async () => 42)).toBe(42);
    expect(vi.getTimerCount()).toBe(0);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(withRequestDeadline(controller.signal, 1000, stalled)).rejects.toThrow('cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });
});
