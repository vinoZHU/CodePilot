/**
 * POPO Adapter — implements BaseChannelAdapter for POPO Robot API.
 *
 * Unlike QQ/Feishu (WebSocket), POPO uses HTTP Webhook push mode:
 * - POPO server POSTs events to our webhook endpoint
 * - Our webhook route calls injectWebhookMessage() on this adapter
 * - consumeOne() blocks until a message is injected
 *
 * User identity: POPO uses email addresses (not opaque IDs).
 * chatId = sender email (P2P) or group ID (group)
 * userId = sender email
 *
 * Rate limits:
 * - P2P:   20000 msg/h per robot, 200/s per IP (account locked on exceed!)
 * - Group:  5000 msg/h per robot, 200/s per IP
 * - Text:  3000 char max per message
 */

import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '../types';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter';
import { getSetting, insertAuditLog } from '../../db';
import { getAccessToken, clearTokenCache, sendPopoMessage } from './popo-api';

/** Max dedup map size */
const DEDUP_MAX = 1000;

export class PopoAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'popo';

  private _running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  /** messageId → true, for dedup */
  private seenMessageIds = new Map<string, boolean>();

  // ── Lifecycle ──────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[popo-adapter] Cannot start:', configError);
      return;
    }

    // Pre-warm the token cache to catch credential errors early
    const appKey = getSetting('bridge_popo_app_key') || '';
    const appSecret = getSetting('bridge_popo_app_secret') || '';
    try {
      await getAccessToken(appKey, appSecret);
    } catch (err) {
      throw new Error(`[popo-adapter] Token initialization failed: ${err}`);
    }

    this._running = true;
    console.log('[popo-adapter] Started — waiting for webhook events');
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;

    clearTokenCache();

    // Wake up all blocked consumers with null (signals shutdown)
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];
    this.queue = [];
    this.seenMessageIds.clear();

    console.log('[popo-adapter] Stopped');
  }

  isRunning(): boolean {
    return this._running;
  }

  // ── Message Queue ──────────────────────────────────────────────

  /**
   * Block until a message arrives (pushed via injectWebhookMessage),
   * or return null if the adapter is stopped.
   */
  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (!this._running) return Promise.resolve(null);

    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Called by the Webhook route handler when POPO pushes an event.
   * Thread-safe within Node.js single-threaded event loop.
   */
  injectWebhookMessage(msg: InboundMessage): void {
    if (!this._running) return;

    // Dedup by message ID
    if (this.seenMessageIds.has(msg.messageId)) return;
    this.seenMessageIds.set(msg.messageId, true);
    if (this.seenMessageIds.size > DEDUP_MAX) {
      const firstKey = this.seenMessageIds.keys().next().value!;
      this.seenMessageIds.delete(firstKey);
    }

    // Authorization check
    if (!this.isAuthorized(msg.address.userId || '', msg.address.chatId)) {
      console.log('[popo-adapter] Message rejected: user not authorized', msg.address.userId);
      return;
    }

    // Dispatch to a waiting consumer or enqueue
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }

    // Audit log
    try {
      insertAuditLog({
        channelType: 'popo',
        chatId: msg.address.chatId,
        direction: 'inbound',
        messageId: msg.messageId,
        summary: msg.text.slice(0, 100),
      });
    } catch {
      // Non-fatal
    }
  }

  // ── Send ────────────────────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    const appKey = getSetting('bridge_popo_app_key') || '';
    const appSecret = getSetting('bridge_popo_app_secret') || '';

    let accessToken: string;
    try {
      accessToken = await getAccessToken(appKey, appSecret);
    } catch (err) {
      return { ok: false, error: `Token error: ${err}` };
    }

    // receiver is the chatId (user email for P2P, group ID for group)
    const receiver = message.address.chatId;
    const content = message.text;

    const result = await sendPopoMessage(accessToken, receiver, content);

    if (result.ok) {
      try {
        insertAuditLog({
          channelType: 'popo',
          chatId: receiver,
          direction: 'outbound',
          messageId: result.msgId || 'unknown',
          summary: content.slice(0, 100),
        });
      } catch {
        // Non-fatal
      }
    }

    // errcode 42001 = token expired during send; clear cache and let caller retry
    if (!result.ok && result.errcode === 42001) {
      clearTokenCache();
    }

    return { ok: result.ok, messageId: result.msgId, error: result.error };
  }

  // ── Config & Auth ───────────────────────────────────────────────

  validateConfig(): string | null {
    if (!getSetting('bridge_popo_app_key')) return 'POPO App Key 未配置';
    if (!getSetting('bridge_popo_app_secret')) return 'POPO App Secret 未配置';
    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    const allowed = getSetting('bridge_popo_allowed_users') || '';
    if (!allowed.trim()) return true; // empty = allow all
    return allowed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(userId);
  }
}

// ── Global singleton (for webhook route access) ─────────────────
// Stored in globalThis to survive Next.js HMR module re-evaluation.

const GLOBAL_INSTANCE_KEY = '__popo_adapter_instance__';

function getGlobalInstance(): PopoAdapter | null {
  const g = globalThis as unknown as Record<string, PopoAdapter | null>;
  return g[GLOBAL_INSTANCE_KEY] ?? null;
}

function setGlobalInstance(adapter: PopoAdapter | null): void {
  const g = globalThis as unknown as Record<string, PopoAdapter | null>;
  g[GLOBAL_INSTANCE_KEY] = adapter;
}

export function getPopoAdapterInstance(): PopoAdapter | null {
  return getGlobalInstance();
}

// Self-register
registerAdapterFactory('popo', () => {
  const adapter = new PopoAdapter();
  setGlobalInstance(adapter);
  return adapter;
});
