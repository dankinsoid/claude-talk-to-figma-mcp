// @ai-generated(guided)
// Single source of truth for the write_nodes contract.
//
// The same per-type Zod schemas serve two jobs that must never drift apart:
//   1. Validation gate — write_nodes parses its input against these, so a
//      malformed spec fails fast at the MCP boundary with a precise field path
//      instead of silently no-opping inside the Figma plugin.
//   2. Lazy, on-demand docs — describeNodeSchema() renders one type's schema as
//      a compact field list, so the agent can ask "what does a TEXT spec take?"
//      right before creating one and build to the answer.
//
// Because docs are derived from the validator, the doc can't describe a field
// the gate rejects, or omit one it accepts.
//
// Schemas are intentionally `.passthrough()`: write_nodes is permissive by
// design — every extra key is written straight onto the node and Figma rejects
// bad ones per-property. The curated fields below are the high-value, commonly
// wrong ones (typed, range-checked, enum-constrained); anything else still
// passes through untouched. So this is a guardrail on the common case, not a
// whitelist that would regress arbitrary-property support.

import { z } from "zod";

/** Node types write_nodes can create — mirrors NODE_FACTORIES + INSTANCE in code.js. */
export const NODE_TYPES = [
  "FRAME", "TEXT", "RECTANGLE", "ELLIPSE", "LINE", "STAR", "POLYGON",
  "VECTOR", "COMPONENT", "SECTION", "SLICE", "INSTANCE",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

// ── shared value schemas ──────────────────────────────────────────────────

/** A color as `#RRGGBB`/`#RRGGBBAA` (converted to Figma rgb 0-1) or raw rgba floats. */
const Color = z.union([
  z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "expected #RRGGBB or #RRGGBBAA hex"),
  z.object({ r: z.number(), g: z.number(), b: z.number(), a: z.number().optional() }),
]);

const Paint = z
  .object({
    type: z
      .enum(["SOLID", "GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND", "IMAGE"])
      .optional(),
    color: Color.optional().describe("SOLID paint color, #RRGGBB"),
    opacity: z.number().min(0).max(1).optional(),
  })
  .passthrough();

const FontName = z
  .object({ family: z.string(), style: z.string().describe('face name, e.g. "Regular", "Bold Italic"') })
  .describe("font; loaded automatically before write");

// ── shared field groups (raw Zod shapes, spread into each type) ────────────

const baseFields = {
  name: z.string().optional(),
  x: z.number().optional().describe("parent-relative x (ignored inside an auto-layout parent)"),
  y: z.number().optional().describe("parent-relative y (ignored inside an auto-layout parent)"),
  opacity: z.number().min(0).max(1).optional(),
  rotation: z.number().optional().describe("degrees"),
  visible: z.boolean().optional(),
  locked: z.boolean().optional(),
  blendMode: z.string().optional(),
  parentId: z.string().optional().describe("container to append into; default current page. short ids (n0) or full ids"),
  index: z.number().int().min(0).optional().describe("position among siblings"),
};

const sizeFields = {
  width: z.number().positive().optional().describe("routed through resize()"),
  height: z.number().positive().optional().describe("routed through resize()"),
};

const paintFields = {
  fills: z.array(Paint).optional(),
  strokes: z.array(Paint).optional(),
  strokeWeight: z.number().min(0).optional(),
  strokeAlign: z.enum(["INSIDE", "OUTSIDE", "CENTER"]).optional(),
};

const cornerFields = {
  cornerRadius: z.number().min(0).optional(),
  topLeftRadius: z.number().min(0).optional(),
  topRightRadius: z.number().min(0).optional(),
  bottomLeftRadius: z.number().min(0).optional(),
  bottomRightRadius: z.number().min(0).optional(),
};

const autoLayoutFields = {
  layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional().describe("turns on auto-layout"),
  primaryAxisAlignItems: z.enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]).optional(),
  counterAxisAlignItems: z.enum(["MIN", "CENTER", "MAX", "BASELINE"]).optional(),
  primaryAxisSizingMode: z.enum(["FIXED", "AUTO"]).optional().describe("AUTO = hug contents"),
  counterAxisSizingMode: z.enum(["FIXED", "AUTO"]).optional(),
  layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional(),
  layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional(),
  itemSpacing: z.number().optional().describe("gap between children"),
  paddingLeft: z.number().optional(),
  paddingRight: z.number().optional(),
  paddingTop: z.number().optional(),
  paddingBottom: z.number().optional(),
  clipsContent: z.boolean().optional(),
};

