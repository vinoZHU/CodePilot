/**
 * POPO Webhook Route — receives events pushed by POPO server.
 *
 * GET  /api/bridge/popo/webhook  — URL verification (save config in POPO dev console)
 * POST /api/bridge/popo/webhook  — event dispatch (user messages)
 *
 * Signature verification:
 *   SHA-256( sort([token, String(timestamp), nonce]).join('') ) === signature
 *   Note: values are sorted, NOT "key=value" pairs.
 *
 * GET response: return bare nonce string (no quotes, no JSON wrapping).
 *
 * AES decryption (when aes_key is configured):
 *   Key  = raw UTF-8 bytes of aesKey (POPO generates a 32-char ASCII key)
 *   Mode = AES-128-CBC (POPO splits the 32-byte key: key=keyRaw[0:16], iv=keyRaw[16:32])
 *   Also tries AES-256-CBC, AES-256-ECB, AES-128-ECB with multiple IV strategies as fallback
 *   setAutoPadding(false) — manual PKCS7 strip + WeChat-style prefix detection
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getSetting } from '@/lib/db';
import { getPopoAdapterInstance } from '@/lib/bridge/adapters/popo-adapter';
import type { InboundMessage } from '@/lib/bridge/types';

// ── Signature Helpers ──────────────────────────────────────────

function verifySignature(
  token: string,
  timestamp: string,
  nonce: string,
  signature: string,
): boolean {
  if (!token || !timestamp || !nonce || !signature) return false;
  // Sort [token, timestamp, nonce] by value, concatenate, SHA-256
  const hash = crypto
    .createHash('sha256')
    .update([token, timestamp, nonce].sort().join(''))
    .digest('hex');
  return hash === signature;
}

// ── AES Decryption ─────────────────────────────────────────────

/**
 * Try to find a JSON object in raw (already-decrypted, unpadded) bytes.
 * Handles: direct JSON, PKCS7-stripped JSON, WeChat/POPO-prefix JSON.
 */
function tryParseDecrypted(raw: Buffer): Record<string, unknown> | null {
  if (raw.length === 0) return null;

  // Build candidate payloads: try with PKCS7 padding stripped first, then raw
  const candidates: Buffer[] = [];
  const lastByte = raw[raw.length - 1];
  if (lastByte >= 1 && lastByte <= 16 && lastByte <= raw.length) {
    candidates.push(raw.slice(0, raw.length - lastByte)); // PKCS7-stripped
  }
  candidates.push(raw);

  for (const payload of candidates) {
    // WeChat/POPO style: random(16) + uint32BE(msgLen) + JSON + optional padding
    if (payload.length > 20) {
      try {
        const msgLen = payload.readUInt32BE(16);
        if (msgLen > 0 && 20 + msgLen <= payload.length) {
          const parsed = JSON.parse(payload.slice(20, 20 + msgLen).toString('utf-8'));
          if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
        }
      } catch { /* fall through */ }
    }
    // Direct JSON (strip trailing null bytes / whitespace first)
    try {
      const str = payload.toString('utf-8').replace(/\0+$/, '').trimEnd();
      const parsed = JSON.parse(str);
      if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
    } catch { /* fall through */ }
  }

  return null;
}

/**
 * Attempt one AES decryption (any mode/key-size) with setAutoPadding(false).
 * Returns parsed JSON object, or null on any failure.
 * Logs first 32 raw bytes as hex on parse failure for diagnostics.
 */
function tryAesDecrypt(
  algorithm: string,
  ciphertext: Buffer,
  key: Buffer,
  iv: Buffer,
  label: string,
): Record<string, unknown> | null {
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) return null;
  try {
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    decipher.setAutoPadding(false); // manual padding — avoids spurious "bad decrypt" errors
    const raw = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const result = tryParseDecrypted(raw);
    if (result) {
      console.log(`[popo-webhook] Decrypt OK: ${label}`);
      return result;
    }
    // Diagnostic: show first 32 raw bytes so we can spot "close but wrong parse" cases
    console.log(`[popo-webhook] ${label}: parse fail, raw[0..32]=${raw.slice(0, 32).toString('hex')}`);
    return null;
  } catch (e) {
    console.log(`[popo-webhook] ${label} error: ${String(e).slice(0, 80)}`);
    return null;
  }
}

/**
 * Decrypt AES-encrypted body from POPO using exhaustive key/IV/mode strategies.
 *
 * POPO auto-generates a 32-char ASCII key (not base64-encoded).
 * Key  = raw UTF-8 bytes of the key string
 * Mode = AES-256-CBC, AES-128-CBC, AES-256-ECB, AES-128-ECB
 * IV   = exhaustively try: IV-prepended, zero bytes, key[0:16], MD5(key)
 */
