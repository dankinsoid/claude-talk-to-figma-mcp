// @ai-generated(guided)
// Bidirectional map between canonical Figma node ids and short counter ids
// (n0, n1, ...) substituted into compact read-tool output to cut token cost: a
// nested instance id like "I8782:344721;3063:34762;3063:40330;3063:40206" becomes
// "n7". A given canonical id always maps back to the same short id within a
// namespace.
//
// The map is namespaced by channel (stable per Figma file + machine, persisted
// by the plugin in document pluginData) and persisted to disk, so short ids
// survive MCP-server restarts and never collide across files. Figma node ids
// are document-stable forever, so a loaded map can be stale-unused but never
// wrong; the TTL below is disk-growth hygiene, not a correctness bound. The
// hot path stays on in-memory Maps — disk is touched only on namespace load
// and via a debounced flush.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

const DIR = join(tmpdir(), "talk-to-figma", "idmap");
const TTL_MS = 48 * 60 * 60 * 1000;
// Next-tick, not a real delay: renumberIds assigns a whole read's ids in one
// synchronous burst, so a 0ms timer still coalesces them into a single write
// while shrinking the lose-on-kill window to ~nothing.
const FLUSH_DELAY_MS = 0;
// On load the counter skips ahead so short ids minted after the last flush of
// a killed process (SIGKILL/crash — flush handlers can't run) are never
// reassigned to different nodes: a stale id from the agent's context then
// fails loudly in resolveOne instead of silently resolving to the wrong node.
const COUNTER_GAP = 100;

let shortToFull = new Map<string, string>();
let fullToShort = new Map<string, string>();
let counter = 0;
// Persistence target for the current namespace; null until a channel is joined
// (no reads can happen before join — commands require a channel).
let filePath: string | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const SHORT_RE = /^n\d+$/;

function fileFor(channel: string): string {
  return join(DIR, channel.replace(/[^\w.-]/g, "_") + ".json");
}

/**
 * Switch the map to the given channel's namespace: flush the previous one,
 * load this channel's persisted map (if any), and prune expired files.
 * Call on every successful channel join; a re-join to the same channel is a no-op.
 */
export function setIdMapNamespace(channel: string): void {
  const next = fileFor(channel);
  if (filePath === next) return;
  flushNow();
  filePath = next;
  shortToFull = new Map();
  fullToShort = new Map();
  counter = 0;
  try {
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    if (data && typeof data.counter === "number" && data.ids) {
      counter = data.counter + COUNTER_GAP;
      for (const [full, s] of Object.entries(data.ids as Record<string, string>)) {
        fullToShort.set(full, s);
        shortToFull.set(s, full);
      }
    }
  } catch {
    // Missing or corrupt file → fresh map.
  }
  pruneExpired();
}

// Drop idmap files untouched for TTL_MS (flushes refresh mtime, so files of
// actively-used documents survive indefinitely). Skips the current namespace.
function pruneExpired(): void {
  try {
    const cutoff = Date.now() - TTL_MS;
    for (const name of readdirSync(DIR)) {
      const p = join(DIR, name);
      if (p === filePath || !name.endsWith(".json")) continue;
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        // Raced with another process — ignore.
      }
    }
  } catch {
    // Directory missing yet — nothing to prune.
  }
}

function scheduleFlush(): void {
  if (!filePath || flushTimer) return;
  flushTimer = setTimeout(flushNow, FLUSH_DELAY_MS);
}

