import WebSocket from "ws";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";

export class GatewayClient extends EventEmitter {
  constructor({ port = 18789, token, host = "localhost" }) {
    super();
    this.port = port;
    this.token = token;
    this.host = host;
    this.ws = null;
    this.reqId = 0;
    this.pending = new Map();       // id -> { resolve, reject, timer }
    this.connected = false;
    this.sessionKey = null;
    this._reconnectTimer = null;
    this._intentionalClose = false;
    this._reconnectAttempt = 0;
    this._maxReconnectDelay = 30000;
    this._autoReconnect = true;
  }

  nextId() { return String(++this.reqId); }

  connect() {
    this._intentionalClose = false;
    this.reqId = 0; // Reset so connect handshake uses id "1"
    return new Promise((resolve, reject) => {
      const url = `ws://${this.host}:${this.port}`;
      this.ws = new WebSocket(url, {
        headers: { Origin: `http://${this.host}:${this.port}` },
      });

      const connectTimeout = setTimeout(() => {
        reject(new Error("Gateway connection timed out"));
        this.ws.terminate();
      }, 15000);

      this.ws.on("open", () => {
        // Wait for connect.challenge
      });

      this.ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        this._handleMessage(msg, resolve, reject, connectTimeout);
      });

      this.ws.on("error", (err) => {
        clearTimeout(connectTimeout);
        if (!this.connected) {
          reject(err);
        } else {
          this.emit("error", err);
        }
      });

      this.ws.on("close", () => {
        const wasConnected = this.connected;
        this.connected = false;
        if (wasConnected && !this._intentionalClose) {
          this.emit("disconnected");
          this._scheduleReconnect();
        }
      });
    });
  }

  _scheduleReconnect() {
    if (!this._autoReconnect || this._intentionalClose) return;
    if (this._reconnectTimer) return; // already scheduled

    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempt), this._maxReconnectDelay);
    this._reconnectAttempt++;
    this.emit("reconnecting", { attempt: this._reconnectAttempt, delay });

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this.connect();
        this._reconnectAttempt = 0;
        this.emit("reconnected");
      } catch {
        // connect() failed — schedule another attempt
        this._scheduleReconnect();
      }
    }, delay);
  }

  _handleMessage(msg, connectResolve, connectReject, connectTimeout) {
    // Phase 1: connection handshake
    if (msg.type === "event" && msg.event === "connect.challenge") {
      const id = this.nextId();
      this._send({
        type: "req", id, method: "connect",
        params: {
          minProtocol: 3, maxProtocol: 3,
          client: { id: "familiar-ui", version: "1.0.0", platform: "node", mode: "ui" },
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write", "operator.pairing", "chat"],
          auth: { token: this.token },
        },
      });
      return;
    }

    // Connect response (always id=1)
    if (msg.type === "res" && msg.id === "1") {
      clearTimeout(connectTimeout);
      if (!msg.ok) {
        connectReject(new Error(`Gateway auth failed: ${JSON.stringify(msg.error || msg)}`));
        return;
      }
      this.connected = true;
      connectResolve();
      return;
    }

    // Pending request responses
    if (msg.type === "res" && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.ok) resolve(msg.payload);
      else reject(new Error(JSON.stringify(msg.error || msg)));
      return;
    }

    // Agent streaming events
    if (msg.type === "event" && msg.event === "agent") {
      this.emit("agent", msg.payload);
      return;
    }

    // Chat state events
    if (msg.type === "event" && msg.event === "chat") {
      this.emit("chat", msg.payload);
      return;
    }

    // Skip noise
    if (msg.type === "event" && (msg.event === "tick" || msg.event === "health" || msg.event === "presence")) {
      return;
    }

    this.emit("raw", msg);
  }

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  request(method, params, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._send({ type: "req", id, method, params });
    });
  }

  async chat(sessionKey, message) {
    const payload = await this.request("chat.send", {
      sessionKey,
      message,
      idempotencyKey: randomUUID(),
    });
    return payload;
  }

  // ── Session Management ──

  async sessionCreate({ title, workingDir } = {}) {
    return this.request("session.create", { title, workingDir });
  }

  async sessionList({ includeArchived, limit } = {}) {
    const result = await this.request("session.list", { includeArchived, limit });
    return result.sessions || [];
  }

  async sessionGet(sessionId) {
    return this.request("session.get", { sessionId });
  }

  async sessionRename(sessionId, title) {
    return this.request("session.rename", { sessionId, title });
  }

  async sessionArchive(sessionId, archived = true) {
    return this.request("session.archive", { sessionId, archived });
  }

  async sessionFork(sessionId, { title, upToMessageId } = {}) {
    return this.request("session.fork", { sessionId, title, upToMessageId });
  }

  async sessionMessages(sessionId, { limit, offset } = {}) {
    const result = await this.request("session.messages", { sessionId, limit, offset });
    return result.messages || [];
  }

  async sessionAddMessage(sessionId, { role, text, metadata } = {}) {
    return this.request("session.addMessage", { sessionId, role, text, metadata });
  }

  disconnect() {
    this._intentionalClose = true;
    this._autoReconnect = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    for (const [id, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(new Error("Disconnected"));
    }
    this.pending.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

export function loadConfig(configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  return {
    port: config.gateway?.port ?? 18789,
    token: config.gateway?.auth?.token,
  };
}