function decryptAesBody(encryptedBase64: string, aesKey: string): Record<string, unknown> | null {
  // Build key buffer (POPO uses raw ASCII, not base64)
  let keyRaw: Buffer;
  if (aesKey.length === 16 || aesKey.length === 24 || aesKey.length === 32) {
    keyRaw = Buffer.from(aesKey, 'utf-8');
  } else {
    const padded = aesKey + '='.repeat((4 - aesKey.length % 4) % 4);
    keyRaw = Buffer.from(padded, 'base64');
  }
  if (keyRaw.length < 16) {
    console.error('[popo-webhook] AES key too short:', keyRaw.length, 'bytes');
    return null;
  }

  const key128 = keyRaw.slice(0, 16);
  const key256 = keyRaw.length >= 32
    ? keyRaw.slice(0, 32)
    : Buffer.concat([keyRaw, Buffer.alloc(32 - keyRaw.length)]);

  const encBuf = Buffer.from(encryptedBase64, 'base64');
  console.log(
    `[popo-webhook] Decrypt: encBuf=${encBuf.length}B b64len=${encryptedBase64.length} ` +
    `key="${aesKey.slice(0, 4)}...${aesKey.slice(-4)}"(${aesKey.length}c)`,
  );

  const zeroIV  = Buffer.alloc(16, 0);
  const md5IV   = crypto.createHash('md5').update(keyRaw).digest(); // 16 bytes
  const emptyIV = Buffer.alloc(0);                                  // ECB needs empty IV

  // key-split IV: POPO splits the 32-byte key — first 16B = AES-128 key, last 16B = IV
  const keySplitIV = keyRaw.length >= 32 ? keyRaw.slice(16, 32) : null;

  // IV-prepended: treat first 16 bytes of encBuf as IV, rest as ciphertext
  const hasPrepend = encBuf.length > 16;
  const prependIV  = hasPrepend ? encBuf.slice(0, 16) : zeroIV;
  const restBuf    = hasPrepend ? encBuf.slice(16) : encBuf;

  type S = [string, Buffer, Buffer, Buffer, string]; // [algo, key, iv, ciphertext, label]
  const strategies: S[] = [
    // ── AES-128-CBC / key-split (POPO: key=keyRaw[0:16], iv=keyRaw[16:32]) ──
    ...(keySplitIV
      ? [['aes-128-cbc', key128, keySplitIV, encBuf, 'AES-128-CBC/key-split-IV']] as S[]
      : []),
    // ── AES-256-CBC ──────────────────────────────────────────────────────
    ...(hasPrepend
      ? [['aes-256-cbc', key256, prependIV, restBuf, 'AES-256-CBC/IV-prepended']] as S[]
      : []),
    ['aes-256-cbc', key256, zeroIV,             encBuf, 'AES-256-CBC/zero-IV'],
    ['aes-256-cbc', key256, key256.slice(0, 16), encBuf, 'AES-256-CBC/key-IV'],
    ['aes-256-cbc', key256, key256.slice(16, 32), encBuf, 'AES-256-CBC/key-split-IV'],
    ['aes-256-cbc', key256, md5IV,               encBuf, 'AES-256-CBC/md5-IV'],
    // ── AES-128-CBC ──────────────────────────────────────────────────────
    ...(hasPrepend
      ? [['aes-128-cbc', key128, prependIV, restBuf, 'AES-128-CBC/IV-prepended']] as S[]
      : []),
    ['aes-128-cbc', key128, zeroIV,  encBuf, 'AES-128-CBC/zero-IV'],
    ['aes-128-cbc', key128, key128,  encBuf, 'AES-128-CBC/key-IV'],
    ['aes-128-cbc', key128, md5IV,   encBuf, 'AES-128-CBC/md5-IV'],
    // ── ECB (no IV) ───────────────────────────────────────────────────────
    ['aes-256-ecb', key256, emptyIV, encBuf, 'AES-256-ECB'],
    ['aes-128-ecb', key128, emptyIV, encBuf, 'AES-128-ECB'],
  ];

  for (const [algo, key, iv, ct, label] of strategies) {
    const result = tryAesDecrypt(algo, ct, key, iv, label);
    if (result) return result;
  }

  return null;
}

// ── GET — URL verification ─────────────────────────────────────

