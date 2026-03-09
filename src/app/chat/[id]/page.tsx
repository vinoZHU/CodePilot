'use client';

import { useEffect, useState, useRef, useCallback, use } from 'react';
import Link from 'next/link';
import type { Message, MessagesResponse, ChatSession } from '@/types';
import { ChatView } from '@/components/chat/ChatView';
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon, PencilEdit01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePanel } from '@/hooks/usePanel';
import { useTranslation } from '@/hooks/useTranslation';
import { getCachedSession } from '@/lib/session-cache';
import { getCachedMessages, setCachedMessages } from '@/lib/message-cache';

interface ChatSessionPageProps {
  params: Promise<{ id: string }>;
}

/** Apply session metadata to local state + panel context */
function applySessionData(
  session: ChatSession,
  id: string,
  fallbackTitle: string,
  ops: {
    setWorkingDirectory: (d: string) => void;
    setSessionWorkingDir: (d: string) => void;
    setSessionId: (d: string) => void;
    setPanelOpen: (d: boolean) => void;
    setSessionTitle: (d: string) => void;
    setPanelSessionTitle: (d: string) => void;
    setSessionModel: (d: string) => void;
    setSessionProviderId: (d: string) => void;
    setSessionMode: (d: string) => void;
    setSessionPermissionProfile: (d: 'default' | 'full_access') => void;
    setProjectName: (d: string) => void;
  },
  dispatchFileTree = false,
) {
  if (session.working_directory) {
    ops.setWorkingDirectory(session.working_directory);
    ops.setSessionWorkingDir(session.working_directory);
    localStorage.setItem('codepilot:last-working-directory', session.working_directory);
    if (dispatchFileTree) window.dispatchEvent(new Event('refresh-file-tree'));
  }
  ops.setSessionId(id);
  ops.setPanelOpen(true);
  const title = session.title || fallbackTitle;
  ops.setSessionTitle(title);
  ops.setPanelSessionTitle(title);
  ops.setSessionModel(session.model || '');
  ops.setSessionProviderId(session.provider_id || '');
  ops.setSessionMode(session.mode || 'code');
  ops.setSessionPermissionProfile(session.permission_profile || 'default');
  ops.setProjectName(session.project_name || '');
}

