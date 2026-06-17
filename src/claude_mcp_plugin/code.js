// This is the main code file for the Claude MCP Figma plugin
// It handles Figma API commands

// Plugin state
const state = {
  serverPort: 3055, // Default port
};


// Helper function for progress updates
async function sendProgressUpdate(
  commandId,
  commandType,
  status,
  progress,
  totalItems,
  processedItems,
  message,
  payload = null
) {
  const update = {
    type: "command_progress",
    commandId,
    commandType,
    status,
    progress,
    totalItems,
    processedItems,
    message,
    timestamp: Date.now(),
  };

  // Add optional chunk information if present
  if (payload) {
    if (
      payload.currentChunk !== undefined &&
      payload.totalChunks !== undefined
    ) {
      update.currentChunk = payload.currentChunk;
      update.totalChunks = payload.totalChunks;
      update.chunkSize = payload.chunkSize;
    }
    update.payload = payload;
  }

  // Send to UI
  figma.ui.postMessage(update);
  console.log(`Progress update: ${status} - ${progress}% - ${message}`);

  // Yield so the Figma plugin sandbox flushes postMessage to ui.html
  // before the next iteration begins
  await new Promise((resolve) => setTimeout(resolve, 0));

  return update;
}

/**
 * Throttled progress reporter for one long-running command. Every emitted update
 * resets the MCP server's inactivity timer, so a long run (many font loads,
 * exports, component swaps) never trips the 30s command timeout. The first
 * `start()` alone lifts the timeout from 30s to 60s; `tick()` keeps refreshing it.
 *
 * tick() is throttled to at most one update per `everyItems` items OR per
 * `everyMs` ms, whichever comes first — so callers can call it on every node
 * cheaply. start()/done() always emit. When total <= minItems the whole reporter
 * is a no-op, so small interactive calls don't flash the progress bar.
 *
 * @param {string} commandType - tool name echoed in updates (e.g. "write_nodes")
 * @param {number} total - expected item count (progress denominator)
 * @param {{commandId?:string, minItems?:number, everyItems?:number, everyMs?:number}} [opts]
 */
function makeProgress(commandType, total, opts) {
  opts = opts || {};
  const commandId = opts.commandId || generateCommandId();
  const minItems = opts.minItems != null ? opts.minItems : 0;
  const everyItems = opts.everyItems != null ? opts.everyItems : 5;
  const everyMs = opts.everyMs != null ? opts.everyMs : 1500;
  const enabled = total > minItems;
  let lastCount = 0;
  let lastTime = 0;
  // Cap in-progress at 99% — the expected total is a lower bound (failed specs
  // skip their children), so the live ratio can otherwise read past 100.
  const pct = (done) => (total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 0);
  return {
    commandId,
    enabled,
    async start(message) {
      if (!enabled) return;
      lastTime = Date.now();
      await sendProgressUpdate(commandId, commandType, "started", 0, total, 0, message);
    },
    /** Emit an in-progress update if the throttle window has elapsed (or force=true). */
    async tick(done, message, force) {
      if (!enabled) return;
      const now = Date.now();
      if (!force && done - lastCount < everyItems && now - lastTime < everyMs) return;
      lastCount = done;
      lastTime = now;
      await sendProgressUpdate(commandId, commandType, "in_progress", pct(done), total, done, message);
    },
    async done(message) {
      if (!enabled) return;
      await sendProgressUpdate(commandId, commandType, "completed", 100, total, total, message);
    },
  };
}

// Show UI
figma.showUI(__html__, { width: 350, height: 600 });

// @ai-generated(solo)
// File/page context shown alongside each channel so the agent can tell which
// document a channel is open in without opening it.
function getFileInfo() {
  return {
    name: figma.root.name,
    page: figma.currentPage.name,
    // "figma" | "figjam" | "dev" | "slides" — the document kind.
    editorType: figma.editorType,
  };
}

// @ai-generated(solo)
// Stable channel id: a per-file part persisted in the document (pluginData)
// plus a per-machine part (clientStorage). A plugin restart/crash rejoins the
// same channel, so the agent's joined channel stays valid; collaborators
// opening the same file still land in distinct channels via the machine part.
// Returns null when the document is read-only (e.g. Dev Mode) — the UI then
// falls back to a throwaway random channel.
async function getStableChannelId() {
  try {
    let fileId = figma.root.getPluginData("mcpChannelId");
    if (!fileId) {
      fileId = randomChannelPart(8);
      figma.root.setPluginData("mcpChannelId", fileId);
    }
    let machineId = await figma.clientStorage.getAsync("mcpChannelSuffix");
    if (!machineId) {
      machineId = randomChannelPart(4);
      await figma.clientStorage.setAsync("mcpChannelSuffix", machineId);
    }
    return fileId + "-" + machineId;
  } catch (error) {
    return null;
  }
}

function randomChannelPart(length) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

async function sendFileInfo() {
  figma.ui.postMessage({
    type: "file-info",
    info: getFileInfo(),
    channel: await getStableChannelId(),
  });
}

// Push fresh context when the user renames the file or switches pages so the
// relay's record stays accurate without a reconnect.
figma.on("currentpagechange", sendFileInfo);
sendFileInfo();

// Plugin commands from UI
figma.ui.onmessage = async (msg) => {
  switch (msg.type) {
    case "update-settings":
      updateSettings(msg);
      break;
    case "request-file-info":
      // UI loaded/connected after the initial push — answer on demand.
      sendFileInfo();
      break;
    case "notify":
      figma.notify(msg.message);
      break;
    case "close-plugin":
      figma.closePlugin();
      break;
    case "resize-window":
      // UI can't resize itself; it requests a resize from the main thread.
      figma.ui.resize(
        Math.max(1, Math.round(msg.width)),
        Math.max(1, Math.round(msg.height))
      );
      break;
    case "pin-window":
      // Big delta clamps the window into the bottom-left corner.
      figma.ui.reposition(-100000, 100000);
      break;
    case "execute-command":
      // Execute commands received from UI (which gets them from WebSocket)
      try {
        const result = await handleCommand(msg.command, msg.params);
        figma.ui.postMessage({
          type: "command-result",
          id: msg.id,
          result,
        });
      } catch (error) {
        // Figma can throw non-Error values (or Errors with an empty .message);
        // surface .stack/String(error) so the real cause isn't masked by the
        // generic fallback.
        figma.ui.postMessage({
          type: "command-error",
          id: msg.id,
          error:
            error && (error.message || error.stack)
              ? error.message || String(error)
              : "Error executing command: " + String(error),
        });
      }
      break;
  }
};

// Listen for plugin commands from menu
figma.on("run", ({ command }) => {
  figma.ui.postMessage({ type: "auto-connect" });
});

// Update plugin settings
function updateSettings(settings) {
  if (settings.serverPort) {
    state.serverPort = settings.serverPort;
  }

  figma.clientStorage.setAsync("settings", {
    serverPort: state.serverPort,
  });
}

// Handle commands from UI
async function handleCommand(command, params) {
  switch (command) {
    case "get_selection":
      return await getSelection();
    case "read_node":
      if (!params || !params.nodeId) {
        throw new Error("Missing nodeId parameter");
      }
      return await readNode(params.nodeId);
    case "read_node_raw":
      if (!params || !params.nodeId) {
        throw new Error("Missing nodeId parameter");
      }
      return await readNodeRaw(params.nodeId);
    case "write_nodes":
      return await writeNodes(params);
    case "edit_nodes":
      return await editNodes(params);
    case "reparent_nodes":
      return await reparentNodes(params);
    case "delete_nodes":
      return await deleteNodes(params);
    case "get_styles":
      return await getStyles();
    case "write_styles":
      return await writeStyles(params);
    case "edit_styles":
      return await editStyles(params);
    case "get_local_components":
      return await getLocalComponents(params);
    // case "get_team_components":
    //   return await getTeamComponents();
    case "export_node_as_image":
      return await exportNodeAsImage(params);
    case "clone_node":
      return await cloneNode(params);
    case "get_annotations":
      return await getAnnotations(params);
    case "set_annotations":
      return await setAnnotations(params);
    case "glob_nodes":
      return await globNodes(params);
    case "grep_nodes":
      return await grepNodes(params);
    case "query_nodes":
      return await queryNodes(params);
    case "get_instance_overrides":
      // Check if instanceNode parameter is provided
      if (params && params.instanceNodeId) {
        // Get the instance node by ID
        const instanceNode = await figma.getNodeByIdAsync(params.instanceNodeId);
        if (!instanceNode) {
          throw new Error(`Instance node not found with ID: ${params.instanceNodeId}`);
        }
        return await getInstanceOverrides(instanceNode);
      }
      // Call without instance node if not provided
      return await getInstanceOverrides();

    case "set_instance_overrides":
      // Check if instanceNodeIds parameter is provided
      if (params && params.targetNodeIds) {
        // Validate that targetNodeIds is an array
        if (!Array.isArray(params.targetNodeIds)) {
          throw new Error("targetNodeIds must be an array");
        }

        // Get the instance nodes by IDs
        const targetNodes = await getValidTargetInstances(params.targetNodeIds);
        if (!targetNodes.success) {
          figma.notify(targetNodes.message);
          return { success: false, message: targetNodes.message };
        }

        if (params.sourceInstanceId) {

          // get source instance data
          let sourceInstanceData = null;
          sourceInstanceData = await getSourceInstanceData(params.sourceInstanceId);

          if (!sourceInstanceData.success) {
            figma.notify(sourceInstanceData.message);
            return { success: false, message: sourceInstanceData.message };
          }
          return await setInstanceOverrides(targetNodes.targetInstances, sourceInstanceData);
        } else {
          throw new Error("Missing sourceInstanceId parameter");
        }
      }
    case "get_reactions":
      if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
        throw new Error("Missing or invalid nodeIds parameter");
      }
      return await getReactions(params.nodeIds);
    case "set_reactions":
      return await setReactions(params);
    case "set_default_connector":
      return await setDefaultConnector(params);
    case "create_connections":
      return await createConnections(params);
    case "set_focus":
      return await setFocus(params);
    case "set_selections":
      return await setSelections(params);
    case "combine_as_variants":
      return await combineAsVariants(params);
    case "boolean_operation":
      return await booleanOperation(params);
    case "edit_groups":
      return await editGroups(params);
    case "write_table":
      return await writeTable(params);
    case "edit_table":
      return await editTable(params);
    case "get_variables":
      return await getVariables(params);
    case "set_variables":
      return await setVariables(params);
    case "bind_variables":
      return await bindVariables(params);
    case "convert_nodes":
    case "transform_nodes": // legacy alias (pre-rename servers)
      return await convertNodes(params);
    case "list_fonts":
      return await listFonts(params);
    case "style_text_range":
      return await styleTextRange(params);
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// Command implementations

async function getSelection() {
  return {
    selectionCount: figma.currentPage.selection.length,
    selection: figma.currentPage.selection.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      visible: node.visible,
    })),
  };
}

function rgbaToHex(color) {
  var r = Math.round(color.r * 255);
  var g = Math.round(color.g * 255);
  var b = Math.round(color.b * 255);
  var a = color.a !== undefined ? Math.round(color.a * 255) : 255;

  if (a === 255) {
    return (
      "#" +
      [r, g, b]
        .map((x) => {
          return x.toString(16).padStart(2, "0");
        })
        .join("")
    );
  }

  return (
    "#" +
    [r, g, b, a]
      .map((x) => {
        return x.toString(16).padStart(2, "0");
      })
      .join("")
  );
}

function filterFigmaNode(node) {
  // VECTOR leaves: a minimal stub — identity + extent only, never the path
  // geometry (an SVG paste can hold hundreds of these). The server needs the
  // type to detect icon-like subtrees (all-vector leaves) and collapse the
  // whole container into one ICON line; dropping vectors entirely (old
  // behavior) left the wrapper-group matryoshka uncollapsible.
  if (node.type === "VECTOR") {
    var vec = { id: node.id, name: node.name, type: node.type };
    if (node.visible === false) vec.visible = false;
    if (node.absoluteBoundingBox) vec.absoluteBoundingBox = node.absoluteBoundingBox;
    return vec;
  }

  var filtered = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  // Hidden node: the server shows it as {id, hidden:true} (unless it's the
  // requested root). Without this flag a hidden node is indistinguishable from
  // a visible one downstream.
  if (node.visible === false) {
    filtered.visible = false;
  }
  // Layer opacity (distinct from fill alpha); only the non-default is meaningful.
  if (node.opacity !== undefined && node.opacity !== 1) {
    filtered.opacity = node.opacity;
  }
  // Geometry the server needs to cull non-rendering nodes: clipsContent bounds
  // its descendants (anything fully outside is invisible); rotation makes a
  // node's AABB overstate its real coverage, so it must not be treated as a
  // clean opaque occluder.
  if (node.clipsContent === true) {
    filtered.clipsContent = true;
  }
  if (node.rotation) {
    filtered.rotation = node.rotation;
  }

  // Lets the server collapse repeated instances of the same component (consumed,
  // not echoed): the first instance is shown in full, later copies as a stub.
  if (node.componentId) {
    filtered.componentId = node.componentId;
  }
  // The config that distinguishes an instance from its master — shown in place
  // of the hidden internals on a collapsed repeat.
  if (node.componentProperties) {
    filtered.componentProperties = node.componentProperties;
  }

  if (node.fills && node.fills.length > 0) {
    filtered.fills = node.fills.map((fill) => {
      var processedFill = Object.assign({}, fill);
      delete processedFill.boundVariables;
      delete processedFill.imageRef;

      if (processedFill.gradientStops) {
        processedFill.gradientStops = processedFill.gradientStops.map(
          (stop) => {
            var processedStop = Object.assign({}, stop);
            if (processedStop.color) {
              processedStop.color = rgbaToHex(processedStop.color);
            }
            delete processedStop.boundVariables;
            return processedStop;
          }
        );
      }

      if (processedFill.color) {
        processedFill.color = rgbaToHex(processedFill.color);
      }

      return processedFill;
    });
  }

  if (node.strokes && node.strokes.length > 0) {
    filtered.strokes = node.strokes.map((stroke) => {
      var processedStroke = Object.assign({}, stroke);
      delete processedStroke.boundVariables;
      if (processedStroke.color) {
        processedStroke.color = rgbaToHex(processedStroke.color);
      }
      return processedStroke;
    });
  }

  if (node.cornerRadius !== undefined) {
    filtered.cornerRadius = node.cornerRadius;
  }

  // Stroke thickness — often sub-pixel (e.g. a 0.5px border); without it the
  // server can show a border exists but not how thick.
  if (node.strokeWeight !== undefined && node.strokes && node.strokes.length > 0) {
    filtered.strokeWeight = node.strokeWeight;
  }

  if (node.absoluteBoundingBox) {
    filtered.absoluteBoundingBox = node.absoluteBoundingBox;
  }

  if (node.characters) {
    filtered.characters = node.characters;
  }

  // FigJam SHAPE_WITH_TEXT: the shape silhouette (DIAMOND/ROUNDED_RECTANGLE/…),
  // which the REST export carries but the generic copy above doesn't forward.
  if (node.shapeType) {
    filtered.shapeType = node.shapeType;
  }

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

  // Auto-layout spec: forward so the server can present positioning semantics
  // (stack/gap/padding + fill/hug sizing) instead of raw coordinates. Only
  // emit what's present and non-default to keep the payload lean.
  if (node.layoutMode && node.layoutMode !== "NONE") {
    filtered.layoutMode = node.layoutMode;
    if (node.itemSpacing) filtered.itemSpacing = node.itemSpacing;
    if (node.layoutWrap && node.layoutWrap !== "NO_WRAP") filtered.layoutWrap = node.layoutWrap;
    ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].forEach((k) => {
      if (node[k]) filtered[k] = node[k];
    });
    if (node.primaryAxisAlignItems && node.primaryAxisAlignItems !== "MIN")
      filtered.primaryAxisAlignItems = node.primaryAxisAlignItems;
    if (node.counterAxisAlignItems && node.counterAxisAlignItems !== "MIN")
      filtered.counterAxisAlignItems = node.counterAxisAlignItems;
    // Sizing modes (AUTO = hug contents) let the server show "hug" instead of a
    // px size that just duplicates the children's extent. Consumed, not echoed.
    if (node.primaryAxisSizingMode) filtered.primaryAxisSizingMode = node.primaryAxisSizingMode;
    if (node.counterAxisSizingMode) filtered.counterAxisSizingMode = node.counterAxisSizingMode;
  }
  // How this node sizes/positions itself inside an auto-layout parent.
  if (node.layoutAlign && node.layoutAlign !== "INHERIT") filtered.layoutAlign = node.layoutAlign;
  if (node.layoutGrow) filtered.layoutGrow = node.layoutGrow;
  if (node.layoutPositioning && node.layoutPositioning !== "AUTO")
    filtered.layoutPositioning = node.layoutPositioning;

  if (node.children) {
    filtered.children = node.children
      .map((child) => {
        return filterFigmaNode(child);
      })
      .filter((child) => {
        return child !== null;
      });
  }

  return filtered;
}

async function readNode(nodeId) {
  const node = await figma.getNodeByIdAsync(nodeId);

  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  const response = await node.exportAsync({
    format: "JSON_REST_V1",
  });

  const filtered = filterFigmaNode(response.document);

  // Ancestor breadcrumb: the export gives the subtree (downward) but nothing
  // about what contains this node, so a caller that lands here can't tell where
  // it sits without a separate glob. Walk the live node's parents up to the page
  // and attach a root-first chain (page → ... → immediate parent). One small
  // array on the root only — children already carry their own @parent via glob.
  if (filtered) {
    const ancestors = [];
    let p = node.parent;
    while (p && p.type !== "DOCUMENT") {
      ancestors.unshift({ id: p.id, name: p.name, type: p.type });
      if (p.type === "PAGE") break;
      p = p.parent;
    }
    if (ancestors.length) filtered.ancestors = ancestors;
  }

  return filtered;
}

// Full, unfiltered JSON_REST_V1 serialization of a single node, with the
// children array stripped so the caller gets every property of just that node.
async function readNodeRaw(nodeId) {
  const node = await figma.getNodeByIdAsync(nodeId);

  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  const response = await node.exportAsync({
    format: "JSON_REST_V1",
  });

  const document = response.document;
  delete document.children;

  // JSON_REST_V1 encodes per-range text styling as characterStyleOverrides +
  // styleOverrideTable, which is painful to map back to character ranges. Attach
  // the clean live segments (each a [start,end) run with its resolved style) so
  // the agent can see what to target with style_text_range.
  if (node.type === "TEXT") {
    try {
      document.styledTextSegments = node.getStyledTextSegments([
        "fontName",
        "fontSize",
        "fills",
        "fillStyleId",
        "textStyleId",
        "textCase",
        "textDecoration",
        "letterSpacing",
        "lineHeight",
        "hyperlink",
        "listOptions",
        "indentation",
      ]);
    } catch (err) {
      document.styledTextSegmentsError = String((err && err.message) || err);
    }
  }

  return document;
}


async function getReactions(nodeIds) {
  try {
    const progress = makeProgress("get_reactions", nodeIds.length);
    await progress.start(`Starting deep search for reactions in ${nodeIds.length} nodes and their children`);

    // Function to find nodes with reactions from the node and all its children
    async function findNodesWithReactions(node, processedNodes = new Set(), depth = 0, results = []) {
      // Skip already processed nodes (prevent circular references)
      if (processedNodes.has(node.id)) {
        return results;
      }
      
      processedNodes.add(node.id);
      
      // Check if the current node has reactions
      let filteredReactions = [];
      if (node.reactions && node.reactions.length > 0) {
        // Filter out reactions with navigation === 'CHANGE_TO'
        filteredReactions = node.reactions.filter(r => {
          // Some reactions may have action or actions array
          if (r.action && r.action.navigation === 'CHANGE_TO') return false;
          if (Array.isArray(r.actions)) {
            // If any action in actions array is CHANGE_TO, exclude
            return !r.actions.some(a => a.navigation === 'CHANGE_TO');
          }
          return true;
        });
      }
      const hasFilteredReactions = filteredReactions.length > 0;
      
      // If the node has filtered reactions, add it to results
      if (hasFilteredReactions) {
        results.push({
          id: node.id,
          name: node.name,
          type: node.type,
          depth: depth,
          hasReactions: true,
          reactions: filteredReactions,
          path: getNodePath(node)
        });
      }

      // If node has children, recursively search them
      if (node.children) {
        for (const child of node.children) {
          await findNodesWithReactions(child, processedNodes, depth + 1, results);
        }
      }

      return results;
    }

    // Get node hierarchy path as a string
    function getNodePath(node) {
      const path = [];
      let current = node;
      
      while (current && current.parent) {
        path.unshift(current.name);
        current = current.parent;
      }
      
      return path.join(' > ');
    }

    // Array to store all results
    let allResults = [];
    let processedCount = 0;
    const totalCount = nodeIds.length;
    
    // Iterate through each node and its children to search for reactions
    for (let i = 0; i < nodeIds.length; i++) {
      try {
        const nodeId = nodeIds[i];
        const node = await figma.getNodeByIdAsync(nodeId);
        
        if (!node) {
          processedCount++;
          await progress.tick(processedCount, `Node not found: ${nodeId}`);
          continue;
        }

        // Search for reactions in the node and its children
        const processedNodes = new Set();
        const nodeResults = await findNodesWithReactions(node, processedNodes);

        // Add results
        allResults = allResults.concat(nodeResults);

        // Update progress
        processedCount++;
        await progress.tick(processedCount, `Processed node ${processedCount}/${totalCount}, found ${nodeResults.length} nodes with reactions`);
      } catch (error) {
        processedCount++;
        await progress.tick(processedCount, `Error processing node: ${error.message}`);
      }
    }

    await progress.done(`Completed deep search: found ${allResults.length} nodes with reactions.`);

    return {
      nodesCount: nodeIds.length,
      nodesWithReactions: allResults.length,
      nodes: allResults
    };
  } catch (error) {
    throw new Error(`Failed to get reactions: ${error.message}`);
  }
}