export async function GET(req: NextRequest): Promise<Response> {
  const token = getSetting('bridge_popo_webhook_token') || '';
  const { searchParams } = req.nextUrl;

  const signature = searchParams.get('signature') || '';
  const timestamp = searchParams.get('timestamp') || '';
  const nonce = searchParams.get('nonce') || '';

  if (!verifySignature(token, timestamp, nonce, signature)) {
    return new Response('Invalid signature', { status: 401 });
  }

  // POPO requires the raw nonce string as response body (no JSON, no quotes)
  return new Response(nonce, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

// ── POST — event dispatch ──────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const token = getSetting('bridge_popo_webhook_token') || '';
  const aesKey = getSetting('bridge_popo_aes_key') || '';
  const { searchParams } = req.nextUrl;

  const signature = searchParams.get('signature') || '';
  const timestamp = searchParams.get('timestamp') || '';
  const nonce = searchParams.get('nonce') || '';

  if (!verifySignature(token, timestamp, nonce, signature)) {
    console.warn('[popo-webhook] Signature mismatch — check token setting');
    return NextResponse.json({ ok: false, error: 'Invalid signature' }, { status: 401 });
  }

  // ── Read raw body text (never fail with 400 — POPO would retry endlessly) ──
  let rawText: string;
  try {
    rawText = await req.text();
  } catch {
    console.error('[popo-webhook] Failed to read request body');
    return NextResponse.json({ ok: true });
  }

  // ── Parse body: JSON → AES decrypt if needed; or raw encrypted blob ───────
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;

    if (aesKey && typeof parsed.encrypt === 'string') {
      // POPO sent AES-encrypted message wrapped in JSON {encrypt: "..."}
      console.log('[popo-webhook] AES-encrypted JSON body, decrypting...');
      const decrypted = decryptAesBody(parsed.encrypt, aesKey);
      if (!decrypted) {
        console.error('[popo-webhook] AES decrypt failed. encrypt (first 60):', parsed.encrypt.toString().slice(0, 60));
        // Return 200 to prevent POPO retries; fix key/format and restart bridge
        return NextResponse.json({ ok: true });
      }
      body = decrypted;
    } else {
      body = parsed;
    }
  } catch {
    // Body is not valid JSON — POPO may send raw base64 AES blob when encryption enabled
    console.warn('[popo-webhook] Body is not JSON. Raw (first 200):', rawText.slice(0, 200));
    if (aesKey && rawText.trim()) {
      const decrypted = decryptAesBody(rawText.trim(), aesKey);
      if (decrypted) {
        body = decrypted;
      } else {
        console.error('[popo-webhook] Raw body AES decrypt also failed. Body type may be unsupported.');
        return NextResponse.json({ ok: true });
      }
    } else {
      return NextResponse.json({ ok: true });
    }
  }

  const eventType = body.eventType as string | undefined;
  console.log('[popo-webhook] Event received:', eventType, JSON.stringify(body).slice(0, 300));

  // URL verification event (sent when saving webhook config in POPO console)
  if (eventType === 'valid_url') {
    return NextResponse.json({ ok: true });
  }

  // Only handle incoming message events
  const SUPPORTED_EVENTS = [
    'IM_P2P_TO_ROBOT_MSG',       // User → Robot P2P
    'IM_CHAT_TO_ROBOT_AT_MSG',   // User @Robot in group
  ];

  if (!eventType || !SUPPORTED_EVENTS.includes(eventType)) {
    // Acknowledge silently for unsupported events (recall, etc.)
    return NextResponse.json({ ok: true });
  }

  const adapter = getPopoAdapterInstance();
  if (!adapter) {
    console.warn('[popo-webhook] Adapter instance is null — bridge may not have been started yet');
    return NextResponse.json({ ok: true });
  }
  if (!adapter.isRunning()) {
    console.warn('[popo-webhook] Adapter exists but isRunning()=false — bridge may be stopped');
    return NextResponse.json({ ok: true });
  }

  // Parse event data
  // POPO MsgDTO fields: from, to, notify, sessionId, uuid, addtime, msgType, sessionType
  const data = (body.eventData ?? body) as Record<string, unknown>;
  const from = (data.from as string) || '';          // sender email
  const notify = (data.notify as string) || '';      // message text content
  const uuid = (data.uuid as string) || '';           // message ID
  const sessionId = (data.sessionId as string) || '';
  const addtime = (data.addtime as string) || '';
  const msgType = (data.msgType as number) || 1;
  const sessionType = (data.sessionType as number) || 1; // 1=P2P, 3=Group

  // Skip non-text messages (files, videos, etc.)
  if (msgType !== 1 && msgType !== 211) {
    return NextResponse.json({ ok: true });
  }

  // Skip empty messages
  const text = notify.trim();
  if (!text) {
    return NextResponse.json({ ok: true });
  }

  // Determine chatId: P2P = sender email, Group = sessionId (group number)
  const isGroup = sessionType === 3 || eventType === 'IM_CHAT_TO_ROBOT_AT_MSG';
  const chatId = isGroup ? sessionId : from;

  const msg: InboundMessage = {
    messageId: uuid || `${from}-${Date.now()}`,
    address: {
      channelType: 'popo',
      chatId,
      userId: from,
      displayName: from,
    },
    text,
    timestamp: addtime ? parseInt(addtime, 10) : Date.now(),
    raw: body,
  };

  adapter.injectWebhookMessage(msg);

  return NextResponse.json({ ok: true });
}
