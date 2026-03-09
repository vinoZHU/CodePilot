import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface PluginResource {
  name: string;
  description: string;
  filePath: string;
  /** "skill" | "command" | "agent" */
  resourceType: 'skill' | 'command' | 'agent';
}

export interface InstalledPlugin {
  /** e.g. "superpowers@claude-plugins-official" */
  id: string;
  /** Display name from plugin.json, falls back to id prefix */
  name: string;
  description: string;
  version: string;
  author: string;
  homepage?: string;
  license?: string;
  keywords: string[];
  /** Install timestamp ISO string */
  installedAt: string;
  lastUpdated: string;
  scope: string;
  installPath: string;
  /** Whether the install path actually exists on disk */
  exists: boolean;
  /** Resources bundled with this plugin (skills, commands, agents) */
  resources: PluginResource[];
  /** MCP config if plugin ships one (.mcp.json) */
  mcpConfig?: Record<string, unknown>;
}

export interface PluginsResponse {
  plugins: InstalledPlugin[];
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function parseSkillFrontMatter(content: string): { name?: string; description?: string } {
  const fmMatch = content.match(/^---\r?\n([\s\S]+?)\r?\n---/);
  if (!fmMatch) return {};

  const frontMatter = fmMatch[1];
  const lines = frontMatter.split(/\r?\n/);
  const result: { name?: string; description?: string } = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Support both `name:` and legacy `skill:` key
    const nameMatch = line.match(/^(?:name|skill):\s*(.+)/);
    if (nameMatch) {
      result.name = nameMatch[1].trim();
      continue;
    }

    if (/^description:\s*\|/.test(line)) {
      const descLines: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s+/.test(lines[j])) {
          descLines.push(lines[j].trim());
        } else {
          break;
        }
      }
      if (descLines.length > 0) {
        result.description = descLines.filter(Boolean).join(' ');
      }
      continue;
    }

    const descMatch = line.match(/^description:\s+(.+)/);
    if (descMatch) {
      result.description = descMatch[1].trim();
    }
  }
  return result;
}

function extractDescription(content: string, fallback: string): string {
  const meta = parseSkillFrontMatter(content);
  if (meta.description) return meta.description;
  const bodyMatch = content.match(/^---[\s\S]+?---\r?\n([\s\S]+)/);
  const firstLine = (bodyMatch?.[1] ?? content).split('\n')[0]?.trim() || '';
  return firstLine.startsWith('#')
    ? firstLine.replace(/^#+\s*/, '')
    : firstLine || fallback;
}

function scanSkillsDir(skillsDir: string): PluginResource[] {
  const resources: PluginResource[] = [];
  if (!fs.existsSync(skillsDir)) return resources;
  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const meta = parseSkillFrontMatter(content);
      const name = meta.name || entry.name;
      const description = meta.description || `Skill: /${name}`;
      resources.push({ name, description, filePath: skillMdPath, resourceType: 'skill' });
    }
  } catch { /* ignore */ }
  return resources;
}

function scanCommandsDir(commandsDir: string): PluginResource[] {
  const resources: PluginResource[] = [];
  if (!fs.existsSync(commandsDir)) return resources;

  function recurse(dir: string, prefix = '') {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          recurse(fullPath, prefix ? `${prefix}:${entry.name}` : entry.name);
          continue;
        }
        if (!entry.name.endsWith('.md')) continue;
        const baseName = entry.name.replace(/\.md$/, '');
        const name = prefix ? `${prefix}:${baseName}` : baseName;
        const content = fs.readFileSync(fullPath, 'utf-8');
        const description = extractDescription(content, `Command: /${name}`);
        resources.push({ name, description, filePath: fullPath, resourceType: 'command' });
      }
    } catch { /* ignore */ }
  }

  recurse(commandsDir);
  return resources;
}

function scanAgentsDir(agentsDir: string): PluginResource[] {
  const resources: PluginResource[] = [];
  if (!fs.existsSync(agentsDir)) return resources;
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const filePath = path.join(agentsDir, entry.name);
      const content = fs.readFileSync(filePath, 'utf-8');
      const meta = parseSkillFrontMatter(content);
      const name = meta.name || entry.name.replace(/\.md$/, '');
      const description = meta.description || extractDescription(content, `Agent: ${name}`);
      resources.push({ name, description, filePath, resourceType: 'agent' });
    }
  } catch { /* ignore */ }
  return resources;
}

function readPluginMeta(installPath: string): {
  name?: string;
  description?: string;
  version?: string;
  author?: string | { name?: string };
  homepage?: string;
  license?: string;
  keywords?: string[];
} {
  const candidates = [
    path.join(installPath, '.claude-plugin', 'plugin.json'),
    path.join(installPath, 'plugin.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      } catch { /* ignore */ }
    }
  }
  return {};
}

function readMcpConfig(installPath: string): Record<string, unknown> | undefined {
  const candidates = [
    path.join(installPath, '.mcp.json'),
    path.join(installPath, '.mcp', 'config.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
      } catch { /* ignore */ }
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────
// Main discovery
// ─────────────────────────────────────────────

function discoverInstalledPlugins(): InstalledPlugin[] {
  const installedPluginsPath = path.join(
    os.homedir(), '.claude', 'plugins', 'installed_plugins.json'
  );

  if (!fs.existsSync(installedPluginsPath)) return [];

  let raw: {
    version?: number;
    plugins?: Record<string, Array<{
      scope?: string;
      installPath?: string;
      version?: string;
      installedAt?: string;
      lastUpdated?: string;
    }>>;
  };

  try {
    raw = JSON.parse(fs.readFileSync(installedPluginsPath, 'utf-8'));
  } catch {
    return [];
  }

  const pluginsMap = raw.plugins || {};
  const result: InstalledPlugin[] = [];

  for (const [pluginId, entries] of Object.entries(pluginsMap)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const entry = entries[0]; // Most-recently installed record
    const installPath = entry.installPath || '';
    const exists = !!installPath && fs.existsSync(installPath);

    const meta = exists ? readPluginMeta(installPath) : {};
    const authorName =
      typeof meta.author === 'string'
        ? meta.author
        : (meta.author as { name?: string } | undefined)?.name || '';

    const displayName = meta.name || pluginId.split('@')[0];

    const resources: PluginResource[] = [];
    if (exists) {
      resources.push(...scanSkillsDir(path.join(installPath, 'skills')));
      resources.push(...scanCommandsDir(path.join(installPath, 'commands')));
      resources.push(...scanAgentsDir(path.join(installPath, 'agents')));
    }

    const mcpConfig = exists ? readMcpConfig(installPath) : undefined;

    result.push({
      id: pluginId,
      name: displayName,
      description: meta.description || '',
      version: entry.version || meta.version || '',
      author: authorName,
      homepage: meta.homepage,
      license: meta.license,
      keywords: meta.keywords || [],
      installedAt: entry.installedAt || '',
      lastUpdated: entry.lastUpdated || '',
      scope: entry.scope || 'user',
      installPath,
      exists,
      resources,
      mcpConfig,
    });
  }

  return result;
}

// ─────────────────────────────────────────────
// Route handler
// ─────────────────────────────────────────────

export async function GET(): Promise<NextResponse<PluginsResponse | { error: string }>> {
  try {
    const plugins = discoverInstalledPlugins();
    return NextResponse.json({ plugins });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load plugins' },
      { status: 500 }
    );
  }
}
