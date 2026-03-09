// Bun-native MCP server over stdio.
// Implements JSON-RPC 2.0 for the Model Context Protocol.
// Zero dependencies — just Bun built-ins.

import { memoryTools } from "./tools/memory.mjs";
import { gatewayTools } from "./tools/gateway.mjs";

const SERVER_INFO = {
  name: "familiar",
  version: "0.1.0",
};

const PROTOCOL_VERSION = "2024-11-05";

// Collect all tools from modules
const allTools = [...memoryTools, ...gatewayTools];
const toolMap = new Map(allTools.map((t) => [t.name, t]));

function log(...args) {
  process.stderr.write(`[familiar-mcp] ${args.join(" ")}\n`);
}

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function sendError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(msg + "\n");
}

function sendNotification(method, params) {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
  process.stdout.write(msg + "\n");
}

async function handleRequest(req) {
  const { id, method, params } = req;

  switch (method) {
    case "initialize":
      sendResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: SERVER_INFO,
      });
      break;

    case "notifications/initialized":
      // Client ack — nothing to do
      break;

    case "ping":
      sendResponse(id, {});
      break;

    case "tools/list":
      sendResponse(id, {
        tools: allTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
      break;

    case "tools/call": {
      const toolName = params?.name;
      const args = params?.arguments || {};

      const tool = toolMap.get(toolName);
      if (!tool) {
        sendResponse(id, {
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
          isError: true,
        });
        break;
      }

      try {
        const result = await tool.handler(args);
        sendResponse(id, result);
      } catch (err) {
        sendResponse(id, {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        });
      }
      break;
    }

    default:
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
      break;
  }
}

// Read stdin line-by-line
async function main() {
  log(`Starting (${allTools.length} tools registered)`);

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });

    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const req = JSON.parse(line);
        await handleRequest(req);
      } catch (err) {
        log(`Parse error: ${err.message}`);
        sendError(null, -32700, "Parse error");
      }
    }
  }
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
