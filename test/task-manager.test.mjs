import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run as runJob } from "../bin/commands/job.mjs";
import { writeSession } from "../bin/lib/session-store.mjs";
import { readTask, readTaskLog } from "../bin/lib/task-store.mjs";

function makeTempHome() {
  return mkdtempSync(path.join(os.tmpdir(), "orca-colab-job-test-"));
}

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

test("job submit --wait streams live output to task log and records succeeded status", async () => {
  const homeDir = makeTempHome();
  try {
    writeSession(
      {
        name: "orca-colab-t401",
        account: "default",
        hostname: "orca-colab-t401",
        colabRuntime: { id: "r-1", endpoint: "r-1", baseUrl: "https://8080-m.colab.dev", token: "proxy-tok" },
        gpu: { name: "Tesla T4", memoryTotalMiB: 15360 },
        rateKey: "T4",
        cuPerHour: 1.96,
        createdAt: "2026-11-09T12:00:00.000Z",
        lastActivityAt: "2026-11-09T12:00:00.000Z",
        state: "active",
      },
      homeDir,
    );

    const fakeTty = async ({ onOutput }) => {
      onOutput("Epoch 1/2: loss=0.412\n");
      onOutput("Epoch 2/2: loss=0.189\n");
      return { ok: true, exitCode: 0, stdout: "" };
    };

    const submitIo = makeBuffers();
    const code = await runJob(
      ["submit", "--name", "Train ResMLP", "--wait", "--", "python3", "train.py"],
      {
        json: true,
        stdout: submitIo.stdout,
        stderr: submitIo.stderr,
        homeDir,
        execTty: fakeTty,
      },
    );

    assert.equal(code, 0);
    const submitRes = JSON.parse(submitIo.stdoutText);
    assert.equal(submitRes.ok, true);
    assert.equal(submitRes.task.name, "Train ResMLP");
    assert.equal(submitRes.task.status, "succeeded");
    assert.equal(submitRes.task.exitCode, 0);
    assert.match(submitRes.output, /Epoch 1\/2: loss=0\.412/);
    assert.match(submitRes.output, /Epoch 2\/2: loss=0\.189/);

    const lsIo = makeBuffers();
    await runJob(["ls"], {
      json: true,
      stdout: lsIo.stdout,
      stderr: lsIo.stderr,
      homeDir,
    });
    const lsRes = JSON.parse(lsIo.stdoutText);
    assert.equal(lsRes.tasks.length, 1);
    assert.equal(lsRes.tasks[0].id, submitRes.task.id);

    const logsIo = makeBuffers();
    await runJob(["logs", submitRes.task.id], {
      json: true,
      stdout: logsIo.stdout,
      stderr: logsIo.stderr,
      homeDir,
    });
    const logsRes = JSON.parse(logsIo.stdoutText);
    assert.equal(logsRes.ok, true);
    assert.match(logsRes.output, /Epoch 2\/2: loss=0\.189/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("job submit detached and job stop marks task stopped and kills remote process", async () => {
  const homeDir = makeTempHome();
  try {
    writeSession(
      {
        name: "orca-colab-t402",
        account: "default",
        hostname: "orca-colab-t402",
        colabRuntime: { id: "r-2", endpoint: "r-2", baseUrl: "https://8080-n.colab.dev", token: "proxy-tok" },
        gpu: { name: "Tesla T4", memoryTotalMiB: 15360 },
        rateKey: "T4",
        cuPerHour: 1.96,
        createdAt: "2026-11-09T12:00:00.000Z",
        lastActivityAt: "2026-11-09T12:00:00.000Z",
        state: "active",
      },
      homeDir,
    );

    const submitIo = makeBuffers();
    const code = await runJob(
      ["submit", "--name", "Long Training", "--", "python3", "long_train.py"],
      {
        json: true,
        stdout: submitIo.stdout,
        stderr: submitIo.stderr,
        homeDir,
        spawnChild: () => ({
          pid: process.pid,
          unref() {},
        }),
      },
    );

    assert.equal(code, 0);
    const submitRes = JSON.parse(submitIo.stdoutText);
    assert.equal(submitRes.task.status, "running");

    let remoteKilledCmd = null;
    const stopIo = makeBuffers();
    const stopCode = await runJob(["stop", submitRes.task.id], {
      json: true,
      stdout: stopIo.stdout,
      stderr: stopIo.stderr,
      homeDir,
      execTty: async ({ command }) => {
        remoteKilledCmd = command;
        return { ok: true, exitCode: 0, stdout: "" };
      },
    });

    assert.equal(stopCode, 0);
    const stopRes = JSON.parse(stopIo.stdoutText);
    assert.equal(stopRes.task.status, "stopped");
    assert.equal(stopRes.task.exitCode, 130);
    assert.match(remoteKilledCmd, new RegExp(`ORCA_TASK_ID=${submitRes.task.id}`));

    const stored = readTask(submitRes.task.id, homeDir);
    assert.equal(stored.status, "stopped");
    const logSnap = readTaskLog(submitRes.task.id, homeDir);
    assert.match(logSnap.text, /stopped by user/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