// @ai-generated(solo)
// Write-side twin of getReactions: install prototyping reactions onto nodes.
// Each entry is { nodeId, reactions } where `reactions` is a raw Figma Reaction[]
// (trigger + actions). setReactionsAsync REPLACES the node's full reaction list,
// so callers must pass the complete desired set, not a delta. Entries are
// independent — one failure records its error without aborting the rest.
async function setReactions(params) {
  const entries = params && params.reactions;
  if (!Array.isArray(entries)) {
    throw new Error("Missing or invalid 'reactions' parameter; expected an array of { nodeId, reactions }");
  }

  const results = [];
  // Each entry awaits getNodeByIdAsync + setReactionsAsync; a long list can exceed
  // the 30s command timeout, so stream progress to keep the inactivity timer alive.
  const progress = makeProgress("set_reactions", entries.length, { commandId: params && params.commandId, minItems: 5 });
  await progress.start(`Setting reactions on ${entries.length} nodes...`);
  let done = 0;
  for (const entry of entries) {
    await progress.tick(++done, `Processed ${done}/${entries.length}`);
    if (!entry || !entry.nodeId) {
      results.push({ success: false, error: "Missing nodeId in entry" });
      continue;
    }
    try {
      const node = await figma.getNodeByIdAsync(entry.nodeId);
      if (!node) {
        results.push({ nodeId: entry.nodeId, success: false, error: "Node not found" });
        continue;
      }
      // setReactionsAsync lives on most scene nodes but not on the page/document.
      if (typeof node.setReactionsAsync !== "function") {
        results.push({ nodeId: entry.nodeId, success: false, error: `Node type ${node.type} does not support reactions` });
        continue;
      }
      const reactions = Array.isArray(entry.reactions) ? entry.reactions : [];
      await node.setReactionsAsync(reactions);
      results.push({ nodeId: entry.nodeId, name: node.name, success: true, reactionsCount: reactions.length });
    } catch (error) {
      results.push({ nodeId: entry.nodeId, success: false, error: error.message });
    }
  }

  await progress.done(`Set reactions on ${entries.length} nodes`);
  const succeeded = results.filter((r) => r.success).length;
  return { total: entries.length, succeeded, failed: entries.length - succeeded, results };
}

// @ai-generated(solo)
// Create-side twin of editNodes: build new nodes from raw Figma JSON specs.
// Each spec is { type, ...props, children? }. Specs and children are independent
// — a failing one records its Figma error without aborting the rest — and large
// batches stream progress so a long run won't trip the 30s command timeout.
// Count every spec in the tree (roots + all descendants) so progress reflects
// real work, not just the root count — a single root with a deep subtree still
// streams. Cheap walk; no node creation.
function countSpecNodes(specs) {
  let n = 0;
  for (const spec of specs) {
    n++;
    if (spec && Array.isArray(spec.children) && spec.children.length) {
      n += countSpecNodes(spec.children);
    }
  }
  return n;
}

async function writeNodes(params) {
  const { nodes } = params || {};
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("write_nodes requires a non-empty `nodes` array");
  }

  const counts = { created: 0, total: 0 };
  const totalExpected = countSpecNodes(nodes);
  // minItems:0 — stream for ANY create count so the first `start()` lifts the
  // server off its 30s floor even for a single slow node (font load / image
  // import); the reporter throttles the per-node ticks emitted from inside the
  // recursion (see createOneNode), so a tiny call just emits start+done.
  const progress = makeProgress("write_nodes", totalExpected, {
    commandId: params && params.commandId,
    minItems: 0,
  });
  await progress.start(`Creating ${totalExpected} nodes...`);

  const results = [];
  for (let i = 0; i < nodes.length; i++) {
    results.push(await createOneNode(nodes[i], figma.currentPage, counts, progress));
  }

  await progress.done(`Done: ${counts.created} nodes created`);

  return { created: counts.created, total: counts.total, results };
}

const NODE_FACTORIES = {
  RECTANGLE: () => figma.createRectangle(),
  FRAME: () => figma.createFrame(),
  TEXT: () => figma.createText(),
  ELLIPSE: () => figma.createEllipse(),
  LINE: () => figma.createLine(),
  STAR: () => figma.createStar(),
  POLYGON: () => figma.createPolygon(),
  VECTOR: () => figma.createVector(),
  COMPONENT: () => figma.createComponent(),
  SECTION: () => figma.createSection(),
  SLICE: () => figma.createSlice(),
  CODE_BLOCK: () => figma.createCodeBlock(),
  STICKY: () => figma.createSticky(),
  SHAPE_WITH_TEXT: () => figma.createShapeWithText(),
};

// FigJam-only node types: the create* constructors throw in a Figma design file,
// so we pre-check figma.editorType and fail with a clear message instead.
const FIGJAM_TYPES = new Set(["CODE_BLOCK", "STICKY", "SHAPE_WITH_TEXT"]);

// FigJam sticky/shape/connector hold their text on a readonly `.text`
// TextSublayerNode, not on the node itself — these keys route there.
const TEXT_SUBLAYER_TYPES = new Set(["STICKY", "SHAPE_WITH_TEXT", "CONNECTOR"]);
const TEXT_SUBLAYER_KEYS = new Set(["characters", "fontName", "fontSize", "textAlignHorizontal", "letterSpacing", "lineHeight"]);

// Keys consumed by the spec itself rather than written onto the node.
const WRITE_RESERVED = new Set(["type", "parentId", "index", "children", "id", "componentId", "componentKey", "svg", "svgUrl", "svgError"]);

// Apply structural props before cosmetic ones: a font must load before its
// glyphs, layoutMode must exist before padding/spacing it gates, and characters
// goes last so it picks up the resolved font.
function writePropWeight(k) {
  switch (k) {
    case "fontName": return 0;
    case "fontSize": return 1;
    // Bind a text style before letterSpacing/lineHeight/characters: it swaps the
    // node's font to the style's, and those props throw on an unloaded font
    // (setStyleId loads it for us).
    case "textStyleId": return 2;
    case "layoutMode": return 3;
    case "layoutWrap": return 4;
    case "characters": return 99;
    default: return 50;
  }
}

// Recurse hex `color` leaves into Figma rgb 0-1, mirroring edit_nodes' convertWriteValue
// but reaching colors nested inside paint arrays (fills/strokes). Also resolves
// image paints: the server replaces a paint's imageUrl with base64 imageBytes,
// which we import here into a real Figma image + imageHash.
function coerceColors(val) {
  if (Array.isArray(val)) return val.map(coerceColors);
  if (val && typeof val === "object") {
    if (typeof val.imageError === "string") throw new Error(`image fill: ${val.imageError}`);
    if (typeof val.imageBytes === "string") return makeImagePaint(val);
    const out = {};
    for (const k in val) {
      if (k === "color" && typeof val[k] === "string" && /^#[0-9a-fA-F]{3,8}$/.test(val[k])) {
        const rgb = hexToRgb01(val[k]);
        if (!rgb) throw new Error(`invalid hex color "${val[k]}"`);
        out.color = { r: rgb.r, g: rgb.g, b: rgb.b };
        // Hex alpha maps to the paint's opacity unless the spec set one explicitly.
        if (typeof rgb.a === "number" && rgb.a !== 1 && val.opacity === undefined) out.opacity = rgb.a;
      } else {
        out[k] = coerceColors(val[k]);
      }
    }
    return out;
  }
  return val;
}

// Apply a text-ish prop onto a FigJam node's `.text` TextSublayer. Mirrors the
// TEXT-node handling below (a font must be loaded before characters/fontSize).
async function setSublayerTextProp(sub, key, value) {
  if (key === "characters") {
    await setCharacters(sub, String(value)); // loads the sublayer's font (with fallback) itself
    return;
  }
  if (key === "fontName") {
    await figma.loadFontAsync(value);
    sub.fontName = value;
    return;
  }
  if (key === "fontSize") {
    if (sub.fontName && sub.fontName !== figma.mixed) await figma.loadFontAsync(sub.fontName);
    sub.fontSize = value;
    return;
  }
  sub[key] = coerceTypedUnit(key, value); // textAlignHorizontal / letterSpacing / lineHeight
}

// A CodeBlock paints its text — and syntax-highlight weights — in Source Code
// Pro, and figma.createCodeBlock()'s `code` setter requires those fonts already
// loaded. Load every weight the highlighter may reach, best-effort: Medium is
// the base (its absence is fatal), the rest are skipped if the file lacks them.
async function loadCodeBlockFonts() {
  const styles = ["Medium", "Regular", "Semi Bold", "Bold"];
  let base = false;
  for (const style of styles) {
    try {
      await figma.loadFontAsync({ family: "Source Code Pro", style });
      if (style === "Medium") base = true;
    } catch (e) {
      if (style === "Medium") throw new Error("could not load Source Code Pro Medium (required for CODE_BLOCK `code`)");
    }
  }
  return base;
}

async function setWriteProp(node, key, value) {
  // FigJam sticky/shape/connector: text-ish props live on node.text, not the node.
  if (TEXT_SUBLAYER_TYPES.has(node.type) && TEXT_SUBLAYER_KEYS.has(key)) {
    await setSublayerTextProp(node.text, key, value);
    return;
  }
  // INSTANCE variant/prop overrides go through setProperties, not assignment.
  if (key === "componentProperties") {
    if (!value || typeof value !== "object") throw new Error("componentProperties must be a {name: value} object");
    applyComponentProperties(node, value);
    return;
  }
  if (key === "characters") {
    if (node.type !== "TEXT") throw new Error(`characters can only be set on TEXT nodes, not ${node.type}`);
    await setCharacters(node, String(value)); // loads the node's font (with fallback) itself
    return;
  }
  // CODE_BLOCK renders its text in Source Code Pro; the `code` setter needs that
  // font loaded first (it doesn't load it itself), so assignment alone throws.
  if (key === "code" && node.type === "CODE_BLOCK") {
    await loadCodeBlockFonts();
    node.code = String(value);
    return;
  }
  if (key === "fontName") {
    await figma.loadFontAsync(value); // throws on an unavailable family/style — surfaced to the agent
    node.fontName = value;
    return;
  }
  if (key === "fontSize" && node.type === "TEXT" && node.fontName && node.fontName !== figma.mixed) {
    await figma.loadFontAsync(node.fontName);
  }
  // Style-id props are read-only under documentAccess:dynamic-page — bind via the
  // async setter so the style resolves across pages (assignment throws).
  if (STYLE_ID_SETTERS[key]) {
    await setStyleId(node, key, value);
    return;
  }
  if (key === "effects") {
    node.effects = normalizeEffects(value);
    return;
  }
  node[key] = coerceColors(coerceTypedUnit(key, value));
}

// Style-id properties have no assignable setter under documentAccess:dynamic-page
// (the manifest opts in) — Figma makes them read-only and exposes an async setter
// that resolves the style across pages. Map each id prop to its setter.
const STYLE_ID_SETTERS = {
  fillStyleId: "setFillStyleIdAsync",
  strokeStyleId: "setStrokeStyleIdAsync",
  effectStyleId: "setEffectStyleIdAsync",
  gridStyleId: "setGridStyleIdAsync",
  textStyleId: "setTextStyleIdAsync",
};

async function setStyleId(node, key, value) {
  const method = STYLE_ID_SETTERS[key];
  if (typeof node[method] !== "function") throw new Error(`${node.type} does not support ${key}`);
  await node[method](value == null ? "" : String(value)); // "" detaches the style
  // A bound text style swaps the node to the style's font; load it so a later
  // letterSpacing/lineHeight/characters write in the same batch doesn't throw on
  // an unloaded font (the setter doesn't load it itself).
  if (key === "textStyleId" && node.type === "TEXT" && node.fontName && node.fontName !== figma.mixed) {
    await figma.loadFontAsync(node.fontName);
  }
}

// Figma's Effect setters validate per-type, and the STYLE setter (style.effects)
// is stricter than the node setter: it needs a shadow color that carries an alpha
// channel and rejects showShadowBehindNode on effects that don't define it (only
// DROP_SHADOW does). Normalize both paths to one well-formed shape so an effect
// that applies to a node also applies as a style. Hex `color` is converted (with
// alpha) like coerceColors does elsewhere.
function normalizeEffects(effects) {
  if (!Array.isArray(effects)) return coerceColors(effects);
  return effects.map((e) => {
    if (!e || typeof e !== "object") return e;
    const out = Object.assign({}, e);
    if (out.color !== undefined) {
      const c = out.color;
      if (typeof c === "string") {
        const rgb = hexToRgb01(c);
        if (!rgb) throw new Error(`invalid hex color "${c}" in effect`);
        out.color = { r: rgb.r, g: rgb.g, b: rgb.b, a: typeof rgb.a === "number" ? rgb.a : 1 };
      } else if (c && typeof c === "object") {
        out.color = { r: c.r, g: c.g, b: c.b, a: typeof c.a === "number" ? c.a : 1 };
      }
    }
    // showShadowBehindNode is a DROP_SHADOW-only field; carrying it on other
    // effect types makes the stricter style setter throw.
    if (out.type !== "DROP_SHADOW" && "showShadowBehindNode" in out) delete out.showShadowBehindNode;
    return out;
  });
}

// Figma's letterSpacing/lineHeight are {value, unit} objects — a bare number
// would throw. Accept the number as a PIXELS shorthand (the common intent);
// callers pass the object form for PERCENT/AUTO.
function coerceTypedUnit(key, value) {
  if ((key === "letterSpacing" || key === "lineHeight") && typeof value === "number") {
    return { value, unit: "PIXELS" };
  }
  return value;
}

// Build one node and its subtree. Hard failures (bad type, missing parent,
// uninstantiable component) reject the whole spec; a single rejected property
// is recorded in `errors` and the node survives with its other props.
async function createOneNode(spec, fallbackParent, counts, progress) {
  counts.total++;
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return { ok: false, type: undefined, error: "node spec must be an object" };
  }
  const type = String(spec.type || "").toUpperCase();

  let node;
  try {
    if (!type) throw new Error("node spec needs a `type`");
    if (FIGJAM_TYPES.has(type) && figma.editorType !== "figjam") {
      throw new Error(`${type} requires a FigJam file (current editor: ${figma.editorType})`);
    }
    if (type === "INSTANCE") {
      node = await instantiateComponent(spec);
    } else if (type === "SVG") {
      if (typeof spec.svgError === "string") throw new Error(`svg import: ${spec.svgError}`);
      if (typeof spec.svg !== "string" || !spec.svg) throw new Error("SVG needs `svg` markup or `svgUrl`");
      node = figma.createNodeFromSvg(spec.svg);
    } else {
      const make = NODE_FACTORIES[type];
      if (!make) throw new Error(`unsupported node type "${type}"`);
      node = make();
    }

    // Resolve placement, then append before writing props so layout-relative
    // props (layoutSizing FILL/HUG, index) resolve against the real parent.
    let parent = fallbackParent || figma.currentPage;
    if (spec.parentId) {
      const p = await figma.getNodeByIdAsync(spec.parentId);
      if (!p) throw new Error(`parent not found: ${spec.parentId}`);
      if (!("appendChild" in p)) throw new Error(`parent ${spec.parentId} cannot have children`);
      parent = p;
    }
    if (typeof spec.index === "number" && "insertChild" in parent) parent.insertChild(spec.index, node);
    else parent.appendChild(node);
  } catch (err) {
    if (node) node.remove(); // don't leave an orphan from a half-done create
    return { ok: false, type: type || undefined, error: err && err.message ? err.message : String(err) };
  }

  const propErrors = [];

  // width/height go through resize() together, not assignment.
  if ("width" in spec || "height" in spec) {
    try {
      if (!("resize" in node)) throw new Error(`${node.type} does not support resizing`);
      const w = spec.width != null ? Number(spec.width) : node.width;
      const h = spec.height != null ? Number(spec.height) : node.height;
      node.resize(w, h);
    } catch (err) {
      propErrors.push({ key: "width/height", error: err && err.message ? err.message : String(err) });
    }
  }

  const keys = Object.keys(spec)
    .filter((k) => !WRITE_RESERVED.has(k) && k !== "width" && k !== "height")
    .sort((a, b) => writePropWeight(a) - writePropWeight(b));
  for (const key of keys) {
    try {
      await setWriteProp(node, key, spec[key]);
    } catch (err) {
      propErrors.push({ key, error: err && err.message ? err.message : String(err) });
    }
  }

  counts.created++;
  const result = { ok: true, id: node.id, type: node.type, name: node.name };
  if (propErrors.length) result.errors = propErrors;

  // Tick before recursing so each subtree level keeps the inactivity timer alive
  // (throttled inside the reporter, so calling it per node is cheap).
  if (progress) await progress.tick(counts.total, `Created ${counts.created} nodes so far`);

  if (Array.isArray(spec.children) && spec.children.length) {
    if (!("appendChild" in node)) {
      result.errors = (result.errors || []).concat({ key: "children", error: `${node.type} cannot have children` });
    } else {
      result.children = [];
      for (const child of spec.children) {
        result.children.push(await createOneNode(child, node, counts, progress));
      }
    }
  }
  return result;
}

// Resolve an INSTANCE spec's source component (local id or published key) and
// instantiate it; the generic flow then appends and writes its props.
async function instantiateComponent(spec) {
  const { componentId, componentKey } = spec;
  if (!componentId && !componentKey) {
    throw new Error("INSTANCE needs `componentId` (local component) or `componentKey` (published library component)");
  }
  if (componentId) {
    const n = await figma.getNodeByIdAsync(componentId);
    if (!n) throw new Error(`component not found: ${componentId}`);
    if (n.type !== "COMPONENT") throw new Error(`node ${componentId} is ${n.type}, not a COMPONENT`);
    return n.createInstance();
  }
  const component = await figma.importComponentByKeyAsync(componentKey);
  return component.createInstance();
}

// Fill/stroke colors are set via edit_nodes (fills/strokes/strokeWeight paths) — no dedicated handler.

async function getStyles() {
  const styles = {
    colors: await figma.getLocalPaintStylesAsync(),
    texts: await figma.getLocalTextStylesAsync(),
    effects: await figma.getLocalEffectStylesAsync(),
    grids: await figma.getLocalGridStylesAsync(),
  };

  return {
    colors: styles.colors.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
      paint: style.paints[0],
    })),
    texts: styles.texts.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
      fontSize: style.fontSize,
      fontName: style.fontName,
    })),
    effects: styles.effects.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
    })),
    grids: styles.grids.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
    })),
  };
}

const STYLE_FACTORIES = {
  PAINT: () => figma.createPaintStyle(),
  TEXT: () => figma.createTextStyle(),
  EFFECT: () => figma.createEffectStyle(),
  GRID: () => figma.createGridStyle(),
};

async function localStylesOfType(type) {
  switch (type) {
    case "PAINT": return await figma.getLocalPaintStylesAsync();
    case "TEXT": return await figma.getLocalTextStylesAsync();
    case "EFFECT": return await figma.getLocalEffectStylesAsync();
    case "GRID": return await figma.getLocalGridStylesAsync();
    default: throw new Error(`unsupported style type "${type}" (PAINT|TEXT|EFFECT|GRID)`);
  }
}

