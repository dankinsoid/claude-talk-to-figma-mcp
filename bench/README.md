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

## Result (3 iPhone screens from Apple's kit, 468 nodes)

| | tokens | vs raw |
|---|---|---|
| raw `JSON_REST_V1` | 164,925 | — |
| upstream | 37,536 | −77% |
| ours, no collapse | 20,116 | −88% |
| ours (`read_node` default) | 13,178 | −92% |

Like-for-like (same nodes): **−46%**. With collapse/cull at default settings:
**−65%, 2.8× fewer tokens**.

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

## Result (task: locate the keyboard components)

| | tokens | |
|---|---|---|
| upstream `get_document_info` | 117 | 3 top-level stubs, names only |
| upstream `get_node_info("iPhone")` | 417,593 | 5,059 nodes — one section, in full |
| **upstream, one candidate opened** | **417,710** | no top-level node is named *Keyboard* |
| **ours, `glob_nodes`** | **1,823** | 86 matches, whole page searched |

**Ours is ~229× cheaper** (1,823 tok vs 417,710 — fewer is better) — and the two calls are
not doing the same amount of work:
upstream opened *one branch*, ours searched *everything*.

The asymmetry is structural, not a matter of tuning:

- upstream's cost scales with **the subtree it opens** — 418k tokens for 5,059 nodes
- ours scales with **the number of matches** — 1.8k tokens for 86 hits

A deeper or wider file grows the first number and leaves the second flat. On
this file one section is already ~418k tokens, which exceeds a 200k context
window: the upstream path cannot complete the lookup at all, at any budget.

## Fixture note

`nav-section-8222-94767.json` is pruned to the fields `filterFigmaNode` actually
reads (the raw export is 3.8 MB). Pruning drops only keys the filter never
touches, so the token count is identical to the full export's.

## Caveat

This models a *generous* upstream path — one section opened, the right one. The
kit's three top-level sections (`iPad`, `iPhone`, `iPhone Duo`) carry no hint of
which holds a keyboard, so a real descent may open more than one, each at
comparable cost.

---

# Flow benchmark

The two benchmarks above measure single calls. This one measures the task an
agent actually performs, where calls compose: **find a component, then inspect
its properties**.

```bash
bun run scripts/bench-flow.ts
```

Our side is a verbatim transcript of three calls run against the kit
(`fixtures/flow/`). Upstream's side is reconstructed from its own tool surface,
replaying the same committed fixtures through its `filterFigmaNode`.

## Result

| step | ours | upstream |
|---|---|---|
| 1. locate `Examples/Alert` | `glob_nodes` — **28** | `get_document_info` — **117** |
| 2. read its structure | `read_node` — **894** | `get_node_info(section)` — **417,593** |
| 3. inspect properties | `read_node(fields:[…])` — **190** | `get_node_info(component)` — **1,984** |
| **total** | **1,112 tok** | **419,694 tok** |

**Ours is ~377× cheaper** for the same task.

## Where the gap actually is

Step 3 is the interesting one: upstream is *fine* there — 1,984 tokens. The
component is small, so having no field projection costs little.

The entire gap is **step 2 — 99% of upstream's total**. Reaching a 25-node
component costs a 5,059-node section, because the only way down (`get_node_info`)
returns everything below the node. That single call exceeds a 200k context
window, so the flow cannot complete upstream at all.

**The gap is the search, not the read.** Our compaction layer saves ~2.8× on a
read (first benchmark); the indexing tools are what turn that into two-plus
orders of magnitude on a real task.

## Caveat

Upstream's step 2 assumes it guesses the right section first try, and that the
section it opens is the one holding the component. A wrong guess costs another
section-sized read.
