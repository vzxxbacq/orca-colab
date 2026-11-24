import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run as runDown } from "../bin/commands/down.mjs";
import { run as runJob } from "../bin/commands/job.mjs";
import { run as runStatus } from "../bin/commands/status.mjs";
import { run as runUp } from "../bin/commands/up.mjs";
import { discoverAccountRuntimes } from "../bin/lib/account-runtimes.mjs";
import { resolveOAuthClientConfig, saveOAuthCredentials } from "../bin/lib/colab-oauth.mjs";
import { readLedgerEvents } from "../bin/lib/credit-ledger.mjs";
import { evaluateSessionIdleState } from "../bin/lib/idle-watchdog.mjs";
import {
  directRuntimeChannel,
  readRuntimeUsage,
  readUseByOtherMachines,
  stampRuntimeActivity,
} from "../bin/lib/runtime-records.mjs";
import { distinctRuntimeSessions, listSessions, readSession } from "../bin/lib/session-store.mjs";
import { readTask, readTaskLog } from "../bin/lib/task-store.mjs";
import { createFakeRuntime, STATE_DIR } from "./fake-colab-runtime.mjs";

const RUNTIME = { id: "r-7", endpoint: "r-7", baseUrl: "https://8080-m.colab.dev", token: "proxy-tok", tokenExpiry: null };
const LISTED = { name: "runtimes/r-7", runtimeSpec: { variant: "VARIANT_GPU", accelerator: "T4" }, connectionInfo: { url: RUNTIME.baseUrl, token: RUNTIME.token } };
const MACHINE_A = { ORCA_COLAB_MACHINE: "machine-A", ORCA_COLAB_AGENT: "Claude Code" };
const MACHINE_B = { ORCA_COLAB_MACHINE: "machine-B" };

function makeBuffers() {
  let out = "";
  return { stdout: { write: (c) => { out += c; } }, stderr: { write() {} }, read: () => JSON.parse(out) };
}

// One "machine": its own ~/.orca-colab, signed in to the same Google account as the others.
function machine(t) {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "orca-colab-machine-"));
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  saveOAuthCredentials(
    "default",
    { refreshToken: "r", accessToken: "a", expiryDate: Date.now() + 3_600_000, email: "me@example.com", clientId: resolveOAuthClientConfig(homeDir).clientId },
    homeDir,
  );
  return homeDir;
}

async function upOnMachineA(homeDir, runtime, argv = ["--gpu", "T4", "--name", "train"]) {
  const io = makeBuffers();
  await runUp(argv, {
    json: true,
    ...io,
    env: MACHINE_A,
    cwd: "/work/my-repo",
    homeDir,
    nowIso: () => "2026-11-24T08:00:00.000Z",
    fetchImpl: runtime.fetchImpl,
    assignRuntimeFn: async () => RUNTIME,
    getConsumptionUserInfoFn: async () => ({}),
    queryGpuTtyFn: async () => ({ name: "Tesla T4", memoryTotalMiB: 15360, driverVersion: null }),
  });
  return io.read();
}

const discoverFrom = (homeDir, runtime, runtimes, at = "2026-11-24T09:00:00.000Z") =>
  discoverAccountRuntimes({
    homeDir,
    env: MACHINE_B,
    fetchImpl: runtime.fetchImpl,
    listRuntimesFn: async () => runtimes,
    nowMs: () => Date.parse(at),
  });

