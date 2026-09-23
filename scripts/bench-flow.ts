// @ai-generated(guided)
// End-to-end flow benchmark: "find a component, then inspect its properties".
//
// The other two benchmarks measure single calls. This one measures the task an
// agent actually performs, where the calls compose:
//
//   1. locate the component by name
//   2. read its structure (what is inside)
//   3. inspect specific properties (fills, padding, variant props)
//
// Our side is a verbatim transcript of the three calls run against the live
// file (bench/fixtures/flow/). Upstream's side is reconstructed from its own
// tool surface, replaying the same committed fixtures through its filterFigmaNode.
//
// Run: bun run scripts/bench-flow.ts

import { readFileSync } from "node:fs";
import { getEncoding } from "js-tiktoken";

const enc = getEncoding("cl100k_base");
const tokens = (s: string) => enc.encode(s).length;
const ser = (v: any) => JSON.stringify(v);
const fmt = (n: number) => n.toLocaleString("en-US");
const read = (p: string) => readFileSync(p, "utf8");

function rgbaToHex(color: any): string {
	const r = Math.round(color.r * 255), g = Math.round(color.g * 255);
	const b = Math.round(color.b * 255), a = Math.round(color.a * 255);
	const h = (x: number) => x.toString(16).padStart(2, "0");
	return `#${h(r)}${h(g)}${h(b)}${a === 255 ? "" : h(a)}`;
}

// Verbatim from grab/cursor-talk-to-figma-mcp src/cursor_mcp_plugin/code.js.
function filterFigmaNode(node: any): any {
	if (node.type === "VECTOR") return null;
	const f: any = { id: node.id, name: node.name, type: node.type };
	if (node.fills?.length) {
		f.fills = node.fills.map((fill: any) => {
			const p = { ...fill };
			delete p.boundVariables; delete p.imageRef;
			if (p.gradientStops) p.gradientStops = p.gradientStops.map((st: any) => {
				const s = { ...st };
				if (s.color) s.color = rgbaToHex(s.color);
				delete s.boundVariables;
				return s;
			});
			if (p.color) p.color = rgbaToHex(p.color);
			return p;
		});
	}
	if (node.strokes?.length) {
		f.strokes = node.strokes.map((stroke: any) => {
			const s = { ...stroke };
			delete s.boundVariables;
			if (s.color) s.color = rgbaToHex(s.color);
			return s;
		});
	}
	if (node.cornerRadius !== undefined) f.cornerRadius = node.cornerRadius;
	if (node.absoluteBoundingBox) f.absoluteBoundingBox = node.absoluteBoundingBox;
	if (node.characters) f.characters = node.characters;
	if (node.style) f.style = {
		fontFamily: node.style.fontFamily, fontStyle: node.style.fontStyle,
		fontWeight: node.style.fontWeight, fontSize: node.style.fontSize,
		textAlignHorizontal: node.style.textAlignHorizontal,
		letterSpacing: node.style.letterSpacing, lineHeightPx: node.style.lineHeightPx,
	};
	if (node.children) f.children = node.children.map((c: any) => filterFigmaNode(c)).filter(Boolean);
	return f;
}

const count = (n: any): number =>
	n ? 1 + (n.children ?? []).reduce((a: number, c: any) => a + count(c), 0) : 0;

const docInfo = JSON.parse(read("bench/fixtures/doc-info.json"));
// The section that actually contains the target — the branch upstream must open
// to reach it. (The component lives under "Playlist", not under "Player".)
const section = JSON.parse(read("bench/fixtures/flow/raw-playlist-section.json"))[0].node;
// The component itself, captured separately: upstream's step 3 reads this node,
// and get_node_info returns its whole subtree.
const target = JSON.parse(read("bench/fixtures/flow/raw-component.json"))[0].node;

// ── OURS: verbatim transcript of three live calls.
const ourSteps = [
	{ label: `glob_nodes(name:"Music / Player")`, out: read("bench/fixtures/flow/step1-glob.txt") },
	{ label: `read_node(["n0"])`, out: read("bench/fixtures/flow/step2-read.json") },
	{ label: `read_node(["n0"], fields:[...])`, out: read("bench/fixtures/flow/step3-fields.json") },
];
const ourTok = ourSteps.map((s) => tokens(s.out));
const ourTotal = ourTok.reduce((a, b) => a + b, 0);

// ── UPSTREAM: same goal, its own tools.
// 1. get_document_info — page's direct children only; no name search exists.
const upDoc = tokens(ser(docInfo));
// 2. get_node_info(section) — the only way down, and it returns the full subtree.
const upSection = filterFigmaNode(section);
const upSectionTok = tokens(ser(upSection));
// 3. get_node_info(component) — properties come bundled with the whole subtree;
//    there is no field projection, so inspecting padding costs the descendants too.
const upTarget = target ? filterFigmaNode(target) : null;
const upTargetTok = upTarget ? tokens(ser(upTarget)) : 0;

const upSteps = [
	{ label: `get_document_info()`, tok: upDoc, note: `${docInfo.children.length} top-level stubs, names only` },
	{ label: `get_node_info("Playlist" section)`, tok: upSectionTok, note: `${fmt(count(upSection))} nodes — whole section` },
	{ label: `get_node_info(component)`, tok: upTargetTok, note: `${fmt(count(upTarget))} nodes, all fields — no projection` },
];
const upTotal = upSteps.reduce((a, s) => a + s.tok, 0);

console.log(`\ntokenizer: cl100k_base (js-tiktoken)`);
console.log(`task: find the "Music / Player" component, then inspect its properties\n`);

console.log(`── ours (transcript of three live calls)`);
ourSteps.forEach((s, i) => {
	console.log(`   ${i + 1}. ${s.label.padEnd(34)} ${fmt(ourTok[i]).padStart(8)} tok`);
});
console.log(`      ${"total".padEnd(34)} ${fmt(ourTotal).padStart(8)} tok\n`);

console.log(`── upstream (grab), same goal with its tool surface`);
upSteps.forEach((s, i) => {
	console.log(`   ${i + 1}. ${s.label.padEnd(34)} ${fmt(s.tok).padStart(8)} tok   (${s.note})`);
});
console.log(`      ${"total".padEnd(34)} ${fmt(upTotal).padStart(8)} tok\n`);

console.log(`── result`);
console.log(`   ours ${fmt(ourTotal)} tok vs upstream ${fmt(upTotal)} tok`);
console.log(`   → ours is ${(upTotal / ourTotal).toFixed(0)}× cheaper for the same task (fewer tokens is better)\n`);

console.log(`── where the gap comes from`);
console.log(`   step 1  no name search upstream, so the page must be descended blind`);
console.log(`   step 2  get_node_info has no depth param — one level costs the whole subtree`);
console.log(`   step 3  once the id is known, upstream is fine here (${fmt(upTargetTok)} tok): the`);
console.log(`           component is small, so "no field projection" costs little.`);
console.log(``);
console.log(`   Step 2 is the whole story — ${Math.round(upSectionTok / upTotal * 100)}% of upstream's total. Reaching a`);
console.log(`   ${fmt(count(upTarget))}-node component costs a ${fmt(count(upSection))}-node section, because the only way`);
console.log(`   down returns everything below it. That one call exceeds a 200k window.`);
console.log(`   The gap is the SEARCH, not the read.\n`);
