"use client";

import { useState, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Search01Icon,
  Loading02Icon,
  Package01Icon,
  ZapIcon,
  CommandIcon,
  UserStar01Icon,
  Settings02Icon,
  AlertCircleIcon,
  CheckmarkCircle01Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";
import { getApiCache, setApiCache } from "@/lib/api-cache";
import type { InstalledPlugin, PluginResource } from "@/app/api/plugins/route";

// ─────────────────────────────────────────────
// Resource type icon map
// ─────────────────────────────────────────────
function ResourceIcon({ type, className }: { type: PluginResource["resourceType"]; className?: string }) {
  const icon =
    type === "skill" ? ZapIcon :
    type === "command" ? CommandIcon :
    UserStar01Icon;
  return <HugeiconsIcon icon={icon} className={cn("h-3.5 w-3.5", className)} />;
}

function resourceBadgeVariant(type: PluginResource["resourceType"]) {
  if (type === "skill") return "default";
  if (type === "command") return "secondary";
  return "outline";
}

// ─────────────────────────────────────────────
// Plugin list item
// ─────────────────────────────────────────────
interface PluginListItemProps {
  plugin: InstalledPlugin;
  selected: boolean;
  onSelect: () => void;
}

function PluginListItem({ plugin, selected, onSelect }: PluginListItemProps) {
  const skillCount = plugin.resources.filter(r => r.resourceType === "skill").length;
  const commandCount = plugin.resources.filter(r => r.resourceType === "command").length;
  const agentCount = plugin.resources.filter(r => r.resourceType === "agent").length;

  return (
    <div
      className={cn(
        "group flex items-start gap-2.5 rounded-lg px-3 py-2.5 cursor-pointer transition-colors border border-transparent",
        selected
          ? "bg-accent text-accent-foreground border-accent-foreground/10"
          : "hover:bg-accent/40"
      )}
      onClick={onSelect}
    >
      <div className={cn(
        "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
        plugin.exists ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
      )}>
        <HugeiconsIcon icon={Package01Icon} className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium truncate">{plugin.name}</span>
          {plugin.version && (
            <span className="text-[10px] text-muted-foreground shrink-0">v{plugin.version}</span>
          )}
        </div>
        {plugin.description && (
          <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{plugin.description}</p>
        )}
        {/* Resource chips */}
        {plugin.resources.length > 0 && (
          <div className="flex items-center gap-1 mt-1.5 flex-wrap">
            {skillCount > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] bg-primary/10 text-primary rounded px-1.5 py-0.5">
                <HugeiconsIcon icon={ZapIcon} className="h-2.5 w-2.5" />
                {skillCount}
              </span>
            )}
            {commandCount > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] bg-muted text-muted-foreground rounded px-1.5 py-0.5">
                <HugeiconsIcon icon={CommandIcon} className="h-2.5 w-2.5" />
                {commandCount}
              </span>
            )}
            {agentCount > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded px-1.5 py-0.5">
                <HugeiconsIcon icon={UserStar01Icon} className="h-2.5 w-2.5" />
                {agentCount}
              </span>
            )}
            {plugin.mcpConfig && (
              <span className="inline-flex items-center gap-0.5 text-[10px] bg-orange-500/10 text-orange-600 dark:text-orange-400 rounded px-1.5 py-0.5">
                <HugeiconsIcon icon={Settings02Icon} className="h-2.5 w-2.5" />
                MCP
              </span>
            )}
          </div>
        )}
      </div>
      {!plugin.exists && (
        <HugeiconsIcon icon={AlertCircleIcon} className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// Resource list section
// ─────────────────────────────────────────────
function ResourceSection({
  title,
  items,
  icon,
  colorClass,
}: {
  title: string;
  items: PluginResource[];
  icon: React.ComponentProps<typeof HugeiconsIcon>["icon"];
  colorClass: string;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2">
        <HugeiconsIcon icon={icon} className={cn("h-3.5 w-3.5", colorClass)} />
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          {title} <span className="ml-0.5 opacity-60">({items.length})</span>
        </span>
      </div>
      <div className="space-y-1.5">
        {items.map((resource) => (
          <div
            key={resource.filePath}
            className="flex items-start gap-2 rounded-md bg-muted/50 px-2.5 py-1.5"
          >
            <ResourceIcon type={resource.resourceType} className={cn("mt-0.5 shrink-0", colorClass)} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium">/{resource.name}</span>
                <Badge variant={resourceBadgeVariant(resource.resourceType)} className="text-[9px] h-4 px-1">
                  {resource.resourceType}
                </Badge>
              </div>
              {resource.description && (
                <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                  {resource.description}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Plugin detail panel
// ─────────────────────────────────────────────
interface PluginDetailPanelProps {
  plugin: InstalledPlugin;
}

function PluginDetailPanel({ plugin }: PluginDetailPanelProps) {
  const { t } = useTranslation();
  const skills = plugin.resources.filter(r => r.resourceType === "skill");
  const commands = plugin.resources.filter(r => r.resourceType === "command");
  const agents = plugin.resources.filter(r => r.resourceType === "agent");

  const formatDate = (iso: string) => {
    if (!iso) return "–";
    try {
      return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch {
      return iso;
    }
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="px-5 py-4 border-b border-border">
        <div className="flex items-start gap-3">
          <div className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
            plugin.exists ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
          )}>
            <HugeiconsIcon icon={Package01Icon} className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold">{plugin.name}</h2>
              {plugin.version && (
                <Badge variant="outline" className="text-xs">v{plugin.version}</Badge>
              )}
              {plugin.exists ? (
                <HugeiconsIcon icon={CheckmarkCircle01Icon} className="h-4 w-4 text-green-500" />
              ) : (
                <Badge variant="destructive" className="text-xs">{t('plugins.notFound')}</Badge>
              )}
            </div>
            {plugin.description && (
              <p className="text-sm text-muted-foreground mt-1">{plugin.description}</p>
            )}
            {plugin.keywords.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {plugin.keywords.map(k => (
                  <Badge key={k} variant="secondary" className="text-[10px] h-4 px-1.5">{k}</Badge>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Meta info */}
      <div className="px-5 py-3 border-b border-border bg-muted/20">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          {plugin.author && (
            <>
              <dt className="text-muted-foreground">{t('plugins.author')}</dt>
              <dd className="font-medium truncate">{plugin.author}</dd>
            </>
          )}
          {plugin.license && (
            <>
              <dt className="text-muted-foreground">{t('plugins.license')}</dt>
              <dd className="font-medium">{plugin.license}</dd>
            </>
          )}
          <dt className="text-muted-foreground">{t('plugins.installedAt')}</dt>
          <dd className="font-medium">{formatDate(plugin.installedAt)}</dd>
          <dt className="text-muted-foreground">{t('plugins.updatedAt')}</dt>
          <dd className="font-medium">{formatDate(plugin.lastUpdated)}</dd>
          <dt className="text-muted-foreground">{t('plugins.scope')}</dt>
          <dd className="font-medium capitalize">{plugin.scope}</dd>
        </dl>
        {plugin.installPath && (
          <p className="mt-2 text-[10px] text-muted-foreground font-mono truncate" title={plugin.installPath}>
            {plugin.installPath}
          </p>
        )}
      </div>

      {/* Resources */}
      <div className="flex-1 px-5 py-4 space-y-5">
        {plugin.resources.length === 0 && !plugin.mcpConfig ? (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
            <HugeiconsIcon icon={Package01Icon} className="h-8 w-8 opacity-30" />
            <p className="text-sm">{t('plugins.noResources')}</p>
          </div>
        ) : (
          <>
            <ResourceSection
              title={t('plugins.skills')}
              items={skills}
              icon={ZapIcon}
              colorClass="text-primary"
            />
            <ResourceSection
              title={t('plugins.commands')}
              items={commands}
              icon={CommandIcon}
              colorClass="text-muted-foreground"
            />
            <ResourceSection
              title={t('plugins.agents')}
              items={agents}
              icon={UserStar01Icon}
              colorClass="text-blue-500"
            />
            {plugin.mcpConfig && (
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <HugeiconsIcon icon={Settings02Icon} className="h-3.5 w-3.5 text-orange-500" />
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    {t('plugins.mcp')}
                  </span>
                </div>
                <div className="rounded-md bg-muted/50 px-3 py-2">
                  <p className="text-xs text-muted-foreground mb-2">{t('plugins.hasMcp')}</p>
                  <pre className="text-[10px] font-mono text-foreground whitespace-pre-wrap break-all max-h-40 overflow-auto">
                    {JSON.stringify(plugin.mcpConfig, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Main PluginsManager
// ─────────────────────────────────────────────
export function PluginsManager() {
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<InstalledPlugin[]>(() => getApiCache<InstalledPlugin[]>('plugins') ?? []);
  const [loading, setLoading] = useState(() => !getApiCache<InstalledPlugin[]>('plugins'));
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<InstalledPlugin | null>(null);

  const fetchPlugins = useCallback(async () => {
    try {
      const res = await fetch("/api/plugins");
      if (res.ok) {
        const data = await res.json() as { plugins: InstalledPlugin[] };
        const fetched = data.plugins || [];
        setApiCache('plugins', fetched);
        setPlugins(fetched);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPlugins();
  }, [fetchPlugins]);

  // Auto-select first plugin
  useEffect(() => {
    if (!selected && plugins.length > 0) {
      setSelected(plugins[0]);
    }
  }, [plugins, selected]);

  const filtered = plugins.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.description.toLowerCase().includes(search.toLowerCase()) ||
    p.id.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center gap-2">
        <HugeiconsIcon icon={Loading02Icon} className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{t("plugins.loading")}</span>
      </div>
    );
  }

  if (plugins.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
        <HugeiconsIcon icon={Package01Icon} className="h-12 w-12 opacity-30" />
        <div className="text-center">
          <p className="text-sm font-medium">{t("plugins.noPlugins")}</p>
          <p className="text-xs mt-1 max-w-xs">{t("plugins.noPluginsDesc")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <h3 className="text-lg font-semibold">{t("plugins.title")}</h3>
        <Badge variant="secondary" className="text-xs">{plugins.length}</Badge>
      </div>

      <div className="flex gap-4 flex-1 min-h-0">
        {/* Left panel: plugin list */}
        <div className="w-72 shrink-0 flex flex-col border border-border rounded-lg overflow-hidden">
          {/* Search */}
          <div className="p-2 border-b border-border">
            <div className="relative">
              <HugeiconsIcon
                icon={Search01Icon}
                className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground"
              />
              <Input
                placeholder={t("plugins.searchPlugins")}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-7 h-8 text-sm"
              />
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto min-h-0 p-1.5 space-y-0.5">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-1">
                <HugeiconsIcon icon={Package01Icon} className="h-7 w-7 opacity-30" />
                <p className="text-xs">{t("plugins.noPlugins")}</p>
              </div>
            ) : (
              filtered.map(plugin => (
                <PluginListItem
                  key={plugin.id}
                  plugin={plugin}
                  selected={selected?.id === plugin.id}
                  onSelect={() => setSelected(plugin)}
                />
              ))
            )}
          </div>
        </div>

        {/* Right panel: detail */}
        <div className="flex-1 min-w-0 border border-border rounded-lg overflow-hidden">
          {selected ? (
            <PluginDetailPanel plugin={selected} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
              <HugeiconsIcon icon={Package01Icon} className="h-12 w-12 opacity-30" />
              <div className="text-center">
                <p className="text-sm font-medium">{t("plugins.noSelected")}</p>
                <p className="text-xs">{t("plugins.selectHint")}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
