import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./cli-output.mjs";
import {
  ensureColabHome,
  getColabPaths,
  readJsonFile,
  writeJsonAtomic,
} from "./colab-home.mjs";

export function generateTaskId(nowMs = Date.now()) {
  const ts = Math.floor(nowMs / 1000).toString(36);
  const suffix = randomBytes(2).toString("hex");
  return `task-${ts}-${suffix}`;
}

export function assertSafeTaskId(id) {
  if (
    typeof id !== "string" ||
    id.trim() === "" ||
    id.includes("/") ||
    id.includes("\\") ||
    id === "." ||
    id === ".."
  ) {
    throw new CliError(`invalid task id: ${id}`);
  }
}

export function taskJsonPath(id, homeDir = os.homedir()) {
  assertSafeTaskId(id);
  const { tasksDir } = getColabPaths(homeDir);
  return path.join(tasksDir, `${id}.json`);
}

export function taskLogPath(id, homeDir = os.homedir()) {
  assertSafeTaskId(id);
  const { tasksDir } = getColabPaths(homeDir);
  return path.join(tasksDir, `${id}.log`);
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

export function normalizeTask(input, homeDir = os.homedir()) {
  if (!input || typeof input !== "object") {
    throw new CliError("task data must be an object");
  }
  assertSafeTaskId(input.id);
  const nowIso = new Date().toISOString();
  const createdAt =
    typeof input.createdAt === "string" && input.createdAt
      ? input.createdAt
      : nowIso;
  const startedAt =
    typeof input.startedAt === "string" && input.startedAt
      ? input.startedAt
      : createdAt;
  const command = Array.isArray(input.command)
    ? input.command.map(String)
    : typeof input.command === "string"
      ? [input.command]
      : [];
  const defaultName =
    command.join(" ").slice(0, 64) || input.id;

  const validStatuses = new Set(["running", "succeeded", "failed", "stopped"]);
  const status = validStatuses.has(input.status) ? input.status : "running";

  return {
    id: input.id,
    name:
      typeof input.name === "string" && input.name.trim()
        ? input.name.trim()
        : defaultName,
    command,
    sessionName:
      typeof input.sessionName === "string" ? input.sessionName : "",
    gpuName:
      typeof input.gpuName === "string" && input.gpuName ? input.gpuName : null,
    account:
      typeof input.account === "string" && input.account
        ? input.account
        : "default",
    cwd: typeof input.cwd === "string" && input.cwd ? input.cwd : null,
    env:
      input.env && typeof input.env === "object" && !Array.isArray(input.env)
        ? { ...input.env }
        : {},
    syncPath:
      typeof input.syncPath === "string" && input.syncPath
        ? input.syncPath
        : null,
    status,
    exitCode:
      typeof input.exitCode === "number" && Number.isInteger(input.exitCode)
        ? input.exitCode
        : null,
    createdAt,
    startedAt,
    finishedAt:
      typeof input.finishedAt === "string" && input.finishedAt
        ? input.finishedAt
        : null,
    localPid:
      typeof input.localPid === "number" && Number.isInteger(input.localPid)
        ? input.localPid
        : null,
    logPath:
      typeof input.logPath === "string" && input.logPath
        ? input.logPath
        : taskLogPath(input.id, homeDir),
  };
}

export function writeTask(task, homeDir = os.homedir()) {
  const paths = ensureColabHome(homeDir);
  mkdirSync(paths.tasksDir, { recursive: true, mode: 0o700 });
  const normalized = normalizeTask(task, homeDir);
  const filePath = taskJsonPath(normalized.id, homeDir);
  writeJsonAtomic(filePath, normalized, { mode: 0o600 });
  if (!existsSync(normalized.logPath)) {
    mkdirSync(path.dirname(normalized.logPath), { recursive: true, mode: 0o700 });
    writeFileSync(normalized.logPath, "", { encoding: "utf8", mode: 0o600 });
  }
  return normalized;
}

export function reconcileTask(task, homeDir = os.homedir(), { checkPid = isProcessAlive } = {}) {
  if (!task || task.status !== "running") {
    return task;
  }
  if (task.localPid && !checkPid(task.localPid)) {
    const updated = writeTask(
      {
        ...task,
        status: "failed",
        exitCode: task.exitCode ?? 1,
        finishedAt: task.finishedAt || new Date().toISOString(),
      },
      homeDir,
    );
    return updated;
  }
  return task;
}

export function readTask(id, homeDir = os.homedir(), { reconcile = true } = {}) {
  const filePath = taskJsonPath(id, homeDir);
  const raw = readJsonFile(filePath);
  if (!raw) {
    return null;
  }
  const normalized = normalizeTask(raw, homeDir);
  return reconcile ? reconcileTask(normalized, homeDir) : normalized;
}

export function listTasks(homeDir = os.homedir(), { reconcile = true } = {}) {
  const { tasksDir } = getColabPaths(homeDir);
  let entries;
  try {
    entries = readdirSync(tasksDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const tasks = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const raw = readJsonFile(path.join(tasksDir, entry.name));
    if (raw) {
      const normalized = normalizeTask(raw, homeDir);
      tasks.push(reconcile ? reconcileTask(normalized, homeDir) : normalized);
    }
  }

  tasks.sort((a, b) => {
    const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (!Number.isNaN(diff) && diff !== 0) {
      return diff;
    }
    return b.id.localeCompare(a.id);
  });
  return tasks;
}

export function appendTaskLog(id, text, homeDir = os.homedir()) {
  const paths = ensureColabHome(homeDir);
  mkdirSync(paths.tasksDir, { recursive: true, mode: 0o700 });
  const logFile = taskLogPath(id, homeDir);
  appendFileSync(logFile, text, { encoding: "utf8", mode: 0o600 });
}

export function readTaskLog(
  id,
  homeDir = os.homedir(),
  { tailLines = 200, maxBytes = 65536 } = {},
) {
  const logFile = taskLogPath(id, homeDir);
  if (!existsSync(logFile)) {
    return { text: "", totalBytes: 0, truncated: false };
  }
  const stat = statSync(logFile);
  const totalBytes = stat.size;
  let raw = "";
  let truncated = false;

  if (totalBytes > maxBytes) {
    const fd = openSync(logFile, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const start = totalBytes - maxBytes;
      readFileSync;
      const bytesRead = closeAndReadSlice(fd, buf, start);
      raw = buf.subarray(0, bytesRead).toString("utf8");
      truncated = true;
    } finally {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  } else {
    raw = readFileSync(logFile, "utf8");
  }

  if (tailLines && tailLines > 0) {
    const lines = raw.split(/\r?\n/);
    if (lines.length > tailLines + 1) {
      raw = lines.slice(-tailLines).join("\n");
      truncated = true;
    }
  }

  return { text: raw, totalBytes, truncated };
}

function closeAndReadSlice(fd, buf, position) {
  let offset = 0;
  while (offset < buf.length) {
    const n = readSyncCompat(fd, buf, offset, buf.length - offset, position + offset);
    if (n <= 0) break;
    offset += n;
  }
  return offset;
}

import { readSync as readSyncCompat } from "node:fs";
