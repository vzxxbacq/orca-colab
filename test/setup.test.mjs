import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run as runSetup } from "../bin/commands/setup.mjs";
import { copyToClipboard } from "../bin/lib/clipboard.mjs";
import { readConfig } from "../bin/lib/colab-home.mjs";
import {
  BOOTSTRAP_NOTEBOOK_COLAB_URL,
  isRunningInsideOrca,
  openUrl,
} from "../bin/lib/open-url.mjs";

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

test("setup writes config and generates SSH keypair without leaking authKey to stdout or stderr", async (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-setup-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  const io = makeBuffers();
  const secretKey = "tskey-auth-kSetupSecret777";
  const fakePub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKey orca-colab";

  const code = await runSetup(
    [
      "--auth-key",
      secretKey,
      "--login-server",
      "https://hs.example.com",
      "--notebook-url",
      "https://colab.research.google.com/drive/1DriveCopyId",
      "--non-interactive",
    ],
    {
      json: true,
      stdout: io.stdout,
      stderr: io.stderr,
      env: {},
      homeDir: tmpHome,
      now: () => "2026-11-09T12:00:00.000Z",
      copyClipboard: () => ({ copied: true, tool: "pbcopy" }),
      runKeygen: (_bin, _args, { privateKeyPath, publicKeyPath }) => {
        writeFileSync(privateKeyPath, "FAKE_PRIV\n", { mode: 0o600 });
        writeFileSync(publicKeyPath, `${fakePub}\n`, { mode: 0o644 });
      },
    },
  );

  assert.equal(code, 0);
  assert.equal(io.stdoutText.includes(secretKey), false);
  assert.equal(io.stderrText.includes(secretKey), false);

  const result = JSON.parse(io.stdoutText);
  assert.deepEqual(result, {
    ok: true,
    configPath: path.join(tmpHome, ".orca-colab", "config.json"),
    publicKeyPath: path.join(tmpHome, ".orca-colab", "id_ed25519.pub"),
    publicKey: fakePub,
    sshKeyCreated: true,
    account: "default",
    notebookUrl: "https://colab.research.google.com/drive/1DriveCopyId",
    loginServer: "https://hs.example.com",
    bootstrapNotebookUrl: BOOTSTRAP_NOTEBOOK_COLAB_URL,
  });

  assert.deepEqual(readConfig(tmpHome), {
    authKey: secretKey,
    authKeyCreatedAt: "2026-11-09T12:00:00.000Z",
    loginServer: "https://hs.example.com",
    tags: ["tag:orca-colab"],
    remoteRootBase: "/content/orca",
    accounts: [
      {
        label: "default",
        notebookUrl: "https://colab.research.google.com/drive/1DriveCopyId",
      },
    ],
    defaultAccount: "default",
  });
});

test("copyToClipboard and openUrl select platform and Orca embedded browser tools", () => {
  const calls = [];
  const clipRes = copyToClipboard("payload-line", {
    platform: "darwin",
    findBinary: (name) => (name === "pbcopy" ? "/usr/bin/pbcopy" : null),
    spawnProcess: (bin, args, opts) => {
      calls.push({ bin, args, input: opts.input });
      return { status: 0 };
    },
  });
  assert.deepEqual(clipRes, { copied: true, tool: "pbcopy" });
  assert.deepEqual(calls, [
    { bin: "/usr/bin/pbcopy", args: [], input: "payload-line" },
  ]);

  assert.equal(isRunningInsideOrca({}), false);
  assert.equal(isRunningInsideOrca({ ORCA_PANE_KEY: "pane-1" }), true);

  const openCalls = [];
  const opened = openUrl("https://colab.research.google.com/drive/1abc", {
    env: { ORCA_WORKSPACE_ID: "ws-1" },
    platform: "darwin",
    findBinary: (name) => (name === "orca" ? "/usr/local/bin/orca" : null),
    spawnProcess: (bin, args) => {
      openCalls.push({ bin, args });
      return {
        status: 0,
        stdout: JSON.stringify({ browserPageId: "page-42" }),
      };
    },
  });
  assert.deepEqual(opened, {
    opened: true,
    target: "orca-browser",
    browserPageId: "page-42",
  });
  assert.deepEqual(openCalls, [
    {
      bin: "/usr/local/bin/orca",
      args: [
        "tab",
        "create",
        "--url",
        "https://colab.research.google.com/drive/1abc",
        "--json",
      ],
    },
  ]);
});
