import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("skills/colab-gpu/SKILL.md and references/cli.md follow agentskills layout and pin v0.2.2", () => {
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
  assert.equal(
    skillText.includes("npx -y github:vzxxbacq/orca-colab#v0.2.2"),
    true,
  );
  assert.equal(skillText.includes("references/cli.md"), true);

  const refText = readFileSync(refPath, "utf8");
  for (const cmd of [
    "doctor",
    "setup",
    "up",
    "status",
    "run",
    "sync",
    "pull",
    "forward",
    "down",
    "credits",
    "ledger",
    "rates",
  ]) {
    assert.equal(refText.includes(`\`${cmd}`), true);
  }
});
