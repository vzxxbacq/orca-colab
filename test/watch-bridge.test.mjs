import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FrameAssembler } from "../bin/lib/bridge-frames.mjs";
import { readLedgerEvents } from "../bin/lib/credit-ledger.mjs";
import { sealForRecipient } from "../bin/lib/credential-envelope.mjs";
import { readOAuthStore } from "../bin/lib/colab-oauth.mjs";
import { parseControlLine, parseControlLines, snapshotFingerprint } from "../bin/commands/watch.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "orca-colab.mjs");

test("parseControlLine decodes call lines and rejects garbage", () => {
  const b64 = Buffer.from(JSON.stringify({ budgetCu: 50 })).toString("base64");
  assert.deepEqual(parseControlLine(`call r1 setBudget ${b64}`), {
    verb: "call",
    reqId: "r1",
    action: "setBudget",
    input: { budgetCu: 50 },
  });
  assert.deepEqual(parseControlLine("select task-1"), { verb: "select", taskId: "task-1" });
  assert.equal(parseControlLine("rm -rf /"), null);
  assert.equal(parseControlLine("call r2"), null);
});

test("snapshotFingerprint changes only when panel-visible state changes", () => {
  const base = {
    tasks: [{ id: "t1", status: "running", exitCode: null, finishedAt: null }],
    sessions: [{ name: "s1", state: "active", keep: false, liveMetrics: null }],
    activeTaskOutput: { taskId: "t1", totalBytes: 10, status: "running" },
    authByAccount: { default: { account: "default", authenticated: true } },
    credits: { estimatedBalanceCu: 100, budgetCu: null },
    provisioning: { active: false, message: null, error: null },
    policy: { allowedGpus: ["T4"] },
  };
  const a = snapshotFingerprint(base);
  assert.equal(snapshotFingerprint({ ...base, rates: { T4: 2 } }), a);
  assert.notEqual(
    snapshotFingerprint({ ...base, activeTaskOutput: { ...base.activeTaskOutput, totalBytes: 11 } }),
    a,
  );
});