// PAINT styles accept the full `paints` array, a single `paint`, or a `color`
// hex shorthand for the common one-solid case. Hex colors anywhere are converted
// by coerceColors (same path as node fills).
function stylePaintsFromSpec(spec) {
  if (spec.paints !== undefined) return coerceColors(spec.paints);
  if (spec.paint !== undefined) return coerceColors([spec.paint]);
  if (typeof spec.color === "string") {
    const rgb = hexToRgb01(spec.color);
    if (!rgb) throw new Error(`invalid hex color "${spec.color}"`);
    const p = { type: "SOLID", color: { r: rgb.r, g: rgb.g, b: rgb.b } };
    if (typeof rgb.a === "number" && rgb.a !== 1) p.opacity = rgb.a;
    if (typeof spec.opacity === "number") p.opacity = spec.opacity;
    return [p];
  }
  return undefined;
}

// Write the per-type properties onto a style object. Shared by write_styles
// (fresh style) and edit_styles (existing style). Only keys present in `spec`
// are touched, so edits are partial.
async function applyStyleProps(style, spec) {
  if (typeof spec.name === "string") style.name = spec.name;
  if (typeof spec.description === "string") style.description = spec.description;

  if (style.type === "PAINT") {
    const paints = stylePaintsFromSpec(spec);
    if (paints !== undefined) style.paints = paints;
  } else if (style.type === "TEXT") {
    // Any text prop on a TextStyle requires its font to be loaded first; load the
    // incoming font (or the style's current one) before writing.
    const targetFont = spec.fontName || style.fontName;
    if (targetFont && targetFont !== figma.mixed) await figma.loadFontAsync(targetFont);
    if (spec.fontName !== undefined) style.fontName = spec.fontName;
    if (spec.fontSize !== undefined) style.fontSize = spec.fontSize;
    if (spec.lineHeight !== undefined) style.lineHeight = coerceTypedUnit("lineHeight", spec.lineHeight);
    if (spec.letterSpacing !== undefined) style.letterSpacing = coerceTypedUnit("letterSpacing", spec.letterSpacing);
    if (spec.paragraphSpacing !== undefined) style.paragraphSpacing = spec.paragraphSpacing;
    if (spec.paragraphIndent !== undefined) style.paragraphIndent = spec.paragraphIndent;
    if (spec.textCase !== undefined) style.textCase = spec.textCase;
    if (spec.textDecoration !== undefined) style.textDecoration = spec.textDecoration;
  } else if (style.type === "EFFECT") {
    // Same normalization node effects get, so a spec that works on a node works
    // as a style (shadow color gets alpha, stray showShadowBehindNode dropped).
    if (spec.effects !== undefined) style.effects = normalizeEffects(spec.effects);
  } else if (style.type === "GRID") {
    if (spec.layoutGrids !== undefined) style.layoutGrids = coerceColors(spec.layoutGrids);
  }
}

async function resolveStyle(spec) {
  if (spec.id) {
    const s = await figma.getStyleByIdAsync(spec.id);
    if (!s) throw new Error("style not found by id: " + spec.id);
    return s;
  }
  if (spec.name && spec.type) {
    const type = String(spec.type).toUpperCase();
    const list = await localStylesOfType(type);
    return list.find((s) => s.name === spec.name) || null;
  }
  throw new Error("edit_styles entry needs `id`, or `name` + `type`");
}

async function writeStyles(params) {
  const input = (params && params.styles) || [];
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("write_styles requires a non-empty `styles` array");
  }
  const out = [];
  const progress = makeProgress("write_styles", input.length, { commandId: params && params.commandId, minItems: 5 });
  await progress.start(`Creating ${input.length} styles...`);
  let done = 0;
  for (const spec of input) {
    await progress.tick(++done, `Created ${done}/${input.length} styles`);
    const type = String((spec && spec.type) || "").toUpperCase();
    const make = STYLE_FACTORIES[type];
    if (!make) {
      out.push({ ok: false, type: spec && spec.type, error: `unsupported style type "${spec && spec.type}" (PAINT|TEXT|EFFECT|GRID)` });
      continue;
    }
    if (!spec.name) {
      out.push({ ok: false, type, error: "style needs a `name`" });
      continue;
    }
    let style;
    try {
      style = make();
      style.name = spec.name;
      await applyStyleProps(style, spec);
      out.push({ ok: true, id: style.id, key: style.key, name: style.name, type: style.type });
    } catch (e) {
      if (style) { try { style.remove(); } catch (_) {} } // no half-created style on failure
      out.push({ ok: false, type, error: e && e.message ? e.message : String(e) });
    }
  }
  await progress.done(`Created ${out.filter((s) => s.ok).length}/${input.length} styles`);
  return { styles: out, created: out.filter((s) => s.ok).length, total: input.length };
}

async function editStyles(params) {
  const input = (params && params.styles) || [];
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("edit_styles requires a non-empty `styles` array");
  }
  const out = [];
  const progress = makeProgress("edit_styles", input.length, { commandId: params && params.commandId, minItems: 5 });
  await progress.start(`Editing ${input.length} styles...`);
  let done = 0;
  for (const spec of input) {
    await progress.tick(++done, `Edited ${done}/${input.length} styles`);
    try {
      const style = await resolveStyle(spec);
      if (!style) throw new Error("style not found: " + (spec.name || spec.id));
      if (spec.remove === true) {
        const info = { ok: true, id: style.id, name: style.name, type: style.type, removed: true };
        style.remove();
        out.push(info);
        continue;
      }
      await applyStyleProps(style, spec);
      out.push({ ok: true, id: style.id, key: style.key, name: style.name, type: style.type });
    } catch (e) {
      out.push({ ok: false, id: spec && spec.id, name: spec && spec.name, error: e && e.message ? e.message : String(e) });
    }
  }
  await progress.done(`Edited ${out.filter((s) => s.ok).length}/${input.length} styles`);
  return { styles: out, updated: out.filter((s) => s.ok && !s.removed).length, removed: out.filter((s) => s.removed).length, total: input.length };
}

async function getLocalComponents(params) {
  const pages = figma.root.children;
  const totalPages = pages.length;
  // Page loadAsync + findAllWithCriteria per page can be slow on big files; frame
  // and tick per page so the scan never trips the command timeout.
  const progress = makeProgress("get_local_components", totalPages, {
    commandId: params && params.commandId,
    everyItems: 1,
  });
  await progress.start("Starting component scan across " + totalPages + " pages...");

  var allComponents = [];

  for (var i = 0; i < totalPages; i++) {
    var page = pages[i];
    await page.loadAsync();

    var pageComponents = page.findAllWithCriteria({ types: ["COMPONENT"] });

    for (var j = 0; j < pageComponents.length; j++) {
      var component = pageComponents[j];
      allComponents.push({
        id: component.id,
        name: component.name,
        key: "key" in component ? component.key : null,
      });
    }

    await progress.tick(i + 1, "Scanned " + page.name + ": " + pageComponents.length + " components (total so far: " + allComponents.length + ")");
  }

  await progress.done("Found " + allComponents.length + " components across " + totalPages + " pages");

  return {
    count: allComponents.length,
    components: allComponents,
  };
}

// async function getTeamComponents() {
//   try {
//     const teamComponents =
//       await figma.teamLibrary.getAvailableComponentsAsync();

//     return {
//       count: teamComponents.length,
//       components: teamComponents.map((component) => ({
//         key: component.key,
//         name: component.name,
//         description: component.description,
//         libraryName: component.libraryName,
//       })),
//     };
//   } catch (error) {
//     throw new Error(`Error getting team components: ${error.message}`);
//   }
// }

const EXPORT_MIME_TYPES = {
  PNG: "image/png",
  JPG: "image/jpeg",
  SVG: "image/svg+xml",
  PDF: "application/pdf",
};

async function exportNodeAsImage(params) {
  const { nodeId, format = "PNG", scale = 1 } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }
  if (!EXPORT_MIME_TYPES[format]) {
    throw new Error(`Unsupported export format: ${format}`);
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }
  if (!("exportAsync" in node)) {
    throw new Error(`Node does not support exporting: ${nodeId}`);
  }

  const mimeType = EXPORT_MIME_TYPES[format];
  // The SCALE constraint only affects raster output; SVG/PDF are vector, so a
  // list of scales collapses to a single export for them.
  const usesScale = format === "PNG" || format === "JPG";
  const scales = usesScale && Array.isArray(scale) ? scale : [usesScale ? scale : 1];

  // exportAsync + base64-encoding a large node can run long; framing here lifts
  // the command timeout from 30s to 60s, and a tick before each scale resets the
  // inactivity timer right before that scale's heavy export begins.
  const progress = makeProgress("export_node_as_image", scales.length, {
    commandId: params && params.commandId,
  });
  await progress.start(`Exporting ${nodeId} as ${format} (${scales.length} scale(s))...`);

  try {
    const images = [];
    for (let i = 0; i < scales.length; i++) {
      const s = scales[i];
      await progress.tick(i, `Exporting scale ${i + 1}/${scales.length} (@${s}x)`, true);
      const settings = usesScale
        ? { format, constraint: { type: "SCALE", value: s } }
        : { format };
      const bytes = await node.exportAsync(settings);
      images.push({ scale: s, imageData: customBase64Encode(bytes) });
    }

    await progress.done(`Exported ${images.length} image(s)`);

    return {
      nodeId,
      format,
      mimeType,
      images,
    };
  } catch (error) {
    throw new Error(`Error exporting node as image: ${error.message}`);
  }
}
// Decode a base64 string into a Uint8Array. No atob in the plugin sandbox, so
// decode by hand (inverse of customBase64Encode).
function customBase64Decode(base64) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;

  let len = base64.length;
  while (len > 0 && base64[len - 1] === "=") len--; // ignore padding
  const byteLength = (len * 3) >> 2;
  const bytes = new Uint8Array(byteLength);

  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const a = lookup[base64.charCodeAt(i)];
    const b = lookup[base64.charCodeAt(i + 1)];
    const c = lookup[base64.charCodeAt(i + 2)];
    const d = lookup[base64.charCodeAt(i + 3)];
    if (p < byteLength) bytes[p++] = (a << 2) | (b >> 4);
    if (p < byteLength) bytes[p++] = ((b & 15) << 4) | (c >> 2);
    if (p < byteLength) bytes[p++] = ((c & 3) << 6) | d;
  }
  return bytes;
}

// Build an IMAGE paint from a server-resolved paint carrying base64 imageBytes:
// import the bytes into Figma (sync) and swap in the resulting imageHash.
function makeImagePaint(paint) {
  const image = figma.createImage(customBase64Decode(paint.imageBytes));
  const out = {};
  for (const k in paint) {
    if (k === "imageBytes" || k === "imageUrl" || k === "imageError") continue;
    out[k] = paint[k];
  }
  out.type = "IMAGE";
  out.imageHash = image.hash;
  if (!out.scaleMode) out.scaleMode = "FILL";
  return out;
}

function customBase64Encode(bytes) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let base64 = "";

  const byteLength = bytes.byteLength;
  const byteRemainder = byteLength % 3;
  const mainLength = byteLength - byteRemainder;

  let a, b, c, d;
  let chunk;

  // Main loop deals with bytes in chunks of 3
  for (let i = 0; i < mainLength; i = i + 3) {
    // Combine the three bytes into a single integer
    chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];

    // Use bitmasks to extract 6-bit segments from the triplet
    a = (chunk & 16515072) >> 18; // 16515072 = (2^6 - 1) << 18
    b = (chunk & 258048) >> 12; // 258048 = (2^6 - 1) << 12
    c = (chunk & 4032) >> 6; // 4032 = (2^6 - 1) << 6
    d = chunk & 63; // 63 = 2^6 - 1

    // Convert the raw binary segments to the appropriate ASCII encoding
    base64 += chars[a] + chars[b] + chars[c] + chars[d];
  }

  // Deal with the remaining bytes and padding
  if (byteRemainder === 1) {
    chunk = bytes[mainLength];

    a = (chunk & 252) >> 2; // 252 = (2^6 - 1) << 2

    // Set the 4 least significant bits to zero
    b = (chunk & 3) << 4; // 3 = 2^2 - 1

    base64 += chars[a] + chars[b] + "==";
  } else if (byteRemainder === 2) {
    chunk = (bytes[mainLength] << 8) | bytes[mainLength + 1];

    a = (chunk & 64512) >> 10; // 64512 = (2^6 - 1) << 10
    b = (chunk & 1008) >> 4; // 1008 = (2^6 - 1) << 4

    // Set the 2 least significant bits to zero
    c = (chunk & 15) << 2; // 15 = 2^4 - 1

    base64 += chars[a] + chars[b] + chars[c] + "=";
  }

  return base64;
}

function uniqBy(arr, predicate) {
  const cb = typeof predicate === "function" ? predicate : (o) => o[predicate];
  return [
    ...arr
      .reduce((map, item) => {
        const key = item === null || item === undefined ? item : cb(item);

        map.has(key) || map.set(key, item);

        return map;
      }, new Map())
      .values(),
  ];
}
const setCharacters = async (node, characters, options) => {
  const fallbackFont = (options && options.fallbackFont) || {
    family: "Inter",
    style: "Regular",
  };
  try {
    if (node.fontName === figma.mixed) {
      if (options && options.smartStrategy === "prevail") {
        const fontHashTree = {};
        for (let i = 1; i < node.characters.length; i++) {
          const charFont = node.getRangeFontName(i - 1, i);
          const key = `${charFont.family}::${charFont.style}`;
          fontHashTree[key] = fontHashTree[key] ? fontHashTree[key] + 1 : 1;
        }
        const prevailedTreeItem = Object.entries(fontHashTree).sort(
          (a, b) => b[1] - a[1]
        )[0];
        const [family, style] = prevailedTreeItem[0].split("::");
        const prevailedFont = {
          family,
          style,
        };
        await figma.loadFontAsync(prevailedFont);
        node.fontName = prevailedFont;
      } else if (options && options.smartStrategy === "strict") {
        return setCharactersWithStrictMatchFont(node, characters, fallbackFont);
      } else if (options && options.smartStrategy === "experimental") {
        return setCharactersWithSmartMatchFont(node, characters, fallbackFont);
      } else {
        const firstCharFont = node.getRangeFontName(0, 1);
        await figma.loadFontAsync(firstCharFont);
        node.fontName = firstCharFont;
      }
    } else {
      await figma.loadFontAsync({
        family: node.fontName.family,
        style: node.fontName.style,
      });
    }
  } catch (err) {
    console.warn(
      `Failed to load "${node.fontName["family"]} ${node.fontName["style"]}" font and replaced with fallback "${fallbackFont.family} ${fallbackFont.style}"`,
      err
    );
    await figma.loadFontAsync(fallbackFont);
    node.fontName = fallbackFont;
  }
  try {
    node.characters = characters;
    return true;
  } catch (err) {
    console.warn(`Failed to set characters. Skipped.`, err);
    return false;
  }
};

const setCharactersWithStrictMatchFont = async (
  node,
  characters,
  fallbackFont
) => {
  const fontHashTree = {};
  for (let i = 1; i < node.characters.length; i++) {
    const startIdx = i - 1;
    const startCharFont = node.getRangeFontName(startIdx, i);
    const startCharFontVal = `${startCharFont.family}::${startCharFont.style}`;
    while (i < node.characters.length) {
      i++;
      const charFont = node.getRangeFontName(i - 1, i);
      if (startCharFontVal !== `${charFont.family}::${charFont.style}`) {
        break;
      }
    }
    fontHashTree[`${startIdx}_${i}`] = startCharFontVal;
  }
  await figma.loadFontAsync(fallbackFont);
  node.fontName = fallbackFont;
  node.characters = characters;
  console.log(fontHashTree);
  await Promise.all(
    Object.keys(fontHashTree).map(async (range) => {
      console.log(range, fontHashTree[range]);
      const [start, end] = range.split("_");
      const [family, style] = fontHashTree[range].split("::");
      const matchedFont = {
        family,
        style,
      };
      await figma.loadFontAsync(matchedFont);
      return node.setRangeFontName(Number(start), Number(end), matchedFont);
    })
  );
  return true;
};

const getDelimiterPos = (str, delimiter, startIdx = 0, endIdx = str.length) => {
  const indices = [];
  let temp = startIdx;
  for (let i = startIdx; i < endIdx; i++) {
    if (
      str[i] === delimiter &&
      i + startIdx !== endIdx &&
      temp !== i + startIdx
    ) {
      indices.push([temp, i + startIdx]);
      temp = i + startIdx + 1;
    }
  }
  temp !== endIdx && indices.push([temp, endIdx]);
  return indices.filter(Boolean);
};

const buildLinearOrder = (node) => {
  const fontTree = [];
  const newLinesPos = getDelimiterPos(node.characters, "\n");
  newLinesPos.forEach(([newLinesRangeStart, newLinesRangeEnd], n) => {
    const newLinesRangeFont = node.getRangeFontName(
      newLinesRangeStart,
      newLinesRangeEnd
    );
    if (newLinesRangeFont === figma.mixed) {
      const spacesPos = getDelimiterPos(
        node.characters,
        " ",
        newLinesRangeStart,
        newLinesRangeEnd
      );
      spacesPos.forEach(([spacesRangeStart, spacesRangeEnd], s) => {
        const spacesRangeFont = node.getRangeFontName(
          spacesRangeStart,
          spacesRangeEnd
        );
        if (spacesRangeFont === figma.mixed) {
          const spacesRangeFont = node.getRangeFontName(
            spacesRangeStart,
            spacesRangeStart[0]
          );
          fontTree.push({
            start: spacesRangeStart,
            delimiter: " ",
            family: spacesRangeFont.family,
            style: spacesRangeFont.style,
          });
        } else {
          fontTree.push({
            start: spacesRangeStart,
            delimiter: " ",
            family: spacesRangeFont.family,
            style: spacesRangeFont.style,
          });
        }
      });
    } else {
      fontTree.push({
        start: newLinesRangeStart,
        delimiter: "\n",
        family: newLinesRangeFont.family,
        style: newLinesRangeFont.style,
      });
    }
  });
  return fontTree
    .sort((a, b) => +a.start - +b.start)
    .map(({ family, style, delimiter }) => ({ family, style, delimiter }));
};

const setCharactersWithSmartMatchFont = async (
  node,
  characters,
  fallbackFont
) => {
  const rangeTree = buildLinearOrder(node);
  const fontsToLoad = uniqBy(
    rangeTree,
    ({ family, style }) => `${family}::${style}`
  ).map(({ family, style }) => ({
    family,
    style,
  }));

  await Promise.all([...fontsToLoad, fallbackFont].map(figma.loadFontAsync));

  node.fontName = fallbackFont;
  node.characters = characters;

  let prevPos = 0;
  rangeTree.forEach(({ family, style, delimiter }) => {
    if (prevPos < node.characters.length) {
      const delimeterPos = node.characters.indexOf(delimiter, prevPos);
      const endPos =
        delimeterPos > prevPos ? delimeterPos : node.characters.length;
      const matchedFont = {
        family,
        style,
      };
      node.setRangeFontName(prevPos, endPos, matchedFont);
      prevPos = endPos + 1;
    }
  });
  return true;
};

// Clone one or many nodes. The server sends the batch shape `{clones:[{nodeId,x?,y?}]}`;
// the single `{nodeId,x?,y?}` shape is still honored for back-compat with an older server.
async function cloneNode(params) {
  params = params || {};

  let specs;
  if (Array.isArray(params.clones) && params.clones.length) {
    specs = params.clones;
  } else if (params.nodeId) {
    specs = [{ nodeId: params.nodeId, x: params.x, y: params.y }];
  } else {
    throw new Error("clone_node requires `nodeId` or a non-empty `clones` array");
  }

  const progress = makeProgress("clone_node", specs.length, {
    commandId: params.commandId,
    minItems: 0,
  });
  await progress.start(`Cloning ${specs.length} nodes...`);

  const results = [];
  let cloned = 0;
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i] || {};
    try {
      if (!spec.nodeId) throw new Error("Missing nodeId");
      const node = await figma.getNodeByIdAsync(spec.nodeId);
      if (!node) throw new Error(`Node not found with ID: ${spec.nodeId}`);

      const clone = node.clone();

      if (spec.x !== undefined && spec.y !== undefined) {
        if (!("x" in clone) || !("y" in clone)) {
          throw new Error(`Cloned node does not support position: ${spec.nodeId}`);
        }
        clone.x = spec.x;
        clone.y = spec.y;
      }

      // Place the clone in the same parent as its source.
      (node.parent || figma.currentPage).appendChild(clone);

      results.push({
        ok: true,
        id: clone.id,
        name: clone.name,
        x: "x" in clone ? clone.x : undefined,
        y: "y" in clone ? clone.y : undefined,
        width: "width" in clone ? clone.width : undefined,
        height: "height" in clone ? clone.height : undefined,
      });
      cloned++;
    } catch (e) {
      results.push({ ok: false, nodeId: spec.nodeId, error: e instanceof Error ? e.message : String(e) });
    }
    await progress.tick(i + 1, `Cloned ${cloned}/${specs.length}`);
  }

  await progress.done(`Done: ${cloned} clones created`);
  return { cloned, total: specs.length, results };
}

