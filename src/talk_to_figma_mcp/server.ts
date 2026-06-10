#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";
import { writeFile, readFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { shapeNode } from "./shape.js";
import { renumberIds, resolveShortIdsInParams } from "./idmap.js";
import { writeNodeUnion, describeNodeSchema, listNodeTypes, validateEditValue, NODE_TYPES, type NodeType } from "./write_schema.js";

// Define TypeScript interfaces for Figma responses
interface FigmaResponse {
  id: string;
  result?: any;
  error?: string;
}

// Define interface for command progress updates
interface CommandProgressUpdate {
  type: 'command_progress';
  commandId: string;
  commandType: string;
  status: 'started' | 'in_progress' | 'completed' | 'error';
  progress: number;
  totalItems: number;
  processedItems: number;
  currentChunk?: number;
  totalChunks?: number;
  chunkSize?: number;
  message: string;
  payload?: any;
  timestamp: number;
}

// Update the getInstanceOverridesResult interface to match the plugin implementation
interface getInstanceOverridesResult {
  success: boolean;
  message: string;
  sourceInstanceId: string;
  mainComponentId: string;
  overridesCount: number;
}

interface setInstanceOverridesResult {
  success: boolean;
  message: string;
  totalCount?: number;
  results?: Array<{
    success: boolean;
    instanceId: string;
    instanceName: string;
    appliedCount?: number;
    message?: string;
  }>;
}

// Custom logging functions that write to stderr instead of stdout to avoid being captured
const logger = {
  info: (message: string) => process.stderr.write(`[INFO] ${message}\n`),
  debug: (message: string) => process.stderr.write(`[DEBUG] ${message}\n`),
  warn: (message: string) => process.stderr.write(`[WARN] ${message}\n`),
  error: (message: string) => process.stderr.write(`[ERROR] ${message}\n`),
  log: (message: string) => process.stderr.write(`[LOG] ${message}\n`)
};

// WebSocket connection and request tracking
let ws: WebSocket | null = null;
const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  lastActivity: number; // Add timestamp for last activity
}>();

// Track which channel each client is in
let currentChannel: string | null = null;

// Create MCP server
const server = new McpServer({
  name: "TalkToFigmaMCP",
  version: "1.0.0",
});

// Add command line argument parsing
const args = process.argv.slice(2);
const serverArg = args.find(arg => arg.startsWith('--server='));
const serverUrl = serverArg ? serverArg.split('=')[1] : 'localhost';
const WS_URL = serverUrl === 'localhost' ? `ws://${serverUrl}` : `wss://${serverUrl}`;

// Opt-in for routing large read-tool output to a file instead of the LLM
// context. Returning a path keeps big payloads out of the token budget.
const saveParams = {
  saveToFile: z
    .boolean()
    .optional()
    .describe(
      "If true, write the full result to a file and return only its path + byte size instead of the payload. Use for large outputs to keep them out of the LLM context."
    ),
  outputPath: z
    .string()
    .optional()
    .describe(
      "Explicit file path to write the result to (implies saveToFile). Parent dirs are created. Defaults to an auto-named file under the OS temp dir."
    ),
};

type SaveArgs = { saveToFile?: boolean; outputPath?: string };

// Monotonic suffix so two writes within the same millisecond never collide.
let outputFileSeq = 0;

// Cap on a single inline image (raw decoded bytes). Above this we spill to a
// file — base64 in the context is ~1.3x this and very expensive.
const INLINE_MAX_BYTES = 1024 * 1024;

// Cap on a single asset (image/SVG) imported via a URL in a write/edit payload.
// The bytes ride the local WebSocket to the plugin base64-encoded, so a runaway
// URL would bloat the message; reject loudly instead.
const IMPORT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Walk a write/edit payload and resolve external asset URLs into inline data the
 * plugin can build without network access (its manifest only allows the relay):
 *   • a paint `{imageUrl}`  → fetch bytes → `{imageBytes: <base64>}` (plugin
 *     calls figma.createImage and fills in the imageHash)
 *   • an SVG spec `{svgUrl}` → fetch text → `{svg: "<svg…>"}`
 * Mutates in place. A fetch failure is recorded as `imageError`/`svgError` on the
 * same object so the plugin can surface it as a per-node/per-edit error instead
 * of failing the whole batch. Returns the same value for convenience.
 */
async function resolveExternalAssets(value: any): Promise<any> {
  if (Array.isArray(value)) {
    await Promise.all(value.map((v) => resolveExternalAssets(v)));
    return value;
  }
  if (!value || typeof value !== "object") return value;

  if (typeof value.imageUrl === "string") {
    const url = value.imageUrl;
    delete value.imageUrl;
    try {
      value.imageBytes = await fetchAssetBase64(url);
      if (value.type == null) value.type = "IMAGE";
    } catch (err) {
      value.imageError = err instanceof Error ? err.message : String(err);
    }
  }
  if (typeof value.svgUrl === "string" && typeof value.svg !== "string") {
    const url = value.svgUrl;
    delete value.svgUrl;
    try {
      value.svg = await fetchAssetText(url);
    } catch (err) {
      value.svgError = err instanceof Error ? err.message : String(err);
    }
  }

  await Promise.all(Object.keys(value).map((k) => resolveExternalAssets(value[k])));
  return value;
}

async function fetchAssetBytes(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > IMPORT_MAX_BYTES) {
    throw new Error(`asset ${url} is ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB, over the ${IMPORT_MAX_BYTES / 1024 / 1024}MB import cap`);
  }
  return buf;
}

async function fetchAssetBase64(url: string): Promise<string> {
  return (await fetchAssetBytes(url)).toString("base64");
}

async function fetchAssetText(url: string): Promise<string> {
  return (await fetchAssetBytes(url)).toString("utf8");
}

