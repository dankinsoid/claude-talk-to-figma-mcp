// @ai-generated(solo)
// Compaction layer for Figma node trees returned to the agent.
//
// The Figma plugin returns a fully-recursive, verbose tree (every descendant
// with full geometry/paints/styles). Feeding that straight to the model burns
// tokens and slows every turn. shapeNode() reshapes that tree into a compact,
// "zoomable" form: a depth budget cuts the tree and leaves drill-in stubs,
// icon-like subtrees collapse to a single line, repeated paints hoist into a
// shared `_defs` table, keys/numbers shrink, and default values are dropped.
//
// Phase 1 lives here on the server: it reshapes whatever the plugin already
// sent. It cannot surface fields the plugin never emits (padding, itemSpacing,
// layoutMode, effects) — those need a plugin-side traversal (phase 2).

/** Field groups a detail profile may switch on. `text` characters are always kept. */
interface Fields {
  box: boolean;
  style: boolean;
  text: boolean;
  full: boolean;
}

export type DetailProfile = "skeleton" | "box" | "style" | "text" | "auto" | "full";

export interface ShapeOptions {
  /** Levels of children to expand. Beyond it, nodes become drill-in stubs. */
  depth?: number;
  detail?: DetailProfile;
  /** Collapse icon-like subtrees (no text, vector leaves) to one ICON node. */
  collapseIcons?: boolean;
  /** Hoist paints/strokes used more than once into a shared `_defs` table. */
  dedupe?: boolean;
}

const PROFILES: Record<DetailProfile, Fields> = {
  skeleton: { box: false, style: false, text: false, full: false },
  box: { box: true, style: false, text: false, full: false },
  style: { box: true, style: true, text: false, full: false },
  text: { box: true, style: false, text: true, full: false },
  // auto keeps characters (always emitted) but drops font styling — what
  // matters by default is structure, text content, and positioning, not type specs.
  auto: { box: true, style: false, text: false, full: false },
  full: { box: true, style: true, text: true, full: true },
};

/** Leaf node types that count as "drawing" rather than content. */
const VECTOR_LEAF = new Set([
  "VECTOR",
  "BOOLEAN_OPERATION",
  "ELLIPSE",
  "STAR",
  "POLYGON",
  "LINE",
  "RECTANGLE",
]);

const round = (n: number, p = 0): number => {
  const f = Math.pow(10, p);
  return Math.round(n * f) / f;
};

