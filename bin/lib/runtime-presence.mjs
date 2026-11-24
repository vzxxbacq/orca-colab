import { randomUUID } from "node:crypto";
import os from "node:os";
import { COLAB_HEADERS, COLAB_PROXY_TOKEN_HEADER } from "./colab-api-client.mjs";
import { SessionGoneError, createRuntimeChannel } from "./runtime-channel.mjs";
import { listSessions, readSession, writeSession } from "./session-store.mjs";
import { isProcessAlive } from "./task-store.mjs";

// Colab takes back runtimes it considers unattended: G4 runtimes used only through terminals, the
// contents API and /files were gone 21 to 38 minutes after they started, busy or not, and Colab's own
// VS Code client treats a kernel with a connected client as the sign of use
// (docs/colab-internal-endpoints.md § 6). So while a runtime is in use, the machine using it holds the
// connection a notebook front end holds: a websocket on the channels of a kernel, kept for that purpose
// and shared by every machine (the Jupyter session with this path); nothing is ever executed on it.
export const PRESENCE_SESSION_PATH = "orca-colab-presence";
export const PRESENCE_FRESH_MS = 150_000;
const STAMP_EVERY_MS = 60_000;
// Colab's VS Code client counted a kernel as in use for an hour after its last message; this keeps
// the kernel's last activity recent without running anything.
const NUDGE_EVERY_MS = 4 * 60_000;
const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

function stampPresence(sessionName, homeDir, nowMs) {
  const current = readSession(sessionName, homeDir);
  if (current) {
    writeSession({ ...current, lastPresenceAt: new Date(nowMs).toISOString() }, homeDir);
  }
}

export function presenceOf(session, nowMs = Date.now()) {
  const lastMs = Date.parse(session?.lastPresenceAt || "");
  return {
    connected: Number.isFinite(lastMs) && nowMs - lastMs < PRESENCE_FRESH_MS,
    lastAt: Number.isFinite(lastMs) ? session.lastPresenceAt : null,
  };
}

// Stays connected to the runtime until `close()`: reconnects when the connection drops, refreshes the
// proxy token when it is refused, and gives up only when Colab no longer has the runtime.
export function holdRuntimePresence({
  sessionName,
  homeDir = os.homedir(),
  fetchImpl = fetch,
  WebSocketImpl = globalThis.WebSocket,
  nowMs = () => Date.now(),
  onState = () => {},
  retryMs = RETRY_MS,
} = {}) {
  const channel = createRuntimeChannel({ sessionName, homeDir, fetchImpl });
  const clientId = randomUUID();
  const state = { connected: false, gone: false, error: null };
  let closed = false;
  let attempt = 0;
  let ws = null;
  let kernel = null;
  let retryTimer = null;
  let beatTimer = null;
  let lastNudgeMs = 0;

  const report = (patch) => {
    Object.assign(state, patch);
    onState({ ...state });
  };

  const json = (init = {}) => ({ timeoutMs: 20_000, ...init, headers: { "Content-Type": "application/json", ...init.headers } });

  function retryLater() {
    if (closed || state.gone) return;
    const wait = retryMs[Math.min(attempt, retryMs.length - 1)];
    attempt += 1;
    retryTimer = setTimeout(() => void connect({ refresh: true }), wait);
    retryTimer.unref?.();
  }

  function beat() {
    if (closed || !state.connected) return;
    try {
      stampPresence(sessionName, homeDir, nowMs());
    } catch {
      // The session file is being replaced; the next beat writes it.
    }
    if (nowMs() - lastNudgeMs >= NUDGE_EVERY_MS) {
      lastNudgeMs = nowMs();
      try {
        ws.send(
          JSON.stringify({
            header: { msg_id: randomUUID(), username: "orca-colab", session: clientId, msg_type: "kernel_info_request", version: "5.3", date: new Date(nowMs()).toISOString() },
            parent_header: {},
            metadata: {},
            content: {},
            channel: "shell",
          }),
        );
      } catch {
        // The close event that follows reconnects.
      }
    }
  }

  async function connect({ refresh = false } = {}) {
    if (closed) return;
    try {
      // The proxy answers an expired token with 404, like a missing page; only a refresh tells them apart.
      if (refresh) await channel.refreshToken();
      const base = String(channel.baseUrl()).replace(/\/+$/, "");
      // Jupyter answers with the existing session when one has this path, so every machine shares it.
      const res = await channel.fetch(
        `${base}/api/sessions`,
        json({ method: "POST", body: JSON.stringify({ path: PRESENCE_SESSION_PATH, name: "orca-colab", type: "console", kernel: { name: "python3" } }) }),
      );
      const body = res.ok ? await res.json() : await res.arrayBuffer().then(() => null);
      if (!body?.kernel?.id || !body.id) {
        throw new Error(`the runtime refused a kernel for the keep-alive connection (HTTP ${res.status})`);
      }
      if (closed) return;
      kernel = { id: body.kernel.id, sessionId: body.id };
      const url = new URL(`${base}/api/kernels/${encodeURIComponent(kernel.id)}/channels`);
      url.searchParams.set("session_id", clientId);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocketImpl(url.toString(), {
        headers: { ...COLAB_HEADERS, [COLAB_PROXY_TOKEN_HEADER]: channel.session().colabRuntime.token },
      });
      ws = socket;
      let ended = false;
      const end = (error) => {
        if (ended) return;
        ended = true;
        clearInterval(beatTimer);
        if (ws === socket) ws = null;
        if (closed) return;
        report({ connected: false, error });
        retryLater();
      };
      socket.addEventListener("open", () => {
        if (closed) {
          socket.close();
          return;
        }
        attempt = 0;
        lastNudgeMs = nowMs();
        report({ connected: true, error: null });
        beat();
        beatTimer = setInterval(beat, STAMP_EVERY_MS);
        beatTimer.unref?.();
      });
      socket.addEventListener("message", () => {});
      socket.addEventListener("error", (event) => end(event?.message || event?.error?.message || "the keep-alive connection failed"));
      socket.addEventListener("close", () => end("the keep-alive connection was closed"));
    } catch (err) {
      if (err instanceof SessionGoneError) {
        report({ connected: false, gone: true, error: err.message });
        return;
      }
      report({ connected: false, error: err?.message || String(err) });
      retryLater();
    }
  }

  void connect();

  return {
    state: () => ({ ...state }),
    // Leaves the kernel to the machines still connected to it and removes it with the last one, so a
    // runtime nobody uses looks to Colab exactly as it did before.
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      clearInterval(beatTimer);
      const wasConnected = state.connected;
      try {
        ws?.close();
      } catch {
        // Already closed.
      }
      if (!kernel || !wasConnected) return;
      try {
        const base = String(channel.baseUrl()).replace(/\/+$/, "");
        for (let i = 0; i < 3; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          const res = await channel.fetch(`${base}/api/kernels/${encodeURIComponent(kernel.id)}`, { timeoutMs: 4_000 });
          const info = res.ok ? await res.json() : await res.arrayBuffer().then(() => null);
          if (!info) return;
          if (info.connections === 0) {
            const gone = await channel.fetch(`${base}/api/sessions/${encodeURIComponent(kernel.sessionId)}`, { method: "DELETE", timeoutMs: 4_000 });
            await gone.arrayBuffer().catch(() => {});
            return;
          }
        }
      } catch {
        // The runtime is gone or unreachable; there is nothing left to tidy up.
      }
    },
  };
}

