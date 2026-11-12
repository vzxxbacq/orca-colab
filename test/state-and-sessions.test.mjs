import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getColabPaths,
  readConfig,
  writeConfig,
} from "../bin/lib/colab-home.mjs";
import {
  deleteSession,
  listSessions,
  resolveSession,
  selectDefaultSession,
  writeSession,
} from "../bin/lib/session-store.mjs";

test("writeConfig writes 0600 config atomically inside 0700 home and drops the old Tailscale auth key", (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-home-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  const written = writeConfig(
    {
      authKey: "tskey-auth-k123456",
      authKeyCreatedAt: "2026-11-09T00:00:00.000Z",
      balance: 999,
      budget: 100,
    },
    tmpHome,
  );

  assert.deepEqual(written, {
    remoteRootBase: "/content/orca",
    accounts: [{ label: "default" }],
    defaultAccount: "default",
  });

  const paths = getColabPaths(tmpHome);
  assert.equal(statSync(paths.baseDir).mode & 0o777, 0o700);
  assert.equal(statSync(paths.configPath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(paths.baseDir).sort(), ["config.json", "sessions"]);
  assert.deepEqual(readConfig(tmpHome), written);
});

test("session-store persists sessions atomically and selects the only or newest active session", (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-sess-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  const older = writeSession(
    {
      name: "orca-colab-aaa111",
      gpu: { name: "Tesla T4", memoryMiB: 15360 },
      rateKey: "T4",
      cuPerHour: 1.96,
      createdAt: "2026-11-09T10:00:00.000Z",
    },
    tmpHome,
  );

  assert.equal(
    resolveSession({ homeDir: tmpHome }).name,
    "orca-colab-aaa111",
  );

  const newer = writeSession(
    {
      name: "orca-colab-bbb222",
      gpu: { name: "NVIDIA A100-SXM4-40GB", memoryMiB: 40960 },
      rateKey: "A100",
      cuPerHour: 11.77,
      createdAt: "2026-11-09T12:00:00.000Z",
    },
    tmpHome,
  );

  writeSession(
    {
      name: "orca-colab-ccc333",
      createdAt: "2026-11-09T13:00:00.000Z",
      state: "zombie",
    },
    tmpHome,
  );

  const all = listSessions(tmpHome);
  assert.deepEqual(
    all.map((s) => s.name),
    ["orca-colab-ccc333", "orca-colab-bbb222", "orca-colab-aaa111"],
  );

  assert.equal(selectDefaultSession(all).name, newer.name);
  assert.equal(
    selectDefaultSession(all, "orca-colab-aaa111").name,
    older.name,
  );
  assert.throws(
    () => selectDefaultSession(all, "orca-colab-missing"),
    /session not found: orca-colab-missing/,
  );

  assert.equal(deleteSession("orca-colab-bbb222", tmpHome), true);
  assert.equal(deleteSession("orca-colab-bbb222", tmpHome), false);
});
