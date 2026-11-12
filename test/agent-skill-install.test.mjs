import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectAgentSkills, installAgentSkill, removeAgentSkill } from "../worker/agent-skill-install.mjs";

function tmpHome(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-colab-skill-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("install writes only the chosen folders and remove deletes them again", (t) => {
  const home = tmpHome(t);
  const { results } = installAgentSkill(["claude"], home);
  assert.deepEqual(results.map((r) => [r.id, r.ok]), [["claude", true]]);
  assert.equal(existsSync(path.join(home, ".claude", "skills", "colab-gpu", "references", "cli.md")), true);
  assert.equal(existsSync(path.join(home, ".agents")), false);
  assert.equal(existsSync(path.join(home, ".gemini")), false);
  assert.deepEqual(
    inspectAgentSkills(home).map((s) => [s.id, s.installed, s.current]),
    [["agents", false, false], ["claude", true, true], ["gemini", false, false]],
  );

  removeAgentSkill(["claude"], home);
  assert.equal(existsSync(path.join(home, ".claude", "skills", "colab-gpu")), false);
});

test("a colab-gpu folder holding someone else's skill is neither overwritten nor removed", (t) => {
  const home = tmpHome(t);
  const dir = path.join(home, ".agents", "skills", "colab-gpu");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), "---\nname: my-own-skill\n---\nmine\n");

  assert.equal(installAgentSkill(["agents"], home).results[0].ok, false);
  assert.equal(removeAgentSkill(["agents"], home).results[0].ok, false);
  assert.equal(readFileSync(path.join(dir, "SKILL.md"), "utf8"), "---\nname: my-own-skill\n---\nmine\n");
  assert.equal(inspectAgentSkills(home)[0].foreign, true);
});
