import assert from "node:assert/strict";
import test from "node:test";
import { main } from "../bin/orca-colab.mjs";

function makeBuffers() {
  let out = "";
  let err = "";
  return {
    stdout: { write: (chunk) => { out += chunk; } },
    stderr: { write: (chunk) => { err += chunk; } },
    get stdoutText() { return out; },
    get stderrText() { return err; },
  };
}

test("cli help --json lists all dispatched commands", async () => {
  const io = makeBuffers();
  const code = await main(["--help", "--json"], io);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(io.stdoutText), {
    commands: [
      "doctor",
      "setup",
      "auth",
      "up",
      "status",
      "ls",
      "run",
      "job",
      "sync",
      "pull",
      "forward",
      "down",
      "credits",
      "ledger",
      "rates",
      "watch",
    ],
  });
  assert.equal(io.stderrText, "");
});

test("cli unknown command returns exit code 1 with [colab] stderr prefix and JSON error", async () => {
  const io = makeBuffers();
  const code = await main(["bogus", "--json"], io);
  assert.equal(code, 1);
  assert.equal(io.stderrText, "[colab] error: unknown command: bogus\n");
  assert.deepEqual(JSON.parse(io.stdoutText), {
    ok: false,
    error: "unknown command: bogus",
  });
});
