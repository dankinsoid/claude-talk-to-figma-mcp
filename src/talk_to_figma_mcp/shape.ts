// @ai-generated(guided)
// Compaction layer for Figma node trees returned to the agent.
//
// The Figma plugin returns a fully-recursive, verbose tree (every descendant
// with full geometry/paints/styles). Feeding that straight to the model burns
// tokens and slows every turn. shapeNode() reshapes that tree into a compact,
// "zoomable" form and keeps only a fixed, minimal field set per node:
//
//   id, name, type
//   color | gradient | image   — top-most visible fill (paint opacity folded
//                                 into the hex alpha; gradient = stop colors only)
//   opacity                     — node layer opacity, only when != 1
//   box [x,y,w,h]               — absolute extent, OR
//   autoLayout {flow,gap,pad[],alignMain,alignCross,size}  — for auto-layout
//                                 containers (size = how it fits its own parent)
//   size                        — fill/hug/px, for non-container children in a stack
//   text                        — characters (no font styling)
//   hidden: true                — for a non-root node with visible:false (id only)
//
// A depth cap (default 6) cuts the tree and leaves drill-in stubs ({childCount,
// more:true}); icon-like subtrees collapse to one ICON line; repeated instances
// of the same component collapse to the first copy plus stubs carrying the
// differentiating props/text.

export interface ShapeOptions {
  /**
   * Hard depth cap: levels of children below the requested root. Nodes deeper
   * than this become drill-in stubs ({childCount, more:true}). Default 6.
   */
  depth?: number;
  /** Collapse icon-like subtrees (no text, vector leaves) to one ICON node. */
  collapseIcons?: boolean;
  /**
   * Collapse repeated instances of the same component: the first instance of a
   * given component renders in full, later copies become a stub carrying the
   * differentiating text. Default true.
   */
  collapseRepeats?: boolean;
  /**
   * Cull nodes that are technically visible but render nowhere: fully clipped
   * out by an ancestor's clipsContent, or fully covered by an opaque sibling
   * above them. Culled nodes collapse to {id, clipped:true} / {id, occluded:true}.
   * Default true.
   */
  cull?: boolean;
}

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

/**
 * Fold a paint's layer opacity into the color's hex alpha, so a single hex
 * string carries the visible transparency (e.g. white @0.5 -> "#ffffff80").
 * `hex` is "#rrggbb" or "#rrggbbaa" (plugin already converted color rgba).
 */
function applyAlpha(hex: string, opacity?: number): string {
  let base = 255;
  let rgb = hex;
  if (hex.length === 9) {
    base = parseInt(hex.slice(7, 9), 16);
    rgb = hex.slice(0, 7);
  }
  const eff = Math.round(base * (opacity ?? 1));
  if (eff >= 255) return rgb;
  return rgb + eff.toString(16).padStart(2, "0");
}

/**
 * Reduce a node's fills to its dominant paint: the top-most visible one.
 * SOLID -> {color}, gradient -> {gradient: [stop colors]}, image -> {image}.
 * Stroke/cornerRadius are intentionally dropped from the compact view.
 */
function fillInfo(fills: any[]): { color?: string; gradient?: string[]; image?: boolean } | null {
  if (!Array.isArray(fills) || !fills.length) return null;
  let paint: any = null;
  for (const p of fills) if (p && p.visible !== false) paint = p; // last visible = top of stack
  if (!paint) return null;
  if (paint.type === "SOLID" && paint.color) {
    return { color: applyAlpha(colorToHex(paint.color), paint.opacity) };
  }
  if (paint.gradientStops) {
    return { gradient: paint.gradientStops.map((s: any) => applyAlpha(colorToHex(s.color), paint.opacity)) };
  }
  if (paint.type === "IMAGE") return { image: true };
  return null;
}

/** Axis-aligned bounding rect from a node's absolute box. */
interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
function rect(node: any): Rect | null {
  const b = node.absoluteBoundingBox;
  if (!b) return null;
  return { x1: b.x, y1: b.y, x2: b.x + b.width, y2: b.y + b.height };
}
function intersect(a: Rect | null, b: Rect): Rect {
  if (!a) return b;
  return { x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), x2: Math.min(a.x2, b.x2), y2: Math.min(a.y2, b.y2) };
}
/** r has no pixels inside the visible clip region. */
function fullyOutside(clip: Rect, r: Rect): boolean {
  return r.x2 <= clip.x1 || r.x1 >= clip.x2 || r.y2 <= clip.y1 || r.y1 >= clip.y2;
}
function contains(outer: Rect, inner: Rect): boolean {
  return inner.x1 >= outer.x1 && inner.y1 >= outer.y1 && inner.x2 <= outer.x2 && inner.y2 <= outer.y2;
}

/**
 * True only when this node is guaranteed to paint every pixel of its box fully
 * opaque: a single opaque SOLID fill, no layer transparency, no rounded corners
 * (which leave uncovered pixels), no rotation (which makes the AABB overstate
 * coverage). Deliberately strict — a false positive would erase a visible node.
 */
