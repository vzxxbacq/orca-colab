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
  return parseOrcaEnvelope(stdout).data;
}

// The CLI answers `{ ok, result }` or `{ ok: false, error }`; the error may be a string or an object.
export function parseOrcaEnvelope(stdout) {
  const text = String(stdout || "");
  const start = text.indexOf("{");
  if (start === -1) {
    return { data: null, error: text.trim().split("\n")[0] || null };
  }
  try {
    const parsed = JSON.parse(text.slice(start));
    if (parsed && typeof parsed === "object" && "ok" in parsed) {
      if (parsed.ok) {
        return { data: parsed.result ?? {}, error: null };
      }
      const err = parsed.error;
      const message =
        typeof err === "string"
          ? err
          : err?.message || err?.code || (err ? JSON.stringify(err) : "orca CLI reported a failure");
      return { data: null, error: message };
    }
    return { data: parsed, error: null };
  } catch {
    return { data: null, error: text.trim().split("\n")[0] || "unparsable orca CLI output" };
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
        const envelope = parseOrcaEnvelope(stdout);
        if (code === 0 && envelope.data) {
          resolve({ ok: true, error: null, data: envelope.data });
        } else {
          const msg = envelope.error || stderr.trim().split("\n")[0] || `exit ${code}`;
          resolve({ ok: false, error: `orca ${command.join(" ")}: ${msg}`.slice(0, 300), data: null });
        }
      });
    });

  const envOpt = (environment) => (environment ? { environment } : {});

  return {
    available,
    orcaBin,

    // Saved paired servers; the worktree the client shows may live on one of them.
    async listEnvironments() {
      const res = await run(["environment", "list"]);
      if (!res.ok) return res;
      const rows = Array.isArray(res.data?.environments)
        ? res.data.environments
        : Object.values(res.data || {}).find(Array.isArray) || [];
      return {
        ok: true,
        error: null,
        data: rows
          .map((e) => ({ id: e.id || e.environmentId || null, name: e.name || e.label || null }))
          .filter((e) => e.id || e.name),
      };
    },

    async showWorktree(selector, { environment = null } = {}) {
      const res = await run(["worktree", "show"], { worktree: selector, ...envOpt(environment) });
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

    async activeWorktree() {
      return this.showWorktree("active");
    },

    async listTerminals(selector, { environment = null } = {}) {
      const res = await run(["terminal", "list"], { worktree: selector, limit: 50, ...envOpt(environment) });
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

    async createTerminal({ selector, title, command, environment = null }) {
      const res = await run(["terminal", "create"], { worktree: selector, title, command, ...envOpt(environment) });
      if (!res.ok) return res;
      const handle = res.data?.terminal?.handle || res.data?.handle || null;
      return handle
        ? { ok: true, error: null, data: { handle } }
        : { ok: false, error: "orca terminal create returned no handle", data: null };
    },

    // Accumulated output since `cursor` (not the rendered screen), so frames that scrolled off are
    // still delivered; the caller keeps `nextCursor` for the following read.
    async readTerminal(handle, { cursor = undefined, limit = 2000, environment = null } = {}) {
      const res = await run(["terminal", "read"], { terminal: handle, cursor, limit, ...envOpt(environment) });
      if (!res.ok) return res;
      const d = res.data?.terminal || res.data;
      const lines = Array.isArray(d?.tail) ? d.tail : Array.isArray(d?.lines) ? d.lines : [];
      return {
        ok: true,
        error: null,
        data: { lines, nextCursor: d?.nextCursor ?? null, status: d?.status ?? null },
      };
    },

    async sendTerminal(handle, text, { environment = null } = {}) {
      return run(["terminal", "send"], { terminal: handle, text, enter: true, ...envOpt(environment) });
    },
  };
}