// Function to generate simple UUIDs for command IDs
function generateCommandId() {
  return (
    "cmd_" +
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15)
  );
}

async function getAnnotations(params) {
  try {
    const { nodeId, includeCategories = true } = params;

    // Get categories first if needed
    let categoriesMap = {};
    if (includeCategories) {
      const categories = await figma.annotations.getAnnotationCategoriesAsync();
      categoriesMap = categories.reduce((map, category) => {
        map[category.id] = {
          id: category.id,
          label: category.label,
          color: category.color,
          isPreset: category.isPreset,
        };
        return map;
      }, {});
    }

    if (nodeId) {
      // Get annotations for a specific node
      const node = await figma.getNodeByIdAsync(nodeId);
      if (!node) {
        throw new Error(`Node not found: ${nodeId}`);
      }

      if (!("annotations" in node)) {
        throw new Error(`Node type ${node.type} does not support annotations`);
      }

      // Collect annotations from this node and all its descendants
      const mergedAnnotations = [];
      const collect = async (n) => {
        if ("annotations" in n && n.annotations && n.annotations.length > 0) {
          for (const a of n.annotations) {
            mergedAnnotations.push({ nodeId: n.id, annotation: a });
          }
        }
        if ("children" in n) {
          for (const child of n.children) {
            await collect(child);
          }
        }
      };
      await collect(node);

      const result = {
        nodeId: node.id,
        name: node.name,
        annotations: mergedAnnotations,
      };

      if (includeCategories) {
        result.categories = Object.values(categoriesMap);
      }

      return result;
    } else {
      // Get all annotations in the current page
      const annotations = [];
      const processNode = async (node) => {
        if (
          "annotations" in node &&
          node.annotations &&
          node.annotations.length > 0
        ) {
          annotations.push({
            nodeId: node.id,
            name: node.name,
            annotations: node.annotations,
          });
        }
        if ("children" in node) {
          for (const child of node.children) {
            await processNode(child);
          }
        }
      };

      // Start from current page
      await processNode(figma.currentPage);

      const result = {
        annotatedNodes: annotations,
      };

      if (includeCategories) {
        result.categories = Object.values(categoriesMap);
      }

      return result;
    }
  } catch (error) {
    console.error("Error in getAnnotations:", error);
    throw error;
  }
}

async function setAnnotation(params) {
  try {
    console.log("=== setAnnotation Debug Start ===");
    console.log("Input params:", JSON.stringify(params, null, 2));

    const { nodeId, annotationId, labelMarkdown, categoryId, properties } =
      params;

    // Validate required parameters
    if (!nodeId) {
      console.error("Validation failed: Missing nodeId");
      return { success: false, error: "Missing nodeId" };
    }

    if (!labelMarkdown) {
      console.error("Validation failed: Missing labelMarkdown");
      return { success: false, error: "Missing labelMarkdown" };
    }

    console.log("Attempting to get node:", nodeId);
    // Get and validate node
    const node = await figma.getNodeByIdAsync(nodeId);
    console.log("Node lookup result:", {
      id: nodeId,
      found: !!node,
      type: node ? node.type : undefined,
      name: node ? node.name : undefined,
      hasAnnotations: node ? "annotations" in node : false,
    });

    if (!node) {
      console.error("Node lookup failed:", nodeId);
      return { success: false, error: `Node not found: ${nodeId}` };
    }

    // Validate node supports annotations
    if (!("annotations" in node)) {
      console.error("Node annotation support check failed:", {
        nodeType: node.type,
        nodeId: node.id,
      });
      return {
        success: false,
        error: `Node type ${node.type} does not support annotations`,
      };
    }

    // Create the annotation object
    const newAnnotation = {
      labelMarkdown,
    };

    // Validate and add categoryId if provided
    if (categoryId) {
      console.log("Adding categoryId to annotation:", categoryId);
      newAnnotation.categoryId = categoryId;
    }

    // Validate and add properties if provided
    if (properties && Array.isArray(properties) && properties.length > 0) {
      console.log(
        "Adding properties to annotation:",
        JSON.stringify(properties, null, 2)
      );
      newAnnotation.properties = properties;
    }

    // Log current annotations before update
    console.log("Current node annotations:", node.annotations);

    // Overwrite annotations
    console.log(
      "Setting new annotation:",
      JSON.stringify(newAnnotation, null, 2)
    );
    node.annotations = [newAnnotation];

    // Verify the update
    console.log("Updated node annotations:", node.annotations);
    console.log("=== setAnnotation Debug End ===");

    return {
      success: true,
      nodeId: node.id,
      name: node.name,
      annotations: node.annotations,
    };
  } catch (error) {
    console.error("=== setAnnotation Error ===");
    console.error("Error details:", {
      message: error.message,
      stack: error.stack,
      params: JSON.stringify(params, null, 2),
    });
    return { success: false, error: error.message };
  }
}

// @ai-generated(guided)
/**
 * Flat, glob-style index of a subtree. Walks every container under `root`
 * (so any-depth `**` search) and collects nodes matching an optional type
 * filter, name glob, and spatial filter (within a rect / the viewport).
 * @param {Object} params
 * @param {string} [params.root] - Node id to search under; defaults to current page.
 * @param {string} [params.name] - Name glob (* = any run, ? = one char). Omit = any.
 * @param {string|string[]} [params.type] - Type filter; a type, an array, or "*"/omit = any.
 * @param {number} [params.depth] - Max depth below root (direct children = 1). Omit = unlimited.
 * @param {boolean} [params.bbox=true] - Include each hit's absolute bbox. Pass false to omit.
 * @param {{x,y,width,height}} [params.within] - Keep only nodes intersecting this absolute rect.
 * @returns {Promise<{count:number, matches:Array<{id,name,type,parentId,bbox?}>}>}
 */
async function globNodes(params) {
  const { root, name, type, depth, bbox, within } = params || {};

  let rootNode;
  if (root) {
    rootNode = await figma.getNodeByIdAsync(root);
    if (!rootNode) throw new Error(`Node with ID ${root} not found`);
  } else {
    rootNode = figma.currentPage;
  }

  // Type filter → uppercase Set, or null for "match any".
  let typeSet = null;
  if (type && type !== "*") {
    const arr = Array.isArray(type) ? type : [type];
    typeSet = new Set(arr.map((t) => String(t).toUpperCase()));
  }

  // Spatial filter region (absolute coords); null = no spatial filter.
  // Intersect semantics → a node partially inside still counts as a hit.
  const region = within
    ? { x: within.x, y: within.y, width: within.width, height: within.height }
    : null;

  const nameRe = name ? globToRegExp(name) : null;
  const maxDepth = typeof depth === "number" ? depth : Infinity;
  const includeBbox = bbox !== false; // default on
  const matches = [];

  // Descend through every container regardless of whether it matched, so the
  // search is any-depth; the root itself (d===0) is the container, not a hit.
  // Descent is never pruned by the spatial filter — a child can overflow its
  // parent's box (clipping off), so geometry gates the match, not the walk.
  // parentId carries the immediate container id so the flat output can show
  // each hit's location (@parent) without reconstructing the tree.
  const walk = (node, d, parentId) => {
    if (d > 0 && (!typeSet || typeSet.has(node.type)) && (!nameRe || nameRe.test(node.name || ""))) {
      const abox = node.absoluteBoundingBox || null; // null for geometry-less nodes
      if (!region || (abox && rectsIntersect(abox, region))) {
        const m = { id: node.id, name: node.name || "", type: node.type, parentId };
        if (includeBbox && abox) {
          m.bbox = {
            x: Math.round(abox.x),
            y: Math.round(abox.y),
            w: Math.round(abox.width),
            h: Math.round(abox.height),
          };
        }
        matches.push(m);
      }
    }
    if (d < maxDepth && "children" in node) {
      for (const child of node.children) walk(child, d + 1, node.id);
    }
  };
  walk(rootNode, 0, null);

  return { count: matches.length, matches };
}

// @ai-generated(guided)
/**
 * Content search over a subtree — the Figma analog of grep. Walks every
 * container under `root` and tests each TEXT node's `characters` against a
 * regex, LINE BY LINE (Figma text is multi-line), so a hit reports its 1-based
 * line number like grep's `file:line:`. Names are NOT searched here — that is
 * glob_nodes' job; grep is for the text *content*.
 * @param {Object} params
 * @param {string} params.pattern - JS regex source (not a glob).
 * @param {string} [params.root] - Node id to search under; defaults to current page.
 * @param {boolean} [params.ignoreCase] - Case-insensitive match (regex `i`). Default false.
 * @param {boolean} [params.onlyMatch] - Report only the matched substrings, not the whole line (grep -o).
 * @param {number} [params.depth] - Max depth below root (direct children = 1). Omit = unlimited.
 * @param {{x,y,width,height}} [params.within] - Keep only nodes intersecting this absolute rect.
 * @param {boolean} [params.bbox] - Include each hit node's absolute bbox. Default false.
 * @param {number} [params.maxMatches=1000] - Hard cap on collected line-hits; walk stops after.
 * @returns {Promise<{count:number,nodeCount:number,truncated:boolean,matches:Array<{id,name,type,parentId,line,text,bbox?}>}>}
 */
async function grepNodes(params) {
  const { root, pattern, ignoreCase, onlyMatch, depth, within, bbox } = params || {};
  if (!pattern) throw new Error("grep_nodes requires a `pattern`");

  let rootNode;
  if (root) {
    rootNode = await figma.getNodeByIdAsync(root);
    if (!rootNode) throw new Error(`Node with ID ${root} not found`);
  } else {
    rootNode = figma.currentPage;
  }

  // Always global (matchAll/onlyMatch); `i` opt-in. Invalid source → clear error.
  let re;
  try {
    re = new RegExp(pattern, ignoreCase ? "gi" : "g");
  } catch (e) {
    throw new Error(`Invalid regex pattern: ${e.message}`);
  }

  const region = within
    ? { x: within.x, y: within.y, width: within.width, height: within.height }
    : null;
  const maxDepth = typeof depth === "number" ? depth : Infinity;
  const includeBbox = bbox === true; // default off — grep is about text, not geometry
  const maxMatches = typeof params.maxMatches === "number" ? params.maxMatches : 1000;

  const matches = [];
  const hitNodes = new Set();
  let truncated = false;

  // Center a long line on its first match so one giant paragraph can't blow the
  // token budget; short lines pass through whole (grep prints the full line).
  const snippet = (line, idx, win) => {
    win = win || 120;
    if (line.length <= 2 * win) return line;
    const start = Math.max(0, idx - win);
    const end = Math.min(line.length, idx + win);
    return (start > 0 ? "…" : "") + line.slice(start, end) + (end < line.length ? "…" : "");
  };

  // Descend through every container regardless of match (any-depth), exactly
  // like globNodes; only TEXT nodes carry searchable content. Spatial filter
  // gates the match, never the walk (a child may overflow its clipped parent).
  const walk = (node, d, parentId) => {
    if (truncated) return;
    if (d > 0 && node.type === "TEXT") {
      const abox = node.absoluteBoundingBox || null;
      if (!region || (abox && rectsIntersect(abox, region))) {
        const chars = node.characters || "";
        const lines = chars.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          re.lastIndex = 0;
          const found = [];
          let m;
          while ((m = re.exec(line)) !== null) {
            found.push(m);
            if (m.index === re.lastIndex) re.lastIndex++; // guard zero-width matches
          }
          if (found.length) {
            const hit = {
              id: node.id,
              name: node.name || "",
              type: node.type,
              parentId,
              line: i + 1,
              text: onlyMatch
                ? found.map((f) => f[0]).join(" … ")
                : snippet(line, found[0].index),
            };
            if (includeBbox && abox) {
              hit.bbox = {
                x: Math.round(abox.x),
                y: Math.round(abox.y),
                w: Math.round(abox.width),
                h: Math.round(abox.height),
              };
            }
            matches.push(hit);
            hitNodes.add(node.id);
            if (matches.length >= maxMatches) {
              truncated = true;
              return;
            }
          }
        }
      }
    }
    if (d < maxDepth && "children" in node) {
      for (const child of node.children) {
        walk(child, d + 1, node.id);
        if (truncated) return;
      }
    }
  };
  walk(rootNode, 0, null);

  return { count: matches.length, nodeCount: hitNodes.size, truncated, matches };
}

// @ai-generated(guided)
/**
 * Structural search over a subtree — query nodes by predicates on their fields,
 * not by flat text. Each predicate is {path, op, value}; a node is a hit when
 * ALL predicates pass (AND). `path` walks the node JSON (dot for objects,
 * `[i]` for an index, `[*]` for "any array element"); ops cover what regex
 * can't: numeric compare, color (rgb 0-1 ↔ hex with tolerance), and presence
 * of the KEY itself (`exists`/`absent` — e.g. find fills NOT bound to a
 * variable). String/equality/oneOf are all the default `regex` op.
 * @param {Object} params
 * @param {Array<{path:string,op?:string,value?:any,i?:boolean}>} params.where - Predicates, AND-combined. Required, ≥1.
 * @param {string} [params.root] - Node id to search under; defaults to current page.
 * @param {number} [params.depth] - Max depth below root (direct children = 1). Omit = unlimited.
 * @param {{x,y,width,height}} [params.within] - Keep only nodes intersecting this absolute rect.
 * @param {boolean} [params.bbox] - Include each hit's absolute bbox. Default false.
 * @param {number} [params.maxMatches=1000] - Hard cap on collected hits.
 * @returns {Promise<{count:number,truncated:boolean,matches:Array<{id,name,type,parentId,props:Array<{path,value}>,bbox?}>}>}
 */
async function queryNodes(params) {
  const { root, where, depth, within, bbox } = params || {};
  if (!Array.isArray(where) || where.length === 0) {
    throw new Error("query_nodes requires a non-empty `where` array of predicates");
  }

  let rootNode;
  if (root) {
    rootNode = await figma.getNodeByIdAsync(root);
    if (!rootNode) throw new Error(`Node with ID ${root} not found`);
  } else {
    rootNode = figma.currentPage;
  }

  // Pre-compile predicates once (parse path, build regex) so the walk is cheap.
  const preds = where.map((p) => {
    const op = p.op || "regex";
    if (op !== "exists" && op !== "absent" && p.value === undefined) {
      throw new Error(`Predicate on "${p.path}" with op "${op}" needs a value`);
    }
    let re = null;
    if (op === "regex") {
      try {
        re = new RegExp(String(p.value), p.i ? "i" : "");
      } catch (e) {
        throw new Error(`Invalid regex for "${p.path}": ${e.message}`);
      }
    }
    let target = null;
    if (op === "color") {
      target = hexToRgb01(String(p.value));
      if (!target) throw new Error(`color op on "${p.path}" needs a #RRGGBB value`);
    }
    return { path: p.path, op, value: p.value, steps: parseFieldPath(p.path), re, target };
  });

  const region = within
    ? { x: within.x, y: within.y, width: within.width, height: within.height }
    : null;
  const maxDepth = typeof depth === "number" ? depth : Infinity;
  const includeBbox = bbox === true;
  const maxMatches = typeof params.maxMatches === "number" ? params.maxMatches : 1000;

  const matches = [];
  let truncated = false;

  const walk = (node, d, parentId) => {
    if (truncated) return;
    if (d > 0) {
      const abox = node.absoluteBoundingBox || null;
      if (!region || (abox && rectsIntersect(abox, region))) {
        const props = [];
        let allPass = true;
        for (const pred of preds) {
          const vals = resolveFieldPath(node, pred.steps); // present leaf values
          const pass = testPredicate(pred, vals);
          if (!pass) {
            allPass = false;
            break;
          }
          // First present value drives the display; presence ops have none.
          props.push({ path: pred.path, value: displayValue(pred, vals) });
        }
        if (allPass) {
          const hit = { id: node.id, name: node.name || "", type: node.type, parentId, props };
          if (includeBbox && abox) {
            hit.bbox = {
              x: Math.round(abox.x),
              y: Math.round(abox.y),
              w: Math.round(abox.width),
              h: Math.round(abox.height),
            };
          }
          matches.push(hit);
          if (matches.length >= maxMatches) {
            truncated = true;
            return;
          }
        }
      }
    }
    if (d < maxDepth && "children" in node) {
      for (const child of node.children) {
        walk(child, d + 1, node.id);
        if (truncated) return;
      }
    }
  };
  walk(rootNode, 0, null);

  return { count: matches.length, truncated, matches };
}

/**
 * Tokenize a field path into steps. `fills[*].color` → [{key:fills},{wild},{key:color}].
 * @param {string} path
 * @returns {Array<{key?:string,index?:number,wild?:boolean}>}
 */
function parseFieldPath(path) {
  const steps = [];
  const re = /([^.\[\]]+)|\[(\d+)\]|\[\*\]/g;
  let m;
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) steps.push({ key: m[1] });
    else if (m[2] !== undefined) steps.push({ index: parseInt(m[2], 10) });
    else steps.push({ wild: true });
  }
  return steps;
}

/**
 * Resolve a parsed path against a node, returning every PRESENT leaf value
 * (branching at `[*]`). Property reads are guarded — Figma getters can throw on
 * unsupported node types, and that simply means "not present here". A value
 * that is itself `figma.mixed` is returned (counts as present) but is not
 * descended into.
 * @returns {any[]} present leaf values; empty = path absent on this node
 */
function resolveFieldPath(node, steps) {
  let current = [node];
  for (const step of steps) {
    const next = [];
    for (const cur of current) {
      if (cur == null || cur === figma.mixed) continue;
      try {
        if (step.wild) {
          if (Array.isArray(cur)) for (const el of cur) next.push(el);
        } else if (step.index != null) {
          if (Array.isArray(cur) && step.index < cur.length) next.push(cur[step.index]);
        } else {
          let v = cur[step.key];
          // FigJam sticky/shape/connector keep text props on a `.text` sublayer —
          // fall through so reads (and edit `old` guards) see them at the top level,
          // matching where setWriteProp/applyEditToNode write them.
          if (v === undefined && cur.type && TEXT_SUBLAYER_TYPES.has(cur.type) && TEXT_SUBLAYER_KEYS.has(step.key) && cur.text) {
            v = cur.text[step.key];
          }
          if (v !== undefined) next.push(v);
        }
      } catch (e) {
        // getter threw on this node type → field not present here
      }
    }
    current = next;
  }
  return current;
}

/** Evaluate one compiled predicate against a node's resolved values. */
function testPredicate(pred, vals) {
  if (pred.op === "exists") return vals.length > 0;
  if (pred.op === "absent") return vals.length === 0;
  for (const v of vals) {
    if (matchScalar(pred, v)) return true; // ANY present value satisfies
  }
  return false;
}

/** Value-op match for a single resolved value. `figma.mixed` never matches. */
function matchScalar(pred, v) {
  if (v === figma.mixed) return false;
  switch (pred.op) {
    case "regex":
      return pred.re.test(typeof v === "object" ? JSON.stringify(v) : String(v));
    case "gt":
      return typeof v === "number" && v > pred.value;
    case "gte":
      return typeof v === "number" && v >= pred.value;
    case "lt":
      return typeof v === "number" && v < pred.value;
    case "lte":
      return typeof v === "number" && v <= pred.value;
    case "color":
      return colorMatches(v, pred.target);
    default:
      throw new Error(`Unknown op "${pred.op}"`);
  }
}

/** A short, human-readable value for output. Presence ops have no value. */
function displayValue(pred, vals) {
  if (pred.op === "exists") return "✓";
  if (pred.op === "absent") return "∅";
  const v = vals.find((x) => x !== figma.mixed);
  if (v === undefined) return vals.length ? "mixed" : "";
  if (pred.op === "color" && v && typeof v === "object" && typeof v.r === "number") {
    return rgb01ToHex(v);
  }
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 79) + "…" : s;
  }
  return String(v);
}

/** Parse #RRGGBB (or #RGB) to {r,g,b} in 0-1. Null on bad input. */
function hexToRgb01(hex) {
  let h = String(hex).trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

/** {r,g,b} 0-1 → #RRGGBB. */
function rgb01ToHex(c) {
  const h = (n) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, "0");
  return "#" + h(c.r) + h(c.g) + h(c.b);
}

