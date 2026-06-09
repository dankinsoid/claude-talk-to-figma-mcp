// @ai-generated(guided)
// Single source of truth for the write_nodes contract.
//
// The per-type Zod schemas serve two jobs that must never drift apart:
//   1. Validation gate — write_nodes parses input against these, so a malformed
//      spec fails fast at the MCP boundary with a precise field path instead of
//      silently no-opping inside the Figma plugin.
//   2. Lazy, on-demand docs — describeNodeSchema() renders one type's schema as a
//      compact field list, so the agent can ask "what does a TEXT spec take?"
//      right before creating one and build to the answer.
//
// The field SET and TYPES are generated from @figma/plugin-typings
// (write_schema.generated.ts, via `bun gen:schema`) so they can't silently drift
// from Figma's real runtime types — the letterSpacing-was-a-number class of bug.
// This hand layer adds what the types can't express: human .describe() NOTES (the
// non-obvious "why"), synthetic spec-only fields (parentId/index/children/...),
// and coercion-driven overrides (letterSpacing accepts a bare number).
//
// Schemas are `.passthrough()`: write_nodes is permissive — every extra key is
// written straight onto the node and Figma rejects bad ones per-property. The
// generated fields are the high-value, type-checked common set; anything else
// still passes through untouched.

import { z } from "zod";
import { GENERATED_FIELDS } from "./write_schema.generated.js";
import { Color, Paint } from "./shared-schemas.js";

/** Node types write_nodes can create — mirrors NODE_FACTORIES + INSTANCE in code.js. */
export const NODE_TYPES = [
  "FRAME", "TEXT", "RECTANGLE", "ELLIPSE", "LINE", "STAR", "POLYGON",
  "VECTOR", "COMPONENT", "SECTION", "SLICE", "INSTANCE",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

// ── hand-authored notes (the non-obvious "why", which types can't carry) ──────
const NOTES: Record<string, string> = {
  x: "parent-relative x (ignored inside an auto-layout parent)",
  y: "parent-relative y (ignored inside an auto-layout parent)",
  rotation: "degrees",
  layoutMode: "turns on auto-layout",
  primaryAxisSizingMode: "AUTO = hug contents",
  counterAxisSizingMode: "AUTO = hug contents",
  layoutSizingHorizontal: "FILL/HUG require an auto-layout parent",
  layoutSizingVertical: "FILL/HUG require an auto-layout parent",
  itemSpacing: "gap between children (auto-layout)",
  characters: "the text content; loads the node's font for you",
  fills: "paints; a #RRGGBB hex on a SOLID color is converted to Figma rgb 0-1",
  strokes: "paints; #RRGGBB hex converted to Figma rgb 0-1",
  letterSpacing: "number = PIXELS; {value,unit:'PERCENT'} for em-relative",
  lineHeight: "number = PIXELS; {value,unit:'PERCENT'} or {unit:'AUTO'}",
};

// ── synthetic fields consumed by the spec itself, not written onto the node ───
const parentId = z.string().optional().describe("container to append into; default current page. short ids (n0) or full ids");
const index = z.number().int().min(0).optional().describe("position among siblings");
const width = z.number().positive().optional().describe("routed through resize()");
const height = z.number().positive().optional().describe("routed through resize()");
const componentId = z.string().optional().describe("local COMPONENT id (from get_local_components)");
const componentKey = z.string().optional().describe("published library component key");
// `children` is the same union, lazily referenced so the recursive type resolves.
const children = z.array(z.lazy((): z.ZodTypeAny => writeNodeUnion)).optional().describe("nested specs, created recursively inside this node");

const CONTAINER_TYPES = new Set<NodeType>(["FRAME", "COMPONENT", "SECTION", "INSTANCE"]);
const REQUIRED: Partial<Record<NodeType, Set<string>>> = { TEXT: new Set(["characters"]) };

// Range constraints Figma enforces at runtime but doesn't encode in its types
// (it types these as bare `number`) — restored so the gate rejects them up front.
const FIELD_OVERRIDES: Record<string, z.ZodTypeAny> = {
  opacity: z.number().min(0).max(1),
  cornerRadius: z.number().min(0),
  strokeWeight: z.number().min(0),
};

// Keys that are read-only or read-format-only — surfaced as a clear redirect
// rather than silently no-opping when an agent pastes a read result into write.
export const READ_ONLY_KEYS: Record<string, string> = {
  style: "REST read-format; on write use fontName {family,style} + fontSize on a TEXT node",
  absoluteBoundingBox: "read-only; use x/y + width/height",
  absoluteRenderBounds: "read-only (computed)",
  characterStyleOverrides: "per-range text styling not supported on write; one uniform style per node",
  styleOverrideTable: "per-range text styling not supported on write",
  boundVariables: "variable bindings not supported on write; set a literal value",
  id: "assigned by Figma",
};

/** Compose one node type's schema: generated fields (optional + notes) + synthetic spec fields. */
function compose(type: NodeType): z.ZodTypeAny {
  const gen = GENERATED_FIELDS[type] ?? {};
  const required = REQUIRED[type] ?? new Set<string>();
  const shape: Record<string, z.ZodTypeAny> = { type: z.literal(type) };
  for (const [key, generated] of Object.entries(gen)) {
    const base = FIELD_OVERRIDES[key] ?? generated;
    let field = required.has(key) ? base : base.optional();
    if (NOTES[key]) field = field.describe(NOTES[key]);
    shape[key] = field;
  }
  shape.parentId = parentId;
  shape.index = index;
  shape.width = width;
  shape.height = height;
  if (CONTAINER_TYPES.has(type)) shape.children = children;
  if (type === "INSTANCE") {
    shape.componentId = componentId;
    shape.componentKey = componentKey;
  }
  return z.object(shape).passthrough();
}

/** Per-type spec schemas. The map IS the doc source and the validation source. */
export const NODE_SCHEMAS = Object.fromEntries(
  NODE_TYPES.map((t) => [t, compose(t)]),
) as Record<NodeType, z.ZodTypeAny>;

/** Reject known read-only / read-format keys with a redirect message (the input grammar the agent used). */
function rejectReadOnly(spec: Record<string, unknown>, ctx: z.RefinementCtx): void {
  for (const key of Object.keys(spec)) {
    if (key in READ_ONLY_KEYS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: READ_ONLY_KEYS[key], path: [key] });
    }
  }
}

