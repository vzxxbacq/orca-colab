import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run as runDown } from "../bin/commands/down.mjs";
import { resolveOAuthClientConfig, saveOAuthCredentials } from "../bin/lib/colab-oauth.mjs";
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

function runtimeSession(name, id) {
  return {
    name,
    createdAt: "2026-11-09T10:00:00.000Z",
    transport: "colab-tty",
    colabRuntime: { id, endpoint: id, baseUrl: "https://8080-x.colab.dev", token: "proxy" },
  };
}

test("down releases through the Colab API, marks a zombie (exit 4) when the API refuses, and drops pre-API sessions", async (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-down-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));
  saveOAuthCredentials(
    "default",
    {
      refreshToken: "r",
      accessToken: "a",
      expiryDate: Date.now() + 3_600_000,
      clientId: resolveOAuthClientConfig(tmpHome).clientId,
    },
    tmpHome,
  );
  const deleted = [];
  const deleteRuntimeFn = async ({ runtimeId }) => {
    if (runtimeId === "r-refused") throw new Error("403");
    deleted.push(runtimeId);
  };
  const common = { json: true, homeDir: tmpHome, deleteRuntimeFn, onSessionEnd: null };

  writeSession(runtimeSession("orca-colab-ok", "r-ok"), tmpHome);
  const io1 = makeBuffers();
  assert.equal(await runDown(["--session", "orca-colab-ok"], { ...common, ...io1 }), 0);
  assert.deepEqual(deleted, ["r-ok"]);
  assert.equal(readSession("orca-colab-ok", tmpHome), null);

  writeSession(runtimeSession("orca-colab-stuck", "r-refused"), tmpHome);
  const io2 = makeBuffers();
  assert.equal(await runDown(["--session", "orca-colab-stuck"], { ...common, ...io2 }), 4);
  assert.equal(JSON.parse(io2.stdoutText).reason, "api-delete-failed");
  assert.equal(readSession("orca-colab-stuck", tmpHome).state, "zombie");

  writeSession({ name: "orca-colab-legacy", ip: "100.64.0.90", createdAt: "2026-11-09T10:00:00.000Z" }, tmpHome);
  const io3 = makeBuffers();
  assert.equal(await runDown(["--session", "orca-colab-legacy"], { ...common, ...io3 }), 0);
  assert.equal(readSession("orca-colab-legacy", tmpHome), null);
});

test("withSessionActivity records activePid during execution and removes it on exit", async (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-act-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  writeSession(
    {
      name: "orca-colab-act1",
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
