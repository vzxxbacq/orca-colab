import { spawn } from "node:child_process";
import { locateOrcaBinary } from "./colab-browser-automation.mjs";

// The plugin host API on a desktop client cannot see workspaces that live on a remote Orca server, but
// the local `orca` CLI can: it resolves the focused worktree and manages its terminals through the same
// client↔server connection. This helper wraps the few CLI calls the bridge needs.
export function buildOrcaArgs(command, options = {}) {
  const args = [...command];
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === false) continue;
    const flag = `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    if (value === true) {
      args.push(flag);
    } else {
      args.push(flag, String(value));
    }
  }
  args.push("--json");
  return args;
}

export function parseOrcaJson(stdout) {
  const text = String(stdout || "");
  const start = text.indexOf("{");
  if (start === -1) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(start));
    if (parsed && typeof parsed === "object" && "ok" in parsed) {
      return parsed.ok ? (parsed.result ?? {}) : null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function createOrcaRemoteHelper({
  env = process.env,
  orcaBin = locateOrcaBinary(env),
  spawnProcess = spawn,
  timeoutMs = 15_000,
} = {}) {
  const available = Boolean(orcaBin);

  const run = (command, options = {}) =>
    new Promise((resolve) => {
      if (!orcaBin) {
        resolve({ ok: false, error: "orca CLI not found on this machine", data: null });
        return;
      }
      const args = buildOrcaArgs(command, options);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const child = spawnProcess(orcaBin, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
          resolve({ ok: false, error: `orca ${command.join(" ")} timed out`, data: null });
        }
      }, timeoutMs);
      child.stdout?.on("data", (d) => (stdout += d));
      child.stderr?.on("data", (d) => (stderr += d));
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, error: err?.message || String(err), data: null });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const data = parseOrcaJson(stdout);
        if (code === 0 && data) {
          resolve({ ok: true, error: null, data });
        } else {
          const msg = stderr.trim() || stdout.trim() || `exit ${code}`;
          resolve({ ok: false, error: msg.split("\n")[0].slice(0, 300), data: null });
        }
      });
    });

  return {
    available,
    orcaBin,

    async activeWorktree() {
      const res = await run(["worktree", "show"], { worktree: "active" });
      if (!res.ok) return res;
      const wt = res.data?.worktree || res.data;
      return {
        ok: true,
        error: null,
        data: {
          id: wt?.id || null,
          identity: wt?.identity?.key || null,
          hostId: wt?.hostId || wt?.identity?.executionHostId || null,
          displayName: wt?.displayName || null,
          path: wt?.path || null,
          branch: wt?.branch || null,
        },
      };
    },

    async listTerminals(selector) {
      const res = await run(["terminal", "list"], { worktree: selector, limit: 50 });
      if (!res.ok) return res;
      const rows = Array.isArray(res.data?.terminals) ? res.data.terminals : [];
      return {
        ok: true,
        error: null,
        data: rows.map((t) => ({
          handle: t.handle,
          title: t.title || "",
          preview: t.preview || "",
          connected: t.connected !== false,
        })),
      };
    },

    async createTerminal({ selector, title, command }) {
      const res = await run(["terminal", "create"], { worktree: selector, title, command });
      if (!res.ok) return res;
      const handle = res.data?.terminal?.handle || res.data?.handle || null;
      return handle
        ? { ok: true, error: null, data: { handle } }
        : { ok: false, error: "orca terminal create returned no handle", data: null };
    },

    // Accumulated output since `cursor` (not the rendered screen), so frames that scrolled off are
    // still delivered; the caller keeps `nextCursor` for the following read.
    async readTerminal(handle, { cursor = undefined, limit = 2000 } = {}) {
      const res = await run(["terminal", "read"], { terminal: handle, cursor, limit });
      if (!res.ok) return res;
      const d = res.data?.terminal || res.data;
      const lines = Array.isArray(d?.tail) ? d.tail : Array.isArray(d?.lines) ? d.lines : [];
      return {
        ok: true,
        error: null,
        data: { lines, nextCursor: d?.nextCursor ?? null, status: d?.status ?? null },
      };
    },

    async sendTerminal(handle, text) {
      return run(["terminal", "send"], { terminal: handle, text, enter: true });
    },
  };
}