function colorToHex(color: any): string {
  if (typeof color === "string") return color; // plugin already converted some
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = color.a !== undefined ? Math.round(color.a * 255) : 255;
  const hex = (x: number) => x.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}${a === 255 ? "" : hex(a)}`;
}

/** Compact a single paint (fill or stroke). Drops NORMAL blendMode and defaults. */
function compactPaint(paint: any, full: boolean): any {
  const p: any = { type: paint.type };
  if (paint.visible === false) p.visible = false;
  if (paint.opacity !== undefined && paint.opacity !== 1) p.opacity = round(paint.opacity, 2);
  if (paint.color) p.color = colorToHex(paint.color);
  // Gradient stops: "#rrggbbaa@pos". Fixes the plugin bug where gradient stops
  // inside strokes keep raw {r,g,b,a} objects (plugin only hexes fill stops).
  if (paint.gradientStops) {
    p.stops = paint.gradientStops.map(
      (s: any) => `${colorToHex(s.color)}@${round(s.position, 2)}`
    );
  }
  if (paint.scaleMode) p.scaleMode = paint.scaleMode; // image fills
  // Handle positions are only needed to *recreate* a gradient — keep in `full`.
  if (full && paint.gradientHandlePositions) {
    p.handles = paint.gradientHandlePositions.map((h: any) => [round(h.x, 3), round(h.y, 3)]);
  }
  return p;
}

function compactTextStyle(s: any, full: boolean): any {
  const o: any = {};
  if (s.fontFamily) o.font = s.fontFamily;
  if (s.fontStyle && s.fontStyle !== "Regular") o.fontStyle = s.fontStyle;
  if (s.fontWeight && s.fontWeight !== 400) o.weight = s.fontWeight;
  if (s.fontSize) o.size = round(s.fontSize, 1);
  if (s.textAlignHorizontal && s.textAlignHorizontal !== "LEFT") o.align = s.textAlignHorizontal;
  if (s.letterSpacing) o.letterSpacing = round(s.letterSpacing, 2); // 0 dropped
  if (full && s.lineHeightPx) o.lineHeight = round(s.lineHeightPx, 1);
  return o;
}

/** True if no TEXT node anywhere in the subtree. */
function hasNoText(node: any): boolean {
  if (node.type === "TEXT") return false;
  if (node.children) return node.children.every(hasNoText);
  return true;
}

/** True if every leaf in the subtree is a vector/shape primitive. */
function allLeavesVector(node: any): boolean {
  if (!node.children || node.children.length === 0) {
    return VECTOR_LEAF.has(node.type);
  }
  return node.children.every(allLeavesVector);
}

function hasAnyLeaf(node: any): boolean {
  if (!node.children || node.children.length === 0) return true;
  return node.children.some(hasAnyLeaf);
}

/**
 * Icon = a container with descendants, no text, all-vector leaves. The root of
 * a request is never collapsed (curDepth 0) — collapsing what was explicitly
 * asked for would defeat the request.
 */
function isIcon(node: any, curDepth: number): boolean {
  if (curDepth === 0) return false;
  if (!node.children || node.children.length === 0) return false; // leaves render as-is
  if (!hasAnyLeaf(node)) return false;
  return hasNoText(node) && allLeavesVector(node);
}

function box(node: any): number[] | undefined {
  const b = node.absoluteBoundingBox;
  if (!b) return undefined;
  return [round(b.x), round(b.y), round(b.width), round(b.height)];
}

type Stack = "h" | "v" | null;

/** This node's own auto-layout direction, if any. */
function stackOf(node: any): Stack {
  if (node.layoutMode === "HORIZONTAL") return "h";
  if (node.layoutMode === "VERTICAL") return "v";
  return null;
}

/** Which axes a child fills inside an auto-layout parent. */
function childFill(node: any, parent: Stack): { w: boolean; h: boolean } {
  const grow = node.layoutGrow === 1; // fills the parent's main axis
  const stretch = node.layoutAlign === "STRETCH"; // fills the counter axis
  return parent === "h" ? { w: grow, h: stretch } : { w: stretch, h: grow };
}

/** Emit auto-layout container spec: stack/gap/padding (positions, not coords). */
function layoutSpec(node: any, out: any, stack: Stack): void {
  if (!stack) return;
  out.stack = stack;
  if (node.itemSpacing) out.gap = round(node.itemSpacing);
  const pads = [node.paddingTop || 0, node.paddingRight || 0, node.paddingBottom || 0, node.paddingLeft || 0];
  if (pads.some((p) => p)) out.pad = pads.every((p) => p === pads[0]) ? round(pads[0]) : pads.map((p) => round(p));
  if (node.primaryAxisAlignItems) out.alignMain = node.primaryAxisAlignItems;
  if (node.counterAxisAlignItems) out.alignCross = node.counterAxisAlignItems;
}

function shapeRec(node: any, opts: Required<ShapeOptions>, f: Fields, curDepth: number, parent: Stack): any {
  const out: any = { id: node.id, name: node.name, type: node.type };

  if (opts.collapseIcons && isIcon(node, curDepth)) {
    out.type = "ICON";
    if (f.box) out.box = box(node);
    out.more = true; // drill in with get_node_info(id) for the real vectors
    return out;
  }

  const myStack = stackOf(node);
  // Geometry: inside an auto-layout parent a child's x/y are layout-determined,
  // so we drop them and express only sizing (fill vs fixed px). Absolutely-
  // positioned children and nodes under a non-layout parent keep the full box.
  if (f.box) {
    const absolute = node.layoutPositioning === "ABSOLUTE";
    if (parent && !absolute) {
      const b = node.absoluteBoundingBox;
      if (b) {
        const fill = childFill(node, parent);
        const w = fill.w ? "fill" : round(b.width);
        const h = fill.h ? "fill" : round(b.height);
        out.size = w === "fill" && h === "fill" ? "fill" : [w, h];
      }
    } else {
      const b = box(node);
      if (b) out.box = b;
    }
  }
  if (f.box) layoutSpec(node, out, myStack);
  if (node.cornerRadius !== undefined && (f.style || f.box)) {
    out.cornerRadius = round(node.cornerRadius, 1);
  }
  if (f.style) {
    if (node.fills && node.fills.length) out.fills = node.fills.map((x: any) => compactPaint(x, f.full));
    if (node.strokes && node.strokes.length) out.strokes = node.strokes.map((x: any) => compactPaint(x, f.full));
  }
  // Text characters are the semantic anchor — keep them on every profile.
  if (node.characters !== undefined) out.characters = node.characters;
  if (node.style && (f.text || f.style)) {
    const ts = compactTextStyle(node.style, f.full);
    if (Object.keys(ts).length) out.style = ts;
  }

  const kids: any[] = node.children || [];
  if (kids.length) {
    if (curDepth < opts.depth) {
      out.children = kids.map((c) => shapeRec(c, opts, f, curDepth + 1, myStack));
    } else {
      out.childCount = kids.length;
      out.more = true; // drill in with get_node_info(id, depth>0)
    }
  }
  return out;
}

/** Hoist fills/strokes arrays used more than once into a shared table. */
function dedupe(root: any): Record<string, any> | undefined {
  const counts = new Map<string, number>();
  const walk = (n: any, fn: (key: string) => void) => {
    for (const k of ["fills", "strokes"] as const) {
      if (n[k]) fn(JSON.stringify(n[k]));
    }
    if (n.children) n.children.forEach((c: any) => walk(c, fn));
  };
  walk(root, (key) => counts.set(key, (counts.get(key) || 0) + 1));

  const defs: Record<string, any> = {};
  const keyFor = new Map<string, string>();
  let n = 0;
  for (const [json, count] of counts) {
    if (count > 1) {
      const ref = `@${++n}`;
      keyFor.set(json, ref);
      defs[ref] = JSON.parse(json);
    }
  }
  if (n === 0) return undefined;

  const replace = (node: any) => {
    for (const k of ["fills", "strokes"] as const) {
      if (node[k]) {
        const ref = keyFor.get(JSON.stringify(node[k]));
        if (ref) node[k] = ref;
      }
    }
    if (node.children) node.children.forEach(replace);
  };
  replace(root);
  return defs;
}

/**
 * Reshape a plugin node tree into the compact agent-facing form.
 * Returns the shaped root; when paints were hoisted it carries `_defs`,
 * a table that `@N` string references in `fills`/`strokes` resolve against.
 */
export function shapeNode(node: any, options: ShapeOptions = {}): any {
  const opts: Required<ShapeOptions> = {
    depth: options.depth ?? 2,
    detail: options.detail ?? "auto",
    collapseIcons: options.collapseIcons ?? true,
    dedupe: options.dedupe ?? true,
  };
  const fields = PROFILES[opts.detail] ?? PROFILES.auto;
  const shaped = shapeRec(node, opts, fields, 0, null);
  if (opts.dedupe && fields.style) {
    const defs = dedupe(shaped);
    if (defs) shaped._defs = defs;
  }
  return shaped;
}
