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
  /**
   * Soft node budget: the tree expands breadth-first until ~this many nodes are
   * emitted, then the rest become drill-in stubs. Keeps response size roughly
   * constant regardless of tree shape. Default 100.
   */
  maxNodes?: number;
  /** Optional hard depth cap (levels of children). Default: unbounded (budget governs). */
  depth?: number;
  detail?: DetailProfile;
  /** Collapse icon-like subtrees (no text, vector leaves) to one ICON node. */
  collapseIcons?: boolean;
  /**
   * Collapse repeated instances of the same component: the first instance of a
   * given component renders in full, later copies become a stub carrying the
   * differentiating text. Default true.
   */
  collapseRepeats?: boolean;
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

/**
 * Geometry rounding: integer for >=1px (a 1px error on a 2000px coord is noise),
 * but keep sub-pixel precision below 1px so thin features (a 0.5px divider) do
 * not round away to nothing.
 */
const dim = (n: number): number => (Math.abs(n) < 1 ? round(n, 2) : Math.round(n));

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

function box(node: any): { x: number; y: number; w: number; h: number } | undefined {
  const b = node.absoluteBoundingBox;
  if (!b) return undefined;
  return { x: dim(b.x), y: dim(b.y), w: dim(b.width), h: dim(b.height) };
}

type Stack = "h" | "v" | null;

/** This node's own auto-layout direction, if any. */
function stackOf(node: any): Stack {
  if (node.layoutMode === "HORIZONTAL") return "h";
  if (node.layoutMode === "VERTICAL") return "v";
  return null;
}

/**
 * Resolve one axis of a node's size to "FILL" (grows in parent), "HUG" (sized
 * to own content), or a fixed px number. fill wins over hug. The string values
 * are the canonical Figma enums (layoutSizingHorizontal/Vertical) so the agent
 * can pass them straight back to set_layout_sizing — read/write round-trip safe.
 */
function axisSize(node: any, parent: Stack, self: Stack, dim: "w" | "h", px: number): number | string {
  if (parent) {
    const isMain = (parent === "h" && dim === "w") || (parent === "v" && dim === "h");
    const fills = isMain ? node.layoutGrow === 1 : node.layoutAlign === "STRETCH";
    if (fills) return "FILL";
  }
  if (self) {
    const isMain = (self === "h" && dim === "w") || (self === "v" && dim === "h");
    const mode = isMain ? node.primaryAxisSizingMode : node.counterAxisSizingMode;
    if (mode === "AUTO") return "HUG";
  }
  return px;
}

/**
 * Collapse padding to the most compact self-describing form: a single value
 * when uniform, {vertical,horizontal} for symmetric pairs, else a {top,right,
 * bottom,left} object. Object forms omit zero sides. Keyed (not positional) so
 * the agent never has to recall an order.
 */
function padOf(node: any): number | Record<string, number> | undefined {
  const t = dim(node.paddingTop || 0);
  const r = dim(node.paddingRight || 0);
  const b = dim(node.paddingBottom || 0);
  const l = dim(node.paddingLeft || 0);
  if (!(t || r || b || l)) return undefined;
  if (t === r && r === b && b === l) return t;
  const o: Record<string, number> = {};
  if (t === b && l === r) {
    if (t) o.vertical = t;
    if (l) o.horizontal = l;
    return o;
  }
  if (t) o.top = t;
  if (r) o.right = r;
  if (b) o.bottom = b;
  if (l) o.left = l;
  return o;
}

/**
 * Emit auto-layout container spec: stack/gap/padding/align (positions, not
 * coords). Values are canonical Figma enums (HORIZONTAL/VERTICAL, MIN/CENTER/
 * MAX/SPACE_BETWEEN/BASELINE) so they round-trip into set_layout_mode /
 * set_axis_align without translation.
 */
function layoutSpec(node: any, out: any, stack: Stack): void {
  if (!stack) return;
  out.stack = stack === "h" ? "HORIZONTAL" : "VERTICAL";
  if (node.itemSpacing) out.gap = dim(node.itemSpacing);
  const pad = padOf(node);
  if (pad !== undefined) out.pad = pad;
  // Plugin only forwards non-default (non-MIN) alignment, so presence => meaningful.
  if (node.primaryAxisAlignItems) out.alignMain = node.primaryAxisAlignItems;
  if (node.counterAxisAlignItems) out.alignCross = node.counterAxisAlignItems;
}

