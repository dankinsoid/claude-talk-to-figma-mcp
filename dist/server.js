#!/usr/bin/env node

// src/talk_to_figma_mcp/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z as z4 } from "zod";
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";
import { writeFile, readFile, mkdir } from "fs/promises";
import { tmpdir, homedir } from "os";
import { dirname, join } from "path";

// src/talk_to_figma_mcp/shape.ts
var VECTOR_LEAF = /* @__PURE__ */ new Set([
  "VECTOR",
  "BOOLEAN_OPERATION",
  "ELLIPSE",
  "STAR",
  "POLYGON",
  "LINE",
  "RECTANGLE"
]);
var round = (n, p = 0) => {
  const f = Math.pow(10, p);
  return Math.round(n * f) / f;
};
var dim = (n) => Math.abs(n) < 1 ? round(n, 2) : Math.round(n);
function colorToHex(color) {
  if (typeof color === "string") return color;
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = color.a !== void 0 ? Math.round(color.a * 255) : 255;
  const hex = (x) => x.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}${a === 255 ? "" : hex(a)}`;
}
function applyAlpha(hex, opacity) {
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
function fillInfo(fills) {
  if (!Array.isArray(fills) || !fills.length) return null;
  let paint = null;
  for (const p of fills) if (p && p.visible !== false) paint = p;
  if (!paint) return null;
  if (paint.type === "SOLID" && paint.color) {
    return { color: applyAlpha(colorToHex(paint.color), paint.opacity) };
  }
  if (paint.gradientStops) {
    return { gradient: paint.gradientStops.map((s) => applyAlpha(colorToHex(s.color), paint.opacity)) };
  }
  if (paint.type === "IMAGE") return { image: true };
  return null;
}
function rect(node) {
  const b = node.absoluteBoundingBox;
  if (!b) return null;
  return { x1: b.x, y1: b.y, x2: b.x + b.width, y2: b.y + b.height };
}
function intersect(a, b) {
  if (!a) return b;
  return { x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), x2: Math.min(a.x2, b.x2), y2: Math.min(a.y2, b.y2) };
}
function fullyOutside(clip, r) {
  return r.x2 <= clip.x1 || r.x1 >= clip.x2 || r.y2 <= clip.y1 || r.y1 >= clip.y2;
}
function contains(outer, inner) {
  return inner.x1 >= outer.x1 && inner.y1 >= outer.y1 && inner.x2 <= outer.x2 && inner.y2 <= outer.y2;
}
function opaqueCover(node) {
  if (node.rotation) return false;
  if (node.cornerRadius) return false;
  if (node.opacity !== void 0 && node.opacity !== 1) return false;
  const fi = node.fills && fillInfo(node.fills);
  return !!(fi && fi.color && fi.color.length === 7);
}
function occludedSet(kids) {
  const covered = /* @__PURE__ */ new Set();
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
var NONE = /* @__PURE__ */ new Set();
function hasNoText(node) {
  if (node.type === "TEXT") return false;
  if (node.children) return node.children.every(hasNoText);
  return true;
}
function allLeavesVector(node) {
  if (!node.children || node.children.length === 0) {
    return VECTOR_LEAF.has(node.type);
  }
  return node.children.every(allLeavesVector);
}
function hasAnyLeaf(node) {
  if (!node.children || node.children.length === 0) return true;
  return node.children.some(hasAnyLeaf);
}
function isIcon(node, curDepth) {
  if (curDepth === 0) return false;
  if (!node.children || node.children.length === 0) return false;
  if (!hasAnyLeaf(node)) return false;
  return hasNoText(node) && allLeavesVector(node);
}
function box(node) {
  const b = node.absoluteBoundingBox;
  if (!b) return void 0;
  return [dim(b.x), dim(b.y), dim(b.width), dim(b.height)];
}
function stackOf(node) {
  if (node.layoutMode === "HORIZONTAL") return "h";
  if (node.layoutMode === "VERTICAL") return "v";
  return null;
}
function axisSize(node, parent, self, dim2, px) {
  if (parent) {
    const isMain = parent === "h" && dim2 === "w" || parent === "v" && dim2 === "h";
    const fills = isMain ? node.layoutGrow === 1 : node.layoutAlign === "STRETCH";
    if (fills) return "FILL";
  }
  if (self) {
    const isMain = self === "h" && dim2 === "w" || self === "v" && dim2 === "h";
    const mode = isMain ? node.primaryAxisSizingMode : node.counterAxisSizingMode;
    if (mode === "AUTO") return "HUG";
  }
  return px;
}
function autoLayoutOf(node, stack, size) {
  const al = { flow: stack };
  if (node.primaryAxisAlignItems) al.alignMain = node.primaryAxisAlignItems;
  if (node.counterAxisAlignItems) al.alignCross = node.counterAxisAlignItems;
  if (size !== void 0) al.size = size;
  return al;
}
function planRepeats(root, enabled) {
  const collapsed = /* @__PURE__ */ new Set();
  const templates = /* @__PURE__ */ new Map();
  if (!enabled) return { collapsed, templates };
  const visit = (node, isRoot) => {
    if (!isRoot && node.type === "INSTANCE" && node.componentId) {
      if (templates.has(node.componentId)) {
        collapsed.add(node.id);
        return;
      }
      templates.set(node.componentId, node.componentProperties);
    }
    const kids = node.children;
    if (kids) for (const c of kids) visit(c, false);
  };
  visit(root, true);
  return { collapsed, templates };
}
function compactProps(cp) {
  if (!cp || typeof cp !== "object") return void 0;
  const o = {};
  for (const key of Object.keys(cp)) {
    const name = key.split("#")[0];
    const v = cp[key];
    o[name] = v && typeof v === "object" && "value" in v ? v.value : v;
  }
  return Object.keys(o).length ? o : void 0;
}
function propsDiff(cp, templateCp) {
  const cur = compactProps(cp);
  if (!cur) return void 0;
  const tmpl = compactProps(templateCp) || {};
  const o = {};
  for (const k of Object.keys(cur)) {
    if (JSON.stringify(cur[k]) !== JSON.stringify(tmpl[k])) o[k] = cur[k];
  }
  return Object.keys(o).length ? o : void 0;
}
function collectText(node, acc, cap) {
  if (acc.length >= cap) return;
  if (node.type === "TEXT" && typeof node.characters === "string") acc.push(node.characters);
  const kids = node.children;
  if (kids) for (const c of kids) {
    if (acc.length >= cap) break;
    collectText(c, acc, cap);
  }
}
function planExpansion(root, opts, repeats) {
  const expand = /* @__PURE__ */ new Set([root.id]);
  const queue = [{ node: root, depth: 0 }];
  while (queue.length) {
    const { node, depth } = queue.shift();
    if (opts.collapseIcons && isIcon(node, depth)) continue;
    if (repeats.has(node.id)) continue;
    if (depth + 1 > opts.depth) continue;
    const kids = node.children || [];
    for (const kid of kids) {
      expand.add(kid.id);
      queue.push({ node: kid, depth: depth + 1 });
    }
  }
  return expand;
}
function stubNode(node, collapseIcons) {
  if (node.visible === false) return { id: node.id, hidden: true };
  const out = { id: node.id, name: node.name, type: node.type };
  if (collapseIcons && isIcon(node, 1)) out.type = "ICON";
  const b = box(node);
  if (b) out.box = b;
  const n = (node.children || []).length;
  if (n) {
    out.childCount = n;
    out.more = true;
  }
  return out;
}
function shapeRec(node, opts, curDepth, parent, expand, repeats, templates, clip) {
  if (curDepth > 0 && node.visible === false) return { id: node.id, hidden: true };
  const out = { id: node.id, name: node.name, type: node.type };
  if (opts.collapseIcons && isIcon(node, curDepth)) {
    out.type = "ICON";
    const b = box(node);
    if (b) out.box = b;
    out.more = true;
    return out;
  }
  const isRepeat = repeats.has(node.id);
  const myStack = stackOf(node);
  const fi = node.fills && fillInfo(node.fills);
  if (fi) {
    if (fi.color) out.color = fi.color;
    else if (fi.gradient) out.gradient = fi.gradient;
    else if (fi.image) out.image = true;
  }
  if (node.opacity !== void 0 && node.opacity !== 1) out.opacity = round(node.opacity, 2);
  const absolute = node.layoutPositioning === "ABSOLUTE";
  let size = void 0;
  if (parent && !absolute) {
    const b = node.absoluteBoundingBox;
    if (b) {
      const w = axisSize(node, parent, myStack, "w", dim(b.width));
      const h = axisSize(node, parent, myStack, "h", dim(b.height));
      size = w === h && typeof w === "string" ? w : [w, h];
    }
  }
  const boxArr = !parent || absolute ? box(node) : void 0;
  if (myStack && !isRepeat) {
    out.autoLayout = autoLayoutOf(node, myStack, size);
    if (boxArr) out.box = boxArr;
  } else {
    if (size !== void 0) out.size = size;
    if (boxArr) out.box = boxArr;
  }
  if (node.characters !== void 0) out.text = node.characters;
  const kids = node.children || [];
  if (kids.length) {
    if (isRepeat) {
      const props = propsDiff(node.componentProperties, templates.get(node.componentId));
      if (props) out.props = props;
      const texts = [];
      collectText(node, texts, 6);
      if (texts.length) out.text = texts.length === 1 ? texts[0] : texts;
      out.childCount = kids.length;
      out.more = true;
    } else if (expand.has(node.id)) {
      const myRect = rect(node);
      const childClip = opts.cull && node.clipsContent && myRect ? intersect(clip, myRect) : clip;
      const covered = opts.cull ? occludedSet(kids) : NONE;
      out.children = kids.map((c) => {
        if (c.visible === false) return { id: c.id, hidden: true };
        if (opts.cull && childClip) {
          const r = rect(c);
          if (r && fullyOutside(childClip, r)) return { id: c.id, clipped: true };
        }
        if (covered.has(c.id)) return { id: c.id, occluded: true };
        return expand.has(c.id) ? shapeRec(c, opts, curDepth + 1, myStack, expand, repeats, templates, childClip) : stubNode(c, opts.collapseIcons);
      });
    } else {
      out.childCount = kids.length;
      out.more = true;
    }
  }
  return out;
}
function shapeNode(node, options = {}) {
  const opts = {
    depth: options.depth ?? 6,
    collapseIcons: options.collapseIcons ?? true,
    collapseRepeats: options.collapseRepeats ?? true,
    cull: options.cull ?? true
  };
  const { collapsed, templates } = planRepeats(node, opts.collapseRepeats);
  const expand = planExpansion(node, opts, collapsed);
  const out = shapeRec(node, opts, 0, null, expand, collapsed, templates, null);
  if (node.ancestors) out.ancestors = node.ancestors;
  return out;
}

// src/talk_to_figma_mcp/idmap.ts
var shortToFull = /* @__PURE__ */ new Map();
var fullToShort = /* @__PURE__ */ new Map();
var counter = 0;
var SHORT_RE = /^n\d+$/;
function shorten(fullId) {
  if (SHORT_RE.test(fullId)) return fullId;
  let s = fullToShort.get(fullId);
  if (!s) {
    s = "n" + counter++;
    fullToShort.set(fullId, s);
    shortToFull.set(s, fullId);
  }
  return s;
}
function renumberIds(node) {
  if (Array.isArray(node)) {
    node.forEach(renumberIds);
    return node;
  }
  if (node && typeof node === "object") {
    const o = node;
    if (typeof o.id === "string") o.id = shorten(o.id);
    for (const k in o) {
      if (o[k] && typeof o[k] === "object") renumberIds(o[k]);
    }
    return node;
  }
  return node;
}
function resolveOne(id) {
  if (!SHORT_RE.test(id)) return id;
  const full = shortToFull.get(id);
  if (!full) {
    throw new Error(
      `Unknown short id "${id}" \u2014 re-fetch the node; short ids reset when the MCP server restarts.`
    );
  }
  return full;
}
var ID_KEYS = /* @__PURE__ */ new Set([
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
  "destinationId",
  // set_reactions: NODE-action target, nested in actions[]
  "instanceNodeId",
  // get_instance_overrides: server renames tool's nodeId before send
  "tableId"
  // edit_table
]);
function resolveShortIdsInParams(value, key = "") {
  if (Array.isArray(value)) return value.map((v) => resolveShortIdsInParams(v, key));
  if (value && typeof value === "object") {
    for (const k in value) value[k] = resolveShortIdsInParams(value[k], k);
    return value;
  }
  if (typeof value === "string" && ID_KEYS.has(key)) return resolveOne(value);
  return value;
}

// src/talk_to_figma_mcp/write_schema.ts
import { z as z3 } from "zod";

// src/talk_to_figma_mcp/write_schema.generated.ts
import { z as z2 } from "zod";

// src/talk_to_figma_mcp/shared-schemas.ts
import { z } from "zod";
var Color = z.union([
  z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "expected #RRGGBB or #RRGGBBAA hex"),
  z.object({ r: z.number(), g: z.number(), b: z.number(), a: z.number().optional() })
]);
var Paint = z.object({
  type: z.enum(["SOLID", "GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND", "IMAGE"]).optional(),
  color: Color.optional().describe("SOLID paint color, #RRGGBB"),
  opacity: z.number().min(0).max(1).optional(),
  // IMAGE paint: pass a URL and the server fetches the bytes and imports them
  // into Figma for you (no imageHash juggling). type defaults to "IMAGE" when
  // imageUrl is present. Alternatively pass an imageHash you already have.
  imageUrl: z.string().optional().describe('image fill source \u2014 https URL, file:// URL or local file path (/abs or ~/); read/fetched server-side and imported; implies type "IMAGE"'),
  imageHash: z.string().optional().describe("pre-imported Figma image hash (alternative to imageUrl)"),
  scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional().describe("IMAGE paint scale mode (default FILL)")
}).passthrough();
var FontName = z.object({ family: z.string(), style: z.string().describe('face name, e.g. "Regular", "Bold Italic"') }).describe("font; loaded automatically before write");
var LetterSpacing = z.union([
  z.number(),
  z.object({ value: z.number(), unit: z.enum(["PIXELS", "PERCENT"]) })
]);
var LineHeight = z.union([
  z.number(),
  z.object({ value: z.number(), unit: z.enum(["PIXELS", "PERCENT"]) }),
  z.object({ unit: z.literal("AUTO") })
]);
var Effect = z.object({ type: z.string().describe("DROP_SHADOW | INNER_SHADOW | LAYER_BLUR | BACKGROUND_BLUR | ...") }).passthrough();

// src/talk_to_figma_mcp/write_schema.generated.ts
var StrokeCap = z2.enum(["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL", "DIAMOND_FILLED", "TRIANGLE_FILLED", "CIRCLE_FILLED"]);
var StrokeJoin = z2.enum(["ROUND", "MITER", "BEVEL"]);
var StrokeAlign = z2.enum(["CENTER", "INSIDE", "OUTSIDE"]);
var LayoutSizingHorizontal = z2.enum(["FIXED", "HUG", "FILL"]);
var LayoutAlign = z2.enum(["CENTER", "MIN", "MAX", "STRETCH", "INHERIT"]);
var LayoutPositioning = z2.enum(["AUTO", "ABSOLUTE"]);
var GridChildHorizontalAlign = z2.enum(["CENTER", "MIN", "MAX", "AUTO"]);
var LayoutMode = z2.enum(["NONE", "HORIZONTAL", "VERTICAL", "GRID"]);
var PrimaryAxisSizingMode = z2.enum(["FIXED", "AUTO"]);
var LayoutWrap = z2.enum(["NO_WRAP", "WRAP"]);
var PrimaryAxisAlignItems = z2.enum(["CENTER", "MIN", "MAX", "SPACE_BETWEEN"]);
var CounterAxisAlignItems = z2.enum(["CENTER", "MIN", "MAX", "BASELINE"]);
var CounterAxisAlignContent = z2.enum(["AUTO", "SPACE_BETWEEN"]);
var GridAutoTracks = z2.enum(["NONE", "ROWS"]);
var GridItemsPositioning = z2.enum(["MANUAL", "ROW_AUTO_FLOW"]);
var Unit = z2.enum(["PIXELS", "PERCENT"]);
var MaskType = z2.enum(["ALPHA", "VECTOR", "LUMINANCE"]);
var BlendMode = z2.enum(["PASS_THROUGH", "NORMAL", "DARKEN", "MULTIPLY", "LINEAR_BURN", "COLOR_BURN", "LIGHTEN", "SCREEN", "LINEAR_DODGE", "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY"]);
var ConstraintType = z2.enum(["CENTER", "MIN", "MAX", "STRETCH", "SCALE"]);
var Constraints = z2.object({ "horizontal": ConstraintType, "vertical": ConstraintType }).passthrough();
var GridTrackSize = z2.object({ "value": z2.number().nullable().optional(), "type": z2.enum(["FIXED", "HUG", "FLEX"]) }).passthrough();
var OverflowDirection = z2.enum(["NONE", "HORIZONTAL", "VERTICAL", "BOTH"]);
var RGB = z2.object({ "r": z2.number(), "g": z2.number(), "b": z2.number() }).passthrough();
var SolidPaint = z2.object({ "type": z2.literal("SOLID"), "color": RGB, "visible": z2.boolean().nullable().optional(), "opacity": z2.number().nullable().optional(), "blendMode": BlendMode.nullable().optional(), "boundVariables": z2.record(z2.unknown()).nullable().optional() }).passthrough();
var HyperlinkTarget = z2.object({ "type": z2.enum(["URL", "NODE"]), "value": z2.string() }).passthrough();
var ArcData = z2.object({ "startingAngle": z2.number(), "endingAngle": z2.number(), "innerRadius": z2.number() }).passthrough();
var VectorPath = z2.object({ "windingRule": z2.enum(["NONE", "NONZERO", "EVENODD"]), "data": z2.string() }).passthrough();
var DocumentationLink = z2.object({ "uri": z2.string() }).passthrough();
var GENERATED_FIELDS = {
  FRAME: {
    "blendMode": BlendMode,
    "bottomLeftRadius": z2.number(),
    "bottomRightRadius": z2.number(),
    "clipsContent": z2.boolean(),
    "constraints": Constraints,
    "cornerRadius": z2.number(),
    "cornerSmoothing": z2.number(),
    "counterAxisAlignContent": CounterAxisAlignContent,
    "counterAxisAlignItems": CounterAxisAlignItems,
    "counterAxisSizingMode": PrimaryAxisSizingMode,
    "counterAxisSpacing": z2.number().nullable(),
    "effects": z2.array(Effect),
    "expanded": z2.boolean(),
    "fills": z2.array(Paint),
    "gridAutoTracks": GridAutoTracks,
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnCount": z2.number(),
    "gridColumnGap": z2.number(),
    "gridColumnSizes": z2.array(GridTrackSize),
    "gridColumnSpan": z2.number(),
    "gridItemsPositioning": GridItemsPositioning,
    "gridRowCount": z2.number(),
    "gridRowGap": z2.number(),
    "gridRowSizes": z2.array(GridTrackSize),
    "gridRowSpan": z2.number(),
    "isMask": z2.boolean(),
    "itemReverseZIndex": z2.boolean(),
    "itemSpacing": z2.number(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": z2.number(),
    "layoutMode": LayoutMode,
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "layoutWrap": LayoutWrap,
    "locked": z2.boolean(),
    "maskType": MaskType,
    "maxHeight": z2.number().nullable(),
    "maxWidth": z2.number().nullable(),
    "minHeight": z2.number().nullable(),
    "minWidth": z2.number().nullable(),
    "name": z2.string(),
    "numberOfFixedChildren": z2.number(),
    "opacity": z2.number(),
    "overflowDirection": OverflowDirection,
    "paddingBottom": z2.number(),
    "paddingLeft": z2.number(),
    "paddingRight": z2.number(),
    "paddingTop": z2.number(),
    "primaryAxisAlignItems": PrimaryAxisAlignItems,
    "primaryAxisSizingMode": PrimaryAxisSizingMode,
    "rotation": z2.number(),
    "strokeAlign": StrokeAlign,
    "strokeBottomWeight": z2.number(),
    "strokeCap": StrokeCap,
    "strokeJoin": StrokeJoin,
    "strokeLeftWeight": z2.number(),
    "strokeMiterLimit": z2.number(),
    "strokeRightWeight": z2.number(),
    "strokeTopWeight": z2.number(),
    "strokeWeight": z2.number(),
    "strokes": z2.array(Paint),
    "strokesIncludedInLayout": z2.boolean(),
    "topLeftRadius": z2.number(),
    "topRightRadius": z2.number(),
    "visible": z2.boolean(),
    "x": z2.number(),
    "y": z2.number()
  },
  TEXT: {
    "autoRename": z2.boolean(),
    "blendMode": BlendMode,
    "characters": z2.string(),
    "constraints": Constraints,
    "effects": z2.array(Effect),
    "fills": z2.array(Paint),
    "fontName": FontName,
    "fontSize": z2.number(),
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnSpan": z2.number(),
    "gridRowSpan": z2.number(),
    "hangingList": z2.boolean(),
    "hangingPunctuation": z2.boolean(),
    "hyperlink": HyperlinkTarget.nullable(),
    "isMask": z2.boolean(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": z2.number(),
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "leadingTrim": z2.enum(["NONE", "CAP_HEIGHT"]),
    "letterSpacing": LetterSpacing,
    "lineHeight": LineHeight,
    "listSpacing": z2.number(),
    "locked": z2.boolean(),
    "maskType": MaskType,
    "maxHeight": z2.number().nullable(),
    "maxLines": z2.number().nullable(),
    "maxWidth": z2.number().nullable(),
    "minHeight": z2.number().nullable(),
    "minWidth": z2.number().nullable(),
    "name": z2.string(),
    "opacity": z2.number(),
    "paragraphIndent": z2.number(),
    "paragraphSpacing": z2.number(),
    "rotation": z2.number(),
    "strokeAlign": StrokeAlign,
    "strokeCap": StrokeCap,
    "strokeJoin": StrokeJoin,
    "strokeMiterLimit": z2.number(),
    "strokeWeight": z2.number(),
    "strokes": z2.array(Paint),
    "textAlignHorizontal": z2.enum(["CENTER", "LEFT", "RIGHT", "JUSTIFIED"]),
    "textAlignVertical": z2.enum(["CENTER", "TOP", "BOTTOM"]),
    "textAutoResize": z2.enum(["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"]),
    "textCase": z2.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"]),
    "textDecoration": z2.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]),
    "textDecorationColor": z2.union([z2.object({ "value": SolidPaint }).passthrough(), z2.object({ "value": z2.literal("AUTO") }).passthrough()]).nullable(),
    "textDecorationOffset": z2.union([z2.object({ "value": z2.number(), "unit": Unit }).passthrough(), z2.object({ "unit": z2.literal("AUTO") }).passthrough()]).nullable(),
    "textDecorationSkipInk": z2.boolean().nullable(),
    "textDecorationStyle": z2.enum(["SOLID", "WAVY", "DOTTED"]).nullable(),
    "textDecorationThickness": z2.union([z2.object({ "value": z2.number(), "unit": Unit }).passthrough(), z2.object({ "unit": z2.literal("AUTO") }).passthrough()]).nullable(),
    "textTruncation": z2.enum(["DISABLED", "ENDING"]),
    "visible": z2.boolean(),
    "x": z2.number(),
    "y": z2.number()
  },
  RECTANGLE: {
    "blendMode": BlendMode,
    "bottomLeftRadius": z2.number(),
    "bottomRightRadius": z2.number(),
    "constraints": Constraints,
    "cornerRadius": z2.number(),
    "cornerSmoothing": z2.number(),
    "effects": z2.array(Effect),
    "fills": z2.array(Paint),
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnSpan": z2.number(),
    "gridRowSpan": z2.number(),
    "isMask": z2.boolean(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": z2.number(),
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "locked": z2.boolean(),
    "maskType": MaskType,
    "maxHeight": z2.number().nullable(),
    "maxWidth": z2.number().nullable(),
    "minHeight": z2.number().nullable(),
    "minWidth": z2.number().nullable(),
    "name": z2.string(),
    "opacity": z2.number(),
    "rotation": z2.number(),
    "strokeAlign": StrokeAlign,
    "strokeBottomWeight": z2.number(),
    "strokeCap": StrokeCap,
    "strokeJoin": StrokeJoin,
    "strokeLeftWeight": z2.number(),
    "strokeMiterLimit": z2.number(),
    "strokeRightWeight": z2.number(),
    "strokeTopWeight": z2.number(),
    "strokeWeight": z2.number(),
    "strokes": z2.array(Paint),
    "topLeftRadius": z2.number(),
    "topRightRadius": z2.number(),
    "visible": z2.boolean(),
    "x": z2.number(),
    "y": z2.number()
  },
  ELLIPSE: {
    "arcData": ArcData,
    "blendMode": BlendMode,
    "constraints": Constraints,
    "cornerRadius": z2.number(),
    "cornerSmoothing": z2.number(),
    "effects": z2.array(Effect),
    "fills": z2.array(Paint),
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnSpan": z2.number(),
    "gridRowSpan": z2.number(),
    "isMask": z2.boolean(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": z2.number(),
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "locked": z2.boolean(),
    "maskType": MaskType,
    "maxHeight": z2.number().nullable(),
    "maxWidth": z2.number().nullable(),
    "minHeight": z2.number().nullable(),
    "minWidth": z2.number().nullable(),
    "name": z2.string(),
    "opacity": z2.number(),
    "rotation": z2.number(),
    "strokeAlign": StrokeAlign,
    "strokeCap": StrokeCap,
    "strokeJoin": StrokeJoin,
    "strokeMiterLimit": z2.number(),
    "strokeWeight": z2.number(),
    "strokes": z2.array(Paint),
    "visible": z2.boolean(),
    "x": z2.number(),
    "y": z2.number()
  },
  LINE: {
    "blendMode": BlendMode,
    "constraints": Constraints,
    "effects": z2.array(Effect),
    "fills": z2.array(Paint),
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnSpan": z2.number(),
    "gridRowSpan": z2.number(),
    "isMask": z2.boolean(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": z2.number(),
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "locked": z2.boolean(),
    "maskType": MaskType,
    "maxHeight": z2.number().nullable(),
    "maxWidth": z2.number().nullable(),
    "minHeight": z2.number().nullable(),
    "minWidth": z2.number().nullable(),
    "name": z2.string(),
    "opacity": z2.number(),
    "rotation": z2.number(),
    "strokeAlign": StrokeAlign,
    "strokeCap": StrokeCap,
    "strokeJoin": StrokeJoin,
    "strokeMiterLimit": z2.number(),
    "strokeWeight": z2.number(),
    "strokes": z2.array(Paint),
    "visible": z2.boolean(),
    "x": z2.number(),
    "y": z2.number()
  },
  STAR: {
    "blendMode": BlendMode,
    "constraints": Constraints,
    "cornerRadius": z2.number(),
    "cornerSmoothing": z2.number(),
    "effects": z2.array(Effect),
    "fills": z2.array(Paint),
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnSpan": z2.number(),
    "gridRowSpan": z2.number(),
    "innerRadius": z2.number(),
    "isMask": z2.boolean(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": z2.number(),
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "locked": z2.boolean(),
    "maskType": MaskType,
    "maxHeight": z2.number().nullable(),
    "maxWidth": z2.number().nullable(),
    "minHeight": z2.number().nullable(),
    "minWidth": z2.number().nullable(),
    "name": z2.string(),
    "opacity": z2.number(),
    "pointCount": z2.number(),
    "rotation": z2.number(),
    "strokeAlign": StrokeAlign,
    "strokeCap": StrokeCap,
    "strokeJoin": StrokeJoin,
    "strokeMiterLimit": z2.number(),
    "strokeWeight": z2.number(),
    "strokes": z2.array(Paint),
    "visible": z2.boolean(),
    "x": z2.number(),
    "y": z2.number()
  },
  POLYGON: {
    "blendMode": BlendMode,
    "constraints": Constraints,
    "cornerRadius": z2.number(),
    "cornerSmoothing": z2.number(),
    "effects": z2.array(Effect),
    "fills": z2.array(Paint),
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnSpan": z2.number(),
    "gridRowSpan": z2.number(),
    "isMask": z2.boolean(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": z2.number(),
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "locked": z2.boolean(),
    "maskType": MaskType,
    "maxHeight": z2.number().nullable(),
    "maxWidth": z2.number().nullable(),
    "minHeight": z2.number().nullable(),
    "minWidth": z2.number().nullable(),
    "name": z2.string(),
    "opacity": z2.number(),
    "pointCount": z2.number(),
    "rotation": z2.number(),
    "strokeAlign": StrokeAlign,
    "strokeCap": StrokeCap,
    "strokeJoin": StrokeJoin,
    "strokeMiterLimit": z2.number(),
    "strokeWeight": z2.number(),
    "strokes": z2.array(Paint),
    "visible": z2.boolean(),
    "x": z2.number(),
    "y": z2.number()
  },
  VECTOR: {
    "blendMode": BlendMode,
    "constraints": Constraints,
    "cornerRadius": z2.number(),
    "cornerSmoothing": z2.number(),
    "effects": z2.array(Effect),
    "fills": z2.array(Paint),
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnSpan": z2.number(),
    "gridRowSpan": z2.number(),
    "handleMirroring": z2.enum(["NONE", "ANGLE", "ANGLE_AND_LENGTH"]),
    "isMask": z2.boolean(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": z2.number(),
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "locked": z2.boolean(),
    "maskType": MaskType,
    "maxHeight": z2.number().nullable(),
    "maxWidth": z2.number().nullable(),
    "minHeight": z2.number().nullable(),
    "minWidth": z2.number().nullable(),
    "name": z2.string(),
    "opacity": z2.number(),
    "rotation": z2.number(),
    "strokeAlign": StrokeAlign,
    "strokeCap": StrokeCap,
    "strokeJoin": StrokeJoin,
    "strokeMiterLimit": z2.number(),
    "strokeWeight": z2.number(),
    "strokes": z2.array(Paint),
    "vectorPaths": z2.array(VectorPath),
    "visible": z2.boolean(),
    "x": z2.number(),
    "y": z2.number()
  },
  COMPONENT: {
    "blendMode": BlendMode,
    "bottomLeftRadius": z2.number(),
    "bottomRightRadius": z2.number(),
    "clipsContent": z2.boolean(),
    "constraints": Constraints,
    "cornerRadius": z2.number(),
    "cornerSmoothing": z2.number(),
    "counterAxisAlignContent": CounterAxisAlignContent,
    "counterAxisAlignItems": CounterAxisAlignItems,
    "counterAxisSizingMode": PrimaryAxisSizingMode,
    "counterAxisSpacing": z2.number().nullable(),
    "description": z2.string(),
    "descriptionMarkdown": z2.string(),
    "documentationLinks": z2.array(DocumentationLink),
    "effects": z2.array(Effect),
    "expanded": z2.boolean(),
    "fills": z2.array(Paint),
    "gridAutoTracks": GridAutoTracks,
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnCount": z2.number(),
    "gridColumnGap": z2.number(),
    "gridColumnSizes": z2.array(GridTrackSize),
    "gridColumnSpan": z2.number(),
    "gridItemsPositioning": GridItemsPositioning,
    "gridRowCount": z2.number(),
    "gridRowGap": z2.number(),
    "gridRowSizes": z2.array(GridTrackSize),
    "gridRowSpan": z2.number(),
    "isMask": z2.boolean(),
    "itemReverseZIndex": z2.boolean(),
    "itemSpacing": z2.number(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": z2.number(),
    "layoutMode": LayoutMode,
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "layoutWrap": LayoutWrap,
    "locked": z2.boolean(),
    "maskType": MaskType,
    "maxHeight": z2.number().nullable(),
    "maxWidth": z2.number().nullable(),
    "minHeight": z2.number().nullable(),
    "minWidth": z2.number().nullable(),
    "name": z2.string(),
    "numberOfFixedChildren": z2.number(),
    "opacity": z2.number(),
    "overflowDirection": OverflowDirection,
    "paddingBottom": z2.number(),
    "paddingLeft": z2.number(),
    "paddingRight": z2.number(),
    "paddingTop": z2.number(),
    "primaryAxisAlignItems": PrimaryAxisAlignItems,
    "primaryAxisSizingMode": PrimaryAxisSizingMode,
    "rotation": z2.number(),
    "strokeAlign": StrokeAlign,
    "strokeBottomWeight": z2.number(),
    "strokeCap": StrokeCap,
    "strokeJoin": StrokeJoin,
    "strokeLeftWeight": z2.number(),
    "strokeMiterLimit": z2.number(),
    "strokeRightWeight": z2.number(),
    "strokeTopWeight": z2.number(),
    "strokeWeight": z2.number(),
    "strokes": z2.array(Paint),
    "strokesIncludedInLayout": z2.boolean(),
    "topLeftRadius": z2.number(),
    "topRightRadius": z2.number(),
    "visible": z2.boolean(),
    "x": z2.number(),
    "y": z2.number()
  },
  SECTION: {
    "bottomLeftRadius": z2.number(),
    "bottomRightRadius": z2.number(),
    "cornerRadius": z2.number(),
    "cornerSmoothing": z2.number(),
    "fills": z2.array(Paint),
    "locked": z2.boolean(),
    "maxHeight": z2.number().nullable(),
    "maxWidth": z2.number().nullable(),
    "minHeight": z2.number().nullable(),
    "minWidth": z2.number().nullable(),
    "name": z2.string(),
    "sectionContentsHidden": z2.boolean(),
    "strokeAlign": StrokeAlign,
    "strokeJoin": StrokeJoin,
    "strokeWeight": z2.number(),
    "strokes": z2.array(Paint),
    "topLeftRadius": z2.number(),
    "topRightRadius": z2.number(),
    "visible": z2.boolean(),
    "x": z2.number(),
    "y": z2.number()
  },
  SLICE: {
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnSpan": z2.number(),
    "gridRowSpan": z2.number(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": z2.number(),
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "locked": z2.boolean(),
    "maxHeight": z2.number().nullable(),
    "maxWidth": z2.number().nullable(),
    "minHeight": z2.number().nullable(),
    "minWidth": z2.number().nullable(),
    "name": z2.string(),
    "rotation": z2.number(),
    "visible": z2.boolean(),
    "x": z2.number(),
    "y": z2.number()
  },
  INSTANCE: {
    "blendMode": BlendMode,
    "bottomLeftRadius": z2.number(),
    "bottomRightRadius": z2.number(),
    "clipsContent": z2.boolean(),
    "constraints": Constraints,
    "cornerRadius": z2.number(),
    "cornerSmoothing": z2.number(),
    "counterAxisAlignContent": CounterAxisAlignContent,
    "counterAxisAlignItems": CounterAxisAlignItems,
    "counterAxisSizingMode": PrimaryAxisSizingMode,
    "counterAxisSpacing": z2.number().nullable(),
    "effects": z2.array(Effect),
    "expanded": z2.boolean(),
    "fills": z2.array(Paint),
    "gridAutoTracks": GridAutoTracks,
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnCount": z2.number(),
    "gridColumnGap": z2.number(),
    "gridColumnSizes": z2.array(GridTrackSize),
    "gridColumnSpan": z2.number(),
    "gridItemsPositioning": GridItemsPositioning,
    "gridRowCount": z2.number(),
    "gridRowGap": z2.number(),
    "gridRowSizes": z2.array(GridTrackSize),
    "gridRowSpan": z2.number(),
    "isExposedInstance": z2.boolean(),
    "isMask": z2.boolean(),
    "itemReverseZIndex": z2.boolean(),
    "itemSpacing": z2.number(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": z2.number(),
    "layoutMode": LayoutMode,
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "layoutWrap": LayoutWrap,
    "locked": z2.boolean(),
    "maskType": MaskType,
    "maxHeight": z2.number().nullable(),
    "maxWidth": z2.number().nullable(),
    "minHeight": z2.number().nullable(),
    "minWidth": z2.number().nullable(),
    "name": z2.string(),
    "numberOfFixedChildren": z2.number(),
    "opacity": z2.number(),
    "overflowDirection": OverflowDirection,
    "paddingBottom": z2.number(),
    "paddingLeft": z2.number(),
    "paddingRight": z2.number(),
    "paddingTop": z2.number(),
    "primaryAxisAlignItems": PrimaryAxisAlignItems,
    "primaryAxisSizingMode": PrimaryAxisSizingMode,
    "rotation": z2.number(),
    "scaleFactor": z2.number(),
    "strokeAlign": StrokeAlign,
    "strokeBottomWeight": z2.number(),
    "strokeCap": StrokeCap,
    "strokeJoin": StrokeJoin,
    "strokeLeftWeight": z2.number(),
    "strokeMiterLimit": z2.number(),
    "strokeRightWeight": z2.number(),
    "strokeTopWeight": z2.number(),
    "strokeWeight": z2.number(),
    "strokes": z2.array(Paint),
    "strokesIncludedInLayout": z2.boolean(),
    "topLeftRadius": z2.number(),
    "topRightRadius": z2.number(),
    "visible": z2.boolean(),
    "x": z2.number(),
    "y": z2.number()
  },
  CODE_BLOCK: {
    "blendMode": BlendMode,
    "code": z2.string(),
    "codeLanguage": z2.enum(["TYPESCRIPT", "CPP", "RUBY", "CSS", "JAVASCRIPT", "HTML", "JSON", "GRAPHQL", "PYTHON", "GO", "SQL", "SWIFT", "KOTLIN", "RUST", "BASH", "PLAINTEXT", "DART"]),
    "locked": z2.boolean(),
    "maxHeight": z2.number().nullable(),
    "maxWidth": z2.number().nullable(),
    "minHeight": z2.number().nullable(),
    "minWidth": z2.number().nullable(),
    "name": z2.string(),
    "opacity": z2.number(),
    "visible": z2.boolean(),
    "x": z2.number(),
    "y": z2.number()
  },
  STICKY: {
    "authorName": z2.string(),
    "authorVisible": z2.boolean(),
    "blendMode": BlendMode,
    "fills": z2.array(Paint),
    "isWideWidth": z2.boolean(),
    "locked": z2.boolean(),
    "maxHeight": z2.number().nullable(),
    "maxWidth": z2.number().nullable(),
    "minHeight": z2.number().nullable(),
    "minWidth": z2.number().nullable(),
    "name": z2.string(),
    "opacity": z2.number(),
    "visible": z2.boolean(),
    "x": z2.number(),
    "y": z2.number()
  },
  SHAPE_WITH_TEXT: {
    "blendMode": BlendMode,
    "fills": z2.array(Paint),
    "locked": z2.boolean(),
    "maxHeight": z2.number().nullable(),
    "maxWidth": z2.number().nullable(),
    "minHeight": z2.number().nullable(),
    "minWidth": z2.number().nullable(),
    "name": z2.string(),
    "opacity": z2.number(),
    "rotation": z2.number(),
    "shapeType": z2.enum(["SQUARE", "ELLIPSE", "ROUNDED_RECTANGLE", "DIAMOND", "TRIANGLE_UP", "TRIANGLE_DOWN", "PARALLELOGRAM_RIGHT", "PARALLELOGRAM_LEFT", "ENG_DATABASE", "ENG_QUEUE", "ENG_FILE", "ENG_FOLDER", "TRAPEZOID", "PREDEFINED_PROCESS", "SHIELD", "DOCUMENT_SINGLE", "DOCUMENT_MULTIPLE", "MANUAL_INPUT", "HEXAGON", "CHEVRON", "PENTAGON", "OCTAGON", "STAR", "PLUS", "ARROW_LEFT", "ARROW_RIGHT", "SUMMING_JUNCTION", "OR", "SPEECH_BUBBLE", "INTERNAL_STORAGE"]),
    "strokeAlign": StrokeAlign,
    "strokeJoin": StrokeJoin,
    "strokeWeight": z2.number(),
    "strokes": z2.array(Paint),
    "visible": z2.boolean(),
    "x": z2.number(),
    "y": z2.number()
  }
};

// src/talk_to_figma_mcp/write_schema.ts
var NODE_TYPES = [
  "FRAME",
  "TEXT",
  "RECTANGLE",
  "ELLIPSE",
  "LINE",
  "STAR",
  "POLYGON",
  "VECTOR",
  "COMPONENT",
  "SECTION",
  "SLICE",
  "INSTANCE",
  "SVG",
  "CODE_BLOCK",
  "STICKY",
  "SHAPE_WITH_TEXT"
];
var NOTES = {
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
  lineHeight: "number = PIXELS; {value,unit:'PERCENT'} or {unit:'AUTO'}"
};
var parentId = z3.string().optional().describe("container to append into; default current page. short ids (n0) or full ids");
var index = z3.number().int().min(0).optional().describe("position among siblings");
var width = z3.number().positive().optional().describe("routed through resize()");
var height = z3.number().positive().optional().describe("routed through resize()");
var componentId = z3.string().optional().describe("local COMPONENT id (from get_local_components)");
var componentKey = z3.string().optional().describe("published library component key");
var svg = z3.string().optional().describe("raw SVG markup to import as a vector node");
var svgUrl = z3.string().optional().describe("SVG source \u2014 https URL or local file path (/abs, ~/ or file://); read/fetched server-side, then imported");
var children = z3.array(z3.lazy(() => writeNodeUnion)).optional().describe("nested specs, created recursively inside this node");
var CONTAINER_TYPES = /* @__PURE__ */ new Set(["FRAME", "COMPONENT", "SECTION", "INSTANCE", "SVG"]);
var REQUIRED = { TEXT: /* @__PURE__ */ new Set(["characters"]) };
var SUBLAYER_TEXT_TYPES = /* @__PURE__ */ new Set(["STICKY", "SHAPE_WITH_TEXT"]);
var SUBLAYER_TEXT_FIELDS = ["characters", "fontName", "fontSize", "letterSpacing", "lineHeight", "textAlignHorizontal"];
var pixelsOrUnit = z3.union([
  z3.number(),
  z3.object({ value: z3.number(), unit: z3.enum(["PIXELS", "PERCENT"]) }).passthrough()
]);
var FIELD_OVERRIDES = {
  opacity: z3.number().min(0).max(1),
  cornerRadius: z3.number().min(0),
  strokeWeight: z3.number().min(0),
  letterSpacing: pixelsOrUnit,
  lineHeight: z3.union([pixelsOrUnit, z3.object({ unit: z3.literal("AUTO") }).passthrough()])
};
var READ_ONLY_KEYS = {
  style: "REST read-format; on write use fontName {family,style} + fontSize on a TEXT node",
  absoluteBoundingBox: "read-only; use x/y + width/height",
  absoluteRenderBounds: "read-only (computed)",
  characterStyleOverrides: "per-range text styling not supported on write; one uniform style per node",
  styleOverrideTable: "per-range text styling not supported on write",
  boundVariables: "variable bindings not supported on write; set a literal value",
  id: "assigned by Figma"
};
function compose(type) {
  const gen = GENERATED_FIELDS[type] ?? {};
  const required = REQUIRED[type] ?? /* @__PURE__ */ new Set();
  const shape = { type: z3.literal(type) };
  for (const [key, generated] of Object.entries(gen)) {
    const base = FIELD_OVERRIDES[key] ?? generated;
    let field = required.has(key) ? base : base.optional();
    if (NOTES[key]) field = field.describe(NOTES[key]);
    shape[key] = field;
  }
  if (SUBLAYER_TEXT_TYPES.has(type)) {
    const textGen = GENERATED_FIELDS.TEXT ?? {};
    for (const key of SUBLAYER_TEXT_FIELDS) {
      if (shape[key] || !textGen[key]) continue;
      let field = textGen[key].optional();
      if (NOTES[key]) field = field.describe(NOTES[key]);
      shape[key] = field;
    }
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
  if (type === "SVG") {
    shape.svg = svg;
    shape.svgUrl = svgUrl;
  }
  return z3.object(shape).passthrough();
}
var NODE_SCHEMAS = Object.fromEntries(
  NODE_TYPES.map((t) => [t, compose(t)])
);
function rejectReadOnly(spec, ctx) {
  for (const key of Object.keys(spec)) {
    if (key in READ_ONLY_KEYS) {
      ctx.addIssue({ code: z3.ZodIssueCode.custom, message: READ_ONLY_KEYS[key], path: [key] });
    }
  }
}
var writeNodeUnion = z3.lazy(
  () => z3.discriminatedUnion("type", NODE_TYPES.map((t) => NODE_SCHEMAS[t])).superRefine((spec, ctx) => {
    rejectReadOnly(spec, ctx);
    if (spec.type === "INSTANCE" && !spec.componentId && !spec.componentKey) {
      ctx.addIssue({ code: z3.ZodIssueCode.custom, message: "INSTANCE needs componentId (local) or componentKey (published)", path: ["componentId"] });
    }
    if (spec.type === "SVG" && !spec.svg && !spec.svgUrl) {
      ctx.addIssue({ code: z3.ZodIssueCode.custom, message: "SVG needs `svg` markup or `svgUrl`", path: ["svg"] });
    }
  })
);
function renderType(schema) {
  const def = schema._def;
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
      const checks = def.checks || [];
      const lo = checks.find((c) => c.kind === "min");
      const hi = checks.find((c) => c.kind === "max");
      if (lo && hi) return `number ${lo.value}..${hi.value}`;
      if (checks.some((c) => c.kind === "min" && c.value === 0)) return "number \u22650";
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
function unwrapObject(schema) {
  let s = schema;
  while (s && s._def) {
    if (s._def.typeName === "ZodObject") return s;
    if (s._def.typeName === "ZodEffects") {
      s = s._def.schema;
      continue;
    }
    if (s._def.innerType) {
      s = s._def.innerType;
      continue;
    }
    return null;
  }
  return null;
}
function describeNodeSchema(type) {
  const obj = unwrapObject(NODE_SCHEMAS[type]);
  if (!obj) return `unknown type ${type}`;
  const shape = obj._def.shape();
  const lines = [`${type} \u2014 write_nodes spec fields:`];
  for (const key of Object.keys(shape)) {
    if (key === "type") continue;
    const field = shape[key];
    const optional = field._def.typeName === "ZodOptional";
    const note = field._def.description || field._def.innerType && field._def.innerType._def?.description;
    lines.push(`  ${key}${optional ? "?" : ""}: ${renderType(field)}${note ? ` \u2014 ${note}` : ""}`);
  }
  lines.push("  (+ any other Figma property for this type passes through)");
  return lines.join("\n");
}
function listNodeTypes() {
  return "Node types (get_write_schema(type) for fields):\n  " + NODE_TYPES.join(", ");
}
var FIELD_SCHEMAS = {};
for (const type of NODE_TYPES) {
  for (const [key, schema] of Object.entries(GENERATED_FIELDS[type] ?? {})) {
    if (!(key in FIELD_SCHEMAS)) FIELD_SCHEMAS[key] = FIELD_OVERRIDES[key] ?? schema;
  }
}
FIELD_SCHEMAS.width = z3.number().positive();
FIELD_SCHEMAS.height = z3.number().positive();
function validateEditValue(path, value) {
  const segs = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  if (!segs.length) return null;
  if (segs[0] in READ_ONLY_KEYS) return READ_ONLY_KEYS[segs[0]];
  const endsWithIndex = /^\d+$/.test(segs[segs.length - 1]);
  const leaf = [...segs].reverse().find((s) => !/^\d+$/.test(s));
  if (!leaf) return null;
  let schema;
  if (leaf === "color") schema = Color;
  else if (leaf === "fills" || leaf === "strokes") schema = endsWithIndex ? Paint : z3.array(Paint);
  else schema = FIELD_SCHEMAS[leaf] ?? null;
  if (!schema) return null;
  const r = schema.safeParse(value);
  if (r.success) return null;
  return r.error.issues[0]?.message ?? "invalid value";
}

// src/talk_to_figma_mcp/server.ts
var logger = {
  info: (message) => process.stderr.write(`[INFO] ${message}
