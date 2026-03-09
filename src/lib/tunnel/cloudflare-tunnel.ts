/**
 * Cloudflare Tunnel Manager — singleton process lifecycle.
 *
 * Uses `cloudflared tunnel --url http://localhost:<port>` (no account needed).
 * The temporary URL appears in the process stderr stream.
 *
 * Process lifecycle is tied to the Next.js server process.
 * HMR-safe: module-level state persists across hot reloads.
 */

import { spawn, type ChildProcess } from 'child_process';

// ── Types ──────────────────────────────────────────────────────

export type TunnelState = 'idle' | 'starting' | 'running' | 'stopped' | 'error';

export interface TunnelStatus {
  state: TunnelState;
  url: string | null;
  error: string | null;
}

// ── Module-level state (HMR-safe) ─────────────────────────────

let _process: ChildProcess | null = null;
let _state: TunnelState = 'idle';
let _url: string | null = null;
let _error: string | null = null;

// URL pattern emitted by cloudflared in stderr
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

// ── Public API ─────────────────────────────────────────────────

export function getTunnelStatus(): TunnelStatus {
  // If we have a process ref but it's exited, sync state
  if (_process && _process.exitCode !== null && _state === 'running') {
    _state = 'stopped';
  }
  return { state: _state, url: _url, error: _error };
}

/**
 * Start Cloudflare Tunnel pointing to localhost:<port>.
 * No-op if already starting or running.
 */
export async function startTunnel(port = 3000): Promise<TunnelStatus> {
  if (_state === 'starting' || _state === 'running') {
    return getTunnelStatus();
  }

  _state = 'starting';
  _url = null;
  _error = null;

  return new Promise((resolve) => {
    // Try npx cloudflared first; fallback gracefully if not installed
    const proc = spawn('npx', ['--yes', 'cloudflared', 'tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    _process = proc;

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();

      // cloudflared emits the tunnel URL to stderr
      const match = TUNNEL_URL_RE.exec(text);
      if (match && _state === 'starting') {
        _url = match[0];
        _state = 'running';
        resolve(getTunnelStatus());
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    proc.on('error', (err) => {
      _state = 'error';
      _error = `Failed to start cloudflared: ${err.message}`;
      _process = null;
      resolve(getTunnelStatus());
    });

    proc.on('exit', (code) => {
      if (_state === 'running') {
        _state = 'stopped';
      } else if (_state === 'starting') {
        _state = 'error';
        _error = `cloudflared exited during startup (code=${code})`;
      }
      _process = null;
      // Resolve in case we never got a URL
      resolve(getTunnelStatus());
    });

    // Timeout: if no URL within 30s, treat as error
    setTimeout(() => {
      if (_state === 'starting') {
        _state = 'error';
        _error = 'Timeout waiting for cloudflared tunnel URL (30s)';
        proc.kill();
        resolve(getTunnelStatus());
      }
    }, 30_000);
  });
}

/**
 * Stop the running tunnel process.
 */
export function stopTunnel(): TunnelStatus {
  if (_process) {
    try {
      _process.kill('SIGTERM');
    } catch {
      // already dead
    }
    _process = null;
  }
  _state = 'idle';
  _url = null;
  _error = null;
  return getTunnelStatus();
}
