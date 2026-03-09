/**
 * Module-level message cache (stale-while-revalidate pattern).
 *
 * Populated by the chat page after a successful message fetch.
 * On subsequent visits to the same session, messages are served
 * from cache immediately (no loading spinner), while a background
 * fetch refreshes the data silently.
 *
 * Max 20 sessions cached to prevent unbounded memory growth.
 */

import type { Message } from '@/types';

const MAX_CACHED_SESSIONS = 20;

interface CachedMessages {
  messages: Message[];
  hasMore: boolean;
  /** Epoch ms when this entry was last written */
  timestamp: number;
}

const cache = new Map<string, CachedMessages>();

/** Store or update cached messages for a session. */
export function setCachedMessages(
  sessionId: string,
  messages: Message[],
  hasMore: boolean,
): void {
  // Evict the oldest entry when at capacity (and this is a new session)
  if (!cache.has(sessionId) && cache.size >= MAX_CACHED_SESSIONS) {
    let oldestKey = '';
    let oldestTs = Infinity;
    for (const [key, val] of cache) {
      if (val.timestamp < oldestTs) {
        oldestTs = val.timestamp;
        oldestKey = key;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(sessionId, { messages, hasMore, timestamp: Date.now() });
}

/** Returns cached messages for `sessionId`, or undefined if not cached. */
export function getCachedMessages(
  sessionId: string,
): CachedMessages | undefined {
  return cache.get(sessionId);
}

/** Invalidate the cache for a session (e.g. after /clear). */
export function invalidateCachedMessages(sessionId: string): void {
  cache.delete(sessionId);
}
