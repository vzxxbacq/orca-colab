import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run as runSync } from "../bin/commands/sync.mjs";
import {
  buildPullRsyncArgs,
  buildSyncRsyncArgs,
  buildSyncTarPlan,
} from "../bin/lib/file-transfer.mjs";
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

test("buildSyncRsyncArgs and buildSyncTarPlan include .gitignore and .colabignore filters and exclude .git", () => {
  const rsyncArgs = buildSyncRsyncArgs({
    localDir: "/Users/alice/projects/demo-repo",
    ip: "100.64.0.10",
    remoteRoot: "/content/orca/demo-repo",
    homeDir: "/Users/alice",
  });

  assert.deepEqual(rsyncArgs, [
    "-az",
    "--delete",
    "--exclude=.git/",
    "--filter=:- .gitignore",
    "--filter=:- .colabignore",
    "--rsync-path",
    "mkdir -p /content/orca/demo-repo && rsync",
    "-e",
    "ssh -i /Users/alice/.orca-colab/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/Users/alice/.orca-colab/known_hosts -o ConnectTimeout=10",
    "/Users/alice/projects/demo-repo/",
    "root@100.64.0.10:/content/orca/demo-repo/",
  ]);

  const tarPlan = buildSyncTarPlan({
    localDir: "/Users/alice/projects/demo-repo",
    ip: "100.64.0.10",
    remoteRoot: "/content/orca/demo-repo",
    homeDir: "/Users/alice",
    hasGitignore: true,
    hasColabignore: true,
  });

  assert.deepEqual(tarPlan.tarArgs, [
    "-czf",
    "-",
    "--exclude=.git",
    "--exclude-from=/Users/alice/projects/demo-repo/.gitignore",
    "--exclude-from=/Users/alice/projects/demo-repo/.colabignore",
    "-C",
    "/Users/alice/projects/demo-repo",
    ".",
  ]);

  assert.deepEqual(
    buildPullRsyncArgs({
      ip: "100.64.0.10",
      remotePath: "/content/orca/demo-repo/checkpoints/model.pt",
      localPath: "/Users/alice/projects/demo-repo/checkpoints/model.pt",
      homeDir: "/Users/alice",
    }),
    [
      "-az",
      "-e",
      "ssh -i /Users/alice/.orca-colab/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/Users/alice/.orca-colab/known_hosts -o ConnectTimeout=10",
      "root@100.64.0.10:/content/orca/demo-repo/checkpoints/model.pt",
      "/Users/alice/projects/demo-repo/checkpoints/model.pt",
    ],
  );
});

test("sync records remoteRoot in the session file", async (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-sync-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  writeSession(
    {
      name: "orca-colab-sync1",
      ip: "100.64.0.22",
      createdAt: "2026-11-09T10:00:00.000Z",
    },
    tmpHome,
  );

  const io = makeBuffers();
  const code = await runSync(["."], {
    json: true,
    stdout: io.stdout,
    stderr: io.stderr,
    env: {},
    cwd: "/Users/alice/workspace/toy-train",
    homeDir: tmpHome,
    findBinary: () => "/usr/bin/rsync",
    spawnProcess: () => ({ status: 0, stdout: "", stderr: "" }),
  });

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(io.stdoutText), {
    ok: true,
    session: "orca-colab-sync1",
    localPath: "/Users/alice/workspace/toy-train",
    remoteRoot: "/content/orca/toy-train",
    method: "rsync",
  });
  assert.equal(
    readSession("orca-colab-sync1", tmpHome).remoteRoot,
    "/content/orca/toy-train",
  );
});
