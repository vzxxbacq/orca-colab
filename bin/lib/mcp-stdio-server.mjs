import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// Model Context Protocol over stdio: one JSON-RPC 2.0 message per line. Tools only; no SDK, because the
// CLI installs through `npx` and must stay dependency-free.
export function serveMcpOverStdio({
  input,
  write,
  serverInfo,
  instructions,
  tools,
  callTool,
  onClientInfo = null,
  clientRequestTimeoutMs = 5000,
}) {
  const inFlight = new Map();
  const awaitingClient = new Map();
  let nextClientRequestId = 1;
  let clientCapabilities = {};
  let cachedRoots = null;

  const send = (message) => write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const reply = (id, result) => send({ id, result });
  const fail = (id, code, message) => send({ id, error: { code, message } });

  function requestClient(method, params) {
    const id = `orca-colab-${nextClientRequestId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        awaitingClient.delete(id);
        reject(new Error(`client did not answer ${method}`));
      }, clientRequestTimeoutMs);
      awaitingClient.set(id, { resolve, reject, timer });
      send({ id, method, ...(params ? { params } : {}) });
    });
  }

  // Workspace folders the client exposes (MCP roots), as local paths; empty when it has none.
  async function listRoots() {
    if (!clientCapabilities?.roots) {
      return [];
    }
    if (!cachedRoots) {
      try {
        const result = await requestClient("roots/list");
        cachedRoots = (Array.isArray(result?.roots) ? result.roots : []).flatMap((root) => {
          try {
            return String(root?.uri).startsWith("file:") ? [fileURLToPath(root.uri)] : [];
          } catch {
            return [];
          }
        });
      } catch {
        return [];
      }
    }
    return cachedRoots;
  }

  async function handleToolCall(id, params) {
    const name = params?.name;
    if (!tools.some((tool) => tool.name === name)) {
      fail(id, INVALID_PARAMS, `Unknown tool: ${name}`);
      return;
    }
    const controller = new AbortController();
    inFlight.set(id, controller);
    const progressToken = params?._meta?.progressToken;
    let progress = 0;
    try {
      const result = await callTool(name, params?.arguments ?? {}, {
        signal: controller.signal,
        listRoots,
        onProgress: (message) => {
          if (progressToken !== undefined && inFlight.has(id)) {
            progress += 1;
            send({ method: "notifications/progress", params: { progressToken, progress, message } });
          }
        },
      });
      if (!controller.signal.aborted) {
        reply(id, result);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        fail(id, INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
      }
    } finally {
      inFlight.delete(id);
    }
  }

  function handleRequest({ id, method, params }) {
    if (method === "initialize") {
      clientCapabilities = params?.capabilities ?? {};
      onClientInfo?.(params?.clientInfo ?? null);
      const requested = params?.protocolVersion;
      reply(id, {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        instructions,
      });
    } else if (method === "ping") {
      reply(id, {});
    } else if (method === "tools/list") {
      reply(id, {
        tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({
          name,
          title,
          description,
          inputSchema,
          ...(annotations ? { annotations } : {}),
        })),
      });
    } else if (method === "tools/call") {
      void handleToolCall(id, params);
    } else {
      fail(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  function handleNotification({ method, params }) {
    if (method === "notifications/cancelled") {
      inFlight.get(params?.requestId)?.abort();
    } else if (method === "notifications/roots/list_changed") {
      cachedRoots = null;
    }
  }

  function handleLine(line) {
    if (!line.trim()) {
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(null, PARSE_ERROR, "Parse error");
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
      fail(message?.id ?? null, INVALID_REQUEST, "Invalid Request");
      return;
    }
    if (typeof message.method === "string") {
      if (message.id === undefined || message.id === null) {
        handleNotification(message);
      } else {
        handleRequest(message);
      }
      return;
    }
    const waiting = awaitingClient.get(message.id);
    if (waiting) {
      awaitingClient.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) {
        waiting.reject(new Error(message.error.message || "client error"));
      } else {
        waiting.resolve(message.result);
      }
    }
  }

  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on("line", handleLine);
  const closed = new Promise((resolve) => {
    lines.once("close", () => {
      for (const controller of inFlight.values()) {
        controller.abort();
      }
      for (const waiting of awaitingClient.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error("client disconnected"));
      }
      awaitingClient.clear();
      resolve();
    });
  });

  return { closed };
}