/**
 * Mark instances to collapse as repeats: walking in render (pre-)order, the
 * first instance of each component is kept; later instances of an already-seen
 * component are recorded so the render/budget passes treat them as leaves. The
 * requested root is never collapsed. Returns the set of repeat node ids.
 */
function planRepeats(root: any, enabled: boolean): Set<string> {
  const collapsed = new Set<string>();
  if (!enabled) return collapsed;
  const seen = new Set<string>();
  const visit = (node: any, isRoot: boolean) => {
    if (!isRoot && node.type === "INSTANCE" && node.componentId) {
      if (seen.has(node.componentId)) {
        collapsed.add(node.id);
        return; // a copy of an already-seen component — don't descend
      }
      seen.add(node.componentId);
    }
    const kids = node.children;
    if (kids) for (const c of kids) visit(c, false);
  };
  visit(root, true);
  return collapsed;
}

/**
 * Compact an instance's componentProperties to a flat {name: value} map — the
 * config that distinguishes this instance (text/boolean/variant/instance-swap).
 * Property keys carry a "#id" suffix in Figma; strip it for readability.
 */
function compactProps(cp: any): Record<string, any> | undefined {
  if (!cp || typeof cp !== "object") return undefined;
  const o: Record<string, any> = {};
  for (const key of Object.keys(cp)) {
    const name = key.split("#")[0];
    const v = cp[key];
    o[name] = v && typeof v === "object" && "value" in v ? v.value : v;
  }
  return Object.keys(o).length ? o : undefined;
}

/** Collect up to `cap` text strings from a subtree (the instance's visible words). */
function collectText(node: any, acc: string[], cap: number): void {
  if (acc.length >= cap) return;
  if (node.type === "TEXT" && typeof node.characters === "string") acc.push(node.characters);
  const kids = node.children;
  if (kids) for (const c of kids) {
    if (acc.length >= cap) break;
    collectText(c, acc, cap);
  }
}

/**
 * Breadth-first expansion plan. Walks the tree level by level admitting nodes
 * until the budget runs out; nodes beyond it are recorded as stubs. Returns the
 * set of node ids whose children should be expanded inline. Icons and depth-cap
 * boundaries are not expanded. This decouples "how much to show" from the
 * render pass so size stays predictable across wide and deep trees alike.
 */
function planExpansion(root: any, opts: Required<ShapeOptions>, repeats: Set<string>): Set<string> {
  const expand = new Set<string>([root.id]);
  let count = 1; // root always shown
  const queue: { node: any; depth: number }[] = [{ node: root, depth: 0 }];
  while (queue.length) {
    const { node, depth } = queue.shift()!;
    if (opts.collapseIcons && isIcon(node, depth)) continue; // icon: children hidden
    if (repeats.has(node.id)) continue; // repeated instance: children hidden
    const kids: any[] = node.children || [];
    if (!kids.length) continue;
    const underCap = depth + 1 <= opts.depth;
    for (const kid of kids) {
      count++; // kid appears (full or stub)
      if (count <= opts.maxNodes && underCap) {
        expand.add(kid.id);
        queue.push({ node: kid, depth: depth + 1 });
      }
      // else: kid stays a stub — not added to expand, not enqueued
    }
  }
  return expand;
}

/** Minimal stub for a truncated node: identity + extent + a drill-in marker. */
function stubNode(node: any, collapseIcons: boolean): any {
  const out: any = { id: node.id, name: node.name, type: node.type };
  // A truncated icon reads better as ICON than a generic stub (stubs are always
  // below the root, so depth is non-zero — icon detection is valid here).
  if (collapseIcons && isIcon(node, 1)) out.type = "ICON";
  const b = box(node);
  if (b) out.box = b; // px extent/position so the agent isn't blind (e.g. hug nodes)
  const n = (node.children || []).length;
  if (n) {
    out.childCount = n; // truncation marker: N hidden children
    out.more = true; // re-request this id to expand
  }
  return out;
}