/** Component-wise color match with a tolerance (~5/255) — float rgb is never exact. */
function colorMatches(v, target) {
  if (!v || typeof v !== "object" || typeof v.r !== "number") return false;
  const tol = 0.02;
  return (
    Math.abs(v.r - target.r) <= tol &&
    Math.abs(v.g - target.g) <= tol &&
    Math.abs(v.b - target.b) <= tol
  );
}

/** Axis-aligned rectangle overlap test (touching edges do not count). */
function rectsIntersect(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * Translate a shell-style name glob to an anchored, case-insensitive RegExp.
 * `*` = any run, `?` = one char; every other regex metachar is escaped so
 * Figma names with (), [], +, ., etc. match literally.
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  let re = "";
  for (const ch of glob) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", "i");
}

// ---------------------------------------------------------------------------
// edit_nodes — generic, path-addressed property writer (write-side twin of
// query_nodes). Each edit is {nodeId, path, old?, new}: `path` uses the same
// field-path syntax as query_nodes (dot for objects, [i] for an index; no [*]),
// `old` is an optional Edit-style guard checked against the current value, and
// `new` is the value to write. Edits apply in order and are independent — one
// failing (guard mismatch, read-only prop, Figma rejecting the write) records
// its error and the rest still run, so the agent learns exactly what went wrong.
// ---------------------------------------------------------------------------
async function editNodes(params) {
  const { edits } = params || {};
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("edit_nodes requires a non-empty `edits` array");
  }

  const nodeCache = new Map();
  const results = [];
  let applied = 0;

  // Even a small batch can exceed the 30s command timeout — a single
  // `characters` edit may block on a slow loadFontAsync, a variant swap can
  // trigger heavy relayout. The reporter streams progress whose first `start()`
  // alone lifts the server timeout off the 30s floor and whose ticks keep
  // resetting the inactivity timer. minItems:0 → stream for ANY edit count
  // (the per-item ticks stay throttled, so a tiny call just emits start+done).
  const total = edits.length;
  const progress = makeProgress("edit_nodes", total, {
    commandId: params && params.commandId,
    minItems: 0,
  });
  await progress.start(`Applying ${total} edits...`);

  for (let i = 0; i < edits.length; i++) {
    const e = edits[i] || {};
    const r = { nodeId: e.nodeId, path: e.path };
    try {
      if (!e.nodeId) throw new Error("edit needs a `nodeId`");
      if (!e.path || typeof e.path !== "string") throw new Error("edit needs a string `path`");
      if (!("new" in e)) throw new Error("edit needs a `new` value");

      let node = nodeCache.get(e.nodeId);
      if (node === undefined) {
        node = (await figma.getNodeByIdAsync(e.nodeId)) || null;
        nodeCache.set(e.nodeId, node);
      }
      if (!node) throw new Error(`node not found: ${e.nodeId}`);

      const steps = parseFieldPath(e.path);
      if (!steps.length) throw new Error(`could not parse path "${e.path}"`);
      if (steps.some((s) => s.wild)) {
        throw new Error(`path "${e.path}" uses [*]; edit needs a concrete index`);
      }

      const before = resolveFieldPath(node, steps);
      const present = before.length > 0;
      const beforeVal = present ? before[0] : undefined;

      // Edit-style guard: refuse to write if the current value isn't what the
      // agent thinks it is — catches stale reads and wrong-node mistakes.
      if ("old" in e && e.old !== undefined) {
        if (!present) {
          throw new Error(`old mismatch at "${e.path}": expected ${JSON.stringify(e.old)}, but path is absent`);
        }
        if (!leafEquals(beforeVal, e.old)) {
          throw new Error(
            `old mismatch at "${e.path}": expected ${JSON.stringify(e.old)}, found ${JSON.stringify(normalizeForDisplay(beforeVal))}`
          );
        }
      }

      const newVal = await applyEditToNode(node, steps, e.new, present ? beforeVal : undefined, e.path);
      r.name = node.name;
      r.type = node.type;
      r.old = present ? normalizeForDisplay(beforeVal) : null;
      r.new = newVal;
      r.ok = true;
      applied++;
    } catch (err) {
      r.ok = false;
      r.error = err && err.message ? err.message : String(err);
    }
    results.push(r);
    await progress.tick(i + 1, `Applied ${i + 1}/${total} edits (${applied} ok)`);
  }

  await progress.done(`Done: ${applied}/${total} applied`);

  return { applied, total: edits.length, results };
}

// reparent_nodes — move existing nodes to a new parent and/or a new z-order
// position among siblings. edit_nodes deliberately can't write `parent`/`index`
// (they're structural, not value properties), so this is the only way to move a
// node after creation. Each move is {nodeId, parentId?, index?}: with parentId
// the node is appended into that container; with index it's placed at that slot
// among its siblings (in the new parent, or the current one for a pure reorder).
// Moves are independent — one failing records its Figma error and the rest run.
// Reparenting keeps the node's LOCAL x/y, so its absolute position shifts; in an
// auto-layout parent x/y is ignored and `index` sets the layout order instead.
// @ai-generated(solo)
async function reparentNodes(params) {
  const { moves } = params || {};
  if (!Array.isArray(moves) || moves.length === 0) {
    throw new Error("reparent_nodes requires a non-empty `moves` array");
  }

  const results = [];
  let applied = 0;
  const total = moves.length;
  const progress = makeProgress("reparent_nodes", total, {
    commandId: params && params.commandId,
    minItems: 5,
  });
  await progress.start(`Moving ${total} nodes...`);

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i] || {};
    const r = { nodeId: m.nodeId };
    try {
      if (!m.nodeId) throw new Error("move needs a `nodeId`");
      const hasParent = m.parentId != null && m.parentId !== "";
      const hasIndex = typeof m.index === "number";
      if (!hasParent && !hasIndex) throw new Error("move needs `parentId` and/or `index`");

      const node = await figma.getNodeByIdAsync(m.nodeId);
      if (!node) throw new Error(`node not found: ${m.nodeId}`);
      if (!node.parent) throw new Error(`${node.type} cannot be reparented (no parent)`);

      const oldParent = node.parent;
      r.oldParentId = oldParent.id;
      r.oldIndex = oldParent.children ? oldParent.children.indexOf(node) : null;

      // Target parent: explicit parentId, or the current parent for a pure reorder.
      let parent = oldParent;
      if (hasParent) {
        const p = await figma.getNodeByIdAsync(m.parentId);
        if (!p) throw new Error(`parent not found: ${m.parentId}`);
        if (!("appendChild" in p)) throw new Error(`parent ${m.parentId} (${p.type}) cannot have children`);
        parent = p;
      }

      if (hasIndex) {
        // insertChild requires 0 <= index <= children.length; clamp so an
        // out-of-range index pins to the end instead of throwing. When the node
        // is already in `parent`, Figma repositions it (the resulting index may
        // shift as removal compacts the list — we report the real one below).
        let idx = m.index < 0 ? 0 : m.index;
        const max = parent.children ? parent.children.length : 0;
        if (idx > max) idx = max;
        parent.insertChild(idx, node);
      } else {
        parent.appendChild(node); // append into the new parent, keep sibling order
      }

      r.newParentId = parent.id;
      r.newIndex = parent.children ? parent.children.indexOf(node) : null;
      r.name = node.name;
      r.type = node.type;
      r.ok = true;
      applied++;
    } catch (err) {
      r.ok = false;
      r.error = err && err.message ? err.message : String(err);
    }
    results.push(r);
    await progress.tick(i + 1, `Moved ${i + 1}/${total} (${applied} ok)`);
  }

  await progress.done(`Done: ${applied}/${total} moved`);

  return { applied, total, results };
}

// An instance's componentProperties is a {key: {type, value, ...}} descriptor
// map that's READ-ONLY — variant swaps and boolean/text/swap overrides land via
// instance.setProperties({key: value}). The key is the bare group name for
// VARIANT props but carries a "#nnn" suffix for BOOLEAN/TEXT/INSTANCE_SWAP (e.g.
// "Has icon#7:0"); we resolve a caller's bare name onto whichever real key
// matches so the agent can address it the way read_node shows the property name.

/** Find the real componentProperties key for a caller-supplied name (exact, else pre-'#' segment). */
function resolveComponentPropKey(defs, name) {
  if (Object.prototype.hasOwnProperty.call(defs, name)) return name;
  const base = String(name).split("#")[0];
  for (const k in defs) {
    if (k.split("#")[0] === base) return k;
  }
  return null;
}

/** Coerce an edit value to what setProperties expects for the prop's type (BOOLEAN takes a real bool). */
function coerceComponentPropValue(def, value) {
  if (def && def.type === "BOOLEAN" && typeof value === "string") return value === "true";
  return value;
}

/**
 * Apply a {name: value} map of component-property overrides to an INSTANCE via
 * setProperties — the one path Figma allows for variant swaps and prop changes.
 * INSTANCE_SWAP values must be a real component id/key string (the server does
 * NOT remap a short id inside an edit value). Used by both edit_nodes (one prop)
 * and write_nodes (a whole map on a freshly created instance).
 */
function applyComponentProperties(node, map) {
  if (node.type !== "INSTANCE") {
    throw new Error(`componentProperties can only be set on INSTANCE nodes, not ${node.type}`);
  }
  const defs = node.componentProperties || {};
  const out = {};
  for (const name in map) {
    const realKey = resolveComponentPropKey(defs, name);
    if (realKey == null) {
      const avail = Object.keys(defs).join(", ") || "none";
      throw new Error(`instance has no component property "${name}" (available: ${avail})`);
    }
    out[realKey] = coerceComponentPropValue(defs[realKey], map[name]);
  }
  node.setProperties(out);
}

/**
 * Route an edit_nodes path of the form `componentProperties.<Name>` (optionally
 * `.value`) to setProperties. Accepts both the bare-name and the `.value` forms
 * so a path that mirrors a read (`componentProperties.Size.value`) works and its
 * `old` guard compares against the bare value the agent saw.
 */
function setComponentProperty(node, steps, newValue, path) {
  if (steps.length < 2 || steps[1].key == null) {
    throw new Error(`path "${path}" must name a property, e.g. componentProperties.Size`);
  }
  const name = steps[1].key;
  applyComponentProperties(node, { [name]: newValue });
  const realKey = resolveComponentPropKey(node.componentProperties || {}, name);
  const def = realKey != null ? node.componentProperties[realKey] : null;
  return def ? normalizeForDisplay(def.value) : newValue;
}

/**
 * Write `newValue` at a parsed path on a node, returning the value read back.
 * Figma node properties are immutable references, so a nested write (e.g.
 * fills[0].color) clones the whole top-level property, edits the clone, then
 * reassigns it. A handful of props (width/height, characters) are exposed only
 * through methods rather than assignment and are routed accordingly.
 */
async function applyEditToNode(node, steps, newValue, oldLeaf, path) {
  const top = steps[0];
  if (top.index != null || top.wild) throw new Error(`path "${path}" must start with a property name`);
  const topKey = top.key;

  // componentProperties is a read-only descriptor map; a variant/boolean/text/
  // swap change goes through instance.setProperties(), not assignment. Route any
  // edit whose top key is componentProperties there. (See setComponentProperty.)
  if (topKey === "componentProperties") {
    return setComponentProperty(node, steps, newValue, path);
  }

  if (steps.length === 1) {
    // FigJam sticky/shape/connector: text-ish props live on node.text, not the
    // node — mirror the write_nodes routing (setWriteProp).
    if (TEXT_SUBLAYER_TYPES.has(node.type) && TEXT_SUBLAYER_KEYS.has(topKey)) {
      await setSublayerTextProp(node.text, topKey, newValue);
      return normalizeForDisplay(node.text[topKey]);
    }
    if (topKey === "characters") {
      if (node.type !== "TEXT") throw new Error(`characters can only be set on TEXT nodes, not ${node.type}`);
      await figma.loadFontAsync(node.fontName); // throws on mixed fonts — surfaced to the agent
      await setCharacters(node, String(newValue));
      return node.characters;
    }
    if (topKey === "width" || topKey === "height") {
      if (!("resize" in node)) throw new Error(`${node.type} does not support resizing`);
      const w = topKey === "width" ? Number(newValue) : node.width;
      const h = topKey === "height" ? Number(newValue) : node.height;
      node.resize(w, h);
      return node[topKey];
    }
    if (topKey === "code" && node.type === "CODE_BLOCK") {
      await loadCodeBlockFonts(); // setter needs Source Code Pro loaded first
      node.code = String(newValue);
      return node.code;
    }
    // Style-id binds are read-only under dynamic-page access — use the async setter.
    if (STYLE_ID_SETTERS[topKey]) {
      await setStyleId(node, topKey, newValue);
      return normalizeForDisplay(resolveFieldPath(node, steps)[0]);
    }
    if (topKey === "effects") {
      node.effects = normalizeEffects(newValue);
      return normalizeForDisplay(resolveFieldPath(node, steps)[0]);
    }
    node[topKey] = convertWriteValue(newValue, oldLeaf, topKey);
    return normalizeForDisplay(resolveFieldPath(node, steps)[0]);
  }

  const topVal = node[topKey];
  if (topVal === undefined) throw new Error(`property "${topKey}" is not present on this node`);
  if (topVal === figma.mixed) throw new Error(`property "${topKey}" is mixed; cannot edit a nested field`);
  let clone;
  try {
    clone = JSON.parse(JSON.stringify(topVal));
  } catch (e) {
    throw new Error(`property "${topKey}" cannot be cloned for editing`);
  }

  let cur = clone;
  for (let i = 1; i < steps.length - 1; i++) {
    const s = steps[i];
    const k = s.index != null ? s.index : s.key;
    if (cur == null || typeof cur !== "object") throw new Error(`path "${path}" is not an object before "${k}"`);
    cur = cur[k];
    if (cur === undefined) throw new Error(`path "${path}" segment "${k}" is absent`);
  }
  const last = steps[steps.length - 1];
  const leafKey = last.index != null ? last.index : last.key;
  if (cur == null || typeof cur !== "object") throw new Error(`path "${path}" parent of the leaf is not editable`);
  cur[leafKey] = convertWriteValue(newValue, oldLeaf, last.key);

  node[topKey] = clone;
  return normalizeForDisplay(resolveFieldPath(node, steps)[0]);
}

/** Coerce a hex string into a Figma rgb 0-1 color when the target leaf is a color; otherwise pass through. */
function convertWriteValue(newValue, oldLeaf, key) {
  // `key` here is the leaf being written; for a whole-property edit of
  // letterSpacing/lineHeight a bare number is the PIXELS shorthand. A nested
  // edit (letterSpacing.value) has key="value" and is left alone.
  if ((key === "letterSpacing" || key === "lineHeight") && typeof newValue === "number") {
    return { value: newValue, unit: "PIXELS" };
  }
  if (typeof newValue === "string" && /^#[0-9a-fA-F]{3,8}$/.test(newValue)) {
    const colorLike = key === "color" || (oldLeaf && typeof oldLeaf === "object" && typeof oldLeaf.r === "number");
    if (colorLike) {
      const rgb = hexToRgb01(newValue);
      if (!rgb) throw new Error(`invalid hex color "${newValue}"`);
      if (oldLeaf && typeof oldLeaf.a === "number") rgb.a = oldLeaf.a; // keep existing alpha channel
      return rgb;
    }
  }
  // A whole object/array value (e.g. setting `fills` to a paint array) gets the
  // same recursive treatment write_nodes uses: nested hex colors → rgb 0-1 and
  // server-resolved image paints (imageBytes) → an imported imageHash.
  if (newValue && typeof newValue === "object") return coerceColors(newValue);
  return newValue;
}

/** Present a raw leaf the way the agent reads it elsewhere: colors as hex, figma.mixed as "mixed". */
function normalizeForDisplay(v) {
  if (v === figma.mixed) return "mixed";
  if (v && typeof v === "object" && typeof v.r === "number" && typeof v.g === "number" && typeof v.b === "number") {
    return rgbaToHex(v);
  }
  return v;
}

/** Compare a raw current leaf against an agent-supplied `old`, tolerant of color/number formatting. */
function leafEquals(currentRaw, old) {
  const cur = normalizeForDisplay(currentRaw);
  if (typeof cur === "string" && typeof old === "string") {
    if (cur[0] === "#" || old[0] === "#") return hexNorm(cur) === hexNorm(old);
    return cur === old;
  }
  if (typeof cur === "number" && typeof old === "number") return Math.abs(cur - old) < 1e-4;
  if (typeof cur === "number" && typeof old === "string") return Math.abs(cur - Number(old)) < 1e-4;
  return JSON.stringify(cur) === JSON.stringify(old);
}

/** Normalize a hex string for comparison: lowercase, expand shorthand, drop an opaque alpha. */
function hexNorm(s) {
  let h = String(s).toLowerCase().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 8 && h.endsWith("ff")) h = h.slice(0, 6);
  return h;
}

// Set multiple annotations with async progress updates
async function setAnnotations(params) {
  console.log("=== setAnnotations Debug Start ===");
  console.log("Input params:", JSON.stringify(params, null, 2));

  const { annotations } = params;

  if (!annotations || annotations.length === 0) {
    console.error("Validation failed: No annotations provided");
    return { success: false, error: "No annotations provided" };
  }

  console.log(`Processing ${annotations.length} annotations`);

  const results = [];
  let successCount = 0;
  let failureCount = 0;

  // Each setAnnotation loads the node's font; a big batch can exceed the 30s
  // timeout, so stream progress (skip framing for small interactive batches).
  const progress = makeProgress("set_annotations", annotations.length, {
    commandId: params && params.commandId,
    minItems: 5,
  });
  await progress.start(`Applying ${annotations.length} annotations...`);

  // Process annotations sequentially
  for (let i = 0; i < annotations.length; i++) {
    const annotation = annotations[i];
    console.log(
      `\nProcessing annotation ${i + 1}/${annotations.length}:`,
      JSON.stringify(annotation, null, 2)
    );

    try {
      console.log("Calling setAnnotation with params:", {
        nodeId: annotation.nodeId,
        labelMarkdown: annotation.labelMarkdown,
        categoryId: annotation.categoryId,
        properties: annotation.properties,
      });

      const result = await setAnnotation({
        nodeId: annotation.nodeId,
        labelMarkdown: annotation.labelMarkdown,
        categoryId: annotation.categoryId,
        properties: annotation.properties,
      });

      console.log("setAnnotation result:", JSON.stringify(result, null, 2));

      if (result.success) {
        successCount++;
        results.push({ success: true, nodeId: annotation.nodeId });
        console.log(`✓ Annotation ${i + 1} applied successfully`);
      } else {
        failureCount++;
        results.push({
          success: false,
          nodeId: annotation.nodeId,
          error: result.error,
        });
        console.error(`✗ Annotation ${i + 1} failed:`, result.error);
      }
    } catch (error) {
      failureCount++;
      const errorResult = {
        success: false,
        nodeId: annotation.nodeId,
        error: error.message,
      };
      results.push(errorResult);
      console.error(`✗ Annotation ${i + 1} failed with error:`, error);
      console.error("Error details:", {
        message: error.message,
        stack: error.stack,
      });
    }
    await progress.tick(i + 1, `Applied ${i + 1}/${annotations.length} annotations (${successCount} ok)`);
  }

  await progress.done(`Done: ${successCount}/${annotations.length} annotations applied`);

  const summary = {
    success: successCount > 0,
    annotationsApplied: successCount,
    annotationsFailed: failureCount,
    totalAnnotations: annotations.length,
    results: results,
  };

  console.log("\n=== setAnnotations Summary ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("=== setAnnotations Debug End ===");

  return summary;
}

async function deleteNodes(params) {
  const { nodeIds } = params || {};

  if (!nodeIds || !Array.isArray(nodeIds) || nodeIds.length === 0) {
    throw new Error("Missing or invalid nodeIds parameter");
  }

  console.log(`Starting deletion of ${nodeIds.length} nodes`);

  const progress = makeProgress("delete_nodes", nodeIds.length, {
    commandId: params && params.commandId,
    minItems: 5,
  });
  await progress.start(`Starting deletion of ${nodeIds.length} nodes`);

  const results = [];
  let successCount = 0;
  let failureCount = 0;

  // Process nodes in chunks of 5 to avoid overwhelming Figma
  const CHUNK_SIZE = 5;
  const chunks = [];

  for (let i = 0; i < nodeIds.length; i += CHUNK_SIZE) {
    chunks.push(nodeIds.slice(i, i + CHUNK_SIZE));
  }

  console.log(`Split ${nodeIds.length} deletions into ${chunks.length} chunks`);

  // Process each chunk sequentially
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    console.log(
      `Processing chunk ${chunkIndex + 1}/${chunks.length} with ${chunk.length
      } nodes`
    );

    // Process deletions within a chunk in parallel
    const chunkPromises = chunk.map(async (nodeId) => {
      try {
        const node = await figma.getNodeByIdAsync(nodeId);

        if (!node) {
          console.error(`Node not found: ${nodeId}`);
          return {
            success: false,
            nodeId: nodeId,
            error: `Node not found: ${nodeId}`,
          };
        }

        // Save node info before deleting
        const nodeInfo = {
          id: node.id,
          name: node.name,
          type: node.type,
        };

        // Delete the node
        node.remove();

        console.log(`Successfully deleted node: ${nodeId}`);
        return {
          success: true,
          nodeId: nodeId,
          nodeInfo: nodeInfo,
        };
      } catch (error) {
        console.error(`Error deleting node ${nodeId}: ${error.message}`);
        return {
          success: false,
          nodeId: nodeId,
          error: error.message,
        };
      }
    });

    // Wait for all deletions in this chunk to complete
    const chunkResults = await Promise.all(chunkPromises);

    // Process results for this chunk
    chunkResults.forEach((result) => {
      if (result.success) {
        successCount++;
      } else {
        failureCount++;
      }
      results.push(result);
    });

    await progress.tick(
      successCount + failureCount,
      `Completed chunk ${chunkIndex + 1}/${chunks.length}. ${successCount} successful, ${failureCount} failed so far.`
    );

    // Add a small delay between chunks
    if (chunkIndex < chunks.length - 1) {
      console.log("Pausing between chunks...");
      await delay(1000);
    }
  }

  console.log(
    `Deletion complete: ${successCount} successful, ${failureCount} failed`
  );

  await progress.done(`Node deletion complete: ${successCount} successful, ${failureCount} failed`);

  return {
    success: successCount > 0,
    nodesDeleted: successCount,
    nodesFailed: failureCount,
    totalNodes: nodeIds.length,
    results: results,
    completedInChunks: chunks.length,
    commandId: progress.commandId,
  };
}

