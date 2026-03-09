import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

interface SkillFile {
  name: string;
  description: string;
  content: string;
  source: "global" | "project" | "plugin" | "installed" | "agent";
  installedSource?: "agents" | "claude";
  filePath: string;
  /** Only set for source="agent": which plugin this agent belongs to */
  pluginId?: string;
}

type InstalledSource = "agents" | "claude";
type InstalledSkill = SkillFile & { installedSource: InstalledSource; contentHash: string };

function getGlobalCommandsDir(): string {
  return path.join(os.homedir(), ".claude", "commands");
}

function getProjectCommandsDir(cwd?: string): string {
  return path.join(cwd || process.cwd(), ".claude", "commands");
}

function getProjectSkillsDir(cwd?: string): string {
  return path.join(cwd || process.cwd(), ".claude", "skills");
}

interface PluginScanTarget {
  dir: string;
  /** "skills" → {name}/SKILL.md 格式，用 scanProjectSkills；"commands" → 平铺 .md，用 scanDirectory */
  scanType: "skills" | "commands";
  /** Plugin identifier (key from installed_plugins.json) for agent attribution */
  pluginId?: string;
}

/**
 * 收集所有已安装插件需要扫描的目录。
 *
 * 主路径：读取 installed_plugins.json 获取各插件的 installPath（缓存目录），
 * 对每个 installPath 同时尝试 skills/ 和 commands/ 两个子目录。
 *
 * 回退路径：若 installed_plugins.json 不存在，改为遍历
 * ~/.claude/plugins/marketplaces/{marketplace}/plugins/{plugin}/
 * 同样扫 skills/ 和 commands/。
 */
function getPluginScanTargets(): PluginScanTarget[] {
  const targets: PluginScanTarget[] = [];

  function addTargetsFromPluginRoot(pluginRoot: string, pluginId?: string) {
    const skillsDir = path.join(pluginRoot, "skills");
    if (fs.existsSync(skillsDir)) {
      targets.push({ dir: skillsDir, scanType: "skills", pluginId });
    }
    const commandsDir = path.join(pluginRoot, "commands");
    if (fs.existsSync(commandsDir)) {
      targets.push({ dir: commandsDir, scanType: "commands", pluginId });
    }
  }

  const installedPluginsPath = path.join(
    os.homedir(), ".claude", "plugins", "installed_plugins.json"
  );

  if (fs.existsSync(installedPluginsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(installedPluginsPath, "utf-8"));
      const plugins = data.plugins as Record<string, Array<{ installPath?: string }>> || {};
      for (const [pluginKey, entries] of Object.entries(plugins)) {
        if (!Array.isArray(entries)) continue;
        // 取第一条（最新安装记录）
        const installPath = entries[0]?.installPath;
        if (!installPath || typeof installPath !== "string") continue;
        if (!fs.existsSync(installPath)) continue;
        addTargetsFromPluginRoot(installPath, pluginKey);
      }
      return targets;
    } catch {
      // 解析失败，继续走回退逻辑
    }
  }

  // 回退：直接遍历 marketplaces 目录
  const marketplacesDir = path.join(os.homedir(), ".claude", "plugins", "marketplaces");
  if (!fs.existsSync(marketplacesDir)) return targets;
  try {
    const marketplaces = fs.readdirSync(marketplacesDir);
    for (const marketplace of marketplaces) {
      const pluginsDir = path.join(marketplacesDir, marketplace, "plugins");
      if (!fs.existsSync(pluginsDir)) continue;
      for (const plugin of fs.readdirSync(pluginsDir)) {
        addTargetsFromPluginRoot(path.join(pluginsDir, plugin));
      }
    }
  } catch {
    // ignore
  }
  return targets;
}

function getInstalledSkillsDir(): string {
  return path.join(os.homedir(), ".agents", "skills");
}

