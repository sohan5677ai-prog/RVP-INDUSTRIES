/** Keep the deadline active through body consumption, not just response headers. */
export async function withRequestDeadline<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  mutation = false,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timer = timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs) : undefined;
  try {
    return await run(controller.signal);
  } catch (error) {
    if (timedOut && !signal?.aborted) {
      throw new Error(mutation
        ? 'The server did not respond in time. Your change may have been saved. Refresh and check the record before submitting again.'
        : 'The server did not respond in time. Please try again.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
