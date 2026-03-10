'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BotIcon,
  ArrowRight01Icon,
  Loading02Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { cn } from '@/lib/utils';
import type { AgentCallInfo } from '@/types';

interface AgentCallBlockProps {
  agentCalls: AgentCallInfo[];
  isStreaming?: boolean;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function AgentRow({ agent }: { agent: AgentCallInfo }) {
  const [open, setOpen] = useState(false);
  const isRunning = agent.finished_at === undefined;
  const duration = agent.finished_at ? agent.finished_at - agent.started_at : undefined;

  return (
    <div className="border-l-2 border-orange-500/30 rounded-r-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs text-muted-foreground hover:bg-muted/20 transition-colors"
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          className={cn(
            "h-3 w-3 shrink-0 text-orange-400/70 transition-transform duration-200",
            open && "rotate-90"
          )}
        />
        <HugeiconsIcon
          icon={BotIcon}
          className="h-3.5 w-3.5 shrink-0 text-orange-400"
        />
        <span className="font-mono text-orange-400/90 truncate flex-1">
          {agent.agent_type}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          {duration !== undefined && (
            <span className="text-muted-foreground/50 text-[11px]">{formatDuration(duration)}</span>
          )}
          {isRunning ? (
            <HugeiconsIcon icon={Loading02Icon} className="h-3.5 w-3.5 animate-spin text-orange-400/70" />
          ) : (
            <HugeiconsIcon icon={CheckmarkCircle02Icon} className="h-3.5 w-3.5 text-green-500" />
          )}
        </div>
      </button>

      <AnimatePresence initial={false}>
        {open && agent.last_message && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="px-3 pb-2 pt-0">
              <pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground/70 font-mono leading-relaxed max-h-48 overflow-y-auto bg-muted/30 rounded p-2">
                {agent.last_message.slice(0, 2000)}
              </pre>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function AgentCallBlock({ agentCalls, isStreaming = false }: AgentCallBlockProps) {
  const [open, setOpen] = useState(true);

  if (agentCalls.length === 0) return null;

  const runningCount = agentCalls.filter(a => a.finished_at === undefined).length;
  const doneCount = agentCalls.length - runningCount;
  const summaryParts: string[] = [];
  if (runningCount > 0) summaryParts.push(`${runningCount} running`);
  if (doneCount > 0) summaryParts.push(`${doneCount} completed`);

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 py-1 text-xs rounded-sm hover:bg-muted/30 transition-colors"
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          className={cn(
            "h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform duration-200",
            open && "rotate-90"
          )}
        />
        <span className="inline-flex items-center justify-center rounded bg-orange-500/20 px-1.5 py-0.5 text-[10px] font-medium leading-none text-orange-400 tabular-nums">
          {agentCalls.length}
        </span>
        <span className="text-muted-foreground/60 truncate">
          {summaryParts.join(' · ')} {agentCalls.length === 1 ? 'sub-agent' : 'sub-agents'}
        </span>
        {runningCount > 0 && isStreaming && (
          <HugeiconsIcon icon={Loading02Icon} className="h-3 w-3 animate-spin text-orange-400/60 ml-auto" />
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="ml-1.5 mt-0.5 space-y-0.5">
              {agentCalls.map((agent) => (
                <AgentRow key={agent.agent_id} agent={agent} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
