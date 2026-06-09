// @ai-generated(solo)
// Generator for write_schema.generated.ts — the WRITE-side field set, derived
// from @figma/plugin-typings so the contract can't silently drift from Figma's
// real runtime types (the letterSpacing-was-a-number class of bug).
//
// It reads each node interface, keeps the WRITABLE properties (non-readonly
// signatures, non-methods), drops the noise/read-only-effective ones by rule,
// maps each TS type to a Zod expression, and emits a per-type field map. The
// hand layer (write_schema.ts) then attaches .describe() notes, synthetic
// fields (parentId/children/...), and coercion overrides (letterSpacing union).
//
// Run: bun gen:schema   (devDeps: ts-morph, @figma/plugin-typings)

import { Project, SyntaxKind, Type, Node } from "ts-morph";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const DTS = resolve(here, "../node_modules/@figma/plugin-typings/plugin-api.d.ts");
const OUT = resolve(here, "../src/talk_to_figma_mcp/write_schema.generated.ts");

// MCP node type → Figma interface name.
const TYPE_TO_IFACE: Record<string, string> = {
  FRAME: "FrameNode", TEXT: "TextNode", RECTANGLE: "RectangleNode", ELLIPSE: "EllipseNode",
  LINE: "LineNode", STAR: "StarNode", POLYGON: "PolygonNode", VECTOR: "VectorNode",
  COMPONENT: "ComponentNode", SECTION: "SectionNode", SLICE: "SliceNode", INSTANCE: "InstanceNode",
};

// Named Figma types we already hand-model in shared-schemas.ts — referenced by
// name instead of being recursively regenerated. Matched on the written
// type-node text (the alias name, which is lost once the type is resolved), so
// `Paint[]` → z.array(Paint) and the wide Paint/Effect unions stay compact.
const COMPOSITES: Record<string, { expr: string; array: boolean }> = {
  Paint: { expr: "Paint", array: true }, Effect: { expr: "Effect", array: true },
  FontName: { expr: "FontName", array: false },
  LetterSpacing: { expr: "LetterSpacing", array: false }, LineHeight: { expr: "LineHeight", array: false },
};
const COMPOSITE_IMPORTS = Object.values(COMPOSITES).map((c) => c.expr);

// Properties dropped regardless of node type: read-only-effective under
// dynamic-page (style ids need async setters), variable/token plumbing,
// low-level transforms, and prototyping/export metadata that isn't creation
// material. Everything else writable is kept.
const DROP_NAME = /StyleId$|Variable|componentPropertyReferences/;
const DROP_EXACT = new Set([
  "id", "relativeTransform", "absoluteTransform", "annotations", "reactions",
  "exportSettings", "guides", "layoutGrids", "devStatus", "complexStrokeProperties",
  "variableWidthStrokeProperties", "dashPattern", "inferredAutoLayout",
  "mainComponent", // a node reference, not write material — use componentId/componentKey instead
]);

const project = new Project({ skipAddingFilesFromTsConfig: true });
const sf = project.addSourceFileAtPath(DTS);

/** True when a property's JSDoc marks it read-only (e.g. dynamic-page) or deprecated — not a real write target. */
function jsdocBlocksWrite(decl: Node): boolean {
  const txt = decl.getLeadingCommentRanges().map((c) => c.getText()).join("\n");
  return /this property is read-only|@deprecated/i.test(txt);
}

const isMixed = (t: Type) => t.getText().includes('"mixed"');
const aliasName = (t: Type) => t.getAliasSymbol()?.getName() ?? t.getSymbol()?.getName();
/** Node-typed values are never inlined into a write spec (you reference by id) — collapse them. */
const looksLikeNode = (t: Type) => /Node$|Mixin$/.test(aliasName(t) ?? "");

/** A composite override keyed off the property's written type text (the alias name survives there). */
function compositeOverride(ps: Node): string | null {
  const txt = ps.asKindOrThrow(SyntaxKind.PropertySignature).getTypeNode()?.getText() ?? "";
  for (const [name, { expr, array }] of Object.entries(COMPOSITES)) {
    if (new RegExp(`\\b${name}\\b`).test(txt)) return array ? `z.array(${expr})` : expr;
  }
  return null;
}

