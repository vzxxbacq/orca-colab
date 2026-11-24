import { closeSync, existsSync, openSync, rmSync, statSync, truncateSync } from "node:fs";
import os from "node:os";
import { createRuntimeChannel, SessionGoneError } from "./runtime-channel.mjs";
import {
  FINAL_TASK_STATUSES,
  HEARTBEAT_STALE_MS,
  listRuntimeTasks,
  readRuntimeFileFrom,
  readRuntimeFileTail,
  readRuntimeTask,
  requestRuntimeTaskStop,
  runtimeTaskFile,
  stageRuntimeTask,
} from "./runtime-records.mjs";
import { listSessions } from "./session-store.mjs";
import { appendTaskLog, isProcessAlive, listTasks, readTask, taskLogPath, writeTask } from "./task-store.mjs";

const FIRST_MIRROR_BYTES = 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function taskLogFooter(task) {
  return task.status === "stopped"
    ? `\n[task ${task.id}] stopped by user at ${task.finishedAt}\n`
    : `\n[task ${task.id}] ${task.status} at ${task.finishedAt} (exit code ${task.exitCode})\n`;
}

function localLogBytes(id, homeDir) {
  const file = taskLogPath(id, homeDir);
  return existsSync(file) ? statSync(file).size : 0;
}

function hasLiveFollower(task, checkPid) {
  return Boolean(task?.localPid) && task.localPid !== process.pid && checkPid(task.localPid);
}

// Starts the job detached on the runtime, then follows its record and log over HTTPS into the local
// copy until it ends. Ending this process only ends the following: the job and its log stay complete
// on the runtime, where any machine signed in to the account reads them.
export async function runTaskOnRuntime({
  task,
  session,
  script,
  logHead,
  localLogHead = logHead,
  homeDir = os.homedir(),
  execTty,
  fetchImpl = fetch,
  onOutput = null,
  pollMs = 1000,
  channel = createRuntimeChannel({ sessionName: session.name, homeDir, fetchImpl }),
}) {
  const launchLine = await stageRuntimeTask(channel, {
    record: {
      id: task.id,
      name: task.name,
      command: task.command,
      cwd: task.cwd,
      sessionName: session.name,
      origin: task.origin || null,
      status: "running",
      exitCode: null,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: null,
    },
    script,
    logHead,
  });
  appendTaskLog(task.id, localLogHead, homeDir);
  const headBytes = Buffer.byteLength(logHead);
  writeTask(
    {
      ...task,
      status: "running",
      localPid: process.pid,
      runtimeBacked: true,
      runtimeLogOffset: headBytes,
      localLogBytes: localLogBytes(task.id, homeDir),
    },
    homeDir,
  );
  const current = channel.session();
  const launched = await execTty({
    baseUrl: current.colabRuntime.baseUrl,
    proxyToken: current.colabRuntime.token,
    command: launchLine,
    timeoutMs: 60_000,
    fetchImpl,
  });
  if (launched.exitCode !== 0) {
    throw new Error(`could not start the job on the runtime: ${String(launched.stdout || "").trim().slice(-200)}`);
  }

  const decoder = new TextDecoder("utf-8");
  const startedMs = Date.now();
  let offset = headBytes;
  let lastBeat = "";
  let lastProgressMs = Date.now();
  let failingSinceMs = null;
  for (;;) {
    let record = null;
    try {
      record = await readRuntimeTask(channel, task.id);
      const bytes = await readRuntimeFileFrom(channel, runtimeTaskFile(task.id, "log"), offset);
      failingSinceMs = null;
      if (bytes?.length) {
        offset += bytes.length;
        appendTaskLog(task.id, bytes, homeDir);
        // Offset and local size are recorded together, so a copy that was cut off between the append
        // and this write is recognised and undone by the next reader instead of appended twice.
        const mine = readTask(task.id, homeDir, { reconcile: false });
        if (mine && mine.status === "running") {
          writeTask({ ...mine, runtimeLogOffset: offset, localLogBytes: localLogBytes(task.id, homeDir) }, homeDir);
        }
        lastProgressMs = Date.now();
        onOutput?.(decoder.decode(bytes, { stream: true }));
      }
    } catch (err) {
      if (err instanceof SessionGoneError) throw err;
      failingSinceMs ??= Date.now();
      if (Date.now() - failingSinceMs > 5 * 60_000) {
        throw Object.assign(new Error(`lost contact with the runtime while following the job: ${err?.message || err}`), {
          followLost: true,
        });
      }
    }
    if (record?.updatedAt && record.updatedAt !== lastBeat) {
      lastBeat = record.updatedAt;
      lastProgressMs = Date.now();
    }
    if (record && FINAL_TASK_STATUSES.includes(record.status)) {
      return { record, logOffset: offset };
    }
    const mine = readTask(task.id, homeDir, { reconcile: false });
    if (!mine || mine.status === "stopped") {
      return { record: null, logOffset: offset, stoppedLocally: true };
    }
    if (Date.now() - lastProgressMs > HEARTBEAT_STALE_MS + 30_000) {
      // The proxy answers an expired token like a missing file; a refresh tells the two apart.
      await channel.refreshToken();
      const again = await readRuntimeTask(channel, task.id).catch(() => null);
      if (!again || again.updatedAt === lastBeat) {
        throw new Error("the job's runner on the runtime stopped reporting (the runtime restarted or the runner was killed)");
      }
    }
    await sleep(Date.now() - startedMs < 5000 ? Math.min(300, pollMs) : pollMs);
  }
}