test("up writes the session record on the runtime, and another machine lists that runtime with its name and origin", async (t) => {
  const runtime = createFakeRuntime();
  const homeA = machine(t);
  const homeB = machine(t);
  await upOnMachineA(homeA, runtime, ["--gpu", "T4", "--name", "train", "--keep"]);

  assert.deepEqual(runtime.json(`${STATE_DIR}/session.json`), {
    schema: 1,
    name: "orca-colab-train",
    account: "me@example.com",
    origin: { machine: "machine-A", platform: process.platform, agent: "Claude Code", workspace: "my-repo", directory: path.resolve("/work/my-repo") },
    gpu: { name: "Tesla T4", memoryTotalMiB: 15360, driverVersion: null },
    rateKey: "T4",
    cuPerHour: 1.96,
    createdAt: "2026-11-24T08:00:00.000Z",
    keep: true,
    runtimeId: "r-7",
    project: null,
    guardrails: {
      source: "machine",
      file: null,
      allowedGpus: ["T4", "L4", "A100", "G4", "H100", "CPU"],
      maxConcurrentSessions: 2,
      monthlyBudgetCu: null,
      budgetScope: "machine",
      autoStopIdleMinutes: null,
    },
  });

  const io = makeBuffers();
  await runStatus([], { json: true, ...io, homeDir: homeB, discover: (o) => discoverFrom(o.homeDir, runtime, [LISTED]) });
  const [seen] = io.read().sessions;
  assert.deepEqual(
    { name: seen.name, origin: seen.origin, startedHere: seen.startedHere, createdAt: seen.createdAt, keep: seen.keep, rateKey: seen.rateKey, runtime: seen.colabRuntime },
    {
      name: "orca-colab-train",
      origin: { machine: "machine-A", platform: process.platform, agent: "Claude Code", workspace: "my-repo", directory: path.resolve("/work/my-repo") },
      startedHere: false,
      createdAt: "2026-11-24T08:00:00.000Z",
      keep: true,
      rateKey: "T4",
      runtime: { id: "r-7", endpoint: "r-7", baseUrl: RUNTIME.baseUrl, tokenExpiry: null },
    },
  );
  assert.equal(readSession("orca-colab-train", homeB).colabRuntime.token, "proxy-tok");
  assert.equal((await runStatus([], { json: true, ...makeBuffers(), homeDir: homeA, discover: async () => {} })) ?? 0, 0);
  assert.equal(readSession("orca-colab-train", homeA).adopted, undefined);
});

test("a runtime without a record shows as unknown origin, is never idle-stopped, and is dropped once Colab stops listing it", async (t) => {
  const runtime = createFakeRuntime();
  const homeB = machine(t);

  const first = await discoverFrom(homeB, runtime, [LISTED]);
  assert.deepEqual(first.adopted, [{ name: "orca-colab-r7", account: "default", email: "me@example.com", origin: null }]);
  const session = readSession("orca-colab-r7", homeB);
  assert.deepEqual({ adopted: session.adopted, origin: session.origin, gpu: session.gpu.name }, { adopted: true, origin: undefined, gpu: "NVIDIA T4" });
  assert.equal(
    evaluateSessionIdleState({
      session: { ...session, lastActivityAt: "2026-11-01T00:00:00.000Z" },
      gpuSamples: [0, 0, 0],
      autoStopIdleMinutes: 20,
    }).reason,
    "unknown-origin",
  );

  const second = await discoverFrom(homeB, runtime, [], "2026-11-24T09:05:00.000Z");
  assert.deepEqual(second.dropped, [{ name: "orca-colab-r7", account: "default" }]);
  assert.deepEqual(listSessions(homeB), []);
  assert.deepEqual(
    readLedgerEvents(homeB).map((e) => [e.type, e.session, e.cause ?? null]),
    [["session.start", "orca-colab-r7", null], ["session.end", "orca-colab-r7", "colab-died"]],
  );
});