// Repeated aliased types (BlendMode, StrokeCap, Constraints, …) are hoisted into
// named consts emitted once and referenced by name. The Map's insertion order is
// dependency-correct: a type's body is computed (registering its children) before
// the type itself is set, so children always precede parents in the output.
let registry = new Map<string, string>();
let emitting = new Set<string>();
// Sorted-value-set → const name, so an enum that lost its alias (e.g. an optional
// `blendMode?: BlendMode` resolves to a bare literal union) still reuses BlendMode,
// and so alias-less enums repeated ≥2× across types are hoisted once (pass 2).
let enumKeyToName = new Map<string, string>();
const enumFreq = new Map<string, number>(); // enum value-key → times seen across all fields
const enumHint = new Map<string, string>(); // enum value-key → first field/prop name that produced it
const enumBody = new Map<string, string>(); // enum value-key → its `z.enum([...])` source
const RESERVED = new Set([...COMPOSITE_IMPORTS, "Transform", "Array", "ReadonlyArray", "Object", "Promise"]);

/** The sorted-value key of a pure string-literal-union type, or null if it isn't one. */
function enumKey(t: Type): string | null {
  if (!t.isUnion()) return null;
  const m = t.getUnionTypes();
  if (!m.length || !m.every((x) => x.isStringLiteral())) return null;
  return JSON.stringify(m.map((x) => JSON.stringify(x.getLiteralValue())).sort());
}

/** A PascalCase alias whose body is worth naming (enum/object, not a primitive, array, composite, or node). */
function nameable(name: string | undefined, t: Type): name is string {
  if (!name || RESERVED.has(name) || !/^[A-Z][A-Za-z0-9]+$/.test(name)) return false;
  if (looksLikeNode(t) || t.isArray() || t.isTuple()) return false;
  return t.isUnion() || t.isObject();
}

/** Map a TS type to a Zod expression string, hoisting any nameable aliased type to a named const. */
function zodExpr(type: Type, decl: Node, depth: number, hint: string): string {
  const name = aliasName(type);
  if (nameable(name, type)) {
    if (emitting.has(name)) return "z.record(z.unknown())"; // self/mutual cycle — break it
    if (!registry.has(name)) {
      emitting.add(name);
      const body = zodBody(type, decl, 0, hint);
      emitting.delete(name);
      registry.set(name, body);
      const k = enumKey(type);
      if (k) enumKeyToName.set(k, name); // let later alias-less enums reuse this name
    }
    return name;
  }
  return zodBody(type, decl, depth, hint);
}

/** Structural mapping (no naming) — the body of a type. `hint` names a hoisted enum after its field. */
function zodBody(type: Type, decl: Node, depth: number, hint: string): string {
  if (type.isString()) return "z.string()";
  if (type.isNumber()) return "z.number()";
  if (type.isBoolean()) return "z.boolean()";
  if (type.isStringLiteral()) return `z.literal(${JSON.stringify(type.getLiteralValue())})`;
  if (type.isTuple()) return "z.array(z.number())"; // Transform et al. — numeric matrices
  if (type.isArray()) return `z.array(${zodExpr(type.getArrayElementTypeOrThrow(), decl, depth, hint)})`;
  if (type.isUnion()) {
    const members = type.getUnionTypes();
    const nullable = members.some((m) => m.isNull() || m.isUndefined());
    const keep = members.filter((m) => !isMixed(m) && !m.isNull() && !m.isUndefined());
    let expr: string;
    if (keep.length === 0) expr = "z.unknown()";
    else if (keep.every((m) => m.isBooleanLiteral())) expr = "z.boolean()";
    else if (keep.every((m) => m.isStringLiteral())) {
      const vals = keep.map((m) => JSON.stringify(m.getLiteralValue()));
      const key = JSON.stringify([...vals].sort());
      const inline = `z.enum([${vals.join(", ")}])`;
      enumFreq.set(key, (enumFreq.get(key) ?? 0) + 1);
      if (!enumHint.has(key)) { enumHint.set(key, hint); enumBody.set(key, inline); }
      expr = enumKeyToName.get(key) ?? inline; // a name wins once one is assigned (alias or pass-2 synth)
    } else if (keep.length === 1) expr = zodExpr(keep[0], decl, depth, hint);
    else expr = `z.union([${keep.map((m) => zodExpr(m, decl, depth, hint)).join(", ")}])`;
    return nullable && expr !== "z.unknown()" ? `${expr}.nullable()` : expr;
  }
  if (type.isObject()) return objectExpr(type, decl, depth, hint);
  return "z.unknown()";
}