// Implementation for getInstanceOverrides function
async function getInstanceOverrides(instanceNode = null) {
  console.log("=== getInstanceOverrides called ===");

  let sourceInstance = null;

  // Check if an instance node was passed directly
  if (instanceNode) {
    console.log("Using provided instance node");

    // Validate that the provided node is an instance
    if (instanceNode.type !== "INSTANCE") {
      console.error("Provided node is not an instance");
      figma.notify("Provided node is not a component instance");
      return { success: false, message: "Provided node is not a component instance" };
    }

    sourceInstance = instanceNode;
  } else {
    // No node provided, use selection
    console.log("No node provided, using current selection");

    // Get the current selection
    const selection = figma.currentPage.selection;

    // Check if there's anything selected
    if (selection.length === 0) {
      console.log("No nodes selected");
      figma.notify("Please select at least one instance");
      return { success: false, message: "No nodes selected" };
    }

    // Filter for instances in the selection
    const instances = selection.filter(node => node.type === "INSTANCE");

    if (instances.length === 0) {
      console.log("No instances found in selection");
      figma.notify("Please select at least one component instance");
      return { success: false, message: "No instances found in selection" };
    }

    // Take the first instance from the selection
    sourceInstance = instances[0];
  }

  try {
    console.log(`Getting instance information:`);
    console.log(sourceInstance);

    // Get component overrides and main component
    const overrides = sourceInstance.overrides || [];
    console.log(`  Raw Overrides:`, overrides);

    // Get main component
    const mainComponent = await sourceInstance.getMainComponentAsync();
    if (!mainComponent) {
      console.error("Failed to get main component");
      figma.notify("Failed to get main component");
      return { success: false, message: "Failed to get main component" };
    }

    // return data to MCP server
    const returnData = {
      success: true,
      message: `Got component information from "${sourceInstance.name}" for overrides.length: ${overrides.length}`,
      sourceInstanceId: sourceInstance.id,
      mainComponentId: mainComponent.id,
      overridesCount: overrides.length
    };

    console.log("Data to return to MCP server:", returnData);
    figma.notify(`Got component information from "${sourceInstance.name}"`);

    return returnData;
  } catch (error) {
    console.error("Error in getInstanceOverrides:", error);
    figma.notify(`Error: ${error.message}`);
    return {
      success: false,
      message: `Error: ${error.message}`
    };
  }
}

/**
 * Helper function to validate and get target instances
 * @param {string[]} targetNodeIds - Array of instance node IDs
 * @returns {instanceNode[]} targetInstances - Array of target instances
 */
async function getValidTargetInstances(targetNodeIds) {
  let targetInstances = [];

  // Handle array of instances or single instance
  if (Array.isArray(targetNodeIds)) {
    if (targetNodeIds.length === 0) {
      return { success: false, message: "No instances provided" };
    }
    for (const targetNodeId of targetNodeIds) {
      const targetNode = await figma.getNodeByIdAsync(targetNodeId);
      if (targetNode && targetNode.type === "INSTANCE") {
        targetInstances.push(targetNode);
      }
    }
    if (targetInstances.length === 0) {
      return { success: false, message: "No valid instances provided" };
    }
  } else {
    return { success: false, message: "Invalid target node IDs provided" };
  }


  return { success: true, message: "Valid target instances provided", targetInstances };
}

/**
 * Helper function to validate and get saved override data
 * @param {string} sourceInstanceId - Source instance ID
 * @returns {Promise<Object>} - Validation result with source instance data or error
 */
async function getSourceInstanceData(sourceInstanceId) {
  if (!sourceInstanceId) {
    return { success: false, message: "Missing source instance ID" };
  }

  // Get source instance by ID
  const sourceInstance = await figma.getNodeByIdAsync(sourceInstanceId);
  if (!sourceInstance) {
    return {
      success: false,
      message: "Source instance not found. The original instance may have been deleted."
    };
  }

  // Verify it's an instance
  if (sourceInstance.type !== "INSTANCE") {
    return {
      success: false,
      message: "Source node is not a component instance."
    };
  }

  // Get main component
  const mainComponent = await sourceInstance.getMainComponentAsync();
  if (!mainComponent) {
    return {
      success: false,
      message: "Failed to get main component from source instance."
    };
  }

  return {
    success: true,
    sourceInstance,
    mainComponent,
    overrides: sourceInstance.overrides || []
  };
}

/**
 * Sets saved overrides to the selected component instance(s)
 * @param {InstanceNode[] | null} targetInstances - Array of instance nodes to set overrides to
 * @param {Object} sourceResult - Source instance data from getSourceInstanceData
 * @returns {Promise<Object>} - Result of the set operation
 */
async function setInstanceOverrides(targetInstances, sourceResult) {
  try {


    const { sourceInstance, mainComponent, overrides } = sourceResult;

    console.log(`Processing ${targetInstances.length} instances with ${overrides.length} overrides`);
    console.log(`Source instance: ${sourceInstance.id}, Main component: ${mainComponent.id}`);
    console.log(`Overrides:`, overrides);

    // swapComponent + per-field font loads across many instances can exceed the
    // 30s timeout; stream progress per instance (small batches skip framing).
    const progress = makeProgress("set_instance_overrides", targetInstances.length, { minItems: 3 });
    await progress.start(`Applying overrides to ${targetInstances.length} instances...`);

    // Process all instances
    const results = [];
    let totalAppliedCount = 0;
    let processedCount = 0;

    for (const targetInstance of targetInstances) {
      try {
        // // Skip if trying to apply to the source instance itself
        // if (targetInstance.id === sourceInstance.id) {
        //   console.log(`Skipping source instance itself: ${targetInstance.id}`);
        //   results.push({
        //     success: false,
        //     instanceId: targetInstance.id,
        //     instanceName: targetInstance.name,
        //     message: "This is the source instance itself, skipping"
        //   });
        //   continue;
        // }

        // Swap component
        try {
          targetInstance.swapComponent(mainComponent);
          console.log(`Swapped component for instance "${targetInstance.name}"`);
        } catch (error) {
          console.error(`Error swapping component for instance "${targetInstance.name}":`, error);
          results.push({
            success: false,
            instanceId: targetInstance.id,
            instanceName: targetInstance.name,
            message: `Error: ${error.message}`
          });
        }

        // Prepare overrides by replacing node IDs
        let appliedCount = 0;

        // Apply each override
        for (const override of overrides) {
          // Skip if no ID or overriddenFields
          if (!override.id || !override.overriddenFields || override.overriddenFields.length === 0) {
            continue;
          }

          // Replace source instance ID with target instance ID in the node path
          const overrideNodeId = override.id.replace(sourceInstance.id, targetInstance.id);
          const overrideNode = await figma.getNodeByIdAsync(overrideNodeId);

          if (!overrideNode) {
            console.log(`Override node not found: ${overrideNodeId}`);
            continue;
          }

          // Get source node to copy properties from
          const sourceNode = await figma.getNodeByIdAsync(override.id);
          if (!sourceNode) {
            console.log(`Source node not found: ${override.id}`);
            continue;
          }

          // Apply each overridden field
          let fieldApplied = false;
          for (const field of override.overriddenFields) {
            try {
              if (field === "componentProperties") {
                // Apply component properties
                if (sourceNode.componentProperties && overrideNode.componentProperties) {
                  const properties = {};
                  for (const key in sourceNode.componentProperties) {
                    // if INSTANCE_SWAP use id, otherwise use value
                    if (sourceNode.componentProperties[key].type === 'INSTANCE_SWAP') {
                      properties[key] = sourceNode.componentProperties[key].value;
                    
                    } else {
                      properties[key] = sourceNode.componentProperties[key].value;
                    }
                  }
                  overrideNode.setProperties(properties);
                  fieldApplied = true;
                }
              } else if (field === "characters" && overrideNode.type === "TEXT") {
                // For text nodes, need to load fonts first
                await figma.loadFontAsync(overrideNode.fontName);
                overrideNode.characters = sourceNode.characters;
                fieldApplied = true;
              } else if (field in overrideNode) {
                // Direct property assignment
                overrideNode[field] = sourceNode[field];
                fieldApplied = true;
              }
            } catch (fieldError) {
              console.error(`Error applying field ${field}:`, fieldError);
            }
          }

          if (fieldApplied) {
            appliedCount++;
          }
        }

        if (appliedCount > 0) {
          totalAppliedCount += appliedCount;
          results.push({
            success: true,
            instanceId: targetInstance.id,
            instanceName: targetInstance.name,
            appliedCount
          });
          console.log(`Applied ${appliedCount} overrides to "${targetInstance.name}"`);
        } else {
          results.push({
            success: false,
            instanceId: targetInstance.id,
            instanceName: targetInstance.name,
            message: "No overrides were applied"
          });
        }
      } catch (instanceError) {
        console.error(`Error processing instance "${targetInstance.name}":`, instanceError);
        results.push({
          success: false,
          instanceId: targetInstance.id,
          instanceName: targetInstance.name,
          message: `Error: ${instanceError.message}`
        });
      }
      processedCount++;
      await progress.tick(processedCount, `Processed ${processedCount}/${targetInstances.length} instances`);
    }

    await progress.done(`Applied ${totalAppliedCount} overrides across ${targetInstances.length} instances`);

    // Return results
    if (totalAppliedCount > 0) {
      const instanceCount = results.filter(r => r.success).length;
      const message = `Applied ${totalAppliedCount} overrides to ${instanceCount} instances`;
      figma.notify(message);
      return {
        success: true,
        message,
        totalCount: totalAppliedCount,
        results
      };
    } else {
      const message = "No overrides applied to any instance";
      figma.notify(message);
      return { success: false, message, results };
    }

  } catch (error) {
    console.error("Error in setInstanceOverrides:", error);
    const message = `Error: ${error.message}`;
    figma.notify(message);
    return { success: false, message };
  }
}

async function setDefaultConnector(params) {
  const { connectorId } = params || {};
  
  // If connectorId is provided, search and set by that ID (do not check existing storage)
  if (connectorId) {
    // Get node by specified ID
    const node = await figma.getNodeByIdAsync(connectorId);
    if (!node) {
      throw new Error(`Connector node not found with ID: ${connectorId}`);
    }
    
    // Check node type
    if (node.type !== 'CONNECTOR') {
      throw new Error(`Node is not a connector: ${connectorId}`);
    }
    
    // Set the found connector as the default connector
    await figma.clientStorage.setAsync('defaultConnectorId', connectorId);
    
    return {
      success: true,
      message: `Default connector set to: ${connectorId}`,
      connectorId: connectorId
    };
  } 
  // If connectorId is not provided, check existing storage
  else {
    // Check if there is an existing default connector in client storage
    try {
      const existingConnectorId = await figma.clientStorage.getAsync('defaultConnectorId');
      
      // If there is an existing connector ID, check if the node is still valid
      if (existingConnectorId) {
        try {
          const existingConnector = await figma.getNodeByIdAsync(existingConnectorId);
          
          // If the stored connector still exists and is of type CONNECTOR
          if (existingConnector && existingConnector.type === 'CONNECTOR') {
            return {
              success: true,
              message: `Default connector is already set to: ${existingConnectorId}`,
              connectorId: existingConnectorId,
              exists: true
            };
          }
          // The stored connector is no longer valid - find a new connector
          else {
            console.log(`Stored connector ID ${existingConnectorId} is no longer valid, finding a new connector...`);
          }
        } catch (error) {
          console.log(`Error finding stored connector: ${error.message}. Will try to set a new one.`);
        }
      }
    } catch (error) {
      console.log(`Error checking for existing connector: ${error.message}`);
    }
    
    // If there is no stored default connector or it is invalid, find one in the current page
    try {
      // Find CONNECTOR type nodes in the current page
      const currentPageConnectors = figma.currentPage.findAllWithCriteria({ types: ['CONNECTOR'] });
      
      if (currentPageConnectors && currentPageConnectors.length > 0) {
        // Use the first connector found
        const foundConnector = currentPageConnectors[0];
        const autoFoundId = foundConnector.id;
        
        // Set the found connector as the default connector
        await figma.clientStorage.setAsync('defaultConnectorId', autoFoundId);
        
        return {
          success: true,
          message: `Automatically found and set default connector to: ${autoFoundId}`,
          connectorId: autoFoundId,
          autoSelected: true
        };
      } else {
        // If no connector is found in the current page, show a guide message
        throw new Error('No connector found in the current page. Please create a connector in Figma first or specify a connector ID.');
      }
    } catch (error) {
      // Error occurred while running findAllWithCriteria
      throw new Error(`Failed to find a connector: ${error.message}`);
    }
  }
}

async function createCursorNode(targetNodeId) {
  const svgString = `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M16 8V35.2419L22 28.4315L27 39.7823C27 39.7823 28.3526 40.2722 29 39.7823C29.6474 39.2924 30.2913 38.3057 30 37.5121C28.6247 33.7654 25 26.1613 25 26.1613H32L16 8Z" fill="#202125" />
  </svg>`;
  try {
    const targetNode = await figma.getNodeByIdAsync(targetNodeId);
    if (!targetNode) throw new Error("Target node not found");

    // The targetNodeId has semicolons since it is a nested node.
    // So we need to get the parent node ID from the target node ID and check if we can appendChild to it or not.
    let parentNodeId = targetNodeId.includes(';') 
      ? targetNodeId.split(';')[0] 
      : targetNodeId;
    if (!parentNodeId) throw new Error("Could not determine parent node ID");

    // Find the parent node to append cursor node as child
    let parentNode = await figma.getNodeByIdAsync(parentNodeId);
    if (!parentNode) throw new Error("Parent node not found");

    // If the parent node is not eligible to appendChild, set the parentNode to the parent of the parentNode
    if (parentNode.type === 'INSTANCE' || parentNode.type === 'COMPONENT' || parentNode.type === 'COMPONENT_SET') {
      parentNode = parentNode.parent;
      if (!parentNode) throw new Error("Parent node not found");
    }

    // Create the cursor node
    const importedNode = await figma.createNodeFromSvg(svgString);
    if (!importedNode || !importedNode.id) {
      throw new Error("Failed to create imported cursor node");
    }
    importedNode.name = "TTF_Connector / Mouse Cursor";
    importedNode.resize(48, 48);

    const cursorNode = importedNode.findOne(node => node.type === 'VECTOR');
    if (cursorNode) {
      cursorNode.fills = [{
        type: 'SOLID',
        color: { r: 0, g: 0, b: 0 },
        opacity: 1
      }];
      cursorNode.strokes = [{
        type: 'SOLID',
        color: { r: 1, g: 1, b: 1 },
        opacity: 1
      }];
      cursorNode.strokeWeight = 2;
      cursorNode.strokeAlign = 'OUTSIDE';
      cursorNode.effects = [{
        type: "DROP_SHADOW",
        color: { r: 0, g: 0, b: 0, a: 0.3 },
        offset: { x: 1, y: 1 },
        radius: 2,
        spread: 0,
        visible: true,
        blendMode: "NORMAL"
      }];
    }

    // Append the cursor node to the parent node
    parentNode.appendChild(importedNode);

    // if the parentNode has auto-layout enabled, set the layoutPositioning to ABSOLUTE
    if ('layoutMode' in parentNode && parentNode.layoutMode !== 'NONE') {
      importedNode.layoutPositioning = 'ABSOLUTE';
    }

    // Adjust the importedNode's position to the targetNode's position
    if (
      targetNode.absoluteBoundingBox &&
      parentNode.absoluteBoundingBox
    ) {
      // if the targetNode has absoluteBoundingBox, set the importedNode's absoluteBoundingBox to the targetNode's absoluteBoundingBox
      console.log('targetNode.absoluteBoundingBox', targetNode.absoluteBoundingBox);
      console.log('parentNode.absoluteBoundingBox', parentNode.absoluteBoundingBox);
      importedNode.x = targetNode.absoluteBoundingBox.x - parentNode.absoluteBoundingBox.x  + targetNode.absoluteBoundingBox.width / 2 - 48 / 2
      importedNode.y = targetNode.absoluteBoundingBox.y - parentNode.absoluteBoundingBox.y + targetNode.absoluteBoundingBox.height / 2 - 48 / 2;
    } else if (
      'x' in targetNode && 'y' in targetNode && 'width' in targetNode && 'height' in targetNode) {
        // if the targetNode has x, y, width, height, calculate center based on relative position
        console.log('targetNode.x/y/width/height', targetNode.x, targetNode.y, targetNode.width, targetNode.height);
        importedNode.x = targetNode.x + targetNode.width / 2 - 48 / 2;
        importedNode.y = targetNode.y + targetNode.height / 2 - 48 / 2;
    } else {
      // Fallback: Place at top-left of target if possible, otherwise at (0,0) relative to parent
      if ('x' in targetNode && 'y' in targetNode) {
        console.log('Fallback to targetNode x/y');
        importedNode.x = targetNode.x;
        importedNode.y = targetNode.y;
      } else {
        console.log('Fallback to (0,0)');
        importedNode.x = 0;
        importedNode.y = 0;
      }
    }

    // get the importedNode ID and the importedNode
    console.log('importedNode', importedNode);


    return { id: importedNode.id, node: importedNode };
    
  } catch (error) {
    console.error("Error creating cursor from SVG:", error);
    return { id: null, node: null, error: error.message };
  }
}

