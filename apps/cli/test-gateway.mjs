import WebSocket from "ws";
import { readFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(__dirname, "..", "config", "familiar.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const GW_PORT = config.gateway?.port ?? 18789;
const GW_TOKEN = config.gateway?.auth?.token;
let reqId = 0;
const nextId = () => String(++reqId);

const ws = new WebSocket(`ws://localhost:${GW_PORT}`, {
  headers: { Origin: `http://localhost:${GW_PORT}` },
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === "event" && msg.event === "connect.challenge") {
    ws.send(JSON.stringify({
      type: "req", id: nextId(), method: "connect",
      params: {
        minProtocol: 3, maxProtocol: 3,
        client: { id: "familiar-ui", version: "1.0.0", platform: "node", mode: "ui" },
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write", "operator.pairing", "chat"],
        auth: { token: GW_TOKEN },
      },
    }));
    return;
  }

  if (msg.type === "res" && reqId === 1) {
    if (!msg.ok) {
      console.log("CONNECT FAIL:", JSON.stringify(msg));
      ws.close();
      return;
    }
    console.log("CONNECTED — sending test message");
    ws.send(JSON.stringify({
      type: "req", id: nextId(), method: "chat.send",
      params: {
        sessionKey: `familiar:test:${Date.now()}`,
        message: "Say hello in 5 words.",
        idempotencyKey: randomUUID(),
      },
    }));
    return;
  }

  // Agent lifecycle / streaming events
  if (msg.type === "event" && msg.event === "agent") {
    const p = msg.payload;
    console.log(`AGENT RAW: ${JSON.stringify(p).slice(0, 500)}`);
    return;
  }

  // Chat state
  if (msg.type === "event" && msg.event === "chat") {
    console.log(`CHAT RAW: ${JSON.stringify(msg.payload).slice(0, 500)}`);
    // Only exit on OUR session
    if ((msg.payload?.state === "final" || msg.payload?.state === "error") &&
        msg.payload?.sessionKey?.includes("cli-test")) {
      setTimeout(() => { ws.close(); process.exit(0); }, 500);
    }
    return;
  }

  // Responses
  if (msg.type === "res") {
    console.log(`RES id=${msg.id} ok=${msg.ok} payload=${JSON.stringify(msg.payload || {}).slice(0, 200)}`);
    return;
  }

  // Skip tick/health
  if (msg.type === "event" && (msg.event === "tick" || msg.event === "health" || msg.event === "presence")) return;

  console.log("OTHER:", JSON.stringify(msg).slice(0, 500));
});

ws.on("error", (e) => console.log("WS ERROR:", e.message));
setTimeout(() => { console.log("TIMEOUT"); ws.close(); process.exit(0); }, 180000);
