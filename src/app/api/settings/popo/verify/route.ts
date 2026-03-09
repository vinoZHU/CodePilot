/**
 * POPO credentials verification.
 * Calls the POPO token API with provided credentials.
 *
 * POST /api/settings/popo/verify
 * Body: { app_key: string; app_secret: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSetting } from '@/lib/db';
import { verifyCredentials, clearTokenCache } from '@/lib/bridge/adapters/popo-api';

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { app_key?: string; app_secret?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  let { app_key = '', app_secret = '' } = body;

  // If secret is masked (UI didn't change it), load from DB
  if (!app_secret || app_secret.startsWith('***')) {
    app_secret = getSetting('bridge_popo_app_secret') || '';
  }
  if (!app_key) {
    app_key = getSetting('bridge_popo_app_key') || '';
  }

  if (!app_key || !app_secret) {
    return NextResponse.json(
      { verified: false, error: 'App Key 和 App Secret 不能为空' },
      { status: 400 },
    );
  }

  // Clear cache so we get a fresh token
  clearTokenCache();

  const result = await verifyCredentials(app_key, app_secret);

  if (result.ok) {
    return NextResponse.json({ verified: true });
  } else {
    return NextResponse.json({ verified: false, error: result.error });
  }
}