// Whether this machine should stay connected to a runtime: while it is kept, has work of this machine
// going (a live command, a job it knows to be running) or was used in the last `activeWithinMinutes`.
// After that the runtime is left to the idle auto-stop and to Colab.
export function sessionNeedsPresence({
  session,
  runningTasksCount = 0,
  gpuBusy = false,
  activeWithinMinutes = 20,
  nowMs = Date.now(),
  checkPid = isProcessAlive,
} = {}) {
  if (!session || session.state === "zombie" || !session.colabRuntime?.baseUrl || !session.colabRuntime?.token) {
    return false;
  }
  // No record of ours: it may be a notebook the owner has open in Colab, which keeps itself alive.
  if (session.adopted && !session.origin) {
    return false;
  }
  if (session.keep || runningTasksCount > 0 || gpuBusy) {
    return true;
  }
  if ((session.activePids || []).some((pid) => checkPid(pid))) {
    return true;
  }
  const lastMs = Date.parse(session.lastActivityAt || session.createdAt);
  return Number.isFinite(lastMs) && nowMs - lastMs < activeWithinMinutes * 60_000;
}

// For a process that outlives single commands (the plugin's worker, the MCP server): holds one
// connection per runtime that needs it and lets go of the others.
export class RuntimePresenceKeeper {
  constructor({ homeDir = os.homedir(), fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, hold = holdRuntimePresence } = {}) {
    this.homeDir = homeDir;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.hold = hold;
    this.held = new Map();
  }

  // `needs(session)` decides; the caller knows the jobs and the GPU load. A holder whose runtime Colab
  // took back stays in place, doing nothing, until the session is dropped or its name gets a new runtime.
  reconcile(needs, sessions = listSessions(this.homeDir)) {
    const wanted = new Map(sessions.filter((s) => needs(s)).map((s) => [`${s.name}\n${s.colabRuntime?.id || ""}`, s.name]));
    for (const [key, holder] of this.held) {
      if (!wanted.has(key)) {
        this.held.delete(key);
        void holder.close();
      }
    }
    for (const [key, name] of wanted) {
      if (!this.held.has(key)) {
        this.held.set(key, this.hold({ sessionName: name, homeDir: this.homeDir, fetchImpl: this.fetchImpl, WebSocketImpl: this.WebSocketImpl }));
      }
    }
    return [...wanted.values()];
  }

  async stop() {
    const holders = [...this.held.values()];
    this.held.clear();
    await Promise.all(holders.map((holder) => holder.close()));
  }
}