test("watch answers a call over stdin with a res frame and emits snap frames", async (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-watch-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));
  // HOME is not consulted by the CLI (os.homedir() is), so the test passes the home through the
  // override hook of main() by spawning node with an inline import.
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { main } from ${JSON.stringify(CLI)}; await main(["watch", "--no-watchdog"], { homeDir: ${JSON.stringify(tmpHome)} }); process.exit(0);`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  t.after(() => child.kill("SIGKILL"));

  const assembler = new FrameAssembler();
  const frames = [];
  let resolveRes;
  const resPromise = new Promise((r) => (resolveRes = r));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const f of assembler.ingest(chunk)) {
      frames.push(f);
      if (f.kind === "res") resolveRes(f);
    }
  });

  const b64 = Buffer.from(JSON.stringify({ budgetCu: 42 })).toString("base64");
  child.stdin.write(`call req1 setBudget ${b64}\n`);
  const res = await Promise.race([
    resPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("no res frame within 15s")), 15_000)),
  ]);
  assert.equal(res.payload.reqId, "req1");
  assert.equal(res.payload.ok, true, JSON.stringify(res.payload));

  const budgetEvents = readLedgerEvents(tmpHome).filter((e) => e.type === "budget.set");
  assert.equal(budgetEvents.length, 1);
  assert.equal(budgetEvents[0].budgetCu, 42);

  const unknown = new Promise((r) => {
    child.stdout.on("data", () => {
      const f = frames.find((x) => x.kind === "res" && x.payload.reqId === "req2");
      if (f) r(f);
    });
  });
  const batchB64 = Buffer.from(JSON.stringify({ ops: [{ id: "x1", action: "setBudget", input: { budgetCu: 43 } }, { id: "x2", action: "nope", input: {} }], live: false })).toString("base64");
  const batchRes = new Promise((r) => {
    child.stdout.on("data", () => {
      const f = frames.find((x) => x.kind === "res" && x.payload.reqId === "b1" && !x.payload.partial);
      if (f) r(f);
    });
  });
  child.stdin.write(`batch b1 ${batchB64} ;;\n`);
  const batch = await Promise.race([
    batchRes,
    new Promise((_, rej) => setTimeout(() => rej(new Error("no batch res within 10s")), 10_000)),
  ]);
  assert.equal(batch.payload.ok, false);
  assert.deepEqual(batch.payload.results.map((r) => [r.id, r.ok]), [["x1", true], ["x2", false]]);
  const partials = frames.filter((x) => x.kind === "res" && x.payload.reqId === "b1" && x.payload.partial);
  assert.equal(partials.length, 2, "one partial frame per op");
  assert.equal(readLedgerEvents(tmpHome).filter((e) => e.type === "budget.set").at(-1).budgetCu, 43);

  // Credentials sealed to the key the snapshot advertises land in the server's store as plaintext.
  const snapFrame = frames.find((f) => f.kind === "snap" && f.payload.origin?.sealKey);
  assert.ok(snapFrame, "snapshot advertises a seal key");
  const envelope = sealForRecipient(snapFrame.payload.origin.sealKey, {
    refreshToken: "1//0test-refresh",
    accessToken: "ya29.test",
    expiryDate: Date.now() + 3600_000,
    email: "pytest@example.com",
    name: "Py Test",
  });
  const importB64 = Buffer.from(JSON.stringify({ account: "default", addAccount: false, envelope })).toString("base64");
  const importRes = new Promise((r) => {
    child.stdout.on("data", () => {
      const f = frames.find((x) => x.kind === "res" && x.payload.reqId === "imp1");
      if (f) r(f);
    });
  });
  child.stdin.write(`call imp1 authImport ${importB64} ;;\n`);
  const imported = await Promise.race([
    importRes,
    new Promise((_, rej) => setTimeout(() => rej(new Error("no authImport res within 10s")), 10_000)),
  ]);
  assert.equal(imported.payload.ok, true, JSON.stringify(imported.payload));
  assert.equal(readOAuthStore(tmpHome).accounts.default.refreshToken, "1//0test-refresh");
  assert.equal(readOAuthStore(tmpHome).accounts.default.email, "pytest@example.com");

  child.stdin.write("call req2 nope e30=\n");
  const bad = await Promise.race([
    unknown,
    new Promise((_, rej) => setTimeout(() => rej(new Error("no error res within 10s")), 10_000)),
  ]);
  assert.equal(bad.payload.ok, false);
  assert.match(bad.payload.error, /unknown action/);
  assert.ok(frames.some((f) => f.kind === "snap" && Array.isArray(f.payload.tasks)));

  child.stdin.write("quit\n");
  await new Promise((r) => child.once("exit", r));
});

test("isRemoteHostId treats Orca's own machine ('local', null, '') as local", async () => {
  const { isRemoteHostId } = await import("../worker/main.mjs");
  assert.equal(isRemoteHostId(null), false);
  assert.equal(isRemoteHostId(""), false);
  assert.equal(isRemoteHostId("local"), false);
  assert.equal(isRemoteHostId("Local"), false);
  assert.equal(isRemoteHostId("host_7f3a"), true);
});

test("pickWorktreeRow prefers the live row whose name and branch both match", async () => {
  const { pickWorktreeRow } = await import("../worker/main.mjs");
  const rows = [
    { id: "a", displayName: "main", branch: "main", isArchived: false },
    { id: "b", displayName: "main", branch: "main", isArchived: true },
    { id: "c", displayName: "remote-host-bridge", branch: "remote-host-bridge", isArchived: false },
    { id: "d", displayName: "main", branch: "feat/x", isArchived: false },
  ];
  assert.equal(pickWorktreeRow(rows, { workspaceName: "main", branch: "main" }).id, "a");
  assert.equal(pickWorktreeRow(rows, { workspaceName: "remote-host-bridge", branch: "remote-host-bridge" }).id, "c");
  assert.equal(pickWorktreeRow(rows, { workspaceName: "main", branch: null }), null);
  assert.equal(pickWorktreeRow(rows, { workspaceName: "nope", branch: "main" }), null);
});

test("parseControlLines splits commands that two clients merged into one line", () => {
  const b64 = Buffer.from(JSON.stringify({ budgetCu: 5 })).toString("base64");
  const merged = `call r9 setBudget ${b64} ;;live 0 ;;`;
  assert.deepEqual(parseControlLines(merged), [
    { verb: "call", reqId: "r9", action: "setBudget", input: { budgetCu: 5 } },
    { verb: "live", on: false },
  ]);
  assert.deepEqual(parseControlLines(`live 1 ;;call r2 ping x ;;`).map((c) => c.verb), ["live", "call"]);
  assert.deepEqual(parseControlLines("snap"), [{ verb: "snap" }]);
  assert.deepEqual(parseControlLines(`call r3 setBudget ${b64}`), [
    { verb: "call", reqId: "r3", action: "setBudget", input: { budgetCu: 5 } },
  ]);
});

test("parseControlLines decodes a batch and splits merged lines from two clients", () => {
  const b64 = Buffer.from(JSON.stringify({ ops: [{ id: "o1", action: "setBudget", input: { budgetCu: 5 } }], live: true })).toString("base64");
  const merged = `batch b1 ${b64} ;;live 0 ;;`;
  const parsed = parseControlLines(merged);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].verb, "batch");
  assert.equal(parsed[0].reqId, "b1");
  assert.deepEqual(parsed[0].ops, [{ id: "o1", action: "setBudget", input: { budgetCu: 5 } }]);
  assert.equal(parsed[0].control.live, true);
  assert.deepEqual(parsed[1], { verb: "live", on: false });
});

test("coalesceOps keeps the last value per setting and cancels paired toggles", async () => {
  const { coalesceOps, applyOptimisticOps } = await import("../worker/main.mjs");
  const mk = (action, input) => ({ id: Math.random().toString(36), action, input, resolve: () => {}, optimistic: true });
  let q = [];
  q = coalesceOps(q, mk("setBudget", { budgetCu: 10 }));
  q = coalesceOps(q, mk("setBudget", { budgetCu: 20 }));
  q = coalesceOps(q, mk("toggleKeep", { session: "s1" }));
  q = coalesceOps(q, mk("toggleKeep", { session: "s1" }));
  q = coalesceOps(q, mk("submitTask", { command: "a" }));
  q = coalesceOps(q, mk("submitTask", { command: "b" }));
  assert.deepEqual(q.map((o) => o.action), ["setBudget", "submitTask", "submitTask"]);
  assert.equal(q[0].input.budgetCu, 20);

  const snap = {
    defaultAccount: "default",
    credits: { budgetCu: null, estimatedBalanceCu: 100 },
    creditsByAccount: { default: { budgetCu: null, estimatedBalanceCu: 100 } },
    policy: { allowedGpus: ["T4"], maxConcurrentSessions: 1 },
    sessions: [{ name: "s1", keep: false }],
    tasks: [{ id: "t1", status: "running" }, { id: "t2", status: "succeeded" }],
  };
  const out = applyOptimisticOps(snap, [
    mk("setBudget", { budgetCu: 20 }),
    mk("updatePolicy", { allowedGpus: ["t4", "l4"] }),
    mk("toggleKeep", { session: "s1" }),
    mk("clearFinishedTasks", {}),
  ]);
  assert.equal(out.credits.budgetCu, 20);
  assert.deepEqual(out.policy.allowedGpus, ["T4", "L4"]);
  assert.equal(out.sessions[0].keep, true);
  assert.deepEqual(out.tasks.map((t) => t.id), ["t1"]);
  assert.equal(snap.credits.budgetCu, null, "input snapshot is not mutated");
});
