import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  buildOrcaArgs,
  createOrcaRemoteHelper,
  parseOrcaEnvelope,
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
  assert.equal(parseOrcaEnvelope('{"id":"1","ok":false,"error":{"code":"not_found","message":"no worktree"}}').error, "no worktree");
  assert.equal(parseOrcaJson("not json"), null);
});

test("helper lists this machine's terminals through a fake orca binary", async () => {
  const calls = [];
  const fakeSpawn = (bin, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit("data", JSON.stringify({ ok: true, result: { terminals: [{ handle: "term_42", title: "zsh", worktreePath: "/srv/p" }] } }));
      child.emit("close", 0);
    });
    return child;
  };
  const helper = createOrcaRemoteHelper({ orcaBin: "/fake/orca", spawnProcess: fakeSpawn });
  const listed = await helper.listTerminals(undefined);
  assert.deepEqual(listed.data, [{ handle: "term_42", title: "zsh", preview: "", connected: true, worktreePath: "/srv/p" }]);
  assert.deepEqual(calls, [["terminal", "list", "--limit", "200", "--json"]]);

  const missing = createOrcaRemoteHelper({ orcaBin: null });
  assert.equal(missing.available, false);
  assert.match((await missing.listTerminals(undefined)).error, /not found/);
});
