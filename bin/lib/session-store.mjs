import { readdirSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./cli-output.mjs";
import {
  ensureColabHome,
  getColabPaths,
  readJsonFile,
  writeJsonAtomic,
} from "./colab-home.mjs";
import { normalizeRecordedGuardrails } from "./project-guardrails.mjs";

export function normalizeSessionOrigin(input) {
  if (!input || typeof input !== "object" || typeof input.machine !== "string" || !input.machine) {
    return null;
  }
  return {
    machine: input.machine,
    platform: typeof input.platform === "string" ? input.platform : null,
    agent: typeof input.agent === "string" && input.agent ? input.agent : "cli",
    workspace: typeof input.workspace === "string" && input.workspace ? input.workspace : null,
    // Where on that machine the work was started, and which Orca workspace that is when Orca said so.
    ...(typeof input.directory === "string" && input.directory ? { directory: input.directory } : {}),
    ...(typeof input.orcaWorkspace === "string" && input.orcaWorkspace ? { orcaWorkspace: input.orcaWorkspace } : {}),
  };
}

function assertSafeSessionName(name) {
  if (
    typeof name !== "string" ||
    name.trim() === "" ||
    name.includes("/") ||
    name.includes("\\") ||
    name === "." ||
    name === ".."
  ) {
    throw new CliError(`invalid session name: ${name}`);
  }
}

export function normalizeSession(input) {
  if (!input || typeof input !== "object") {
    throw new CliError("session data must be an object");
  }
  assertSafeSessionName(input.name);
  const nowIso = new Date().toISOString();
  const createdAt =
    typeof input.createdAt === "string" && input.createdAt
      ? input.createdAt
      : nowIso;
  const lastActivityAt =
    typeof input.lastActivityAt === "string" && input.lastActivityAt
      ? input.lastActivityAt
      : createdAt;

  const normalized = {
    name: input.name,
    account: typeof input.account === "string" && input.account ? input.account : "default",
    hostname: typeof input.hostname === "string" ? input.hostname : input.name,
    gpu: input.gpu ?? null,
    rateKey: typeof input.rateKey === "string" && input.rateKey ? input.rateKey : "unknown",
    cuPerHour: typeof input.cuPerHour === "number" ? input.cuPerHour : 2,
    createdAt,
    lastActivityAt,
    activePids: Array.isArray(input.activePids)
      ? input.activePids.filter((pid) => Number.isInteger(pid))
      : [],
    keep: Boolean(input.keep),
    state: input.state === "zombie" ? "zombie" : "active",
    remoteRoot: typeof input.remoteRoot === "string" ? input.remoteRoot : null,
  };

  if (typeof input.transport === "string" && input.transport) {
    normalized.transport = input.transport;
  }

  // `origin` is who started the runtime (from its own record); `adopted` marks a session this machine
  // did not start but found in the account's runtime list. Adopted without origin = unknown origin.
  const origin = normalizeSessionOrigin(input.origin);
  if (origin) {
    normalized.origin = origin;
  }
  if (input.adopted) {
    normalized.adopted = true;
  }

  // The project whose `.orca/colab.json` governed this runtime, and the guardrails in force at `up`.
  if (typeof input.project === "string" && input.project) {
    normalized.project = input.project;
  }
  const guardrails = normalizeRecordedGuardrails(input.guardrails);
  if (guardrails) {
    normalized.guardrails = guardrails;
  }

  // When a client of this machine was last connected to the runtime (bin/lib/runtime-presence.mjs).
  if (typeof input.lastPresenceAt === "string" && input.lastPresenceAt) {
    normalized.lastPresenceAt = input.lastPresenceAt;
  }

  if (Array.isArray(input.forwards) && input.forwards.length > 0) {
    normalized.forwards = input.forwards
      .filter((f) => Number.isInteger(f?.pid) && Number.isInteger(f?.remotePort) && typeof f?.listen === "string")
      .map((f) => ({ pid: f.pid, remotePort: f.remotePort, listen: f.listen, startedAt: f.startedAt ?? null }));
  }

  if (input.colabRuntime && typeof input.colabRuntime === "object") {
    normalized.colabRuntime = {
      id: typeof input.colabRuntime.id === "string" ? input.colabRuntime.id : "",
      endpoint:
        typeof input.colabRuntime.endpoint === "string" ? input.colabRuntime.endpoint : "",
      baseUrl:
        typeof input.colabRuntime.baseUrl === "string" ? input.colabRuntime.baseUrl : "",
      token: typeof input.colabRuntime.token === "string" ? input.colabRuntime.token : "",
      tokenExpiry:
        typeof input.colabRuntime.tokenExpiry === "string"
          ? input.colabRuntime.tokenExpiry
          : null,
    };
  }

  return normalized;
}

export function sessionFilePath(name, homeDir = os.homedir()) {
  assertSafeSessionName(name);
  const { sessionsDir } = getColabPaths(homeDir);
  return path.join(sessionsDir, `${name}.json`);
}

export function readSession(name, homeDir = os.homedir()) {
  const filePath = sessionFilePath(name, homeDir);
  const raw = readJsonFile(filePath);
  if (!raw) {
    return null;
  }
  return normalizeSession(raw);
}

export function writeSession(session, homeDir = os.homedir()) {
  ensureColabHome(homeDir);
  const normalized = normalizeSession(session);
  const filePath = sessionFilePath(normalized.name, homeDir);
  writeJsonAtomic(filePath, normalized, { mode: 0o600 });
  return normalized;
}

export function deleteSession(name, homeDir = os.homedir()) {
  const filePath = sessionFilePath(name, homeDir);
  try {
    unlinkSync(filePath);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function compareSessionsNewestFirst(a, b) {
  const timeDiff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (!Number.isNaN(timeDiff) && timeDiff !== 0) {
    return timeDiff;
  }
  return a.name.localeCompare(b.name);
}

export function listSessions(homeDir = os.homedir()) {
  const { sessionsDir } = getColabPaths(homeDir);
  let entries;
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const sessions = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const raw = readJsonFile(path.join(sessionsDir, entry.name));
    if (raw) {
      sessions.push(normalizeSession(raw));
    }
  }
  sessions.sort(compareSessionsNewestFirst);
  return sessions;
}

// One session per Colab runtime: a runtime found in the account's list while `up` was still writing
// its own session can have a second, adopted record until the next discovery removes it.
export function distinctRuntimeSessions(sessions) {
  const byRuntime = new Map();
  const out = [];
  for (const s of [...sessions].sort((a, b) => Number(Boolean(a.adopted)) - Number(Boolean(b.adopted)))) {
    const id = s.colabRuntime?.id;
    if (id && byRuntime.has(id)) continue;
    if (id) byRuntime.set(id, s);
    out.push(s);
  }
  return out;
}

export function selectDefaultSession(sessions, requestedName = null) {
  if (requestedName) {
    const match = sessions.find((s) => s.name === requestedName);
    if (!match) {
      throw new CliError(`session not found: ${requestedName}`);
    }
    return match;
  }

  if (!Array.isArray(sessions) || sessions.length === 0) {
    throw new CliError("no active sessions; run 'orca-colab up' first");
  }

  if (sessions.length === 1) {
    return sessions[0];
  }

  // A runtime another machine started is used only when asked for by name or when it is the only one.
  const active = sessions.filter((s) => s.state !== "zombie");
  const own = active.filter((s) => !s.adopted);
  const pool = own.length > 0 ? own : active.length > 0 ? active : sessions;
  return [...pool].sort(compareSessionsNewestFirst)[0];
}

export function resolveSession({ sessionName = null, homeDir = os.homedir() } = {}) {
  const sessions = listSessions(homeDir);
  return selectDefaultSession(sessions, sessionName);
}

// Sessions started before v0.3.0 over Tailscale may lack the runtime proxy that every command now uses.
export function requireColabRuntime(session) {
  const runtime = session?.colabRuntime;
  if (!runtime?.baseUrl || !runtime?.token) {
    throw new CliError(
      `session ${session?.name} has no Colab runtime proxy (started by an older orca-colab over Tailscale); run 'orca-colab down --session ${session?.name}' and 'orca-colab up' again`,
    );
  }
  return { baseUrl: runtime.baseUrl, proxyToken: runtime.token };
}
