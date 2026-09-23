// @ai-generated(guided)
// Navigation benchmark: what it costs an agent to FIND a node, before it reads
// anything. bench-compaction.ts measures one read of a known id; this measures
// getting to that id.
//
// Upstream (grab/cursor-talk-to-figma-mcp) has no name/type search over the
// document. Its read surface is:
//   get_document_info   — the current page's DIRECT children only (id/name/type)
//   get_node_info(id)   — filterFigmaNode(exportAsync(id)): the FULL subtree,
//                         no depth parameter, everything below that node
//   scan_nodes_by_types(id, types) — needs the id you are still looking for
//
// So locating a node by name means descending: read a candidate container, scan
// its children's names, descend into the next one. Each such step pays for that
// node's entire subtree, because get_node_info cannot return one level.
//
// Ours: glob_nodes(name:"*player*") — one call, flat index of matches.
//
// Run: bun run scripts/bench-navigation.ts

import { readFileSync } from "node:fs";
import { getEncoding } from "js-tiktoken";

const enc = getEncoding("cl100k_base");
const tokens = (s: string) => enc.encode(s).length;
const ser = (v: any) => JSON.stringify(v);

function rgbaToHex(color: any): string {
	const r = Math.round(color.r * 255), g = Math.round(color.g * 255);
	const b = Math.round(color.b * 255), a = Math.round(color.a * 255);
	const h = (x: number) => x.toString(16).padStart(2, "0");
	return `#${h(r)}${h(g)}${h(b)}${a === 255 ? "" : h(a)}`;
}

// Verbatim from grab/cursor-talk-to-figma-mcp src/cursor_mcp_plugin/code.js.
function filterFigmaNode(node: any): any {
	if (node.type === "VECTOR") return null;
	const filtered: any = { id: node.id, name: node.name, type: node.type };
	if (node.fills && node.fills.length > 0) {
		filtered.fills = node.fills.map((fill: any) => {
			const f = { ...fill };
			delete f.boundVariables; delete f.imageRef;
			if (f.gradientStops) f.gradientStops = f.gradientStops.map((st: any) => {
				const s = { ...st };
				if (s.color) s.color = rgbaToHex(s.color);
				delete s.boundVariables;
				return s;
			});
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
	if (node.style) filtered.style = {
		fontFamily: node.style.fontFamily, fontStyle: node.style.fontStyle,
		fontWeight: node.style.fontWeight, fontSize: node.style.fontSize,
		textAlignHorizontal: node.style.textAlignHorizontal,
		letterSpacing: node.style.letterSpacing, lineHeightPx: node.style.lineHeightPx,
	};
	if (node.children) {
		filtered.children = node.children.map((c: any) => filterFigmaNode(c)).filter((c: any) => c !== null);
	}
	return filtered;
}

const count = (n: any): number =>
	n ? 1 + (n.children ?? []).reduce((a: number, c: any) => a + count(c), 0) : 0;

const section = JSON.parse(readFileSync("bench/fixtures/nav-section-8222-94767.json", "utf8"))[0].node;
const docInfo = JSON.parse(readFileSync("bench/fixtures/doc-info.json", "utf8"));

// ── Upstream step 1: get_document_info — page's direct children, id/name/type.
const docTok = tokens(ser(docInfo));

// ── Upstream step 2: get_node_info on ONE candidate section. There is no way to
// ask for less: the tool returns the whole subtree under that id.
const sectionFiltered = filterFigmaNode(section);
const sectionTok = tokens(ser(sectionFiltered));

// Our glob output for the same intent, captured live from the same file.
const globOut = readFileSync("bench/fixtures/nav-glob-player.txt", "utf8");
const globTok = tokens(globOut);
const globHits = globOut.trimEnd().split("\n").length;

const fmt = (n: number) => n.toLocaleString("en-US");
const pageChildren = docInfo.children.length;
const playerNamed = docInfo.children.filter((c: any) => /player/i.test(c.name)).length;

console.log(`\ntokenizer: cl100k_base (js-tiktoken)`);
console.log(`file: "${docInfo.name}" — ${pageChildren} top-level nodes on the page`);
console.log(`task: locate the player component(s) by name\n`);

console.log(`── upstream (grab): no search tool, must descend`);
console.log(`   get_document_info            ${fmt(docTok).padStart(9)} tok   (${pageChildren} top-level stubs, names only)`);
console.log(`   get_node_info("Player")      ${fmt(sectionTok).padStart(9)} tok   (${fmt(count(sectionFiltered))} nodes — the WHOLE section, no depth param)`);
console.log(`   ────────────────────────────────────────`);
console.log(`   one candidate section        ${fmt(docTok + sectionTok).padStart(9)} tok`);
console.log(`   ...and "Player" was 1 of ${pageChildren} top-level nodes (${playerNamed} are named *Player*), so a`);
console.log(`   miss means opening the next one at comparable cost.\n`);

console.log(`── ours: glob_nodes(name:"*player*")`);
console.log(`   one call                     ${fmt(globTok).padStart(9)} tok   (${globHits} matches, across the whole page)\n`);

const ratio = (docTok + sectionTok) / globTok;
console.log(`── locating a node`);
console.log(`   upstream ${fmt(docTok + sectionTok)} tok (ONE section opened) vs ours ${fmt(globTok)} tok (whole page searched)`);
console.log(`   → ours is ${ratio.toFixed(0)}× cheaper (fewer tokens is better), and it searched the whole`);
console.log(`     page while upstream opened a single branch.\n`);

// The asymmetry that matters: upstream's cost is driven by subtree size at the
// point it descends, ours by the number of matches.
console.log(`── why the gap is structural, not a tuning difference`);
console.log(`   upstream pays for the SUBTREE it opens   → ${fmt(sectionTok)} tok for ${fmt(count(sectionFiltered))} nodes`);
console.log(`   ours pays for the MATCHES it returns     → ${fmt(globTok)} tok for ${globHits} hits`);
console.log(`   A deeper or wider file makes the first number grow and the second stay flat.\n`);