// Brings this machine's task list in line with the runtime's: jobs another machine submitted appear
// here, and a job whose local follower is gone gets its real state. Returns the ids on the runtime.
export async function mirrorRuntimeTasks({
  session,
  homeDir = os.homedir(),
  fetchImpl = fetch,
  checkPid = isProcessAlive,
  channel = createRuntimeChannel({ sessionName: session.name, homeDir, fetchImpl }),
  nowIso = () => new Date().toISOString(),
}) {
  const local = new Map(
    listTasks(homeDir, { reconcile: false })
      .filter((t) => t.sessionName === session.name)
      .map((t) => [t.id, t]),
  );
  const { known, ids, tasks } = await listRuntimeTasks(channel, {
    wanted: (id) => {
      const mine = local.get(id);
      return !mine || (mine.status === "running" && !hasLiveFollower(mine, checkPid));
    },
  });
  if (!known) {
    return { known: false, ids: [] };
  }
  for (const { id, record, stale } of tasks) {
    const mine = local.get(id);
    const final = FINAL_TASK_STATUSES.includes(record.status);
    writeTask(
      {
        ...(mine || {}),
        id,
        name: record.name,
        command: record.command,
        sessionName: session.name,
        gpuName: mine?.gpuName || session.gpu?.name || null,
        account: session.account || "default",
        cwd: record.cwd ?? null,
        status: final ? record.status : stale ? "failed" : "running",
        exitCode: final ? record.exitCode : stale ? 1 : null,
        createdAt: record.createdAt,
        startedAt: record.startedAt,
        finishedAt: final ? record.finishedAt : stale ? nowIso() : null,
        localPid: null,
        runtimeBacked: true,
        origin: record.origin || mine?.origin || null,
      },
      homeDir,
    );
  }
  // A job this machine believes is running there, on a runtime that has no record of it.
  for (const mine of local.values()) {
    if (mine.status === "running" && mine.runtimeBacked && !ids.includes(mine.id) && !hasLiveFollower(mine, checkPid)) {
      writeTask({ ...mine, status: "failed", exitCode: 1, finishedAt: nowIso(), localPid: null }, homeDir);
    }
  }
  return { known: true, ids };
}