async function writeOutputFile(
  baseName: string,
  ext: string,
  data: string | Buffer,
  outputPath?: string
): Promise<{ path: string; bytes: number }> {
  const safeBase = baseName.replace(/[^a-zA-Z0-9_-]/g, "-");
  const target = outputPath
    ? outputPath
    : join(tmpdir(), "talk-to-figma", `${safeBase}-${Date.now()}-${outputFileSeq++}.${ext}`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
  const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
  return { path: target, bytes };
}

// Above this inline-return size, a result is spilled to a temp file by default
// so a huge payload never floods the model context. ~25k tokens of JSON.
const AUTO_SAVE_BYTES = 100_000;

// Render a JSON payload either inline or, when save is requested, to a file —
// returning a single content block (the path pointer when saved). Oversized
// payloads auto-spill to a temp file even without an explicit save request;
// if that write fails, they fall back to inline so the call still returns data.
async function jsonContent(payload: any, save: SaveArgs, baseName: string) {
  const text = JSON.stringify(payload);
  if (save?.saveToFile || save?.outputPath) {
    const { path, bytes } = await writeOutputFile(baseName, "json", text, save.outputPath);
    return { type: "text" as const, text: `Saved ${bytes} bytes of JSON to ${path}` };
  }
  if (Buffer.byteLength(text) > AUTO_SAVE_BYTES) {
    try {
      const { path, bytes } = await writeOutputFile(baseName, "json", text);
      return {
        type: "text" as const,
        text: `Output too large to return inline (${bytes} bytes); saved to ${path}. Read it from there, or re-request with a lower depth to shrink the result.`,
      };
    } catch {
      // Write failed — return inline rather than nothing.
    }
  }
  return { type: "text" as const, text };
}

// Render a plain-text payload (e.g. glob lines) inline, or spill to a file when
// requested or oversized — mirroring jsonContent but without JSON encoding.
async function textContent(text: string, summary: string, save: SaveArgs, baseName: string) {
  if (save?.saveToFile || save?.outputPath) {
    const { path, bytes } = await writeOutputFile(baseName, "txt", text, save.outputPath);
    return { type: "text" as const, text: `Saved ${bytes} bytes (${summary}) to ${path}` };
  }
  if (Buffer.byteLength(text) > AUTO_SAVE_BYTES) {
    try {
      const { path, bytes } = await writeOutputFile(baseName, "txt", text);
      return {
        type: "text" as const,
        text: `Output too large to return inline (${bytes} bytes, ${summary}); saved to ${path}. Read it from there, or narrow with type/name/depth.`,
      };
    } catch {
      // Write failed — return inline rather than nothing.
    }
  }
  return { type: "text" as const, text };
}

// Selection Tool
server.tool(
  "get_selection",
  "Get information about the current selection in Figma",
  { ...saveParams },
  async ({ saveToFile, outputPath }: any) => {
    try {
      const result = await sendCommandToFigma("get_selection");
      return {
        content: [await jsonContent(renumberIds(result), { saveToFile, outputPath }, "selection")]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting selection: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Shared shaping params for read tools. Defaults give a compact, "zoomable"
// view: structure + text + integer boxes, 2 levels deep, icons collapsed.
// Drill deeper by re-calling with a child nodeId and/or a larger depth.
const shapeParams = {
  depth: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Levels of children below the requested node to expand (default 6). Deeper nodes become stubs with {childCount, more:true}; re-request that id to zoom in. Raise to see more at once, lower for a terser overview."),
  collapseIcons: z
    .boolean()
    .optional()
    .describe("Collapse icon-like subtrees (no text, vector leaves) to a single ICON node with more:true (default true)."),
  collapseRepeats: z
    .boolean()
    .optional()
    .describe("Collapse repeated instances of the same component: the first renders in full, later copies become a stub with their props/text and more:true (default true)."),
  cull: z
    .boolean()
    .optional()
    .describe("Drop nodes that render nowhere — fully clipped out by an ancestor's clipsContent ({id, clipped:true}) or fully covered by an opaque sibling above ({id, occluded:true}). Default true."),
};

type ShapeArgs = {
  depth?: number;
  collapseIcons?: boolean;
  collapseRepeats?: boolean;
  cull?: boolean;
};

// Figma names can be whole paragraphs (notes, annotations carry their full text
// as the layer name), which otherwise dominate a glob line or an ancestor
// breadcrumb. Cap them in compact output; the id is still the handle for tools.
const NAME_MAX = 40;
function truncName(name: string): string {
  if (typeof name !== "string" || name.length <= NAME_MAX) return name;
  return name.slice(0, NAME_MAX - 1) + "…";
}

// The compact node-reference token shared by every flat listing — glob/grep/
// query lines and read_node's ancestor breadcrumb: `id:"name".TYPE`, name
// truncated and JSON-quoted/escaped. One formatter so the shape stays uniform.
function fmtNodeRef(id: string, name: string, type: string): string {
  return `${id}:${JSON.stringify(truncName(name))}.${type}`;
}

// Read Node Tool — the Read tool for the canvas. Variadic; reads the selection
// when no ids are given. Compact subtree by default, full node props with raw.
server.tool(
  "read_node",
  "Read Figma nodes — the Read tool for the canvas. Pass `nodeIds` (one or many); omit it to read the current selection. Returns one entry per node. Default (compact) gives each node's subtree in a minimal, low-token field set (id, name, type, color/gradient, opacity, box or autoLayout, text); children expand to `depth` levels and deeper nodes become {childCount, more:true} stubs — re-request a stub's id or raise depth to zoom in. Each requested node also carries `ancestors`: a root-first breadcrumb (page → ... → immediate parent) of `id:\"name\".TYPE` tokens (same form as glob lines) so you know what contains it without a separate glob — those ids are short counters too, so pass one back to zoom OUT. Set `raw:true` for the full, unfiltered JSON_REST_V1 of each node with ALL properties but the children array stripped (use when the compact view drops a field you need); in raw mode depth/collapse/cull are ignored — raw is always one node, all props, no children. Large outputs auto-spill to a file. Node ids are short counters (n0, n1, ...) standing in for canonical Figma ids — pass them to any tool. Locate ids with glob_nodes/grep_nodes first, then read_node to inspect properties.",
  {
    nodeIds: z
      .array(z.string())
      .optional()
      .describe("Node ids to read (short n0,... or canonical). Omit to read the current selection."),
    raw: z
      .boolean()
      .optional()
      .describe("Return each node's full unfiltered props (children stripped) instead of the compact subtree. Ignores depth/collapse/cull. Default false."),
    ...shapeParams,
    ...saveParams,
  },
  async ({ nodeIds, raw, depth, collapseIcons, collapseRepeats, cull, saveToFile, outputPath }: any) => {
    try {
      // Resolve targets: explicit ids, else fall back to the current selection.
      let ids: string[] = Array.isArray(nodeIds) ? nodeIds : [];
      if (ids.length === 0) {
        const sel: any = await sendCommandToFigma("get_selection");
        ids = (sel?.selection ?? []).map((n: any) => n.id);
      }
      if (ids.length === 0) {
        return {
          content: [{ type: "text", text: "No nodes to read: no nodeIds given and the selection is empty." }],
        };
      }

      if (raw) {
        // Raw keeps canonical Figma ids untouched; echo the requested id so the
        // agent sees the short->canonical mapping instead of an unexplained swap.
        const nodes = await Promise.all(
          ids.map(async (nodeId) => ({
            requestedId: nodeId,
            node: await sendCommandToFigma("read_node_raw", { nodeId }),
          }))
        );
        return {
          content: [await jsonContent(nodes, { saveToFile, outputPath }, "node-raw")],
        };
      }

      const opts: ShapeArgs = { depth, collapseIcons, collapseRepeats, cull };
      const infos = await Promise.all(
        ids.map((nodeId) => sendCommandToFigma("read_node", { nodeId }))
      );
      // Renumber across the whole batch so short ids share one counter space.
      const shaped = renumberIds(infos.map((info) => shapeNode(info, opts)));
      // Collapse the ancestor breadcrumb from {id,name,type} objects to the same
      // compact `id:"name".TYPE` token glob/grep use (runs after renumber so the
      // ids are already short). Cuts the per-call breadcrumb roughly in half.
      for (const node of shaped) {
        if (Array.isArray(node?.ancestors)) {
          node.ancestors = node.ancestors.map((a: any) => fmtNodeRef(a.id, a.name, a.type));
        }
      }
      return {
        content: [await jsonContent(shaped, { saveToFile, outputPath }, "node-info")],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error reading node(s): ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Glob Tool — flat, grep-friendly index of a subtree
server.tool(
  "glob_nodes",
  "List nodes under a root by type and/or name glob, one per line as `id:\"name\".TYPE @parent [x,y wxh]` — a flat, grep-friendly index of a subtree (the Figma analog of glob / `ls -R`). The `@parent` is the immediate container's short id (location without drawing the tree; pass it to read_node to see surroundings). The trailing `[x,y wxh]` is the node's ABSOLUTE bounding box (omitted with `bbox:false`, or when a node has no geometry). Filters: `type` (a node type, an array, or \"*\"/omit for any); `name` (a shell-style glob over the node's OWN name: `*` = any run, `?` = one char; omit for any — matches names only, not paths, since Figma names contain slashes); and `within` (an absolute rect — keep only nodes intersecting it, e.g. to glob a region; get its coords from a prior bbox). `root` is the node id to search under (default: current page); descends through every container regardless of match (any-depth search), with `depth` capping how deep. Ids (including `@parent`) are short counters (n0, n1, ...) — feed any straight into read/edit tools.",
  {
    root: z
      .string()
      .optional()
      .describe("Node id to search under. Defaults to the current page. Accepts short ids (n0, ...)."),
    name: z
      .string()
      .optional()
      .describe("Shell-style glob matched against each node's own name (* = any run, ? = one char). Case-insensitive. Omit to match any name."),
    type: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("Node type filter: a single type (e.g. \"TEXT\"), an array ([\"TEXT\",\"INSTANCE\"]), or \"*\"/omit for any. Case-insensitive."),
    depth: z
      .number()
      .optional()
      .describe("Max depth below root to descend (root's direct children = 1). Omit for unlimited."),
    bbox: z
      .boolean()
      .optional()
      .describe("Append each hit's absolute bounding box as [x,y wxh]. Default true; pass false to drop it and save tokens."),
    within: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .optional()
      .describe("Absolute rectangle; keep only nodes whose bounding box intersects it. Coordinates are absolute (same space as the [x,y wxh] output). Use to glob a visual region."),
    ...saveParams,
  },
  async ({ root, name, type, depth, bbox, within, saveToFile, outputPath }: any) => {
    try {
      const result: any = await sendCommandToFigma("glob_nodes", { root, name, type, depth, bbox, within });
      // renumberIds shortens each match's `id`; parentId shares the same map, so
      // a hit and its parent get the same short id (idempotent shortening).
      const matches = renumberIds(result?.matches || []);
      const lines = matches
        .map((m: any) => {
          const parent = m.parentId ? renumberIds({ id: m.parentId }).id : null;
          const box = m.bbox ? ` [${m.bbox.x},${m.bbox.y} ${m.bbox.w}x${m.bbox.h}]` : "";
          return `${fmtNodeRef(m.id, m.name, m.type)}${parent ? ` @${parent}` : ""}${box}`;
        })
        .join("\n");
      const text = lines || "(no matches)";
      return {
        content: [await textContent(text, `${matches.length} nodes`, { saveToFile, outputPath }, "glob")],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error globbing nodes: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Grep Tool — regex search over text-node content within a subtree
server.tool(
  "grep_nodes",
  "Search the TEXT content of a subtree by regex — the Figma analog of grep. Tests each TEXT node's `characters` LINE BY LINE (Figma text is multi-line) and returns hits one per line as `id:\"name\".TEXT @parent L<n>: <line>`, where `L<n>` is the 1-based line within that text node and `<line>` is the matching line (long lines are windowed around the match; pass `onlyMatch:true` for just the matched substrings, like grep -o). This searches CONTENT, not names — to match node names use glob_nodes' `name` glob instead. `pattern` is a JS regex (not a shell glob); `ignoreCase` adds the `i` flag. Scope with `root` (node id to search under, default current page), `depth` (cap descent), and `within` (an absolute rect — only nodes intersecting it; get coords from a prior bbox). `mode` shapes output: \"content\" (default, every matching line), \"nodes\" (one line per matching node with its hit count, like grep -l), or \"count\" (just totals). Ids (and `@parent`) are short counters (n0, n1, ...) — feed any straight into read/edit tools. Results cap at `maxMatches` line-hits (default 1000); a `(truncated)` note is appended if hit.",
  {
    pattern: z
      .string()
      .describe("JavaScript regular expression source (NOT a shell glob). E.g. \"\\\\bCTA\\\\b\", \"\\\\$\\\\d+\", \"left$\"."),
    root: z
      .string()
      .optional()
      .describe("Node id to search under. Defaults to the current page. Accepts short ids (n0, ...)."),
    ignoreCase: z
      .boolean()
      .optional()
      .describe("Case-insensitive match (regex `i` flag). Default false."),
    onlyMatch: z
      .boolean()
      .optional()
      .describe("Report only the matched substring(s) per line instead of the whole line (grep -o). Default false."),
    mode: z
      .enum(["content", "nodes", "count"])
      .optional()
      .describe("Output shape: \"content\" (default; each matching line), \"nodes\" (one line per matching node + its hit count), or \"count\" (totals only)."),
    depth: z
      .number()
      .optional()
      .describe("Max depth below root to descend (root's direct children = 1). Omit for unlimited."),
    within: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .optional()
      .describe("Absolute rectangle; keep only TEXT nodes whose bounding box intersects it. Same coordinate space as glob_nodes' [x,y wxh]."),
    bbox: z
      .boolean()
      .optional()
      .describe("Append each hit node's absolute bounding box as [x,y wxh]. Default false."),
    maxMatches: z
      .number()
      .optional()
      .describe("Hard cap on collected line-hits before the walk stops. Default 1000."),
    ...saveParams,
  },
  async ({ pattern, root, ignoreCase, onlyMatch, mode, depth, within, bbox, maxMatches, saveToFile, outputPath }: any) => {
    try {
      const result: any = await sendCommandToFigma("grep_nodes", {
        pattern,
        root,
        ignoreCase,
        onlyMatch,
        depth,
        within,
        bbox,
        maxMatches,
      });
      const matches = renumberIds(result?.matches || []);
      const fmtParent = (pid: string | null) => (pid ? ` @${renumberIds({ id: pid }).id}` : "");
      const fmtBox = (m: any) => (m.bbox ? ` [${m.bbox.x},${m.bbox.y} ${m.bbox.w}x${m.bbox.h}]` : "");

      let text: string;
      let summary: string;
      const outMode = mode || "content";
      if (outMode === "count") {
        text =
          `${result?.count ?? matches.length} matching lines in ${result?.nodeCount ?? 0} nodes` +
          (result?.truncated ? " (truncated)" : "");
        summary = "count";
      } else if (outMode === "nodes") {
        // One line per node; count its line-hits.
        const counts = new Map<string, { name: string; type: string; parentId: string | null; n: number }>();
        for (const m of matches) {
          const e = counts.get(m.id) || { name: m.name, type: m.type, parentId: m.parentId, n: 0 };
          e.n++;
          counts.set(m.id, e);
        }
        const lines = [...counts.entries()].map(
          ([id, e]) => `${fmtNodeRef(id, e.name, e.type)}${fmtParent(e.parentId)} (${e.n} match${e.n === 1 ? "" : "es"})`
        );
        text = (lines.join("\n") || "(no matches)") + (result?.truncated ? "\n(truncated)" : "");
        summary = `${counts.size} nodes`;
      } else {
        const lines = matches.map(
          (m: any) => `${fmtNodeRef(m.id, m.name, m.type)}${fmtParent(m.parentId)}${fmtBox(m)} L${m.line}: ${m.text}`
        );
        text = (lines.join("\n") || "(no matches)") + (result?.truncated ? "\n(truncated)" : "");
        summary = `${matches.length} lines`;
      }

      return {
        content: [await textContent(text, summary, { saveToFile, outputPath }, "grep")],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error grepping nodes: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Query Tool — structural search over node fields (predicates, not flat text)
server.tool(
  "query_nodes",
  "Find nodes by predicates on their STRUCTURE — query the node model's fields, not flat text. Pass `where`: an array of `{path, op, value}` predicates that are AND-combined; a node is a hit when all pass. Returned one per line as `id:\"name\".TYPE @parent {path=value, ...}`. `path` walks the node JSON: dot for objects, `[i]` for an array index, `[*]` for \"any array element\" (e.g. `fills[*].color`, `boundVariables.fills`, `fontSize`, `name`, `type`). Ops — `regex` (DEFAULT; case-insensitive with `i:true`; covers equality/contains/oneOf via the pattern; this is the right op for strings, ids, enums, even numbers as text); `gt`/`gte`/`lt`/`lte` (numeric compare — what regex can't do, e.g. fontSize<12, opacity<1); `color` (value is `#RRGGBB`; matches a Figma rgb 0-1 color with tolerance); `exists`/`absent` (presence of the KEY itself, no value — `absent` finds nodes MISSING a field, e.g. `boundVariables.fills` absent = a fill NOT bound to a variable/token; the core design-system audit query). Scope with `root` (default current page), `depth`, `within` (absolute rect). `bbox:true` appends each hit's [x,y wxh]. Ids (and `@parent`) are short counters — feed straight into other tools. Caps at `maxMatches` hits (default 1000). For raw authored copy use grep_nodes; for a plain type/name index use glob_nodes.",
  {
    where: z
      .array(
        z.object({
          path: z
            .string()
            .describe("Field path on the node. Dot for objects, [i] for an index, [*] for any array element. E.g. \"fontSize\", \"fills[*].color\", \"boundVariables.fills\", \"name\"."),
          op: z
            .enum(["regex", "gt", "gte", "lt", "lte", "color", "exists", "absent"])
            .optional()
            .describe("Match op. Default \"regex\". Use gt/gte/lt/lte for numbers, color for #RRGGBB, exists/absent for key presence (no value needed)."),
          value: z
            .union([z.string(), z.number(), z.boolean()])
            .optional()
            .describe("Comparison value. Regex source for \"regex\", a number for compares, \"#RRGGBB\" for color. Omit for exists/absent."),
          i: z
            .boolean()
            .optional()
            .describe("Case-insensitive regex (only for op \"regex\"). Default false."),
        })
      )
      .min(1)
      .describe("Predicates, AND-combined. At least one required."),
    root: z
      .string()
      .optional()
      .describe("Node id to search under. Defaults to the current page. Accepts short ids (n0, ...)."),
    depth: z
      .number()
      .optional()
      .describe("Max depth below root to descend (root's direct children = 1). Omit for unlimited."),
    within: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .optional()
      .describe("Absolute rectangle; keep only nodes whose bounding box intersects it. Same coordinate space as glob_nodes' [x,y wxh]."),
    bbox: z
      .boolean()
      .optional()
      .describe("Append each hit's absolute bounding box as [x,y wxh]. Default false."),
    maxMatches: z
      .number()
      .optional()
      .describe("Hard cap on collected hits before the walk stops. Default 1000."),
    ...saveParams,
  },
  async ({ where, root, depth, within, bbox, maxMatches, saveToFile, outputPath }: any) => {
    try {
      const result: any = await sendCommandToFigma("query_nodes", {
        where,
        root,
        depth,
        within,
        bbox,
        maxMatches,
      });
      const matches = renumberIds(result?.matches || []);
      const lines = matches.map((m: any) => {
        const parent = m.parentId ? ` @${renumberIds({ id: m.parentId }).id}` : "";
        const box = m.bbox ? ` [${m.bbox.x},${m.bbox.y} ${m.bbox.w}x${m.bbox.h}]` : "";
        const props = (m.props || [])
          .map((p: any) => `${p.path}=${p.value}`)
          .join(", ");
        return `${fmtNodeRef(m.id, m.name, m.type)}${parent}${box}${props ? ` {${props}}` : ""}`;
      });
      const text = (lines.join("\n") || "(no matches)") + (result?.truncated ? "\n(truncated)" : "");
      return {
        content: [await textContent(text, `${matches.length} nodes`, { saveToFile, outputPath }, "query")],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error querying nodes: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "edit_nodes",
  "Edit node properties directly in the node model — the write-side twin of query_nodes/read_node, an Edit tool for Figma JSON instead of text. Pass `edits`: an array of `{nodeId, path, old?, new}`. `path` addresses one field the same way query_nodes does — dot for objects, `[i]` for an array index (e.g. `name`, `cornerRadius`, `fills[0].color`, `fills[0].opacity`); no `[*]` (a write needs one concrete target). `new` is the value to set: colors as `#RRGGBB` are converted to Figma's rgb 0-1, and whole objects/arrays are allowed (e.g. set `fills[0]` to a full paint). `old` is an OPTIONAL guard, exactly like the old_string in Edit — if given and it doesn't match the current value (colors compared as hex, numbers tolerantly), that one edit is rejected so you never blind-overwrite a stale read. Edits run in order and are INDEPENDENT: one failing — guard mismatch, read-only/derived prop, a type Figma rejects, font not loaded — records its Figma error and the rest still apply. The result lists each edit as `✓ id path: old → new` or `✗ id path: <error>`, so a failure tells you exactly what to fix. One call can touch many nodes (each edit names its own `nodeId`) — this is also how you bulk-replace text across components: one `{nodeId, path:\"characters\", new:\"...\"}` per text node in a single call (the `characters` path loads the node's font for you). Large batches stream progress, so a long run won't time out. Common paths: `name`, `characters`, `x`/`y`, `width`/`height` (resize), `cornerRadius`, `fills[0].color` (#RRGGBB), `opacity`, `layoutMode`, `paddingTop`, `itemSpacing`, `primaryAxisAlignItems`, `layoutSizingHorizontal`. INSTANCE variant/prop swap: edit `componentProperties.<PropName>` (the names read_node shows for an instance) — `{nodeId, path:\"componentProperties.Size\", new:\"Large\"}` swaps a VARIANT, and BOOLEAN/TEXT props work the same way (pass the bare name, the #id suffix is matched for you); this routes through Figma's setProperties since the map itself is read-only. An INSTANCE_SWAP prop takes a component id/key as its `new` (use a FULL Figma id — short n-ids aren't remapped inside a value). Bind a style to a node by its id: set `fillStyleId`/`strokeStyleId`/`effectStyleId`/`gridStyleId`/`textStyleId` to a style id (from get_styles/write_styles) — applied via Figma's async setter, with `\"\"` detaching the style. nodeId accepts short ids (n0, ...) or full Figma ids.",
  {
    edits: z
      .array(
        z.object({
          nodeId: z
            .string()
            .describe("Node to edit. Short ids (n0, ...) or full Figma ids."),
          path: z
            .string()
            .describe("Field path to write. Dot for objects, [i] for an array index. Same syntax as query_nodes, but no [*]. E.g. \"name\", \"cornerRadius\", \"fills[0].color\"."),
          old: z
            .any()
            .optional()
            .describe("Optional guard: expected current value (Edit-style). Colors as #RRGGBB. Mismatch rejects only this edit."),
          new: z
            .any()
            .describe("Value to set. #RRGGBB → Figma rgb; numbers/strings/objects/arrays allowed."),
        })
      )
      .min(1)
      .describe("Edits applied in order; each independent — one failing does not abort the rest."),
  },
  async ({ edits }: any) => {
    try {
      // Pre-validate each edit's value against the shared field schema before the
      // plugin round-trip — catches read-only paths and type-agnostic value/enum
      // mistakes with a message in the agent's path grammar. Per-edit (edits are
      // independent): a rejected edit is reported, the rest still apply.
      const valid: any[] = [];
      const rejected: string[] = [];
      for (const e of edits as any[]) {
        const msg = validateEditValue(e.path, e.new);
        if (msg) rejected.push(`✗ ${e.nodeId} ${e.path}: ${msg}`);
        else valid.push(e);
      }

      // Resolve any imageUrl in an edit's value (e.g. setting fills to an image
      // paint) into inline bytes the plugin imports without network access.
      await resolveExternalAssets(valid.map((e) => e.new));

      const result: any = valid.length ? await sendCommandToFigma("edit_nodes", { edits: valid }) : { applied: 0, total: 0, results: [] };
      const fmt = (v: any) =>
        v === null || v === undefined
          ? "(absent)"
          : typeof v === "object"
          ? JSON.stringify(v)
          : String(v);
      const rows = [
        ...rejected,
        ...(result?.results || []).map((r: any) => {
          const id = renumberIds({ id: r.nodeId }).id;
          return r.ok
            ? `✓ ${id} ${r.path}: ${fmt(r.old)} → ${fmt(r.new)}`
            : `✗ ${id} ${r.path}: ${r.error}`;
        }),
      ];
      const text = `applied ${result?.applied || 0}/${edits.length}` + (rows.length ? "\n" + rows.join("\n") : "");
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error editing nodes: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Reparent Nodes Tool — move existing nodes between parents / reorder z-order
// @ai-generated(solo)
server.tool(
  "reparent_nodes",
  "Move existing nodes to a new parent and/or a new z-order position — the structural move that edit_nodes can't do (it only writes value properties, never `parent`/`index`). Pass `moves`: an array of `{nodeId, parentId?, index?}`. `parentId` re-parents the node into that container (a FRAME, GROUP, SECTION, COMPONENT, or a page; short ids n0,... or full Figma ids). `index` sets the node's slot among its siblings — 0 is the bottom of the z-order / first in an auto-layout, larger is later; an out-of-range index pins to the end. Give `parentId` to move into a different container, `index` alone to REORDER within the current parent, or both. Moves are INDEPENDENT: one failing — node/parent not found, a parent that can't hold children, moving a node into its own descendant (Figma rejects) — records its error and the rest still run. Note: re-parenting keeps the node's LOCAL x/y, so its absolute position shifts when the new parent is elsewhere (use edit_nodes to set x/y after); inside an auto-layout parent x/y is ignored and `index` controls the layout order. The result lists each move as `✓ id \"name\": parent#oldIndex → parent#newIndex` or `✗ id: <error>`.",
  {
    moves: z
      .array(
        z.object({
          nodeId: z
            .string()
            .describe("Node to move. Short ids (n0, ...) or full Figma ids."),
          parentId: z
            .string()
            .optional()
            .describe("New parent container. Omit to reorder within the current parent. Short ids (n0, ...) or full Figma ids."),
          index: z
            .number()
            .int()
            .optional()
            .describe("Position among siblings (0 = bottom/first). Omit to append. Out-of-range pins to the end."),
        })
      )
      .min(1)
      .describe("Moves applied in order; each independent — one failing does not abort the rest."),
  },
  async ({ moves }: any) => {
    try {
      const result: any = await sendCommandToFigma("reparent_nodes", { moves });
      const rows = (result?.results || []).map((r: any) => {
        const id = renumberIds({ id: r.nodeId }).id;
        if (!r.ok) return `✗ ${id}: ${r.error}`;
        const oldP = r.oldParentId ? renumberIds({ id: r.oldParentId }).id : "?";
        const newP = r.newParentId ? renumberIds({ id: r.newParentId }).id : "?";
        return `✓ ${id} "${r.name}": ${oldP}#${r.oldIndex} → ${newP}#${r.newIndex}`;
      });
      const text = `moved ${result?.applied || 0}/${moves.length}` + (rows.length ? "\n" + rows.join("\n") : "");
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error reparenting nodes: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);


// Write Nodes Tool — the create-side twin of edit_nodes
// @ai-generated(solo)
server.tool(
  "write_nodes",
  "Create new nodes from raw Figma JSON — the create-side twin of edit_nodes, a Write tool for the node tree instead of text. Pass `nodes`: an array of node specs. Each spec is `{type, ...props, children?}`: `type` is the Figma node type to create (RECTANGLE, FRAME, TEXT, ELLIPSE, LINE, STAR, POLYGON, VECTOR, COMPONENT, SECTION, SLICE, or INSTANCE). Every OTHER key is a property written onto the new node exactly as edit_nodes writes a path — `name`, `x`, `y`, `cornerRadius`, `opacity`, `fills`, `layoutMode`, `paddingTop`, `itemSpacing`, etc. Values follow edit_nodes rules: any `color` field given as `#RRGGBB` is converted to Figma's rgb 0-1 (so `fills:[{type:\"SOLID\",color:\"#3366ff\"}]` works), `width`/`height` route through resize(), and on a TEXT node `characters` loads the node's font for you. Placement: `parentId` appends the node into an existing container (short ids n0,... or full Figma ids; default is the current page) and `index` sets its position among siblings. `children` is an array of the same spec shape, created recursively inside this node — this is how you write a whole subtree (frame → its rows → their text) in one call. Specs are INDEPENDENT like edit_nodes: a spec whose factory or parent lookup fails records its Figma error and the siblings still create; within a created node, a single bad property (e.g. padding with no layoutMode, a value Figma rejects) is reported per-property and the node still survives with its other props. INSTANCE needs `componentId` (a local COMPONENT, from get_local_components) or `componentKey` (a published library component); add `componentProperties:{PropName:value}` to pick variants / set boolean·text·swap props on the new instance (applied via setProperties). IMAGE fills: put `{type:\"IMAGE\", imageUrl:\"https://…\", scaleMode:\"FILL\"}` in `fills` — the server fetches the URL and imports the bytes into Figma for you (no imageHash needed); same works in edit_nodes when you set a node's `fills`. SVG: `type:\"SVG\"` with `svg:\"<svg…>\"` raw markup or `svgUrl:\"https://…\"` (fetched server-side) creates a vector node from the SVG. The result is a tree of `✓ <id> <TYPE> \"<name>\"` (use that id as a parentId or in edit_nodes next) or `✗ <error>`, with `! key: <error>` lines for any rejected properties. Large batches stream progress so a long run won't time out.",
  {
    nodes: z
      .array(z.record(z.any()))
      .min(1)
      .describe("Node specs, each `{type, ...props, children?}`. Created in order, independent — one failing does not abort the rest."),
  },
  async ({ nodes }: any) => {
    try {
      // Validate each root spec against the write schema BEFORE the plugin round-trip,
      // so a shape/enum mistake fails here with a precise field path instead of
      // silently no-opping in Figma. Per-root (not whole-batch) keeps write_nodes'
      // independence guarantee — one bad root is rejected, valid siblings still create.
      const valid: any[] = [];
      const rejected: string[] = [];
      for (const spec of nodes as any[]) {
        const parsed = writeNodeUnion.safeParse(spec);
        if (parsed.success) {
          valid.push(spec);
        } else {
          const where = spec && typeof spec === "object" ? String(spec.type || "node") : "node";
          for (const iss of (parsed as z.SafeParseError<any>).error.issues) {
            rejected.push(`✗ ${where}: ${iss.path.join(".") || "(root)"}: ${iss.message}`);
          }
        }
      }

      // Resolve any imageUrl/svgUrl in the validated specs into inline bytes/markup
      // the plugin can build offline (fetched here so the plugin needs no network).
      await resolveExternalAssets(valid);

      const result: any = valid.length ? await sendCommandToFigma("write_nodes", { nodes: valid }) : { created: 0, total: 0, results: [] };
      const renumber = (id: string) => renumberIds({ id }).id;
      const lines: string[] = [...rejected];
      const walk = (arr: any[], depth: number) => {
        for (const r of arr || []) {
          const pad = "  ".repeat(depth);
          lines.push(
            r.ok
              ? `${pad}✓ ${renumber(r.id)} ${r.type} "${r.name}"`
              : `${pad}✗ ${r.type || "node"}: ${r.error}`
          );
          for (const pe of r.errors || []) lines.push(`${pad}  ! ${pe.key}: ${pe.error}`);
          if (r.children && r.children.length) walk(r.children, depth + 1);
        }
      };
      walk(result?.results || [], 0);
      const text = `created ${result?.created || 0}/${nodes.length}` + (lines.length ? "\n" + lines.join("\n") : "");
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error writing nodes: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Fill/stroke colors are set via edit_nodes — e.g. {path:"fills",new:[{type:"SOLID",color:"#3366ff"}]}
// or {path:"strokes",...} + {path:"strokeWeight",...}. No dedicated tools.

// Write Schema Tool — lazy, on-demand contract for write_nodes.
// @ai-generated(guided)
server.tool(
  "get_write_schema",
  "Get the WRITE-side schema for a node type — the fields write_nodes accepts when CREATING that type (not the REST shape read_node returns). Call with `type` (e.g. \"TEXT\") right before building a node to see its fields, valid enum values, and ranges; call with no `type` to list the creatable types. This is the same schema write_nodes validates against, so what it shows is exactly what is accepted. Note: write_nodes also passes through any other Figma property for the type, so the list is the curated common set, not an exhaustive cap.",
  {
    type: z
      .enum(NODE_TYPES)
      .optional()
      .describe("Node type to describe (FRAME, TEXT, ...). Omit to list all creatable types."),
  },
  async ({ type }: { type?: NodeType }) => {
    const text = type ? describeNodeSchema(type) : listNodeTypes();
    return { content: [{ type: "text", text }] };
  }
);

// Clone Node Tool
server.tool(
  "clone_node",
  "Clone an existing node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to clone"),
    x: z.number().optional().describe("New X position for the clone"),
    y: z.number().optional().describe("New Y position for the clone")
  },
  async ({ nodeId, x, y }: any) => {
    try {
      const result = await sendCommandToFigma('clone_node', { nodeId, x, y });
      const typedResult = result as { name: string, id: string };
      return {
        content: [
          {
            type: "text",
            text: `Cloned node "${typedResult.name}" with new ID: ${typedResult.id}${x !== undefined && y !== undefined ? ` at position (${x}, ${y})` : ''}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error cloning node: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Delete Nodes Tool
server.tool(
  "delete_nodes",
  "Delete one or more nodes from Figma. Large batches are chunked with progress updates.",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to delete"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("delete_nodes", { nodeIds });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting nodes: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Export Node as Image Tool
server.tool(
  "export_node_as_image",
  "Export one or more nodes as images from Figma. Each node may request several scales at once, so a single call can produce many files. To actually look at how a node renders, pass inline:true with a small scale (e.g. 0.5) so the image comes back in the response and stays cheap on context.",
  {
    nodes: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the node to export"),
          scale: z
            .union([z.number().positive(), z.array(z.number().positive()).nonempty()])
            .optional()
            .describe(
              "Export scale(s): a single number, or an array to emit one image per scale. Only applies to raster formats (PNG/JPG); ignored for SVG/PDF. Default 1."
            ),
        })
      )
      .nonempty()
      .describe("Nodes to export. Each entry exports its node at its own scale(s)."),
    format: z
      .enum(["PNG", "JPG", "SVG", "PDF"])
      .optional()
      .describe("Export format shared by all nodes (default PNG)."),
    inline: z
      .boolean()
      .optional()
      .describe(
        `Return the image(s) directly in the response instead of writing files, so you can see them. Set this whenever you want to look at how something renders — and pair it with a small scale (e.g. 0.5) to keep it cheap. Honored only for raster formats (PNG/JPG) whose encoded size is under ${INLINE_MAX_BYTES / 1024}KB — anything larger (or SVG/PDF) falls back to a file to avoid blowing up the context.`
      ),
    outputDir: z
      .string()
      .optional()
      .describe(
        "Directory to write the images into (created if missing). Defaults to the OS temp dir. Files are auto-named export-<nodeId>@<scale>x.<ext>. Ignored for images returned inline."
      ),
  },
  async ({ nodes, format, inline, outputDir }: any) => {
    const fmt = format || "PNG";
    const ext = fmt.toLowerCase() === "jpg" ? "jpg" : fmt.toLowerCase();
    const inlineable = inline && (fmt === "PNG" || fmt === "JPG");
    const content: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    > = [];
    const written: string[] = [];
    const errors: string[] = [];

    for (const { nodeId, scale } of nodes) {
      try {
        const result = await sendCommandToFigma("export_node_as_image", {
          nodeId,
          format: fmt,
          scale: scale ?? 1,
        });
        const typedResult = result as {
          mimeType: string;
          images: { scale: number; imageData: string }[];
        };

        for (const img of typedResult.images) {
          const buffer = Buffer.from(img.imageData, "base64");
          if (inlineable && buffer.length <= INLINE_MAX_BYTES) {
            content.push({ type: "image", data: img.imageData, mimeType: typedResult.mimeType });
            written.push(`${nodeId} @${img.scale}x → inline (${buffer.length} bytes)`);
            continue;
          }
          const safeId = nodeId.replace(/[^a-zA-Z0-9_-]/g, "-");
          const baseName = `export-${safeId}@${img.scale}x`;
          const target = outputDir ? join(outputDir, `${baseName}.${ext}`) : undefined;
          const { path, bytes } = await writeOutputFile(baseName, ext, buffer, target);
          const note = inline && !inlineable ? " (file: inline unsupported for this format)"
            : inline ? " (file: too large to inline)" : "";
          written.push(`${nodeId} @${img.scale}x → ${path} (${bytes} bytes)${note}`);
        }
      } catch (error) {
        errors.push(
          `${nodeId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const lines = [
      `Exported ${written.length} ${fmt} image(s):`,
      ...written,
      ...(errors.length ? ["", `Failed (${errors.length}):`, ...errors] : []),
    ];
    content.unshift({ type: "text", text: lines.join("\n") });
    return { content };
  }
);

// Get Styles Tool
server.tool(
  "get_styles",
  "Get all styles from the current Figma document",
  { ...saveParams },
  async ({ saveToFile, outputPath }: any) => {
    try {
      const result = await sendCommandToFigma("get_styles");
      return {
        content: [await jsonContent(result, { saveToFile, outputPath }, "styles")]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting styles: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Shared shape for a style spec (used by write_styles / edit_styles).
const styleSpecShape = {
  id: z.string().optional().describe("Existing style id (edit_styles: match by id; also accepted on write to fail loudly if reused)"),
  type: z.enum(["PAINT", "TEXT", "EFFECT", "GRID"]).optional().describe("Style kind — required for write_styles and for edit_styles when matching by name"),
  name: z.string().optional().describe("Style name; '/' creates folders (e.g. 'brand/primary'). Required on write."),
  description: z.string().optional(),
  // PAINT
  paints: z.array(z.any()).optional().describe("PAINT: array of Figma Paint objects (SOLID/GRADIENT/IMAGE). Hex strings in a `color` field are accepted."),
  paint: z.any().optional().describe("PAINT: single Paint object shorthand for one-paint styles"),
  color: z.string().optional().describe("PAINT: hex shorthand ('#RRGGBB'/'#RRGGBBAA') for a single solid fill"),
  opacity: z.number().optional().describe("PAINT: opacity 0-1 for the `color` shorthand"),
  // TEXT
  fontName: z.object({ family: z.string(), style: z.string() }).optional().describe("TEXT: {family, style} — loaded before applying"),
  fontSize: z.number().optional().describe("TEXT: font size in px"),
  lineHeight: z.any().optional().describe("TEXT: number (PIXELS shorthand) or {value, unit: PIXELS|PERCENT} or {unit: AUTO}"),
  letterSpacing: z.any().optional().describe("TEXT: number (PIXELS shorthand) or {value, unit: PIXELS|PERCENT}"),
  paragraphSpacing: z.number().optional().describe("TEXT: spacing between paragraphs in px"),
  paragraphIndent: z.number().optional().describe("TEXT: first-line indent in px"),
  textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional(),
  textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
  // EFFECT
  effects: z.array(z.any()).optional().describe("EFFECT: array of Figma Effect objects (DROP_SHADOW/INNER_SHADOW/LAYER_BLUR/BACKGROUND_BLUR). Hex in a `color` field is accepted."),
  // GRID
  layoutGrids: z.array(z.any()).optional().describe("GRID: array of Figma LayoutGrid objects (GRID/COLUMNS/ROWS)."),
};

function styleResultText(verb: string, result: any): string {
  const lines = (result.styles || []).map((s: any) =>
    s.ok
      ? `✓ ${s.removed ? "removed" : verb} ${s.type} "${s.name}" (${s.id})`
      : `✗ ${s.type || ""} ${s.name || s.id || ""}: ${s.error}`
  );
  return `${lines.join("\n")}\n\n${JSON.stringify(result, null, 2)}`;
}

// Create Styles Tool
server.tool(
  "write_styles",
  "Create local Figma styles (paint/color, text, effect, grid). Each entry needs `type` (PAINT|TEXT|EFFECT|GRID) and `name` ('/' makes folders). PAINT: pass `paints` (full Paint array), `paint`, or the `color` hex shorthand. TEXT: `fontName` {family,style} (loaded automatically), `fontSize`, `lineHeight`, `letterSpacing`, `paragraphSpacing`, `paragraphIndent`, `textCase`, `textDecoration`. EFFECT: `effects` (Effect array — shadows/blurs). GRID: `layoutGrids`. Hex colors are accepted wherever a paint/effect `color` is expected. Use edit_styles to modify an existing style.",
  {
    styles: z.array(z.object(styleSpecShape)).min(1).describe("Styles to create"),
  },
  async ({ styles }: any) => {
    try {
      const result: any = await sendCommandToFigma("write_styles", { styles });
      return {
        content: [
          { type: "text", text: `Styles created: ${result.created}/${result.total}.\n${styleResultText("created", result)}` },
        ],
      };
    } catch (error) {
      return {
        content: [
          { type: "text", text: `Error creating styles: ${error instanceof Error ? error.message : String(error)}` },
        ],
      };
    }
  }
);

// Edit Styles Tool
server.tool(
  "edit_styles",
  "Update or delete existing local Figma styles. Match each entry by `id` (from get_styles), or by `name` + `type`. Only the fields you pass are changed (partial update) — same field set as write_styles (name, description, paints/color, font props, effects, layoutGrids). Set `remove: true` to delete the style. To create a new style use write_styles.",
  {
    styles: z
      .array(z.object({ ...styleSpecShape, remove: z.boolean().optional().describe("Delete this style instead of updating it") }))
      .min(1)
      .describe("Styles to update or remove"),
  },
  async ({ styles }: any) => {
    try {
      const result: any = await sendCommandToFigma("edit_styles", { styles });
      return {
        content: [
          { type: "text", text: `Styles: ${result.updated} updated, ${result.removed} removed of ${result.total}.\n${styleResultText("updated", result)}` },
        ],
      };
    } catch (error) {
      return {
        content: [
          { type: "text", text: `Error editing styles: ${error instanceof Error ? error.message : String(error)}` },
        ],
      };
    }
  }
);

// Get Local Components Tool
server.tool(
  "get_local_components",
  "Get all local components from the Figma document",
  { ...saveParams },
  async ({ saveToFile, outputPath }: any) => {
    try {
      const result = await sendCommandToFigma("get_local_components");
      return {
        content: [await jsonContent(result, { saveToFile, outputPath }, "local-components")]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting local components: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Get Annotations Tool
server.tool(
  "get_annotations",
  "Get all annotations in the current document or specific node",
  {
    nodeId: z.string().describe("node ID to get annotations for specific node"),
    includeCategories: z.boolean().optional().default(true).describe("Whether to include category information"),
    ...saveParams,
  },
  async ({ nodeId, includeCategories, saveToFile, outputPath }: any) => {
    try {
      const result = await sendCommandToFigma("get_annotations", {
        nodeId,
        includeCategories
      });
      return {
        content: [await jsonContent(result, { saveToFile, outputPath }, "annotations")]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting annotations: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Set Annotations Tool — variadic create/update of native Figma annotations
server.tool(
  "set_annotations",
  "Create or update one or more native Figma annotations. Pass `annotations`: an array of `{nodeId, labelMarkdown, categoryId?, annotationId?, properties?}`. Each entry annotates its own `nodeId` with markdown text; supply `annotationId` to update an existing annotation instead of creating one, and `categoryId` to file it under an annotation category (from get_annotations). Entries are applied independently — one failing records its error and the rest still apply. Large batches are chunked with progress updates so a long run won't time out. The result lists each entry as `✓ <id>` or `✗ <id>: <error>`.",
  {
    annotations: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the node to annotate"),
          labelMarkdown: z.string().describe("The annotation text in markdown format"),
          categoryId: z.string().optional().describe("The ID of the annotation category"),
          annotationId: z.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
          properties: z.array(z.object({
            type: z.string()
          })).optional().describe("Additional properties for the annotation")
        })
      )
      .min(1)
      .describe("Annotations to apply; each independent — one failing does not abort the rest."),
  },
  async ({ annotations }: any) => {
    try {
      const result: any = await sendCommandToFigma("set_annotations", { annotations });
      const rows = (result?.results || []).map((r: any) => {
        const id = renumberIds({ id: r.nodeId }).id;
        return r.success ? `✓ ${id}` : `✗ ${id}: ${r.error || "Unknown error"}`;
      });
      const text =
        `applied ${result?.annotationsApplied || 0}/${result?.totalAnnotations || annotations.length}` +
        (rows.length ? "\n" + rows.join("\n") : "");
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting annotations: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Copy Instance Overrides Tool
server.tool(
  "get_instance_overrides",
  "Get all override properties from a selected component instance. These overrides can be applied to other instances, which will swap them to match the source component.",
  {
    nodeId: z.string().optional().describe("Optional ID of the component instance to get overrides from. If not provided, currently selected instance will be used."),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("get_instance_overrides", {
        instanceNodeId: nodeId || null
      });
      const typedResult = result as getInstanceOverridesResult;

      return {
        content: [
          {
            type: "text",
            text: typedResult.success
              ? `Successfully got instance overrides: ${typedResult.message}`
              : `Failed to get instance overrides: ${typedResult.message}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error copying instance overrides: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Set Instance Overrides Tool
server.tool(
  "set_instance_overrides",
  "Apply previously copied overrides to selected component instances. Target instances will be swapped to the source component and all copied override properties will be applied.",
  {
    sourceInstanceId: z.string().describe("ID of the source component instance"),
    targetNodeIds: z.array(z.string()).describe("Array of target instance IDs. Currently selected instances will be used.")
  },
  async ({ sourceInstanceId, targetNodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("set_instance_overrides", {
        sourceInstanceId: sourceInstanceId,
        targetNodeIds: targetNodeIds || []
      });
      const typedResult = result as setInstanceOverridesResult;

      if (typedResult.success) {
        const successCount = typedResult.results?.filter(r => r.success).length || 0;
        return {
          content: [
            {
              type: "text",
              text: `Successfully applied ${typedResult.totalCount || 0} overrides to ${successCount} instances.`
            }
          ]
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Failed to set instance overrides: ${typedResult.message}`
            }
          ]
        };
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting instance overrides: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);


// Define design strategy prompt
server.prompt(
  "design_strategy",
  "Best practices for working with Figma designs",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `When working with Figma designs, follow these best practices:

1. Start with Document Structure:
   - First use glob_nodes({ type: ["SECTION","FRAME"] }) to map existing screens/sections before adding more
   - Plan your layout hierarchy before creating elements
   - Create a main container frame for each screen/section

2. Naming Conventions:
   - Use descriptive, semantic names for all elements
   - Follow a consistent naming pattern (e.g., "Login Screen", "Logo Container", "Email Input")
   - Group related elements with meaningful names

3. Layout Hierarchy:
   - Create parent frames first, then add child elements
   - For forms/login screens:
     * Start with the main screen container frame
     * Create a logo container at the top
     * Group input fields in their own containers
     * Place action buttons (login, submit) after inputs
     * Add secondary elements (forgot password, signup links) last

4. Input Fields Structure:
   - Create a container frame for each input field
   - Include a label text above or inside the input
   - Group related inputs (e.g., username/password) together

5. Element Creation:
   - Use write_nodes() to create the whole subtree at once: a FRAME spec for each container/input field with nested children TEXT specs for labels, button text, and links
   - Set appropriate colors and styles inline on each spec:
     * fills for backgrounds (color as hex #RRGGBB)
     * strokes for borders
     * fontName/fontSize for different text elements

6. Mofifying existing elements:
  - use edit_nodes() to modify properties (text via the "characters" path, colors, layout, etc.).

7. Visual Hierarchy:
   - Position elements in logical reading order (top to bottom)
   - Maintain consistent spacing between elements
   - Use appropriate font sizes for different text types:
     * Larger for headings/welcome text
     * Medium for input labels
     * Standard for button text
     * Smaller for helper text/links

8. Best Practices:
   - Verify each creation with read_node()
   - Use parentId to maintain proper hierarchy
   - Group related elements together in frames
   - Keep consistent spacing and alignment

Example Login Screen Structure:
- Login Screen (main frame)
  - Logo Container (frame)
    - Logo (image/text)
  - Welcome Text (text)
  - Input Container (frame)
    - Email Input (frame)
      - Email Label (text)
      - Email Field (frame)
    - Password Input (frame)
      - Password Label (text)
      - Password Field (frame)
  - Login Button (frame)
    - Button Text (text)
  - Helper Links (frame)
    - Forgot Password (text)
    - Don't have account (text)`,
          },
        },
      ],
      description: "Best practices for working with Figma designs",
    };
  }
);

server.prompt(
  "read_design_strategy",
  "Best practices for reading Figma designs",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `Exploring and modifying a Figma design works like editing a codebase: locate first with cheap searches, then read only what you need, then edit surgically. Do NOT dump whole subtrees to find something.

## The ladder (cheap → detailed)
1. Orient — glob_nodes({ root, type }) for a flat \`id:"name".TYPE @parent\` index of a page or subtree (the \`ls -R\`). Start here when you don't yet know the ids. Filter by \`type\` to cut noise (e.g. type:["SECTION","FRAME"] for the screen map).
2. Locate — grep_nodes (regex over TEXT content, the \`grep\`) to find nodes by what they say, or query_nodes (predicates over node fields — fontSize<12, fills bound to a variable, etc.) to find by structure. All return short ids.
3. Inspect — read_node({ nodeIds }) for the compact subtree of just the nodes you'll act on; raise \`depth\` or re-request a stub id to zoom; raw:true for every prop of one node.
4. Modify — edit_nodes({ edits:[{nodeId, path, old?, new}] }) to write properties (text via the "characters" path). Pass \`old\` as a guard so you never overwrite a stale read. To MOVE a node — change its parent or its z-order/layout position — use reparent_nodes({ moves:[{nodeId, parentId?, index?}] }); edit_nodes can't write structure.

## Notes
- No selection and no ids? read_node() with no args reads the current selection; if it's empty, ask the user to select, or glob_nodes the page.
- Ids are short counters (n0, n1, ...) and flow between all tools — a glob/grep hit feeds straight into read_node/edit_nodes.
- Width of search is cheap (ids only); depth of detail is not (full subtree). Prefer a wide glob then a narrow read over reading wide.
`,
          },
        },
      ],
      description: "Best practices for reading Figma designs",
    };
  }
);

// Text Replacement Strategy Prompt
server.prompt(
  "text_replacement_strategy",
  "Systematic approach for replacing text in Figma designs",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Text Replacement Strategy

## 1. Locate the text nodes
\`\`\`
glob_nodes({ root: "node-id", type: "TEXT" })   // flat index of every text node + its @parent
grep_nodes({ root: "node-id", pattern: "..." })  // or find text nodes by content
read_node({ nodeIds: [...] })                    // pull full characters for the ones you'll edit
\`\`\`

## 2. Replace in one call
edit_nodes does the bulk replace — one edit per text node, the "characters" path loads the node's font for you. One call can span many nodes; large batches stream progress.
\`\`\`
edit_nodes({ edits: [
  { nodeId: "n12", path: "characters", old: "Old", new: "New" },  // old = guard against a stale read
  // ...more text nodes
] })
\`\`\`

## 3. Chunk large jobs and verify visually
For big designs, replace in logical chunks (a table's rows, a card group, one screen area) rather than all at once, and after each chunk export a small image to confirm text still fits and the layout holds before continuing:
\`\`\`
export_node_as_image({ nodes: [{ nodeId: "chunk-node-id", scale: 0.5 }] })  // smaller scale for bigger chunks; pass several nodes/scales to batch
\`\`\`
Adapt text to its container: if it overflows, shorten or break lines at sensible points, and keep related content (labels with their fields, headers with their data) consistent across chunks.`,
          },
        },
      ],
      description: "Systematic approach for replacing text in Figma designs",
    };
  }
);

// Annotation Conversion Strategy Prompt
server.prompt(
  "annotation_conversion_strategy",
  "Strategy for converting manual annotations to Figma's native annotations",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Automatic Annotation Conversion
            
## Process Overview

The process of converting manual annotations (numbered/alphabetical indicators with connected descriptions) to Figma's native annotations:

1. Get selected frame/component information
2. Scan and collect all annotation text nodes
3. Scan target UI elements (components, instances, frames)
4. Match annotations to appropriate UI elements
5. Apply native Figma annotations

## Step 1: Get Selection and Initial Setup

First, get the selected frame or component that contains annotations:

\`\`\`typescript
// Get the selected frame/component
const selection = await get_selection();
const selectedNodeId = selection[0].id

// Get available annotation categories for later use
const annotationData = await get_annotations({
  nodeId: selectedNodeId,
  includeCategories: true
});
const categories = annotationData.categories;
\`\`\`

## Step 2: Index Annotation Text Nodes

Index all text nodes to identify annotations and their descriptions:

\`\`\`typescript
// Flat index of every text node under the selection (id, name, @parent, bbox)
const textNodes = await glob_nodes({ root: selectedNodeId, type: "TEXT" });
// Then read_node({ nodeIds: [...] }) for the characters you need.

// Filter and group annotation markers and descriptions

// Markers typically have these characteristics:
// - Short text content (usually single digit/letter)
// - Specific font styles (often bold)
// - Located in a container with "Marker" or "Dot" in the name
// - Have a clear naming pattern (e.g., "1", "2", "3" or "A", "B", "C")


// Identify description nodes
// Usually longer text nodes near markers or with matching numbers in path
  
\`\`\`

## Step 3: Scan Target UI Elements

Get all potential target elements that annotations might refer to:

\`\`\`typescript
// List all UI elements that could be annotation targets
const targetNodes = await glob_nodes({
  root: selectedNodeId,
  type: [
    "COMPONENT",
    "INSTANCE",
    "FRAME"
  ]
});
\`\`\`

## Step 4: Match Annotations to Targets

Match each annotation to its target UI element using these strategies in order of priority:

1. **Path-Based Matching**:
   - Look at the marker's parent container name in the Figma layer hierarchy
   - Remove any "Marker:" or "Annotation:" prefixes from the parent name
   - Find UI elements that share the same parent name or have it in their path
   - This works well when markers are grouped with their target elements

2. **Name-Based Matching**:
   - Extract key terms from the annotation description
   - Look for UI elements whose names contain these key terms
   - Consider both exact matches and semantic similarities
   - Particularly effective for form fields, buttons, and labeled components

3. **Proximity-Based Matching** (fallback):
   - Calculate the center point of the marker
   - Find the closest UI element by measuring distances to element centers
   - Consider the marker's position relative to nearby elements
   - Use this method when other matching strategies fail

Additional Matching Considerations:
- Give higher priority to matches found through path-based matching
- Consider the type of UI element when evaluating matches
- Take into account the annotation's context and content
- Use a combination of strategies for more accurate matching

## Step 5: Apply Native Annotations

Convert matched annotations to Figma's native annotations using batch processing:

\`\`\`typescript
// Prepare annotations array for batch processing
const annotationsToApply = Object.values(annotations).map(({ marker, description }) => {
  // Find target using multiple strategies
  const target = 
    findTargetByPath(marker, targetNodes) ||
    findTargetByName(description, targetNodes) ||
    findTargetByProximity(marker, targetNodes);
  
  if (target) {
    // Determine appropriate category based on content
    const category = determineCategory(description.characters, categories);

    // Determine appropriate additional annotationProperty based on content
    const annotationProperty = determineProperties(description.characters, target.type);
    
    return {
      nodeId: target.id,
      labelMarkdown: description.characters,
      categoryId: category.id,
      properties: annotationProperty
    };
  }
  return null;
}).filter(Boolean); // Remove null entries

// Apply annotations in one batch using set_annotations
if (annotationsToApply.length > 0) {
  await set_annotations({
    annotations: annotationsToApply
  });
}
\`\`\`


This strategy focuses on practical implementation based on real-world usage patterns, emphasizing the importance of handling various UI elements as annotation targets, not just text nodes.`
          },
        },
      ],
      description: "Strategy for converting manual annotations to Figma's native annotations",
    };
  }
);

// Instance Slot Filling Strategy Prompt
server.prompt(
  "swap_overrides_instances",
  "Guide to swap instance overrides between instances",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Swap Component Instance and Override Strategy

## Overview
This strategy enables transferring content and property overrides from a source instance to one or more target instances in Figma, maintaining design consistency while reducing manual work.

## Step-by-Step Process

### 1. Selection Analysis
- Use \`get_selection()\` to identify the parent component or selected instances
- For parent components, list instances with \`glob_nodes({ root: "parent-id", type: "INSTANCE" })\`
- Identify custom slots by name patterns (e.g. "Custom Slot*" or "Instance Slot") or by examining text content
- Determine which is the source instance (with content to copy) and which are targets (where to apply content)

### 2. Extract Source Overrides
- Use \`get_instance_overrides()\` to extract customizations from the source instance
- This captures text content, property values, and style overrides
- Command syntax: \`get_instance_overrides({ nodeId: "source-instance-id" })\`
- Look for successful response like "Got component information from [instance name]"

### 3. Apply Overrides to Targets
- Apply captured overrides using \`set_instance_overrides()\`
- Command syntax:
  \`\`\`
  set_instance_overrides({
    sourceInstanceId: "source-instance-id", 
    targetNodeIds: ["target-id-1", "target-id-2", ...]
  })
  \`\`\`

### 4. Verification
- Verify results with \`read_node()\` (pass nodeIds, or omit for the current selection)
- Confirm text content and style overrides have transferred successfully

## Key Tips
- Always join the appropriate channel first with \`join_channel()\`
- When working with multiple targets, check the full selection with \`get_selection()\`
- Preserve component relationships by using instance overrides rather than direct text manipulation`,
          },
        },
      ],
      description: "Strategy for transferring overrides between component instances in Figma",
    };
  }
);

// A tool to get Figma Prototyping Reactions from multiple nodes
server.tool(
  "get_reactions",
  "Get Figma Prototyping Reactions from multiple nodes. CRITICAL: The output MUST be processed using the 'reaction_to_connector_strategy' prompt IMMEDIATELY to generate parameters for connector lines via the 'create_connections' tool.",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to get reactions from"),
    ...saveParams,
  },
  async ({ nodeIds, saveToFile, outputPath }: any) => {
    try {
      const result = await sendCommandToFigma("get_reactions", { nodeIds });
      return {
        content: [
          await jsonContent(result, { saveToFile, outputPath }, "reactions"),
          {
            type: "text",
            text: "IMPORTANT: You MUST now use the reaction data above and follow the `reaction_to_connector_strategy` prompt to prepare the parameters for the `create_connections` tool call. This is a required next step."
          }
        ],
        followUp: {
          type: "prompt",
          prompt: "reaction_to_connector_strategy",
        },
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting reactions: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Schemas for set_reactions: a Figma Reaction is `{ trigger, actions }`. We keep
// these permissive (.passthrough()) so newer Figma fields pass through unblocked.
const transitionSchema = z
  .object({
    type: z
      .enum([
        "DISSOLVE",
        "SMART_ANIMATE",
        "SCROLL_ANIMATE",
        "MOVE_IN",
        "MOVE_OUT",
        "PUSH",
        "SLIDE_IN",
        "SLIDE_OUT",
      ])
      .describe("Animation style for the navigation"),
    easing: z.object({ type: z.string() }).passthrough().optional(),
    duration: z.number().optional().describe("Duration in seconds"),
    direction: z.enum(["LEFT", "RIGHT", "TOP", "BOTTOM"]).optional(),
    matchLayers: z.boolean().optional().describe("SMART_ANIMATE: match layers by name"),
  })
  .passthrough();

const reactionActionSchema = z
  .object({
    type: z
      .enum([
        "BACK",
        "CLOSE",
        "URL",
        "NODE",
        "SET_VARIABLE",
        "SET_VARIABLE_MODE",
        "CONDITIONAL",
        "UPDATE_MEDIA_RUNTIME",
      ])
      .describe("Action kind. NODE = navigate/overlay/swap to another frame."),
    url: z.string().optional().describe("URL action: link to open"),
    destinationId: z
      .string()
      .nullable()
      .optional()
      .describe("NODE action: target node id (the frame to navigate/swap/overlay to)"),
    navigation: z
      .enum(["NAVIGATE", "SWAP", "OVERLAY", "SCROLL_TO", "CHANGE_TO"])
      .optional()
      .describe("NODE action: how the destination is presented"),
    transition: transitionSchema.nullable().optional(),
    preserveScrollPosition: z.boolean().optional(),
    overlayRelativePosition: z.object({ x: z.number(), y: z.number() }).optional(),
    resetVideoPosition: z.boolean().optional(),
    resetScrollPosition: z.boolean().optional(),
    resetInteractionState: z.boolean().optional(),
  })
  .passthrough();

const reactionTriggerSchema = z
  .object({
    type: z
      .enum([
        "ON_CLICK",
        "ON_HOVER",
        "ON_PRESS",
        "ON_DRAG",
        "AFTER_TIMEOUT",
        "MOUSE_ENTER",
        "MOUSE_LEAVE",
        "MOUSE_UP",
        "MOUSE_DOWN",
        "ON_KEY_DOWN",
        "ON_MEDIA_HIT",
        "ON_MEDIA_END",
      ])
      .describe("What initiates the reaction"),
    timeout: z.number().optional().describe("AFTER_TIMEOUT: delay in seconds"),
    delay: z.number().optional().describe("MOUSE_* triggers: delay in seconds"),
    device: z.string().optional().describe("ON_KEY_DOWN: input device (e.g. KEYBOARD)"),
    keyCodes: z.array(z.number()).optional().describe("ON_KEY_DOWN: key codes"),
    mediaHitTime: z.number().optional().describe("ON_MEDIA_HIT: time in seconds"),
  })
  .passthrough();

const reactionSchema = z
  .object({
    trigger: reactionTriggerSchema.nullable().describe("The interaction that fires the actions"),
    actions: z.array(reactionActionSchema).optional().describe("Actions to run when triggered"),
    action: reactionActionSchema
      .optional()
      .describe("Deprecated single-action form; prefer `actions`"),
  })
  .passthrough();

// A tool to write Figma Prototyping Reactions onto nodes (create prototype flows/transitions)
server.tool(
  "set_reactions",
  "Install prototyping reactions (interactions/transitions) onto Figma nodes via setReactionsAsync — the write-side twin of get_reactions. Use this to create prototype flows: e.g. an ON_CLICK trigger with a NODE action navigating to another frame with a SMART_ANIMATE transition. NOTE: this REPLACES the full reaction list on each node, so pass the complete desired set (use get_reactions first to preserve existing ones). Most scene nodes support reactions; pages/documents do not.",
  {
    reactions: z
      .array(
        z.object({
          nodeId: z.string().describe("ID of the node to attach reactions to"),
          reactions: z
            .array(reactionSchema)
            .describe("Complete list of reactions to set on this node (replaces existing)"),
        })
      )
      .describe("Per-node reaction sets to install"),
  },
  async ({ reactions }: any) => {
    try {
      const result = await sendCommandToFigma("set_reactions", { reactions });
      const typed = result as {
        total: number;
        succeeded: number;
        failed: number;
        results: Array<{ nodeId?: string; success: boolean; error?: string; reactionsCount?: number }>;
      };
      const failures = typed.results.filter((r) => !r.success);
      const summary = `Set reactions on ${typed.succeeded}/${typed.total} nodes${
        typed.failed ? `, ${typed.failed} failed` : ""
      }.${failures.length ? ` Failures: ${failures.map((f) => `${f.nodeId ?? "?"}: ${f.error}`).join("; ")}` : ""}`;
      return {
        content: [{ type: "text", text: summary }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting reactions: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Create Connectors Tool
server.tool(
  "set_default_connector",
  "Set a copied connector node as the default connector",
  {
    connectorId: z.string().optional().describe("The ID of the connector node to set as default")
  },
  async ({ connectorId }: any) => {
    try {
      const result = await sendCommandToFigma("set_default_connector", {
        connectorId
      });

      return {
        content: [
          {
            type: "text",
            text: `Default connector set: ${JSON.stringify(result)}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting default connector: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Connect Nodes Tool
server.tool(
  "create_connections",
  "Create connections between nodes using the default connector style",
  {
    connections: z.array(z.object({
      startNodeId: z.string().describe("ID of the starting node"),
      endNodeId: z.string().describe("ID of the ending node"),
      text: z.string().optional().describe("Optional text to display on the connector")
    })).describe("Array of node connections to create")
  },
  async ({ connections }: any) => {
    try {
      if (!connections || connections.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No connections provided"
            }
          ]
        };
      }

      const result = await sendCommandToFigma("create_connections", {
        connections
      });

      return {
        content: [
          {
            type: "text",
            text: `Created ${connections.length} connections: ${JSON.stringify(result)}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating connections: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Set Focus Tool
server.tool(
  "set_focus",
  "Set focus on a specific node in Figma by selecting it and scrolling viewport to it",
  {
    nodeId: z.string().describe("The ID of the node to focus on"),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("set_focus", { nodeId });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Focused on node "${typedResult.name}" (ID: ${typedResult.id})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting focus: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Selections Tool
server.tool(
  "set_selections",
  "Set selection to multiple nodes in Figma and scroll viewport to show them",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to select"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("set_selections", { nodeIds });
      const typedResult = result as { selectedNodes: Array<{ name: string; id: string }>; count: number };
      return {
        content: [
          {
            type: "text",
            text: `Selected ${typedResult.count} nodes: ${typedResult.selectedNodes.map(node => `"${node.name}" (${node.id})`).join(', ')}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting selections: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Combine standalone components into a variant set (COMPONENT_SET)
server.tool(
  "combine_as_variants",
  "Combine 2+ standalone COMPONENT nodes into a single COMPONENT_SET (variants). Figma derives variant properties from each component's name in \"Prop=Value, Prop2=Value2\" form, so pass `rename` to set those names atomically before merging (e.g. State=Default, State=Hover). All components must be on the same page. By default the variants are packed into a tidy grid (the raw Figma API keeps each component's original x/y, leaving gaps) — when there are exactly 2 variant props the grid is the variant matrix (prop1 down rows, prop2 across columns), otherwise a near-square wrap; pass `arrange:false` to keep the source positions, or `gap` to set the spacing (default 16).",
  {
    nodeIds: z.array(z.string()).min(2).describe("IDs of the COMPONENT nodes to combine (at least 2, same page)"),
    name: z.string().optional().describe("Name for the resulting component set"),
    parentId: z.string().optional().describe("Parent node to place the set in (defaults to current page)"),
    rename: z
      .array(z.object({ nodeId: z.string(), name: z.string() }))
      .optional()
      .describe("Rename components before combining, to set variant props via \"Prop=Value\" naming"),
    arrange: z.boolean().optional().describe("Pack variants into a grid after combining (default true). false keeps source x/y."),
    gap: z.number().min(0).optional().describe("Spacing between variants when arranging (px, default 16)."),
  },
  async ({ nodeIds, name, parentId, rename, arrange, gap }: any) => {
    try {
      const result: any = await sendCommandToFigma("combine_as_variants", { nodeIds, name, parentId, rename, arrange, gap });
      const props = result.variantProperties
        ? Object.entries(result.variantProperties)
            .map(([k, v]: any) => `${k}: [${(v?.values || []).join(", ")}]`)
            .join("; ")
        : "none";
      const warn = result.variantWarning ? `\n⚠️ ${result.variantWarning}` : "";
      const grid = result.arranged ? ", packed into a grid" : "";
      return {
        content: [
          {
            type: "text",
            text: `Created component set "${result.name}" (ID: ${result.id}) with ${result.childCount} variants${grid}. Properties: ${props}${warn}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error combining as variants: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Boolean operations: cut/merge shapes into a single BOOLEAN_OPERATION node
server.tool(
  "boolean_operation",
  "Combine 2+ vector/shape nodes with a boolean operation into one non-destructive BOOLEAN_OPERATION node (children stay editable). `union` merges, `subtract` cuts the 2nd+ nodes out of the 1st, `intersect` keeps only overlap, `exclude` keeps the non-overlapping parts. Order matters for subtract/exclude — the first nodeId is the base. Operands should be vectors, shapes (rect/ellipse/polygon/star), or other boolean ops.",
  {
    operation: z
      .enum(["union", "subtract", "intersect", "exclude"])
      .describe("Which boolean op to apply"),
    nodeIds: z
      .array(z.string())
      .min(2)
      .describe("IDs of the nodes to combine (at least 2). For subtract/exclude the first is the base."),
    name: z.string().optional().describe("Name for the resulting boolean operation node"),
    parentId: z.string().optional().describe("Parent node to place the result in (defaults to current page)"),
  },
  async ({ operation, nodeIds, name, parentId }: any) => {
    try {
      const result: any = await sendCommandToFigma("boolean_operation", { operation, nodeIds, name, parentId });
      return {
        content: [
          {
            type: "text",
            text: `Created ${operation} "${result.name}" (ID: ${result.id}) from ${result.childCount} nodes.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error performing boolean operation: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Convert existing nodes into a different kind of node, in place
server.tool(
  "convert_nodes",
  "Convert existing nodes into a different kind of node, in place — four operations that write_nodes/edit_nodes can't express (this is NOT rotate/scale; for those set `rotation` or `width`/`height` via edit_nodes). `flatten`: merge ALL nodeIds into one VectorNode (overlaps/strokes baked into a single path). `outline_stroke`: per node, create a new vector of the stroke rendered as fills (the original node is left untouched); skipped when a node has no stroke. `to_component`: per node, convert a FRAME/GROUP/etc into a COMPONENT preserving its children (unlike a write_nodes COMPONENT, which starts empty). `detach`: per node, detach an INSTANCE into a standalone FRAME. Returns the new node id(s) — ids change for flatten/to_component/detach.",
  {
    operation: z
      .enum(["flatten", "outline_stroke", "to_component", "detach"])
      .describe("Which conversion to apply"),
    nodeIds: z
      .array(z.string())
      .min(1)
      .describe("Nodes to convert. `flatten` merges all of them into one; the other ops map 1:1."),
    name: z
      .string()
      .optional()
      .describe("Name for the resulting node. Applied to the flatten result, or to a single-node result; ignored when an op produces multiple nodes."),
    parentId: z
      .string()
      .optional()
      .describe("flatten only: parent to place the merged vector in (defaults to the first node's parent)."),
  },
  async ({ operation, nodeIds, name, parentId }: any) => {
    try {
      const result: any = await sendCommandToFigma("convert_nodes", { operation, nodeIds, name, parentId });
      const lines = (result.results || []).map((r: any) =>
        r.newId
          ? `${r.oldId || (r.oldIds || []).join("+")} → ${r.newId}${r.name ? ` "${r.name}"` : ""}${r.type ? ` (${r.type})` : ""}`
          : `${r.oldId} → skipped: ${r.skipped}`
      );
      return {
        content: [
          {
            type: "text",
            text: `convert_nodes (${operation}):\n${lines.join("\n")}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error transforming nodes: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// List fonts available to loadFontAsync
server.tool(
  "list_fonts",
  "List font families available in Figma so you don't guess names that loadFontAsync would reject. Returns families with their styles. Pass `query` to filter by a case-insensitive substring of the family name — strongly recommended, the unfiltered list has thousands of families. `limit` caps the number of families returned (default 200).",
  {
    query: z.string().optional().describe("Case-insensitive substring to filter family names (e.g. 'inter', 'roboto')"),
    limit: z.number().optional().describe("Max families to return (default 200)"),
    ...saveParams,
  },
  async ({ query, limit, saveToFile, outputPath }: any) => {
    try {
      const result = await sendCommandToFigma("list_fonts", { query, limit });
      return {
        content: [await jsonContent(result, { saveToFile, outputPath }, "fonts")],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error listing fonts: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Per-character-range text styling (the mixed-style edits edit_nodes can't do)
server.tool(
  "style_text_range",
  "Apply per-character-range styling to a TEXT node — the mixed-style edits edit_nodes can't express, since a node-level setter writes the whole text. Each entry is a [start, end) character span (start inclusive, end exclusive) with one or more style props; only the props you pass on that span are changed. Fonts for the affected ranges are loaded automatically. Read the node's current runs first via read_node_raw → `styledTextSegments`. `hyperlink`: pass a URL string (or {type:'URL'|'NODE', value}) to set it, or null to clear it. Colors in `fills` accept #RRGGBB.",
  {
    nodeId: z.string().describe("The TEXT node to style"),
    ranges: z
      .array(
        z.object({
          start: z.number().describe("Start character index (inclusive)"),
          end: z.number().describe("End character index (exclusive)"),
          fontName: z
            .object({ family: z.string(), style: z.string() })
            .optional()
            .describe("Font for this range (loaded automatically). Use list_fonts to get valid family/style."),
          fontSize: z.number().optional(),
          fills: z.array(z.any()).optional().describe("Paint array; a paint's color accepts #RRGGBB"),
          textCase: z
            .enum(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"])
            .optional(),
          textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
          letterSpacing: z.any().optional().describe("Number (px shorthand) or {value, unit}"),
          lineHeight: z
            .any()
            .optional()
            .describe("Number (px shorthand) or {value, unit:'PIXELS'|'PERCENT'} or {unit:'AUTO'}"),
          hyperlink: z.any().optional().describe("URL string, {type,value}, or null to clear"),
          listOptions: z.object({ type: z.enum(["ORDERED", "UNORDERED", "NONE"]) }).optional(),
          indentation: z.number().optional(),
          textStyleId: z.string().optional().describe("Apply a shared text style by id"),
          fillStyleId: z.string().optional().describe("Apply a shared paint/fill style by id"),
        })
      )
      .min(1)
      .describe("Character ranges to style"),
  },
  async ({ nodeId, ranges }: any) => {
    try {
      const result: any = await sendCommandToFigma("style_text_range", { nodeId, ranges });
      const lines = (result.ranges || []).map(
        (r: any) => `[${r.start},${r.end}) → ${(r.applied || []).join(", ") || "no-op"}`
      );
      return {
        content: [
          {
            type: "text",
            text: `Styled ${result.ranges.length} range(s) on ${result.nodeId} (text length ${result.length}):\n${lines.join("\n")}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error styling text range: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Group / ungroup nodes
server.tool(
  "edit_groups",
  "Group or ungroup nodes. `group` wraps 2+ nodes in a new GROUP (placed in the first node's current parent unless `parentId` is given). `ungroup` dissolves each GROUP/FRAME in `nodeIds` back into its parent and returns the freed children with their new IDs (ungroup reparents, so IDs change). A GROUP is a lightweight container with no layout/clipping of its own — use a FRAME (via write_nodes) when you need auto-layout, padding, or clipping.",
  {
    operation: z.enum(["group", "ungroup"]).describe("`group` to wrap nodes, `ungroup` to dissolve containers"),
    nodeIds: z
      .array(z.string())
      .min(1)
      .describe("For `group`: the 2+ nodes to wrap. For `ungroup`: the GROUP/FRAME nodes to dissolve."),
    name: z.string().optional().describe("Name for the new group (group only)"),
    parentId: z.string().optional().describe("Parent to place the group in; defaults to the first node's parent (group only)"),
  },
  async ({ operation, nodeIds, name, parentId }: any) => {
    try {
      const result: any = await sendCommandToFigma("edit_groups", { operation, nodeIds, name, parentId });
      const text =
        operation === "group"
          ? `Grouped ${result.childCount} nodes into "${result.name}" (ID: ${result.id}).`
          : `Ungrouped ${nodeIds.length} container(s) into ${result.childCount} nodes: ${result.children
              .map((c: any) => `${c.name} (${c.id})`)
              .join(", ")}.`;
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error editing groups: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// FigJam tables: a 2D grid that write_nodes can't express (its `children` is a
// flat list). FigJam files only.
server.tool(
  "write_table",
  "Create a FigJam TABLE (FigJam files only) of `rows`×`columns` cells, optionally filling cell text. Cells are 0-indexed via {row, column, text}; omitted cells stay empty. A table is a FigJam-native 2D grid, so write_nodes can't build it. Use edit_table afterwards to add/remove/resize rows & columns or change cell text.",
  {
    rows: z.number().int().min(1).describe("number of rows"),
    columns: z.number().int().min(1).describe("number of columns"),
    cells: z
      .array(
        z.object({
          row: z.number().int().min(0),
          column: z.number().int().min(0),
          text: z.string(),
        })
      )
      .optional()
      .describe("cell contents, 0-indexed (row, column); omitted cells stay empty"),
    parentId: z.string().optional().describe("container to place the table in; defaults to current page"),
    index: z.number().int().min(0).optional().describe("position among siblings"),
    x: z.number().optional().describe("x position (ignored inside an auto-layout parent)"),
    y: z.number().optional().describe("y position (ignored inside an auto-layout parent)"),
    name: z.string().optional().describe("name for the table node"),
  },
  async ({ rows, columns, cells, parentId, index, x, y, name }: any) => {
    try {
      const result: any = await sendCommandToFigma("write_table", { rows, columns, cells, parentId, index, x, y, name });
      const warn = result.cellErrors?.length
        ? ` (${result.cellErrors.length} cell error(s): ${result.cellErrors.map((e: any) => `(${e.row},${e.column}) ${e.error}`).join("; ")})`
        : "";
      return {
        content: [
          { type: "text", text: `Created TABLE "${result.name}" (ID: ${result.id}) — ${result.numRows}×${result.numColumns}.${warn}` },
        ],
      };
    } catch (error) {
      return {
        content: [
          { type: "text", text: `Error creating table: ${error instanceof Error ? error.message : String(error)}` },
        ],
      };
    }
  }
);

server.tool(
  "edit_table",
  "Mutate an existing FigJam TABLE: append rows/columns, remove rows/columns by index, resize them, and/or set cell text. Operations apply in a fixed order — addColumns, addRows, removeColumns, removeRows, resizeColumns, resizeRows, then cells — so cell coordinates and resize indices refer to the resulting grid. Removes run high-index-first, so a list like [1,3] is safe.",
  {
    tableId: z.string().describe("ID of the TABLE node to edit"),
    addRows: z.number().int().min(0).optional().describe("append this many rows at the bottom"),
    addColumns: z.number().int().min(0).optional().describe("append this many columns at the right"),
    removeRows: z.array(z.number().int().min(0)).optional().describe("row indices to remove (0-indexed)"),
    removeColumns: z.array(z.number().int().min(0)).optional().describe("column indices to remove (0-indexed)"),
    resizeRows: z
      .array(z.object({ index: z.number().int().min(0), height: z.number().positive() }))
      .optional()
      .describe("set row heights by index"),
    resizeColumns: z
      .array(z.object({ index: z.number().int().min(0), width: z.number().positive() }))
      .optional()
      .describe("set column widths by index"),
    cells: z
      .array(
        z.object({
          row: z.number().int().min(0),
          column: z.number().int().min(0),
          text: z.string(),
        })
      )
      .optional()
      .describe("cell contents to set, 0-indexed against the resulting grid"),
  },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("edit_table", args);
      const warn = result.errors?.length
        ? ` (${result.errors.length} error(s): ${result.errors.map((e: any) => `${e.op}: ${e.error}`).join("; ")})`
        : "";
      return {
        content: [
          { type: "text", text: `Edited TABLE "${result.name}" (ID: ${result.id}) — now ${result.numRows}×${result.numColumns}.${warn}` },
        ],
      };
    } catch (error) {
      return {
        content: [
          { type: "text", text: `Error editing table: ${error instanceof Error ? error.message : String(error)}` },
        ],
      };
    }
  }
);

// ---- Variables / design tokens ----

server.tool(
  "get_variables",
  "Read local Figma variables (design tokens): every variable collection, its modes, and each variable's per-mode value. Colors come back as hex, and aliases (variables referencing other variables) resolve to {alias: <target name>, aliasId}. Use this to discover token names/ids before binding or updating them. Pass `collection` to filter to one collection by name or id.",
  {
    collection: z.string().optional().describe("Limit to a single collection by name or id"),
  },
  async ({ collection }: any) => {
    try {
      const result: any = await sendCommandToFigma("get_variables", { collection });
      const cols = result.collections || [];
      const summary = cols.length
        ? cols
            .map(
              (c: any) =>
                `• ${c.name} (${c.id}) — modes: ${c.modes.map((m: any) => m.name).join(", ")}; ${c.variableCount} variables`
            )
            .join("\n")
        : "No local variable collections found.";
      return {
        content: [
          { type: "text", text: `${summary}\n\n${JSON.stringify(result, null, 2)}` },
        ],
      };
    } catch (error) {
      return {
        content: [
          { type: "text", text: `Error reading variables: ${error instanceof Error ? error.message : String(error)}` },
        ],
      };
    }
  }
);

server.tool(
  "set_variables",
  "Create or update Figma variables (design tokens), collections, and modes in one call (upsert). Match an existing collection/variable by `id`, or by `name` to update it, or omit both to create. New variables require `type` (COLOR|FLOAT|STRING|BOOLEAN). Set per-mode values via `valuesByMode` keyed by mode name; COLOR accepts hex (\"#RRGGBB\"/\"#RRGGBBAA\") or {r,g,b,a} 0-1. A value of {alias: \"<other variable name>\"} (or {alias id}) makes the variable reference another — aliases resolve after all variables in the batch are created, so forward references within the call work. NOTE: more than one mode per collection requires a paid Figma plan.",
  {
    collections: z
      .array(
        z.object({
          id: z.string().optional().describe("Existing collection id to update"),
          name: z.string().optional().describe("Collection name (used to match or create)"),
          modes: z
            .array(z.string())
            .optional()
            .describe("Desired mode names; the first becomes the default mode of a new collection"),
          variables: z
            .array(
              z.object({
                id: z.string().optional().describe("Existing variable id to update"),
                name: z.string().describe("Variable name; '/' creates token groups (e.g. 'color/bg/primary')"),
                type: z
                  .enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"])
                  .optional()
                  .describe("Resolved type — required when creating a new variable"),
                scopes: z.array(z.string()).optional().describe("Variable scopes (e.g. ALL_SCOPES, TEXT_CONTENT, CORNER_RADIUS)"),
                description: z.string().optional(),
                valuesByMode: z
                  .record(z.string(), z.any())
                  .optional()
                  .describe("Map of mode name → value (literal hex/number/string/boolean, or {alias: <name>})"),
              })
            )
            .optional(),
        })
      )
      .min(1)
      .describe("Collections to upsert, each with its modes and variables"),
  },
  async ({ collections }: any) => {
    try {
      const result: any = await sendCommandToFigma("set_variables", { collections });
      return {
        content: [
          {
            type: "text",
            text: `Variables updated: ${result.variablesCreated} created, ${result.variablesUpdated} updated across ${result.collections.length} collection(s).\n\n${JSON.stringify(result, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          { type: "text", text: `Error setting variables: ${error instanceof Error ? error.message : String(error)}` },
        ],
      };
    }
  }
);

server.tool(
  "bind_variables",
  "Bind a variable (design token) to a node property, or unbind it. Identify the variable by `variableId` (from get_variables) or `variableName`. `field` accepts node properties like width, height, cornerRadius (or per-corner topLeftRadius…), opacity, visible, characters, fontSize, lineHeight, letterSpacing, fontWeight, paragraphSpacing, itemSpacing (alias 'gap'), paddingLeft/Right/Top/Bottom — plus 'fills'/'strokes' to bind the paint color (use `paintIndex`, default 0). Set `unbind: true` to clear a binding.",
  {
    bindings: z
      .array(
        z.object({
          nodeId: z.string().describe("Target node id"),
          field: z.string().describe("Property to bind (e.g. 'fills', 'cornerRadius', 'fontSize', 'itemSpacing')"),
          variableId: z.string().optional().describe("Variable id to bind"),
          variableName: z.string().optional().describe("Variable name to bind (used if variableId omitted)"),
          paintIndex: z.number().optional().describe("For 'fills'/'strokes': which paint to bind (default 0)"),
          unbind: z.boolean().optional().describe("Clear the binding on this field instead of setting it"),
        })
      )
      .min(1)
      .describe("Bindings to apply"),
  },
  async ({ bindings }: any) => {
    try {
      const result: any = await sendCommandToFigma("bind_variables", { bindings });
      const lines = (result.results || []).map((r: any) =>
        r.error
          ? `✗ ${r.nodeId}.${r.field}: ${r.error}`
          : `${r.bound ? "✓ bound" : "✓ unbound"} ${r.nodeId}.${r.field}${r.variableName ? ` → ${r.variableName}` : ""}`
      );
      return {
        content: [
          { type: "text", text: `${result.applied}/${result.total} bindings applied.\n${lines.join("\n")}` },
        ],
      };
    } catch (error) {
      return {
        content: [
          { type: "text", text: `Error binding variables: ${error instanceof Error ? error.message : String(error)}` },
        ],
      };
    }
  }
);

// Strategy for converting Figma prototype reactions to connector lines
server.prompt(
  "reaction_to_connector_strategy",
  "Strategy for converting Figma prototype reactions to connector lines using the output of 'get_reactions'",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Strategy: Convert Figma Prototype Reactions to Connector Lines

## Goal
Process the JSON output from the \`get_reactions\` tool to generate an array of connection objects suitable for the \`create_connections\` tool. This visually represents prototype flows as connector lines on the Figma canvas.

## Input Data
You will receive JSON data from the \`get_reactions\` tool. This data contains an array of nodes, each with potential reactions. A typical reaction object looks like this:
\`\`\`json
{
  "trigger": { "type": "ON_CLICK" },
  "action": {
    "type": "NAVIGATE",
    "destinationId": "destination-node-id",
    "navigationTransition": { ... },
    "preserveScrollPosition": false
  }
}
\`\`\`

## Step-by-Step Process

### 1. Preparation & Context Gathering
   - **Action:** Call \`read_node\` on the relevant node(s) — pass their nodeIds, or omit nodeIds to read the current selection — to get context about the nodes involved (names, types, etc.). This helps in generating meaningful connector labels later.
   - **Action:** Call \`set_default_connector\` **without** the \`connectorId\` parameter.
   - **Check Result:** Analyze the response from \`set_default_connector\`.
     - If it confirms a default connector is already set (e.g., "Default connector is already set"), proceed to Step 2.
     - If it indicates no default connector is set (e.g., "No default connector set..."), you **cannot** proceed with \`create_connections\` yet. Inform the user they need to manually copy a connector from FigJam, paste it onto the current page, select it, and then you can run \`set_default_connector({ connectorId: "SELECTED_NODE_ID" })\` before attempting \`create_connections\`. **Do not proceed to Step 2 until a default connector is confirmed.**

### 2. Filter and Transform Reactions from \`get_reactions\` Output
   - **Iterate:** Go through the JSON array provided by \`get_reactions\`. For each node in the array:
     - Iterate through its \`reactions\` array.
   - **Filter:** Keep only reactions where the \`action\` meets these criteria:
     - Has a \`type\` that implies a connection (e.g., \`NAVIGATE\`, \`OPEN_OVERLAY\`, \`SWAP_OVERLAY\`). **Ignore** types like \`CHANGE_TO\`, \`CLOSE_OVERLAY\`, etc.
     - Has a valid \`destinationId\` property.
   - **Extract:** For each valid reaction, extract the following information:
     - \`sourceNodeId\`: The ID of the node the reaction belongs to (from the outer loop).
     - \`destinationNodeId\`: The value of \`action.destinationId\`.
     - \`actionType\`: The value of \`action.type\`.
     - \`triggerType\`: The value of \`trigger.type\`.

### 3. Generate Connector Text Labels
   - **For each extracted connection:** Create a concise, descriptive text label string.
   - **Combine Information:** Use the \`actionType\`, \`triggerType\`, and potentially the names of the source/destination nodes (obtained from Step 1's \`read_node\` call if necessary) to generate the label.
   - **Example Labels:**
     - If \`triggerType\` is "ON\_CLICK" and \`actionType\` is "NAVIGATE": "On click, navigate to [Destination Node Name]"
     - If \`triggerType\` is "ON\_DRAG" and \`actionType\` is "OPEN\_OVERLAY": "On drag, open [Destination Node Name] overlay"
   - **Keep it brief and informative.** Let this generated string be \`generatedText\`.

### 4. Prepare the \`connections\` Array for \`create_connections\`
   - **Structure:** Create a JSON array where each element is an object representing a connection.
   - **Format:** Each object in the array must have the following structure:
     \`\`\`json
     {
       "startNodeId": "sourceNodeId_from_step_2",
       "endNodeId": "destinationNodeId_from_step_2",
       "text": "generatedText_from_step_3"
     }
     \`\`\`
   - **Result:** This final array is the value you will pass to the \`connections\` parameter when calling the \`create_connections\` tool.

### 5. Execute Connection Creation
   - **Action:** Call the \`create_connections\` tool, passing the array generated in Step 4 as the \`connections\` argument.
   - **Verify:** Check the response from \`create_connections\` to confirm success or failure.

This detailed process ensures you correctly interpret the reaction data, prepare the necessary information, and use the appropriate tools to create the connector lines.`
          },
        },
      ],
      description: "Strategy for converting Figma prototype reactions to connector lines using the output of 'get_reactions'",
    };
  }
);


// Define command types and parameters
type FigmaCommand =
  | "get_selection"
  | "read_node"
  | "read_node_raw"
  | "write_nodes"
  | "delete_nodes"
  | "get_styles"
  | "write_styles"
  | "edit_styles"
  | "get_local_components"
  | "get_instance_overrides"
  | "set_instance_overrides"
  | "export_node_as_image"
  | "join"
  | "clone_node"
  | "get_annotations"
  | "set_annotations"
  | "glob_nodes"
  | "grep_nodes"
  | "query_nodes"
  | "edit_nodes"
  | "reparent_nodes"
  | "get_reactions"
  | "set_reactions"
  | "set_default_connector"
  | "create_connections"
  | "set_focus"
  | "set_selections"
  | "combine_as_variants"
  | "boolean_operation"
  | "convert_nodes"
  | "list_fonts"
  | "style_text_range"
  | "edit_groups"
  | "write_table"
  | "edit_table"
  | "get_variables"
  | "set_variables"
  | "bind_variables";

type CommandParams = {
  get_selection: Record<string, never>;
  read_node: { nodeId: string };
  read_node_raw: { nodeId: string };
  write_nodes: {
    nodes: Array<Record<string, any>>;
  };
  delete_nodes: {
    nodeIds: string[];
  };
  get_styles: Record<string, never>;
  write_styles: { styles: Array<Record<string, any>> };
  edit_styles: { styles: Array<Record<string, any>> };
  get_local_components: Record<string, never>;
  get_team_components: Record<string, never>;
  get_instance_overrides: {
    instanceNodeId: string | null;
  };
  set_instance_overrides: {
    targetNodeIds: string[];
    sourceInstanceId: string;
  };
  export_node_as_image: {
    nodeId: string;
    format?: "PNG" | "JPG" | "SVG" | "PDF";
    scale?: number | number[];
  };
  execute_code: {
    code: string;
  };
  join: {
    channel: string;
  };
  clone_node: {
    nodeId: string;
    x?: number;
    y?: number;
  };
  get_annotations: {
    nodeId?: string;
    includeCategories?: boolean;
  };
  set_annotations: {
    annotations: Array<{
      nodeId: string;
      labelMarkdown: string;
      categoryId?: string;
      annotationId?: string;
      properties?: Array<{ type: string }>;
    }>;
  };
  glob_nodes: {
    root?: string;
    name?: string;
    type?: string | Array<string>;
    depth?: number;
    bbox?: boolean;
    within?: { x: number; y: number; width: number; height: number };
  };
  grep_nodes: {
    pattern: string;
    root?: string;
    ignoreCase?: boolean;
    onlyMatch?: boolean;
    depth?: number;
    within?: { x: number; y: number; width: number; height: number };
    bbox?: boolean;
    maxMatches?: number;
  };
  query_nodes: {
    where: Array<{
      path: string;
      op?: "regex" | "gt" | "gte" | "lt" | "lte" | "color" | "exists" | "absent";
      value?: string | number | boolean;
      i?: boolean;
    }>;
    root?: string;
    depth?: number;
    within?: { x: number; y: number; width: number; height: number };
    bbox?: boolean;
    maxMatches?: number;
  };
  reparent_nodes: {
    moves: Array<{ nodeId: string; parentId?: string; index?: number }>;
  };
  get_reactions: { nodeIds: string[] };
  set_reactions: {
    reactions: Array<{ nodeId: string; reactions: Array<Record<string, any>> }>;
  };
  set_default_connector: {
    connectorId?: string | undefined;
  };
  create_connections: {
    connections: Array<{
      startNodeId: string;
      endNodeId: string;
      text?: string;
    }>;
  };
  set_focus: {
    nodeId: string;
  };
  set_selections: {
    nodeIds: string[];
  };
  combine_as_variants: {
    nodeIds: string[];
    name?: string;
    parentId?: string;
    rename?: Array<{ nodeId: string; name: string }>;
  };
  boolean_operation: {
    operation: "union" | "subtract" | "intersect" | "exclude";
    nodeIds: string[];
    name?: string;
    parentId?: string;
  };
  convert_nodes: {
    operation: "flatten" | "outline_stroke" | "to_component" | "detach";
    nodeIds: string[];
    name?: string;
    parentId?: string;
  };
  list_fonts: {
    query?: string;
    limit?: number;
  };
  style_text_range: {
    nodeId: string;
    ranges: Array<{
      start: number;
      end: number;
      fontName?: { family: string; style: string };
      fontSize?: number;
      fills?: any[];
      textCase?: string;
      textDecoration?: string;
      letterSpacing?: any;
      lineHeight?: any;
      hyperlink?: any;
      listOptions?: { type: string };
      indentation?: number;
      textStyleId?: string;
      fillStyleId?: string;
    }>;
  };
  edit_groups: {
    operation: "group" | "ungroup";
    nodeIds: string[];
    name?: string;
    parentId?: string;
  };
  write_table: {
    rows: number;
    columns: number;
    cells?: Array<{ row: number; column: number; text: string }>;
    parentId?: string;
    index?: number;
    x?: number;
    y?: number;
    name?: string;
  };
  edit_table: {
    tableId: string;
    addRows?: number;
    addColumns?: number;
    removeRows?: number[];
    removeColumns?: number[];
    resizeRows?: Array<{ index: number; height: number }>;
    resizeColumns?: Array<{ index: number; width: number }>;
    cells?: Array<{ row: number; column: number; text: string }>;
  };
  get_variables: {
    collection?: string;
  };
  set_variables: {
    collections: Array<{
      id?: string;
      name?: string;
      modes?: string[];
      variables?: Array<{
        id?: string;
        name: string;
        type?: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
        scopes?: string[];
        description?: string;
        valuesByMode?: Record<string, any>;
      }>;
    }>;
  };
  bind_variables: {
    bindings: Array<{
      nodeId: string;
      field: string;
      variableId?: string;
      variableName?: string;
      paintIndex?: number;
      unbind?: boolean;
    }>;
  };

};


// Update the connectToFigma function
function connectToFigma(port: number = 3055) {
  // If already connected, do nothing
  if (ws && ws.readyState === WebSocket.OPEN) {
    logger.info('Already connected to Figma');
    return;
  }

  const wsUrl = serverUrl === 'localhost' ? `${WS_URL}:${port}` : WS_URL;
  logger.info(`Connecting to Figma socket server at ${wsUrl}...`);
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    logger.info('Connected to Figma socket server');
    // Re-join the last channel so a reconnect is transparent. The plugin keeps
    // its channel across reconnects (ui.html); the server must too, otherwise
    // every blip forces the agent to call join_channel again to revive the session.
    if (currentChannel) {
      const channel = currentChannel;
      sendCommandToFigma('join', { channel }).then(
        () => logger.info(`Rejoined channel after reconnect: ${channel}`),
        (err) => logger.error(`Failed to rejoin channel ${channel}: ${err instanceof Error ? err.message : String(err)}`)
      );
    }
  });

  ws.on("message", (data: any) => {
    try {
      // Define a more specific type with an index signature to allow any property access
      interface ProgressMessage {
        message: FigmaResponse | any;
        type?: string;
        id?: string;
        [key: string]: any; // Allow any other properties
      }

      const json = JSON.parse(data) as ProgressMessage;

      // Relay fail-fast: no client in the channel received the command. Reject
      // the matching request now instead of waiting for the full timeout.
      if (json.type === 'error') {
        const errId = json.id || json.message?.id;
        if (errId && pendingRequests.has(errId)) {
          const request = pendingRequests.get(errId)!;
          clearTimeout(request.timeout);
          const reason = json.message?.error || json.message || 'Figma relay error';
          logger.error(`Relay error for request ${errId}: ${reason}`);
          request.reject(new Error(typeof reason === 'string' ? reason : JSON.stringify(reason)));
          pendingRequests.delete(errId);
        }
        return;
      }

      // Handle progress updates
      if (json.type === 'progress_update') {
        const progressData = json.message.data as CommandProgressUpdate;
        const requestId = json.id || '';

        if (requestId && pendingRequests.has(requestId)) {
          const request = pendingRequests.get(requestId)!;

          // Update last activity timestamp
          request.lastActivity = Date.now();

          // Reset the timeout to prevent timeouts during long-running operations
          clearTimeout(request.timeout);

          // Create a new timeout
          request.timeout = setTimeout(() => {
            if (pendingRequests.has(requestId)) {
              logger.error(`Request ${requestId} timed out after extended period of inactivity`);
              pendingRequests.delete(requestId);
              request.reject(new Error('Request to Figma timed out'));
            }
          }, 60000); // 60 second timeout for inactivity

          // Log progress
          logger.info(`Progress update for ${progressData.commandType}: ${progressData.progress}% - ${progressData.message}`);

          // For completed updates, we could resolve the request early if desired
          if (progressData.status === 'completed' && progressData.progress === 100) {
            // Optionally resolve early with partial data
            // request.resolve(progressData.payload);
            // pendingRequests.delete(requestId);

            // Instead, just log the completion, wait for final result from Figma
            logger.info(`Operation ${progressData.commandType} completed, waiting for final result`);
          }
        }
        return;
      }

      // Handle regular responses
      const myResponse = json.message;
      logger.debug(`Received message: ${JSON.stringify(myResponse)}`);
      logger.log('myResponse' + JSON.stringify(myResponse));

      // Handle response to a request
      if (
        myResponse.id &&
        pendingRequests.has(myResponse.id) &&
        myResponse.result
      ) {
        const request = pendingRequests.get(myResponse.id)!;
        clearTimeout(request.timeout);

        if (myResponse.error) {
          logger.error(`Error from Figma: ${myResponse.error}`);
          request.reject(new Error(myResponse.error));
        } else {
          if (myResponse.result) {
            request.resolve(myResponse.result);
          }
        }

        pendingRequests.delete(myResponse.id);
      } else {
        // Handle broadcast messages or events
        logger.info(`Received broadcast message: ${JSON.stringify(myResponse)}`);
      }
    } catch (error) {
      logger.error(`Error parsing message: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ws.on('error', (error) => {
    logger.error(`Socket error: ${error}`);
  });

  ws.on('close', () => {
    logger.info('Disconnected from Figma socket server');
    ws = null;

    // Reject all pending requests
    for (const [id, request] of pendingRequests.entries()) {
      clearTimeout(request.timeout);
      request.reject(new Error("Connection closed"));
      pendingRequests.delete(id);
    }

    // Attempt to reconnect
    logger.info('Attempting to reconnect in 2 seconds...');
    setTimeout(() => connectToFigma(port), 2000);
  });
}

// Function to join a channel
async function joinChannel(channelName: string): Promise<void> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Not connected to Figma");
  }

  try {
    await sendCommandToFigma("join", { channel: channelName });
    currentChannel = channelName;
    logger.info(`Joined channel: ${channelName}`);
  } catch (error) {
    logger.error(`Failed to join channel: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

// Wait for the socket to reach OPEN, kicking off a connect if needed. Bounded so
// a dead relay surfaces as an error instead of hanging the command forever.
function waitForConnection(timeoutMs: number = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    connectToFigma();
    const start = Date.now();
    const interval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`Unable to establish connection to Figma after ${timeoutMs / 1000} seconds`));
      }
    }, 100);
  });
}

// @ai-generated(solo)
// Relay fail-fast error when the plugin's socket is gone from the channel.
const NO_CLIENT_ERROR_RE = /No client is connected to channel/;

// The plugin restarted or its socket blipped. It auto-reconnects on a 1-2s
// backoff (and with the stable per-file channel id it usually rejoins the
// same channel) — poll the relay's active-channels file briefly for it to
// reappear instead of failing the command immediately.
async function recoverPluginChannel(): Promise<string | null> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const active = await readActiveChannels();
    if (active.length > 0) {
      // Prefer the channel we were already on; otherwise an unambiguous sole
      // channel. Multiple foreign channels → can't guess, let the agent pick.
      const same = active.find((c) => c.channel === currentChannel);
      if (same) return same.channel;
      if (active.length === 1) return active[0].channel;
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return null;
}

// Function to send commands to Figma
function sendCommandToFigma(
  command: FigmaCommand,
  params: unknown = {},
  timeoutMs: number = 30000,
  isRetry: boolean = false
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Ride out an in-flight reconnect instead of failing the first call after a
    // blip. 'join' is exempt: it is sent from the reconnect open-handler while
    // the socket is already OPEN, so it never needs to wait (and must not recurse).
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (command === 'join') {
        reject(new Error('Not connected to Figma'));
        return;
      }
      waitForConnection().then(() => sendCommandToFigma(command, params, timeoutMs).then(resolve, reject), reject);
      return;
    }

    // Check if we need a channel for this command
    const requiresChannel = command !== "join";
    if (requiresChannel && !currentChannel) {
      reject(new Error("Must join a channel before sending commands"));
      return;
    }

    // Translate short counter ids (n0, n1, ...) the agent saw in compact output
    // back to canonical Figma ids before the command leaves the server.
    try {
      params = resolveShortIdsInParams(params);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const id = uuidv4();
    const request = {
      id,
      type: command === "join" ? "join" : "message",
      ...(command === "join"
        ? { channel: (params as any).channel }
        : { channel: currentChannel }),
      message: {
        id,
        command,
        params: {
          ...(params as any),
          commandId: id, // Include the command ID in params
        },
      },
    };

    // Set timeout for request
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        logger.error(`Request ${id} to Figma timed out after ${timeoutMs / 1000} seconds`);
        reject(new Error('Request to Figma timed out'));
      }
    }, timeoutMs);

    // Relay said nobody handles the channel — the plugin likely restarted.
    // Re-discover its channel, rejoin if it moved, retry the command once,
    // all transparent to the agent. Anything else rejects as before.
    const rejectWithRecovery = (error: Error) => {
      if (isRetry || command === "join" || !NO_CLIENT_ERROR_RE.test(error.message)) {
        reject(error);
        return;
      }
      logger.info(`Plugin missing from channel ${currentChannel}; attempting recovery...`);
      recoverPluginChannel().then(
        (channel) => {
          if (!channel) {
            reject(error);
            return;
          }
          const rejoined =
            channel !== currentChannel ? joinChannel(channel) : Promise.resolve();
          rejoined.then(
            () => {
              logger.info(`Recovered plugin channel ${channel}; retrying ${command}`);
              sendCommandToFigma(command, params, timeoutMs, true).then(resolve, reject);
            },
            () => reject(error)
          );
        },
        () => reject(error)
      );
    };

    // Store the promise callbacks to resolve/reject later
    pendingRequests.set(id, {
      resolve,
      reject: rejectWithRecovery,
      timeout,
      lastActivity: Date.now()
    });

    // Send the request
    logger.info(`Sending command to Figma: ${command}`);
    logger.debug(`Request details: ${JSON.stringify(request)}`);
    ws.send(JSON.stringify(request));
  });
}

// Channels opened by a Figma plugin, written by the WebSocket relay (socket.ts).
const ACTIVE_CHANNELS_FILE = join(tmpdir(), "figma-active-channels.json");

interface ActiveChannel {
  channel: string;
  clients: number;
  // Context of the file the plugin has open: { name, page, editorType }.
  meta?: { name?: string; page?: string; editorType?: string };
}

// Read the channels the relay recorded as plugin-opened. Returns [] when the
// file is missing (relay not started, or no plugin connected yet).
async function readActiveChannels(): Promise<ActiveChannel[]> {
  try {
    const raw = await readFile(ACTIVE_CHANNELS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.channels) ? parsed.channels : [];
  } catch {
    return [];
  }
}

server.tool(
  "get_active_channel",
  "Get the channel(s) the Figma plugin currently has open, as recorded by the WebSocket relay. Each entry includes meta about the open file (name, current page, editorType: figma/figjam/dev/slides). Use this to discover the channel to join without asking the user to paste it.",
  {},
  async () => {
    const active = await readActiveChannels();
    if (active.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No active plugin channel found. Make sure the WebSocket relay (bun socket) is running and the Figma plugin is connected.",
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ active, currentChannel }, null, 2),
        },
      ],
    };
  }
);

// Update the join_channel tool
server.tool(
  "join_channel",
  "Join a specific channel to communicate with Figma. Leave channel empty to auto-join the channel the plugin currently has open (when exactly one is active).",
  {
    channel: z.string().describe("The name of the channel to join").default(""),
  },
  async ({ channel }: any) => {
    try {
      if (!channel) {
        // Try to auto-discover the plugin's open channel before asking the user.
        const active = await readActiveChannels();
        if (active.length === 1) {
          channel = active[0].channel;
        } else if (active.length > 1) {
          return {
            content: [
              {
                type: "text",
                text: `Multiple active channels found, pass one explicitly: ${active
                  .map((c) =>
                    c.meta?.name
                      ? `${c.channel} (${c.meta.name}${
                          c.meta.editorType ? `, ${c.meta.editorType}` : ""
                        })`
                      : c.channel
                  )
                  .join(", ")}`,
              },
            ],
          };
        } else {
          // No active channel recorded — fall back to asking the user.
          return {
            content: [
              {
                type: "text",
                text: "Please provide a channel name to join:",
              },
            ],
            followUp: {
              tool: "join_channel",
              description: "Join the specified channel",
            },
          };
        }
      }

      await joinChannel(channel);
      return {
        content: [
          {
            type: "text",
            text: `Successfully joined channel: ${channel}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error joining channel: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Start the server
async function main() {
  try {
    // Try to connect to Figma socket server
    connectToFigma();
  } catch (error) {
    logger.warn(`Could not connect to Figma initially: ${error instanceof Error ? error.message : String(error)}`);
    logger.warn('Will try to connect when the first command is sent');
  }

  // Start the MCP server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('FigmaMCP server running on stdio');
}

// Run the server
main().catch(error => {
  logger.error(`Error starting FigmaMCP server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});



