import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run as runLs } from "../bin/commands/ls.mjs";
import { run as runCmd } from "../bin/commands/run.mjs";
import { writeSession } from "../bin/lib/session-store.mjs";

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

test("run sends the command with env and remoteRoot over /colab/tty and propagates the remote exit code", async (t) => {
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

  const calls = [];
  const io = makeBuffers();
  const code = await runCmd(
    ["--env", "WANDB_MODE=offline", "--", "python", "train.py", "--lr", "0.001"],
    {
      json: false,
      stdout: io.stdout,
      stderr: io.stderr,
      homeDir: tmpHome,
      stdinIsTTY: false,
      execTty: async ({ baseUrl, proxyToken, command, cwd }) => {
        calls.push({ baseUrl, proxyToken, command, cwd });
        return { ok: false, exitCode: 42, stdout: "", stderr: "" };
      },
    },
  );

  assert.equal(code, 42);
  assert.deepEqual(calls, [
    {
      baseUrl: "https://8080-m.colab.dev",
      proxyToken: "proxy-tok",
      command: "export WANDB_MODE=offline && cd /content/orca/my-repo && python train.py --lr 0.001",
      cwd: "/content/orca/my-repo",
    },
  ]);
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
        reachable: true,
        ageSeconds: 330,
      },
    ],
  });
});
