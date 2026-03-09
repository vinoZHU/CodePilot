/**
 * Cloudflare Tunnel lifecycle API + internal IP detection.
 *
 * GET  /api/settings/popo/tunnel  — status + internalIp + tunnelUrl
 * POST /api/settings/popo/tunnel  — { action: 'start' | 'stop' }
 */

import { NextRequest, NextResponse } from 'next/server';
import os from 'os';
import {
  getTunnelStatus,
  startTunnel,
  stopTunnel,
} from '@/lib/tunnel/cloudflare-tunnel';

function getInternalIp(): string | null {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

function buildWebhookUrl(base: string): string {
  return `${base}/api/bridge/popo/webhook`;
}

export async function GET(): Promise<NextResponse> {
  const tunnel = getTunnelStatus();
  const internalIp = getInternalIp();
  const port = process.env.PORT || '3000';

  return NextResponse.json({
    tunnel,
    internalIp,
    internalWebhookUrl: internalIp
      ? buildWebhookUrl(`http://${internalIp}:${port}`)
      : null,
    tunnelWebhookUrl: tunnel.url
      ? buildWebhookUrl(tunnel.url)
      : null,
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { action } = body;
  const port = parseInt(process.env.PORT || '3000', 10);

  if (action === 'start') {
    const status = await startTunnel(port);
    const tunnelWebhookUrl = status.url ? buildWebhookUrl(status.url) : null;
    return NextResponse.json({ tunnel: status, tunnelWebhookUrl });
  }

  if (action === 'stop') {
    const status = stopTunnel();
    return NextResponse.json({ tunnel: status, tunnelWebhookUrl: null });
  }

  return NextResponse.json({ error: 'Invalid action. Use "start" or "stop".' }, { status: 400 });
}
