#!/usr/bin/env bun

// Standalone relay entry point (`bun socket`). The relay is normally embedded in
// the MCP server (server.ts calls startRelay), so this is only needed when you
// want to run the relay on its own — e.g. to share one relay across machines.
import { startRelay } from "./socket";

if (!startRelay(Number(process.env.PORT) || 3055)) {
  console.error(
    `Port ${Number(process.env.PORT) || 3055} is already in use — a relay is likely already running.`
  );
  process.exit(1);
}
