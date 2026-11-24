import os from "node:os";
import path from "node:path";
import { COLAB_HEADERS, COLAB_PROXY_TOKEN_HEADER } from "./colab-api-client.mjs";
import { normalizeRecordedGuardrails } from "./project-guardrails.mjs";
import { normalizeSessionOrigin as normalizeOrigin } from "./session-store.mjs";

// What another machine needs to know about a runtime lives on the runtime itself, read and written
// through its Jupyter server (contents API and /files) with the runtime proxy token: who started it,
// which jobs ran there with their complete output, and who used it last. Any machine signed in to the
// same Google account gets the proxy token from Colab's runtime list, so no machine has to ask another.
export const RUNTIME_STATE_DIR = "/content/orca/.orca-colab";
export const RUNTIME_RECORD_SCHEMA = 1;
const TASKS_DIR = "tasks";
const ACTIVITY_DIR = "activity";
const JOB_RUNNER_FILE = "_job-runner-v1.py";
export const BUSY_GRACE_MS = 150_000;
export const HEARTBEAT_STALE_MS = 120_000;

// A runtime that is not a local session yet (seen in Colab's list) is reached with the token from that list.
export function directRuntimeChannel({ baseUrl, proxyToken, fetchImpl = fetch }) {
  return {
    baseUrl: () => baseUrl,
    fetch: (url, init = {}) =>
      fetchImpl(url, {
        ...init,
        headers: { ...COLAB_HEADERS, ...init.headers, [COLAB_PROXY_TOKEN_HEADER]: proxyToken },
        signal: init.signal ?? AbortSignal.timeout(15_000),
      }),
  };
}

// A runtime that stalls must cost a reader seconds, not minutes; the next poll asks again.
function send(channel, url, init = {}) {
  return channel.fetch(url, init.signal ? init : { timeoutMs: 8_000, ...init });
}

// Starting a job has no next poll: its requests wait longer and are sent again after a timeout. Colab's
// proxy now and then holds one request for many seconds while the next one is answered at once.
const JOB_START_REQUEST = Object.freeze({ timeoutMs: 20_000, retryTimeouts: true });

function statePath(rel) {
  return rel ? `${RUNTIME_STATE_DIR}/${rel}` : RUNTIME_STATE_DIR;
}

function apiUrl(channel, kind, absPath) {
  const segments = absPath.split("/").filter(Boolean).map((s) => encodeURIComponent(s));
  return `${String(channel.baseUrl()).replace(/\/+$/, "")}/${kind}/${segments.join("/")}`;
}

