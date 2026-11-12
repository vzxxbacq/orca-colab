import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run as runUp } from "../bin/commands/up.mjs";

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

test("up without a Google sign-in fails at the prerequisites step", async (t) => {
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
