"use client";

import { PluginsManager } from "@/components/plugins/PluginsManager";

export default function PluginsPage() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-hidden p-6 flex flex-col min-h-0">
        <PluginsManager />
      </div>
    </div>
  );
}
