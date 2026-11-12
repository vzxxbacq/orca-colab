import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run as runPull } from "../bin/commands/pull.mjs";
import { run as runSync } from "../bin/commands/sync.mjs";
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

function tmpDir(t, prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const RUNTIME = { id: "r-1", endpoint: "r-1", baseUrl: "https://8080-m.colab.dev", token: "proxy-tok" };

test("sync unpacks the workspace over /colab/tty and records remoteRoot in the session file", async (t) => {
  const tmpHome = tmpDir(t, "orca-colab-sync-");
  writeSession({ name: "orca-colab-sync1", createdAt: "2026-11-09T10:00:00.000Z", colabRuntime: RUNTIME }, tmpHome);

  const ttyCalls = [];
  const io = makeBuffers();
  const code = await runSync(["."], {
    json: true,
    stdout: io.stdout,
    stderr: io.stderr,
    env: {},
    cwd: "/Users/alice/workspace/toy-train",
    homeDir: tmpHome,
    spawnProcess: () => ({ status: 0, stdout: Buffer.from("tar-bytes"), stderr: Buffer.alloc(0) }),
    execTty: async (req) => {
      ttyCalls.push(req);
      return { ok: true, exitCode: 0, stdout: "" };
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(io.stdoutText), {
    ok: true,
    session: "orca-colab-sync1",
    localPath: "/Users/alice/workspace/toy-train",
    remoteRoot: "/content/orca/toy-train",
    method: "colab-tty-tar",
  });
  assert.equal(ttyCalls[0].command, "mkdir -p /content/orca/toy-train && tar -xzf - -C /content/orca/toy-train");
  assert.equal(ttyCalls[0].stdinBase64, Buffer.from("tar-bytes").toString("base64"));
  assert.equal(readSession("orca-colab-sync1", tmpHome).remoteRoot, "/content/orca/toy-train");
});

test("pull packs the remote path, downloads it from Jupyter /files with the proxy token and unpacks binary data intact", async (t) => {
  const tmpHome = tmpDir(t, "orca-colab-pull-home-");
  const remoteSide = tmpDir(t, "orca-colab-pull-remote-");
  const localSide = tmpDir(t, "orca-colab-pull-local-");
  writeSession(
    { name: "orca-colab-pull1", createdAt: "2026-11-09T10:00:00.000Z", remoteRoot: "/content/orca/proj", colabRuntime: RUNTIME },
    tmpHome,
  );
  const blob = Buffer.from([0, 255, 10, 13, 0x1f, 0x8b, 200, 1, 2, 3]);
  mkdirSync(path.join(remoteSide, "out"));
  writeFileSync(path.join(remoteSide, "out", "weights.bin"), blob);
  const archive = path.join(remoteSide, "archive.tar.gz");
  assert.equal(spawnSync("tar", ["-czf", archive, "-C", remoteSide, "out"]).status, 0);

  const ttyCommands = [];
  const fetched = [];
  const io = makeBuffers();
  const code = await runPull(["out", "results"], {
    json: true,
    stdout: io.stdout,
    stderr: io.stderr,
    cwd: localSide,
    homeDir: tmpHome,
    execTty: async ({ command }) => {
      ttyCommands.push(command);
      return { ok: true, exitCode: 0, stdout: "" };
    },
    fetchImpl: async (url, init) => {
      fetched.push({ url, token: init.headers["X-Colab-Runtime-Proxy-Token"] });
      return new Response(readFileSync(archive));
    },
  });

  assert.equal(code, 0);
  assert.match(ttyCommands[0], /^tar -czf \/tmp\/orca-colab-pull-[0-9a-f]{12}\.tar\.gz -C \/content\/orca\/proj out$/);
  const archivePath = ttyCommands[0].split(" ")[2];
  assert.deepEqual(fetched, [{ url: `https://8080-m.colab.dev/files${archivePath}`, token: "proxy-tok" }]);
  assert.equal(ttyCommands[1], `rm -f ${archivePath}`);
  assert.deepEqual(readFileSync(path.join(localSide, "results", "out", "weights.bin")), blob);
  assert.equal(JSON.parse(io.stdoutText).method, "jupyter-files");
});