function opaqueCover(node: any): boolean {
  if (node.rotation) return false;
  if (node.cornerRadius) return false;
  if (node.opacity !== undefined && node.opacity !== 1) return false;
  const fi = node.fills && fillInfo(node.fills);
  // fillInfo drops the alpha pair when fully opaque, so a 7-char "#rrggbb" hex
  // (no alpha) is the opaque case; "#rrggbbaa" carries transparency.
  return !!(fi && fi.color && fi.color.length === 7);
}

/**
 * Ids of children fully hidden behind an opaque later sibling (later in the
 * array renders above). Conservative: only single-sibling full containment.
 */
function occludedSet(kids: any[]): Set<string> {
  const covered = new Set<string>();
  for (let i = 0; i < kids.length; i++) {
    const cr = rect(kids[i]);
    if (!cr) continue;
    for (let j = i + 1; j < kids.length; j++) {
      const o = kids[j];
      if (o.visible === false || !opaqueCover(o)) continue;
      const or = rect(o);
      if (or && contains(or, cr)) {
        covered.add(kids[i].id);
        break;
      }
    }
  }
  return covered;
}

const NONE = new Set<string>();

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

/** Absolute extent/position as [x, y, w, h]. */
function box(node: any): number[] | undefined {
  const b = node.absoluteBoundingBox;
  if (!b) return undefined;
  return [dim(b.x), dim(b.y), dim(b.width), dim(b.height)];
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

/** Padding as [left, top, right, bottom]; undefined when all sides are zero. */
function padArray(node: any): number[] | undefined {
  const t = dim(node.paddingTop || 0);
  const r = dim(node.paddingRight || 0);
  const b = dim(node.paddingBottom || 0);
  const l = dim(node.paddingLeft || 0);
  if (!(t || r || b || l)) return undefined;
  return [l, t, r, b];
}

/**
 * Auto-layout container spec: flow/gap/padding/align plus how the container
 * itself sizes within its parent. Align values are canonical Figma enums
 * (MIN/CENTER/MAX/SPACE_BETWEEN/BASELINE) for round-trip into set_axis_align.
 */
function autoLayoutOf(node: any, stack: "h" | "v", size: any): any {
  const al: any = { flow: stack };
  if (node.itemSpacing) al.gap = dim(node.itemSpacing);
  const pad = padArray(node);
  if (pad) al.pad = pad;
  // Plugin only forwards non-default (non-MIN) alignment, so presence => meaningful.
  if (node.primaryAxisAlignItems) al.alignMain = node.primaryAxisAlignItems;
  if (node.counterAxisAlignItems) al.alignCross = node.counterAxisAlignItems;
  if (size !== undefined) al.size = size;
  return al;
}

/**
 * Mark instances to collapse as repeats: walking in render (pre-)order, the
 * first instance of each component is kept as the template; later instances of
 * an already-seen component are recorded so the render/budget passes treat them
 * as leaves. The requested root is never collapsed. Returns the set of repeat
 * node ids plus a componentId -> template componentProperties map, so a
 * collapsed copy can surface only the props that differ from its template.
 */
function planRepeats(root: any, enabled: boolean): { collapsed: Set<string>; templates: Map<string, any> } {
  const collapsed = new Set<string>();
  const templates = new Map<string, any>();
  if (!enabled) return { collapsed, templates };
  const visit = (node: any, isRoot: boolean) => {
    if (!isRoot && node.type === "INSTANCE" && node.componentId) {
      if (templates.has(node.componentId)) {
        collapsed.add(node.id);
        return; // a copy of an already-seen component — don't descend
      }
      templates.set(node.componentId, node.componentProperties);
    }
    const kids = node.children;
    if (kids) for (const c of kids) visit(c, false);
  };
  visit(root, true);
  return { collapsed, templates };
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

/**
 * Props of a collapsed repeat relative to its template (the first instance of
 * the same component): keep only keys whose value differs. With no template, or
 * when nothing differs, the copy is config-identical and props are dropped.
 */
function propsDiff(cp: any, templateCp: any): Record<string, any> | undefined {
  const cur = compactProps(cp);
  if (!cur) return undefined;
  const tmpl = compactProps(templateCp) || {};
  const o: Record<string, any> = {};
  for (const k of Object.keys(cur)) {
    if (JSON.stringify(cur[k]) !== JSON.stringify(tmpl[k])) o[k] = cur[k];
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
 * Expansion plan: the set of node ids whose children render inline. A node's
 * children expand while within the depth cap; past it (or under an icon /
 * repeated instance) they become drill-in stubs.
 */
function planExpansion(root: any, opts: Required<ShapeOptions>, repeats: Set<string>): Set<string> {
  const expand = new Set<string>([root.id]);
  const queue: { node: any; depth: number }[] = [{ node: root, depth: 0 }];
  while (queue.length) {
    const { node, depth } = queue.shift()!;
    if (opts.collapseIcons && isIcon(node, depth)) continue; // icon: children hidden
    if (repeats.has(node.id)) continue; // repeated instance: children hidden
    if (depth + 1 > opts.depth) continue; // depth cap: children become stubs
    const kids: any[] = node.children || [];
    for (const kid of kids) {
      expand.add(kid.id);
      queue.push({ node: kid, depth: depth + 1 });
    }
  }
  return expand;
}

/** Minimal stub for a truncated node: identity + extent + a drill-in marker. */
function stubNode(node: any, collapseIcons: boolean): any {
  if (node.visible === false) return { id: node.id, hidden: true };
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
  curDepth: number,
  parent: Stack,
  expand: Set<string>,
  repeats: Set<string>,
  templates: Map<string, any>,
  clip: Rect | null
): any {
  // Hidden nodes (except the requested root) collapse to a bare presence marker.
  if (curDepth > 0 && node.visible === false) return { id: node.id, hidden: true };

  const out: any = { id: node.id, name: node.name, type: node.type };

  if (opts.collapseIcons && isIcon(node, curDepth)) {
    out.type = "ICON";
    const b = box(node);
    if (b) out.box = b;
    out.more = true; // drill in with get_node_info(id) for the real vectors
    return out;
  }

  const isRepeat = repeats.has(node.id);
  const myStack = stackOf(node);

  // Paint: top-most visible fill, as color / gradient / image.
  const fi = node.fills && fillInfo(node.fills);
  if (fi) {
    if (fi.color) out.color = fi.color;
    else if (fi.gradient) out.gradient = fi.gradient;
    else if (fi.image) out.image = true;
  }
  if (node.opacity !== undefined && node.opacity !== 1) out.opacity = round(node.opacity, 2);

  // Geometry: inside an auto-layout parent a child's x/y are layout-determined,
  // so we drop them and express only sizing (fill vs hug vs px). Absolutely-
  // positioned children and nodes under a non-layout parent keep the full box.
  const absolute = node.layoutPositioning === "ABSOLUTE";
  let size: any = undefined;
  if (parent && !absolute) {
    const b = node.absoluteBoundingBox;
    if (b) {
      const w = axisSize(node, parent, myStack, "w", dim(b.width));
      const h = axisSize(node, parent, myStack, "h", dim(b.height));
      size = w === h && typeof w === "string" ? w : [w, h];
    }
  }
  const boxArr = !parent || absolute ? box(node) : undefined;

  if (myStack && !isRepeat) {
    // Auto-layout container: its arrangement (with own size folded in). A
    // top-level container not in a flow keeps its absolute box too.
    out.autoLayout = autoLayoutOf(node, myStack, size);
    if (boxArr) out.box = boxArr;
  } else {
    if (size !== undefined) out.size = size;
    if (boxArr) out.box = boxArr;
  }

  // Text characters are the semantic anchor — keep them, drop font styling.
  if (node.characters !== undefined) out.text = node.characters;

  const kids: any[] = node.children || [];
  if (kids.length) {
    if (isRepeat) {
      // Repeated instance: surface only what differentiates this copy from its
      // template (props that differ + any visible text), hide the internals.
      const props = propsDiff(node.componentProperties, templates.get(node.componentId));
      if (props) out.props = props;
      const texts: string[] = [];
      collectText(node, texts, 6);
      if (texts.length) out.text = texts.length === 1 ? texts[0] : texts;
      out.childCount = kids.length;
      out.more = true; // drill in for the full copy
    } else if (expand.has(node.id)) {
      // Clip region passed to children: intersect the inherited clip with this
      // node's box when it clips its content. Occlusion is computed per sibling
      // set (a later opaque sibling covers an earlier one).
      const myRect = rect(node);
      const childClip = opts.cull && node.clipsContent && myRect ? intersect(clip, myRect) : clip;
      const covered = opts.cull ? occludedSet(kids) : NONE;
      // shapeRec handles each child's own state (icon / repeat / full); only
      // budget-truncated children (not in expand) become generic stubs.
      out.children = kids.map((c) => {
        if (c.visible === false) return { id: c.id, hidden: true };
        if (opts.cull && childClip) {
          const r = rect(c);
          if (r && fullyOutside(childClip, r)) return { id: c.id, clipped: true };
        }
        if (covered.has(c.id)) return { id: c.id, occluded: true };
        return expand.has(c.id)
          ? shapeRec(c, opts, curDepth + 1, myStack, expand, repeats, templates, childClip)
          : stubNode(c, opts.collapseIcons);
      });
    } else {
      // Node itself reached the budget edge — surface as a stub in place.
      out.childCount = kids.length;
      out.more = true;
    }
  }
  return out;
}

/**
 * Reshape a plugin node tree into the compact agent-facing form (fixed minimal
 * field set; see file header). Returns the shaped root.
 */
export function shapeNode(node: any, options: ShapeOptions = {}): any {
  const opts: Required<ShapeOptions> = {
    depth: options.depth ?? 6,
    collapseIcons: options.collapseIcons ?? true,
    collapseRepeats: options.collapseRepeats ?? true,
    cull: options.cull ?? true,
  };
  const { collapsed, templates } = planRepeats(node, opts.collapseRepeats);
  const expand = planExpansion(node, opts, collapsed);
  return shapeRec(node, opts, 0, null, expand, collapsed, templates, null);
}
