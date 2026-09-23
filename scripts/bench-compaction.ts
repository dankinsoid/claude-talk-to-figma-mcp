// @ai-generated(guided)
// Token benchmark: our compaction layer vs the upstream we forked from.
//
// Upstream is grab/cursor-talk-to-figma-mcp. Both sides are pure functions of
// the SAME input — the raw JSON_REST_V1 document exportAsync returns. Upstream's
// get_node_info pipes it through filterFigmaNode(); read_node pipes it through
// shapeNode(). So a fixture captured once replays through both offline, with no
// Figma connection and no API key.
//
// Capture fixtures with:
//   read_node({nodeIds:["<id>"], fields:"all", depth:30,
//              outputPath:"tmp/bench/raw-<id>.json"})
//
// Run: bun run scripts/bench-compaction.ts [fixtureDir]

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getEncoding } from "js-tiktoken";
import { shapeNode } from "../src/talk_to_figma_mcp/shape.js";

const enc = getEncoding("cl100k_base");
const tokens = (s: string) => enc.encode(s).length;

// Upstream: src/cursor_mcp_plugin/code.js @ grab/cursor-talk-to-figma-mcp
// (the repo this project forked from). Vendored verbatim so the comparison runs
// without cloning it. Note it has NO depth parameter — recursion is always full.
function rgbaToHex(color: any): string {
	const r = Math.round(color.r * 255);
	const g = Math.round(color.g * 255);
	const b = Math.round(color.b * 255);
	const a = Math.round(color.a * 255);
	const h = (x: number) => x.toString(16).padStart(2, "0");
	return `#${h(r)}${h(g)}${h(b)}${a === 255 ? "" : h(a)}`;
}

function filterFigmaNode(node: any) {
	if (node.type === "VECTOR") return null;
	const filtered: any = { id: node.id, name: node.name, type: node.type };

	if (node.fills && node.fills.length > 0) {
		filtered.fills = node.fills.map((fill: any) => {
			const f = { ...fill };
			delete f.boundVariables;
			delete f.imageRef;
			if (f.gradientStops) {
				f.gradientStops = f.gradientStops.map((stop: any) => {
					const s = { ...stop };
					if (s.color) s.color = rgbaToHex(s.color);
					delete s.boundVariables;
					return s;
				});
			}
			if (f.color) f.color = rgbaToHex(f.color);
			return f;
		});
	}

	if (node.strokes && node.strokes.length > 0) {
		filtered.strokes = node.strokes.map((stroke: any) => {
			const s = { ...stroke };
			delete s.boundVariables;
			if (s.color) s.color = rgbaToHex(s.color);
			return s;
		});
	}

	if (node.cornerRadius !== undefined) filtered.cornerRadius = node.cornerRadius;
	if (node.absoluteBoundingBox) filtered.absoluteBoundingBox = node.absoluteBoundingBox;
	if (node.characters) filtered.characters = node.characters;
	if (node.style) {
		filtered.style = {
			fontFamily: node.style.fontFamily,
			fontStyle: node.style.fontStyle,
			fontWeight: node.style.fontWeight,
			fontSize: node.style.fontSize,
			textAlignHorizontal: node.style.textAlignHorizontal,
			letterSpacing: node.style.letterSpacing,
			lineHeightPx: node.style.lineHeightPx,
		};
	}

	if (node.children) {
		filtered.children = node.children
			.map((c: any) => filterFigmaNode(c))
			.filter((c: any) => c !== null);
	}
	return filtered;
}

function countNodes(n: any): number {
	if (!n) return 0;
	return 1 + (n.children ?? []).reduce((a: number, c: any) => a + countNodes(c), 0);
}

// Upstream serializes with JSON.stringify(filterFigmaNode(result)) — no indent;
// read_node goes through jsonContent, also unindented. Same serializer both sides.
const ser = (v: any) => JSON.stringify(v);

const dir = process.argv[2] ?? "tmp/bench";
const files = readdirSync(dir).filter((f) => f.startsWith("raw-") && f.endsWith(".json")).sort();

if (!files.length) {
	console.error(`No raw-*.json fixtures in ${dir}/ — capture one with read_node fields:"all".`);
	process.exit(1);
}

const rows: any[] = [];
for (const file of files) {
	const parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
	const raw = (Array.isArray(parsed) ? parsed[0].node : parsed.node) ?? parsed;

	const rawTok = tokens(ser(raw));
	const ours = shapeNode(raw, {});
	const ourTok = tokens(ser(ours));

	// Ours with collapse/cull off: same node set as a full upstream walk, so the
	// delta here is representation alone, not "we dropped more subtrees".
	const oursFlat = shapeNode(raw, { collapseIcons: false, collapseRepeats: false, cull: false, depth: 30 });
	const flatTok = tokens(ser(oursFlat));

	const row: any = {
		fixture: file.replace(/^raw-|\.json$/g, ""),
		rawNodes: countNodes(raw),
		rawTok,
		ourNodes: countNodes(ours),
		ourTok,
		flatTok,
		flatNodes: countNodes(oursFlat),
	};
	const up = filterFigmaNode(raw);
	row.upTok = tokens(ser(up));
	row.upNodes = countNodes(up);
	rows.push(row);
}

const pct = (from: number, to: number) => `${(((from - to) / from) * 100).toFixed(1)}%`;
const fmt = (n: number) => n.toLocaleString("en-US");

console.log(`\ntokenizer: cl100k_base (js-tiktoken) · serializer: JSON.stringify, no indent`);
console.log(`fixtures: ${dir}/\n`);

for (const r of rows) {
	console.log(`── ${r.fixture}  (${r.rawNodes} nodes raw)`);
	console.log(`   raw JSON_REST_V1      ${fmt(r.rawTok).padStart(9)} tok`);
	console.log(`   upstream (grab)       ${fmt(r.upTok).padStart(9)} tok   (${r.upNodes} nodes)   −${pct(r.rawTok, r.upTok)} vs raw`);
	console.log(`   ours, no collapse     ${fmt(r.flatTok).padStart(9)} tok   (${r.flatNodes} nodes)   −${pct(r.rawTok, r.flatTok)} vs raw`);
	console.log(`   ours  (read_node)     ${fmt(r.ourTok).padStart(9)} tok   (${r.ourNodes} nodes)   −${pct(r.rawTok, r.ourTok)} vs raw`);
	console.log(`   → representation only (same nodes): −${pct(r.upTok, r.flatTok)} vs upstream`);
	console.log(`   → + collapse/cull (read_node default): −${pct(r.upTok, r.ourTok)}  (${(r.upTok / r.ourTok).toFixed(1)}× fewer)\n`);
}

const sum = (k: string) => rows.reduce((a, r) => a + r[k], 0);
console.log(`── TOTAL (${rows.length} fixtures)`);
console.log(`   raw ${fmt(sum("rawTok"))} · upstream ${fmt(sum("upTok"))} · ours ${fmt(sum("ourTok"))}`);
console.log(`   representation only (collapse off): −${pct(sum("upTok"), sum("flatTok"))} vs upstream`);
console.log(`   ours vs upstream: −${pct(sum("upTok"), sum("ourTok"))} (${(sum("upTok") / sum("ourTok")).toFixed(1)}× fewer)`);
console.log(`   ours vs raw:                −${pct(sum("rawTok"), sum("ourTok"))}\n`);
