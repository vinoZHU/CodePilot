/**
 * GET /api/chat/sessions/[id]/events
 *
 * Server-Sent Events (SSE) endpoint that pushes real-time bridge notifications
 * to the ChatView component watching a specific session.
 *
 * The bridge-manager calls notifyBridgeUpdate(sessionId) after processing
 * each inbound message, which triggers a "bridge-update" SSE event here.
 * ChatView subscribes via EventSource and refreshes its message list on receipt.
 */

import { NextRequest } from 'next/server';
import { subscribeBridgeEvents } from '@/lib/bridge/bridge-events';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sessionId } = await params;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send initial comment to establish connection
      controller.enqueue(encoder.encode(': connected\n\n'));

      // Subscribe to bridge events for this session
      const unsubscribe = subscribeBridgeEvents(sessionId, (event, data) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch {
          // Controller may be closed
        }
      });

      // Keepalive every 25s to prevent proxy timeouts
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          clearInterval(keepalive);
          unsubscribe();
        }
      }, 25_000);

      // Cleanup when client disconnects
      req.signal.addEventListener('abort', () => {
        clearInterval(keepalive);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable Nginx buffering
    },
  });
}
