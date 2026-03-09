"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon, ListViewIcon, CodeIcon, Loading02Icon, RefreshIcon, Wifi01Icon } from "@hugeicons/core-free-icons";
import { McpServerList } from "@/components/plugins/McpServerList";
import { McpServerEditor } from "@/components/plugins/McpServerEditor";
import { ConfigEditor } from "@/components/plugins/ConfigEditor";
import { useTranslation } from "@/hooks/useTranslation";
import { getApiCache, setApiCache } from "@/lib/api-cache";
import type { TranslationKey } from "@/i18n";
import type { MCPServer } from "@/types";

interface McpRuntimeStatus {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  serverInfo?: { name: string; version: string };
}

export function McpManager() {
  const { t } = useTranslation();
  const [servers, setServers] = useState<Record<string, MCPServer>>(
    () => getApiCache<Record<string, MCPServer>>('mcp-servers') ?? {}
  );
  const [loading, setLoading] = useState(() => !getApiCache<Record<string, MCPServer>>('mcp-servers'));
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | undefined>();
  const [editingServer, setEditingServer] = useState<MCPServer | undefined>();
  const [tab, setTab] = useState<"list" | "json">("list");
  const [error, setError] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<McpRuntimeStatus[]>([]);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const fetchServers = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/plugins/mcp");
      const data = await res.json();
      if (data.mcpServers) {
        setApiCache('mcp-servers', data.mcpServers);
        setServers(data.mcpServers);
      } else if (data.error) {
        setError(data.error);
      }
    } catch (err) {
      console.error("Failed to fetch MCP servers:", err);
      setError("Failed to connect to API");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchRuntimeStatus = useCallback(async () => {
    setRuntimeLoading(true);
    try {
      // Try to get active session from stream manager
      const sessionsRes = await fetch('/api/chat/sessions?status=active&limit=1');
      const sessionsData = await sessionsRes.json();
      const sessionId = sessionsData?.sessions?.[0]?.id;

      if (!sessionId) {
        setActiveSessionId(null);
        setRuntimeStatus([]);
        return;
      }

      setActiveSessionId(sessionId);
      const res = await fetch(`/api/plugins/mcp/status?sessionId=${encodeURIComponent(sessionId)}`);
      const data = await res.json();
      if (data.servers) {
        setRuntimeStatus(data.servers);
      }
    } catch {
      // Runtime status unavailable
    } finally {
      setRuntimeLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchServers();
    fetchRuntimeStatus();
  }, [fetchServers, fetchRuntimeStatus]);

  function handleEdit(name: string, server: MCPServer) {
    setEditingName(name);
    setEditingServer(server);
    setEditorOpen(true);
  }

  function handleAdd() {
    setEditingName(undefined);
    setEditingServer(undefined);
    setEditorOpen(true);
  }

  async function handleDelete(name: string) {
    try {
      const res = await fetch(`/api/plugins/mcp/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        const updated = { ...servers };
        delete updated[name];
        setApiCache('mcp-servers', updated);
        setServers(updated);
      } else {
        const data = await res.json();
        console.error("Failed to delete MCP server:", data.error);
      }
    } catch (err) {
      console.error("Failed to delete MCP server:", err);
    }
  }

  async function handleSave(name: string, server: MCPServer) {
    if (editingName && editingName !== name) {
      const updated = { ...servers };
      delete updated[editingName];
      updated[name] = server;
      try {
        await fetch("/api/plugins/mcp", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mcpServers: updated }),
        });
        setApiCache('mcp-servers', updated);
        setServers(updated);
      } catch (err) {
        console.error("Failed to save MCP server:", err);
      }
    } else if (editingName) {
      const updated = { ...servers, [name]: server };
      try {
        await fetch("/api/plugins/mcp", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mcpServers: updated }),
        });
        setApiCache('mcp-servers', updated);
        setServers(updated);
      } catch (err) {
        console.error("Failed to save MCP server:", err);
      }
    } else {
      try {
        const res = await fetch("/api/plugins/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, server }),
        });
        if (res.ok) {
          const updated = { ...servers, [name]: server };
          setApiCache('mcp-servers', updated);
          setServers(updated);
        } else {
          const data = await res.json();
          console.error("Failed to add MCP server:", data.error);
        }
      } catch (err) {
        console.error("Failed to add MCP server:", err);
      }
    }
  }

  async function handleJsonSave(jsonStr: string) {
    try {
      const parsed = JSON.parse(jsonStr);
      await fetch("/api/plugins/mcp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mcpServers: parsed }),
      });
      setApiCache('mcp-servers', parsed);
      setServers(parsed);
    } catch (err) {
      console.error("Failed to save MCP config:", err);
    }
  }

  const serverCount = Object.keys(servers).length;

  return (
    <div className="h-full overflow-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold">{t('extensions.mcpServers')}</h3>
            {serverCount > 0 && (
              <span className="text-sm text-muted-foreground">
                ({serverCount})
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Configure Model Context Protocol servers for Claude
          </p>
        </div>
        <Button size="sm" className="gap-1" onClick={handleAdd}>
          <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
          {t('mcp.addServer')}
        </Button>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 mb-4">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as "list" | "json")}>
        <TabsList>
          <TabsTrigger value="list" className="gap-1.5">
            <HugeiconsIcon icon={ListViewIcon} className="h-3.5 w-3.5" />
            {t('mcp.listTab')}
          </TabsTrigger>
          <TabsTrigger value="json" className="gap-1.5">
            <HugeiconsIcon icon={CodeIcon} className="h-3.5 w-3.5" />
            {t('mcp.jsonTab')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="mt-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
              <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
              <p className="text-sm">{t('mcp.loadingServers')}</p>
            </div>
          ) : (
            <McpServerList
              servers={servers}
              onEdit={handleEdit}
              onDelete={handleDelete}
              runtimeStatus={runtimeStatus}
              activeSessionId={activeSessionId || undefined}
            />
          )}
        </TabsContent>

        <TabsContent value="json" className="mt-4">
          <ConfigEditor
            value={JSON.stringify(servers, null, 2)}
            onSave={handleJsonSave}
            label={t('mcp.serverConfig')}
          />
        </TabsContent>
      </Tabs>

      {/* Runtime Status Section */}
      <div className="mt-6 border-t pt-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <HugeiconsIcon icon={Wifi01Icon} className="h-4 w-4 text-muted-foreground" />
            <h4 className="text-sm font-medium">{t('mcp.runtimeStatus' as TranslationKey)}</h4>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={fetchRuntimeStatus}
            disabled={runtimeLoading}
          >
            <HugeiconsIcon icon={runtimeLoading ? Loading02Icon : RefreshIcon} className={`h-3 w-3 ${runtimeLoading ? 'animate-spin' : ''}`} />
            {t('mcp.refresh' as TranslationKey)}
          </Button>
        </div>

        {!activeSessionId ? (
          <p className="text-xs text-muted-foreground py-4 text-center">
            {t('mcp.noActiveSession' as TranslationKey)}
          </p>
        ) : runtimeStatus.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">
            {t('mcp.noRuntimeStatus' as TranslationKey)}
          </p>
        ) : (
          <div className="space-y-1.5">
            {runtimeStatus.map((s) => (
              <div key={s.name} className="flex items-center justify-between py-1.5 px-2 rounded-md bg-muted/30">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`h-2 w-2 rounded-full shrink-0 ${
                    s.status === 'connected' ? 'bg-green-500' :
                    s.status === 'failed' ? 'bg-red-500' :
                    s.status === 'pending' ? 'bg-blue-500' :
                    s.status === 'disabled' ? 'bg-gray-400' :
                    'bg-yellow-500'
                  }`} />
                  <span className="text-xs font-medium truncate">{s.name}</span>
                </div>
                <Badge variant="outline" className="text-[10px] shrink-0">
                  {s.status}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </div>

      <McpServerEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        name={editingName}
        server={editingServer}
        onSave={handleSave}
      />
    </div>
  );
}
