/**
 * Generic module-level API response cache (stale-while-revalidate).
 *
 * Survives navigation / component remounts because it lives at module scope,
 * not inside React state. Components read the cache synchronously as their
 * useState initializer, then always re-fetch in the background.
 *
 * Entries expire after DEFAULT_TTL_MS; callers can pass a custom TTL.
 * LRU eviction keeps the map bounded at MAX_ENTRIES.
 */

const MAX_ENTRIES = 60;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

/**
 * Read a cached value. Returns `undefined` if the entry is missing or stale.
 *
 * @param key   - Unique cache key (include scope/id if needed, e.g. `skills:${cwd}`)
 * @param ttlMs - How long to consider the entry fresh (default 5 min)
 */
export function getApiCache<T>(
  key: string,
  ttlMs = DEFAULT_TTL_MS,
): T | undefined {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > ttlMs) {
    cache.delete(key);
    return undefined;
  }
  return entry.data;
}

/**
 * Write (or overwrite) a cache entry.
 * Evicts the oldest entry when the cache is full.
 */
export function setApiCache<T>(key: string, data: T): void {
  // Evict the oldest entry if we're at capacity (and this is a new key)
  if (!cache.has(key) && cache.size >= MAX_ENTRIES) {
    let oldestKey = '';
    let oldestTs = Infinity;
    for (const [k, v] of cache) {
      if (v.timestamp < oldestTs) {
        oldestTs = v.timestamp;
        oldestKey = k;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, { data, timestamp: Date.now() });
}

/** Remove a specific cache entry (e.g. after a mutation). */
export function invalidateApiCache(key: string): void {
  cache.delete(key);
}

/** Remove all entries whose key starts with the given prefix. */
export function invalidateApiCacheByPrefix(prefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