const textFields = {
  characters: z.string().describe("the text content; loads the node's font for you"),
  fontName: FontName.optional(),
  fontSize: z.number().positive().optional(),
  textAlignHorizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
  textAlignVertical: z.enum(["TOP", "CENTER", "BOTTOM"]).optional(),
  letterSpacing: z.number().optional(),
  textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional(),
  textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
};

// `children` is the same union, lazily referenced so the recursive type resolves.
const childrenField = {
  children: z.array(z.lazy((): z.ZodTypeAny => writeNodeUnion)).optional().describe("nested specs, created recursively inside this node"),
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

/** Reject known read-only / read-format keys with a redirect message (the input grammar the agent used). */
function rejectReadOnly(spec: Record<string, unknown>, ctx: z.RefinementCtx): void {
  for (const key of Object.keys(spec)) {
    if (key in READ_ONLY_KEYS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: READ_ONLY_KEYS[key], path: [key] });
    }
  }
}

// ── per-type schemas ────────────────────────────────────────────────────────

const containerExtras = { ...sizeFields, ...paintFields, ...cornerFields, ...autoLayoutFields, ...childrenField };
const shapeExtras = { ...sizeFields, ...paintFields };

// Per-type members are PLAIN passthrough objects (no .superRefine) — a
// discriminatedUnion needs raw ZodObject members to read the `type` literal;
// wrapping them in an effect (refine) would hide their `.shape`. Cross-field
// rules (read-only redirects, INSTANCE source) ride on a single top-level
// refine over the union instead.

/** Per-type spec schemas. The map IS the doc source and the validation source. */
export const NODE_SCHEMAS = {
  FRAME: z.object({ type: z.literal("FRAME"), ...baseFields, ...containerExtras }).passthrough(),
  COMPONENT: z.object({ type: z.literal("COMPONENT"), ...baseFields, ...containerExtras }).passthrough(),
  SECTION: z.object({ type: z.literal("SECTION"), ...baseFields, ...sizeFields, ...paintFields, ...childrenField }).passthrough(),
  TEXT: z.object({ type: z.literal("TEXT"), ...baseFields, ...sizeFields, fills: paintFields.fills, ...textFields }).passthrough(),
  RECTANGLE: z.object({ type: z.literal("RECTANGLE"), ...baseFields, ...shapeExtras, ...cornerFields }).passthrough(),
  ELLIPSE: z.object({ type: z.literal("ELLIPSE"), ...baseFields, ...shapeExtras }).passthrough(),
  POLYGON: z.object({ type: z.literal("POLYGON"), ...baseFields, ...shapeExtras }).passthrough(),
  STAR: z.object({ type: z.literal("STAR"), ...baseFields, ...shapeExtras }).passthrough(),
  LINE: z.object({ type: z.literal("LINE"), ...baseFields, ...paintFields }).passthrough(),
  VECTOR: z.object({ type: z.literal("VECTOR"), ...baseFields, ...shapeExtras }).passthrough(),
  SLICE: z.object({ type: z.literal("SLICE"), ...baseFields, ...sizeFields }).passthrough(),
  INSTANCE: z
    .object({
      type: z.literal("INSTANCE"),
      componentId: z.string().optional().describe("local COMPONENT id (from get_local_components)"),
      componentKey: z.string().optional().describe("published library component key"),
      ...baseFields,
      ...sizeFields,
      ...childrenField,
    })
    .passthrough(),
} satisfies Record<NodeType, z.ZodTypeAny>;

/** Discriminated union over `type` + cross-field rules — validates one node spec (recursive via children). */
export const writeNodeUnion: z.ZodTypeAny = z.lazy(() =>
  z.discriminatedUnion("type", Object.values(NODE_SCHEMAS) as any).superRefine((spec: any, ctx) => {
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

/** Unwrap .superRefine/.passthrough effect wrappers down to the base ZodObject. */
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
//   • type-agnostic field values — opacity (0..1), cornerRadius (≥0), enums like
//     layoutMode, colors — validated by the path's leaf name regardless of node
//     type, since their constraint is the same on every type that has them.
// Anything else passes (null) and the plugin handles it, preserving the
// permissive contract.

/** Type-agnostic field schemas, keyed by leaf name — the value-shape checks shared with write. */
const FIELD_SCHEMAS: Record<string, z.ZodTypeAny> = {
  ...baseFields, ...sizeFields, ...paintFields, ...cornerFields, ...autoLayoutFields, ...textFields,
};

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
