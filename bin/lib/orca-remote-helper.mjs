import { spawn } from "node:child_process";
import { locateOrcaBinary } from "./orca-binary.mjs";

// The plugin host API names the focused workspace but not where it lives; the local `orca` CLI lists
// this machine's terminals, which tells a local checkout from a workspace on a remote Orca server.
// This helper wraps that one call.
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
  timeoutMs = 40_000,
} = {}) {
  const available = Boolean(orcaBin);

  // One orca process at a time per lane, so a slow call cannot pile up behind itself.
  const lanes = { send: Promise.resolve(), read: Promise.resolve() };
  const timings = [];
  const run = (command, options = {}, lane = "read") => {
    const startedAt = Date.now();
    const next = lanes[lane].then(() => runNow(command, options));
    lanes[lane] = next.catch(() => {});
    return next.then((res) => {
      timings.push({ command: command.join(" "), ms: Date.now() - startedAt, ok: res.ok, lane });
      if (timings.length > 30) timings.shift();
      return res;
    });
  };

  const runNow = (command, options = {}) =>
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

  return {
    available,
    orcaBin,
    recentTimings: () => timings.slice(),

    // Saved paired servers; a project the client shows may live on one of them.
    async listEnvironments() {
      const res = await run(["environment", "list"]);
      if (!res.ok) return res;
      const rows = Array.isArray(res.data?.environments) ? res.data.environments : [];
      return {
        ok: true,
        error: null,
        data: rows
          .map((e) => ({ id: e.id || e.environmentId || null, name: e.name || e.label || null }))
          .filter((e) => e.id || e.name),
      };
    },

    // Opens a file of a workspace on a paired server in Orca's own editor, where the user edits and
    // saves it over Orca's connection. Which server holds the workspace is not known to a plugin, so
    // each saved one is asked with each selector until one opens it; every refusal is kept for the
    // panel (a headless server answers renderer_unavailable and cannot open tabs at all).
    async openFileOnServer({ file, selectors }) {
      const envs = await this.listEnvironments();
      const attempts = [];
      if (!envs.ok) {
        return { ok: false, attempts: [{ environment: null, selector: null, error: envs.error }] };
      }
      for (const env of envs.data) {
        for (const selector of selectors) {
          const res = await run(["file", "open", file], { worktree: selector, environment: env.id || env.name, focus: true });
          if (res.ok) {
            return { ok: true, environment: env.name || env.id, selector, attempts };
          }
          attempts.push({ environment: env.name || env.id, selector, error: res.error });
        }
      }
      return { ok: false, attempts };
    },

    async listTerminals(selector) {
      const res = await run(["terminal", "list"], { worktree: selector, limit: selector ? 50 : 200 });
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
          worktreePath: t.worktreePath || "",
        })),
      };
    },
  };
}
