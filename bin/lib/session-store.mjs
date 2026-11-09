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
    ip: typeof input.ip === "string" ? input.ip : "",
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
    forwards: Array.isArray(input.forwards) ? input.forwards : [],
  };

  if (typeof input.transport === "string" && input.transport) {
    normalized.transport = input.transport;
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

  const active = sessions.filter((s) => s.state !== "zombie");
  const pool = active.length > 0 ? active : sessions;
  return [...pool].sort(compareSessionsNewestFirst)[0];
}

export function resolveSession({ sessionName = null, homeDir = os.homedir() } = {}) {
  const sessions = listSessions(homeDir);
  return selectDefaultSession(sessions, sessionName);
}