/** Recurse one level into a value-object type → z.object({...}).passthrough(); bottom out to a loose record. */
function objectExpr(type: Type, decl: Node, depth: number, hint: string): string {
  if (looksLikeNode(type)) return "z.record(z.unknown())";
  if (depth >= 2) return "z.record(z.unknown())";
  const props = type.getProperties().filter((p) => {
    if (p.getName().startsWith("__@")) return false; // synthetic symbol props (e.g. [Symbol.unscopables])
    const d = p.getDeclarations()[0];
    return d && d.getKind() === SyntaxKind.PropertySignature && p.getTypeAtLocation(d).getCallSignatures().length === 0;
  });
  if (props.length === 0) return "z.record(z.unknown())";
  const entries = props.map((p) => {
    const d = p.getDeclarations()[0]!;
    const optional = p.isOptional();
    return `${JSON.stringify(p.getName())}: ${zodExpr(p.getTypeAtLocation(d), d, depth + 1, p.getName())}${optional ? ".optional()" : ""}`;
  });
  return `z.object({ ${entries.join(", ")} }).passthrough()`;
}

/** Extract the writable, kept fields of one node type as `name: zodExpr` source lines. */
function fieldsFor(iface: string): string[] {
  const decl = sf.getInterfaceOrThrow(iface);
  const lines: string[] = [];
  for (const prop of decl.getType().getProperties()) {
    const d = prop.getDeclarations()[0];
    if (!d || d.getKind() !== SyntaxKind.PropertySignature) continue;
    const ps = d.asKindOrThrow(SyntaxKind.PropertySignature);
    if (ps.isReadonly()) continue;
    if (ps.getType().getCallSignatures().length > 0) continue;
    const name = prop.getName();
    if (DROP_EXACT.has(name) || DROP_NAME.test(name) || jsdocBlocksWrite(d)) continue;
    const expr = compositeOverride(d) ?? zodExpr(prop.getTypeAtLocation(d), d, 0, name);
    lines.push(`    ${JSON.stringify(name)}: ${expr},`);
  }
  return lines.sort();
}

const buildBlocks = () =>
  Object.entries(TYPE_TO_IFACE).map(([t, iface]) => `  ${t}: {\n${fieldsFor(iface).join("\n")}\n  },`);

// Pass 1 — discover every enum value-set and how often it recurs.
buildBlocks();

// Assign a name to each alias-less enum seen ≥2× (named after its first field), so
// pass 2 references it instead of re-inlining. Skip sets already named via an alias.
const synth = new Map<string, { name: string; body: string }>(); // enum key → const
const used = new Set([...RESERVED, ...registry.keys()]);
for (const [key, freq] of enumFreq) {
  if (freq < 2 || enumKeyToName.has(key)) continue;
  const hint = enumHint.get(key)!;
  let name = hint[0].toUpperCase() + hint.slice(1);
  for (let i = 2; used.has(name); i++) name = `${hint[0].toUpperCase() + hint.slice(1)}${i}`;
  used.add(name);
  synth.set(key, { name, body: enumBody.get(key)! });
}

// Pass 2 — regenerate with the synthesized enum names seeded; aliased hoists re-derive.
registry = new Map();
emitting = new Set();
enumKeyToName = new Map([...synth].map(([k, v]) => [k, v.name]));
const blocks = buildBlocks();
const named = [
  ...[...synth.values()].map((e) => `const ${e.name}: z.ZodTypeAny = ${e.body};`),
  ...[...registry.entries()].map(([n, body]) => `const ${n}: z.ZodTypeAny = ${body};`),
].join("\n");

const out = `// AUTO-GENERATED by scripts/gen-write-schema.ts — DO NOT EDIT.
// Regenerate: bun gen:schema
//
// Per-node WRITABLE field set derived from @figma/plugin-typings. Read-only,
// deprecated, style-id, variable-binding, transform and metadata props are
// dropped by the generator; repeated aliased types (BlendMode, …) are hoisted
// into the named consts below. The hand layer in write_schema.ts adds
// .describe() notes, synthetic fields, and coercion overrides on top of these.

import { z } from "zod";
import { ${COMPOSITE_IMPORTS.join(", ")} } from "./shared-schemas.js";

// Silence "unused" when a given run references only some shared schemas.
${COMPOSITE_IMPORTS.map((n) => `void ${n};`).join(" ")}

${named}

export const GENERATED_FIELDS: Record<string, Record<string, z.ZodTypeAny>> = {
${blocks.join("\n")}
};
`;

writeFileSync(OUT, out);
const counts = Object.entries(TYPE_TO_IFACE).map(([t, i]) => `${t}=${fieldsFor(i).length}`).join("  ");
console.log(`Wrote ${OUT}\nfield counts: ${counts}`);
