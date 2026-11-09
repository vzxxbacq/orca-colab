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

test("run defaults to session remoteRoot, adds -tt on TTY and propagates remote exit code", async (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-run-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  writeSession(
    {
      name: "orca-colab-run1",
      ip: "100.64.0.55",
      createdAt: "2026-11-09T10:00:00.000Z",
      remoteRoot: "/content/orca/my-repo",
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
      stdinIsTTY: true,
      spawnSsh: (bin, args, opts) => {
        calls.push({ bin, args, stdio: opts.stdio });
        return { status: 42 };
      },
    },
  );

  assert.equal(code, 42);
  assert.deepEqual(calls, [
    {
      bin: "ssh",
      args: [
        "-i",
        path.join(tmpHome, ".orca-colab", "id_ed25519"),
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        `UserKnownHostsFile=${path.join(tmpHome, ".orca-colab", "known_hosts")}`,
        "-o",
        "ConnectTimeout=10",
        "-tt",
        "root@100.64.0.55",
        "export WANDB_MODE=offline && cd /content/orca/my-repo && python train.py --lr 0.001",
      ],
      stdio: "inherit",
    },
  ]);
});

test("status and ls report session reachability and ageSeconds in JSON", async (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-status-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  writeSession(
    {
      name: "orca-colab-s1",
      ip: "100.64.0.70",
      gpu: { name: "Tesla T4", memoryMiB: 15360 },
      rateKey: "T4",
      cuPerHour: 1.96,
      createdAt: "2026-11-09T10:00:00.000Z",
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
    probeOnce: async ({ host }) => ({ ok: host === "100.64.0.70" }),
  });

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(io.stdoutText), {
    sessions: [
      {
        name: "orca-colab-s1",
        account: "default",
        hostname: "orca-colab-s1",
        ip: "100.64.0.70",
        gpu: { name: "Tesla T4", memoryMiB: 15360 },
        rateKey: "T4",
        cuPerHour: 1.96,
        createdAt: "2026-11-09T10:00:00.000Z",
        lastActivityAt: "2026-11-09T10:00:00.000Z",
        activePids: [],
        keep: false,
        state: "active",
        remoteRoot: null,
        forwards: [],
        reachable: true,
        ageSeconds: 330,
      },
    ],
  });
});
