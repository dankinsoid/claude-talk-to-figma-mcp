// @ai-generated(guided)
// Bidirectional map between canonical Figma node ids and short counter ids
// (n0, n1, ...) substituted into compact read-tool output to cut token cost: a
// nested instance id like "I8782:344721;3063:34762;3063:40330;3063:40206" becomes
// "n7". The map lives for the MCP server process, so it survives Figma plugin
// reloads (Figma node ids are document-stable; only an MCP-server restart clears
// it). A given canonical id always maps back to the same short id within a run.

const shortToFull = new Map<string, string>();
const fullToShort = new Map<string, string>();
let counter = 0;

const SHORT_RE = /^n\d+$/;

function shorten(fullId: string): string {
  if (SHORT_RE.test(fullId)) return fullId; // already short — keep renumberIds idempotent
  let s = fullToShort.get(fullId);
  if (!s) {
    s = "n" + counter++;
    fullToShort.set(fullId, s);
    shortToFull.set(s, fullId);
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
      `Unknown short id "${id}" — re-fetch the node; short ids reset when the MCP server restarts.`
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