export default function ChatSessionPage({ params }: ChatSessionPageProps) {
  const { id } = use(params);

  // ── initialise from cache (synchronous, no flicker) ──────────────────────
  const cachedSession = getCachedSession(id);
  const cachedMsgs    = getCachedMessages(id);

  const [messages, setMessages]   = useState<Message[]>(cachedMsgs?.messages ?? []);
  const [hasMore, setHasMore]     = useState(cachedMsgs?.hasMore ?? false);
  // Show spinner only when we have no cached messages at all
  const [loading, setLoading]     = useState(!cachedMsgs);
  const [error, setError]         = useState<string | null>(null);

  const [sessionTitle, setSessionTitle]   = useState<string>(cachedSession?.title ?? '');
  const [sessionModel, setSessionModel]   = useState<string>(cachedSession?.model ?? '');
  const [sessionProviderId, setSessionProviderId] = useState<string>(cachedSession?.provider_id ?? '');
  const [sessionMode, setSessionMode]     = useState<string>(cachedSession?.mode ?? 'code');
  const [sessionPermissionProfile, setSessionPermissionProfile] =
    useState<'default' | 'full_access'>(cachedSession?.permission_profile ?? 'default');
  const [projectName, setProjectName]     = useState<string>(cachedSession?.project_name ?? '');
  const [sessionWorkingDir, setSessionWorkingDir] = useState<string>(cachedSession?.working_directory ?? '');

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle]           = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);
  const { setWorkingDirectory, setSessionId, setSessionTitle: setPanelSessionTitle, setPanelOpen } = usePanel();
  const { t } = useTranslation();

  // Manual refresh — ChatView registers its refresh fn via onRefreshReady
  const chatRefreshRef = useRef<(() => Promise<void>) | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    if (!chatRefreshRef.current || isRefreshing) return;
    setIsRefreshing(true);
    try {
      await chatRefreshRef.current();
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing]);

  const handleRefreshReady = useCallback((fn: () => Promise<void>) => {
    chatRefreshRef.current = fn;
  }, []);

  const handleStartEditTitle = useCallback(() => {
    setEditTitle(sessionTitle || t('chat.newConversation'));
    setIsEditingTitle(true);
  }, [sessionTitle, t]);

  const handleSaveTitle = useCallback(async () => {
    const trimmed = editTitle.trim();
    if (!trimmed) {
      setIsEditingTitle(false);
      return;
    }
    try {
      const res = await fetch(`/api/chat/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      });
      if (res.ok) {
        setSessionTitle(trimmed);
        setPanelSessionTitle(trimmed);
        window.dispatchEvent(new CustomEvent('session-updated', { detail: { id, title: trimmed } }));
      }
    } catch {
      // silently fail
    }
    setIsEditingTitle(false);
  }, [editTitle, id, setPanelSessionTitle]);

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveTitle();
    } else if (e.key === 'Escape') {
      setIsEditingTitle(false);
    }
  }, [handleSaveTitle]);

  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  // ── Session metadata: apply cache immediately, then refresh in background ─
  useEffect(() => {
    let cancelled = false;

    // If cached, apply immediately (synchronous side-effects for panel/context)
    const cached = getCachedSession(id);
    if (cached) {
      applySessionData(cached, id, t('chat.newConversation'), {
        setWorkingDirectory,
        setSessionWorkingDir,
        setSessionId,
        setPanelOpen,
        setSessionTitle,
        setPanelSessionTitle,
        setSessionModel,
        setSessionProviderId,
        setSessionMode,
        setSessionPermissionProfile,
        setProjectName,
      }, /* dispatchFileTree */ true);
    }

    // Always do a background refresh to pick up server-side changes
    async function loadSession() {
      try {
        const res = await fetch(`/api/chat/sessions/${id}`);
        if (cancelled || !res.ok) return;
        const data: { session: ChatSession } = await res.json();
        if (cancelled) return;
        applySessionData(data.session, id, t('chat.newConversation'), {
          setWorkingDirectory,
          setSessionWorkingDir,
          setSessionId,
          setPanelOpen,
          setSessionTitle,
          setPanelSessionTitle,
          setSessionModel,
          setSessionProviderId,
          setSessionMode,
          setSessionPermissionProfile,
          setProjectName,
        }, /* dispatchFileTree */ !cached /* only dispatch if wasn't already set */);
      } catch {
        // Session info load failed — panel will still work without directory
      }
    }

    loadSession();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ── Messages: apply cache immediately, always refresh in background ───────
  useEffect(() => {
    let cancelled = false;

    // Apply cached messages straight away (eliminates the spinner on repeat visits)
    const cached = getCachedMessages(id);
    if (cached) {
      setMessages(cached.messages);
      setHasMore(cached.hasMore);
      setLoading(false);
      setError(null);
    } else {
      // No cache → show the loading spinner
      setLoading(true);
      setError(null);
      setMessages([]);
      setHasMore(false);
    }

    async function loadMessages() {
      try {
        const res = await fetch(`/api/chat/sessions/${id}/messages?limit=30`);
        if (cancelled) return;
        if (!res.ok) {
          if (res.status === 404) {
            if (!cancelled) setError('Session not found');
            return;
          }
          throw new Error('Failed to load messages');
        }
        const data: MessagesResponse = await res.json();
        if (cancelled) return;
        // Populate / refresh the module-level cache
        setCachedMessages(id, data.messages, data.hasMore ?? false);
        setMessages(data.messages);
        setHasMore(data.hasMore ?? false);
      } catch (err) {
        if (cancelled) return;
        // Only show an error if we have no cached data to fall back on
        if (!getCachedMessages(id)) {
          setError(err instanceof Error ? err.message : 'Failed to load messages');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadMessages();

    return () => { cancelled = true; };
  }, [id]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <HugeiconsIcon icon={Loading02Icon} className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center space-y-2">
          <p className="text-destructive font-medium">{error}</p>
          <Link href="/chat" className="text-sm text-muted-foreground hover:underline">
            Start a new chat
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Chat title bar */}
      {sessionTitle && (
        <div
          className="flex h-12 shrink-0 items-center px-4"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          {/* Left spacer — mirrors the right refresh button width to keep title centered */}
          <div className="w-6 shrink-0" />

          {/* Center: project / title / edit */}
          <div className="flex flex-1 items-center justify-center gap-1 min-w-0">
            {projectName && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className="text-xs text-muted-foreground shrink-0 hover:text-foreground transition-colors cursor-pointer"
                      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                      onClick={() => {
                        if (sessionWorkingDir) {
                          if (window.electronAPI?.shell?.openPath) {
                            window.electronAPI.shell.openPath(sessionWorkingDir);
                          } else {
                            fetch('/api/files/open', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ path: sessionWorkingDir }),
                            }).catch(() => {});
                          }
                        }
                      }}
                    >
                      {projectName}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs break-all">{sessionWorkingDir || projectName}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Click to open in Finder</p>
                  </TooltipContent>
                </Tooltip>
                <span className="text-xs text-muted-foreground shrink-0">/</span>
              </>
            )}
            {isEditingTitle ? (
              <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                <Input
                  ref={titleInputRef}
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={handleTitleKeyDown}
                  onBlur={handleSaveTitle}
                  className="h-7 text-sm max-w-md text-center"
                />
              </div>
            ) : (
              <div
                className="flex items-center gap-1 group cursor-default max-w-md"
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              >
                <h2 className="text-sm font-medium text-foreground/80 truncate">
                  {sessionTitle}
                </h2>
                <button
                  onClick={handleStartEditTitle}
                  className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 p-0.5 rounded hover:bg-muted"
                >
                  <HugeiconsIcon icon={PencilEdit01Icon} className="h-3 w-3 text-muted-foreground" />
                </button>
              </div>
            )}
          </div>

          {/* Right: refresh button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleRefresh}
                disabled={isRefreshing}
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                className="w-6 h-6 shrink-0 flex items-center justify-center rounded hover:bg-muted transition-colors disabled:opacity-50"
              >
                <HugeiconsIcon
                  icon={isRefreshing ? Loading02Icon : RefreshIcon}
                  className={`h-3.5 w-3.5 text-muted-foreground ${isRefreshing ? 'animate-spin' : ''}`}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">刷新消息</p>
            </TooltipContent>
          </Tooltip>
        </div>
      )}
      <ChatView
        key={id}
        sessionId={id}
        initialMessages={messages}
        initialHasMore={hasMore}
        modelName={sessionModel}
        initialMode={sessionMode}
        providerId={sessionProviderId}
        initialPermissionProfile={sessionPermissionProfile}
        sessionTitle={sessionTitle}
        projectName={projectName}
        onRefreshReady={handleRefreshReady}
      />
    </div>
  );
}
