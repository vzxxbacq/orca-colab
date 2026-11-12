import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PIN_FILES, readPins } from "../scripts/release-pin.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("skills/colab-gpu/SKILL.md and references/cli.md follow agentskills layout", () => {
  const skillPath = path.join(REPO_ROOT, "skills", "colab-gpu", "SKILL.md");
  const refPath = path.join(
    REPO_ROOT,
    "skills",
    "colab-gpu",
    "references",
    "cli.md",
  );

  assert.equal(existsSync(skillPath), true);
  assert.equal(existsSync(refPath), true);

  const skillText = readFileSync(skillPath, "utf8");
  assert.match(skillText, /^---\nname: colab-gpu\ndescription: .+\n---/s);
  assert.equal(skillText.includes("references/cli.md"), true);

  const refText = readFileSync(refPath, "utf8");
  for (const cmd of [
    "doctor",
    "up",
    "status",
    "run",
    "sync",
    "pull",
    "down",
    "credits",
    "ledger",
    "rates",
  ]) {
    assert.equal(refText.includes(`\`${cmd}`), true);
  }
});

test("every npx pin names the same full commit SHA, never a tag", () => {
  const pins = readPins();
  assert.deepEqual([...new Set(pins.map((p) => p.file))], PIN_FILES);
  assert.equal(new Set(pins.map((p) => p.ref)).size, 1);
  assert.match(pins[0].ref, /^[0-9a-f]{40}$/);
});
