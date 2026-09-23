# Compaction benchmark

Measures what `read_node`'s compaction layer saves against
[grab/cursor-talk-to-figma-mcp](https://github.com/grab/cursor-talk-to-figma-mcp),
the upstream this project forked from.

```bash
bun run scripts/bench-compaction.ts bench/fixtures
```

## Why it is comparable

Both sides are pure functions of the same input — the raw `JSON_REST_V1`
document `node.exportAsync()` returns:

| | upstream `get_node_info` | our `read_node` |
|---|---|---|
| plugin | `filterFigmaNode(response.document)` | `filterFigmaNode(...)` → `shapeNode()` |
| server | `JSON.stringify(filtered)` | `jsonContent(shaped)` |

Same source document, same serializer (`JSON.stringify`, no indent). The only
variable is the reshaping. Upstream's `filterFigmaNode` is vendored verbatim
into the script, so the run needs neither their repo nor a Figma connection.

## Fixtures

Fixtures are **not committed** — `bench/fixtures/` is gitignored. The numbers
published in the root README were measured on a private product file, and the
raw export of a Figma file carries every layer name and every string in it.
Capture your own before running the benchmarks.

Any Figma file works. To reproduce something close to the published numbers, use
a file with real screens and repeated component instances — a community UI kit
such as Apple's [iOS and iPadOS](https://www.figma.com/community/file/1651309003795292092/ios-and-ipados-27)
kit works well. Duplicate it, open a page with actual screens (not the cover),
then, with the plugin connected:

```
read_node({ nodeIds: ["<screen id>"], fields: "all", depth: 30,
            outputPath: "bench/fixtures/raw-<id>.json" })
```

`fields:"all"` returns every property untouched, so the fixture is the raw
export — not something either compactor has already seen. `bench-compaction.ts`
picks up every `raw-*.json` in the directory you point it at.

`bench-navigation.ts` and `bench-flow.ts` additionally need a page index and a
section, since they model *locating* a node:

```
read_node({ nodeIds: ["<section id>"], fields: "all", depth: 30,
            outputPath: "bench/fixtures/nav-section-<id>.json" })
```

Both scripts name the fixtures they expect at the top of the file.

## Reading the output

Token counts use `cl100k_base` (js-tiktoken). That is not Claude's tokenizer, so
treat absolute numbers as indicative; the ratio between the two columns is the
point, and it is stable across tokenizers.

Two rows separate the two independent effects:

- **ours, no collapse** — `collapseIcons/collapseRepeats/cull` off, `depth:30`.
  Same node set as upstream, so the delta is representation alone.
- **ours (read_node)** — the actual default, which also drops nodes that render
  nowhere and collapses icons and repeated instances.

The second row is the real per-call cost, but it returns fewer nodes; the first
row is the honest like-for-like number.

## Result (3 screens, 1188 nodes)

| | tokens | vs raw |
|---|---|---|
| raw `JSON_REST_V1` | 360,980 | — |
| upstream | 96,046 | −73% |
| ours, no collapse | 64,364 | −82% |
| ours (`read_node` default) | 14,956 | −96% |

Like-for-like (same nodes): **−33%**. With collapse/cull at default settings:
**−84%, 6.4× fewer tokens**.

---

# Navigation benchmark

The compaction numbers above measure *one read of a known node id*. They say
nothing about how the agent got that id — which, on a real file, is where most
of the tokens go.

```bash
bun run scripts/bench-navigation.ts
```

## The structural difference

Upstream has no search over the document. Its entire read surface is:

| tool | what it returns |
|---|---|
| `get_document_info` | the current page's **direct children only**, id/name/type |
| `get_node_info(id)` | `filterFigmaNode(exportAsync(id))` — the **whole subtree**, no depth param |
| `scan_nodes_by_types(id, types)` | filters by type, and needs the id you are still looking for |

There is no "find a node named X". Locating one means descending: open a
candidate container, read its children's names, open the next. And
`get_node_info` cannot return a single level — every step pays for that node's
entire subtree.

Ours indexes instead: `glob_nodes(name:"*player*")` returns one flat line per
match (`id:"name".TYPE @parent [x,y wxh]`) across the whole page, and
`grep_nodes` does the same over text content.

## Result (same file, task: locate the player component)

| | tokens | |
|---|---|---|
| upstream `get_document_info` | 2,282 | 113 top-level stubs, names only |
| upstream `get_node_info("Player")` | 305,099 | 3,392 nodes — one section, in full |
| **upstream, one candidate opened** | **307,381** | and 2 of 113 top-level nodes are named *Player* |
| **ours, `glob_nodes`** | **3,295** | 143 matches, whole page searched |

**Ours is ~93× cheaper** (3,295 tok vs 307,381 — fewer is better) — and the two calls are
not doing the same amount of work:
upstream opened *one branch*, ours searched *everything*.

The asymmetry is structural, not a matter of tuning:

- upstream's cost scales with **the subtree it opens** — 305k tokens for 3,392 nodes
- ours scales with **the number of matches** — 3.3k tokens for 143 hits

A deeper or wider file grows the first number and leaves the second flat. On
this file one section is already ~305k tokens, which exceeds a 200k context
window: the upstream path cannot complete the lookup at all, at any budget.

## Fixture note

`nav-section-8222-94767.json` is pruned to the fields `filterFigmaNode` actually
reads (the raw export is 3.8 MB). Pruning drops only keys the filter never
touches, so the token count is identical to the full export's.

## Caveat

This models the *lucky* upstream path — the target sits in a section whose name
matches the query, so it descends correctly on the first guess. A target inside
a generically-named container (`Frame 12`, `Group 4`) has no name to steer by,
and the descent becomes trial and error over the 113 top-level nodes.

---

# Flow benchmark

The two benchmarks above measure single calls. This one measures the task an
agent actually performs, where calls compose: **find a component, then inspect
its properties**.

```bash
bun run scripts/bench-flow.ts
```

Our side is a verbatim transcript of three calls run against the live file
(`fixtures/flow/`). Upstream's side is reconstructed from its own tool surface,
replaying the same committed fixtures through its `filterFigmaNode`.

## Result

| step | ours | upstream |
|---|---|---|
| 1. locate `Music / Player` | `glob_nodes` — **108** | `get_document_info` — **2,282** |
| 2. read its structure | `read_node` — **178** | `get_node_info(section)` — **393,463** |
| 3. inspect properties | `read_node(fields:[…])` — **122** | `get_node_info(component)` — **435** |
| **total** | **408 tok** | **396,180 tok** |

**Ours is ~971× cheaper** for the same task.

## Where the gap actually is

Step 3 is the interesting one: upstream is *fine* there — 435 tokens. The
component is small, so having no field projection costs little.

The entire gap is **step 2 — 99% of upstream's total**. Reaching a 6-node
component costs a 4,246-node section, because the only way down (`get_node_info`)
returns everything below the node. That single call exceeds a 200k context
window, so the flow cannot complete upstream at all.

**The gap is the search, not the read.** Our compaction layer saves ~6× on a
read (first benchmark); the indexing tools are what turn that into three orders
of magnitude on a real task.

## Caveat

Upstream's step 2 assumes it guesses the right section first try. `Music / Player`
lives under `Playlist`, which is not a name a search for "player" would rank
first — a wrong guess costs another section-sized read.