test("a job submitted on one machine is listed, read live and stopped from another, with the full log on the runtime", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const runtime = createFakeRuntime({
    runJob: async ({ write, stopRequested }) => {
      write("epoch 1\n");
      await gate;
      if (stopRequested()) return 143;
      write("epoch 2\n");
      return 0;
    },
  });
  const homeA = machine(t);
  const homeB = machine(t);
  await upOnMachineA(homeA, runtime);
  await discoverFrom(homeB, runtime, [LISTED]);

  const submit = makeBuffers();
  const waiting = runJob(["submit", "--name", "train", "--wait", "--", "python", "train.py"], {
    json: true,
    ...submit,
    env: MACHINE_A,
    cwd: "/work/my-repo",
    homeDir: homeA,
    execTty: runtime.execTty,
    fetchImpl: runtime.fetchImpl,
  });
  while (runtime.launches.length === 0) await new Promise((r) => setTimeout(r, 20));
  const id = runtime.launches[0].id;

  const mirrored = { json: true, homeDir: homeB, env: MACHINE_B, fetchImpl: runtime.fetchImpl, execTty: runtime.execTty };
  const ls = makeBuffers();
  await runJob(["ls"], { ...mirrored, ...ls });
  assert.deepEqual(
    ls.read().tasks.map((x) => ({ id: x.id, name: x.name, status: x.status, session: x.sessionName, origin: x.origin, localPid: x.localPid })),
    [{ id, name: "train", status: "running", session: "orca-colab-train", origin: { machine: "machine-A", platform: process.platform, agent: "Claude Code", workspace: "my-repo", directory: path.resolve("/work/my-repo") }, localPid: null }],
  );
  const live = makeBuffers();
  await runJob(["logs", id], { ...mirrored, ...live });
  assert.match(live.read().output, /\$ python train\.py\nepoch 1\n$/);

  const stop = makeBuffers();
  await runJob(["stop", id], { ...mirrored, ...stop });
  assert.equal(runtime.text(`${STATE_DIR}/tasks/${id}.stop`), "stop\n");
  release();
  assert.equal(await waiting, 130);
  await runtime.settle();

  assert.equal(runtime.json(`${STATE_DIR}/tasks/${id}.json`).status, "stopped");
  assert.deepEqual({ status: readTask(id, homeA).status, exitCode: readTask(id, homeA).exitCode }, { status: "stopped", exitCode: 130 });
  assert.match(readTaskLog(id, homeB).text, /epoch 1\n\n\[task [\w-]+\] stopped by user at /);
});

test("down leaves a runtime that another machine is using, or whose records it cannot read, and releases it with --force", async (t) => {
  const runtime = createFakeRuntime({ colabRuntimeId: "r-7" });
  const homeA = machine(t);
  const homeB = machine(t);
  await upOnMachineA(homeA, runtime);
  await discoverFrom(homeB, runtime, [LISTED]);
  const channel = directRuntimeChannel({ baseUrl: RUNTIME.baseUrl, proxyToken: RUNTIME.token, fetchImpl: runtime.fetchImpl });
  await stampRuntimeActivity(channel, { origin: { machine: "machine-A", agent: "Claude Code" }, command: "sync", running: true, nowMs: Date.parse("2026-11-24T00:00:00.000Z") });

  const deleted = [];
  const down = (argv) => {
    const io = makeBuffers();
    return runDown(argv, {
      json: true,
      ...io,
      env: MACHINE_B,
      homeDir: homeB,
      fetchImpl: runtime.fetchImpl,
      deleteRuntimeFn: async ({ runtimeId }) => deleted.push(runtimeId),
    }).then((code) => ({ code, ...io.read() }));
  };

  const refused = await down(["--session", "orca-colab-train"]);
  assert.deepEqual(
    { code: refused.code, ok: refused.ok, released: refused.released, reason: refused.reason, inUseBy: refused.inUseBy },
    { code: 1, ok: false, released: false, reason: "in-use-elsewhere", inUseBy: [{ machine: "machine-A", agent: "Claude Code", doing: "command: sync" }] },
  );
  assert.deepEqual(deleted, []);
  assert.deepEqual(await readUseByOtherMachines(channel, "machine-A"), []);

  runtime.setUnreachable(true);
  const unknown = await down(["--session", "orca-colab-train"]);
  assert.deepEqual(
    { code: unknown.code, released: unknown.released, reason: unknown.reason, inUseBy: unknown.inUseBy },
    { code: 1, released: false, reason: "use-unknown", inUseBy: [] },
  );
  assert.deepEqual(deleted, []);

  const forced = await down(["--session", "orca-colab-train", "--force"]);
  assert.deepEqual({ code: forced.code, released: forced.released }, { code: 0, released: true });
  assert.deepEqual(deleted, ["r-7"]);
});

