type CacheEntry<T> = {
  value: T;
  expiry: number;
};

const cache = new Map<string, CacheEntry<any>>();
const pending = new Map<string, Promise<any>>();

export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>
): Promise<T> {
  const now = Date.now();
  const entry = cache.get(key);

  if (entry && entry.expiry > now) {
    return entry.value;
  }

  const existing = pending.get(key);
  if (existing) return existing;

  // Promise identity prevents an invalidated, older computation from publishing
  // stale data or removing a newer request's pending entry.
  const work = Promise.resolve().then(fn).then((value) => {
    if (pending.get(key) === work) {
      cache.set(key, { value, expiry: Date.now() + ttlSeconds * 1000 });
    }
    return value;
  }).finally(() => {
    if (pending.get(key) === work) pending.delete(key);
  });
  pending.set(key, work);
  return work;
}

export function clearCache(key?: string) {
  if (key) {
    cache.delete(key);
    pending.delete(key);
  } else {
    cache.clear();
    pending.clear();
  }
}