// Write the map to disk, first merging entries another MCP-server process may
// have flushed for the same file (two agent sessions on one document); on a
// short-id conflict this process's assignment wins — the other process keeps
// its own copy in memory, so neither session misresolves while running.
function flushNow(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!filePath) return;
  try {
    mkdirSync(DIR, { recursive: true });
    try {
      const disk = JSON.parse(readFileSync(filePath, "utf8"));
      if (disk && disk.ids) {
        for (const [full, s] of Object.entries(disk.ids as Record<string, string>)) {
          if (!fullToShort.has(full) && !shortToFull.has(s)) {
            fullToShort.set(full, s);
            shortToFull.set(s, full);
          }
        }
        if (typeof disk.counter === "number" && disk.counter > counter) counter = disk.counter;
      }
    } catch {
      // No previous file or unreadable — write ours as-is.
    }
    const ids: Record<string, string> = {};
    for (const [full, s] of fullToShort) ids[full] = s;
    // pid-suffixed temp + rename: atomic, and concurrent processes don't clobber
    // each other's in-flight writes.
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ counter, ids }));
    renameSync(tmp, filePath);
  } catch {
    // Persistence is best-effort; the in-memory map keeps the session working.
  }
}

// Catch entries created in the last FLUSH_DELAY_MS before shutdown. 'exit'
// covers graceful exits only; signals don't emit it under default handling,
// and the MCP host stops servers via SIGTERM — handle both explicitly.
process.on("exit", flushNow);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    flushNow();
    process.exit(sig === "SIGINT" ? 130 : 143);
  });
}

function shorten(fullId: string): string {
  if (SHORT_RE.test(fullId)) return fullId; // already short — keep renumberIds idempotent
  let s = fullToShort.get(fullId);
  if (!s) {
    s = "n" + counter++;
    fullToShort.set(fullId, s);
    shortToFull.set(s, fullId);
    scheduleFlush();
  }
  return s;
}

/**
 * Deep-rewrite every `id` field in a compact read-tool result to its short form.
 * Mutates and returns `node`. Apply only to node-tree outputs whose ids are later
 * consumed as nodeId/parentId — not to tools with their own id namespaces
 * (styles, annotations), whose short ids would have no resolve path back.
 */
export function renumberIds<T>(node: T): T {
  if (Array.isArray(node)) {
    node.forEach(renumberIds);
    return node;
  }
  if (node && typeof node === "object") {
    const o = node as any;
    if (typeof o.id === "string") o.id = shorten(o.id);
    for (const k in o) {
      if (o[k] && typeof o[k] === "object") renumberIds(o[k]);
    }
    return node;
  }
  return node;
}

function resolveOne(id: string): string {
  if (!SHORT_RE.test(id)) return id; // real Figma id — pass through
  const full = shortToFull.get(id);
  if (!full) {
    throw new Error(
      `Unknown short id "${id}" — re-fetch the node; this id is not in the current file's map (expired or from another document).`
    );
  }
  return full;
}

// Param keys whose values are node/component-id references — every such key
// across all tools, so any request accepts short ids interchangeably with full
// ids. Free-text params (text, name, characters) and foreign id namespaces
// (annotationId, categoryId) are deliberately excluded so a literal value like
// "n5" is untouched. Non-short values pass through unchanged regardless.
const ID_KEYS = new Set([
  "nodeId",
  "nodeIds",
  "root",
  "parentId",
  "targetNodeIds",
  "sourceInstanceId",
  "componentId",
  "startNodeId",
  "endNodeId",
  "connectorId",
  "destinationId", // set_reactions: NODE-action target, nested in actions[]
  "instanceNodeId", // get_instance_overrides: server renames tool's nodeId before send
  "tableId", // edit_table
]);

/**
 * Resolve short ids back to canonical ids in outgoing command params, keyed: only
 * values under an ID_KEYS key are touched (recursing through arrays/objects so a
 * nested {nodeId} inside a text-edit array is reached). Mutates and returns value.
 */
export function resolveShortIdsInParams(value: any, key = ""): any {
  if (Array.isArray(value)) return value.map((v) => resolveShortIdsInParams(v, key));
  if (value && typeof value === "object") {
    for (const k in value) value[k] = resolveShortIdsInParams(value[k], k);
    return value;
  }
  if (typeof value === "string" && ID_KEYS.has(key)) return resolveOne(value);
  return value;
}