// Appends what the runtime's log gained since the last copy. A first copy of a large log takes only its
// end; the rest stays on the runtime.
export async function mirrorTaskLog({
  task,
  homeDir = os.homedir(),
  fetchImpl = fetch,
  checkPid = isProcessAlive,
  channel = createRuntimeChannel({ sessionName: task.sessionName, homeDir, fetchImpl }),
}) {
  if (!task?.runtimeBacked || task.logComplete || hasLiveFollower(task, checkPid)) {
    return task;
  }
  // The panel, a CLI call and another panel poll may all copy the same log; two copies of one range
  // would append it twice, so one copier at a time holds a lock file and the others skip this round.
  const lockPath = `${taskLogPath(task.id, homeDir)}.lock`;
  try {
    if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs > 60_000) {
      rmSync(lockPath, { force: true });
    }
    closeSync(openSync(lockPath, "wx"));
  } catch {
    return task;
  }
  try {
    const fresh = readTask(task.id, homeDir, { reconcile: false });
    return fresh ? await copyRuntimeLog({ task: fresh, homeDir, channel }) : task;
  } finally {
    rmSync(lockPath, { force: true });
  }
}

async function copyRuntimeLog({ task, homeDir, channel }) {
  if (task.logComplete) {
    return task;
  }
  const logFile = runtimeTaskFile(task.id, "log");
  let offset = task.runtimeLogOffset || 0;
  let copied = 0;
  const recorded = task.localLogBytes ?? (offset === 0 ? 0 : null);
  if (recorded !== null && localLogBytes(task.id, homeDir) > recorded) {
    truncateSync(taskLogPath(task.id, homeDir), recorded);
  }
  if (offset === 0) {
    const tail = await readRuntimeFileTail(channel, logFile, FIRST_MIRROR_BYTES);
    if (!tail) return task;
    if (tail.totalBytes > tail.bytes.length) {
      appendTaskLog(
        task.id,
        `[task ${task.id}] showing the last ${tail.bytes.length} of ${tail.totalBytes} bytes; the full log is on the runtime\n`,
        homeDir,
      );
    }
    appendTaskLog(task.id, tail.bytes, homeDir);
    offset = tail.totalBytes;
    copied = tail.bytes.length;
  }
  for (;;) {
    const bytes = await readRuntimeFileFrom(channel, logFile, offset);
    if (!bytes?.length) break;
    appendTaskLog(task.id, bytes, homeDir);
    offset += bytes.length;
    copied += bytes.length;
  }
  const latest = readTask(task.id, homeDir, { reconcile: false }) || task;
  const done = latest.status !== "running";
  if (done) {
    appendTaskLog(task.id, taskLogFooter(latest), homeDir);
  }
  if (!copied && !done) {
    return latest;
  }
  return writeTask(
    { ...latest, runtimeLogOffset: offset, localLogBytes: localLogBytes(task.id, homeDir), logComplete: done },
    homeDir,
  );
}

export async function stopRuntimeTask({ task, homeDir = os.homedir(), fetchImpl = fetch }) {
  const channel = createRuntimeChannel({ sessionName: task.sessionName, homeDir, fetchImpl });
  await requestRuntimeTaskStop(channel, task.id);
}

// Every runtime this machine knows, in parallel; one that does not answer in time is skipped.
export async function mirrorAllRuntimeTasks({ homeDir = os.homedir(), fetchImpl = fetch, sessionName = null, timeoutMs = 12_000 } = {}) {
  const sessions = listSessions(homeDir).filter(
    (s) => s.state !== "zombie" && s.colabRuntime?.baseUrl && s.colabRuntime?.token && (!sessionName || s.name === sessionName),
  );
  await Promise.all(
    sessions.map((session) =>
      Promise.race([
        mirrorRuntimeTasks({ session, homeDir, fetchImpl }).catch(() => null),
        new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
      ]),
    ),
  );
  failJobsOfReleasedRuntimes(homeDir);
}

// A job cannot outlive its runtime: once this machine has no session for it, a job still marked running
// that no local process follows has ended with the runtime.
export function failJobsOfReleasedRuntimes(homeDir = os.homedir(), { checkPid = isProcessAlive } = {}) {
  const known = new Set(listSessions(homeDir).map((s) => s.name));
  for (const task of listTasks(homeDir, { reconcile: false })) {
    if (task.status === "running" && task.runtimeBacked && !known.has(task.sessionName) && !hasLiveFollower(task, checkPid)) {
      writeTask({ ...task, status: "failed", exitCode: 1, finishedAt: new Date().toISOString(), localPid: null }, homeDir);
    }
  }
}
