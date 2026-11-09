import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  buildOrcaArgs,
  createOrcaRemoteHelper,
  parseOrcaJson,
} from "../bin/lib/orca-remote-helper.mjs";

test("buildOrcaArgs renders flags and always appends --json", () => {
  assert.deepEqual(
    buildOrcaArgs(["terminal", "create"], { worktree: "active", title: "Colab Bridge", command: "x watch", focus: false }),
    ["terminal", "create", "--worktree", "active", "--title", "Colab Bridge", "--command", "x watch", "--json"],
  );
  assert.deepEqual(buildOrcaArgs(["terminal", "read"], { terminal: "term_1", cursor: "12", limit: 10 }), [
    "terminal", "read", "--terminal", "term_1", "--cursor", "12", "--limit", "10", "--json",
  ]);
  assert.deepEqual(buildOrcaArgs(["terminal", "read"], { terminal: "term_1", cursor: undefined }), [
    "terminal", "read", "--terminal", "term_1", "--json",
  ]);
});

test("parseOrcaJson unwraps the CLI envelope and rejects failures", () => {
  assert.deepEqual(parseOrcaJson('noise\n{"id":"1","ok":true,"result":{"terminals":[]}}'), { terminals: [] });
  assert.equal(parseOrcaJson('{"id":"1","ok":false,"error":"nope"}'), null);
  assert.equal(parseOrcaJson("not json"), null);
});

test("helper maps worktree show and terminal create through a fake orca binary", async () => {
  const calls = [];
  const fakeSpawn = (bin, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const reply = args[0] === "worktree"
      ? { ok: true, result: { worktree: { id: "repo::/srv/p", identity: { key: "wt2:host9:abc", executionHostId: "host9" }, hostId: "host9", displayName: "remote-host-bridge", path: "/srv/p", branch: "refs/heads/main" } } }
      : { ok: true, result: { terminal: { handle: "term_42" } } };
    setImmediate(() => {
      child.stdout.emit("data", JSON.stringify(reply));
      child.emit("close", 0);
    });
    return child;
  };
  const helper = createOrcaRemoteHelper({ orcaBin: "/fake/orca", spawnProcess: fakeSpawn });
  const wt = await helper.activeWorktree();
  assert.deepEqual(wt.data, {
    id: "repo::/srv/p", identity: "wt2:host9:abc", hostId: "host9", displayName: "remote-host-bridge", path: "/srv/p", branch: "refs/heads/main",
  });
  const created = await helper.createTerminal({ selector: "active", title: "Colab Bridge", command: "orca-colab watch" });
  assert.equal(created.data.handle, "term_42");
  assert.deepEqual(calls[1].slice(0, 2), ["terminal", "create"]);

  const missing = createOrcaRemoteHelper({ orcaBin: null });
  assert.equal(missing.available, false);
  assert.match((await missing.activeWorktree()).error, /not found/);
});