async function createConnections(params) {
  if (!params || !params.connections || !Array.isArray(params.connections)) {
    throw new Error('Missing or invalid connections parameter');
  }
  
  const { connections } = params;

  const progress = makeProgress("create_connections", connections.length, {
    commandId: params && params.commandId,
  });
  await progress.start(`Starting to create ${connections.length} connections`);

  // Get default connector ID from client storage
  const defaultConnectorId = await figma.clientStorage.getAsync('defaultConnectorId');
  if (!defaultConnectorId) {
    throw new Error('No default connector set. Please try one of the following options to create connections:\n1. Create a connector in FigJam and copy/paste it to your current page, then run the "set_default_connector" command.\n2. Select an existing connector on the current page, then run the "set_default_connector" command.');
  }
  
  // Get the default connector
  const defaultConnector = await figma.getNodeByIdAsync(defaultConnectorId);
  if (!defaultConnector) {
    throw new Error(`Default connector not found with ID: ${defaultConnectorId}`);
  }
  if (defaultConnector.type !== 'CONNECTOR') {
    throw new Error(`Node is not a connector: ${defaultConnectorId}`);
  }
  
  // Results array for connection creation
  const results = [];
  let processedCount = 0;
  const totalCount = connections.length;
  
  // Preload fonts (used for text if provided)
  let fontLoaded = false;
  
  for (let i = 0; i < connections.length; i++) {
    try {
      const { startNodeId: originalStartId, endNodeId: originalEndId, text } = connections[i];
      let startId = originalStartId;
      let endId = originalEndId;

      // Check and potentially replace start node ID
      if (startId.includes(';')) {
        console.log(`Nested start node detected: ${startId}. Creating cursor node.`);
        const cursorResult = await createCursorNode(startId);
        if (!cursorResult || !cursorResult.id) {
          throw new Error(`Failed to create cursor node for nested start node: ${startId}`);
        }
        startId = cursorResult.id; 
      }  
      
      const startNode = await figma.getNodeByIdAsync(startId);
      if (!startNode) throw new Error(`Start node not found with ID: ${startId}`);

      // Check and potentially replace end node ID
      if (endId.includes(';')) {
        console.log(`Nested end node detected: ${endId}. Creating cursor node.`);
        const cursorResult = await createCursorNode(endId);
        if (!cursorResult || !cursorResult.id) {
          throw new Error(`Failed to create cursor node for nested end node: ${endId}`);
        }
        endId = cursorResult.id;
      }
      const endNode = await figma.getNodeByIdAsync(endId);
      if (!endNode) throw new Error(`End node not found with ID: ${endId}`);

      
      // Clone the default connector
      const clonedConnector = defaultConnector.clone();
      
      // Update connector name using potentially replaced node names
      clonedConnector.name = `TTF_Connector/${startNode.id}/${endNode.id}`;
      
      // Set start and end points using potentially replaced IDs
      clonedConnector.connectorStart = {
        endpointNodeId: startId,
        magnet: 'AUTO'
      };
      
      clonedConnector.connectorEnd = {
        endpointNodeId: endId,
        magnet: 'AUTO'
      };
      
      // Add text (if provided)
      if (text) {
        try {
          // Try to load the necessary fonts
          try {
            // First check if default connector has font and use the same
            if (defaultConnector.text && defaultConnector.text.fontName) {
              const fontName = defaultConnector.text.fontName;
              await figma.loadFontAsync(fontName);
              clonedConnector.text.fontName = fontName;
            } else {
              // Try default Inter font
              await figma.loadFontAsync({ family: "Inter", style: "Regular" });
            }
          } catch (fontError) {
            // If first font load fails, try another font style
            try {
              await figma.loadFontAsync({ family: "Inter", style: "Medium" });
            } catch (mediumFontError) {
              // If second font fails, try system font
              try {
                await figma.loadFontAsync({ family: "System", style: "Regular" });
              } catch (systemFontError) {
                // If all font loading attempts fail, throw error
                throw new Error(`Failed to load any font: ${fontError.message}`);
              }
            }
          }
          
          // Set the text
          clonedConnector.text.characters = text;
        } catch (textError) {
          console.error("Error setting text:", textError);
          // Continue with connection even if text setting fails
          results.push({
            id: clonedConnector.id,
            startNodeId: startNodeId,
            endNodeId: endNodeId,
            text: "",
            textError: textError.message
          });
          
          // Continue to next connection
          continue;
        }
      }
      
      // Add to results (using the *original* IDs for reference if needed)
      results.push({
        id: clonedConnector.id,
        originalStartNodeId: originalStartId,
        originalEndNodeId: originalEndId,
        usedStartNodeId: startId, // ID actually used for connection
        usedEndNodeId: endId,     // ID actually used for connection
        text: text || ""
      });
      
      // Update progress
      processedCount++;
      await progress.tick(processedCount, `Created connection ${processedCount}/${totalCount}`);

    } catch (error) {
      console.error("Error creating connection", error);
      // Continue processing remaining connections even if an error occurs
      processedCount++;
      await progress.tick(processedCount, `Error creating connection: ${error.message}`);

      results.push({
        error: error.message,
        connectionInfo: connections[i]
      });
    }
  }

  await progress.done(`Completed creating ${results.length} connections`);

  return {
    success: true,
    count: results.length,
    connections: results
  };
}

// Set focus on a specific node
async function setFocus(params) {
  if (!params || !params.nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) {
    throw new Error(`Node with ID ${params.nodeId} not found`);
  }

  // Set selection to the node
  figma.currentPage.selection = [node];
  
  // Scroll and zoom to show the node in viewport
  figma.viewport.scrollAndZoomIntoView([node]);

  return {
    success: true,
    name: node.name,
    id: node.id,
    message: `Focused on node "${node.name}"`
  };
}

// Set selection to multiple nodes
async function setSelections(params) {
  if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
    throw new Error("Missing or invalid nodeIds parameter");
  }

  if (params.nodeIds.length === 0) {
    throw new Error("nodeIds array cannot be empty");
  }

  // Get all valid nodes
  const nodes = [];
  const notFoundIds = [];
  
  for (const nodeId of params.nodeIds) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (node) {
      nodes.push(node);
    } else {
      notFoundIds.push(nodeId);
    }
  }

  if (nodes.length === 0) {
    throw new Error(`No valid nodes found for the provided IDs: ${params.nodeIds.join(', ')}`);
  }

  // Set selection to the nodes
  figma.currentPage.selection = nodes;
  
  // Scroll and zoom to show all nodes in viewport
  figma.viewport.scrollAndZoomIntoView(nodes);

  const selectedNodes = nodes.map(node => ({
    name: node.name,
    id: node.id
  }));

  return {
    success: true,
    count: nodes.length,
    selectedNodes: selectedNodes,
    notFoundIds: notFoundIds,
    message: `Selected ${nodes.length} nodes${notFoundIds.length > 0 ? ` (${notFoundIds.length} not found)` : ''}`
  };
}

// Combine standalone COMPONENT nodes into one COMPONENT_SET (variants).
// Figma derives variant properties from each component's name in
// "Prop=Value, Prop2=Value2" form, so callers usually pass `rename` to set
// those names atomically before the merge.
// Parse a component name ("State=Hover, Size=Large") into a {prop: value} map.
function parseVariantName(name) {
  const out = {};
  for (const part of String(name).split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// When the set has exactly 2 variant props, place each child on the matrix
// (rows = first prop's values, cols = second's) so the grid reads like the
// variant table. Returns null to fall back to a wrap grid: names aren't valid
// Prop=Value pairs, there aren't exactly 2 props, or a child misses the matrix.
function variantMatrixLayout(set, kids) {
  let props;
  try {
    props = set.variantGroupProperties;
  } catch (e) {
    return null;
  }
  if (!props) return null;
  const keys = Object.keys(props);
  if (keys.length !== 2) return null;
  const rowVals = (props[keys[0]] && props[keys[0]].values) || [];
  const colVals = (props[keys[1]] && props[keys[1]].values) || [];
  const out = [];
  for (const k of kids) {
    const m = parseVariantName(k.name);
    const r = rowVals.indexOf(m[keys[0]]);
    const c = colVals.indexOf(m[keys[1]]);
    if (r < 0 || c < 0) return null;
    out.push({ node: k, row: r, col: c });
  }
  return out;
}

// figma.combineAsVariants keeps each component's original x/y, so a set built
// from scattered components has gaps (mirroring the API, not the Figma UI which
// auto-packs). Re-lay the children into a tidy grid and shrink the set to fit.
// Cell = the largest child footprint, so differently-sized variants still align.
function packVariantGrid(set, opts) {
  opts = opts || {};
  const padding = typeof opts.padding === "number" ? opts.padding : 16;
  const gap = typeof opts.gap === "number" ? opts.gap : 16;
  const kids = set.children.slice();
  if (kids.length < 1) return;

  let cellW = 0;
  let cellH = 0;
  for (const k of kids) {
    if (k.width > cellW) cellW = k.width;
    if (k.height > cellH) cellH = k.height;
  }

  let layout = variantMatrixLayout(set, kids);
  if (!layout) {
    const cols = Math.ceil(Math.sqrt(kids.length));
    layout = kids.map((k, i) => ({ node: k, row: Math.floor(i / cols), col: i % cols }));
  }

  let maxRow = 0;
  let maxCol = 0;
  for (const it of layout) {
    if (it.row > maxRow) maxRow = it.row;
    if (it.col > maxCol) maxCol = it.col;
  }

  for (const it of layout) {
    it.node.x = padding + it.col * (cellW + gap);
    it.node.y = padding + it.row * (cellH + gap);
  }

  // Resize before clearing absolute children would overflow — set spans the full
  // grid plus padding on every side.
  const w = padding * 2 + (maxCol + 1) * cellW + maxCol * gap;
  const h = padding * 2 + (maxRow + 1) * cellH + maxRow * gap;
  if ("resize" in set) set.resize(w, h);
}

async function combineAsVariants(params) {
  const { nodeIds, name, parentId, rename, arrange, gap } = params || {};
  if (!Array.isArray(nodeIds) || nodeIds.length < 2) {
    throw new Error("combine_as_variants requires `nodeIds` with at least 2 component ids");
  }

  // Each id needs an async getNodeByIdAsync; a large set can exceed the 30s
  // timeout, so stream progress across the rename + resolve passes.
  const progress = makeProgress("combine_as_variants", (Array.isArray(rename) ? rename.length : 0) + nodeIds.length, { commandId: params && params.commandId, minItems: 5 });
  await progress.start(`Resolving ${nodeIds.length} components...`);
  let done = 0;

  // Rename pass first: combineAsVariants reads names to infer variant props.
  if (Array.isArray(rename)) {
    for (const r of rename) {
      await progress.tick(++done, `Renaming (${done})`);
      if (!r || !r.nodeId || typeof r.name !== "string") continue;
      const n = await figma.getNodeByIdAsync(r.nodeId);
      if (n) n.name = r.name;
    }
  }

  const nodes = [];
  for (const id of nodeIds) {
    await progress.tick(++done, `Resolved ${nodes.length}/${nodeIds.length} components`);
    const node = await figma.getNodeByIdAsync(id);
    if (!node) throw new Error(`Node not found: ${id}`);
    if (node.type !== "COMPONENT") {
      throw new Error(`Node ${id} is ${node.type}; combine_as_variants only accepts COMPONENT nodes`);
    }
    nodes.push(node);
  }
  await progress.done(`Combining ${nodes.length} components into a variant set`);

  let parent = figma.currentPage;
  if (parentId) {
    parent = await figma.getNodeByIdAsync(parentId);
    if (!parent) throw new Error(`Parent not found: ${parentId}`);
  }

  // Throws if the components live on different pages or names collide.
  const set = figma.combineAsVariants(nodes, parent);
  if (typeof name === "string" && name) set.name = name;

  // Pack the children into a grid (default on) — combineAsVariants leaves them
  // at their scattered source coords otherwise. Never fail the combine over a
  // layout hiccup; the set already exists.
  let arranged = false;
  if (arrange !== false) {
    try {
      packVariantGrid(set, { gap });
      arranged = true;
    } catch (e) {
      console.error("packVariantGrid failed:", e);
    }
  }

  // variantGroupProperties throws when names aren't valid Prop=Value pairs;
  // surface the warning rather than failing the whole op.
  let variantProperties = null;
  let variantWarning = undefined;
  try {
    variantProperties = set.variantGroupProperties;
  } catch (e) {
    variantWarning = `Component names are not valid "Prop=Value" variants: ${e instanceof Error ? e.message : String(e)}`;
  }

  return {
    success: true,
    id: set.id,
    name: set.name,
    type: set.type,
    childCount: set.children.length,
    arranged,
    variantProperties,
    variantWarning,
  };
}

// Combine 2+ vector/shape nodes with a boolean op (union/subtract/intersect/
// exclude) into one BOOLEAN_OPERATION node. Order matters: for subtract the
// first node is the base and the rest are cut out of it; same z-order logic
// drives exclude. The op is non-destructive — children stay editable inside.
async function booleanOperation(params) {
  const { operation, nodeIds, name, parentId } = params || {};
  const opFns = {
    union: figma.union,
    subtract: figma.subtract,
    intersect: figma.intersect,
    exclude: figma.exclude,
  };
  const fn = opFns[operation];
  if (!fn) {
    throw new Error(`boolean_operation requires \`operation\` one of: ${Object.keys(opFns).join(", ")}`);
  }
  if (!Array.isArray(nodeIds) || nodeIds.length < 2) {
    throw new Error("boolean_operation requires `nodeIds` with at least 2 node ids");
  }

  const progress = makeProgress("boolean_operation", nodeIds.length, { commandId: params && params.commandId, minItems: 5 });
  await progress.start(`Resolving ${nodeIds.length} nodes...`);
  let done = 0;
  const nodes = [];
  for (const id of nodeIds) {
    await progress.tick(++done, `Resolved ${nodes.length}/${nodeIds.length} nodes`);
    const node = await figma.getNodeByIdAsync(id);
    if (!node) throw new Error(`Node not found: ${id}`);
    nodes.push(node);
  }

  let parent = figma.currentPage;
  if (parentId) {
    parent = await figma.getNodeByIdAsync(parentId);
    if (!parent) throw new Error(`Parent not found: ${parentId}`);
  }
  await progress.done(`Applying ${operation} to ${nodes.length} nodes`);

  // figma.union/subtract/intersect/exclude throw if a node isn't a valid
  // boolean operand (e.g. not a vector/shape) or the parent can't host it.
  const result = fn.call(figma, nodes, parent);
  if (typeof name === "string" && name) result.name = name;

  return {
    success: true,
    id: result.id,
    name: result.name,
    type: result.type,
    booleanOperation: result.booleanOperation,
    childCount: result.children.length,
  };
}

// Convert existing nodes into a node of a different kind, in place. One tool,
// four ops with distinct shapes:
//  - flatten:        figma.flatten(nodes, parent) — merges ALL nodeIds into ONE vector.
//  - outline_stroke: node.outlineStroke() — per node; returns a NEW vector of the
//      stroke rendered as fills, inserted above the original (original left intact).
//      Returns null when the node has no stroke.
//  - to_component:   figma.createComponentFromNode(node) — per node; replaces the node
//      with a COMPONENT preserving its children (createComponent makes an empty one).
//  - detach:         instance.detachInstance() — per node; INSTANCE -> standalone FRAME.
async function convertNodes(params) {
  const { operation, nodeIds, name, parentId } = params || {};
  const OPS = ["flatten", "outline_stroke", "to_component", "detach"];
  if (OPS.indexOf(operation) === -1) {
    throw new Error(`convert_nodes requires \`operation\` one of: ${OPS.join(", ")}`);
  }
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
    throw new Error("convert_nodes requires a non-empty `nodeIds` array");
  }

  // Resolve pass (getNodeByIdAsync per id) + the per-node op loop below both run
  // under the 30s timeout; flatten has no op loop (single figma.flatten call).
  const progress = makeProgress("convert_nodes", nodeIds.length + (operation === "flatten" ? 0 : nodeIds.length), { commandId: params && params.commandId, minItems: 5 });
  await progress.start(`Resolving ${nodeIds.length} nodes...`);
  let done = 0;

  const nodes = [];
  for (const id of nodeIds) {
    await progress.tick(++done, `Resolved ${nodes.length}/${nodeIds.length} nodes`);
    const node = await figma.getNodeByIdAsync(id);
    if (!node) throw new Error(`Node not found: ${id}`);
    nodes.push(node);
  }

  // flatten consumes all operands into a single vector; the others map 1:1.
  if (operation === "flatten") {
    let parent = nodes[0].parent || figma.currentPage;
    if (parentId) {
      parent = await figma.getNodeByIdAsync(parentId);
      if (!parent) throw new Error(`Parent not found: ${parentId}`);
    }
    // Throws if an operand can't be flattened or the parent can't host the result.
    const v = figma.flatten(nodes, parent);
    if (typeof name === "string" && name) v.name = name;
    await progress.done(`Flattened ${nodes.length} nodes`);
    return {
      success: true,
      operation,
      results: [{ oldIds: nodeIds, newId: v.id, name: v.name, type: v.type }],
    };
  }

  const results = [];
  for (const node of nodes) {
    await progress.tick(++done, `${operation}: ${results.length}/${nodes.length} done`);
    if (operation === "outline_stroke") {
      const v = node.outlineStroke();
      results.push(
        v
          ? { oldId: node.id, newId: v.id, name: v.name, type: v.type }
          : { oldId: node.id, newId: null, skipped: "node has no stroke to outline" }
      );
    } else if (operation === "to_component") {
      if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
        results.push({ oldId: node.id, newId: node.id, skipped: `already ${node.type}` });
        continue;
      }
      // Replaces the node in place, preserving its children/content.
      const comp = figma.createComponentFromNode(node);
      results.push({ oldId: node.id, newId: comp.id, name: comp.name, type: comp.type });
    } else if (operation === "detach") {
      if (node.type !== "INSTANCE") {
        throw new Error(`detach requires INSTANCE nodes; ${node.id} is ${node.type}`);
      }
      const frame = node.detachInstance();
      results.push({ oldId: node.id, newId: frame.id, name: frame.name, type: frame.type });
    }
  }

  // A single produced node can take an explicit name; naming N nodes the same is ambiguous.
  if (typeof name === "string" && name && results.length === 1 && results[0].newId) {
    const n = await figma.getNodeByIdAsync(results[0].newId);
    if (n) {
      n.name = name;
      results[0].name = name;
    }
  }

  await progress.done(`${operation}: ${results.length} nodes`);
  return { success: true, operation, results };
}

// List fonts loadable via loadFontAsync, so the agent doesn't guess names.
// listAvailableFontsAsync returns thousands of {fontName:{family,style}}; group
// by family and filter by an optional case-insensitive substring on the family.
async function listFonts(params) {
  const { query, limit } = params || {};
  const cap = typeof limit === "number" && limit > 0 ? limit : 200;
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";

  const fonts = await figma.listAvailableFontsAsync();
  const byFamily = new Map();
  for (const f of fonts) {
    const family = f.fontName.family;
    if (q && family.toLowerCase().indexOf(q) === -1) continue;
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family).push(f.fontName.style);
  }

  const allFamilies = Array.from(byFamily.keys()).sort();
  const families = allFamilies.slice(0, cap).map((family) => ({
    family,
    styles: byFamily.get(family),
  }));

  return {
    success: true,
    query: q || null,
    totalFamilies: allFamilies.length,
    returnedFamilies: families.length,
    truncated: allFamilies.length > families.length,
    families,
  };
}

// Apply per-character-range text styling that whole-node setters (edit_nodes)
// can't express: in Figma a TextNode's fontName/fontSize/fills/etc can vary per
// range, and are set only via setRange* methods, not assignable properties.
// CRITICAL: every setRange* throws if the range it touches contains an unloaded
// font, so we load all fonts currently in the node (plus any a range introduces)
// before touching anything.
async function styleTextRange(params) {
  const { nodeId, ranges } = params || {};
  if (!nodeId) throw new Error("style_text_range requires `nodeId`");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  if (node.type !== "TEXT") {
    throw new Error(`style_text_range requires a TEXT node, not ${node.type}`);
  }
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new Error("style_text_range requires a non-empty `ranges` array");
  }

  const len = node.characters.length;

  // Font loads (one async call each) plus the per-range styling can together
  // exceed the 30s timeout on a heavily-styled node, so stream progress.
  const fontsToLoad = node.getRangeAllFontNames(0, len);
  const progress = makeProgress("style_text_range", fontsToLoad.length + ranges.length, { commandId: params && params.commandId, minItems: 5 });
  await progress.start(`Loading ${fontsToLoad.length} fonts...`);
  let done = 0;

  // Load every font already used in the node, then any new font a range brings in.
  for (const f of fontsToLoad) {
    await figma.loadFontAsync(f);
    await progress.tick(++done, `Loaded ${done}/${fontsToLoad.length} fonts`);
  }
  for (const r of ranges) {
    if (r && r.fontName) await figma.loadFontAsync(r.fontName);
  }

  const results = [];
  for (let i = 0; i < ranges.length; i++) {
    await progress.tick(++done, `Styled ${i}/${ranges.length} ranges`);
    const r = ranges[i] || {};
    const { start, end } = r;
    if (typeof start !== "number" || typeof end !== "number") {
      throw new Error(`ranges[${i}] needs numeric \`start\` and \`end\``);
    }
    if (start < 0 || end > len || start >= end) {
      throw new Error(`ranges[${i}] (${start}..${end}) out of bounds for text length ${len}`);
    }

    const applied = [];
    if (r.fontName !== undefined) { node.setRangeFontName(start, end, r.fontName); applied.push("fontName"); }
    if (r.fontSize !== undefined) { node.setRangeFontSize(start, end, r.fontSize); applied.push("fontSize"); }
    if (r.fills !== undefined) { node.setRangeFills(start, end, coerceColors(r.fills)); applied.push("fills"); }
    if (r.textCase !== undefined) { node.setRangeTextCase(start, end, r.textCase); applied.push("textCase"); }
    if (r.textDecoration !== undefined) { node.setRangeTextDecoration(start, end, r.textDecoration); applied.push("textDecoration"); }
    if (r.letterSpacing !== undefined) { node.setRangeLetterSpacing(start, end, coerceTypedUnit("letterSpacing", r.letterSpacing)); applied.push("letterSpacing"); }
    if (r.lineHeight !== undefined) { node.setRangeLineHeight(start, end, coerceTypedUnit("lineHeight", r.lineHeight)); applied.push("lineHeight"); }
    if (r.hyperlink !== undefined) {
      // null clears the link; a bare string is shorthand for {type:"URL", value}.
      const hl = r.hyperlink === null
        ? null
        : typeof r.hyperlink === "string"
          ? { type: "URL", value: r.hyperlink }
          : r.hyperlink;
      node.setRangeHyperlink(start, end, hl);
      applied.push("hyperlink");
    }
    if (r.listOptions !== undefined) { node.setRangeListOptions(start, end, r.listOptions); applied.push("listOptions"); }
    if (r.indentation !== undefined) { node.setRangeIndentation(start, end, r.indentation); applied.push("indentation"); }
    if (r.textStyleId !== undefined) { await node.setRangeTextStyleIdAsync(start, end, r.textStyleId); applied.push("textStyleId"); }
    if (r.fillStyleId !== undefined) { await node.setRangeFillStyleIdAsync(start, end, r.fillStyleId); applied.push("fillStyleId"); }

    results.push({ start, end, applied });
  }

  await progress.done(`Styled ${results.length} ranges`);
  return { success: true, nodeId: node.id, length: len, ranges: results };
}

