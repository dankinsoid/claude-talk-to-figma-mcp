#!/usr/bin/env bun

import { Server, ServerWebSocket } from "bun";
import { tmpdir } from "os";
import { join } from "path";

// Store clients by channel
const channels = new Map<string, Set<ServerWebSocket<any>>>();

// Channels opened by a Figma plugin (role: "plugin" on join). Persisted to disk
// so the MCP server can discover the active channel without joining first.
// meta carries the open file's context: { name, page, editorType }.
interface PluginChannel {
  channel: string;
  meta?: any;
}
const pluginChannels = new Map<ServerWebSocket<any>, PluginChannel>();

// Shared with the MCP server (get_active_channel reads this same path).
const ACTIVE_CHANNELS_FILE = join(tmpdir(), "figma-active-channels.json");

function writeActiveChannels() {
  const byChannel = new Map<
    string,
    { channel: string; clients: number; meta?: any }
  >();
  for (const { channel, meta } of pluginChannels.values()) {
    const entry =
      byChannel.get(channel) ??
      { channel, clients: channels.get(channel)?.size ?? 0 };
    if (meta) entry.meta = meta;
    byChannel.set(channel, entry);
  }
  const payload = {
    updatedAt: new Date().toISOString(),
    channels: [...byChannel.values()],
  };
  Bun.write(ACTIVE_CHANNELS_FILE, JSON.stringify(payload, null, 2)).catch((err) =>
    console.error("Failed to write active channels file:", err)
  );
}

function handleConnection(ws: ServerWebSocket<any>) {
  // Don't add to clients immediately - wait for channel join
  console.log("New client connected");

  // Send welcome message to the new client
  ws.send(JSON.stringify({
    type: "system",
    message: "Please join a channel to start chatting",
  }));

  ws.close = () => {
    console.log("Client disconnected");

    // Remove client from their channel
    channels.forEach((clients, channelName) => {
      if (clients.has(ws)) {
        clients.delete(ws);

        // Notify other clients in same channel
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

// Start the relay on `port`. Returns the running server, or null if the port is
// already taken — that means another process (e.g. a second AI agent's embedded
// relay) is already hosting it, so the caller should just connect as a client.
export function startRelay(port: number = 3055): Server | null {
  let server: Server;
  try {
    server = Bun.serve({
  port,
  // uncomment this to allow connections in windows wsl
  // hostname: "0.0.0.0",
  fetch(req: Request, server: Server) {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Handle WebSocket upgrade
    const success = server.upgrade(req, {
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });

    if (success) {
      return; // Upgraded to WebSocket
    }

    // Return response for non-WebSocket requests
    return new Response("WebSocket server running", {
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
  websocket: {
    open: handleConnection,
    message(ws: ServerWebSocket<any>, message: string | Buffer) {
      try {
        const data = JSON.parse(message as string);
        console.log(`\n=== Received message from client ===`);
        console.log(`Type: ${data.type}, Channel: ${data.channel || 'N/A'}`);
        if (data.message?.command) {
          console.log(`Command: ${data.message.command}, ID: ${data.id}`);
        } else if (data.message?.result) {
          console.log(`Response: ID: ${data.id}, Has Result: ${!!data.message.result}`);
        }
        console.log(`Full message:`, JSON.stringify(data, null, 2));

        // Keepalive from a client — answer so it knows the relay is alive and
        // the socket stays warm. No channel routing needed.
        if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }

        // Plugin pushes refreshed file context (page switch / rename) without
        // rejoining. Update the recorded channel meta and persist.
        if (data.type === "meta") {
          const entry = pluginChannels.get(ws);
          if (entry) {
            entry.meta = data.meta;
            writeActiveChannels();
          }
          return;
        }

        if (data.type === "join") {
          const channelName = data.channel;
          if (!channelName || typeof channelName !== "string") {
            ws.send(JSON.stringify({
              type: "error",
              message: "Channel name is required"
            }));
            return;
          }

          // Create channel if it doesn't exist
          if (!channels.has(channelName)) {
            channels.set(channelName, new Set());
          }

          // Add client to channel
          const channelClients = channels.get(channelName)!;
          channelClients.add(ws);

          console.log(`\n✓ Client joined channel "${channelName}" (${channelClients.size} total clients)`);

          // Record plugin-opened channels so the agent can auto-discover them.
          if (data.role === "plugin") {
            pluginChannels.set(ws, { channel: channelName, meta: data.meta });
            writeActiveChannels();
          }

          // Notify client they joined successfully
          ws.send(JSON.stringify({
            type: "system",
            message: `Joined channel: ${channelName}`,
            channel: channelName
          }));

          ws.send(JSON.stringify({
            type: "system",
            message: {
              id: data.id,
              result: "Connected to channel: " + channelName,
            },
            channel: channelName
          }));

          // Notify other clients in channel
          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: "system",
                message: "A new user has joined the channel",
                channel: channelName
              }));
            }
          });
          return;
        }

        // Handle regular messages
        if (data.type === "message") {
          const channelName = data.channel;
          if (!channelName || typeof channelName !== "string") {
            ws.send(JSON.stringify({
              type: "error",
              message: "Channel name is required"
            }));
            return;
          }

          const channelClients = channels.get(channelName);
          if (!channelClients || !channelClients.has(ws)) {
            ws.send(JSON.stringify({
              type: "error",
              message: "You must join the channel first"
            }));
            return;
          }

          // Broadcast to all OTHER clients in the channel (not the sender)
          // This prevents echo and ensures proper request-response flow
          let broadcastCount = 0;
          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              broadcastCount++;
              const broadcastMessage = {
                type: "broadcast",
                message: data.message,
                sender: "peer",
                channel: channelName
              };
              console.log(`\n=== Broadcasting to peer #${broadcastCount} ===`);
              console.log(JSON.stringify(broadcastMessage, null, 2));
              client.send(JSON.stringify(broadcastMessage));
            }
          });
          
          if (broadcastCount === 0) {
            console.log(`⚠️  No other clients in channel "${channelName}" to receive message!`);
            // Fail fast: tell the sender now instead of letting it wait the
            // full request timeout. Carry the request id so the MCP server can
            // reject the matching pending request.
            ws.send(JSON.stringify({
              type: "error",
              id: data.message?.id,
              message: {
                id: data.message?.id,
                error: `No client is connected to channel "${channelName}" to handle the command. Is the Figma plugin still connected?`,
              },
              channel: channelName,
            }));
          } else {
            console.log(`✓ Broadcast to ${broadcastCount} peer(s) in channel "${channelName}"`);
          }
        }

        // Forward progress_update messages to the MCP server so it can reset
        if (data.type === "progress_update") {
          const channelName = data.channel;
          if (!channelName) return;

          const channelClients = channels.get(channelName);
          if (!channelClients || !channelClients.has(ws)) return;

          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(data));
            }
          });
        }
      } catch (err) {
        console.error("Error handling message:", err);
      }
    },
    close(ws: ServerWebSocket<any>) {
      // Remove client from their channel
      channels.forEach((clients) => {
        clients.delete(ws);
      });

      // Drop the plugin's channel so stale entries don't linger in the file.
      if (pluginChannels.delete(ws)) {
        writeActiveChannels();
      }
    }
  }
});
  } catch (err: any) {
    // EADDRINUSE → someone else already hosts the relay on this port. Not an
    // error for the embedded case; the caller falls back to client-only.
    if (err?.code === "EADDRINUSE" || /in use|EADDRINUSE/i.test(String(err?.message))) {
      return null;
    }
    throw err;
  }

  console.log(`WebSocket server running on port ${server.port}`);
  return server;
}
