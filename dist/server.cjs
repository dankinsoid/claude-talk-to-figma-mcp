#!/usr/bin/env node
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/talk_to_figma_mcp/server.ts
var import_mcp = require("@modelcontextprotocol/sdk/server/mcp.js");
var import_stdio = require("@modelcontextprotocol/sdk/server/stdio.js");
var import_zod4 = require("zod");
var import_ws = __toESM(require("ws"), 1);
var import_uuid = require("uuid");
var import_promises = require("fs/promises");
var import_os3 = require("os");
var import_path3 = require("path");

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
var import_fs = require("fs");
var import_path = require("path");
var import_os = require("os");
var DIR = (0, import_path.join)((0, import_os.tmpdir)(), "talk-to-figma", "idmap");
var TTL_MS = 48 * 60 * 60 * 1e3;
var FLUSH_DELAY_MS = 0;
var COUNTER_GAP = 100;
var shortToFull = /* @__PURE__ */ new Map();
var fullToShort = /* @__PURE__ */ new Map();
var counter = 0;
var filePath = null;
var flushTimer = null;
var SHORT_RE = /^n\d+$/;
function fileFor(channel) {
  return (0, import_path.join)(DIR, channel.replace(/[^\w.-]/g, "_") + ".json");
}
function setIdMapNamespace(channel) {
  const next = fileFor(channel);
  if (filePath === next) return;
  flushNow();
  filePath = next;
  shortToFull = /* @__PURE__ */ new Map();
  fullToShort = /* @__PURE__ */ new Map();
  counter = 0;
  try {
    const data = JSON.parse((0, import_fs.readFileSync)(filePath, "utf8"));
    if (data && typeof data.counter === "number" && data.ids) {
      counter = data.counter + COUNTER_GAP;
      for (const [full, s] of Object.entries(data.ids)) {
        fullToShort.set(full, s);
        shortToFull.set(s, full);
      }
    }
  } catch {
  }
  pruneExpired();
}
function pruneExpired() {
  try {
    const cutoff = Date.now() - TTL_MS;
    for (const name of (0, import_fs.readdirSync)(DIR)) {
      const p = (0, import_path.join)(DIR, name);
      if (p === filePath || !name.endsWith(".json")) continue;
      try {
        if ((0, import_fs.statSync)(p).mtimeMs < cutoff) (0, import_fs.unlinkSync)(p);
      } catch {
      }
    }
  } catch {
  }
}
function scheduleFlush() {
  if (!filePath || flushTimer) return;
  flushTimer = setTimeout(flushNow, FLUSH_DELAY_MS);
}
function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!filePath) return;
  try {
    (0, import_fs.mkdirSync)(DIR, { recursive: true });
    try {
      const disk = JSON.parse((0, import_fs.readFileSync)(filePath, "utf8"));
      if (disk && disk.ids) {
        for (const [full, s] of Object.entries(disk.ids)) {
          if (!fullToShort.has(full) && !shortToFull.has(s)) {
            fullToShort.set(full, s);
            shortToFull.set(s, full);
          }
        }
        if (typeof disk.counter === "number" && disk.counter > counter) counter = disk.counter;
      }
    } catch {
    }
    const ids = {};
    for (const [full, s] of fullToShort) ids[full] = s;
    const tmp = `${filePath}.${process.pid}.tmp`;
    (0, import_fs.writeFileSync)(tmp, JSON.stringify({ counter, ids }));
    (0, import_fs.renameSync)(tmp, filePath);
  } catch {
  }
}
process.on("exit", flushNow);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    flushNow();
    process.exit(sig === "SIGINT" ? 130 : 143);
  });
}
function shorten(fullId) {
  if (SHORT_RE.test(fullId)) return fullId;
  let s = fullToShort.get(fullId);
  if (!s) {
    s = "n" + counter++;
    fullToShort.set(fullId, s);
    shortToFull.set(s, fullId);
    scheduleFlush();
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
      `Unknown short id "${id}" \u2014 re-fetch the node; this id is not in the current file's map (expired or from another document).`
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
var import_zod3 = require("zod");

// src/talk_to_figma_mcp/write_schema.generated.ts
var import_zod2 = require("zod");

// src/talk_to_figma_mcp/shared-schemas.ts
var import_zod = require("zod");
var Color = import_zod.z.union([
  import_zod.z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "expected #RRGGBB or #RRGGBBAA hex"),
  import_zod.z.object({ r: import_zod.z.number(), g: import_zod.z.number(), b: import_zod.z.number(), a: import_zod.z.number().optional() })
]);
var Paint = import_zod.z.object({
  type: import_zod.z.enum(["SOLID", "GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND", "IMAGE"]).optional(),
  color: Color.optional().describe("SOLID paint color, #RRGGBB"),
  opacity: import_zod.z.number().min(0).max(1).optional(),
  // IMAGE paint: pass a URL and the server fetches the bytes and imports them
  // into Figma for you (no imageHash juggling). type defaults to "IMAGE" when
  // imageUrl is present. Alternatively pass an imageHash you already have.
  imageUrl: import_zod.z.string().optional().describe('image fill source \u2014 https URL, file:// URL or local file path (/abs or ~/); read/fetched server-side and imported; implies type "IMAGE"'),
  imageHash: import_zod.z.string().optional().describe("pre-imported Figma image hash (alternative to imageUrl)"),
  scaleMode: import_zod.z.enum(["FILL", "FIT", "CROP", "TILE"]).optional().describe("IMAGE paint scale mode (default FILL)")
}).passthrough();
var FontName = import_zod.z.object({ family: import_zod.z.string(), style: import_zod.z.string().describe('face name, e.g. "Regular", "Bold Italic"') }).describe("font; loaded automatically before write");
var LetterSpacing = import_zod.z.union([
  import_zod.z.number(),
  import_zod.z.object({ value: import_zod.z.number(), unit: import_zod.z.enum(["PIXELS", "PERCENT"]) })
]);
var LineHeight = import_zod.z.union([
  import_zod.z.number(),
  import_zod.z.object({ value: import_zod.z.number(), unit: import_zod.z.enum(["PIXELS", "PERCENT"]) }),
  import_zod.z.object({ unit: import_zod.z.literal("AUTO") })
]);
var Effect = import_zod.z.object({ type: import_zod.z.string().describe("DROP_SHADOW | INNER_SHADOW | LAYER_BLUR | BACKGROUND_BLUR | ...") }).passthrough();

// src/talk_to_figma_mcp/write_schema.generated.ts
var StrokeCap = import_zod2.z.enum(["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL", "DIAMOND_FILLED", "TRIANGLE_FILLED", "CIRCLE_FILLED"]);
var StrokeJoin = import_zod2.z.enum(["ROUND", "MITER", "BEVEL"]);
var StrokeAlign = import_zod2.z.enum(["CENTER", "INSIDE", "OUTSIDE"]);
var LayoutSizingHorizontal = import_zod2.z.enum(["FIXED", "HUG", "FILL"]);
var LayoutAlign = import_zod2.z.enum(["CENTER", "MIN", "MAX", "STRETCH", "INHERIT"]);
var LayoutPositioning = import_zod2.z.enum(["AUTO", "ABSOLUTE"]);
var GridChildHorizontalAlign = import_zod2.z.enum(["CENTER", "MIN", "MAX", "AUTO"]);
var LayoutMode = import_zod2.z.enum(["NONE", "HORIZONTAL", "VERTICAL", "GRID"]);
var PrimaryAxisSizingMode = import_zod2.z.enum(["FIXED", "AUTO"]);
var LayoutWrap = import_zod2.z.enum(["NO_WRAP", "WRAP"]);
var PrimaryAxisAlignItems = import_zod2.z.enum(["CENTER", "MIN", "MAX", "SPACE_BETWEEN"]);
var CounterAxisAlignItems = import_zod2.z.enum(["CENTER", "MIN", "MAX", "BASELINE"]);
var CounterAxisAlignContent = import_zod2.z.enum(["AUTO", "SPACE_BETWEEN"]);
var GridAutoTracks = import_zod2.z.enum(["NONE", "ROWS"]);
var GridItemsPositioning = import_zod2.z.enum(["MANUAL", "ROW_AUTO_FLOW"]);
var Unit = import_zod2.z.enum(["PIXELS", "PERCENT"]);
var MaskType = import_zod2.z.enum(["ALPHA", "VECTOR", "LUMINANCE"]);
var BlendMode = import_zod2.z.enum(["PASS_THROUGH", "NORMAL", "DARKEN", "MULTIPLY", "LINEAR_BURN", "COLOR_BURN", "LIGHTEN", "SCREEN", "LINEAR_DODGE", "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY"]);
var ConstraintType = import_zod2.z.enum(["CENTER", "MIN", "MAX", "STRETCH", "SCALE"]);
var Constraints = import_zod2.z.object({ "horizontal": ConstraintType, "vertical": ConstraintType }).passthrough();
var GridTrackSize = import_zod2.z.object({ "value": import_zod2.z.number().nullable().optional(), "type": import_zod2.z.enum(["FIXED", "HUG", "FLEX"]) }).passthrough();
var OverflowDirection = import_zod2.z.enum(["NONE", "HORIZONTAL", "VERTICAL", "BOTH"]);
var RGB = import_zod2.z.object({ "r": import_zod2.z.number(), "g": import_zod2.z.number(), "b": import_zod2.z.number() }).passthrough();
var SolidPaint = import_zod2.z.object({ "type": import_zod2.z.literal("SOLID"), "color": RGB, "visible": import_zod2.z.boolean().nullable().optional(), "opacity": import_zod2.z.number().nullable().optional(), "blendMode": BlendMode.nullable().optional(), "boundVariables": import_zod2.z.record(import_zod2.z.unknown()).nullable().optional() }).passthrough();
var HyperlinkTarget = import_zod2.z.object({ "type": import_zod2.z.enum(["URL", "NODE"]), "value": import_zod2.z.string() }).passthrough();
var ArcData = import_zod2.z.object({ "startingAngle": import_zod2.z.number(), "endingAngle": import_zod2.z.number(), "innerRadius": import_zod2.z.number() }).passthrough();
var VectorPath = import_zod2.z.object({ "windingRule": import_zod2.z.enum(["NONE", "NONZERO", "EVENODD"]), "data": import_zod2.z.string() }).passthrough();
var DocumentationLink = import_zod2.z.object({ "uri": import_zod2.z.string() }).passthrough();
var GENERATED_FIELDS = {
  FRAME: {
    "blendMode": BlendMode,
    "bottomLeftRadius": import_zod2.z.number(),
    "bottomRightRadius": import_zod2.z.number(),
    "clipsContent": import_zod2.z.boolean(),
    "constraints": Constraints,
    "cornerRadius": import_zod2.z.number(),
    "cornerSmoothing": import_zod2.z.number(),
    "counterAxisAlignContent": CounterAxisAlignContent,
    "counterAxisAlignItems": CounterAxisAlignItems,
    "counterAxisSizingMode": PrimaryAxisSizingMode,
    "counterAxisSpacing": import_zod2.z.number().nullable(),
    "effects": import_zod2.z.array(Effect),
    "expanded": import_zod2.z.boolean(),
    "fills": import_zod2.z.array(Paint),
    "gridAutoTracks": GridAutoTracks,
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnCount": import_zod2.z.number(),
    "gridColumnGap": import_zod2.z.number(),
    "gridColumnSizes": import_zod2.z.array(GridTrackSize),
    "gridColumnSpan": import_zod2.z.number(),
    "gridItemsPositioning": GridItemsPositioning,
    "gridRowCount": import_zod2.z.number(),
    "gridRowGap": import_zod2.z.number(),
    "gridRowSizes": import_zod2.z.array(GridTrackSize),
    "gridRowSpan": import_zod2.z.number(),
    "isMask": import_zod2.z.boolean(),
    "itemReverseZIndex": import_zod2.z.boolean(),
    "itemSpacing": import_zod2.z.number(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": import_zod2.z.number(),
    "layoutMode": LayoutMode,
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "layoutWrap": LayoutWrap,
    "locked": import_zod2.z.boolean(),
    "maskType": MaskType,
    "maxHeight": import_zod2.z.number().nullable(),
    "maxWidth": import_zod2.z.number().nullable(),
    "minHeight": import_zod2.z.number().nullable(),
    "minWidth": import_zod2.z.number().nullable(),
    "name": import_zod2.z.string(),
    "numberOfFixedChildren": import_zod2.z.number(),
    "opacity": import_zod2.z.number(),
    "overflowDirection": OverflowDirection,
    "paddingBottom": import_zod2.z.number(),
    "paddingLeft": import_zod2.z.number(),
    "paddingRight": import_zod2.z.number(),
    "paddingTop": import_zod2.z.number(),
    "primaryAxisAlignItems": PrimaryAxisAlignItems,
    "primaryAxisSizingMode": PrimaryAxisSizingMode,
    "rotation": import_zod2.z.number(),
    "strokeAlign": StrokeAlign,
    "strokeBottomWeight": import_zod2.z.number(),
    "strokeCap": StrokeCap,
    "strokeJoin": StrokeJoin,
    "strokeLeftWeight": import_zod2.z.number(),
    "strokeMiterLimit": import_zod2.z.number(),
    "strokeRightWeight": import_zod2.z.number(),
    "strokeTopWeight": import_zod2.z.number(),
    "strokeWeight": import_zod2.z.number(),
    "strokes": import_zod2.z.array(Paint),
    "strokesIncludedInLayout": import_zod2.z.boolean(),
    "topLeftRadius": import_zod2.z.number(),
    "topRightRadius": import_zod2.z.number(),
    "visible": import_zod2.z.boolean(),
    "x": import_zod2.z.number(),
    "y": import_zod2.z.number()
  },
  TEXT: {
    "autoRename": import_zod2.z.boolean(),
    "blendMode": BlendMode,
    "characters": import_zod2.z.string(),
    "constraints": Constraints,
    "effects": import_zod2.z.array(Effect),
    "fills": import_zod2.z.array(Paint),
    "fontName": FontName,
    "fontSize": import_zod2.z.number(),
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnSpan": import_zod2.z.number(),
    "gridRowSpan": import_zod2.z.number(),
    "hangingList": import_zod2.z.boolean(),
    "hangingPunctuation": import_zod2.z.boolean(),
    "hyperlink": HyperlinkTarget.nullable(),
    "isMask": import_zod2.z.boolean(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": import_zod2.z.number(),
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "leadingTrim": import_zod2.z.enum(["NONE", "CAP_HEIGHT"]),
    "letterSpacing": LetterSpacing,
    "lineHeight": LineHeight,
    "listSpacing": import_zod2.z.number(),
    "locked": import_zod2.z.boolean(),
    "maskType": MaskType,
    "maxHeight": import_zod2.z.number().nullable(),
    "maxLines": import_zod2.z.number().nullable(),
    "maxWidth": import_zod2.z.number().nullable(),
    "minHeight": import_zod2.z.number().nullable(),
    "minWidth": import_zod2.z.number().nullable(),
    "name": import_zod2.z.string(),
    "opacity": import_zod2.z.number(),
    "paragraphIndent": import_zod2.z.number(),
    "paragraphSpacing": import_zod2.z.number(),
    "rotation": import_zod2.z.number(),
    "strokeAlign": StrokeAlign,
    "strokeCap": StrokeCap,
    "strokeJoin": StrokeJoin,
    "strokeMiterLimit": import_zod2.z.number(),
    "strokeWeight": import_zod2.z.number(),
    "strokes": import_zod2.z.array(Paint),
    "textAlignHorizontal": import_zod2.z.enum(["CENTER", "LEFT", "RIGHT", "JUSTIFIED"]),
    "textAlignVertical": import_zod2.z.enum(["CENTER", "TOP", "BOTTOM"]),
    "textAutoResize": import_zod2.z.enum(["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"]),
    "textCase": import_zod2.z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"]),
    "textDecoration": import_zod2.z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]),
    "textDecorationColor": import_zod2.z.union([import_zod2.z.object({ "value": SolidPaint }).passthrough(), import_zod2.z.object({ "value": import_zod2.z.literal("AUTO") }).passthrough()]).nullable(),
    "textDecorationOffset": import_zod2.z.union([import_zod2.z.object({ "value": import_zod2.z.number(), "unit": Unit }).passthrough(), import_zod2.z.object({ "unit": import_zod2.z.literal("AUTO") }).passthrough()]).nullable(),
    "textDecorationSkipInk": import_zod2.z.boolean().nullable(),
    "textDecorationStyle": import_zod2.z.enum(["SOLID", "WAVY", "DOTTED"]).nullable(),
    "textDecorationThickness": import_zod2.z.union([import_zod2.z.object({ "value": import_zod2.z.number(), "unit": Unit }).passthrough(), import_zod2.z.object({ "unit": import_zod2.z.literal("AUTO") }).passthrough()]).nullable(),
    "textTruncation": import_zod2.z.enum(["DISABLED", "ENDING"]),
    "visible": import_zod2.z.boolean(),
    "x": import_zod2.z.number(),
    "y": import_zod2.z.number()
  },
  RECTANGLE: {
    "blendMode": BlendMode,
    "bottomLeftRadius": import_zod2.z.number(),
    "bottomRightRadius": import_zod2.z.number(),
    "constraints": Constraints,
    "cornerRadius": import_zod2.z.number(),
    "cornerSmoothing": import_zod2.z.number(),
    "effects": import_zod2.z.array(Effect),
    "fills": import_zod2.z.array(Paint),
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnSpan": import_zod2.z.number(),
    "gridRowSpan": import_zod2.z.number(),
    "isMask": import_zod2.z.boolean(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": import_zod2.z.number(),
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "locked": import_zod2.z.boolean(),
    "maskType": MaskType,
    "maxHeight": import_zod2.z.number().nullable(),
    "maxWidth": import_zod2.z.number().nullable(),
    "minHeight": import_zod2.z.number().nullable(),
    "minWidth": import_zod2.z.number().nullable(),
    "name": import_zod2.z.string(),
    "opacity": import_zod2.z.number(),
    "rotation": import_zod2.z.number(),
    "strokeAlign": StrokeAlign,
    "strokeBottomWeight": import_zod2.z.number(),
    "strokeCap": StrokeCap,
    "strokeJoin": StrokeJoin,
    "strokeLeftWeight": import_zod2.z.number(),
    "strokeMiterLimit": import_zod2.z.number(),
    "strokeRightWeight": import_zod2.z.number(),
    "strokeTopWeight": import_zod2.z.number(),
    "strokeWeight": import_zod2.z.number(),
    "strokes": import_zod2.z.array(Paint),
    "topLeftRadius": import_zod2.z.number(),
    "topRightRadius": import_zod2.z.number(),
    "visible": import_zod2.z.boolean(),
    "x": import_zod2.z.number(),
    "y": import_zod2.z.number()
  },
  ELLIPSE: {
    "arcData": ArcData,
    "blendMode": BlendMode,
    "constraints": Constraints,
    "cornerRadius": import_zod2.z.number(),
    "cornerSmoothing": import_zod2.z.number(),
    "effects": import_zod2.z.array(Effect),
    "fills": import_zod2.z.array(Paint),
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnSpan": import_zod2.z.number(),
    "gridRowSpan": import_zod2.z.number(),
    "isMask": import_zod2.z.boolean(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": import_zod2.z.number(),
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "locked": import_zod2.z.boolean(),
    "maskType": MaskType,
    "maxHeight": import_zod2.z.number().nullable(),
    "maxWidth": import_zod2.z.number().nullable(),
    "minHeight": import_zod2.z.number().nullable(),
    "minWidth": import_zod2.z.number().nullable(),
    "name": import_zod2.z.string(),
    "opacity": import_zod2.z.number(),
    "rotation": import_zod2.z.number(),
    "strokeAlign": StrokeAlign,
    "strokeCap": StrokeCap,
    "strokeJoin": StrokeJoin,
    "strokeMiterLimit": import_zod2.z.number(),
    "strokeWeight": import_zod2.z.number(),
    "strokes": import_zod2.z.array(Paint),
    "visible": import_zod2.z.boolean(),
    "x": import_zod2.z.number(),
    "y": import_zod2.z.number()
  },
  LINE: {
    "blendMode": BlendMode,
    "constraints": Constraints,
    "effects": import_zod2.z.array(Effect),
    "fills": import_zod2.z.array(Paint),
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnSpan": import_zod2.z.number(),
    "gridRowSpan": import_zod2.z.number(),
    "isMask": import_zod2.z.boolean(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": import_zod2.z.number(),
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "locked": import_zod2.z.boolean(),
    "maskType": MaskType,
    "maxHeight": import_zod2.z.number().nullable(),
    "maxWidth": import_zod2.z.number().nullable(),
    "minHeight": import_zod2.z.number().nullable(),
    "minWidth": import_zod2.z.number().nullable(),
    "name": import_zod2.z.string(),
    "opacity": import_zod2.z.number(),
    "rotation": import_zod2.z.number(),
    "strokeAlign": StrokeAlign,
    "strokeCap": StrokeCap,
    "strokeJoin": StrokeJoin,
    "strokeMiterLimit": import_zod2.z.number(),
    "strokeWeight": import_zod2.z.number(),
    "strokes": import_zod2.z.array(Paint),
    "visible": import_zod2.z.boolean(),
    "x": import_zod2.z.number(),
    "y": import_zod2.z.number()
  },
  STAR: {
    "blendMode": BlendMode,
    "constraints": Constraints,
    "cornerRadius": import_zod2.z.number(),
    "cornerSmoothing": import_zod2.z.number(),
    "effects": import_zod2.z.array(Effect),
    "fills": import_zod2.z.array(Paint),
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnSpan": import_zod2.z.number(),
    "gridRowSpan": import_zod2.z.number(),
    "innerRadius": import_zod2.z.number(),
    "isMask": import_zod2.z.boolean(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": import_zod2.z.number(),
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "locked": import_zod2.z.boolean(),
    "maskType": MaskType,
    "maxHeight": import_zod2.z.number().nullable(),
    "maxWidth": import_zod2.z.number().nullable(),
    "minHeight": import_zod2.z.number().nullable(),
    "minWidth": import_zod2.z.number().nullable(),
    "name": import_zod2.z.string(),
    "opacity": import_zod2.z.number(),
    "pointCount": import_zod2.z.number(),
    "rotation": import_zod2.z.number(),
    "strokeAlign": StrokeAlign,
    "strokeCap": StrokeCap,
    "strokeJoin": StrokeJoin,
    "strokeMiterLimit": import_zod2.z.number(),
    "strokeWeight": import_zod2.z.number(),
    "strokes": import_zod2.z.array(Paint),
    "visible": import_zod2.z.boolean(),
    "x": import_zod2.z.number(),
    "y": import_zod2.z.number()
  },
  POLYGON: {
    "blendMode": BlendMode,
    "constraints": Constraints,
    "cornerRadius": import_zod2.z.number(),
    "cornerSmoothing": import_zod2.z.number(),
    "effects": import_zod2.z.array(Effect),
    "fills": import_zod2.z.array(Paint),
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnSpan": import_zod2.z.number(),
    "gridRowSpan": import_zod2.z.number(),
    "isMask": import_zod2.z.boolean(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": import_zod2.z.number(),
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "locked": import_zod2.z.boolean(),
    "maskType": MaskType,
    "maxHeight": import_zod2.z.number().nullable(),
    "maxWidth": import_zod2.z.number().nullable(),
    "minHeight": import_zod2.z.number().nullable(),
    "minWidth": import_zod2.z.number().nullable(),
    "name": import_zod2.z.string(),
    "opacity": import_zod2.z.number(),
    "pointCount": import_zod2.z.number(),
    "rotation": import_zod2.z.number(),
    "strokeAlign": StrokeAlign,
    "strokeCap": StrokeCap,
    "strokeJoin": StrokeJoin,
    "strokeMiterLimit": import_zod2.z.number(),
    "strokeWeight": import_zod2.z.number(),
    "strokes": import_zod2.z.array(Paint),
    "visible": import_zod2.z.boolean(),
    "x": import_zod2.z.number(),
    "y": import_zod2.z.number()
  },
  VECTOR: {
    "blendMode": BlendMode,
    "constraints": Constraints,
    "cornerRadius": import_zod2.z.number(),
    "cornerSmoothing": import_zod2.z.number(),
    "effects": import_zod2.z.array(Effect),
    "fills": import_zod2.z.array(Paint),
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnSpan": import_zod2.z.number(),
    "gridRowSpan": import_zod2.z.number(),
    "handleMirroring": import_zod2.z.enum(["NONE", "ANGLE", "ANGLE_AND_LENGTH"]),
    "isMask": import_zod2.z.boolean(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": import_zod2.z.number(),
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "locked": import_zod2.z.boolean(),
    "maskType": MaskType,
    "maxHeight": import_zod2.z.number().nullable(),
    "maxWidth": import_zod2.z.number().nullable(),
    "minHeight": import_zod2.z.number().nullable(),
    "minWidth": import_zod2.z.number().nullable(),
    "name": import_zod2.z.string(),
    "opacity": import_zod2.z.number(),
    "rotation": import_zod2.z.number(),
    "strokeAlign": StrokeAlign,
    "strokeCap": StrokeCap,
    "strokeJoin": StrokeJoin,
    "strokeMiterLimit": import_zod2.z.number(),
    "strokeWeight": import_zod2.z.number(),
    "strokes": import_zod2.z.array(Paint),
    "vectorPaths": import_zod2.z.array(VectorPath),
    "visible": import_zod2.z.boolean(),
    "x": import_zod2.z.number(),
    "y": import_zod2.z.number()
  },
  COMPONENT: {
    "blendMode": BlendMode,
    "bottomLeftRadius": import_zod2.z.number(),
    "bottomRightRadius": import_zod2.z.number(),
    "clipsContent": import_zod2.z.boolean(),
    "constraints": Constraints,
    "cornerRadius": import_zod2.z.number(),
    "cornerSmoothing": import_zod2.z.number(),
    "counterAxisAlignContent": CounterAxisAlignContent,
    "counterAxisAlignItems": CounterAxisAlignItems,
    "counterAxisSizingMode": PrimaryAxisSizingMode,
    "counterAxisSpacing": import_zod2.z.number().nullable(),
    "description": import_zod2.z.string(),
    "descriptionMarkdown": import_zod2.z.string(),
    "documentationLinks": import_zod2.z.array(DocumentationLink),
    "effects": import_zod2.z.array(Effect),
    "expanded": import_zod2.z.boolean(),
    "fills": import_zod2.z.array(Paint),
    "gridAutoTracks": GridAutoTracks,
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnCount": import_zod2.z.number(),
    "gridColumnGap": import_zod2.z.number(),
    "gridColumnSizes": import_zod2.z.array(GridTrackSize),
    "gridColumnSpan": import_zod2.z.number(),
    "gridItemsPositioning": GridItemsPositioning,
    "gridRowCount": import_zod2.z.number(),
    "gridRowGap": import_zod2.z.number(),
    "gridRowSizes": import_zod2.z.array(GridTrackSize),
    "gridRowSpan": import_zod2.z.number(),
    "isMask": import_zod2.z.boolean(),
    "itemReverseZIndex": import_zod2.z.boolean(),
    "itemSpacing": import_zod2.z.number(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": import_zod2.z.number(),
    "layoutMode": LayoutMode,
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "layoutWrap": LayoutWrap,
    "locked": import_zod2.z.boolean(),
    "maskType": MaskType,
    "maxHeight": import_zod2.z.number().nullable(),
    "maxWidth": import_zod2.z.number().nullable(),
    "minHeight": import_zod2.z.number().nullable(),
    "minWidth": import_zod2.z.number().nullable(),
    "name": import_zod2.z.string(),
    "numberOfFixedChildren": import_zod2.z.number(),
    "opacity": import_zod2.z.number(),
    "overflowDirection": OverflowDirection,
    "paddingBottom": import_zod2.z.number(),
    "paddingLeft": import_zod2.z.number(),
    "paddingRight": import_zod2.z.number(),
    "paddingTop": import_zod2.z.number(),
    "primaryAxisAlignItems": PrimaryAxisAlignItems,
    "primaryAxisSizingMode": PrimaryAxisSizingMode,
    "rotation": import_zod2.z.number(),
    "strokeAlign": StrokeAlign,
    "strokeBottomWeight": import_zod2.z.number(),
    "strokeCap": StrokeCap,
    "strokeJoin": StrokeJoin,
    "strokeLeftWeight": import_zod2.z.number(),
    "strokeMiterLimit": import_zod2.z.number(),
    "strokeRightWeight": import_zod2.z.number(),
    "strokeTopWeight": import_zod2.z.number(),
    "strokeWeight": import_zod2.z.number(),
    "strokes": import_zod2.z.array(Paint),
    "strokesIncludedInLayout": import_zod2.z.boolean(),
    "topLeftRadius": import_zod2.z.number(),
    "topRightRadius": import_zod2.z.number(),
    "visible": import_zod2.z.boolean(),
    "x": import_zod2.z.number(),
    "y": import_zod2.z.number()
  },
  SECTION: {
    "bottomLeftRadius": import_zod2.z.number(),
    "bottomRightRadius": import_zod2.z.number(),
    "cornerRadius": import_zod2.z.number(),
    "cornerSmoothing": import_zod2.z.number(),
    "fills": import_zod2.z.array(Paint),
    "locked": import_zod2.z.boolean(),
    "maxHeight": import_zod2.z.number().nullable(),
    "maxWidth": import_zod2.z.number().nullable(),
    "minHeight": import_zod2.z.number().nullable(),
    "minWidth": import_zod2.z.number().nullable(),
    "name": import_zod2.z.string(),
    "sectionContentsHidden": import_zod2.z.boolean(),
    "strokeAlign": StrokeAlign,
    "strokeJoin": StrokeJoin,
    "strokeWeight": import_zod2.z.number(),
    "strokes": import_zod2.z.array(Paint),
    "topLeftRadius": import_zod2.z.number(),
    "topRightRadius": import_zod2.z.number(),
    "visible": import_zod2.z.boolean(),
    "x": import_zod2.z.number(),
    "y": import_zod2.z.number()
  },
  SLICE: {
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnSpan": import_zod2.z.number(),
    "gridRowSpan": import_zod2.z.number(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": import_zod2.z.number(),
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "locked": import_zod2.z.boolean(),
    "maxHeight": import_zod2.z.number().nullable(),
    "maxWidth": import_zod2.z.number().nullable(),
    "minHeight": import_zod2.z.number().nullable(),
    "minWidth": import_zod2.z.number().nullable(),
    "name": import_zod2.z.string(),
    "rotation": import_zod2.z.number(),
    "visible": import_zod2.z.boolean(),
    "x": import_zod2.z.number(),
    "y": import_zod2.z.number()
  },
  INSTANCE: {
    "blendMode": BlendMode,
    "bottomLeftRadius": import_zod2.z.number(),
    "bottomRightRadius": import_zod2.z.number(),
    "clipsContent": import_zod2.z.boolean(),
    "constraints": Constraints,
    "cornerRadius": import_zod2.z.number(),
    "cornerSmoothing": import_zod2.z.number(),
    "counterAxisAlignContent": CounterAxisAlignContent,
    "counterAxisAlignItems": CounterAxisAlignItems,
    "counterAxisSizingMode": PrimaryAxisSizingMode,
    "counterAxisSpacing": import_zod2.z.number().nullable(),
    "effects": import_zod2.z.array(Effect),
    "expanded": import_zod2.z.boolean(),
    "fills": import_zod2.z.array(Paint),
    "gridAutoTracks": GridAutoTracks,
    "gridChildHorizontalAlign": GridChildHorizontalAlign,
    "gridChildVerticalAlign": GridChildHorizontalAlign,
    "gridColumnCount": import_zod2.z.number(),
    "gridColumnGap": import_zod2.z.number(),
    "gridColumnSizes": import_zod2.z.array(GridTrackSize),
    "gridColumnSpan": import_zod2.z.number(),
    "gridItemsPositioning": GridItemsPositioning,
    "gridRowCount": import_zod2.z.number(),
    "gridRowGap": import_zod2.z.number(),
    "gridRowSizes": import_zod2.z.array(GridTrackSize),
    "gridRowSpan": import_zod2.z.number(),
    "isExposedInstance": import_zod2.z.boolean(),
    "isMask": import_zod2.z.boolean(),
    "itemReverseZIndex": import_zod2.z.boolean(),
    "itemSpacing": import_zod2.z.number(),
    "layoutAlign": LayoutAlign,
    "layoutGrow": import_zod2.z.number(),
    "layoutMode": LayoutMode,
    "layoutPositioning": LayoutPositioning,
    "layoutSizingHorizontal": LayoutSizingHorizontal,
    "layoutSizingVertical": LayoutSizingHorizontal,
    "layoutWrap": LayoutWrap,
    "locked": import_zod2.z.boolean(),
    "maskType": MaskType,
    "maxHeight": import_zod2.z.number().nullable(),
    "maxWidth": import_zod2.z.number().nullable(),
    "minHeight": import_zod2.z.number().nullable(),
    "minWidth": import_zod2.z.number().nullable(),
    "name": import_zod2.z.string(),
    "numberOfFixedChildren": import_zod2.z.number(),
    "opacity": import_zod2.z.number(),
    "overflowDirection": OverflowDirection,
    "paddingBottom": import_zod2.z.number(),
    "paddingLeft": import_zod2.z.number(),
    "paddingRight": import_zod2.z.number(),
    "paddingTop": import_zod2.z.number(),
    "primaryAxisAlignItems": PrimaryAxisAlignItems,
    "primaryAxisSizingMode": PrimaryAxisSizingMode,
    "rotation": import_zod2.z.number(),
    "scaleFactor": import_zod2.z.number(),
    "strokeAlign": StrokeAlign,
    "strokeBottomWeight": import_zod2.z.number(),
    "strokeCap": StrokeCap,
    "strokeJoin": StrokeJoin,
    "strokeLeftWeight": import_zod2.z.number(),
    "strokeMiterLimit": import_zod2.z.number(),
    "strokeRightWeight": import_zod2.z.number(),
    "strokeTopWeight": import_zod2.z.number(),
    "strokeWeight": import_zod2.z.number(),
    "strokes": import_zod2.z.array(Paint),
    "strokesIncludedInLayout": import_zod2.z.boolean(),
    "topLeftRadius": import_zod2.z.number(),
    "topRightRadius": import_zod2.z.number(),
    "visible": import_zod2.z.boolean(),
    "x": import_zod2.z.number(),
    "y": import_zod2.z.number()
  },
  CODE_BLOCK: {
    "blendMode": BlendMode,
    "code": import_zod2.z.string(),
    "codeLanguage": import_zod2.z.enum(["TYPESCRIPT", "CPP", "RUBY", "CSS", "JAVASCRIPT", "HTML", "JSON", "GRAPHQL", "PYTHON", "GO", "SQL", "SWIFT", "KOTLIN", "RUST", "BASH", "PLAINTEXT", "DART"]),
    "locked": import_zod2.z.boolean(),
    "maxHeight": import_zod2.z.number().nullable(),
    "maxWidth": import_zod2.z.number().nullable(),
    "minHeight": import_zod2.z.number().nullable(),
    "minWidth": import_zod2.z.number().nullable(),
    "name": import_zod2.z.string(),
    "opacity": import_zod2.z.number(),
    "visible": import_zod2.z.boolean(),
    "x": import_zod2.z.number(),
    "y": import_zod2.z.number()
  },
  STICKY: {
    "authorName": import_zod2.z.string(),
    "authorVisible": import_zod2.z.boolean(),
    "blendMode": BlendMode,
    "fills": import_zod2.z.array(Paint),
    "isWideWidth": import_zod2.z.boolean(),
    "locked": import_zod2.z.boolean(),
    "maxHeight": import_zod2.z.number().nullable(),
    "maxWidth": import_zod2.z.number().nullable(),
    "minHeight": import_zod2.z.number().nullable(),
    "minWidth": import_zod2.z.number().nullable(),
    "name": import_zod2.z.string(),
    "opacity": import_zod2.z.number(),
    "visible": import_zod2.z.boolean(),
    "x": import_zod2.z.number(),
    "y": import_zod2.z.number()
  },
  SHAPE_WITH_TEXT: {
    "blendMode": BlendMode,
    "fills": import_zod2.z.array(Paint),
    "locked": import_zod2.z.boolean(),
    "maxHeight": import_zod2.z.number().nullable(),
    "maxWidth": import_zod2.z.number().nullable(),
    "minHeight": import_zod2.z.number().nullable(),
    "minWidth": import_zod2.z.number().nullable(),
    "name": import_zod2.z.string(),
    "opacity": import_zod2.z.number(),
    "rotation": import_zod2.z.number(),
    "shapeType": import_zod2.z.enum(["SQUARE", "ELLIPSE", "ROUNDED_RECTANGLE", "DIAMOND", "TRIANGLE_UP", "TRIANGLE_DOWN", "PARALLELOGRAM_RIGHT", "PARALLELOGRAM_LEFT", "ENG_DATABASE", "ENG_QUEUE", "ENG_FILE", "ENG_FOLDER", "TRAPEZOID", "PREDEFINED_PROCESS", "SHIELD", "DOCUMENT_SINGLE", "DOCUMENT_MULTIPLE", "MANUAL_INPUT", "HEXAGON", "CHEVRON", "PENTAGON", "OCTAGON", "STAR", "PLUS", "ARROW_LEFT", "ARROW_RIGHT", "SUMMING_JUNCTION", "OR", "SPEECH_BUBBLE", "INTERNAL_STORAGE"]),
    "strokeAlign": StrokeAlign,
    "strokeJoin": StrokeJoin,
    "strokeWeight": import_zod2.z.number(),
    "strokes": import_zod2.z.array(Paint),
    "visible": import_zod2.z.boolean(),
    "x": import_zod2.z.number(),
    "y": import_zod2.z.number()
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
var parentId = import_zod3.z.string().optional().describe("container to append into; default current page. short ids (n0) or full ids");
var index = import_zod3.z.number().int().min(0).optional().describe("position among siblings");
var width = import_zod3.z.number().positive().optional().describe("routed through resize()");
var height = import_zod3.z.number().positive().optional().describe("routed through resize()");
var componentId = import_zod3.z.string().optional().describe("local COMPONENT id (from get_local_components)");
var componentKey = import_zod3.z.string().optional().describe("published library component key");
var svg = import_zod3.z.string().optional().describe("raw SVG markup to import as a vector node");
var svgUrl = import_zod3.z.string().optional().describe("SVG source \u2014 https URL or local file path (/abs, ~/ or file://); read/fetched server-side, then imported");
var children = import_zod3.z.array(import_zod3.z.lazy(() => writeNodeUnion)).optional().describe("nested specs, created recursively inside this node");
var CONTAINER_TYPES = /* @__PURE__ */ new Set(["FRAME", "COMPONENT", "SECTION", "INSTANCE", "SVG"]);
var REQUIRED = { TEXT: /* @__PURE__ */ new Set(["characters"]) };
var SUBLAYER_TEXT_TYPES = /* @__PURE__ */ new Set(["STICKY", "SHAPE_WITH_TEXT"]);
var SUBLAYER_TEXT_FIELDS = ["characters", "fontName", "fontSize", "letterSpacing", "lineHeight", "textAlignHorizontal"];
var pixelsOrUnit = import_zod3.z.union([
  import_zod3.z.number(),
  import_zod3.z.object({ value: import_zod3.z.number(), unit: import_zod3.z.enum(["PIXELS", "PERCENT"]) }).passthrough()
]);
var FIELD_OVERRIDES = {
  opacity: import_zod3.z.number().min(0).max(1),
  cornerRadius: import_zod3.z.number().min(0),
  strokeWeight: import_zod3.z.number().min(0),
  letterSpacing: pixelsOrUnit,
  lineHeight: import_zod3.z.union([pixelsOrUnit, import_zod3.z.object({ unit: import_zod3.z.literal("AUTO") }).passthrough()])
};
var FIELD_ALIASES = {
  borderRadius: "cornerRadius",
  radius: "cornerRadius",
  rotate: "rotation",
  angle: "rotation",
  w: "width",
  h: "height",
  text: "characters",
  textContent: "characters",
  gap: "itemSpacing",
  spacing: "itemSpacing"
};
var FIELD_REDIRECTS = {
  backgroundColor: 'use fills:[{type:"SOLID",color:"#RRGGBB"}]',
  background: 'use fills:[{type:"SOLID",color:"#RRGGBB"}]',
  bg: 'use fills:[{type:"SOLID",color:"#RRGGBB"}]',
  fill: 'use fills (plural): [{type:"SOLID",color:"#RRGGBB"}]',
  color: 'use fills:[{type:"SOLID",color:"#RRGGBB"}] (or fills[0].color on edit)',
  border: 'use strokes:[{type:"SOLID",color:"#RRGGBB"}] + strokeWeight',
  borderColor: 'use strokes:[{type:"SOLID",color:"#RRGGBB"}]',
  stroke: 'use strokes (plural): [{type:"SOLID",color:"#RRGGBB"}]',
  borderWidth: "use strokeWeight",
  padding: "use paddingTop/paddingRight/paddingBottom/paddingLeft",
  fontFamily: "use fontName:{family,style} on a TEXT node",
  fontWeight: 'use fontName:{family,style} (e.g. style:"Bold")',
  fontStyle: "use fontName:{family,style}",
  flexDirection: 'use layoutMode:"HORIZONTAL"|"VERTICAL"',
  direction: 'use layoutMode:"HORIZONTAL"|"VERTICAL"',
  justifyContent: "use primaryAxisAlignItems:MIN|CENTER|MAX|SPACE_BETWEEN",
  alignItems: "use counterAxisAlignItems:MIN|CENTER|MAX|BASELINE",
  hidden: "use visible (boolean, inverted)",
  zIndex: "use reparent_nodes `index` for z-order"
};
function normalizeWriteSpec(spec, notes = []) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return notes;
  for (const alias of Object.keys(spec)) {
    const canon = FIELD_ALIASES[alias];
    if (canon && !(canon in spec)) {
      spec[canon] = spec[alias];
      delete spec[alias];
      notes.push(`${alias}\u2192${canon}`);
    }
  }
  if (typeof spec.color === "string" && !("fills" in spec)) {
    spec.fills = [{ type: "SOLID", color: spec.color }];
    delete spec.color;
    notes.push("color\u2192fills");
  }
  if (Array.isArray(spec.children)) for (const c of spec.children) normalizeWriteSpec(c, notes);
  return notes;
}
function aliasPath(path) {
  const canon = /^[A-Za-z_$][\w$]*$/.test(path) ? FIELD_ALIASES[path] : void 0;
  return canon ? { path: canon, note: `${path}\u2192${canon}` } : { path, note: null };
}
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
  const shape = { type: import_zod3.z.literal(type) };
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
  return import_zod3.z.object(shape).passthrough();
}
var NODE_SCHEMAS = Object.fromEntries(
  NODE_TYPES.map((t) => [t, compose(t)])
);
function rejectReadOnly(spec, ctx) {
  for (const key of Object.keys(spec)) {
    if (key in READ_ONLY_KEYS) {
      ctx.addIssue({ code: import_zod3.z.ZodIssueCode.custom, message: READ_ONLY_KEYS[key], path: [key] });
    } else if (key in FIELD_REDIRECTS) {
      ctx.addIssue({ code: import_zod3.z.ZodIssueCode.custom, message: FIELD_REDIRECTS[key], path: [key] });
    }
  }
}
var writeNodeUnion = import_zod3.z.lazy(
  () => import_zod3.z.discriminatedUnion("type", NODE_TYPES.map((t) => NODE_SCHEMAS[t])).superRefine((spec, ctx) => {
    rejectReadOnly(spec, ctx);
    if (spec.type === "INSTANCE" && !spec.componentId && !spec.componentKey) {
      ctx.addIssue({ code: import_zod3.z.ZodIssueCode.custom, message: "INSTANCE needs componentId (local) or componentKey (published)", path: ["componentId"] });
    }
    if (spec.type === "SVG" && !spec.svg && !spec.svgUrl) {
      ctx.addIssue({ code: import_zod3.z.ZodIssueCode.custom, message: "SVG needs `svg` markup or `svgUrl`", path: ["svg"] });
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
FIELD_SCHEMAS.width = import_zod3.z.number().positive();
FIELD_SCHEMAS.height = import_zod3.z.number().positive();
function validateEditValue(path, value) {
  const segs = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  if (!segs.length) return null;
  if (segs[0] in READ_ONLY_KEYS) return READ_ONLY_KEYS[segs[0]];
  if (segs.length === 1 && segs[0] in FIELD_REDIRECTS) return FIELD_REDIRECTS[segs[0]];
  const endsWithIndex = /^\d+$/.test(segs[segs.length - 1]);
  const leaf = [...segs].reverse().find((s) => !/^\d+$/.test(s));
  if (!leaf) return null;
  let schema;
  if (leaf === "color") schema = Color;
  else if (leaf === "fills" || leaf === "strokes") schema = endsWithIndex ? Paint : import_zod3.z.array(Paint);
  else schema = FIELD_SCHEMAS[leaf] ?? null;
  if (!schema) return null;
  const r = schema.safeParse(value);
  if (r.success) return null;
  return r.error.issues[0]?.message ?? "invalid value";
}

// src/socket.ts
var import_os2 = require("os");
var import_path2 = require("path");
var channels = /* @__PURE__ */ new Map();
var pluginChannels = /* @__PURE__ */ new Map();
var ACTIVE_CHANNELS_FILE = (0, import_path2.join)((0, import_os2.tmpdir)(), "figma-active-channels.json");
function writeActiveChannels() {
  const byChannel = /* @__PURE__ */ new Map();
  for (const { channel, meta } of pluginChannels.values()) {
    const entry = byChannel.get(channel) ?? { channel, clients: channels.get(channel)?.size ?? 0 };
    if (meta) entry.meta = meta;
    byChannel.set(channel, entry);
  }
  const payload = {
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    channels: [...byChannel.values()]
  };
  Bun.write(ACTIVE_CHANNELS_FILE, JSON.stringify(payload, null, 2)).catch(
    (err) => console.error("Failed to write active channels file:", err)
  );
}
function handleConnection(ws2) {
  console.log("New client connected");
  ws2.send(JSON.stringify({
    type: "system",
    message: "Please join a channel to start chatting"
  }));
  ws2.close = () => {
    console.log("Client disconnected");
    channels.forEach((clients, channelName) => {
      if (clients.has(ws2)) {
        clients.delete(ws2);
        clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: "system",
              message: "A user has left the channel",
              channel: channelName
            }));
          }
        });
      }
    });
  };
}
function startRelay(port = 3055) {
  let server2;
  try {
    server2 = Bun.serve({
      port,
      // uncomment this to allow connections in windows wsl
      // hostname: "0.0.0.0",
      fetch(req, server3) {
        if (req.method === "OPTIONS") {
          return new Response(null, {
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization"
            }
          });
        }
        const success = server3.upgrade(req, {
          headers: {
            "Access-Control-Allow-Origin": "*"
          }
        });
        if (success) {
          return;
        }
        return new Response("WebSocket server running", {
          headers: {
            "Access-Control-Allow-Origin": "*"
          }
        });
      },
      websocket: {
        open: handleConnection,
        message(ws2, message) {
          try {
            const data = JSON.parse(message);
            console.log(`
=== Received message from client ===`);
            console.log(`Type: ${data.type}, Channel: ${data.channel || "N/A"}`);
            if (data.message?.command) {
              console.log(`Command: ${data.message.command}, ID: ${data.id}`);
            } else if (data.message?.result) {
              console.log(`Response: ID: ${data.id}, Has Result: ${!!data.message.result}`);
            }
            console.log(`Full message:`, JSON.stringify(data, null, 2));
            if (data.type === "ping") {
              ws2.send(JSON.stringify({ type: "pong" }));
              return;
            }
            if (data.type === "meta") {
              const entry = pluginChannels.get(ws2);
              if (entry) {
                entry.meta = data.meta;
                writeActiveChannels();
              }
              return;
            }
            if (data.type === "join") {
              const channelName = data.channel;
              if (!channelName || typeof channelName !== "string") {
                ws2.send(JSON.stringify({
                  type: "error",
                  message: "Channel name is required"
                }));
                return;
              }
              if (!channels.has(channelName)) {
                channels.set(channelName, /* @__PURE__ */ new Set());
              }
              const channelClients = channels.get(channelName);
              channelClients.add(ws2);
              console.log(`
\u2713 Client joined channel "${channelName}" (${channelClients.size} total clients)`);
              if (data.role === "plugin") {
                pluginChannels.set(ws2, { channel: channelName, meta: data.meta });
                writeActiveChannels();
              }
              ws2.send(JSON.stringify({
                type: "system",
                message: `Joined channel: ${channelName}`,
                channel: channelName
              }));
              ws2.send(JSON.stringify({
                type: "system",
                message: {
                  id: data.id,
                  result: "Connected to channel: " + channelName
                },
                channel: channelName
              }));
              channelClients.forEach((client) => {
                if (client !== ws2 && client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({
                    type: "system",
                    message: "A new user has joined the channel",
                    channel: channelName
                  }));
                }
              });
              return;
            }
            if (data.type === "message") {
              const channelName = data.channel;
              if (!channelName || typeof channelName !== "string") {
                ws2.send(JSON.stringify({
                  type: "error",
                  message: "Channel name is required"
                }));
                return;
              }
              const channelClients = channels.get(channelName);
              if (!channelClients || !channelClients.has(ws2)) {
                ws2.send(JSON.stringify({
                  type: "error",
                  message: "You must join the channel first"
                }));
                return;
              }
              let broadcastCount = 0;
              channelClients.forEach((client) => {
                if (client !== ws2 && client.readyState === WebSocket.OPEN) {
                  broadcastCount++;
                  const broadcastMessage = {
                    type: "broadcast",
                    message: data.message,
                    sender: "peer",
                    channel: channelName
                  };
                  console.log(`
=== Broadcasting to peer #${broadcastCount} ===`);
                  console.log(JSON.stringify(broadcastMessage, null, 2));
                  client.send(JSON.stringify(broadcastMessage));
                }
              });
              if (broadcastCount === 0) {
                console.log(`\u26A0\uFE0F  No other clients in channel "${channelName}" to receive message!`);
                ws2.send(JSON.stringify({
                  type: "error",
                  id: data.message?.id,
                  message: {
                    id: data.message?.id,
                    error: `No client is connected to channel "${channelName}" to handle the command. Is the Figma plugin still connected?`
                  },
                  channel: channelName
                }));
              } else {
                console.log(`\u2713 Broadcast to ${broadcastCount} peer(s) in channel "${channelName}"`);
              }
            }
            if (data.type === "progress_update") {
              const channelName = data.channel;
              if (!channelName) return;
              const channelClients = channels.get(channelName);
              if (!channelClients || !channelClients.has(ws2)) return;
              channelClients.forEach((client) => {
                if (client !== ws2 && client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify(data));
                }
              });
            }
          } catch (err) {
            console.error("Error handling message:", err);
          }
        },
        close(ws2) {
          channels.forEach((clients) => {
            clients.delete(ws2);
          });
          if (pluginChannels.delete(ws2)) {
            writeActiveChannels();
          }
        }
      }
    });
  } catch (err) {
    if (err?.code === "EADDRINUSE" || /in use|EADDRINUSE/i.test(String(err?.message))) {
      return null;
    }
    throw err;
  }
  console.log(`WebSocket server running on port ${server2.port}`);
  return server2;
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
var server = new import_mcp.McpServer({
  name: "TalkToFigmaMCP",
  version: "1.0.0"
});
var args = process.argv.slice(2);
var serverArg = args.find((arg) => arg.startsWith("--server="));
var serverUrl = serverArg ? serverArg.split("=")[1] : "localhost";
var WS_URL = serverUrl === "localhost" ? `ws://${serverUrl}` : `wss://${serverUrl}`;
var saveParams = {
  saveToFile: import_zod4.z.boolean().optional().describe(
    "If true, write the full result to a file and return only its path + byte size instead of the payload. Use for large outputs to keep them out of the LLM context."
  ),
  outputPath: import_zod4.z.string().optional().describe(
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
  else if (url.startsWith("~/")) localPath = (0, import_path3.join)((0, import_os3.homedir)(), url.slice(2));
  let buf;
  if (localPath !== void 0) {
    buf = await (0, import_promises.readFile)(localPath);
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
  const target = outputPath ? outputPath : (0, import_path3.join)((0, import_os3.tmpdir)(), "talk-to-figma", `${safeBase}-${Date.now()}-${outputFileSeq++}.${ext}`);
  await (0, import_promises.mkdir)((0, import_path3.dirname)(target), { recursive: true });
  await (0, import_promises.writeFile)(target, data);
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
  depth: import_zod4.z.number().int().min(0).optional().describe("Levels of children below the requested node to expand (default 6). Deeper nodes become stubs with {childCount, more:true}; re-request that id to zoom in. Raise to see more at once, lower for a terser overview."),
  collapseIcons: import_zod4.z.boolean().optional().describe("Collapse icon-like subtrees (no text, vector leaves) to a single ICON node with more:true (default true)."),
  collapseRepeats: import_zod4.z.boolean().optional().describe("Collapse repeated instances of the same component: the first renders in full, later copies become a stub with their props/text and more:true (default true)."),
  cull: import_zod4.z.boolean().optional().describe("Drop nodes that render nowhere \u2014 fully clipped out by an ancestor's clipsContent ({id, clipped:true}) or fully covered by an opaque sibling above ({id, occluded:true}). Default true.")
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
  'Read Figma nodes \u2014 the canvas\'s Read tool. `nodeIds` one or many; omit to read the selection. `fields`: "auto" (DEFAULT) = compact low-token subtree (id, name, type, color/gradient, opacity, box or autoLayout, text); "all" = every JSON_REST_V1 property; or an array of field paths (e.g. ["fills","effects","absoluteBoundingBox"]; query_nodes dot/[i]/[*] syntax) returned flat-keyed by path, id/name/type always kept. In "auto", children expand `depth` levels (default 6) and deeper nodes become {childCount, more:true} stubs \u2014 re-request a stub\'s id or raise depth to zoom in; each node carries an `ancestors` breadcrumb (root-first `id:"name".TYPE` tokens, as glob lines \u2014 pass one back to zoom OUT). For "all"/array modes `depth` defaults to 0 (node alone); collapse/cull and ancestors apply to "auto" only. Use "all"/a field array when "auto" drops a field you need. Large outputs spill to a file. Ids are short counters (n0, n1, ...) standing in for canonical Figma ids. Locate ids with glob_nodes/grep_nodes first.',
  {
    nodeIds: import_zod4.z.array(import_zod4.z.string()).optional().describe("Node ids to read (short n0,... or canonical). Omit to read the current selection."),
    fields: import_zod4.z.union([import_zod4.z.literal("auto"), import_zod4.z.literal("all"), import_zod4.z.array(import_zod4.z.string())]).optional().describe('What to return per node: "auto" (default) = compact low-token subtree; "all" = every JSON_REST_V1 property; string[] = only those field paths (query_nodes path syntax, flat-keyed by path, id/name/type always kept). For "all"/array modes `depth` controls children (default 0).'),
    ...shapeParams,
    ...saveParams
  },
  async ({ nodeIds, fields, depth, collapseIcons, collapseRepeats, cull, saveToFile, outputPath }) => {
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
      let mode = fields == null ? "auto" : fields;
      const aliasNotes = [];
      if (Array.isArray(mode)) {
        mode = mode.map((p) => {
          const { path, note } = aliasPath(p);
          if (note) aliasNotes.push(note);
          return path;
        });
      }
      if (mode !== "auto") {
        const rawDepth = depth ?? 0;
        const nodes = await Promise.all(
          ids.map(async (nodeId) => ({
            requestedId: nodeId,
            node: await sendCommandToFigma("read_node_raw", { nodeId, fields: mode, depth: rawDepth })
          }))
        );
        const content = [await jsonContent(nodes, { saveToFile, outputPath }, "node-raw")];
        if (aliasNotes.length) content.unshift({ type: "text", text: `(auto-corrected fields: ${[...new Set(aliasNotes)].join(", ")})` });
        return { content };
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
  'List nodes under a root by type and/or name glob \u2014 a flat, grep-friendly subtree index (Figma\'s glob / `ls -R`). One per line: `id:"name".TYPE @parent [x,y wxh]`, where `@parent` is the immediate container\'s short id and `[x,y wxh]` is the ABSOLUTE bounding box (dropped by `bbox:false` or when the node has no geometry). Filters: `type` (a type, an array, or "*"/omit for any); `name` (shell glob over the node\'s OWN name \u2014 `*`/`?`, case-insensitive, names not paths since Figma names contain slashes); `within` (absolute rect \u2014 keep only nodes intersecting it). `root` defaults to the current page and is searched at any depth (`depth` caps it). Ids (including `@parent`) are short counters (n0, n1, ...) usable in any tool.',
  {
    root: import_zod4.z.string().optional().describe("Node id to search under. Defaults to the current page. Accepts short ids (n0, ...)."),
    name: import_zod4.z.string().optional().describe("Shell-style glob matched against each node's own name (* = any run, ? = one char). Case-insensitive. Omit to match any name."),
    type: import_zod4.z.union([import_zod4.z.string(), import_zod4.z.array(import_zod4.z.string())]).optional().describe('Node type filter: a single type (e.g. "TEXT"), an array (["TEXT","INSTANCE"]), or "*"/omit for any. Case-insensitive.'),
    depth: import_zod4.z.number().optional().describe("Max depth below root to descend (root's direct children = 1). Omit for unlimited."),
    bbox: import_zod4.z.boolean().optional().describe("Append each hit's absolute bounding box as [x,y wxh]. Default true; pass false to drop it and save tokens."),
    within: import_zod4.z.object({
      x: import_zod4.z.number(),
      y: import_zod4.z.number(),
      width: import_zod4.z.number(),
      height: import_zod4.z.number()
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
  'Regex-search the TEXT content of a subtree \u2014 Figma\'s grep. Tests each TEXT node\'s `characters` LINE BY LINE and returns hits as `id:"name".TEXT @parent L<n>: <line>` (`L<n>` = 1-based line within the node; long lines windowed around the match; `onlyMatch:true` returns just the matched substrings, like grep -o). Searches CONTENT, not names \u2014 for names use glob_nodes\' `name`. `pattern` is a JS regex (not a shell glob); `ignoreCase` adds the `i` flag. Scope with `root` (default current page), `depth`, `within` (absolute rect \u2014 only nodes intersecting it). `mode`: "content" (default, every matching line), "nodes" (one line per node + hit count, like grep -l), or "count" (totals only). Caps at `maxMatches` line-hits (default 1000), appending `(truncated)`. Ids (and `@parent`) are short counters (n0, n1, ...).',
  {
    pattern: import_zod4.z.string().describe('JavaScript regular expression source (NOT a shell glob). E.g. "\\\\bCTA\\\\b", "\\\\$\\\\d+", "left$".'),
    root: import_zod4.z.string().optional().describe("Node id to search under. Defaults to the current page. Accepts short ids (n0, ...)."),
    ignoreCase: import_zod4.z.boolean().optional().describe("Case-insensitive match (regex `i` flag). Default false."),
    onlyMatch: import_zod4.z.boolean().optional().describe("Report only the matched substring(s) per line instead of the whole line (grep -o). Default false."),
    mode: import_zod4.z.enum(["content", "nodes", "count"]).optional().describe('Output shape: "content" (default; each matching line), "nodes" (one line per matching node + its hit count), or "count" (totals only).'),
    depth: import_zod4.z.number().optional().describe("Max depth below root to descend (root's direct children = 1). Omit for unlimited."),
    within: import_zod4.z.object({
      x: import_zod4.z.number(),
      y: import_zod4.z.number(),
      width: import_zod4.z.number(),
      height: import_zod4.z.number()
    }).optional().describe("Absolute rectangle; keep only TEXT nodes whose bounding box intersects it. Same coordinate space as glob_nodes' [x,y wxh]."),
    bbox: import_zod4.z.boolean().optional().describe("Append each hit node's absolute bounding box as [x,y wxh]. Default false."),
    maxMatches: import_zod4.z.number().optional().describe("Hard cap on collected line-hits before the walk stops. Default 1000."),
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
  "Find nodes by predicates on their STRUCTURE \u2014 the node model's fields, not flat text. `where` is an array of `{path, op, value}` predicates, AND-combined; hits return as `id:\"name\".TYPE @parent {path=value, ...}`. `path` walks the node JSON: dot for objects, `[i]` for an index, `[*]` for any array element (e.g. `fills[*].color`, `boundVariables.fills`, `fontSize`, `name`, `type`). Ops: `regex` (DEFAULT, case-insensitive with `i:true`; covers equality/contains/oneOf \u2014 the right op for strings/ids/enums/numbers-as-text); `gt`/`gte`/`lt`/`lte` (numeric, what regex can't do \u2014 e.g. fontSize<12); `color` (value `#RRGGBB`, matches a Figma rgb 0-1 color with tolerance); `exists`/`absent` (KEY presence, no value \u2014 `absent` finds nodes MISSING a field, e.g. `boundVariables.fills` absent = a fill NOT bound to a token, the core design-system audit). Scope with `root` (default current page), `depth`, `within` (absolute rect); `bbox:true` appends [x,y wxh]. Caps at `maxMatches` (default 1000). Ids (and `@parent`) are short counters. For raw authored copy use grep_nodes; for a type/name index use glob_nodes.",
  {
    where: import_zod4.z.array(
      import_zod4.z.object({
        path: import_zod4.z.string().describe('Field path on the node. Dot for objects, [i] for an index, [*] for any array element. E.g. "fontSize", "fills[*].color", "boundVariables.fills", "name".'),
        op: import_zod4.z.enum(["regex", "gt", "gte", "lt", "lte", "color", "exists", "absent"]).optional().describe('Match op. Default "regex". Use gt/gte/lt/lte for numbers, color for #RRGGBB, exists/absent for key presence (no value needed).'),
        value: import_zod4.z.union([import_zod4.z.string(), import_zod4.z.number(), import_zod4.z.boolean()]).optional().describe('Comparison value. Regex source for "regex", a number for compares, "#RRGGBB" for color. Omit for exists/absent.'),
        i: import_zod4.z.boolean().optional().describe('Case-insensitive regex (only for op "regex"). Default false.')
      })
    ).min(1).describe("Predicates, AND-combined. At least one required."),
    root: import_zod4.z.string().optional().describe("Node id to search under. Defaults to the current page. Accepts short ids (n0, ...)."),
    depth: import_zod4.z.number().optional().describe("Max depth below root to descend (root's direct children = 1). Omit for unlimited."),
    within: import_zod4.z.object({
      x: import_zod4.z.number(),
      y: import_zod4.z.number(),
      width: import_zod4.z.number(),
      height: import_zod4.z.number()
    }).optional().describe("Absolute rectangle; keep only nodes whose bounding box intersects it. Same coordinate space as glob_nodes' [x,y wxh]."),
    bbox: import_zod4.z.boolean().optional().describe("Append each hit's absolute bounding box as [x,y wxh]. Default false."),
    maxMatches: import_zod4.z.number().optional().describe("Hard cap on collected hits before the walk stops. Default 1000."),
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
  'Edit node properties directly in the node model \u2014 the write twin of query_nodes/read_node, an Edit tool for Figma JSON. `edits` is an array of `{nodeId, path, old?, new}`. `path` addresses one field like query_nodes \u2014 dot for objects, `[i]` for an index (e.g. `name`, `cornerRadius`, `fills[0].color`, `fills[0].opacity`); no `[*]`, a write needs one target. `new` is the value: `#RRGGBB` colors convert to Figma rgb 0-1, and whole objects/arrays are allowed (set `fills[0]` to a full paint). `old` is an OPTIONAL guard like Edit\'s old_string \u2014 if it doesn\'t match the current value (colors as hex, numbers tolerantly), that edit is rejected so you never blind-overwrite a stale read. Edits run in order and are INDEPENDENT \u2014 one failing (guard mismatch, read-only/derived prop, type Figma rejects, font not loaded) records its error, the rest apply; result is `\u2713 id path: old \u2192 new` / `\u2717 id path: <error>`. One call can touch many nodes \u2014 this is also how you bulk-replace text: one `{nodeId, path:"characters", new:"..."}` per text node (the `characters` path loads its font for you). Large batches stream progress. Common paths: `name`, `characters`, `x`/`y`, `width`/`height` (resize), `cornerRadius`, `fills[0].color` (#RRGGBB), `opacity`, `layoutMode`, `paddingTop`, `itemSpacing`, `primaryAxisAlignItems`, `layoutSizingHorizontal`. INSTANCE variant/prop swap: edit `componentProperties.<PropName>` (the names read_node shows) \u2014 `{path:"componentProperties.Size", new:"Large"}` swaps a VARIANT; BOOLEAN/TEXT props work the same (bare name, the #id suffix is matched for you); routes through Figma\'s setProperties since the map is read-only. An INSTANCE_SWAP prop takes a component id/key as `new` (use a FULL Figma id \u2014 short n-ids aren\'t remapped inside a value). Bind a style: set `fillStyleId`/`strokeStyleId`/`effectStyleId`/`gridStyleId`/`textStyleId` to a style id (from get_styles/write_styles), `""` detaches. nodeId accepts short (n0, ...) or full Figma ids.',
  {
    edits: import_zod4.z.array(
      import_zod4.z.object({
        nodeId: import_zod4.z.string().describe("Node to edit. Short ids (n0, ...) or full Figma ids."),
        path: import_zod4.z.string().describe('Field path to write. Dot for objects, [i] for an array index. Same syntax as query_nodes, but no [*]. E.g. "name", "cornerRadius", "fills[0].color".'),
        old: import_zod4.z.any().optional().describe("Optional guard: expected current value (Edit-style). Colors as #RRGGBB. Mismatch rejects only this edit."),
        new: import_zod4.z.any().describe("Value to set. #RRGGBB \u2192 Figma rgb; numbers/strings/objects/arrays allowed.")
      })
    ).min(1).describe("Edits applied in order; each independent \u2014 one failing does not abort the rest.")
  },
  async ({ edits }) => {
    try {
      const valid = [];
      const rejected = [];
      const aliasNotes = [];
      for (const raw of edits) {
        const { path, note } = aliasPath(raw.path);
        const e = note ? { ...raw, path } : raw;
        if (note) aliasNotes.push(note);
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
      if (aliasNotes.length) rows.push(`(auto-corrected fields: ${[...new Set(aliasNotes)].join(", ")})`);
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
  "Move existing nodes to a new parent and/or z-order slot \u2014 the structural move edit_nodes can't do (it only writes value properties, never `parent`/`index`). `moves` is an array of `{nodeId, parentId?, index?}`. `parentId` re-parents into that container (FRAME, GROUP, SECTION, COMPONENT, or a page). `index` sets the sibling slot \u2014 0 = bottom of z-order / first in auto-layout, larger is later, out-of-range pins to the end. Give `parentId` to move, `index` alone to REORDER in place, or both. Moves are INDEPENDENT \u2014 one failing (node/parent not found, parent can't hold children, moving into its own descendant) records its error, the rest run. Re-parenting keeps the node's LOCAL x/y, so absolute position shifts when the new parent is elsewhere (set x/y via edit_nodes after); inside an auto-layout parent x/y is ignored and `index` controls order. Result: `\u2713 id \"name\": parent#oldIndex \u2192 parent#newIndex` / `\u2717 id: <error>`.",
  {
    moves: import_zod4.z.array(
      import_zod4.z.object({
        nodeId: import_zod4.z.string().describe("Node to move. Short ids (n0, ...) or full Figma ids."),
        parentId: import_zod4.z.string().optional().describe("New parent container. Omit to reorder within the current parent. Short ids (n0, ...) or full Figma ids."),
        index: import_zod4.z.number().int().optional().describe("Position among siblings (0 = bottom/first). Omit to append. Out-of-range pins to the end.")
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
  'Create new nodes from raw Figma JSON \u2014 the create twin of edit_nodes, a Write tool for the node tree. `nodes` is an array of specs `{type, ...props, children?}`. `type` is the node type to create (RECTANGLE, FRAME, TEXT, ELLIPSE, LINE, STAR, POLYGON, VECTOR, COMPONENT, SECTION, SLICE, INSTANCE). Every other key is a property written like edit_nodes \u2014 `name`, `x`, `y`, `cornerRadius`, `opacity`, `fills`, `layoutMode`, `paddingTop`, `itemSpacing`, etc., same rules: `#RRGGBB` colors convert to Figma rgb 0-1 (`fills:[{type:"SOLID",color:"#3366ff"}]`), `width`/`height` route through resize(), and a TEXT `characters` loads the font for you. Placement: `parentId` appends into a container (default current page), `index` sets the sibling slot. `children` is an array of the same spec shape, created recursively \u2014 write a whole subtree (frame \u2192 rows \u2192 text) in one call. Specs are INDEPENDENT \u2014 a spec whose factory/parent lookup fails records its error and siblings still create; within a node a single bad property (padding with no layoutMode, a value Figma rejects) is reported per-property and the node survives. INSTANCE needs `componentId` (local, from get_local_components) or `componentKey` (published); add `componentProperties:{PropName:value}` for variants / boolean\xB7text\xB7swap props (via setProperties). IMAGE fills: `{type:"IMAGE", imageUrl:"https://\u2026", scaleMode:"FILL"}` in `fills` \u2014 imageUrl also accepts a LOCAL FILE PATH (`/abs/path.png`, `~/pic.png`, `file://\u2026`) read from disk; the server fetches/reads and imports the bytes (no imageHash); same in edit_nodes. SVG: `type:"SVG"` with `svg:"<svg\u2026>"` markup or `svgUrl` (URL or local path, fetched/read server-side). Result is a tree of `\u2713 <id> <TYPE> "<name>"` / `\u2717 <error>`, with `! key: <error>` lines for rejected properties. Large batches stream progress.',
  {
    nodes: import_zod4.z.array(import_zod4.z.record(import_zod4.z.any())).min(1).describe("Node specs, each `{type, ...props, children?}`. Created in order, independent \u2014 one failing does not abort the rest.")
  },
  async ({ nodes }) => {
    try {
      const valid = [];
      const rejected = [];
      const aliasNotes = [];
      for (const spec of nodes) {
        const notes = normalizeWriteSpec(spec);
        if (notes.length) aliasNotes.push(...notes);
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
      if (aliasNotes.length) {
        const uniq = [...new Set(aliasNotes)];
        lines.push(`(auto-corrected fields: ${uniq.join(", ")})`);
      }
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
  'Get the WRITE-side schema for a node type \u2014 the fields write_nodes accepts when CREATING it (not the REST shape read_node returns). Pass `type` (e.g. "TEXT") to see its fields, enum values, and ranges; omit `type` to list creatable types. This is the exact schema write_nodes validates against, but write_nodes also passes through any other Figma property, so the list is the curated common set, not an exhaustive cap.',
  {
    type: import_zod4.z.enum(NODE_TYPES).optional().describe("Node type to describe (FRAME, TEXT, ...). Omit to list all creatable types.")
  },
  async ({ type }) => {
    const text = type ? describeNodeSchema(type) : listNodeTypes();
    return { content: [{ type: "text", text }] };
  }
);
server.tool(
  "clone_node",
  'Clone existing nodes \u2014 one or many in one call. Each clone is a deep copy that lands next to its source (same parent; use reparent_nodes to move it). Clones are independent \u2014 one failing records its error, the rest still clone. To vary text/props per clone, follow with edit_nodes on the returned ids; to create many component INSTANCES at different spots with different variant/text props, prefer write_nodes with INSTANCE specs instead. Result: `\u2713 <id> "<name>"` or `\u2717 <error>` per clone.',
  {
    nodeId: import_zod4.z.string().optional().describe("Source node id, single form. Short ids n0,... or full Figma ids."),
    x: import_zod4.z.number().optional().describe("Absolute canvas X (single form)."),
    y: import_zod4.z.number().optional().describe("Absolute canvas Y (single form)."),
    clones: import_zod4.z.array(
      import_zod4.z.object({
        nodeId: import_zod4.z.string().describe("Source node id (short n0,... or full Figma id)."),
        x: import_zod4.z.number().optional().describe("Absolute canvas X, as glob_nodes reports. Ignored if the parent is auto-layout; omit to stack on the source."),
        y: import_zod4.z.number().optional().describe("Absolute canvas Y.")
      })
    ).min(1).optional().describe("Batch form: one `{nodeId, x?, y?}` per clone.")
  },
  async ({ nodeId, x, y, clones }) => {
    try {
      const specs = Array.isArray(clones) && clones.length ? clones : nodeId ? [{ nodeId, x, y }] : [];
      if (!specs.length) {
        return { content: [{ type: "text", text: "Error cloning node: provide `nodeId` (single) or a non-empty `clones` array (batch)" }] };
      }
      const result = await sendCommandToFigma("clone_node", { clones: specs });
      const renumber = (id) => renumberIds({ id }).id;
      const lines = (result?.results || []).map(
        (r) => r.ok ? `\u2713 ${renumber(r.id)} "${r.name}"` : `\u2717 ${r.nodeId ? renumber(r.nodeId) + ": " : ""}${r.error}`
      );
      const text = `cloned ${result?.cloned ?? 0}/${result?.total ?? specs.length}` + (lines.length ? "\n" + lines.join("\n") : "");
      return { content: [{ type: "text", text }] };
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
    nodeIds: import_zod4.z.array(import_zod4.z.string()).describe("Array of node IDs to delete")
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
    nodes: import_zod4.z.array(
      import_zod4.z.object({
        nodeId: import_zod4.z.string().describe("The ID of the node to export"),
        scale: import_zod4.z.union([import_zod4.z.number().positive(), import_zod4.z.array(import_zod4.z.number().positive()).nonempty()]).optional().describe(
          "Export scale(s): a single number, or an array to emit one image per scale. Only applies to raster formats (PNG/JPG); ignored for SVG/PDF. Default 1."
        )
      })
    ).nonempty().describe("Nodes to export. Each entry exports its node at its own scale(s)."),
    format: import_zod4.z.enum(["PNG", "JPG", "SVG", "PDF"]).optional().describe("Export format shared by all nodes (default PNG)."),
    inline: import_zod4.z.boolean().optional().describe(
      `Return the image(s) directly in the response instead of writing files, so you can see them. Set this whenever you want to look at how something renders \u2014 and pair it with a small scale (e.g. 0.5) to keep it cheap. Honored only for raster formats (PNG/JPG) whose encoded size is under ${INLINE_MAX_BYTES / 1024}KB \u2014 anything larger (or SVG/PDF) falls back to a file to avoid blowing up the context.`
    ),
    outputDir: import_zod4.z.string().optional().describe(
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
          const target = outputDir ? (0, import_path3.join)(outputDir, `${baseName}.${ext}`) : void 0;
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
  id: import_zod4.z.string().optional().describe("Existing style id (edit_styles: match by id; also accepted on write to fail loudly if reused)"),
  type: import_zod4.z.enum(["PAINT", "TEXT", "EFFECT", "GRID"]).optional().describe("Style kind \u2014 required for write_styles and for edit_styles when matching by name"),
  name: import_zod4.z.string().optional().describe("Style name; '/' creates folders (e.g. 'brand/primary'). Required on write."),
  description: import_zod4.z.string().optional(),
  // PAINT
  paints: import_zod4.z.array(import_zod4.z.any()).optional().describe("PAINT: array of Figma Paint objects (SOLID/GRADIENT/IMAGE). Hex strings in a `color` field are accepted."),
  paint: import_zod4.z.any().optional().describe("PAINT: single Paint object shorthand for one-paint styles"),
  color: import_zod4.z.string().optional().describe("PAINT: hex shorthand ('#RRGGBB'/'#RRGGBBAA') for a single solid fill"),
  opacity: import_zod4.z.number().optional().describe("PAINT: opacity 0-1 for the `color` shorthand"),
  // TEXT
  fontName: import_zod4.z.object({ family: import_zod4.z.string(), style: import_zod4.z.string() }).optional().describe("TEXT: {family, style} \u2014 loaded before applying"),
  fontSize: import_zod4.z.number().optional().describe("TEXT: font size in px"),
  lineHeight: import_zod4.z.any().optional().describe("TEXT: number (PIXELS shorthand) or {value, unit: PIXELS|PERCENT} or {unit: AUTO}"),
  letterSpacing: import_zod4.z.any().optional().describe("TEXT: number (PIXELS shorthand) or {value, unit: PIXELS|PERCENT}"),
  paragraphSpacing: import_zod4.z.number().optional().describe("TEXT: spacing between paragraphs in px"),
  paragraphIndent: import_zod4.z.number().optional().describe("TEXT: first-line indent in px"),
  textCase: import_zod4.z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional(),
  textDecoration: import_zod4.z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
  // EFFECT
  effects: import_zod4.z.array(import_zod4.z.any()).optional().describe("EFFECT: array of Figma Effect objects (DROP_SHADOW/INNER_SHADOW/LAYER_BLUR/BACKGROUND_BLUR). Hex in a `color` field is accepted."),
  // GRID
  layoutGrids: import_zod4.z.array(import_zod4.z.any()).optional().describe("GRID: array of Figma LayoutGrid objects (GRID/COLUMNS/ROWS).")
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
    styles: import_zod4.z.array(import_zod4.z.object(styleSpecShape)).min(1).describe("Styles to create")
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
    styles: import_zod4.z.array(import_zod4.z.object({ ...styleSpecShape, remove: import_zod4.z.boolean().optional().describe("Delete this style instead of updating it") })).min(1).describe("Styles to update or remove")
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
    nodeId: import_zod4.z.string().describe("node ID to get annotations for specific node"),
    includeCategories: import_zod4.z.boolean().optional().default(true).describe("Whether to include category information"),
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
  "Create or update native Figma annotations. `annotations` is an array of `{nodeId, labelMarkdown, categoryId?, annotationId?, properties?}` \u2014 each annotates its `nodeId` with markdown; pass `annotationId` to update an existing one, `categoryId` to file it under a category (from get_annotations). Entries are INDEPENDENT \u2014 one failing records its error, the rest apply. Large batches stream progress. Result: `\u2713 <id>` / `\u2717 <id>: <error>`.",
  {
    annotations: import_zod4.z.array(
      import_zod4.z.object({
        nodeId: import_zod4.z.string().describe("The ID of the node to annotate"),
        labelMarkdown: import_zod4.z.string().describe("The annotation text in markdown format"),
        categoryId: import_zod4.z.string().optional().describe("The ID of the annotation category"),
        annotationId: import_zod4.z.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
        properties: import_zod4.z.array(import_zod4.z.object({
          type: import_zod4.z.string()
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
    nodeId: import_zod4.z.string().optional().describe("Optional ID of the component instance to get overrides from. If not provided, currently selected instance will be used.")
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
    sourceInstanceId: import_zod4.z.string().describe("ID of the source component instance"),
    targetNodeIds: import_zod4.z.array(import_zod4.z.string()).describe("Array of target instance IDs. Currently selected instances will be used.")
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
    nodeIds: import_zod4.z.array(import_zod4.z.string()).describe("Array of node IDs to get reactions from"),
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
var transitionSchema = import_zod4.z.object({
  type: import_zod4.z.enum([
    "DISSOLVE",
    "SMART_ANIMATE",
    "SCROLL_ANIMATE",
    "MOVE_IN",
    "MOVE_OUT",
    "PUSH",
    "SLIDE_IN",
    "SLIDE_OUT"
  ]).describe("Animation style for the navigation"),
  easing: import_zod4.z.object({ type: import_zod4.z.string() }).passthrough().optional(),
  duration: import_zod4.z.number().optional().describe("Duration in seconds"),
  direction: import_zod4.z.enum(["LEFT", "RIGHT", "TOP", "BOTTOM"]).optional(),
  matchLayers: import_zod4.z.boolean().optional().describe("SMART_ANIMATE: match layers by name")
}).passthrough();
var reactionActionSchema = import_zod4.z.object({
  type: import_zod4.z.enum([
    "BACK",
    "CLOSE",
    "URL",
    "NODE",
    "SET_VARIABLE",
    "SET_VARIABLE_MODE",
    "CONDITIONAL",
    "UPDATE_MEDIA_RUNTIME"
  ]).describe("Action kind. NODE = navigate/overlay/swap to another frame."),
  url: import_zod4.z.string().optional().describe("URL action: link to open"),
  destinationId: import_zod4.z.string().nullable().optional().describe("NODE action: target node id (the frame to navigate/swap/overlay to)"),
  navigation: import_zod4.z.enum(["NAVIGATE", "SWAP", "OVERLAY", "SCROLL_TO", "CHANGE_TO"]).optional().describe("NODE action: how the destination is presented"),
  transition: transitionSchema.nullable().optional(),
  preserveScrollPosition: import_zod4.z.boolean().optional(),
  overlayRelativePosition: import_zod4.z.object({ x: import_zod4.z.number(), y: import_zod4.z.number() }).optional(),
  resetVideoPosition: import_zod4.z.boolean().optional(),
  resetScrollPosition: import_zod4.z.boolean().optional(),
  resetInteractionState: import_zod4.z.boolean().optional()
}).passthrough();
var reactionTriggerSchema = import_zod4.z.object({
  type: import_zod4.z.enum([
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
  timeout: import_zod4.z.number().optional().describe("AFTER_TIMEOUT: delay in seconds"),
  delay: import_zod4.z.number().optional().describe("MOUSE_* triggers: delay in seconds"),
  device: import_zod4.z.string().optional().describe("ON_KEY_DOWN: input device (e.g. KEYBOARD)"),
  keyCodes: import_zod4.z.array(import_zod4.z.number()).optional().describe("ON_KEY_DOWN: key codes"),
  mediaHitTime: import_zod4.z.number().optional().describe("ON_MEDIA_HIT: time in seconds")
}).passthrough();
var reactionSchema = import_zod4.z.object({
  trigger: reactionTriggerSchema.nullable().describe("The interaction that fires the actions"),
  actions: import_zod4.z.array(reactionActionSchema).optional().describe("Actions to run when triggered"),
  action: reactionActionSchema.optional().describe("Deprecated single-action form; prefer `actions`")
}).passthrough();
server.tool(
  "set_reactions",
  "Install prototyping reactions (interactions/transitions) onto Figma nodes via setReactionsAsync \u2014 the write-side twin of get_reactions. Use this to create prototype flows: e.g. an ON_CLICK trigger with a NODE action navigating to another frame with a SMART_ANIMATE transition. NOTE: this REPLACES the full reaction list on each node, so pass the complete desired set (use get_reactions first to preserve existing ones). Most scene nodes support reactions; pages/documents do not.",
  {
    reactions: import_zod4.z.array(
      import_zod4.z.object({
        nodeId: import_zod4.z.string().describe("ID of the node to attach reactions to"),
        reactions: import_zod4.z.array(reactionSchema).describe("Complete list of reactions to set on this node (replaces existing)")
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
    connectorId: import_zod4.z.string().optional().describe("The ID of the connector node to set as default")
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
    connections: import_zod4.z.array(import_zod4.z.object({
      startNodeId: import_zod4.z.string().describe("ID of the starting node"),
      endNodeId: import_zod4.z.string().describe("ID of the ending node"),
      text: import_zod4.z.string().optional().describe("Optional text to display on the connector")
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
    nodeId: import_zod4.z.string().describe("The ID of the node to focus on")
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
    nodeIds: import_zod4.z.array(import_zod4.z.string()).describe("Array of node IDs to select")
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
    nodeIds: import_zod4.z.array(import_zod4.z.string()).min(2).describe("IDs of the COMPONENT nodes to combine (at least 2, same page)"),
    name: import_zod4.z.string().optional().describe("Name for the resulting component set"),
    parentId: import_zod4.z.string().optional().describe("Parent node to place the set in (defaults to current page)"),
    rename: import_zod4.z.array(import_zod4.z.object({ nodeId: import_zod4.z.string(), name: import_zod4.z.string() })).optional().describe('Rename components before combining, to set variant props via "Prop=Value" naming'),
    arrange: import_zod4.z.boolean().optional().describe("Pack variants into a grid after combining (default true). false keeps source x/y."),
    gap: import_zod4.z.number().min(0).optional().describe("Spacing between variants when arranging (px, default 16).")
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
    operation: import_zod4.z.enum(["union", "subtract", "intersect", "exclude"]).describe("Which boolean op to apply"),
    nodeIds: import_zod4.z.array(import_zod4.z.string()).min(2).describe("IDs of the nodes to combine (at least 2). For subtract/exclude the first is the base."),
    name: import_zod4.z.string().optional().describe("Name for the resulting boolean operation node"),
    parentId: import_zod4.z.string().optional().describe("Parent node to place the result in (defaults to current page)")
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
    operation: import_zod4.z.enum(["flatten", "outline_stroke", "to_component", "detach"]).describe("Which conversion to apply"),
    nodeIds: import_zod4.z.array(import_zod4.z.string()).min(1).describe("Nodes to convert. `flatten` merges all of them into one; the other ops map 1:1."),
    name: import_zod4.z.string().optional().describe("Name for the resulting node. Applied to the flatten result, or to a single-node result; ignored when an op produces multiple nodes."),
    parentId: import_zod4.z.string().optional().describe("flatten only: parent to place the merged vector in (defaults to the first node's parent).")
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
    query: import_zod4.z.string().optional().describe("Case-insensitive substring to filter family names (e.g. 'inter', 'roboto')"),
    limit: import_zod4.z.number().optional().describe("Max families to return (default 200)"),
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
    nodeId: import_zod4.z.string().describe("The TEXT node to style"),
    ranges: import_zod4.z.array(
      import_zod4.z.object({
        start: import_zod4.z.number().describe("Start character index (inclusive)"),
        end: import_zod4.z.number().describe("End character index (exclusive)"),
        fontName: import_zod4.z.object({ family: import_zod4.z.string(), style: import_zod4.z.string() }).optional().describe("Font for this range (loaded automatically). Use list_fonts to get valid family/style."),
        fontSize: import_zod4.z.number().optional(),
        fills: import_zod4.z.array(import_zod4.z.any()).optional().describe("Paint array; a paint's color accepts #RRGGBB"),
        textCase: import_zod4.z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"]).optional(),
        textDecoration: import_zod4.z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
        letterSpacing: import_zod4.z.any().optional().describe("Number (px shorthand) or {value, unit}"),
        lineHeight: import_zod4.z.any().optional().describe("Number (px shorthand) or {value, unit:'PIXELS'|'PERCENT'} or {unit:'AUTO'}"),
        hyperlink: import_zod4.z.any().optional().describe("URL string, {type,value}, or null to clear"),
        listOptions: import_zod4.z.object({ type: import_zod4.z.enum(["ORDERED", "UNORDERED", "NONE"]) }).optional(),
        indentation: import_zod4.z.number().optional(),
        textStyleId: import_zod4.z.string().optional().describe("Apply a shared text style by id"),
        fillStyleId: import_zod4.z.string().optional().describe("Apply a shared paint/fill style by id")
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
    operation: import_zod4.z.enum(["group", "ungroup"]).describe("`group` to wrap nodes, `ungroup` to dissolve containers"),
    nodeIds: import_zod4.z.array(import_zod4.z.string()).min(1).describe("For `group`: the 2+ nodes to wrap. For `ungroup`: the GROUP/FRAME nodes to dissolve."),
    name: import_zod4.z.string().optional().describe("Name for the new group (group only)"),
    parentId: import_zod4.z.string().optional().describe("Parent to place the group in; defaults to the first node's parent (group only)")
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
    rows: import_zod4.z.number().int().min(1).describe("number of rows"),
    columns: import_zod4.z.number().int().min(1).describe("number of columns"),
    cells: import_zod4.z.array(
      import_zod4.z.object({
        row: import_zod4.z.number().int().min(0),
        column: import_zod4.z.number().int().min(0),
        text: import_zod4.z.string()
      })
    ).optional().describe("cell contents, 0-indexed (row, column); omitted cells stay empty"),
    parentId: import_zod4.z.string().optional().describe("container to place the table in; defaults to current page"),
    index: import_zod4.z.number().int().min(0).optional().describe("position among siblings"),
    x: import_zod4.z.number().optional().describe("x position (ignored inside an auto-layout parent)"),
    y: import_zod4.z.number().optional().describe("y position (ignored inside an auto-layout parent)"),
    name: import_zod4.z.string().optional().describe("name for the table node")
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
    tableId: import_zod4.z.string().describe("ID of the TABLE node to edit"),
    addRows: import_zod4.z.number().int().min(0).optional().describe("append this many rows at the bottom"),
    addColumns: import_zod4.z.number().int().min(0).optional().describe("append this many columns at the right"),
    removeRows: import_zod4.z.array(import_zod4.z.number().int().min(0)).optional().describe("row indices to remove (0-indexed)"),
    removeColumns: import_zod4.z.array(import_zod4.z.number().int().min(0)).optional().describe("column indices to remove (0-indexed)"),
    resizeRows: import_zod4.z.array(import_zod4.z.object({ index: import_zod4.z.number().int().min(0), height: import_zod4.z.number().positive() })).optional().describe("set row heights by index"),
    resizeColumns: import_zod4.z.array(import_zod4.z.object({ index: import_zod4.z.number().int().min(0), width: import_zod4.z.number().positive() })).optional().describe("set column widths by index"),
    cells: import_zod4.z.array(
      import_zod4.z.object({
        row: import_zod4.z.number().int().min(0),
        column: import_zod4.z.number().int().min(0),
        text: import_zod4.z.string()
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
    collection: import_zod4.z.string().optional().describe("Limit to a single collection by name or id")
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
    collections: import_zod4.z.array(
      import_zod4.z.object({
        id: import_zod4.z.string().optional().describe("Existing collection id to update"),
        name: import_zod4.z.string().optional().describe("Collection name (used to match or create)"),
        modes: import_zod4.z.array(import_zod4.z.string()).optional().describe("Desired mode names; the first becomes the default mode of a new collection"),
        variables: import_zod4.z.array(
          import_zod4.z.object({
            id: import_zod4.z.string().optional().describe("Existing variable id to update"),
            name: import_zod4.z.string().describe("Variable name; '/' creates token groups (e.g. 'color/bg/primary')"),
            type: import_zod4.z.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]).optional().describe("Resolved type \u2014 required when creating a new variable"),
            scopes: import_zod4.z.array(import_zod4.z.string()).optional().describe("Variable scopes (e.g. ALL_SCOPES, TEXT_CONTENT, CORNER_RADIUS)"),
            description: import_zod4.z.string().optional(),
            valuesByMode: import_zod4.z.record(import_zod4.z.string(), import_zod4.z.any()).optional().describe("Map of mode name \u2192 value (literal hex/number/string/boolean, or {alias: <name>})")
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
    bindings: import_zod4.z.array(
      import_zod4.z.object({
        nodeId: import_zod4.z.string().describe("Target node id"),
        field: import_zod4.z.string().describe("Property to bind (e.g. 'fills', 'cornerRadius', 'fontSize', 'itemSpacing')"),
        variableId: import_zod4.z.string().optional().describe("Variable id to bind"),
        variableName: import_zod4.z.string().optional().describe("Variable name to bind (used if variableId omitted)"),
        paintIndex: import_zod4.z.number().optional().describe("For 'fills'/'strokes': which paint to bind (default 0)"),
        unbind: import_zod4.z.boolean().optional().describe("Clear the binding on this field instead of setting it")
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
var embeddedRelay = null;
function ensureRelay(port) {
  if (serverUrl !== "localhost") return;
  if (embeddedRelay) return;
  if (typeof Bun === "undefined") return;
  try {
    embeddedRelay = startRelay(port);
    if (embeddedRelay) {
      logger.info(`Embedded WebSocket relay listening on port ${port}`);
    }
  } catch (error) {
    logger.warn(`Could not start embedded relay: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function connectToFigma(port = 3055) {
  ensureRelay(port);
  if (ws && ws.readyState === import_ws.default.OPEN) {
    logger.info("Already connected to Figma");
    return;
  }
  const wsUrl = serverUrl === "localhost" ? `${WS_URL}:${port}` : WS_URL;
  logger.info(`Connecting to Figma socket server at ${wsUrl}...`);
  ws = new import_ws.default(wsUrl);
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
          }, 12e4);
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
  if (!ws || ws.readyState !== import_ws.default.OPEN) {
    throw new Error("Not connected to Figma");
  }
  try {
    await sendCommandToFigma("join", { channel: channelName });
    currentChannel = channelName;
    setIdMapNamespace(channelName);
    logger.info(`Joined channel: ${channelName}`);
  } catch (error) {
    logger.error(`Failed to join channel: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
function waitForConnection(timeoutMs = 1e4) {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === import_ws.default.OPEN) {
      resolve();
      return;
    }
    connectToFigma();
    const start = Date.now();
    const interval = setInterval(() => {
      if (ws && ws.readyState === import_ws.default.OPEN) {
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
    if (!ws || ws.readyState !== import_ws.default.OPEN) {
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
    const id = (0, import_uuid.v4)();
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
var ACTIVE_CHANNELS_FILE2 = (0, import_path3.join)((0, import_os3.tmpdir)(), "figma-active-channels.json");
async function readActiveChannels() {
  try {
    const raw = await (0, import_promises.readFile)(ACTIVE_CHANNELS_FILE2, "utf8");
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
            text: "No active plugin channel found. Open the TalkToFigma plugin in Figma and press Connect (the relay is hosted by this MCP server automatically)."
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
    channel: import_zod4.z.string().describe("The name of the channel to join").default("")
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
  const transport = new import_stdio.StdioServerTransport();
  await server.connect(transport);
  logger.info("FigmaMCP server running on stdio");
}
main().catch((error) => {
  logger.error(`Error starting FigmaMCP server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
//# sourceMappingURL=server.cjs.map