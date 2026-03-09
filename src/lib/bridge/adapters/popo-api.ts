/**
 * POPO API Layer — Token management + message sending.
 *
 * POPO uses email addresses (not opaque IDs) to identify users and robots.
 * Access tokens expire in 24h; refresh tokens expire in 30 days.
 *
 * API Base: https://open.popo.netease.com
 * Auth header: Open-Access-Token: {accessToken}
 */

import { getSetting } from '@/lib/db';

const POPO_BASE = 'https://open.popo.netease.com';

// ── Token Cache ────────────────────────────────────────────────

interface TokenCache {
  accessToken: string;
  /** Unix ms when accessToken expires */
  expiresAt: number;
  refreshToken: string;
  /** Unix ms when refreshToken expires */
  refreshExpiresAt: number;
  /** The appKey this cache is for (invalidate if key changes) */
  appKey: string;
}

let _tokenCache: TokenCache | null = null;

/** Refresh 5 minutes before expiry to avoid races. */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Get a valid accessToken, fetching/refreshing as needed.
 * Caches result in module-level memory.
 */
export async function getAccessToken(appKey: string, appSecret: string): Promise<string> {
  const now = Date.now();

  // Cache hit: accessToken still valid
  if (
    _tokenCache &&
    _tokenCache.appKey === appKey &&
    _tokenCache.expiresAt - TOKEN_REFRESH_BUFFER_MS > now
  ) {
    return _tokenCache.accessToken;
  }

  // Try refresh if refreshToken is still valid
  if (
    _tokenCache &&
    _tokenCache.appKey === appKey &&
    _tokenCache.refreshExpiresAt > now
  ) {
    try {
      const refreshed = await refreshAccessToken(appKey, _tokenCache.refreshToken);
      _tokenCache = { ...refreshed, appKey };
      return _tokenCache.accessToken;
    } catch {
      // Refresh failed — fall through to full re-auth
    }
  }

  // Full re-authorization
  const fresh = await fetchAccessToken(appKey, appSecret);
  _tokenCache = { ...fresh, appKey };
  return _tokenCache.accessToken;
}

/** Clear the token cache (e.g. on config change). */
export function clearTokenCache(): void {
  _tokenCache = null;
}

interface RawTokenData {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
}

async function fetchAccessToken(appKey: string, appSecret: string): Promise<RawTokenData> {
  const res = await fetch(`${POPO_BASE}/open-apis/robots/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey, appSecret }),
    signal: AbortSignal.timeout(15_000),
  });

  const json = await res.json() as {
    errcode: number;
    errmsg: string;
    data?: {
      accessToken: string;
      accessExpiredAt: number;
      refreshToken: string;
      refreshExpiredAt: number;
    };
  };

  if (json.errcode !== 0 || !json.data) {
    throw new Error(`POPO token fetch failed: ${json.errmsg} (errcode=${json.errcode})`);
  }

  return {
    accessToken: json.data.accessToken,
    expiresAt: json.data.accessExpiredAt,
    refreshToken: json.data.refreshToken,
    refreshExpiresAt: json.data.refreshExpiredAt,
  };
}

async function refreshAccessToken(appKey: string, refreshToken: string): Promise<RawTokenData> {
  const res = await fetch(`${POPO_BASE}/open-apis/robots/v1/token/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey, refreshToken }),
    signal: AbortSignal.timeout(15_000),
  });

  const json = await res.json() as {
    errcode?: number;
    status?: number;
    errmsg?: string;
    message?: string;
    data?: {
      accessToken: string;
      accessExpiredAt: number;
      refreshToken: string;
      refreshExpiredAt: number;
    };
  };

  // 42002 = refreshToken expired
  const errcode = json.errcode ?? json.status ?? -1;
  if (errcode !== 0 || !json.data) {
    throw new Error(`POPO token refresh failed: ${json.errmsg ?? json.message} (errcode=${errcode})`);
  }

  return {
    accessToken: json.data.accessToken,
    expiresAt: json.data.accessExpiredAt,
    refreshToken: json.data.refreshToken,
    refreshExpiresAt: json.data.refreshExpiredAt,
  };
}

// ── Send Message ───────────────────────────────────────────────

export interface PopoSendResult {
  ok: boolean;
  msgId?: string;
  error?: string;
  errcode?: number;
}

/**
 * Send a P2P or group text message via POPO robot.
 *
 * @param accessToken  Valid access token
 * @param receiver     Recipient email (P2P) or group ID (group chat)
 * @param content      Plain text content (max 3000 chars)
 */
export async function sendPopoMessage(
  accessToken: string,
  receiver: string,
  content: string,
): Promise<PopoSendResult> {
  try {
    const res = await fetch(`${POPO_BASE}/open-apis/robots/v1/im/send-msg`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Open-Access-Token': accessToken,
      },
      body: JSON.stringify({
        receiver,
        msgType: 'text',
        message: { content },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const json = await res.json() as {
      errcode: number;
      errmsg: string;
      data?: {
        msgInfo?: Record<string, string>;
      };
    };

    if (json.errcode !== 0) {
      return { ok: false, error: json.errmsg, errcode: json.errcode };
    }

    // msgInfo: { [receiver]: msgId }
    const msgId = json.data?.msgInfo?.[receiver];
    return { ok: true, msgId };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Verify credentials by attempting to fetch an access token.
 * Returns the token on success (can be reused by the caller).
 */
export async function verifyCredentials(
  appKey: string,
  appSecret: string,
): Promise<{ ok: true; accessToken: string } | { ok: false; error: string }> {
  try {
    // Always fetch fresh token for verification
    const data = await fetchAccessToken(appKey, appSecret);
    // Warm the cache
    _tokenCache = { ...data, appKey };
    return { ok: true, accessToken: data.accessToken };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ── Notification ───────────────────────────────────────────────

/**
 * Send a bridge notification to a configured POPO email.
 * Called by bridge-manager after a message has been fully processed.
 * Fire-and-forget — caller should .catch() any thrown errors.
 *
 * @param notifyEmail   Destination email to notify
 * @param fromEmail     Email of the original message sender
 * @param userMessage   The user's original message text
 * @param claudeResponse  Claude's response text (optional — may be absent on error)
 */
export async function sendPopoNotification(params: {
  notifyEmail: string;
  fromEmail: string;
  userMessage: string;
  claudeResponse?: string;
}): Promise<void> {
  const appKey = getSetting('bridge_popo_app_key') || '';
  const appSecret = getSetting('bridge_popo_app_secret') || '';
  if (!appKey || !appSecret) return;

  const { notifyEmail, fromEmail, userMessage, claudeResponse } = params;

  // Build a concise notification message (POPO limit: 3000 chars)
  const msgSnippet = userMessage.length > 100
    ? userMessage.slice(0, 100) + '…'
    : userMessage;

  const replySnippet = claudeResponse
    ? (claudeResponse.length > 200 ? claudeResponse.slice(0, 200) + '…' : claudeResponse)
    : '（处理中或无回复）';

  const content = [
    `📬 Bridge 消息通知`,
    `来自：${fromEmail}`,
    `内容：${msgSnippet}`,
    ``,
    `Claude 回复：${replySnippet}`,
  ].join('\n');

  const token = await getAccessToken(appKey, appSecret);
  const result = await sendPopoMessage(token, notifyEmail, content);
  if (!result.ok) {
    console.warn(`[popo-api] Notification to ${notifyEmail} failed:`, result.error);
  }
}

