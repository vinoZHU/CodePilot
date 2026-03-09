/**
 * Bridge event bus — lets server-side bridge push real-time notifications
 * to SSE clients (i.e., the ChatView watching a bridge-controlled session).
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

const GLOBAL_KEY = '__bridge_event_subscribers__';

type SubscriberFn = (event: string, data: string) => void;

function getSubscriberMap(): Map<string, Set<SubscriberFn>> {
  const g = globalThis as unknown as Record<string, Map<string, Set<SubscriberFn>>>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map();
  }
  return g[GLOBAL_KEY];
}

/**
 * Subscribe to bridge events for a specific session.
 * Returns an unsubscribe function.
 */
export function subscribeBridgeEvents(sessionId: string, fn: SubscriberFn): () => void {
  const map = getSubscriberMap();
  if (!map.has(sessionId)) {
    map.set(sessionId, new Set());
  }
  map.get(sessionId)!.add(fn);

  return () => {
    const subs = map.get(sessionId);
    if (subs) {
      subs.delete(fn);
      if (subs.size === 0) map.delete(sessionId);
    }
  };
}

/**
 * Notify all SSE subscribers that a bridge message was processed for this session.
 * Called by bridge-manager after handleMessage() completes.
 */
export function notifyBridgeUpdate(
  sessionId: string,
  type: 'message-complete' | 'message-start' = 'message-complete',
): void {
  const subs = getSubscriberMap().get(sessionId);
  if (!subs || subs.size === 0) return;

  const data = JSON.stringify({ type, sessionId, ts: Date.now() });
  for (const fn of subs) {
    try {
      fn('bridge-update', data);
    } catch {
      // Ignore — subscriber may have closed
    }
  }
}