test("the idle rule follows the runtime's records: busy elsewhere is never idle, and the last command of any machine counts", async () => {
  const runtime = createFakeRuntime();
  const channel = directRuntimeChannel({ baseUrl: RUNTIME.baseUrl, proxyToken: RUNTIME.token, fetchImpl: runtime.fetchImpl });
  await stampRuntimeActivity(channel, { origin: { machine: "machine-A", agent: "cli" }, command: "run", running: true, nowMs: Date.parse("2026-11-24T00:00:00.000Z") });
  runtime.advance(60_000);
  const busy = await readRuntimeUsage(channel);
  assert.deepEqual(busy.busyBy, [{ machine: "machine-A", agent: "cli", command: "run" }]);

  const session = { name: "s", state: "active", keep: false, activePids: [], createdAt: "2026-11-24T00:00:00.000Z", lastActivityAt: "2026-11-24T00:00:00.000Z" };
  const idleFor = (runtimeUsage) =>
    evaluateSessionIdleState({ session, gpuSamples: [0, 0, 0], autoStopIdleMinutes: 20, nowMs: Date.parse("2026-11-24T01:00:00.000Z"), runtimeUsage });
  assert.equal(idleFor(busy).reason, "active-process");

  runtime.advance(200_000);
  const quiet = await readRuntimeUsage(channel);
  assert.deepEqual(quiet.busyBy, []);
  assert.deepEqual({ isIdle: idleFor(quiet).isIdle, reason: idleFor(quiet).reason }, { isIdle: false, reason: "recent-cli-activity" });
  assert.equal(idleFor({ ...quiet, idleMs: 25 * 60_000 }).isIdle, true);
});

test("a runtime adopted while its own up was still writing the session keeps one record, charged once", async (t) => {
  const runtime = createFakeRuntime();
  const home = machine(t);
  // Discovery saw the runtime before `up` had written its session or the record on the runtime.
  await discoverAccountRuntimes({ homeDir: home, env: MACHINE_A, fetchImpl: runtime.fetchImpl, listRuntimesFn: async () => [LISTED], nowMs: () => Date.parse("2026-11-24T07:59:59.000Z") });
  await upOnMachineA(home, runtime);
  assert.deepEqual(listSessions(home).map((s) => s.name).sort(), ["orca-colab-r7", "orca-colab-train"]);
  assert.deepEqual(distinctRuntimeSessions(listSessions(home)).map((s) => s.name), ["orca-colab-train"]);

  await discoverAccountRuntimes({ homeDir: home, env: MACHINE_A, fetchImpl: runtime.fetchImpl, listRuntimesFn: async () => [LISTED], nowMs: () => Date.parse("2026-11-24T08:01:00.000Z") });
  assert.deepEqual(listSessions(home).map((s) => s.name), ["orca-colab-train"]);
  assert.deepEqual(
    readLedgerEvents(home).filter((e) => e.session === "orca-colab-r7").map((e) => [e.type, e.at, e.cause ?? null]),
    [
      ["session.start", "2026-11-24T07:59:59.000Z", null],
      ["session.end", "2026-11-24T07:59:59.000Z", "duplicate-record"],
    ],
  );
});

test("a session missing from Colab's list is dropped only when Colab no longer answers for its runtime, with what Colab said", async (t) => {
  const runtime = createFakeRuntime();
  const home = machine(t);
  await upOnMachineA(home, runtime);
  const discover = (getRuntimeFn) =>
    discoverAccountRuntimes({ homeDir: home, env: MACHINE_A, fetchImpl: runtime.fetchImpl, listRuntimesFn: async () => [], getRuntimeFn, nowMs: () => Date.parse("2026-11-24T08:23:00.000Z") });

  await discover(async () => LISTED);
  assert.deepEqual(listSessions(home).map((s) => s.name), ["orca-colab-train"]);

  await discover(async () => {
    throw Object.assign(new Error("gone"), {
      status: 404,
      responseBody: JSON.stringify({ error: { code: 404, status: "NOT_FOUND", message: "Runtime was preempted.", details: [{ reason: "RUNTIME_PREEMPTED" }] } }),
    });
  });
  assert.deepEqual(listSessions(home), []);
  const end = readLedgerEvents(home).at(-1);
  assert.deepEqual(
    [end.type, end.session, end.cause, end.at, end.colabSaid],
    ["session.end", "orca-colab-train", "colab-died", "2026-11-24T08:23:00.000Z", "404 NOT_FOUND RUNTIME_PREEMPTED Runtime was preempted."],
  );
});
