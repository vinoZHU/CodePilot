import type { NextConfig } from "next";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

// output: 'standalone' is only needed for the Electron production build.
// In dev mode it causes 500 errors (required-server-files.json missing) and
// Turbopack distDirRoot panics. Use the phase-aware function form so Next.js
// passes the correct lifecycle phase regardless of NODE_ENV in the shell.
const nextConfigFn = (phase: string): NextConfig => {
  const isDev = phase === "phase-development-server";
  return {
    output: isDev ? undefined : "standalone",
    serverExternalPackages: ["better-sqlite3", "discord.js", "@discordjs/ws", "zlib-sync"],
    env: {
      NEXT_PUBLIC_APP_VERSION: pkg.version,
    },
  };
};

export default nextConfigFn;
