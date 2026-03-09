/**
 * Desktop notification utility — client-side module.
 *
 * Sends macOS system notifications for key Claude Code events:
 *  • permission_request — tool execution approval required
 *  • completed          — assistant response finished
 *  • error              — non-abort error occurred
 *
 * Notification anatomy (macOS):
 *  ┌────────────────────────────────┐
 *  │ CodePilot           [app icon] │
 *  │ [subtitle] ← event type        │
 *  │ [body]     ← session + detail  │
 *  └────────────────────────────────┘
 *
 * Uses Electron's Notification API via IPC when running in Electron;
 * falls back to the Web Notification API in browser dev mode.
 */

import { translate, type Locale } from '@/i18n';

// ── Module-level state ──────────────────────────────────────────────────────

/** Current locale, synced from I18nProvider */
let _locale: Locale = 'zh';

/** Whether desktop notifications are enabled (from app settings) */
let _enabled = true;

// ── Public setters (called from React layer) ────────────────────────────────

export function setNotificationLocale(locale: Locale): void {
  _locale = locale;
}

export function setNotificationEnabled(enabled: boolean): void {
  _enabled = enabled;
}

// ── POPO notification relay ──────────────────────────────────────────────────

/**
 * Mirror a notification to POPO by calling the server-side relay endpoint.
 * Fire-and-forget — never throws, never blocks the caller.
 *
 * Skipped when the window is focused (same condition as desktop notifications).
 * The endpoint is a no-op when bridge_popo_notify_email is not configured.
 */
function sendPopoNotify(subtitle: string, body: string): void {
  // Don't notify when user is already looking at the app
  if (typeof document !== 'undefined' && !document.hidden && document.hasFocus()) return;

  fetch('/api/notifications/popo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subtitle, body }),
  }).catch(() => { /* silent — best-effort channel */ });
}

// ── Core send function ──────────────────────────────────────────────────────

/**
 * Send a desktop notification.
 *  - No-op if notifications are disabled by user settings.
 *  - No-op if the app window is currently focused (avoid interruption).
 *  - In Electron: uses electronAPI.notify() → main process Notification class.
 *    subtitle is shown under the title on macOS (native feature).
 *  - In browser dev mode: uses window.Notification if permission is granted.
 */
export function sendDesktopNotification(title: string, body: string, subtitle?: string): void {
  if (!_enabled) return;

  // Don't notify while the window has focus — user is already looking at it
  if (typeof document !== 'undefined' && !document.hidden && document.hasFocus()) return;

  // Electron path via IPC preload bridge
  const api = (window as {
    electronAPI?: { notify?: (t: string, b: string, s?: string) => void }
  }).electronAPI;
  if (api?.notify) {
    api.notify(title, body, subtitle);
    return;
  }

  // Browser dev-mode fallback (requires prior Notification.requestPermission)
  if (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    window.Notification.permission === 'granted'
  ) {
    // Web Notification API doesn't support subtitle — merge into body
    const fullBody = subtitle ? `${subtitle}\n${body}` : body;
    new window.Notification(title, { body: fullBody });
  }
}

// ── Context helpers ─────────────────────────────────────────────────────────

/**
 * Build the notification body line that shows session name and project.
 * Format: "「Session Title」· project-name"
 * Falls back gracefully when either field is missing.
 */
function buildContextLine(sessionTitle?: string, projectName?: string): string {
  const parts: string[] = [];
  if (sessionTitle) parts.push(`「${sessionTitle}」`);
  if (projectName) parts.push(projectName);
  return parts.join(' · ');
}

// ── Convenience helpers ─────────────────────────────────────────────────────

/**
 * Notify that Claude Code is waiting for tool permission approval.
 */
export function notifyPermissionRequired(
  toolName: string,
  sessionTitle?: string,
  projectName?: string,
): void {
  const subtitle = translate(_locale, 'notification.type.permissionRequired');
  const contextLine = buildContextLine(sessionTitle, projectName);
  const detail = translate(_locale, 'notification.permissionRequired.body', { tool: toolName });
  const body = contextLine ? `${contextLine}\n${detail}` : detail;

  sendDesktopNotification('CodePilot', body, subtitle);
  sendPopoNotify(subtitle, body);
}

/**
 * Notify that Claude Code has finished responding.
 */
export function notifyCompleted(
  preview?: string,
  sessionTitle?: string,
  projectName?: string,
): void {
  const subtitle = translate(_locale, 'notification.type.completed');
  const contextLine = buildContextLine(sessionTitle, projectName);

  let detail: string;
  if (preview) {
    const clean = preview.replace(/[#*`>_~\[\]]/g, '').replace(/\s+/g, ' ').trim();
    detail = clean.slice(0, 60) || translate(_locale, 'notification.completed.body');
  } else {
    detail = translate(_locale, 'notification.completed.body');
  }

  const body = contextLine ? `${contextLine}\n${detail}` : detail;
  sendDesktopNotification('CodePilot', body, subtitle);
  sendPopoNotify(subtitle, body);
}

/**
 * Notify that Claude Code encountered an error.
 */
export function notifyError(
  errMsg: string,
  sessionTitle?: string,
  projectName?: string,
): void {
  const subtitle = translate(_locale, 'notification.type.error');
  const contextLine = buildContextLine(sessionTitle, projectName);
  const detail = translate(_locale, 'notification.error.body', { error: errMsg.slice(0, 60) });
  const body = contextLine ? `${contextLine}\n${detail}` : detail;

  sendDesktopNotification('CodePilot', body, subtitle);
  sendPopoNotify(subtitle, body);
}
