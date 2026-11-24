import { COLAB_HEADERS, COLAB_PROXY_TOKEN_HEADER } from "./colab-api-client.mjs";

// An interactive shell on the runtime without any local terminal: one Jupyter terminal of its own
// (`POST /api/terminals`, then its websocket), the same kind every command gets. Output arrives through
// `onData`; `close` deletes the terminal, which hangs up the shell.
export async function openRuntimeShell({
  baseUrl,
  proxyToken,
  onData,
  onClose = () => {},
  cols = 100,
  rows = 30,
  fetchImpl = fetch,
  WebSocketImpl = globalThis.WebSocket,
}) {
  const headers = { ...COLAB_HEADERS, [COLAB_PROXY_TOKEN_HEADER]: proxyToken };
  const created = await fetchImpl(new URL("/api/terminals", baseUrl).toString(), {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  const name = created.ok ? (await created.json())?.name : null;
  if (typeof name !== "string" || !/^[\w.-]+$/.test(name)) {
    throw new Error(`the runtime refused a terminal (${created.status})`);
  }
  const wsUrl = new URL(`/terminals/websocket/${name}`, baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocketImpl(wsUrl.toString(), { headers });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      ws.close();
    } catch {
      // Already closed.
    }
    try {
      await fetchImpl(new URL(`/api/terminals/${name}`, baseUrl).toString(), {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // The runtime may be gone.
    }
    onClose();
  };

  const send = (frame) => {
    if (!closed && ws.readyState === 1) {
      ws.send(JSON.stringify(frame));
    }
  };

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      send(["set_size", rows, cols]);
      // A fresh Jupyter terminal starts in /; work lives under /content.
      send(["stdin", "cd /content 2>/dev/null; clear\n"]);
      resolve();
    });
    ws.addEventListener("error", (event) => reject(new Error(`shell connection failed: ${event?.message || "websocket error"}`)));
  });
  ws.addEventListener("message", (event) => {
    try {
      const frame = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
      if (Array.isArray(frame) && frame[0] === "stdout" && typeof frame[1] === "string") {
        onData(frame[1]);
      }
    } catch {
      // Not a terminado frame.
    }
  });
  ws.addEventListener("close", () => void close());

  return {
    name,
    write: (text) => send(["stdin", String(text)]),
    resize: (nextCols, nextRows) => send(["set_size", nextRows, nextCols]),
    close,
  };
}