function shapeRec(
  node: any,
  opts: Required<ShapeOptions>,
  f: Fields,
  curDepth: number,
  parent: Stack,
  expand: Set<string>,
  repeats: Set<string>
): any {
  const out: any = { id: node.id, name: node.name, type: node.type };

  if (opts.collapseIcons && isIcon(node, curDepth)) {
    out.type = "ICON";
    if (f.box) out.box = box(node);
    out.more = true; // drill in with get_node_info(id) for the real vectors
    return out;
  }

  const isRepeat = repeats.has(node.id);
  const myStack = stackOf(node);
  // Geometry: inside an auto-layout parent a child's x/y are layout-determined,
  // so we drop them and express only sizing (fill vs fixed px). Absolutely-
  // positioned children and nodes under a non-layout parent keep the full box.
  if (f.box) {
    const absolute = node.layoutPositioning === "ABSOLUTE";
    if (parent && !absolute) {
      const b = node.absoluteBoundingBox;
      if (b) {
        const w = axisSize(node, parent, myStack, "w", dim(b.width));
        const h = axisSize(node, parent, myStack, "h", dim(b.height));
        // Collapse to a bare "fill"/"hug" when both axes share that mode.
        out.size = w === h && typeof w === "string" ? w : { w, h };
      }
    } else {
      const b = box(node);
      if (b) out.box = b;
    }
  }
  // A collapsed repeat hides its internals, so its internal arrangement is moot.
  if (f.box && !isRepeat) layoutSpec(node, out, myStack);
  if (node.cornerRadius !== undefined && (f.style || f.box)) {
    out.cornerRadius = round(node.cornerRadius, 1);
  }
  if (f.style) {
    if (node.fills && node.fills.length) out.fills = node.fills.map((x: any) => compactPaint(x, f.full));
    if (node.strokes && node.strokes.length) {
      out.strokes = node.strokes.map((x: any) => compactPaint(x, f.full));
      // Thickness kept at full precision — stroke weights are small and often
      // sub-pixel, so rounding to int would distort or erase them.
      if (node.strokeWeight !== undefined) out.strokeWeight = round(node.strokeWeight, 2);
    }
  }
  // Text characters are the semantic anchor — keep them on every profile.
  if (node.characters !== undefined) out.characters = node.characters;
  if (node.style && (f.text || f.style)) {
    const ts = compactTextStyle(node.style, f.full);
    if (Object.keys(ts).length) out.style = ts;
  }

  const kids: any[] = node.children || [];
  if (kids.length) {
    if (isRepeat) {
      // Repeated instance: surface the config that differentiates this copy
      // (component properties + any visible text), hide the internals.
      const props = compactProps(node.componentProperties);
      if (props) out.props = props;
      const texts: string[] = [];
      collectText(node, texts, 6);
      if (texts.length) out.text = texts.length === 1 ? texts[0] : texts;
      out.childCount = kids.length;
      out.more = true; // drill in for the full copy
    } else if (expand.has(node.id)) {
      // shapeRec handles each child's own state (icon / repeat / full); only
      // budget-truncated children (not in expand) become generic stubs.
      out.children = kids.map((c) =>
        expand.has(c.id) ? shapeRec(c, opts, f, curDepth + 1, myStack, expand, repeats) : stubNode(c, opts.collapseIcons)
      );
    } else {
      // Node itself reached the budget edge — surface as a stub in place.
      out.childCount = kids.length;
      out.more = true;
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
    maxNodes: options.maxNodes ?? 100,
    depth: options.depth ?? Infinity,
    detail: options.detail ?? "auto",
    collapseIcons: options.collapseIcons ?? true,
    collapseRepeats: options.collapseRepeats ?? true,
    dedupe: options.dedupe ?? true,
  };
  const fields = PROFILES[opts.detail] ?? PROFILES.auto;
  const repeats = planRepeats(node, opts.collapseRepeats);
  const expand = planExpansion(node, opts, repeats);
  const shaped = shapeRec(node, opts, fields, 0, null, expand, repeats);
  if (opts.dedupe && fields.style) {
    const defs = dedupe(shaped);
    if (defs) shaped._defs = defs;
  }
  return shaped;
}
