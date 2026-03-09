/**
 * POPO Settings API — GET/PUT for configuration keys.
 *
 * GET  /api/settings/popo  — read all POPO settings (app_secret masked)
 * PUT  /api/settings/popo  — write POPO settings (masked secret skipped)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSetting, setSetting } from '@/lib/db';

const POPO_KEYS = [
  'bridge_popo_enabled',
  'bridge_popo_app_key',
  'bridge_popo_app_secret',
  'bridge_popo_robot_email',
  'bridge_popo_webhook_token',
  'bridge_popo_aes_key',
  'bridge_popo_allowed_users',
  'bridge_popo_notify_email',
] as const;

type PopoKey = (typeof POPO_KEYS)[number];

export async function GET(): Promise<NextResponse> {
  const result: Record<string, string> = {};
  for (const key of POPO_KEYS) {
    const value = getSetting(key) || '';
    // Mask app_secret: show only last 8 chars
    if (key === 'bridge_popo_app_secret' && value.length > 8) {
      result[key] = '***' + value.slice(-8);
    // Mask aes_key: show only last 8 chars
    } else if (key === 'bridge_popo_aes_key' && value.length > 8) {
      result[key] = '***' + value.slice(-8);
    } else {
      result[key] = value;
    }
  }
  return NextResponse.json({ settings: result });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const settings = (body.settings ?? body) as Record<string, unknown>;

  for (const key of POPO_KEYS) {
    if (!(key in settings)) continue;
    const strValue = String(settings[key] ?? '');

    // Skip masked secrets — don't overwrite the real stored value
    if (key === 'bridge_popo_app_secret' && strValue.startsWith('***')) {
      continue;
    }
    if (key === 'bridge_popo_aes_key' && strValue.startsWith('***')) {
      continue;
    }

    setSetting(key, strValue);
  }

  return NextResponse.json({ ok: true });
}