`),
  debug: (message) => process.stderr.write(`[DEBUG] ${message}
`),
  warn: (message) => process.stderr.write(`[WARN] ${message}
`),
  error: (message) => process.stderr.write(`[ERROR] ${message}
`),
  log: (message) => process.stderr.write(`[LOG] ${message}
`)
};
var ws = null;
var pendingRequests = /* @__PURE__ */ new Map();
var currentChannel = null;
var server = new McpServer({
  name: "TalkToFigmaMCP",
  version: "1.0.0"
});
var args = process.argv.slice(2);
var serverArg = args.find((arg) => arg.startsWith("--server="));
var serverUrl = serverArg ? serverArg.split("=")[1] : "localhost";
var WS_URL = serverUrl === "localhost" ? `ws://${serverUrl}` : `wss://${serverUrl}`;
var saveParams = {
  saveToFile: z4.boolean().optional().describe(
    "If true, write the full result to a file and return only its path + byte size instead of the payload. Use for large outputs to keep them out of the LLM context."
  ),
  outputPath: z4.string().optional().describe(
    "Explicit file path to write the result to (implies saveToFile). Parent dirs are created. Defaults to an auto-named file under the OS temp dir."
  )
};
var outputFileSeq = 0;
var INLINE_MAX_BYTES = 1024 * 1024;
var IMPORT_MAX_BYTES = 10 * 1024 * 1024;
async function resolveExternalAssets(value) {
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
async function fetchAssetBytes(url) {
  let localPath;
  if (url.startsWith("file://")) localPath = decodeURIComponent(new URL(url).pathname);
  else if (url.startsWith("/")) localPath = url;
  else if (url.startsWith("~/")) localPath = join(homedir(), url.slice(2));
  let buf;
  if (localPath !== void 0) {
    buf = await readFile(localPath);
  } else {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} \u2192 HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  }
  if (buf.byteLength > IMPORT_MAX_BYTES) {
    throw new Error(`asset ${url} is ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB, over the ${IMPORT_MAX_BYTES / 1024 / 1024}MB import cap`);
  }
  return buf;
}
async function fetchAssetBase64(url) {
  return (await fetchAssetBytes(url)).toString("base64");
}
async function fetchAssetText(url) {
  return (await fetchAssetBytes(url)).toString("utf8");
}
async function writeOutputFile(baseName, ext, data, outputPath) {
  const safeBase = baseName.replace(/[^a-zA-Z0-9_-]/g, "-");
  const target = outputPath ? outputPath : join(tmpdir(), "talk-to-figma", `${safeBase}-${Date.now()}-${outputFileSeq++}.${ext}`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
  const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
  return { path: target, bytes };
}
var AUTO_SAVE_BYTES = 1e5;
async function jsonContent(payload, save, baseName) {
  const text = JSON.stringify(payload);
  if (save?.saveToFile || save?.outputPath) {
    const { path, bytes } = await writeOutputFile(baseName, "json", text, save.outputPath);
    return { type: "text", text: `Saved ${bytes} bytes of JSON to ${path}` };
  }
  if (Buffer.byteLength(text) > AUTO_SAVE_BYTES) {
    try {
      const { path, bytes } = await writeOutputFile(baseName, "json", text);
      return {
        type: "text",
        text: `Output too large to return inline (${bytes} bytes); saved to ${path}. Read it from there, or re-request with a lower depth to shrink the result.`
      };
    } catch {
    }
  }
  return { type: "text", text };
}
async function textContent(text, summary, save, baseName) {
  if (save?.saveToFile || save?.outputPath) {
    const { path, bytes } = await writeOutputFile(baseName, "txt", text, save.outputPath);
    return { type: "text", text: `Saved ${bytes} bytes (${summary}) to ${path}` };
  }
  if (Buffer.byteLength(text) > AUTO_SAVE_BYTES) {
    try {
      const { path, bytes } = await writeOutputFile(baseName, "txt", text);
      return {
        type: "text",
        text: `Output too large to return inline (${bytes} bytes, ${summary}); saved to ${path}. Read it from there, or narrow with type/name/depth.`
      };
    } catch {
    }
  }
  return { type: "text", text };
}
server.tool(
  "get_selection",
  "Get information about the current selection in Figma",
  { ...saveParams },
  async ({ saveToFile, outputPath }) => {
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
            text: `Error getting selection: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
var shapeParams = {
  depth: z4.number().int().min(0).optional().describe("Levels of children below the requested node to expand (default 6). Deeper nodes become stubs with {childCount, more:true}; re-request that id to zoom in. Raise to see more at once, lower for a terser overview."),
  collapseIcons: z4.boolean().optional().describe("Collapse icon-like subtrees (no text, vector leaves) to a single ICON node with more:true (default true)."),
  collapseRepeats: z4.boolean().optional().describe("Collapse repeated instances of the same component: the first renders in full, later copies become a stub with their props/text and more:true (default true)."),
  cull: z4.boolean().optional().describe("Drop nodes that render nowhere \u2014 fully clipped out by an ancestor's clipsContent ({id, clipped:true}) or fully covered by an opaque sibling above ({id, occluded:true}). Default true.")
};
var NAME_MAX = 40;
function truncName(name) {
  if (typeof name !== "string" || name.length <= NAME_MAX) return name;
  return name.slice(0, NAME_MAX - 1) + "\u2026";
}
function fmtNodeRef(id, name, type) {
  return `${id}:${JSON.stringify(truncName(name))}.${type}`;
}
server.tool(
  "read_node",
  "Read Figma nodes \u2014 the Read tool for the canvas. Pass `nodeIds` (one or many); omit it to read the current selection. Returns one entry per node. Default (compact) gives each node's subtree in a minimal, low-token field set (id, name, type, color/gradient, opacity, box or autoLayout, text); children expand to `depth` levels and deeper nodes become {childCount, more:true} stubs \u2014 re-request a stub's id or raise depth to zoom in. Each requested node also carries `ancestors`: a root-first breadcrumb (page \u2192 ... \u2192 immediate parent) of `id:\"name\".TYPE` tokens (same form as glob lines) so you know what contains it without a separate glob \u2014 those ids are short counters too, so pass one back to zoom OUT. Set `raw:true` for the full, unfiltered JSON_REST_V1 of each node with ALL properties but the children array stripped (use when the compact view drops a field you need); in raw mode depth/collapse/cull are ignored \u2014 raw is always one node, all props, no children. Large outputs auto-spill to a file. Node ids are short counters (n0, n1, ...) standing in for canonical Figma ids \u2014 pass them to any tool. Locate ids with glob_nodes/grep_nodes first, then read_node to inspect properties.",
  {
    nodeIds: z4.array(z4.string()).optional().describe("Node ids to read (short n0,... or canonical). Omit to read the current selection."),
    raw: z4.boolean().optional().describe("Return each node's full unfiltered props (children stripped) instead of the compact subtree. Ignores depth/collapse/cull. Default false."),
    ...shapeParams,
    ...saveParams
  },
  async ({ nodeIds, raw, depth, collapseIcons, collapseRepeats, cull, saveToFile, outputPath }) => {
    try {
      let ids = Array.isArray(nodeIds) ? nodeIds : [];
      if (ids.length === 0) {
        const sel = await sendCommandToFigma("get_selection");
        ids = (sel?.selection ?? []).map((n) => n.id);
      }
      if (ids.length === 0) {
        return {
          content: [{ type: "text", text: "No nodes to read: no nodeIds given and the selection is empty." }]
        };
      }
      if (raw) {
        const nodes = await Promise.all(
          ids.map(async (nodeId) => ({
            requestedId: nodeId,
            node: await sendCommandToFigma("read_node_raw", { nodeId })
          }))
        );
        return {
          content: [await jsonContent(nodes, { saveToFile, outputPath }, "node-raw")]
        };
      }
      const opts = { depth, collapseIcons, collapseRepeats, cull };
      const infos = await Promise.all(
        ids.map((nodeId) => sendCommandToFigma("read_node", { nodeId }))
      );
      const shaped = renumberIds(infos.map((info) => shapeNode(info, opts)));
      for (const node of shaped) {
        if (Array.isArray(node?.ancestors)) {
          node.ancestors = node.ancestors.map((a) => fmtNodeRef(a.id, a.name, a.type));
        }
      }
      return {
        content: [await jsonContent(shaped, { saveToFile, outputPath }, "node-info")]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error reading node(s): ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
server.tool(
  "glob_nodes",
  'List nodes under a root by type and/or name glob, one per line as `id:"name".TYPE @parent [x,y wxh]` \u2014 a flat, grep-friendly index of a subtree (the Figma analog of glob / `ls -R`). The `@parent` is the immediate container\'s short id (location without drawing the tree; pass it to read_node to see surroundings). The trailing `[x,y wxh]` is the node\'s ABSOLUTE bounding box (omitted with `bbox:false`, or when a node has no geometry). Filters: `type` (a node type, an array, or "*"/omit for any); `name` (a shell-style glob over the node\'s OWN name: `*` = any run, `?` = one char; omit for any \u2014 matches names only, not paths, since Figma names contain slashes); and `within` (an absolute rect \u2014 keep only nodes intersecting it, e.g. to glob a region; get its coords from a prior bbox). `root` is the node id to search under (default: current page); descends through every container regardless of match (any-depth search), with `depth` capping how deep. Ids (including `@parent`) are short counters (n0, n1, ...) \u2014 feed any straight into read/edit tools.',
  {
    root: z4.string().optional().describe("Node id to search under. Defaults to the current page. Accepts short ids (n0, ...)."),
    name: z4.string().optional().describe("Shell-style glob matched against each node's own name (* = any run, ? = one char). Case-insensitive. Omit to match any name."),
    type: z4.union([z4.string(), z4.array(z4.string())]).optional().describe('Node type filter: a single type (e.g. "TEXT"), an array (["TEXT","INSTANCE"]), or "*"/omit for any. Case-insensitive.'),
    depth: z4.number().optional().describe("Max depth below root to descend (root's direct children = 1). Omit for unlimited."),
    bbox: z4.boolean().optional().describe("Append each hit's absolute bounding box as [x,y wxh]. Default true; pass false to drop it and save tokens."),
    within: z4.object({
      x: z4.number(),
      y: z4.number(),
      width: z4.number(),
      height: z4.number()
    }).optional().describe("Absolute rectangle; keep only nodes whose bounding box intersects it. Coordinates are absolute (same space as the [x,y wxh] output). Use to glob a visual region."),
    ...saveParams
  },
  async ({ root, name, type, depth, bbox, within, saveToFile, outputPath }) => {
    try {
      const result = await sendCommandToFigma("glob_nodes", { root, name, type, depth, bbox, within });
      const matches = renumberIds(result?.matches || []);
      const lines = matches.map((m) => {
        const parent = m.parentId ? renumberIds({ id: m.parentId }).id : null;
        const box2 = m.bbox ? ` [${m.bbox.x},${m.bbox.y} ${m.bbox.w}x${m.bbox.h}]` : "";
        return `${fmtNodeRef(m.id, m.name, m.type)}${parent ? ` @${parent}` : ""}${box2}`;
      }).join("\n");
      const text = lines || "(no matches)";
      return {
        content: [await textContent(text, `${matches.length} nodes`, { saveToFile, outputPath }, "glob")]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error globbing nodes: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
server.tool(
  "grep_nodes",
  'Search the TEXT content of a subtree by regex \u2014 the Figma analog of grep. Tests each TEXT node\'s `characters` LINE BY LINE (Figma text is multi-line) and returns hits one per line as `id:"name".TEXT @parent L<n>: <line>`, where `L<n>` is the 1-based line within that text node and `<line>` is the matching line (long lines are windowed around the match; pass `onlyMatch:true` for just the matched substrings, like grep -o). This searches CONTENT, not names \u2014 to match node names use glob_nodes\' `name` glob instead. `pattern` is a JS regex (not a shell glob); `ignoreCase` adds the `i` flag. Scope with `root` (node id to search under, default current page), `depth` (cap descent), and `within` (an absolute rect \u2014 only nodes intersecting it; get coords from a prior bbox). `mode` shapes output: "content" (default, every matching line), "nodes" (one line per matching node with its hit count, like grep -l), or "count" (just totals). Ids (and `@parent`) are short counters (n0, n1, ...) \u2014 feed any straight into read/edit tools. Results cap at `maxMatches` line-hits (default 1000); a `(truncated)` note is appended if hit.',
  {
    pattern: z4.string().describe('JavaScript regular expression source (NOT a shell glob). E.g. "\\\\bCTA\\\\b", "\\\\$\\\\d+", "left$".'),
    root: z4.string().optional().describe("Node id to search under. Defaults to the current page. Accepts short ids (n0, ...)."),
    ignoreCase: z4.boolean().optional().describe("Case-insensitive match (regex `i` flag). Default false."),
    onlyMatch: z4.boolean().optional().describe("Report only the matched substring(s) per line instead of the whole line (grep -o). Default false."),
    mode: z4.enum(["content", "nodes", "count"]).optional().describe('Output shape: "content" (default; each matching line), "nodes" (one line per matching node + its hit count), or "count" (totals only).'),
    depth: z4.number().optional().describe("Max depth below root to descend (root's direct children = 1). Omit for unlimited."),
    within: z4.object({
      x: z4.number(),
      y: z4.number(),
      width: z4.number(),
      height: z4.number()
    }).optional().describe("Absolute rectangle; keep only TEXT nodes whose bounding box intersects it. Same coordinate space as glob_nodes' [x,y wxh]."),
    bbox: z4.boolean().optional().describe("Append each hit node's absolute bounding box as [x,y wxh]. Default false."),
    maxMatches: z4.number().optional().describe("Hard cap on collected line-hits before the walk stops. Default 1000."),
    ...saveParams
  },
  async ({ pattern, root, ignoreCase, onlyMatch, mode, depth, within, bbox, maxMatches, saveToFile, outputPath }) => {
    try {
      const result = await sendCommandToFigma("grep_nodes", {
        pattern,
        root,
        ignoreCase,
        onlyMatch,
        depth,
        within,
        bbox,
        maxMatches
      });
      const matches = renumberIds(result?.matches || []);
      const fmtParent = (pid) => pid ? ` @${renumberIds({ id: pid }).id}` : "";
      const fmtBox = (m) => m.bbox ? ` [${m.bbox.x},${m.bbox.y} ${m.bbox.w}x${m.bbox.h}]` : "";
      let text;
      let summary;
      const outMode = mode || "content";
      if (outMode === "count") {
        text = `${result?.count ?? matches.length} matching lines in ${result?.nodeCount ?? 0} nodes` + (result?.truncated ? " (truncated)" : "");
        summary = "count";
      } else if (outMode === "nodes") {
        const counts = /* @__PURE__ */ new Map();
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
          (m) => `${fmtNodeRef(m.id, m.name, m.type)}${fmtParent(m.parentId)}${fmtBox(m)} L${m.line}: ${m.text}`
        );
        text = (lines.join("\n") || "(no matches)") + (result?.truncated ? "\n(truncated)" : "");
        summary = `${matches.length} lines`;
      }
      return {
        content: [await textContent(text, summary, { saveToFile, outputPath }, "grep")]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error grepping nodes: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
server.tool(
  "query_nodes",
  'Find nodes by predicates on their STRUCTURE \u2014 query the node model\'s fields, not flat text. Pass `where`: an array of `{path, op, value}` predicates that are AND-combined; a node is a hit when all pass. Returned one per line as `id:"name".TYPE @parent {path=value, ...}`. `path` walks the node JSON: dot for objects, `[i]` for an array index, `[*]` for "any array element" (e.g. `fills[*].color`, `boundVariables.fills`, `fontSize`, `name`, `type`). Ops \u2014 `regex` (DEFAULT; case-insensitive with `i:true`; covers equality/contains/oneOf via the pattern; this is the right op for strings, ids, enums, even numbers as text); `gt`/`gte`/`lt`/`lte` (numeric compare \u2014 what regex can\'t do, e.g. fontSize<12, opacity<1); `color` (value is `#RRGGBB`; matches a Figma rgb 0-1 color with tolerance); `exists`/`absent` (presence of the KEY itself, no value \u2014 `absent` finds nodes MISSING a field, e.g. `boundVariables.fills` absent = a fill NOT bound to a variable/token; the core design-system audit query). Scope with `root` (default current page), `depth`, `within` (absolute rect). `bbox:true` appends each hit\'s [x,y wxh]. Ids (and `@parent`) are short counters \u2014 feed straight into other tools. Caps at `maxMatches` hits (default 1000). For raw authored copy use grep_nodes; for a plain type/name index use glob_nodes.',
  {
    where: z4.array(
      z4.object({
        path: z4.string().describe('Field path on the node. Dot for objects, [i] for an index, [*] for any array element. E.g. "fontSize", "fills[*].color", "boundVariables.fills", "name".'),
        op: z4.enum(["regex", "gt", "gte", "lt", "lte", "color", "exists", "absent"]).optional().describe('Match op. Default "regex". Use gt/gte/lt/lte for numbers, color for #RRGGBB, exists/absent for key presence (no value needed).'),
        value: z4.union([z4.string(), z4.number(), z4.boolean()]).optional().describe('Comparison value. Regex source for "regex", a number for compares, "#RRGGBB" for color. Omit for exists/absent.'),
        i: z4.boolean().optional().describe('Case-insensitive regex (only for op "regex"). Default false.')
      })
    ).min(1).describe("Predicates, AND-combined. At least one required."),
    root: z4.string().optional().describe("Node id to search under. Defaults to the current page. Accepts short ids (n0, ...)."),
    depth: z4.number().optional().describe("Max depth below root to descend (root's direct children = 1). Omit for unlimited."),
    within: z4.object({
      x: z4.number(),
      y: z4.number(),
      width: z4.number(),
      height: z4.number()
    }).optional().describe("Absolute rectangle; keep only nodes whose bounding box intersects it. Same coordinate space as glob_nodes' [x,y wxh]."),
    bbox: z4.boolean().optional().describe("Append each hit's absolute bounding box as [x,y wxh]. Default false."),
    maxMatches: z4.number().optional().describe("Hard cap on collected hits before the walk stops. Default 1000."),
    ...saveParams
  },
  async ({ where, root, depth, within, bbox, maxMatches, saveToFile, outputPath }) => {
    try {
      const result = await sendCommandToFigma("query_nodes", {
        where,
        root,
        depth,
        within,
        bbox,
        maxMatches
      });
      const matches = renumberIds(result?.matches || []);
      const lines = matches.map((m) => {
        const parent = m.parentId ? ` @${renumberIds({ id: m.parentId }).id}` : "";
        const box2 = m.bbox ? ` [${m.bbox.x},${m.bbox.y} ${m.bbox.w}x${m.bbox.h}]` : "";
        const props = (m.props || []).map((p) => `${p.path}=${p.value}`).join(", ");
        return `${fmtNodeRef(m.id, m.name, m.type)}${parent}${box2}${props ? ` {${props}}` : ""}`;
      });
      const text = (lines.join("\n") || "(no matches)") + (result?.truncated ? "\n(truncated)" : "");
      return {
        content: [await textContent(text, `${matches.length} nodes`, { saveToFile, outputPath }, "query")]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error querying nodes: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
server.tool(
  "edit_nodes",
  'Edit node properties directly in the node model \u2014 the write-side twin of query_nodes/read_node, an Edit tool for Figma JSON instead of text. Pass `edits`: an array of `{nodeId, path, old?, new}`. `path` addresses one field the same way query_nodes does \u2014 dot for objects, `[i]` for an array index (e.g. `name`, `cornerRadius`, `fills[0].color`, `fills[0].opacity`); no `[*]` (a write needs one concrete target). `new` is the value to set: colors as `#RRGGBB` are converted to Figma\'s rgb 0-1, and whole objects/arrays are allowed (e.g. set `fills[0]` to a full paint). `old` is an OPTIONAL guard, exactly like the old_string in Edit \u2014 if given and it doesn\'t match the current value (colors compared as hex, numbers tolerantly), that one edit is rejected so you never blind-overwrite a stale read. Edits run in order and are INDEPENDENT: one failing \u2014 guard mismatch, read-only/derived prop, a type Figma rejects, font not loaded \u2014 records its Figma error and the rest still apply. The result lists each edit as `\u2713 id path: old \u2192 new` or `\u2717 id path: <error>`, so a failure tells you exactly what to fix. One call can touch many nodes (each edit names its own `nodeId`) \u2014 this is also how you bulk-replace text across components: one `{nodeId, path:"characters", new:"..."}` per text node in a single call (the `characters` path loads the node\'s font for you). Large batches stream progress, so a long run won\'t time out. Common paths: `name`, `characters`, `x`/`y`, `width`/`height` (resize), `cornerRadius`, `fills[0].color` (#RRGGBB), `opacity`, `layoutMode`, `paddingTop`, `itemSpacing`, `primaryAxisAlignItems`, `layoutSizingHorizontal`. INSTANCE variant/prop swap: edit `componentProperties.<PropName>` (the names read_node shows for an instance) \u2014 `{nodeId, path:"componentProperties.Size", new:"Large"}` swaps a VARIANT, and BOOLEAN/TEXT props work the same way (pass the bare name, the #id suffix is matched for you); this routes through Figma\'s setProperties since the map itself is read-only. An INSTANCE_SWAP prop takes a component id/key as its `new` (use a FULL Figma id \u2014 short n-ids aren\'t remapped inside a value). Bind a style to a node by its id: set `fillStyleId`/`strokeStyleId`/`effectStyleId`/`gridStyleId`/`textStyleId` to a style id (from get_styles/write_styles) \u2014 applied via Figma\'s async setter, with `""` detaching the style. nodeId accepts short ids (n0, ...) or full Figma ids.',
  {
    edits: z4.array(
      z4.object({
        nodeId: z4.string().describe("Node to edit. Short ids (n0, ...) or full Figma ids."),
        path: z4.string().describe('Field path to write. Dot for objects, [i] for an array index. Same syntax as query_nodes, but no [*]. E.g. "name", "cornerRadius", "fills[0].color".'),
        old: z4.any().optional().describe("Optional guard: expected current value (Edit-style). Colors as #RRGGBB. Mismatch rejects only this edit."),
        new: z4.any().describe("Value to set. #RRGGBB \u2192 Figma rgb; numbers/strings/objects/arrays allowed.")
      })
    ).min(1).describe("Edits applied in order; each independent \u2014 one failing does not abort the rest.")
  },
  async ({ edits }) => {
    try {
      const valid = [];
      const rejected = [];
      for (const e of edits) {
        const msg = validateEditValue(e.path, e.new);
        if (msg) rejected.push(`\u2717 ${e.nodeId} ${e.path}: ${msg}`);
        else valid.push(e);
      }
      await resolveExternalAssets(valid.map((e) => e.new));
      const result = valid.length ? await sendCommandToFigma("edit_nodes", { edits: valid }) : { applied: 0, total: 0, results: [] };
      const fmt = (v) => v === null || v === void 0 ? "(absent)" : typeof v === "object" ? JSON.stringify(v) : String(v);
      const rows = [
        ...rejected,
        ...(result?.results || []).map((r) => {
          const id = renumberIds({ id: r.nodeId }).id;
          return r.ok ? `\u2713 ${id} ${r.path}: ${fmt(r.old)} \u2192 ${fmt(r.new)}` : `\u2717 ${id} ${r.path}: ${r.error}`;
        })
      ];
      const text = `applied ${result?.applied || 0}/${edits.length}` + (rows.length ? "\n" + rows.join("\n") : "");
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error editing nodes: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
server.tool(
  "reparent_nodes",
  "Move existing nodes to a new parent and/or a new z-order position \u2014 the structural move that edit_nodes can't do (it only writes value properties, never `parent`/`index`). Pass `moves`: an array of `{nodeId, parentId?, index?}`. `parentId` re-parents the node into that container (a FRAME, GROUP, SECTION, COMPONENT, or a page; short ids n0,... or full Figma ids). `index` sets the node's slot among its siblings \u2014 0 is the bottom of the z-order / first in an auto-layout, larger is later; an out-of-range index pins to the end. Give `parentId` to move into a different container, `index` alone to REORDER within the current parent, or both. Moves are INDEPENDENT: one failing \u2014 node/parent not found, a parent that can't hold children, moving a node into its own descendant (Figma rejects) \u2014 records its error and the rest still run. Note: re-parenting keeps the node's LOCAL x/y, so its absolute position shifts when the new parent is elsewhere (use edit_nodes to set x/y after); inside an auto-layout parent x/y is ignored and `index` controls the layout order. The result lists each move as `\u2713 id \"name\": parent#oldIndex \u2192 parent#newIndex` or `\u2717 id: <error>`.",
  {
    moves: z4.array(
      z4.object({
        nodeId: z4.string().describe("Node to move. Short ids (n0, ...) or full Figma ids."),
        parentId: z4.string().optional().describe("New parent container. Omit to reorder within the current parent. Short ids (n0, ...) or full Figma ids."),
        index: z4.number().int().optional().describe("Position among siblings (0 = bottom/first). Omit to append. Out-of-range pins to the end.")
      })
    ).min(1).describe("Moves applied in order; each independent \u2014 one failing does not abort the rest.")
  },
  async ({ moves }) => {
    try {
      const result = await sendCommandToFigma("reparent_nodes", { moves });
      const rows = (result?.results || []).map((r) => {
        const id = renumberIds({ id: r.nodeId }).id;
        if (!r.ok) return `\u2717 ${id}: ${r.error}`;
        const oldP = r.oldParentId ? renumberIds({ id: r.oldParentId }).id : "?";
        const newP = r.newParentId ? renumberIds({ id: r.newParentId }).id : "?";
        return `\u2713 ${id} "${r.name}": ${oldP}#${r.oldIndex} \u2192 ${newP}#${r.newIndex}`;
      });
      const text = `moved ${result?.applied || 0}/${moves.length}` + (rows.length ? "\n" + rows.join("\n") : "");
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error reparenting nodes: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
server.tool(
  "write_nodes",
  'Create new nodes from raw Figma JSON \u2014 the create-side twin of edit_nodes, a Write tool for the node tree instead of text. Pass `nodes`: an array of node specs. Each spec is `{type, ...props, children?}`: `type` is the Figma node type to create (RECTANGLE, FRAME, TEXT, ELLIPSE, LINE, STAR, POLYGON, VECTOR, COMPONENT, SECTION, SLICE, or INSTANCE). Every OTHER key is a property written onto the new node exactly as edit_nodes writes a path \u2014 `name`, `x`, `y`, `cornerRadius`, `opacity`, `fills`, `layoutMode`, `paddingTop`, `itemSpacing`, etc. Values follow edit_nodes rules: any `color` field given as `#RRGGBB` is converted to Figma\'s rgb 0-1 (so `fills:[{type:"SOLID",color:"#3366ff"}]` works), `width`/`height` route through resize(), and on a TEXT node `characters` loads the node\'s font for you. Placement: `parentId` appends the node into an existing container (short ids n0,... or full Figma ids; default is the current page) and `index` sets its position among siblings. `children` is an array of the same spec shape, created recursively inside this node \u2014 this is how you write a whole subtree (frame \u2192 its rows \u2192 their text) in one call. Specs are INDEPENDENT like edit_nodes: a spec whose factory or parent lookup fails records its Figma error and the siblings still create; within a created node, a single bad property (e.g. padding with no layoutMode, a value Figma rejects) is reported per-property and the node still survives with its other props. INSTANCE needs `componentId` (a local COMPONENT, from get_local_components) or `componentKey` (a published library component); add `componentProperties:{PropName:value}` to pick variants / set boolean\xB7text\xB7swap props on the new instance (applied via setProperties). IMAGE fills: put `{type:"IMAGE", imageUrl:"https://\u2026", scaleMode:"FILL"}` in `fills` \u2014 imageUrl also accepts a LOCAL FILE PATH (`/abs/path.png`, `~/pic.png` or `file://\u2026`) read straight from disk, no need to serve files over HTTP; the server fetches/reads the source and imports the bytes into Figma for you (no imageHash needed); same works in edit_nodes when you set a node\'s `fills`. SVG: `type:"SVG"` with `svg:"<svg\u2026>"` raw markup or `svgUrl:"https://\u2026"` (also accepts a local path, fetched/read server-side) creates a vector node from the SVG. The result is a tree of `\u2713 <id> <TYPE> "<name>"` (use that id as a parentId or in edit_nodes next) or `\u2717 <error>`, with `! key: <error>` lines for any rejected properties. Large batches stream progress so a long run won\'t time out.',
  {
    nodes: z4.array(z4.record(z4.any())).min(1).describe("Node specs, each `{type, ...props, children?}`. Created in order, independent \u2014 one failing does not abort the rest.")
  },
  async ({ nodes }) => {
    try {
      const valid = [];
      const rejected = [];
      for (const spec of nodes) {
        const parsed = writeNodeUnion.safeParse(spec);
        if (parsed.success) {
          valid.push(spec);
        } else {
          const where = spec && typeof spec === "object" ? String(spec.type || "node") : "node";
          for (const iss of parsed.error.issues) {
            rejected.push(`\u2717 ${where}: ${iss.path.join(".") || "(root)"}: ${iss.message}`);
          }
        }
      }
      await resolveExternalAssets(valid);
      const result = valid.length ? await sendCommandToFigma("write_nodes", { nodes: valid }) : { created: 0, total: 0, results: [] };
      const renumber = (id) => renumberIds({ id }).id;
      const lines = [...rejected];
      const walk = (arr, depth) => {
        for (const r of arr || []) {
          const pad = "  ".repeat(depth);
          lines.push(
            r.ok ? `${pad}\u2713 ${renumber(r.id)} ${r.type} "${r.name}"` : `${pad}\u2717 ${r.type || "node"}: ${r.error}`
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
            text: `Error writing nodes: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
server.tool(
  "get_write_schema",
  'Get the WRITE-side schema for a node type \u2014 the fields write_nodes accepts when CREATING that type (not the REST shape read_node returns). Call with `type` (e.g. "TEXT") right before building a node to see its fields, valid enum values, and ranges; call with no `type` to list the creatable types. This is the same schema write_nodes validates against, so what it shows is exactly what is accepted. Note: write_nodes also passes through any other Figma property for the type, so the list is the curated common set, not an exhaustive cap.',
  {
    type: z4.enum(NODE_TYPES).optional().describe("Node type to describe (FRAME, TEXT, ...). Omit to list all creatable types.")
  },
  async ({ type }) => {
    const text = type ? describeNodeSchema(type) : listNodeTypes();
    return { content: [{ type: "text", text }] };
  }
);
server.tool(
  "clone_node",
  "Clone an existing node in Figma",
  {
    nodeId: z4.string().describe("The ID of the node to clone"),
    x: z4.number().optional().describe("New X position for the clone"),
    y: z4.number().optional().describe("New Y position for the clone")
  },
  async ({ nodeId, x, y }) => {
    try {
      const result = await sendCommandToFigma("clone_node", { nodeId, x, y });
      const typedResult = result;
      return {
        content: [
          {
            type: "text",
            text: `Cloned node "${typedResult.name}" with new ID: ${typedResult.id}${x !== void 0 && y !== void 0 ? ` at position (${x}, ${y})` : ""}`
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
server.tool(
  "delete_nodes",
  "Delete one or more nodes from Figma. Large batches are chunked with progress updates.",
  {
    nodeIds: z4.array(z4.string()).describe("Array of node IDs to delete")
  },
  async ({ nodeIds }) => {
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
            text: `Error deleting nodes: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
server.tool(
  "export_node_as_image",
  "Export one or more nodes as images from Figma. Each node may request several scales at once, so a single call can produce many files. To actually look at how a node renders, pass inline:true with a small scale (e.g. 0.5) so the image comes back in the response and stays cheap on context.",
  {
    nodes: z4.array(
      z4.object({
        nodeId: z4.string().describe("The ID of the node to export"),
        scale: z4.union([z4.number().positive(), z4.array(z4.number().positive()).nonempty()]).optional().describe(
          "Export scale(s): a single number, or an array to emit one image per scale. Only applies to raster formats (PNG/JPG); ignored for SVG/PDF. Default 1."
        )
      })
    ).nonempty().describe("Nodes to export. Each entry exports its node at its own scale(s)."),
    format: z4.enum(["PNG", "JPG", "SVG", "PDF"]).optional().describe("Export format shared by all nodes (default PNG)."),
    inline: z4.boolean().optional().describe(
      `Return the image(s) directly in the response instead of writing files, so you can see them. Set this whenever you want to look at how something renders \u2014 and pair it with a small scale (e.g. 0.5) to keep it cheap. Honored only for raster formats (PNG/JPG) whose encoded size is under ${INLINE_MAX_BYTES / 1024}KB \u2014 anything larger (or SVG/PDF) falls back to a file to avoid blowing up the context.`
    ),
    outputDir: z4.string().optional().describe(
      "Directory to write the images into (created if missing). Defaults to the OS temp dir. Files are auto-named export-<nodeId>@<scale>x.<ext>. Ignored for images returned inline."
    )
  },
  async ({ nodes, format, inline, outputDir }) => {
    const fmt = format || "PNG";
    const ext = fmt.toLowerCase() === "jpg" ? "jpg" : fmt.toLowerCase();
    const inlineable = inline && (fmt === "PNG" || fmt === "JPG");
    const content = [];
    const written = [];
    const errors = [];
    for (const { nodeId, scale } of nodes) {
      try {
        const result = await sendCommandToFigma("export_node_as_image", {
          nodeId,
          format: fmt,
          scale: scale ?? 1
        });
        const typedResult = result;
        for (const img of typedResult.images) {
          const buffer = Buffer.from(img.imageData, "base64");
          if (inlineable && buffer.length <= INLINE_MAX_BYTES) {
            content.push({ type: "image", data: img.imageData, mimeType: typedResult.mimeType });
            written.push(`${nodeId} @${img.scale}x \u2192 inline (${buffer.length} bytes)`);
            continue;
          }
          const safeId = nodeId.replace(/[^a-zA-Z0-9_-]/g, "-");
          const baseName = `export-${safeId}@${img.scale}x`;
          const target = outputDir ? join(outputDir, `${baseName}.${ext}`) : void 0;
          const { path, bytes } = await writeOutputFile(baseName, ext, buffer, target);
          const note = inline && !inlineable ? " (file: inline unsupported for this format)" : inline ? " (file: too large to inline)" : "";
          written.push(`${nodeId} @${img.scale}x \u2192 ${path} (${bytes} bytes)${note}`);
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
      ...errors.length ? ["", `Failed (${errors.length}):`, ...errors] : []
    ];
    content.unshift({ type: "text", text: lines.join("\n") });
    return { content };
  }
);
server.tool(
  "get_styles",
  "Get all styles from the current Figma document",
  { ...saveParams },
  async ({ saveToFile, outputPath }) => {
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
            text: `Error getting styles: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
var styleSpecShape = {
  id: z4.string().optional().describe("Existing style id (edit_styles: match by id; also accepted on write to fail loudly if reused)"),
  type: z4.enum(["PAINT", "TEXT", "EFFECT", "GRID"]).optional().describe("Style kind \u2014 required for write_styles and for edit_styles when matching by name"),
  name: z4.string().optional().describe("Style name; '/' creates folders (e.g. 'brand/primary'). Required on write."),
  description: z4.string().optional(),
  // PAINT
  paints: z4.array(z4.any()).optional().describe("PAINT: array of Figma Paint objects (SOLID/GRADIENT/IMAGE). Hex strings in a `color` field are accepted."),
  paint: z4.any().optional().describe("PAINT: single Paint object shorthand for one-paint styles"),
  color: z4.string().optional().describe("PAINT: hex shorthand ('#RRGGBB'/'#RRGGBBAA') for a single solid fill"),
  opacity: z4.number().optional().describe("PAINT: opacity 0-1 for the `color` shorthand"),
  // TEXT
  fontName: z4.object({ family: z4.string(), style: z4.string() }).optional().describe("TEXT: {family, style} \u2014 loaded before applying"),
  fontSize: z4.number().optional().describe("TEXT: font size in px"),
  lineHeight: z4.any().optional().describe("TEXT: number (PIXELS shorthand) or {value, unit: PIXELS|PERCENT} or {unit: AUTO}"),
  letterSpacing: z4.any().optional().describe("TEXT: number (PIXELS shorthand) or {value, unit: PIXELS|PERCENT}"),
  paragraphSpacing: z4.number().optional().describe("TEXT: spacing between paragraphs in px"),
  paragraphIndent: z4.number().optional().describe("TEXT: first-line indent in px"),
  textCase: z4.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional(),
  textDecoration: z4.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
  // EFFECT
  effects: z4.array(z4.any()).optional().describe("EFFECT: array of Figma Effect objects (DROP_SHADOW/INNER_SHADOW/LAYER_BLUR/BACKGROUND_BLUR). Hex in a `color` field is accepted."),
  // GRID
  layoutGrids: z4.array(z4.any()).optional().describe("GRID: array of Figma LayoutGrid objects (GRID/COLUMNS/ROWS).")
};
function styleResultText(verb, result) {
  const lines = (result.styles || []).map(
    (s) => s.ok ? `\u2713 ${s.removed ? "removed" : verb} ${s.type} "${s.name}" (${s.id})` : `\u2717 ${s.type || ""} ${s.name || s.id || ""}: ${s.error}`
  );
  return `${lines.join("\n")}

${JSON.stringify(result, null, 2)}`;
}
server.tool(
  "write_styles",
  "Create local Figma styles (paint/color, text, effect, grid). Each entry needs `type` (PAINT|TEXT|EFFECT|GRID) and `name` ('/' makes folders). PAINT: pass `paints` (full Paint array), `paint`, or the `color` hex shorthand. TEXT: `fontName` {family,style} (loaded automatically), `fontSize`, `lineHeight`, `letterSpacing`, `paragraphSpacing`, `paragraphIndent`, `textCase`, `textDecoration`. EFFECT: `effects` (Effect array \u2014 shadows/blurs). GRID: `layoutGrids`. Hex colors are accepted wherever a paint/effect `color` is expected. Use edit_styles to modify an existing style.",
  {
    styles: z4.array(z4.object(styleSpecShape)).min(1).describe("Styles to create")
  },
  async ({ styles }) => {
    try {
      const result = await sendCommandToFigma("write_styles", { styles });
      return {
        content: [
          { type: "text", text: `Styles created: ${result.created}/${result.total}.
${styleResultText("created", result)}` }
        ]
      };
    } catch (error) {
      return {
        content: [
          { type: "text", text: `Error creating styles: ${error instanceof Error ? error.message : String(error)}` }
        ]
      };
    }
  }
);
server.tool(
  "edit_styles",
  "Update or delete existing local Figma styles. Match each entry by `id` (from get_styles), or by `name` + `type`. Only the fields you pass are changed (partial update) \u2014 same field set as write_styles (name, description, paints/color, font props, effects, layoutGrids). Set `remove: true` to delete the style. To create a new style use write_styles.",
  {
    styles: z4.array(z4.object({ ...styleSpecShape, remove: z4.boolean().optional().describe("Delete this style instead of updating it") })).min(1).describe("Styles to update or remove")
  },
  async ({ styles }) => {
    try {
      const result = await sendCommandToFigma("edit_styles", { styles });
      return {
        content: [
          { type: "text", text: `Styles: ${result.updated} updated, ${result.removed} removed of ${result.total}.
${styleResultText("updated", result)}` }
        ]
      };
    } catch (error) {
      return {
        content: [
          { type: "text", text: `Error editing styles: ${error instanceof Error ? error.message : String(error)}` }
        ]
      };
    }
  }
);
server.tool(
  "get_local_components",
  "Get all local components from the Figma document",
  { ...saveParams },
  async ({ saveToFile, outputPath }) => {
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
            text: `Error getting local components: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
server.tool(
  "get_annotations",
  "Get all annotations in the current document or specific node",
  {
    nodeId: z4.string().describe("node ID to get annotations for specific node"),
    includeCategories: z4.boolean().optional().default(true).describe("Whether to include category information"),
    ...saveParams
  },
  async ({ nodeId, includeCategories, saveToFile, outputPath }) => {
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
server.tool(
  "set_annotations",
  "Create or update one or more native Figma annotations. Pass `annotations`: an array of `{nodeId, labelMarkdown, categoryId?, annotationId?, properties?}`. Each entry annotates its own `nodeId` with markdown text; supply `annotationId` to update an existing annotation instead of creating one, and `categoryId` to file it under an annotation category (from get_annotations). Entries are applied independently \u2014 one failing records its error and the rest still apply. Large batches are chunked with progress updates so a long run won't time out. The result lists each entry as `\u2713 <id>` or `\u2717 <id>: <error>`.",
  {
    annotations: z4.array(
      z4.object({
        nodeId: z4.string().describe("The ID of the node to annotate"),
        labelMarkdown: z4.string().describe("The annotation text in markdown format"),
        categoryId: z4.string().optional().describe("The ID of the annotation category"),
        annotationId: z4.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
        properties: z4.array(z4.object({
          type: z4.string()
        })).optional().describe("Additional properties for the annotation")
      })
    ).min(1).describe("Annotations to apply; each independent \u2014 one failing does not abort the rest.")
  },
  async ({ annotations }) => {
    try {
      const result = await sendCommandToFigma("set_annotations", { annotations });
      const rows = (result?.results || []).map((r) => {
        const id = renumberIds({ id: r.nodeId }).id;
        return r.success ? `\u2713 ${id}` : `\u2717 ${id}: ${r.error || "Unknown error"}`;
      });
      const text = `applied ${result?.annotationsApplied || 0}/${result?.totalAnnotations || annotations.length}` + (rows.length ? "\n" + rows.join("\n") : "");
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting annotations: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
server.tool(
  "get_instance_overrides",
  "Get all override properties from a selected component instance. These overrides can be applied to other instances, which will swap them to match the source component.",
  {
    nodeId: z4.string().optional().describe("Optional ID of the component instance to get overrides from. If not provided, currently selected instance will be used.")
  },
  async ({ nodeId }) => {
    try {
      const result = await sendCommandToFigma("get_instance_overrides", {
        instanceNodeId: nodeId || null
      });
      const typedResult = result;
      return {
        content: [
          {
            type: "text",
            text: typedResult.success ? `Successfully got instance overrides: ${typedResult.message}` : `Failed to get instance overrides: ${typedResult.message}`
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
server.tool(
  "set_instance_overrides",
  "Apply previously copied overrides to selected component instances. Target instances will be swapped to the source component and all copied override properties will be applied.",
  {
    sourceInstanceId: z4.string().describe("ID of the source component instance"),
    targetNodeIds: z4.array(z4.string()).describe("Array of target instance IDs. Currently selected instances will be used.")
  },
  async ({ sourceInstanceId, targetNodeIds }) => {
    try {
      const result = await sendCommandToFigma("set_instance_overrides", {
        sourceInstanceId,
        targetNodeIds: targetNodeIds || []
      });
      const typedResult = result;
      if (typedResult.success) {
        const successCount = typedResult.results?.filter((r) => r.success).length || 0;
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
    - Don't have account (text)`
          }
        }
      ],
      description: "Best practices for working with Figma designs"
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

## The ladder (cheap \u2192 detailed)
1. Orient \u2014 glob_nodes({ root, type }) for a flat \`id:"name".TYPE @parent\` index of a page or subtree (the \`ls -R\`). Start here when you don't yet know the ids. Filter by \`type\` to cut noise (e.g. type:["SECTION","FRAME"] for the screen map).
2. Locate \u2014 grep_nodes (regex over TEXT content, the \`grep\`) to find nodes by what they say, or query_nodes (predicates over node fields \u2014 fontSize<12, fills bound to a variable, etc.) to find by structure. All return short ids.
3. Inspect \u2014 read_node({ nodeIds }) for the compact subtree of just the nodes you'll act on; raise \`depth\` or re-request a stub id to zoom; raw:true for every prop of one node.
4. Modify \u2014 edit_nodes({ edits:[{nodeId, path, old?, new}] }) to write properties (text via the "characters" path). Pass \`old\` as a guard so you never overwrite a stale read. To MOVE a node \u2014 change its parent or its z-order/layout position \u2014 use reparent_nodes({ moves:[{nodeId, parentId?, index?}] }); edit_nodes can't write structure.

## Notes
- No selection and no ids? read_node() with no args reads the current selection; if it's empty, ask the user to select, or glob_nodes the page.
- Ids are short counters (n0, n1, ...) and flow between all tools \u2014 a glob/grep hit feeds straight into read_node/edit_nodes.
- Width of search is cheap (ids only); depth of detail is not (full subtree). Prefer a wide glob then a narrow read over reading wide.
`
          }
        }
      ],
      description: "Best practices for reading Figma designs"
    };
  }
);
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
edit_nodes does the bulk replace \u2014 one edit per text node, the "characters" path loads the node's font for you. One call can span many nodes; large batches stream progress.
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
Adapt text to its container: if it overflows, shorten or break lines at sensible points, and keep related content (labels with their fields, headers with their data) consistent across chunks.`
          }
        }
      ],
      description: "Systematic approach for replacing text in Figma designs"
    };
  }
);
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
          }
        }
      ],
      description: "Strategy for converting manual annotations to Figma's native annotations"
    };
  }
);
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
- Preserve component relationships by using instance overrides rather than direct text manipulation`
          }
        }
      ],
      description: "Strategy for transferring overrides between component instances in Figma"
    };
  }
);
server.tool(
  "get_reactions",
  "Get Figma Prototyping Reactions from multiple nodes. CRITICAL: The output MUST be processed using the 'reaction_to_connector_strategy' prompt IMMEDIATELY to generate parameters for connector lines via the 'create_connections' tool.",
  {
    nodeIds: z4.array(z4.string()).describe("Array of node IDs to get reactions from"),
    ...saveParams
  },
  async ({ nodeIds, saveToFile, outputPath }) => {
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
          prompt: "reaction_to_connector_strategy"
        }
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting reactions: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
var transitionSchema = z4.object({
  type: z4.enum([
    "DISSOLVE",
    "SMART_ANIMATE",
    "SCROLL_ANIMATE",
    "MOVE_IN",
    "MOVE_OUT",
    "PUSH",
    "SLIDE_IN",
    "SLIDE_OUT"
  ]).describe("Animation style for the navigation"),
  easing: z4.object({ type: z4.string() }).passthrough().optional(),
  duration: z4.number().optional().describe("Duration in seconds"),
  direction: z4.enum(["LEFT", "RIGHT", "TOP", "BOTTOM"]).optional(),
  matchLayers: z4.boolean().optional().describe("SMART_ANIMATE: match layers by name")
}).passthrough();
var reactionActionSchema = z4.object({
  type: z4.enum([
    "BACK",
    "CLOSE",
    "URL",
    "NODE",
    "SET_VARIABLE",
    "SET_VARIABLE_MODE",
    "CONDITIONAL",
    "UPDATE_MEDIA_RUNTIME"
  ]).describe("Action kind. NODE = navigate/overlay/swap to another frame."),
  url: z4.string().optional().describe("URL action: link to open"),
  destinationId: z4.string().nullable().optional().describe("NODE action: target node id (the frame to navigate/swap/overlay to)"),
  navigation: z4.enum(["NAVIGATE", "SWAP", "OVERLAY", "SCROLL_TO", "CHANGE_TO"]).optional().describe("NODE action: how the destination is presented"),
  transition: transitionSchema.nullable().optional(),
  preserveScrollPosition: z4.boolean().optional(),
  overlayRelativePosition: z4.object({ x: z4.number(), y: z4.number() }).optional(),
  resetVideoPosition: z4.boolean().optional(),
  resetScrollPosition: z4.boolean().optional(),
  resetInteractionState: z4.boolean().optional()
}).passthrough();
var reactionTriggerSchema = z4.object({
  type: z4.enum([
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
    "ON_MEDIA_END"
  ]).describe("What initiates the reaction"),
  timeout: z4.number().optional().describe("AFTER_TIMEOUT: delay in seconds"),
  delay: z4.number().optional().describe("MOUSE_* triggers: delay in seconds"),
  device: z4.string().optional().describe("ON_KEY_DOWN: input device (e.g. KEYBOARD)"),
  keyCodes: z4.array(z4.number()).optional().describe("ON_KEY_DOWN: key codes"),
  mediaHitTime: z4.number().optional().describe("ON_MEDIA_HIT: time in seconds")
}).passthrough();
var reactionSchema = z4.object({
  trigger: reactionTriggerSchema.nullable().describe("The interaction that fires the actions"),
  actions: z4.array(reactionActionSchema).optional().describe("Actions to run when triggered"),
  action: reactionActionSchema.optional().describe("Deprecated single-action form; prefer `actions`")
}).passthrough();
server.tool(
  "set_reactions",
  "Install prototyping reactions (interactions/transitions) onto Figma nodes via setReactionsAsync \u2014 the write-side twin of get_reactions. Use this to create prototype flows: e.g. an ON_CLICK trigger with a NODE action navigating to another frame with a SMART_ANIMATE transition. NOTE: this REPLACES the full reaction list on each node, so pass the complete desired set (use get_reactions first to preserve existing ones). Most scene nodes support reactions; pages/documents do not.",
  {
    reactions: z4.array(
      z4.object({
        nodeId: z4.string().describe("ID of the node to attach reactions to"),
        reactions: z4.array(reactionSchema).describe("Complete list of reactions to set on this node (replaces existing)")
      })
    ).describe("Per-node reaction sets to install")
  },
  async ({ reactions }) => {
    try {
      const result = await sendCommandToFigma("set_reactions", { reactions });
      const typed = result;
      const failures = typed.results.filter((r) => !r.success);
      const summary = `Set reactions on ${typed.succeeded}/${typed.total} nodes${typed.failed ? `, ${typed.failed} failed` : ""}.${failures.length ? ` Failures: ${failures.map((f) => `${f.nodeId ?? "?"}: ${f.error}`).join("; ")}` : ""}`;
      return {
        content: [{ type: "text", text: summary }]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting reactions: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
server.tool(
  "set_default_connector",
  "Set a copied connector node as the default connector",
  {
    connectorId: z4.string().optional().describe("The ID of the connector node to set as default")
  },
  async ({ connectorId }) => {
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
server.tool(
  "create_connections",
  "Create connections between nodes using the default connector style",
  {
    connections: z4.array(z4.object({
      startNodeId: z4.string().describe("ID of the starting node"),
      endNodeId: z4.string().describe("ID of the ending node"),
      text: z4.string().optional().describe("Optional text to display on the connector")
    })).describe("Array of node connections to create")
  },
  async ({ connections }) => {
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
server.tool(
  "set_focus",
  "Set focus on a specific node in Figma by selecting it and scrolling viewport to it",
  {
    nodeId: z4.string().describe("The ID of the node to focus on")
  },
  async ({ nodeId }) => {
    try {
      const result = await sendCommandToFigma("set_focus", { nodeId });
      const typedResult = result;
      return {
        content: [
          {
            type: "text",
            text: `Focused on node "${typedResult.name}" (ID: ${typedResult.id})`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting focus: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
server.tool(
  "set_selections",
  "Set selection to multiple nodes in Figma and scroll viewport to show them",
  {
    nodeIds: z4.array(z4.string()).describe("Array of node IDs to select")
  },
  async ({ nodeIds }) => {
    try {
      const result = await sendCommandToFigma("set_selections", { nodeIds });
      const typedResult = result;
      return {
        content: [
          {
            type: "text",
            text: `Selected ${typedResult.count} nodes: ${typedResult.selectedNodes.map((node) => `"${node.name}" (${node.id})`).join(", ")}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting selections: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
server.tool(
  "combine_as_variants",
  "Combine 2+ standalone COMPONENT nodes into a single COMPONENT_SET (variants). Figma derives variant properties from each component's name in \"Prop=Value, Prop2=Value2\" form, so pass `rename` to set those names atomically before merging (e.g. State=Default, State=Hover). All components must be on the same page. By default the variants are packed into a tidy grid (the raw Figma API keeps each component's original x/y, leaving gaps) \u2014 when there are exactly 2 variant props the grid is the variant matrix (prop1 down rows, prop2 across columns), otherwise a near-square wrap; pass `arrange:false` to keep the source positions, or `gap` to set the spacing (default 16).",
  {
    nodeIds: z4.array(z4.string()).min(2).describe("IDs of the COMPONENT nodes to combine (at least 2, same page)"),
    name: z4.string().optional().describe("Name for the resulting component set"),
    parentId: z4.string().optional().describe("Parent node to place the set in (defaults to current page)"),
    rename: z4.array(z4.object({ nodeId: z4.string(), name: z4.string() })).optional().describe('Rename components before combining, to set variant props via "Prop=Value" naming'),
    arrange: z4.boolean().optional().describe("Pack variants into a grid after combining (default true). false keeps source x/y."),
    gap: z4.number().min(0).optional().describe("Spacing between variants when arranging (px, default 16).")
  },
  async ({ nodeIds, name, parentId: parentId2, rename, arrange, gap }) => {
    try {
      const result = await sendCommandToFigma("combine_as_variants", { nodeIds, name, parentId: parentId2, rename, arrange, gap });
      const props = result.variantProperties ? Object.entries(result.variantProperties).map(([k, v]) => `${k}: [${(v?.values || []).join(", ")}]`).join("; ") : "none";
      const warn = result.variantWarning ? `
\u26A0\uFE0F ${result.variantWarning}` : "";
      const grid = result.arranged ? ", packed into a grid" : "";
      return {
        content: [
          {
            type: "text",
            text: `Created component set "${result.name}" (ID: ${result.id}) with ${result.childCount} variants${grid}. Properties: ${props}${warn}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error combining as variants: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
server.tool(
  "boolean_operation",
  "Combine 2+ vector/shape nodes with a boolean operation into one non-destructive BOOLEAN_OPERATION node (children stay editable). `union` merges, `subtract` cuts the 2nd+ nodes out of the 1st, `intersect` keeps only overlap, `exclude` keeps the non-overlapping parts. Order matters for subtract/exclude \u2014 the first nodeId is the base. Operands should be vectors, shapes (rect/ellipse/polygon/star), or other boolean ops.",
  {
    operation: z4.enum(["union", "subtract", "intersect", "exclude"]).describe("Which boolean op to apply"),
    nodeIds: z4.array(z4.string()).min(2).describe("IDs of the nodes to combine (at least 2). For subtract/exclude the first is the base."),
    name: z4.string().optional().describe("Name for the resulting boolean operation node"),
    parentId: z4.string().optional().describe("Parent node to place the result in (defaults to current page)")
  },
  async ({ operation, nodeIds, name, parentId: parentId2 }) => {
    try {
      const result = await sendCommandToFigma("boolean_operation", { operation, nodeIds, name, parentId: parentId2 });
      return {
        content: [
          {
            type: "text",
            text: `Created ${operation} "${result.name}" (ID: ${result.id}) from ${result.childCount} nodes.`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error performing boolean operation: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
server.tool(
  "convert_nodes",
  "Convert existing nodes into a different kind of node, in place \u2014 four operations that write_nodes/edit_nodes can't express (this is NOT rotate/scale; for those set `rotation` or `width`/`height` via edit_nodes). `flatten`: merge ALL nodeIds into one VectorNode (overlaps/strokes baked into a single path). `outline_stroke`: per node, create a new vector of the stroke rendered as fills (the original node is left untouched); skipped when a node has no stroke. `to_component`: per node, convert a FRAME/GROUP/etc into a COMPONENT preserving its children (unlike a write_nodes COMPONENT, which starts empty). `detach`: per node, detach an INSTANCE into a standalone FRAME. Returns the new node id(s) \u2014 ids change for flatten/to_component/detach.",
  {
    operation: z4.enum(["flatten", "outline_stroke", "to_component", "detach"]).describe("Which conversion to apply"),
    nodeIds: z4.array(z4.string()).min(1).describe("Nodes to convert. `flatten` merges all of them into one; the other ops map 1:1."),
    name: z4.string().optional().describe("Name for the resulting node. Applied to the flatten result, or to a single-node result; ignored when an op produces multiple nodes."),
    parentId: z4.string().optional().describe("flatten only: parent to place the merged vector in (defaults to the first node's parent).")
  },
  async ({ operation, nodeIds, name, parentId: parentId2 }) => {
    try {
      const result = await sendCommandToFigma("convert_nodes", { operation, nodeIds, name, parentId: parentId2 });
      const lines = (result.results || []).map(
        (r) => r.newId ? `${r.oldId || (r.oldIds || []).join("+")} \u2192 ${r.newId}${r.name ? ` "${r.name}"` : ""}${r.type ? ` (${r.type})` : ""}` : `${r.oldId} \u2192 skipped: ${r.skipped}`
      );
      return {
        content: [
          {
            type: "text",
            text: `convert_nodes (${operation}):
${lines.join("\n")}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error transforming nodes: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
server.tool(
  "list_fonts",
  "List font families available in Figma so you don't guess names that loadFontAsync would reject. Returns families with their styles. Pass `query` to filter by a case-insensitive substring of the family name \u2014 strongly recommended, the unfiltered list has thousands of families. `limit` caps the number of families returned (default 200).",
  {
    query: z4.string().optional().describe("Case-insensitive substring to filter family names (e.g. 'inter', 'roboto')"),
    limit: z4.number().optional().describe("Max families to return (default 200)"),
    ...saveParams
  },
  async ({ query, limit, saveToFile, outputPath }) => {
    try {
      const result = await sendCommandToFigma("list_fonts", { query, limit });
      return {
        content: [await jsonContent(result, { saveToFile, outputPath }, "fonts")]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error listing fonts: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
server.tool(
  "style_text_range",
  "Apply per-character-range styling to a TEXT node \u2014 the mixed-style edits edit_nodes can't express, since a node-level setter writes the whole text. Each entry is a [start, end) character span (start inclusive, end exclusive) with one or more style props; only the props you pass on that span are changed. Fonts for the affected ranges are loaded automatically. Read the node's current runs first via read_node_raw \u2192 `styledTextSegments`. `hyperlink`: pass a URL string (or {type:'URL'|'NODE', value}) to set it, or null to clear it. Colors in `fills` accept #RRGGBB.",
  {
    nodeId: z4.string().describe("The TEXT node to style"),
    ranges: z4.array(
      z4.object({
        start: z4.number().describe("Start character index (inclusive)"),
        end: z4.number().describe("End character index (exclusive)"),
        fontName: z4.object({ family: z4.string(), style: z4.string() }).optional().describe("Font for this range (loaded automatically). Use list_fonts to get valid family/style."),
        fontSize: z4.number().optional(),
        fills: z4.array(z4.any()).optional().describe("Paint array; a paint's color accepts #RRGGBB"),
        textCase: z4.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"]).optional(),
        textDecoration: z4.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
        letterSpacing: z4.any().optional().describe("Number (px shorthand) or {value, unit}"),
        lineHeight: z4.any().optional().describe("Number (px shorthand) or {value, unit:'PIXELS'|'PERCENT'} or {unit:'AUTO'}"),
        hyperlink: z4.any().optional().describe("URL string, {type,value}, or null to clear"),
        listOptions: z4.object({ type: z4.enum(["ORDERED", "UNORDERED", "NONE"]) }).optional(),
        indentation: z4.number().optional(),
        textStyleId: z4.string().optional().describe("Apply a shared text style by id"),
        fillStyleId: z4.string().optional().describe("Apply a shared paint/fill style by id")
      })
    ).min(1).describe("Character ranges to style")
  },
  async ({ nodeId, ranges }) => {
    try {
      const result = await sendCommandToFigma("style_text_range", { nodeId, ranges });
      const lines = (result.ranges || []).map(
        (r) => `[${r.start},${r.end}) \u2192 ${(r.applied || []).join(", ") || "no-op"}`
      );
      return {
        content: [
          {
            type: "text",
            text: `Styled ${result.ranges.length} range(s) on ${result.nodeId} (text length ${result.length}):
${lines.join("\n")}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error styling text range: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
server.tool(
  "edit_groups",
  "Group or ungroup nodes. `group` wraps 2+ nodes in a new GROUP (placed in the first node's current parent unless `parentId` is given). `ungroup` dissolves each GROUP/FRAME in `nodeIds` back into its parent and returns the freed children with their new IDs (ungroup reparents, so IDs change). A GROUP is a lightweight container with no layout/clipping of its own \u2014 use a FRAME (via write_nodes) when you need auto-layout, padding, or clipping.",
  {
    operation: z4.enum(["group", "ungroup"]).describe("`group` to wrap nodes, `ungroup` to dissolve containers"),
    nodeIds: z4.array(z4.string()).min(1).describe("For `group`: the 2+ nodes to wrap. For `ungroup`: the GROUP/FRAME nodes to dissolve."),
    name: z4.string().optional().describe("Name for the new group (group only)"),
    parentId: z4.string().optional().describe("Parent to place the group in; defaults to the first node's parent (group only)")
  },
  async ({ operation, nodeIds, name, parentId: parentId2 }) => {
    try {
      const result = await sendCommandToFigma("edit_groups", { operation, nodeIds, name, parentId: parentId2 });
      const text = operation === "group" ? `Grouped ${result.childCount} nodes into "${result.name}" (ID: ${result.id}).` : `Ungrouped ${nodeIds.length} container(s) into ${result.childCount} nodes: ${result.children.map((c) => `${c.name} (${c.id})`).join(", ")}.`;
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error editing groups: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
server.tool(
  "write_table",
  "Create a FigJam TABLE (FigJam files only) of `rows`\xD7`columns` cells, optionally filling cell text. Cells are 0-indexed via {row, column, text}; omitted cells stay empty. A table is a FigJam-native 2D grid, so write_nodes can't build it. Use edit_table afterwards to add/remove/resize rows & columns or change cell text.",
  {
    rows: z4.number().int().min(1).describe("number of rows"),
    columns: z4.number().int().min(1).describe("number of columns"),
    cells: z4.array(
      z4.object({
        row: z4.number().int().min(0),
        column: z4.number().int().min(0),
        text: z4.string()
      })
    ).optional().describe("cell contents, 0-indexed (row, column); omitted cells stay empty"),
    parentId: z4.string().optional().describe("container to place the table in; defaults to current page"),
    index: z4.number().int().min(0).optional().describe("position among siblings"),
    x: z4.number().optional().describe("x position (ignored inside an auto-layout parent)"),
    y: z4.number().optional().describe("y position (ignored inside an auto-layout parent)"),
    name: z4.string().optional().describe("name for the table node")
  },
  async ({ rows, columns, cells, parentId: parentId2, index: index2, x, y, name }) => {
    try {
      const result = await sendCommandToFigma("write_table", { rows, columns, cells, parentId: parentId2, index: index2, x, y, name });
      const warn = result.cellErrors?.length ? ` (${result.cellErrors.length} cell error(s): ${result.cellErrors.map((e) => `(${e.row},${e.column}) ${e.error}`).join("; ")})` : "";
      return {
        content: [
          { type: "text", text: `Created TABLE "${result.name}" (ID: ${result.id}) \u2014 ${result.numRows}\xD7${result.numColumns}.${warn}` }
        ]
      };
    } catch (error) {
      return {
        content: [
          { type: "text", text: `Error creating table: ${error instanceof Error ? error.message : String(error)}` }
        ]
      };
    }
  }
);
server.tool(
  "edit_table",
  "Mutate an existing FigJam TABLE: append rows/columns, remove rows/columns by index, resize them, and/or set cell text. Operations apply in a fixed order \u2014 addColumns, addRows, removeColumns, removeRows, resizeColumns, resizeRows, then cells \u2014 so cell coordinates and resize indices refer to the resulting grid. Removes run high-index-first, so a list like [1,3] is safe.",
  {
    tableId: z4.string().describe("ID of the TABLE node to edit"),
    addRows: z4.number().int().min(0).optional().describe("append this many rows at the bottom"),
    addColumns: z4.number().int().min(0).optional().describe("append this many columns at the right"),
    removeRows: z4.array(z4.number().int().min(0)).optional().describe("row indices to remove (0-indexed)"),
    removeColumns: z4.array(z4.number().int().min(0)).optional().describe("column indices to remove (0-indexed)"),
    resizeRows: z4.array(z4.object({ index: z4.number().int().min(0), height: z4.number().positive() })).optional().describe("set row heights by index"),
    resizeColumns: z4.array(z4.object({ index: z4.number().int().min(0), width: z4.number().positive() })).optional().describe("set column widths by index"),
    cells: z4.array(
      z4.object({
        row: z4.number().int().min(0),
        column: z4.number().int().min(0),
        text: z4.string()
      })
    ).optional().describe("cell contents to set, 0-indexed against the resulting grid")
  },
  async (args2) => {
    try {
      const result = await sendCommandToFigma("edit_table", args2);
      const warn = result.errors?.length ? ` (${result.errors.length} error(s): ${result.errors.map((e) => `${e.op}: ${e.error}`).join("; ")})` : "";
      return {
        content: [
          { type: "text", text: `Edited TABLE "${result.name}" (ID: ${result.id}) \u2014 now ${result.numRows}\xD7${result.numColumns}.${warn}` }
        ]
      };
    } catch (error) {
      return {
        content: [
          { type: "text", text: `Error editing table: ${error instanceof Error ? error.message : String(error)}` }
        ]
      };
    }
  }
);
server.tool(
  "get_variables",
  "Read local Figma variables (design tokens): every variable collection, its modes, and each variable's per-mode value. Colors come back as hex, and aliases (variables referencing other variables) resolve to {alias: <target name>, aliasId}. Use this to discover token names/ids before binding or updating them. Pass `collection` to filter to one collection by name or id.",
  {
    collection: z4.string().optional().describe("Limit to a single collection by name or id")
  },
  async ({ collection }) => {
    try {
      const result = await sendCommandToFigma("get_variables", { collection });
      const cols = result.collections || [];
      const summary = cols.length ? cols.map(
        (c) => `\u2022 ${c.name} (${c.id}) \u2014 modes: ${c.modes.map((m) => m.name).join(", ")}; ${c.variableCount} variables`
      ).join("\n") : "No local variable collections found.";
      return {
        content: [
          { type: "text", text: `${summary}

${JSON.stringify(result, null, 2)}` }
        ]
      };
    } catch (error) {
      return {
        content: [
          { type: "text", text: `Error reading variables: ${error instanceof Error ? error.message : String(error)}` }
        ]
      };
    }
  }
);
server.tool(
  "set_variables",
  'Create or update Figma variables (design tokens), collections, and modes in one call (upsert). Match an existing collection/variable by `id`, or by `name` to update it, or omit both to create. New variables require `type` (COLOR|FLOAT|STRING|BOOLEAN). Set per-mode values via `valuesByMode` keyed by mode name; COLOR accepts hex ("#RRGGBB"/"#RRGGBBAA") or {r,g,b,a} 0-1. A value of {alias: "<other variable name>"} (or {alias id}) makes the variable reference another \u2014 aliases resolve after all variables in the batch are created, so forward references within the call work. NOTE: more than one mode per collection requires a paid Figma plan.',
  {
    collections: z4.array(
      z4.object({
        id: z4.string().optional().describe("Existing collection id to update"),
        name: z4.string().optional().describe("Collection name (used to match or create)"),
        modes: z4.array(z4.string()).optional().describe("Desired mode names; the first becomes the default mode of a new collection"),
        variables: z4.array(
          z4.object({
            id: z4.string().optional().describe("Existing variable id to update"),
            name: z4.string().describe("Variable name; '/' creates token groups (e.g. 'color/bg/primary')"),
            type: z4.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]).optional().describe("Resolved type \u2014 required when creating a new variable"),
            scopes: z4.array(z4.string()).optional().describe("Variable scopes (e.g. ALL_SCOPES, TEXT_CONTENT, CORNER_RADIUS)"),
            description: z4.string().optional(),
            valuesByMode: z4.record(z4.string(), z4.any()).optional().describe("Map of mode name \u2192 value (literal hex/number/string/boolean, or {alias: <name>})")
          })
        ).optional()
      })
    ).min(1).describe("Collections to upsert, each with its modes and variables")
  },
  async ({ collections }) => {
    try {
      const result = await sendCommandToFigma("set_variables", { collections });
      return {
        content: [
          {
            type: "text",
            text: `Variables updated: ${result.variablesCreated} created, ${result.variablesUpdated} updated across ${result.collections.length} collection(s).

${JSON.stringify(result, null, 2)}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          { type: "text", text: `Error setting variables: ${error instanceof Error ? error.message : String(error)}` }
        ]
      };
    }
  }
);
server.tool(
  "bind_variables",
  "Bind a variable (design token) to a node property, or unbind it. Identify the variable by `variableId` (from get_variables) or `variableName`. `field` accepts node properties like width, height, cornerRadius (or per-corner topLeftRadius\u2026), opacity, visible, characters, fontSize, lineHeight, letterSpacing, fontWeight, paragraphSpacing, itemSpacing (alias 'gap'), paddingLeft/Right/Top/Bottom \u2014 plus 'fills'/'strokes' to bind the paint color (use `paintIndex`, default 0). Set `unbind: true` to clear a binding.",
  {
    bindings: z4.array(
      z4.object({
        nodeId: z4.string().describe("Target node id"),
        field: z4.string().describe("Property to bind (e.g. 'fills', 'cornerRadius', 'fontSize', 'itemSpacing')"),
        variableId: z4.string().optional().describe("Variable id to bind"),
        variableName: z4.string().optional().describe("Variable name to bind (used if variableId omitted)"),
        paintIndex: z4.number().optional().describe("For 'fills'/'strokes': which paint to bind (default 0)"),
        unbind: z4.boolean().optional().describe("Clear the binding on this field instead of setting it")
      })
    ).min(1).describe("Bindings to apply")
  },
  async ({ bindings }) => {
    try {
      const result = await sendCommandToFigma("bind_variables", { bindings });
      const lines = (result.results || []).map(
        (r) => r.error ? `\u2717 ${r.nodeId}.${r.field}: ${r.error}` : `${r.bound ? "\u2713 bound" : "\u2713 unbound"} ${r.nodeId}.${r.field}${r.variableName ? ` \u2192 ${r.variableName}` : ""}`
      );
      return {
        content: [
          { type: "text", text: `${result.applied}/${result.total} bindings applied.
${lines.join("\n")}` }
        ]
      };
    } catch (error) {
      return {
        content: [
          { type: "text", text: `Error binding variables: ${error instanceof Error ? error.message : String(error)}` }
        ]
      };
    }
  }
);
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
   - **Action:** Call \`read_node\` on the relevant node(s) \u2014 pass their nodeIds, or omit nodeIds to read the current selection \u2014 to get context about the nodes involved (names, types, etc.). This helps in generating meaningful connector labels later.
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
     - If \`triggerType\` is "ON_CLICK" and \`actionType\` is "NAVIGATE": "On click, navigate to [Destination Node Name]"
     - If \`triggerType\` is "ON_DRAG" and \`actionType\` is "OPEN_OVERLAY": "On drag, open [Destination Node Name] overlay"
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
          }
        }
      ],
      description: "Strategy for converting Figma prototype reactions to connector lines using the output of 'get_reactions'"
    };
  }
);
function connectToFigma(port = 3055) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    logger.info("Already connected to Figma");
    return;
  }
  const wsUrl = serverUrl === "localhost" ? `${WS_URL}:${port}` : WS_URL;
  logger.info(`Connecting to Figma socket server at ${wsUrl}...`);
  ws = new WebSocket(wsUrl);
  ws.on("open", () => {
    logger.info("Connected to Figma socket server");
    if (currentChannel) {
      const channel = currentChannel;
      sendCommandToFigma("join", { channel }).then(
        () => logger.info(`Rejoined channel after reconnect: ${channel}`),
        (err) => logger.error(`Failed to rejoin channel ${channel}: ${err instanceof Error ? err.message : String(err)}`)
      );
    }
  });
  ws.on("message", (data) => {
    try {
      const json = JSON.parse(data);
      if (json.type === "error") {
        const errId = json.id || json.message?.id;
        if (errId && pendingRequests.has(errId)) {
          const request = pendingRequests.get(errId);
          clearTimeout(request.timeout);
          const reason = json.message?.error || json.message || "Figma relay error";
          logger.error(`Relay error for request ${errId}: ${reason}`);
          request.reject(new Error(typeof reason === "string" ? reason : JSON.stringify(reason)));
          pendingRequests.delete(errId);
        }
        return;
      }
      if (json.type === "progress_update") {
        const progressData = json.message.data;
        const requestId = json.id || "";
        if (requestId && pendingRequests.has(requestId)) {
          const request = pendingRequests.get(requestId);
          request.lastActivity = Date.now();
          clearTimeout(request.timeout);
          request.timeout = setTimeout(() => {
            if (pendingRequests.has(requestId)) {
              logger.error(`Request ${requestId} timed out after extended period of inactivity`);
              pendingRequests.delete(requestId);
              request.reject(new Error("Request to Figma timed out"));
            }
          }, 6e4);
          logger.info(`Progress update for ${progressData.commandType}: ${progressData.progress}% - ${progressData.message}`);
          if (progressData.status === "completed" && progressData.progress === 100) {
            logger.info(`Operation ${progressData.commandType} completed, waiting for final result`);
          }
        }
        return;
      }
      const myResponse = json.message;
      logger.debug(`Received message: ${JSON.stringify(myResponse)}`);
      logger.log("myResponse" + JSON.stringify(myResponse));
      if (myResponse.id && pendingRequests.has(myResponse.id) && myResponse.result) {
        const request = pendingRequests.get(myResponse.id);
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
        logger.info(`Received broadcast message: ${JSON.stringify(myResponse)}`);
      }
    } catch (error) {
      logger.error(`Error parsing message: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  ws.on("error", (error) => {
    logger.error(`Socket error: ${error}`);
  });
  ws.on("close", () => {
    logger.info("Disconnected from Figma socket server");
    ws = null;
    for (const [id, request] of pendingRequests.entries()) {
      clearTimeout(request.timeout);
      request.reject(new Error("Connection closed"));
      pendingRequests.delete(id);
    }
    logger.info("Attempting to reconnect in 2 seconds...");
    setTimeout(() => connectToFigma(port), 2e3);
  });
}
async function joinChannel(channelName) {
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
function waitForConnection(timeoutMs = 1e4) {
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
        reject(new Error(`Unable to establish connection to Figma after ${timeoutMs / 1e3} seconds`));
      }
    }, 100);
  });
}
var NO_CLIENT_ERROR_RE = /No client is connected to channel/;
async function recoverPluginChannel() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const active = await readActiveChannels();
    if (active.length > 0) {
      const same = active.find((c) => c.channel === currentChannel);
      if (same) return same.channel;
      if (active.length === 1) return active[0].channel;
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return null;
}
function sendCommandToFigma(command, params = {}, timeoutMs = 3e4, isRetry = false) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (command === "join") {
        reject(new Error("Not connected to Figma"));
        return;
      }
      waitForConnection().then(() => sendCommandToFigma(command, params, timeoutMs).then(resolve, reject), reject);
      return;
    }
    const requiresChannel = command !== "join";
    if (requiresChannel && !currentChannel) {
      reject(new Error("Must join a channel before sending commands"));
      return;
    }
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
      ...command === "join" ? { channel: params.channel } : { channel: currentChannel },
      message: {
        id,
        command,
        params: {
          ...params,
          commandId: id
          // Include the command ID in params
        }
      }
    };
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        logger.error(`Request ${id} to Figma timed out after ${timeoutMs / 1e3} seconds`);
        reject(new Error("Request to Figma timed out"));
      }
    }, timeoutMs);
    const rejectWithRecovery = (error) => {
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
          const rejoined = channel !== currentChannel ? joinChannel(channel) : Promise.resolve();
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
    pendingRequests.set(id, {
      resolve,
      reject: rejectWithRecovery,
      timeout,
      lastActivity: Date.now()
    });
    logger.info(`Sending command to Figma: ${command}`);
    logger.debug(`Request details: ${JSON.stringify(request)}`);
    ws.send(JSON.stringify(request));
  });
}
var ACTIVE_CHANNELS_FILE = join(tmpdir(), "figma-active-channels.json");
async function readActiveChannels() {
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
            text: "No active plugin channel found. Make sure the WebSocket relay (bun socket) is running and the Figma plugin is connected."
          }
        ]
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ active, currentChannel }, null, 2)
        }
      ]
    };
  }
);
server.tool(
  "join_channel",
  "Join a specific channel to communicate with Figma. Leave channel empty to auto-join the channel the plugin currently has open (when exactly one is active).",
  {
    channel: z4.string().describe("The name of the channel to join").default("")
  },
  async ({ channel }) => {
    try {
      if (!channel) {
        const active = await readActiveChannels();
        if (active.length === 1) {
          channel = active[0].channel;
        } else if (active.length > 1) {
          return {
            content: [
              {
                type: "text",
                text: `Multiple active channels found, pass one explicitly: ${active.map(
                  (c) => c.meta?.name ? `${c.channel} (${c.meta.name}${c.meta.editorType ? `, ${c.meta.editorType}` : ""})` : c.channel
                ).join(", ")}`
              }
            ]
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Please provide a channel name to join:"
              }
            ],
            followUp: {
              tool: "join_channel",
              description: "Join the specified channel"
            }
          };
        }
      }
      await joinChannel(channel);
      return {
        content: [
          {
            type: "text",
            text: `Successfully joined channel: ${channel}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error joining channel: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
async function main() {
  try {
    connectToFigma();
  } catch (error) {
    logger.warn(`Could not connect to Figma initially: ${error instanceof Error ? error.message : String(error)}`);
    logger.warn("Will try to connect when the first command is sent");
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("FigmaMCP server running on stdio");
}
main().catch((error) => {
  logger.error(`Error starting FigmaMCP server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
//# sourceMappingURL=server.js.map