function getClaudeSkillsDir(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

/**
 * Parse YAML front matter from an agent .md file.
 * Agent front matter uses `name:` and `description:` (may be multi-line block scalar `|`).
 */
function parseAgentFrontMatter(content: string): { name?: string; description?: string } {
  return parseSkillFrontMatter(content); // Reuse same parser — identical format
}

/**
 * Scan a plugin's `agents/` directory for sub-agent .md files.
 * Each agent file has YAML front matter with name and description.
 */
function scanPluginAgents(agentsDir: string, pluginId: string): SkillFile[] {
  const agents: SkillFile[] = [];
  if (!fs.existsSync(agentsDir)) return agents;
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const filePath = path.join(agentsDir, entry.name);
      const content = fs.readFileSync(filePath, "utf-8");
      const meta = parseAgentFrontMatter(content);
      const name = meta.name || entry.name.replace(/\.md$/, "");
      // description may be multi-line in the front matter; fall back to first non-front-matter line
      let description = meta.description;
      if (!description) {
        const bodyMatch = content.match(/^---[\s\S]+?---\r?\n([\s\S]+)/);
        const firstBodyLine = bodyMatch?.[1]?.split("\n")[0]?.trim() || "";
        description = firstBodyLine.startsWith("#")
          ? firstBodyLine.replace(/^#+\s*/, "")
          : firstBodyLine || `Agent: ${name}`;
      }
      agents.push({
        name,
        description,
        content,
        source: "agent",
        filePath,
        pluginId,
      });
    }
  } catch {
    // ignore read errors
  }
  return agents;
}

/**
 * Scan project-level skills from .claude/skills/{name}/SKILL.md.
 * Each subdirectory may contain a SKILL.md with optional YAML front matter.
 */
function scanProjectSkills(dir: string): SkillFile[] {
  const skills: SkillFile[] = [];
  if (!fs.existsSync(dir)) return skills;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skillMdPath = path.join(dir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;

      const content = fs.readFileSync(skillMdPath, "utf-8");
      const meta = parseSkillFrontMatter(content);
      const name = meta.name || entry.name;
      const description = meta.description || `Skill: /${name}`;

      skills.push({
        name,
        description,
        content,
        source: "project",
        filePath: skillMdPath,
      });
    }
  } catch {
    // ignore read errors
  }
  return skills;
}

function computeContentHash(content: string): string {
  return crypto.createHash("sha1").update(content, "utf8").digest("hex");
}

/**
 * Parse YAML front matter from SKILL.md content.
 * Extracts `name` (or `skill:` as alias) and `description` fields from the --- delimited block.
 */
function parseSkillFrontMatter(content: string): { name?: string; description?: string } {
  // Extract front matter between --- delimiters
  const fmMatch = content.match(/^---\r?\n([\s\S]+?)\r?\n---/);
  if (!fmMatch) return {};

  const frontMatter = fmMatch[1];
  const lines = frontMatter.split(/\r?\n/);
  const result: { name?: string; description?: string } = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match name: value  OR  skill: value (legacy alias)
    const nameMatch = line.match(/^(?:name|skill):\s*(.+)/);
    if (nameMatch) {
      result.name = nameMatch[1].trim();
      continue;
    }

    // Match description: | (multi-line YAML block scalar) — check FIRST
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
        result.description = descLines.filter(Boolean).join(" ");
      }
      continue;
    }

    // Match description: value (single-line)
    const descMatch = line.match(/^description:\s+(.+)/);
    if (descMatch) {
      result.description = descMatch[1].trim();
    }
  }
  return result;
}

/**
 * Scan a directory for installed skills.
 * Each skill is a subdirectory containing a SKILL.md with YAML front matter.
 * Used for both ~/.agents/skills/ and ~/.claude/skills/.
 */
function scanInstalledSkills(
  dir: string,
  installedSource: InstalledSource
): InstalledSkill[] {
  const skills: InstalledSkill[] = [];
  if (!fs.existsSync(dir)) return skills;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skillMdPath = path.join(dir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;

      const content = fs.readFileSync(skillMdPath, "utf-8");
      const meta = parseSkillFrontMatter(content);
      const name = meta.name || entry.name;
      const description = meta.description || `Installed skill: /${name}`;
      const contentHash = computeContentHash(content);

      skills.push({
        name,
        description,
        content,
        source: "installed",
        installedSource,
        contentHash,
        filePath: skillMdPath,
      });
    }
  } catch {
    // ignore read errors
  }
  return skills;
}

function resolveInstalledSkills(
  agentsSkills: InstalledSkill[],
  claudeSkills: InstalledSkill[],
  preferredSource: InstalledSource
): SkillFile[] {
  const all = [...agentsSkills, ...claudeSkills];
  const byName = new Map<string, InstalledSkill[]>();
  for (const skill of all) {
    const existing = byName.get(skill.name);
    if (existing) {
      existing.push(skill);
    } else {
      byName.set(skill.name, [skill]);
    }
  }

  const resolved: InstalledSkill[] = [];
  for (const group of byName.values()) {
    if (group.length === 1) {
      resolved.push(group[0]);
      continue;
    }

    const uniqueHashes = new Set(group.map((s) => s.contentHash));
    if (uniqueHashes.size === 1) {
      const preferred =
        group.find((s) => s.installedSource === preferredSource) || group[0];
      resolved.push(preferred);
      continue;
    }

    resolved.push(...group);
  }

  return resolved.map(({ contentHash: _contentHash, ...rest }) => rest);
}

