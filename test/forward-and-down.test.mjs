import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run as runDown } from "../bin/commands/down.mjs";
import { run as runForward } from "../bin/commands/forward.mjs";
import { withSessionActivity } from "../bin/lib/session-activity.mjs";
import { readSession, writeSession } from "../bin/lib/session-store.mjs";

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

test("forward records background ssh pid and --stop terminates and removes it", async (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-fwd-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  writeSession(
    {
      name: "orca-colab-fwd1",
      ip: "100.64.0.80",
      createdAt: "2026-11-09T10:00:00.000Z",
    },
    tmpHome,
  );

  const spawned = [];
  const killed = [];
  const io = makeBuffers();

  const code = await runForward(["6006:6007"], {
    json: true,
    stdout: io.stdout,
    stderr: io.stderr,
    homeDir: tmpHome,
    spawnDetached: (bin, args) => {
      spawned.push({ bin, args });
      return { pid: 54321 };
    },
    killPid: (pid) => {
      killed.push(pid);
      return true;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(io.stdoutText), {
    ok: true,
    session: "orca-colab-fwd1",
    port: 6006,
    remotePort: 6007,
    pid: 54321,
    url: "http://localhost:6006",
  });
  assert.deepEqual(readSession("orca-colab-fwd1", tmpHome).forwards, [
    { port: 6006, remotePort: 6007, pid: 54321 },
  ]);

  const stopIo = makeBuffers();
  const stopCode = await runForward(["--stop", "6006"], {
    json: true,
    stdout: stopIo.stdout,
    stderr: stopIo.stderr,
    homeDir: tmpHome,
    killPid: (pid) => {
      killed.push(pid);
      return true;
    },
  });

  assert.equal(stopCode, 0);
  assert.deepEqual(killed, [54321]);
  assert.deepEqual(readSession("orca-colab-fwd1", tmpHome).forwards, []);
});

test("down kills forwards, touches unassign sentinel, deletes session when port 22 closes, and marks zombie (exit 4) when port 22 stays open", async (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-down-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  writeSession(
    {
      name: "orca-colab-d1",
      ip: "100.64.0.90",
      createdAt: "2026-11-09T10:00:00.000Z",
      forwards: [{ port: 8888, remotePort: 8888, pid: 11111 }],
    },
    tmpHome,
  );

  const killed = [];
  const sshCalls = [];
  const io1 = makeBuffers();

  const zombieCode = await runDown([], {
    json: true,
    stdout: io1.stdout,
    stderr: io1.stderr,
    homeDir: tmpHome,
    killPid: (pid) => {
      killed.push(pid);
      return true;
    },
    runSsh: (bin, args) => {
      sshCalls.push({ bin, args });
      return { status: 0, stdout: "", stderr: "" };
    },
    waitPortClosed: async () => false,
    nowIso: () => "2026-11-09T11:00:00.000Z",
  });

  assert.equal(zombieCode, 4);
  assert.deepEqual(killed, [11111]);
  assert.equal(
    sshCalls[0].args.at(-1),
    "mkdir -p /root/.orca-colab && touch /root/.orca-colab/unassign",
  );
  const zombieSession = readSession("orca-colab-d1", tmpHome);
  assert.equal(zombieSession.state, "zombie");
  assert.deepEqual(zombieSession.forwards, []);
  assert.deepEqual(JSON.parse(io1.stdoutText), {
    ok: false,
    session: "orca-colab-d1",
    released: false,
    state: "zombie",
    reason: "port-22-still-open",
    action:
      "Open the Colab notebook tab and choose Runtime -> Disconnect and delete runtime.",
  });

  const io2 = makeBuffers();
  const releaseCode = await runDown([], {
    json: true,
    stdout: io2.stdout,
    stderr: io2.stderr,
    homeDir: tmpHome,
    runSsh: () => ({ status: 0, stdout: "", stderr: "" }),
    waitPortClosed: async () => true,
  });

  assert.equal(releaseCode, 0);
  assert.equal(readSession("orca-colab-d1", tmpHome), null);
  assert.deepEqual(JSON.parse(io2.stdoutText), {
    ok: true,
    session: "orca-colab-d1",
    released: true,
  });

  const io3 = makeBuffers();
  const alreadyGoneCode = await runDown([], {
    json: true,
    stdout: io3.stdout,
    stderr: io3.stderr,
    homeDir: tmpHome,
  });
  assert.equal(alreadyGoneCode, 0);
  assert.deepEqual(JSON.parse(io3.stdoutText), {
    ok: true,
    session: null,
    released: true,
    reason: "already-gone",
  });
});

test("withSessionActivity records activePid during execution and removes it on exit", async (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-act-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  writeSession(
    {
      name: "orca-colab-act1",
      ip: "100.64.0.95",
      createdAt: "2026-11-09T10:00:00.000Z",
    },
    tmpHome,
  );

  let ticks = 0;
  let midSession = null;
  await withSessionActivity(
    "orca-colab-act1",
    tmpHome,
    async () => {
      midSession = readSession("orca-colab-act1", tmpHome);
    },
    {
      pid: 77777,
      nowIso: () => {
        ticks += 1;
        return `2026-11-09T10:0${ticks}:00.000Z`;
      },
    },
  );

  assert.deepEqual(midSession.activePids, [77777]);
  assert.equal(midSession.lastActivityAt, "2026-11-09T10:01:00.000Z");

  const afterSession = readSession("orca-colab-act1", tmpHome);
  assert.deepEqual(afterSession.activePids, []);
  assert.equal(afterSession.lastActivityAt, "2026-11-09T10:02:00.000Z");
});
