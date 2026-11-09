import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run as runUp } from "../bin/commands/up.mjs";
import { getColabPaths, writeConfig } from "../bin/lib/colab-home.mjs";
import { readSession } from "../bin/lib/session-store.mjs";
import { buildSshExecArgs } from "../bin/lib/ssh-exec.mjs";

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

test("buildSshExecArgs produces the required strict SSH argv", () => {
  const args = buildSshExecArgs({
    ip: "100.64.0.42",
    remoteCommand: ["nvidia-smi", "-L"],
    homeDir: "/Users/alice",
  });
  assert.deepEqual(args, [
    "-i",
    "/Users/alice/.orca-colab/id_ed25519",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "UserKnownHostsFile=/Users/alice/.orca-colab/known_hosts",
    "-o",
    "ConnectTimeout=10",
    "root@100.64.0.42",
    "nvidia-smi",
    "-L",
  ]);
});

test("up orchestrates peer discovery, SSH probe, GPU query, clipboard fallback and writes exact session JSON", async (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-up-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  const secretKey = "tskey-auth-kUpSecret888";
  const pubKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIUpTest orca-colab";
  writeConfig(
    {
      authKey: secretKey,
      authKeyCreatedAt: "2026-11-09T00:00:00.000Z",
    },
    tmpHome,
  );
  const paths = getColabPaths(tmpHome);
  writeFileSync(paths.privateKeyPath, "PRIV\n", { mode: 0o600 });
  writeFileSync(paths.publicKeyPath, `${pubKey}\n`, { mode: 0o644 });

  let statusCall = 0;
  let copiedLine = null;
  let openedUrl = null;
  const io = makeBuffers();

  const code = await runUp(["--keep"], {
    json: true,
    stdout: io.stdout,
    stderr: io.stderr,
    env: {},
    homeDir: tmpHome,
    nowMs: () => 1_700_000_000_000,
    nowIso: () => "2026-11-09T15:00:00.000Z",
    sleep: async () => {},
    copyClipboard: (text) => {
      copiedLine = text;
      return { copied: true, tool: "pbcopy" };
    },
    openBrowser: (url) => {
      openedUrl = url;
      return { opened: true, target: "system-browser", browserPageId: null };
    },
    fetchTailscaleStatus: async () => {
      statusCall += 1;
      if (statusCall === 1) {
        return { found: true, loggedIn: true, backendState: "Running", peers: [] };
      }
      return {
        found: true,
        loggedIn: true,
        backendState: "Running",
        peers: [
          {
            id: "nPeerT4",
            hostName: "orca-colab-7a8b9c",
            ipv4: "100.99.88.77",
            online: true,
          },
        ],
      };
    },
    probeSshBanner: async () => ({
      host: "100.99.88.77",
      port: 22,
      banner: "SSH-2.0-OpenSSH_9.2",
    }),
    runSsh: () => ({
      status: 0,
      stdout: "name, memory.total [MiB]\nTesla T4, 15360 MiB\n",
      stderr: "",
    }),
  });

  assert.equal(code, 0);
  assert.equal(copiedLine, `${secretKey} ${pubKey}`);
  assert.equal(
    openedUrl,
    "https://colab.research.google.com/github/vzxxbacq/orca-colab/blob/main/notebooks/orca-colab-bootstrap.ipynb",
  );
  assert.equal(io.stdoutText.includes(secretKey), false);
  assert.equal(io.stderrText.includes(secretKey), false);

  const expectedSession = {
    name: "orca-colab-7a8b9c",
    account: "default",
    hostname: "orca-colab-7a8b9c",
    ip: "100.99.88.77",
    gpu: { name: "Tesla T4", memoryMiB: 15360 },
    rateKey: "T4",
    cuPerHour: 1.96,
    createdAt: "2026-11-09T15:00:00.000Z",
    lastActivityAt: "2026-11-09T15:00:00.000Z",
    activePids: [],
    keep: true,
    state: "active",
    remoteRoot: null,
    forwards: [],
  };

  assert.deepEqual(JSON.parse(io.stdoutText), {
    ...expectedSession,
    estimatedCuPerHour: 1.96,
  });
  assert.deepEqual(readSession("orca-colab-7a8b9c", tmpHome), expectedSession);
});

test("up returns exitCode 1 when unconfigured", async (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-up-err-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  const io = makeBuffers();
  await assert.rejects(
    () =>
      runUp([], {
        json: true,
        stdout: io.stdout,
        stderr: io.stderr,
        env: {},
        homeDir: tmpHome,
      }),
    (err) => {
      assert.equal(err.exitCode, 1);
      assert.equal(err.payload.step, "prerequisites");
      return true;
    },
  );
});
