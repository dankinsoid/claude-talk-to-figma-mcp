# Talk to Figma MCP

A Model Context Protocol (MCP) integration between an AI agent (Claude Code and other MCP clients) and Figma, letting the agent read and modify designs programmatically.

https://github.com/user-attachments/assets/129a14d2-ed73-470f-9a4c-2240b2a4885c

## Based on `grab/cursor-talk-to-figma-mcp`

This is a fork of [grab/cursor-talk-to-figma-mcp](https://github.com/grab/cursor-talk-to-figma-mcp) (itself based on the original by [sonnylazuardi](https://github.com/sonnylazuardi/cursor-talk-to-figma-mcp)). It has diverged substantially. The upstream worked, but in practice it was slow, expensive, and limited:

- it fed the model **near-complete node JSON** for every read — thousands of tokens per node, with full geometry, paints and styles the agent rarely needed;
- **search was rigid** — a couple of fixed scans (by type, by text node) that returned heavy results; anything beyond them meant dumping a whole subtree and scanning it by eye;
- **editing was limited** to a handful of single-purpose setters.

This fork reworks the agent's interface around how an AI agent already works with a **codebase** — locate cheaply, read narrowly, edit surgically.

**What's different:**

- **Compact, zoomable hierarchy.** Reads return a minimal field set per node (id, name, type, color, box/auto-layout, text) instead of raw JSON, with a depth cap, drill-in stubs, and collapsing of icons and repeated component instances. A screen that was tens of thousands of tokens is now around ~5k.
- **Powerful, flexible search, code-agent style.** In place of the old fixed scans, three composable tools: `glob_nodes` (the `ls -R`/glob, filter by type and name pattern), `grep_nodes` (regex over text content, the `grep`), and `query_nodes` (arbitrary predicates over node fields — fontSize, fills color, bound variables, key presence). They return flat, line-oriented `id:"name".TYPE` hits — addresses you feed straight into read/edit, without ever dumping the tree.
- **A `Read` → `Edit` → `Write` model.** `read_node`, `edit_nodes` (one path-addressed property writer that replaced ~10 single-purpose setters), and `write_nodes` (create whole subtrees from JSON) mirror the file tools the agent is already trained on.
- **Short node ids.** Long nested instance paths (`I8782:344721;3063:34762;…`) are replaced with short counters (`n0`, `n1`, …) in all compact output, resolved back server-side. Cuts tokens and keeps the tree readable; every tool accepts short or canonical ids.
- **Bug fixes.** Notably, the original could corrupt text colors: the reaction-highlight animation didn't always restore the original fill. Fixed.
- **Small UX touches.** The plugin's channel window collapses to a compact widget so it stays out of the way, and the agent can discover the active channel automatically (`get_active_channel`) instead of you pasting it.

## Project Structure

- `src/talk_to_figma_mcp/` - TypeScript MCP server for Figma integration
- `src/claude_mcp_plugin/` - Figma plugin for communicating with the agent
- `src/socket.ts` - WebSocket server that relays messages between the MCP server and the Figma plugin

## How to use

1. Install Bun if you haven't already:

```bash
curl -fsSL https://bun.sh/install | bash
```

2. Run setup — this also installs the MCP config in your active project (`.cursor/mcp.json` and `.mcp.json`):

```bash
bun setup
```

3. Start the WebSocket relay:

```bash
bun socket
```

4. Install the Figma plugin — see [Figma Plugin](#figma-plugin) below. (Install locally: this fork ships a modified plugin, so the upstream community listing won't include the changes above.)

5. Run the plugin in Figma, join a channel, then drive it from your agent.

## Manual Setup and Installation

### MCP Server

Add the server to your MCP config (`~/.cursor/mcp.json` for Cursor, `.mcp.json` for Claude Code):

```json
{
  "mcpServers": {
    "TalkToFigma": {
      "command": "bunx",
      "args": ["@dankinsoid/claude-talk-to-figma-mcp@latest"]
    }
  }
}
```

Or via the Claude Code CLI:

```bash
claude mcp add TalkToFigma -- bunx @dankinsoid/claude-talk-to-figma-mcp@latest
```

### WebSocket Server

```bash
bun socket
```

### Figma Plugin

1. In Figma, go to Plugins > Development > New Plugin
2. Choose "Link existing plugin"
3. Select `src/claude_mcp_plugin/manifest.json`
4. The plugin is now available under your Figma development plugins

## Windows + WSL Guide

1. Install bun via PowerShell:

```bash
powershell -c "irm bun.sh/install.ps1|iex"
```

2. Uncomment the hostname `0.0.0.0` in `src/socket.ts`:

```typescript
// uncomment this to allow connections in windows wsl
hostname: "0.0.0.0",
```

3. Start the websocket:

```bash
bun socket
```

## MCP Tools

The agent's workflow mirrors editing a codebase: **search** to locate nodes cheaply, **read** only what you need, then **edit/write**. Node ids are short counters (`n0`, `n1`, …) that flow between every tool; canonical Figma ids are accepted too.

### Read

- `read_node` — the `Read` tool for the canvas. Pass `nodeIds` (one or many), or omit to read the current selection. Returns the compact, low-token subtree of each node; `depth` controls how far children expand and deeper nodes become drill-in stubs. `raw:true` returns the full unfiltered JSON of a single node (all props, children stripped).

### Search (locate before reading)

- `glob_nodes` — flat type/name-glob index of a subtree, one node per line as `id:"name".TYPE @parent [x,y wxh]` (the `ls -R`/glob analog). Filter by `type` and a shell-style `name` glob; scope with `root`/`depth`/`within`.
- `grep_nodes` — regex search over the text content of a subtree, line-oriented (the `grep` analog): `id:"name".TEXT @parent L<n>: <line>`. `mode` switches between content / nodes / count.
- `query_nodes` — structural search by field predicates (`{path, op, value}`, AND-combined). Match any node-model field (fontSize, fills color, bound variables, …), including key presence via `exists`/`absent` — e.g. find fills *not* bound to a variable for a design-system audit.

### Edit & Create

- `edit_nodes` — the `Edit` tool for the node model. Pass `edits: [{nodeId, path, old?, new}]`. `path` addresses one field (`name`, `characters`, `x`, `fills[0].color`, `cornerRadius`, `layoutMode`, `paddingTop`, `itemSpacing`, …); `new` is the value (`#RRGGBB` → Figma rgb; objects/arrays allowed); optional `old` is a guard that rejects only a stale edit. Edits are independent and one call can touch many nodes — this is also how you bulk-replace text (one `{path:"characters"}` per node). Replaced the former single-purpose setters (`move_node`, `resize_node`, `set_text_content`, `set_padding`, `set_layout_mode`, …).
- `write_nodes` — the `Write` tool. Create new nodes from `{type, ...props, children?}` specs; `children` builds a whole subtree in one call. Placement via `parentId`/`index`. `INSTANCE` needs `componentId`/`componentKey`.
- `get_write_schema` — the write-side schema for a node type: the fields `write_nodes` accepts when creating it (with no `type`, lists the creatable types). Call it before building a node.
- `delete_nodes` — delete one or more nodes (chunked with progress for large batches).
- `clone_node` — copy an existing node with an optional position offset.

### Selection & Channel

- `get_selection` - the current selection
- `set_selections` / `set_focus` - select nodes (and scroll the viewport to them)
- `get_active_channel` - the channel the plugin currently has open (so the agent can join without you pasting it)
- `join_channel` - join a channel to communicate with the plugin

### Components & Styles

- `get_styles` - local styles
- `get_local_components` - local components
- `get_instance_overrides` / `set_instance_overrides` - extract overrides from one instance and apply them to others

### Annotations

- `get_annotations` - all annotations in the document or a node
- `set_annotations` - create/update one or more native annotations (markdown, batched)

### Prototyping & Connections

- `get_reactions` - prototype reactions from nodes
- `set_default_connector` - set a copied FigJam connector as the default style (required before creating connections)
- `create_connections` - FigJam connector lines between nodes

### Export

- `export_node_as_image` - export a node (PNG, JPG, SVG, PDF)

### MCP Prompts

Helper prompts that guide the agent through common tasks:

- `read_design_strategy` - the explore→modify ladder (glob/grep/query → read_node → edit_nodes)
- `design_strategy` - best practices for creating designs
- `text_replacement_strategy` - locating and bulk-replacing text, with chunked visual verification
- `annotation_conversion_strategy` - converting manual annotations to native Figma annotations
- `swap_overrides_instances` - transferring overrides between component instances
- `reaction_to_connector_strategy` - turning prototype reactions into connector lines

## Best Practices

1. Join a channel before sending commands (`get_active_channel` → `join_channel`).
2. **Locate before reading.** Start with `glob_nodes` (e.g. `{type:["SECTION","FRAME"]}` for a screen map), `grep_nodes`, or `query_nodes` to get ids — don't dump a whole subtree to find something.
3. **Read narrowly.** `read_node` only the ids you'll act on; raise `depth` or re-request a stub id to zoom. Width of search is cheap (ids only); depth of detail is not.
4. **Edit surgically.** Use `edit_nodes` with `old` as a guard against stale reads; batch many nodes in one call. Create subtrees with `write_nodes`.
5. For large designs: narrow with `root`/`depth`/`within` and cap with `maxMatches` on the search tools; verify changes with targeted `export_node_as_image`.
6. Prefer component instances for consistency; all commands can throw, so handle errors.

## Development

```bash
bun install        # install dependencies
bun run build      # build the MCP server (tsup → dist/)
bun run dev        # build in watch mode
```

To run the server from your local checkout, point the MCP config at it:

```json
{
  "mcpServers": {
    "TalkToFigma": {
      "command": "bun",
      "args": ["/path-to-repo/src/talk_to_figma_mcp/server.ts"]
    }
  }
}
```

The Figma plugin is **not** bundled — edit `src/claude_mcp_plugin/code.js` and `ui.html` directly.

## Credits

- Upstream: [grab/cursor-talk-to-figma-mcp](https://github.com/grab/cursor-talk-to-figma-mcp); original by [sonnylazuardi](https://github.com/sonnylazuardi/cursor-talk-to-figma-mcp).
- Bulk text replacement and instance-override propagation features by [@dusskapark](https://github.com/dusskapark) ([text demo](https://www.youtube.com/watch?v=j05gGT3xfCs), [overrides demo](https://youtu.be/uvuT8LByroI)).

## License

MIT
