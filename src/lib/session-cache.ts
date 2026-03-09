/**
 * Module-level session metadata cache.
 *
 * Populated by ChatListPanel whenever it fetches the session list,
 * consumed by the chat page to render the title bar and initialize
 * ChatView without waiting for a separate API round-trip.
 *
 * Intentionally a plain Map (not React state) so it survives navigation
 * and is accessible synchronously in useState initializers.
 */

import type { ChatSession } from '@/types';

const cache = new Map<string, ChatSession>();

/** Upsert a single session into the cache. */
export function setCachedSession(session: ChatSession): void {
  cache.set(session.id, session);
}

/** Bulk-upsert sessions (called by ChatListPanel after every fetch). */
export function setCachedSessions(sessions: ChatSession[]): void {
  for (const s of sessions) {
    cache.set(s.id, s);
  }
}

/** Returns the cached ChatSession for `id`, or undefined if not cached. */
export function getCachedSession(id: string): ChatSession | undefined {
  return cache.get(id);
}

/** Remove a session from the cache (e.g. after deletion). */
export function clearCachedSession(id: string): void {
  cache.delete(id);
}
