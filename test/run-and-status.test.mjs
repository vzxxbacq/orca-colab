import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run as runLs } from "../bin/commands/ls.mjs";
import { run as runCmd } from "../bin/commands/run.mjs";
import { appendLedgerEvent } from "../bin/lib/credit-ledger.mjs";
import { writeSession } from "../bin/lib/session-store.mjs";
import { createFakeRuntime } from "./fake-colab-runtime.mjs";

function makeBuffers() {
  let out = "";
  let err = "";
  return {
    stdout: { write: (c) => { out += c; } },
    stderr: { write: (c) => { err += c; } },
    get stdoutText() { return out; },
    get stderrText() { return err; },
  };
}

const RUNTIME = { id: "r-1", endpoint: "r-1", baseUrl: "https://8080-m.colab.dev", token: "proxy-tok" };

test("run starts the command with env and remoteRoot as a job on the runtime and propagates its exit code", async (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-run-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  writeSession(
    {
      name: "orca-colab-run1",
      createdAt: "2026-11-09T10:00:00.000Z",
      remoteRoot: "/content/orca/my-repo",
      colabRuntime: RUNTIME,
    },
    tmpHome,
  );

  const started = [];
  const runtime = createFakeRuntime({
    runJob: async ({ script, record, write }) => {
      started.push({ script, cwd: record.cwd });
      write("epoch 1\n");
      return 42;
    },
  });
  const io = makeBuffers();
  const code = await runCmd(
    ["--env", "WANDB_MODE=offline", "--", "python", "train.py", "--lr", "0.001"],
    {
      json: true,
      stdout: io.stdout,
      stderr: io.stderr,
      homeDir: tmpHome,
      stdinIsTTY: false,
      execTty: runtime.execTty,
      fetchImpl: runtime.fetchImpl,
      onInterrupt: () => () => {},
    },
  );

  assert.equal(code, 42);
  assert.deepEqual(started, [
    {
      script: "export WANDB_MODE=offline && cd /content/orca/my-repo && python train.py --lr 0.001",
      cwd: "/content/orca/my-repo",
    },
  ]);
  assert.deepEqual(runtime.launches.map(({ baseUrl, proxyToken }) => ({ baseUrl, proxyToken })), [
    { baseUrl: "https://8080-m.colab.dev", proxyToken: "proxy-tok" },
  ]);
  const out = JSON.parse(io.stdoutText);
  assert.deepEqual({ ok: out.ok, exitCode: out.exitCode, stdout: out.stdout }, { ok: false, exitCode: 42, stdout: "epoch 1" });
});

test("run on a session from the Tailscale era says to restart it", async (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-run-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));
  writeSession({ name: "orca-colab-old", ip: "100.64.0.55", createdAt: "2026-11-09T10:00:00.000Z" }, tmpHome);

  const io = makeBuffers();
  await assert.rejects(
    runCmd(["--", "nvidia-smi"], { json: true, ...io, homeDir: tmpHome, execTty: async () => assert.fail("tty used") }),
    /orca-colab down --session orca-colab-old/,
  );
});

test("status and ls report reachability and ageSeconds in JSON without the runtime proxy token", async (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-status-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  writeSession(
    {
      name: "orca-colab-s1",
      gpu: { name: "Tesla T4", memoryMiB: 15360 },
      rateKey: "T4",
      cuPerHour: 1.96,
      createdAt: "2026-11-09T10:00:00.000Z",
      transport: "colab-tty",
      colabRuntime: RUNTIME,
    },
    tmpHome,
  );

  const io = makeBuffers();
  const code = await runLs([], {
    json: true,
    stdout: io.stdout,
    stderr: io.stderr,
    homeDir: tmpHome,
    nowMs: () => Date.parse("2026-11-09T10:05:30.000Z"),
  });

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(io.stdoutText), {
    sessions: [
      {
        name: "orca-colab-s1",
        account: "default",
        hostname: "orca-colab-s1",
        gpu: { name: "Tesla T4", memoryMiB: 15360 },
        rateKey: "T4",
        cuPerHour: 1.96,
        createdAt: "2026-11-09T10:00:00.000Z",
        lastActivityAt: "2026-11-09T10:00:00.000Z",
        activePids: [],
        keep: false,
        state: "active",
        remoteRoot: null,
        transport: "colab-tty",
        colabRuntime: { id: "r-1", endpoint: "r-1", baseUrl: "https://8080-m.colab.dev", tokenExpiry: null },
        forwards: [],
        origin: null,
        startedHere: true,
        reachable: true,
        ageSeconds: 330,
      },
    ],
    recentlyEnded: [],
  });
});

test("status says when and why a session ended, newest first, for the last 24 hours", async (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-status-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));
  for (const [at, session, cause] of [
    ["2026-11-08T09:00:00.000Z", "orca-colab-old", "user"],
    ["2026-11-09T09:00:00.000Z", "orca-colab-a", "user"],
    ["2026-11-09T09:01:00.000Z", "orca-colab-a", "colab-died"],
    ["2026-11-09T09:30:00.000Z", "orca-colab-b", "idle-watchdog"],
    ["2026-11-09T09:58:00.744Z", "orca-colab-h3", "colab-died"],
  ]) {
    appendLedgerEvent({ type: "session.end", at, account: "default", session, cause }, tmpHome);
  }

  const io = makeBuffers();
  await runLs([], { json: true, stdout: io.stdout, stderr: io.stderr, homeDir: tmpHome, nowMs: () => Date.parse("2026-11-09T10:00:00.000Z") });
  assert.deepEqual(JSON.parse(io.stdoutText), {
    sessions: [],
    recentlyEnded: [
      {
        session: "orca-colab-h3",
        account: "default",
        endedAt: "2026-11-09T09:58:00.744Z",
        cause: "colab-died",
        reason:
          "Colab no longer had this runtime assigned, so the local session was dropped. This machine did not release it: it was released from another machine or ended on Colab's side (its web UI, an idle or lifetime limit, or Colab reclaiming it).",
      },
      {
        session: "orca-colab-b",
        account: "default",
        endedAt: "2026-11-09T09:30:00.000Z",
        cause: "idle-watchdog",
        reason: "Released by the idle auto-stop: no command, job or GPU load for the configured time.",
      },
      {
        session: "orca-colab-a",
        account: "default",
        endedAt: "2026-11-09T09:00:00.000Z",
        cause: "user",
        reason: "Released with 'down' (CLI, MCP or the panel's Stop button).",
      },
    ],
  });
});