/** Discriminated union over `type` + cross-field rules — validates one node spec (recursive via children). */
export const writeNodeUnion: z.ZodTypeAny = z.lazy(() =>
  z.discriminatedUnion("type", NODE_TYPES.map((t) => NODE_SCHEMAS[t]) as any).superRefine((spec: any, ctx) => {
    rejectReadOnly(spec, ctx);
    if (spec.type === "INSTANCE" && !spec.componentId && !spec.componentKey) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INSTANCE needs componentId (local) or componentKey (published)", path: ["componentId"] });
    }
  })
);

// ── compact doc rendering ────────────────────────────────────────────────────

/** Render one Zod field type as a short token, e.g. `number 0..1`, `enum(MIN|CENTER)`, `Paint[]`. */
function renderType(schema: z.ZodTypeAny): string {
  const def: any = schema._def;
  switch (def.typeName) {
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
      return renderType(def.innerType);
    case "ZodLazy":
      return "NodeSpec";
    case "ZodString":
      return "string";
    case "ZodBoolean":
      return "boolean";
    case "ZodNumber": {
      const checks: any[] = def.checks || [];
      const lo = checks.find((c) => c.kind === "min");
      const hi = checks.find((c) => c.kind === "max");
      if (lo && hi) return `number ${lo.value}..${hi.value}`;
      if (checks.some((c) => c.kind === "min" && c.value === 0)) return "number ≥0";
      if (lo && lo.value > 0) return "number >0";
      return "number";
    }
    case "ZodEnum":
      return `enum(${def.values.join("|")})`;
    case "ZodLiteral":
      return JSON.stringify(def.value);
    case "ZodArray":
      return `${renderType(def.type)}[]`;
    case "ZodRecord":
      return "object";
    case "ZodObject": {
      const keys = Object.keys(def.shape());
      return `{${keys.join(",")}}`;
    }
    case "ZodUnion":
      return def.options.map(renderType).join(" | ");
    default:
      return def.typeName?.replace(/^Zod/, "").toLowerCase() || "any";
  }
}

