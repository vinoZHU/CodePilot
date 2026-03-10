'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BrainIcon,
  ArrowRight01Icon,
} from "@hugeicons/core-free-icons";
import { cn } from '@/lib/utils';

interface ThinkingBlockProps {
  /** Accumulated thinking text */
  content: string;
  /** Whether still actively streaming thinking content */
  isStreaming?: boolean;
  /** Default open state */
  defaultOpen?: boolean;
}

export function ThinkingBlock({ content, isStreaming = false, defaultOpen = false }: ThinkingBlockProps) {
  const [open, setOpen] = useState(defaultOpen);

  if (!content) return null;

  const preview = content
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

  return (
    <div className="my-1 rounded-md border border-violet-500/20 bg-violet-500/[0.03]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/20 transition-colors rounded-md"
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          className={cn(
            "h-3 w-3 shrink-0 text-violet-400/70 transition-transform duration-200",
            open && "rotate-90"
          )}
        />
        <HugeiconsIcon icon={BrainIcon} className="h-3.5 w-3.5 shrink-0 text-violet-400/70" />
        <span className="text-violet-400/70 font-medium shrink-0">
          {isStreaming ? 'Thinking…' : 'Thought'}
        </span>
        {!open && preview && (
          <span className="font-mono text-muted-foreground/40 truncate">{preview}</span>
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
            <div className="px-3 pb-2 pt-0">
              <pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground/70 font-mono leading-relaxed max-h-96 overflow-y-auto">
                {content}
              </pre>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
