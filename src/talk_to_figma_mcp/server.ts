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

// Document Info Tool
server.tool(
  "get_document_info",
  "Get detailed information about the current Figma document",
  { ...saveParams },
  async ({ saveToFile, outputPath }: any) => {
    try {
      const result = await sendCommandToFigma("get_document_info");
      return {
        content: [await jsonContent(result, { saveToFile, outputPath }, "document-info")]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting document info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

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

// Read Node Tool — the Read tool for the canvas. Variadic; reads the selection
// when no ids are given. Compact subtree by default, full node props with raw.
server.tool(
  "read_node",
  "Read Figma nodes — the Read tool for the canvas. Pass `nodeIds` (one or many); omit it to read the current selection. Returns one entry per node. Default (compact) gives each node's subtree in a minimal, low-token field set (id, name, type, color/gradient, opacity, box or autoLayout, text); children expand to `depth` levels and deeper nodes become {childCount, more:true} stubs — re-request a stub's id or raise depth to zoom in. Set `raw:true` for the full, unfiltered JSON_REST_V1 of each node with ALL properties but the children array stripped (use when the compact view drops a field you need); in raw mode depth/collapse/cull are ignored — raw is always one node, all props, no children. Large outputs auto-spill to a file. Node ids are short counters (n0, n1, ...) standing in for canonical Figma ids — pass them to any tool. Locate ids with glob_nodes/grep_nodes first, then read_node to inspect properties.",
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
            node: await sendCommandToFigma("get_node_info_raw", { nodeId }),
          }))
        );
        return {
          content: [await jsonContent(nodes, { saveToFile, outputPath }, "node-raw")],
        };
      }

      const opts: ShapeArgs = { depth, collapseIcons, collapseRepeats, cull };
      const infos = await Promise.all(
        ids.map((nodeId) => sendCommandToFigma("get_node_info", { nodeId }))
      );
      // Renumber across the whole batch so short ids share one counter space.
      const shaped = renumberIds(infos.map((info) => shapeNode(info, opts)));
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
          return `${m.id}:${JSON.stringify(m.name)}.${m.type}${parent ? ` @${parent}` : ""}${box}`;
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
          ([id, e]) => `${id}:${JSON.stringify(e.name)}.${e.type}${fmtParent(e.parentId)} (${e.n} match${e.n === 1 ? "" : "es"})`
        );
        text = (lines.join("\n") || "(no matches)") + (result?.truncated ? "\n(truncated)" : "");
        summary = `${counts.size} nodes`;
      } else {
        const lines = matches.map(
          (m: any) => `${m.id}:${JSON.stringify(m.name)}.${m.type}${fmtParent(m.parentId)}${fmtBox(m)} L${m.line}: ${m.text}`
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
        return `${m.id}:${JSON.stringify(m.name)}.${m.type}${parent}${box}${props ? ` {${props}}` : ""}`;
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
  "Edit node properties directly in the node model — the write-side twin of query_nodes/read_node, an Edit tool for Figma JSON instead of text. Pass `edits`: an array of `{nodeId, path, old?, new}`. `path` addresses one field the same way query_nodes does — dot for objects, `[i]` for an array index (e.g. `name`, `cornerRadius`, `fills[0].color`, `fills[0].opacity`); no `[*]` (a write needs one concrete target). `new` is the value to set: colors as `#RRGGBB` are converted to Figma's rgb 0-1, and whole objects/arrays are allowed (e.g. set `fills[0]` to a full paint). `old` is an OPTIONAL guard, exactly like the old_string in Edit — if given and it doesn't match the current value (colors compared as hex, numbers tolerantly), that one edit is rejected so you never blind-overwrite a stale read. Edits run in order and are INDEPENDENT: one failing — guard mismatch, read-only/derived prop, a type Figma rejects, font not loaded — records its Figma error and the rest still apply. The result lists each edit as `✓ id path: old → new` or `✗ id path: <error>`, so a failure tells you exactly what to fix. One call can touch many nodes (each edit names its own `nodeId`) — this is also how you bulk-replace text across components: one `{nodeId, path:\"characters\", new:\"...\"}` per text node in a single call (the `characters` path loads the node's font for you). Large batches stream progress, so a long run won't time out. Common paths: `name`, `characters`, `x`/`y`, `width`/`height` (resize), `cornerRadius`, `fills[0].color` (#RRGGBB), `opacity`, `layoutMode`, `paddingTop`, `itemSpacing`, `primaryAxisAlignItems`, `layoutSizingHorizontal`. nodeId accepts short ids (n0, ...) or full Figma ids.",
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
      const result: any = await sendCommandToFigma("edit_nodes", { edits });
      const fmt = (v: any) =>
        v === null || v === undefined
          ? "(absent)"
          : typeof v === "object"
          ? JSON.stringify(v)
          : String(v);
      const rows = (result?.results || []).map((r: any) => {
        const id = renumberIds({ id: r.nodeId }).id;
        return r.ok
          ? `✓ ${id} ${r.path}: ${fmt(r.old)} → ${fmt(r.new)}`
          : `✗ ${id} ${r.path}: ${r.error}`;
      });
      const text = `applied ${result?.applied || 0}/${result?.total || 0}` + (rows.length ? "\n" + rows.join("\n") : "");
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

function rgbaToHex(color: any): string {
  // skip if color is already hex
  if (color.startsWith('#')) {
    return color;
  }

  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = Math.round(color.a * 255);

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}${a === 255 ? '' : a.toString(16).padStart(2, '0')}`;
}

function filterFigmaNode(node: any) {
  // Skip VECTOR type nodes
  if (node.type === "VECTOR") {
    return null;
  }

  const filtered: any = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  if (node.fills && node.fills.length > 0) {
    filtered.fills = node.fills.map((fill: any) => {
      const processedFill = { ...fill };

      // Remove boundVariables and imageRef
      delete processedFill.boundVariables;
      delete processedFill.imageRef;

      // Process gradientStops if present
      if (processedFill.gradientStops) {
        processedFill.gradientStops = processedFill.gradientStops.map((stop: any) => {
          const processedStop = { ...stop };
          // Convert color to hex if present
          if (processedStop.color) {
            processedStop.color = rgbaToHex(processedStop.color);
          }
          // Remove boundVariables
          delete processedStop.boundVariables;
          return processedStop;
        });
      }

      // Convert solid fill colors to hex
      if (processedFill.color) {
        processedFill.color = rgbaToHex(processedFill.color);
      }

      return processedFill;
    });
  }

  if (node.strokes && node.strokes.length > 0) {
    filtered.strokes = node.strokes.map((stroke: any) => {
      const processedStroke = { ...stroke };
      // Remove boundVariables
      delete processedStroke.boundVariables;
      // Convert color to hex if present
      if (processedStroke.color) {
        processedStroke.color = rgbaToHex(processedStroke.color);
      }
      return processedStroke;
    });
  }

  if (node.cornerRadius !== undefined) {
    filtered.cornerRadius = node.cornerRadius;
  }

  if (node.absoluteBoundingBox) {
    filtered.absoluteBoundingBox = node.absoluteBoundingBox;
  }

  if (node.characters) {
    filtered.characters = node.characters;
  }

  if (node.style) {
    filtered.style = {
      fontFamily: node.style.fontFamily,
      fontStyle: node.style.fontStyle,
      fontWeight: node.style.fontWeight,
      fontSize: node.style.fontSize,
      textAlignHorizontal: node.style.textAlignHorizontal,
      letterSpacing: node.style.letterSpacing,
      lineHeightPx: node.style.lineHeightPx
    };
  }

  if (node.children) {
    filtered.children = node.children
      .map((child: any) => filterFigmaNode(child))
      .filter((child: any) => child !== null); // Remove null children (VECTOR nodes)
  }

  return filtered;
}

// Create Rectangle Tool
server.tool(
  "create_rectangle",
  "Create a new rectangle in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the rectangle"),
    height: z.number().describe("Height of the rectangle"),
    name: z.string().optional().describe("Optional name for the rectangle"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the rectangle to"),
  },
  async ({ x, y, width, height, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_rectangle", {
        x,
        y,
        width,
        height,
        name: name || "Rectangle",
        parentId,
      });
      return {
        content: [
          {
            type: "text",
            text: `Created rectangle "${JSON.stringify(result)}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating rectangle: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Frame Tool
server.tool(
  "create_frame",
  "Create a new frame in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the frame"),
    height: z.number().describe("Height of the frame"),
    name: z.string().optional().describe("Optional name for the frame"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the frame to"),
    fillColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Fill color in RGBA format"),
    strokeColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Stroke color in RGBA format"),
    strokeWeight: z.number().positive().optional().describe("Stroke weight"),
    layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional().describe("Auto-layout mode for the frame"),
    layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether the auto-layout frame wraps its children"),
    paddingTop: z.number().optional().describe("Top padding for auto-layout frame"),
    paddingRight: z.number().optional().describe("Right padding for auto-layout frame"),
    paddingBottom: z.number().optional().describe("Bottom padding for auto-layout frame"),
    paddingLeft: z.number().optional().describe("Left padding for auto-layout frame"),
    primaryAxisAlignItems: z
      .enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"])
      .optional()
      .describe("Primary axis alignment for auto-layout frame. Note: When set to SPACE_BETWEEN, itemSpacing will be ignored as children will be evenly spaced."),
    counterAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional().describe("Counter axis alignment for auto-layout frame"),
    layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Horizontal sizing mode for auto-layout frame"),
    layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Vertical sizing mode for auto-layout frame"),
    itemSpacing: z
      .number()
      .optional()
      .describe("Distance between children in auto-layout frame. Note: This value will be ignored if primaryAxisAlignItems is set to SPACE_BETWEEN.")
  },
  async ({
    x,
    y,
    width,
    height,
    name,
    parentId,
    fillColor,
    strokeColor,
    strokeWeight,
    layoutMode,
    layoutWrap,
    paddingTop,
    paddingRight,
    paddingBottom,
    paddingLeft,
    primaryAxisAlignItems,
    counterAxisAlignItems,
    layoutSizingHorizontal,
    layoutSizingVertical,
    itemSpacing
  }: any) => {
    try {
      const result = await sendCommandToFigma("create_frame", {
        x,
        y,
        width,
        height,
        name: name || "Frame",
        parentId,
        fillColor: fillColor || { r: 1, g: 1, b: 1, a: 1 },
        strokeColor: strokeColor,
        strokeWeight: strokeWeight,
        layoutMode,
        layoutWrap,
        paddingTop,
        paddingRight,
        paddingBottom,
        paddingLeft,
        primaryAxisAlignItems,
        counterAxisAlignItems,
        layoutSizingHorizontal,
        layoutSizingVertical,
        itemSpacing
      });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Created frame "${typedResult.name}" with ID: ${typedResult.id}. Use the ID as the parentId to appendChild inside this frame.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating frame: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Text Tool
server.tool(
  "create_text",
  "Create a new text element in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    text: z.string().describe("Text content"),
    fontSize: z.number().optional().describe("Font size (default: 14)"),
    fontWeight: z
      .number()
      .optional()
      .describe("Font weight (e.g., 400 for Regular, 700 for Bold)"),
    fontColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Font color in RGBA format"),
    name: z
      .string()
      .optional()
      .describe("Semantic layer name for the text node"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the text to"),
  },
  async ({ x, y, text, fontSize, fontWeight, fontColor, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_text", {
        x,
        y,
        text,
        fontSize: fontSize || 14,
        fontWeight: fontWeight || 400,
        fontColor: fontColor || { r: 0, g: 0, b: 0, a: 1 },
        name: name || "Text",
        parentId,
      });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Created text "${typedResult.name}" with ID: ${typedResult.id}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating text: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Set Fill Color Tool
server.tool(
  "set_fill_color",
  "Set the fill color of a node in Figma can be TextNode or FrameNode",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    r: z.number().min(0).max(1).describe("Red component (0-1)"),
    g: z.number().min(0).max(1).describe("Green component (0-1)"),
    b: z.number().min(0).max(1).describe("Blue component (0-1)"),
    a: z.number().min(0).max(1).optional().describe("Alpha component (0-1)"),
  },
  async ({ nodeId, r, g, b, a }: any) => {
    try {
      const result = await sendCommandToFigma("set_fill_color", {
        nodeId,
        color: { r, g, b, a: a || 1 },
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set fill color of node "${typedResult.name
              }" to RGBA(${r}, ${g}, ${b}, ${a || 1})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting fill color: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Set Stroke Color Tool
server.tool(
  "set_stroke_color",
  "Set the stroke color of a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    r: z.number().min(0).max(1).describe("Red component (0-1)"),
    g: z.number().min(0).max(1).describe("Green component (0-1)"),
    b: z.number().min(0).max(1).describe("Blue component (0-1)"),
    a: z.number().min(0).max(1).optional().describe("Alpha component (0-1)"),
    weight: z.number().positive().optional().describe("Stroke weight"),
  },
  async ({ nodeId, r, g, b, a, weight }: any) => {
    try {
      const result = await sendCommandToFigma("set_stroke_color", {
        nodeId,
        color: { r, g, b, a: a || 1 },
        weight: weight || 1,
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set stroke color of node "${typedResult.name
              }" to RGBA(${r}, ${g}, ${b}, ${a || 1}) with weight ${weight || 1}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting stroke color: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
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

// Delete Node Tool
server.tool(
  "delete_node",
  "Delete a node from Figma",
  {
    nodeId: z.string().describe("The ID of the node to delete"),
  },
  async ({ nodeId }: any) => {
    try {
      await sendCommandToFigma("delete_node", { nodeId });
      return {
        content: [
          {
            type: "text",
            text: `Deleted node with ID: ${nodeId}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting node: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Delete Multiple Nodes Tool
server.tool(
  "delete_multiple_nodes",
  "Delete multiple nodes from Figma at once",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to delete"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("delete_multiple_nodes", { nodeIds });
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
            text: `Error deleting multiple nodes: ${error instanceof Error ? error.message : String(error)
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
  "Export a node as an image from Figma",
  {
    nodeId: z.string().describe("The ID of the node to export"),
    format: z
      .enum(["PNG", "JPG", "SVG", "PDF"])
      .optional()
      .describe("Export format"),
    scale: z.number().positive().optional().describe("Export scale"),
    outputPath: z
      .string()
      .optional()
      .describe(
        "File path to write the exported image to. Parent dirs are created. Defaults to an auto-named file under the OS temp dir. The image is always written to disk — only the path is returned, never inline base64 (which is very expensive in the LLM context)."
      ),
  },
  async ({ nodeId, format, scale, outputPath }: any) => {
    try {
      const fmt = format || "PNG";
      const result = await sendCommandToFigma("export_node_as_image", {
        nodeId,
        format: fmt,
        scale: scale || 1,
      });
      const typedResult = result as { imageData: string; mimeType: string };

      const ext = fmt.toLowerCase() === "jpg" ? "jpg" : fmt.toLowerCase();
      const buffer = Buffer.from(typedResult.imageData, "base64");
      const { path, bytes } = await writeOutputFile(`export-${nodeId}`, ext, buffer, outputPath);
      return {
        content: [
          {
            type: "text" as const,
            text: `Exported ${fmt} (${bytes} bytes) to ${path}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error exporting node as image: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
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

// Set Annotation Tool
server.tool(
  "set_annotation",
  "Create or update an annotation",
  {
    nodeId: z.string().describe("The ID of the node to annotate"),
    annotationId: z.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
    labelMarkdown: z.string().describe("The annotation text in markdown format"),
    categoryId: z.string().optional().describe("The ID of the annotation category"),
    properties: z.array(z.object({
      type: z.string()
    })).optional().describe("Additional properties for the annotation")
  },
  async ({ nodeId, annotationId, labelMarkdown, categoryId, properties }: any) => {
    try {
      const result = await sendCommandToFigma("set_annotation", {
        nodeId,
        annotationId,
        labelMarkdown,
        categoryId,
        properties
      });
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
            text: `Error setting annotation: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

interface SetMultipleAnnotationsParams {
  nodeId: string;
  annotations: Array<{
    nodeId: string;
    labelMarkdown: string;
    categoryId?: string;
    annotationId?: string;
    properties?: Array<{ type: string }>;
  }>;
}

// Set Multiple Annotations Tool
server.tool(
  "set_multiple_annotations",
  "Set multiple annotations parallelly in a node",
  {
    nodeId: z
      .string()
      .describe("The ID of the node containing the elements to annotate"),
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
      .describe("Array of annotations to apply"),
  },
  async ({ nodeId, annotations }: any) => {
    try {
      if (!annotations || annotations.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No annotations provided",
            },
          ],
        };
      }

      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting annotation process for ${annotations.length} nodes. This will be processed in batches of 5...`,
      };

      // Track overall progress
      let totalProcessed = 0;
      const totalToProcess = annotations.length;

      // Use the plugin's set_multiple_annotations function with chunking
      const result = await sendCommandToFigma("set_multiple_annotations", {
        nodeId,
        annotations,
      });

      // Cast the result to a specific type to work with it safely
      interface AnnotationResult {
        success: boolean;
        nodeId: string;
        annotationsApplied?: number;
        annotationsFailed?: number;
        totalAnnotations?: number;
        completedInChunks?: number;
        results?: Array<{
          success: boolean;
          nodeId: string;
          error?: string;
          annotationId?: string;
        }>;
      }

      const typedResult = result as AnnotationResult;

      // Format the results for display
      const success = typedResult.annotationsApplied && typedResult.annotationsApplied > 0;
      const progressText = `
      Annotation process completed:
      - ${typedResult.annotationsApplied || 0} of ${totalToProcess} successfully applied
      - ${typedResult.annotationsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;

      // Detailed results
      const detailedResults = typedResult.results || [];
      const failedResults = detailedResults.filter(item => !item.success);

      // Create the detailed part of the response
      let detailedResponse = "";
      if (failedResults.length > 0) {
        detailedResponse = `\n\nNodes that failed:\n${failedResults.map(item =>
          `- ${item.nodeId}: ${item.error || "Unknown error"}`
        ).join('\n')}`;
      }

      return {
        content: [
          initialStatus,
          {
            type: "text" as const,
            text: progressText + detailedResponse,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting multiple annotations: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Component Instance Tool
server.tool(
  "create_component_instance",
  "Create an instance of a component in Figma. For LOCAL components (from get_local_components), use componentId with the id field. For published LIBRARY components, use componentKey with the publishedKey field.",
  {
    componentId: z.string().optional().describe("ID of a local component (use the id field from get_local_components result). Use this for unpublished/local components."),
    componentKey: z.string().optional().describe("Key of a published library component to instantiate (use the publishedKey field from get_local_components result). Only works for published components."),
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    parentId: z.string().optional().describe("Optional parent node ID to place the instance into"),
  },
  async ({ componentId, componentKey, x, y, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_component_instance", {
        componentId,
        componentKey,
        x,
        y,
        parentId,
      });
      const typedResult = result as any;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(typedResult),
          }
        ]
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating component instance: ${error instanceof Error ? error.message : String(error)
              }`,
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
   - First use get_document_info() to understand the current document
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
   - Use create_frame() for containers and input fields
   - Use create_text() for labels, buttons text, and links
   - Set appropriate colors and styles:
     * Use fillColor for backgrounds
     * Use strokeColor for borders
     * Set proper fontWeight for different text elements

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
            text: `When reading Figma designs, follow these best practices:

1. Start with selection:
   - First use read_node() (no nodeIds → current selection) to understand the current selection
   - If no selection ask user to select single or multiple nodes
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
            text: `# Intelligent Text Replacement Strategy

## 1. Analyze Design & Identify Structure
- Index the text nodes to understand the overall structure of the design
- Use AI pattern recognition to identify logical groupings:
  * Tables (rows, columns, headers, cells)
  * Lists (items, headers, nested lists)
  * Card groups (similar cards with recurring text fields)
  * Forms (labels, input fields, validation text)
  * Navigation (menu items, breadcrumbs)
\`\`\`
glob_nodes({ root: "node-id", type: "TEXT" })   // flat index of every text node + its @parent
read_node({ nodeIds: [...] })                    // pull full characters for the ones you'll edit
grep_nodes({ root: "node-id", pattern: "..." })  // or find text nodes by content
\`\`\`

## 2. Strategic Chunking for Complex Designs
- Divide replacement tasks into logical content chunks based on design structure
- Use one of these chunking strategies that best fits the design:
  * **Structural Chunking**: Table rows/columns, list sections, card groups
  * **Spatial Chunking**: Top-to-bottom, left-to-right in screen areas
  * **Semantic Chunking**: Content related to the same topic or functionality
  * **Component-Based Chunking**: Process similar component instances together

## 3. Progressive Replacement with Verification
- Create a safe copy of the node for text replacement
- Replace text chunk by chunk with continuous progress updates
- After each chunk is processed:
  * Export that section as a small, manageable image
  * Verify text fits properly and maintain design integrity
  * Fix issues before proceeding to the next chunk

\`\`\`
// Clone the node to create a safe copy
clone_node(nodeId: "selected-node-id", x: [new-x], y: [new-y])

// Replace text chunk by chunk — one edit per text node, "characters" path loads the font
edit_nodes({
  edits: [
    { nodeId: "node-id-1", path: "characters", new: "New text 1" },
    // More nodes in this chunk...
  ]
})

// Verify chunk with small, targeted image exports
export_node_as_image(nodeId: "chunk-node-id", format: "PNG", scale: 0.5)
\`\`\`

## 4. Intelligent Handling for Table Data
- For tabular content:
  * Process one row or column at a time
  * Maintain alignment and spacing between cells
  * Consider conditional formatting based on cell content
  * Preserve header/data relationships

## 5. Smart Text Adaptation
- Adaptively handle text based on container constraints:
  * Auto-detect space constraints and adjust text length
  * Apply line breaks at appropriate linguistic points
  * Maintain text hierarchy and emphasis
  * Consider font scaling for critical content that must fit

## 6. Progressive Feedback Loop
- Establish a continuous feedback loop during replacement:
  * Real-time progress updates (0-100%)
  * Small image exports after each chunk for verification
  * Issues identified early and resolved incrementally
  * Quick adjustments applied to subsequent chunks

## 7. Final Verification & Context-Aware QA
- After all chunks are processed:
  * Export the entire design at reduced scale for final verification
  * Check for cross-chunk consistency issues
  * Verify proper text flow between different sections
  * Ensure design harmony across the full composition

## 8. Chunk-Specific Export Scale Guidelines
- Scale exports appropriately based on chunk size:
  * Small chunks (1-5 elements): scale 1.0
  * Medium chunks (6-20 elements): scale 0.7
  * Large chunks (21-50 elements): scale 0.5
  * Very large chunks (50+ elements): scale 0.3
  * Full design verification: scale 0.2

## Sample Chunking Strategy for Common Design Types

### Tables
- Process by logical rows (5-10 rows per chunk)
- Alternative: Process by column for columnar analysis
- Tip: Always include header row in first chunk for reference

### Card Lists
- Group 3-5 similar cards per chunk
- Process entire cards to maintain internal consistency
- Verify text-to-image ratio within cards after each chunk

### Forms
- Group related fields (e.g., "Personal Information", "Payment Details")
- Process labels and input fields together
- Ensure validation messages and hints are updated with their fields

### Navigation & Menus
- Process hierarchical levels together (main menu, submenu)
- Respect information architecture relationships
- Verify menu fit and alignment after replacement

## Best Practices
- **Preserve Design Intent**: Always prioritize design integrity
- **Structural Consistency**: Maintain alignment, spacing, and hierarchy
- **Visual Feedback**: Verify each chunk visually before proceeding
- **Incremental Improvement**: Learn from each chunk to improve subsequent ones
- **Balance Automation & Control**: Let AI handle repetitive replacements but maintain oversight
- **Respect Content Relationships**: Keep related content consistent across chunks

Remember that text is never just text—it's a core design element that must work harmoniously with the overall composition. This chunk-based strategy allows you to methodically transform text while maintaining design integrity.`,
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

// Apply annotations in batches using set_multiple_annotations
if (annotationsToApply.length > 0) {
  await set_multiple_annotations({
    nodeId: selectedNodeId,
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
  | "get_document_info"
  | "get_selection"
  | "get_node_info"
  | "get_node_info_raw"
  | "create_rectangle"
  | "create_frame"
  | "create_text"
  | "set_fill_color"
  | "set_stroke_color"
  | "delete_node"
  | "delete_multiple_nodes"
  | "get_styles"
  | "get_local_components"
  | "create_component_instance"
  | "get_instance_overrides"
  | "set_instance_overrides"
  | "export_node_as_image"
  | "join"
  | "clone_node"
  | "get_annotations"
  | "set_annotation"
  | "set_multiple_annotations"
  | "glob_nodes"
  | "grep_nodes"
  | "query_nodes"
  | "edit_nodes"
  | "get_reactions"
  | "set_default_connector"
  | "create_connections"
  | "set_focus"
  | "set_selections";

type CommandParams = {
  get_document_info: Record<string, never>;
  get_selection: Record<string, never>;
  get_node_info: { nodeId: string };
  get_node_info_raw: { nodeId: string };
  create_rectangle: {
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    parentId?: string;
  };
  create_frame: {
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    parentId?: string;
    fillColor?: { r: number; g: number; b: number; a?: number };
    strokeColor?: { r: number; g: number; b: number; a?: number };
    strokeWeight?: number;
  };
  create_text: {
    x: number;
    y: number;
    text: string;
    fontSize?: number;
    fontWeight?: number;
    fontColor?: { r: number; g: number; b: number; a?: number };
    name?: string;
    parentId?: string;
  };
  set_fill_color: {
    nodeId: string;
    r: number;
    g: number;
    b: number;
    a?: number;
  };
  set_stroke_color: {
    nodeId: string;
    r: number;
    g: number;
    b: number;
    a?: number;
    weight?: number;
  };
  delete_node: {
    nodeId: string;
  };
  delete_multiple_nodes: {
    nodeIds: string[];
  };
  get_styles: Record<string, never>;
  get_local_components: Record<string, never>;
  get_team_components: Record<string, never>;
  create_component_instance: {
    componentKey: string;
    x: number;
    y: number;
  };
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
    scale?: number;
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
  set_annotation: {
    nodeId: string;
    annotationId?: string;
    labelMarkdown: string;
    categoryId?: string;
    properties?: Array<{ type: string }>;
  };
  set_multiple_annotations: SetMultipleAnnotationsParams;
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
  get_reactions: { nodeIds: string[] };
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

};


// Helper function to process Figma node responses
function processFigmaNodeResponse(result: unknown): any {
  if (!result || typeof result !== "object") {
    return result;
  }

  // Check if this looks like a node response
  const resultObj = result as Record<string, unknown>;
  if ("id" in resultObj && typeof resultObj.id === "string") {
    // It appears to be a node response, log the details
    console.info(
      `Processed Figma node: ${resultObj.name || "Unknown"} (ID: ${resultObj.id
      })`
    );

    if ("x" in resultObj && "y" in resultObj) {
      console.debug(`Node position: (${resultObj.x}, ${resultObj.y})`);
    }

    if ("width" in resultObj && "height" in resultObj) {
      console.debug(`Node dimensions: ${resultObj.width}×${resultObj.height}`);
    }
  }

  return result;
}

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
    // Reset channel on new connection
    currentChannel = null;
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

// Function to send commands to Figma
function sendCommandToFigma(
  command: FigmaCommand,
  params: unknown = {},
  timeoutMs: number = 30000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // If not connected, try to connect first
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectToFigma();
      reject(new Error("Not connected to Figma. Attempting to connect..."));
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

    // Store the promise callbacks to resolve/reject later
    pendingRequests.set(id, {
      resolve,
      reject,
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
  "Get the channel(s) the Figma plugin currently has open, as recorded by the WebSocket relay. Use this to discover the channel to join without asking the user to paste it.",
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
                  .map((c) => c.channel)
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