async function putContents(channel, absPath, body, request = {}) {
  const res = await send(channel, apiUrl(channel, "api/contents", absPath), {
    ...request,
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await res.arrayBuffer().catch(() => {});
  return res;
}

// Jupyter creates one directory level per request and answers 201 for one that already exists.
export async function ensureRuntimeStateDirs(channel, request = {}) {
  for (const dir of ["/content/orca", RUNTIME_STATE_DIR, statePath(TASKS_DIR), statePath(ACTIVITY_DIR)]) {
    const res = await putContents(channel, dir, { type: "directory" }, request);
    if (!res.ok) {
      throw new Error(`could not create ${dir} on the runtime (${res.status})`);
    }
  }
}

export async function writeRuntimeFile(channel, rel, text, request = {}) {
  const body = { type: "file", format: "text", content: text };
  let res = await putContents(channel, statePath(rel), body, request);
  if (!res.ok) {
    await ensureRuntimeStateDirs(channel, request);
    res = await putContents(channel, statePath(rel), body, request);
  }
  if (!res.ok) {
    throw new Error(`could not write ${statePath(rel)} on the runtime (${res.status})`);
  }
}

export async function readRuntimeJson(channel, rel) {
  const res = await send(channel, `${apiUrl(channel, "api/contents", statePath(rel))}?content=1&format=text&type=file`);
  if (!res.ok) {
    await res.arrayBuffer().catch(() => {});
    if (res.status === 404) return null;
    throw new Error(`could not read ${statePath(rel)} on the runtime (${res.status})`);
  }
  try {
    const parsed = JSON.parse((await res.json()).content);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // Read in the middle of a rewrite; the next poll gets the whole file.
    return null;
  }
}

// `serverNowMs` is the runtime side's clock, so ages are right on a machine whose own clock is off.
export async function listRuntimeDir(channel, rel, request = {}) {
  const res = await send(channel, `${apiUrl(channel, "api/contents", statePath(rel))}?content=1&type=directory`, request);
  if (!res.ok) {
    await res.arrayBuffer().catch(() => {});
    if (res.status === 404) return null;
    throw new Error(`could not list ${statePath(rel)} on the runtime (${res.status})`);
  }
  const dateMs = Date.parse(res.headers?.get?.("date") || "");
  const body = await res.json();
  return {
    serverNowMs: Number.isFinite(dateMs) ? dateMs : Date.now(),
    entries: (Array.isArray(body?.content) ? body.content : []).map((e) => ({
      name: e.name,
      type: e.type,
      size: typeof e.size === "number" ? e.size : 0,
      lastModifiedMs: Date.parse(e.last_modified || "") || 0,
    })),
  };
}

// Bytes of a file from `from` on; an empty buffer when nothing new was written, null when it is missing.
export async function readRuntimeFileFrom(channel, rel, from = 0) {
  const res = await send(channel, apiUrl(channel, "files", statePath(rel)), {
    headers: from > 0 ? { Range: `bytes=${from}-` } : {},
  });
  if (res.status === 416) {
    await res.arrayBuffer().catch(() => {});
    return Buffer.alloc(0);
  }
  if (!res.ok) {
    await res.arrayBuffer().catch(() => {});
    if (res.status === 404) return null;
    throw new Error(`could not read ${statePath(rel)} on the runtime (${res.status})`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return res.status === 206 || from === 0 ? bytes : bytes.subarray(from);
}

// The last `maxBytes` of a file and its full size, for a first read of a log that may be huge.
export async function readRuntimeFileTail(channel, rel, maxBytes) {
  const res = await send(channel, apiUrl(channel, "files", statePath(rel)), {
    headers: { Range: `bytes=-${maxBytes}` },
  });
  if (res.status === 416) {
    await res.arrayBuffer().catch(() => {});
    return { bytes: Buffer.alloc(0), totalBytes: 0 };
  }
  if (!res.ok) {
    await res.arrayBuffer().catch(() => {});
    if (res.status === 404) return null;
    throw new Error(`could not read ${statePath(rel)} on the runtime (${res.status})`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const total = Number(/\/(\d+)$/.exec(res.headers?.get?.("content-range") || "")?.[1]);
  if (res.status === 206 && Number.isFinite(total)) {
    return { bytes, totalBytes: total };
  }
  return { bytes: bytes.subarray(Math.max(0, bytes.length - maxBytes)), totalBytes: bytes.length };
}

function machineFileId(machine) {
  return String(machine || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "unknown";
}

// The name other machines see for this one. ORCA_COLAB_MACHINE overrides a hostname that says nothing
// (a container id) or that two machines share.
export function machineName(env = process.env) {
  return String(env.ORCA_COLAB_MACHINE || "").trim() || os.hostname();
}

// Who is acting: the machine, and the agent when it says so. Agents set ORCA_COLAB_AGENT (the MCP server
// passes its client's name); Claude Code is recognised by its own variable.
export function describeOrigin({ env = process.env, cwd = null, agent = null } = {}) {
  const named = agent || env.ORCA_COLAB_AGENT || (env.CLAUDECODE ? "Claude Code" : null);
  return {
    machine: machineName(env),
    platform: process.platform,
    agent: named ? String(named).slice(0, 80) : "cli",
    workspace: cwd ? path.basename(cwd) : null,
    ...(cwd ? { directory: path.resolve(cwd) } : {}),
    // Orca sets this in the terminals of a workspace: an exact handle another machine can pass to `orca`.
    ...(env.ORCA_WORKTREE_ID ? { orcaWorkspace: String(env.ORCA_WORKTREE_ID) } : {}),
  };
}

export function sameMachine(origin, machine = machineName()) {
  return Boolean(origin?.machine) && origin.machine === machine;
}

export async function writeRuntimeSessionRecord(channel, session, { email = null } = {}) {
  await writeRuntimeFile(
    channel,
    "session.json",
    `${JSON.stringify(
      {
        schema: RUNTIME_RECORD_SCHEMA,
        name: session.name,
        account: email,
        origin: normalizeOrigin(session.origin),
        gpu: session.gpu ?? null,
        rateKey: session.rateKey,
        cuPerHour: session.cuPerHour,
        createdAt: session.createdAt,
        keep: Boolean(session.keep),
        runtimeId: session.colabRuntime?.id || null,
        project: session.project ?? null,
        guardrails: session.guardrails ?? null,
      },
      null,
      2,
    )}\n`,
  );
}

// The keep flag belongs to the runtime, so every machine's watchdog honours it. A session from before
// runtime records gets its record here.
export async function setRuntimeKeep(channel, session, keep) {
  const existing = await readRuntimeJson(channel, "session.json");
  if (!existing) {
    await writeRuntimeSessionRecord(channel, { ...session, keep });
    return;
  }
  await writeRuntimeFile(channel, "session.json", `${JSON.stringify({ ...existing, keep: Boolean(keep) }, null, 2)}\n`);
}

export async function readRuntimeSessionRecord(channel) {
  const raw = await readRuntimeJson(channel, "session.json");
  if (!raw || typeof raw.name !== "string" || !raw.name) {
    return null;
  }
  return {
    name: raw.name,
    account: typeof raw.account === "string" ? raw.account : null,
    origin: normalizeOrigin(raw.origin),
    gpu: raw.gpu && typeof raw.gpu === "object" ? raw.gpu : null,
    rateKey: typeof raw.rateKey === "string" ? raw.rateKey : null,
    cuPerHour: typeof raw.cuPerHour === "number" ? raw.cuPerHour : null,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    keep: Boolean(raw.keep),
    runtimeId: typeof raw.runtimeId === "string" ? raw.runtimeId : null,
    project: typeof raw.project === "string" && raw.project ? raw.project : null,
    guardrails: normalizeRecordedGuardrails(raw.guardrails),
  };
}

// One file per machine: the time of its last command and until when that command counts as still
// going (a running command renews it every minute; a finished one sets it to now).
export async function stampRuntimeActivity(channel, { origin, command = null, running, nowMs = Date.now() }) {
  await writeRuntimeFile(
    channel,
    `${ACTIVITY_DIR}/${machineFileId(origin?.machine)}.json`,
    `${JSON.stringify({
      machine: origin?.machine || null,
      agent: origin?.agent || null,
      command,
      at: new Date(nowMs).toISOString(),
      busyUntil: new Date(running ? nowMs + BUSY_GRACE_MS : nowMs).toISOString(),
    })}\n`,
  );
}

// Who used the runtime and when, measured on the runtime side's clock: `idleMs` since the last command
// of any machine, `busyBy` the machines with a command still going.
export async function readRuntimeUsage(channel) {
  const listing = await listRuntimeDir(channel, ACTIVITY_DIR);
  if (!listing) {
    return { known: false, idleMs: null, busyBy: [] };
  }
  const files = listing.entries.filter((e) => e.type === "file" && e.name.endsWith(".json"));
  const newestMs = Math.max(0, ...files.map((e) => e.lastModifiedMs));
  const recent = files.filter((e) => listing.serverNowMs - e.lastModifiedMs < BUSY_GRACE_MS);
  const records = await Promise.all(
    recent.map((e) => readRuntimeJson(channel, `${ACTIVITY_DIR}/${e.name}`).catch(() => null)),
  );
  const busyBy = [];
  recent.forEach((e, i) => {
    const rec = records[i];
    const stillFor = Date.parse(rec?.busyUntil || "") - Date.parse(rec?.at || "");
    if (rec?.machine && stillFor > 0 && listing.serverNowMs - e.lastModifiedMs < stillFor) {
      busyBy.push({ machine: rec.machine, agent: rec.agent || null, command: rec.command || null });
    }
  });
  return {
    known: files.length > 0,
    idleMs: files.length > 0 ? Math.max(0, listing.serverNowMs - newestMs) : null,
    busyBy,
  };
}

// Runs one job detached from whoever started it: the command writes straight into the log file, this
// process records the state next to it and stops the command when a `.stop` file appears. So the log
// is complete for every reader and the job outlives the client that submitted it.
const JOB_RUNNER_SOURCE = String.raw`
import json, os, signal, subprocess, sys, time

root, tid = sys.argv[1], sys.argv[2]
jpath = os.path.join(root, tid + ".json")
lpath = os.path.join(root, tid + ".log")
spath = os.path.join(root, tid + ".sh")
stop_path = os.path.join(root, tid + ".stop")

def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".000Z"

def save(rec):
    rec["updatedAt"] = now()
    tmp = jpath + ".tmp"
    with open(tmp, "w") as f:
        json.dump(rec, f, indent=2)
    os.replace(tmp, jpath)

with open(jpath) as f:
    rec = json.load(f)
with open(spath) as f:
    script = f.read()
os.remove(spath)
if rec.get("cwd"):
    os.makedirs(rec["cwd"], exist_ok=True)
    os.chdir(rec["cwd"])
else:
    os.chdir("/content")
log = open(lpath, "ab", buffering=0)
proc = subprocess.Popen(["/bin/sh", "-c", script], stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
rec.update({"status": "running", "runnerPid": os.getpid(), "pid": proc.pid})
save(rec)

stopped = False
def stop_command(*_):
    global stopped
    stopped = True
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
signal.signal(signal.SIGTERM, stop_command)

beat = time.time()
killed_at = None
while proc.poll() is None:
    time.sleep(0.5)
    if not stopped and os.path.exists(stop_path):
        stop_command()
    if stopped and killed_at is None:
        killed_at = time.time()
    if killed_at and time.time() - killed_at > 8:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if time.time() - beat > 15:
        beat = time.time()
        save(rec)

code = proc.returncode
finished = now()
if stopped:
    rec.update({"status": "stopped", "exitCode": 130, "finishedAt": finished})
else:
    rec.update({"status": "succeeded" if code == 0 else "failed", "exitCode": code, "finishedAt": finished})
save(rec)
try:
    os.remove(stop_path)
except OSError:
    pass
`.trimStart();

export function runtimeTaskFile(id, ext) {
  return `${TASKS_DIR}/${id}.${ext}`;
}

// A job that did not start says at which step: the caller shows the message as the reason.
export async function jobStartStep(step, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err?.code === "SESSION_GONE") throw err;
    throw Object.assign(new Error(`could not start the job (${step}): ${err?.message || err}`, { cause: err }), { jobStartStep: step });
  }
}

// Uploads the job's record, its shell script and the head of its log, and returns the shell line that
// starts the runner detached from the terminal that types it.
export async function stageRuntimeTask(channel, { record, script, logHead = "" }) {
  const write = (rel, text) => writeRuntimeFile(channel, rel, text, JOB_START_REQUEST);
  let listing = await jobStartStep("listing the jobs on the runtime", () => listRuntimeDir(channel, TASKS_DIR, JOB_START_REQUEST));
  if (!listing) {
    await jobStartStep("creating the job directory on the runtime", () => ensureRuntimeStateDirs(channel, JOB_START_REQUEST));
    listing = { entries: [] };
  }
  if (!listing.entries.some((e) => e.name === JOB_RUNNER_FILE)) {
    await jobStartStep("uploading the job runner", () => write(`${TASKS_DIR}/${JOB_RUNNER_FILE}`, JOB_RUNNER_SOURCE));
  }
  await jobStartStep("creating the job's log", () => write(runtimeTaskFile(record.id, "log"), logHead));
  await jobStartStep("uploading the job's script", () => write(runtimeTaskFile(record.id, "sh"), script));
  await jobStartStep("uploading the job's record", () => write(runtimeTaskFile(record.id, "json"), `${JSON.stringify(record, null, 2)}\n`));
  const tasksDir = statePath(TASKS_DIR);
  return `nohup setsid python3 ${tasksDir}/${JOB_RUNNER_FILE} ${tasksDir} ${record.id} > /dev/null 2>&1 < /dev/null & echo started`;
}

export async function readRuntimeTask(channel, id) {
  return readRuntimeJson(channel, runtimeTaskFile(id, "json"));
}

export async function requestRuntimeTaskStop(channel, id) {
  await writeRuntimeFile(channel, runtimeTaskFile(id, "stop"), "stop\n");
}

export const FINAL_TASK_STATUSES = Object.freeze(["succeeded", "failed", "stopped"]);

// Records of the jobs on the runtime: `wanted` restricts the reads to the ones the caller cannot settle
// from its own copy. `stale` marks a running job whose runner stopped reporting.
export async function listRuntimeTasks(channel, { wanted = () => true, changedWithinMs = null } = {}) {
  const listing = await listRuntimeDir(channel, TASKS_DIR);
  if (!listing) {
    return { known: false, ids: [], tasks: [] };
  }
  const jsonFiles = listing.entries.filter(
    (e) => e.type === "file" && e.name.endsWith(".json") && !e.name.startsWith("_"),
  );
  const ids = jsonFiles.map((e) => e.name.slice(0, -".json".length));
  const logSizes = new Map(
    listing.entries.filter((e) => e.name.endsWith(".log")).map((e) => [e.name.slice(0, -".log".length), e.size]),
  );
  const picked = jsonFiles.filter(
    (e) =>
      wanted(e.name.slice(0, -".json".length)) &&
      (changedWithinMs === null || listing.serverNowMs - e.lastModifiedMs < changedWithinMs),
  );
  const tasks = [];
  for (let at = 0; at < picked.length; at += 8) {
    const batch = await Promise.all(
      picked.slice(at, at + 8).map(async (e) => {
        const id = e.name.slice(0, -".json".length);
        const record = await readRuntimeJson(channel, `${TASKS_DIR}/${e.name}`).catch(() => null);
        if (!record) return null;
        return {
          id,
          record,
          logBytes: logSizes.get(id) ?? 0,
          stale: !FINAL_TASK_STATUSES.includes(record.status) && listing.serverNowMs - e.lastModifiedMs > HEARTBEAT_STALE_MS,
        };
      }),
    );
    tasks.push(...batch.filter(Boolean));
  }
  return { known: true, ids, tasks };
}

// Who else is on the runtime right now: machines other than this one with a command still going or a
// job still running. Empty when nobody is, or when the runtime keeps no records.
export async function readUseByOtherMachines(channel, machine = machineName()) {
  const [usage, running] = await Promise.all([
    readRuntimeUsage(channel),
    // A running job's record is rewritten every few seconds, so only fresh records need reading.
    listRuntimeTasks(channel, { changedWithinMs: HEARTBEAT_STALE_MS }),
  ]);
  const users = usage.busyBy
    .filter((u) => u.machine !== machine)
    .map((u) => ({ machine: u.machine, agent: u.agent, doing: u.command ? `command: ${u.command}` : "a command" }));
  for (const { record } of running.tasks) {
    if (!FINAL_TASK_STATUSES.includes(record.status) && record.origin?.machine && record.origin.machine !== machine) {
      users.push({ machine: record.origin.machine, agent: record.origin.agent || null, doing: `job ${record.id} (${record.name})` });
    }
  }
  return users;
}
