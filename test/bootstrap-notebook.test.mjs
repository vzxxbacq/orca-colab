import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("orca-colab-bootstrap.ipynb has clean cells, empty form defaults and in-kernel unassign watcher", () => {
  const nbPath = path.join(
    REPO_ROOT,
    "notebooks",
    "orca-colab-bootstrap.ipynb",
  );
  const nb = JSON.parse(readFileSync(nbPath, "utf8"));

  assert.equal(nb.nbformat, 4);
  assert.deepEqual(
    nb.cells.map((c) => c.cell_type),
    ["markdown", "code", "code"],
  );

  for (const cell of nb.cells) {
    if (cell.cell_type === "code") {
      assert.deepEqual(cell.outputs, []);
      assert.equal(cell.execution_count, null);
    }
  }

  const mainSource = nb.cells[1].source.join("");
  assert.equal(mainSource.includes('TAILSCALE_AUTH_KEY = ""'), true);
  assert.equal(mainSource.includes('SSH_PUBLIC_KEY = ""'), true);
  assert.equal(mainSource.includes('TAILSCALE_LOGIN_SERVER = ""'), true);
  assert.equal(mainSource.includes('HOSTNAME_SUFFIX = ""'), true);
  assert.equal(mainSource.includes('PASTE = ""'), true);
  assert.equal(mainSource.includes("--tun=userspace-networking"), true);
  assert.equal(mainSource.includes("/root/.orca-colab"), true);
  assert.equal(mainSource.includes("runtime.unassign()"), true);
  assert.equal(mainSource.includes("Connected. Keep this tab open."), true);
  assert.equal(/tskey-auth-[A-Za-z0-9]+/.test(mainSource), false);
});