// Group/ungroup, the inverse halves of one operation.
// - group: wrap 2+ nodes in a GROUP. figma.group reparents them (they must share
//   a reachable scene), so parent defaults to the first node's current parent
//   rather than the page — grouping siblings shouldn't yank them to the root.
// - ungroup: dissolve each GROUP/FRAME back into its parent. figma.ungroup
//   returns the freed children with fresh ids (they're reparented), so echo the
//   new ids for the agent to keep operating on them.
async function editGroups(params) {
  const { operation, nodeIds, name, parentId } = params || {};
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
    throw new Error("edit_groups requires a non-empty `nodeIds` array");
  }

  const progress = makeProgress("edit_groups", nodeIds.length, { commandId: params && params.commandId, minItems: 5 });
  await progress.start(`Resolving ${nodeIds.length} nodes...`);
  let done = 0;
  const nodes = [];
  for (const id of nodeIds) {
    await progress.tick(++done, `Resolved ${nodes.length}/${nodeIds.length} nodes`);
    const node = await figma.getNodeByIdAsync(id);
    if (!node) throw new Error(`Node not found: ${id}`);
    nodes.push(node);
  }
  await progress.done(`Resolved ${nodes.length} nodes`);

  if (operation === "ungroup") {
    const freed = [];
    for (const node of nodes) {
      if (typeof node.children === "undefined") {
        throw new Error(`Node ${node.id} is ${node.type}; ungroup only accepts container nodes (GROUP/FRAME)`);
      }
      // figma.ungroup throws if the node has no parent (e.g. already detached).
      for (const c of figma.ungroup(node)) {
        freed.push({ id: c.id, name: c.name, type: c.type });
      }
    }
    return { success: true, operation, childCount: freed.length, children: freed };
  }

  if (operation === "group") {
    if (nodes.length < 2) {
      throw new Error("group requires at least 2 node ids");
    }
    let parent;
    if (parentId) {
      parent = await figma.getNodeByIdAsync(parentId);
      if (!parent) throw new Error(`Parent not found: ${parentId}`);
    } else {
      parent = nodes[0].parent || figma.currentPage;
    }
    // Throws if nodes can't be grouped (e.g. mixed pages, parent can't host).
    const group = figma.group(nodes, parent);
    if (typeof name === "string" && name) group.name = name;
    return {
      success: true,
      operation,
      id: group.id,
      name: group.name,
      type: group.type,
      childCount: group.children.length,
    };
  }

  throw new Error("edit_groups requires `operation` one of: group, ungroup");
}

// ---- Tables (FigJam) ----

// Set one cell's text. Coordinates are 0-indexed; text lives on the cell's
// `.text` TextSublayer, so setCharacters loads its font before writing.
async function setTableCellText(table, cell) {
  if (!cell || typeof cell.row !== "number" || typeof cell.column !== "number") {
    throw new Error("cell needs numeric `row` and `column`");
  }
  if (cell.row < 0 || cell.row >= table.numRows || cell.column < 0 || cell.column >= table.numColumns) {
    throw new Error(`cell (${cell.row},${cell.column}) out of bounds for ${table.numRows}x${table.numColumns} table`);
  }
  await setCharacters(table.cellAt(cell.row, cell.column).text, String(cell.text == null ? "" : cell.text));
}

async function writeTable(params) {
  if (figma.editorType !== "figjam") {
    throw new Error(`write_table requires a FigJam file (current editor: ${figma.editorType})`);
  }
  const { rows, columns, cells, parentId, index, x, y, name } = params || {};
  const r = Math.floor(Number(rows));
  const c = Math.floor(Number(columns));
  if (!(r >= 1) || !(c >= 1)) throw new Error("write_table requires rows >= 1 and columns >= 1");

  const table = figma.createTable(r, c);

  let parent = figma.currentPage;
  if (parentId) {
    const p = await figma.getNodeByIdAsync(parentId);
    if (!p) throw new Error(`Parent not found: ${parentId}`);
    if (!("appendChild" in p)) throw new Error(`Parent ${parentId} cannot have children`);
    parent = p;
  }
  if (typeof index === "number" && "insertChild" in parent) parent.insertChild(index, table);
  else parent.appendChild(table);
  if (typeof x === "number") table.x = x;
  if (typeof y === "number") table.y = y;
  if (typeof name === "string" && name) table.name = name;

  const cellErrors = [];
  if (Array.isArray(cells)) {
    // Each cell loads its font (async); a big table can exceed the 30s timeout.
    const progress = makeProgress("write_table", cells.length, { commandId: params && params.commandId, minItems: 5 });
    await progress.start(`Filling ${cells.length} cells...`);
    let done = 0;
    for (const cell of cells) {
      await progress.tick(++done, `Filled ${done}/${cells.length} cells`);
      try {
        await setTableCellText(table, cell);
      } catch (err) {
        cellErrors.push({ row: cell && cell.row, column: cell && cell.column, error: err && err.message ? err.message : String(err) });
      }
    }
    await progress.done(`Filled ${cells.length} cells`);
  }

  const result = { success: true, id: table.id, name: table.name, type: table.type, numRows: table.numRows, numColumns: table.numColumns };
  if (cellErrors.length) result.cellErrors = cellErrors;
  return result;
}

async function editTable(params) {
  const { tableId, addRows, addColumns, removeRows, removeColumns, resizeRows, resizeColumns, cells } = params || {};
  if (!tableId) throw new Error("edit_table requires `tableId`");
  const table = await figma.getNodeByIdAsync(tableId);
  if (!table) throw new Error(`Table not found: ${tableId}`);
  if (table.type !== "TABLE") throw new Error(`Node ${tableId} is ${table.type}, not a TABLE`);

  const errors = [];
  const tryOp = (label, fn) => {
    try { fn(); } catch (err) { errors.push({ op: label, error: err && err.message ? err.message : String(err) }); }
  };

  // Fixed order so indices stay predictable: grow, then shrink (high-index-first
  // so a list like [1,3] doesn't shift under itself), then resize, then fill.
  const nAddCols = Math.max(0, Math.floor(Number(addColumns) || 0));
  const nAddRows = Math.max(0, Math.floor(Number(addRows) || 0));
  for (let i = 0; i < nAddCols; i++) tryOp("addColumns", () => table.insertColumn(table.numColumns));
  for (let i = 0; i < nAddRows; i++) tryOp("addRows", () => table.insertRow(table.numRows));
  if (Array.isArray(removeColumns)) for (const idx of [...removeColumns].sort((a, b) => b - a)) tryOp(`removeColumn ${idx}`, () => table.removeColumn(idx));
  if (Array.isArray(removeRows)) for (const idx of [...removeRows].sort((a, b) => b - a)) tryOp(`removeRow ${idx}`, () => table.removeRow(idx));
  if (Array.isArray(resizeColumns)) for (const rc of resizeColumns) tryOp(`resizeColumn ${rc && rc.index}`, () => table.resizeColumn(rc.index, rc.width));
  if (Array.isArray(resizeRows)) for (const rr of resizeRows) tryOp(`resizeRow ${rr && rr.index}`, () => table.resizeRow(rr.index, rr.height));

  if (Array.isArray(cells)) {
    // Each cell loads its font (async); a big batch can exceed the 30s timeout.
    const progress = makeProgress("edit_table", cells.length, { commandId: params && params.commandId, minItems: 5 });
    await progress.start(`Filling ${cells.length} cells...`);
    let done = 0;
    for (const cell of cells) {
      await progress.tick(++done, `Filled ${done}/${cells.length} cells`);
      try {
        await setTableCellText(table, cell);
      } catch (err) {
        errors.push({ op: `cell (${cell && cell.row},${cell && cell.column})`, error: err && err.message ? err.message : String(err) });
      }
    }
    await progress.done(`Filled ${cells.length} cells`);
  }

  const result = { success: true, id: table.id, name: table.name, type: table.type, numRows: table.numRows, numColumns: table.numColumns };
  if (errors.length) result.errors = errors;
  return result;
}

// ---- Variables / design tokens ----

/** #RGB / #RGBA / #RRGGBB / #RRGGBBAA → {r,g,b,a} 0-1. null on malformed input. */
function hexToRgba01(hex) {
  let h = String(hex).trim().replace(/^#/, "");
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  if (h.length === 6) h += "ff";
  if (!/^[0-9a-fA-F]{8}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
    a: parseInt(h.slice(6, 8), 16) / 255,
  };
}

/** A user-supplied value that points at another variable rather than a literal. */
function isAliasInput(v) {
  return v && typeof v === "object" && (typeof v.alias === "string" || v.type === "VARIABLE_ALIAS");
}

/** Coerce a literal into a Figma variable value of `type`. Aliases are handled separately. */
function coerceVariableValue(type, value) {
  if (type === "COLOR") {
    if (typeof value === "string") {
      const c = hexToRgba01(value);
      if (!c) throw new Error("Invalid color hex: " + value);
      return c;
    }
    if (value && typeof value === "object" && typeof value.r === "number") {
      return { r: value.r, g: value.g, b: value.b, a: value.a !== undefined ? value.a : 1 };
    }
    throw new Error("COLOR value must be a hex string or {r,g,b,a}: " + JSON.stringify(value));
  }
  if (type === "FLOAT") {
    const n = typeof value === "number" ? value : parseFloat(value);
    if (!isFinite(n)) throw new Error("FLOAT value must be a number: " + JSON.stringify(value));
    return n;
  }
  if (type === "STRING") return String(value);
  if (type === "BOOLEAN") return Boolean(value);
  throw new Error("Unknown variable type: " + type);
}

async function getVariables(params) {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const allVars = await figma.variables.getLocalVariablesAsync();
  const varById = {};
  for (const v of allVars) varById[v.id] = v;

  // Aliases are stored as {type:'VARIABLE_ALIAS', id}; resolve to the target's name
  // so the agent reads/round-trips by name instead of opaque ids. Colors → hex.
  function resolveValue(type, value) {
    if (value && value.type === "VARIABLE_ALIAS") {
      const ref = varById[value.id];
      return { alias: ref ? ref.name : value.id, aliasId: value.id };
    }
    if (type === "COLOR" && value && typeof value.r === "number") return rgbaToHex(value);
    return value;
  }

  const wanted = params && params.collection ? String(params.collection) : null;
  return {
    collections: collections
      .filter((c) => !wanted || c.id === wanted || c.name === wanted)
      .map((c) => {
        const modeName = {};
        c.modes.forEach((m) => (modeName[m.modeId] = m.name));
        const variables = c.variableIds
          .map((id) => varById[id])
          .filter(Boolean)
          .map((v) => {
            const valuesByMode = {};
            for (const modeId in v.valuesByMode) {
              valuesByMode[modeName[modeId] || modeId] = resolveValue(v.resolvedType, v.valuesByMode[modeId]);
            }
            return {
              id: v.id,
              name: v.name,
              type: v.resolvedType,
              scopes: v.scopes,
              description: v.description || undefined,
              valuesByMode,
            };
          });
        return {
          id: c.id,
          name: c.name,
          defaultModeId: c.defaultModeId,
          modes: c.modes.map((m) => ({ modeId: m.modeId, name: m.name })),
          variableCount: variables.length,
          variables,
        };
      }),
  };
}

async function setVariables(params) {
  const input = (params && params.collections) || [];
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("set_variables requires a non-empty `collections` array");
  }

  const existingCollections = await figma.variables.getLocalVariableCollectionsAsync();
  const existingVars = await figma.variables.getLocalVariablesAsync();

  // Variable names are unique within a collection, not globally — key alias lookups
  // by collectionId+name, with a bare-name fallback for cross-collection refs.
  const varByKey = {};
  const varByName = {};
  for (const v of existingVars) {
    varByKey[v.variableCollectionId + "\u0000" + v.name] = v;
    varByName[v.name] = v;
  }

  const result = { collections: [], variablesCreated: 0, variablesUpdated: 0 };
  // Aliases resolve in a second pass so a token can reference one created later in the batch.
  const pendingAliases = [];

  // Many tokens (async lookups + setValueForMode per mode) can exceed the 30s
  // timeout; stream progress over the total variable count across collections.
  const totalVars = input.reduce((a, cs) => a + ((cs.variables && cs.variables.length) || 0), 0);
  const progress = makeProgress("set_variables", totalVars, { commandId: params && params.commandId, minItems: 5 });
  await progress.start(`Writing ${totalVars} variables...`);
  let done = 0;

  for (const cs of input) {
    let collection = null;
    if (cs.id) {
      collection = existingCollections.find((c) => c.id === cs.id) ||
        (await figma.variables.getVariableCollectionByIdAsync(cs.id));
      if (!collection) throw new Error("Collection not found: " + cs.id);
    } else if (cs.name) {
      collection = existingCollections.find((c) => c.name === cs.name) || null;
    }

    let createdCollection = false;
    if (!collection) {
      if (!cs.name) throw new Error("Each collection needs `name` or `id`");
      collection = figma.variables.createVariableCollection(cs.name);
      createdCollection = true;
      existingCollections.push(collection);
    } else if (cs.name && collection.name !== cs.name) {
      collection.name = cs.name;
    }

    const modeIdByName = {};
    collection.modes.forEach((m) => (modeIdByName[m.name] = m.modeId));
    if (Array.isArray(cs.modes) && cs.modes.length) {
      // A fresh collection always has one default mode ("Mode 1") — repurpose it as
      // the first requested mode instead of leaving a stray mode behind.
      if (createdCollection) {
        const first = collection.modes[0];
        collection.renameMode(first.modeId, cs.modes[0]);
        delete modeIdByName[first.name];
        modeIdByName[cs.modes[0]] = first.modeId;
      }
      for (const mname of cs.modes) {
        if (modeIdByName[mname]) continue;
        try {
          modeIdByName[mname] = collection.addMode(mname);
        } catch (e) {
          throw new Error(
            'Cannot add mode "' + mname + '" to "' + collection.name + '": ' +
            (e && e.message ? e.message : String(e)) +
            " (more than one mode per collection requires a paid Figma plan)"
          );
        }
      }
    }

    const varsOut = [];
    for (const vi of cs.variables || []) {
      await progress.tick(++done, `Wrote ${done}/${totalVars} variables`);
      let variable = null;
      if (vi.id) {
        variable = existingVars.find((v) => v.id === vi.id) ||
          (await figma.variables.getVariableByIdAsync(vi.id));
        if (!variable) throw new Error("Variable not found: " + vi.id);
      } else {
        variable = varByKey[collection.id + "\u0000" + vi.name] || null;
      }

      if (!variable) {
        if (!vi.type) {
          throw new Error('Variable "' + vi.name + '" needs `type` (COLOR|FLOAT|STRING|BOOLEAN) to be created');
        }
        variable = figma.variables.createVariable(vi.name, collection, vi.type);
        result.variablesCreated++;
        existingVars.push(variable);
        varByKey[collection.id + "\u0000" + variable.name] = variable;
        varByName[variable.name] = variable;
      } else {
        result.variablesUpdated++;
        if (vi.name && variable.name !== vi.name) variable.name = vi.name;
      }

      if (Array.isArray(vi.scopes)) variable.scopes = vi.scopes;
      if (typeof vi.description === "string") variable.description = vi.description;

      const vbm = vi.valuesByMode || {};
      for (const modeName in vbm) {
        const modeId = modeIdByName[modeName];
        if (!modeId) {
          throw new Error('Mode "' + modeName + '" not found in "' + collection.name + '". Declare it in `modes`.');
        }
        const raw = vbm[modeName];
        if (isAliasInput(raw)) {
          pendingAliases.push({ variable, modeId, ref: raw, collectionId: collection.id });
        } else {
          variable.setValueForMode(modeId, coerceVariableValue(variable.resolvedType, raw));
        }
      }
      varsOut.push({ id: variable.id, name: variable.name, type: variable.resolvedType });
    }

    result.collections.push({
      id: collection.id,
      name: collection.name,
      modes: collection.modes.map((m) => ({ modeId: m.modeId, name: m.name })),
      variables: varsOut,
    });
  }

  for (const pa of pendingAliases) {
    await progress.tick(done, `Resolving ${pendingAliases.length} aliases`);
    const refName = pa.ref.alias;
    const refId = pa.ref.id;
    let target = null;
    if (refId) target = await figma.variables.getVariableByIdAsync(refId);
    if (!target && refName) {
      target = varByKey[pa.collectionId + "\u0000" + refName] || varByName[refName] || null;
    }
    if (!target) throw new Error("Alias target not found: " + (refName || refId));
    pa.variable.setValueForMode(pa.modeId, figma.variables.createVariableAlias(target));
  }

  await progress.done(`Wrote ${totalVars} variables`);
  return result;
}

// Fills/strokes bind their *paint* color, not a plain node field, so they go through
// setBoundVariableForPaint. Everything else uses node.setBoundVariable(field, ...).
var BIND_PAINT_FIELDS = { fills: "fills", fill: "fills", strokes: "strokes", stroke: "strokes" };
var BIND_FIELD_ALIASES = { gap: "itemSpacing", spacing: "itemSpacing", radius: "cornerRadius" };

async function bindVariables(params) {
  const bindings = (params && params.bindings) || [];
  if (!Array.isArray(bindings) || bindings.length === 0) {
    throw new Error("bind_variables requires a non-empty `bindings` array");
  }

  const results = [];
  // Each binding awaits getNodeByIdAsync (and sometimes getLocalVariablesAsync);
  // a large batch can exceed the 30s timeout, so stream progress.
  const progress = makeProgress("bind_variables", bindings.length, { commandId: params && params.commandId, minItems: 5 });
  await progress.start(`Binding ${bindings.length} variables...`);
  let done = 0;
  for (const b of bindings) {
    await progress.tick(++done, `Bound ${done}/${bindings.length}`);
    try {
      const node = await figma.getNodeByIdAsync(b.nodeId);
      if (!node) throw new Error("Node not found: " + b.nodeId);

      let variable = null;
      if (!b.unbind) {
        if (b.variableId) variable = await figma.variables.getVariableByIdAsync(b.variableId);
        else if (b.variableName) {
          const all = await figma.variables.getLocalVariablesAsync();
          variable = all.find((v) => v.name === b.variableName) || null;
        }
        if (!variable) throw new Error("Variable not found: " + (b.variableId || b.variableName));
      }

      let field = String(b.field || "");
      const paintKind = BIND_PAINT_FIELDS[field];
      if (paintKind) {
        const idx = b.paintIndex || 0;
        const arr = (node[paintKind] || []).map((p) => Object.assign({}, p));
        if (!arr[idx]) throw new Error(paintKind + "[" + idx + "] does not exist on node " + b.nodeId);
        arr[idx] = figma.variables.setBoundVariableForPaint(arr[idx], "color", b.unbind ? null : variable);
        node[paintKind] = arr;
      } else {
        field = BIND_FIELD_ALIASES[field] || field;
        node.setBoundVariable(field, b.unbind ? null : variable);
      }

      results.push({
        nodeId: b.nodeId,
        field: b.field,
        bound: !b.unbind,
        variableId: variable ? variable.id : null,
        variableName: variable ? variable.name : null,
      });
    } catch (e) {
      results.push({ nodeId: b.nodeId, field: b.field, error: e instanceof Error ? e.message : String(e) });
    }
  }

  await progress.done(`Bound ${results.filter((r) => !r.error).length}/${bindings.length} variables`);
  return { results, total: bindings.length, applied: results.filter((r) => !r.error).length };
}