function scanDirectory(
  dir: string,
  source: "global" | "project" | "plugin",
  prefix = ""
): SkillFile[] {
  const skills: SkillFile[] = [];
  if (!fs.existsSync(dir)) return skills;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Recurse into subdirectories (e.g. ~/.claude/commands/review/pr.md)
        const subPrefix = prefix ? `${prefix}:${entry.name}` : entry.name;
        skills.push(...scanDirectory(fullPath, source, subPrefix));
        continue;
      }

      if (!entry.name.endsWith(".md")) continue;
      const baseName = entry.name.replace(/\.md$/, "");
      const name = prefix ? `${prefix}:${baseName}` : baseName;
      const filePath = fullPath;
      const content = fs.readFileSync(filePath, "utf-8");
      const firstLine = content.split("\n")[0]?.trim() || "";
      const description = firstLine.startsWith("#")
        ? firstLine.replace(/^#+\s*/, "")
        : firstLine || `Skill: /${name}`;
      skills.push({ name, description, content, source, filePath });
    }
  } catch {
    // ignore read errors
  }
  return skills;
}

export async function GET(request: NextRequest) {
  try {
    // Accept optional cwd query param for project-level skills
    const cwd = request.nextUrl.searchParams.get("cwd") || undefined;
    const globalDir = getGlobalCommandsDir();
    const projectDir = getProjectCommandsDir(cwd);

    console.log(`[skills] Scanning global: ${globalDir} (exists: ${fs.existsSync(globalDir)})`);
    console.log(`[skills] Scanning project: ${projectDir} (exists: ${fs.existsSync(projectDir)})`);
    console.log(`[skills] HOME=${process.env.HOME}, homedir=${os.homedir()}`);

    const globalSkills = scanDirectory(globalDir, "global");
    const projectSkills = scanDirectory(projectDir, "project");

    // Scan project-level skills (.claude/skills/*/SKILL.md)
    const projectSkillsDir = getProjectSkillsDir(cwd);
    console.log(`[skills] Scanning project skills: ${projectSkillsDir} (exists: ${fs.existsSync(projectSkillsDir)})`);
    const projectLevelSkills = scanProjectSkills(projectSkillsDir);
    console.log(`[skills] Found ${projectLevelSkills.length} project-level skills`);

    // Deduplicate: project commands take priority over project skills with the same name
    const projectCommandNames = new Set(projectSkills.map((s) => s.name));
    const dedupedProjectSkills = projectLevelSkills.filter(
      (s) => !projectCommandNames.has(s.name)
    );

    const agentsSkillsDir = getInstalledSkillsDir();
    const claudeSkillsDir = getClaudeSkillsDir();
    console.log(`[skills] Scanning installed: ${agentsSkillsDir} (exists: ${fs.existsSync(agentsSkillsDir)})`);
    console.log(`[skills] Scanning installed: ${claudeSkillsDir} (exists: ${fs.existsSync(claudeSkillsDir)})`);
    const agentsSkills = scanInstalledSkills(agentsSkillsDir, "agents");
    const claudeSkills = scanInstalledSkills(claudeSkillsDir, "claude");
    const preferredInstalledSource: InstalledSource =
      agentsSkills.length === claudeSkills.length
        ? "claude"
        : agentsSkills.length > claudeSkills.length
          ? "agents"
          : "claude";
    console.log(
      `[skills] Installed counts: agents=${agentsSkills.length}, claude=${claudeSkills.length}, preferred=${preferredInstalledSource}`
    );
    const installedSkills = resolveInstalledSkills(
      agentsSkills,
      claudeSkills,
      preferredInstalledSource
    );

    // Scan installed plugin skills（同时支持 skills/SKILL.md 和 commands/*.md 两种格式）
    // AND sub-agents from plugins' agents/ directories
    const pluginScanTargets = getPluginScanTargets();
    console.log(`[skills] Plugin scan targets: ${pluginScanTargets.length}`, pluginScanTargets.map(t => `${t.scanType}:${t.dir}`));
    const pluginSkills: SkillFile[] = [];
    const pluginAgents: SkillFile[] = [];

    for (const target of pluginScanTargets) {
      if (target.scanType === "skills") {
        // SKILL.md 格式 → 用 scanProjectSkills，再把 source 改为 plugin
        const found = scanProjectSkills(target.dir).map(s => ({ ...s, source: "plugin" as const }));
        pluginSkills.push(...found);
      } else {
        // 平铺 .md 格式 → 用 scanDirectory
        pluginSkills.push(...scanDirectory(target.dir, "plugin"));
      }

      // Also scan agents/ sibling directory (same plugin root)
      if (target.pluginId) {
        const pluginRoot = path.dirname(target.dir);
        const agentsDir = path.join(pluginRoot, "agents");
        if (fs.existsSync(agentsDir)) {
          const agents = scanPluginAgents(agentsDir, target.pluginId);
          // Avoid duplicates (same plugin root may yield multiple targets)
          for (const agent of agents) {
            if (!pluginAgents.some(a => a.filePath === agent.filePath)) {
              pluginAgents.push(agent);
            }
          }
        }
      }
    }

    // If no pluginId-aware targets were produced (fallback path), scan agents from installPaths directly
    if (pluginScanTargets.every(t => !t.pluginId)) {
      const installedPluginsPath2 = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
      if (fs.existsSync(installedPluginsPath2)) {
        try {
          const data2 = JSON.parse(fs.readFileSync(installedPluginsPath2, "utf-8"));
          const plugins2 = data2.plugins as Record<string, Array<{ installPath?: string }>> || {};
          for (const [pluginKey, entries] of Object.entries(plugins2)) {
            if (!Array.isArray(entries)) continue;
            const installPath = entries[0]?.installPath;
            if (!installPath || !fs.existsSync(installPath)) continue;
            const agentsDir = path.join(installPath, "agents");
            const agents = scanPluginAgents(agentsDir, pluginKey);
            for (const agent of agents) {
              if (!pluginAgents.some(a => a.filePath === agent.filePath)) {
                pluginAgents.push(agent);
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }

    const all = [...globalSkills, ...projectSkills, ...dedupedProjectSkills, ...installedSkills, ...pluginSkills, ...pluginAgents];
    console.log(`[skills] Found: global=${globalSkills.length}, project=${projectSkills.length}, projectSkills=${dedupedProjectSkills.length}, installed=${installedSkills.length}, plugin=${pluginSkills.length}, agents=${pluginAgents.length}`);

    // Merge SDK slash commands if available
    try {
      const { getCachedCommands } = await import('@/lib/agent-sdk-capabilities');
      const sdkCommands = getCachedCommands('env');
      if (sdkCommands.length > 0) {
        const existingNames = new Set(all.map(s => s.name));
        for (const cmd of sdkCommands) {
          if (!existingNames.has(cmd.name)) {
            all.push({
              name: cmd.name,
              description: cmd.description || `SDK command: /${cmd.name}`,
              content: '', // SDK commands don't have local content
              source: 'sdk' as typeof all[number]['source'],
              filePath: '',
            });
          }
        }
        console.log(`[skills] Added ${sdkCommands.length} SDK commands (${sdkCommands.filter(c => !existingNames.has(c.name)).length} unique)`);
      }
    } catch {
      // SDK capabilities not available, skip
    }

    return NextResponse.json({ skills: all });
  } catch (error) {
    console.error('[skills] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load skills" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, content, scope, cwd } = body as {
      name: string;
      content: string;
      scope: "global" | "project";
      cwd?: string;
    };

    if (!name || typeof name !== "string") {
      return NextResponse.json(
        { error: "Skill name is required" },
        { status: 400 }
      );
    }

    // Sanitize name: only allow alphanumeric, hyphens, underscores
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "-");
    if (!safeName) {
      return NextResponse.json(
        { error: "Invalid skill name" },
        { status: 400 }
      );
    }

    const dir =
      scope === "project" ? getProjectCommandsDir(cwd) : getGlobalCommandsDir();

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const filePath = path.join(dir, `${safeName}.md`);
    if (fs.existsSync(filePath)) {
      return NextResponse.json(
        { error: "A skill with this name already exists" },
        { status: 409 }
      );
    }

    fs.writeFileSync(filePath, content || "", "utf-8");

    const firstLine = (content || "").split("\n")[0]?.trim() || "";
    const description = firstLine.startsWith("#")
      ? firstLine.replace(/^#+\s*/, "")
      : firstLine || `Skill: /${safeName}`;

    return NextResponse.json(
      {
        skill: {
          name: safeName,
          description,
          content: content || "",
          source: scope || "global",
          filePath,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create skill" },
      { status: 500 }
    );
  }
}
