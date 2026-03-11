'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import type { Message, MessagesResponse, FileAttachment, SessionStreamSnapshot } from '@/types';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { ChatComposerActionBar } from './ChatComposerActionBar';
import { ChatPermissionSelector } from './ChatPermissionSelector';
import { ContextUsageIndicator } from './ContextUsageIndicator';
import { ImageGenToggle } from './ImageGenToggle';
import { usePanel } from '@/hooks/usePanel';
import { useTranslation } from '@/hooks/useTranslation';
import { PermissionPrompt } from './PermissionPrompt';
import { BatchExecutionDashboard, BatchContextSync } from './batch-image-gen';
import { setLastGeneratedImages, transferPendingToMessage } from '@/lib/image-ref-store';
import {
  startStream,
  stopStream,
  subscribe,
  getSnapshot,
  getRewindPoints,
  respondToPermission,
  clearSnapshot,
} from '@/lib/stream-session-manager';
import { setCachedMessages, invalidateCachedMessages } from '@/lib/message-cache';

interface ChatViewProps {
  sessionId: string;
  initialMessages?: Message[];
  initialHasMore?: boolean;
  modelName?: string;
  initialMode?: string;
  providerId?: string;
  initialPermissionProfile?: 'default' | 'full_access';
  /** Session title for desktop notifications */
  sessionTitle?: string;
  /** Project/folder name for desktop notifications */
  projectName?: string;
  /** Called once (and on session change) with a stable refresh function the parent can invoke */
  onRefreshReady?: (fn: () => Promise<void>) => void;
}