/** Unwrap .passthrough()/effect wrappers down to the base ZodObject. */
function unwrapObject(schema: z.ZodTypeAny): z.ZodObject<any> | null {
  let s: any = schema;
  while (s && s._def) {
    if (s._def.typeName === "ZodObject") return s;
    if (s._def.typeName === "ZodEffects") { s = s._def.schema; continue; }
    if (s._def.innerType) { s = s._def.innerType; continue; }
    return null;
  }
  return null;
}

/**
 * Compact, line-per-field doc for one node type — the lazy schema an agent
 * fetches right before building that type. `?` marks optional; the trailing
 * `— note` is the field's .describe() (the non-obvious why/how only).
 */
export function describeNodeSchema(type: NodeType): string {
  const obj = unwrapObject(NODE_SCHEMAS[type]);
  if (!obj) return `unknown type ${type}`;
  const shape = obj._def.shape();
  const lines: string[] = [`${type} — write_nodes spec fields:`];
  for (const key of Object.keys(shape)) {
    if (key === "type") continue;
    const field: z.ZodTypeAny = shape[key];
    const optional = field._def.typeName === "ZodOptional";
    const note = field._def.description || (field._def.innerType && field._def.innerType._def?.description);
    lines.push(`  ${key}${optional ? "?" : ""}: ${renderType(field)}${note ? ` — ${note}` : ""}`);
  }
  lines.push("  (+ any other Figma property for this type passes through)");
  return lines.join("\n");
}

/** Table of contents: the node types an agent can request a schema for. */
export function listNodeTypes(): string {
  return "Node types (get_write_schema(type) for fields):\n  " + NODE_TYPES.join(", ");
}

// ── edit_nodes validation (cheap subset) ─────────────────────────────────────
//
// edit_nodes addresses ONE field by string path on a node whose type the server
// doesn't know without a round-trip — so it can't do write_nodes' full per-type
// check. But two checks need no round-trip and reuse the schemas above:
//   • read-only / read-format roots (style, absoluteBoundingBox, ...) — reject
//     with the same redirect, so editing a read-only field fails loudly.
//   • type-agnostic field values — a field's value-shape is the same wherever it
//     appears, so the path's leaf name picks the schema regardless of node type.
// Anything else passes (null) and the plugin handles it, preserving the
// permissive contract.

/** Type-agnostic field schemas, keyed by leaf name — merged across every node type's generated fields. */
const FIELD_SCHEMAS: Record<string, z.ZodTypeAny> = {};
for (const type of NODE_TYPES) {
  for (const [key, schema] of Object.entries(GENERATED_FIELDS[type] ?? {})) {
    if (!(key in FIELD_SCHEMAS)) FIELD_SCHEMAS[key] = FIELD_OVERRIDES[key] ?? schema;
  }
}
FIELD_SCHEMAS.width = z.number().positive();
FIELD_SCHEMAS.height = z.number().positive();

/**
 * Validate one edit_nodes `{path, new}` without reading the node. Returns an
 * error message (in the agent's path grammar) or null to pass through.
 */
export function validateEditValue(path: string, value: unknown): string | null {
  const segs = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  if (!segs.length) return null;
  if (segs[0] in READ_ONLY_KEYS) return READ_ONLY_KEYS[segs[0]];

  const endsWithIndex = /^\d+$/.test(segs[segs.length - 1]);
  const leaf = [...segs].reverse().find((s) => !/^\d+$/.test(s));
  if (!leaf) return null;

  let schema: z.ZodTypeAny | null;
  if (leaf === "color") schema = Color;
  else if (leaf === "fills" || leaf === "strokes") schema = endsWithIndex ? Paint : z.array(Paint);
  else schema = FIELD_SCHEMAS[leaf] ?? null;
  if (!schema) return null;

  const r = schema.safeParse(value);
  if (r.success) return null;
  // zod's SafeParseReturnType isn't a discriminated union in this typings
  // version, so TS won't narrow to the error branch — reach for `error` directly.
  return (r as { error: z.ZodError }).error.issues[0]?.message ?? "invalid value";
}
