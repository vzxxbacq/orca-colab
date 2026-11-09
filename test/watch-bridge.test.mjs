import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FrameAssembler } from "../bin/lib/bridge-frames.mjs";
import { readLedgerEvents } from "../bin/lib/credit-ledger.mjs";
import { parseControlLine, snapshotFingerprint } from "../bin/commands/watch.mjs";

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
