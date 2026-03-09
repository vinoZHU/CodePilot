/**
 * POST /api/notifications/popo
 *
 * Server-side relay: mirrors a CodePilot desktop notification to POPO.
 * Called fire-and-forget from notifications.ts (client-side) whenever
 * a system notification would be shown (completed / permissionRequired / error).
 *
 * Reads bridge_popo_notify_email from DB; no-ops if not configured.
 * Always returns 200 — failure must not break the caller.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSetting } from '@/lib/db';
import { getAccessToken, sendPopoMessage } from '@/lib/bridge/adapters/popo-api';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const { subtitle, body } = (await req.json()) as { subtitle?: string; body?: string };

    const notifyEmail = getSetting('bridge_popo_notify_email') || '';
    if (!notifyEmail) return NextResponse.json({ ok: true });

    const appKey    = getSetting('bridge_popo_app_key')    || '';
    const appSecret = getSetting('bridge_popo_app_secret') || '';
    if (!appKey || !appSecret) return NextResponse.json({ ok: true });

    // Format mirrors system notification: subtitle on first line, body below
    const content = [subtitle, body].filter(Boolean).join('\n');
    if (!content.trim()) return NextResponse.json({ ok: true });

    const token = await getAccessToken(appKey, appSecret);
    await sendPopoMessage(token, notifyEmail, content);
  } catch (err) {
    // Best-effort — log and swallow
    console.warn('[notifications/popo] Failed to send POPO notification:', err);
  }

  return NextResponse.json({ ok: true });
}