export function ChatView({ sessionId, initialMessages = [], initialHasMore = false, modelName, initialMode, providerId, initialPermissionProfile, sessionTitle, projectName, onRefreshReady }: ChatViewProps) {
  const { setStreamingSessionId, workingDirectory, setWorkingDirectory, setPanelOpen, setPendingApprovalSessionId } = usePanel();
  const { t } = useTranslation();
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [permissionProfile, setPermissionProfile] = useState<'default' | 'full_access'>(initialPermissionProfile || 'default');

  // Workspace mismatch banner state
  const [workspaceMismatchPath, setWorkspaceMismatchPath] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [mode, setMode] = useState(initialMode || 'code');
  const [currentModel, setCurrentModel] = useState(modelName || (typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-model') : null) || 'sonnet');
  const [currentProviderId, setCurrentProviderId] = useState(providerId || (typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-provider-id') : null) || '');
  // Effort level selected in MessageInput — lifted here so it enters the stream chain
  const [selectedEffort, setSelectedEffort] = useState<string | undefined>(undefined);
  // Thinking mode from app settings
  const [thinkingMode, setThinkingMode] = useState<string>('adaptive');

  // Sync model/provider when session data loads (props update after async fetch)
  // Unconditional: when modelName is empty (old session with no saved model),
  // fall back to localStorage or default to avoid stale values from previous session.
  useEffect(() => {
    setCurrentModel(modelName || (typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-model') : null) || 'sonnet');
  }, [modelName]);
  useEffect(() => {
    setCurrentProviderId(providerId || (typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-provider-id') : null) || '');
  }, [providerId]);

  // Fetch thinking mode from app settings
  useEffect(() => {
    fetch('/api/settings/app')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.settings?.thinking_mode) {
          setThinkingMode(data.settings.thinking_mode);
        }
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (initialPermissionProfile) {
      setPermissionProfile(initialPermissionProfile);
    }
  }, [initialPermissionProfile]);

  // Stream snapshot from the manager — drives all streaming UI
  const [streamSnapshot, setStreamSnapshot] = useState<SessionStreamSnapshot | null>(
    () => getSnapshot(sessionId)
  );

  // Derive rendering state from snapshot (backward-compatible with MessageList props)
  const isStreaming = streamSnapshot?.phase === 'active';
  const streamingContent = streamSnapshot?.streamingContent ?? '';
  const toolUses = streamSnapshot?.toolUses ?? [];
  const toolResults = streamSnapshot?.toolResults ?? [];
  const streamingToolOutput = streamSnapshot?.streamingToolOutput ?? '';
  const statusText = streamSnapshot?.statusText;
  const pendingPermission = streamSnapshot?.pendingPermission ?? null;
  const permissionResolved = streamSnapshot?.permissionResolved ?? null;
  const agentCalls = streamSnapshot?.agentCalls;
  const thinkingContent = streamSnapshot?.thinkingContent;
  const startedAt = streamSnapshot?.startedAt;
  const rewindPoints = getRewindPoints(sessionId);

  // Pending image generation notices — flushed into the next user message so the LLM knows about generated images
  const pendingImageNoticesRef = useRef<string[]>([]);
  // Ref for sendMessage to allow self-referencing in timeout auto-retry
  const sendMessageRef = useRef<(content: string, files?: FileAttachment[]) => Promise<void>>(undefined);

  const handleModeChange = useCallback((newMode: string) => {
    setMode(newMode);
    // Persist mode to database and notify chat list
    if (sessionId) {
      fetch(`/api/chat/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode }),
      }).then(() => {
        window.dispatchEvent(new CustomEvent('session-updated'));
      }).catch(() => { /* silent */ });

      // Try to switch SDK permission mode in real-time (works if streaming)
      fetch('/api/chat/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, mode: newMode }),
      }).catch(() => { /* silent — will apply on next message */ });
    }
  }, [sessionId]);

  const handleProviderModelChange = useCallback((newProviderId: string, model: string) => {
    setCurrentProviderId(newProviderId);
    setCurrentModel(model);
    // Persist immediately so switching chats preserves the selection
    fetch(`/api/chat/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, provider_id: newProviderId }),
    }).catch(() => {});
  }, [sessionId]);

  // Subscribe to bridge SSE events — refreshes messages when bridge processes
  // an inbound POPO/Telegram/etc. message for this session.
  // Uses EventSource so the UI updates as soon as bridge finishes, without polling.
  useEffect(() => {
    if (!sessionId) return;

    const es = new EventSource(`/api/chat/sessions/${sessionId}/events`);

    es.addEventListener('bridge-update', () => {
      // Re-fetch latest messages from DB so bridge responses appear immediately
      fetch(`/api/chat/sessions/${sessionId}/messages?limit=50`)
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data?.messages && data.messages.length > 0) {
            setMessages(data.messages);
          }
        })
        .catch(() => { /* silent — keep existing messages */ });
    });

    es.onerror = () => {
      // EventSource will auto-reconnect; no action needed
    };

    return () => es.close();
  }, [sessionId]);

  // Subscribe to stream-session-manager for this session.
  // On unmount we only unsubscribe — we do NOT abort the stream.
  useEffect(() => {
    // Restore snapshot if stream is already active (e.g., user switched away and back)
    const existing = getSnapshot(sessionId);
    if (existing) {
      setStreamSnapshot(existing);
      if (existing.phase === 'active') {
        setStreamingSessionId(sessionId);
      }
      if (existing.pendingPermission && !existing.permissionResolved) {
        setPendingApprovalSessionId(sessionId);
      }
      // If stream completed while this ChatView was unmounted, consume finalMessageContent now.
      // Re-fetch messages from DB to avoid duplicates (backend already persisted the reply).
      if (existing.phase !== 'active' && existing.finalMessageContent) {
        detectAssistantCompletion(existing.finalMessageContent);
        fetch(`/api/chat/sessions/${sessionId}/messages?limit=50`)
          .then(res => res.ok ? res.json() : null)
          .then(data => {
            if (data?.messages) {
              setMessages(data.messages);
            }
          })
          .catch(() => {
            // Fallback: append locally if DB fetch fails
            const assistantMessage: Message = {
              id: 'temp-assistant-' + Date.now(),
              session_id: sessionId,
              role: 'assistant',
              content: existing.finalMessageContent!,
              created_at: new Date().toISOString(),
              token_usage: existing.tokenUsage ? JSON.stringify(existing.tokenUsage) : null,
            };
            transferPendingToMessage(assistantMessage.id);
            setMessages((prev) => [...prev, assistantMessage]);
          });
        clearSnapshot(sessionId);
      }
    } else {
      setStreamSnapshot(null);
    }

    const unsubscribe = subscribe(sessionId, (event) => {
      setStreamSnapshot(event.snapshot);

      // Sync panel state
      if (event.type === 'phase-changed') {
        if (event.snapshot.phase === 'active') {
          setStreamingSessionId(sessionId);
        } else {
          setStreamingSessionId('');
          setPendingApprovalSessionId('');
        }
      }
      if (event.type === 'permission-request') {
        setPendingApprovalSessionId(sessionId);
      }
      if (event.type === 'completed') {
        setStreamingSessionId('');
        setPendingApprovalSessionId('');

        // Append the final assistant message to the messages list
        const finalContent = event.snapshot.finalMessageContent;
        if (finalContent) {
          // Check for assistant project completion signals
          detectAssistantCompletion(finalContent);

          const assistantMessage: Message = {
            id: 'temp-assistant-' + Date.now(),
            session_id: sessionId,
            role: 'assistant',
            content: finalContent,
            created_at: new Date().toISOString(),
            token_usage: event.snapshot.tokenUsage ? JSON.stringify(event.snapshot.tokenUsage) : null,
          };
          // Transfer pending reference images to this message ID
          transferPendingToMessage(assistantMessage.id);
          setMessages((prev) => [...prev, assistantMessage]);
        }

        // Clear the snapshot from the manager since we've consumed it
        clearSnapshot(sessionId);
      }
    });

    return () => {
      unsubscribe();
      // Do NOT abort — stream continues in the manager
    };
  }, [sessionId, setStreamingSessionId, setPendingApprovalSessionId]);

  const initializedRef = useRef(false);
  useEffect(() => {
    if (initialMessages.length > 0 && !initializedRef.current) {
      initializedRef.current = true;
      setMessages(initialMessages);
    }
  }, [initialMessages]);

  // Sync messages → cache whenever message list changes.
  // Note: no isStreaming guard needed — during streaming, messages array does not
  // change (streaming content lives in streamSnapshot, not messages). Messages
  // only change on send (adds user msg) or on stream completion (adds assistant msg).
  useEffect(() => {
    if (messages.length > 0) {
      setCachedMessages(sessionId, messages, hasMore);
    }
  }, [sessionId, messages, hasMore]);

  // Manual refresh: re-fetch latest messages from server and update cache.
  const refreshMessages = useCallback(async () => {
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}/messages?limit=50`);
      if (!res.ok) return;
      const data: MessagesResponse = await res.json();
      setCachedMessages(sessionId, data.messages, data.hasMore ?? false);
      setMessages(data.messages);
      setHasMore(data.hasMore ?? false);
    } catch {
      // silent
    }
  }, [sessionId]);

  // Register refresh function with parent once (and whenever session changes).
  useEffect(() => {
    onRefreshReady?.(refreshMessages);
  }, [onRefreshReady, refreshMessages]);

  // Sync mode when session data loads
  useEffect(() => {
    if (initialMode) {
      setMode(initialMode);
    }
  }, [initialMode]);

  // Sync hasMore when initial data loads
  useEffect(() => {
    setHasMore(initialHasMore);
  }, [initialHasMore]);

  // Auto-trigger assistant project hooks (onboarding/check-in)
  // Uses autoTrigger flag so the backend skips saving user message and title update.
  // Works for both fresh sessions (onboarding) and reused sessions (check-in).
  const assistantTriggerFiredRef = useRef(false);
  const checkAssistantTrigger = useCallback(async () => {
    // Don't trigger if already streaming or already triggered in this mount
    if (isStreaming || assistantTriggerFiredRef.current) return;

    try {
      const res = await fetch('/api/settings/workspace');
      if (!res.ok) return;
      const data = await res.json();
      if (!data.path) return;

      // Check if this session's working directory matches workspace path
      if (workingDirectory !== data.path) return;

      const state = data.state;
      if (!state) return;

      // Check hookTriggeredSessionId: if this session already has a trigger in progress
      // AND there are existing messages (conversation started), skip to avoid re-triggering.
      // If the session has no messages, the previous trigger may have failed — allow retry.
      if (state.hookTriggeredSessionId === sessionId && initialMessages.length > 0) return;

      const today = new Date().toISOString().slice(0, 10);
      const needsOnboarding = !state.onboardingComplete;
      const needsCheckIn = state.onboardingComplete && state.lastCheckInDate !== today;

      if (!needsOnboarding && !needsCheckIn) return;

      // For daily check-in, only trigger in the most recent session for this workspace.
      // This prevents older sessions from hijacking the check-in when reopened.
      if (needsCheckIn) {
        const latestRes = await fetch(`/api/workspace/latest-session?workingDirectory=${encodeURIComponent(data.path)}`);
        if (latestRes.ok) {
          const { sessionId: latestSessionId } = await latestRes.json();
          if (latestSessionId && latestSessionId !== sessionId) return;
        }
      }

      // Mark fired so we don't re-trigger on focus/re-render
      assistantTriggerFiredRef.current = true;

      // Mark in persistent state to prevent duplicate triggers across page reloads
      await fetch('/api/workspace/hook-triggered', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });

      // Use autoTrigger: the message is invisible (no user bubble, no title update)
      const triggerMsg = needsOnboarding
        ? '请开始助理引导设置。'
        : '请开始每日问询。';
      startStream({
        sessionId,
        content: triggerMsg,
        mode,
        model: currentModel,
        providerId: currentProviderId,
        autoTrigger: true,
        thinking: buildThinkingConfig(),
        sessionTitle,
        projectName,
        onModeChanged: (sdkMode) => {
          const uiMode = sdkMode === 'plan' ? 'plan' : 'code';
          handleModeChange(uiMode);
        },
        sendMessageFn: (retryContent: string, retryFiles?: FileAttachment[]) => {
          sendMessageRef.current?.(retryContent, retryFiles);
        },
      });
    } catch (e) {
      console.error('[ChatView] Assistant auto-trigger failed:', e);
    }
  }, [sessionId, workingDirectory, isStreaming, mode, currentModel, currentProviderId, handleModeChange]);

  useEffect(() => {
    // Small delay to let the session fully initialize
    const timer = setTimeout(checkAssistantTrigger, 500);
    return () => clearTimeout(timer);
  }, [checkAssistantTrigger]);

  // Detect workspace mismatch: only show banner when this session was previously
  // an assistant workspace session (has .assistant data) but the path has since changed.
  // Normal project chats should never see this banner.
  useEffect(() => {
    if (!workingDirectory) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/settings/workspace');
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;

        if (data.path && workingDirectory !== data.path) {
          // Only show banner if this session's workingDirectory was itself an assistant workspace
          // (i.e., it has .assistant/state.json). Regular project chats skip the banner.
          const inspectRes = await fetch(`/api/workspace/inspect?path=${encodeURIComponent(workingDirectory)}`);
          if (!inspectRes.ok || cancelled) return;
          const inspectData = await inspectRes.json();
          if (inspectData.hasAssistantData) {
            setWorkspaceMismatchPath(data.path);
          } else {
            setWorkspaceMismatchPath(null);
          }
        } else {
          setWorkspaceMismatchPath(null);
        }
      } catch {
        // ignore
      }
    })();
    return () => { cancelled = true; };
  }, [workingDirectory]);

  // Listen for workspace-switched events (from AssistantWorkspaceSection).
  // Only show banner if this session's workingDirectory was the OLD assistant workspace.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.newPath && workingDirectory && workingDirectory === detail.oldPath) {
        setWorkspaceMismatchPath(detail.newPath);
      }
    };
    window.addEventListener('assistant-workspace-switched', handler);
    return () => window.removeEventListener('assistant-workspace-switched', handler);
  }, [workingDirectory]);

  const handleOpenNewAssistant = useCallback(async () => {
    try {
      const model = typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-model') || '' : '';
      const provider_id = typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-provider-id') || '' : '';
      // Prefer reusing the latest assistant session (checkin mode) rather than always creating a new onboarding session
      const res = await fetch('/api/workspace/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'checkin', model, provider_id }),
      });
      if (res.ok) {
        const data = await res.json();
        window.dispatchEvent(new CustomEvent('session-created'));
        router.push(`/chat/${data.session.id}`);
      }
    } catch (e) {
      console.error('[ChatView] Failed to open assistant session:', e);
    }
  }, [router]);

  const loadEarlierMessages = useCallback(async () => {
    // Use ref as atomic lock to prevent double-fetch from rapid clicks
    if (loadingMoreRef.current || !hasMore || messages.length === 0) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      // Use _rowid of the earliest message as cursor
      const earliest = messages[0];
      const earliestRowId = (earliest as Message & { _rowid?: number })._rowid;
      if (!earliestRowId) return;
      const res = await fetch(`/api/chat/sessions/${sessionId}/messages?limit=100&before=${earliestRowId}`);
      if (!res.ok) return;
      const data: MessagesResponse = await res.json();
      setHasMore(data.hasMore ?? false);
      if (data.messages.length > 0) {
        setMessages(prev => [...data.messages, ...prev]);
      }
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [sessionId, messages, hasMore]);

  // Stop streaming — delegates to manager
  const stopStreaming = useCallback(() => {
    stopStream(sessionId);
  }, [sessionId]);

  // Permission response — delegates to manager
  const handlePermissionResponse = useCallback(
    async (decision: 'allow' | 'allow_session' | 'deny', updatedInput?: Record<string, unknown>, denyMessage?: string) => {
      setPendingApprovalSessionId('');
      await respondToPermission(sessionId, decision, updatedInput, denyMessage);
    },
    [sessionId, setPendingApprovalSessionId]
  );

  // Detect assistant project completion signals in final message content.
  // Only processes fences when this session's workingDirectory matches the current assistant workspace path.
  const detectAssistantCompletion = useCallback(async (content: string) => {
    // Guard: only allow fence processing for the current assistant workspace session
    if (!workingDirectory) return;
    try {
      const wsRes = await fetch('/api/settings/workspace');
      if (!wsRes.ok) return;
      const wsData = await wsRes.json();
      if (!wsData.path || wsData.path !== workingDirectory) return;
    } catch {
      return;
    }

    const clearHookTriggered = () =>
      fetch('/api/workspace/hook-triggered', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: '__clear__' }),
      }).catch(() => {});

    // Check for onboarding completion
    const onboardingMatch = content.match(/```onboarding-complete\n([\s\S]*?)\n```/);
    if (onboardingMatch) {
      try {
        const answers = JSON.parse(onboardingMatch[1]);
        await fetch('/api/workspace/onboarding', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers, sessionId }),
        });
        await clearHookTriggered();
      } catch (e) {
        console.error('[ChatView] Onboarding completion failed:', e);
      }
      return;
    }

    // Check for check-in completion
    const checkinMatch = content.match(/```checkin-complete\n([\s\S]*?)\n```/);
    if (checkinMatch) {
      try {
        const answers = JSON.parse(checkinMatch[1]);
        await fetch('/api/workspace/checkin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers, sessionId }),
        });
        await clearHookTriggered();
      } catch (e) {
        console.error('[ChatView] Check-in completion failed:', e);
      }
    }
  }, [sessionId, workingDirectory]);

  // Build SDK thinking config from settings
  const buildThinkingConfig = useCallback((): { type: string } | undefined => {
    if (!thinkingMode || thinkingMode === 'adaptive') return { type: 'adaptive' };
    if (thinkingMode === 'enabled') return { type: 'enabled' };
    if (thinkingMode === 'disabled') return { type: 'disabled' };
    return undefined;
  }, [thinkingMode]);

  // Send message — delegates stream management to the manager
  const sendMessage = useCallback(
    async (content: string, files?: FileAttachment[], systemPromptAppend?: string, displayOverride?: string) => {
      if (isStreaming) return;

      // Use displayOverride for UI if provided (e.g. image-gen skill injection hides the skill prompt)
      const displayUserContent = displayOverride || content;

      // Build display content: embed file metadata as HTML comment for MessageItem to parse
      let displayContent = displayUserContent;
      if (files && files.length > 0) {
        const fileMeta = files.map(f => ({ id: f.id, name: f.name, type: f.type, size: f.size }));
        displayContent = `<!--files:${JSON.stringify(fileMeta)}-->${displayUserContent}`;
      }

      // Optimistic: add user message to UI immediately
      const userMessage: Message = {
        id: 'temp-' + Date.now(),
        session_id: sessionId,
        role: 'user',
        content: displayContent,
        created_at: new Date().toISOString(),
        token_usage: null,
      };
      setMessages((prev) => [...prev, userMessage]);

      // Flush pending image notices
      const notices = pendingImageNoticesRef.current.length > 0
        ? [...pendingImageNoticesRef.current]
        : undefined;
      if (notices) {
        pendingImageNoticesRef.current = [];
      }

      // Delegate to stream session manager
      startStream({
        sessionId,
        content,
        mode,
        model: currentModel,
        providerId: currentProviderId,
        files,
        systemPromptAppend,
        pendingImageNotices: notices,
        effort: selectedEffort,
        thinking: buildThinkingConfig(),
        sessionTitle,
        projectName,
        onModeChanged: (sdkMode) => {
          const uiMode = sdkMode === 'plan' ? 'plan' : 'code';
          handleModeChange(uiMode);
        },
        sendMessageFn: (retryContent: string, retryFiles?: FileAttachment[]) => {
          sendMessageRef.current?.(retryContent, retryFiles);
        },
      });
    },
    [sessionId, isStreaming, mode, currentModel, currentProviderId, selectedEffort, buildThinkingConfig, handleModeChange, sessionTitle, projectName]
  );

  // Keep sendMessageRef in sync so timeout auto-retry can call it
  sendMessageRef.current = sendMessage;

  const handleCommand = useCallback((command: string) => {
    switch (command) {
      case '/help': {
        const helpMessage: Message = {
          id: 'cmd-' + Date.now(),
          session_id: sessionId,
          role: 'assistant',
          content: `## Available Commands\n\n### Instant Commands\n- **/help** — Show this help message\n- **/clear** — Clear conversation history\n- **/cost** — Show token usage statistics\n\n### Prompt Commands (shown as badge, add context then send)\n- **/compact** — Compress conversation context\n- **/doctor** — Diagnose project health\n- **/init** — Initialize CLAUDE.md for project\n- **/review** — Review code quality\n- **/terminal-setup** — Configure terminal settings\n- **/memory** — Edit project memory file\n\n### Custom Skills\nSkills from \`~/.claude/commands/\` and project \`.claude/commands/\` are also available via \`/\`.\n\n**Tips:**\n- Type \`/\` to browse commands and skills\n- Type \`@\` to mention files\n- Use Shift+Enter for new line\n- Select a project folder to enable file operations`,
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages(prev => [...prev, helpMessage]);
        break;
      }
      case '/clear':
        setMessages([]);
        invalidateCachedMessages(sessionId);
        // Also clear database messages and reset SDK session
        if (sessionId) {
          fetch(`/api/chat/sessions/${sessionId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clear_messages: true }),
          }).catch(() => { /* silent */ });
        }
        break;
      case '/cost': {
        // Aggregate token usage from all messages in this session
        let totalInput = 0;
        let totalOutput = 0;
        let totalCacheRead = 0;
        let totalCacheCreation = 0;
        let totalCost = 0;
        let turnCount = 0;

        for (const msg of messages) {
          if (msg.token_usage) {
            try {
              const usage = typeof msg.token_usage === 'string' ? JSON.parse(msg.token_usage) : msg.token_usage;
              totalInput += usage.input_tokens || 0;
              totalOutput += usage.output_tokens || 0;
              totalCacheRead += usage.cache_read_input_tokens || 0;
              totalCacheCreation += usage.cache_creation_input_tokens || 0;
              if (usage.cost_usd) totalCost += usage.cost_usd;
              turnCount++;
            } catch { /* skip */ }
          }
        }

        const totalTokens = totalInput + totalOutput;
        let content: string;

        if (turnCount === 0) {
          content = `## Token Usage\n\nNo token usage data yet. Send a message first.`;
        } else {
          content = `## Token Usage\n\n| Metric | Count |\n|--------|-------|\n| Input tokens | ${totalInput.toLocaleString()} |\n| Output tokens | ${totalOutput.toLocaleString()} |\n| Cache read | ${totalCacheRead.toLocaleString()} |\n| Cache creation | ${totalCacheCreation.toLocaleString()} |\n| **Total tokens** | **${totalTokens.toLocaleString()}** |\n| Turns | ${turnCount} |${totalCost > 0 ? `\n| **Estimated cost** | **$${totalCost.toFixed(4)}** |` : ''}`;
        }

        const costMessage: Message = {
          id: 'cmd-' + Date.now(),
          session_id: sessionId,
          role: 'assistant',
          content,
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages(prev => [...prev, costMessage]);
        break;
      }
      default:
        // This shouldn't be reached since non-immediate commands are handled via badge
        sendMessage(command);
    }
  }, [sessionId, sendMessage]);

  // Listen for image generation completion — persist notice to DB and queue for next user message.
  // The notice is NOT sent as a separate LLM turn (avoids permission popups).
  // Instead it's flushed into the next user message via pendingImageNoticesRef.
  // MessageItem hides messages matching this prefix so the user doesn't see them.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      const paths = (detail.images || [])
        .map((img: { localPath?: string }) => img.localPath)
        .filter(Boolean);
      const pathInfo = paths.length > 0 ? `\nGenerated image file paths:\n${paths.map((p: string) => `- ${p}`).join('\n')}` : '';
      const notice = `[Image generation completed]\n- Prompt: "${detail.prompt}"\n- Aspect ratio: ${detail.aspectRatio}\n- Resolution: ${detail.resolution}${pathInfo}`;

      // Store generated image paths so subsequent edits can use them as reference
      if (paths.length > 0) {
        setLastGeneratedImages(paths);
      }

      // Queue for next user message so the LLM gets the context
      pendingImageNoticesRef.current.push(notice);

      // Also persist to DB for history reload
      const dbNotice = `[__IMAGE_GEN_NOTICE__ prompt: "${detail.prompt}", aspect ratio: ${detail.aspectRatio}, resolution: ${detail.resolution}${paths.length > 0 ? `, file path: ${paths.join(', ')}` : ''}]`;
      fetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, role: 'user', content: dbNotice }),
      }).catch(() => {});
    };
    window.addEventListener('image-gen-completed', handler);
    return () => window.removeEventListener('image-gen-completed', handler);
  }, [sessionId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Workspace mismatch banner */}
      {workspaceMismatchPath && (
        <div className="flex items-center justify-between gap-3 border-b border-yellow-500/30 bg-yellow-500/10 px-4 py-2">
          <span className="text-xs text-yellow-700 dark:text-yellow-400">
            {t('assistant.switchedBanner', { path: workspaceMismatchPath })}
          </span>
          <button
            onClick={handleOpenNewAssistant}
            className="shrink-0 rounded-md bg-yellow-600 px-3 py-1 text-xs font-medium text-white hover:bg-yellow-700 transition-colors"
          >
            {t('assistant.openNewAssistant')}
          </button>
        </div>
      )}
      <MessageList
        messages={messages}
        streamingContent={streamingContent}
        isStreaming={isStreaming}
        toolUses={toolUses}
        toolResults={toolResults}
        streamingToolOutput={streamingToolOutput}
        statusText={statusText}
        onForceStop={stopStreaming}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={loadEarlierMessages}
        rewindPoints={rewindPoints}
        sessionId={sessionId}
        agentCalls={agentCalls}
        thinkingContent={thinkingContent}
        startedAt={startedAt}
      />
      {/* Permission prompt — rendered outside MessageList so it's always visible at bottom */}
      <PermissionPrompt
        pendingPermission={pendingPermission}
        permissionResolved={permissionResolved}
        onPermissionResponse={handlePermissionResponse}
        toolUses={toolUses}
        permissionProfile={permissionProfile}
      />
      {/* Batch image generation panels — shown above the input area */}
      <BatchExecutionDashboard />
      <BatchContextSync />

      <MessageInput
        key={sessionId}
        onSend={sendMessage}
        onCommand={handleCommand}
        onStop={stopStreaming}
        disabled={false}
        isStreaming={isStreaming}
        sessionId={sessionId}
        modelName={currentModel}
        onModelChange={setCurrentModel}
        providerId={currentProviderId}
        onProviderModelChange={handleProviderModelChange}
        workingDirectory={workingDirectory}
        mode={mode}
        onModeChange={handleModeChange}
        onAssistantTrigger={checkAssistantTrigger}
        effort={selectedEffort}
        onEffortChange={setSelectedEffort}
      />
      <ChatComposerActionBar
        left={<ImageGenToggle />}
        center={
          <ChatPermissionSelector
            sessionId={sessionId}
            permissionProfile={permissionProfile}
            onPermissionChange={setPermissionProfile}
          />
        }
        right={
          <ContextUsageIndicator
            messages={messages}
            modelName={currentModel}
          />
        }
      />
    </div>
  );
}
